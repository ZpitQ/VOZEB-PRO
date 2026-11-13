import { isDeepStrictEqual } from "node:util";
import { runCustomImageTask, pollCustomImageTask } from "@/app/api/image-tasks/image-task-custom";
import { customGeminiImageTaskPath } from "@/app/api/image-tasks/image-task-gemini-config";
import { EcommerceCanvasAdapterReview } from "@/app/api/image-tasks/image-task-size";
import { runGeminiImageTask } from "@/app/api/image-tasks/image-task-gemini";
import { runOpenAiImageTask } from "@/app/api/image-tasks/image-task-openai";
import { imageUnits, ImageQueryContractError, ImageUpstreamTerminalError, pollOpenAiImageTask } from "@/app/api/image-tasks/image-task-support";
import type { ImageTaskRunResult } from "@/app/api/image-tasks/image-task-types";
import { stableMediaUrl, writeImageGenerationLog } from "@/app/api/image-tasks/image-task-runner";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { publicImageResultEnhancement } from "@/lib/image-enhancement-contract";
import { finishGenerationAttempt, startGenerationAttempt } from "@/lib/server/generation-attempt";
import { generationModelId } from "@/lib/server/generation-channel";
import { refundImageTask } from "@/lib/server/image-task-refund";
import { deletePreparedImageTaskResults, persistedImageTaskResults, prepareImageTaskResults } from "@/lib/server/image-task-result-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { GenerationSubmissionSafeFailure, generationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { getImageTask, transitionImageTask, updateImageTask, type ImageTask, type StoredImageTaskMediaResult } from "@/lib/server/image-task-store";
import { maintenanceWorkerContext } from "@/lib/server/maintenance-auth";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { imageReferenceToDataUrl, resolveImageTaskEditProtocol } from "@/app/api/image-tasks/image-task-support";
import { validateSceneEditProtection } from "./ecommerce-product-regions";
import { assertEcommerceImageExecutionSnapshot, ecommerceSceneProtectionReferencesMatch } from "./ecommerce-image-task-orchestration";
import { getAgentRun, type AgentRun } from "./agent-run-store";
import { assertEcommerceReferenceContent, EcommerceReferenceSourceChangedError, EcommerceReferenceSourceReadError, referenceAssetVersion } from "./ecommerce-reference-recovery";
import { originalImageSourceUrl } from "@/lib/media-image-url";
import { captureImageTaskNativeResults } from "./image-task-native-capture";
import { getStoredGenerationTaskRecord } from "./generation-task-store";
import { ensureImageTaskResultProcessing, consumeCompletedImageTaskResultProcessing } from "./image-task-result-processing";
import { usesImageTaskResultProcessing } from "./image-task-result-contract";
import { readCompletedEcommerceSceneProtection } from "./ecommerce-protection-preparation";
import { verifyPreparedEcommerceReferenceSource, loadPreparedEcommerceReferenceSource } from "./ecommerce-reference-preparation";
import { isFullImageEcommerceExecution } from "./ecommerce-image-compiler";

export type ImageUpstreamStep =
    | { state: "pending"; upstream: NonNullable<ImageTask["upstream"]>; status: string }
    | { state: "needs_review"; reason: string; status: string }
    | { state: "result_ready"; resultUrl: string; status: string }
    | { state: "completed" }
    | { state: "failed"; error: string; status: string; retryReason?: "upstream_failed" };

