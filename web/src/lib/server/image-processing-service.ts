import { imageProcessingFailureIdentity, imageProcessingPauseMessage, type ClosedImageProcessingFailure } from "./image-processing-failure";
import { repairAgentImageProcessingPause } from "./agent-run-image-processing-projection";
import { readEnhancementProcessingTask, closeEnhancementProcessingFailure, type EnhancementProcessingPayload } from "./image-enhancement-processing-store";
import {
    claimEnhancementProcessingTask,
    heartbeatEnhancementProcessing,
    readEnhancementProcessingInput,
    writeEnhancementProcessingOutput,
    completeEnhancementProcessing,
    closeEnhancementProcessingCancellation,
    resumeUnstartedEnhancementPublication as resumeUnstartedEnhancement,
    retryEnhancementPublication as retryEnhancement,
    cancelEnhancementPublication as cancelEnhancement,
} from "./image-enhancement-processing";
import { EnhancementProcessingConflict } from "./image-enhancement-processing-store";
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { EcommerceVisualReviewCheckpoint, EcommerceVisualReviewSource } from "./ecommerce-generation-snapshot";
import type { PreparedEcommerceQualityView } from "./ecommerce-quality-check";
import type { EcommerceGenerationTrace } from "./ecommerce-generation-trace";
import { independentAdvisoryReview, reviewContextDigest, reviewDigest, reviewQualityDigest, reviewRegionTuple, reviewSourceTuple } from "./ecommerce-visual-review-identity";
import { fileImageResultRun, imageResultRunMatches, nativeGlobalSceneResultTaskMatches, nativeProductResultTaskMatches, readImageResultRun, type ImageResultRun, type ImageResultRunBinding } from "./image-task-result-run";
import { createHash, randomUUID } from "node:crypto";
import { normalizeQuality, resolveResultSize, resolveEcommerceCanvasRequestSize, parseImageDimensions } from "@/lib/image-generation-size";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { isDeepStrictEqual } from "node:util";
import sharp, { type Metadata } from "sharp";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import type {
    ImageProcessingArtifact,
    ImageProcessingGenerationInput,
    ImageProcessingEnhancementBaseline,
    ImageProcessingInput,
    ImageProcessingOperation,
    ImageProcessingOutcome,
    ImageProcessingProtectionOptions,
    ImageProcessingRectangle,
    ImageProcessingResult,
    ImageProcessingResultOptions,
    ImageProcessingResultBinding,
    ProductEnhancementEvidence,
    SceneProtectionEvidence,
    SceneProtectionSnapshot,
} from "@/lib/image-processing/contracts";
import { validPixelRectangle } from "@/lib/image-processing/protection-masks";
import { imageMimeType, orientedDimensions } from "@/lib/image-processing/generated-image";
import { imageProcessingResourceConfig } from "@/lib/image-processing/resource-config";
import { decideImageProcessingAdmission, estimateImageProcessingMemory, type EncodedImageProcessingInput, type ImageProcessingResourceFacts } from "@/lib/image-processing/resource-model";
import type { AgentRun } from "./agent-run-store";
import { queueRuntimeFileOperation, type RunMutationContext } from "./creative-runtime-repository";
import { createPostgresRepositories, ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction, type QueryExecutor } from "./database";
import { referenceAssetVersion, referenceSourcesLoaded, type EcommerceReferenceCheckpoint } from "./ecommerce-reference-recovery";
import { ECOMMERCE_IMAGE_MAX_INPUT_PIXELS, ECOMMERCE_VISION_IMAGE_MAX_BYTES, ECOMMERCE_VISION_IMAGE_MAX_DIMENSION } from "./ecommerce-vision-image";
import { getStoredGenerationTask, getStoredGenerationTaskRecord, withGenerationTaskFileRead, withGenerationTaskFileMutation } from "./generation-task-store";
import type { StoredGenerationTaskRecord } from "./generation-task-types";
import type { ImageTask } from "./image-task-store";
import { refundImageTaskBilling } from "./image-task-refund";
import { normalizeGenerationLogRequestSnapshot, readGenerationLogDb } from "./generation-log-repository";
import { writeImageGenerationLog } from "@/app/api/image-tasks/image-task-runner";
import { getLocalMediaRegistration, getLocalMediaRegistrations, isLocalMediaRegistrationExpired, type LocalMediaRegistration } from "./local-media-registry";
import { GENERATION_MEDIA_ROOT, REFERENCE_MEDIA_ROOT } from "./local-media-storage";
import { readExternalMediaStream } from "./object-storage-service";
import { writeReferenceMediaFile } from "./reference-asset-store";
import {
    isNativeSceneImageTaskResult,
    isNativeGlobalSceneImageTaskResult,
    isNativeProductImageTaskResult,
    imageTaskNativeSceneBaseline,
    imageTaskResultSourceIdentityDigest,
    canonicalImageTaskResultValue,
    imageTaskResultReferenceLocation,
    imageTaskResultReferenceUrl,
    imageTaskResultInputsMatch,
    imageTaskResultMaskBytes,
    imageTaskResultFrozenSourceRegistrationMatches,
} from "./image-task-result-contract";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { toLegacyEcommerceVisualAnalysis } from "./ecommerce-reference-roles";
import { buildProductProtectionRegions, buildSceneProductProtectionRegions, STRICT_PRODUCT_COMPILER_VERSION } from "./ecommerce-product-regions";
import { resolveLocalEditTarget } from "./ecommerce-edit-planner";
import { assetAccessUrl } from "./agent-run-surface-policy";
import { originalImageSourceUrl } from "@/lib/media-image-url";
import { cancellationExecutionPatch, type GenerationCancellationTarget } from "./generation-task-cancellation-service";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";

type StoredImageProcessingOperation = Extract<ImageProcessingOperation, { operation: "prepare_reference" | "prepare_review" | "build_protection" | "process_result" }>;

export type EnqueueImageProcessingInput = StoredImageProcessingOperation & {
    runId: string;
    parentExecutionId: string;
    parentTaskId?: string;
    algorithmVersion: string;
    inputs: Omit<ImageProcessingInput, "path">[];
};

export type AgentImageProcessingPayload = StoredImageProcessingOperation & {
    version: "image-processing.v1";
    inputDigest: string;
    algorithmVersion: string;
    inputs: Omit<ImageProcessingInput, "path">[];
    sources: ImageProcessingMediaReference[];
    resource: {
        profileVersion: string;
        requiredMemoryBytes?: number;
        facts: ImageProcessingResourceFacts;
        configuration: Omit<ReturnType<typeof imageProcessingResourceConfig>, "profileVersion">;
        unavailable?: { code: "image_processing_resource_unavailable"; reason: "profile_uncalibrated" | "exceeds_total_budget" };
    };
    executionId?: string;
    parentMask?: { inputIndex: number; imageTaskId: string };
    reviewBinding?: { attempt: number; contextDigest: string; sourceIndex: number; viewIndex: number };
    imageResultBinding?: { imageTaskId: string; userId: string; nativeResults: NonNullable<ImageTask["nativeResults"]>; run?: ImageResultRunBinding; sourceIdentityDigest?: string };
};

export type ImageProcessingPayload = AgentImageProcessingPayload | EnhancementProcessingPayload;

export type ImageProcessingMediaReference = {
    inputIndex: number;
    scope: LocalMediaRegistration["scope"];
    storageKey: string;
    storageProvider: "local" | "object";
    externalStorageId?: string;
    frozenResultSource?: true;
};

export type StoredImageProcessingArtifact = Omit<ImageProcessingArtifact, "path"> & { storageKey: string };
export type ImageProcessingManifest = Omit<ImageProcessingResult, "metrics" | "artifacts"> & { artifacts: StoredImageProcessingArtifact[] };
export type SceneSelectionReceipt = {
    version: "scene-selection-receipt.v1";
    parentTaskId: string;
    baseline: { assetId: string; assetVersion: string; sha256: string; bytes: number; width: number; height: number };
    prepare: { jobId: string; inputDigest: string; executionId: string; manifestDigest: string; assetVersion: string };
    region: ImageProcessingRectangle;
    semantics: string[];
    confirmation: { actorUserId: string; confirmedAt: number };
};
type ImageProcessingStageReference = { jobId: string; inputDigest: string; manifest?: ImageProcessingManifest };
export type ImageProcessingCheckpoint = {
    version: "image-processing-checkpoint.v1";
    prepareReferences: Array<ImageProcessingStageReference & { assetId: string; assetVersion: string }>;
    generationReferences?: Array<ImageProcessingStageReference & { parentTaskId: string; assetId: string; assetVersion: string; generationInput: ImageProcessingGenerationInput; planDigest: string }>;
    sceneSelection?: SceneSelectionReceipt;
    protection?: ImageProcessingStageReference & { generationInput?: ImageProcessingGenerationInput };
    waitingFor?: ImageProcessingStageReference;
};

export type ImageProcessingTask = Omit<StoredGenerationTaskRecord, "type" | "payload"> & {
    type: "image_processing";
    payload: AgentImageProcessingPayload;
};

export type ClaimImageProcessingInput = { workerId: string; profileVersion: string; availableMemoryBytes: number; slots: number };
export type ClaimedImageProcessingTask = { id: string; executionId: string; leaseUntil: number; payload: ImageProcessingPayload; inputUrls: string[] };

export type CompleteImageProcessingInput = { workerId: string; executionId: string; manifest: ImageProcessingManifest; metrics: ImageProcessingResult["metrics"] };
export type CompletedImageProcessingStage = { jobId: string; inputDigest: string; executionId: string; manifest: ImageProcessingManifest; parentRescheduled: boolean };
export type { ClosedImageProcessingFailure } from "./image-processing-failure";
export type FailImageProcessingInput = { workerId: string; executionId: string; failure: ClosedImageProcessingFailure };
export type FailedImageProcessingStage = { jobId: string; status: "error" | "paused"; executionPhase: "needs_review" };

export async function cancelImageTask(task: ImageTask, executionPhase: GenerationCancellationTarget["executionPhase"]): Promise<ImageTask> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (executor) => {
            const run = await readImageResultRun(task.runId, executor, true);
            const image = await readImageProcessingFinalImage(task.id, executor, true);
            const current = image?.payload.resultProcessing ? await readImageProcessingStage(image.payload.resultProcessing.jobId, executor, true) : undefined;
            const clock = await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now");
            const now = clock.rows[0].now.getTime();
            assertImageCancellationParent(image, task, now);
            if (image.payload.resultProcessing) {
                requireImageProcessingStage(current);
                assertImageCancellationResult(image, current, run, now);
                if (current.status === "pending" || current.status === "running") {
                    const pending = current.status === "pending";
                    const updated = await executor.query(
                        `UPDATE generation_tasks SET status = 'cancelled', execution_phase = $6, next_poll_at = NULL, updated_at = clock_timestamp()${pending ? ", worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL" : ""}
                         WHERE id = $1 AND task_type = 'image_processing' AND user_id = $2 AND parent_task_id = $3
                           AND run_id IS NOT DISTINCT FROM $4::text AND status = $5 AND expires_at > clock_timestamp()
                           AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM generation_tasks AS parent WHERE parent.id = $4 AND parent.task_type = 'agent' AND parent.expires_at > clock_timestamp()))
                         RETURNING id`,
                        [current.id, task.userId, task.id, current.runId || null, current.status, pending ? "completed" : "cancel_requested"],
                    );
                    if (!updated.rows[0]) throw new ImageProcessingInputError("图像阶段归属或有效期已失效", 409);
                }
            }
            const { cancelled, execution } = cancelledImageTask(image.payload, executionPhase, now);
            const updated = await executor.query(
                `UPDATE generation_tasks SET status = 'cancelled', payload = $3::jsonb, updated_at = $4, expires_at = $5,
                 execution_phase = 'cancel_requested', next_poll_at = $4, worker_id = NULL, lease_until = NULL,
                 upstream_task_id = COALESCE($6::text, upstream_task_id), channel_id = COALESCE($7::text, channel_id),
                 provider = COALESCE($8::text, provider), query_path = COALESCE($9::text, query_path),
                 last_upstream_status = $10, result_payload = $11::jsonb
                 WHERE id = $1 AND task_type = 'image' AND user_id = $2 AND status IN ('pending', 'running') AND expires_at > clock_timestamp()
                 RETURNING id`,
                [
                    task.id,
                    task.userId,
                    JSON.stringify(cancelled),
                    new Date(now),
                    new Date(now + GENERATION_TASK_RETENTION_MS),
                    execution.upstreamTaskId || null,
                    execution.channelId || null,
                    execution.provider || null,
                    execution.queryPath || null,
                    execution.lastUpstreamStatus,
                    JSON.stringify(execution.resultPayload),
                ],
            );
            if (!updated.rows[0]) throw new ImageProcessingInputError("当前任务无法取消", 409);
            return cancelled;
        });
    }
    return queueRuntimeFileOperation(() =>
        withGenerationTaskFileMutation(async (records) => {
            const now = Date.now();
            const record = records.find((item) => item.type === "image" && item.id === task.id);
            const image = record && { ...record, payload: record.payload as ImageTask };
            assertImageCancellationParent(image, task, now);
            const resultProcessing = image.payload.resultProcessing;
            const child = resultProcessing ? records.find((item) => item.type === "image_processing" && item.id === resultProcessing.jobId) : undefined;
            if (resultProcessing) {
                const current = child && imageProcessingStageFromRecord(child);
                requireImageProcessingStage(current);
                assertImageCancellationResult(image, current, fileImageResultRun(records, image.runId), now);
            }
            const { cancelled, execution } = cancelledImageTask(image.payload, executionPhase, now);
            return {
                tasks: records.map((item): StoredGenerationTaskRecord =>
                    item === record
                        ? {
                              ...item,
                              status: "cancelled",
                              payload: cancelled,
                              updatedAt: now,
                              expiresAt: now + GENERATION_TASK_RETENTION_MS,
                              executionPhase: execution.executionPhase,
                              nextPollAt: execution.nextPollAt,
                              lastUpstreamStatus: execution.lastUpstreamStatus,
                              resultPayload: execution.resultPayload,
                              ...(execution.upstreamTaskId ? { upstreamTaskId: execution.upstreamTaskId } : {}),
                              ...(execution.channelId ? { channelId: execution.channelId } : {}),
                              ...(execution.provider ? { provider: execution.provider } : {}),
                              ...(execution.queryPath ? { queryPath: execution.queryPath } : {}),
                              workerId: undefined,
                              leaseUntil: undefined,
                          }
                        : item === child && (item.status === "pending" || item.status === "running")
                          ? {
                                ...item,
                                status: "cancelled",
                                executionPhase: item.status === "pending" ? "completed" : "cancel_requested",
                                nextPollAt: undefined,
                                updatedAt: now,
                                ...(item.status === "pending" ? { workerId: undefined, leaseUntil: undefined, lastHeartbeatAt: undefined } : {}),
                            }
                          : item,
                ),
                result: cancelled,
            };
        }),
    );
}

function cancelledImageTask(image: ImageTask, executionPhase: GenerationCancellationTarget["executionPhase"], now: number) {
    const cancelled: ImageTask = { ...image, status: "cancelled", error: "任务已取消", retryable: false, updatedAt: now };
    const execution = cancellationExecutionPatch({ type: "image", taskId: image.id, userId: image.userId, executionPhase, upstreamTaskId: image.upstream?.id, queryPath: image.config.advancedConfig?.queryPath, config: image.config }, now);
    return { cancelled, execution };
}

function assertImageCancellationParent(image: ImageProcessingFinalImage | undefined, task: ImageTask, now: number): asserts image is ImageProcessingFinalImage {
    if (
        !image ||
        image.userId !== task.userId ||
        image.payload.id !== image.id ||
        image.payload.userId !== image.userId ||
        image.runId !== task.runId ||
        image.payload.runId !== image.runId ||
        image.payload.status !== image.status ||
        (image.status !== "pending" && image.status !== "running") ||
        image.expiresAt <= now
    )
        throw new ImageProcessingInputError("当前任务无法取消", 409);
}

function assertImageProcessingCancellationBinding(stage: ImageProcessingStageState) {
    const binding = stage.payload.imageResultBinding;
    if (!binding || stage.payload.version !== "image-processing.v1" || stage.id !== "image-process-" + stage.payload.inputDigest || stage.userId !== binding.userId || stage.parentTaskId !== binding.imageTaskId || stage.runId !== binding.run?.runId)
        throw new ImageProcessingInputError("结果取消关闭的Run或原任务绑定已变化", 409);
    return binding;
}

function assertImageCancellationResult(image: ImageProcessingFinalImage, stage: ImageProcessingStageState, run: ImageResultRun | undefined, now: number) {
    if (stage.payload.operation !== "process_result") throw new ImageProcessingInputError("结果阶段类型不符", 409);
    const binding = assertImageProcessingCancellationBinding(stage);
    if (
        stage.expiresAt <= now ||
        !imageProcessingFinalImageMatches(stage, image, binding, now) ||
        !imageResultRunMatches(run, image.payload, binding.run, now, true) ||
        image.conversationId !== image.payload.conversationId ||
        image.surface !== image.payload.surface ||
        image.projectId !== image.payload.projectId ||
        stage.conversationId !== image.conversationId ||
        stage.surface !== image.surface ||
        stage.projectId !== image.projectId
    )
        throw new ImageProcessingInputError("结果取消的原任务或Run绑定已变化", 409);
}

export async function cancelImageProcessingTaskForRun(input: { userId: string; runId: string; jobId: string }): Promise<void> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (executor) => {
            const parent = await readImageResultRun(input.runId, executor, true);
            if (!parent) throw new ImageProcessingInputError("父任务不存在", 404);
            const initial = await readImageProcessingStage(input.jobId, executor);
            requireImageProcessingStage(initial);
            const imageId = initial.payload.operation === "process_result" ? initial.payload.imageResultBinding?.imageTaskId : undefined;
            if (initial.payload.operation === "process_result" && !imageId) throw new ImageProcessingInputError("结果阶段原任务绑定不存在", 409);
            const image = imageId ? await readImageProcessingFinalImage(imageId, executor, true) : undefined;
            const current = await readImageProcessingStage(input.jobId, executor, true);
            requireImageProcessingStage(current);
            if (parent.expiresAt <= current.now) throw new ImageProcessingInputError("父任务不存在", 404);
            assertImageProcessingRunCancellation(parent, current, input, image);
            if (current.status !== "pending" && current.status !== "running") return;
            const pending = current.status === "pending";
            const updated = await executor.query(
                `UPDATE generation_tasks SET status = 'cancelled', execution_phase = $4, next_poll_at = NULL, updated_at = statement_timestamp()${pending ? ", worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL" : ""}
                 WHERE id = $1 AND task_type = 'image_processing' AND user_id = $2 AND run_id = $3 AND status = $5 AND expires_at > statement_timestamp()
                   AND EXISTS (SELECT 1 FROM generation_tasks AS parent WHERE parent.id = $3 AND parent.task_type = 'agent' AND parent.expires_at > statement_timestamp())
                 RETURNING id`,
                [input.jobId, input.userId, input.runId, pending ? "completed" : "cancel_requested", current.status],
            );
            if (!updated.rows[0]) throw new ImageProcessingInputError("图像阶段归属或有效期已失效", 409);
        });
    }
    return queueRuntimeFileOperation(() =>
        withGenerationTaskFileMutation(async (records) => {
            const now = Date.now();
            const parent = fileImageResultRun(records, input.runId);
            if (!parent || parent.expiresAt <= now) throw new ImageProcessingInputError("父任务不存在", 404);
            const childRecord = records.find((record) => record.type === "image_processing" && record.id === input.jobId && record.expiresAt > now);
            const current = childRecord && imageProcessingStageFromRecord(childRecord);
            requireImageProcessingStage(current);
            const imageRecord = records.find((record) => record.type === "image" && record.id === current.payload.imageResultBinding?.imageTaskId);
            const image = imageRecord && { ...imageRecord, payload: imageRecord.payload as ImageTask };
            assertImageProcessingRunCancellation(parent, current, input, image);
            if (current.status !== "pending" && current.status !== "running") return { tasks: records, result: undefined };
            const pending = current.status === "pending";
            return {
                tasks: records.map((record): StoredGenerationTaskRecord =>
                    record !== childRecord
                        ? record
                        : {
                              ...record,
                              status: "cancelled",
                              executionPhase: pending ? "completed" : "cancel_requested",
                              updatedAt: now,
                              nextPollAt: undefined,
                              ...(pending ? { workerId: undefined, leaseUntil: undefined, lastHeartbeatAt: undefined } : {}),
                          },
                ),
                result: undefined,
            };
        }),
    );
}

function assertImageProcessingRunCancellation(parent: ImageResultRun, stage: ImageProcessingStageState, input: { userId: string; runId: string }, image?: ImageProcessingFinalImage) {
    if (parent.id !== input.runId || parent.userId !== input.userId || parent.payload.id !== parent.id || parent.payload.userId !== parent.userId || stage.userId !== input.userId || stage.runId !== input.runId)
        throw new ImageProcessingInputError("父子阶段归属不符", 409);
    if (stage.payload.operation === "process_result" && (stage.status === "pending" || stage.status === "running")) {
        const binding = stage.payload.imageResultBinding;
        if (
            !binding?.run ||
            !image ||
            stage.parentTaskId !== binding.imageTaskId ||
            image.id !== binding.imageTaskId ||
            image.userId !== binding.userId ||
            image.runId !== binding.run.runId ||
            image.payload.runId !== binding.run.runId ||
            image.parentTaskId !== binding.run.runId ||
            image.payload.parentTaskId !== binding.run.runId ||
            !isDeepStrictEqual(image.payload.nativeResults, binding.nativeResults) ||
            !imageResultRunMatches(parent, image.payload, binding.run, stage.now, true)
        )
            throw new ImageProcessingInputError("结果取消的原任务或Run绑定已变化", 409);
    }
    if (!parent.payload.cancellation && parent.payload.status !== "cancelled") throw new ImageProcessingInputError("父任务尚未请求取消", 409);
}

type ImageProcessingCancellationCloseReport = Pick<ImageProcessingOutcome, "jobId" | "executionId" | "exitCode" | "signal" | "stderr"> & { pid: number } & (
        { status: "aborted" | "completed" } | { status: "rejected" | "crashed"; error: { code: string; message: string } } | { status: "resource_failure"; reason: "v8_heap_oom" }
    );
export type ImageProcessingCancellationCloseInput = {
    workerId: string;
    executionId: string;
    closed: ImageProcessingCancellationCloseReport;
    stopCause: "cancel_requested" | "lease_lost" | "worker_stopping" | null;
};
export type ImageProcessingCancellationNotStartedInput = {
    workerId: string;
    executionId: string;
    notStarted: true;
    stopCause: "cancel_requested";
};
export type ImageProcessingCancellationInput = ImageProcessingCancellationCloseInput | ImageProcessingCancellationNotStartedInput;
export type ImageProcessingCancellationCloseReceipt = { jobId: string; executionId: string; status: "cancelled"; executionPhase: "completed" };

export async function acknowledgeImageProcessingCancellation(id: string, body: Record<string, unknown>): Promise<ImageProcessingCancellationCloseReceipt> {
    const input = parseImageProcessingCancellation(id, body);
    const enhancement = await readEnhancementProcessingTask(id);
    if (enhancement) return enhancementProcessingRequest(() => closeEnhancementProcessingCancellation(enhancement, input));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (executor) => {
            const current = await readImageProcessingStage(id, executor, true);
            requireImageProcessingStage(current);
            const previous = imageProcessingCancellationReceipt(current, input);
            if (previous) return previous;
            const receipt: ImageProcessingCancellationCloseReceipt = { jobId: id, executionId: input.executionId, status: "cancelled", executionPhase: "completed" };
            const resultPayload: ImageProcessingStoredResult = { executionId: input.executionId, ...current.resultPayload, ...("notStarted" in input ? { cancelNotStarted: { ...input, receipt } } : { cancelClose: { ...input, receipt } }) };
            const updated = await executor.query(
                `UPDATE generation_tasks SET execution_phase = 'completed', result_payload = $4::jsonb, updated_at = statement_timestamp(), worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, next_poll_at = NULL
                 WHERE id = $1 AND task_type = 'image_processing' AND status = 'cancelled' AND execution_phase = 'cancel_requested'
                   AND worker_id = $2 AND payload ->> 'executionId' = $3 AND expires_at > statement_timestamp()
                 RETURNING id`,
                [id, input.workerId, input.executionId, JSON.stringify(resultPayload)],
            );
            if (!updated.rows[0]) throw new ImageProcessingInputError("图像阶段不存在或已过期", 404);
            return receipt;
        });
    }
    return withGenerationTaskFileMutation(async (records) => {
        const now = Date.now();
        const record = records.find((task) => task.type === "image_processing" && task.id === id && task.expiresAt > now);
        const current = record && imageProcessingStageFromRecord(record);
        requireImageProcessingStage(current);
        const previous = imageProcessingCancellationReceipt(current, input);
        if (previous) return { tasks: records, result: previous };
        const receipt: ImageProcessingCancellationCloseReceipt = { jobId: id, executionId: input.executionId, status: "cancelled", executionPhase: "completed" };
        const resultPayload: ImageProcessingStoredResult = { executionId: input.executionId, ...current.resultPayload, ...("notStarted" in input ? { cancelNotStarted: { ...input, receipt } } : { cancelClose: { ...input, receipt } }) };
        return {
            tasks: records.map((task): StoredGenerationTaskRecord =>
                task === record ? { ...task, executionPhase: "completed", resultPayload, updatedAt: now, workerId: undefined, leaseUntil: undefined, lastHeartbeatAt: undefined, nextPollAt: undefined } : task,
            ),
            result: receipt,
        };
    });
}

function imageProcessingCancellationReceipt(stage: ImageProcessingStageState, input: ImageProcessingCancellationInput): ImageProcessingCancellationCloseReceipt | undefined {
    if (stage.payload.operation === "process_result") assertImageProcessingCancellationBinding(stage);
    if (stage.status !== "cancelled" || stage.payload.executionId !== input.executionId) throw new ImageProcessingInputError("取消关闭执行身份或状态冲突", 409);
    const saved = stage.resultPayload?.cancelClose;
    const savedNotStarted = stage.resultPayload?.cancelNotStarted;
    if (stage.executionPhase === "completed") {
        if ("notStarted" in input) {
            if (saved || !savedNotStarted || savedNotStarted.workerId !== input.workerId || savedNotStarted.executionId !== input.executionId || savedNotStarted.notStarted !== input.notStarted || savedNotStarted.stopCause !== input.stopCause)
                throw new ImageProcessingInputError("未启动取消回执身份或报告冲突", 409);
            return savedNotStarted.receipt;
        }
        if (savedNotStarted || !saved || saved.workerId !== input.workerId || saved.executionId !== input.executionId || saved.stopCause !== input.stopCause || JSON.stringify(imageProcessingCloseIdentity(saved.closed)) !== JSON.stringify(input.closed))
            throw new ImageProcessingInputError("取消关闭回执身份或报告冲突", 409);
        return saved.receipt;
    }
    if (stage.executionPhase !== "cancel_requested" || stage.workerId !== input.workerId || saved || savedNotStarted) throw new ImageProcessingInputError("取消关闭执行身份或状态冲突", 409);
    return undefined;
}

function parseImageProcessingCancellation(id: string, body: Record<string, unknown>): ImageProcessingCancellationInput {
    if (Object.hasOwn(body, "notStarted")) {
        assertImageProcessingCloseFields(body, ["workerId", "executionId", "notStarted", "stopCause"]);
        const { workerId, executionId, notStarted, stopCause } = body;
        if (typeof workerId !== "string" || !workerId.trim() || typeof executionId !== "string" || !executionId.trim() || notStarted !== true || stopCause !== "cancel_requested")
            throw new ImageProcessingInputError("未启动取消请求缺少有效执行身份或停止来源", 400);
        return { workerId: workerId.trim(), executionId, notStarted, stopCause };
    }
    assertImageProcessingCloseFields(body, ["workerId", "executionId", "closed", "stopCause"]);
    const { workerId, executionId, closed, stopCause } = body;
    if (typeof workerId !== "string" || !workerId.trim() || typeof executionId !== "string" || !executionId.trim() || !isImageProcessingCloseRecord(closed)) throw new ImageProcessingInputError("取消关闭请求缺少有效执行身份或报告", 400);
    if (stopCause !== null && stopCause !== "cancel_requested" && stopCause !== "lease_lost" && stopCause !== "worker_stopping") throw new ImageProcessingInputError("取消关闭停止来源无效", 400);
    const { status, pid, exitCode, signal, stderr } = closed;
    if (
        closed.jobId !== id ||
        closed.executionId !== executionId ||
        typeof pid !== "number" ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) ||
        (signal !== null && typeof signal !== "string") ||
        typeof stderr !== "string"
    )
        throw new ImageProcessingInputError("取消关闭报告身份或退出证据无效", 400);
    const fields = ["jobId", "executionId", "status", "pid", "exitCode", "signal", "stderr"];
    const exit = { jobId: id, executionId, pid, exitCode, signal, stderr };
    let report: ImageProcessingCancellationCloseReport;
    switch (status) {
        case "aborted":
        case "completed":
            assertImageProcessingCloseFields(closed, fields);
            report = { ...exit, status };
            break;
        case "rejected":
        case "crashed": {
            assertImageProcessingCloseFields(closed, [...fields, "error"]);
            const error = closed.error;
            if (!isImageProcessingCloseRecord(error)) throw new ImageProcessingInputError("取消关闭错误报告无效", 400);
            assertImageProcessingCloseFields(error, ["code", "message"]);
            if (typeof error.code !== "string" || typeof error.message !== "string") throw new ImageProcessingInputError("取消关闭错误报告无效", 400);
            report = { ...exit, status, error: { code: error.code, message: error.message } };
            break;
        }
        case "resource_failure":
            assertImageProcessingCloseFields(closed, [...fields, "reason"]);
            if (closed.reason !== "v8_heap_oom") throw new ImageProcessingInputError("取消关闭资源原因无效", 400);
            report = { ...exit, status, reason: "v8_heap_oom" };
            break;
        default:
            throw new ImageProcessingInputError("取消关闭报告状态无效", 400);
    }
    return { workerId: workerId.trim(), executionId, closed: report, stopCause };
}

function isImageProcessingCloseRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertImageProcessingCloseFields(value: Record<string, unknown>, fields: string[]) {
    if (Object.keys(value).length !== fields.length || !fields.every((field) => Object.hasOwn(value, field))) throw new ImageProcessingInputError("取消关闭报告字段无效", 400);
}

function imageProcessingCloseIdentity(closed: ImageProcessingCancellationCloseReport): ImageProcessingCancellationCloseReport {
    const exit = { jobId: closed.jobId, executionId: closed.executionId, pid: closed.pid, exitCode: closed.exitCode, signal: closed.signal, stderr: closed.stderr };
    if (closed.status === "rejected" || closed.status === "crashed") return { ...exit, status: closed.status, error: { code: closed.error.code, message: closed.error.message } };
    if (closed.status === "resource_failure") return { ...exit, status: closed.status, reason: closed.reason };
    return { ...exit, status: closed.status };
}

export async function failImageProcessingTask(id: string, input: FailImageProcessingInput): Promise<FailedImageProcessingStage> {
    const response = await closeImageProcessingTask(id, input);
    const stage = await readImageProcessingStage(id);
    if (stage && (stage.payload.operation === "prepare_reference" || stage.payload.operation === "build_protection") && stage.runId) {
        const parent = await getStoredGenerationTask<AgentRun>("agent", stage.runId);
        if (parent) await repairAgentImageProcessingPause(parent);
    }
    return response;
}

async function closeImageProcessingTask(id: string, input: FailImageProcessingInput): Promise<FailedImageProcessingStage> {
    if (input.failure.jobId !== id || input.failure.executionId !== input.executionId) throw new ImageProcessingInputError("失败报告与阶段身份不符", 400);
    const failure = imageProcessingFailureIdentity(input.failure);
    const enhancement = await readEnhancementProcessingTask(id);
    if (enhancement) return enhancementProcessingRequest(() => closeEnhancementProcessingFailure(enhancement, { ...input, failure }));
    const initial = await readImageProcessingStage(id);
    requireImageProcessingStage(initial);
    if (initial.payload.operation === "process_result") return failImageProcessingResult(initial, input, failure);
    if (initial.payload.operation === "prepare_review") return failEcommerceReviewPreparation(initial, input, failure);
    if (initial.status !== "running") return readFailedImageProcessingStage(initial, input, failure);
    const response = failedImageProcessingResponse(id, failure);
    if (getDatabaseProvider() === "postgres")
        return withPostgresTransaction(async (executor) => {
            const locked = await executor.query<{ user_id: string; payload: AgentRun }>("SELECT user_id, payload FROM generation_tasks WHERE id = $1 AND task_type = 'agent' FOR UPDATE", [initial.runId]);
            const parent = locked.rows[0];
            if (!parent) throw new ImageProcessingInputError("父任务不存在", 404);
            const current = await readImageProcessingStage(id, executor, true);
            requireImageProcessingStage(current);
            if (current.status !== "running") return readFailedImageProcessingStage(current, input, failure);
            if (current.runId !== initial.runId || current.userId !== parent.user_id) throw new ImageProcessingInputError("父子阶段归属已失效", 409);
            const resultPayload: ImageProcessingStoredResult = { ...current.resultPayload, executionId: input.executionId, workerId: input.workerId, failure };
            const nextParent = pausedImageProcessingParent(parent.payload, current, failure);
            // Keep lease eligibility in PostgreSQL: JS Date loses sub-millisecond precision.
            const updated = await executor.query<{ updated_at: Date }>(
                `UPDATE generation_tasks SET status = $4, execution_phase = 'needs_review', result_payload = $5::jsonb, updated_at = statement_timestamp(), next_poll_at = NULL, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = $6
                 WHERE id = $1 AND task_type = 'image_processing' AND status = 'running' AND worker_id = $2 AND payload ->> 'executionId' = $3
                   AND lease_until > statement_timestamp() AND expires_at > statement_timestamp()
                   AND EXISTS (SELECT 1 FROM generation_tasks AS parent WHERE parent.id = $7 AND parent.task_type = 'agent' AND parent.expires_at > statement_timestamp())
                 RETURNING updated_at`,
                [id, input.workerId, input.executionId, response.status, JSON.stringify(resultPayload), failure.status === "rejected" ? failure.error.code : failure.reason, initial.runId],
            );
            if (!updated.rows[0]) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
            if (nextParent) {
                const now = updated.rows[0].updated_at;
                const paused = await executor.query(
                    "UPDATE generation_tasks SET status = 'paused', payload = $2::jsonb, updated_at = $3, execution_phase = 'needs_review', next_poll_at = NULL, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = 'image_processing_failed' WHERE id = $1 AND task_type = 'agent' AND expires_at > statement_timestamp() RETURNING id",
                    [initial.runId, JSON.stringify({ ...nextParent, updatedAt: now.getTime() }), now],
                );
                if (!paused.rows[0]) throw new ImageProcessingInputError("父任务已过期", 409);
            }
            return response;
        });
    assertCurrentImageProcessingStage(initial, input);
    return queueRuntimeFileOperation(async () => {
        const latest = await readImageProcessingStage(id);
        requireImageProcessingStage(latest);
        if (latest.status !== "running") return readFailedImageProcessingStage(latest, input, failure);
        return withGenerationTaskFileMutation(async (records) => {
            const parentRecord = records.find((record) => record.type === "agent" && record.id === initial.runId);
            const childRecord = records.find((record) => record.type === "image_processing" && record.id === id);
            if (!parentRecord) throw new ImageProcessingInputError("父任务不存在", 404);
            const current = childRecord && imageProcessingStageFromRecord(childRecord);
            requireImageProcessingStage(current);
            const now = Date.now();
            assertCurrentImageProcessingStage({ ...current, now }, input);
            if (current.runId !== initial.runId || current.userId !== parentRecord.userId || parentRecord.expiresAt <= now) throw new ImageProcessingInputError("父子阶段归属已失效", 409);
            const resultPayload: ImageProcessingStoredResult = { ...current.resultPayload, executionId: input.executionId, workerId: input.workerId, failure };
            const nextParent = pausedImageProcessingParent(parentRecord.payload as AgentRun, current, failure);
            return {
                tasks: records.map((record): StoredGenerationTaskRecord => {
                    if (record === childRecord)
                        return {
                            ...record,
                            status: response.status,
                            executionPhase: "needs_review",
                            resultPayload,
                            updatedAt: now,
                            nextPollAt: undefined,
                            workerId: undefined,
                            leaseUntil: undefined,
                            lastHeartbeatAt: undefined,
                            lastUpstreamStatus: failure.status === "rejected" ? failure.error.code : failure.reason,
                        };
                    if (record === parentRecord && nextParent)
                        return {
                            ...record,
                            status: "paused",
                            payload: { ...nextParent, updatedAt: now },
                            updatedAt: now,
                            executionPhase: "needs_review",
                            nextPollAt: undefined,
                            workerId: undefined,
                            leaseUntil: undefined,
                            lastHeartbeatAt: undefined,
                            lastUpstreamStatus: "image_processing_failed",
                        };
                    return record;
                }),
                result: response,
            };
        });
    });
}

