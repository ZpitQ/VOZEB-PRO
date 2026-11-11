import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeImageGenerationLog } from "@/app/api/image-tasks/image-task-runner";
import { canvasProviderDimensions, resolveResultSize } from "@/app/api/image-tasks/image-task-size";
import sharp from "sharp";
import { originalImageSourceUrl } from "@/lib/media-image-url";
import { imageProcessingResourceConfig } from "@/lib/image-processing/resource-config";
import { decideImageProcessingAdmission, estimateImageProcessingMemory, IMAGE_PROCESSING_MEMORY_MODEL_VERSION, type EncodedImageProcessingInput } from "@/lib/image-processing/resource-model";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction, type QueryExecutor } from "./database";
import { getStoredGenerationTaskRecord, withGenerationTaskFileRead, withGenerationTaskFileMutation, type StoredGenerationTaskRecord } from "./generation-task-store";
import {
    assertResultModeEvidence,
    assertNativeSceneResultBaseline,
    assertNativeProductResultSource,
    collectReference,
    ImageProcessingInputError,
    imageResultResourceReason,
    readCompletedEcommerceSceneProtection,
    readCompletedEcommerceProductProtection,
    readCompletedEcommerceGlobalScene,
    readCompletedImageProcessingStage,
    readImageProcessingMediaFacts,
    readNativeImageResultEvidence,
    type CompleteImageProcessingInput,
    type ImageProcessingManifest,
    type ImageProcessingPayload,
    type AgentImageProcessingPayload,
} from "./image-processing-service";
import type { AgentRun } from "./agent-run-store";
import type { ImageTask, ImageTaskReference, ImageTaskResultEvidence, StoredImageTaskMediaResult } from "./image-task-store";
import { getLocalMediaRegistrations, isLocalMediaRegistrationExpired, promoteFileLocalMediaAssets } from "./local-media-registry";
import { queueRuntimeFileOperation, readRuntimeFile, writeRuntimeFile } from "./creative-runtime-repository";
import { registerGenerationTaskAssetsForUser } from "./creative-runtime-service";
import { finishGenerationAttempt } from "./generation-attempt";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";
import { enqueueImageEnhancement } from "./image-enhancement-enqueue";
import { imageEnhancementExclusion } from "./image-enhancement-plan";
import { canWaitForImageResultRun, fileImageResultRun, imageResultRunBinding, imageResultRunMatches, readImageResultRun, type ImageResultRun } from "./image-task-result-run";
import { generationTaskNextPollAt, releaseGenerationTaskLease } from "./generation-task-scheduler";
import {
    usesImageTaskResultProcessing,
    isNativeSceneImageTaskResult,
    isNativeProductImageTaskResult,
    isNativeGlobalSceneImageTaskResult,
    imageTaskResultOptions,
    imageTaskResultReferences,
    imageTaskResultReferenceId,
    imageTaskResultReferenceLocation,
    imageTaskResultReferenceUrl,
    imageTaskResultMaskBytes,
    imageTaskResultInputsMatch,
    imageTaskResultSourceIdentity,
    imageTaskResultSourceIdentityDigest,
    imageTaskResultFrozenSourceRegistrationMatches,
} from "./image-task-result-contract";
import { readImageTaskOriginalFile } from "./image-task-native-capture";
import { writeReferenceMediaFile } from "./reference-asset-store";

type ImageTaskResultProcessingInput = {
    taskId: string;
    workerId: string;
    executionId: string;
};

type ImageTaskResultProcessingOutcome = { state: "ready" } | { state: "waiting" } | { state: "waiting_for_run" } | { state: "ownership_lost" };

type NativeResults = NonNullable<ImageTask["nativeResults"]>;
type StoredNativeSlot = Extract<NativeResults["slots"][number], { status: "stored" }>;
type ResultProcessingPayload = Extract<AgentImageProcessingPayload, { operation: "process_result" }> & {
    imageResultBinding: NonNullable<AgentImageProcessingPayload["imageResultBinding"]>;
};
type ResultStage = Pick<StoredGenerationTaskRecord, "id" | "type" | "userId" | "status" | "payload" | "executionPhase" | "resultPayload"> & { parentTaskId?: string | null; runId?: string | null; unexpired: boolean };
type LockedImage = { payload: ImageTask; expires_at: Date; server_now: Date; conversation_id: string | null; surface: StoredGenerationTaskRecord["surface"] | null; project_id: string | null };
type CompletedResultInput = CompleteImageProcessingInput & { manifest: ImageProcessingManifest & { results: NonNullable<ImageProcessingManifest["results"]> } };

const ALGORITHM_VERSION = "image-task-result-processing.v1";
const IMAGE_RESULT_CLAIM_WHERE = `id = $1 AND task_type = 'image' AND user_id = $2
    AND payload ->> 'id' = $1 AND payload ->> 'userId' = $2
    AND status IN ('pending', 'running') AND payload ->> 'status' = status
    AND expires_at > clock_timestamp() AND lease_until > clock_timestamp()
    AND worker_id = $3 AND payload ->> 'executionId' = $4
    AND payload -> 'attemptNo' = to_jsonb($5::integer)
    AND upstream_task_id IS NOT DISTINCT FROM $6::text
    AND (($6::text IS NULL AND (payload -> 'upstream' IS NULL OR payload -> 'upstream' = 'null'::jsonb))
         OR ($6::text IS NOT NULL AND jsonb_typeof(payload #> '{upstream,id}') = 'string' AND payload #>> '{upstream,id}' = $6::text))
    AND run_id IS NOT DISTINCT FROM NULLIF(payload ->> 'runId', '')
    AND parent_task_id IS NOT DISTINCT FROM NULLIF(payload ->> 'parentTaskId', '')
    AND payload -> 'nativeResults' = $7::jsonb
    AND (run_id IS NULL OR EXISTS (SELECT 1 FROM generation_tasks AS image_run
        WHERE image_run.id = generation_tasks.run_id AND image_run.task_type = 'agent'
          AND image_run.user_id = $2 AND image_run.expires_at > clock_timestamp()
          AND image_run.status NOT IN ('success', 'error', 'cancelled')
          AND COALESCE(image_run.payload ->> 'status', '') NOT IN ('completed', 'failed', 'cancelled')
          AND (image_run.payload -> 'cancellation' IS NULL OR image_run.payload -> 'cancellation' = 'null'::jsonb)))`;

const IMAGE_RESULT_SOURCE_IDENTITY_SQL = `jsonb_build_object(
    'kind', payload -> 'kind', 'references', payload -> 'references',
    'mask', payload -> 'mask', 'sceneProtection', payload -> 'sceneProtection',
    'productProtection', payload -> 'productProtection', 'enhancementDelivery', payload -> 'enhancementDelivery',
    'runId', payload -> 'runId',
    'ecommerceExecution', CASE WHEN payload ->> 'ecommerceExecution' IS NULL THEN 'false'::jsonb ELSE payload -> 'ecommerceExecution' END,
    'ecommerceCanvasRequest', CASE WHEN payload ->> 'ecommerceCanvasRequest' IS NULL THEN 'false'::jsonb ELSE payload -> 'ecommerceCanvasRequest' END,
    'quality', payload #> '{config,quality}', 'size', payload #> '{config,size}',
    'outputBackground', payload #> '{config,outputBackground}', 'outputMode', payload #> '{config,outputMode}')`;

// Aborting the callback also prevents a no-op File write or a partial PG enqueue.
class ImageResultOwnershipLost extends Error {}

// Abort the File callback to preserve the current owner and avoid even a no-op task-file write.
class ImageResultReady extends Error {}

type CompletedResultTechnicalFacts = {
    resultId: string;
    url: string;
    nativeUrl: string;
    sourceAssetId: string;
    sourceUrl: string;
    sourceSize: { width: number; height: number };
    nativeSize: { width: number; height: number };
    storedSize: { width: number; height: number };
};

export type CompletedImageResultTechnicalEvidence = CompletedResultTechnicalFacts &
    ({ kind: "scene"; sceneProtectionEvidence: NonNullable<StoredImageTaskMediaResult["sceneProtectionEvidence"]> } | { kind: "product" | "global_scene"; sceneProtectionEvidence?: undefined });