export async function createImageTaskUpstreamStep(task: ImageTask, origin: string, publicOrigin: string, cookie = "", workerUserId = ""): Promise<ImageUpstreamStep> {
    const current = await getImageTask(task.id);
    if (!current || current.status === "cancelled") return { state: "failed", error: "任务已取消", status: "cancelled" };
    const running = current.status === "pending" ? await transitionImageTask(current, ["pending"], { status: "running" }) : current;
    if (!running) return { state: "failed", error: "图片任务状态已变化", status: "conflict" };
    const prepared = persistedImageTaskResults(running);
    if (prepared.length || running.result?.batchEvidence) return readyImageStep(running, prepared[0]?.serverUrl || prepared[0]?.dataUrl || "");
    if (running.upstream?.id) return queryImageTaskUpstreamStep(running, origin, cookie, workerUserId);
    if (running.ecommerceExecution?.canvas && (customGeminiImageTaskPath(running.config, running.kind) || (!usesDeclarativeImageProtocol(running.config.advancedConfig?.protocol) && running.config.apiFormat === "gemini"))) {
        return { state: "needs_review", reason: new EcommerceCanvasAdapterReview("Gemini generateContent").message, status: "canvas_adapter_unsupported" };
    }

    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    const localSceneEdit = running.sceneProtection || (running.ecommerceExecution?.protection?.scope === "local" && !running.productProtection);
    let nativeScene: Awaited<ReturnType<typeof nativeSceneSubmissionState>>;
    if (localSceneEdit) {
        try {
            nativeScene = await nativeSceneSubmissionState(running, task.executionId);
        } catch (error) {
            if (error instanceof EcommerceReferenceValidationUnavailableError) return { state: "needs_review", reason: "参考任务暂时无法核对，请稍后点击“检查状态”继续原任务。", status: "reference_validation_unavailable" };
            return { state: "needs_review", reason: error instanceof Error ? error.message : "局部场景编辑证据无法验证", status: "scene_mask_review_required" };
        }
    }
    let submissionMask = running.mask;
    let submissionReferences: ImageTask["references"];
    try {
        submissionReferences = await frozenImageSubmissionReferences(running, origin, authContext);
    } catch (error) {
        if (error instanceof EcommerceReferenceSourceChangedError) return { state: "needs_review", reason: error.message, status: "reference_source_changed" };
        const infrastructure = error instanceof EcommerceReferenceValidationUnavailableError;
        return {
            state: "needs_review",
            reason: infrastructure ? "参考任务暂时无法核对，请稍后点击“检查状态”继续原任务。" : "参考图片暂时无法读取，请稍后点击“检查状态”继续原任务。",
            status: infrastructure ? "reference_validation_unavailable" : "reference_source_unavailable",
        };
    }
    if (running.config.apiSource === "system" && running.ecommerceExecution) {
        try {
            assertEcommerceImageExecutionSnapshot(await getAuthSettings(), running.ecommerceExecution, running.config);
        } catch (error) {
            return { state: "needs_review", reason: error instanceof Error ? error.message : "电商生图执行配置已变化", status: "ecommerce_execution_snapshot_changed" };
        }
    }
    if (running.productProtection || localSceneEdit) {
        try {
            if (!running.mask) throw new Error("局部编辑缺少可信独立蒙版");
            if (!(await resolveImageTaskEditProtocol(running.config)).supportsIndependentMask) throw new Error("当前渠道尚未配置可用的独立蒙版编辑方式，请联系管理员。");
            if (localSceneEdit) {
                if (nativeScene) {
                    const source = Buffer.from(submissionReferences[0].dataUrl.split(",")[1], "base64");
                    if (source.length !== nativeScene.baseline.bytes) throw new EcommerceReferenceSourceChangedError();
                    assertEcommerceReferenceContent(source, nativeScene.baseline.sha256);
                    const mask = await loadPreparedEcommerceReferenceSource({ sourceUrl: nativeScene.sceneProtection.mask.serverUrl, sourceBytes: nativeScene.mask.bytes, contentSha256: nativeScene.mask.sha256 }, origin, authContext);
                    // Only the provider sees these exact verified bytes. Persisted
                    // native evidence retains its original owned mask URL.
                    submissionMask = { ...running.mask, dataUrl: "data:image/png;base64," + mask.toString("base64"), serverUrl: undefined, url: undefined, remoteUrl: undefined };
                    const currentScene = await nativeSceneSubmissionState(running, task.executionId);
                    if (!currentScene || !isDeepStrictEqual(currentScene.binding, nativeScene.binding)) throw new Error("场景保护提交身份在原件读取期间已变化");
                } else {
                    if (!running.sceneProtection || !ecommerceSceneProtectionReferencesMatch(running.sceneProtection.sourceAssetId, running.references, running.ecommerceExecution) || running.mask.dataUrl !== running.sceneProtection.mask.dataUrl)
                        throw new Error("局部场景编辑缺少完整原图与可信独立蒙版");
                    const source = await imageReferenceToDataUrl(submissionReferences[0], "scene.png", origin, authContext);
                    await validateSceneEditProtection(Buffer.from(source.split(",")[1], "base64"), running.sceneProtection);
                }
            }
        } catch (error) {
            return { state: "needs_review", reason: error instanceof Error ? error.message : "局部编辑蒙版无法验证", status: running.productProtection ? "product_mask_review_required" : "scene_mask_review_required" };
        }
    }
    const config = running.config;
    let attempts = running.attempts || [];
    const started = startGenerationAttempt(attempts, { channelId: config.channelId, model: generationModelId(config), capability: "image" });
    attempts = started.attempts;
    const candidate = { ...running, config, attempts, attemptNo: started.attempt.attemptNo, upstream: undefined, billing: undefined };
    await updateImageTask(task.id, { config, attempts, attemptNo: candidate.attemptNo, upstream: undefined, billing: undefined });
    const submissionStartedAt = Date.now();
    await scheduleGenerationTask("image", task.id, {
        executionPhase: "submitting",
        submittedAt: submissionStartedAt,
        nextPollAt: submissionStartedAt + resolveModelRequestTimeoutMs(config, "image"),
        channelId: config.channelId,
        provider: config.advancedConfig?.protocol || config.apiFormat,
        lastUpstreamStatus: "submitting",
    });
    try {
        // Verified source bytes are used only for this submission. Persisted task
        // references and result/log processing retain the stable owned URLs.
        const submission = { ...candidate, references: submissionReferences, mask: submissionMask };
        const result = customGeminiImageTaskPath(config, candidate.kind)
            ? await runGeminiImageTask(submission, origin, authContext)
            : usesDeclarativeImageProtocol(config.advancedConfig?.protocol)
              ? await runCustomImageTask(submission, origin, publicOrigin, authContext, true)
              : config.apiFormat === "gemini"
                ? await runGeminiImageTask(submission, origin, authContext)
                : await runOpenAiImageTask(submission, origin, publicOrigin, authContext, true);
        return await handleImageProviderResult({ ...candidate, ecommerceCanvasRequest: submission.ecommerceCanvasRequest }, result, origin, authContext);
    } catch (error) {
        if (error instanceof EcommerceCanvasAdapterReview) return { state: "needs_review", reason: error.message, status: "canvas_adapter_unsupported" };
        if (error instanceof ImageUpstreamTerminalError) return { state: "failed", error: error.message || "图片生成失败", status: "failed", retryReason: "upstream_failed" };
        if (!(error instanceof GenerationSubmissionSafeFailure)) throw generationSubmissionUncertainError(error, "图片任务创建结果未知");
        attempts = finishGenerationAttempt(attempts, candidate.attemptNo, { status: "failed", error: error.message });
        await refundImageCandidate(candidate);
        await updateImageTask(task.id, { attempts, attemptNo: candidate.attemptNo, upstream: undefined, billing: undefined });
        return { state: "failed", error: error.message, status: "failed" };
    }
}

