import { isDeepStrictEqual } from "node:util";
import { independentAdvisoryReview, reviewContextDigest, reviewQualityDigest } from "./ecommerce-visual-review-identity";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";

import { getAuthSettings, type UserRole } from "@/lib/auth/store";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import { collectLocalMediaStorageKeys, countLocalMediaReferences, localMediaStorageKeyFromValue } from "@/lib/server/local-media-references";
import { deleteLocalMediaAssetsByStorageKeys, deleteUserLocalMediaAssets, GENERATION_MEDIA_ROOT } from "@/lib/server/local-media-storage";
import { deleteUserMediaAssetsCascade } from "@/lib/server/user-media-deletion-service";
import { getLocalMediaRegistration } from "@/lib/server/local-media-registry";
import {
    defaultSummary,
    isGenerationKind,
    isGenerationSource,
    isGenerationStatus,
    kindLabel,
    listLocalAssetFiles,
    localAssetUrls,
    mutateGenerationLogDb,
    normalizeAssets,
    normalizeGenerationLogRequestSnapshot,
    normalizeModelName,
    normalizeNonNegativeInteger,
    normalizeNonNegativeNumber,
    normalizeOptionalText,
    normalizePositiveInteger,
    normalizeText,
    normalizeTime,
    parseDateEnd,
    parseDateStart,
    readGenerationLogDb,
    sourceLabel,
    stableAssetUrl,
} from "./generation-log-repository";
import type { GenerationAssetStats, GenerationLogInput, GenerationLogListOptions, StoredGenerationLog } from "./generation-log-types";
import { buildEcommerceGenerationTrace, normalizeEcommerceGenerationTrace, type EcommerceGenerationTrace } from "./ecommerce-generation-trace";
import { getImageTask, type ImageTask } from "./image-task-store";
import { getStoredGenerationTask, getStoredGenerationTaskRecord, withGenerationTaskFileRead } from "./generation-task-store";
import type { AgentRun } from "./agent-run-store";
import { hydrateGenerationLogEnhancements } from "./generation-log-enhancement";

export type { GenerationAssetStats, GenerationLogAsset, GenerationLogInput, GenerationLogSource, StoredGenerationLog } from "./generation-log-types";
export { isGenerationSource } from "./generation-log-repository";