// Completed results keep their original receipt and files; active leases and execution epochs no longer authorize this read.
export async function readCompletedImageTaskResult(run: AgentRun, observed: ImageTask, resultId: string): Promise<CompletedImageResultTechnicalEvidence | undefined> {
    const localScene = observed.sceneProtection || observed.ecommerceExecution?.protection?.scope === "local" || (run.ecommerceSnapshot?.plan?.operation === "scene_edit" && run.ecommerceSnapshot.plan.protection?.scope === "local");
    const productResult =
        (resolveResultSize(observed.config.quality, "1:1") !== resolveResultSize("4k", "1:1") || !observed.enhancementDelivery) &&
        Boolean(
            isNativeProductImageTaskResult(observed) ||
            (observed.resultProcessing && observed.productProtection) ||
            ((run.ecommerceSnapshot?.plan?.operation === "product_to_scene" || run.ecommerceSnapshot?.plan?.operation === "local_edit") && run.ecommerceSnapshot.plan.strategy === "strict_product"),
        );
    const globalPlan = run.ecommerceSnapshot?.plan;
    const globalScene = Boolean(
        isNativeGlobalSceneImageTaskResult(observed) ||
        (globalPlan?.operation === "scene_edit" &&
            globalPlan.strategy === "integrated_scene" &&
            globalPlan.protection?.scope === "global" &&
            (observed.resultProcessing ||
                observed.nativeResults ||
                observed.enhancementDelivery?.scope === "full_image" ||
                resolveResultSize(observed.config.quality, "1:1") !== resolveResultSize("4k", "1:1") ||
                run.tasks.some((task) => task.childTasks?.some((child) => child.id === observed.id) && resolveResultSize(task.quality, "1:1") !== resolveResultSize("4k", "1:1")))),
    );
    if (!observed.resultProcessing) {
        if (globalScene) throw new ImageProcessingInputError("技术验收缺少原全局场景结果完成阶段", 409);
        if (productResult) throw new ImageProcessingInputError("技术验收缺少原商品结果完成阶段", 409);
        return;
    }
    if (!localScene && !productResult && !globalScene) return;
    const reference = observed.resultProcessing;
    const processing = run.ecommerceSnapshot?.processing;
    const ids = [
        run.id,
        observed.id,
        reference.jobId,
        ...(processing?.sceneSelection ? [processing.sceneSelection.prepare.jobId] : []),
        ...(processing?.protection ? [processing.protection.jobId] : []),
        ...(globalScene ? (processing?.prepareReferences || []).map((item) => item.jobId) : []),
        ...(productResult
            ? (processing?.prepareReferences || [])
                  .filter((item) => item.assetId === observed.productProtection?.sourceAssetId || (observed.productProtection?.maskProvider === "local-edit-target.v1" && item.assetId === observed.productProtection.productAnchorId))
                  .map((item) => item.jobId)
            : []),
    ];
    const { records, now } = await readCompletedImageResultRecords(ids);
    const original = records.find((record) => record.type === "image" && record.id === observed.id);
    const stage = records.find((record) => record.type === "image_processing" && record.id === reference.jobId);
    const parent = records.find((record) => record.type === "agent" && record.id === run.id);
    if (!original || !stage || !parent) throw new ImageProcessingInputError("技术验收缺少原图片、Run或已完成结果阶段", 404);
    const image = original.payload as ImageTask;
    const currentRun = parent.payload as AgentRun;
    const payload = stage.payload as ImageProcessingPayload;
    if (
        original.status !== "success" ||
        image.status !== "success" ||
        parent.userId !== run.userId ||
        currentRun.id !== run.id ||
        currentRun.userId !== run.userId ||
        original.userId !== run.userId ||
        image.userId !== run.userId ||
        image.id !== observed.id ||
        image.runId !== run.id ||
        original.runId !== run.id ||
        image.parentTaskId !== run.id ||
        original.parentTaskId !== run.id ||
        imageTaskResultSourceIdentityDigest(image) !== imageTaskResultSourceIdentityDigest(observed) ||
        !isDeepStrictEqual(image.nativeResults, observed.nativeResults) ||
        !isDeepStrictEqual(image.resultProcessing, observed.resultProcessing) ||
        payload.operation !== "process_result" ||
        (payload.options.mode !== "scene_protection" && payload.options.mode !== "ordinary") ||
        !payload.imageResultBinding ||
        payload.version !== "image-processing.v1" ||
        payload.algorithmVersion !== ALGORITHM_VERSION ||
        stage.status !== "success" ||
        stage.executionPhase !== "completed" ||
        stage.userId !== run.userId ||
        stage.runId !== run.id ||
        stage.parentTaskId !== image.id ||
        image.resultProcessing?.jobId !== stage.id ||
        image.resultProcessing.inputDigest !== payload.inputDigest ||
        stage.id !== `image-process-${payload.inputDigest}`
    )
        throw new ImageProcessingInputError("已完成场景结果的原任务或阶段绑定已变化", 409);
    const options = payload.options;
    if ((productResult || globalScene) !== (options.mode === "ordinary") || (productResult && !isNativeProductImageTaskResult(image)) || (globalScene && !isNativeGlobalSceneImageTaskResult(image)))
        throw new ImageProcessingInputError("已完成结果与原处理范围不符", 409);
    const requested: ResultProcessingPayload = { ...payload, imageResultBinding: payload.imageResultBinding };
    const binding = requested.imageResultBinding;
    const task = currentRun.tasks.find((item) => item.id === binding.run?.agentTaskId);
    if (
        !matchesImageBinding(original, binding) ||
        binding.userId !== run.userId ||
        binding.imageTaskId !== image.id ||
        binding.run?.runId !== run.id ||
        !task ||
        !task.taskIds?.includes(image.id) ||
        task.childTasks?.filter((child) => child.id === image.id && child.attempt === binding.run?.agentAttempt).length !== 1 ||
        !isDeepStrictEqual(task.sceneProtection, image.sceneProtection) ||
        !isDeepStrictEqual(task.ecommerceExecution, image.ecommerceExecution)
    )
        throw new ImageProcessingInputError("已完成场景结果的原Run、copy或attempt关联已变化", 409);
    let completion: CompletedResultInput;
    try {
        assertResultReference(image, requested);
        completion = completedResultInput(stage, requested);
    } catch (error) {
        throw new ImageProcessingInputError("已完成场景结果的原件或完成回执已变化", 409, { cause: error });
    }
    const manifest = completion.manifest;
    const stored = binding.nativeResults.slots.filter((slot): slot is StoredNativeSlot => slot.status === "stored");
    const expectedOptions = imageTaskResultOptions(
        image,
        stored.map((slot, inputIndex) => ({ resultId: slot.resultId, resultIndex: slot.resultIndex, inputIndex })),
    );
    if (!isDeepStrictEqual(expectedOptions, options) || manifest.sourceIdentities.length !== requested.inputs.length || !isDeepStrictEqual(manifest.geometry, options.mode === "ordinary" ? {} : { sourceSize: options.protection.sourceSize }))
        throw new ImageProcessingInputError("已完成场景结果的原生槽位或源图几何已变化", 409);
    for (const [index, native] of stored.entries()) {
        const source = manifest.sourceIdentities[index];
        const input = requested.inputs[index];
        const location = requested.sources.find((item) => item.inputIndex === index);
        if (
            !source ||
            source.decodeError ||
            !input ||
            source.assetId !== native.assetId ||
            source.assetVersion !== native.assetVersion ||
            source.sha256 !== native.sha256 ||
            source.bytes !== native.bytes ||
            input.expectedSha256 !== native.sha256 ||
            input.assetId !== native.assetId ||
            input.assetVersion !== native.assetVersion ||
            !location ||
            location.storageKey !== native.storageKey ||
            location.scope !== native.scope ||
            location.storageProvider !== native.storageProvider ||
            location.externalStorageId !== native.externalStorageId
        )
            throw new ImageProcessingInputError("已完成场景结果的原生文件身份已变化", 409);
    }
    for (const result of manifest.results) if (!result.error) assertResultModeEvidence(requested.options, manifest, result, manifest.artifacts[result.finalArtifactIndex]);
    const build = records.find((record) => record.type === "image_processing" && record.id === processing?.protection?.jobId);
    const buildPayload = build?.payload as ImageProcessingPayload | undefined;
    const buildManifest = build?.resultPayload?.manifest as ImageProcessingManifest | undefined;
    const keys = [
        ...requested.sources.map((source) => source.storageKey),
        ...manifest.artifacts.map((artifact) => artifact.storageKey),
        ...(globalScene || (productResult && image.productProtection?.maskProvider === "local-edit-target.v1")
            ? records
                  .filter((record) => record.type === "image_processing" && processing?.prepareReferences.some((reference) => reference.jobId === record.id))
                  .flatMap((record) => (record.payload as ImageProcessingPayload).sources.map((source) => source.storageKey))
            : []),
        ...(productResult ? [...(buildPayload?.sources.map((source) => source.storageKey) || []), ...(buildManifest?.artifacts.map((artifact) => artifact.storageKey) || [])] : []),
    ];
    const registrations = await getLocalMediaRegistrations(keys, { ownerUserId: run.userId });
    try {
        assertResultRegistrations(requested, registrations, now);
        assertCompletedResultRegistrations(stage, manifest, registrations, now, true);
    } catch (error) {
        throw new ImageProcessingInputError("已完成场景结果的原件或成图登记已变化", 409, { cause: error });
    }
    if (options.mode === "scene_protection" && isNativeSceneImageTaskResult(image)) {
        const scene = await readCompletedEcommerceSceneProtection(currentRun, undefined, { records, registrations, now, completedResult: true });
        assertNativeSceneResultBaseline(image, scene);
        if (!isDeepStrictEqual(image.sceneProtection, scene.sceneProtection) || !isDeepStrictEqual(image.mask, scene.sceneProtection.mask) || !isDeepStrictEqual(image.ecommerceExecution, scene.execution))
            throw new ImageProcessingInputError("已完成场景结果与原prepare、build或确认记录不符", 409);
        for (const [index, key, digest, bytes] of [
            [options.sourceInputIndex, scene.stage.payload.sources[0].storageKey, scene.source.sha256, scene.source.bytes],
            [options.maskInputIndex, scene.mask.storageKey, scene.mask.sha256, scene.mask.bytes],
        ] as const) {
            const source = requested.sources.find((item) => item.inputIndex === index);
            const fact = requested.resource.facts.encodedInputs.find((item) => item.inputIndex === index);
            if (!source || source.storageKey !== key || source.frozenResultSource || !fact || fact.sha256 !== digest || fact.bytes !== bytes) throw new ImageProcessingInputError("已完成场景结果的原build源图或蒙版绑定已变化", 409);
        }
    }
    const { results: canonical, batchEvidence } = completedImageResults(image, completion, requested);
    if (!isDeepStrictEqual(image.result?.results, canonical) || ((productResult || globalScene) && !isDeepStrictEqual(image.result?.batchEvidence, batchEvidence))) throw new ImageProcessingInputError("已发布场景结果与原完成槽位不符", 409);
    const result = manifest.results.find((slot) => slot.resultId === resultId);
    const media = canonical.find((item) => item.resultId === resultId);
    if (!result || result.error || !media?.canvasEvidence) throw new ImageProcessingInputError("技术验收缺少原完成结果槽位或画幅事实", 409);
    if (options.mode === "ordinary") {
        let baseline: { source: { assetId: string; width: number; height: number }; url: string };
        if (globalScene) {
            const scene = await readCompletedEcommerceGlobalScene(currentRun, image, { records, registrations, now, completedResult: true });
            for (const reference of scene.references) await readImageProcessingMediaFacts(reference.registration, reference.source);
            baseline = { source: scene.baseline.source, url: imageTaskResultReferenceUrl(image.references[0]) };
        } else {
            const product = await readCompletedEcommerceProductProtection(currentRun, { records, registrations, now, completedResult: true });
            assertNativeProductResultSource(currentRun, image, product);
            if (product.maskRegistration.storageClass !== "permanent" || product.maskRegistration.expiresAt !== undefined) throw new ImageProcessingInputError("技术验收原商品蒙版没有永久保留", 409);
            for (const reference of product.references) await readImageProcessingMediaFacts(reference.registration, reference.source);
            await readImageProcessingMediaFacts(product.maskRegistration, product.mask);
            const source = image.references.find((item) => item.id === product.source.assetId);
            if (!source) throw new ImageProcessingInputError("技术验收原商品参考缺失", 409);
            baseline = { source: product.source, url: imageTaskResultReferenceUrl(source) };
        }
        const native = manifest.sourceIdentities[result.nativeInputIndex];
        const final = manifest.artifacts[result.finalArtifactIndex];
        if (native.decodeError) throw new ImageProcessingInputError("技术验收原生结果没有完成解码事实", 409);
        const location = requested.sources.find((item) => item.inputIndex === result.nativeInputIndex);
        const nativeRegistration = registrations.find((item) => item.storageKey === location?.storageKey);
        const finalRegistration = registrations.find((item) => item.storageKey === final.storageKey);
        if (!nativeRegistration || !finalRegistration || finalRegistration.storageClass !== "permanent" || finalRegistration.expiresAt !== undefined) throw new ImageProcessingInputError("技术验收原生结果媒体没有永久保留", 409);
        await readImageProcessingMediaFacts(nativeRegistration, native);
        await readImageProcessingMediaFacts(finalRegistration, final);
        return {
            kind: globalScene ? "global_scene" : "product",
            resultId,
            url: media.serverUrl || media.dataUrl,
            nativeUrl: media.canvasEvidence.nativeUrl,
            sourceAssetId: baseline.source.assetId,
            sourceUrl: originalImageSourceUrl(baseline.url),
            sourceSize: { width: baseline.source.width, height: baseline.source.height },
            nativeSize: { width: native.width, height: native.height },
            storedSize: { width: final.width, height: final.height },
        };
    }
    if (!media.sceneProtectionEvidence) throw new ImageProcessingInputError("技术验收缺少原场景保护事实", 409);
    const source = manifest.sourceIdentities[options.sourceInputIndex];
    const mask = manifest.sourceIdentities[options.maskInputIndex];
    const native = manifest.sourceIdentities[result.nativeInputIndex];
    const final = manifest.artifacts[result.finalArtifactIndex];
    if (source.decodeError || mask.decodeError || native.decodeError) throw new ImageProcessingInputError("技术验收原场景输入没有完成解码事实", 409);
    if (
        source.assetId !== options.protection.sourceAssetId ||
        source.sha256 !== options.protection.sourceDigest ||
        mask.sha256 !== options.protection.maskDigest ||
        mask.mimeType !== "image/png" ||
        source.width !== options.protection.sourceSize.width ||
        source.height !== options.protection.sourceSize.height ||
        mask.width !== source.width ||
        mask.height !== source.height
    )
        throw new ImageProcessingInputError("技术验收源图或蒙版与冻结保护事实不符", 409);
    for (const [index, expected] of [
        [options.sourceInputIndex, source],
        [options.maskInputIndex, mask],
        [result.nativeInputIndex, native],
    ] as const) {
        const location = requested.sources.find((item) => item.inputIndex === index);
        const registration = registrations.find((item) => item.storageKey === location?.storageKey);
        if (!registration) throw new ImageProcessingInputError("技术验收原件登记不存在", 409);
        if (index === options.maskInputIndex && (registration.storageClass !== "permanent" || registration.expiresAt !== undefined)) throw new ImageProcessingInputError("技术验收原蒙版没有永久保留", 409);
        await readImageProcessingMediaFacts(registration, expected);
    }
    const finalRegistration = registrations.find((item) => item.storageKey === final.storageKey);
    if (!finalRegistration || finalRegistration.storageClass !== "permanent" || finalRegistration.expiresAt !== undefined) throw new ImageProcessingInputError("技术验收原成图没有永久保留", 409);
    await readImageProcessingMediaFacts(finalRegistration, final);
    return {
        kind: "scene",
        resultId,
        url: media.serverUrl || media.dataUrl,
        nativeUrl: media.canvasEvidence.nativeUrl,
        sourceAssetId: source.assetId,
        sourceUrl: originalImageSourceUrl(imageTaskResultReferenceUrl(image.references[0])),
        sourceSize: { width: source.width, height: source.height },
        nativeSize: { width: native.width, height: native.height },
        storedSize: { width: final.width, height: final.height },
        sceneProtectionEvidence: media.sceneProtectionEvidence,
    };
}