async function nativeSceneSubmissionState(task: ImageTask, executionId: string | undefined) {
    let observedParent;
    try {
        observedParent = task.runId ? await getAgentRun(task.runId) : null;
    } catch (error) {
        throw new EcommerceReferenceValidationUnavailableError("场景父任务暂时无法读取", { cause: error });
    }
    if (!observedParent?.ecommerceSnapshot?.processing?.sceneSelection && !task.sceneProtection?.mask.serverUrl) return;
    if (!task.runId) throw new Error("场景保护缺少当前父任务");
    const [record, parentRecord] = await Promise.all([getStoredGenerationTaskRecord("image", task.id), getStoredGenerationTaskRecord("agent", task.runId)]);
    const parent = parentRecord?.payload as AgentRun | undefined;
    const current = record?.payload as ImageTask | undefined;
    const automaticRetry =
        record?.lastUpstreamStatus === "automatic_retry_after_upstream_failure" &&
        !record.queryPath &&
        Object.keys(record.resultPayload ?? {}).length === 0 &&
        current?.attemptNo === 1 &&
        current.attempts?.length === 1 &&
        current.attempts[0].attemptNo === 1 &&
        current.attempts[0].status === "failed" &&
        current.attempts[0].completedAt !== undefined &&
        current.retryable === false &&
        current.candidateConfigs?.length === 0;
    const now = Date.now();
    if (
        !parent ||
        !parentRecord ||
        !record ||
        !current ||
        parentRecord.expiresAt <= now ||
        parentRecord.status !== "running" ||
        parentRecord.id !== parent.id ||
        parentRecord.userId !== parent.userId ||
        parentRecord.conversationId !== parent.conversationId ||
        parentRecord.surface !== parent.surface ||
        parentRecord.projectId !== parent.projectId ||
        parent.status !== "running" ||
        parent.cancellation ||
        parent.userId !== task.userId ||
        parent.id !== task.runId ||
        parent.conversationId !== task.conversationId ||
        parent.surface !== task.surface ||
        parent.projectId !== task.projectId ||
        !record.workerId ||
        !executionId ||
        current.executionId !== executionId ||
        record.expiresAt <= now ||
        !(Number(record.leaseUntil) > now) ||
        record.userId !== task.userId ||
        record.runId !== current.runId ||
        record.conversationId !== current.conversationId ||
        record.surface !== current.surface ||
        record.projectId !== current.projectId ||
        record.parentTaskId !== current.parentTaskId ||
        record.clientRequestId !== current.clientRequestId ||
        record.attemptNo !== current.attemptNo ||
        record.status !== "running" ||
        current.status !== record.status ||
        record.executionPhase !== "created" ||
        record.submittedAt !== undefined ||
        record.upstreamTaskId ||
        current.upstream ||
        current.billing ||
        current.result ||
        current.nativeResults ||
        current.nativeAcquisition ||
        current.resultProcessing ||
        (current.attempts?.length && !automaticRetry) ||
        !isDeepStrictEqual(nativeSceneImageIdentity(current), nativeSceneImageIdentity(task))
    )
        throw new Error("场景保护缺少当前图片任务的有效提交身份");
    const evidence = await readCompletedEcommerceSceneProtection(parent);
    const { state, sceneProtection } = evidence;
    const logical = state.task;
    const checkpoint = state.checkpoint;
    const children = logical.childTasks?.filter((child) => child.id === current.id) || [];
    const child = children[0];
    const fence = current.referenceDispatch;
    const logicalReferences = logical.references || [];
    if (
        state.snapshot.qualityCheck ||
        current.kind !== "edit" ||
        current.productProtection ||
        current.parentTaskId !== parent.id ||
        logical.type !== "image" ||
        logical.status !== "running" ||
        children.length !== 1 ||
        !child ||
        child.attempt !== logical.attempts ||
        (child.status !== "pending" && child.status !== "needs_review") ||
        !logical.taskIds?.includes(current.id) ||
        !fence?.executionId.trim() ||
        checkpoint.version !== "ecommerce-reference-checkpoint.v1" ||
        checkpoint.state !== "resolved" ||
        checkpoint.analysisStage.state !== "completed" ||
        fence.inputId !== checkpoint.inputId ||
        fence.decisionId !== checkpoint.decisionId ||
        fence.analysisRequestId !== checkpoint.analysisStage.requestId ||
        !Number.isSafeInteger(fence.copy) ||
        fence.copy < 1 ||
        fence.copy > logical.count ||
        current.clientRequestId !== `${parent.clientRequestId}:${logical.id}:${child.attempt}:${fence.copy}` ||
        current.prompt !== logical.prompt ||
        logicalReferences.length !== current.references.length ||
        logicalReferences.some(
            (reference, index) =>
                reference.assetId !== current.references[index].id ||
                reference.ecommerceRole !== current.references[index].ecommerceRole ||
                originalImageSourceUrl(reference.url) !== originalImageSourceUrl(current.references[index].url || current.references[index].serverUrl || current.references[index].remoteUrl || ""),
        ) ||
        !ecommerceSceneProtectionReferencesMatch(sceneProtection.sourceAssetId, current.references, current.ecommerceExecution) ||
        !isDeepStrictEqual(current.ecommerceExecution, evidence.execution) ||
        !isDeepStrictEqual(logical.sceneProtection, sceneProtection) ||
        !isDeepStrictEqual(current.sceneProtection, sceneProtection) ||
        !isDeepStrictEqual(current.mask, sceneProtection.mask)
    )
        throw new Error("场景保护与当前父任务、确认选区或图片副本不一致");
    return {
        baseline: state.receipt.baseline,
        mask: evidence.mask,
        sceneProtection,
        binding: {
            image: nativeSceneImageIdentity(current),
            workerId: record.workerId,
            parentExecutionId: parent.executionId,
            parentClientRequestId: parent.clientRequestId,
            plan: state.plan,
            referenceCheckpoint: checkpoint,
            receipt: state.receipt,
            logicalTaskId: logical.id,
            logicalReferences,
            logicalAttempt: logical.attempts,
            count: logical.count,
            child,
            stage: evidence.stage,
            sourceRegistration: evidence.sourceRegistration,
            maskRegistration: evidence.maskRegistration,
        },
    };
}

