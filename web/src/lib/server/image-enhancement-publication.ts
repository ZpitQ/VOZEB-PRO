import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { imageReferenceToDataUrl } from "@/app/api/image-tasks/image-task-support";
import { listCreativeAssets, registerCreativeAssets } from "./creative-runtime-store";
import { getEnhancementJob, mutateEnhancementJob, type ImageEnhancementJob, type StoredEnhancementArtifact } from "./database/image-enhancement-job-repository";
import type { EnhancementArtifact, EnhancementWorkerBudgets } from "./image-enhancement-worker-client";
import { writeAssetBytes } from "./generation-log-repository";
import { maintenanceWorkerContext } from "./maintenance-auth";
import type { ImageTask } from "./image-task-store";
import { getDatabaseProvider } from "./database/postgres";
import { queueRuntimeFileOperation, readRuntimeFile, writeRuntimeFile, type RuntimeFileDatabase } from "./creative-runtime-repository";

export class ImageEnhancementPublicationError extends Error {}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function publishImageEnhancement(lease: ImageEnhancementJob, task: ImageTask, origin: string, aiBytes?: Buffer) {
    const fence = () => ({ token: lease.leaseToken!, now: Date.now() });
    const current = async () => {
        const job = await getEnhancementJob(lease.id, lease.userId);
        if (!job || job.leaseToken !== lease.leaseToken || !job.leaseUntil || job.leaseUntil <= Date.now()) throw new ImageEnhancementPublicationError("lease_lost");
        if (job.cancelRequested) throw new ImageEnhancementPublicationError("cancel_requested");
        return job;
    };
    let job = await current();
    if (job.publication) return job;
    const plan = job.remotePlan;
    const expected = job.remoteResult;
    if (!plan || !expected || job.decision.status !== "queued") throw new ImageEnhancementPublicationError("invalid_enhancement_plan");
    const read = async (artifact: StoredEnhancementArtifact, role: "ai" | "delivery") => {
        const dataUrl = await imageReferenceToDataUrl({ dataUrl: artifact.url }, "enhancement.png", origin, maintenanceWorkerContext(job.userId), plan.budgets[role].maxBytes);
        const bytes = Buffer.from(dataUrl.split(",")[1] || "", "base64");
        await validate(bytes, artifact, plan.budgets[role]);
        return bytes;
    };
    const save = async (role: "ai" | "delivered", bytes: Buffer, artifact: EnhancementArtifact, deliveryEncodingMs?: number) => {
        await current();
        const saved = await writeAssetBytes(bytes, "image/png", "image", { ownerUserId: job.userId, source: task.source, conversationId: task.conversationId, taskId: job.id, originalName: role === "ai" ? "完整AI增强.png" : "AI高清增强.png" }).catch(() => { throw new ImageEnhancementPublicationError("output_storage_invalid"); });
        if (!saved.serverUrl?.startsWith("/api/generation-log-assets/") || saved.width !== artifact.width || saved.height !== artifact.height || saved.bytes !== bytes.length) throw new ImageEnhancementPublicationError("output_storage_invalid");
        const stored: StoredEnhancementArtifact = { ...artifact, url: saved.serverUrl };
        const updated = await mutateEnhancementJob(job.id, job.userId, (row) => ({ ...row, staged: { ...row.staged, [role]: stored }, ...(deliveryEncodingMs === undefined ? {} : { timings: { ...row.timings, deliveryEncodingMs } }), updatedAt: Date.now() }), fence());
        if (!updated) throw new ImageEnhancementPublicationError("lease_lost");
        job = updated;
        return stored;
    };
    let ai = job.staged?.ai;
    if (!ai) {
        if (!aiBytes) throw new ImageEnhancementPublicationError("output_unavailable");
        await validate(aiBytes, expected, plan.budgets.ai);
        ai = await save("ai", aiBytes, expected);
    }
    const completeAi = await read(ai, "ai");
    let delivered = job.staged?.delivered;
    if (!delivered) {
        const target = job.decision.target;
        if (Math.min(target.width / ai.width, target.height / ai.height) > 1) throw new ImageEnhancementPublicationError("unsupported_target");
        let bytes = completeAi;
        let dimensions = { width: ai.width, height: ai.height };
        let deliveryEncodingMs: number | undefined;
        if (ai.width > target.width || ai.height > target.height) {
            const startedAt = performance.now();
            const encoded = await sharp(completeAi, { failOn: "warning", limitInputPixels: plan.budgets.ai.maxPixels }).resize(target.width, target.height, { fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
            bytes = encoded.data;
            dimensions = { width: encoded.info.width, height: encoded.info.height };
            const elapsed = performance.now() - startedAt;
            if (Number.isFinite(elapsed) && elapsed >= 0) deliveryEncodingMs = elapsed;
        }
        const artifact: EnhancementArtifact = { ...dimensions, format: "png", byteLength: bytes.length, sha256: digest(bytes) };
        await validate(bytes, artifact, plan.budgets.delivery);
        delivered = ai.sha256 === artifact.sha256 ? ai : await save("delivered", bytes, artifact, deliveryEncodingMs);
    }
    await read(delivered, "delivery");
    const storedAi = ai;
    const storedDelivery = delivered;
    const verified = await mutateEnhancementJob(job.id, job.userId, (row) => row.phase === "publish" ? row : { ...row, phase: "publish", updatedAt: Date.now(), events: [...row.events, { stage: "storage_verified", at: Date.now(), attempt: row.attempt }] }, fence());
    if (!verified) throw new ImageEnhancementPublicationError("lease_lost");
    const commit = (runtime?: RuntimeFileDatabase) => mutateEnhancementJob(job.id, job.userId, async (row, executor) => {
        if (row.cancelRequested) throw new ImageEnhancementPublicationError("cancel_requested");
        if (row.publication) return row;
        let assetId: string | null = null;
        if (task.conversationId) {
            const original = (task.result?.results?.length ? task.result.results : task.result ? [task.result] : []).find((result) => result.resultId === row.resultId);
            if (!original || original.nativeSource?.sha256 !== row.decision.source.sha256) throw new ImageEnhancementPublicationError("native_identity_changed");
            const ordinal = task.result?.results?.findIndex((result) => result.resultId === row.resultId) ?? 0;
            const sourceRunId = task.runId || `${task.surface || "task"}:${task.projectId || task.conversationId}`;
            let parent = (await listCreativeAssets(task.conversationId, task.userId, executor, runtime)).find((asset) => asset.sourceTaskId === task.id && asset.ordinal === ordinal && asset.serverUrl === row.decision.source.url);
            if (!parent) [parent] = await registerCreativeAssets([{ userId: task.userId, conversationId: task.conversationId, sourceRunId, sourceTaskId: task.id, ordinal, type: "image", title: task.title || "原图", serverUrl: row.decision.source.url, storageKind: "local", width: original.width, height: original.height, bytes: original.bytes, mimeType: original.mimeType, metadata: { provenance: "provider_native", resultId: row.resultId } }], executor, runtime);
            if (!parent) throw new ImageEnhancementPublicationError("native_asset_unavailable");
            const [asset] = await registerCreativeAssets([{ id: `asset-enhancement-${digest(Buffer.from(row.id))}`, userId: task.userId, conversationId: task.conversationId, sourceRunId, sourceTaskId: row.id, parentAssetId: parent.id, ordinal: 0, type: "image", title: `${task.title || "图片"} · AI高清增强`, serverUrl: storedDelivery.url, storageKind: "local", width: storedDelivery.width, height: storedDelivery.height, bytes: storedDelivery.byteLength, mimeType: "image/png", metadata: { provenance: "ai_enhanced", parentResultId: row.resultId, parentAssetIds: [parent.id], enhancementId: row.id, nativeSha256: row.decision.source.sha256, sha256: storedDelivery.sha256 } }], executor, runtime);
            if (!asset) throw new ImageEnhancementPublicationError("asset_registration_failed");
            assetId = asset.id;
        }
        if (runtime) await writeRuntimeFile(runtime);
        const now = Date.now();
        return { ...row, staged: { ai: storedAi, delivered: storedDelivery }, publication: { ai: storedAi, delivered: storedDelivery, assetId, publishedAt: now }, status: "succeeded", phase: "receipt", reason: null, nextPollAt: now, updatedAt: now, events: [...row.events, { stage: "published", at: now, attempt: row.attempt }] };
    }, fence());
    // Match the existing creative -> generation -> enhancement lock order.
    const updated = getDatabaseProvider() === "postgres" ? await commit() : await queueRuntimeFileOperation(async () => commit(await readRuntimeFile()));
    if (!updated) throw new ImageEnhancementPublicationError("lease_lost");
    return updated;
}

async function validate(bytes: Buffer, expected: EnhancementArtifact, budget: EnhancementWorkerBudgets["ai"]) {
    if (bytes.length !== expected.byteLength || digest(bytes) !== expected.sha256 || bytes.length > budget.maxBytes || BigInt(expected.width) * BigInt(expected.height) > BigInt(budget.maxPixels)) throw new ImageEnhancementPublicationError("output_invalid");
    try {
        const image = sharp(bytes, { failOn: "warning", limitInputPixels: budget.maxPixels });
        const metadata = await image.metadata();
        const stats = await image.stats();
        if (metadata.format !== "png" || metadata.width !== expected.width || metadata.height !== expected.height || (metadata.orientation && metadata.orientation !== 1) || (metadata.pages && metadata.pages !== 1) || !stats.isOpaque) throw new Error("invalid pixels");
    } catch { throw new ImageEnhancementPublicationError("output_invalid"); }
}