async function readCompletedImageResultRecords(ids: string[]): Promise<{ records: StoredGenerationTaskRecord[]; now: number }> {
    if (getDatabaseProvider() !== "postgres") return withGenerationTaskFileRead(async (records) => ({ records: records.filter((record) => ids.includes(record.id)), now: Date.now() }));
    await ensurePostgresSchema();
    type Row = Omit<StoredGenerationTaskRecord, "runId" | "parentTaskId" | "conversationId" | "surface" | "projectId" | "upstreamTaskId" | "clientRequestId" | "attemptNo" | "executionPhase" | "resultPayload"> & {
        runId: string | null;
        parentTaskId: string | null;
        conversationId: string | null;
        surface: StoredGenerationTaskRecord["surface"] | null;
        projectId: string | null;
        upstreamTaskId: string | null;
        clientRequestId: string | null;
        attemptNo: number | null;
        executionPhase: StoredGenerationTaskRecord["executionPhase"] | null;
        resultPayload: StoredGenerationTaskRecord["resultPayload"] | null;
        now: number;
    };
    // Read persisted completion facts even after their scheduling TTL; purged records remain unavailable.
    const { rows } = await postgresQuery<Row>(
        `SELECT id, task_type AS type, user_id AS "userId", status, payload,
        (EXTRACT(EPOCH FROM created_at) * 1000)::double precision AS "createdAt", (EXTRACT(EPOCH FROM updated_at) * 1000)::double precision AS "updatedAt", (EXTRACT(EPOCH FROM expires_at) * 1000)::double precision AS "expiresAt",
        run_id AS "runId", parent_task_id AS "parentTaskId", conversation_id AS "conversationId", surface, project_id AS "projectId", upstream_task_id AS "upstreamTaskId", client_request_id AS "clientRequestId", attempt_no AS "attemptNo", execution_phase AS "executionPhase", result_payload AS "resultPayload", (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::double precision AS now
        FROM generation_tasks WHERE id = ANY($1::text[])`,
        [ids],
    );
    if (!rows.length) throw new ImageProcessingInputError("技术验收原任务不存在", 404);
    return {
        records: rows.map((row) => ({
            ...row,
            runId: row.runId ?? undefined,
            parentTaskId: row.parentTaskId ?? undefined,
            conversationId: row.conversationId ?? undefined,
            surface: row.surface ?? undefined,
            projectId: row.projectId ?? undefined,
            upstreamTaskId: row.upstreamTaskId ?? undefined,
            clientRequestId: row.clientRequestId ?? undefined,
            attemptNo: row.attemptNo ?? undefined,
            executionPhase: row.executionPhase ?? undefined,
            resultPayload: row.resultPayload ?? undefined,
        })),
        now: rows[0].now,
    };
}

async function nativeResultPostgresNow(image: ImageTask) {
    if (getDatabaseProvider() !== "postgres" || (!isNativeSceneImageTaskResult(image) && !isNativeProductImageTaskResult(image) && !isNativeGlobalSceneImageTaskResult(image))) return;
    const clock = await postgresQuery<{ now: Date }>("SELECT clock_timestamp() AS now");
    return clock.rows[0].now.getTime();
}

export async function ensureImageTaskResultProcessing(_input: ImageTaskResultProcessingInput): Promise<ImageTaskResultProcessingOutcome> {
    const original = await getStoredGenerationTaskRecord("image", _input.taskId);
    if (!original || !matchesImageClaim(original, _input, original.userId, await nativeResultPostgresNow(original.payload as ImageTask))) return { state: "ownership_lost" };
    const image = original.payload as ImageTask;
    assertResultImage(image, original.runId);
    if (!image.nativeResults) throw new Error("Not implemented: result processing before native sealing");
    if ((original.runId || undefined) !== image.runId) return { state: "ownership_lost" };
    const run = await readImageResultRun(image.runId);
    const runNow = await nativeResultPostgresNow(image);
    const runBinding = image.runId ? imageResultRunBinding(run, image, runNow ?? Date.now()) : undefined;
    if (image.runId && !runBinding) {
        if (!canWaitForImageResultRun(run, image, runNow ?? Date.now())) return { state: "ownership_lost" };
        const released = await releaseGenerationTaskLease(
            "image",
            image.id,
            _input.workerId,
            {
                executionPhase: "persisting",
                nextPollAt: generationTaskNextPollAt({ submittedAt: original.submittedAt || image.createdAt }),
                lastUpstreamStatus: "image_processing_run_link_waiting",
            },
            { executionId: _input.executionId },
        );
        return { state: released ? "waiting_for_run" : "ownership_lost" };
    }
    const binding = { imageTaskId: image.id, userId: image.userId, nativeResults: image.nativeResults, ...(runBinding ? { run: runBinding } : {}) };
    if (!matchesImageBinding(original, binding)) return { state: "ownership_lost" };
    try {
        const payload = await resultProcessingPayload(original, binding);
        if (getDatabaseProvider() === "postgres") return await enqueuePostgresResult(_input, payload, image);
        return await withGenerationTaskFileMutation<ImageTaskResultProcessingOutcome>(async (records) => {
            const current = records.find((record) => record.id === _input.taskId);
            const run = fileImageResultRun(records, payload.imageResultBinding.run?.runId);
            if (!current || !matchesImageClaim(current, _input, image.userId) || !matchesImageBinding(current, payload.imageResultBinding)) throw new ImageResultOwnershipLost();
            if (!isDeepStrictEqual(imageTaskResultSourceIdentity(current.payload as ImageTask), imageTaskResultSourceIdentity(image)) || !isDeepStrictEqual(current.payload.resultProcessing, image.resultProcessing)) throw new ImageResultOwnershipLost();
            assertResultImage(current.payload as ImageTask, current.runId);
            assertResultRun(run, current.payload as ImageTask, payload, Date.now());
            assertResultReference(current.payload as ImageTask, payload);
            const scene = await readNativeImageResultEvidence(run, current.payload as ImageTask, payload, records);
            const registrations = scene?.registrations || (await readResultRegistrations(payload));
            if (!matchesImageClaim(current, _input, image.userId, Date.now()) || !matchesImageBinding(current, payload.imageResultBinding)) throw new ImageResultOwnershipLost();
            assertResultRun(run, current.payload as ImageTask, payload, Date.now());
            scene?.check(Date.now(), registrations);
            assertResultRegistrations(payload, registrations);
            const id = `image-process-${payload.inputDigest}`;
            const existing = records.find((record) => record.id === id);
            if (existing && existing.status === "success") {
                assertResultStageBinding({ ...existing, unexpired: existing.expiresAt > Date.now() }, payload);
                const completion = completedResultInput(existing, payload);
                const finalRegistrations = await getLocalMediaRegistrations(
                    completion.manifest.artifacts.map((artifact) => artifact.storageKey),
                    { ownerUserId: image.userId },
                );
                const now = Date.now();
                if (!matchesImageClaim(current, _input, image.userId, now) || !matchesImageBinding(current, payload.imageResultBinding)) throw new ImageResultOwnershipLost();
                assertResultStageBinding({ ...existing, unexpired: existing.expiresAt > now }, payload);
                assertResultRun(run, current.payload as ImageTask, payload, now);
                assertCompletedResultRegistrations(existing, completion.manifest, finalRegistrations, now, true);
                throw new ImageResultReady();
            }
            if (existing) assertReusableResultStage({ ...existing, unexpired: existing.expiresAt > Date.now() }, payload);
            const unavailable = existing ? (existing.payload as ResultProcessingPayload).resource.unavailable : payload.resource.unavailable;
            const now = Date.now();
            if (!matchesImageClaim(current, _input, image.userId, now)) throw new ImageResultOwnershipLost();
            assertResultRun(run, current.payload as ImageTask, payload, now);
            const child: StoredGenerationTaskRecord = existing || {
                id,
                type: "image_processing",
                userId: current.userId,
                parentTaskId: current.id,
                ...(payload.imageResultBinding.run ? { runId: payload.imageResultBinding.run.runId } : {}),
                status: unavailable ? "paused" : "pending",
                executionPhase: unavailable ? "needs_review" : "created",
                attemptNo: 0,
                clientRequestId: payload.inputDigest,
                payload,
                createdAt: now,
                updatedAt: now,
                expiresAt: current.expiresAt,
                conversationId: current.conversationId,
                surface: current.surface,
                projectId: current.projectId,
                nextPollAt: unavailable ? undefined : now,
                lastUpstreamStatus: unavailable?.code || "created",
            };
            const updated: StoredGenerationTaskRecord = {
                ...current,
                status: "running",
                payload: waitingImage(current.payload as ImageTask, payload, now),
                ...(unavailable ? { resultPayload: { ...current.resultPayload, reviewReason: imageResultResourceReason } } : {}),
                updatedAt: now,
                executionPhase: unavailable ? "needs_review" : "persisting",
                nextPollAt: undefined,
                workerId: undefined,
                leaseUntil: undefined,
                lastHeartbeatAt: undefined,
                lastUpstreamStatus: unavailable?.code || "image_processing_waiting",
            };
            return { tasks: [...records.filter((record) => record.id !== current.id && record.id !== id), updated, child], result: { state: "waiting" } };
        });
    } catch (error) {
        if (error instanceof ImageResultOwnershipLost) return { state: "ownership_lost" };
        if (error instanceof ImageResultReady) return { state: "ready" };
        throw error;
    }
}