function nativeSceneImageIdentity(task: ImageTask) {
    return {
        id: task.id,
        userId: task.userId,
        runId: task.runId,
        conversationId: task.conversationId,
        surface: task.surface,
        projectId: task.projectId,
        parentTaskId: task.parentTaskId,
        clientRequestId: task.clientRequestId,
        referenceDispatch: task.referenceDispatch,
        status: task.status,
        executionId: task.executionId,
        attemptNo: task.attemptNo,
        attempts: task.attempts,
        config: task.config,
        prompt: task.prompt,
        references: task.references,
        mask: task.mask,
        sceneProtection: task.sceneProtection,
        ecommerceExecution: task.ecommerceExecution,
    };
}

class EcommerceReferenceValidationUnavailableError extends Error {}

async function frozenImageSubmissionReferences(task: ImageTask, origin: string, authContext: string): Promise<ImageTask["references"]> {
    if (!task.runId) return task.references;
    let parent;
    try {
        parent = await getAgentRun(task.runId);
    } catch {
        throw new EcommerceReferenceValidationUnavailableError();
    }
    const checkpoint = parent?.ecommerceSnapshot?.referenceCheckpoint;
    if (!checkpoint && !task.referenceDispatch) return task.references;
    const fence = task.referenceDispatch;
    if (
        !parent ||
        parent.id !== task.runId ||
        parent.userId !== task.userId ||
        parent.conversationId !== task.conversationId ||
        parent.cancellation ||
        checkpoint?.version !== "ecommerce-reference-checkpoint.v1" ||
        checkpoint.state !== "resolved" ||
        checkpoint.analysisStage.state !== "completed" ||
        checkpoint.planningInput.conversationId !== parent.conversationId ||
        !fence ||
        fence.inputId !== checkpoint.inputId ||
        fence.decisionId !== checkpoint.decisionId ||
        fence.analysisRequestId !== checkpoint.analysisStage.requestId ||
        new Set(task.references.map((reference) => reference.id)).size !== task.references.length
    )
        throw new EcommerceReferenceSourceChangedError();
    const references: ImageTask["references"] = [];
    for (const [index, reference] of task.references.entries()) {
        const item = checkpoint.assets.find((value) => value.asset.id === reference.id);
        const source = checkpoint.planningInput.assetCandidates.find((value) => value.id === reference.id && value.type === "image")?.url;
        if (
            !item ||
            !source ||
            !item.contentSha256 ||
            item.assetVersion !== referenceAssetVersion(item.asset, item.contentSha256) ||
            item.asset.userId !== parent.userId ||
            item.asset.conversationId !== parent.conversationId ||
            item.asset.type !== "image" ||
            item.asset.status !== "ready"
        )
            throw new EcommerceReferenceSourceChangedError();
        const original = { ...reference, dataUrl: "", url: originalImageSourceUrl(source), serverUrl: undefined, remoteUrl: undefined };
        if ((task.productProtection || isFullImageEcommerceExecution(task.ecommerceExecution)) && task.ecommerceExecution?.modelSnapshot.imageEdit?.protocol === "sub2api") {
            const prepared = parent.ecommerceSnapshot?.processing?.prepareReferences.find((entry) => entry.assetId === reference.id)?.manifest?.sourceIdentities[0];
            if (!prepared || prepared.decodeError || prepared.sha256 !== item.contentSha256) throw new EcommerceReferenceSourceChangedError();
            await verifyPreparedEcommerceReferenceSource({ sourceUrl: original.url, sourceBytes: prepared.bytes, contentSha256: item.contentSha256 }, origin, authContext);
            references.push(original);
            continue;
        }
        const dataUrl = await imageReferenceToDataUrl(original, reference.name || `reference-${index + 1}.png`, origin, authContext);
        const encoded = dataUrl.match(/^data:image\/[^;,]+;base64,(.+)$/i)?.[1];
        if (!encoded) throw new EcommerceReferenceSourceReadError();
        assertEcommerceReferenceContent(Buffer.from(encoded, "base64"), item.contentSha256);
        references.push({ ...reference, dataUrl, url: undefined, remoteUrl: undefined, serverUrl: undefined });
    }
    return references;
}