export async function listGenerationLogs(options: GenerationLogListOptions = {}) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const page = Math.max(1, Math.floor(Number(options.page) || 1));
        const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || 20)));
        const result = await createPostgresRepositories().generationLogs.list({
            page,
            pageSize,
            userId: options.userId,
            kind: isGenerationKind(options.kind) ? options.kind : undefined,
            source: isGenerationSource(options.source) ? options.source : undefined,
            status: isGenerationStatus(options.status) ? options.status : undefined,
            keyword: options.keyword,
            startAt: dateFilterValue(options.start),
            endAt: dateFilterValue(options.end, true),
        });
        let items = result.items.map((item) => toStoredGenerationLog(item, options.includeEcommerceTrace));
        if (options.includeEcommerceTrace) items = await hydrateEcommerceTracesFromImageTasks(items);
        if (options.includeImageEnhancement) items = await hydrateGenerationLogEnhancements(items);
        return { ...result, items };
    }
    const db = await readGenerationLogDb();
    const page = Math.max(1, Math.floor(Number(options.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || 20)));
    const keyword = (options.keyword || "").trim().toLowerCase();
    const startMs = parseDateStart(options.start);
    const endMs = parseDateEnd(options.end);

    const filtered = db.logs
        .filter((log) => (isGenerationKind(options.kind) ? log.kind === options.kind : true))
        .filter((log) => (isGenerationSource(options.source) ? log.source === options.source : true))
        .filter((log) => (isGenerationStatus(options.status) ? log.status === options.status : true))
        .filter((log) => (options.userId ? log.userId === options.userId : true))
        .filter((log) => {
            const time = Date.parse(log.createdAt);
            if (startMs && time < startMs) return false;
            if (endMs && time > endMs) return false;
            return true;
        })
        .filter((log) => {
            if (!keyword) return true;
            return [log.displayName, log.username, log.prompt, log.model, log.title, log.summary, sourceLabel(log.source), kindLabel(log.kind)].join(" ").toLowerCase().includes(keyword);
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const total = filtered.length;
    const startIndex = (page - 1) * pageSize;
    let items = filtered.slice(startIndex, startIndex + pageSize).map((item) => (options.includeEcommerceTrace ? item : withoutEcommerceTrace(item)));
    if (options.includeEcommerceTrace) items = await hydrateEcommerceTracesFromImageTasks(items);
    if (options.includeImageEnhancement) items = await hydrateGenerationLogEnhancements(items);
    return { items, total, page, pageSize };
}

function pendingAdvisoryTrace(trace: EcommerceGenerationTrace | undefined) {
    const stage = trace?.stages.find((entry) => entry.key === "quality_check");
    const output = stage?.output;
    return stage?.status === "not_run" && output && typeof output === "object" && !Array.isArray(output) && output.policy === "advisory";
}

function sameTraceIdentity(left: EcommerceGenerationTrace, right: EcommerceGenerationTrace) {
    return left.runId === right.runId && left.agentTaskId === right.agentTaskId && JSON.stringify(left.imageTaskIds) === JSON.stringify(right.imageTaskIds);
}

type CompletedReviewTraceFence = { runId: string; attempt: number; contextDigest: string; qualityDigest: string };

export async function hydrateEcommerceTracesFromImageTasks(
    logs: StoredGenerationLog[],
    persist: (taskIds: string[], trace: EcommerceGenerationTrace, expectedTrace?: EcommerceGenerationTrace | null, review?: CompletedReviewTraceFence) => Promise<{ updated: number }> = attachEcommerceTraceToGenerationLogs,
) {
    return Promise.all(
        logs.map(async (log) => {
            if (!log.taskId || (log.ecommerceTrace && !pendingAdvisoryTrace(log.ecommerceTrace))) return log;
            const image = await getImageTask(log.taskId);
            if (!image || image.id !== log.taskId || image.userId !== log.userId) return log;
            let trace = normalizeEcommerceGenerationTrace(image.ecommerceTrace);
            if (log.ecommerceTrace && trace && !sameTraceIdentity(log.ecommerceTrace, trace)) return log;
            let fence: CompletedReviewTraceFence | undefined;
            const bindingTrace = trace || log.ecommerceTrace;
            if (image.runId && image.parentTaskId) {
                const run = await getStoredGenerationTask<AgentRun>("agent", image.runId);
                const snapshot = run?.ecommerceSnapshot;
                const belongs = (task: AgentRun["tasks"][number]) => (task.taskIds || (task.taskId ? [task.taskId] : [])).includes(image.id) && (!task.childTasks?.length || task.childTasks.some((child) => child.id === image.id));
                // Native image tasks use run.id as parentTaskId; their verified trace names the Agent task.
                const parent =
                    run?.tasks.find((task) => task.id === image.parentTaskId) ||
                    (image.parentTaskId === run?.id && bindingTrace?.runId === run.id && bindingTrace.imageTaskIds.includes(image.id) ? run.tasks.find((task) => task.id === bindingTrace.agentTaskId && belongs(task)) : undefined);
                const ids = parent?.taskIds || (parent?.taskId ? [parent.taskId] : []);
                if (
                    run?.id === image.runId &&
                    run.userId === image.userId &&
                    run.status === "completed" &&
                    run.reviewed &&
                    snapshot?.qualityPolicy === "advisory" &&
                    snapshot.technicalCheck?.status === "passed" &&
                    snapshot.qualityCheck &&
                    parent?.status === "completed" &&
                    parent.ecommerceExecution &&
                    belongs(parent)
                ) {
                    if (independentAdvisoryReview(run)) {
                        const checkpoint = snapshot.visualReview;
                        if (!checkpoint) return log;
                        fence = { runId: run.id, attempt: checkpoint.attempt, contextDigest: checkpoint.contextDigest, qualityDigest: reviewQualityDigest(snapshot.qualityCheck) };
                    }
                    const rebuilt = buildEcommerceGenerationTrace({
                        runId: run.id,
                        task: parent,
                        snapshot,
                        imageTaskIds: ids,
                        generationStatus: "completed",
                        finalStatus: "completed",
                        recordedAt: run.timings?.reviewCompletedAt || snapshot.qualityCheck.checkedAt,
                    });
                    if (!log.ecommerceTrace || sameTraceIdentity(log.ecommerceTrace, rebuilt)) trace = rebuilt;
                } else if (run && independentAdvisoryReview(run)) return log;
            }
            if (!trace || (log.ecommerceTrace && pendingAdvisoryTrace(trace))) return log;
            try {
                const result = await persist([log.taskId], trace, log.ecommerceTrace || null, fence);
                if (fence && !result.updated) return log;
            } catch (error) {
                console.error("[ecommerce-generation-trace] pending trace reconciliation failed", error instanceof Error ? error.message : "unknown error");
                if (fence) return log;
            }
            return { ...log, ecommerceTrace: trace };
        }),
    );
}

function matchesCompletedReviewTrace(run: AgentRun, images: ImageTask[], trace: EcommerceGenerationTrace, fence: CompletedReviewTraceFence) {
    const snapshot = run.ecommerceSnapshot;
    const checkpoint = snapshot?.visualReview;
    const task = run.tasks.find((item) => item.id === trace.agentTaskId);
    const ids = task?.taskIds || (task?.taskId ? [task.taskId] : []);
    if (
        !independentAdvisoryReview(run) ||
        !run.reviewed ||
        !snapshot?.qualityCheck ||
        !checkpoint ||
        checkpoint.attempt !== fence.attempt ||
        checkpoint.contextDigest !== fence.contextDigest ||
        reviewQualityDigest(snapshot.qualityCheck) !== fence.qualityDigest ||
        (reviewContextDigest(run, images) !== fence.contextDigest && !(snapshot.qualityCheck.status === "unavailable" && checkpoint.submission.state !== "completed")) ||
        !task ||
        trace.runId !== run.id ||
        !isDeepStrictEqual(ids, trace.imageTaskIds)
    )
        return false;
    return isDeepStrictEqual(
        trace,
        buildEcommerceGenerationTrace({ runId: run.id, task, snapshot, imageTaskIds: ids, generationStatus: "completed", finalStatus: "completed", recordedAt: run.timings?.reviewCompletedAt || snapshot.qualityCheck.checkedAt }),
    );
}

export async function attachEcommerceTraceToGenerationLogs(taskIds: string[], trace: EcommerceGenerationTrace, expectedTrace?: EcommerceGenerationTrace | null, review?: CompletedReviewTraceFence) {
    const ids = Array.from(new Set(taskIds.map((id) => id.trim()).filter(Boolean)));
    const normalized = normalizeEcommerceGenerationTrace(trace);
    if (!ids.length || !normalized || (review && ids.some((id) => !normalized.imageTaskIds.includes(id)))) return { updated: 0 };
    let fileReviewExpiry: number | undefined;
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        if (review)
            return withPostgresTransaction(async (executor) => {
                const parent = await getStoredGenerationTaskRecord("agent", review.runId, executor, true);
                if (!parent) return { updated: 0 };
                const related = await executor.query<{ payload: ImageTask }>("SELECT payload FROM generation_tasks WHERE task_type = 'image' AND run_id = $1 AND user_id = $2 ORDER BY id FOR UPDATE", [review.runId, parent.userId]);
                const live = await executor.query<{ live: boolean }>("SELECT expires_at > clock_timestamp() AS live FROM generation_tasks WHERE id = $1", [review.runId]);
                if (
                    !live.rows[0]?.live ||
                    !matchesCompletedReviewTrace(
                        parent.payload as AgentRun,
                        related.rows.map((row) => row.payload),
                        normalized,
                        review,
                    )
                )
                    return { updated: 0 };
                const updated = await createPostgresRepositories(executor).generationLogs.updateEcommerceTraceByTaskIds(ids, normalized, expectedTrace);
                const stillLive = await executor.query<{ live: boolean }>("SELECT expires_at > clock_timestamp() AS live FROM generation_tasks WHERE id = $1", [review.runId]);
                if (!stillLive.rows[0]?.live) throw new Error("视觉复核日志提交时父任务已过期");
                return { updated };
            });
        return { updated: await createPostgresRepositories().generationLogs.updateEcommerceTraceByTaskIds(ids, normalized, expectedTrace) };
    }
    if (review)
        return withGenerationTaskFileRead(async (records) => {
            const parent = records.find((item) => item.type === "agent" && item.id === review.runId && item.expiresAt > Date.now());
            const images = records.filter((item) => item.type === "image" && item.runId === review.runId && item.userId === parent?.userId).map((item) => item.payload as ImageTask);
            if (!parent || !matchesCompletedReviewTrace(parent.payload as AgentRun, images, normalized, review)) return { updated: 0 };
            fileReviewExpiry = parent.expiresAt;
            return writeTrace();
        });
    return writeTrace();
    function writeTrace() {
        return mutateGenerationLogDb(async (db) => {
            const idSet = new Set(ids);
            let updated = 0;
            db.logs = db.logs.map((log) => {
                if (!log.taskId || !idSet.has(log.taskId)) return log;
                if (expectedTrace !== undefined && JSON.stringify(log.ecommerceTrace || null) !== JSON.stringify(expectedTrace)) return log;
                updated += 1;
                return { ...log, ecommerceTrace: normalized, updatedAt: new Date().toISOString() };
            });
            if (fileReviewExpiry !== undefined && fileReviewExpiry <= Date.now()) throw new Error("视觉复核日志提交时父任务已过期");
            return { updated };
        });
    }
}