export async function resumeImageProcessingTaskForRun(run: AgentRun): Promise<AgentRun | undefined> {
    const waiting = run.ecommerceSnapshot?.processing?.waitingFor;
    if (!waiting) return;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (executor) => {
            const locked = await executor.query<{ user_id: string; payload: AgentRun }>("SELECT user_id, payload FROM generation_tasks WHERE id = $1 AND task_type = 'agent' AND expires_at > statement_timestamp() FOR UPDATE", [run.id]);
            const parent = locked.rows[0];
            if (!parent) throw new ImageProcessingInputError("父任务不存在", 404);
            const current = await readImageProcessingStage(waiting.jobId, executor, true);
            requireImageProcessingStage(current);
            const resumed = await prepareImageProcessingResourceResume(run, parent.payload, parent.user_id, current, (jobId) => readImageProcessingStage(jobId, executor), executor);
            if (!resumed) return;
            const updated = await executor.query<{ updated_at: Date }>(
                "UPDATE generation_tasks SET status = 'pending', execution_phase = 'created', payload = $4::jsonb, result_payload = $5::jsonb, updated_at = statement_timestamp(), next_poll_at = statement_timestamp(), worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = 'resource_resume' WHERE id = $1 AND task_type = 'image_processing' AND user_id = $2 AND run_id = $3 AND status = 'paused' AND execution_phase = 'needs_review' AND payload ->> 'executionId' = $6 AND expires_at > statement_timestamp() RETURNING updated_at",
                [current.id, run.userId, run.id, JSON.stringify(resumed.payload), JSON.stringify(resumed.resultPayload), current.payload.executionId],
            );
            if (!updated.rows[0]) throw new ImageProcessingInputError("图像阶段状态已变化", 409);
            const now = updated.rows[0].updated_at;
            const next: AgentRun = { ...parent.payload, status: "running", executionId: undefined, failure: undefined, updatedAt: now.getTime() };
            const saved = await executor.query(
                "UPDATE generation_tasks SET status = 'running', payload = $2::jsonb, updated_at = $3, execution_phase = 'created', next_poll_at = NULL, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = 'image_processing_waiting' WHERE id = $1 AND task_type = 'agent' AND status = 'paused' AND expires_at > statement_timestamp() RETURNING id",
                [run.id, JSON.stringify(next), now],
            );
            if (!saved.rows[0]) throw new ImageProcessingInputError("父任务状态或有效期已变化", 409);
            return next;
        });
    }
    return queueRuntimeFileOperation(() =>
        withGenerationTaskFileMutation(async (records) => {
            const now = Date.now();
            const parentRecord = records.find((record) => record.type === "agent" && record.id === run.id && record.expiresAt > now);
            if (!parentRecord) throw new ImageProcessingInputError("父任务不存在", 404);
            const childRecord = records.find((record) => record.type === "image_processing" && record.id === waiting.jobId);
            const current = childRecord && imageProcessingStageFromRecord(childRecord);
            requireImageProcessingStage(current);
            const parent = parentRecord.payload as AgentRun;
            const resumed = await prepareImageProcessingResourceResume(run, parent, parentRecord.userId, current, async (jobId) => {
                const record = records.find((record) => record.type === "image_processing" && record.id === jobId);
                return record && imageProcessingStageFromRecord(record);
            });
            if (!resumed) return { tasks: records, result: undefined };
            const committedAt = Date.now();
            if (current.expiresAt <= committedAt || parentRecord.expiresAt <= committedAt) throw new ImageProcessingInputError("父子阶段已过期", 409);
            const next: AgentRun = { ...parent, status: "running", executionId: undefined, failure: undefined, updatedAt: committedAt };
            return {
                tasks: records.map((record): StoredGenerationTaskRecord => {
                    if (record === childRecord)
                        return {
                            ...record,
                            status: "pending",
                            executionPhase: "created",
                            payload: resumed.payload,
                            resultPayload: resumed.resultPayload,
                            updatedAt: committedAt,
                            nextPollAt: committedAt,
                            workerId: undefined,
                            leaseUntil: undefined,
                            lastHeartbeatAt: undefined,
                            lastUpstreamStatus: "resource_resume",
                        };
                    if (record === parentRecord)
                        return {
                            ...record,
                            status: "running",
                            payload: next,
                            updatedAt: committedAt,
                            executionPhase: "created",
                            nextPollAt: undefined,
                            workerId: undefined,
                            leaseUntil: undefined,
                            lastHeartbeatAt: undefined,
                            lastUpstreamStatus: "image_processing_waiting",
                        };
                    return record;
                }),
                result: next,
            };
        }),
    );
}

export async function imageProcessingRecoveryForRun(run: AgentRun): Promise<{ reason: "resource_failure" | "input_rejected"; canResume: boolean; message: string } | undefined> {
    const waiting = run.ecommerceSnapshot?.processing?.waitingFor;
    if (run.surface !== "chat" || run.status !== "paused" || run.cancellation || !waiting) return;
    const record = await getStoredGenerationTaskRecord("agent", run.id);
    if (!record || record.userId !== run.userId || record.status !== "paused") return;
    const parent = record.payload as AgentRun;
    const currentWaiting = parent.ecommerceSnapshot?.processing?.waitingFor;
    if (parent.status !== "paused" || parent.cancellation || parent.conversationId !== run.conversationId || currentWaiting?.jobId !== waiting.jobId || currentWaiting.inputDigest !== waiting.inputDigest) return;
    const stage = await readImageProcessingStage(waiting.jobId);
    if (!stage) return;
    const pause = await repairAgentImageProcessingPause(run);
    if (pause?.reason === "input_rejected") return pause;
    try {
        if (!(await validateImageProcessingResourceResume(run, parent, record.userId, stage, readImageProcessingStage))) return;
    } catch (error) {
        if (error instanceof ImageProcessingInputError) return;
        throw error;
    }
    const message = "图像处理因资源不足暂停，进度已保存。";
    try {
        imageProcessingResourceResumeResource(stage.payload);
        return { reason: "resource_failure", canResume: true, message: message + "资源已调整，可以继续原任务。" };
    } catch (error) {
        if (!(error instanceof ImageProcessingInputError)) throw error;
        return { reason: "resource_failure", canResume: false, message: message + error.message + "调整后请刷新页面。" };
    }
}

async function prepareImageProcessingResourceResume(expected: AgentRun, parent: AgentRun, ownerUserId: string, stage: ImageProcessingStageState, lookup: (jobId: string) => Promise<ImageProcessingStageState | undefined>, executor?: QueryExecutor) {
    const validated = await validateImageProcessingResourceResume(expected, parent, ownerUserId, stage, lookup, executor);
    if (!validated) return;
    const { payload, result, failure, workerId } = validated;
    const resource = imageProcessingResourceResumeResource(payload);
    const checkpoint = { executionId: result.executionId, workerId, failure, resource: payload.resource, ...(result.artifacts ? { artifacts: result.artifacts } : {}) };
    return { payload: { ...payload, executionId: undefined, resource }, resultPayload: { executionId: result.executionId, checkpoints: [...(result.checkpoints || []), checkpoint] } };
}

async function validateImageProcessingResourceResume(expected: AgentRun, parent: AgentRun, ownerUserId: string, stage: ImageProcessingStageState, lookup: (jobId: string) => Promise<ImageProcessingStageState | undefined>, executor?: QueryExecutor) {
    const processing = parent.ecommerceSnapshot?.processing;
    const waiting = processing?.waitingFor;
    if (
        parent.id !== expected.id ||
        parent.userId !== expected.userId ||
        ownerUserId !== expected.userId ||
        parent.conversationId !== expected.conversationId ||
        parent.status !== "paused" ||
        parent.cancellation ||
        waiting?.jobId !== stage.id ||
        waiting.inputDigest !== stage.payload.inputDigest ||
        expected.ecommerceSnapshot?.processing?.waitingFor?.jobId !== stage.id ||
        stage.runId !== parent.id ||
        stage.userId !== parent.userId ||
        stage.expiresAt <= stage.now
    )
        throw new ImageProcessingInputError("原图像阶段与暂停任务不匹配", 409);
    if (stage.status === "pending" || stage.status === "running") return;
    const payload = stage.payload;
    const result = stage.resultPayload;
    const failure = result?.failure;
    if (
        stage.status !== "paused" ||
        stage.executionPhase !== "needs_review" ||
        payload.operation === "process_result" ||
        payload.version !== "image-processing.v1" ||
        payload.inputs.length !== 1 ||
        payload.sources.length !== 1 ||
        !stage.parentTaskId ||
        stage.workerId ||
        stage.leaseUntil !== undefined ||
        !result ||
        !result.workerId ||
        !payload.executionId ||
        result.executionId !== payload.executionId ||
        failure?.status !== "resource_failure" ||
        failure.reason !== "v8_heap_oom" ||
        failure.jobId !== stage.id ||
        failure.executionId !== payload.executionId ||
        result.cancelClose ||
        result.cancelNotStarted
    )
        throw new ImageProcessingInputError("当前图像阶段没有可恢复的资源失败回执", 409);
    const reference =
        payload.operation === "prepare_reference"
            ? (payload.options.generationInput ? processing?.generationReferences : processing?.prepareReferences)?.find(
                  (item) => item.jobId === stage.id && item.assetId === payload.inputs[0].assetId && item.assetVersion === payload.inputs[0].assetVersion,
              )
            : processing?.protection;
    if (reference?.jobId !== stage.id || reference.inputDigest !== payload.inputDigest || reference.manifest || stage.id !== "image-process-" + payload.inputDigest) throw new ImageProcessingInputError("原图像阶段检查点已变化", 409);
    const input = imageProcessingResourceResumeInput(parent, stage);
    if (input.operation === "build_protection" || (input.operation === "prepare_reference" && input.options.generationInput)) {
        if (input.operation === "prepare_reference") assertGenerationReferenceRequest(parent, input);
        const prepared = await completedProtectionInputs(parent, input, lookup, executor);
        if (prepared.inputDigest !== payload.inputDigest || enqueueInputsIdentity(prepared) !== enqueueInputsIdentity({ sources: payload.sources, facts: payload.resource.facts })) throw new ImageProcessingInputError("保护阶段原件完成证据已变化", 409);
    } else {
        const source = payload.inputs[0];
        const encoded = payload.resource.facts.encodedInputs.find((fact) => fact.inputIndex === 0 && fact.assetId === source.assetId && fact.assetVersion === source.assetVersion);
        if (!source.expectedSha256 || !encoded || encoded.sha256 !== source.expectedSha256) throw new ImageProcessingInputError("原参考处理阶段输入身份冲突", 409);
        await recheckFrozenReference(parent, input, payload.sources[0], executor);
    }
    return { payload, result, failure, workerId: result.workerId };
}

function imageProcessingResourceResumeResource(payload: AgentImageProcessingPayload): AgentImageProcessingPayload["resource"] {
    let configured: ReturnType<typeof imageProcessingResourceConfig>;
    try {
        configured = imageProcessingResourceConfig(process.env);
    } catch (error) {
        throw new ImageProcessingInputError("当前图像处理资源配置无效，请联系管理员检查后继续。", 409, { cause: error });
    }
    const { profileVersion, ...configuration } = configured;
    if (profileVersion === payload.resource.profileVersion) throw new ImageProcessingInputError("图像处理资源配置尚未调整，请联系管理员检查后继续。", 409);
    const estimate = estimateImageProcessingMemory(payload, payload.resource.facts);
    const admission = decideImageProcessingAdmission(estimate, { totalMemoryBytes: configuration.budgetBytes, availableMemoryBytes: configuration.budgetBytes, availableSlots: configuration.concurrency });
    if (estimate.status !== "calibrated" || admission.status === "unavailable") throw new ImageProcessingInputError("当前资源配置仍无法执行原图像阶段，请联系管理员检查。", 409);
    const resource: AgentImageProcessingPayload["resource"] = { profileVersion, configuration, facts: payload.resource.facts, requiredMemoryBytes: estimate.requiredMemoryBytes };
    return resource;
}

function imageProcessingResourceResumeInput(run: AgentRun, stage: ImageProcessingStageState): ImageProcessingFrozenInput {
    const payload = stage.payload;
    if (payload.operation === "process_result") throw new ImageProcessingInputError("结果阶段不能通过参考处理入口恢复", 409);
    // Storage defaults an omitted logical parent to the Run id; the digest keeps the original omission.
    const parentTaskIds = stage.parentTaskId === run.id ? [stage.parentTaskId, undefined] : [stage.parentTaskId];
    for (const parentTaskId of parentTaskIds) {
        const input: ImageProcessingFrozenInput = { ...payload, runId: run.id, parentTaskId };
        const matches =
            input.operation === "build_protection"
                ? protectionInputDigest(run, input, payload.inputs) === payload.inputDigest
                : prepareInputDigest(run, input) === payload.inputDigest || prepareInputDigest(run, input, payload.inputs[0].expectedSha256) === payload.inputDigest;
        if (matches) return input;
    }
    throw new ImageProcessingInputError("原图像阶段请求指纹冲突", 409);
}

export type ImageProcessingStoredResult = {
    executionId: string;
    artifacts?: StoredImageProcessingArtifact[];
    manifest?: ImageProcessingManifest;
    manifestDigest?: string;
    metrics?: ImageProcessingResult["metrics"];
    workerId?: string;
    parentRescheduled?: boolean;
    failure?: ClosedImageProcessingFailure;
    checkpoints?: Array<{ executionId: string; workerId: string; failure: Extract<ClosedImageProcessingFailure, { status: "resource_failure" }>; resource: AgentImageProcessingPayload["resource"]; artifacts?: StoredImageProcessingArtifact[] }>;
    cancelClose?: ImageProcessingCancellationCloseInput & { receipt: ImageProcessingCancellationCloseReceipt };
    cancelNotStarted?: ImageProcessingCancellationNotStartedInput & { receipt: ImageProcessingCancellationCloseReceipt };
};

function failedImageProcessingResponse(id: string, failure: ClosedImageProcessingFailure): FailedImageProcessingStage {
    return { jobId: id, status: failure.status === "rejected" ? "error" : "paused", executionPhase: "needs_review" };
}

function readFailedImageProcessingStage(stage: ImageProcessingStageState, input: FailImageProcessingInput, failure: ClosedImageProcessingFailure): FailedImageProcessingStage {
    const result = stage.resultPayload;
    const response = failedImageProcessingResponse(stage.id, failure);
    if (stage.status !== response.status || !result?.failure || result.workerId !== input.workerId || result.executionId !== input.executionId || JSON.stringify(imageProcessingFailureIdentity(result.failure)) !== JSON.stringify(failure))
        throw new ImageProcessingInputError("阶段失败回执身份或报告冲突", 409);
    return response;
}

function pausedImageProcessingParent(parent: AgentRun, stage: ImageProcessingStageState, failure: ClosedImageProcessingFailure): AgentRun | undefined {
    const waiting = parent.ecommerceSnapshot?.processing?.waitingFor;
    if (parent.cancellation || parent.status === "cancelled" || parent.status === "completed" || parent.status === "failed" || waiting?.jobId !== stage.id || waiting.inputDigest !== stage.payload.inputDigest) return;
    return { ...parent, status: "paused", executionId: undefined, failure: imageProcessingPauseMessage(failure) };
}

type ImageProcessingStageState = Pick<StoredGenerationTaskRecord, "id" | "userId" | "runId" | "parentTaskId" | "conversationId" | "surface" | "projectId" | "status" | "executionPhase" | "workerId" | "leaseUntil" | "expiresAt"> & {
    payload: AgentImageProcessingPayload;
    resultPayload?: ImageProcessingStoredResult;
    now: number;
};
const analysisMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/tiff", "image/avif"];