export async function queryImageTaskUpstreamStep(task: ImageTask, origin: string, cookie = "", workerUserId = ""): Promise<ImageUpstreamStep> {
    const prepared = persistedImageTaskResults(task);
    if (prepared.length || task.result?.batchEvidence) return readyImageStep(task, prepared[0]?.serverUrl || prepared[0]?.dataUrl || "");
    const upstream = task.upstream;
    if (!upstream?.id) return { state: "failed", error: "图片任务缺少上游任务 ID", status: "missing_upstream_id" };
    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    try {
        const result = usesDeclarativeImageProtocol(task.config.advancedConfig?.protocol)
            ? await pollCustomImageTask(task, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, true)
            : await pollOpenAiImageTask(task.config, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, upstream.explicitPollUrl || "", true);
        return await handleImageProviderResult(task, { ...result, pointsCost: task.billing?.pointsCost, pointsRecordId: task.billing?.pointsRecordId }, origin, authContext);
    } catch (error) {
        if (error instanceof ImageQueryContractError) return { state: "needs_review", reason: error.message, status: "query_contract_invalid" };
        if (error instanceof ImageUpstreamTerminalError) return { state: "failed", error: error.message, status: "failed", retryReason: "upstream_failed" };
        if (error instanceof GenerationSubmissionSafeFailure) return { state: "failed", error: error.message, status: "failed" };
        throw error;
    }
}

export async function prepareImageTaskAutomaticRetry(task: ImageTask, error: string) {
    const current = (await getImageTask(task.id)) || task;
    if (current.status !== "pending" && current.status !== "running") return null;
    const attemptNo = current.attemptNo || current.attempts?.at(-1)?.attemptNo || 1;
    if (attemptNo >= 2) return null;
    const attempts = finishGenerationAttempt(current.attempts || [], attemptNo, {
        status: "failed",
        error,
        pointsCost: current.billing?.pointsCost,
        pointsRecordId: current.billing?.pointsRecordId,
    });
    await refundImageCandidate(current);
    const nextConfig = current.candidateConfigs?.[0] || current.config;
    return updateImageTask(current.id, {
        config: nextConfig,
        candidateConfigs: [],
        attempts,
        attemptNo,
        upstream: undefined,
        billing: undefined,
        retryable: false,
    });
}

export async function queryCancelledImageTaskUpstreamStep(task: ImageTask, origin: string, cookie = "", workerUserId = "") {
    const upstream = task.upstream;
    if (!upstream?.id) return { state: "terminal" as const, status: "missing_upstream_id" };
    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    try {
        const result = usesDeclarativeImageProtocol(task.config.advancedConfig?.protocol)
            ? await pollCustomImageTask(task, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, true)
            : await pollOpenAiImageTask(task.config, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, upstream.explicitPollUrl || "", true);
        return result.pending ? { state: "pending" as const, status: "processing" } : { state: "terminal" as const, status: "completed" };
    } catch (error) {
        if (error instanceof ImageUpstreamTerminalError || error instanceof GenerationSubmissionSafeFailure) return { state: "terminal" as const, status: "failed" };
        throw error;
    }
}