export async function listUserGenerationLogsForDelete(userId: string, ids: string[]) {
    const targetUserId = userId.trim();
    const idSet = new Set(ids.map((id) => id.trim()).filter(Boolean));
    if (!targetUserId || !idSet.size) return [];

    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const repository = createPostgresRepositories().generationLogs;
        const requestedLogs = await repository.getByIds(Array.from(idSet), targetUserId);
        const assetUrls = Array.from(new Set(requestedLogs.flatMap((log) => log.assets.map(stableAssetUrl).filter(Boolean))));
        const sharedLogs = await repository.listByUserAndAssetUrls(targetUserId, assetUrls);
        return uniqueGenerationLogs([...requestedLogs, ...sharedLogs]).map((log) => toStoredGenerationLog(log));
    }
    const db = await readGenerationLogDb();
    const userLogs = db.logs.filter((log) => log.userId === targetUserId);
    const requestedLogs = userLogs.filter((log) => idSet.has(log.id));
    const assetUrls = new Set(requestedLogs.flatMap((log) => log.assets.map(stableAssetUrl).filter(Boolean)));

    return userLogs.filter((log) => idSet.has(log.id) || log.assets.some((asset) => assetUrls.has(stableAssetUrl(asset))));
}

export async function recordGenerationLog(input: GenerationLogInput, beforePersist?: () => void, executor?: QueryExecutor) {
    const id = normalizeText(input.id, randomUUID(), 120);
    if (isPostgresDatabaseEnabled()) {
        if (!executor) await ensurePostgresSchema();
        const repository = createPostgresRepositories(executor).generationLogs;
        const existing = await repository.getById(id);
        if (existing && existing.userId !== input.userId) throw new Error("generation log id belongs to another user");
        const assets = await normalizeAssets(input.assets || [], {
            ownerUserId: input.userId,
            source: input.source || (existing && isGenerationSource(existing.source) ? existing.source : "unknown"),
            conversationId: input.conversationId || existing?.conversationId,
            taskId: input.taskId || existing?.taskId,
            originalName: input.title || existing?.title,
        });
        const persist = async (client: QueryExecutor) => {
            const transactionRepository = createPostgresRepositories(client).generationLogs;
            const current = await transactionRepository.getById(id, true);
            if (current && current.userId !== input.userId) throw new Error("generation log id belongs to another user");
            const next = buildGenerationLog(input, id, current ? toStoredGenerationLog(current) : undefined, assets);
            return toStoredGenerationLog(await transactionRepository.upsert(next));
        };
        return executor ? persist(executor) : withPostgresTransaction(persist);
    }
    return mutateGenerationLogDb(async (db) => {
        const now = new Date().toISOString();
        const existing = db.logs.find((log) => log.id === id);
        if (existing && existing.userId !== input.userId) {
            throw new Error("generation log id belongs to another user");
        }
        const assets = await normalizeAssets(input.assets || [], {
            ownerUserId: input.userId,
            source: input.source || existing?.source || "unknown",
            conversationId: input.conversationId || existing?.conversationId,
            taskId: input.taskId || existing?.taskId,
            originalName: input.title || existing?.title,
        });
        const completedAt = input.status === "pending" ? undefined : normalizeTime(input.completedAt, now);
        const next = buildGenerationLog(input, id, existing, assets, now, completedAt);

        beforePersist?.();
        db.logs = [next, ...db.logs.filter((log) => log.id !== id)];
        return next;
    });
}