export async function writeImageProcessingOutput(
    id: string,
    kind: ImageProcessingArtifact["kind"],
    identity: { workerId: string; executionId: string },
    input: { stream: ReadableStream<Uint8Array>; mimeType: string; signal?: AbortSignal; resultId?: string },
): Promise<StoredImageProcessingArtifact> {
    const enhancement = await readEnhancementProcessingTask(id);
    if (enhancement) return enhancementProcessingRequest(() => writeEnhancementProcessingOutput(enhancement, kind, identity, input));
    const initial = await readImageProcessingStage(id);
    requireImageProcessingStage(initial);
    assertCurrentImageProcessingStage(initial, identity);
    const analysis = (initial.payload.operation === "prepare_review" || (initial.payload.operation === "prepare_reference" && !initial.payload.options.generationInput)) && kind === "analysis";
    const generation =
        initial.payload.operation === "prepare_reference" ? initial.payload.options.generationInput : initial.payload.operation === "build_protection" && !("mode" in initial.payload.options) ? initial.payload.options.generationInput : undefined;
    const generationReference = Boolean(generation) && kind === "generation_reference";
    const generationMask = initial.payload.operation === "build_protection" && Boolean(generation) && kind === "generation_mask";
    const mask = initial.payload.operation === "build_protection" && (kind === "mask" || generationMask);
    const final = initial.payload.operation === "process_result" && kind === "final";
    if (!analysis && !mask && !final && !generationReference) throw new ImageProcessingInputError("当前阶段不接受此工件类别", 400);
    if (!final && input.resultId !== undefined) throw new ImageProcessingInputError("当前工件类别不接受结果槽位选择", 400);
    const resultUpload = final ? selectImageProcessingFinalUpload(initial, input.resultId) : undefined;
    if (resultUpload) await assertImageProcessingFinalUploadAvailable(initial, identity, resultUpload);
    if (mask ? input.mimeType !== "image/png" : !analysisMimeTypes.includes(input.mimeType)) throw new ImageProcessingInputError(final ? "结果图像媒体类型不支持" : analysis ? "分析图像媒体类型不支持" : "保护蒙版仅接受PNG", 415);
    const sourceSize = kind === "mask" ? frozenDecodedSource(initial.payload) : undefined;
    const directory = await mkdtemp(join(tmpdir(), "vozeb-image-processing-output-"));
    const filename = join(directory, kind);
    try {
        const hash = createHash("sha256");
        let bytes = 0;
        const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.length;
                if (analysis && bytes > ECOMMERCE_VISION_IMAGE_MAX_BYTES) return callback(new ImageProcessingInputError("分析图像超过4MiB", 413));
                hash.update(chunk);
                callback(null, chunk);
            },
        });
        // These are the same WHATWG streams; Node and DOM expose different declarations.
        await pipeline(Readable.fromWeb(input.stream as NodeReadableStream<Uint8Array>), meter, createWriteStream(filename, { flags: "wx" }), { signal: input.signal });
        let metadata: Metadata;
        try {
            metadata = await sharp(filename, { failOn: "error", limitInputPixels: final ? 40_000_000 : ECOMMERCE_IMAGE_MAX_INPUT_PIXELS }).metadata();
        } catch (error) {
            if (resultUpload) await assertImageProcessingFinalUploadAvailable(initial, identity, resultUpload);
            throw new ImageProcessingInputError(final ? "结果图像签名或元数据无效" : "分析图像签名或元数据无效", 400, { cause: error });
        }
        if (resultUpload) await assertImageProcessingFinalUploadAvailable(initial, identity, resultUpload);
        if (
            mask &&
            (metadata.format !== "png" ||
                metadata.depth !== "uchar" ||
                metadata.channels !== 4 ||
                !metadata.hasAlpha ||
                (metadata.orientation !== undefined && metadata.orientation !== 1) ||
                (metadata.pages !== undefined && metadata.pages !== 1) ||
                (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height))
        )
            throw new ImageProcessingInputError("保护蒙版必须为原尺寸单帧正向RGBA PNG", 400);
        const mimeType = mask ? "image/png" : analysisMetadataMimeType(metadata);
        if (mimeType !== input.mimeType) throw new ImageProcessingInputError(final ? "结果图像签名与媒体类型不匹配" : "分析图像签名与媒体类型不匹配", 415);
        const rotated = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
        const width = Number(rotated ? metadata.height : metadata.width);
        const height = Number(rotated ? metadata.width : metadata.height);
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || (analysis && Math.max(width, height) > ECOMMERCE_VISION_IMAGE_MAX_DIMENSION) || (final && width * height > 40_000_000))
            throw new ImageProcessingInputError(final ? "结果图像尺寸无效或超过40MP" : analysis ? "分析图像尺寸无效或超过2048" : "蒙版尺寸无效", 400);
        if (sourceSize && (width !== sourceSize.width || height !== sourceSize.height)) throw new ImageProcessingInputError("蒙版尺寸必须与冻结源尺寸一致", 400);
        if (generation && (generationReference || generationMask)) {
            const source = frozenDecodedSource(initial.payload);
            if (width > generation.bounds.width || height > generation.bounds.height || width > source.width || height > source.height || (generationReference && !["image/png", "image/jpeg"].includes(mimeType)))
                throw new ImageProcessingInputError("生成输入超出冻结请求边界或格式不支持", 400);
        }
        // Mask and final files have no encoded-size cap derived from raw memory. This
        // boundary is the exact byte count of this closed, hashed file.
        const stored = await writeReferenceMediaFile(filename, "image", mimeType, false, {
            ownerUserId: initial.userId,
            source: final ? "image-processing-final" : analysis ? "image-processing-analysis" : generationReference ? "image-processing-generation-reference" : "image-processing-mask",
            runId: initial.runId,
            taskId: id,
            maxBytes: analysis ? ECOMMERCE_VISION_IMAGE_MAX_BYTES : bytes,
        });
        const artifact: StoredImageProcessingArtifact = {
            kind,
            storageKey: stored.token,
            sha256: hash.digest("hex"),
            mimeType,
            bytes,
            width,
            height,
            ...(resultUpload ? { resultId: resultUpload.slot.resultId, resultIndex: resultUpload.slot.resultIndex } : {}),
        };
        if (resultUpload) return await stageImageProcessingFinalOutput(initial, identity, resultUpload, artifact, stored.storage);
        if (getDatabaseProvider() === "postgres")
            return await withPostgresTransaction(async (executor) => {
                const current = await readImageProcessingStage(id, executor, true);
                requireImageProcessingStage(current);
                assertCurrentImageProcessingStage(current, identity);
                await assertImageProcessingOutputRegistration(current, artifact, executor);
                const previous = matchingStagedArtifact(current, artifact, identity.executionId);
                if (previous) {
                    await assertImageProcessingOutputRegistration(current, previous, executor);
                    const active = await executor.query(
                        "SELECT id FROM generation_tasks WHERE id = $1 AND status = 'running' AND worker_id = $2 AND payload ->> 'executionId' = $3 AND lease_until > statement_timestamp() AND expires_at > statement_timestamp()",
                        [id, identity.workerId, identity.executionId],
                    );
                    if (!active.rows[0]) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
                    return previous;
                }
                const staged: ImageProcessingStoredResult = {
                    executionId: identity.executionId,
                    artifacts: [...imageProcessingFinalArtifacts(current, identity.executionId), artifact],
                    ...(current.resultPayload?.checkpoints ? { checkpoints: current.resultPayload.checkpoints } : {}),
                };
                const updated = await executor.query(
                    "UPDATE generation_tasks SET result_payload = $4::jsonb, updated_at = statement_timestamp() WHERE id = $1 AND task_type = 'image_processing' AND status = 'running' AND worker_id = $2 AND payload ->> 'executionId' = $3 AND lease_until > statement_timestamp() AND expires_at > statement_timestamp() RETURNING id",
                    [id, identity.workerId, identity.executionId, JSON.stringify(staged)],
                );
                if (!updated.rows[0]) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
                return artifact;
            });
        return await withGenerationTaskFileMutation(async (records) => {
            const record = records.find((task) => task.type === "image_processing" && task.id === id);
            const current = record && imageProcessingStageFromRecord(record);
            requireImageProcessingStage(current);
            assertCurrentImageProcessingStage(current, identity);
            await assertImageProcessingOutputRegistration(current, artifact);
            const previous = matchingStagedArtifact(current, artifact, identity.executionId);
            if (previous) await assertImageProcessingOutputRegistration(current, previous);
            assertCurrentImageProcessingStage({ ...current, now: Date.now() }, identity);
            if (previous) return { tasks: records, result: previous };
            return {
                tasks: records.map((task) =>
                    task === record
                        ? {
                              ...task,
                              updatedAt: Date.now(),
                              resultPayload: {
                                  executionId: identity.executionId,
                                  artifacts: [...imageProcessingFinalArtifacts(current, identity.executionId), artifact],
                                  ...(current.resultPayload?.checkpoints ? { checkpoints: current.resultPayload.checkpoints } : {}),
                              },
                          }
                        : task,
                ),
                result: artifact,
            };
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

type ImageProcessingFinalImage = Pick<StoredGenerationTaskRecord, "id" | "userId" | "runId" | "parentTaskId" | "conversationId" | "surface" | "projectId" | "status" | "expiresAt" | "upstreamTaskId" | "workerId" | "leaseUntil"> & { payload: ImageTask };

function selectImageProcessingFinalUpload(stage: ImageProcessingStageState, resultId: string | undefined) {
    const payload = stage.payload;
    if (payload.operation !== "process_result") throw new Error("Not implemented: final upload outside result processing");
    const binding = payload.imageResultBinding;
    if (!binding) throw new Error("Not implemented: final upload without frozen image result binding");
    if (stage.userId !== binding.userId || stage.parentTaskId !== binding.imageTaskId || stage.runId !== binding.run?.runId || stage.id !== "image-process-" + payload.inputDigest) throw new ImageProcessingInputError("结果阶段归属或冻结绑定已变化", 409);
    const selected = payload.options.results.find((slot) => slot.resultId === resultId);
    const native = binding.nativeResults.slots.find((slot) => slot.resultId === resultId);
    if (!resultId || !selected || !native || native.status !== "stored") throw new ImageProcessingInputError("结果槽位不在本阶段允许清单", 400);
    const input = payload.inputs[selected.inputIndex];
    const source = payload.sources.find((item) => item.inputIndex === selected.inputIndex);
    if (
        selected.resultIndex !== native.resultIndex ||
        !input ||
        input.assetId !== native.assetId ||
        input.assetVersion !== native.assetVersion ||
        input.expectedSha256 !== native.sha256 ||
        !source ||
        source.scope !== native.scope ||
        source.storageKey !== native.storageKey ||
        source.storageProvider !== native.storageProvider ||
        source.externalStorageId !== native.externalStorageId
    )
        throw new ImageProcessingInputError("结果槽位与冻结原件身份不符", 409);
    return { binding, slot: native };
}

type ImageProcessingFinalUpload = ReturnType<typeof selectImageProcessingFinalUpload>;

async function readImageProcessingFinalImage(id: string, executor?: QueryExecutor, lock = false): Promise<ImageProcessingFinalImage | undefined> {
    if (getDatabaseProvider() !== "postgres") {
        const record = await getStoredGenerationTaskRecord("image", id);
        return record ? { ...record, payload: record.payload as ImageTask } : undefined;
    }
    if (!executor) await ensurePostgresSchema();
    const query: QueryExecutor["query"] = executor ? executor.query.bind(executor) : postgresQuery;
    if (lock) await query("SELECT id FROM generation_tasks WHERE id = $1 AND task_type = 'image' FOR UPDATE", [id]);
    const result = await query<{
        id: string;
        user_id: string;
        run_id: string | null;
        parent_task_id: string | null;
        conversation_id: string | null;
        surface: StoredGenerationTaskRecord["surface"] | null;
        project_id: string | null;
        status: StoredGenerationTaskRecord["status"];
        payload: ImageTask;
        expires_at: Date;
        upstream_task_id: string | null;
        worker_id: string | null;
        lease_until: Date | null;
    }>("SELECT id, user_id, run_id, parent_task_id, conversation_id, surface, project_id, status, payload, expires_at, upstream_task_id, worker_id, lease_until FROM generation_tasks WHERE id = $1 AND task_type = 'image'", [id]);
    const row = result.rows[0];
    return row
        ? {
              id: row.id,
              userId: row.user_id,
              runId: row.run_id ?? undefined,
              parentTaskId: row.parent_task_id ?? undefined,
              conversationId: row.conversation_id ?? undefined,
              surface: row.surface ?? undefined,
              projectId: row.project_id ?? undefined,
              status: row.status,
              payload: row.payload,
              expiresAt: row.expires_at.getTime(),
              upstreamTaskId: row.upstream_task_id ?? undefined,
              workerId: row.worker_id ?? undefined,
              leaseUntil: row.lease_until?.getTime(),
          }
        : undefined;
}

function imageProcessingFinalImageMatches(
    stage: ImageProcessingStageState,
    image: ImageProcessingFinalImage | undefined,
    binding: NonNullable<AgentImageProcessingPayload["imageResultBinding"]>,
    now: number,
    expectedStatus: "running" | "error" = "running",
): image is ImageProcessingFinalImage {
    if (
        !image ||
        image.id !== binding.imageTaskId ||
        image.userId !== binding.userId ||
        image.payload.id !== image.id ||
        image.payload.userId !== image.userId ||
        image.status !== expectedStatus ||
        image.payload.status !== image.status ||
        image.expiresAt <= now ||
        image.payload.attemptNo !== binding.nativeResults.attemptNo ||
        (image.upstreamTaskId ?? null) !== binding.nativeResults.upstreamTaskId ||
        (image.payload.upstream?.id ?? null) !== binding.nativeResults.upstreamTaskId ||
        !isDeepStrictEqual(image.payload.nativeResults, binding.nativeResults) ||
        image.payload.resultProcessing?.jobId !== stage.id ||
        image.payload.resultProcessing.inputDigest !== stage.payload.inputDigest ||
        image.runId !== binding.run?.runId ||
        image.payload.runId !== binding.run?.runId ||
        (binding.run &&
            (image.parentTaskId !== binding.run.runId || image.payload.parentTaskId !== binding.run.runId || image.conversationId !== image.payload.conversationId || image.surface !== image.payload.surface || image.projectId !== image.payload.projectId))
    )
        return false;
    try {
        return imageTaskResultInputsMatch(image.payload, stage.payload);
    } catch (error) {
        throw new ImageProcessingInputError("结果源或保护绑定已变化", 409, { cause: error });
    }
}

function assertImageProcessingFinalImage(stage: ImageProcessingStageState, image: ImageProcessingFinalImage | undefined, upload: ImageProcessingFinalUpload, now: number) {
    if (!imageProcessingFinalImageMatches(stage, image, upload.binding, now)) throw new ImageProcessingInputError("结果阶段的图像业务或原件绑定已失效", 409);
}

function assertImageProcessingFinalStage(initial: ImageProcessingStageState, current: ImageProcessingStageState, identity: { workerId: string; executionId: string }) {
    assertCurrentImageProcessingStage(current, identity);
    if (current.userId !== initial.userId || current.parentTaskId !== initial.parentTaskId || current.runId !== initial.runId || !isDeepStrictEqual(current.payload, initial.payload))
        throw new ImageProcessingInputError("结果阶段归属或冻结绑定已变化", 409);
}

function assertImageProcessingFinalRun(stage: ImageProcessingStageState, image: ImageProcessingFinalImage | undefined, run: ImageResultRun | undefined, now: number) {
    const binding = stage.payload.imageResultBinding;
    if (binding?.run && (!image || !imageResultRunMatches(run, image.payload, binding.run, now))) throw new ImageProcessingInputError("结果阶段的Run来源或声明任务绑定已失效", 409);
}

function assertImageProcessingResultParent(stage: ImageProcessingStageState, image: ImageProcessingFinalImage | undefined, run: ImageResultRun | undefined, expectedStatus: "running" | "error" = "running"): asserts image is ImageProcessingFinalImage {
    const payload = stage.payload;
    const binding = payload.imageResultBinding;
    if (
        payload.operation !== "process_result" ||
        payload.version !== "image-processing.v1" ||
        !binding ||
        stage.expiresAt <= stage.now ||
        stage.id !== "image-process-" + payload.inputDigest ||
        stage.userId !== binding.userId ||
        stage.parentTaskId !== binding.imageTaskId ||
        stage.runId !== binding.run?.runId
    )
        throw new ImageProcessingInputError("结果阶段归属或冻结绑定已变化", 409);
    const nativeCount = binding.nativeResults.slots.filter((slot) => slot.status === "stored").length;
    if (payload.options.results.length !== nativeCount || new Set(payload.options.results.map((result) => result.resultId)).size !== nativeCount) throw new ImageProcessingInputError("结果阶段原件槽位绑定已变化", 409);
    if (!imageProcessingFinalImageMatches(stage, image, binding, stage.now, expectedStatus)) throw new ImageProcessingInputError("结果阶段的图像业务或原件绑定已失效", 409);
    if (
        image.conversationId !== image.payload.conversationId ||
        image.surface !== image.payload.surface ||
        image.projectId !== image.payload.projectId ||
        stage.conversationId !== image.conversationId ||
        stage.surface !== image.surface ||
        stage.projectId !== image.projectId
    )
        throw new ImageProcessingInputError("结果阶段的图像上下文已变化", 409);
    if (expectedStatus === "running") assertImageProcessingFinalRun(stage, image, run, stage.now);
}

function assertImageProcessingResultSources(stage: ImageProcessingStageState, registrations: LocalMediaRegistration[]) {
    const payload = stage.payload;
    if (payload.operation !== "process_result") throw new ImageProcessingInputError("结果阶段类型不符", 409);
    // Validate every frozen native input; failure/check does not require an uploaded final artifact.
    for (const result of payload.options.results) {
        const native = selectImageProcessingFinalUpload(stage, result.resultId);
        assertImageProcessingFinalNativeRegistration(
            stage,
            native,
            registrations.find((registration) => registration.storageKey === native.slot.storageKey),
        );
    }
    assertResultAuxiliaryRegistrations(stage, registrations);
}

export const imageResultResourceReason = "图像结果处理资源不足，已暂停等待人工检查。";
const imageResultRejectionReason = "图像结果处理未能完成，请检查图片后重试。";

function failedImageResultPayload(image: ImageTask, failure: ClosedImageProcessingFailure, now: number): ImageTask {
    const next = { ...image, executionId: undefined, updatedAt: now };
    if (failure.status === "resource_failure") return next;
    // Commit the local rejection's attempt with its parent; it does not establish a provider failure.
    const attempts = (image.attempts || []).map((attempt) => (attempt.attemptNo === image.attemptNo ? { ...attempt, status: "failed" as const, completedAt: now, error: imageResultRejectionReason } : attempt));
    return { ...next, status: "error", error: imageResultRejectionReason, retryable: true, candidateConfigs: [], attempts };
}

function failedImageProcessingResultPayload(stage: ImageProcessingStageState, input: FailImageProcessingInput, failure: ClosedImageProcessingFailure): ImageProcessingStoredResult {
    return { executionId: input.executionId, workerId: input.workerId, failure, artifacts: imageProcessingFinalArtifacts(stage, input.executionId), ...(stage.resultPayload?.checkpoints ? { checkpoints: stage.resultPayload.checkpoints } : {}) };
}

class ImageProcessingFailureReplay extends Error {
    constructor(readonly receipt: FailedImageProcessingStage) {
        super("Image processing failure already committed");
    }
}

function assertRejectedImageResultSettlement(
    initial: ImageProcessingStageState,
    current: ImageProcessingStageState,
    image: ImageProcessingFinalImage | undefined,
    input: FailImageProcessingInput,
    failure: ClosedImageProcessingFailure,
): asserts image is ImageProcessingFinalImage {
    readFailedImageProcessingStage(current, input, failure);
    if (
        current.userId !== initial.userId ||
        current.parentTaskId !== initial.parentTaskId ||
        current.runId !== initial.runId ||
        !isDeepStrictEqual(current.payload, initial.payload) ||
        (initial.status === "error" && !isDeepStrictEqual(current.resultPayload, initial.resultPayload))
    )
        throw new ImageProcessingInputError("原拒绝阶段归属或冻结绑定已变化", 409);
    // The persisted rejection authorizes its original settlement after the Run advances or the old lease ends.
    assertImageProcessingResultParent(current, image, undefined, "error");
}

async function hasRejectedImageResultLog(image: ImageTask, executor?: QueryExecutor) {
    const slotted = Boolean(image.generationLogId && image.generationSlotId);
    const id = image.generationLogId && image.generationSlotId ? image.generationLogId : `image-task:${image.id}`;
    const log = executor ? await createPostgresRepositories(executor).generationLogs.getById(id) : (await readGenerationLogDb()).logs.find((item) => item.id === id);
    if (!log || log.userId !== image.userId || log.kind !== "image") return false;
    if (slotted) {
        const slot = normalizeGenerationLogRequestSnapshot(log.requestSnapshot)?.slots.find((item) => item.id === image.generationSlotId || (image.clientRequestId && item.clientRequestId === image.clientRequestId));
        return Boolean(slot && slot.taskId === image.id && slot.status === "failed" && slot.error === image.error);
    }
    return log.taskId === image.id && log.status === "failed" && log.error === image.error && log.count === 1 && log.successCount === 0 && log.failCount === 1 && log.assets.length === 0;
}

async function settleRejectedImageResult(image: ImageTask, now: number, executor?: QueryExecutor) {
    const refunded = await refundImageTaskBilling(image, executor);
    if (!(await hasRejectedImageResultLog(image, executor))) {
        const logged = await writeImageGenerationLog(refunded, "failed", "", now - image.createdAt, image.error, undefined, executor);
        if (!logged.log || !(await hasRejectedImageResultLog(refunded, executor))) throw new Error("Rejected image result generation log was not saved");
    }
    return refunded;
}

async function failImageProcessingResult(initial: ImageProcessingStageState, input: FailImageProcessingInput, failure: ClosedImageProcessingFailure): Promise<FailedImageProcessingStage> {
    if (initial.status !== "running" && failure.status !== "rejected") return readFailedImageProcessingStage(initial, input, failure);
    const parentTaskId = initial.parentTaskId;
    if (!parentTaskId) throw new ImageProcessingInputError("结果阶段缺少原图像任务", 409);
    const response = failedImageProcessingResponse(initial.id, failure);
    const reason = failure.status === "resource_failure" ? imageResultResourceReason : imageResultRejectionReason;
    if (getDatabaseProvider() === "postgres")
        return withPostgresTransaction(async (executor) => {
            const run = await readImageResultRun(initial.runId, executor, true);
            const image = await readImageProcessingFinalImage(parentTaskId, executor, true);
            const current = await readImageProcessingStage(initial.id, executor, true);
            requireImageProcessingStage(current);
            if (current.status !== "running") {
                const receipt = readFailedImageProcessingStage(current, input, failure);
                if (failure.status === "rejected") {
                    assertRejectedImageResultSettlement(initial, current, image, input, failure);
                    const refunded = await settleRejectedImageResult(image.payload, current.now, executor);
                    if (refunded !== image.payload) {
                        const patched = await executor.query(
                            `UPDATE generation_tasks SET payload = jsonb_set(payload, '{billing}', $3::jsonb), updated_at = clock_timestamp()
                             WHERE id = $1 AND task_type = 'image' AND user_id = $2 AND status = 'error' AND payload = $4::jsonb AND expires_at > clock_timestamp()
                               AND EXISTS (SELECT 1 FROM generation_tasks AS rejected_child WHERE rejected_child.id = $5 AND rejected_child.task_type = 'image_processing'
                                   AND rejected_child.user_id = $2 AND rejected_child.parent_task_id = $1 AND rejected_child.status = 'error'
                                   AND rejected_child.payload = $6::jsonb AND rejected_child.result_payload = $7::jsonb AND rejected_child.expires_at > clock_timestamp())`,
                            [image.id, image.userId, JSON.stringify(refunded.billing), JSON.stringify(image.payload), current.id, JSON.stringify(current.payload), JSON.stringify(current.resultPayload)],
                        );
                        if (patched.rowCount !== 1) throw new ImageProcessingInputError("原拒绝回执或图像结算绑定已变化", 409);
                    }
                }
                return receipt;
            }
            assertImageProcessingFinalStage(initial, current, input);
            const registrations = await getLocalMediaRegistrations(
                current.payload.sources.map((source) => source.storageKey),
                { ownerUserId: current.userId, executor, forUpdate: true },
            );
            const checked = await readImageProcessingStage(initial.id, executor);
            requireImageProcessingStage(checked);
            assertImageProcessingFinalStage(initial, checked, input);
            assertImageProcessingResultParent(checked, image, run);
            assertImageProcessingResultSources(checked, registrations);
            if (image.workerId && image.payload.executionId && Number(image.leaseUntil) > checked.now) throw new ImageProcessingInputError("图像任务已有新的活动执行", 409);
            const failed = failedImageResultPayload(image.payload, failure, checked.now);
            const payload = failure.status === "rejected" ? await settleRejectedImageResult(failed, checked.now, executor) : failed;
            const parent = await executor.query(
                `UPDATE generation_tasks SET status = $3, payload = $4::jsonb,
                 result_payload = jsonb_set(COALESCE(result_payload, '{}'::jsonb), '{reviewReason}', to_jsonb($5::text)),
                 updated_at = clock_timestamp(), execution_phase = $6, next_poll_at = NULL, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = 'image_processing_failed'
             WHERE id = $1 AND task_type = 'image' AND user_id = $2 AND status = 'running' AND payload ->> 'status' = status AND expires_at > clock_timestamp()
               AND NOT (NULLIF(worker_id, '') IS NOT NULL AND NULLIF(payload ->> 'executionId', '') IS NOT NULL AND lease_until IS NOT NULL AND lease_until > clock_timestamp())
             RETURNING id`,
                [image.id, checked.userId, payload.status, JSON.stringify(payload), reason, failure.status === "resource_failure" ? "needs_review" : "completed"],
            );
            if (parent.rowCount !== 1) throw new ImageProcessingInputError("图像任务归属、租约或有效期已变化", 409);
            const resultPayload = failedImageProcessingResultPayload(checked, input, failure);
            const saved = await executor.query(
                `UPDATE generation_tasks SET status = $4, execution_phase = 'needs_review', result_payload = $5::jsonb,
                 updated_at = clock_timestamp(), next_poll_at = NULL, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = $13
             WHERE id = $1 AND task_type = 'image_processing' AND status = 'running' AND worker_id = $2 AND payload ->> 'executionId' = $3
               AND user_id = $6 AND parent_task_id = $7 AND run_id IS NOT DISTINCT FROM $12::text AND lease_until > clock_timestamp() AND expires_at > clock_timestamp()
               AND EXISTS (SELECT 1 FROM generation_tasks AS result_image WHERE result_image.id = $7 AND result_image.task_type = 'image' AND result_image.user_id = $6
                   AND result_image.status = $8 AND result_image.payload ->> 'status' = $8 AND result_image.expires_at > clock_timestamp()
                   AND result_image.payload -> 'nativeResults' = $9::jsonb AND result_image.payload #>> '{resultProcessing,jobId}' = $1
                   AND result_image.payload #>> '{resultProcessing,inputDigest}' = $10 AND result_image.upstream_task_id IS NOT DISTINCT FROM $11::text)
               AND (run_id IS NULL OR EXISTS (SELECT 1 FROM generation_tasks AS result_run WHERE result_run.id = generation_tasks.run_id AND result_run.task_type = 'agent'
                   AND result_run.user_id = $6 AND result_run.expires_at > clock_timestamp() AND result_run.status NOT IN ('success', 'error', 'cancelled')
                   AND COALESCE(result_run.payload ->> 'status', '') NOT IN ('completed', 'failed', 'cancelled')
                   AND (result_run.payload -> 'cancellation' IS NULL OR result_run.payload -> 'cancellation' = 'null'::jsonb)))`,
                [
                    initial.id,
                    input.workerId,
                    input.executionId,
                    response.status,
                    JSON.stringify(resultPayload),
                    checked.userId,
                    image.id,
                    payload.status,
                    JSON.stringify(image.payload.nativeResults),
                    checked.payload.inputDigest,
                    image.upstreamTaskId ?? null,
                    checked.runId ?? null,
                    failure.status === "rejected" ? failure.error.code : failure.reason,
                ],
            );
            if (saved.rowCount !== 1) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
            return response;
        });
    try {
        return await queueRuntimeFileOperation(async () => {
            await withGenerationTaskFileMutation(async (records) => {
                const childRecord = records.find((record) => record.type === "image_processing" && record.id === initial.id);
                const current = childRecord && imageProcessingStageFromRecord(childRecord);
                requireImageProcessingStage(current);
                if (current.status !== "running") throw new ImageProcessingFailureReplay(readFailedImageProcessingStage(current, input, failure));
                assertImageProcessingFinalStage(initial, current, input);
                const parentRecord = records.find((record) => record.type === "image" && record.id === parentTaskId);
                const image = parentRecord && { ...parentRecord, payload: parentRecord.payload as ImageTask };
                const run = fileImageResultRun(records, initial.runId);
                const registrations = await getLocalMediaRegistrations(
                    current.payload.sources.map((source) => source.storageKey),
                    { ownerUserId: current.userId },
                );
                const checked = { ...current, now: Date.now() };
                assertImageProcessingFinalStage(initial, checked, input);
                assertImageProcessingResultParent(checked, image, run);
                assertImageProcessingResultSources(checked, registrations);
                if (image.workerId && image.payload.executionId && Number(image.leaseUntil) > checked.now) throw new ImageProcessingInputError("图像任务已有新的活动执行", 409);
                const payload = failedImageResultPayload(image.payload, failure, checked.now);
                const resultPayload = failedImageProcessingResultPayload(checked, input, failure);
                return {
                    tasks: records.map((record): StoredGenerationTaskRecord => {
                        if (record === childRecord)
                            return {
                                ...record,
                                status: response.status,
                                executionPhase: "needs_review",
                                resultPayload,
                                updatedAt: checked.now,
                                nextPollAt: undefined,
                                workerId: undefined,
                                leaseUntil: undefined,
                                lastHeartbeatAt: undefined,
                                lastUpstreamStatus: failure.status === "rejected" ? failure.error.code : failure.reason,
                            };
                        if (record === parentRecord)
                            return {
                                ...record,
                                status: payload.status,
                                payload,
                                resultPayload: { ...record.resultPayload, reviewReason: reason },
                                updatedAt: checked.now,
                                executionPhase: failure.status === "resource_failure" ? "needs_review" : "completed",
                                nextPollAt: undefined,
                                workerId: undefined,
                                leaseUntil: undefined,
                                lastHeartbeatAt: undefined,
                                lastUpstreamStatus: "image_processing_failed",
                            };
                        return record;
                    }),
                    result: response,
                };
            }).catch((error: unknown) => {
                if (!(error instanceof ImageProcessingFailureReplay)) throw error;
            });
            if (failure.status === "rejected") {
                const current = await readImageProcessingStage(initial.id);
                requireImageProcessingStage(current);
                const image = await readImageProcessingFinalImage(parentTaskId);
                assertRejectedImageResultSettlement(initial, current, image, input, failure);
                const refunded = await settleRejectedImageResult(image.payload, Date.now());
                if (refunded !== image.payload)
                    await withGenerationTaskFileMutation(async (records) => {
                        const childRecord = records.find((record) => record.type === "image_processing" && record.id === initial.id);
                        const latest = childRecord && imageProcessingStageFromRecord(childRecord);
                        requireImageProcessingStage(latest);
                        const parentRecord = records.find((record) => record.type === "image" && record.id === parentTaskId);
                        const parent = parentRecord && { ...parentRecord, payload: parentRecord.payload as ImageTask };
                        assertRejectedImageResultSettlement(current, latest, parent, input, failure);
                        if (parent.payload.billing?.pointsRecordId !== image.payload.billing?.pointsRecordId || parent.payload.billing?.pointsCost !== image.payload.billing?.pointsCost) throw new ImageProcessingInputError("原图像消费绑定已变化", 409);
                        if (parent.payload.billing?.refunded) throw new ImageProcessingFailureReplay(response);
                        return {
                            tasks: records.map((record) => (record === parentRecord ? { ...record, payload: { ...record.payload, billing: refunded.billing }, updatedAt: Date.now() } : record)),
                            result: undefined,
                        };
                    });
            }
            return response;
        });
    } catch (error) {
        if (error instanceof ImageProcessingFailureReplay) return error.receipt;
        throw error;
    }
}

class ImageProcessingResultCheck extends Error {
    constructor(readonly image: ImageTask) {
        super("Image result check does not mutate the task file");
    }
}

function prepareImageProcessingResultResourceResume(stage: ImageProcessingStageState, image: ImageProcessingFinalImage) {
    const payload = stage.payload;
    const result = stage.resultPayload;
    if (payload.resource.unavailable) {
        if (stage.status !== "paused" || stage.executionPhase !== "needs_review" || stage.workerId || stage.leaseUntil !== undefined || payload.executionId || result || image.workerId || image.leaseUntil !== undefined || image.payload.executionId)
            throw new ImageProcessingInputError("当前结果阶段没有可恢复的准入暂停记录", 409);
        return { payload: { ...payload, resource: imageProcessingResourceResumeResource(payload) }, resultPayload: undefined };
    }
    const failure = result?.failure;
    if (
        stage.status !== "paused" ||
        stage.executionPhase !== "needs_review" ||
        stage.workerId ||
        stage.leaseUntil !== undefined ||
        !payload.executionId ||
        !result?.workerId ||
        result.executionId !== payload.executionId ||
        failure?.status !== "resource_failure" ||
        failure.reason !== "v8_heap_oom" ||
        failure.jobId !== stage.id ||
        failure.executionId !== payload.executionId ||
        result.manifest ||
        result.manifestDigest ||
        result.parentRescheduled ||
        result.cancelClose ||
        result.cancelNotStarted ||
        image.workerId ||
        image.leaseUntil !== undefined ||
        image.payload.executionId
    )
        throw new ImageProcessingInputError("当前结果阶段没有可恢复的资源失败回执", 409);
    const resource = imageProcessingResourceResumeResource(payload);
    const checkpoint = { executionId: result.executionId, workerId: result.workerId, failure, resource: payload.resource, ...(result.artifacts ? { artifacts: result.artifacts } : {}) };
    return { payload: { ...payload, executionId: undefined, resource }, resultPayload: { executionId: result.executionId, checkpoints: [...(result.checkpoints || []), checkpoint] } };
}

export async function checkImageProcessingTaskForImage(input: { userId: string; taskId: string }): Promise<ImageTask> {
    const initial = await readImageProcessingFinalImage(input.taskId);
    if (!initial || initial.userId !== input.userId) throw new ImageProcessingInputError("图像任务不存在", 404);
    if (getDatabaseProvider() === "postgres")
        return withPostgresTransaction(async (executor) => {
            const run = await readImageResultRun(initial.runId, executor, true);
            const image = await readImageProcessingFinalImage(input.taskId, executor, true);
            if (!image || image.userId !== input.userId || image.runId !== initial.runId || !image.payload.resultProcessing) throw new ImageProcessingInputError("原图像结果阶段已变化", 409);
            const current = await readImageProcessingStage(image.payload.resultProcessing.jobId, executor, true);
            requireImageProcessingStage(current);
            const registrations = await getLocalMediaRegistrations(
                current.payload.sources.map((source) => source.storageKey),
                { ownerUserId: current.userId, executor, forUpdate: true },
            );
            const checked = await readImageProcessingStage(current.id, executor);
            requireImageProcessingStage(checked);
            assertImageProcessingResultParent(checked, image, run);
            assertImageProcessingResultSources(checked, registrations);
            if (checked.status === "pending" || checked.status === "running") return image.payload;
            const resumed = prepareImageProcessingResultResourceResume(checked, image);
            const payload: ImageTask = { ...image.payload, updatedAt: checked.now };
            const parent = await executor.query(
                `UPDATE generation_tasks SET payload = $3::jsonb, result_payload = result_payload - 'reviewReason',
                 updated_at = clock_timestamp(), execution_phase = 'persisting', last_upstream_status = 'image_processing_waiting'
             WHERE id = $1 AND task_type = 'image' AND user_id = $2 AND status = 'running' AND execution_phase = 'needs_review'
               AND payload = $4::jsonb AND result_payload ->> 'reviewReason' = $5
               AND worker_id IS NULL AND lease_until IS NULL AND last_heartbeat_at IS NULL AND next_poll_at IS NULL
               AND expires_at > clock_timestamp() RETURNING id`,
                [image.id, checked.userId, JSON.stringify(payload), JSON.stringify(image.payload), imageResultResourceReason],
            );
            if (parent.rowCount !== 1) throw new ImageProcessingInputError("原图像任务状态或有效期已变化", 409);
            const saved = await executor.query(
                `UPDATE generation_tasks SET status = 'pending', execution_phase = 'created', payload = $5::jsonb, result_payload = $6::jsonb,
                 updated_at = clock_timestamp(), next_poll_at = clock_timestamp(), worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = 'resource_resume'
             WHERE id = $1 AND task_type = 'image_processing' AND user_id = $2 AND parent_task_id = $3 AND run_id IS NOT DISTINCT FROM $4::text
               AND status = 'paused' AND execution_phase = 'needs_review' AND payload = $7::jsonb AND result_payload IS NOT DISTINCT FROM $8::jsonb
               AND worker_id IS NULL AND lease_until IS NULL AND last_heartbeat_at IS NULL AND next_poll_at IS NULL AND expires_at > clock_timestamp()
               AND EXISTS (SELECT 1 FROM generation_tasks AS result_image WHERE result_image.id = $3 AND result_image.task_type = 'image'
                   AND result_image.user_id = $2 AND result_image.status = 'running' AND result_image.execution_phase = 'persisting'
                   AND result_image.payload = $9::jsonb AND result_image.expires_at > clock_timestamp())
               AND (run_id IS NULL OR EXISTS (SELECT 1 FROM generation_tasks AS result_run WHERE result_run.id = generation_tasks.run_id AND result_run.task_type = 'agent'
                   AND result_run.user_id = $2 AND result_run.expires_at > clock_timestamp() AND result_run.status NOT IN ('success', 'error', 'cancelled')
                   AND COALESCE(result_run.payload ->> 'status', '') NOT IN ('completed', 'failed', 'cancelled')
                   AND (result_run.payload -> 'cancellation' IS NULL OR result_run.payload -> 'cancellation' = 'null'::jsonb)))`,
                [checked.id, checked.userId, image.id, checked.runId ?? null, JSON.stringify(resumed.payload), JSON.stringify(resumed.resultPayload), JSON.stringify(checked.payload), JSON.stringify(checked.resultPayload), JSON.stringify(payload)],
            );
            if (saved.rowCount !== 1) throw new ImageProcessingInputError("原结果阶段状态或有效期已变化", 409);
            return payload;
        });
    try {
        return await queueRuntimeFileOperation(() =>
            withGenerationTaskFileMutation<ImageTask>(async (records) => {
                const parentRecord = records.find((record) => record.type === "image" && record.id === input.taskId);
                const image = parentRecord && { ...parentRecord, payload: parentRecord.payload as ImageTask };
                if (!image || image.userId !== input.userId || image.runId !== initial.runId || !image.payload.resultProcessing) throw new ImageProcessingInputError("原图像结果阶段已变化", 409);
                const jobId = image.payload.resultProcessing.jobId;
                const childRecord = records.find((record) => record.type === "image_processing" && record.id === jobId);
                const current = childRecord && imageProcessingStageFromRecord(childRecord);
                requireImageProcessingStage(current);
                const registrations = await getLocalMediaRegistrations(
                    current.payload.sources.map((source) => source.storageKey),
                    { ownerUserId: current.userId },
                );
                const checked = { ...current, now: Date.now() };
                const run = fileImageResultRun(records, initial.runId);
                assertImageProcessingResultParent(checked, image, run);
                assertImageProcessingResultSources(checked, registrations);
                if (checked.status === "pending" || checked.status === "running") throw new ImageProcessingResultCheck(image.payload);
                if (
                    image.executionPhase !== "needs_review" ||
                    image.resultPayload?.reviewReason !== imageResultResourceReason ||
                    image.lastHeartbeatAt !== undefined ||
                    image.nextPollAt !== undefined ||
                    childRecord?.lastHeartbeatAt !== undefined ||
                    childRecord?.nextPollAt !== undefined
                )
                    throw new ImageProcessingInputError("原图像任务或结果阶段状态已变化", 409);
                const resumed = prepareImageProcessingResultResourceResume(checked, image);
                const committedAt = Date.now();
                if (checked.expiresAt <= committedAt || image.expiresAt <= committedAt || (run && run.expiresAt <= committedAt)) throw new ImageProcessingInputError("父子阶段已过期", 409);
                const payload: ImageTask = { ...image.payload, updatedAt: committedAt };
                return {
                    tasks: records.map((record): StoredGenerationTaskRecord => {
                        if (record === childRecord)
                            return {
                                ...record,
                                status: "pending",
                                executionPhase: "created",
                                payload: resumed.payload,
                                resultPayload: resumed.resultPayload,
                                updatedAt: committedAt,
                                nextPollAt: committedAt,
                                workerId: undefined,
                                leaseUntil: undefined,
                                lastHeartbeatAt: undefined,
                                lastUpstreamStatus: "resource_resume",
                            };
                        if (record === parentRecord) {
                            const resultPayload = { ...record.resultPayload };
                            delete resultPayload.reviewReason;
                            return {
                                ...record,
                                payload,
                                resultPayload,
                                updatedAt: committedAt,
                                executionPhase: "persisting",
                                lastUpstreamStatus: "image_processing_waiting",
                            };
                        }
                        return record;
                    }),
                    result: payload,
                };
            }),
        );
    } catch (error) {
        if (error instanceof ImageProcessingResultCheck) return error.image;
        throw error;
    }
}

async function assertImageProcessingFinalUploadAvailable(initial: ImageProcessingStageState, identity: { workerId: string; executionId: string }, upload: ImageProcessingFinalUpload) {
    const image = await readImageProcessingFinalImage(upload.binding.imageTaskId);
    if (image && (isNativeSceneImageTaskResult(image.payload) || isNativeProductImageTaskResult(image.payload) || isNativeGlobalSceneImageTaskResult(image.payload))) {
        const validate = async (storage: QueryExecutor | StoredGenerationTaskRecord[]) => {
            const executor = Array.isArray(storage) ? undefined : storage;
            const run = Array.isArray(storage) ? fileImageResultRun(storage, initial.runId) : await readImageResultRun(initial.runId, executor, true);
            const record = Array.isArray(storage) ? storage.find((item) => item.type === "image" && item.id === upload.binding.imageTaskId) : await getStoredGenerationTaskRecord("image", upload.binding.imageTaskId, executor, true);
            const currentImage = record ? { ...record, payload: record.payload as ImageTask } : undefined;
            const child = Array.isArray(storage) ? storage.find((item) => item.type === "image_processing" && item.id === initial.id) : await getStoredGenerationTaskRecord("image_processing", initial.id, executor, true);
            const observedAt = executor ? (await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime() : Date.now();
            const current = child ? { ...imageProcessingStageFromRecord(child), now: observedAt } : undefined;
            requireImageProcessingStage(current);
            assertImageProcessingFinalStage(initial, current, identity);
            assertImageProcessingFinalImage(current, currentImage, upload, current.now);
            assertImageProcessingFinalRun(current, currentImage, run, current.now);
            const scene = await readNativeImageResultEvidence(run, currentImage?.payload, current.payload, storage);
            const now = executor ? (await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime() : Date.now();
            assertImageProcessingFinalStage(initial, { ...current, now }, identity);
            assertImageProcessingFinalImage(current, currentImage, upload, now);
            assertImageProcessingFinalRun(current, currentImage, run, now);
            scene?.check(now);
            return { now, registrations: scene?.registrations };
        };
        if (getDatabaseProvider() === "postgres") return withPostgresTransaction(validate);
        return withGenerationTaskFileRead(validate);
    }
    const run = await readImageResultRun(initial.runId);
    const current = await readImageProcessingStage(initial.id);
    if (!current) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
    assertImageProcessingFinalStage(initial, current, identity);
    assertImageProcessingFinalImage(current, image, upload, current.now);
    assertImageProcessingFinalRun(current, image, run, current.now);
}

function imageProcessingFinalArtifacts(stage: ImageProcessingStageState, executionId: string) {
    return stage.resultPayload?.executionId === executionId ? (stage.resultPayload.artifacts ?? []) : [];
}

function assertImageProcessingFinalArtifact(previous: StoredImageProcessingArtifact | undefined, artifact: StoredImageProcessingArtifact) {
    if (
        previous &&
        (previous.resultIndex !== artifact.resultIndex || previous.sha256 !== artifact.sha256 || previous.mimeType !== artifact.mimeType || previous.bytes !== artifact.bytes || previous.width !== artifact.width || previous.height !== artifact.height)
    )
        throw new ImageProcessingInputError("本执行已登记不同的结果槽位工件", 409);
}

async function readImageProcessingFinalRegistrations(stage: ImageProcessingStageState, upload: ImageProcessingFinalUpload, artifact: StoredImageProcessingArtifact, previous: StoredImageProcessingArtifact | undefined, executor?: QueryExecutor) {
    return getLocalMediaRegistrations([upload.slot.storageKey, artifact.storageKey, ...(previous ? [previous.storageKey] : [])], { ownerUserId: stage.userId, executor, forUpdate: Boolean(executor) });
}

function assertImageProcessingFinalOutputRegistration(stage: ImageProcessingStageState, artifact: StoredImageProcessingArtifact, registration: LocalMediaRegistration | undefined): asserts registration is LocalMediaRegistration {
    if (
        !registration ||
        registration.ownerUserId !== stage.userId ||
        registration.scope !== "reference" ||
        registration.type !== "image" ||
        registration.runId !== stage.runId ||
        registration.taskId !== stage.id ||
        registration.mimeType !== artifact.mimeType ||
        registration.bytes !== artifact.bytes ||
        isLocalMediaRegistrationExpired(registration, stage.now)
    )
        throw new ImageProcessingInputError("结果工件媒体登记或归属无效", 400);
}

function assertImageProcessingFinalNativeRegistration(stage: ImageProcessingStageState, upload: ImageProcessingFinalUpload, native: LocalMediaRegistration | undefined) {
    const slot = upload.slot;
    if (
        !native ||
        native.ownerUserId !== stage.userId ||
        native.taskId !== upload.binding.imageTaskId ||
        native.scope !== slot.scope ||
        native.storageClass !== "permanent" ||
        native.type !== "attachment" ||
        native.mimeType !== "application/octet-stream" ||
        native.source !== "image-task-native-result" ||
        native.bytes !== slot.bytes ||
        (native.storageProvider === "object" ? "object" : "local") !== slot.storageProvider ||
        native.externalStorageId !== slot.externalStorageId ||
        isLocalMediaRegistrationExpired(native, stage.now)
    )
        throw new ImageProcessingInputError("结果原件媒体登记或存储位置已变化", 409);
}

function assertImageProcessingFinalRegistrations(
    stage: ImageProcessingStageState,
    upload: ImageProcessingFinalUpload,
    artifact: StoredImageProcessingArtifact,
    previous: StoredImageProcessingArtifact | undefined,
    registrations: LocalMediaRegistration[],
    storage: "local" | "object" | undefined,
) {
    const byKey = new Map(registrations.map((registration) => [registration.storageKey, registration]));
    assertImageProcessingFinalNativeRegistration(stage, upload, byKey.get(upload.slot.storageKey));
    const output = byKey.get(artifact.storageKey);
    assertImageProcessingFinalOutputRegistration(stage, artifact, output);
    if ((output.storageProvider === "object" ? "object" : "local") !== storage) throw new ImageProcessingInputError("结果工件媒体存储位置已变化", 409);
    if (previous) assertImageProcessingFinalOutputRegistration(stage, previous, byKey.get(previous.storageKey));
}

async function stageImageProcessingFinalOutput(
    initial: ImageProcessingStageState,
    identity: { workerId: string; executionId: string },
    upload: ImageProcessingFinalUpload,
    artifact: StoredImageProcessingArtifact,
    storage: "local" | "object" | undefined,
): Promise<StoredImageProcessingArtifact> {
    if (getDatabaseProvider() === "postgres")
        return withPostgresTransaction(async (executor) => {
            // Media I/O has finished; result locks follow Run -> image -> child -> registrations.
            const run = await readImageResultRun(initial.runId, executor, true);
            const image = await readImageProcessingFinalImage(upload.binding.imageTaskId, executor, true);
            const current = await readImageProcessingStage(initial.id, executor, true);
            if (!current) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
            assertImageProcessingFinalStage(initial, current, identity);
            const selected = selectImageProcessingFinalUpload(current, upload.slot.resultId);
            assertImageProcessingFinalImage(current, image, selected, current.now);
            assertImageProcessingFinalRun(current, image, run, current.now);
            const artifacts = imageProcessingFinalArtifacts(current, identity.executionId);
            const previous = artifacts.find((item) => item.kind === "final" && item.resultId === selected.slot.resultId);
            const scene = await readNativeImageResultEvidence(run, image?.payload, current.payload, executor, [selected.slot.storageKey, artifact.storageKey, ...(previous ? [previous.storageKey] : [])]);
            const registrations = scene?.registrations || (await readImageProcessingFinalRegistrations(current, selected, artifact, previous, executor));
            // Registry locks can outlive the lease. Ownership wins before semantic errors.
            const checked = await readImageProcessingStage(initial.id, executor);
            if (!checked) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
            assertImageProcessingFinalStage(initial, checked, identity);
            assertImageProcessingFinalImage(checked, image, selected, checked.now);
            assertImageProcessingFinalRun(checked, image, run, checked.now);
            scene?.check(checked.now, registrations);
            assertImageProcessingFinalRegistrations(checked, selected, artifact, previous, registrations, storage);
            assertImageProcessingFinalArtifact(previous, artifact);
            if (previous) {
                const active = await executor.query(
                    "SELECT child.id FROM generation_tasks AS child JOIN generation_tasks AS image ON image.id = $4 AND image.task_type = 'image' WHERE child.id = $1 AND child.task_type = 'image_processing' AND child.status = 'running' AND child.worker_id = $2 AND child.payload ->> 'executionId' = $3 AND child.lease_until > statement_timestamp() AND child.expires_at > statement_timestamp() AND image.expires_at > statement_timestamp() AND (child.run_id IS NULL OR EXISTS (SELECT 1 FROM generation_tasks AS result_run WHERE result_run.id = child.run_id AND result_run.task_type = 'agent' AND result_run.expires_at > clock_timestamp()))",
                    [initial.id, identity.workerId, identity.executionId, upload.binding.imageTaskId],
                );
                if (!active.rows[0]) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
                return previous;
            }
            const staged: ImageProcessingStoredResult = { executionId: identity.executionId, artifacts: [...artifacts, artifact] };
            const updated = await executor.query(
                "UPDATE generation_tasks AS child SET result_payload = $4::jsonb, updated_at = statement_timestamp() WHERE child.id = $1 AND child.task_type = 'image_processing' AND child.status = 'running' AND child.worker_id = $2 AND child.payload ->> 'executionId' = $3 AND child.lease_until > statement_timestamp() AND child.expires_at > statement_timestamp() AND EXISTS (SELECT 1 FROM generation_tasks AS image WHERE image.id = $5 AND image.task_type = 'image' AND image.expires_at > statement_timestamp()) AND (child.run_id IS NULL OR EXISTS (SELECT 1 FROM generation_tasks AS result_run WHERE result_run.id = child.run_id AND result_run.task_type = 'agent' AND result_run.expires_at > clock_timestamp())) RETURNING child.id",
                [initial.id, identity.workerId, identity.executionId, JSON.stringify(staged), upload.binding.imageTaskId],
            );
            if (!updated.rows[0]) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
            return artifact;
        });
    return withGenerationTaskFileMutation(async (records) => {
        const imageRecord = records.find((record) => record.type === "image" && record.id === upload.binding.imageTaskId);
        const image = imageRecord && { ...imageRecord, payload: imageRecord.payload as ImageTask };
        const run = fileImageResultRun(records, initial.runId);
        const record = records.find((task) => task.type === "image_processing" && task.id === initial.id);
        const current = record && imageProcessingStageFromRecord(record);
        if (!current) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
        assertImageProcessingFinalStage(initial, current, identity);
        const selected = selectImageProcessingFinalUpload(current, upload.slot.resultId);
        assertImageProcessingFinalImage(current, image, selected, current.now);
        assertImageProcessingFinalRun(current, image, run, current.now);
        const artifacts = imageProcessingFinalArtifacts(current, identity.executionId);
        const previous = artifacts.find((item) => item.kind === "final" && item.resultId === selected.slot.resultId);
        const scene = await readNativeImageResultEvidence(run, image?.payload, current.payload, records, [selected.slot.storageKey, artifact.storageKey, ...(previous ? [previous.storageKey] : [])]);
        const registrations = scene?.registrations || (await readImageProcessingFinalRegistrations(current, selected, artifact, previous));
        const now = Date.now();
        const checked = { ...current, now };
        assertImageProcessingFinalStage(initial, checked, identity);
        assertImageProcessingFinalImage(checked, image, selected, now);
        assertImageProcessingFinalRun(checked, image, run, now);
        scene?.check(now, registrations);
        assertImageProcessingFinalRegistrations(checked, selected, artifact, previous, registrations, storage);
        assertImageProcessingFinalArtifact(previous, artifact);
        if (previous) return { tasks: records, result: previous };
        const resultPayload: ImageProcessingStoredResult = { executionId: identity.executionId, artifacts: [...artifacts, artifact] };
        return { tasks: records.map((task) => (task === record ? { ...task, updatedAt: now, resultPayload } : task)), result: artifact };
    });
}

export async function completeImageProcessingTask(id: string, input: CompleteImageProcessingInput): Promise<CompletedImageProcessingStage> {
    const enhancement = await readEnhancementProcessingTask(id);
    if (enhancement) return enhancementProcessingRequest(() => completeEnhancementProcessing(enhancement, input));
    const initial = await readImageProcessingStage(id);
    requireImageProcessingStage(initial);
    if (initial.status === "success") return readCompletedImageProcessingStage(initial, input);
    assertCurrentImageProcessingStage(initial, input);
    if (initial.payload.operation === "prepare_review") return completeEcommerceReviewPreparation(initial, input);
    if (initial.payload.operation === "process_result") {
        if (getDatabaseProvider() === "postgres") return completePostgresImageProcessingResult(initial, input);
        return completeFileImageProcessingResult(initial, input);
    }
    if (getDatabaseProvider() === "postgres")
        return withPostgresTransaction(async (executor) => {
            const locked = await executor.query<{ user_id: string; payload: AgentRun; expires_at: Date }>("SELECT user_id, payload, expires_at FROM generation_tasks WHERE id = $1 AND task_type = 'agent' FOR UPDATE", [initial.runId]);
            const parent = locked.rows[0];
            if (!parent) throw new ImageProcessingInputError("父任务不存在", 404);
            const current = await readImageProcessingStage(id, executor, true);
            requireImageProcessingStage(current);
            if (current.status === "success") return readCompletedImageProcessingStage(current, input);
            assertCurrentImageProcessingStage(current, input);
            if (current.runId !== initial.runId || current.userId !== parent.user_id || parent.expires_at.getTime() <= current.now) throw new ImageProcessingInputError("父子阶段归属已失效", 409);
            assertImageProcessingCompletion(current, input);
            for (const artifact of input.manifest.artifacts) await assertImageProcessingOutputRegistration(current, artifact, executor);
            await assertImageProcessingFrozenSource(current, executor);
            const nextParent = await mergeCompletedImageProcessingParent(parent.payload, current, input.manifest, (jobId) => readImageProcessingStage(jobId, executor));
            const resultPayload = { ...completedImageProcessingPayload(input, Boolean(nextParent)), ...(current.resultPayload?.checkpoints ? { checkpoints: current.resultPayload.checkpoints } : {}) };
            const updated = await executor.query<{ updated_at: Date }>(
                "UPDATE generation_tasks SET status = 'success', execution_phase = 'completed', result_payload = $4::jsonb, updated_at = statement_timestamp(), next_poll_at = NULL, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = 'completed' WHERE id = $1 AND task_type = 'image_processing' AND status = 'running' AND worker_id = $2 AND payload ->> 'executionId' = $3 AND lease_until > statement_timestamp() AND expires_at > statement_timestamp() RETURNING updated_at",
                [id, input.workerId, input.executionId, JSON.stringify(resultPayload)],
            );
            if (!updated.rows[0]) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
            if (nextParent) {
                const now = updated.rows[0].updated_at;
                const scheduled = await executor.query(
                    "UPDATE generation_tasks SET payload = $2::jsonb, updated_at = $3, execution_phase = 'created', next_poll_at = $3, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = 'image_processing_completed' WHERE id = $1 AND task_type = 'agent' AND expires_at > statement_timestamp() RETURNING id",
                    [initial.runId, JSON.stringify({ ...nextParent, updatedAt: now.getTime() }), now],
                );
                if (!scheduled.rows[0]) throw new ImageProcessingInputError("父任务已过期", 409);
            }
            return completedImageProcessingResponse(current, resultPayload);
        });
    return queueRuntimeFileOperation(async () => {
        // A concurrent completion may have committed while this call waited for
        // the creative lock. Return its receipt before opening a file mutation.
        const latest = await readImageProcessingStage(id);
        requireImageProcessingStage(latest);
        if (latest.status === "success") return readCompletedImageProcessingStage(latest, input);
        return withGenerationTaskFileMutation(async (records) => {
            const parentRecord = records.find((task) => task.type === "agent" && task.id === initial.runId);
            const childRecord = records.find((task) => task.type === "image_processing" && task.id === id);
            if (!parentRecord) throw new ImageProcessingInputError("父任务不存在", 404);
            const current = childRecord && imageProcessingStageFromRecord(childRecord);
            requireImageProcessingStage(current);
            assertCurrentImageProcessingStage(current, input);
            if (current.runId !== initial.runId || current.userId !== parentRecord.userId || parentRecord.expiresAt <= current.now) throw new ImageProcessingInputError("父子阶段归属已失效", 409);
            assertImageProcessingCompletion(current, input);
            for (const artifact of input.manifest.artifacts) await assertImageProcessingOutputRegistration(current, artifact);
            await assertImageProcessingFrozenSource(current);
            const nextParent = await mergeCompletedImageProcessingParent(parentRecord.payload as AgentRun, current, input.manifest, async (jobId) => {
                const task = records.find((record) => record.type === "image_processing" && record.id === jobId);
                return task && imageProcessingStageFromRecord(task);
            });
            const now = Date.now();
            assertCurrentImageProcessingStage({ ...current, now }, input);
            const resultPayload = { ...completedImageProcessingPayload(input, Boolean(nextParent)), ...(current.resultPayload?.checkpoints ? { checkpoints: current.resultPayload.checkpoints } : {}) };
            return {
                tasks: records.map((record): StoredGenerationTaskRecord => {
                    if (record === childRecord)
                        return { ...record, status: "success", executionPhase: "completed", resultPayload, updatedAt: now, nextPollAt: undefined, workerId: undefined, leaseUntil: undefined, lastHeartbeatAt: undefined, lastUpstreamStatus: "completed" };
                    if (record === parentRecord && nextParent)
                        return {
                            ...record,
                            payload: { ...nextParent, updatedAt: now },
                            updatedAt: now,
                            executionPhase: "created",
                            nextPollAt: now,
                            workerId: undefined,
                            leaseUntil: undefined,
                            lastHeartbeatAt: undefined,
                            lastUpstreamStatus: "image_processing_completed",
                        };
                    return record;
                }),
                result: completedImageProcessingResponse(current, resultPayload),
            };
        });
    });
}

function completePostgresImageProcessingResult(initial: ImageProcessingStageState, input: CompleteImageProcessingInput): Promise<CompletedImageProcessingStage> {
    return withPostgresTransaction(async (executor) => {
        const run = await readImageResultRun(initial.runId, executor, true);
        const locked = await executor.query<{
            id: string;
            user_id: string;
            run_id: string | null;
            parent_task_id: string | null;
            conversation_id: string | null;
            surface: StoredGenerationTaskRecord["surface"] | null;
            project_id: string | null;
            status: StoredGenerationTaskRecord["status"];
            execution_phase: StoredGenerationTaskRecord["executionPhase"] | null;
            payload: ImageTask;
            expires_at: Date;
            upstream_task_id: string | null;
        }>("SELECT id, user_id, run_id, parent_task_id, conversation_id, surface, project_id, status, execution_phase, payload, expires_at, upstream_task_id FROM generation_tasks WHERE id = $1 AND task_type = 'image' FOR UPDATE", [initial.parentTaskId]);
        const parent = locked.rows[0];
        const current = await readImageProcessingStage(initial.id, executor, true);
        requireImageProcessingStage(current);
        if (current.status === "success") return readCompletedImageProcessingStage(current, input);
        assertImageProcessingFinalStage(initial, current, input);
        const uploads = assertImageProcessingResultCompletion(current, input);
        const image = parent && {
            id: parent.id,
            userId: parent.user_id,
            runId: parent.run_id ?? undefined,
            parentTaskId: parent.parent_task_id ?? undefined,
            conversationId: parent.conversation_id ?? undefined,
            surface: parent.surface ?? undefined,
            projectId: parent.project_id ?? undefined,
            status: parent.status,
            payload: parent.payload,
            expiresAt: parent.expires_at.getTime(),
            upstreamTaskId: parent.upstream_task_id ?? undefined,
        };
        const scene = await readNativeImageResultEvidence(
            run,
            image?.payload,
            current.payload,
            executor,
            input.manifest.artifacts.map((artifact) => artifact.storageKey),
        );
        const registrations =
            scene?.registrations ||
            (await getLocalMediaRegistrations([...current.payload.sources.map((source) => source.storageKey), ...input.manifest.artifacts.map((artifact) => artifact.storageKey)], {
                ownerUserId: current.userId,
                executor,
                forUpdate: true,
            }));
        const checked = await readImageProcessingStage(initial.id, executor);
        requireImageProcessingStage(checked);
        assertImageProcessingFinalStage(initial, checked, input);
        const byKey = new Map(registrations.map((registration) => [registration.storageKey, registration]));
        for (const upload of uploads) assertImageProcessingFinalNativeRegistration(checked, upload, byKey.get(upload.slot.storageKey));
        scene?.check(checked.now, registrations);
        assertResultAuxiliaryRegistrations(checked, registrations);
        for (const artifact of input.manifest.artifacts) {
            const registration = byKey.get(artifact.storageKey);
            assertImageProcessingFinalOutputRegistration(checked, artifact, registration);
            if (registration.storageClass !== "temporary") throw new ImageProcessingInputError("结果工件媒体存储位置或暂存登记已变化", 409);
        }
        assertImageProcessingFinalRun(checked, image, run, checked.now);
        const parentMatches = parent?.execution_phase === "persisting" && imageProcessingFinalImageMatches(checked, image, uploads[0].binding, checked.now);
        if (checked.runId && !parentMatches) throw new ImageProcessingInputError("结果完成的原图像任务绑定已失效", 409);
        // Persist the actual wake result; a failed child CAS rolls that wake back.
        let parentRescheduled = false;
        if (parentMatches) {
            const scheduled = await executor.query(
                `UPDATE generation_tasks
                 SET payload = jsonb_set(payload, '{updatedAt}', to_jsonb(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)),
                     updated_at = clock_timestamp(), execution_phase = 'persisting', next_poll_at = clock_timestamp(), last_upstream_status = 'image_processing_completed'
                 WHERE id = $1 AND task_type = 'image' AND user_id = $2 AND status = 'running' AND execution_phase = 'persisting'
                   AND expires_at > clock_timestamp()
                   AND NOT (NULLIF(worker_id, '') IS NOT NULL AND NULLIF(payload ->> 'executionId', '') IS NOT NULL
                            AND lease_until IS NOT NULL AND lease_until > clock_timestamp())
                    AND (run_id IS NULL OR EXISTS (SELECT 1 FROM generation_tasks AS result_run WHERE result_run.id = generation_tasks.run_id AND result_run.task_type = 'agent' AND result_run.expires_at > clock_timestamp()))`,
                [parent.id, current.userId],
            );
            parentRescheduled = scheduled.rowCount === 1;
        }
        const resultPayload = completedImageProcessingPayload(input, parentRescheduled);
        const updated = await executor.query(
            `UPDATE generation_tasks
             SET status = 'success', execution_phase = 'completed', result_payload = $4::jsonb, updated_at = clock_timestamp(),
                 next_poll_at = NULL, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = 'completed'
             WHERE id = $1 AND task_type = 'image_processing' AND status = 'running' AND worker_id = $2
               AND payload ->> 'executionId' = $3 AND lease_until > clock_timestamp() AND expires_at > clock_timestamp()
                AND (run_id IS NULL OR EXISTS (SELECT 1 FROM generation_tasks AS result_run WHERE result_run.id = generation_tasks.run_id AND result_run.task_type = 'agent' AND result_run.expires_at > clock_timestamp()))`,
            [initial.id, input.workerId, input.executionId, JSON.stringify(resultPayload)],
        );
        if (updated.rowCount !== 1) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
        return completedImageProcessingResponse(checked, resultPayload);
    });
}

function completeFileImageProcessingResult(initial: ImageProcessingStageState, input: CompleteImageProcessingInput): Promise<CompletedImageProcessingStage> {
    return queueRuntimeFileOperation(async () => {
        const latest = await readImageProcessingStage(initial.id);
        requireImageProcessingStage(latest);
        if (latest.status === "success") return readCompletedImageProcessingStage(latest, input);
        return withGenerationTaskFileMutation(async (records) => {
            const childRecord = records.find((record) => record.type === "image_processing" && record.id === initial.id);
            const current = childRecord && imageProcessingStageFromRecord(childRecord);
            requireImageProcessingStage(current);
            assertImageProcessingFinalStage(initial, current, input);
            const uploads = assertImageProcessingResultCompletion(current, input);
            const parentRecord = records.find((record) => record.type === "image" && record.id === uploads[0].binding.imageTaskId);
            const image = parentRecord && { ...parentRecord, payload: parentRecord.payload as ImageTask };
            const run = fileImageResultRun(records, initial.runId);
            const scene = await readNativeImageResultEvidence(
                run,
                image?.payload,
                current.payload,
                records,
                input.manifest.artifacts.map((artifact) => artifact.storageKey),
            );
            const registrations =
                scene?.registrations || (await getLocalMediaRegistrations([...current.payload.sources.map((source) => source.storageKey), ...input.manifest.artifacts.map((artifact) => artifact.storageKey)], { ownerUserId: current.userId }));
            const now = Date.now();
            const checked = { ...current, now };
            assertImageProcessingFinalStage(initial, checked, input);
            const byKey = new Map(registrations.map((registration) => [registration.storageKey, registration]));
            for (const upload of uploads) assertImageProcessingFinalNativeRegistration(checked, upload, byKey.get(upload.slot.storageKey));
            scene?.check(now, registrations);
            assertResultAuxiliaryRegistrations(checked, registrations);
            for (const artifact of input.manifest.artifacts) {
                const registration = byKey.get(artifact.storageKey);
                assertImageProcessingFinalOutputRegistration(checked, artifact, registration);
                if (registration.storageClass !== "temporary") throw new ImageProcessingInputError("结果工件媒体存储位置或暂存登记已变化", 409);
            }
            assertImageProcessingFinalRun(checked, image, run, now);
            const parentMatches = parentRecord?.executionPhase === "persisting" && imageProcessingFinalImageMatches(checked, image, uploads[0].binding, now);
            if (checked.runId && !parentMatches) throw new ImageProcessingInputError("结果完成的原图像任务绑定已失效", 409);
            const parentOwned = parentRecord && parentRecord.workerId && image?.payload.executionId && Number(parentRecord.leaseUntil) > now;
            const parentRescheduled = parentMatches && !parentOwned;
            const resultPayload = completedImageProcessingPayload(input, parentRescheduled);
            return {
                tasks: records.map((record): StoredGenerationTaskRecord => {
                    if (record === childRecord)
                        return { ...record, status: "success", executionPhase: "completed", resultPayload, updatedAt: now, nextPollAt: undefined, workerId: undefined, leaseUntil: undefined, lastHeartbeatAt: undefined, lastUpstreamStatus: "completed" };
                    if (record === parentRecord && parentRescheduled) return { ...record, payload: { ...record.payload, updatedAt: now }, updatedAt: now, executionPhase: "persisting", nextPollAt: now, lastUpstreamStatus: "image_processing_completed" };
                    return record;
                }),
                result: completedImageProcessingResponse(current, resultPayload),
            };
        });
    });
}

function assertImageProcessingResultCompletion(stage: ImageProcessingStageState, input: CompleteImageProcessingInput) {
    const { manifest } = input;
    const payload = stage.payload;
    if (payload.operation !== "process_result") throw new ImageProcessingInputError("结果完成阶段类型不符", 400);
    const options = payload.options;
    const uploads = options.results.map((result) => selectImageProcessingFinalUpload(stage, result.resultId));
    const staged = imageProcessingFinalArtifacts(stage, input.executionId);
    const results = manifest.results;
    const auxiliaryCount = options.mode === "ordinary" ? 0 : options.mode === "layers" ? 1 : 2;
    if (
        manifest.jobId !== stage.id ||
        manifest.executionId !== input.executionId ||
        !uploads.length ||
        payload.inputs.length !== uploads.length + auxiliaryCount ||
        new Set(options.results.map((result) => result.inputIndex)).size !== uploads.length ||
        options.results.some((result, index) => result.inputIndex !== index) ||
        manifest.sourceIdentities.length !== payload.inputs.length ||
        !results ||
        results.length !== uploads.length ||
        !manifest.artifacts.length ||
        manifest.artifacts.length !== staged.length ||
        new Set(staged.map((artifact) => artifact.resultId)).size !== staged.length
    )
        throw new ImageProcessingInputError("结果完成清单与冻结输入或本执行工件不符", 400);
    for (const [inputIndex, source] of manifest.sourceIdentities.entries()) {
        const frozen = payload.inputs[inputIndex];
        const encoded = payload.resource.facts.encodedInputs.find((fact) => fact.inputIndex === inputIndex);
        const native = uploads[inputIndex];
        if (
            source.assetId !== frozen.assetId ||
            source.assetVersion !== frozen.assetVersion ||
            source.sha256 !== frozen.expectedSha256 ||
            !encoded ||
            source.assetId !== encoded.assetId ||
            source.assetVersion !== encoded.assetVersion ||
            source.sha256 !== encoded.sha256 ||
            source.bytes !== encoded.bytes ||
            (native && source.bytes !== native.slot.bytes) ||
            (source.decodeError && (source.width !== undefined || source.height !== undefined || source.mimeType !== undefined || source.nativeImage !== undefined || !native)) ||
            (!source.decodeError &&
                (!analysisMimeTypes.includes(source.mimeType) ||
                    !Number.isSafeInteger(source.width) ||
                    !Number.isSafeInteger(source.height) ||
                    source.width <= 0 ||
                    source.height <= 0 ||
                    (native
                        ? !source.nativeImage ||
                          source.nativeImage.format !== source.mimeType.slice("image/".length) ||
                          typeof source.nativeImage.hasAlpha !== "boolean" ||
                          Object.keys(source.nativeImage).some((key) => !["format", "hasAlpha"].includes(key))
                        : source.nativeImage !== undefined)))
        )
            throw new ImageProcessingInputError("结果完成原件身份与冻结输入不符", 400);
    }
    if (options.mode === "ordinary") {
        if (Object.keys(manifest.geometry).length !== 0) throw new ImageProcessingInputError("普通结果不接受保护几何", 400);
    } else {
        const source = manifest.sourceIdentities[options.sourceInputIndex];
        if (options.sourceInputIndex !== uploads.length || !source || source.decodeError || !isDeepStrictEqual(manifest.geometry, { sourceSize: { width: source.width, height: source.height } }))
            throw new ImageProcessingInputError("结果辅助源或几何身份不符", 400);
        if (options.mode !== "layers") {
            const mask = manifest.sourceIdentities[options.maskInputIndex];
            const size = options.mode === "scene_protection" ? options.protection.sourceSize : options.protection.product.sourceSize;
            const sourceId = options.mode === "scene_protection" ? options.protection.sourceAssetId : options.protection.product.sourceAssetId;
            const maskSha256 = options.mode === "scene_protection" ? options.protection.maskDigest : options.protection.maskSha256;
            if (
                options.maskInputIndex !== uploads.length + 1 ||
                !mask ||
                mask.decodeError ||
                mask.mimeType !== "image/png" ||
                mask.sha256 !== maskSha256 ||
                mask.width !== size.width ||
                mask.height !== size.height ||
                source.assetId !== sourceId ||
                source.width !== size.width ||
                source.height !== size.height ||
                (options.mode === "scene_protection" && source.sha256 !== options.protection.sourceDigest) ||
                (options.baseline && (options.baseline.sha256 !== source.sha256 || options.baseline.byteLength !== source.bytes || options.baseline.width !== source.width || options.baseline.height !== source.height))
            )
                throw new ImageProcessingInputError("结果保护源、蒙版或基线不符", 400);
        }
    }
    const usedArtifacts = new Set<number>();
    for (const [index, result] of results.entries()) {
        const frozen = options.results[index];
        const source = manifest.sourceIdentities[frozen.inputIndex];
        if (result.resultId !== frozen.resultId || result.resultIndex !== frozen.resultIndex || result.nativeInputIndex !== frozen.inputIndex) throw new ImageProcessingInputError("结果完成槽位与冻结清单不符", 400);
        if (result.error) {
            if (
                options.mode === "layers" ||
                result.finalArtifactIndex !== undefined ||
                Object.keys(result).some((key) => !["resultId", "resultIndex", "nativeInputIndex", "error"].includes(key)) ||
                (source.decodeError ? result.error.failureStage !== "decode" || result.error.code !== source.decodeError.code || result.error.message !== source.decodeError.message : result.error.failureStage !== "validation")
            )
                throw new ImageProcessingInputError("结果失败槽位与原件解码事实不符", 400);
            continue;
        }
        const artifact = manifest.artifacts[result.finalArtifactIndex];
        const previous = staged.find((item) => item.resultId === result.resultId);
        if (
            source.decodeError ||
            !Number.isSafeInteger(result.finalArtifactIndex) ||
            usedArtifacts.has(result.finalArtifactIndex) ||
            !artifact ||
            artifact.kind !== "final" ||
            artifact.resultId !== result.resultId ||
            artifact.resultIndex !== result.resultIndex ||
            !previous ||
            !isDeepStrictEqual(artifactIdentity(options.mode === "layers" ? { ...artifact, layerKind: undefined } : artifact), artifactIdentity(previous))
        )
            throw new ImageProcessingInputError("结果完成槽位与本执行登记工件不符", 400);
        assertResultModeEvidence(options, manifest, result, artifact);
        usedArtifacts.add(result.finalArtifactIndex);
    }
    if (usedArtifacts.size !== manifest.artifacts.length) throw new ImageProcessingInputError("结果完成清单包含未绑定工件", 400);
    if (options.mode === "layers" && (manifest.artifacts.filter((artifact) => artifact.layerKind === "background").length !== 1 || !manifest.artifacts.some((artifact) => artifact.layerKind === "element")))
        throw new ImageProcessingInputError("分层结果缺少完整背景或元素", 400);
    return uploads;
}

function assertResultAuxiliaryRegistrations(stage: ImageProcessingStageState, registrations: LocalMediaRegistration[]) {
    const payload = stage.payload;
    if (payload.operation !== "process_result") throw new ImageProcessingInputError("结果阶段类型不符", 400);
    for (const source of payload.sources.filter((item) => !payload.options.results.some((result) => result.inputIndex === item.inputIndex))) {
        const registration = registrations.find((item) => item.storageKey === source.storageKey);
        const encoded = payload.resource.facts.encodedInputs.find((item) => item.inputIndex === source.inputIndex);
        if (
            !registration ||
            !encoded ||
            registration.ownerUserId !== stage.userId ||
            registration.scope !== source.scope ||
            registration.type !== "image" ||
            registration.bytes !== encoded.bytes ||
            (registration.storageProvider === "object" ? "object" : "local") !== source.storageProvider ||
            registration.externalStorageId !== source.externalStorageId ||
            (source.frozenResultSource && !imageTaskResultFrozenSourceRegistrationMatches(registration, payload.imageResultBinding?.imageTaskId)) ||
            isLocalMediaRegistrationExpired(registration, stage.now)
        )
            throw new ImageProcessingInputError("结果辅助输入媒体登记已变化", 409);
    }
}

export function assertResultModeEvidence(options: ImageProcessingResultOptions, manifest: ImageProcessingManifest, result: Extract<ImageProcessingResultBinding, { finalArtifactIndex: number }>, artifact: StoredImageProcessingArtifact) {
    const native = manifest.sourceIdentities[result.nativeInputIndex];
    if (native.decodeError || !native.nativeImage) throw new ImageProcessingInputError("结果缺少实际原件事实", 400);
    if (result.finalImage && (typeof result.finalImage.hasAlpha !== "boolean" || `image/${result.finalImage.format}` !== artifact.mimeType)) throw new ImageProcessingInputError("最终成图格式或透明事实不符", 400);
    if (options.mode === "ordinary" || options.mode === "layers") {
        if (result.baselineValidated !== undefined || result.sceneProtectionEvidence !== undefined || result.productEnhancementEvidence !== undefined) throw new ImageProcessingInputError("普通或分层结果不接受保护证据", 400);
        if (options.mode === "layers") {
            const source = manifest.sourceIdentities[options.sourceInputIndex];
            if (
                source.decodeError ||
                artifact.layerKind !== (native.nativeImage.hasAlpha ? "element" : "background") ||
                artifact.sha256 !== native.sha256 ||
                artifact.bytes !== native.bytes ||
                artifact.mimeType !== native.mimeType ||
                artifact.width !== source.width ||
                artifact.height !== source.height ||
                native.width !== source.width ||
                native.height !== source.height
            )
                throw new ImageProcessingInputError("分层分类、原字节或尺寸不符", 400);
        } else {
            const target = options.targetSize;
            const preservesNative = !target || (native.width === target.width && native.height === target.height) || native.width < target.width || native.height < target.height;
            if (artifact.layerKind !== undefined || (options.transparentBackground && !native.nativeImage.hasAlpha)) throw new ImageProcessingInputError("普通结果透明事实或目标尺寸不符", 400);
            if (preservesNative) {
                if (artifact.sha256 !== native.sha256 || artifact.bytes !== native.bytes || artifact.mimeType !== native.mimeType || artifact.width !== native.width || artifact.height !== native.height)
                    throw new ImageProcessingInputError("普通结果原字节或尺寸不符", 400);
            } else {
                const shrink = Math.max(native.width / target.width, native.height / target.height);
                // Sharp clamps each inside shrink axis before libvips rounds its output size.
                const width = Math.round(native.width / Math.min(shrink, native.width));
                const height = Math.round(native.height / Math.min(shrink, native.height));
                if (artifact.width !== width || artifact.height !== height) throw new ImageProcessingInputError("普通结果目标尺寸与等比缩放不符", 400);
            }
        }
        return;
    }
    const source = manifest.sourceIdentities[options.sourceInputIndex];
    const mask = manifest.sourceIdentities[options.maskInputIndex];
    const size = options.mode === "scene_protection" ? options.protection.sourceSize : options.protection.product.sourceSize;
    if (
        source.decodeError ||
        mask.decodeError ||
        artifact.layerKind !== undefined ||
        artifact.mimeType !== "image/png" ||
        artifact.width !== size.width ||
        artifact.height !== size.height ||
        result.baselineValidated !== (options.baseline ? true : undefined)
    )
        throw new ImageProcessingInputError("保护结果尺寸或基线资格不符", 400);
    if (options.mode === "scene_protection") {
        const proof = result.sceneProtectionEvidence;
        if (!proof || result.productEnhancementEvidence !== undefined) throw new ImageProcessingInputError("场景结果缺少保护证据", 400);
        const { nativeSize, normalization, nativeDigest, compositeDigest, outsidePixels, mappedOutsideChangedPixels, nativeOutsideChangedPixels, compositeOutsideChangedPixels, ...snapshot } = proof;
        const cross = BigInt(native.width) * BigInt(size.height) - BigInt(native.height) * BigInt(size.width);
        const expectedNormalization = native.width === size.width && native.height === size.height ? "none" : cross === BigInt(0) ? "uniform_scale" : "pixel_grid_scale";
        const region = options.protection.targetRegion;
        if (
            !isDeepStrictEqual(snapshot, options.protection) ||
            !isDeepStrictEqual(nativeSize, { width: native.width, height: native.height }) ||
            normalization !== expectedNormalization ||
            BigInt(2) * (cross < BigInt(0) ? -cross : cross) >= BigInt(size.width) + BigInt(size.height) ||
            nativeDigest !== native.sha256 ||
            compositeDigest !== artifact.sha256 ||
            outsidePixels !== size.width * size.height - region.width * region.height ||
            compositeOutsideChangedPixels !== 0 ||
            !Number.isSafeInteger(mappedOutsideChangedPixels) ||
            mappedOutsideChangedPixels < 0 ||
            mappedOutsideChangedPixels > outsidePixels ||
            (normalization === "none" ? nativeOutsideChangedPixels !== mappedOutsideChangedPixels : nativeOutsideChangedPixels !== undefined)
        )
            throw new ImageProcessingInputError("场景保护证据与冻结源或真实工件不符", 400);
        return;
    }
    const proof = result.productEnhancementEvidence;
    const product = options.protection.product;
    if (
        !proof ||
        result.sceneProtectionEvidence !== undefined ||
        native.nativeImage.hasAlpha ||
        native.width !== size.width ||
        native.height !== size.height ||
        proof.version !== options.protection.version ||
        proof.normalization !== options.protection.normalization ||
        proof.productAnchorId !== product.productAnchorId ||
        proof.sourceAssetId !== product.sourceAssetId ||
        proof.sourceSha256 !== source.sha256 ||
        proof.maskSha256 !== mask.sha256 ||
        proof.aiSha256 !== native.sha256 ||
        proof.compositeSha256 !== artifact.sha256 ||
        !isDeepStrictEqual(proof.sourceSize, size) ||
        !isDeepStrictEqual(proof.aiSize, { width: native.width, height: native.height }) ||
        proof.protectedChangedPixels !== 0 ||
        !Number.isSafeInteger(proof.allowedPixels) ||
        proof.allowedPixels <= 0 ||
        !Number.isSafeInteger(proof.protectedPixels) ||
        proof.protectedPixels <= 0 ||
        proof.allowedPixels + proof.protectedPixels !== size.width * size.height
    )
        throw new ImageProcessingInputError("商品保护证据与冻结源或真实工件不符", 400);
}

function imageProcessingStageFromRecord(record: StoredGenerationTaskRecord): ImageProcessingStageState {
    return { ...record, payload: record.payload as AgentImageProcessingPayload, resultPayload: record.resultPayload as ImageProcessingStoredResult | undefined, now: Date.now() };
}

async function readImageProcessingStage(id: string, executor?: QueryExecutor, lock = false): Promise<ImageProcessingStageState | undefined> {
    if (getDatabaseProvider() !== "postgres") {
        const record = await getStoredGenerationTaskRecord("image_processing", id);
        return record ? imageProcessingStageFromRecord(record) : undefined;
    }
    if (!executor) await ensurePostgresSchema();
    const query: QueryExecutor["query"] = executor ? executor.query.bind(executor) : postgresQuery;
    if (lock) await query("SELECT id FROM generation_tasks WHERE id = $1 AND task_type = 'image_processing' FOR UPDATE", [id]);
    // A fresh statement after acquiring the lock observes the server time after
    // any lock wait, so an expired owner cannot use the pre-wait timestamp.
    const result = await query<{
        id: string;
        user_id: string;
        run_id: string | null;
        parent_task_id: string | null;
        status: StoredGenerationTaskRecord["status"];
        conversation_id: string | null;
        surface: StoredGenerationTaskRecord["surface"] | null;
        project_id: string | null;
        execution_phase: StoredGenerationTaskRecord["executionPhase"] | null;
        payload: AgentImageProcessingPayload;
        result_payload: ImageProcessingStoredResult | null;
        worker_id: string | null;
        lease_until: Date | null;
        expires_at: Date;
        server_now: Date;
    }>(
        "SELECT id, user_id, run_id, parent_task_id, conversation_id, surface, project_id, status, execution_phase, payload, result_payload, worker_id, lease_until, expires_at, statement_timestamp() AS server_now FROM generation_tasks WHERE id = $1 AND task_type = 'image_processing' AND expires_at > statement_timestamp()",
        [id],
    );
    const row = result.rows[0];
    return row
        ? {
              id: row.id,
              userId: row.user_id,
              runId: row.run_id ?? undefined,
              parentTaskId: row.parent_task_id ?? undefined,
              conversationId: row.conversation_id ?? undefined,
              surface: row.surface ?? undefined,
              projectId: row.project_id ?? undefined,
              status: row.status,
              executionPhase: row.execution_phase ?? undefined,
              payload: row.payload,
              resultPayload: row.result_payload ?? undefined,
              workerId: row.worker_id ?? undefined,
              leaseUntil: row.lease_until?.getTime(),
              expiresAt: row.expires_at.getTime(),
              now: row.server_now.getTime(),
          }
        : undefined;
}

function requireImageProcessingStage(stage: ImageProcessingStageState | undefined): asserts stage is ImageProcessingStageState {
    if (!stage) throw new ImageProcessingInputError("图像阶段不存在", 404);
}

function assertCurrentImageProcessingStage(stage: ImageProcessingStageState, identity: { workerId: string; executionId: string }) {
    if (stage.expiresAt <= stage.now || stage.status !== "running" || stage.workerId !== identity.workerId || stage.payload.executionId !== identity.executionId || !(Number(stage.leaseUntil) > stage.now))
        throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
}

function analysisMetadataMimeType(metadata: Metadata) {
    if (metadata.format === "heif" && metadata.compression === "av1") return "image/avif";
    const mimeType = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
    if (!analysisMimeTypes.includes(mimeType)) throw new ImageProcessingInputError("分析图像真实格式不支持", 400);
    return mimeType;
}

function artifactIdentity(artifact: StoredImageProcessingArtifact) {
    return [artifact.kind, artifact.storageKey, artifact.sha256, artifact.mimeType, artifact.bytes, artifact.width, artifact.height, artifact.resultId, artifact.resultIndex, artifact.layerKind];
}

function matchingStagedArtifact(stage: ImageProcessingStageState, artifact: StoredImageProcessingArtifact, executionId: string) {
    const previous = stage.resultPayload?.executionId === executionId ? stage.resultPayload.artifacts?.find((item) => item.kind === artifact.kind) : undefined;
    if (previous && (previous.sha256 !== artifact.sha256 || previous.mimeType !== artifact.mimeType || previous.bytes !== artifact.bytes || previous.width !== artifact.width || previous.height !== artifact.height))
        throw new ImageProcessingInputError(artifact.kind === "analysis" ? "本执行已登记不同的分析工件" : "本执行已登记不同的蒙版工件", 409);
    return previous;
}

async function assertImageProcessingOutputRegistration(stage: ImageProcessingStageState, artifact: StoredImageProcessingArtifact, executor?: QueryExecutor) {
    const [registration] = await getLocalMediaRegistrations([artifact.storageKey], { ownerUserId: stage.userId, executor, forUpdate: Boolean(executor) });
    if (
        !registration ||
        registration.scope !== "reference" ||
        registration.type !== "image" ||
        registration.runId !== stage.runId ||
        registration.taskId !== stage.id ||
        registration.mimeType !== artifact.mimeType ||
        registration.bytes !== artifact.bytes ||
        isLocalMediaRegistrationExpired(registration, stage.now)
    )
        throw new ImageProcessingInputError("分析工件媒体登记或归属无效", 400);
}

async function assertImageProcessingFrozenSource(stage: ImageProcessingStageState, executor?: QueryExecutor) {
    const source = stage.payload.sources[0];
    const [registration] = await getLocalMediaRegistrations([source.storageKey], { ownerUserId: stage.userId, executor, forUpdate: Boolean(executor) });
    assertRegistration(registration, source, stage.userId, stage.now);
    if ((registration.storageProvider === "object" ? "object" : "local") !== source.storageProvider || registration.externalStorageId !== source.externalStorageId) throw new ImageProcessingInputError("原件媒体存储位置已变化", 409);
}

function frozenDecodedSource(payload: AgentImageProcessingPayload) {
    const input = payload.inputs[0];
    const decoded = payload.resource.facts.decodedInputs.find((fact) => fact.inputIndex === 0 && fact.assetId === input.assetId && fact.assetVersion === input.assetVersion && fact.sha256 === input.expectedSha256);
    if (!decoded) throw new ImageProcessingInputError("保护阶段缺少冻结的完整解码尺寸", 409);
    return decoded;
}

function assertImageProcessingCompletion(stage: ImageProcessingStageState, input: CompleteImageProcessingInput) {
    if (stage.payload.operation === "build_protection") return assertProtectionCompletion(stage, input, stage.payload.options);
    return assertPrepareCompletion(stage, input);
}

function assertProtectionCompletion(stage: ImageProcessingStageState, input: CompleteImageProcessingInput, options: ImageProcessingProtectionOptions) {
    const { manifest } = input;
    const source = manifest.sourceIdentities[0];
    const frozen = stage.payload.inputs[0];
    const encoded = stage.payload.resource.facts.encodedInputs[0];
    const size = frozenDecodedSource(stage.payload);
    const mask = manifest.artifacts[0];
    const staged = stage.resultPayload?.executionId === input.executionId ? stage.resultPayload.artifacts : undefined;
    if (
        manifest.jobId !== stage.id ||
        manifest.executionId !== input.executionId ||
        manifest.sourceIdentities.length !== 1 ||
        !source ||
        source.decodeError ||
        source.assetId !== frozen.assetId ||
        source.assetVersion !== frozen.assetVersion ||
        source.sha256 !== frozen.expectedSha256 ||
        source.sha256 !== encoded.sha256 ||
        source.bytes !== encoded.bytes ||
        source.mimeType !== (encoded.layout?.format === "jpeg" ? "image/jpeg" : `image/${encoded.layout?.format}`) ||
        source.width !== size.width ||
        source.height !== size.height ||
        manifest.results !== undefined ||
        manifest.artifacts.length !== (!("mode" in options) && options.generationInput ? 3 : 1) ||
        !mask ||
        mask.kind !== "mask" ||
        mask.mimeType !== "image/png" ||
        mask.width !== size.width ||
        mask.height !== size.height ||
        !staged ||
        staged.length !== manifest.artifacts.length ||
        !manifest.artifacts.every((artifact, index) => isDeepStrictEqual(artifactIdentity(artifact), artifactIdentity(staged[index]))) ||
        !manifest.geometry.sourceSize ||
        manifest.geometry.sourceSize.width !== size.width ||
        manifest.geometry.sourceSize.height !== size.height
    )
        throw new ImageProcessingInputError("保护完成清单与冻结原件或本执行蒙版不符", 400);
    if (!("mode" in options) && options.generationInput) assertGenerationInputArtifacts(manifest.artifacts, options.generationInput, size);
    const geometry = manifest.geometry;
    if (!("mode" in options)) {
        const product = geometry.productBounds;
        const halo = geometry.haloBounds;
        if (
            !product ||
            !halo ||
            !validPixelRectangle(product, size) ||
            !validPixelRectangle(halo, size) ||
            halo.x > product.x ||
            halo.y > product.y ||
            halo.x + halo.width < product.x + product.width ||
            halo.y + halo.height < product.y + product.height ||
            geometry.sceneProtection !== undefined
        )
            throw new ImageProcessingInputError("商品保护边界与冻结源尺寸不符", 400);
    } else {
        if (geometry.productBounds !== undefined || geometry.haloBounds !== undefined) throw new ImageProcessingInputError("局部保护不接受商品分割边界", 400);
        const protection = geometry.sceneProtection;
        if (options.mode === "local_edit") {
            if (protection !== undefined) throw new ImageProcessingInputError("局部商品蒙版不接受场景保护快照", 400);
        } else if (
            !protection ||
            protection.sourceAssetId !== source.assetId ||
            protection.sourceDigest !== source.sha256 ||
            protection.sourceSize.width !== size.width ||
            protection.sourceSize.height !== size.height ||
            protection.maskSize.width !== size.width ||
            protection.maskSize.height !== size.height ||
            protection.maskDigest !== mask.sha256 ||
            protection.confirmation !== undefined ||
            JSON.stringify(rectangleIdentity(protection.targetRegion)) !== JSON.stringify(rectangleIdentity(options.region)) ||
            JSON.stringify(protection.semantics) !== JSON.stringify(options.semantics) ||
            protection.selectionSource !== options.selectionSource
        )
            throw new ImageProcessingInputError("场景保护快照与冻结选区或实际蒙版不符", 400);
    }
    assertProtectionBaseline(geometry.enhancementBaseline, options, source, mask);
}

function assertProtectionBaseline(
    baseline: ImageProcessingEnhancementBaseline | undefined,
    options: ImageProcessingProtectionOptions,
    source: Extract<ImageProcessingResult["sourceIdentities"][number], { mimeType: string }>,
    mask: StoredImageProcessingArtifact,
) {
    if (!options.freezeEnhancementBaseline) {
        if (baseline !== undefined) throw new ImageProcessingInputError("本阶段未请求增强基线资格", 400);
        return;
    }
    const scope = "mode" in options && options.mode === "scene_selection" ? "local_edit" : "product_background";
    if (!baseline || baseline.scope !== scope) throw new ImageProcessingInputError("增强基线资格或范围不符", 400);
    if (baseline.status === "unsupported") return;
    const frozen = baseline.baseline;
    if (frozen.sha256 !== source.sha256 || frozen.byteLength !== source.bytes || frozen.width !== source.width || frozen.height !== source.height) throw new ImageProcessingInputError("增强基线原件身份不符", 400);
    const composition = baseline.composition;
    if (scope === "local_edit") {
        if (composition !== undefined) throw new ImageProcessingInputError("场景增强基线不接受商品合成证据", 400);
        return;
    }
    const anchor = "mode" in options && options.mode === "local_edit" && options.freezeEnhancementBaseline ? options.freezeEnhancementBaseline.productAnchorId : source.assetId;
    if (
        !composition ||
        baseline.hasAlpha ||
        composition.productAnchorId !== anchor ||
        composition.sourceAssetId !== source.assetId ||
        composition.sourceSha256 !== source.sha256 ||
        composition.maskSha256 !== mask.sha256 ||
        composition.aiSha256 !== frozen.normalizedSha256 ||
        composition.sourceSize.width !== source.width ||
        composition.sourceSize.height !== source.height ||
        composition.aiSize.width !== source.width ||
        composition.aiSize.height !== source.height ||
        composition.allowedPixels <= 0 ||
        composition.protectedPixels < 0 ||
        composition.allowedPixels + composition.protectedPixels !== source.width * source.height ||
        composition.protectedChangedPixels !== 0
    )
        throw new ImageProcessingInputError("商品增强基线合成证据与冻结来源不符", 400);
}

function assertPrepareCompletion(stage: ImageProcessingStageState, input: CompleteImageProcessingInput) {
    const { manifest } = input;
    const source = manifest.sourceIdentities[0];
    const frozen = stage.payload.inputs[0];
    const encoded = stage.payload.resource.facts.encodedInputs[0];
    const artifacts = stage.resultPayload?.executionId === input.executionId ? stage.resultPayload.artifacts : undefined;
    const size = manifest.geometry.sourceSize;
    if (
        stage.payload.operation !== "prepare_reference" ||
        manifest.jobId !== stage.id ||
        manifest.executionId !== input.executionId ||
        manifest.sourceIdentities.length !== 1 ||
        !source ||
        source.decodeError ||
        source.assetId !== frozen.assetId ||
        source.assetVersion !== frozen.assetVersion ||
        source.sha256 !== frozen.expectedSha256 ||
        source.sha256 !== encoded.sha256 ||
        source.bytes !== encoded.bytes ||
        !source.mimeType ||
        !analysisMimeTypes.includes(source.mimeType) ||
        !Number.isSafeInteger(source.width) ||
        !Number.isSafeInteger(source.height) ||
        Number(source.width) <= 0 ||
        Number(source.height) <= 0 ||
        Number(source.width) * Number(source.height) > ECOMMERCE_IMAGE_MAX_INPUT_PIXELS ||
        !size ||
        size.width !== source.width ||
        size.height !== source.height ||
        manifest.results !== undefined ||
        Object.keys(manifest.geometry).some((key) => key !== "sourceSize") ||
        manifest.artifacts.length !== 1 ||
        manifest.artifacts[0].kind !== (stage.payload.operation === "prepare_reference" && stage.payload.options.generationInput ? "generation_reference" : "analysis") ||
        !artifacts ||
        artifacts.length !== 1 ||
        JSON.stringify(artifactIdentity(manifest.artifacts[0])) !== JSON.stringify(artifactIdentity(artifacts[0]))
    )
        throw new ImageProcessingInputError("完成清单与本执行登记工件或原件身份不符", 400);
    if (stage.payload.operation === "prepare_reference" && stage.payload.options.generationInput) assertGenerationReferenceArtifact(manifest.artifacts[0], stage.payload.options.generationInput, size);
}

export function imageProcessingManifestDigest(manifest: ImageProcessingManifest) {
    return createHash("sha256")
        .update(
            JSON.stringify([
                manifest.jobId,
                manifest.executionId,
                manifest.sourceIdentities.map((source) => [
                    source.assetId,
                    source.assetVersion,
                    source.sha256,
                    source.bytes,
                    source.width,
                    source.height,
                    source.mimeType,
                    source.decodeError && [source.decodeError.code, source.decodeError.message],
                    ...(manifest.results ? [source.nativeImage && [source.nativeImage.format, source.nativeImage.hasAlpha]] : []),
                ]),
                manifest.artifacts.map(artifactIdentity),
                [
                    manifest.geometry.sourceSize?.width,
                    manifest.geometry.sourceSize?.height,
                    manifest.geometry.productBounds && rectangleIdentity(manifest.geometry.productBounds),
                    manifest.geometry.haloBounds && rectangleIdentity(manifest.geometry.haloBounds),
                    manifest.geometry.sceneProtection && sceneProtectionIdentity(manifest.geometry.sceneProtection),
                    manifest.geometry.enhancementBaseline && enhancementBaselineIdentity(manifest.geometry.enhancementBaseline),
                ],
                manifest.results?.map((result) => [
                    result.resultId,
                    result.resultIndex,
                    result.nativeInputIndex,
                    result.finalArtifactIndex,
                    result.error && [result.error.code, result.error.message, result.error.failureStage],
                    !result.error && [
                        result.baselineValidated,
                        result.sceneProtectionEvidence && sceneProtectionEvidenceIdentity(result.sceneProtectionEvidence),
                        result.productEnhancementEvidence && productCompositionIdentity(result.productEnhancementEvidence),
                        ...(result.finalImage ? [[result.finalImage.format, result.finalImage.hasAlpha]] : []),
                    ],
                ]),
            ]),
        )
        .digest("hex");
}

function sceneProtectionIdentity(protection: SceneProtectionSnapshot) {
    return [
        protection.version,
        protection.sourceAssetId,
        [protection.sourceSize.width, protection.sourceSize.height],
        protection.sourceDigest,
        [protection.maskSize.width, protection.maskSize.height],
        protection.maskDigest,
        rectangleIdentity(protection.targetRegion),
        protection.semantics,
        protection.selectionSource,
        protection.confirmation && [protection.confirmation.actorUserId, protection.confirmation.confirmedAt],
        protection.maskSemantics,
        protection.method,
    ];
}

function sceneProtectionEvidenceIdentity(evidence: SceneProtectionEvidence) {
    return [
        sceneProtectionIdentity(evidence),
        [evidence.nativeSize.width, evidence.nativeSize.height],
        evidence.normalization,
        evidence.nativeDigest,
        evidence.compositeDigest,
        evidence.outsidePixels,
        evidence.mappedOutsideChangedPixels,
        evidence.nativeOutsideChangedPixels,
        evidence.compositeOutsideChangedPixels,
    ];
}

function enhancementBaselineIdentity(baseline: ImageProcessingEnhancementBaseline) {
    if (baseline.status === "unsupported") return [baseline.status, baseline.scope, [baseline.error.code, baseline.error.message]];
    const frozen = baseline.baseline;
    return [baseline.status, baseline.scope, baseline.normalization, [frozen.sha256, frozen.byteLength, frozen.width, frozen.height, frozen.normalizedSha256], baseline.hasAlpha, baseline.composition && productCompositionIdentity(baseline.composition)];
}

function productCompositionIdentity(evidence: ProductEnhancementEvidence) {
    return [
        evidence.version,
        evidence.normalization,
        evidence.productAnchorId,
        evidence.sourceAssetId,
        evidence.sourceSha256,
        evidence.maskSha256,
        evidence.aiSha256,
        evidence.compositeSha256,
        [evidence.sourceSize.width, evidence.sourceSize.height],
        [evidence.aiSize.width, evidence.aiSize.height],
        evidence.allowedPixels,
        evidence.protectedPixels,
        evidence.protectedChangedPixels,
    ];
}

function completedImageProcessingPayload(input: CompleteImageProcessingInput, parentRescheduled: boolean) {
    return { executionId: input.executionId, workerId: input.workerId, manifest: input.manifest, manifestDigest: imageProcessingManifestDigest(input.manifest), metrics: input.metrics, parentRescheduled };
}

function completedImageProcessingResponse(stage: Pick<ImageProcessingTask, "id" | "payload">, result: { executionId: string; manifest: ImageProcessingManifest; parentRescheduled: boolean }): CompletedImageProcessingStage {
    return { jobId: stage.id, inputDigest: stage.payload.inputDigest, executionId: result.executionId, manifest: result.manifest, parentRescheduled: result.parentRescheduled };
}

export function readCompletedImageProcessingStage(stage: Pick<ImageProcessingTask, "id" | "payload" | "resultPayload">, input: CompleteImageProcessingInput): CompletedImageProcessingStage {
    const result = stage.resultPayload as ImageProcessingStoredResult | undefined;
    if (!result?.manifest || result.workerId !== input.workerId || result.executionId !== input.executionId || result.manifestDigest !== imageProcessingManifestDigest(input.manifest) || typeof result.parentRescheduled !== "boolean")
        throw new ImageProcessingInputError("已完成阶段执行身份或清单冲突", 409);
    return completedImageProcessingResponse(stage, { executionId: result.executionId, manifest: result.manifest, parentRescheduled: result.parentRescheduled });
}

// Called by reference recovery while its parent and child records are locked.
export function hasOnlyCompletedEcommerceReferencePrepares(run: AgentRun, children: RunMutationContext["persistedChildren"]) {
    const processing = run.ecommerceSnapshot?.processing;
    if (!processing) return children.length === 0;
    const checkpoint = run.ecommerceSnapshot?.referenceCheckpoint;
    const references = processing.prepareReferences;
    if (
        !checkpoint ||
        processing.waitingFor ||
        processing.protection ||
        processing.generationReferences?.length ||
        !references.length ||
        references.length !== checkpoint.assets.length ||
        references.length !== children.length ||
        new Set(references.map((reference) => reference.jobId)).size !== references.length ||
        new Set(references.map((reference) => reference.assetId)).size !== references.length
    )
        return false;
    return references.every((reference) =>
        Boolean(
            completedEcommerceReferencePrepare(
                run,
                reference.jobId,
                children.find((record) => record.id === reference.jobId),
            ),
        ),
    );
}

function completedEcommerceReferencePrepare(run: AgentRun, jobId: string, child: RunMutationContext["persistedChildren"][number] | undefined) {
    const reference = run.ecommerceSnapshot?.processing?.prepareReferences.find((item) => item.jobId === jobId);
    const checkpoint = run.ecommerceSnapshot?.referenceCheckpoint;
    if (!reference || !checkpoint) return;
    const current = checkpoint.assets.find((item) => item.asset.id === reference.assetId);
    if (!child || child.type !== "image_processing" || child.status !== "success" || child.executionPhase !== "completed" || child.userId !== run.userId || child.runId !== run.id || !current?.contentSha256 || !reference.manifest) return;
    const payload = child.payload as AgentImageProcessingPayload;
    if (payload.version !== "image-processing.v1" || payload.operation !== "prepare_reference" || Object.keys(payload.options).length !== 0 || payload.inputs.length !== 1 || payload.sources.length !== 1 || !payload.executionId) return;
    const input = payload.inputs[0];
    const encoded = payload.resource.facts.encodedInputs.find((fact) => fact.inputIndex === 0 && fact.assetId === input.assetId && fact.assetVersion === input.assetVersion);
    const result = child.resultPayload as ImageProcessingStoredResult | undefined;
    if (!result?.manifest) return;
    const manifest = result.manifest;
    const source = manifest.sourceIdentities[0];
    if (
        !source ||
        source.decodeError ||
        !encoded ||
        payload.inputDigest !== reference.inputDigest ||
        manifest.jobId !== child.id ||
        manifest.executionId !== payload.executionId ||
        result.executionId !== payload.executionId ||
        manifest.sourceIdentities.length !== 1 ||
        manifest.artifacts.length !== 1 ||
        manifest.artifacts[0].kind !== "analysis" ||
        result.manifestDigest !== imageProcessingManifestDigest(manifest) ||
        imageProcessingManifestDigest(manifest) !== imageProcessingManifestDigest(reference.manifest) ||
        source.assetId !== reference.assetId ||
        source.assetId !== input.assetId ||
        source.assetVersion !== reference.assetVersion ||
        source.assetVersion !== input.assetVersion ||
        source.sha256 !== input.expectedSha256 ||
        source.sha256 !== encoded.sha256 ||
        source.bytes !== encoded.bytes ||
        source.sha256 !== current.contentSha256 ||
        !prepareSourceMatchesReference(current, source)
    )
        return;
    return { record: child, payload, reference, current, source };
}

function prepareSourceMatchesReference(item: EcommerceReferenceCheckpoint["assets"][number], source: ImageProcessingResult["sourceIdentities"][number]) {
    return (
        !source.decodeError &&
        source.assetId === item.asset.id &&
        referenceAssetVersion(item.asset, item.contentSha256) === item.assetVersion &&
        (source.assetVersion === referenceAssetVersion(item.asset) || source.assetVersion === referenceAssetVersion(item.asset, source.sha256)) &&
        (!item.contentSha256 || (item.contentSha256 === source.sha256 && item.asset.width === source.width && item.asset.height === source.height))
    );
}

async function mergeCompletedImageProcessingParent(parent: AgentRun, stage: ImageProcessingStageState, manifest: ImageProcessingManifest, lookup: (jobId: string) => Promise<ImageProcessingStageState | undefined>): Promise<AgentRun | undefined> {
    if (stage.payload.operation === "prepare_reference" && stage.payload.options.generationInput) {
        const snapshot = parent.ecommerceSnapshot;
        const processing = snapshot?.processing;
        const reference = processing?.generationReferences?.find((item) => item.jobId === stage.id && item.inputDigest === stage.payload.inputDigest);
        if (!snapshot || !processing || !reference || parent.cancellation || parent.status === "cancelled" || processing.waitingFor?.jobId !== stage.id || processing.waitingFor.inputDigest !== stage.payload.inputDigest) return;
        return {
            ...parent,
            executionId: undefined,
            ecommerceSnapshot: { ...snapshot, processing: { ...processing, generationReferences: processing.generationReferences!.map((item) => (item === reference ? { ...item, manifest } : item)), waitingFor: undefined } },
        };
    }
    if (stage.payload.operation !== "build_protection") return mergeCompletedPrepareParent(parent, stage, manifest, lookup);
    const snapshot = parent.ecommerceSnapshot;
    const processing = snapshot?.processing;
    if (
        parent.cancellation ||
        parent.status === "cancelled" ||
        !snapshot ||
        !processing ||
        processing.waitingFor?.jobId !== stage.id ||
        processing.waitingFor.inputDigest !== stage.payload.inputDigest ||
        processing.protection?.jobId !== stage.id ||
        processing.protection.inputDigest !== stage.payload.inputDigest
    )
        return;
    const source = manifest.sourceIdentities[0];
    const reference = snapshot.referenceCheckpoint?.assets.find((item) => item.asset.id === source.assetId && item.assetVersion === source.assetVersion && item.contentSha256 === source.sha256);
    if (!reference || !prepareSourceMatchesReference(reference, source)) return;
    return { ...parent, executionId: undefined, ecommerceSnapshot: { ...snapshot, processing: { ...processing, protection: { ...processing.protection, manifest }, waitingFor: undefined } } };
}

async function mergeCompletedPrepareParent(parent: AgentRun, stage: ImageProcessingStageState, manifest: ImageProcessingManifest, lookup: (jobId: string) => Promise<ImageProcessingStageState | undefined>): Promise<AgentRun | undefined> {
    const snapshot = parent.ecommerceSnapshot;
    const processing = snapshot?.processing;
    const checkpoint = snapshot?.referenceCheckpoint;
    if (parent.cancellation || parent.status === "cancelled" || !snapshot || !processing || !checkpoint || processing.waitingFor?.jobId !== stage.id || processing.waitingFor.inputDigest !== stage.payload.inputDigest) return;
    const source = manifest.sourceIdentities[0];
    const item = checkpoint.assets.find((entry) => entry.asset.id === source.assetId);
    const reference = processing.prepareReferences.find((entry) => entry.jobId === stage.id && entry.inputDigest === stage.payload.inputDigest && entry.assetId === source.assetId && entry.assetVersion === source.assetVersion);
    if (!item || !reference || !prepareSourceMatchesReference(item, source) || source.decodeError) return;
    const assets = checkpoint.assets.map((entry) =>
        entry !== item || entry.contentSha256 ? entry : { ...entry, asset: { ...entry.asset, width: source.width, height: source.height }, contentSha256: source.sha256, assetVersion: referenceAssetVersion(entry.asset, source.sha256) },
    );
    const prepareReferences = processing.prepareReferences.map((entry) => (entry === reference ? { ...entry, manifest } : entry));
    let nextCheckpoint = { ...checkpoint, assets };
    const sources: Array<{ assetId: string; contentSha256: string; sourceSize: { width: number; height: number } }> = [];
    for (const asset of assets) {
        const prepared = prepareReferences.find((entry) => entry.assetId === asset.asset.id && entry.manifest);
        if (!prepared?.manifest) break;
        const saved = prepared.jobId === stage.id ? undefined : await lookup(prepared.jobId);
        const completed =
            prepared.jobId === stage.id
                ? manifest
                : saved?.status === "success" && saved.userId === stage.userId && saved.runId === parent.id && saved.payload.operation === "prepare_reference" && saved.payload.inputDigest === prepared.inputDigest
                  ? saved.resultPayload?.manifest
                  : undefined;
        const identity = completed?.sourceIdentities[0];
        if (
            !completed ||
            !identity ||
            identity.decodeError ||
            completed.sourceIdentities.length !== 1 ||
            completed.jobId !== prepared.jobId ||
            imageProcessingManifestDigest(completed) !== imageProcessingManifestDigest(prepared.manifest) ||
            !prepareSourceMatchesReference(asset, identity) ||
            identity.assetVersion !== prepared.assetVersion ||
            identity.sha256 !== asset.contentSha256
        )
            break;
        if (
            saved &&
            (completed.executionId !== saved.payload.executionId ||
                identity.assetId !== saved.payload.inputs[0].assetId ||
                identity.assetVersion !== saved.payload.inputs[0].assetVersion ||
                identity.sha256 !== saved.payload.inputs[0].expectedSha256 ||
                identity.bytes !== saved.payload.resource.facts.encodedInputs[0].bytes)
        )
            break;
        sources.push({ assetId: identity.assetId, contentSha256: identity.sha256, sourceSize: { width: identity.width, height: identity.height } });
    }
    if (sources.length === assets.length && (checkpoint.analysisStage.state === "created" || checkpoint.analysisStage.state === "sources_loaded")) nextCheckpoint = referenceSourcesLoaded(nextCheckpoint, sources);
    return { ...parent, executionId: undefined, ecommerceSnapshot: { ...snapshot, referenceCheckpoint: nextCheckpoint, processing: { ...processing, prepareReferences, waitingFor: undefined } } };
}

export async function readImageProcessingInput(id: string, assetId: string, identity: { workerId: string; executionId: string }, signal?: AbortSignal): Promise<{ stream: Readable; mimeType: string; bytes: number }> {
    const enhancement = await readEnhancementProcessingTask(id);
    if (enhancement) return enhancementProcessingRequest(() => readEnhancementProcessingInput(enhancement, assetId, identity, signal));
    let task: Pick<StoredGenerationTaskRecord, "userId" | "status" | "payload" | "workerId" | "leaseUntil" | "expiresAt">;
    let now: number;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ user_id: string; status: StoredGenerationTaskRecord["status"]; payload: Record<string, unknown>; worker_id: string | null; lease_until: Date | null; expires_at: Date; server_now: Date }>(
            "SELECT user_id, status, payload, worker_id, lease_until, expires_at, statement_timestamp() AS server_now FROM generation_tasks WHERE id = $1 AND task_type = 'image_processing'",
            [id],
        );
        const row = result.rows[0];
        if (!row) throw new ImageProcessingInputError("图像阶段不存在", 404);
        now = row.server_now.getTime();
        task = { userId: row.user_id, status: row.status, payload: row.payload, workerId: row.worker_id ?? undefined, leaseUntil: row.lease_until?.getTime(), expiresAt: row.expires_at.getTime() };
    } else {
        const record = await getStoredGenerationTaskRecord("image_processing", id);
        if (!record) throw new ImageProcessingInputError("图像阶段不存在", 404);
        task = record;
        now = Date.now();
    }
    if (task.expiresAt <= now) throw new ImageProcessingInputError("图像阶段已过期", 404);
    const payload = task.payload as AgentImageProcessingPayload;
    if (task.status !== "running" || task.workerId !== identity.workerId || payload.executionId !== identity.executionId || !(Number(task.leaseUntil) > now)) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
    const inputIndex = payload.inputs.findIndex((input) => input.assetId === assetId);
    if (inputIndex < 0) throw new ImageProcessingInputError("素材不在本阶段输入清单", 404);
    if (payload.parentMask?.inputIndex === inputIndex) {
        if (
            payload.operation !== "process_result" ||
            (payload.options.mode !== "scene_protection" && payload.options.mode !== "product_protection") ||
            payload.options.maskInputIndex !== inputIndex ||
            !payload.imageResultBinding ||
            payload.parentMask.imageTaskId !== payload.imageResultBinding.imageTaskId
        )
            throw new ImageProcessingInputError("父蒙版输入定位已失效", 409);
        const initial = await readImageProcessingStage(id);
        requireImageProcessingStage(initial);
        assertCurrentImageProcessingStage(initial, identity);
        const upload = selectImageProcessingFinalUpload(initial, payload.options.results[0].resultId);
        const image = await readImageProcessingFinalImage(payload.parentMask.imageTaskId);
        const current = await readImageProcessingStage(id);
        requireImageProcessingStage(current);
        assertImageProcessingFinalStage(initial, current, identity);
        assertImageProcessingFinalImage(current, image, upload, current.now);
        if (!image?.payload.mask) throw new ImageProcessingInputError("父蒙版输入不存在", 409);
        if (!imageTaskResultReferenceLocation(image.payload.mask)) {
            const bytes = imageTaskResultMaskBytes(image.payload.mask);
            const frozen = payload.resource.facts.encodedInputs.find((fact) => fact.inputIndex === inputIndex);
            if (!frozen || frozen.bytes !== bytes.length || createHash("sha256").update(bytes).digest("hex") !== payload.inputs[inputIndex].expectedSha256) throw new ImageProcessingInputError("父蒙版输入字节与冻结身份不符", 409);
            if (!payload.sources.some((source) => source.inputIndex === inputIndex)) return { stream: Readable.from(bytes), mimeType: "image/png", bytes: bytes.length };
        }
    }
    const source = payload.sources.find((item) => item.inputIndex === inputIndex);
    if (!source) throw new ImageProcessingInputError("图像阶段原件定位已失效", 409);
    let registration: LocalMediaRegistration | null | undefined = await getLocalMediaRegistration(source.storageKey);
    if (!registration) throw new ImageProcessingInputError("原件媒体登记不存在", 404);
    const nativeResult = payload.operation === "process_result" ? payload.options.results.find((result) => result.inputIndex === inputIndex) : undefined;
    if (nativeResult) {
        const current = await readImageProcessingStage(id);
        requireImageProcessingStage(current);
        assertCurrentImageProcessingStage(current, identity);
        if (!isDeepStrictEqual(current.payload, payload)) throw new ImageProcessingInputError("图像阶段冻结输入已变化", 409);
        const upload = selectImageProcessingFinalUpload(current, nativeResult.resultId);
        if (current.runId) await assertImageProcessingFinalUploadAvailable(current, identity, upload);
        assertImageProcessingFinalNativeRegistration(current, upload, registration);
    } else {
        let checkedAt: number | undefined;
        if (payload.operation === "process_result" && payload.imageResultBinding?.run) {
            const current = await readImageProcessingStage(id);
            requireImageProcessingStage(current);
            assertCurrentImageProcessingStage(current, identity);
            if (!isDeepStrictEqual(current.payload, payload)) throw new ImageProcessingInputError("图像阶段冻结输入已变化", 409);
            const upload = selectImageProcessingFinalUpload(current, payload.options.results[0].resultId);
            const available = await assertImageProcessingFinalUploadAvailable(current, identity, upload);
            if (available) {
                checkedAt = available.now;
                registration = available.registrations?.find((item) => item.storageKey === source.storageKey);
            }
        }
        assertRegistration(registration, source, task.userId, checkedAt);
        if (source.frozenResultSource && !imageTaskResultFrozenSourceRegistrationMatches(registration, payload.imageResultBinding?.imageTaskId)) throw new ImageProcessingInputError("结果辅助输入原件归属已变化", 409);
    }
    if (payload.operation === "prepare_review") {
        const current = await readImageProcessingStage(id);
        requireImageProcessingStage(current);
        assertCurrentImageProcessingStage(current, identity);
        if (!isDeepStrictEqual(current.payload, payload)) throw new ImageProcessingInputError("视觉复核原件身份已变化", 409);
        const parent = await getStoredGenerationTask<AgentRun>("agent", current.runId!);
        if (!parent || !reviewStageView(parent, current)) throw new ImageProcessingInputError("视觉复核准备检查点已变化", 409);
    }
    const provider = registration.storageProvider === "object" ? "object" : "local";
    if (provider !== source.storageProvider || registration.externalStorageId !== source.externalStorageId) throw new ImageProcessingInputError("原件媒体存储位置已变化", 409);
    const stream = await registeredOriginalStream(registration, signal);
    return { stream, mimeType: registration.mimeType, bytes: registration.bytes };
}

type ClaimableImageProcessingPayload = ImageProcessingPayload & { resource: { requiredMemoryBytes: number } };

const claimableImageProcessingSql = `task.task_type = 'image_processing'
    AND task.status IN ('pending', 'running')
    AND task.expires_at > statement_timestamp()
    AND task.next_poll_at <= statement_timestamp()
    AND (task.lease_until IS NULL OR task.lease_until <= statement_timestamp())
    AND task.payload ->> 'version' = 'image-processing.v1'
    AND task.payload #>> '{resource,profileVersion}' = $1
    AND (task.payload #>> '{resource,requiredMemoryBytes}')::bigint > 0
    AND (task.payload #>> '{resource,requiredMemoryBytes}')::bigint <= $2::bigint
    AND task.payload #> '{resource,unavailable}' IS NULL
    AND (task.payload ->> 'operation' <> 'process_enhancement' OR (task.status='pending' AND task.payload ->> 'executionId' IS NULL))`;

export async function claimImageProcessingTasks(input: ClaimImageProcessingInput): Promise<{ tasks: ClaimedImageProcessingTask[] }> {
    const configuration = imageProcessingResourceConfig(process.env);
    if (
        !input.workerId.trim() ||
        !Number.isSafeInteger(input.availableMemoryBytes) ||
        input.availableMemoryBytes < 0 ||
        input.availableMemoryBytes > configuration.budgetBytes ||
        !Number.isSafeInteger(input.slots) ||
        input.slots < 0 ||
        input.slots > configuration.concurrency
    )
        throw new ImageProcessingInputError("Worker 空闲内存或槽位不符合部署配置", 400);
    if (input.profileVersion !== configuration.profileVersion) throw new ImageProcessingInputError("图像资源配置版本不匹配", 409);
    if (input.availableMemoryBytes === 0 || input.slots === 0) return { tasks: [] };
    let remainingMemoryBytes = input.availableMemoryBytes;
    const claimed: ClaimedImageProcessingTask[] = [];
    // A locked candidate still consumes its user's turn within this request.
    const selectedUsers: string[] = [];
    const visitedIds: string[] = [];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (executor) => {
            while (claimed.length < input.slots) {
                const candidates = await executor.query<{ id: string; user_id: string }>(
                    `WITH user_candidates AS MATERIALIZED (
                        SELECT DISTINCT ON (task.user_id) task.id
                        FROM generation_tasks AS task
                        WHERE ${claimableImageProcessingSql} AND NOT (task.id = ANY($4::text[]))
                        ORDER BY task.user_id, task.next_poll_at, task.id
                     )
                     SELECT task.id, task.user_id
                     FROM generation_tasks AS task
                     JOIN user_candidates AS candidate ON candidate.id = task.id
                     WHERE ${claimableImageProcessingSql} AND NOT (task.id = ANY($4::text[]))
                     ORDER BY (SELECT count(*) FROM unnest($3::text[]) AS selected(user_id) WHERE selected.user_id = task.user_id),
                              (SELECT max(served.updated_at) FROM generation_tasks AS served
                               WHERE served.user_id = task.user_id AND served.task_type = 'image_processing'
                                 AND served.payload ->> 'executionId' IS NOT NULL) ASC NULLS FIRST,
                              task.next_poll_at, task.id
                     LIMIT 1`,
                    [input.profileVersion, remainingMemoryBytes, selectedUsers, visitedIds],
                );
                const candidate = candidates.rows[0];
                if (!candidate) break;
                visitedIds.push(candidate.id);
                selectedUsers.push(candidate.user_id);
                const enhancement = await readEnhancementProcessingTask(candidate.id, executor);
                if (enhancement) {
                    const leased = await enhancementProcessingRequest(() => claimEnhancementProcessingTask(enhancement, { ...input, availableMemoryBytes: remainingMemoryBytes, slots: 1 }, executor));
                    if (leased) {
                        claimed.push(leased);
                        remainingMemoryBytes -= leased.payload.resource.requiredMemoryBytes!;
                    }
                    continue;
                }
                const locked = await executor.query("SELECT id FROM generation_tasks WHERE id=$1 AND task_type='image_processing' FOR UPDATE SKIP LOCKED", [candidate.id]);
                if (!locked.rows[0]) continue;
                const executionId = randomUUID();
                const result = await executor.query<{ payload: ClaimableImageProcessingPayload; lease_until: Date }>(
                    `UPDATE generation_tasks AS task
                     SET status = 'running', execution_phase = 'created',
                         payload = jsonb_set(task.payload, '{executionId}', to_jsonb($4::text)), worker_id = $3,
                         lease_until = statement_timestamp() + interval '90 seconds', last_heartbeat_at = statement_timestamp(), updated_at = statement_timestamp()
                     WHERE task.id = $5 AND ${claimableImageProcessingSql}
                     RETURNING task.payload, task.lease_until`,
                    [input.profileVersion, remainingMemoryBytes, input.workerId, executionId, candidate.id],
                );
                const leased = result.rows[0];
                // TTL can expire between selecting the locked row and writing its lease.
                if (!leased) continue;
                claimed.push(claimedImageProcessingTask(candidate.id, executionId, leased.payload, leased.lease_until.getTime()));
                remainingMemoryBytes -= leased.payload.resource.requiredMemoryBytes;
            }
            return { tasks: claimed };
        });
    }
    while (claimed.length < input.slots) {
        const candidate = await withGenerationTaskFileRead(async (records) => {
            const lastServedByUser = new Map<string, number>();
            for (const task of records) if (task.type === "image_processing" && task.payload.executionId != null) lastServedByUser.set(task.userId, Math.max(lastServedByUser.get(task.userId) ?? task.updatedAt, task.updatedAt));
            return records
                .filter((task) => !visitedIds.includes(task.id) && isClaimableImageProcessingTask(task, input.profileVersion, remainingMemoryBytes, Date.now()))
                .sort(
                    (a, b) =>
                        selectedUsers.filter((userId) => userId === a.userId).length - selectedUsers.filter((userId) => userId === b.userId).length ||
                        (lastServedByUser.get(a.userId) ?? 0) - (lastServedByUser.get(b.userId) ?? 0) ||
                        Number(a.nextPollAt) - Number(b.nextPollAt) ||
                        a.id.localeCompare(b.id),
                )[0];
        });
        if (!candidate) break;
        visitedIds.push(candidate.id);
        selectedUsers.push(candidate.userId);
        const enhancement = await readEnhancementProcessingTask(candidate.id);
        let leased: ClaimedImageProcessingTask | null;
        if (enhancement) leased = await enhancementProcessingRequest(() => claimEnhancementProcessingTask(enhancement, { ...input, availableMemoryBytes: remainingMemoryBytes, slots: 1 }));
        else
            leased = await withGenerationTaskFileMutation(async (records) => {
                const current = records.find((task) => task.id === candidate.id);
                const now = Date.now();
                if (!current || !isClaimableImageProcessingTask(current, input.profileVersion, remainingMemoryBytes, now)) return { tasks: records, result: null };
                const executionId = randomUUID();
                const payload = { ...(current.payload as AgentImageProcessingPayload), executionId };
                const leaseUntil = now + 90_000;
                const next = { ...current, status: "running" as const, executionPhase: "created" as const, payload, workerId: input.workerId, leaseUntil, lastHeartbeatAt: now, updatedAt: now };
                return { tasks: records.map((record) => (record === current ? next : record)), result: claimedImageProcessingTask(current.id, executionId, payload, leaseUntil) };
            });
        if (!leased) continue;
        claimed.push(leased);
        remainingMemoryBytes -= leased.payload.resource.requiredMemoryBytes!;
    }
    return { tasks: claimed };
}