export async function consumeCompletedImageTaskResultProcessing(input: ImageTaskResultProcessingInput): Promise<{ state: "completed" | "ownership_lost" }> {
    const original = await getStoredGenerationTaskRecord("image", input.taskId);
    if (!original || !matchesImageClaim(original, input, original.userId, await nativeResultPostgresNow(original.payload as ImageTask))) return { state: "ownership_lost" };
    const originalImage = original.payload as ImageTask;
    assertResultImage(originalImage, original.runId);
    if (!originalImage.nativeResults) throw new Error("Image result consumption requires sealed native input");
    if (!originalImage.resultProcessing) return { state: "ownership_lost" };
    const runBinding = originalImage.runId ? imageResultRunBinding(await readImageResultRun(originalImage.runId), originalImage, (await nativeResultPostgresNow(originalImage)) ?? Date.now()) : undefined;
    if (originalImage.runId && !runBinding) return { state: "ownership_lost" };
    try {
        const requested = await resultProcessingPayload(original, { imageTaskId: originalImage.id, userId: originalImage.userId, nativeResults: originalImage.nativeResults, ...(runBinding ? { run: runBinding } : {}) });
        if (getDatabaseProvider() === "postgres") return await consumePostgresCompletedResult(input, originalImage, requested);
        // Creative mutations already acquire the task lock in this order.
        return await queueRuntimeFileOperation(() =>
            withGenerationTaskFileMutation(async (records) => {
                const current = records.find((record) => record.id === input.taskId);
                const stage = records.find((record) => record.id === `image-process-${requested.inputDigest}`);
                const run = fileImageResultRun(records, requested.imageResultBinding.run?.runId);
                if (!current || !stage || stage.status !== "success") throw new ImageResultOwnershipLost();
                const guard = (evidence?: Awaited<ReturnType<typeof readNativeImageResultEvidence>>) => {
                    const now = Date.now();
                    evidence?.check(now);
                    if (!matchesImageClaim(current, input, original.userId, now) || !matchesImageBinding(current, requested.imageResultBinding)) throw new ImageResultOwnershipLost();
                    assertResultImage(current.payload as ImageTask, current.runId);
                    assertResultRun(run, current.payload as ImageTask, requested, now);
                    assertResultReference(current.payload as ImageTask, requested);
                    if (!isDeepStrictEqual(current.payload.resultProcessing, { jobId: stage.id, inputDigest: requested.inputDigest })) throw new ImageResultOwnershipLost();
                    assertResultStageBinding({ ...stage, unexpired: stage.expiresAt > now }, requested);
                };
                guard();
                const completion = completedResultInput(stage, requested);
                const scene = await readNativeImageResultEvidence(
                    run,
                    current.payload as ImageTask,
                    requested,
                    records,
                    completion.manifest.artifacts.map((artifact) => artifact.storageKey),
                );
                const fullGuard = () => guard(scene);
                const registrations =
                    scene?.registrations || (await getLocalMediaRegistrations([...requested.sources.map((source) => source.storageKey), ...completion.manifest.artifacts.map((artifact) => artifact.storageKey)], { ownerUserId: original.userId }));
                fullGuard();
                assertResultRegistrations(requested, registrations);
                assertCompletedResultRegistrations(stage, completion.manifest, registrations, Date.now(), true);
                const finalKeys = new Set(completion.manifest.artifacts.map((artifact) => artifact.storageKey));
                if (scene && "maskRegistration" in scene && scene.maskRegistration.storageClass === "temporary") {
                    await promoteFileLocalMediaAssets([scene.maskRegistration], fullGuard);
                    const index = registrations.findIndex((registration) => registration.storageKey === scene.mask.storageKey);
                    registrations[index] = { ...scene.maskRegistration, storageClass: "permanent", expiresAt: undefined };
                }
                await promoteFileLocalMediaAssets(
                    registrations.filter((registration) => finalKeys.has(registration.storageKey)),
                    fullGuard,
                );
                fullGuard();
                const image = current.payload as ImageTask;
                const { results, batchEvidence } = completedImageResults(image, completion, requested);
                const finalResult = results[0];
                if (!finalResult) throw new Error("Completed image result processing has no successful final");
                const logged = await writeImageGenerationLog(image, "success", results, Date.now() - image.createdAt, undefined, fullGuard);
                fullGuard();
                if (!logged.log) throw new Error("Completed image result generation log was not saved");
                if (image.conversationId) {
                    const runtime = await readRuntimeFile();
                    fullGuard();
                    await registerGenerationTaskAssetsForUser(
                        image.userId,
                        {
                            ...image,
                            taskId: image.id,
                            title: image.title || image.prompt.slice(0, 80),
                            assets: results.map((result) => ({ type: "image", url: result.dataUrl, mimeType: result.mimeType, width: result.width, height: result.height, bytes: result.bytes })),
                        },
                        runtime,
                    );
                    fullGuard();
                    await writeRuntimeFile(runtime);
                }
                const finalRegistrations = await getLocalMediaRegistrations(scene ? scene.registrations.map((registration) => registration.storageKey) : [...requested.sources.map((source) => source.storageKey), ...finalKeys], {
                    ownerUserId: image.userId,
                });
                fullGuard();
                scene?.check(Date.now(), finalRegistrations);
                if (scene && "mask" in scene && !finalRegistrations.some((registration) => registration.storageKey === scene.mask.storageKey && registration.storageClass === "permanent" && registration.expiresAt === undefined))
                    throw new Error("Original native scene mask was not retained");
                assertResultRegistrations(requested, finalRegistrations);
                assertCompletedResultRegistrations(stage, completion.manifest, finalRegistrations, Date.now(), true);
                if (finalRegistrations.some((registration) => finalKeys.has(registration.storageKey) && (registration.storageClass !== "permanent" || registration.expiresAt !== undefined))) throw new Error("Completed image result final was not retained");
                const now = Date.now();
                fullGuard();
                const attempts = finishGenerationAttempt(image.attempts || [], image.attemptNo || image.attempts?.at(-1)?.attemptNo || 1, { status: "succeeded", pointsCost: image.billing?.pointsCost, pointsRecordId: image.billing?.pointsRecordId });
                const published: ImageTask = {
                    ...image,
                    status: "success",
                    result: { ...finalResult, results, ...(batchEvidence ? { batchEvidence } : {}) },
                    retryable: false,
                    config: { ...image.config, apiKey: "system" },
                    candidateConfigs: [],
                    attempts,
                    attemptNo: attempts.at(-1)?.attemptNo,
                    updatedAt: now,
                };
                await enqueueImageEnhancement(published);
                fullGuard();
                const updated: StoredGenerationTaskRecord = {
                    ...current,
                    status: "success",
                    payload: published,
                    updatedAt: now,
                    expiresAt: now + GENERATION_TASK_RETENTION_MS,
                    executionPhase: "completed",
                    nextPollAt: undefined,
                    workerId: undefined,
                    leaseUntil: undefined,
                    lastHeartbeatAt: undefined,
                    lastUpstreamStatus: "persisted",
                };
                return { tasks: records.map((record) => (record.id === current.id ? updated : record)), result: { state: "completed" as const } };
            }),
        );
    } catch (error) {
        if (error instanceof ImageResultOwnershipLost) return { state: "ownership_lost" };
        throw error;
    }
}

