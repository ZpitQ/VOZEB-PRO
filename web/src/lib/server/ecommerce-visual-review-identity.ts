import { createHash } from "node:crypto";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import type { EcommerceEditPlan, EcommerceCanvasConstraint, EcommerceDimensions, EcommerceManualRegion } from "./ecommerce-edit-plan";
import type { EcommerceCompiledImageRequest } from "./ecommerce-image-compiler";
import type { EcommerceQualityCheck, EcommerceQualityCheckItem, EcommerceCanvasQualityEvidence, EcommerceResultTechnicalCheck } from "./ecommerce-quality-check";
import { ecommerceRunForTask, type EcommerceVisualReviewSource } from "./ecommerce-generation-snapshot";
import type { ImageTask, StoredImageTaskMediaResult } from "./image-task-store";
import type { SceneEditProtectionEvidence } from "./ecommerce-product-regions";
import { taskResultItems } from "./agent-run-execution-helpers";

export const ECOMMERCE_REVIEW_PREPARATION_VERSION = "ecommerce-review-preparation.v1" as const;

export function independentAdvisoryReview(run: AgentRun) {
    return run.status === "completed" && run.ecommerceSnapshot?.qualityPolicy === "advisory" && ["ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"].includes(run.ecommerceSnapshot.plan?.planVersion || "");
}

export function ecommerceReviewTasks(run: AgentRun) {
    return run.tasks.filter((task) => task.status === "completed" && task.ecommerceExecution);
}

export function ecommerceReviewSnapshot(run: AgentRun, taskId: string) {
    return { ...ecommerceRunForTask(run, taskId).ecommerceSnapshot!, qualityCheck: run.ecommerceSnapshot!.qualityCheck };
}

export function ecommerceReviewTechnicalCheck(run: AgentRun): EcommerceResultTechnicalCheck {
    const checks = ecommerceReviewTasks(run).map((task) => ecommerceRunForTask(run, task.id).ecommerceSnapshot?.technicalCheck);
    const completed = checks.filter((check): check is EcommerceResultTechnicalCheck => check?.status === "passed");
    if (!completed.length || completed.length !== checks.length) throw new Error("已交付图片的技术检查证据缺失");
    return {
        ...completed[0],
        checks: completed.flatMap((check) => check.checks),
        hardFailures: completed.flatMap((check) => check.hardFailures),
        canvasEvidence: completed.flatMap((check) => check.canvasEvidence),
        sceneProtectionEvidence: completed.flatMap((check) => check.sceneProtectionEvidence),
        checkedAt: Math.max(...completed.map((check) => check.checkedAt)),
    };
}

export function reviewDigest(tuple: readonly unknown[]) {
    return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}

export function reviewRegionTuple(value: EcommerceManualRegion | undefined) {
    return value ? [value.x, value.y, value.width, value.height] : null;
}

function sizeTuple(value: EcommerceDimensions | undefined) {
    return value ? [value.width, value.height] : null;
}

function canvasTuple(value: EcommerceCanvasConstraint | undefined) {
    return value ? [value.mode, sizeTuple(value.size), value.source, value.allowReframe] : null;
}

function protectionTuple(value: EcommerceEditPlan["protection"]) {
    return value ? [value.scope, value.protectedObjectIds, value.preserveOutsideMask, value.allowLightingChange] : null;
}

function photographyTuple(value: EcommerceEditPlan["photography"]) {
    return value
        ? [
              value.materials.map((item) => [item.objectId, item.textureDirection, item.textureScale, item.roughness, item.gloss]),
              [value.lighting.keyLight, value.lighting.fillLight, value.lighting.whiteBalance, value.lighting.contactShadow],
              [value.composition.focalSubject, value.composition.depth, value.composition.negativeSpace],
          ]
        : null;
}

function structureTuple(value: EcommerceEditPlan["visibleStructure"]) {
    return value?.map((item) => [item.objectId, item.feature, item.count, item.certainty, reviewRegionTuple(item.evidenceRegion)]) || [];
}