export async function heartbeatImageProcessingTask(id: string, identity: { workerId: string; executionId: string }): Promise<{ leaseUntil: number; cancelRequested: boolean }> {
    const enhancement = await readEnhancementProcessingTask(id);
    if (enhancement) return enhancementProcessingRequest(() => heartbeatEnhancementProcessing(enhancement, identity));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (executor) => {
            const locked = await executor.query<{ id: string }>("SELECT id FROM generation_tasks WHERE id = $1 AND task_type = 'image_processing' FOR UPDATE", [id]);
            if (!locked.rows[0]) throw new ImageProcessingInputError("图像阶段不存在", 404);
            const result = await executor.query<{ lease_until: Date; cancel_requested: boolean }>(
                `UPDATE generation_tasks
                 SET lease_until = statement_timestamp() + interval '90 seconds', last_heartbeat_at = statement_timestamp()
                 WHERE id = $1 AND task_type = 'image_processing' AND worker_id = $2 AND payload ->> 'executionId' = $3
                   AND lease_until > statement_timestamp() AND expires_at > statement_timestamp()
                   AND (status = 'running' OR (status = 'cancelled' AND execution_phase = 'cancel_requested'))
                 RETURNING lease_until, status = 'cancelled' AS cancel_requested`,
                [id, identity.workerId, identity.executionId],
            );
            const renewed = result.rows[0];
            if (!renewed) throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
            return { leaseUntil: renewed.lease_until.getTime(), cancelRequested: renewed.cancel_requested };
        });
    }
    return withGenerationTaskFileMutation(async (records) => {
        const task = records.find((record) => record.id === id && record.type === "image_processing");
        if (!task) throw new ImageProcessingInputError("图像阶段不存在", 404);
        const now = Date.now();
        const cancelRequested = task.status === "cancelled" && task.executionPhase === "cancel_requested";
        if (task.workerId !== identity.workerId || task.payload.executionId !== identity.executionId || !(Number(task.leaseUntil) > now) || task.expiresAt <= now || (task.status !== "running" && !cancelRequested))
            throw new ImageProcessingInputError("图像阶段执行身份或租约已失效", 409);
        const leaseUntil = now + 90_000;
        return { tasks: records.map((record) => (record === task ? { ...record, leaseUntil, lastHeartbeatAt: now } : record)), result: { leaseUntil, cancelRequested } };
    });
}

