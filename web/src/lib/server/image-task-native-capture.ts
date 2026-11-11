import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import type { ImageTaskRunResult } from "@/app/api/image-tasks/image-task-types";
import { getDatabaseProvider, withPostgresTransaction, type QueryExecutor } from "./database";
import { systemGenerationChannelId } from "./generation-channel";
import { generationMediaProxyHeaders } from "./generation-media-authorization";
import { getStoredGenerationTaskRecord, withGenerationTaskFileMutation, type StoredGenerationTaskRecord } from "./generation-task-store";
import type { ImageTask } from "./image-task-store";
import { fetchInternalApi, resolveInternalOrigin } from "./internal-origin";
import { getLocalMediaRegistrations } from "./local-media-registry";
import { maintenanceWorkerContextHeaders } from "./maintenance-auth";
import { resolveModelRequestTimeoutMs } from "./model-request-policy";
import { writeReferenceMediaFile } from "./reference-asset-store";
import { fetchSafeOutbound, UnsafeOutboundUrlError } from "./safe-outbound-fetch";

type NativeCaptureInput = {
    taskId: string;
    workerId: string;
    executionId: string;
    attemptNo: number;
    upstreamTaskId: string | null;
    result: ImageTaskRunResult;
    origin: string;
    authContext: string;
};
type NativeResults = NonNullable<ImageTask["nativeResults"]>;
type NativeAcquisition = NonNullable<ImageTask["nativeAcquisition"]>;
type NativeCaptureOutcome = { state: "native_ready"; nativeResults: NativeResults } | { state: "ownership_lost" } | { state: "needs_review"; reason: "未能取得上游图片原件，需要人工确认。"; status: "image_native_acquisition_unavailable" };

const IMAGE_NATIVE_CLAIM_WHERE = `id = $1 AND task_type = 'image' AND user_id = $2
    AND payload ->> 'id' = $1 AND payload ->> 'userId' = $2
    AND status IN ('pending', 'running') AND payload ->> 'status' = status
    AND expires_at > clock_timestamp() AND lease_until > clock_timestamp()
    AND worker_id = $3 AND payload ->> 'executionId' = $4
    AND payload -> 'attemptNo' = to_jsonb($5::integer)
    AND upstream_task_id IS NOT DISTINCT FROM $6::text
    AND (($6::text IS NULL AND (payload -> 'upstream' IS NULL OR payload -> 'upstream' = 'null'::jsonb))
         OR ($6::text IS NOT NULL AND jsonb_typeof(payload #> '{upstream,id}') = 'string' AND payload #>> '{upstream,id}' = $6::text))
    AND run_id IS NOT DISTINCT FROM $7::text
    AND NULLIF(payload ->> 'runId', '') IS NOT DISTINCT FROM $7::text`;
const NATIVE_CAPTURE_CLAIM_WHERE = `${IMAGE_NATIVE_CLAIM_WHERE} AND payload ->> 'nativeResults' IS NULL`;
const NATIVE_REUSE_CLAIM_WHERE = `${IMAGE_NATIVE_CLAIM_WHERE} AND payload -> 'nativeResults' = $8::jsonb`;

