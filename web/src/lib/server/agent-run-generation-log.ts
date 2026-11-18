import type { AgentRun } from "./agent-run-store";
import { getDatabaseProvider, createPostgresRepositories, type QueryExecutor } from "./database";
import { generationLogReferences, generationLogRunSnapshot } from "./generation-log-request-snapshot";
import { mutateGenerationLogDb, normalizeGenerationLogRequestSnapshot, normalizeStoredLog } from "./generation-log-repository";
import type { StoredGenerationLog } from "./generation-log-types";
import { isDeepStrictEqual } from "node:util";
import { normalizeEcommerceGenerationTrace, updateEcommerceGenerationTraceTimings } from "./ecommerce-generation-trace";
import { ecommerceRunForTask } from "./ecommerce-generation-snapshot";
import { deleteGenerationLogFileRecords } from "./generation-log-evaluation-file";

export async function persistAgentRunRequestLog(run: AgentRun, executor?: QueryExecutor) {
    const imageRun = run.generationPreferences?.mode === "image" || run.generationPreferences?.mode === "video" || run.ecommerceSnapshot || run.tasks.some((task) => task.type === "image" || task.type === "video");
    if (!imageRun) return;
    const state = generationLogRunSnapshot(run, "pre-generation");
    const shouldCreate = (run.status === "failed" || run.status === "paused" || run.status === "cancelled") && !state.childTaskIds.length;
    const id = `agent-run:${run.id}`;
    const build = async (existing?: StoredGenerationLog) => {
        if (!existing && !shouldCreate) return undefined;
        const checkpoint = run.ecommerceSnapshot?.referenceCheckpoint;
        const liveReferences = await generationLogReferences(run.referencedAssetIds, run.userId, executor);
        const frozenReferences =
            checkpoint?.assets.map(({ asset, assetVersion, alias, contentSha256 }) => ({
                id: asset.id,
                kind: asset.type === "video" || asset.type === "audio" ? asset.type : ("image" as const),
                name: asset.title,
                mimeType: asset.mimeType || "image/png",
                url: asset.serverUrl,
                storageKey: asset.storageKey,
                width: asset.width,
                height: asset.height,
                bytes: asset.bytes,
                durationMs: asset.durationMs,
                sourceRunId: asset.sourceRunId,
                sourceTaskId: asset.sourceTaskId,
                parentAssetId: asset.parentAssetId,
                assetVersion,
                alias,
                sha256: contentSha256,
            })) || [];
        const references = [...frozenReferences, ...liveReferences.filter((reference) => !frozenReferences.some((frozen) => frozen.id === reference.id))].map((reference) => {
            const frozen = checkpoint?.assets.find((entry) => entry.asset.id === reference.id);
            const binding = checkpoint?.confirmedBindings?.find((entry) => entry.assetId === reference.id) || checkpoint?.decision?.bindings.find((entry) => entry.assetId === reference.id);
            return {
                ...reference,
                ...(frozen ? { url: frozen.asset.serverUrl || reference.url, alias: frozen.alias, assetVersion: frozen.assetVersion, sha256: frozen.contentSha256 || reference.sha256 } : {}),
                ...(binding ? { alias: binding.alias, purposes: binding.purposes } : {}),
            };
        });
        const parameters = run.generationPreferences?.image;
        const log = normalizeStoredLog({
            ...existing,
            id,
            userId: run.userId,
            username: existing?.username || "",
            displayName: existing?.displayName || "",
            conversationId: run.conversationId,
            kind: run.generationPreferences?.mode === "video" ? "video" : "image",
            source: run.surface === "canvas" ? "canvas" : run.surface === "drama" ? "drama" : "agent",
            status: run.status === "completed" ? "success" : run.status === "failed" || run.status === "cancelled" ? "failed" : "pending",
            title: "生图前置流程",
            prompt: run.publicPrompt || run.prompt,
            model: run.requestedModelIds?.join("、") || "",
            summary: state.reason || "前置流程状态已更新",
            count: 1,
            successCount: 0,
            failCount: 0,
            assets: [],
            durationMs: run.updatedAt - run.createdAt,
            requestSnapshot: {
                version: 1,
                userPrompt: run.publicPrompt || run.prompt,
                run: state,
                parameters: { size: parameters?.size, quality: parameters?.quality, count: parameters?.count === undefined ? undefined : String(parameters.count) },
                references: references.length ? references : existing?.requestSnapshot?.references || [],
                slots: [],
            },
            error: run.status === "failed" ? run.failure : undefined,
            createdAt: new Date(run.createdAt).toISOString(),
            updatedAt: new Date(run.updatedAt).toISOString(),
            completedAt: run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? new Date(run.updatedAt).toISOString() : undefined,
        });
        return existing && isDeepStrictEqual(existing.requestSnapshot, log.requestSnapshot) && existing.status === log.status && existing.error === log.error ? existing : log;
    };
    const childState = generationLogRunSnapshot(run, "generation");
    const childMetadata = (existing: { requestSnapshot?: unknown; ecommerceTrace?: unknown }) => {
        const requestSnapshot = normalizeGenerationLogRequestSnapshot(existing.requestSnapshot) || { version: 1 as const, parameters: {}, references: [], slots: [] };
        const trace = normalizeEcommerceGenerationTrace(existing.ecommerceTrace);
        const task = trace && run.tasks.find((item) => item.id === trace.agentTaskId);
        const snapshot = task && ecommerceRunForTask(run, task.id).ecommerceSnapshot;
        return {
            requestSnapshot: { ...requestSnapshot, run: childState },
            ecommerceTrace: trace && task && snapshot ? updateEcommerceGenerationTraceTimings(trace, snapshot) : trace,
        };
    };
    if (executor) {
        const repository = createPostgresRepositories(executor).generationLogs;
        const current = await repository.getById(id, true);
        if (current && current.userId !== run.userId) throw new Error("generation log id belongs to another user");
        const prior: StoredGenerationLog | undefined = current
            ? { ...current, source: run.surface === "canvas" ? "canvas" : run.surface === "drama" ? "drama" : "agent", assets: [], requestSnapshot: normalizeGenerationLogRequestSnapshot(current.requestSnapshot), ecommerceTrace: undefined }
            : undefined;
        const log = await build(prior);
        if (log && log !== prior) {
            const actor = await executor.query<{ username: string; display_name: string }>("SELECT username, display_name FROM users WHERE id = $1", [run.userId]);
            if (actor.rows[0]) {
                log.username = actor.rows[0].username;
                log.displayName = actor.rows[0].display_name;
            }
            await repository.upsert(log);
        }
        for (const child of await repository.getByRunTaskIds(run.userId, run.id, childState.childTaskIds)) {
            const metadata = childMetadata(child);
            if (!isDeepStrictEqual(normalizeGenerationLogRequestSnapshot(child.requestSnapshot), metadata.requestSnapshot) || !isDeepStrictEqual(normalizeEcommerceGenerationTrace(child.ecommerceTrace), metadata.ecommerceTrace))
                await repository.updateRunMetadata(child.id, run.userId, metadata.requestSnapshot, metadata.ecommerceTrace);
        }
        return;
    }
    if (getDatabaseProvider() === "postgres") throw new Error("Agent 请求日志必须复用当前事务");
    return mutateGenerationLogDb(async (db) => {
        const existing = db.logs.find((item) => item.id === id);
        if (existing && existing.userId !== run.userId) throw new Error("generation log id belongs to another user");
        const log = await build(existing);
        const changes: Array<{ before?: StoredGenerationLog; after: StoredGenerationLog }> = [];
        if (log && log !== existing) {
            db.logs = [log, ...db.logs.filter((item) => item.id !== id)];
            changes.push({ before: existing, after: log });
        }
        db.logs = db.logs.map((child) => {
            if (child.userId !== run.userId || child.requestSnapshot?.run?.recordType === "pre-generation" || (child.requestSnapshot?.run?.id !== run.id && (child.requestSnapshot?.run || !child.taskId || !childState.childTaskIds.includes(child.taskId))))
                return child;
            const metadata = childMetadata(child);
            if (isDeepStrictEqual(child.requestSnapshot, metadata.requestSnapshot) && isDeepStrictEqual(child.ecommerceTrace, metadata.ecommerceTrace)) return child;
            const after = { ...child, ...metadata };
            changes.push({ before: child, after });
            return after;
        });
        if (!changes.length) return undefined;
        return async () => {
            const createdLogs: StoredGenerationLog[] = [];
            await mutateGenerationLogDb((current) => {
                for (const change of changes) {
                    const written = current.logs.find((item) => item.id === change.after.id);
                    if (!written) continue;
                    if (change.after.id === id) {
                        if (!isDeepStrictEqual(written, change.after)) continue;
                        if (change.before) current.logs = current.logs.map((item) => (item.id === id ? change.before! : item));
                        else createdLogs.push(change.after);
                    } else {
                        if (isDeepStrictEqual(written.requestSnapshot?.run, change.after.requestSnapshot?.run))
                            written.requestSnapshot = isDeepStrictEqual(written.requestSnapshot, change.after.requestSnapshot) ? change.before?.requestSnapshot : { ...written.requestSnapshot!, run: change.before?.requestSnapshot?.run };
                        if (isDeepStrictEqual(written.ecommerceTrace, change.after.ecommerceTrace)) written.ecommerceTrace = change.before?.ecommerceTrace;
                    }
                }
            });
            if (createdLogs.length) await deleteGenerationLogFileRecords((log) => createdLogs.some((created) => created.id === log.id && isDeepStrictEqual(log, created)));
        };
    });
}