function isClaimableImageProcessingTask(task: StoredGenerationTaskRecord, profileVersion: string, availableMemoryBytes: number, now: number) {
    if (task.type !== "image_processing" || (task.status !== "pending" && task.status !== "running") || task.expiresAt <= now || !(Number(task.nextPollAt) <= now) || (task.leaseUntil !== undefined && task.leaseUntil > now)) return false;
    const payload = task.payload as ImageProcessingPayload;
    if (payload.operation === "process_enhancement" && (task.status !== "pending" || payload.executionId !== undefined)) return false;
    const requiredMemoryBytes = payload.resource.requiredMemoryBytes;
    return (
        payload.version === "image-processing.v1" &&
        payload.resource.profileVersion === profileVersion &&
        !payload.resource.unavailable &&
        typeof requiredMemoryBytes === "number" &&
        Number.isSafeInteger(requiredMemoryBytes) &&
        requiredMemoryBytes > 0 &&
        requiredMemoryBytes <= availableMemoryBytes
    );
}

function claimedImageProcessingTask(id: string, executionId: string, payload: ImageProcessingPayload, leaseUntil: number): ClaimedImageProcessingTask {
    return { id, executionId, leaseUntil, payload, inputUrls: payload.inputs.map((input) => `/api/maintenance/image-processing/${encodeURIComponent(id)}/inputs/${encodeURIComponent(input.assetId)}`) };
}

async function enhancementProcessingRequest<T>(request: () => Promise<T>): Promise<T> {
    try {
        return await request();
    } catch (error) {
        if (error instanceof EnhancementProcessingConflict) throw new ImageProcessingInputError(error.message, error.status, { cause: error });
        throw error;
    }
}
export async function resumeUnstartedEnhancementPublication(parent: ImageEnhancementJob) {
    return enhancementProcessingRequest(() => resumeUnstartedEnhancement(parent));
}
export async function retryEnhancementPublication(parent: ImageEnhancementJob) {
    return enhancementProcessingRequest(() => retryEnhancement(parent));
}
export async function cancelEnhancementPublication(parent: ImageEnhancementJob) {
    return enhancementProcessingRequest(() => cancelEnhancement(parent));
}

export class ImageProcessingInputError extends Error {
    constructor(
        message: string,
        readonly status: number,
        options?: ErrorOptions,
    ) {
        super(message, options);
    }
}

export async function enqueueImageProcessingTask(input: EnqueueImageProcessingInput): Promise<ImageProcessingTask> {
    if (input.operation === "process_result") throw new Error("Not implemented: result processing enqueue");
    if (input.operation === "prepare_review") throw new ImageProcessingInputError("视觉复核必须通过已完成Run的批量准备提交", 409);
    if (input.inputs.length !== 1) throw new ImageProcessingInputError("参考预处理每阶段必须绑定一张原件", 400);
    const run = await getStoredGenerationTask<AgentRun>("agent", input.runId);
    if (!run) throw new ImageProcessingInputError("父任务不存在", 404);
    let prepared: ImageProcessingEnqueueInputs;
    if (input.operation === "prepare_reference") {
        const replay = await readPrepareReplay(run, input);
        if (replay) return replay;
        assertParentExecution(run, input);
        prepared = input.options.generationInput ? await completedProtectionInputs(run, input, readImageProcessingStage) : await prepareReferenceInputs(run, input);
    } else {
        prepared = await completedProtectionInputs(run, input, readImageProcessingStage);
        const replay = await readFrozenImageProcessingReplay(run, input, prepared);
        if (replay) return replay;
        assertParentExecution(run, input);
    }
    const { inputDigest, inputs, sources, facts } = prepared;
    const { profileVersion, ...configuration } = imageProcessingResourceConfig(process.env);
    const operation: ImageProcessingOperation = input.operation === "prepare_reference" ? { operation: "prepare_reference", options: input.options } : { operation: "build_protection", options: input.options };
    const estimate = estimateImageProcessingMemory({ ...operation, inputs }, facts);
    const admission = decideImageProcessingAdmission(estimate, { totalMemoryBytes: configuration.budgetBytes, availableMemoryBytes: configuration.budgetBytes, availableSlots: configuration.concurrency });
    const payload: AgentImageProcessingPayload = {
        ...operation,
        version: "image-processing.v1",
        inputDigest,
        algorithmVersion: input.algorithmVersion,
        inputs,
        sources,
        resource: {
            profileVersion,
            ...(estimate.status === "calibrated" ? { requiredMemoryBytes: estimate.requiredMemoryBytes } : {}),
            facts,
            configuration,
            ...(admission.status === "unavailable" ? { unavailable: { code: admission.code, reason: admission.reason } } : {}),
        },
    };
    const id = `image-process-${inputDigest}`;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        await withPostgresTransaction(async (executor) => {
            const locked = await executor.query<{ payload: AgentRun; expires_at: Date; server_now: Date }>("SELECT payload, expires_at, now() AS server_now FROM generation_tasks WHERE id = $1 AND task_type = 'agent' AND expires_at > now() FOR UPDATE", [
                input.runId,
            ]);
            const parent = locked.rows[0];
            if (!parent) throw new ImageProcessingInputError("父任务不存在", 404);
            assertParentExecution(parent.payload, input);
            await recheckEnqueueInputs(parent.payload, input, payload, (jobId) => readImageProcessingStage(jobId, executor, true), executor);
            const existing = await executor.query<{ payload: AgentImageProcessingPayload; user_id: string; run_id: string }>("SELECT payload, user_id, run_id FROM generation_tasks WHERE id = $1 AND task_type = 'image_processing' FOR UPDATE", [id]);
            if (existing.rows[0]) {
                const current = existing.rows[0];
                if (current.user_id !== parent.payload.userId || current.run_id !== input.runId) throw new ImageProcessingInputError("图像阶段归属冲突", 409);
                assertSameStage(current.payload, payload);
            } else {
                await executor.query(
                    `INSERT INTO generation_tasks (id, user_id, task_type, status, payload, created_at, updated_at, expires_at, conversation_id, run_id, surface, project_id, parent_task_id, attempt_no, client_request_id, execution_phase, next_poll_at, last_upstream_status)
                     VALUES ($1, $2, 'image_processing', $3, $4::jsonb, $5, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14, $15)`,
                    [
                        id,
                        parent.payload.userId,
                        payload.resource.unavailable ? "paused" : "pending",
                        JSON.stringify(payload),
                        parent.server_now,
                        parent.expires_at,
                        parent.payload.conversationId,
                        parent.payload.id,
                        parent.payload.surface,
                        parent.payload.projectId || null,
                        input.parentTaskId || parent.payload.id,
                        inputDigest,
                        payload.resource.unavailable ? "needs_review" : "created",
                        payload.resource.unavailable ? null : parent.server_now,
                        payload.resource.unavailable?.code || "created",
                    ],
                );
            }
            const next = waitingParent(parent.payload, payload, parent.server_now.getTime(), input.parentTaskId);
            await executor.query(
                "UPDATE generation_tasks SET status = $2, payload = $3::jsonb, updated_at = $4, execution_phase = $5, next_poll_at = NULL, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, last_upstream_status = $6 WHERE id = $1 AND task_type = 'agent'",
                [next.id, payload.resource.unavailable ? "paused" : "running", JSON.stringify(next), parent.server_now, payload.resource.unavailable ? "needs_review" : "created", payload.resource.unavailable?.code || "image_processing_waiting"],
            );
        });
        const saved = await getStoredGenerationTaskRecord("image_processing", id);
        if (!saved) throw new Error("图像阶段提交后无法读取");
        // generation_tasks is the existing JSON persistence boundary for these payloads.
        return { ...saved, type: "image_processing", payload: saved.payload as AgentImageProcessingPayload };
    }
    return queueRuntimeFileOperation(() =>
        withGenerationTaskFileMutation(async (records) => {
            const parent = records.find((record) => record.id === input.runId && record.type === "agent" && record.expiresAt > Date.now());
            if (!parent) throw new ImageProcessingInputError("父任务不存在", 404);
            const current = parent.payload as AgentRun;
            assertParentExecution(current, input);
            await recheckEnqueueInputs(current, input, payload, async (jobId) => {
                const record = records.find((record) => record.id === jobId && record.type === "image_processing");
                return record && imageProcessingStageFromRecord(record);
            });
            const existing = records.find((record) => record.id === id);
            if (existing) {
                if (existing.type !== "image_processing" || existing.userId !== current.userId || existing.runId !== current.id) throw new ImageProcessingInputError("图像阶段归属冲突", 409);
                assertSameStage(existing.payload as AgentImageProcessingPayload, payload);
            }
            const now = Date.now();
            const child: ImageProcessingTask = existing
                ? { ...existing, type: "image_processing", payload: existing.payload as AgentImageProcessingPayload }
                : {
                      id,
                      userId: current.userId,
                      type: "image_processing",
                      status: payload.resource.unavailable ? "paused" : "pending",
                      payload,
                      createdAt: now,
                      updatedAt: now,
                      expiresAt: parent.expiresAt,
                      conversationId: current.conversationId,
                      runId: current.id,
                      surface: current.surface,
                      projectId: current.projectId,
                      parentTaskId: input.parentTaskId || current.id,
                      attemptNo: 0,
                      clientRequestId: inputDigest,
                      executionPhase: payload.resource.unavailable ? "needs_review" : "created",
                      nextPollAt: payload.resource.unavailable ? undefined : now,
                      lastUpstreamStatus: payload.resource.unavailable?.code || "created",
                  };
            const updated: StoredGenerationTaskRecord = {
                ...parent,
                status: payload.resource.unavailable ? "paused" : "running",
                payload: waitingParent(current, payload, now, input.parentTaskId),
                updatedAt: now,
                executionPhase: payload.resource.unavailable ? "needs_review" : "created",
                nextPollAt: undefined,
                workerId: undefined,
                leaseUntil: undefined,
                lastHeartbeatAt: undefined,
                lastUpstreamStatus: payload.resource.unavailable?.code || "image_processing_waiting",
            };
            return { tasks: [...records.filter((record) => record.id !== parent.id && record.id !== id), updated, child], result: child };
        }),
    );
}

type ImageProcessingFrozenInput = StoredImageProcessingOperation & Pick<EnqueueImageProcessingInput, "runId" | "parentTaskId" | "algorithmVersion" | "inputs">;

type ImageProcessingEnqueueInputs = { inputDigest: string; inputs: AgentImageProcessingPayload["inputs"]; sources: ImageProcessingMediaReference[]; facts: ImageProcessingResourceFacts };

async function prepareReferenceInputs(run: AgentRun, input: EnqueueImageProcessingInput): Promise<ImageProcessingEnqueueInputs> {
    const frozen = frozenPrepareReference(run, input.inputs[0]);
    const registration = await getLocalMediaRegistration(frozen.storageKey);
    assertRegistration(registration, frozen, run.userId);
    const inputDigest = prepareInputDigest(run, input, frozen.input.expectedSha256);
    const encodedInput = await collectReference(registration, frozen.input);
    return {
        inputDigest,
        inputs: [{ ...frozen.input, expectedSha256: encodedInput.sha256 }],
        sources: [
            {
                inputIndex: 0,
                scope: registration.scope,
                storageKey: registration.storageKey,
                storageProvider: registration.storageProvider === "object" ? "object" : "local",
                ...(registration.externalStorageId ? { externalStorageId: registration.externalStorageId } : {}),
            },
        ],
        facts: { encodedInputs: [encodedInput], decodedInputs: [] },
    };
}

// Reads the same real prepare/build evidence as enqueue without releasing or
// scheduling the parent while an already-linked ImageTask is being submitted.
type SceneProtectionReadContext = { records: StoredGenerationTaskRecord[]; registrations: LocalMediaRegistration[]; now: number; completedResult?: true };

