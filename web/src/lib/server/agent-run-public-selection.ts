import type { AgentRun } from "./agent-run-store";
import { publicAgentRun, publicAgentRunSnapshot } from "./agent-run-public";
import { ecommerceSceneSelectionTask } from "./ecommerce-generation-snapshot";
import { getCreativeAssetsByIds } from "./creative-runtime-store";
import { readCompletedEcommerceReference, verifyPreparedEcommerceReferenceSource } from "./ecommerce-reference-preparation";
import { resolveInternalOrigin } from "./internal-origin";
import { originalImageSourceUrl } from "@/lib/media-image-url";
import type { CreativeReferenceReview } from "@/lib/creative-runtime-contract";
import { allowedEcommerceReferencePurposes } from "./ecommerce-reference-purpose";
import { referenceReviewKind, referenceReviewQuestion, referenceSourceTuple, unsubmittedReferenceCheckpoint } from "./ecommerce-reference-recovery";
import { listStoredGenerationTaskRecordsByRunIds } from "./generation-task-store";
import { canContinueCreatedImageReference, canRecoverImageNativeResult, canRecoverUnsubmittedImageMask, canRecoverUnsubmittedImageReference } from "./generation-task-scheduler";
import { imageProcessingRecoveryForRun } from "./image-processing-service";

export async function publicAgentRunForRequest(run: AgentRun, request: Request) {
    return {
        ...publicAgentRun(run),
        ecommerceSceneSelection: await sceneSelectionAction(run, request),
        ecommerceReferenceReview: await referenceReviewAction(run),
        canCheckStatus: await canCheckRunStatus(run),
        imageProcessingRecovery: await imageProcessingRecoveryForRun(run),
    };
}

export async function publicAgentRunSnapshotForRequest(run: AgentRun, request: Request) {
    return {
        ...publicAgentRunSnapshot(run),
        ecommerceSceneSelection: await sceneSelectionAction(run, request),
        ecommerceReferenceReview: await referenceReviewAction(run),
        canCheckStatus: await canCheckRunStatus(run),
        imageProcessingRecovery: await imageProcessingRecoveryForRun(run),
    };
}

async function canCheckRunStatus(run: AgentRun) {
    if (run.surface !== "chat" || run.status !== "paused" || run.cancellation || run.ecommerceSnapshot?.qualityCheck) return false;
    const ids = run.tasks
        .filter((task) => task.type === "image" && task.status === "needs_review")
        .flatMap((task) => (task.childTasks?.length ? task.childTasks.filter((child) => child.status === "needs_review").map((child) => child.id) : task.taskIds?.length ? task.taskIds : task.taskId ? [task.taskId] : []));
    if (!ids.length) return false;
    const records = await listStoredGenerationTaskRecordsByRunIds([run.id], [run.userId]);
    let needsRecovery = false;
    const canContinue = ids.every((id) => {
        const record = records.find((task) => task.id === id && task.type === "image" && task.userId === run.userId && task.runId === run.id && task.conversationId === run.conversationId);
        if (!record) return false;
        const upstream = record.upstreamTaskId || (record.payload.upstream as { id?: string } | undefined)?.id;
        if (["pending", "running"].includes(record.status) && record.executionPhase === "needs_review") {
            const recoverable = Boolean((record.status === "running" && (upstream || canRecoverUnsubmittedImageReference(record) || canRecoverImageNativeResult(record))) || canRecoverUnsubmittedImageMask(record));
            needsRecovery ||= recoverable;
            return recoverable;
        }
        return (
            canContinueCreatedImageReference(record) ||
            (record.status === "success" && record.executionPhase === "completed") ||
            (record.status === "running" && Boolean(upstream) && ["submitted", "polling", "result_ready", "persisting"].includes(record.executionPhase || ""))
        );
    });
    return canContinue && needsRecovery;
}