export async function deleteGenerationLogs(ids: string[], options: { cascadeUserMedia?: boolean } = {}) {
    const normalizedIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (!normalizedIds.length) return { deleted: 0 };
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const removed = await withPostgresTransaction(async (client) => {
            const repository = createPostgresRepositories(client).generationLogs;
            const logs = await repository.getByIds(normalizedIds, undefined, true);
            await repository.delete(logs.map((log) => log.id));
            return logs.map((log) => toStoredGenerationLog(log));
        });
        await deleteRemovedLogMedia(removed, options.cascadeUserMedia);
        return { deleted: removed.length };
    }
    let removed: StoredGenerationLog[] = [];
    const result = await mutateGenerationLogDb(async (db) => {
        const idSet = new Set(normalizedIds);
        removed = db.logs.filter((log) => idSet.has(log.id));
        db.logs = db.logs.filter((log) => !idSet.has(log.id));
        return { deleted: removed.length };
    });
    await deleteRemovedLogMedia(removed, options.cascadeUserMedia);
    return result;
}

export async function deleteGenerationLogsByUserId(userId: string) {
    const targetUserId = userId.trim();
    if (!targetUserId) return { deleted: 0 };
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const { dataLifecycle } = await getAuthSettings();
        let deleted = 0;
        while (true) {
            const removed = await withPostgresTransaction(async (client) => {
                const repository = createPostgresRepositories(client).generationLogs;
                const logs = await repository.listByUserIdBatch(targetUserId, dataLifecycle.maintenanceBatchSize, true);
                if (!logs.length) return [];
                await repository.delete(logs.map((log) => log.id));
                return logs.map((log) => toStoredGenerationLog(log));
            });
            if (!removed.length) break;
            await deleteRemovedLogMedia(removed);
            deleted += removed.length;
        }
        return { deleted };
    }
    let removed: StoredGenerationLog[] = [];
    const result = await mutateGenerationLogDb(async (db) => {
        removed = db.logs.filter((log) => log.userId === targetUserId);
        db.logs = db.logs.filter((log) => log.userId !== targetUserId);
        return { deleted: removed.length };
    });
    await deleteRemovedLogMedia(removed);
    return result;
}