async function consumePostgresCompletedResult(input: ImageTaskResultProcessingInput, originalImage: ImageTask, requested: ResultProcessingPayload): Promise<{ state: "completed" }> {
    const binding = requested.imageResultBinding;
    const reference = { jobId: `image-process-${requested.inputDigest}`, inputDigest: requested.inputDigest };
    const parameters = [
        input.taskId,
        binding.userId,
        input.workerId,
        input.executionId,
        binding.nativeResults.attemptNo,
        binding.nativeResults.upstreamTaskId,
        JSON.stringify(binding.nativeResults),
        originalImage.conversationId ?? null,
        JSON.stringify(reference),
    ];
    const claimWhere = `${IMAGE_RESULT_CLAIM_WHERE}
        AND conversation_id IS NOT DISTINCT FROM $8::text
        AND payload ->> 'conversationId' IS NOT DISTINCT FROM $8::text
        AND payload -> 'resultProcessing' = $9::jsonb`;
    return withPostgresTransaction(async (executor) => {
        // Conversation deletion locks its conversation before tasks.
        if (originalImage.conversationId) {
            const conversation = await executor.query("SELECT id FROM creative_conversations WHERE id = $1 AND user_id = $2 FOR UPDATE", [originalImage.conversationId, binding.userId]);
            if (!conversation.rows[0]) throw new ImageResultOwnershipLost();
        }
        const run = await readImageResultRun(binding.run?.runId, executor, true);
        const locked = await executor.query<LockedImage>(
            `SELECT payload, expires_at, clock_timestamp() AS server_now, conversation_id, surface, project_id
             FROM generation_tasks WHERE ${claimWhere} FOR UPDATE`,
            parameters,
        );
        const current = locked.rows[0];
        if (!current) throw new ImageResultOwnershipLost();
        const image = current.payload;
        assertResultImage(image);
        assertResultRun(run, image, requested, current.server_now.getTime());
        assertResultReference(image, requested);
        if (current.surface !== (image.surface ?? null) || current.project_id !== (image.projectId ?? null) || image.surface !== originalImage.surface || image.projectId !== originalImage.projectId) throw new ImageResultOwnershipLost();
        const children = await executor.query<ResultStage>(
            `SELECT id, task_type AS type, user_id AS "userId", status, payload,
                    execution_phase AS "executionPhase", result_payload AS "resultPayload",
                    parent_task_id AS "parentTaskId", run_id AS "runId", expires_at > clock_timestamp() AS unexpired
             FROM generation_tasks WHERE id = $1 FOR UPDATE`,
            [reference.jobId],
        );
        const closed = children.rows[0];
        if (!closed || closed.status !== "success") throw new ImageResultOwnershipLost();
        const stage = { ...closed, runId: closed.runId ?? undefined };
        assertResultStageBinding(stage, requested);
        const completion = completedResultInput(stage, requested);
        const finalKeys = Array.from(new Set(completion.manifest.artifacts.map((artifact) => artifact.storageKey)));
        const scene = await readNativeImageResultEvidence(run, image, requested, executor, finalKeys);
        const keys = scene ? scene.registrations.map((registration) => registration.storageKey) : [...requested.sources.map((source) => source.storageKey), ...finalKeys];
        const registrations = scene?.registrations || (await getLocalMediaRegistrations(keys, { ownerUserId: image.userId, executor, forUpdate: true }));
        const ownedWhere = `${claimWhere} AND payload = $10::jsonb
            AND EXISTS (SELECT 1 FROM generation_tasks AS child
                        WHERE child.id = $11 AND child.task_type = 'image_processing' AND child.user_id = $2
                          AND child.parent_task_id = $1 AND child.run_id IS NOT DISTINCT FROM generation_tasks.run_id
                          AND child.status = 'success' AND child.execution_phase = 'completed'
                          AND child.expires_at > clock_timestamp() AND child.payload = $12::jsonb AND child.result_payload = $13::jsonb)`;
        const ownedParameters = [...parameters, JSON.stringify(image), stage.id, JSON.stringify(stage.payload), JSON.stringify(stage.resultPayload)];
        const checked = await executor.query<{ server_now: Date }>(`SELECT clock_timestamp() AS server_now FROM generation_tasks WHERE ${ownedWhere}`, ownedParameters);
        const observed = checked.rows[0];
        if (!observed) throw new ImageResultOwnershipLost();
        assertResultRun(run, image, requested, observed.server_now.getTime());
        scene?.check(observed.server_now.getTime(), registrations);
        assertResultRegistrations(requested, registrations, scene ? observed.server_now.getTime() : undefined);
        assertCompletedResultRegistrations(stage, completion.manifest, registrations, observed.server_now.getTime());
        if (scene && "maskRegistration" in scene && scene.maskRegistration.storageClass === "temporary") {
            const mask = scene.maskRegistration;
            const retained = await executor.query(
                `UPDATE local_media_assets SET storage_class = 'permanent', expires_at = NULL
                 WHERE storage_key = $1 AND owner_user_id = $2 AND source = 'image-processing-mask'
                   AND task_id = $3 AND run_id = $4 AND scope = 'reference' AND type = 'image'
                   AND mime_type = $5 AND bytes = $6 AND COALESCE(storage_provider, 'local') = $7
                   AND external_storage_id IS NOT DISTINCT FROM $8::text AND external_object_key IS NOT DISTINCT FROM $9::text
                   AND storage_class = 'temporary' AND (expires_at IS NULL OR expires_at > clock_timestamp()) RETURNING storage_key`,
                [mask.storageKey, image.userId, scene.stage.id, image.runId, mask.mimeType, mask.bytes, mask.storageProvider || "local", mask.externalStorageId ?? null, mask.externalObjectKey ?? null],
            );
            if (retained.rowCount !== 1) throw new Error("Original native scene mask changed before retention");
        }
        const promoted = await executor.query(
            `UPDATE local_media_assets SET storage_class = 'permanent', expires_at = NULL
             WHERE storage_key = ANY($1::text[]) AND owner_user_id = $2 AND task_id = $3
               AND scope = 'reference' AND type = 'image' AND storage_class = 'temporary'
               AND (expires_at IS NULL OR expires_at > clock_timestamp())
             RETURNING storage_key`,
            [finalKeys, image.userId, stage.id],
        );
        if (promoted.rowCount !== finalKeys.length) throw new Error("Image result artifact expired before promotion");
        const { results, batchEvidence } = completedImageResults(image, completion, requested);
        const finalResult = results[0];
        if (!finalResult) throw new Error("Completed image result processing has no successful final");
        const logged = await writeImageGenerationLog(image, "success", results, observed.server_now.getTime() - image.createdAt, undefined, undefined, executor);
        if (!logged.log) throw new Error("Completed image result generation log was not saved");
        if (image.conversationId) {
            await registerGenerationTaskAssetsForUser(
                image.userId,
                {
                    ...image,
                    taskId: image.id,
                    title: image.title || image.prompt.slice(0, 80),
                    assets: results.map((result) => ({ type: "image", url: result.dataUrl, mimeType: result.mimeType, width: result.width, height: result.height, bytes: result.bytes })),
                },
                undefined,
                executor,
            );
        }
        const finalRegistrations = await getLocalMediaRegistrations(keys, { ownerUserId: image.userId, executor, forUpdate: true });
        const latest = await executor.query<{ server_now: Date }>(`SELECT clock_timestamp() AS server_now FROM generation_tasks WHERE ${ownedWhere}`, ownedParameters);
        const live = latest.rows[0];
        if (!live) throw new ImageResultOwnershipLost();
        assertResultRun(run, image, requested, live.server_now.getTime());
        scene?.check(live.server_now.getTime(), finalRegistrations);
        if (scene && "mask" in scene && !finalRegistrations.some((registration) => registration.storageKey === scene.mask.storageKey && registration.storageClass === "permanent" && registration.expiresAt === undefined))
            throw new Error("Original native scene mask was not retained");
        assertResultRegistrations(requested, finalRegistrations, scene ? live.server_now.getTime() : undefined);
        assertCompletedResultRegistrations(stage, completion.manifest, finalRegistrations, live.server_now.getTime(), true);
        if (finalRegistrations.some((registration) => finalKeys.includes(registration.storageKey) && (registration.storageClass !== "permanent" || registration.expiresAt !== undefined))) throw new Error("Completed image result final was not retained");
        const attempts = finishGenerationAttempt(image.attempts || [], image.attemptNo || image.attempts?.at(-1)?.attemptNo || 1, {
            status: "succeeded",
            completedAt: live.server_now.getTime(),
            pointsCost: image.billing?.pointsCost,
            pointsRecordId: image.billing?.pointsRecordId,
        });
        const published: ImageTask = {
            ...image,
            status: "success",
            result: { ...finalResult, results, ...(batchEvidence ? { batchEvidence } : {}) },
            retryable: false,
            config: { ...image.config, apiKey: "system" },
            candidateConfigs: [],
            attempts,
            attemptNo: attempts.at(-1)?.attemptNo,
            updatedAt: live.server_now.getTime(),
        };
        const saved = await executor.query<{ payload: ImageTask }>(
            `WITH publication_clock AS (SELECT clock_timestamp() AS now)
             UPDATE generation_tasks
             SET status = 'success',
                 payload = $14::jsonb || jsonb_build_object('updatedAt', floor(extract(epoch FROM publication_clock.now) * 1000)::bigint),
                 updated_at = publication_clock.now,
                 expires_at = publication_clock.now + $15::double precision * interval '1 millisecond',
                 execution_phase = 'completed', next_poll_at = NULL, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL,
                 last_upstream_status = 'persisted'
             FROM publication_clock WHERE ${ownedWhere} RETURNING payload`,
            [...ownedParameters, JSON.stringify(published), GENERATION_TASK_RETENTION_MS],
        );
        // A failed final owner check must roll back promotion, log and creative assets together.
        if (!saved.rows[0]) throw new ImageResultOwnershipLost();
        await enqueueImageEnhancement(saved.rows[0].payload, executor);
        return { state: "completed" as const };
    });
}