export async function persistImageTaskResult(task: ImageTask, origin: string, resultUrl: string, cookie = "", workerUserId = "") {
    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    const current = (await getImageTask(task.id)) || task;
    if (current.status === "success") return current;
    const resultClaim = usesImageTaskResultProcessing(current) ? await imageTaskResultClaim(task) : undefined;
    if (current.nativeResults && resultClaim) return persistNativeImageTaskResult(current, resultClaim);
    let results = persistedImageTaskResults(current);
    if (results.length || current.result?.batchEvidence) return completeImageResult(current, results);

    const inlineDataUrl = resultUrl === "inline://image-task-result" ? current.result?.dataUrl || "" : resultUrl;
    const remoteUrl = resultUrl === "inline://image-task-result" ? current.result?.remoteUrl : /^https?:\/\//i.test(resultUrl) ? resultUrl : undefined;
    if (!inlineDataUrl && !remoteUrl && !current.nativeAcquisition) throw new GenerationSubmissionSafeFailure("图片任务缺少可持久化结果");
    const legacyResults = current.result?.results?.length ? current.result.results : [{ dataUrl: inlineDataUrl, remoteUrl }];
    const normalizedResults = current.nativeAcquisition
        ? current.nativeAcquisition.slots.map((slot) => ({ dataUrl: slot.source?.url || "", remoteUrl: slot.source?.remoteUrl }))
        : legacyResults.map((item, index) => (index === 0 ? { ...item, dataUrl: inlineDataUrl || item.dataUrl, remoteUrl: remoteUrl || item.remoteUrl } : item));
    if (resultClaim) {
        const captured = await captureProviderNativeResult(task, { ...normalizedResults[0], results: normalizedResults }, origin, authContext, resultClaim);
        if (captured.state !== "native_ready") throw new Error("Native image result acquisition did not retain the current image claim");
        const sealed = await getImageTask(current.id);
        if (!sealed) throw new Error("Native image task disappeared before result processing");
        return persistNativeImageTaskResult(sealed, resultClaim);
    }
    let prepared: Awaited<ReturnType<typeof prepareImageTaskResults>>;
    try {
        prepared = await prepareImageTaskResults(current, { ...normalizedResults[0], results: normalizedResults }, origin, authContext);
        results = prepared.results;
    } catch (error) {
        return markImageTaskFailed(current, error instanceof Error ? error.message : "上游返回的图片文件无效或保存失败");
    }
    try {
        await updateImageTask(current.id, { result: { ...(results[0] || { dataUrl: "" }), ...prepared } });
    } catch (error) {
        await deletePreparedImageTaskResults(results);
        throw error;
    }
    return completeImageResult(current, results);
}

export async function markImageTaskFailed(task: ImageTask, error: string) {
    const current = (await getImageTask(task.id)) || task;
    if (current.status === "success" || current.status === "cancelled") return current;
    const attempts = finishGenerationAttempt(current.attempts || [], current.attemptNo || current.attempts?.at(-1)?.attemptNo || 1, {
        status: "failed",
        error,
        pointsCost: current.billing?.pointsCost,
        pointsRecordId: current.billing?.pointsRecordId,
    });
    const failed = await transitionImageTask(current, ["pending", "running"], { status: "error", error: error.slice(0, 500), retryable: true, billing: current.billing });
    if (!failed) {
        const latest = await getImageTask(current.id);
        if (latest?.status === "error" || latest?.status === "cancelled") return refundImageTask(latest);
        return latest;
    }
    await updateImageTask(current.id, { attempts, candidateConfigs: [], attemptNo: attempts.at(-1)?.attemptNo });
    const refunded = await refundImageTask(failed);
    await writeImageGenerationLog({ ...refunded, retryable: true }, "failed", "", Date.now() - current.createdAt, error).catch((logError) => console.error("Image generation failure log write failed", logError));
    return refunded;
}