export async function captureImageTaskNativeResults(input: NativeCaptureInput): Promise<NativeCaptureOutcome> {
    const original = await getStoredGenerationTaskRecord("image", input.taskId);
    if (!original || !matchesImageClaim(original, input, original.userId)) return { state: "ownership_lost" };
    const runId = original.runId || null;
    if (!matchesNativeRunBinding(original, runId)) return { state: "ownership_lost" };
    if (original.payload.nativeResults) return reuseImageTaskNativeResults(input, original.userId, runId, original.payload.nativeResults as NativeResults);
    if (runId !== null && !(await checkNativeCaptureRun(input, original.userId, runId))) return { state: "ownership_lost" };
    const results = input.result.results !== undefined ? input.result.results : [input.result];
    const previousAcquisition = original.payload.nativeAcquisition as NativeAcquisition | undefined;
    if (previousAcquisition && input.upstreamTaskId !== null) return { state: "ownership_lost" };
    let acquisition: NativeAcquisition | undefined;
    if (input.upstreamTaskId === null && (previousAcquisition || results.some((result) => result.dataUrl !== "" && !result.dataUrl.startsWith("data:")))) {
        if (previousAcquisition && (previousAcquisition.attemptNo !== input.attemptNo || previousAcquisition.upstreamTaskId !== null)) return { state: "ownership_lost" };
        acquisition = previousAcquisition ?? {
            version: "image-task-native-acquisition.v1",
            attemptNo: input.attemptNo,
            upstreamTaskId: null,
            slots: results.map((result, index) => ({
                resultId: `${input.taskId}:${index + 1}`,
                resultIndex: index + 1,
                ...(result.dataUrl === "" || result.dataUrl.startsWith("data:") ? {} : { source: { url: result.dataUrl } }),
            })),
        };
        for (const slot of acquisition.slots) {
            if (slot.source) nativeSourceUrl(slot.source.url, input.origin);
        }
        if (!(await preserveNativeAcquisition(input, original.userId, runId, acquisition, previousAcquisition))) return { state: "ownership_lost" };
    }
    const captureSlots: NativeAcquisition["slots"] = acquisition?.slots ?? results.map((_result, index) => ({ resultId: `${input.taskId}:${index + 1}`, resultIndex: index + 1 }));
    const slots: NativeResults["slots"] = [];
    let directory: string | undefined;
    try {
        for (const [index, target] of captureSlots.entries()) {
            const { resultId, resultIndex } = target;
            // Fresh mixed results still own their inline bytes; recovery only has persisted URL locators.
            const dataUrl = acquisition ? (target.source?.url ?? (previousAcquisition ? "" : results[index].dataUrl)) : results[index].dataUrl;
            if (dataUrl === "") {
                slots.push({ resultId, resultIndex, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
                continue;
            }
            const inline = /^data:[^;,]+;base64,([\s\S]+)$/.exec(dataUrl);
            let source: Buffer | undefined;
            if (inline) {
                source = Buffer.from(inline[1], "base64");
                if (!source.length || source.toString("base64") !== inline[1]) {
                    slots.push({ resultId, resultIndex, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
                    continue;
                }
            }
            directory ??= await mkdtemp(join(tmpdir(), "vozeb-image-task-native-"));
            const sourcePath = join(directory, `native-${resultIndex}`);
            if (source) await writeFile(sourcePath, source, { flag: "wx" });
            else if (!(await readImageTaskOriginalFile(dataUrl, sourcePath, original, input))) {
                slots.push({ resultId, resultIndex, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
                continue;
            }
            const hash = createHash("sha256");
            let bytes = 0;
            for await (const chunk of createReadStream(sourcePath)) {
                bytes += chunk.length;
                hash.update(chunk);
            }
            const sha256 = hash.digest("hex");
            let metadataFacts: { layout: NonNullable<Extract<NativeResults["slots"][number], { status: "stored" }>["layout"]>; metadataSize: { width: number; height: number } } | { metadataRejected: true };
            try {
                const metadata = await sharp(sourcePath, { limitInputPixels: false, failOn: "error" }).metadata();
                metadataFacts =
                    metadata.format && metadata.depth && metadata.channels
                        ? { layout: { format: metadata.format, depth: metadata.depth, channels: metadata.channels }, metadataSize: { width: metadata.width, height: metadata.height } }
                        : { metadataRejected: true };
            } catch {
                metadataFacts = { metadataRejected: true };
            }
            const stored = await writeReferenceMediaFile(sourcePath, "attachment", "application/octet-stream", true, {
                ownerUserId: original.userId,
                taskId: input.taskId,
                source: "image-task-native-result",
                conversationId: original.conversationId,
                projectId: original.projectId,
            });
            const [registration] = await getLocalMediaRegistrations([stored.token], { ownerUserId: original.userId });
            if (!registration) throw new Error("Native image attachment registration missing");
            const slot: NativeResults["slots"][number] = {
                resultId,
                resultIndex,
                status: "stored",
                assetId: stored.token,
                assetVersion: sha256,
                scope: "reference",
                storageKey: stored.token,
                storageProvider: registration.storageProvider === "object" ? "object" : "local",
                externalStorageId: registration.externalStorageId,
                sha256,
                bytes,
                ...metadataFacts,
            };
            slots.push(slot);
        }
        const nativeResults: NativeResults = { version: "image-task-native-results.v1", attemptNo: input.attemptNo, upstreamTaskId: input.upstreamTaskId, slots };
        const hasStored = slots.some((slot) => slot.status === "stored");

        if (getDatabaseProvider() === "postgres") {
            const parameters = [input.taskId, original.userId, input.workerId, input.executionId, input.attemptNo, input.upstreamTaskId, runId, acquisition ? JSON.stringify(acquisition) : null];
            const captureClaimWhere = `${NATIVE_CAPTURE_CLAIM_WHERE} AND payload -> 'nativeAcquisition' IS NOT DISTINCT FROM $8::jsonb`;
            return await withPostgresTransaction<NativeCaptureOutcome>(async (executor) => {
                if (!(await lockNativeRun(executor, runId, original.userId))) return { state: "ownership_lost" };
                const locked = await executor.query(`SELECT id FROM generation_tasks WHERE ${captureClaimWhere} FOR UPDATE`, parameters);
                if (!locked.rows[0]) return { state: "ownership_lost" };
                for (const slot of slots) {
                    if (slot.status === "stored") await recheckNativeRegistration(slot, original.userId, input.taskId, executor);
                }
                if (!hasStored) {
                    const checked = await executor.query(`SELECT id FROM generation_tasks WHERE ${captureClaimWhere}`, parameters);
                    return checked.rows[0] ? { state: "needs_review", reason: "未能取得上游图片原件，需要人工确认。", status: "image_native_acquisition_unavailable" } : { state: "ownership_lost" };
                }
                // The registry lock can outlive the lease, so the final UPDATE uses the same SQL clock predicate.
                const updated = await executor.query<{ native_results: NativeResults }>(
                    `UPDATE generation_tasks
                     SET payload = (payload - 'nativeAcquisition' - 'result')
                         || CASE WHEN payload #> '{result,batchEvidence}' IS NOT NULL
                                 THEN jsonb_build_object('result', jsonb_build_object('dataUrl', '', 'batchEvidence', payload #> '{result,batchEvidence}'))
                                 ELSE '{}'::jsonb END
                         || jsonb_build_object('nativeResults', $9::jsonb, 'updatedAt', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint),
                         updated_at = clock_timestamp()
                     WHERE ${captureClaimWhere}
                     RETURNING payload -> 'nativeResults' AS native_results`,
                    [...parameters, JSON.stringify(nativeResults)],
                );
                return updated.rows[0] ? { state: "native_ready", nativeResults: updated.rows[0].native_results } : { state: "ownership_lost" };
            });
        }
        return await withGenerationTaskFileMutation<NativeCaptureOutcome>(async (records) => {
            const current = records.find((record) => record.id === input.taskId && record.type === "image");
            if (
                !current ||
                !matchesImageClaim(current, input, original.userId) ||
                !matchesNativeRunBinding(current, runId) ||
                !matchesNativeRun(records, runId, original.userId) ||
                current.payload.nativeResults ||
                !isDeepStrictEqual(current.payload.nativeAcquisition, acquisition)
            )
                return { tasks: records, result: { state: "ownership_lost" } };
            for (const slot of slots) {
                if (slot.status === "stored") await recheckNativeRegistration(slot, original.userId, input.taskId);
            }
            const now = Date.now();
            if (current.expiresAt <= now || current.leaseUntil === undefined || current.leaseUntil <= now) return { tasks: records, result: { state: "ownership_lost" } };
            if (!hasStored) return { tasks: records, result: { state: "needs_review", reason: "未能取得上游图片原件，需要人工确认。", status: "image_native_acquisition_unavailable" } };
            const batchEvidence = (current.payload as ImageTask).result?.batchEvidence;
            const updated = { ...current, updatedAt: now, payload: { ...current.payload, nativeAcquisition: undefined, result: batchEvidence ? { dataUrl: "", batchEvidence } : undefined, nativeResults, updatedAt: now } };
            return { tasks: records.map((record) => (record === current ? updated : record)), result: { state: "native_ready", nativeResults } };
        });
    } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
    }
}

async function preserveNativeAcquisition(input: NativeCaptureInput, userId: string, runId: string | null, acquisition: NativeAcquisition, previous: NativeAcquisition | undefined) {
    if (getDatabaseProvider() === "postgres") {
        const parameters = [input.taskId, userId, input.workerId, input.executionId, input.attemptNo, input.upstreamTaskId, runId, previous ? JSON.stringify(previous) : null];
        const acquisitionClaimWhere = `${NATIVE_CAPTURE_CLAIM_WHERE} AND payload -> 'nativeAcquisition' IS NOT DISTINCT FROM $8::jsonb`;
        return withPostgresTransaction(async (executor) => {
            if (!(await lockNativeRun(executor, runId, userId))) return false;
            const locked = await executor.query(`SELECT id FROM generation_tasks WHERE ${acquisitionClaimWhere} FOR UPDATE`, parameters);
            if (!locked.rows[0]) return false;
            const updated = await executor.query(
                `UPDATE generation_tasks
                 SET payload = payload || jsonb_build_object('nativeAcquisition', $9::jsonb, 'updatedAt', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint),
                     updated_at = clock_timestamp()
                 WHERE ${acquisitionClaimWhere}
                 RETURNING id`,
                [...parameters, JSON.stringify(acquisition)],
            );
            return Boolean(updated.rows[0]);
        });
    }
    return withGenerationTaskFileMutation(async (records) => {
        const current = records.find((record) => record.id === input.taskId && record.type === "image");
        const now = Date.now();
        if (
            !current ||
            !matchesImageClaim(current, input, userId) ||
            !matchesNativeRunBinding(current, runId) ||
            !matchesNativeRun(records, runId, userId) ||
            current.payload.nativeResults ||
            !isDeepStrictEqual(current.payload.nativeAcquisition, previous) ||
            current.expiresAt <= now ||
            current.leaseUntil === undefined ||
            current.leaseUntil <= now
        )
            return { tasks: records, result: false };
        const updated = { ...current, updatedAt: now, payload: { ...current.payload, nativeAcquisition: acquisition, updatedAt: now } };
        return { tasks: records.map((record) => (record === current ? updated : record)), result: true };
    });
}

function nativeSourceUrl(value: string, origin?: string) {
    if (value.startsWith("/api/ai/system/")) {
        if (!origin) throw new Error("Not implemented: system original capture without request origin");
        if (!/^\/api\/ai\/system\/[^/\\?#]+\/_media$/.test(value.split("?")[0])) throw new Error("Not implemented: non-canonical system native capture");
        const url = new URL(value, origin);
        directNativeUrl(url.searchParams.get("url") || "");
        return value;
    }
    return directNativeUrl(value);
}

function directNativeUrl(value: string) {
    if (!/^https?:\/\//i.test(value)) throw new Error("Not implemented: non-direct native capture");
    const url = new URL(value);
    if (url.username || url.password) throw new UnsafeOutboundUrlError();
    if (url.pathname === "/api/media-proxy" || /^\/api\/ai\/system\/[^/]+\/(?:v1\/|v1beta\/)?_media(?:\/|$)/.test(url.pathname)) throw new Error("Not implemented: internal proxy native capture");
    return value;
}

export async function readImageTaskOriginalFile(value: string, sourcePath: string, original: StoredGenerationTaskRecord, input?: Pick<NativeCaptureInput, "origin" | "authContext">) {
    const url = nativeSourceUrl(value, input?.origin);
    const config = original.payload.config as ImageTask["config"];
    const internal = url.startsWith("/");
    let requestUrl = url;
    let headers: Headers | undefined;
    if (internal) {
        if (!input) throw new Error("Not implemented: system original capture without request context");
        const target = new URL(url, resolveInternalOrigin(input.origin));
        const channelId = original.channelId || config.channelId || systemGenerationChannelId(config.baseUrl);
        if (!channelId || systemGenerationChannelId(target.pathname.slice(0, -"/_media".length)) !== channelId) throw new Error("Native image system channel binding changed");
        headers = new Headers(maintenanceWorkerContextHeaders(input.authContext) || (input.authContext ? { cookie: input.authContext } : undefined));
        const signed = generationMediaProxyHeaders({ userId: original.userId, taskType: "image", taskId: original.id, channelId, upstreamModel: config.model, url: target.searchParams.get("url") || "" });
        for (const [key, value] of Object.entries(signed)) headers.set(key, value);
        requestUrl = target.toString();
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(resolveModelRequestTimeoutMs(config, "image"))]);
    try {
        let response: Response;
        try {
            response = await (internal ? fetchInternalApi : fetchSafeOutbound)(requestUrl, { headers, cache: "no-store", signal });
        } catch {
            return false;
        }
        if (!response.ok || !response.body) return false;
        const file = await open(sourcePath, "wx");
        const reader = response.body.getReader();
        let bytes = 0;
        try {
            while (true) {
                let part: ReadableStreamReadResult<Uint8Array>;
                try {
                    part = await reader.read();
                } catch {
                    return false;
                }
                if (part.done) return bytes > 0;
                await file.writeFile(part.value);
                bytes += part.value.byteLength;
            }
        } finally {
            reader.releaseLock();
            await file.close();
        }
    } finally {
        controller.abort();
    }
}

async function reuseImageTaskNativeResults(input: NativeCaptureInput, userId: string, runId: string | null, nativeResults: NativeResults): Promise<NativeCaptureOutcome> {
    if (nativeResults.attemptNo !== input.attemptNo || nativeResults.upstreamTaskId !== input.upstreamTaskId) return { state: "ownership_lost" };
    if (getDatabaseProvider() === "postgres") {
        const parameters = [input.taskId, userId, input.workerId, input.executionId, input.attemptNo, input.upstreamTaskId, runId, JSON.stringify(nativeResults)];
        return withPostgresTransaction<NativeCaptureOutcome>(async (executor) => {
            if (!(await lockNativeRun(executor, runId, userId))) return { state: "ownership_lost" };
            const locked = await executor.query(`SELECT id FROM generation_tasks WHERE ${NATIVE_REUSE_CLAIM_WHERE} FOR UPDATE`, parameters);
            if (!locked.rows[0]) return { state: "ownership_lost" };
            for (const slot of nativeResults.slots) {
                if (slot.status === "stored") await recheckNativeRegistration(slot, userId, input.taskId, executor);
            }
            const checked = await executor.query<{ native_results: NativeResults }>(`SELECT payload -> 'nativeResults' AS native_results FROM generation_tasks WHERE ${NATIVE_REUSE_CLAIM_WHERE}`, parameters);
            return checked.rows[0] ? { state: "native_ready", nativeResults: checked.rows[0].native_results } : { state: "ownership_lost" };
        });
    }
    return withGenerationTaskFileMutation<NativeCaptureOutcome>(async (records) => {
        const current = records.find((record) => record.id === input.taskId && record.type === "image");
        if (!current || !matchesImageClaim(current, input, userId) || !matchesNativeRunBinding(current, runId) || !matchesNativeRun(records, runId, userId) || !isDeepStrictEqual(current.payload.nativeResults, nativeResults))
            return { tasks: records, result: { state: "ownership_lost" } };
        const claimCheckedAt = Date.now();
        if (current.expiresAt <= claimCheckedAt || current.leaseUntil === undefined || current.leaseUntil <= claimCheckedAt) return { tasks: records, result: { state: "ownership_lost" } };
        for (const slot of nativeResults.slots) {
            if (slot.status === "stored") await recheckNativeRegistration(slot, userId, input.taskId);
        }
        const now = Date.now();
        if (current.expiresAt <= now || current.leaseUntil === undefined || current.leaseUntil <= now) return { tasks: records, result: { state: "ownership_lost" } };
        return { tasks: records, result: { state: "native_ready", nativeResults } };
    });
}

async function checkNativeCaptureRun(input: NativeCaptureInput, userId: string, runId: string) {
    if (getDatabaseProvider() === "postgres") {
        return withPostgresTransaction(async (executor) => {
            if (!(await lockNativeRun(executor, runId, userId))) return false;
            const checked = await executor.query(`SELECT id FROM generation_tasks WHERE ${NATIVE_CAPTURE_CLAIM_WHERE} FOR UPDATE`, [input.taskId, userId, input.workerId, input.executionId, input.attemptNo, input.upstreamTaskId, runId]);
            return Boolean(checked.rows[0]);
        });
    }
    return withGenerationTaskFileMutation(async (records) => {
        const current = records.find((record) => record.id === input.taskId && record.type === "image");
        const now = Date.now();
        const valid = Boolean(
            current &&
            matchesImageClaim(current, input, userId) &&
            matchesNativeRunBinding(current, runId) &&
            matchesNativeRun(records, runId, userId) &&
            !current.payload.nativeResults &&
            current.expiresAt > now &&
            current.leaseUntil !== undefined &&
            current.leaseUntil > now,
        );
        return { tasks: records, result: valid };
    });
}

async function lockNativeRun(executor: QueryExecutor, runId: string | null, userId: string) {
    if (runId === null) return true;
    // Run payload statuses normalize differently from generation row statuses.
    const locked = await executor.query(
        `SELECT id FROM generation_tasks
         WHERE id = $1 AND task_type = 'agent' AND user_id = $2
           AND payload ->> 'id' = $1 AND payload ->> 'userId' = $2
           AND status NOT IN ('success', 'error', 'cancelled')
           AND COALESCE(payload ->> 'status', '') NOT IN ('completed', 'failed', 'cancelled')
           AND (payload -> 'cancellation' IS NULL OR payload -> 'cancellation' = 'null'::jsonb)
         FOR UPDATE`,
        [runId, userId],
    );
    return Boolean(locked.rows[0]);
}

function matchesNativeRunBinding(record: StoredGenerationTaskRecord, runId: string | null) {
    return (record.runId || null) === runId && (record.payload.runId || null) === runId;
}

function matchesNativeRun(records: StoredGenerationTaskRecord[], runId: string | null, userId: string) {
    if (runId === null) return true;
    const run = records.find((record) => record.id === runId && record.type === "agent");
    return Boolean(
        run &&
        run.userId === userId &&
        run.payload.id === runId &&
        run.payload.userId === userId &&
        !run.payload.cancellation &&
        run.status !== "success" &&
        run.status !== "error" &&
        run.status !== "cancelled" &&
        run.payload.status !== "completed" &&
        run.payload.status !== "failed" &&
        run.payload.status !== "cancelled",
    );
}

function matchesImageClaim(record: StoredGenerationTaskRecord, input: NativeCaptureInput, userId: string) {
    const upstream = record.payload.upstream;
    if (upstream != null && (typeof upstream !== "object" || !("id" in upstream) || typeof upstream.id !== "string")) return false;
    return (
        record.id === input.taskId &&
        record.type === "image" &&
        record.userId === userId &&
        record.payload.id === input.taskId &&
        record.payload.userId === userId &&
        (record.status === "pending" || record.status === "running") &&
        record.payload.status === record.status &&
        record.workerId === input.workerId &&
        record.payload.executionId === input.executionId &&
        record.payload.attemptNo === input.attemptNo &&
        (record.upstreamTaskId ?? null) === input.upstreamTaskId &&
        (upstream == null ? null : upstream.id) === input.upstreamTaskId
    );
}

async function recheckNativeRegistration(slot: Extract<NativeResults["slots"][number], { status: "stored" }>, userId: string, taskId: string, executor?: QueryExecutor) {
    const [registration] = await getLocalMediaRegistrations([slot.storageKey], { ownerUserId: userId, executor, forUpdate: Boolean(executor) });
    if (
        !registration ||
        registration.ownerUserId !== userId ||
        registration.taskId !== taskId ||
        registration.scope !== slot.scope ||
        registration.storageKey !== slot.storageKey ||
        registration.storageClass !== "permanent" ||
        registration.type !== "attachment" ||
        registration.mimeType !== "application/octet-stream" ||
        registration.source !== "image-task-native-result" ||
        registration.bytes !== slot.bytes ||
        (registration.storageProvider === "object" ? "object" : "local") !== slot.storageProvider ||
        registration.externalStorageId !== slot.externalStorageId
    )
        throw new Error("Native image attachment registration changed");
}