async function referenceReviewAction(run: AgentRun): Promise<CreativeReferenceReview | null> {
    const checkpoint = run.ecommerceSnapshot?.referenceCheckpoint;
    if (!unsubmittedReferenceCheckpoint(run) || checkpoint?.version !== "ecommerce-reference-checkpoint.v1" || checkpoint.state !== "needs_review") return null;
    const owned = await getCreativeAssetsByIds(
        checkpoint.assets.map((item) => item.asset.id),
        run.userId,
    );
    if (
        checkpoint.assets.some((item) => {
            const asset = owned.find((value) => value.id === item.asset.id && value.userId === run.userId && value.conversationId === run.conversationId && value.type === "image" && value.status === "ready");
            return !asset || referenceSourceTuple(asset).some((value, index) => value !== referenceSourceTuple(item.asset)[index]);
        })
    )
        return null;
    const assets: CreativeReferenceReview["assets"] = [];
    for (const item of checkpoint.assets.filter((value) => value.alias)) {
        const source = item.asset.serverUrl || "";
        if (!/^\/api\/(reference-assets|generation-log-assets)\//.test(source)) return null;
        const previewUrl = new URL(originalImageSourceUrl(source), "http://reference.local").pathname;
        if (!/^\/api\/(reference-assets|generation-log-assets)\//.test(previewUrl)) return null;
        assets.push({
            assetId: item.asset.id,
            assetVersion: item.assetVersion,
            alias: item.alias,
            previewUrl,
            purposes: [...(checkpoint.decision?.bindings.find((binding) => binding.assetId === item.asset.id)?.purposes || [])],
            allowedPurposes: allowedEcommerceReferencePurposes(checkpoint.analysis?.references.find((reference) => reference.assetId === item.asset.id)),
        });
    }
    const kind = referenceReviewKind(checkpoint);
    const inheritedId = checkpoint.planningInput.inheritedReferences?.editTargetId;
    const inherited = checkpoint.assets.find((item) => item.asset.id === inheritedId && !item.alias);
    let inheritedEditTarget: CreativeReferenceReview["inheritedEditTarget"];
    if (kind === "confirm_purposes" && inherited && allowedEcommerceReferencePurposes(checkpoint.analysis?.references.find((reference) => reference.assetId === inheritedId)).includes("edit_target")) {
        const source = inherited.asset.serverUrl || "";
        if (!/^\/api\/(reference-assets|generation-log-assets)\//.test(source)) return null;
        const previewUrl = new URL(originalImageSourceUrl(source), "http://reference.local").pathname;
        if (!/^\/api\/(reference-assets|generation-log-assets)\//.test(previewUrl)) return null;
        inheritedEditTarget = { assetId: inherited.asset.id, previewUrl };
    }
    return { version: "ecommerce-reference-review.v1", reviewId: checkpoint.reviewId, kind, question: referenceReviewQuestion(checkpoint), assets, ...(inheritedEditTarget ? { inheritedEditTarget } : {}) };
}

async function sceneSelectionAction(run: AgentRun, request: Request) {
    if (run.surface !== "chat" || !ecommerceSceneSelectionTask(run)) return undefined;
    const plan = run.ecommerceSnapshot!.plan!;
    const baselineAssetId = plan.source.currentSceneBaselineId!;
    try {
        const prepared = await readCompletedEcommerceReference(run, baselineAssetId);
        if (!prepared) return undefined;
        const source = prepared.sourceUrl.trim();
        if (!/^\/api\/(reference-assets|generation-log-assets)\//.test(source)) return undefined;
        const url = new URL(originalImageSourceUrl(source), request.url).pathname;
        if (!/^\/api\/(reference-assets|generation-log-assets)\//.test(url)) return undefined;
        const size = prepared.sourceSize;
        if (plan.canvas?.mode !== "exact" || plan.canvas.size.width !== size.width || plan.canvas.size.height !== size.height) return undefined;
        await verifyPreparedEcommerceReferenceSource({ ...prepared, sourceUrl: url }, resolveInternalOrigin(new URL(request.url).origin), request.headers.get("cookie") || "");
        return { action: "confirm_scene_selection" as const, baselineAssetId, url, width: size.width, height: size.height };
    } catch {
        return undefined;
    }
}