async function handleImageProviderResult(task: ImageTask, result: ImageTaskRunResult, origin: string, authContext: string): Promise<ImageUpstreamStep> {
    const billing = result.pointsRecordId ? { pointsCost: result.pointsCost ?? 0, pointsRecordId: result.pointsRecordId, refunded: false } : undefined;
    if (billing) await updateImageTask(task.id, { billing });
    if (result.needsReview) {
        const submittedAt = Date.now();
        await updateImageTask(task.id, { upstream: result.needsReview.upstream, billing });
        await scheduleGenerationTask("image", task.id, {
            executionPhase: "needs_review",
            upstreamTaskId: result.needsReview.upstream.id,
            channelId: task.config.channelId,
            provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
            queryPath: result.needsReview.upstream.explicitPollUrl || task.config.advancedConfig?.queryPath,
            submittedAt,
            nextPollAt: undefined,
            lastUpstreamStatus: "query_contract_missing",
            resultPayload: { reviewReason: result.needsReview.reason.slice(0, 500) },
        });
        return { state: "needs_review", reason: result.needsReview.reason, status: "query_contract_missing" };
    }
    if (result.pending) {
        const submittedAt = Date.now();
        await updateImageTask(task.id, { upstream: result.pending, billing });
        await scheduleGenerationTask("image", task.id, {
            executionPhase: "submitted",
            upstreamTaskId: result.pending.id,
            channelId: task.config.channelId,
            provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
            queryPath: result.pending.explicitPollUrl || task.config.advancedConfig?.queryPath,
            submittedAt,
            nextPollAt: submittedAt,
            lastUpstreamStatus: "submitted",
        });
        return { state: "pending", upstream: result.pending, status: "submitted" };
    }
    if (usesImageTaskResultProcessing(task)) {
        const captured = await captureProviderNativeResult(task, result, origin, authContext, await imageTaskResultClaim(task));
        if (captured.state === "needs_review") return captured;
        if (captured.state !== "native_ready") throw new Error("Native image provider result lost its original image claim");
        const first = captured.nativeResults.slots.find((slot) => slot.status === "stored");
        if (!first || first.status !== "stored") throw new Error("Native image provider result has no stored slot");
        return { state: "result_ready", resultUrl: `/api/reference-assets/${first.storageKey.split("/").map(encodeURIComponent).join("/")}`, status: "native_ready" };
    }
    let prepared: Awaited<ReturnType<typeof prepareImageTaskResults>>;
    try {
        prepared = await prepareImageTaskResults(task, result, origin, authContext);
    } catch (error) {
        return { state: "failed", error: error instanceof Error ? error.message : "上游返回的图片文件无效或保存失败", status: "failed" };
    }
    const results = prepared.results;
    const first = results[0];
    if (!first && !prepared.batchEvidence) return { state: "failed", error: "上游返回的图片文件无效或保存失败", status: "failed" };
    const current = await getImageTask(task.id);
    if (!current || current.status === "cancelled") {
        await deletePreparedImageTaskResults(results);
        return { state: "failed", error: "任务已取消", status: "cancelled" };
    }
    try {
        await updateImageTask(task.id, { result: { ...(first || { dataUrl: "" }), ...prepared } });
    } catch (error) {
        await deletePreparedImageTaskResults(results);
        return { state: "failed", error: error instanceof Error ? error.message : "上游返回的图片文件无效或保存失败", status: "failed" };
    }
    return readyImageStep({ ...task, result: { ...(first || { dataUrl: "" }), ...prepared } }, first?.serverUrl || first?.dataUrl || "");
}

type ImageTaskResultClaim = { taskId: string; workerId: string; executionId: string };

async function imageTaskResultClaim(task: ImageTask): Promise<ImageTaskResultClaim> {
    const record = await getStoredGenerationTaskRecord("image", task.id);
    if (!record) throw new Error("Image result processing requires its current generation claim");
    const current = record.payload as ImageTask;
    const now = Date.now();
    if (
        !record.workerId ||
        typeof task.executionId !== "string" ||
        record.userId !== task.userId ||
        current.id !== task.id ||
        current.userId !== task.userId ||
        (record.status !== "pending" && record.status !== "running") ||
        current.status !== record.status ||
        record.expiresAt <= now ||
        !(Number(record.leaseUntil) > now) ||
        current.executionId !== task.executionId ||
        current.attemptNo !== task.attemptNo ||
        (record.upstreamTaskId ?? null) !== (task.upstream?.id ?? null) ||
        (current.upstream?.id ?? null) !== (task.upstream?.id ?? null)
    )
        throw new Error("Image result processing requires its current generation claim");
    return { taskId: task.id, workerId: record.workerId, executionId: task.executionId };
}

async function captureProviderNativeResult(task: ImageTask, result: ImageTaskRunResult, origin: string, authContext: string, identity: ImageTaskResultClaim) {
    return captureImageTaskNativeResults({ ...identity, attemptNo: task.attemptNo || 1, upstreamTaskId: task.upstream?.id || null, result, origin, authContext });
}

async function persistNativeImageTaskResult(task: ImageTask, identity: ImageTaskResultClaim) {
    const outcome = await ensureImageTaskResultProcessing(identity);
    if (outcome.state === "ownership_lost") throw new Error("Image result processing lost its current generation claim");
    if (outcome.state === "ready") {
        const consumed = await consumeCompletedImageTaskResultProcessing(identity);
        if (consumed.state !== "completed") throw new Error("Image result consumption lost its current generation claim");
    }
    return getImageTask(task.id);
}