function planTuple(plan: EcommerceEditPlan) {
    const product = plan.baseline.productFacts;
    const scene = plan.baseline.sceneFacts;
    return [
        plan.planVersion,
        plan.operation,
        [plan.source.productAnchorId, plan.source.currentSceneBaselineId, plan.source.sceneReferenceIds],
        product ? [product.identity, product.outline, product.color, product.material, product.brandText, product.view] : null,
        scene ? [scene.space, scene.composition, scene.lighting] : null,
        [plan.delta.requestedChanges, plan.delta.targetObjects, plan.delta.targetRegions, reviewRegionTuple(plan.delta.manualRegion)],
        [plan.preserve.productCore, plan.preserve.sceneElements],
        plan.strategy,
        [plan.modelRoles.visionAnalysis, plan.modelRoles.editPlanning, plan.modelRoles.generation, plan.modelRoles.qualityCheck],
        [plan.continuity.parentResultId, plan.continuity.branchId],
        plan.validation.requiredChecks,
        plan.referenceUses?.map((item) => [item.assetId, item.alias, item.purposes, item.usedCueIds]) || [],
        structureTuple(plan.visibleStructure),
        canvasTuple(plan.canvas),
        protectionTuple(plan.protection),
        photographyTuple(plan.photography),
    ];
}

function executionTuple(value: EcommerceCompiledImageRequest | undefined) {
    const route = value?.modelSnapshot;
    return value
        ? [
              value.state,
              value.compilerVersion,
              value.providerProfileId,
              value.prompt,
              value.referenceRoles.map((item) => [item.assetId, item.role]),
              value.referenceMapping?.map((item) => [item.assetId, item.userAlias, item.providerIndex, item.purposes]) || [],
              canvasTuple(value.canvas),
              protectionTuple(value.protection),
              photographyTuple(value.photography),
              value.mask?.mode,
              value.mask?.required,
              value.reason,
              value.parameters.variant,
              value.parameters.size,
              route
                  ? [
                        route.logicalRole,
                        route.capability,
                        route.logicalModelId,
                        route.channelId,
                        route.upstreamModel,
                        route.apiFormat,
                        route.imageEdit ? [route.imageEdit.protocol, route.imageEdit.editPath, route.imageEdit.transport, route.imageEdit.supportsIndependentMask] : null,
                    ]
                  : null,
          ]
        : null;
}

function sceneProofTuple(value: SceneEditProtectionEvidence | undefined) {
    return value
        ? [
              value.version,
              value.sourceAssetId,
              sizeTuple(value.sourceSize),
              value.sourceDigest,
              sizeTuple(value.maskSize),
              value.maskDigest,
              reviewRegionTuple(value.targetRegion),
              value.semantics,
              value.selectionSource,
              value.confirmation ? [value.confirmation.actorUserId, value.confirmation.confirmedAt] : null,
              value.maskSemantics,
              value.method,
              sizeTuple(value.nativeSize),
              value.normalization,
              value.nativeDigest,
              value.compositeDigest,
              value.outsidePixels,
              value.mappedOutsideChangedPixels,
              value.nativeOutsideChangedPixels,
              value.compositeOutsideChangedPixels,
              value.maskUrl,
              value.nativeUrl,
              value.compositeUrl,
          ]
        : null;
}

function checkTuple(item: EcommerceQualityCheckItem) {
    const evidence = item.evidence;
    return [
        item.resultId,
        item.key,
        item.status,
        item.reason,
        item.source,
        evidence ? [evidence.objectId, evidence.feature, evidence.baselineCount, evidence.resultCount, reviewRegionTuple(evidence.baselineRegion), reviewRegionTuple(evidence.resultRegion)] : null,
    ];
}

function canvasEvidenceTuple(value: EcommerceCanvasQualityEvidence) {
    return [
        value.resultId,
        value.resultIndex,
        value.storageStatus,
        value.failureStage,
        value.failureReason,
        canvasTuple(value.constraint),
        sizeTuple(value.nativeSize),
        sizeTuple(value.storedSize),
        value.nativeUrl,
        value.storedUrl,
        value.nativeStatus,
        value.storedStatus,
        value.nativeMatches,
        value.storedMatches,
        value.normalization,
        value.mappingVerified,
        value.hardFailures,
    ];
}