export async function getGenerationAssetStats(): Promise<GenerationAssetStats> {
    const db = isPostgresDatabaseEnabled() ? null : await readGenerationLogDb();
    const files = await listLocalAssetFiles();
    const fileKeys = files.map((file) => relative(resolve(GENERATION_MEDIA_ROOT), file.path).replace(/\\/g, "/"));
    const references = await countLocalMediaReferences(fileKeys);
    const referencedFiles = files.filter((_, index) => (references.get(fileKeys[index]) || 0) > 0);
    const unreferencedFiles = files.filter((_, index) => (references.get(fileKeys[index]) || 0) === 0);
    const logReferences = db ? collectGenerationLogAssetKeys(db) : new Set<string>();

    return {
        totalFiles: files.length,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
        referencedFiles: referencedFiles.length,
        referencedBytes: referencedFiles.reduce((total, file) => total + file.bytes, 0),
        unreferencedFiles: unreferencedFiles.length,
        unreferencedBytes: unreferencedFiles.reduce((total, file) => total + file.bytes, 0),
        missingReferences: Array.from(logReferences).filter((key) => !fileKeys.includes(key)).length,
    };
}

export async function cleanupUnreferencedGenerationAssets() {
    const files = await listLocalAssetFiles();
    const fileKeys = files.map((file) => relative(resolve(GENERATION_MEDIA_ROOT), file.path).replace(/\\/g, "/"));
    const references = await countLocalMediaReferences(fileKeys);
    const removable = fileKeys.filter((key) => (references.get(key) || 0) === 0);
    const result = await deleteLocalMediaAssetsByStorageKeys(removable, "generation");
    const blockedKeys = new Set(result.blocked.map((item) => item.storageKey));
    const deletedKeys = removable.filter((key) => !blockedKeys.has(key));

    return {
        deletedFiles: result.deletedFiles,
        deletedBytes: files.filter((_, index) => deletedKeys.includes(fileKeys[index])).reduce((total, file) => total + file.bytes, 0),
        blocked: result.blocked,
        stats: await getGenerationAssetStats(),
    };
}

export async function canAccessGenerationAsset(userId: string, role: UserRole, url: string) {
    if (role === "admin") return true;
    const storageKey = localMediaStorageKeyFromValue(url);
    if (storageKey) {
        const registration = await getLocalMediaRegistration(storageKey);
        if (registration) return registration.ownerUserId === userId;
    }
    if (isPostgresDatabaseEnabled()) return false;
    const db = await readGenerationLogDb();
    return db.logs.some((log) => log.userId === userId && log.assets.some((asset) => localAssetUrls(asset).includes(url)));
}