// This checks the receipt's frozen parent binding. Actual child completion is checked
// under the confirmation lock and again by native enqueue/consumption.
export function ecommerceSceneSelectionReceiptState(run: AgentRun) {
    const snapshot = run.ecommerceSnapshot;
    const receipt = snapshot?.processing?.sceneSelection;
    const checkpoint = snapshot?.referenceCheckpoint;
    const plan = snapshot?.plan;
    const task = run.tasks[0];
    const reference = checkpoint?.assets.find((item) => item.asset.id === receipt?.baseline.assetId);
    const prepared = receipt ? snapshot?.processing?.prepareReferences.find((item) => item.jobId === receipt.prepare.jobId && item.inputDigest === receipt.prepare.inputDigest) : undefined;
    const manifest = prepared?.manifest;
    const source = manifest?.sourceIdentities[0];
    if (
        !snapshot ||
        !checkpoint ||
        snapshot.mode !== "active" ||
        !receipt ||
        receipt.version !== "scene-selection-receipt.v1" ||
        !plan ||
        !["ecommerce-edit.v3", "ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"].includes(plan.planVersion) ||
        plan.operation !== "scene_edit" ||
        plan.strategy !== "integrated_scene" ||
        plan.source.productAnchorId ||
        plan.protection?.scope !== "local" ||
        run.tasks.length !== 1 ||
        !task ||
        task.id !== receipt.parentTaskId ||
        task.ecommerceExecution?.state !== "ready" ||
        plan.source.currentSceneBaselineId !== receipt.baseline.assetId ||
        !reference?.asset.serverUrl ||
        reference.asset.userId !== run.userId ||
        reference.asset.conversationId !== run.conversationId ||
        reference.asset.type !== "image" ||
        reference.asset.status !== "ready" ||
        reference.assetVersion !== receipt.baseline.assetVersion ||
        reference.assetVersion !== referenceAssetVersion(reference.asset, receipt.baseline.sha256) ||
        reference.contentSha256 !== receipt.baseline.sha256 ||
        reference.asset.width !== receipt.baseline.width ||
        reference.asset.height !== receipt.baseline.height ||
        !prepared ||
        prepared.assetId !== receipt.baseline.assetId ||
        prepared.assetVersion !== receipt.prepare.assetVersion ||
        !manifest ||
        manifest.jobId !== receipt.prepare.jobId ||
        manifest.executionId !== receipt.prepare.executionId ||
        imageProcessingManifestDigest(manifest) !== receipt.prepare.manifestDigest ||
        !source ||
        source.decodeError ||
        source.assetId !== receipt.baseline.assetId ||
        source.assetVersion !== receipt.prepare.assetVersion ||
        source.sha256 !== receipt.baseline.sha256 ||
        source.bytes !== receipt.baseline.bytes ||
        source.width !== receipt.baseline.width ||
        source.height !== receipt.baseline.height ||
        !validPixelRectangle(receipt.region, receipt.baseline) ||
        receipt.region.width * receipt.region.height === receipt.baseline.width * receipt.baseline.height ||
        !isDeepStrictEqual(receipt.semantics, plan.delta.requestedChanges) ||
        plan.canvas?.mode !== "exact" ||
        plan.canvas.size.width !== receipt.baseline.width ||
        plan.canvas.size.height !== receipt.baseline.height
    )
        return;
    return { snapshot, checkpoint, receipt, plan, task, reference, prepared, sourceUrl: reference.asset.serverUrl };
}

export function ecommerceSceneProtectionOptions(state: NonNullable<ReturnType<typeof ecommerceSceneSelectionReceiptState>>): Extract<ImageProcessingProtectionOptions, { mode: "scene_selection" }> {
    const { receipt, task } = state;
    const options: Extract<ImageProcessingProtectionOptions, { mode: "scene_selection" }> = { mode: "scene_selection", region: receipt.region, semantics: receipt.semantics, selectionSource: "user_selection" };
    if (resolveResultSize(task.quality, "1:1") === resolveResultSize("4k", "1:1")) options.freezeEnhancementBaseline = true;
    return options;
}

export function compileConfirmedSceneExecution(state: NonNullable<ReturnType<typeof ecommerceSceneSelectionReceiptState>>) {
    const { snapshot, plan, task } = state;
    const route = snapshot.modelRouteSnapshots?.image_generation;
    const profile = route && resolveEcommerceImageProviderProfile(route);
    if (!profile) throw new ImageProcessingInputError("已保存的场景模型不支持电商编译器", 409);
    const execution = compileEcommerceImageRequest(plan, profile);
    if (execution.state !== "ready" || execution.compilerVersion !== snapshot.compilerVersion || !isDeepStrictEqual(execution, task.ecommerceExecution)) throw new ImageProcessingInputError("已保存的场景计划与执行快照不一致", 409);
    return execution;
}