async function enqueuePostgresResult(input: ImageTaskResultProcessingInput, payload: ResultProcessingPayload, observedImage: ImageTask): Promise<ImageTaskResultProcessingOutcome> {
    const binding = payload.imageResultBinding;
    const parameters = [
        input.taskId,
        binding.userId,
        input.workerId,
        input.executionId,
        binding.nativeResults.attemptNo,
        binding.nativeResults.upstreamTaskId,
        JSON.stringify(binding.nativeResults),
        JSON.stringify(imageTaskResultSourceIdentity(observedImage)),
        observedImage.resultProcessing ? JSON.stringify(observedImage.resultProcessing) : null,
    ];
    const claimWhere = `${IMAGE_RESULT_CLAIM_WHERE}
        AND ${IMAGE_RESULT_SOURCE_IDENTITY_SQL} = $8::jsonb
        AND NULLIF(payload -> 'resultProcessing', 'null'::jsonb) IS NOT DISTINCT FROM $9::jsonb`;
    return withPostgresTransaction<ImageTaskResultProcessingOutcome>(async (executor) => {
        const run = await readImageResultRun(binding.run?.runId, executor, true);
        const locked = await executor.query<LockedImage>(
            `SELECT payload, expires_at, clock_timestamp() AS server_now, conversation_id, surface, project_id
             FROM generation_tasks WHERE ${claimWhere} FOR UPDATE`,
            parameters,
        );
        const current = locked.rows[0];
        if (!current) throw new ImageResultOwnershipLost();
        assertResultImage(current.payload);
        if (!matchesPayloadBinding(current.payload, binding)) throw new ImageResultOwnershipLost();
        assertResultRun(run, current.payload, payload, current.server_now.getTime());
        assertResultReference(current.payload, payload);
        const id = `image-process-${payload.inputDigest}`;
        const existing = await executor.query<ResultStage>(
            `SELECT id, task_type AS type, user_id AS "userId", status, payload,
                    execution_phase AS "executionPhase", result_payload AS "resultPayload",
                    parent_task_id AS "parentTaskId", run_id AS "runId", expires_at > clock_timestamp() AS unexpired
             FROM generation_tasks WHERE id = $1 FOR UPDATE`,
            [id],
        );
        const existingStage = existing.rows[0];
        if (existingStage && existingStage.status === "success") {
            const stage = { ...existingStage, runId: existingStage.runId ?? undefined };
            assertResultStageBinding(stage, payload);
            const completion = completedResultInput(stage, payload);
            const scene = await readNativeImageResultEvidence(
                run,
                current.payload,
                payload,
                executor,
                completion.manifest.artifacts.map((artifact) => artifact.storageKey),
            );
            const registrations =
                scene?.registrations ||
                (await getLocalMediaRegistrations([...payload.sources.map((source) => source.storageKey), ...completion.manifest.artifacts.map((artifact) => artifact.storageKey)], {
                    ownerUserId: binding.userId,
                    executor,
                    forUpdate: true,
                }));
            // Registry lock waits can expire the owner or child; recheck both with the database clock.
            const checked = await executor.query<{ server_now: Date; child_unexpired: boolean }>(
                `SELECT clock_timestamp() AS server_now,
                        EXISTS (SELECT 1 FROM generation_tasks AS child WHERE child.id = $10 AND child.expires_at > clock_timestamp()) AS child_unexpired
                 FROM generation_tasks WHERE ${claimWhere}`,
                [...parameters, id],
            );
            const latest = checked.rows[0];
            if (!latest) throw new ImageResultOwnershipLost();
            assertResultRun(run, current.payload, payload, latest.server_now.getTime());
            assertResultStageBinding({ ...stage, unexpired: latest.child_unexpired }, payload);
            scene?.check(latest.server_now.getTime(), registrations);
            assertResultRegistrations(payload, registrations, scene ? latest.server_now.getTime() : undefined);
            assertCompletedResultRegistrations(stage, completion.manifest, registrations, latest.server_now.getTime());
            return { state: "ready" };
        }
        if (existingStage) assertReusableResultStage(existingStage, payload);
        const unavailable = existingStage ? (existingStage.payload as ResultProcessingPayload).resource.unavailable : payload.resource.unavailable;
        if (!existingStage) {
            await executor.query(
                `INSERT INTO generation_tasks
                 (id, user_id, task_type, status, payload, created_at, updated_at, expires_at, conversation_id, surface, project_id, parent_task_id, attempt_no, client_request_id, execution_phase, next_poll_at, last_upstream_status, run_id)
                 VALUES ($1, $2, 'image_processing', $12::text, $3::jsonb, $4, $4, $5, $6, $7, $8, $9, 0, $10, $13::text, $14::timestamptz, $15::text, $11::text)`,
                [
                    id,
                    binding.userId,
                    JSON.stringify(payload),
                    current.server_now,
                    current.expires_at,
                    current.conversation_id,
                    current.surface,
                    current.project_id,
                    input.taskId,
                    payload.inputDigest,
                    binding.run?.runId ?? null,
                    unavailable ? "paused" : "pending",
                    unavailable ? "needs_review" : "created",
                    unavailable ? null : current.server_now,
                    unavailable?.code || "created",
                ],
            );
        }
        const scene = await readNativeImageResultEvidence(run, current.payload, payload, executor);
        const registrations = scene?.registrations || (await readResultRegistrations(payload, executor));
        const checked = await executor.query<{ server_now: Date }>(`SELECT clock_timestamp() AS server_now FROM generation_tasks WHERE ${claimWhere}`, parameters);
        if (!checked.rows[0]) throw new ImageResultOwnershipLost();
        assertResultRun(run, current.payload, payload, checked.rows[0].server_now.getTime());
        scene?.check(checked.rows[0].server_now.getTime(), registrations);
        assertResultRegistrations(payload, registrations, scene ? checked.rows[0].server_now.getTime() : undefined);
        // Recheck the original lease after registry/child locks; a failed update rolls back the child too.
        const updated = await executor.query(
            `UPDATE generation_tasks
             SET status = 'running',
                 payload = (payload - 'executionId') || jsonb_build_object('status', 'running', 'resultProcessing', $10::jsonb, 'updatedAt', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint),
                 result_payload = CASE WHEN $11::boolean THEN COALESCE(result_payload, '{}'::jsonb) || jsonb_build_object('reviewReason', $12::text) ELSE result_payload END,
                 updated_at = clock_timestamp(), execution_phase = CASE WHEN $11::boolean THEN 'needs_review' ELSE 'persisting' END,
                 next_poll_at = NULL, worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL,
                 last_upstream_status = CASE WHEN $11::boolean THEN 'image_processing_resource_unavailable' ELSE 'image_processing_waiting' END
             WHERE ${claimWhere} RETURNING id`,
            [...parameters, JSON.stringify({ jobId: id, inputDigest: payload.inputDigest }), Boolean(unavailable), imageResultResourceReason],
        );
        if (!updated.rows[0]) throw new ImageResultOwnershipLost();
        return { state: "waiting" };
    });
}

function matchesImageClaim(record: StoredGenerationTaskRecord, input: ImageTaskResultProcessingInput, userId: string, now = Date.now()) {
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
        record.expiresAt > now &&
        record.leaseUntil !== undefined &&
        record.leaseUntil > now
    );
}

function matchesImageBinding(record: StoredGenerationTaskRecord, binding: ResultProcessingPayload["imageResultBinding"]) {
    const upstream = record.payload.upstream;
    if (upstream != null && (typeof upstream !== "object" || !("id" in upstream) || typeof upstream.id !== "string")) return false;
    return (
        record.payload.attemptNo === binding.nativeResults.attemptNo &&
        (record.upstreamTaskId ?? null) === binding.nativeResults.upstreamTaskId &&
        (upstream == null ? null : upstream.id) === binding.nativeResults.upstreamTaskId &&
        (record.runId || undefined) === binding.run?.runId &&
        (record.parentTaskId || undefined) === (record.payload.parentTaskId || undefined) &&
        matchesPayloadBinding(record.payload as ImageTask, binding) &&
        isDeepStrictEqual(record.payload.nativeResults, binding.nativeResults)
    );
}

function matchesPayloadBinding(image: ImageTask, binding: ResultProcessingPayload["imageResultBinding"]) {
    return (image.runId || undefined) === binding.run?.runId && (!binding.run || image.parentTaskId === binding.run.runId);
}

function assertResultRun(run: ImageResultRun | undefined, image: ImageTask, payload: ResultProcessingPayload, now: number) {
    if (!imageResultRunMatches(run, image, payload.imageResultBinding.run, now)) throw new ImageResultOwnershipLost();
}

function assertResultImage(image: ImageTask, runId?: string) {
    if ((runId || image.runId) && !usesImageTaskResultProcessing(image)) throw new Error("Not implemented: Run result processing outside ordinary local non-4k images");
    if ((image.ecommerceExecution || image.ecommerceCanvasRequest) && !usesImageTaskResultProcessing(image)) throw new Error("Not implemented: canvas result processing");
}

async function resultProcessingPayload(original: StoredGenerationTaskRecord, binding: ResultProcessingPayload["imageResultBinding"]): Promise<ResultProcessingPayload> {
    const image = original.payload as ImageTask;
    const nativeResults = binding.nativeResults;
    const stored = nativeResults.slots.filter((slot): slot is StoredNativeSlot => slot.status === "stored");
    if (!stored.length) throw new Error("Not implemented: result processing without stored native input");
    const inputs = stored.map((slot) => ({ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: slot.sha256 }));
    const sources = stored.map<ImageProcessingPayload["sources"][number]>((slot, inputIndex) => ({
        inputIndex,
        scope: slot.scope,
        storageKey: slot.storageKey,
        storageProvider: slot.storageProvider,
        ...(slot.externalStorageId === undefined ? {} : { externalStorageId: slot.externalStorageId }),
    }));
    const encodedInputs = stored.map<EncodedImageProcessingInput>((slot, inputIndex) => {
        const identity = { inputIndex, assetId: slot.assetId, assetVersion: slot.assetVersion, sha256: slot.sha256, bytes: slot.bytes };
        return slot.metadataRejected === true ? { ...identity, metadataRejected: true } : { ...identity, layout: slot.layout, ...(slot.metadataSize ? { metadataSize: slot.metadataSize } : {}) };
    });
    const published = image.resultProcessing ? await getStoredGenerationTaskRecord("image_processing", image.resultProcessing.jobId) : undefined;
    if (image.resultProcessing && !published) throw new ImageResultOwnershipLost();
    const frozen = published?.payload as ResultProcessingPayload | undefined;
    if (frozen?.imageResultBinding.sourceIdentityDigest && frozen.imageResultBinding.sourceIdentityDigest !== imageTaskResultSourceIdentityDigest(image)) throw new ImageResultOwnershipLost();
    const options = imageTaskResultOptions(
        image,
        stored.map((slot, inputIndex) => ({ resultId: slot.resultId, resultIndex: slot.resultIndex, inputIndex })),
    );
    const references = imageTaskResultReferences(image, options);
    const scene = await readNativeImageResultEvidence(await readImageResultRun(image.runId), image);
    binding = { ...binding, ...(references.length || isNativeProductImageTaskResult(image) || isNativeGlobalSceneImageTaskResult(image) ? { sourceIdentityDigest: imageTaskResultSourceIdentityDigest(image) } : {}) };
    if (frozen && !imageTaskResultInputsMatch(image, frozen)) throw new ImageResultOwnershipLost();
    let parentMask: ResultProcessingPayload["parentMask"];
    for (const [index, reference] of references.entries()) {
        const inputIndex = inputs.length;
        const assetId = imageTaskResultReferenceId(image, reference, inputIndex);
        const location = imageTaskResultReferenceLocation(reference);
        let encoded: EncodedImageProcessingInput;
        if (frozen) {
            const fact = frozen.resource.facts.encodedInputs.find((item) => item.inputIndex === inputIndex);
            if (!fact) throw new Error("Image result frozen source facts missing");
            encoded = fact;
            const source = frozen.sources.find((item) => item.inputIndex === inputIndex);
            if (source) sources.push(source);
            if (frozen.parentMask?.inputIndex === inputIndex) parentMask = frozen.parentMask;
        } else if (location) {
            const [registration] = await getLocalMediaRegistrations([location.storageKey], { ownerUserId: image.userId });
            if (!registration || registration.ownerUserId !== image.userId || registration.type !== "image" || registration.scope !== location.scope || isLocalMediaRegistrationExpired(registration, scene?.now))
                throw new Error("Image result source registration changed");
            encoded = await collectReference(registration, { assetId, assetVersion: assetId });
            sources.push({ inputIndex, ...location, storageProvider: registration.storageProvider === "object" ? "object" : "local", ...(registration.externalStorageId === undefined ? {} : { externalStorageId: registration.externalStorageId }) });
            if (scene && index === 1) parentMask = { inputIndex, imageTaskId: image.id };
        } else if (index === 0 || (image.runId && options.mode === "scene_protection")) {
            const source = await freezeResultSource(original, reference, inputIndex, assetId);
            encoded = source.encoded;
            sources.push(source.source);
            if (index === 1) parentMask = { inputIndex, imageTaskId: image.id };
        } else {
            if (index !== 1 || (options.mode !== "scene_protection" && options.mode !== "product_protection")) throw new Error("Image result protection source is invalid");
            const bytes = imageTaskResultMaskBytes(reference);
            const metadata = await sharp(bytes, { limitInputPixels: false, failOn: "error" }).metadata();
            encoded = {
                inputIndex,
                assetId,
                assetVersion: assetId,
                sha256: createHash("sha256").update(bytes).digest("hex"),
                bytes: bytes.length,
                ...(metadata.format && metadata.depth && metadata.channels ? { layout: { format: metadata.format, depth: metadata.depth, channels: metadata.channels }, metadataSize: { width: metadata.width, height: metadata.height } } : {}),
            };
            parentMask = { inputIndex, imageTaskId: image.id };
        }
        const expected =
            options.mode === "scene_protection"
                ? index === 0
                    ? options.protection.sourceDigest
                    : options.protection.maskDigest
                : options.mode === "product_protection"
                  ? index === 0
                      ? options.baseline.sha256
                      : options.protection.maskSha256
                  : undefined;
        if (expected && encoded.sha256 !== expected) throw new Error("Image result source or mask differs from its frozen protection");
        const assetVersion = encoded.sha256;
        inputs.push({ assetId, assetVersion, expectedSha256: encoded.sha256 });
        encodedInputs.push({ ...encoded, inputIndex, assetVersion });
    }
    const facts = { encodedInputs, decodedInputs: [] };
    const optionsIdentity =
        options.mode === "ordinary"
            ? [options.mode, options.results.map((result) => [result.resultId, result.resultIndex, result.inputIndex]), options.targetSize ? [options.targetSize.width, options.targetSize.height] : null, options.transparentBackground]
            : options;
    const inputDigest =
        frozen?.inputDigest ??
        createHash("sha256")
            .update(
                JSON.stringify([
                    ALGORITHM_VERSION,
                    IMAGE_PROCESSING_MEMORY_MODEL_VERSION,
                    binding.userId,
                    binding.imageTaskId,
                    nativeResults.version,
                    nativeResults.attemptNo,
                    nativeResults.upstreamTaskId,
                    nativeResults.slots.map(nativeSlotIdentity),
                    inputs.map((input) => [input.assetId, input.assetVersion, input.expectedSha256]),
                    sources.map((source) => [source.inputIndex, source.scope, source.storageKey, source.storageProvider, source.externalStorageId ?? null, ...(source.frozenResultSource ? ["image-task-result-source"] : [])]),
                    encodedInputs.map((input) => [
                        input.inputIndex,
                        input.assetId,
                        input.assetVersion,
                        input.sha256,
                        input.bytes,
                        input.metadataRejected === true,
                        input.layout ? [input.layout.format, input.layout.depth, input.layout.channels] : null,
                        ...(input.metadataSize ? [[input.metadataSize.width, input.metadataSize.height]] : []),
                    ]),
                    [],
                    optionsIdentity,
                    ...(binding.sourceIdentityDigest ? [binding.sourceIdentityDigest] : []),
                    ...(parentMask ? [[parentMask.inputIndex, parentMask.imageTaskId]] : []),
                    ...(binding.run ? [[binding.run.runId, binding.run.agentTaskId, binding.run.agentAttempt]] : []),
                ]),
            )
            .digest("hex");
    const operation = { operation: "process_result" as const, options };
    const { profileVersion, ...configuration } = imageProcessingResourceConfig(process.env);
    const estimate = estimateImageProcessingMemory({ ...operation, inputs }, facts);
    const admission = decideImageProcessingAdmission(estimate, { totalMemoryBytes: configuration.budgetBytes, availableMemoryBytes: configuration.budgetBytes, availableSlots: configuration.concurrency });
    const payload: ResultProcessingPayload = {
        ...operation,
        version: "image-processing.v1",
        algorithmVersion: ALGORITHM_VERSION,
        inputDigest,
        inputs,
        sources,
        imageResultBinding: binding,
        ...(parentMask ? { parentMask } : {}),
        resource: {
            profileVersion,
            ...(estimate.status === "calibrated" ? { requiredMemoryBytes: estimate.requiredMemoryBytes } : {}),
            facts,
            configuration,
            ...(admission.status === "unavailable" ? { unavailable: { code: admission.code, reason: admission.reason } } : {}),
        },
    };
    if (published) {
        assertResultReference(image, payload);
        const now = (await nativeResultPostgresNow(image)) ?? Date.now();
        assertResultStageBinding({ ...published, unexpired: published.expiresAt > now }, payload);
    }
    return payload;
}