function technicalTuple(value: EcommerceResultTechnicalCheck) {
    return [
        value.version,
        value.status,
        value.checkedAt,
        value.checks.map(checkTuple),
        value.hardFailures.map(checkTuple),
        value.canvasEvidence.map(canvasEvidenceTuple),
        value.sceneProtectionEvidence.map((item) => [item.resultId, sceneProofTuple(item.evidence)]),
    ];
}

export function reviewMediaTuple(media: StoredImageTaskMediaResult) {
    const canvas = media.canvasEvidence;
    const native = media.nativeSource;
    const product = media.productEnhancementEvidence;
    const composition = product?.composition;
    return [
        media.resultId,
        media.dataUrl,
        media.remoteUrl,
        media.serverUrl,
        media.width,
        media.height,
        media.bytes,
        media.mimeType,
        media.enhancementId,
        native ? [native.url, native.sha256, native.width, native.height, native.byteLength, native.format, native.hasAlpha, native.provenance] : null,
        canvas
            ? [
                  canvasTuple(canvas.constraint),
                  sizeTuple(canvas.requestedSize),
                  canvas.providerRequest ? [canvas.providerRequest.size, canvas.providerRequest.aspectRatio, canvas.providerRequest.width, canvas.providerRequest.height] : null,
                  sizeTuple(canvas.nativeSize),
                  sizeTuple(canvas.storedSize),
                  canvas.nativeUrl,
                  canvas.normalization,
              ]
            : null,
        sceneProofTuple(media.sceneProtectionEvidence),
        product && composition
            ? [
                  product.version,
                  product.nativeUrl,
                  product.nativeSha256,
                  product.baselineUrl,
                  product.baselineSha256,
                  composition.version,
                  composition.normalization,
                  composition.productAnchorId,
                  composition.sourceAssetId,
                  composition.sourceSha256,
                  composition.maskSha256,
                  composition.aiSha256,
                  composition.compositeSha256,
                  sizeTuple(composition.sourceSize),
                  sizeTuple(composition.aiSize),
                  composition.allowedPixels,
                  composition.protectedPixels,
                  composition.protectedChangedPixels,
              ]
            : null,
    ];
}

function mediaScalar(value: unknown) {
    if (value === undefined || value === null || typeof value === "string" || typeof value === "number") return value;
    throw new Error("结果媒体字段不是已验证标量");
}

function taskTuple(task: AgentRunTask) {
    // Result items are an external JSON contract; only its named scalar media fields enter this identity.
    return [
        task.id,
        task.type,
        task.status,
        task.prompt,
        task.count,
        task.quality,
        task.ratio,
        task.attempts,
        task.taskId,
        task.taskIds,
        task.assetIds,
        task.childTasks?.map((child) => [child.id, child.status, child.attempt]) || [],
        task.references?.map((reference) => [reference.assetId, reference.url, reference.type, reference.ecommerceRole]) || [],
        executionTuple(task.ecommerceExecution),
        taskResultItems(task.result).map((item) => [item.resultId, item.serverUrl, item.dataUrl, item.url, item.remoteUrl, item.width, item.height].map(mediaScalar)),
    ];
}