export async function readCompletedEcommerceSceneProtection(run: AgentRun, completedStage?: ImageProcessingTask, context?: SceneProtectionReadContext) {
    const state = ecommerceSceneSelectionReceiptState(run);
    if (!state || !state.receipt.confirmation.actorUserId.trim() || !(state.receipt.confirmation.confirmedAt > 0)) throw new ImageProcessingInputError("场景保护缺少当前任务的有效确认记录", 409);
    const { receipt, task, reference } = state;
    const execution = compileConfirmedSceneExecution(state);
    const options = ecommerceSceneProtectionOptions(state);
    const stage =
        completedStage ||
        (await readCompletedEcommerceSceneProtectionTask(
            run,
            {
                runId: run.id,
                parentTaskId: task.id,
                operation: "build_protection",
                algorithmVersion: "scene-edit-protection.v1",
                inputs: [{ assetId: reference.asset.id, assetVersion: reference.assetVersion, expectedSha256: receipt.baseline.sha256 }],
                options,
            },
            context,
        ));
    if (!stage) throw new ImageProcessingInputError("场景保护缺少实际完成的蒙版阶段", 409);
    const now = context?.now ?? (getDatabaseProvider() === "postgres" ? (await postgresQuery<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime() : Date.now());
    const protection = state.snapshot.processing?.protection;
    const manifest = protection?.manifest;
    const source = manifest?.sourceIdentities[0];
    const mask = manifest?.artifacts[0];
    const scene = manifest?.geometry.sceneProtection;
    if (
        stage.status !== "success" ||
        stage.executionPhase !== "completed" ||
        stage.payload.version !== "image-processing.v1" ||
        stage.payload.algorithmVersion !== "scene-edit-protection.v1" ||
        !stage.payload.executionId?.trim() ||
        stage.payload.sources.length !== 1 ||
        (!context?.completedResult && stage.expiresAt <= now) ||
        stage.userId !== run.userId ||
        stage.runId !== run.id ||
        stage.parentTaskId !== task.id ||
        stage.payload.operation !== "build_protection" ||
        !isDeepStrictEqual(stage.payload.options, options) ||
        !protection ||
        protection.jobId !== stage.id ||
        protection.inputDigest !== stage.payload.inputDigest ||
        !manifest ||
        manifest.jobId !== stage.id ||
        manifest.executionId !== stage.payload.executionId ||
        stage.resultPayload?.executionId !== stage.payload.executionId ||
        stage.resultPayload?.manifestDigest !== imageProcessingManifestDigest(manifest) ||
        !isDeepStrictEqual(stage.resultPayload?.manifest, manifest) ||
        manifest.sourceIdentities.length !== 1 ||
        !source ||
        source.decodeError ||
        source.assetId !== receipt.baseline.assetId ||
        source.assetVersion !== receipt.baseline.assetVersion ||
        source.sha256 !== receipt.baseline.sha256 ||
        source.bytes !== receipt.baseline.bytes ||
        source.width !== receipt.baseline.width ||
        source.height !== receipt.baseline.height ||
        manifest.artifacts.length !== 1 ||
        !mask ||
        mask.kind !== "mask" ||
        mask.mimeType !== "image/png" ||
        mask.width !== source.width ||
        mask.height !== source.height ||
        !scene ||
        scene.version !== "scene-edit-protection.v1" ||
        scene.sourceAssetId !== source.assetId ||
        scene.sourceDigest !== source.sha256 ||
        !isDeepStrictEqual(scene.sourceSize, { width: source.width, height: source.height }) ||
        !isDeepStrictEqual(scene.maskSize, scene.sourceSize) ||
        scene.maskDigest !== mask.sha256 ||
        !isDeepStrictEqual(scene.targetRegion, receipt.region) ||
        !isDeepStrictEqual(scene.semantics, receipt.semantics) ||
        scene.selectionSource !== "user_selection" ||
        scene.maskSemantics !== "alpha_zero_edit" ||
        scene.method !== "source_pixels_copy" ||
        scene.confirmation !== undefined
    )
        throw new ImageProcessingInputError("场景保护产物与真实完成阶段或确认选区不一致", 409);
    assertProtectionBaseline(manifest.geometry.enhancementBaseline, options, source, mask);
    const frozenSource = stage.payload.sources[0];
    const registrations = context?.registrations || (await getLocalMediaRegistrations([frozenSource.storageKey, mask.storageKey], { ownerUserId: run.userId }));
    const sourceRegistration = registrations.find((item) => item.storageKey === frozenSource.storageKey);
    const registration = registrations.find((item) => item.storageKey === mask.storageKey);
    if (
        !sourceRegistration ||
        sourceRegistration.scope !== frozenSource.scope ||
        sourceRegistration.ownerUserId !== run.userId ||
        sourceRegistration.type !== "image" ||
        sourceRegistration.bytes !== source.bytes ||
        sourceRegistration.mimeType !== source.mimeType ||
        (sourceRegistration.storageProvider === "object" ? "object" : "local") !== frozenSource.storageProvider ||
        sourceRegistration.externalStorageId !== frozenSource.externalStorageId ||
        isLocalMediaRegistrationExpired(sourceRegistration, now)
    )
        throw new ImageProcessingInputError("场景保护原图登记已变化或失效", 409);
    if (
        !registration ||
        registration.ownerUserId !== run.userId ||
        registration.scope !== "reference" ||
        registration.type !== "image" ||
        registration.source !== "image-processing-mask" ||
        registration.taskId !== stage.id ||
        registration.runId !== run.id ||
        registration.mimeType !== mask.mimeType ||
        registration.bytes !== mask.bytes ||
        isLocalMediaRegistrationExpired(registration, now)
    )
        throw new ImageProcessingInputError("场景保护蒙版登记已变化或失效", 409);
    const maskUrl = "/api/reference-assets/" + mask.storageKey.split("/").map(encodeURIComponent).join("/");
    const sceneProtection = {
        ...scene,
        confirmation: { ...receipt.confirmation },
        mask: { id: reference.asset.id + "-scene-selection-mask", name: "scene-selection-mask.png", type: mask.mimeType, dataUrl: "", serverUrl: maskUrl, width: mask.width, height: mask.height },
    };
    return { state, stage, source, mask, sourceRegistration, maskRegistration: registration, sceneProtection, execution, enhancementBaseline: manifest.geometry.enhancementBaseline };
}

export async function readCompletedEcommerceGlobalScene(run: AgentRun, image: ImageTask, context: SceneProtectionReadContext) {
    const snapshot = run.ecommerceSnapshot;
    const plan = snapshot?.plan;
    const checkpoint = snapshot?.referenceCheckpoint;
    const processing = snapshot?.processing;
    const route = snapshot?.modelRouteSnapshots?.image_generation;
    if (
        !isNativeGlobalSceneImageTaskResult(image) ||
        !snapshot ||
        snapshot.mode !== "active" ||
        !plan ||
        plan.operation !== "scene_edit" ||
        plan.strategy !== "integrated_scene" ||
        plan.protection?.scope !== "global" ||
        !plan.source.currentSceneBaselineId ||
        plan.source.productAnchorId ||
        !checkpoint ||
        checkpoint.state !== "resolved" ||
        checkpoint.analysisStage.state !== "completed" ||
        !processing ||
        processing.waitingFor ||
        processing.protection ||
        !route
    )
        throw new ImageProcessingInputError("全局场景结果缺少原计划或已完成参考检查点", 409);
    const profile = resolveEcommerceImageProviderProfile(route);
    if (!profile) throw new ImageProcessingInputError("已保存的场景模型不支持电商编译器", 409);
    const execution = compileEcommerceImageRequest(plan, profile);
    const tasks = run.tasks.filter((task) => task.childTasks?.some((child) => child.id === image.id));
    const task = tasks[0];
    if (
        execution.state !== "ready" ||
        execution.compilerVersion !== snapshot.compilerVersion ||
        !execution.canvas ||
        execution.mask ||
        !isDeepStrictEqual(execution, image.ecommerceExecution) ||
        tasks.length !== 1 ||
        !task ||
        task.type !== "image" ||
        task.childTasks?.filter((child) => child.id === image.id).length !== 1 ||
        !nativeGlobalSceneResultTaskMatches(run, task, image) ||
        task.prompt !== execution.prompt ||
        image.references.length !== execution.referenceRoles.length ||
        execution.referenceRoles[0]?.assetId !== plan.source.currentSceneBaselineId
    )
        throw new ImageProcessingInputError("全局场景结果与原编译计划、copy或参考不符", 409);
    const references = [];
    for (const [index, role] of execution.referenceRoles.entries()) {
        const imageReference = image.references[index];
        const prepares = processing.prepareReferences.filter((item) => item.assetId === role.assetId);
        const reference = prepares[0];
        const record = reference && context.records.find((item) => item.type === "image_processing" && item.id === reference.jobId);
        const prepared = reference && completedEcommerceReferencePrepare(run, reference.jobId, record);
        const sourceUrl = prepared && assetAccessUrl(prepared.current.asset);
        if (
            role.role !== "scene" ||
            prepares.length !== 1 ||
            !prepared ||
            !record ||
            !sourceUrl ||
            record.id !== `image-process-${reference.inputDigest}` ||
            (!context.completedResult && record.expiresAt <= context.now) ||
            imageReference.id !== role.assetId ||
            imageReference.ecommerceRole !== role.role ||
            originalImageSourceUrl(imageTaskResultReferenceUrl(imageReference)) !== originalImageSourceUrl(sourceUrl)
        )
            throw new ImageProcessingInputError("全局场景结果缺少原参考的实际成功prepare", 409);
        const source = prepared.payload.sources[0];
        await recheckFrozenReference(run, { inputs: [{ assetId: role.assetId, assetVersion: prepared.current.assetVersion, expectedSha256: prepared.source.sha256 }] }, source, undefined, context.registrations, context.now);
        const registration = context.registrations.find((item) => item.storageKey === source.storageKey);
        if (!registration || registration.bytes !== prepared.source.bytes || registration.mimeType !== prepared.source.mimeType) throw new ImageProcessingInputError("全局场景原参考登记与完成事实不符", 409);
        references.push({ ...prepared, registration });
    }
    return { execution, task, references, baseline: references[0] };
}

async function readCompletedEcommerceLocalProductProtection(run: AgentRun, context?: SceneProtectionReadContext) {
    const snapshot = run.ecommerceSnapshot;
    const plan = snapshot?.plan;
    const checkpoint = snapshot?.referenceCheckpoint;
    const rawAnalysis = snapshot?.visualAnalysis;
    const route = snapshot?.modelRouteSnapshots?.image_generation;
    const reference = checkpoint?.assets.find((item) => item.asset.id === plan?.source.currentSceneBaselineId);
    if (
        !snapshot ||
        snapshot.mode !== "active" ||
        !plan ||
        plan.operation !== "local_edit" ||
        plan.strategy !== "strict_product" ||
        !plan.source.productAnchorId ||
        plan.source.productAnchorId === plan.source.currentSceneBaselineId ||
        !plan.protection ||
        plan.protection.preserveOutsideMask ||
        !checkpoint ||
        checkpoint.state !== "resolved" ||
        checkpoint.analysisStage.state !== "completed" ||
        !rawAnalysis ||
        !route ||
        !reference?.contentSha256 ||
        reference.asset.width === undefined ||
        reference.asset.height === undefined
    )
        throw new ImageProcessingInputError("局部商品保护缺少原计划、分析或参考身份", 409);
    const analysis = toLegacyEcommerceVisualAnalysis(rawAnalysis, plan.source.currentSceneBaselineId);
    const anchors = analysis.references.filter((item) => item.assetId === plan.source.productAnchorId);
    const scenes = analysis.references.filter((item) => item.assetId === reference.asset.id);
    if (anchors.length !== 1 || anchors[0].role !== "product" || scenes.length !== 1 || scenes[0].role !== "scene") throw new ImageProcessingInputError("局部商品原分析与商品锚或场景角色不符", 409);
    const profile = resolveEcommerceImageProviderProfile(route);
    if (!profile) throw new ImageProcessingInputError("已保存的商品模型不支持电商编译器", 409);
    const execution = compileEcommerceImageRequest(plan, profile);
    if (
        execution.state !== "ready" ||
        execution.compilerVersion !== snapshot.compilerVersion ||
        !isDeepStrictEqual(execution.referenceRoles, [{ assetId: reference.asset.id, role: "scene" }, { assetId: plan.source.productAnchorId, role: "product" }, ...plan.source.sceneReferenceIds.map((assetId) => ({ assetId, role: "scene" }))])
    )
        throw new ImageProcessingInputError("局部商品计划与原编译器或参考不一致", 409);
    const target = resolveLocalEditTarget(plan, analysis);
    if (target.state !== "resolved") throw new ImageProcessingInputError("局部商品计划缺少原分析中的可信编辑目标", 409);
    const regions = buildSceneProductProtectionRegions(analysis, reference.asset.id, plan.source.productAnchorId, { width: reference.asset.width, height: reference.asset.height });
    const options = { mode: "local_edit" as const, targetRegion: target.target.region, protectedRectangles: [...regions.productCore.rectangles, ...regions.fusionHalo.rectangles] };
    const now = context?.now ?? (getDatabaseProvider() === "postgres" ? (await postgresQuery<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime() : Date.now());
    const references = [];
    for (const role of execution.referenceRoles) {
        const prepares = snapshot.processing?.prepareReferences.filter((item) => item.assetId === role.assetId) || [];
        const preparedReference = prepares[0];
        const record = preparedReference && (context ? context.records.find((item) => item.type === "image_processing" && item.id === preparedReference.jobId) : await getStoredGenerationTaskRecord("image_processing", preparedReference.jobId));
        const prepared = preparedReference && completedEcommerceReferencePrepare(run, preparedReference.jobId, record ?? undefined);
        if (prepares.length !== 1 || !prepared || !record || record.id !== `image-process-${preparedReference.inputDigest}` || (!context?.completedResult && record.expiresAt <= now))
            throw new ImageProcessingInputError("局部商品保护缺少原参考的实际成功prepare", 409);
        const source = prepared.payload.sources[0];
        await recheckFrozenReference(run, { inputs: [{ assetId: role.assetId, assetVersion: prepared.current.assetVersion, expectedSha256: prepared.source.sha256 }] }, source, undefined, context?.registrations, now);
        const registration = context ? context.registrations.find((item) => item.storageKey === source.storageKey) : await getLocalMediaRegistration(source.storageKey);
        if (!registration || registration.type !== "image" || registration.bytes !== prepared.source.bytes || registration.mimeType !== prepared.source.mimeType) throw new ImageProcessingInputError("局部商品参考原件登记与prepare事实不符", 409);
        references.push({ source: prepared.source, registration });
    }
    const stage = await readCompletedEcommerceSceneProtectionTask(
        run,
        {
            runId: run.id,
            parentTaskId: "ecommerce-local-edit",
            operation: "build_protection",
            algorithmVersion: STRICT_PRODUCT_COMPILER_VERSION,
            inputs: [{ assetId: reference.asset.id, assetVersion: reference.assetVersion, expectedSha256: reference.contentSha256 }],
            options,
        },
        context,
    );
    const protection = snapshot.processing?.protection;
    const manifest = protection?.manifest;
    const source = manifest?.sourceIdentities[0];
    const mask = manifest?.artifacts[0];
    if (
        !stage ||
        stage.status !== "success" ||
        stage.executionPhase !== "completed" ||
        stage.userId !== run.userId ||
        stage.runId !== run.id ||
        stage.parentTaskId !== "ecommerce-local-edit" ||
        (!context?.completedResult && stage.expiresAt <= now) ||
        stage.payload.operation !== "build_protection" ||
        stage.payload.version !== "image-processing.v1" ||
        stage.payload.algorithmVersion !== STRICT_PRODUCT_COMPILER_VERSION ||
        !stage.payload.executionId?.trim() ||
        stage.payload.sources.length !== 1 ||
        !isDeepStrictEqual(stage.payload.options, options) ||
        !protection ||
        protection.jobId !== stage.id ||
        protection.inputDigest !== stage.payload.inputDigest ||
        !manifest ||
        manifest.jobId !== stage.id ||
        manifest.executionId !== stage.payload.executionId ||
        stage.resultPayload?.executionId !== stage.payload.executionId ||
        stage.resultPayload?.manifestDigest !== imageProcessingManifestDigest(manifest) ||
        !isDeepStrictEqual(stage.resultPayload?.manifest, manifest) ||
        manifest.sourceIdentities.length !== 1 ||
        !source ||
        source.decodeError ||
        source.assetId !== reference.asset.id ||
        source.assetVersion !== reference.assetVersion ||
        source.sha256 !== reference.contentSha256 ||
        !isDeepStrictEqual(manifest.geometry.sourceSize, regions.sourceSize) ||
        source.width !== regions.sourceSize.width ||
        source.height !== regions.sourceSize.height ||
        manifest.artifacts.length !== 1 ||
        !mask ||
        mask.kind !== "mask" ||
        mask.mimeType !== "image/png" ||
        mask.width !== source.width ||
        mask.height !== source.height
    )
        throw new ImageProcessingInputError("局部商品保护产物与原prepare、target build或参考不一致", 409);
    regions.editableBackground.mask = {
        trust: "trusted",
        provider: "local-edit-target.v1",
        reference: {
            id: reference.asset.id + "-local-edit-mask",
            name: "local-edit-mask.png",
            type: mask.mimeType,
            dataUrl: "",
            serverUrl: "/api/reference-assets/" + mask.storageKey.split("/").map(encodeURIComponent).join("/"),
            width: mask.width,
            height: mask.height,
        },
    };
    const frozenSource = stage.payload.sources[0];
    const registrations = context?.registrations || (await getLocalMediaRegistrations([frozenSource.storageKey, mask.storageKey], { ownerUserId: run.userId }));
    const sourceRegistration = registrations.find((item) => item.storageKey === frozenSource.storageKey);
    const maskRegistration = registrations.find((item) => item.storageKey === mask.storageKey);
    if (
        !sourceRegistration ||
        sourceRegistration.ownerUserId !== run.userId ||
        sourceRegistration.scope !== frozenSource.scope ||
        sourceRegistration.type !== "image" ||
        sourceRegistration.bytes !== source.bytes ||
        sourceRegistration.mimeType !== source.mimeType ||
        (sourceRegistration.storageProvider === "object" ? "object" : "local") !== frozenSource.storageProvider ||
        sourceRegistration.externalStorageId !== frozenSource.externalStorageId ||
        isLocalMediaRegistrationExpired(sourceRegistration, now)
    )
        throw new ImageProcessingInputError("局部商品场景原图登记已变化或失效", 409);
    if (
        !maskRegistration ||
        maskRegistration.ownerUserId !== run.userId ||
        maskRegistration.scope !== "reference" ||
        maskRegistration.type !== "image" ||
        maskRegistration.source !== "image-processing-mask" ||
        maskRegistration.taskId !== stage.id ||
        maskRegistration.runId !== run.id ||
        maskRegistration.mimeType !== mask.mimeType ||
        maskRegistration.bytes !== mask.bytes ||
        isLocalMediaRegistrationExpired(maskRegistration, now)
    )
        throw new ImageProcessingInputError("局部商品原蒙版登记已变化或失效", 409);
    return { stage, source, mask, sourceRegistration, maskRegistration, regions, execution, reference, references, manifest };
}

export async function readCompletedEcommerceProductProtection(run: AgentRun, context?: SceneProtectionReadContext) {
    if (run.ecommerceSnapshot?.plan?.operation === "local_edit") return readCompletedEcommerceLocalProductProtection(run, context);
    const snapshot = run.ecommerceSnapshot;
    const plan = snapshot?.plan;
    const checkpoint = snapshot?.referenceCheckpoint;
    const rawAnalysis = snapshot?.visualAnalysis;
    const route = snapshot?.modelRouteSnapshots?.image_generation;
    const reference = checkpoint?.assets.find((item) => item.asset.id === plan?.source.productAnchorId);
    if (
        !snapshot ||
        snapshot.mode !== "active" ||
        !plan ||
        plan.operation !== "product_to_scene" ||
        plan.strategy !== "strict_product" ||
        !checkpoint ||
        checkpoint.state !== "resolved" ||
        checkpoint.analysisStage.state !== "completed" ||
        !rawAnalysis ||
        !route ||
        !reference?.contentSha256 ||
        reference.asset.width === undefined ||
        reference.asset.height === undefined
    )
        throw new ImageProcessingInputError("商品保护缺少原计划、分析或已冻结参考", 409);
    const analysis = toLegacyEcommerceVisualAnalysis(rawAnalysis, plan.source.currentSceneBaselineId);
    const profile = resolveEcommerceImageProviderProfile(route);
    if (!profile) throw new ImageProcessingInputError("已保存的商品模型不支持电商编译器", 409);
    const execution = compileEcommerceImageRequest(plan, profile);
    if (execution.state !== "ready" || execution.compilerVersion !== snapshot.compilerVersion) throw new ImageProcessingInputError("商品计划与原编译器快照不一致", 409);
    const anchors = analysis.references.filter((item) => item.assetId === reference.asset.id);
    const product = anchors.length === 1 && anchors[0].role === "product" ? anchors[0] : undefined;
    const detailAnchorAllowed = product?.confidence === "medium" && product.visualEvidence.isolatedSubject && (product.visualEvidence.whiteBackground || product.visualEvidence.transparentBackground);
    if (!product || (!detailAnchorAllowed && product.confidence !== "high") || !product.visualEvidence.isolatedSubject || (!product.visualEvidence.whiteBackground && !product.visualEvidence.transparentBackground))
        throw new ImageProcessingInputError("商品图不是高置信度白色或透明背景单主体", 409);
    const generationInput = snapshot.processing?.protection?.generationInput;
    if (generationInput) execution.generationInput = generationInput;
    const options = { transparentBackground: product.visualEvidence.transparentBackground, ...(plan.preserve.sourceFraming ? { sourceFraming: plan.preserve.sourceFraming } : {}), ...(generationInput ? { generationInput } : {}) };
    const stage = await readCompletedEcommerceSceneProtectionTask(
        run,
        {
            runId: run.id,
            parentTaskId: "ecommerce-product-scene",
            operation: "build_protection",
            algorithmVersion: STRICT_PRODUCT_COMPILER_VERSION,
            inputs: [{ assetId: reference.asset.id, assetVersion: reference.assetVersion, expectedSha256: reference.contentSha256 }],
            options,
        },
        context,
    );
    const now = context?.now ?? (getDatabaseProvider() === "postgres" ? (await postgresQuery<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime() : Date.now());
    const protection = snapshot.processing?.protection;
    const manifest = protection?.manifest;
    const source = manifest?.sourceIdentities[0];
    const mask = manifest?.artifacts[0];
    const sourceSize = manifest?.geometry.sourceSize;
    const productBounds = manifest?.geometry.productBounds;
    const haloBounds = manifest?.geometry.haloBounds;
    if (
        !stage ||
        stage.status !== "success" ||
        stage.executionPhase !== "completed" ||
        stage.userId !== run.userId ||
        stage.runId !== run.id ||
        stage.parentTaskId !== "ecommerce-product-scene" ||
        (!context?.completedResult && stage.expiresAt <= now) ||
        stage.payload.operation !== "build_protection" ||
        stage.payload.version !== "image-processing.v1" ||
        stage.payload.algorithmVersion !== STRICT_PRODUCT_COMPILER_VERSION ||
        !stage.payload.executionId?.trim() ||
        stage.payload.sources.length !== 1 ||
        !isDeepStrictEqual(stage.payload.options, options) ||
        !protection ||
        protection.jobId !== stage.id ||
        protection.inputDigest !== stage.payload.inputDigest ||
        !manifest ||
        manifest.jobId !== stage.id ||
        manifest.executionId !== stage.payload.executionId ||
        stage.resultPayload?.executionId !== stage.payload.executionId ||
        stage.resultPayload?.manifestDigest !== imageProcessingManifestDigest(manifest) ||
        !isDeepStrictEqual(stage.resultPayload?.manifest, manifest) ||
        manifest.sourceIdentities.length !== 1 ||
        !source ||
        source.decodeError ||
        source.assetId !== reference.asset.id ||
        source.assetVersion !== reference.assetVersion ||
        source.sha256 !== reference.contentSha256 ||
        !sourceSize ||
        sourceSize.width !== source.width ||
        sourceSize.height !== source.height ||
        manifest.artifacts.length !== (!("mode" in options) && options.generationInput ? 3 : 1) ||
        !mask ||
        mask.kind !== "mask" ||
        mask.mimeType !== "image/png" ||
        mask.width !== source.width ||
        mask.height !== source.height ||
        !productBounds ||
        !haloBounds
    )
        throw new ImageProcessingInputError("商品保护产物与原prepare、build或参考不一致", 409);
    if (generationInput) assertGenerationInputArtifacts(manifest.artifacts, generationInput, source);
    const regions = buildProductProtectionRegions(
        {
            ...analysis,
            references: [
                {
                    ...product,
                    productCore: { x: productBounds.x / source.width, y: productBounds.y / source.height, width: productBounds.width / source.width, height: productBounds.height / source.height },
                    fusionHalo: { x: haloBounds.x / source.width, y: haloBounds.y / source.height, width: haloBounds.width / source.width, height: haloBounds.height / source.height },
                },
            ],
        },
        sourceSize,
    );
    regions.editableBackground.mask = {
        trust: "trusted",
        provider: "white-background-flood-fill.v1",
        reference: {
            id: reference.asset.id + "-background-mask",
            name: "editable-background.png",
            type: mask.mimeType,
            dataUrl: "",
            serverUrl: "/api/reference-assets/" + mask.storageKey.split("/").map(encodeURIComponent).join("/"),
            width: mask.width,
            height: mask.height,
        },
    };
    const frozenSource = stage.payload.sources[0];
    const registrations = context?.registrations || (await getLocalMediaRegistrations([frozenSource.storageKey, mask.storageKey], { ownerUserId: run.userId }));
    const sourceRegistration = registrations.find((item) => item.storageKey === frozenSource.storageKey);
    const maskRegistration = registrations.find((item) => item.storageKey === mask.storageKey);
    if (
        !sourceRegistration ||
        sourceRegistration.ownerUserId !== run.userId ||
        sourceRegistration.scope !== frozenSource.scope ||
        sourceRegistration.type !== "image" ||
        sourceRegistration.bytes !== source.bytes ||
        sourceRegistration.mimeType !== source.mimeType ||
        (sourceRegistration.storageProvider === "object" ? "object" : "local") !== frozenSource.storageProvider ||
        sourceRegistration.externalStorageId !== frozenSource.externalStorageId ||
        isLocalMediaRegistrationExpired(sourceRegistration, now)
    )
        throw new ImageProcessingInputError("商品保护原图登记已变化或失效", 409);
    if (
        !maskRegistration ||
        maskRegistration.ownerUserId !== run.userId ||
        maskRegistration.scope !== "reference" ||
        maskRegistration.type !== "image" ||
        maskRegistration.source !== "image-processing-mask" ||
        maskRegistration.taskId !== stage.id ||
        maskRegistration.runId !== run.id ||
        maskRegistration.mimeType !== mask.mimeType ||
        maskRegistration.bytes !== mask.bytes ||
        isLocalMediaRegistrationExpired(maskRegistration, now)
    )
        throw new ImageProcessingInputError("商品保护原蒙版登记已变化或失效", 409);
    return { stage, source, mask, sourceRegistration, maskRegistration, regions, execution, reference, references: [{ source, registration: sourceRegistration }], manifest };
}

function generationReferencePlanDigest(run: AgentRun) {
    const snapshot = run.ecommerceSnapshot;
    return createHash("sha256")
        .update(
            JSON.stringify(
                canonicalImageTaskResultValue([
                    snapshot?.plan,
                    snapshot?.compilerVersion,
                    snapshot?.modelRouteSnapshots?.image_generation,
                    snapshot?.referenceCheckpoint?.inputId,
                    snapshot?.referenceCheckpoint?.decisionId,
                    snapshot?.referenceCheckpoint?.analysisStage.requestId,
                ]),
            ),
        )
        .digest("hex");
}

function assertGenerationReferenceRequest(run: AgentRun, input: Extract<ImageProcessingFrozenInput, { operation: "prepare_reference" }>) {
    const snapshot = run.ecommerceSnapshot;
    const plan = snapshot?.plan;
    const checkpoint = snapshot?.referenceCheckpoint;
    const route = snapshot?.modelRouteSnapshots?.image_generation;
    const profile = route && resolveEcommerceImageProviderProfile(route);
    const generation = input.options.generationInput;
    const execution = plan && profile && compileEcommerceImageRequest(plan, profile);
    const expectedParent = plan?.operation === "local_edit" ? "ecommerce-local-edit" : "ecommerce-product-scene";
    const previous = snapshot?.processing?.generationReferences?.find((item) => item.parentTaskId === input.parentTaskId && item.assetId === input.inputs[0].assetId);
    if (
        !snapshot ||
        snapshot.mode !== "active" ||
        !plan ||
        !["local_edit", "product_to_scene"].includes(plan.operation) ||
        !checkpoint ||
        checkpoint.state !== "resolved" ||
        checkpoint.analysisStage.state !== "completed" ||
        !execution ||
        execution.state !== "ready" ||
        execution.compilerVersion !== snapshot.compilerVersion ||
        route?.imageEdit?.protocol !== "sub2api" ||
        !generation ||
        input.parentTaskId !== expectedParent ||
        !execution.referenceRoles.slice(1).some((role) => role.assetId === input.inputs[0].assetId) ||
        run.cancellation ||
        !["running", "paused"].includes(run.status) ||
        run.tasks.some((task) => task.attempts || task.taskId || task.taskIds?.length || task.childTasks?.length)
    )
        throw new ImageProcessingInputError("生成参考缺少原计划、已分析引用或提交前的父任务身份", 409);
    const requestSize = parseImageDimensions(resolveEcommerceCanvasRequestSize(execution.canvas, normalizeQuality(generation.quality), `${generation.bounds.width}x${generation.bounds.height}`) || "");
    if (!isDeepStrictEqual(requestSize, generation.bounds) || (previous && (!isDeepStrictEqual(previous.generationInput, generation) || previous.planDigest !== generationReferencePlanDigest(run))))
        throw new ImageProcessingInputError("生成参考与冻结画布、画质或计划不一致", 409);
}

function assertGenerationReferenceArtifact(reference: StoredImageProcessingArtifact, input: ImageProcessingGenerationInput, source: { width: number; height: number }) {
    const scale = Math.min(1, input.bounds.width / source.width, input.bounds.height / source.height);
    if (reference.kind !== "generation_reference" || !["image/jpeg", "image/png"].includes(reference.mimeType) || reference.width !== Math.round(source.width * scale) || reference.height !== Math.round(source.height * scale))
        throw new ImageProcessingInputError("生成参考副本与冻结原件或画布不一致", 409);
}

export async function prepareEcommerceGenerationReferences(run: AgentRun, executionId: string, execution: ReturnType<typeof compileEcommerceImageRequest>, defaults: { imageQuality: string; imageSize: string }) {
    const snapshot = run.ecommerceSnapshot!;
    if (execution.modelSnapshot.imageEdit?.protocol !== "sub2api") return true;
    const previous = snapshot.processing?.generationReferences?.[0]?.generationInput || execution.generationInput;
    const quality = previous?.quality || (run.generationPreferences?.image?.quality || defaults.imageQuality).trim();
    const bounds = previous?.bounds || parseImageDimensions(resolveEcommerceCanvasRequestSize(execution.canvas, normalizeQuality(quality), defaults.imageSize) || "");
    if (!bounds) return true;
    const parentTaskId = snapshot.plan?.operation === "local_edit" ? "ecommerce-local-edit" : "ecommerce-product-scene";
    for (const role of execution.referenceRoles.slice(1)) {
        const reference = snapshot.referenceCheckpoint!.assets.find((item) => item.asset.id === role.assetId)!;
        if (reference.asset.width! <= bounds.width && reference.asset.height! <= bounds.height) continue;
        const stage = await enqueueImageProcessingTask({
            runId: run.id,
            parentExecutionId: executionId,
            parentTaskId,
            operation: "prepare_reference",
            algorithmVersion: "generation-reference.v1",
            inputs: [{ assetId: reference.asset.id, assetVersion: reference.assetVersion, expectedSha256: reference.contentSha256 }],
            options: { generationInput: { bounds, quality } },
        });
        if (stage.status !== "success") return false;
    }
    return true;
}

function assertGenerationInputArtifacts(artifacts: StoredImageProcessingArtifact[], input: ImageProcessingGenerationInput, source: { width: number; height: number }) {
    const [mask, reference, generationMask] = artifacts;
    const scale = Math.min(1, input.bounds.width / source.width, input.bounds.height / source.height);
    if (
        artifacts.length !== 3 ||
        mask.kind !== "mask" ||
        reference.kind !== "generation_reference" ||
        generationMask.kind !== "generation_mask" ||
        !["image/jpeg", "image/png"].includes(reference.mimeType) ||
        generationMask.mimeType !== "image/png" ||
        reference.width !== Math.round(source.width * scale) ||
        reference.height !== Math.round(source.height * scale) ||
        generationMask.width !== reference.width ||
        generationMask.height !== reference.height
    )
        throw new ImageProcessingInputError("生成输入副本与冻结原件、蒙版或画布不一致", 409);
    return { reference, mask: generationMask };
}

export async function readEcommerceGenerationInput(image: ImageTask, quality: string | undefined, requestSize: string | undefined) {
    const primaryInput = image.ecommerceExecution?.generationInput;
    if (!image.ecommerceExecution || !image.runId) throw new ImageProcessingInputError("生成输入副本缺少冻结执行身份", 409);
    const run = await getStoredGenerationTask<AgentRun>("agent", image.runId);
    const original = await getStoredGenerationTask<ImageTask>("image", image.id);
    if (!run || run.userId !== image.userId || run.status !== "running" || run.cancellation || !original || image.references.length !== original.references.length) throw new ImageProcessingInputError("生成输入副本与当前图片任务或父任务不一致", 409);
    // The runtime verifies source hashes before replacing only these transport fields.
    const sourceImage = {
        ...image,
        references: image.references.map((reference, index) => ({
            ...reference,
            dataUrl: original.references[index].dataUrl,
            url: original.references[index].url,
            serverUrl: original.references[index].serverUrl,
            remoteUrl: original.references[index].remoteUrl,
        })),
    };
    if (imageTaskResultSourceIdentityDigest(original) !== imageTaskResultSourceIdentityDigest(sourceImage)) throw new ImageProcessingInputError("生成输入副本与当前图片任务或父任务不一致", 409);
    const completed = await readCompletedEcommerceProductProtection(run);
    const frozen = primaryInput || run.ecommerceSnapshot?.processing?.generationReferences?.[0]?.generationInput;
    const bounds = parseImageDimensions(requestSize || "");
    const task = run.tasks.find((item) => item.id === completed.stage.parentTaskId);
    assertGenerationImageExecution(image, original, run, completed.stage.parentTaskId);
    if (
        !task ||
        !isDeepStrictEqual(task.ecommerceExecution, image.ecommerceExecution) ||
        !isDeepStrictEqual(completed.execution, image.ecommerceExecution) ||
        !isDeepStrictEqual(task.productProtectionRegions, completed.regions) ||
        !isDeepStrictEqual(image.mask, completed.regions.editableBackground.mask?.reference) ||
        !bounds ||
        (frozen && (quality !== normalizeQuality(frozen.quality) || !isDeepStrictEqual(bounds, frozen.bounds))) ||
        image.references.length !== completed.execution.referenceRoles.length ||
        !image.references.every((reference, index) => {
            const role = completed.execution.referenceRoles[index];
            const originalReference = run.ecommerceSnapshot?.referenceCheckpoint?.assets.find((item) => item.asset.id === role.assetId);
            return (
                originalReference &&
                reference.id === role.assetId &&
                reference.ecommerceRole === role.role &&
                originalImageSourceUrl(imageTaskResultReferenceUrl(original.references[index])) === originalImageSourceUrl(assetAccessUrl(originalReference.asset) || "")
            );
        })
    )
        throw new ImageProcessingInputError("生成输入副本与原计划、参考或实际请求不一致", 409);
    const reference = (original: ImageTask["references"][number], artifact: StoredImageProcessingArtifact) => ({
        ...original,
        dataUrl: "",
        url: undefined,
        remoteUrl: undefined,
        serverUrl: "/api/reference-assets/" + artifact.storageKey.split("/").map(encodeURIComponent).join("/"),
        width: artifact.width,
        height: artifact.height,
        type: artifact.mimeType,
    });
    const registeredArtifact = async (artifact: StoredImageProcessingArtifact, jobId: string) => {
        const registration = await getLocalMediaRegistration(artifact.storageKey);
        if (
            !registration ||
            registration.ownerUserId !== image.userId ||
            registration.type !== "image" ||
            registration.scope !== "reference" ||
            registration.source !== (artifact.kind === "generation_reference" ? "image-processing-generation-reference" : "image-processing-mask") ||
            registration.runId !== run.id ||
            registration.taskId !== jobId ||
            isLocalMediaRegistrationExpired(registration, Date.now())
        )
            throw new ImageProcessingInputError("生成输入副本登记已失效或归属不符", 409);
        await readImageProcessingMediaFacts(registration, artifact);
    };
    const references = [...image.references];
    const referenceBytes: Array<number | undefined> = references.map(() => undefined);
    let maskBytes: number | undefined;
    let mask = image.mask;
    if (primaryInput) {
        const pair = assertGenerationInputArtifacts(completed.manifest.artifacts, primaryInput, completed.source);
        await registeredArtifact(pair.reference, completed.stage.id);
        await registeredArtifact(pair.mask, completed.stage.id);
        references[0] = reference(image.references[0], pair.reference);
        referenceBytes[0] = pair.reference.bytes;
        maskBytes = pair.mask.bytes;
        mask = reference(image.mask!, pair.mask);
    }
    for (const [index, role] of completed.execution.referenceRoles.entries()) {
        const asset = run.ecommerceSnapshot!.referenceCheckpoint!.assets.find((item) => item.asset.id === role.assetId)!;
        if (asset.asset.width! <= bounds.width && asset.asset.height! <= bounds.height) continue;
        if (index === 0) {
            if (!primaryInput) throw new ImageProcessingInputError("主参考超出请求画布且缺少配套生成蒙版", 409);
            continue;
        }
        const generation = { bounds, quality: frozen?.quality || quality || "auto" };
        const input: Extract<ImageProcessingFrozenInput, { operation: "prepare_reference" }> = {
            runId: run.id,
            parentTaskId: completed.stage.parentTaskId,
            operation: "prepare_reference",
            algorithmVersion: "generation-reference.v1",
            inputs: [{ assetId: asset.asset.id, assetVersion: asset.assetVersion, expectedSha256: asset.contentSha256 }],
            options: { generationInput: generation },
        };
        const prepared = await completedProtectionInputs(run, input, readImageProcessingStage);
        const mapping = run.ecommerceSnapshot?.processing?.generationReferences?.find(
            (item) =>
                item.parentTaskId === input.parentTaskId &&
                item.assetId === role.assetId &&
                item.assetVersion === asset.assetVersion &&
                item.inputDigest === prepared.inputDigest &&
                item.jobId === `image-process-${prepared.inputDigest}` &&
                item.planDigest === generationReferencePlanDigest(run) &&
                isDeepStrictEqual(item.generationInput, generation),
        );
        const saved = mapping && (await readImageProcessingStage(mapping.jobId));
        const manifest = saved?.resultPayload?.manifest;
        const source = manifest?.sourceIdentities[0];
        if (
            !mapping?.manifest ||
            !saved ||
            saved.status !== "success" ||
            saved.executionPhase !== "completed" ||
            saved.userId !== run.userId ||
            saved.runId !== run.id ||
            saved.parentTaskId !== input.parentTaskId ||
            saved.expiresAt <= saved.now ||
            saved.payload.operation !== "prepare_reference" ||
            !isDeepStrictEqual(saved.payload.options, input.options) ||
            !manifest ||
            !source ||
            source.decodeError ||
            manifest.jobId !== saved.id ||
            manifest.executionId !== saved.payload.executionId ||
            saved.resultPayload?.executionId !== saved.payload.executionId ||
            saved.resultPayload.manifestDigest !== imageProcessingManifestDigest(manifest) ||
            imageProcessingManifestDigest(manifest) !== imageProcessingManifestDigest(mapping.manifest) ||
            manifest.sourceIdentities.length !== 1 ||
            manifest.artifacts.length !== 1 ||
            source.assetId !== asset.asset.id ||
            source.assetVersion !== asset.assetVersion ||
            source.sha256 !== asset.contentSha256 ||
            source.bytes !== prepared.facts.encodedInputs[0].bytes ||
            source.width !== asset.asset.width ||
            source.height !== asset.asset.height ||
            enqueueInputsIdentity(prepared) !== enqueueInputsIdentity({ sources: saved.payload.sources, facts: saved.payload.resource.facts })
        )
            throw new ImageProcessingInputError("生成参考缺少与原任务匹配的完成工件", 409);
        assertSameStage(saved.payload, { ...saved.payload, ...input, inputDigest: prepared.inputDigest, inputs: prepared.inputs });
        const artifact = manifest.artifacts[0];
        assertGenerationReferenceArtifact(artifact, generation, source);
        const originalRegistration = await getLocalMediaRegistration(prepared.sources[0].storageKey);
        assertRegistration(originalRegistration, prepared.sources[0], run.userId);
        await readImageProcessingMediaFacts(originalRegistration, source);
        await registeredArtifact(artifact, saved.id);
        references[index] = reference(image.references[index], artifact);
        referenceBytes[index] = artifact.bytes;
    }
    const currentRun = await getStoredGenerationTask<AgentRun>("agent", run.id);
    const currentImage = await getStoredGenerationTask<ImageTask>("image", image.id);
    if (!currentRun || generationReferencePlanDigest(currentRun) !== generationReferencePlanDigest(run) || !currentImage || imageTaskResultSourceIdentityDigest(currentImage) !== imageTaskResultSourceIdentityDigest(original))
        throw new ImageProcessingInputError("生成输入读取期间原任务或计划已变化", 409);
    assertGenerationImageExecution(image, currentImage, currentRun, completed.stage.parentTaskId);
    return { references, mask, referenceBytes, maskBytes };
}

function assertGenerationImageExecution(image: ImageTask, current: ImageTask, run: AgentRun, logicalParentId: string | undefined) {
    const task = run.tasks.find((item) => item.id === logicalParentId);
    const checkpoint = run.ecommerceSnapshot?.referenceCheckpoint;
    const fence = image.referenceDispatch;
    if (
        current.id !== image.id ||
        current.userId !== image.userId ||
        current.runId !== run.id ||
        current.conversationId !== run.conversationId ||
        current.status !== image.status ||
        !["pending", "running"].includes(current.status) ||
        current.executionId !== image.executionId ||
        current.attemptNo !== image.attemptNo ||
        current.clientRequestId !== image.clientRequestId ||
        !isDeepStrictEqual(current.referenceDispatch, fence) ||
        run.cancellation ||
        run.status !== "running" ||
        !task ||
        task.status !== "running" ||
        !isDeepStrictEqual(task.ecommerceExecution, image.ecommerceExecution) ||
        !fence ||
        fence.copy < 1 ||
        fence.copy > task.count ||
        fence.inputId !== checkpoint?.inputId ||
        fence.decisionId !== checkpoint.decisionId ||
        fence.analysisRequestId !== checkpoint.analysisStage.requestId ||
        image.clientRequestId !== `${run.clientRequestId}:${task.id}:${task.attempts}:${fence.copy}`
    )
        throw new ImageProcessingInputError("生成输入副本的当前图片执行身份已失效", 409);
}

export async function readCompletedEcommerceSceneProtectionTask(run: AgentRun, input: Extract<ImageProcessingFrozenInput, { operation: "build_protection" }>, context?: SceneProtectionReadContext): Promise<ImageProcessingTask | undefined> {
    const lookup = context
        ? async (id: string) => {
              const record = context.records.find((item) => item.type === "image_processing" && item.id === id);
              return record && { ...imageProcessingStageFromRecord(record), now: context.now };
          }
        : readImageProcessingStage;
    const prepared = await completedProtectionInputs(run, input, lookup, undefined, context?.registrations, context?.now, context?.completedResult);
    return readFrozenImageProcessingReplay(run, input, prepared, context?.records);
}

async function completedProtectionInputs(
    run: AgentRun,
    input: Extract<ImageProcessingFrozenInput, { operation: "build_protection" | "prepare_reference" }>,
    lookup: (jobId: string) => Promise<ImageProcessingStageState | undefined>,
    executor?: QueryExecutor,
    registrations?: LocalMediaRegistration[],
    now?: number,
    completedResult = false,
): Promise<ImageProcessingEnqueueInputs> {
    const requested = input.inputs[0];
    const current = run.ecommerceSnapshot?.referenceCheckpoint?.assets.find((item) => item.asset.id === requested.assetId && item.assetVersion === requested.assetVersion);
    const reference = run.ecommerceSnapshot?.processing?.prepareReferences.find((item) => item.assetId === requested.assetId && item.manifest);
    if (!current?.contentSha256 || !reference?.manifest) throw new ImageProcessingInputError("保护阶段缺少参考原件的完整预处理证据", 409);
    const prepared = await lookup(reference.jobId);
    const payload = prepared?.payload;
    const result = prepared?.resultPayload;
    const manifest = result?.manifest;
    const identity = manifest?.sourceIdentities[0];
    const original = payload?.inputs[0];
    const encoded = payload?.resource.facts.encodedInputs.find((fact) => fact.inputIndex === 0 && fact.assetId === requested.assetId && fact.assetVersion === reference.assetVersion);
    if (
        !prepared ||
        prepared.status !== "success" ||
        (!completedResult && prepared.expiresAt <= prepared.now) ||
        prepared.userId !== run.userId ||
        prepared.runId !== run.id ||
        !payload ||
        payload.operation !== "prepare_reference" ||
        Object.keys(payload.options).length !== 0 ||
        payload.version !== "image-processing.v1" ||
        payload.inputs.length !== 1 ||
        payload.sources.length !== 1 ||
        prepared.id !== `image-process-${reference.inputDigest}` ||
        payload.inputDigest !== reference.inputDigest ||
        !result ||
        !manifest ||
        !identity ||
        identity.decodeError ||
        manifest.jobId !== prepared.id ||
        manifest.executionId !== payload.executionId ||
        result.executionId !== payload.executionId ||
        manifest.sourceIdentities.length !== 1 ||
        manifest.artifacts.length !== 1 ||
        manifest.artifacts[0].kind !== "analysis" ||
        result.manifestDigest !== imageProcessingManifestDigest(manifest) ||
        imageProcessingManifestDigest(manifest) !== imageProcessingManifestDigest(reference.manifest) ||
        !original ||
        !encoded ||
        identity.assetId !== original.assetId ||
        identity.assetVersion !== original.assetVersion ||
        identity.assetVersion !== reference.assetVersion ||
        identity.sha256 !== original.expectedSha256 ||
        identity.sha256 !== encoded.sha256 ||
        identity.bytes !== encoded.bytes ||
        identity.sha256 !== current.contentSha256 ||
        (requested.expectedSha256 !== undefined && requested.expectedSha256 !== identity.sha256) ||
        !prepareSourceMatchesReference(current, identity)
    )
        throw new ImageProcessingInputError("保护阶段参考原件与实际成功的预处理阶段不符", 409);
    const inputs = [{ assetId: requested.assetId, assetVersion: requested.assetVersion, expectedSha256: identity.sha256 }];
    await recheckFrozenReference(run, { ...input, inputs }, payload.sources[0], executor, registrations, now);
    // The old prepare keeps v0. Only this new stage maps its proven bytes and
    // completed decode dimensions onto the parent's current v1 identity.
    return {
        inputDigest: input.operation === "prepare_reference" ? prepareInputDigest(run, input, identity.sha256) : protectionInputDigest(run, input, inputs),
        inputs,
        sources: payload.sources,
        facts: {
            encodedInputs: [{ ...encoded, assetVersion: requested.assetVersion }],
            decodedInputs: [{ inputIndex: 0, assetId: requested.assetId, assetVersion: requested.assetVersion, sha256: identity.sha256, width: identity.width, height: identity.height }],
        },
    };
}

function protectionOptionsIdentity(options: ImageProcessingProtectionOptions) {
    if (!("mode" in options))
        return [
            "white",
            options.transparentBackground,
            Boolean(options.freezeEnhancementBaseline),
            ...(options.sourceFraming ? [options.sourceFraming] : []),
            ...(options.generationInput ? [[options.generationInput.bounds.width, options.generationInput.bounds.height, options.generationInput.quality]] : []),
        ];
    if (options.mode === "scene_selection") return [options.mode, rectangleIdentity(options.region), options.semantics, options.selectionSource, Boolean(options.freezeEnhancementBaseline)];
    const baseline = options.freezeEnhancementBaseline;
    return [options.mode, rectangleIdentity(options.targetRegion), options.protectedRectangles.map(rectangleIdentity), baseline ? [baseline.productAnchorId, baseline.productCore.map(rectangleIdentity)] : null];
}

function rectangleIdentity(rectangle: ImageProcessingRectangle) {
    return [rectangle.x, rectangle.y, rectangle.width, rectangle.height];
}

function protectionInputDigest(run: Pick<AgentRun, "userId" | "id">, input: Extract<ImageProcessingFrozenInput, { operation: "build_protection" }>, inputs: AgentImageProcessingPayload["inputs"]) {
    return createHash("sha256")
        .update(JSON.stringify([run.userId, run.id, input.parentTaskId || "", input.operation, input.algorithmVersion, inputs.map((item) => [item.assetId, item.assetVersion, item.expectedSha256]), protectionOptionsIdentity(input.options)]))
        .digest("hex");
}

function enqueueInputsIdentity(inputs: Pick<ImageProcessingEnqueueInputs, "facts" | "sources">) {
    return JSON.stringify([
        inputs.sources.map((source) => [source.inputIndex, source.scope, source.storageKey, source.storageProvider, source.externalStorageId]),
        inputs.facts.encodedInputs.map((fact) => [fact.inputIndex, fact.assetId, fact.assetVersion, fact.sha256, fact.bytes, fact.layout?.format, fact.layout?.depth, fact.layout?.channels, fact.metadataRejected]),
        inputs.facts.decodedInputs.map((fact) => [fact.inputIndex, fact.assetId, fact.assetVersion, fact.sha256, fact.width, fact.height]),
    ]);
}

async function readFrozenImageProcessingReplay(
    run: AgentRun,
    input: Extract<ImageProcessingFrozenInput, { operation: "build_protection" | "prepare_reference" }>,
    prepared: ImageProcessingEnqueueInputs,
    records?: StoredGenerationTaskRecord[],
): Promise<ImageProcessingTask | undefined> {
    const stored = records ? records.find((item) => item.type === "image_processing" && item.id === `image-process-${prepared.inputDigest}`) : await getStoredGenerationTaskRecord("image_processing", `image-process-${prepared.inputDigest}`);
    if (!stored) return;
    if (stored.userId !== run.userId || stored.runId !== run.id || stored.clientRequestId !== prepared.inputDigest || stored.attemptNo !== 0) throw new ImageProcessingInputError("保护阶段归属或请求身份冲突", 409);
    const payload = stored.payload as AgentImageProcessingPayload;
    assertSameStage(payload, { ...payload, ...input, inputDigest: prepared.inputDigest, inputs: prepared.inputs });
    if (enqueueInputsIdentity({ sources: payload.sources, facts: payload.resource.facts }) !== enqueueInputsIdentity(prepared)) throw new ImageProcessingInputError("保护阶段原件事实冲突", 409);
    return { ...stored, type: "image_processing", payload };
}

async function recheckEnqueueInputs(run: AgentRun, input: EnqueueImageProcessingInput, payload: AgentImageProcessingPayload, lookup: (jobId: string) => Promise<ImageProcessingStageState | undefined>, executor?: QueryExecutor) {
    if (input.operation === "prepare_reference" && input.options.generationInput) assertGenerationReferenceRequest(run, input);
    else if (input.operation !== "build_protection") return recheckFrozenReference(run, input, payload.sources[0], executor);
    const current = await completedProtectionInputs(run, input, lookup, executor);
    if (current.inputDigest !== payload.inputDigest || enqueueInputsIdentity(current) !== enqueueInputsIdentity({ sources: payload.sources, facts: payload.resource.facts })) throw new ImageProcessingInputError("保护阶段原件完成证据已变化", 409);
}

function prepareInputDigest(run: AgentRun, input: ImageProcessingFrozenInput, expectedSha256?: string) {
    return createHash("sha256")
        .update(
            JSON.stringify([
                run.userId,
                run.id,
                input.parentTaskId || "",
                input.operation,
                input.algorithmVersion,
                [[input.inputs[0].assetId, input.inputs[0].assetVersion, expectedSha256 || ""]],
                input.operation === "prepare_reference" && input.options.generationInput
                    ? [input.options.generationInput.bounds.width, input.options.generationInput.bounds.height, input.options.generationInput.quality, generationReferencePlanDigest(run)]
                    : [],
            ]),
        )
        .digest("hex");
}

async function readPrepareReplay(run: AgentRun, input: EnqueueImageProcessingInput): Promise<ImageProcessingTask | undefined> {
    if (input.operation === "prepare_reference" && input.options.generationInput) {
        assertGenerationReferenceRequest(run, input);
        const prepared = await completedProtectionInputs(run, input, readImageProcessingStage);
        const reference = run.ecommerceSnapshot?.processing?.generationReferences?.find((item) => item.inputDigest === prepared.inputDigest && item.jobId === `image-process-${prepared.inputDigest}`);
        return reference ? readFrozenImageProcessingReplay(run, input, prepared) : undefined;
    }
    const requested = input.inputs[0];
    const references = run.ecommerceSnapshot?.processing?.prepareReferences || [];
    for (const reference of references) {
        if (reference.assetId !== requested.assetId) continue;
        const stored = await getStoredGenerationTaskRecord("image_processing", reference.jobId);
        if (!stored || stored.userId !== run.userId || stored.runId !== run.id) throw new ImageProcessingInputError("原参考处理阶段归属已失效", 409);
        const payload = stored.payload as AgentImageProcessingPayload;
        if (payload.operation !== "prepare_reference" || Object.keys(payload.options).length !== 0) throw new ImageProcessingInputError("原参考处理阶段操作冲突", 409);
        if (payload.algorithmVersion !== input.algorithmVersion) continue;
        const source = payload.inputs[0];
        const encoded = payload.resource.facts.encodedInputs.find((fact) => fact.inputIndex === 0 && fact.assetId === requested.assetId && fact.assetVersion === reference.assetVersion);
        const originalInput = { ...input, inputs: [{ ...requested, assetVersion: reference.assetVersion }] };
        if (
            payload.version !== "image-processing.v1" ||
            payload.inputs.length !== 1 ||
            source.assetId !== requested.assetId ||
            source.assetVersion !== reference.assetVersion ||
            !source.expectedSha256 ||
            !encoded ||
            encoded.sha256 !== source.expectedSha256 ||
            (requested.expectedSha256 !== undefined && requested.expectedSha256 !== source.expectedSha256) ||
            payload.inputDigest !== reference.inputDigest ||
            stored.id !== `image-process-${reference.inputDigest}` ||
            stored.clientRequestId !== reference.inputDigest ||
            stored.attemptNo !== 0 ||
            (reference.inputDigest !== prepareInputDigest(run, originalInput) && reference.inputDigest !== prepareInputDigest(run, originalInput, source.expectedSha256))
        )
            throw new ImageProcessingInputError("原参考处理阶段输入身份冲突", 409);
        if (reference.assetVersion !== requested.assetVersion) {
            const current = run.ecommerceSnapshot?.referenceCheckpoint?.assets.find((item) => item.asset.id === requested.assetId && item.assetVersion === requested.assetVersion);
            const result = stored.resultPayload as ImageProcessingStoredResult | undefined;
            const manifest = result?.manifest;
            const identity = manifest?.sourceIdentities[0];
            if (
                stored.status !== "success" ||
                !current ||
                !reference.manifest ||
                !manifest ||
                !identity ||
                identity.decodeError ||
                manifest.jobId !== stored.id ||
                manifest.executionId !== payload.executionId ||
                manifest.sourceIdentities.length !== 1 ||
                identity.assetId !== source.assetId ||
                identity.assetVersion !== source.assetVersion ||
                identity.sha256 !== source.expectedSha256 ||
                identity.bytes !== encoded.bytes ||
                identity.sha256 !== current.contentSha256 ||
                current.assetVersion !== referenceAssetVersion(current.asset, identity.sha256) ||
                !prepareSourceMatchesReference(current, identity) ||
                imageProcessingManifestDigest(manifest) !== imageProcessingManifestDigest(reference.manifest)
            )
                throw new ImageProcessingInputError("当前参考缺少原阶段的完整完成证据", 409);
        }
        return { ...stored, type: "image_processing", payload };
    }
}

function assertParentExecution(run: AgentRun, input: EnqueueImageProcessingInput) {
    if (run.id !== input.runId || run.executionId !== input.parentExecutionId || run.cancellation || (run.status !== "planning" && run.status !== "running")) throw new ImageProcessingInputError("父任务执行身份已失效", 409);
}

function frozenPrepareReference(run: AgentRun, input: Omit<ImageProcessingInput, "path">): { scope: LocalMediaRegistration["scope"]; storageKey: string; input: Omit<ImageProcessingInput, "path"> } {
    const frozen = run.ecommerceSnapshot?.referenceCheckpoint?.assets.find((item) => item.asset.id === input.assetId && item.assetVersion === input.assetVersion);
    if (
        !frozen ||
        frozen.asset.userId !== run.userId ||
        frozen.asset.conversationId !== run.conversationId ||
        frozen.asset.type !== "image" ||
        frozen.asset.status !== "ready" ||
        referenceAssetVersion(frozen.asset, frozen.contentSha256) !== input.assetVersion
    )
        throw new ImageProcessingInputError("参考原件身份已变化", 409);
    if (input.expectedSha256 && frozen.contentSha256 && input.expectedSha256 !== frozen.contentSha256) throw new ImageProcessingInputError("参考原件内容身份冲突", 409);
    const url = new URL(frozen.asset.serverUrl || "", "http://image-processing.local");
    const scope = url.pathname.startsWith("/api/reference-assets/") ? "reference" : url.pathname.startsWith("/api/generation-log-assets/") ? "generation" : undefined;
    if (!scope) throw new ImageProcessingInputError("参考原件尚未登记为站内媒体", 409);
    const prefix = scope === "reference" ? "/api/reference-assets/" : "/api/generation-log-assets/";
    const storageKey = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    if (frozen.asset.storageKey && frozen.asset.storageKey !== storageKey) throw new ImageProcessingInputError("参考原件存储引用冲突", 409);
    return { scope, storageKey, input: { assetId: input.assetId, assetVersion: input.assetVersion, ...(frozen.contentSha256 || input.expectedSha256 ? { expectedSha256: frozen.contentSha256 || input.expectedSha256 } : {}) } };
}

function assertRegistration(registration: LocalMediaRegistration | null | undefined, reference: Pick<ImageProcessingMediaReference, "scope" | "storageKey">, userId: string, now?: number): asserts registration is LocalMediaRegistration {
    if (!registration || registration.ownerUserId !== userId || registration.type !== "image" || registration.scope !== reference.scope || registration.storageKey !== reference.storageKey || isLocalMediaRegistrationExpired(registration, now))
        throw new ImageProcessingInputError("参考媒体登记或归属已失效", 409);
}

async function recheckFrozenReference(run: AgentRun, input: Pick<EnqueueImageProcessingInput, "inputs">, source: ImageProcessingMediaReference, executor?: QueryExecutor, registrations?: LocalMediaRegistration[], now?: number) {
    const frozen = frozenPrepareReference(run, input.inputs[0]);
    if (frozen.scope !== source.scope || frozen.storageKey !== source.storageKey) throw new ImageProcessingInputError("参考原件存储引用已变化", 409);
    const registration = registrations ? registrations.find((item) => item.storageKey === source.storageKey) : (await getLocalMediaRegistrations([source.storageKey], { ownerUserId: run.userId, executor, forUpdate: Boolean(executor) }))[0];
    assertRegistration(registration, source, run.userId, now);
    const provider = registration.storageProvider === "object" ? "object" : "local";
    if (provider !== source.storageProvider || registration.externalStorageId !== source.externalStorageId) throw new ImageProcessingInputError("参考原件存储位置已变化", 409);
}

async function registeredOriginalStream(registration: LocalMediaRegistration, signal?: AbortSignal, executor?: QueryExecutor): Promise<Readable> {
    try {
        if (registration.storageProvider === "object") return await readExternalMediaStream(registration, signal, executor);
        const root = resolve(registration.scope === "reference" ? REFERENCE_MEDIA_ROOT : GENERATION_MEDIA_ROOT);
        const sourcePath = resolve(root, registration.storageKey);
        if (sourcePath === root || !sourcePath.startsWith(`${root}${sep}`)) throw new ImageProcessingInputError("参考原件路径不合法", 409);
        const info = await stat(sourcePath);
        if (!info.isFile()) throw new ImageProcessingInputError("原件媒体不存在", 404);
        return createReadStream(sourcePath, { signal });
    } catch (error) {
        if (error instanceof Error && (("code" in error && error.code === "ENOENT") || error.name === "NoSuchKey" || error.name === "NotFound")) throw new ImageProcessingInputError("原件媒体不存在", 404, { cause: error });
        throw error;
    }
}

export async function collectReference(registration: LocalMediaRegistration, input: Omit<ImageProcessingInput, "path">): Promise<EncodedImageProcessingInput> {
    const { sha256, bytes, metadata } = await collectRegisteredOriginal(registration, input.expectedSha256);
    return {
        inputIndex: 0,
        assetId: input.assetId,
        assetVersion: input.assetVersion,
        sha256,
        bytes,
        ...(metadata.format && metadata.depth && metadata.channels ? { layout: { format: metadata.format, depth: metadata.depth, channels: metadata.channels } } : {}),
    };
}

export async function readImageProcessingMediaFacts(registration: LocalMediaRegistration, expected: { sha256: string; bytes: number; width: number; height: number; mimeType: string }, executor?: QueryExecutor) {
    const { sha256, bytes, metadata } = await collectRegisteredOriginal(registration, expected.sha256, executor, expected.bytes);
    const size = orientedDimensions(metadata);
    const mimeType = imageMimeType(metadata);
    if (size.width * size.height > ECOMMERCE_IMAGE_MAX_INPUT_PIXELS) throw new ImageProcessingInputError("画幅验收原件超过像素限制", 413);
    if (bytes !== expected.bytes || mimeType !== expected.mimeType || size.width !== expected.width || size.height !== expected.height) throw new ImageProcessingInputError("画幅验收原件字节、格式或展示尺寸与完成事实不符", 409);
    return { sha256, bytes, mimeType, ...size };
}

async function collectRegisteredOriginal(registration: LocalMediaRegistration, expectedSha256?: string, executor?: QueryExecutor, maxBytes = CREATIVE_UPLOAD_MAX_BYTES) {
    const directory = await mkdtemp(join(tmpdir(), "vozeb-image-processing-input-"));
    const stagedPath = join(directory, "source");
    try {
        const hash = createHash("sha256");
        let bytes = 0;
        const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.length;
                if (bytes > maxBytes) return callback(new ImageProcessingInputError("参考图片文件过大", 413));
                hash.update(chunk);
                callback(null, chunk);
            },
        });
        await pipeline(await registeredOriginalStream(registration, undefined, executor), meter, createWriteStream(stagedPath, { flags: "wx" }));
        const sha256 = hash.digest("hex");
        if (expectedSha256 && expectedSha256 !== sha256) throw new ImageProcessingInputError("参考原件内容已变化", 409);
        const metadata = await sharp(stagedPath, { limitInputPixels: false, failOn: "error" }).metadata();
        return { sha256, bytes, metadata };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function assertSameStage(current: AgentImageProcessingPayload, requested: AgentImageProcessingPayload) {
    if (
        current.version !== requested.version ||
        current.operation !== requested.operation ||
        current.algorithmVersion !== requested.algorithmVersion ||
        current.inputDigest !== requested.inputDigest ||
        current.inputs[0].assetId !== requested.inputs[0].assetId ||
        current.inputs[0].assetVersion !== requested.inputs[0].assetVersion ||
        current.inputs[0].expectedSha256 !== requested.inputs[0].expectedSha256
    )
        throw new ImageProcessingInputError("图像阶段请求指纹冲突", 409);
    if (current.operation === "prepare_reference" && requested.operation === "prepare_reference" && !isDeepStrictEqual(current.options, requested.options)) throw new ImageProcessingInputError("图像阶段参考用途冲突", 409);
    if (current.operation === "build_protection" && requested.operation === "build_protection" && JSON.stringify(protectionOptionsIdentity(current.options)) !== JSON.stringify(protectionOptionsIdentity(requested.options)))
        throw new ImageProcessingInputError("图像阶段保护策略冲突", 409);
}

function waitingParent(run: AgentRun, payload: AgentImageProcessingPayload, now: number, parentTaskId?: string): AgentRun {
    const snapshot = run.ecommerceSnapshot;
    if (!snapshot) throw new ImageProcessingInputError("参考处理检查点不存在", 409);
    const reference = { jobId: `image-process-${payload.inputDigest}`, inputDigest: payload.inputDigest };
    const previous = snapshot.processing || { version: "image-processing-checkpoint.v1", prepareReferences: [] };
    if (payload.operation === "build_protection")
        return {
            ...run,
            status: payload.resource.unavailable ? "paused" : run.status,
            executionId: undefined,
            updatedAt: now,
            ecommerceSnapshot: {
                ...snapshot,
                processing: { ...previous, protection: { ...reference, ...(!("mode" in payload.options) && payload.options.generationInput ? { generationInput: payload.options.generationInput } : {}) }, waitingFor: reference },
            },
        };
    if (payload.operation === "prepare_reference" && payload.options.generationInput) {
        const previousReferences = previous.generationReferences || [];
        const generationReferences = previousReferences.some((item) => item.jobId === reference.jobId)
            ? previousReferences
            : [
                  ...previousReferences,
                  { ...reference, parentTaskId: parentTaskId!, assetId: payload.inputs[0].assetId, assetVersion: payload.inputs[0].assetVersion, generationInput: payload.options.generationInput, planDigest: generationReferencePlanDigest(run) },
              ];
        return { ...run, status: payload.resource.unavailable ? "paused" : run.status, executionId: undefined, updatedAt: now, ecommerceSnapshot: { ...snapshot, processing: { ...previous, generationReferences, waitingFor: reference } } };
    }
    const prepareReferences = previous.prepareReferences.some((item) => item.jobId === reference.jobId)
        ? previous.prepareReferences
        : [...previous.prepareReferences, { ...reference, assetId: payload.inputs[0].assetId, assetVersion: payload.inputs[0].assetVersion }];
    return { ...run, status: payload.resource.unavailable ? "paused" : run.status, executionId: undefined, updatedAt: now, ecommerceSnapshot: { ...snapshot, processing: { ...previous, prepareReferences, waitingFor: reference } } };
}

export function assertNativeSceneResultBaseline(image: ImageTask, evidence: Pick<Awaited<ReturnType<typeof readCompletedEcommerceSceneProtection>>, "state" | "enhancementBaseline">) {
    const baseline = imageTaskNativeSceneBaseline(image);
    if (!baseline) return;
    const qualified = evidence.enhancementBaseline;
    if (qualified?.status !== "qualified" || qualified.scope !== "local_edit" || !isDeepStrictEqual(baseline, qualified.baseline) || imageTaskResultReferenceUrl(image.references[0]) !== evidence.state.sourceUrl)
        throw new ImageProcessingInputError("原生场景4K结果与原build冻结基线不一致", 409);
}

export async function readNativeImageResultEvidence(run: ImageResultRun | undefined, image: ImageTask | undefined, payload?: AgentImageProcessingPayload, storage?: QueryExecutor | StoredGenerationTaskRecord[], extraKeys: string[] = []) {
    if (image && isNativeGlobalSceneImageTaskResult(image)) return readNativeGlobalSceneResultEvidence(run, image, payload, storage, extraKeys);
    if (image && isNativeProductImageTaskResult(image)) return readNativeProductResultEvidence(run, image, payload, storage, extraKeys);
    return readNativeSceneResultEvidence(run, image, payload, storage, extraKeys);
}

async function readNativeGlobalSceneResultEvidence(run: ImageResultRun | undefined, image: ImageTask, payload?: AgentImageProcessingPayload, storage?: QueryExecutor | StoredGenerationTaskRecord[], extraKeys: string[] = []) {
    if (!run || run.id !== image.runId || run.userId !== image.userId || run.payload.id !== run.id || run.payload.userId !== run.userId) throw new ImageProcessingInputError("原生全局场景结果缺少原Run身份", 409);
    const executor = storage && !Array.isArray(storage) ? storage : undefined;
    const originalImage = Array.isArray(storage) ? storage.find((item) => item.type === "image" && item.id === image.id) : await getStoredGenerationTaskRecord("image", image.id, executor);
    if (
        !originalImage ||
        originalImage.userId !== image.userId ||
        originalImage.runId !== image.runId ||
        originalImage.parentTaskId !== image.parentTaskId ||
        originalImage.clientRequestId !== image.clientRequestId ||
        imageTaskResultSourceIdentityDigest(originalImage.payload as ImageTask) !== imageTaskResultSourceIdentityDigest(image)
    )
        throw new ImageProcessingInputError("原生全局场景结果的原图片请求身份已变化", 409);
    const records: StoredGenerationTaskRecord[] = [];
    for (const role of image.ecommerceExecution?.referenceRoles || []) {
        const reference = run.payload.ecommerceSnapshot?.processing?.prepareReferences.find((item) => item.assetId === role.assetId);
        const record = reference && (Array.isArray(storage) ? storage.find((item) => item.type === "image_processing" && item.id === reference.jobId) : await getStoredGenerationTaskRecord("image_processing", reference.jobId, executor, Boolean(executor)));
        if (!record) throw new ImageProcessingInputError("原生全局场景结果的原prepare已失效", 409);
        records.push(record);
    }
    const keys = [...records.flatMap((record) => (record.payload as AgentImageProcessingPayload).sources.map((source) => source.storageKey)), ...(payload?.sources.map((source) => source.storageKey) || []), ...extraKeys];
    const registrations = await getLocalMediaRegistrations(keys, { ownerUserId: image.userId, executor, forUpdate: Boolean(executor) });
    const now = executor
        ? (await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime()
        : getDatabaseProvider() === "postgres"
          ? (await postgresQuery<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime()
          : Date.now();
    const evidence = await readCompletedEcommerceGlobalScene(run.payload, image, { records, registrations, now });
    if (payload && (payload.operation !== "process_result" || payload.options.mode !== "ordinary" || !imageTaskResultInputsMatch(image, payload))) throw new ImageProcessingInputError("原生全局场景结果的原件输入绑定不一致", 409);
    const check = (checkedAt: number, current = registrations) => {
        if (run.expiresAt <= checkedAt || records.some((record) => record.expiresAt <= checkedAt)) throw new ImageProcessingInputError("原生全局场景结果的Run或prepare已过期", 409);
        for (const reference of evidence.references) {
            const actual = current.find((item) => item.storageKey === reference.registration.storageKey);
            if (!actual || !isDeepStrictEqual(actual, reference.registration) || isLocalMediaRegistrationExpired(actual, checkedAt)) throw new ImageProcessingInputError("原生全局场景结果的原参考登记已变化", 409);
        }
    };
    check(now);
    return { ...evidence, registrations, now, check };
}

async function readNativeProductResultEvidence(run: ImageResultRun | undefined, image: ImageTask, payload?: AgentImageProcessingPayload, storage?: QueryExecutor | StoredGenerationTaskRecord[], extraKeys: string[] = []) {
    if (!run || run.id !== image.runId || run.userId !== image.userId || run.payload.id !== run.id || run.payload.userId !== run.userId) throw new ImageProcessingInputError("原生商品结果缺少原Run身份", 409);
    const processing = run.payload.ecommerceSnapshot?.processing;
    const prepareId = processing?.prepareReferences.find((item) => item.assetId === image.productProtection?.sourceAssetId)?.jobId;
    const localProduct = image.productProtection?.maskProvider === "local-edit-target.v1";
    const anchorPrepareId = localProduct ? processing?.prepareReferences.find((item) => item.assetId === image.productProtection?.productAnchorId)?.jobId : undefined;
    if (localProduct && (!anchorPrepareId || anchorPrepareId === prepareId)) throw new ImageProcessingInputError("原生局部商品结果缺少独立的商品锚prepare", 409);
    const auxiliaryPrepareIds = localProduct
        ? image.references.slice(2).map((reference) => {
              const id = processing?.prepareReferences.find((item) => item.assetId === reference.id)?.jobId;
              if (!id) throw new ImageProcessingInputError("原生局部商品结果缺少原辅助参考prepare", 409);
              return id;
          })
        : [];
    const buildId = processing?.protection?.jobId;
    if (!prepareId || !buildId) throw new ImageProcessingInputError("原生商品结果缺少原prepare/build证据", 409);
    const executor = storage && !Array.isArray(storage) ? storage : undefined;
    const originalImage = Array.isArray(storage) ? storage.find((item) => item.type === "image" && item.id === image.id) : await getStoredGenerationTaskRecord("image", image.id, executor);
    if (
        !originalImage ||
        originalImage.userId !== image.userId ||
        originalImage.runId !== image.runId ||
        originalImage.parentTaskId !== image.parentTaskId ||
        originalImage.clientRequestId !== image.clientRequestId ||
        imageTaskResultSourceIdentityDigest(originalImage.payload as ImageTask) !== imageTaskResultSourceIdentityDigest(image)
    )
        throw new ImageProcessingInputError("原生商品结果的原图片请求身份已变化", 409);
    const records: StoredGenerationTaskRecord[] = [];
    for (const id of [prepareId, buildId, ...(anchorPrepareId ? [anchorPrepareId] : []), ...auxiliaryPrepareIds]) {
        const record = Array.isArray(storage) ? storage.find((item) => item.type === "image_processing" && item.id === id) : await getStoredGenerationTaskRecord("image_processing", id, executor, Boolean(executor));
        if (!record) throw new ImageProcessingInputError("原生商品结果的prepare/build已失效", 409);
        records.push(record);
    }
    const manifest = records[1].resultPayload?.manifest as ImageProcessingManifest | undefined;
    const keys = [
        ...records.flatMap((record) => (record.payload as AgentImageProcessingPayload).sources.map((source) => source.storageKey)),
        ...(manifest?.artifacts.map((artifact) => artifact.storageKey) || []),
        ...(payload?.sources.map((source) => source.storageKey) || []),
        ...extraKeys,
    ];
    const registrations = await getLocalMediaRegistrations(keys, { ownerUserId: image.userId, executor, forUpdate: Boolean(executor) });
    const now = executor
        ? (await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime()
        : getDatabaseProvider() === "postgres"
          ? (await postgresQuery<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime()
          : Date.now();
    const evidence = await readCompletedEcommerceProductProtection(run.payload, { records, registrations, now });
    assertNativeProductResultSource(run.payload, image, evidence);
    if (localProduct) {
        for (const reference of evidence.references) await readImageProcessingMediaFacts(reference.registration, reference.source, executor);
        await readImageProcessingMediaFacts(evidence.maskRegistration, evidence.mask, executor);
    }
    if (payload && (payload.operation !== "process_result" || payload.options.mode !== "ordinary" || !imageTaskResultInputsMatch(image, payload))) throw new ImageProcessingInputError("原生商品结果的原件输入绑定不一致", 409);
    const check = (checkedAt: number, current = registrations) => {
        if (run.expiresAt <= checkedAt || records.some((record) => record.expiresAt <= checkedAt)) throw new ImageProcessingInputError("原生商品结果的Run或prepare/build已过期", 409);
        for (const expected of [...evidence.references.map((reference) => reference.registration), evidence.maskRegistration]) {
            const actual = current.find((item) => item.storageKey === expected.storageKey);
            const retained = actual?.storageKey === evidence.mask.storageKey && expected.storageClass === "temporary" && actual.storageClass === "permanent" && actual.expiresAt === undefined;
            if (!actual || !isDeepStrictEqual(actual, retained ? { ...expected, storageClass: "permanent", expiresAt: undefined } : expected) || isLocalMediaRegistrationExpired(actual, checkedAt))
                throw new ImageProcessingInputError("原生商品结果的原build媒体登记已变化", 409);
            if (actual.storageKey === evidence.mask.storageKey && actual.storageClass === "permanent" && actual.expiresAt !== undefined) throw new ImageProcessingInputError("原生商品永久蒙版仍有过期时间", 409);
        }
    };
    check(now);
    return { ...evidence, registrations, now, check };
}

export function assertNativeProductResultSource(run: AgentRun, image: ImageTask, evidence: Awaited<ReturnType<typeof readCompletedEcommerceProductProtection>>) {
    const tasks = run.tasks.filter((task) => task.childTasks?.some((child) => child.id === image.id));
    const task = tasks[0];
    const checkpoint = run.ecommerceSnapshot?.referenceCheckpoint;
    if (
        tasks.length !== 1 ||
        !task ||
        task.id !== evidence.stage.parentTaskId ||
        task.childTasks?.filter((child) => child.id === image.id).length !== 1 ||
        !nativeProductResultTaskMatches(run, task, image) ||
        !isDeepStrictEqual(task.productProtectionRegions, evidence.regions) ||
        !isDeepStrictEqual(image.mask, evidence.regions.editableBackground.mask?.reference) ||
        !isDeepStrictEqual(image.ecommerceExecution, evidence.execution) ||
        task.prompt !== evidence.execution.prompt ||
        image.references.length !== evidence.execution.referenceRoles.length ||
        !image.references.every((reference, index) => {
            const role = evidence.execution.referenceRoles[index];
            const original = checkpoint?.assets.find((item) => item.asset.id === role.assetId);
            const sourceUrl = original && assetAccessUrl(original.asset);
            return reference.id === role.assetId && reference.ecommerceRole === role.role && sourceUrl !== undefined && originalImageSourceUrl(imageTaskResultReferenceUrl(reference)) === originalImageSourceUrl(sourceUrl);
        })
    )
        throw new ImageProcessingInputError("原生商品结果与原计划、参考或build不一致", 409);
}

export async function readNativeSceneResultEvidence(run: ImageResultRun | undefined, image: ImageTask | undefined, payload?: AgentImageProcessingPayload, storage?: QueryExecutor | StoredGenerationTaskRecord[], extraKeys: string[] = []) {
    if (!image || !isNativeSceneImageTaskResult(image)) return;
    if (!run || run.id !== image.runId || run.userId !== image.userId || run.payload.id !== run.id || run.payload.userId !== run.userId) throw new ImageProcessingInputError("原生场景结果缺少原Run身份", 409);
    const receipt = run.payload.ecommerceSnapshot?.processing?.sceneSelection;
    const buildId = run.payload.ecommerceSnapshot?.processing?.protection?.jobId;
    if (!receipt || !buildId) throw new ImageProcessingInputError("原生场景结果缺少原prepare/build证据", 409);
    const executor = storage && !Array.isArray(storage) ? storage : undefined;
    const originalImage = Array.isArray(storage) ? storage.find((item) => item.type === "image" && item.id === image.id) : await getStoredGenerationTaskRecord("image", image.id, executor);
    if (
        !originalImage ||
        originalImage.userId !== image.userId ||
        originalImage.runId !== image.runId ||
        originalImage.parentTaskId !== image.parentTaskId ||
        originalImage.clientRequestId !== image.clientRequestId ||
        imageTaskResultSourceIdentityDigest(originalImage.payload as ImageTask) !== imageTaskResultSourceIdentityDigest(image)
    )
        throw new ImageProcessingInputError("原生场景结果的原图片请求身份已变化", 409);
    const records: StoredGenerationTaskRecord[] = [];
    for (const id of [receipt.prepare.jobId, buildId]) {
        const record = Array.isArray(storage) ? storage.find((item) => item.type === "image_processing" && item.id === id) : await getStoredGenerationTaskRecord("image_processing", id, executor, Boolean(executor));
        if (!record) throw new ImageProcessingInputError("原生场景结果的prepare/build已失效", 409);
        records.push(record);
    }
    const build = records[1].payload as AgentImageProcessingPayload;
    const manifest = records[1].resultPayload?.manifest as ImageProcessingManifest | undefined;
    const keys = [...build.sources.map((source) => source.storageKey), ...(manifest?.artifacts.map((artifact) => artifact.storageKey) || []), ...(payload?.sources.map((source) => source.storageKey) || []), ...extraKeys];
    const registrations = await getLocalMediaRegistrations(keys, { ownerUserId: image.userId, executor, forUpdate: Boolean(executor) });
    const now = executor
        ? (await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime()
        : getDatabaseProvider() === "postgres"
          ? (await postgresQuery<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime()
          : Date.now();
    const evidence = await readCompletedEcommerceSceneProtection(run.payload, undefined, { records, registrations, now });
    assertNativeSceneResultBaseline(image, evidence);
    if (
        !isDeepStrictEqual(image.sceneProtection, evidence.sceneProtection) ||
        !isDeepStrictEqual(image.mask, evidence.sceneProtection.mask) ||
        !isDeepStrictEqual(image.ecommerceExecution, evidence.execution) ||
        !isDeepStrictEqual(evidence.state.task.sceneProtection, evidence.sceneProtection) ||
        !isDeepStrictEqual(evidence.state.task.ecommerceExecution, evidence.execution)
    )
        throw new ImageProcessingInputError("原生场景结果与当前确认和build不一致", 409);
    if (payload) {
        if (
            payload.operation !== "process_result" ||
            payload.options.mode !== "scene_protection" ||
            !payload.parentMask ||
            payload.parentMask.imageTaskId !== image.id ||
            payload.parentMask.inputIndex !== payload.options.maskInputIndex ||
            !imageTaskResultInputsMatch(image, payload)
        )
            throw new ImageProcessingInputError("原生场景结果的原蒙版输入绑定不一致", 409);
        for (const [inputIndex, key, sha256, bytes] of [
            [payload.options.sourceInputIndex, evidence.stage.payload.sources[0].storageKey, evidence.source.sha256, evidence.source.bytes],
            [payload.options.maskInputIndex, evidence.mask.storageKey, evidence.mask.sha256, evidence.mask.bytes],
        ] as const) {
            const source = payload.sources.find((item) => item.inputIndex === inputIndex);
            const fact = payload.resource.facts.encodedInputs.find((item) => item.inputIndex === inputIndex);
            const registration = registrations.find((item) => item.storageKey === key);
            if (
                !source ||
                source.storageKey !== key ||
                !registration ||
                source.scope !== registration.scope ||
                source.frozenResultSource ||
                source.storageProvider !== (registration.storageProvider === "object" ? "object" : "local") ||
                source.externalStorageId !== registration.externalStorageId ||
                !fact ||
                fact.sha256 !== sha256 ||
                fact.bytes !== bytes
            )
                throw new ImageProcessingInputError("原生场景结果的原件或蒙版事实不一致", 409);
        }
    }
    const check = (checkedAt: number, current = registrations) => {
        if (run.expiresAt <= checkedAt || records.some((record) => record.expiresAt <= checkedAt)) throw new ImageProcessingInputError("原生场景结果的Run或prepare/build已过期", 409);
        for (const expected of [evidence.sourceRegistration, evidence.maskRegistration]) {
            const actual = current.find((item) => item.storageKey === expected.storageKey);
            const retained = actual?.storageKey === evidence.mask.storageKey && expected.storageClass === "temporary" && actual.storageClass === "permanent" && actual.expiresAt === undefined;
            if (!actual || !isDeepStrictEqual(actual, retained ? { ...expected, storageClass: "permanent", expiresAt: undefined } : expected) || isLocalMediaRegistrationExpired(actual, checkedAt))
                throw new ImageProcessingInputError("原生场景结果的原build媒体登记已变化", 409);
            if (actual.storageKey === evidence.mask.storageKey && actual.storageClass === "permanent" && actual.expiresAt !== undefined) throw new ImageProcessingInputError("原生场景永久蒙版仍有过期时间", 409);
        }
    };
    check(now);
    return { ...evidence, registrations, now, check };
}

export type EcommerceReviewClaim = { workerId: string; executionId: string };
type ReviewMutation<T> = { tasks: StoredGenerationTaskRecord[]; result: T };

function assertReviewClaim(parent: StoredGenerationTaskRecord, claim: EcommerceReviewClaim, now: number) {
    if (parent.workerId !== claim.workerId || parent.payload.executionId !== claim.executionId || !(Number(parent.leaseUntil) > now) || parent.expiresAt <= now) throw new ImageProcessingInputError("视觉复核执行身份或租约已失效", 409);
}

async function mutateVisualReviewTasks<T>(
    runId: string,
    mutate: (records: StoredGenerationTaskRecord[], executor: QueryExecutor | undefined, now: number) => Promise<ReviewMutation<T>>,
    claim?: EcommerceReviewClaim,
    childClaim?: { id: string; workerId: string; executionId: string },
): Promise<T> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (executor) => {
            const parent = await getStoredGenerationTaskRecord("agent", runId, executor, true);
            if (!parent) throw new ImageProcessingInputError("视觉复核父任务不存在", 404);
            const ids = await executor.query<{ id: string; task_type: "image" | "image_processing" }>("SELECT id, task_type FROM generation_tasks WHERE run_id = $1 AND user_id = $2 AND task_type IN ('image', 'image_processing') ORDER BY id FOR UPDATE", [
                runId,
                parent.userId,
            ]);
            const records = [parent];
            for (const row of ids.rows) {
                const record = await getStoredGenerationTaskRecord(row.task_type, row.id, executor);
                if (record) records.push(record);
            }
            const clock = await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now");
            const now = clock.rows[0].now.getTime();
            if (parent.expiresAt <= now) throw new ImageProcessingInputError("视觉复核父任务已过期", 409);
            if (claim) assertReviewClaim(parent, claim, now);
            const next = await mutate(records, executor, now);
            for (const record of [...next.tasks.filter((item) => item.id !== runId), ...next.tasks.filter((item) => item.id === runId)]) {
                const previous = records.find((item) => item.id === record.id);
                if (record === previous) continue;
                if (!previous) {
                    await executor.query(
                        `INSERT INTO generation_tasks (id,user_id,task_type,status,payload,created_at,updated_at,expires_at,conversation_id,run_id,surface,project_id,parent_task_id,attempt_no,client_request_id,execution_phase,next_poll_at,last_upstream_status)
                        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
                        [
                            record.id,
                            record.userId,
                            record.type,
                            record.status,
                            JSON.stringify(record.payload),
                            new Date(record.createdAt),
                            new Date(record.updatedAt),
                            new Date(record.expiresAt),
                            record.conversationId || null,
                            record.runId || null,
                            record.surface || null,
                            record.projectId || null,
                            record.parentTaskId || null,
                            record.attemptNo || 0,
                            record.clientRequestId || null,
                            record.executionPhase,
                            record.nextPollAt === undefined ? null : new Date(record.nextPollAt),
                            record.lastUpstreamStatus || null,
                        ],
                    );
                    continue;
                }
                const fencedChild = childClaim?.id === record.id ? childClaim : undefined;
                const guard = claim
                    ? " AND EXISTS (SELECT 1 FROM generation_tasks AS parent WHERE parent.id = $13 AND parent.worker_id = $14 AND parent.payload ->> 'executionId' = $15 AND parent.lease_until > clock_timestamp() AND parent.expires_at > clock_timestamp())"
                    : fencedChild
                      ? " AND worker_id = $13 AND payload ->> 'executionId' = $14 AND lease_until > clock_timestamp() AND expires_at > clock_timestamp()"
                      : " AND expires_at > clock_timestamp()";
                const updated = await executor.query(
                    `UPDATE generation_tasks SET status=$2,payload=$3::jsonb,updated_at=$4,execution_phase=$5,next_poll_at=$6,last_upstream_status=$7,result_payload=$8::jsonb,worker_id=$9,lease_until=$10,last_heartbeat_at=$11,expires_at=$12 WHERE id=$1${guard} RETURNING id`,
                    [
                        record.id,
                        record.status,
                        JSON.stringify(record.payload),
                        new Date(record.updatedAt),
                        record.executionPhase,
                        record.nextPollAt === undefined ? null : new Date(record.nextPollAt),
                        record.lastUpstreamStatus || null,
                        JSON.stringify(record.resultPayload || {}),
                        record.workerId || null,
                        record.leaseUntil === undefined ? null : new Date(record.leaseUntil),
                        record.lastHeartbeatAt === undefined ? null : new Date(record.lastHeartbeatAt),
                        new Date(record.expiresAt),
                        ...(claim ? [runId, claim.workerId, claim.executionId] : fencedChild ? [fencedChild.workerId, fencedChild.executionId] : []),
                    ],
                );
                if (!updated.rows[0]) throw new ImageProcessingInputError("视觉复核提交执行身份或租约已失效", 409);
            }
            const live = await executor.query<{ live: boolean }>("SELECT expires_at > clock_timestamp() AS live FROM generation_tasks WHERE id = $1", [runId]);
            if (!live.rows[0]?.live) throw new ImageProcessingInputError("视觉复核提交时父任务已过期", 409);
            return next.result;
        });
    }
    return queueRuntimeFileOperation(() =>
        withGenerationTaskFileMutation(async (all) => {
            const parent = all.find((item) => item.type === "agent" && item.id === runId);
            if (!parent) throw new ImageProcessingInputError("视觉复核父任务不存在", 404);
            const now = Date.now();
            if (parent.expiresAt <= now) throw new ImageProcessingInputError("视觉复核父任务已过期", 409);
            if (claim) assertReviewClaim(parent, claim, now);
            const records = all.filter((item) => item === parent || (item.runId === runId && item.userId === parent.userId && (item.type === "image" || item.type === "image_processing")));
            const next = await mutate(records, undefined, now);
            if (parent.expiresAt <= Date.now()) throw new ImageProcessingInputError("视觉复核父任务已过期", 409);
            if (claim) assertReviewClaim(parent, claim, Date.now());
            if (childClaim) {
                const child = records.find((item) => item.id === childClaim.id);
                if (next.tasks.find((item) => item.id === childClaim.id) !== child) {
                    const current = child && imageProcessingStageFromRecord(child);
                    requireImageProcessingStage(current);
                    assertCurrentImageProcessingStage({ ...current, now: Date.now() }, childClaim);
                }
            }
            return { tasks: [...all.filter((item) => !records.includes(item)), ...next.tasks], result: next.result };
        }),
    );
}

function reviewImages(records: StoredGenerationTaskRecord[]) {
    return records.filter((item) => item.type === "image").map((item) => item.payload as ImageTask);
}

function reviewStageView(parent: AgentRun, stage: ImageProcessingStageState) {
    const checkpoint = parent.ecommerceSnapshot?.visualReview;
    const binding = stage.payload.reviewBinding;
    if (!independentAdvisoryReview(parent) || !checkpoint || !binding || checkpoint.attempt !== binding.attempt || checkpoint.contextDigest !== binding.contextDigest || stage.userId !== parent.userId || stage.runId !== parent.id) return;
    const view = checkpoint.views[binding.viewIndex];
    const source = checkpoint.sources[binding.sourceIndex];
    if (
        !view ||
        !source?.frozen ||
        view.sourceIndex !== binding.sourceIndex ||
        view.jobId !== stage.id ||
        view.inputDigest !== stage.payload.inputDigest ||
        !isDeepStrictEqual(source.frozen.input, stage.payload.inputs[0]) ||
        !isDeepStrictEqual(source.frozen.location, stage.payload.sources[0]) ||
        !isDeepStrictEqual(view.region, stage.payload.operation === "prepare_review" ? stage.payload.options.region : undefined)
    )
        return;
    return { checkpoint, view, source: source.frozen };
}

export async function freezeEcommerceReviewSource(run: AgentRun, source: EcommerceVisualReviewSource, location: { scope: "reference" | "generation"; storageKey: string }): Promise<EcommerceVisualReviewSource> {
    const registration = await getLocalMediaRegistration(location.storageKey);
    assertRegistration(registration, location, run.userId);
    const original = await collectRegisteredOriginal(registration, source.original.sha256);
    const size = orientedDimensions(original.metadata);
    if (size.width * size.height > ECOMMERCE_IMAGE_MAX_INPUT_PIXELS || original.bytes !== registration.bytes) throw new ImageProcessingInputError("视觉复核原件超过像素限制或登记已变化", 413);
    const mimeType = imageMimeType(original.metadata);
    const input = { assetId: source.original.assetId, assetVersion: source.original.assetVersion, expectedSha256: original.sha256 };
    const encoded: EncodedImageProcessingInput = {
        inputIndex: 0,
        ...input,
        sha256: original.sha256,
        bytes: original.bytes,
        ...(original.metadata.format && original.metadata.depth && original.metadata.channels ? { layout: { format: original.metadata.format, depth: original.metadata.depth, channels: original.metadata.channels } } : {}),
    };
    return {
        ...source,
        frozen: {
            input,
            location: {
                inputIndex: 0,
                scope: location.scope,
                storageKey: registration.storageKey,
                storageProvider: registration.storageProvider === "object" ? "object" : "local",
                ...(registration.externalStorageId ? { externalStorageId: registration.externalStorageId } : {}),
            },
            bytes: original.bytes,
            mimeType,
            encoded,
        },
    };
}

export async function enqueueEcommerceReviewPreparation(observed: AgentRun, claim: EcommerceReviewClaim, sources: EcommerceVisualReviewSource[]): Promise<{ status: "waiting" | "ready"; run: AgentRun }> {
    return mutateVisualReviewTasks(
        observed.id,
        async (records, executor, now) => {
            const parent = records.find((item) => item.type === "agent")!;
            const run = parent.payload as AgentRun;
            const checkpoint = run.ecommerceSnapshot?.visualReview;
            if (!checkpoint || run.reviewed || checkpoint.contextDigest !== observed.ecommerceSnapshot?.visualReview?.contextDigest || checkpoint.contextDigest !== reviewContextDigest(run, reviewImages(records)))
                throw new ImageProcessingInputError("视觉复核冻结上下文已变化", 409);
            const snapshot = run.ecommerceSnapshot!;
            if (checkpoint.views.length && (checkpoint.failure || checkpoint.views.every((view) => view.receipt))) return { tasks: records, result: { status: "ready" as const, run } };
            const frozen = checkpoint.views.length ? checkpoint.sources : sources;
            if (frozen.length !== checkpoint.sources.length) throw new ImageProcessingInputError("视觉复核原件数量已变化", 409);
            const registrations: LocalMediaRegistration[] = [];
            for (const key of [...new Set(frozen.flatMap((source) => (source.frozen ? [source.frozen.location.storageKey] : [])))].sort())
                registrations.push(...(await getLocalMediaRegistrations([key], { ownerUserId: run.userId, executor, forUpdate: Boolean(executor) })));
            const registeredAt = executor ? (await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime() : Date.now();
            for (const [index, source] of frozen.entries()) {
                if (!source.frozen || !isDeepStrictEqual(source.original, checkpoint.sources[index].original)) throw new ImageProcessingInputError("视觉复核原件身份不符", 409);
                const registration = registrations.find((item) => item.storageKey === source.frozen!.location.storageKey);
                assertRegistration(registration, source.frozen.location, run.userId, registeredAt);
                if (
                    registration.bytes !== source.frozen.bytes ||
                    registration.mimeType !== source.frozen.mimeType ||
                    (registration.storageProvider === "object" ? "object" : "local") !== source.frozen.location.storageProvider ||
                    registration.externalStorageId !== source.frozen.location.externalStorageId
                )
                    throw new ImageProcessingInputError("视觉复核原件登记已变化", 409);
            }
            const views: EcommerceVisualReviewCheckpoint["views"] = [];
            const children: StoredGenerationTaskRecord[] = [];
            let failure = checkpoint.failure;
            const regions = [...new Map((snapshot.plan!.visibleStructure || []).filter((fact) => fact.evidenceRegion).map((fact) => [JSON.stringify(reviewRegionTuple(fact.evidenceRegion)), fact.evidenceRegion!])).values()];
            for (const [sourceIndex, source] of frozen.entries()) {
                const original = source.frozen!;
                const crop = source.source === "baseline" || (source.source.startsWith("result:") && !snapshot.plan!.canvas?.allowReframe);
                for (const region of [undefined, ...(crop ? regions : [])]) {
                    const options = region ? { region: { ...region } } : {};
                    const inputDigest = reviewDigest([run.userId, run.id, checkpoint.attempt, checkpoint.contextDigest, checkpoint.algorithmVersion, reviewSourceTuple(source), reviewRegionTuple(region)]);
                    const id = "image-process-" + inputDigest;
                    const binding = { attempt: checkpoint.attempt, contextDigest: checkpoint.contextDigest, sourceIndex, viewIndex: views.length };
                    const existing = records.find((item) => item.id === id);
                    if (existing) {
                        const stage = imageProcessingStageFromRecord(existing);
                        if (
                            existing.type !== "image_processing" ||
                            existing.userId !== run.userId ||
                            stage.payload.operation !== "prepare_review" ||
                            !isDeepStrictEqual(stage.payload.reviewBinding, binding) ||
                            stage.payload.inputDigest !== inputDigest ||
                            !isDeepStrictEqual(stage.payload.inputs, [original.input]) ||
                            !isDeepStrictEqual(stage.payload.sources, [original.location]) ||
                            !isDeepStrictEqual(stage.payload.options, options)
                        )
                            throw new ImageProcessingInputError("视觉复核准备子任务身份冲突", 409);
                        views.push({
                            sourceIndex,
                            ...(region ? { region: { ...region } } : {}),
                            jobId: id,
                            inputDigest,
                            ...(stage.status === "success" && stage.resultPayload?.manifest ? { receipt: { executionId: stage.resultPayload.manifest.executionId, manifest: stage.resultPayload.manifest } } : {}),
                        });
                        if (stage.resultPayload?.failure) failure = { code: "review_preparation_failed", message: "视觉复核图像准备失败", jobId: id };
                        continue;
                    }
                    const operation = { operation: "prepare_review" as const, options };
                    const { profileVersion, ...configuration } = imageProcessingResourceConfig(process.env);
                    const facts: ImageProcessingResourceFacts = { encodedInputs: [original.encoded], decodedInputs: [] };
                    const estimate = estimateImageProcessingMemory({ ...operation, inputs: [original.input] }, facts);
                    const admission = decideImageProcessingAdmission(estimate, { totalMemoryBytes: configuration.budgetBytes, availableMemoryBytes: configuration.budgetBytes, availableSlots: configuration.concurrency });
                    const unavailable = admission.status === "unavailable" ? { code: admission.code, reason: admission.reason } : undefined;
                    const payload: AgentImageProcessingPayload = {
                        ...operation,
                        version: "image-processing.v1",
                        inputDigest,
                        algorithmVersion: checkpoint.algorithmVersion,
                        inputs: [original.input],
                        sources: [original.location],
                        reviewBinding: binding,
                        resource: { profileVersion, configuration, facts, ...(estimate.status === "calibrated" ? { requiredMemoryBytes: estimate.requiredMemoryBytes } : {}), ...(unavailable ? { unavailable } : {}) },
                    };
                    children.push({
                        id,
                        userId: run.userId,
                        type: "image_processing",
                        status: unavailable ? "paused" : "pending",
                        payload,
                        createdAt: now,
                        updatedAt: now,
                        expiresAt: parent.expiresAt,
                        conversationId: run.conversationId,
                        runId: run.id,
                        surface: run.surface,
                        projectId: run.projectId,
                        parentTaskId: run.id,
                        attemptNo: 0,
                        clientRequestId: inputDigest,
                        executionPhase: unavailable ? "needs_review" : "created",
                        nextPollAt: unavailable ? undefined : now,
                        lastUpstreamStatus: unavailable?.code || "created",
                    });
                    views.push({ sourceIndex, ...(region ? { region: { ...region } } : {}), jobId: id, inputDigest });
                    if (unavailable) failure = { code: unavailable.code, message: "视觉复核图像准备资源不可用", jobId: id };
                }
            }
            const ready = Boolean(failure) || views.every((view) => view.receipt);
            const nextRun: AgentRun = { ...run, updatedAt: now, ecommerceSnapshot: { ...snapshot, visualReview: { ...checkpoint, sources: frozen, views, ...(failure ? { failure } : {}) } } };
            const nextParent: StoredGenerationTaskRecord = {
                ...parent,
                payload: nextRun,
                updatedAt: now,
                executionPhase: "review_pending",
                ...(ready ? {} : { workerId: undefined, leaseUntil: undefined, lastHeartbeatAt: undefined, nextPollAt: undefined, lastUpstreamStatus: "review_preparation_waiting" }),
            };
            return { tasks: [...records.map((item) => (item === parent ? nextParent : item)), ...children], result: { status: ready ? ("ready" as const) : ("waiting" as const), run: nextRun } };
        },
        claim,
    );
}

async function completeEcommerceReviewPreparation(initial: ImageProcessingStageState, input: CompleteImageProcessingInput): Promise<CompletedImageProcessingStage> {
    return mutateVisualReviewTasks(
        initial.runId!,
        async (records, executor, now) => {
            const child = records.find((item) => item.id === initial.id);
            const stage = child && imageProcessingStageFromRecord(child);
            requireImageProcessingStage(stage);
            if (stage.status === "success") return { tasks: records, result: readCompletedImageProcessingStage(stage, input) };
            assertCurrentImageProcessingStage({ ...stage, now }, input);
            if (stage.payload.operation !== "prepare_review") throw new ImageProcessingInputError("视觉复核操作已变化", 409);
            // Prepare validation is shared; review has the same single-source/single-analysis receipt shape.
            assertPrepareCompletion({ ...stage, payload: { ...stage.payload, operation: "prepare_reference", options: {} } }, input);
            const source = input.manifest.sourceIdentities[0];
            if (source.decodeError || (stage.payload.options.region && !validPixelRectangle(stage.payload.options.region, { width: source.width, height: source.height }))) throw new ImageProcessingInputError("视觉复核原始裁片范围无效", 400);
            const registrations: LocalMediaRegistration[] = [];
            for (const key of [...new Set([stage.payload.sources[0].storageKey, input.manifest.artifacts[0].storageKey])].sort())
                registrations.push(...(await getLocalMediaRegistrations([key], { ownerUserId: stage.userId, executor, forUpdate: Boolean(executor) })));
            const registeredAt = executor ? (await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime() : Date.now();
            await assertImageProcessingOutputRegistration({ ...stage, now: registeredAt }, input.manifest.artifacts[0], executor);
            await assertImageProcessingFrozenSource({ ...stage, now: registeredAt }, executor);
            const original = registrations.find((item) => item.storageKey === stage.payload.sources[0].storageKey);
            const encoded = stage.payload.resource.facts.encodedInputs[0];
            if (original?.bytes !== encoded.bytes || original.mimeType !== source.mimeType) throw new ImageProcessingInputError("视觉复核原件登记已变化", 409);
            const parent = records.find((item) => item.type === "agent")!;
            const run = parent.payload as AgentRun;
            const current = reviewStageView(run, stage);
            const matches = current && parent.executionPhase === "review_pending" && !run.reviewed && !current.checkpoint.failure && current.checkpoint.contextDigest === reviewContextDigest(run, reviewImages(records));
            const resultPayload = completedImageProcessingPayload(input, Boolean(matches));
            const nextParent = matches
                ? {
                      ...parent,
                      payload: {
                          ...run,
                          updatedAt: now,
                          ecommerceSnapshot: {
                              ...run.ecommerceSnapshot!,
                              visualReview: { ...current.checkpoint, views: current.checkpoint.views.map((view) => (view === current.view ? { ...view, receipt: { executionId: input.executionId, manifest: input.manifest } } : view)) },
                          },
                      },
                      updatedAt: now,
                      executionPhase: "review_pending" as const,
                      nextPollAt: now,
                      lastUpstreamStatus: "review_preparation_completed",
                  }
                : parent;
            const closed: StoredGenerationTaskRecord = {
                ...child!,
                status: "success",
                executionPhase: "completed",
                resultPayload,
                updatedAt: now,
                nextPollAt: undefined,
                workerId: undefined,
                leaseUntil: undefined,
                lastHeartbeatAt: undefined,
                lastUpstreamStatus: "completed",
            };
            return { tasks: records.map((item) => (item === parent ? nextParent : item === child ? closed : item)), result: completedImageProcessingResponse(stage, resultPayload) };
        },
        undefined,
        { id: initial.id, workerId: input.workerId, executionId: input.executionId },
    );
}

async function failEcommerceReviewPreparation(initial: ImageProcessingStageState, input: FailImageProcessingInput, failure: ClosedImageProcessingFailure): Promise<FailedImageProcessingStage> {
    return mutateVisualReviewTasks(
        initial.runId!,
        async (records, _executor, now) => {
            const child = records.find((item) => item.id === initial.id);
            const stage = child && imageProcessingStageFromRecord(child);
            requireImageProcessingStage(stage);
            if (stage.status !== "running") return { tasks: records, result: readFailedImageProcessingStage(stage, input, failure) };
            assertCurrentImageProcessingStage({ ...stage, now }, input);
            const parent = records.find((item) => item.type === "agent")!;
            const run = parent.payload as AgentRun;
            const binding = reviewStageView(run, stage);
            const response = failedImageProcessingResponse(stage.id, failure);
            const nextParent =
                binding && parent.executionPhase === "review_pending" && !run.reviewed && binding.checkpoint.contextDigest === reviewContextDigest(run, reviewImages(records))
                    ? {
                          ...parent,
                          payload: { ...run, updatedAt: now, ecommerceSnapshot: { ...run.ecommerceSnapshot!, visualReview: { ...binding.checkpoint, failure: { code: "review_preparation_failed", message: "视觉复核图像准备失败", jobId: stage.id } } } },
                          updatedAt: now,
                          executionPhase: "review_pending" as const,
                          nextPollAt: now,
                          lastUpstreamStatus: "review_preparation_failed",
                      }
                    : parent;
            const closed: StoredGenerationTaskRecord = {
                ...child!,
                status: response.status,
                executionPhase: "needs_review",
                resultPayload: { ...stage.resultPayload, executionId: input.executionId, workerId: input.workerId, failure },
                updatedAt: now,
                nextPollAt: undefined,
                workerId: undefined,
                leaseUntil: undefined,
                lastHeartbeatAt: undefined,
                lastUpstreamStatus: "review_preparation_failed",
            };
            return { tasks: records.map((item) => (item === parent ? nextParent : item === child ? closed : item)), result: response };
        },
        undefined,
        { id: initial.id, workerId: input.workerId, executionId: input.executionId },
    );
}

export async function loadEcommerceReviewViews(run: AgentRun): Promise<PreparedEcommerceQualityView[]> {
    const checkpoint = run.ecommerceSnapshot?.visualReview;
    if (!checkpoint || checkpoint.failure || !checkpoint.views.length) throw new ImageProcessingInputError("视觉复核准备尚未完成", 409);
    for (const [index, source] of checkpoint.sources.entries()) {
        const frozen = source.frozen;
        const full = checkpoint.views.find((view) => view.sourceIndex === index && !view.region)?.receipt?.manifest.sourceIdentities[0];
        if (!frozen || !full || full.decodeError) throw new ImageProcessingInputError("视觉复核原始完成身份缺失", 409);
        const registration = await getLocalMediaRegistration(frozen.location.storageKey);
        assertRegistration(registration, frozen.location, run.userId);
        await readImageProcessingMediaFacts(registration, { sha256: frozen.input.expectedSha256, bytes: frozen.bytes, width: full.width, height: full.height, mimeType: frozen.mimeType });
    }
    const views: PreparedEcommerceQualityView[] = [];
    for (const view of checkpoint.views) {
        const child = await readImageProcessingStage(view.jobId);
        if (!child || child.status !== "success" || !view.receipt || !child.resultPayload?.manifest || imageProcessingManifestDigest(child.resultPayload.manifest) !== imageProcessingManifestDigest(view.receipt.manifest) || !reviewStageView(run, child))
            throw new ImageProcessingInputError("视觉复核准备完成回执已变化", 409);
        const manifest = view.receipt.manifest;
        const artifact = manifest.artifacts[0];
        const source = manifest.sourceIdentities[0];
        if (source.decodeError || !manifest.geometry.sourceSize || artifact.kind !== "analysis" || artifact.bytes > ECOMMERCE_VISION_IMAGE_MAX_BYTES || Math.max(artifact.width, artifact.height) > ECOMMERCE_VISION_IMAGE_MAX_DIMENSION)
            throw new ImageProcessingInputError("视觉复核工件或原始画幅无效", 409);
        await assertImageProcessingOutputRegistration(child, artifact);
        const registration = await getLocalMediaRegistration(artifact.storageKey);
        if (!registration) throw new ImageProcessingInputError("视觉复核工件登记不存在", 404);
        const chunks: Buffer[] = [];
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of await registeredOriginalStream(registration)) {
            bytes += chunk.length;
            if (bytes > artifact.bytes) throw new ImageProcessingInputError("视觉复核工件长度已变化", 409);
            hash.update(chunk);
            chunks.push(Buffer.from(chunk));
        }
        if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) throw new ImageProcessingInputError("视觉复核工件内容已变化", 409);
        views.push({
            source: checkpoint.sources[view.sourceIndex].source,
            size: { ...manifest.geometry.sourceSize },
            ...(view.region ? { region: { ...view.region } } : {}),
            url: `data:${artifact.mimeType};base64,${Buffer.concat(chunks, bytes).toString("base64")}`,
        });
    }
    return views;
}

export async function projectEcommerceReviewTrace(observed: AgentRun, claim: EcommerceReviewClaim, qualityDigest: string, trace: EcommerceGenerationTrace, expectedCurrentContextDigest?: string) {
    return mutateVisualReviewTasks(
        observed.id,
        async (records, _executor, now) => {
            const parent = records.find((item) => item.type === "agent")!;
            const run = parent.payload as AgentRun;
            const checkpoint = run.ecommerceSnapshot?.visualReview;
            const quality = run.ecommerceSnapshot?.qualityCheck;
            const currentContext = reviewContextDigest(run, reviewImages(records));
            const observedContext = expectedCurrentContextDigest || reviewContextDigest(observed, reviewImages(records));
            const unavailable = quality?.status === "unavailable" && checkpoint?.submission.state !== "completed";
            if (
                !run.reviewed ||
                !checkpoint ||
                checkpoint.attempt !== observed.ecommerceSnapshot?.visualReview?.attempt ||
                !quality ||
                reviewQualityDigest(quality) !== qualityDigest ||
                currentContext !== observedContext ||
                (!unavailable && currentContext !== checkpoint.contextDigest)
            )
                throw new ImageProcessingInputError("视觉复核投影身份已变化", 409);
            const ids = run.tasks[0].taskIds || (run.tasks[0].taskId ? [run.tasks[0].taskId] : []);
            return { tasks: records.map((item) => (item.type === "image" && ids.includes(item.id) ? { ...item, payload: { ...item.payload, ecommerceTrace: trace }, updatedAt: now } : item)), result: undefined };
        },
        claim,
    );
}
