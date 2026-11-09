import sharp from "sharp";
import { imageMimeType } from "@/lib/image-processing/generated-image";
import { ECOMMERCE_IMAGE_MAX_INPUT_PIXELS } from "./ecommerce-vision-image";
import { referenceAssetVersion } from "./ecommerce-reference-recovery";
import { getAuthSettings } from "@/lib/auth/store";
import { getAgentRun, updateAgentRunById, type AgentRun } from "./agent-run-store";
import { getCreativeAssetsByIds } from "./creative-runtime-store";
import { getImageTask, type ImageTask } from "./image-task-store";
import type { GenerationTaskLease } from "./generation-task-scheduler";
import type { EcommerceVisualReviewCheckpoint, EcommerceVisualReviewSource } from "./ecommerce-generation-snapshot";
import { ECOMMERCE_REVIEW_PREPARATION_VERSION, reviewContextDigest, reviewDigest, reviewMediaTuple, reviewQualityDigest, reviewSourceTuple } from "./ecommerce-visual-review-identity";
import { enqueueEcommerceReviewPreparation, freezeEcommerceReviewSource, loadEcommerceReviewViews, projectEcommerceReviewTrace, type EcommerceReviewClaim } from "./image-processing-service";
import { imageTaskResultReferenceLocation } from "./image-task-result-contract";
import { writeReferenceMediaDataUrl } from "./reference-asset-store";
import { checkEcommerceResultWithFallback, ecommerceResultDeliveryGate, qualityImageBytes, unavailableEcommerceQualityCheck, type EcommerceQualityCheck, type EcommerceQualityCheckRequest } from "./ecommerce-quality-check";
import { resolveEcommerceRoleCandidates, routeEcommerceRole, type EcommerceRoleCandidate, type EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import { StructuredTextSubmissionRejectedError } from "./text-planning-runtime";
import { buildEcommerceGenerationTrace } from "./ecommerce-generation-trace";

class ReviewOwnershipLostError extends Error {}

function frozenRegistrations(checkpoint: EcommerceVisualReviewCheckpoint) {
    return checkpoint.sources.flatMap((source) => (source.frozen ? [{ ...source.frozen.location, bytes: source.frozen.bytes, mimeType: source.frozen.mimeType }] : []));
}

function unavailableSubmission(checkpoint: EcommerceVisualReviewCheckpoint, reason: string): EcommerceVisualReviewCheckpoint["submission"] {
    const submission = checkpoint.submission;
    return submission.state === "started" || submission.state === "unknown" ? { state: "unknown", requestDigest: submission.requestDigest, reason } : { state: "failed", reason };
}

async function reviewInputs(run: AgentRun, origin: string, cookie: string) {
    const snapshot = run.ecommerceSnapshot;
    const plan = snapshot?.plan;
    const task = run.tasks.length === 1 ? run.tasks[0] : undefined;
    if (!plan || snapshot?.technicalCheck?.status !== "passed" || !task?.ecommerceExecution || task.status !== "completed") throw new Error("已交付视觉复核证据缺失");
    const ids = task.taskIds || (task.taskId ? [task.taskId] : []);
    const images: ImageTask[] = [];
    for (const id of ids) {
        const image = await getImageTask(id);
        if (!image || image.userId !== run.userId || image.runId !== run.id || ![run.id, task.id].includes(image.parentTaskId || "") || image.status !== "success") throw new Error("已交付图片身份不符");
        images.push(image);
    }
    const baselineId = plan.operation === "product_to_scene" ? plan.source.productAnchorId : plan.source.currentSceneBaselineId || plan.source.productAnchorId;
    const baseline = task.references?.find((reference) => reference.assetId === baselineId && reference.url);
    const anchor = task.references?.find((reference) => reference.ecommerceRole === "product" && reference.assetId && reference.assetId !== baselineId && reference.url);
    if (!baseline?.assetId) throw new Error("验收基线图片不可用");
    const references = [baseline, ...(anchor ? [anchor] : [])];
    const assets = await getCreativeAssetsByIds(
        references.map((reference) => reference.assetId!),
        run.userId,
    );
    const sources: EcommerceVisualReviewSource[] = references.map((reference, index) => {
        const asset = assets.find((item) => item.id === reference.assetId);
        if (!asset || asset.userId !== run.userId || asset.conversationId !== run.conversationId || asset.type !== "image" || asset.status !== "ready") throw new Error("验收参考素材身份不符");
        const accepted = snapshot.referenceCheckpoint?.assets.find((item) => item.asset.id === asset.id);
        const sha256 = accepted?.contentSha256 || (typeof asset.metadata.sha256 === "string" ? asset.metadata.sha256 : undefined);
        if (accepted && accepted.assetVersion !== referenceAssetVersion(asset, accepted.contentSha256)) throw new Error("验收参考素材版本已变化");
        return { source: index === 0 ? "baseline" : "productAnchor", original: { assetId: asset.id, assetVersion: referenceAssetVersion(asset, sha256), url: reference.url, ...(sha256 ? { sha256 } : {}) } };
    });
    const resultImages: EcommerceQualityCheckRequest["resultImages"] = [];
    for (const image of images) {
        const media = image.result?.results?.length ? image.result.results : image.result?.batchEvidence ? [] : image.result ? [image.result] : [];
        for (const [index, result] of media.entries()) {
            const resultId = result.resultId || `${image.id}:${index + 1}`;
            const url = result.serverUrl || result.dataUrl;
            if (!url) throw new Error("已交付图片原件缺失");
            const resultDigest = reviewDigest(reviewMediaTuple(result));
            sources.push({ source: `result:${resultId}`, original: { assetId: resultId, assetVersion: resultDigest, url, imageTaskId: image.id, resultId, resultDigest } });
            resultImages.push({
                resultId,
                url,
                ...(result.canvasEvidence ? { nativeUrl: result.canvasEvidence.nativeUrl, nativeSize: result.canvasEvidence.nativeSize } : {}),
                ...(result.sceneProtectionEvidence ? { sceneProtectionEvidence: structuredClone(result.sceneProtectionEvidence) } : {}),
            });
        }
    }
    if (!resultImages.length) throw new Error("已交付结果图片缺失");
    const input: EcommerceQualityCheckRequest = {
        origin,
        cookie,
        userId: run.userId,
        requestId: `${run.id}:${task.id}:${ids.join(",")}`,
        plan,
        baselineReference: { assetId: baseline.assetId, url: baseline.url, role: baselineId === plan.source.currentSceneBaselineId ? "scene" : "product" },
        ...(anchor ? { productAnchorReference: { assetId: anchor.assetId!, url: anchor.url } } : {}),
        analysisVisibleStructure: snapshot.visualAnalysis?.references.find((reference) => reference.assetId === baselineId)?.visibleStructure,
        resultImages,
        ...(images.some((image) => image.result?.batchEvidence) ? { batchEvidence: images.flatMap((image) => image.result?.batchEvidence || []) } : {}),
    };
    return { input, sources, contextDigest: reviewContextDigest(run, images), ids, task };
}

function qualityCandidates(settings: Awaited<ReturnType<typeof getAuthSettings>>, snapshot: EcommerceRoleRouteSnapshot | undefined) {
    const candidates = [snapshot ? routeEcommerceRole(settings, "quality_check", snapshot) : null, ...resolveEcommerceRoleCandidates(settings, "quality_check", "text")];
    const seen = new Set<string>();
    return candidates.filter((candidate): candidate is EcommerceRoleCandidate => {
        if (!candidate) return false;
        const key = reviewDigest([candidate.logicalModelId, candidate.channelId, candidate.upstreamModel]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export async function processIndependentEcommerceReview(observed: AgentRun, origin: string, cookie: string, lease: GenerationTaskLease) {
    const attempts = observed.reviewAttempts || 0;
    if (!lease.workerId || !lease.executionId || lease.id !== observed.id || observed.executionId !== lease.executionId) return { status: "ownership_lost" as const, attempts };
    const claim: EcommerceReviewClaim = { workerId: lease.workerId, executionId: lease.executionId };
    let active = observed;
    let currentContextDigest: string | undefined;
    const update = async (checkpoint: EcommerceVisualReviewCheckpoint, patch: Partial<AgentRun> = {}, terminal = false) => {
        const gate = terminal ? ecommerceResultDeliveryGate(active.ecommerceSnapshot!.technicalCheck!, patch.ecommerceSnapshot!.qualityCheck) : undefined;
        const updated = await updateAgentRunById(
            active.id,
            { ...patch, ecommerceSnapshot: { ...active.ecommerceSnapshot!, ...(patch.ecommerceSnapshot || {}), visualReview: checkpoint } },
            { type: terminal ? "ecommerce.quality" : "run.review.checkpoint", data: gate ? { status: gate.publicStatus, text: gate.publicMessage } : { attempt: checkpoint.attempt } },
            ["completed"],
            claim.executionId,
            active.tasks,
            {
                attempts: active.reviewAttempts || 0,
                reviewed: false,
                ...(active.ecommerceSnapshot?.visualReview ? { contextDigest: active.ecommerceSnapshot.visualReview.contextDigest } : {}),
                currentContextDigest,
                sources: checkpoint.failure || (terminal && patch.ecommerceSnapshot?.qualityCheck?.status === "unavailable" && checkpoint.submission.state !== "completed") ? [] : frozenRegistrations(checkpoint),
                claim,
            },
        );
        if (!updated) throw new ReviewOwnershipLostError("视觉复核执行身份或上下文已变化");
        active = updated;
        return updated;
    };
    const fallbackRole = active.ecommerceSnapshot?.modelRouteSnapshots?.quality_check || { logicalRole: "quality_check" as const, capability: "text" as const, logicalModelId: "", channelId: "", upstreamModel: "", apiFormat: "openai" as const };
    const settle = async (quality: EcommerceQualityCheck, submission: EcommerceVisualReviewCheckpoint["submission"]) => {
        const checkpoint = active.ecommerceSnapshot!.visualReview!;
        const completed = await update(
            { ...checkpoint, submission },
            {
                reviewed: true,
                reviewStatus: quality.status === "unavailable" ? "review_unavailable" : "review_completed",
                ecommerceSnapshot: { ...active.ecommerceSnapshot!, qualityCheck: quality },
                timings: { ...(active.timings || { requestAcceptedAt: active.createdAt }), reviewCompletedAt: Date.now() },
            },
            true,
        );
        const task = completed.tasks[0];
        const ids = task.taskIds || (task.taskId ? [task.taskId] : []);
        const trace = buildEcommerceGenerationTrace({ runId: completed.id, task, snapshot: completed.ecommerceSnapshot!, imageTaskIds: ids, generationStatus: "completed", finalStatus: "completed", recordedAt: completed.timings!.reviewCompletedAt });
        try {
            await projectEcommerceReviewTrace(completed, claim, reviewQualityDigest(quality), trace, currentContextDigest);
            // Reconciliation uses an expected trace CAS and can restore interrupted projections from the authoritative parent.
            // Eager log writes are performed by the same reconciliation path, never by an unfenced late reviewer.
        } catch (error) {
            console.error("[ecommerce-generation-trace] review projection pending", error instanceof Error ? error.message : "unknown error");
        }
        return { status: quality.status === "unavailable" ? ("unavailable" as const) : ("completed" as const), attempts: checkpoint.attempt };
    };
    try {
        const inputs = await reviewInputs(active, origin, cookie);
        currentContextDigest = inputs.contextDigest;
        const existing = active.ecommerceSnapshot?.visualReview;
        if (existing && existing.contextDigest !== inputs.contextDigest) {
            await update({ ...existing, failure: { code: "review_context_changed", message: "已交付视觉复核上下文已变化" } });
            return await settle(unavailableEcommerceQualityCheck("已交付视觉复核上下文已变化", fallbackRole), unavailableSubmission(existing, "review_context_changed"));
        }
        if (existing && reviewDigest(existing.sources.map((source) => reviewSourceTuple({ source: source.source, original: source.original }))) !== reviewDigest(inputs.sources.map(reviewSourceTuple))) {
            await update({ ...existing, failure: { code: "review_source_changed", message: "视觉复核原件描述已变化" } });
            return await settle(unavailableEcommerceQualityCheck("视觉复核原件描述已变化", fallbackRole), unavailableSubmission(existing, "review_source_changed"));
        }
        if (!existing)
            await update(
                { version: "ecommerce-visual-review.v1", attempt: attempts + 1, contextDigest: inputs.contextDigest, algorithmVersion: ECOMMERCE_REVIEW_PREPARATION_VERSION, sources: inputs.sources, views: [], submission: { state: "not_submitted" } },
                { reviewStatus: "reviewing", reviewAttempts: attempts + 1 },
            );
        let checkpoint = active.ecommerceSnapshot!.visualReview!;
        if (checkpoint.submission.state === "started" || checkpoint.submission.state === "unknown")
            return await settle(unavailableEcommerceQualityCheck("视觉复核提交结果未知，保留已交付图片", fallbackRole), { state: "unknown", requestDigest: checkpoint.submission.requestDigest, reason: "视觉复核提交中断，不能确认上游结果" });
        for (const [index, source] of checkpoint.sources.entries()) {
            if (source.frozen) continue;
            let location = imageTaskResultReferenceLocation({ dataUrl: "", url: source.original.url });
            if (!location) {
                const bytes = await qualityImageBytes(source.original.url, inputs.input);
                const mimeType = imageMimeType(await sharp(bytes, { limitInputPixels: ECOMMERCE_IMAGE_MAX_INPUT_PIXELS, failOn: "error" }).metadata());
                const stored = await writeReferenceMediaDataUrl(`data:${mimeType};base64,${bytes.toString("base64")}`, "image", { ownerUserId: active.userId, source: "ecommerce-visual-review", conversationId: active.conversationId, runId: active.id });
                location = { scope: "reference", storageKey: stored.token };
            }
            const frozen = await freezeEcommerceReviewSource(active, source, location);
            checkpoint = { ...checkpoint, sources: checkpoint.sources.map((item, slot) => (slot === index ? frozen : item)) };
            await update(checkpoint);
        }
        const preparation = await enqueueEcommerceReviewPreparation(active, claim, checkpoint.sources);
        active = preparation.run;
        if (preparation.status === "waiting") return { status: "waiting" as const, attempts: checkpoint.attempt };
        checkpoint = active.ecommerceSnapshot!.visualReview!;
        if (checkpoint.failure) return await settle(unavailableEcommerceQualityCheck(checkpoint.failure.message, fallbackRole), { state: "failed", reason: checkpoint.failure.code });
        const views = await loadEcommerceReviewViews(active);
        const settings = await getAuthSettings();
        const candidates = qualityCandidates(settings, active.ecommerceSnapshot?.modelRouteSnapshots?.quality_check);
        if (!candidates.length) return await settle(unavailableEcommerceQualityCheck("结果验收模型快照不可用", fallbackRole), { state: "failed", reason: "quality_route_unavailable" });
        const quality = await checkEcommerceResultWithFallback(inputs.input, candidates, active.ecommerceSnapshot!.technicalCheck, {
            views,
            onBeforeRequest: async (candidate, submission) => {
                checkpoint = { ...active.ecommerceSnapshot!.visualReview!, submission: { state: "started", modelRole: { ...candidate.snapshot }, ...submission, startedAt: Date.now() } };
                await update(checkpoint);
            },
        });
        const submitted = active.ecommerceSnapshot!.visualReview!.submission;
        return await settle(
            quality,
            submitted.state === "started" && quality.observations
                ? { state: "completed", requestDigest: submitted.requestDigest, completedAt: Date.now() }
                : { state: "failed", ...(submitted.state === "started" ? { requestDigest: submitted.requestDigest } : {}), reason: quality.internalReason },
        );
    } catch (error) {
        if (error instanceof ReviewOwnershipLostError || error instanceof StructuredTextSubmissionRejectedError) return { status: "ownership_lost" as const, attempts: active.reviewAttempts || attempts };
        const latest = await getAgentRun(active.id);
        if (!latest || latest.executionId !== claim.executionId || latest.reviewed) return { status: "ownership_lost" as const, attempts: active.reviewAttempts || attempts };
        active = latest;
        const checkpoint = active.ecommerceSnapshot?.visualReview;
        const reason = error instanceof Error ? error.message : "视觉复核暂时不可用";
        if (!checkpoint) {
            const quality = unavailableEcommerceQualityCheck(reason, fallbackRole);
            const saved = await updateAgentRunById(
                active.id,
                { reviewed: true, reviewStatus: "review_unavailable", ecommerceSnapshot: { ...active.ecommerceSnapshot!, qualityCheck: quality }, timings: { ...(active.timings || { requestAcceptedAt: active.createdAt }), reviewCompletedAt: Date.now() } },
                { type: "run.review.unavailable", data: { status: "unavailable" } },
                ["completed"],
                claim.executionId,
                active.tasks,
                { attempts: active.reviewAttempts || 0, reviewed: false, claim },
            );
            return { status: saved ? ("unavailable" as const) : ("ownership_lost" as const), attempts: active.reviewAttempts || attempts };
        }
        try {
            return await settle(unavailableEcommerceQualityCheck(reason, fallbackRole), unavailableSubmission(checkpoint, reason));
        } catch (settlementError) {
            if (settlementError instanceof ReviewOwnershipLostError) return { status: "ownership_lost" as const, attempts: checkpoint.attempt };
            throw settlementError;
        }
    }
}