async function readyImageStep(task: ImageTask, resultUrl: string): Promise<ImageUpstreamStep> {
    if (!resultUrl && task.result?.batchEvidence) {
        await completeImageResult(task, []);
        return { state: "completed" };
    }
    if (!stableMediaUrl(resultUrl)) return { state: "failed", error: "上游返回的图片文件无效或保存失败", status: "failed" };
    await persistReadyImageSchedule(task, resultUrl);
    return { state: "result_ready", resultUrl, status: "completed" };
}

function persistReadyImageSchedule(task: ImageTask, resultUrl: string) {
    return scheduleGenerationTask("image", task.id, {
        executionPhase: "result_ready",
        channelId: task.config.channelId,
        provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
        nextPollAt: Date.now(),
        lastUpstreamStatus: "completed",
        resultPayload: { url: resultUrl },
    });
}

async function refundImageCandidate(task: ImageTask) {
    const current = await getImageTask(task.id);
    const billing = current?.billing;
    if (!billing?.pointsRecordId || billing.refunded) return;
    const settings = await getAuthSettings();
    await refundUserPoints(
        task.userId,
        generationModelId(task.config),
        billing.pointsCost,
        "image",
        imageUnits(task.config.quality, settings.generationPointMultipliers.imageQuality),
        `image-task:${task.id}:attempt:${task.attemptNo || 1}:refund`,
        billing.pointsRecordId,
    );
}

async function completeImageResult(task: ImageTask, safeResults: StoredImageTaskMediaResult[]) {
    const beforePersistence = await getImageTask(task.id);
    if (!beforePersistence || beforePersistence.status === "cancelled") {
        if (beforePersistence?.status === "cancelled") await refundImageTask(beforePersistence);
        return beforePersistence;
    }
    task = beforePersistence;
    const current = await getImageTask(task.id);
    if (!current || current.status === "cancelled") {
        if (current?.status === "cancelled") await refundImageTask(current);
        return current;
    }
    const completed = await transitionImageTask(current, ["pending", "running"], {
        status: "success",
        result: { ...(safeResults[0] || { dataUrl: "" }), results: safeResults, ...(task.result?.batchEvidence ? { batchEvidence: task.result.batchEvidence } : {}) },
        pointsRemaining: task.pointsRemaining,
        retryable: false,
    });
    if (!completed) {
        const latest = await getImageTask(task.id);
        if (latest?.status === "cancelled") await refundImageTask(latest);
        return latest;
    }
    const logged = await writeImageGenerationLog(completed, "success", safeResults, Date.now() - completed.createdAt).catch((logError) => {
        console.error("Image generation success log write failed", logError);
        return undefined;
    });
    const loggedAssets = logged?.assets?.length ? logged.assets : logged?.asset ? [logged.asset] : [];
    const finalResults =
        loggedAssets.length && !completed.ecommerceExecution?.canvas && !completed.sceneProtection
            ? safeResults.map((media, index) => {
                  const asset = loggedAssets[index];
                  return media.nativeSource || !asset
                      ? media
                      : { ...media, dataUrl: asset.serverUrl || asset.url, remoteUrl: asset.remoteUrl, serverUrl: asset.serverUrl, width: asset.width, height: asset.height, bytes: asset.bytes, mimeType: asset.mimeType };
              })
            : safeResults;
    const finalResult = finalResults[0];
    const attempts = finishGenerationAttempt(completed.attempts || [], completed.attemptNo || completed.attempts?.at(-1)?.attemptNo || 1, {
        status: "succeeded",
        pointsCost: completed.billing?.pointsCost,
        pointsRecordId: completed.billing?.pointsRecordId,
    });
    const finalized =
        (await updateImageTask(task.id, {
            result: { ...(finalResult || { dataUrl: "" }), results: finalResults, ...(completed.result?.batchEvidence ? { batchEvidence: completed.result.batchEvidence } : {}) },
            config: { ...completed.config, apiKey: "system" },
            candidateConfigs: [],
            attempts,
            attemptNo: attempts.at(-1)?.attemptNo,
        })) || completed;
    const assets = (finalized.result?.results?.length ? finalized.result.results : finalized.result ? [finalized.result] : []).flatMap((item) => {
        const url = item.serverUrl || item.remoteUrl || stableMediaUrl(item.dataUrl);
        return url ? [{ type: "image" as const, url, mimeType: item.mimeType, width: item.width, height: item.height, bytes: item.bytes, ...publicImageResultEnhancement(item) }] : [];
    });
    if (assets.length)
        await registerGenerationTaskAssetsForUser(finalized.userId, {
            ...finalized,
            taskId: finalized.id,
            title: finalized.title || finalized.prompt.slice(0, 80),
            assets,
        }).catch((error) => console.error("Creative image asset registration failed", error));
    return finalized;
}

function usesDeclarativeImageProtocol(protocol: NonNullable<ImageTask["config"]["advancedConfig"]>["protocol"] | undefined) {
    return protocol === "custom" || protocol === "stable-diffusion" || protocol === "yumeng";
}
