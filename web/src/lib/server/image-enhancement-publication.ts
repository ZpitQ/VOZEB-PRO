import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { imageReferenceToDataUrl } from "@/app/api/image-tasks/image-task-support";
import { listCreativeAssets, registerCreativeAssets } from "./creative-runtime-store";
import { getEnhancementJob, mutateEnhancementJob, type ImageEnhancementJob, type StoredEnhancementArtifact } from "./database/image-enhancement-job-repository";
import type { EnhancementWorkerBudgets } from "./image-enhancement-worker-client";
import { writeAssetBytes } from "./generation-log-repository";
import { maintenanceWorkerContext } from "./maintenance-auth";
import type { ImageTask } from "./image-task-store";
import { getDatabaseProvider } from "./database/postgres";
import { queueRuntimeFileOperation, readRuntimeFile, writeRuntimeFile, type RuntimeFileDatabase } from "./creative-runtime-repository";
import { enhancementNativeIdentityMatches } from "./image-enhancement-enqueue";
import { compositeProductEnhancement, type ProductEnhancementEvidence } from "./image-enhancement-product-protection";
import { compositeSceneEnhancement, type SceneEnhancementEvidence } from "./image-enhancement-scene-protection";
import { compositeSceneEdit } from "./ecommerce-product-regions";
import { getStoredGenerationTask } from "./generation-task-store";
import type { AgentRun } from "./agent-run-store";
import { ecommerceProductAnchorIdFromRun } from "./ecommerce-reference-roles";

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
        const dataUrl = await imageReferenceToDataUrl({ dataUrl: artifact.url }, `enhancement.${artifact.format === "jpeg" ? "jpg" : "png"}`, origin, maintenanceWorkerContext(job.userId), plan.budgets[role].maxBytes);
        const bytes = Buffer.from(dataUrl.split(",")[1] || "", "base64");
        await validate(bytes, artifact, plan.budgets[role]);
        return bytes;
    };
    const save = async (role: "ai" | "delivered", bytes: Buffer, artifact: Omit<StoredEnhancementArtifact, "url">, deliveryEncodingMs?: number) => {
        await current();
        const saved = await writeAssetBytes(bytes, `image/${artifact.format}`, "image", {
            ownerUserId: job.userId,
            source: task.source,
            conversationId: task.conversationId,
            taskId: job.id,
            originalName: `${role === "ai" ? "完整AI增强" : "AI高清增强"}.${artifact.format === "jpeg" ? "jpg" : "png"}`,
        }).catch(() => {
            throw new ImageEnhancementPublicationError("output_storage_invalid");
        });
        if (!saved.serverUrl?.startsWith("/api/generation-log-assets/") || saved.width !== artifact.width || saved.height !== artifact.height || saved.bytes !== bytes.length) throw new ImageEnhancementPublicationError("output_storage_invalid");
        const stored: StoredEnhancementArtifact = { ...artifact, url: saved.serverUrl };
        const updated = await mutateEnhancementJob(
            job.id,
            job.userId,
            (row) => ({ ...row, staged: { ...row.staged, [role]: stored }, ...(deliveryEncodingMs === undefined ? {} : { timings: { ...row.timings, deliveryEncodingMs } }), updatedAt: Date.now() }),
            fence(),
        );
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
    if (ai.width !== expected.width || ai.height !== expected.height || ai.format !== expected.format || ai.byteLength !== expected.byteLength || ai.sha256 !== expected.sha256) throw new ImageEnhancementPublicationError("output_invalid");
    let protection: ProductEnhancementEvidence | SceneEnhancementEvidence | undefined;
    let protectedBytes: Buffer | undefined;
    let protectedEncodingMs: number | undefined;
    const delivery = job.decision.delivery;
    if (delivery?.contract.scope === "product_background" || delivery?.contract.scope === "local_edit") {
        try {
            const contract = delivery.contract;
            const original = (task.result?.results?.length ? task.result.results : task.result ? [task.result] : []).find((result) => result.resultId === job.resultId);
            if (!original || !enhancementNativeIdentityMatches(task, original, job.decision.source, delivery)) throw new Error("Protection binding changed");
            const readFrozen = async (url: string) => {
                const dataUrl = await imageReferenceToDataUrl({ dataUrl: url }, "enhancement-protection.png", origin, maintenanceWorkerContext(job.userId), plan.budgets.input.maxBytes);
                const bytes = Buffer.from(dataUrl.split(",")[1] || "", "base64");
                if (bytes.length > plan.budgets.input.maxBytes) throw new Error("Protection source exceeds its byte limit");
                return bytes;
            };
            const [sourceBytes, nativeBytes, baselineBytes] = await Promise.all([readFrozen(contract.baseline.url), readFrozen(job.decision.source.url), read({ ...delivery.baseline, format: "png" }, "delivery")]);
            if (sourceBytes.length !== contract.baseline.byteLength || digest(sourceBytes) !== contract.baseline.sha256 || nativeBytes.length !== job.decision.source.byteLength || digest(nativeBytes) !== job.decision.source.sha256)
                throw new Error("Protection source digest changed");
            const normalized = await sharp(sourceBytes, { failOn: "warning", limitInputPixels: plan.budgets.ai.maxPixels }).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer({ resolveWithObject: true });
            if (normalized.info.width !== contract.baseline.width || normalized.info.height !== contract.baseline.height || digest(normalized.data) !== contract.baseline.normalizedSha256) throw new Error("Protection source normalization changed");
            const baseline =
                contract.scope === "local_edit" ? await compositeSceneEdit(sourceBytes, nativeBytes, contract.protection.scene) : await compositeProductEnhancement(sourceBytes, nativeBytes, contract.protection, plan.budgets.ai.maxPixels, "native");
            await validate(baseline.bytes, { ...delivery.baseline, format: "png" }, plan.budgets.delivery);
            const sceneProof = original.sceneProtectionEvidence;
            const expectedEvidence = contract.scope === "local_edit" && sceneProof ? (({ maskUrl: _mask, nativeUrl: _native, compositeUrl: _composite, ...evidence }) => evidence)(sceneProof) : original.productEnhancementEvidence?.composition;
            if (!baseline.bytes.equals(baselineBytes) || !isDeepStrictEqual(baseline.evidence, expectedEvidence)) throw new Error("Protected baseline evidence changed");
            const startedAt = performance.now();
            const final =
                contract.scope === "local_edit"
                    ? await compositeSceneEnhancement(baseline.bytes, completeAi, contract.protection, plan.budgets.ai.maxPixels)
                    : await compositeProductEnhancement(baseline.bytes, completeAi, contract.protection, plan.budgets.ai.maxPixels);
            const elapsed = performance.now() - startedAt;
            if (!isDeepStrictEqual(final.evidence.sourceSize, job.decision.target)) throw new Error("Protected delivery dimensions changed");
            protectedBytes = final.bytes;
            protection = final.evidence;
            if (Number.isFinite(elapsed) && elapsed >= 0) protectedEncodingMs = elapsed;
        } catch {
            throw new ImageEnhancementPublicationError("protection_invalid");
        }
    }
    let delivered = job.staged?.delivered;
    if (!delivered) {
        const target = job.decision.target;
        if (Math.min(target.width / ai.width, target.height / ai.height) > 1) throw new ImageEnhancementPublicationError("unsupported_target");
        let bytes = protectedBytes || completeAi;
        let dimensions = protectedBytes ? target : { width: ai.width, height: ai.height };
        let deliveryEncodingMs = protectedEncodingMs;
        if (!protectedBytes) {
            const startedAt = performance.now();
            const encoded = await sharp(completeAi, { failOn: "warning", limitInputPixels: plan.budgets.ai.maxPixels })
                .resize(target.width, target.height, { fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
                .toBuffer({ resolveWithObject: true });
            bytes = encoded.data;
            dimensions = { width: encoded.info.width, height: encoded.info.height };
            const elapsed = performance.now() - startedAt;
            if (Number.isFinite(elapsed) && elapsed >= 0) deliveryEncodingMs = elapsed;
        }
        const artifact: Omit<StoredEnhancementArtifact, "url"> = { ...dimensions, format: protectedBytes ? "png" : "jpeg", byteLength: bytes.length, sha256: digest(bytes) };
        await validate(bytes, artifact, plan.budgets.delivery);
        delivered = ai.sha256 === artifact.sha256 ? ai : await save("delivered", bytes, artifact, deliveryEncodingMs);
    }
    try {
        const bytes = await read(delivered, "delivery");
        if (protectedBytes && !bytes.equals(protectedBytes)) throw new ImageEnhancementPublicationError("protection_invalid");
    } catch (error) {
        if (protectedBytes) throw new ImageEnhancementPublicationError("protection_invalid");
        throw error;
    }
    const storedAi = ai;
    const storedDelivery = delivered;
    const sourceRun = task.runId ? await getStoredGenerationTask<AgentRun>("agent", task.runId) : null;
    const verified = await mutateEnhancementJob(
        job.id,
        job.userId,
        (row) => {
            const events = [...row.events];
            if (row.phase !== "publish") events.push({ stage: "storage_verified", at: Date.now(), attempt: row.attempt });
            if (protection && !events.some((event) => event.stage === "protection_verified" && event.attempt === row.attempt)) events.push({ stage: "protection_verified", at: Date.now(), attempt: row.attempt });
            return events.length === row.events.length ? row : { ...row, phase: "publish", updatedAt: Date.now(), events };
        },
        fence(),
    );
    if (!verified) throw new ImageEnhancementPublicationError("lease_lost");
    const commit = (runtime?: RuntimeFileDatabase) =>
        mutateEnhancementJob(
            job.id,
            job.userId,
            async (row, executor) => {
                if (row.cancelRequested) throw new ImageEnhancementPublicationError("cancel_requested");
                if (row.publication) return row;
                let assetId: string | null = null;
                if (task.conversationId) {
                    const original = (task.result?.results?.length ? task.result.results : task.result ? [task.result] : []).find((result) => result.resultId === row.resultId);
                    if (!original || !enhancementNativeIdentityMatches(task, original, row.decision.source, row.decision.delivery)) throw new ImageEnhancementPublicationError("native_identity_changed");
                    const ordinal = task.result?.results?.findIndex((result) => result.resultId === row.resultId) ?? 0;
                    const sourceRunId = task.runId || `${task.surface || "task"}:${task.projectId || task.conversationId}`;
                    const parentUrl = original.serverUrl || original.dataUrl;
                    const conversationAssets = await listCreativeAssets(task.conversationId, task.userId, executor, runtime);
                    let parent = conversationAssets.find((asset) => asset.sourceTaskId === task.id && asset.ordinal === ordinal && asset.serverUrl === parentUrl);
                    if (!parent) {
                        const run = sourceRun?.userId === task.userId && sourceRun.conversationId === task.conversationId ? sourceRun : null;
                        const productAnchorId = run ? ecommerceProductAnchorIdFromRun(run) : undefined;
                        const sceneRootAssetId = run?.ecommerceSnapshot?.continuity?.sceneRootAssetId;
                        const continuity = run?.ecommerceSnapshot?.continuity || run?.ecommerceSnapshot?.plan?.continuity;
                        const parentAssetIds = [...new Set([productAnchorId, sceneRootAssetId, ...(task.references || []).map((reference) => reference.id)].filter((id): id is string => Boolean(id)))];
                        const ecommerceContinuity =
                            (productAnchorId || sceneRootAssetId) && continuity
                                ? {
                                      productAnchorId: productAnchorId || null,
                                      sceneBaselineId: run?.ecommerceSnapshot?.plan?.source.currentSceneBaselineId || null,
                                      parentResultId: continuity.parentResultId,
                                      branchId: continuity.branchId,
                                      ...(sceneRootAssetId ? { sceneRootAssetId } : {}),
                                      ...(run?.ecommerceSnapshot?.qualityCheck ? { qualityStatus: run.ecommerceSnapshot.qualityCheck.publicStatus } : {}),
                                  }
                                : undefined;
                        if (
                            run?.ecommerceSnapshot &&
                            (!ecommerceContinuity || !conversationAssets.some((asset) => asset.id === parentAssetIds[0] && asset.userId === task.userId && asset.conversationId === task.conversationId && asset.type === "image" && asset.status === "ready"))
                        )
                            throw new ImageEnhancementPublicationError("native_asset_unavailable");
                        [parent] = await registerCreativeAssets(
                            [
                                {
                                    userId: task.userId,
                                    conversationId: task.conversationId,
                                    sourceRunId,
                                    sourceTaskId: task.id,
                                    parentAssetId: parentAssetIds[0],
                                    ordinal,
                                    type: "image",
                                    title: task.title || "原图",
                                    serverUrl: parentUrl,
                                    storageKind: "local",
                                    width: original.width,
                                    height: original.height,
                                    bytes: original.bytes,
                                    mimeType: original.mimeType,
                                    metadata: { provenance: protection ? "protected_baseline" : "provider_native", resultId: row.resultId, nativeSource: original.nativeSource, parentAssetIds, ...(ecommerceContinuity ? { ecommerceContinuity } : {}) },
                                },
                            ],
                            executor,
                            runtime,
                        );
                    }
                    if (!parent) throw new ImageEnhancementPublicationError("native_asset_unavailable");
                    const [asset] = await registerCreativeAssets(
                        [
                            {
                                id: `asset-enhancement-${digest(Buffer.from(row.id))}`,
                                userId: task.userId,
                                conversationId: task.conversationId,
                                sourceRunId,
                                sourceTaskId: row.id,
                                parentAssetId: parent.id,
                                ordinal: 0,
                                type: "image",
                                title: `${task.title || "图片"} · AI高清增强`,
                                serverUrl: storedDelivery.url,
                                storageKind: "local",
                                width: storedDelivery.width,
                                height: storedDelivery.height,
                                bytes: storedDelivery.byteLength,
                                mimeType: `image/${storedDelivery.format}`,
                                metadata: {
                                    provenance: "ai_enhanced",
                                    parentResultId: row.resultId,
                                    parentAssetIds: [parent.id],
                                    enhancementId: row.id,
                                    nativeSha256: row.decision.source.sha256,
                                    sha256: storedDelivery.sha256,
                                    ...(delivery ? { deliveryVersion: delivery.contract.version, scope: delivery.contract.scope } : {}),
                                    ...(protection ? { protection } : {}),
                                },
                            },
                        ],
                        executor,
                        runtime,
                    );
                    if (!asset) throw new ImageEnhancementPublicationError("asset_registration_failed");
                    assetId = asset.id;
                }
                if (runtime) await writeRuntimeFile(runtime);
                const now = Date.now();
                return {
                    ...row,
                    staged: { ai: storedAi, delivered: storedDelivery },
                    publication: { ai: storedAi, delivered: storedDelivery, assetId, publishedAt: now, ...(protection ? { protection } : {}) },
                    status: "succeeded",
                    phase: "receipt",
                    reason: null,
                    nextPollAt: now,
                    updatedAt: now,
                    events: [...row.events, { stage: "published", at: now, attempt: row.attempt }],
                };
            },
            fence(),
        );
    // Match the existing creative -> generation -> enhancement lock order.
    const updated = getDatabaseProvider() === "postgres" ? await commit() : await queueRuntimeFileOperation(async () => commit(await readRuntimeFile()));
    if (!updated) throw new ImageEnhancementPublicationError("lease_lost");
    return updated;
}

async function validate(bytes: Buffer, expected: Omit<StoredEnhancementArtifact, "url">, budget: EnhancementWorkerBudgets["ai"]) {
    if (bytes.length !== expected.byteLength || digest(bytes) !== expected.sha256 || bytes.length > budget.maxBytes || BigInt(expected.width) * BigInt(expected.height) > BigInt(budget.maxPixels))
        throw new ImageEnhancementPublicationError("output_invalid");
    try {
        const image = sharp(bytes, { failOn: "warning", limitInputPixels: budget.maxPixels });
        const metadata = await image.metadata();
        const stats = await image.stats();
        if (
            !["png", "jpeg"].includes(expected.format) ||
            metadata.format !== expected.format ||
            metadata.width !== expected.width ||
            metadata.height !== expected.height ||
            (metadata.orientation && metadata.orientation !== 1) ||
            (metadata.pages && metadata.pages !== 1) ||
            !stats.isOpaque
        )
            throw new Error("invalid pixels");
    } catch {
        throw new ImageEnhancementPublicationError("output_invalid");
    }
}