function buildGenerationLog(
    input: GenerationLogInput,
    id: string,
    existing: StoredGenerationLog | undefined,
    assets: StoredGenerationLog["assets"],
    now = new Date().toISOString(),
    completedAt = input.status === "pending" ? undefined : normalizeTime(input.completedAt, now),
): StoredGenerationLog {
    return {
        id,
        userId: normalizeText(input.userId, existing?.userId || "", 120),
        conversationId: normalizeOptionalText(input.conversationId, existing?.conversationId, 160),
        username: normalizeText(input.username, existing?.username || "", 80),
        displayName: normalizeText(input.displayName, existing?.displayName || input.username || "未知用户", 80),
        kind: input.kind,
        source: input.source || existing?.source || "unknown",
        status: input.status,
        title: normalizeText(input.title, existing?.title || input.prompt || "未命名记录", 80),
        prompt: normalizeText(input.prompt, existing?.prompt || "", 5000),
        model: normalizeModelName(input.model || existing?.model || ""),
        summary: normalizeText(input.summary, existing?.summary || defaultSummary(input.kind, input.status), 160),
        durationMs: normalizeNonNegativeNumber(input.durationMs, existing?.durationMs || 0),
        count: normalizePositiveInteger(input.count, existing?.count || 1),
        successCount: normalizeNonNegativeInteger(input.successCount, existing?.successCount || (input.status === "success" ? 1 : 0)),
        failCount: normalizeNonNegativeInteger(input.failCount, existing?.failCount || (input.status === "failed" ? 1 : 0)),
        assets: assets.length ? assets : existing?.assets || [],
        requestSnapshot: normalizeGenerationLogRequestSnapshot(input.requestSnapshot) || existing?.requestSnapshot,
        ecommerceTrace: existing?.ecommerceTrace,
        taskId: normalizeOptionalText(input.taskId, existing?.taskId, 160),
        error: normalizeOptionalText(input.error, existing?.error, 1000),
        createdAt: normalizeTime(input.createdAt, existing?.createdAt || now),
        updatedAt: now,
        completedAt,
    };
}

function toStoredGenerationLog(log: { source: string; requestSnapshot?: unknown; ecommerceTrace?: unknown } & Omit<StoredGenerationLog, "source" | "requestSnapshot" | "ecommerceTrace">, includeEcommerceTrace = true): StoredGenerationLog {
    const stored = {
        ...log,
        source: isGenerationSource(log.source) ? log.source : "unknown",
        requestSnapshot: normalizeGenerationLogRequestSnapshot(log.requestSnapshot),
        ecommerceTrace: normalizeEcommerceGenerationTrace(log.ecommerceTrace),
    };
    return includeEcommerceTrace ? stored : withoutEcommerceTrace(stored);
}

export function withoutEcommerceTrace(log: StoredGenerationLog): StoredGenerationLog {
    const publicLog = { ...log };
    delete publicLog.ecommerceTrace;
    return publicLog;
}

function uniqueGenerationLogs<T extends { id: string }>(logs: T[]) {
    return Array.from(new Map(logs.map((log) => [log.id, log])).values());
}

async function deleteRemovedLogMedia(logs: StoredGenerationLog[], cascadeUserMedia = false) {
    const byUser = new Map<string, Set<string>>();
    logs.forEach((log) => {
        const keys = byUser.get(log.userId) || new Set<string>();
        collectLocalMediaStorageKeys(log.assets).forEach((key) => keys.add(key));
        byUser.set(log.userId, keys);
    });
    await Promise.all(Array.from(byUser, ([userId, keys]) => (cascadeUserMedia ? deleteUserMediaAssetsCascade(userId, Array.from(keys)) : deleteUserLocalMediaAssets(userId, Array.from(keys)))));
}

function collectGenerationLogAssetKeys(db: Awaited<ReturnType<typeof readGenerationLogDb>>) {
    const keys = new Set<string>();
    db.logs.forEach((log) =>
        log.assets.forEach((asset) =>
            localAssetUrls(asset)
                .filter((url) => url.startsWith("/api/generation-log-assets/"))
                .map(localMediaStorageKeyFromValue)
                .filter(Boolean)
                .forEach((key) => keys.add(key)),
        ),
    );
    return keys;
}

function dateFilterValue(value: string | undefined, end = false) {
    const time = end ? parseDateEnd(value) : parseDateStart(value);
    return time ? new Date(time).toISOString() : undefined;
}