export function reviewContextDigest(run: AgentRun, images: readonly ImageTask[]) {
    const snapshot = run.ecommerceSnapshot;
    if (!snapshot?.plan || !snapshot.technicalCheck || !run.tasks.length) throw new Error("已交付视觉复核上下文不完整");
    const plan = snapshot.plan;
    const ids = ecommerceReviewTasks(run).flatMap((task) => task.taskIds || (task.taskId ? [task.taskId] : []));
    const orderedImages = ids.map((id) => {
        const image = images.find((item) => item.id === id);
        if (!image) throw new Error("已交付图片身份缺失");
        return image;
    });
    return reviewDigest([
        ECOMMERCE_REVIEW_PREPARATION_VERSION,
        run.id,
        run.userId,
        run.conversationId,
        planTuple(plan),
        snapshot.referenceCheckpoint?.assets.map((item) => [item.asset.id, item.assetVersion, item.contentSha256]) || [],
        run.tasks.length === 1
            ? taskTuple(run.tasks[0])
            : run.tasks.map((task) => {
                  const current = ecommerceRunForTask(run, task.id).ecommerceSnapshot!;
                  const route = current.modelRouteSnapshots?.image_generation;
                  return [
                      taskTuple(task),
                      planTuple(current.plan!),
                      current.compilerVersion,
                      [route?.logicalRole, route?.capability, route?.logicalModelId, route?.channelId, route?.upstreamModel, route?.apiFormat],
                      current.technicalCheck ? technicalTuple(current.technicalCheck) : null,
                  ];
              }),
        technicalTuple(snapshot.technicalCheck),
        orderedImages.map((image) => [
            image.id,
            image.userId,
            image.runId,
            image.parentTaskId,
            image.status,
            image.resultProcessing ? [image.resultProcessing.jobId, image.resultProcessing.inputDigest] : null,
            (image.result?.results || (image.result ? [image.result] : [])).map(reviewMediaTuple),
            image.result?.batchEvidence?.map((item) => [item.resultId, item.resultIndex, item.nativeStatus, sizeTuple(item.nativeSize), item.storageStatus, sizeTuple(item.storedSize), item.storedUrl, item.failureStage, item.failureReason]) || [],
        ]),
        structureTuple(
            snapshot.visualAnalysis?.references.find((reference) => reference.assetId === (plan.operation === "product_to_scene" ? plan.source.productAnchorId : plan.source.currentSceneBaselineId || plan.source.productAnchorId))?.visibleStructure,
        ),
    ]);
}

export function reviewSourceTuple(source: EcommerceVisualReviewSource) {
    const original = source.original;
    const frozen = source.frozen;
    const layout = frozen?.encoded.layout;
    return [
        source.source,
        [original.assetId, original.assetVersion, original.url, original.imageTaskId, original.resultId, original.resultDigest, original.sha256],
        frozen
            ? [
                  frozen.input.assetId,
                  frozen.input.assetVersion,
                  frozen.input.expectedSha256,
                  frozen.location.inputIndex,
                  frozen.location.scope,
                  frozen.location.storageKey,
                  frozen.location.storageProvider,
                  frozen.location.externalStorageId,
                  frozen.bytes,
                  frozen.mimeType,
                  frozen.encoded.inputIndex,
                  frozen.encoded.assetId,
                  frozen.encoded.assetVersion,
                  frozen.encoded.sha256,
                  frozen.encoded.bytes,
                  frozen.encoded.metadataRejected,
                  layout ? [layout.format, layout.depth, layout.channels] : null,
              ]
            : null,
    ];
}

export function reviewQualityDigest(check: EcommerceQualityCheck) {
    const observation = (value: NonNullable<EcommerceQualityCheck["observations"]>["baseline"]) => [value.readable, value.logo, value.packagingText, structureTuple(value.visibleStructure)];
    return reviewDigest([
        check.version,
        check.status,
        check.publicStatus,
        check.checkedAt,
        check.modelRole.logicalRole,
        check.modelRole.capability,
        check.modelRole.logicalModelId,
        check.modelRole.channelId,
        check.modelRole.upstreamModel,
        check.modelRole.apiFormat,
        check.checks.map(checkTuple),
        check.hardFailures.map(checkTuple),
        check.internalReason,
        check.contradictions?.map((item) => [item.source, item.objectId, item.feature, item.reportedCount, item.observedCount, reviewRegionTuple(item.reportedRegion), reviewRegionTuple(item.observedRegion)]) || [],
        check.canvasEvidence?.map(canvasEvidenceTuple) || [],
        check.observations
            ? [observation(check.observations.baseline), check.observations.productAnchor ? observation(check.observations.productAnchor) : null, check.observations.results.map((item) => [item.resultId, observation(item.observation)])]
            : null,
        check.sceneProtectionEvidence?.map((item) => [item.resultId, sceneProofTuple(item.evidence)]) || [],
        check.visionEvidence
            ? [
                  check.visionEvidence.imageCount,
                  check.visionEvidence.images.map((item) => [item.source, sizeTuple(item.size), reviewRegionTuple(item.region)]),
                  check.visionEvidence.transmissions.map((item) => [item.protocol, item.bodyBytes, item.maxBytes]),
              ]
            : null,
    ]);
}