async function freezeResultSource(original: StoredGenerationTaskRecord, reference: ImageTaskReference, inputIndex: number, assetId: string) {
    const directory = await mkdtemp(join(tmpdir(), "vozeb-image-result-source-"));
    const sourcePath = join(directory, "source");
    try {
        const value = originalImageSourceUrl(imageTaskResultReferenceUrl(reference));
        if (value.startsWith("data:")) {
            const inline = /^data:image\/[^;,]+;base64,([\s\S]+)$/.exec(value);
            if (!inline) throw new Error("Image result source encoding is invalid");
            const bytes = Buffer.from(inline[1], "base64");
            if (!bytes.length || bytes.toString("base64") !== inline[1]) throw new Error("Image result source encoding is invalid");
            await writeFile(sourcePath, bytes, { flag: "wx" });
        } else if (!(await readImageTaskOriginalFile(value, sourcePath, original))) {
            throw new Error("Image result source could not be read");
        }
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(sourcePath)) {
            bytes += chunk.length;
            hash.update(chunk);
        }
        const metadata = await sharp(sourcePath, { limitInputPixels: false, failOn: "error" }).metadata();
        const mimeType = metadata.format === "heif" && metadata.compression === "av1" ? "image/avif" : metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
        const stored = await writeReferenceMediaFile(sourcePath, "image", mimeType, true, {
            ownerUserId: original.userId,
            taskId: original.id,
            conversationId: original.conversationId,
            projectId: original.projectId,
            runId: original.runId,
            source: "image-task-result-source",
            maxBytes: bytes,
        });
        const [registration] = await getLocalMediaRegistrations([stored.token], { ownerUserId: original.userId });
        if (!registration || !imageTaskResultFrozenSourceRegistrationMatches(registration, original.id)) throw new Error("Image result frozen source registration missing");
        const encoded: EncodedImageProcessingInput = {
            inputIndex,
            assetId,
            assetVersion: assetId,
            sha256: hash.digest("hex"),
            bytes,
            ...(metadata.format && metadata.depth && metadata.channels ? { layout: { format: metadata.format, depth: metadata.depth, channels: metadata.channels }, metadataSize: { width: metadata.width, height: metadata.height } } : {}),
        };
        const source: ImageProcessingPayload["sources"][number] = {
            inputIndex,
            scope: "reference",
            storageKey: stored.token,
            storageProvider: registration.storageProvider === "object" ? "object" : "local",
            ...(registration.externalStorageId === undefined ? {} : { externalStorageId: registration.externalStorageId }),
            frozenResultSource: true,
        };
        return { source, encoded };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function nativeSlotIdentity(slot: NativeResults["slots"][number]) {
    if (slot.status === "failed") return [slot.resultId, slot.resultIndex, slot.status, slot.failureStage, slot.failureCode];
    return [
        slot.resultId,
        slot.resultIndex,
        slot.status,
        slot.assetId,
        slot.assetVersion,
        slot.scope,
        slot.storageKey,
        slot.storageProvider,
        slot.externalStorageId ?? null,
        slot.sha256,
        slot.bytes,
        slot.metadataRejected === true ? ["metadata_rejected"] : [slot.layout.format, slot.layout.depth, slot.layout.channels, ...(slot.metadataSize ? [[slot.metadataSize.width, slot.metadataSize.height]] : [])],
    ];
}

function assertResultReference(image: ImageTask, payload: ResultProcessingPayload) {
    if (!imageTaskResultInputsMatch(image, payload)) throw new Error("Image result source, mode or protection binding changed");
    if (image.resultProcessing && (image.resultProcessing.jobId !== `image-process-${payload.inputDigest}` || image.resultProcessing.inputDigest !== payload.inputDigest)) throw new Error("Image result processing reference changed");
}

function assertReusableResultStage(stage: ResultStage, requested: ResultProcessingPayload) {
    assertResultStageBinding(stage, requested);
    const current = stage.payload as ResultProcessingPayload;
    if (stage.status === "paused" && stage.executionPhase === "needs_review" && current.resource.unavailable && !current.executionId && !stage.resultPayload) return;
    if (stage.status !== "pending" && stage.status !== "running") throw new Error("Not implemented: closed result processing stage consumption or recovery");
}

function assertResultStageBinding(stage: ResultStage, requested: ResultProcessingPayload) {
    const current = stage.payload as ResultProcessingPayload;
    if (
        stage.id !== `image-process-${requested.inputDigest}` ||
        stage.type !== "image_processing" ||
        stage.userId !== requested.imageResultBinding.userId ||
        stage.parentTaskId !== requested.imageResultBinding.imageTaskId ||
        (stage.runId || undefined) !== requested.imageResultBinding.run?.runId ||
        !stage.unexpired ||
        current.version !== requested.version ||
        current.operation !== requested.operation ||
        current.algorithmVersion !== requested.algorithmVersion ||
        current.inputDigest !== requested.inputDigest ||
        !isDeepStrictEqual(current.imageResultBinding, requested.imageResultBinding) ||
        !isDeepStrictEqual(current.inputs, requested.inputs) ||
        !isDeepStrictEqual(current.sources, requested.sources) ||
        !isDeepStrictEqual(current.parentMask, requested.parentMask) ||
        !isDeepStrictEqual(current.options, requested.options) ||
        !isDeepStrictEqual(current.resource.facts, requested.resource.facts)
    )
        throw new Error("Image result processing stage binding changed");
}

function completedResultInput(stage: Pick<StoredGenerationTaskRecord, "id" | "payload" | "executionPhase" | "resultPayload">, requested: ResultProcessingPayload): CompletedResultInput {
    const payload = stage.payload as ResultProcessingPayload;
    const result = stage.resultPayload as Partial<CompleteImageProcessingInput> | undefined;
    const manifest = result?.manifest;
    if (
        stage.executionPhase !== "completed" ||
        typeof payload.executionId !== "string" ||
        !payload.executionId ||
        typeof result?.workerId !== "string" ||
        !result.workerId ||
        result.executionId !== payload.executionId ||
        !manifest ||
        manifest.jobId !== stage.id ||
        manifest.executionId !== payload.executionId ||
        !result.metrics
    )
        throw new Error("Completed image result processing identity changed");
    if (
        !isDeepStrictEqual(
            manifest.sourceIdentities.map((source) => [source.assetId, source.assetVersion, source.sha256, source.bytes]),
            requested.resource.facts.encodedInputs.map((source) => [source.assetId, source.assetVersion, source.sha256, source.bytes]),
        ) ||
        !manifest.results ||
        !isDeepStrictEqual(
            manifest.results.map((slot) => [slot.resultId, slot.resultIndex, slot.nativeInputIndex]),
            requested.options.results.map((slot) => [slot.resultId, slot.resultIndex, slot.inputIndex]),
        )
    )
        throw new Error("Completed image result processing manifest binding changed");
    const usedArtifacts = new Set<number>();
    for (const slot of manifest.results) {
        if (slot.error) continue;
        const artifact = manifest.artifacts[slot.finalArtifactIndex];
        if (!Number.isSafeInteger(slot.finalArtifactIndex) || usedArtifacts.has(slot.finalArtifactIndex) || !artifact || artifact.kind !== "final" || artifact.resultId !== slot.resultId || artifact.resultIndex !== slot.resultIndex)
            throw new Error("Completed image result processing artifact binding changed");
        usedArtifacts.add(slot.finalArtifactIndex);
    }
    if (usedArtifacts.size !== manifest.artifacts.length) throw new Error("Completed image result processing manifest contains unbound artifacts");
    const completion = { workerId: result.workerId, executionId: payload.executionId, manifest, metrics: result.metrics };
    readCompletedImageProcessingStage({ id: stage.id, payload, resultPayload: stage.resultPayload }, completion);
    return { ...completion, manifest: { ...manifest, results: manifest.results } };
}

function assertCompletedResultRegistrations(
    stage: Pick<StoredGenerationTaskRecord, "id" | "userId" | "runId">,
    manifest: ImageProcessingManifest,
    registrations: Awaited<ReturnType<typeof getLocalMediaRegistrations>>,
    now: number,
    allowPermanent = false,
) {
    const byKey = new Map(registrations.map((registration) => [registration.storageKey, registration]));
    for (const artifact of manifest.artifacts) {
        const registration = byKey.get(artifact.storageKey);
        if (
            !registration ||
            registration.ownerUserId !== stage.userId ||
            registration.scope !== "reference" ||
            registration.type !== "image" ||
            registration.runId !== stage.runId ||
            registration.taskId !== stage.id ||
            registration.mimeType !== artifact.mimeType ||
            registration.bytes !== artifact.bytes ||
            (registration.storageClass !== "temporary" && !(allowPermanent && registration.storageClass === "permanent" && registration.expiresAt === undefined)) ||
            isLocalMediaRegistrationExpired(registration, now)
        )
            throw new Error("Completed image result processing artifact registration changed");
    }
}

function completedImageResults(image: ImageTask, completion: CompletedResultInput, requested: ResultProcessingPayload): { results: StoredImageTaskMediaResult[]; batchEvidence?: ImageTaskResultEvidence[] } {
    const manifest = completion.manifest;
    const retainedMask = requested.parentMask ? requested.sources.find((source) => source.inputIndex === requested.parentMask?.inputIndex) : undefined;
    const nativeProduct = isNativeProductImageTaskResult(image);
    const results: StoredImageTaskMediaResult[] = manifest.results.flatMap((slot) => {
        if (slot.error) return [];
        const artifact = manifest.artifacts[slot.finalArtifactIndex];
        const url = resultMediaUrl(artifact.storageKey);
        const source = manifest.sourceIdentities[slot.nativeInputIndex];
        const native = image.nativeResults?.slots.find((item) => item.resultId === slot.resultId);
        if (!native || native.status !== "stored" || source.decodeError || !source.nativeImage) throw new Error("Completed image result lost its original native identity");
        const enhanced = resolveResultSize(image.config.quality, "1:1") === resolveResultSize("4k", "1:1");
        const layered = image.config.outputMode === "layers";
        const ordinary4k = enhanced && !layered && !image.sceneProtection && image.enhancementDelivery?.scope !== "product_background";
        const protectedMask = ordinary4k && Boolean(image.mask);
        const finalEnhancement = enhanced && !layered && Boolean(slot.finalImage);
        if (ordinary4k && (artifact.sha256 !== source.sha256 || artifact.bytes !== source.bytes || artifact.width !== source.width || artifact.height !== source.height || artifact.mimeType !== source.mimeType))
            throw new Error("Ordinary 4k result changed its provider native bytes");
        const nativeUrl = ordinary4k ? url : resultMediaUrl(native.storageKey);
        const enhancementSkip =
            enhanced && (layered || nativeProduct || protectedMask || isNativeGlobalSceneImageTaskResult(image))
                ? imageEnhancementExclusion({ enabled: image.enhancementPolicy?.enabled ?? false, requested4k: true, protectedContract: !finalEnhancement && (nativeProduct || protectedMask), layered })
                : undefined;
        return [
            {
                resultId: slot.resultId,
                dataUrl: url,
                serverUrl: url,
                width: artifact.width,
                height: artifact.height,
                bytes: artifact.bytes,
                mimeType: artifact.mimeType,
                ...(enhanced && !layered && (finalEnhancement || (!nativeProduct && !protectedMask))
                    ? {
                          enhancementId: `enhancement:${slot.resultId}`,
                          nativeSource: {
                              url: nativeUrl,
                              sha256: source.sha256,
                              width: source.width,
                              height: source.height,
                              byteLength: source.bytes,
                              format: source.nativeImage.format,
                              hasAlpha: source.nativeImage.hasAlpha,
                              provenance: "provider_native" as const,
                          },
                      }
                    : {}),
                ...(finalEnhancement
                    ? {
                          enhancementSource: {
                              url,
                              sha256: artifact.sha256,
                              byteLength: artifact.bytes,
                              width: artifact.width,
                              height: artifact.height,
                              format: slot.finalImage!.format,
                              hasAlpha: slot.finalImage!.hasAlpha,
                              provenance: "generation_final" as const,
                          },
                      }
                    : {}),
                ...(enhancementSkip ? { enhancementSkip } : {}),
                ...((isNativeProductImageTaskResult(image) || isNativeGlobalSceneImageTaskResult(image)) && image.ecommerceExecution?.canvas
                    ? {
                          canvasEvidence: {
                              constraint: structuredClone(image.ecommerceExecution.canvas),
                              ...(image.ecommerceCanvasRequest ? { providerRequest: { ...image.ecommerceCanvasRequest }, requestedSize: canvasProviderDimensions(image.ecommerceCanvasRequest) } : {}),
                              nativeSize: { width: source.width, height: source.height },
                              storedSize: { width: artifact.width, height: artifact.height },
                              nativeUrl,
                              normalization: "none" as const,
                          },
                      }
                    : {}),
                ...(slot.sceneProtectionEvidence
                    ? {
                          sceneProtectionEvidence: { ...slot.sceneProtectionEvidence, nativeUrl, compositeUrl: url, ...(retainedMask ? { maskUrl: resultMediaUrl(retainedMask.storageKey) } : {}) },
                          ...(image.ecommerceExecution?.canvas
                              ? {
                                    canvasEvidence: {
                                        constraint: structuredClone(image.ecommerceExecution.canvas),
                                        providerRequest: { ...image.ecommerceCanvasRequest },
                                        requestedSize: canvasProviderDimensions(image.ecommerceCanvasRequest),
                                        nativeSize: { width: source.width, height: source.height },
                                        storedSize: { width: artifact.width, height: artifact.height },
                                        nativeUrl,
                                        normalization: slot.sceneProtectionEvidence.normalization,
                                    },
                                }
                              : {}),
                      }
                    : {}),
                ...(slot.productEnhancementEvidence
                    ? { productEnhancementEvidence: { version: "product-baseline.v2" as const, nativeUrl, nativeSha256: source.sha256, baselineUrl: url, baselineSha256: artifact.sha256, composition: slot.productEnhancementEvidence } }
                    : {}),
            },
        ];
    });
    if (!image.nativeResults) throw new Error("Completed image result requires sealed native input");
    const hasFailure = image.nativeResults.slots.some((slot) => slot.status === "failed") || manifest.results.some((slot) => slot.error);
    if (!hasFailure && !isNativeProductImageTaskResult(image) && !isNativeGlobalSceneImageTaskResult(image)) return { results, ...(image.result?.batchEvidence ? { batchEvidence: image.result.batchEvidence } : {}) };
    const batchEvidence = image.nativeResults.slots.map<ImageTaskResultEvidence>((native) => {
        if (native.status === "failed") return { resultId: native.resultId, resultIndex: native.resultIndex, nativeStatus: "unavailable", storageStatus: "unavailable", failureStage: "read", failureReason: native.failureCode };
        const slot = manifest.results.find((item) => item.resultId === native.resultId);
        if (!slot) throw new Error("Completed image result lost an original slot");
        const source = manifest.sourceIdentities[slot.nativeInputIndex];
        const evidence: ImageTaskResultEvidence = {
            resultId: native.resultId,
            resultIndex: native.resultIndex,
            nativeStatus: source.decodeError ? "unavailable" : "readable",
            ...(!source.decodeError ? { nativeSize: { width: source.width, height: source.height } } : {}),
            storageStatus: "unavailable",
        };
        if (slot.error) return { ...evidence, failureStage: slot.error.failureStage, failureReason: slot.error.message };
        const artifact = manifest.artifacts[slot.finalArtifactIndex];
        return { ...evidence, storageStatus: "stored", storedUrl: resultMediaUrl(artifact.storageKey), storedSize: { width: artifact.width, height: artifact.height } };
    });
    return { results, batchEvidence };
}

function resultMediaUrl(storageKey: string) {
    return `/api/reference-assets/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
}

function waitingImage(image: ImageTask, payload: ResultProcessingPayload, now: number): ImageTask {
    return { ...image, status: "running", executionId: undefined, resultProcessing: { jobId: `image-process-${payload.inputDigest}`, inputDigest: payload.inputDigest }, updatedAt: now };
}

async function readResultRegistrations(payload: ResultProcessingPayload, executor?: QueryExecutor) {
    return getLocalMediaRegistrations(
        payload.sources.map((source) => source.storageKey),
        { ownerUserId: payload.imageResultBinding.userId, executor, forUpdate: Boolean(executor) },
    );
}

function assertResultRegistrations(payload: ResultProcessingPayload, registrations: Awaited<ReturnType<typeof getLocalMediaRegistrations>>, now?: number) {
    const binding = payload.imageResultBinding;
    const stored = binding.nativeResults.slots.filter((slot): slot is StoredNativeSlot => slot.status === "stored");
    const byKey = new Map(registrations.map((registration) => [registration.storageKey, registration]));
    for (const slot of stored) {
        const registration = byKey.get(slot.storageKey);
        if (
            !registration ||
            registration.ownerUserId !== binding.userId ||
            registration.taskId !== binding.imageTaskId ||
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
    for (const source of payload.sources.filter((item) => !payload.options.results.some((result) => result.inputIndex === item.inputIndex))) {
        const registration = byKey.get(source.storageKey);
        const encoded = payload.resource.facts.encodedInputs[source.inputIndex];
        if (
            !registration ||
            registration.ownerUserId !== binding.userId ||
            registration.scope !== source.scope ||
            registration.type !== "image" ||
            registration.bytes !== encoded.bytes ||
            (registration.storageProvider === "object" ? "object" : "local") !== source.storageProvider ||
            (source.frozenResultSource && !imageTaskResultFrozenSourceRegistrationMatches(registration, binding.imageTaskId)) ||
            registration.externalStorageId !== source.externalStorageId ||
            isLocalMediaRegistrationExpired(registration, now)
        )
            throw new Error("Image result auxiliary registration changed");
    }
}
