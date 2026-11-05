import { createHash } from "node:crypto";
import { listCreativeAssets, registerCreativeAssets } from "./creative-runtime-store";
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { ImageTask } from "./image-task-store";
import type { QueryExecutor } from "./database/postgres";
import { writeRuntimeFile, type RuntimeFileDatabase } from "./creative-runtime-repository";
import { enhancementNativeIdentityMatches } from "./image-enhancement-enqueue";
import type { AgentRun } from "./agent-run-store";
import { ecommerceProductAnchorIdFromRun } from "./ecommerce-reference-roles";

export class ImageEnhancementPublicationError extends Error {}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function commitImageEnhancementPublication(
    row: ImageEnhancementJob,
    task: ImageTask,
    artifacts: Pick<NonNullable<ImageEnhancementJob["publication"]>, "ai" | "delivered" | "protection">,
    sourceRun: AgentRun | null,
    executor?: QueryExecutor,
    runtime?: RuntimeFileDatabase,
): Promise<ImageEnhancementJob> {
    const { ai: storedAi, delivered: storedDelivery, protection } = artifacts;
    const delivery = row.decision.delivery;
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
    if (runtime) {
        if (row.leaseUntil === null || row.leaseUntil <= Date.now()) throw new ImageEnhancementPublicationError("lease_lost");
        await writeRuntimeFile(runtime);
    }
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
}
