import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { buildWhiteBackgroundProductMaskPixels, EcommerceProductSegmentationError } from "../image-processing/core";
import { buildLocalEditMask, buildSceneSelectionMask } from "../image-processing/protection-masks";
import { decodeScenePixels } from "../image-processing/scene-protection";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceResolvedLocalEditTarget } from "./ecommerce-edit-planner";
import { buildProductProtectionRegions, buildSceneProductProtectionRegions, type ProductProtectionRectangle, type ProductProtectionSourceSize, type ProductProtectionRegions, type SceneEditProtection } from "./ecommerce-product-regions";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import type { AgentRun } from "./agent-run-store";
import type { ImageProcessingRectangle } from "../image-processing/contracts";
import type { SceneSelectionReceipt } from "./image-processing-service";

export async function persistFrozenEcommercePlan(run: AgentRun, origin: string, cookie: string): Promise<AgentRun> {
    const { updateAgentRunById } = await import("./agent-run-store");
    const { normalizePlannedEdit } = await import("./ecommerce-edit-planner");
    const { ecommerceCanvasInputFromRequest } = await import("./ecommerce-generation-service");
    const { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } = await import("./ecommerce-image-compiler");
    const snapshot = run.ecommerceSnapshot;
    const fullImage = snapshot?.plan;
    const checkpoint = snapshot?.referenceCheckpoint;
    const routes = snapshot?.modelRouteSnapshots;
    assert(snapshot && fullImage?.planVersion === "ecommerce-edit.v7" && checkpoint?.analysis && routes?.image_generation && routes.edit_planning);
    const baselineId = fullImage.source.currentSceneBaselineId || fullImage.source.productAnchorId;
    const baseline = checkpoint.assets.find((item) => item.asset.id === baselineId)?.asset;
    assert(baseline?.width && baseline.height);
    const scene = fullImage.operation === "scene_edit";
    const normalized = normalizePlannedEdit(
        {
            ...fullImage,
            planVersion: "ecommerce-edit.v6",
            strategy: scene ? "integrated_scene" : "strict_product",
            delta: { ...fullImage.delta, requestedChanges: fullImage.delta.requestedChanges.filter((change) => change !== run.prompt) },
            protection: { scope: scene ? "local" : "global", protectedObjectIds: [], preserveOutsideMask: scene, allowLightingChange: !scene },
        },
        {
            origin,
            cookie,
            userId: run.userId,
            requestId: run.id,
            planningInput: checkpoint.planningInput,
            sources: {
                status: "resolved",
                ...fullImage.source,
                sceneRootAssetId: fullImage.source.currentSceneBaselineId,
                parentResultId: fullImage.continuity.parentResultId,
                startsNewProductAnchor: !fullImage.source.currentSceneBaselineId,
                createsBranch: Boolean(fullImage.continuity.parentResultId),
                ambiguityReason: null,
                clarificationQuestion: null,
            },
            branchId: fullImage.continuity.branchId,
            generationModelRole: fullImage.modelRoles.generation,
            qualityCheckModelRole: fullImage.modelRoles.qualityCheck,
            canvasInput: ecommerceCanvasInputFromRequest(run.prompt, run.generationPreferences?.image?.size, { width: baseline.width, height: baseline.height }),
        },
        checkpoint.analysis,
        routes.edit_planning.logicalModelId,
    );
    assert(normalized);
    const plan: EcommerceEditPlan = { ...normalized, planVersion: "ecommerce-edit.v6", referenceUses: fullImage.referenceUses };
    const profile = resolveEcommerceImageProviderProfile(routes.image_generation);
    assert(profile);
    const compiled = compileEcommerceImageRequest(plan, profile);
    assert(compiled.state === "ready");
    const preferences = run.generationPreferences?.image;
    const tasks: AgentRun["tasks"] = scene
        ? [
              {
                  id: "ecommerce-scene-edit",
                  title: "Historical scene edit",
                  type: "image",
                  model: plan.modelRoles.generation,
                  optimizedPrompt: run.prompt,
                  prompt: compiled.prompt,
                  ecommerceExecution: compiled,
                  count: preferences?.count || 1,
                  ...(preferences?.quality ? { quality: preferences.quality } : {}),
                  ...(preferences?.size ? { ratio: preferences.size } : {}),
                  dependencies: [],
                  status: "needs_review",
                  attempts: 0,
              },
          ]
        : [];
    const saved = await updateAgentRunById(run.id, {
        status: scene ? "paused" : "running",
        executionId: undefined,
        tasks,
        ecommerceGenerations: undefined,
        ecommerceSnapshot: {
            ...snapshot,
            plan,
            modelRoles: plan.modelRoles,
            compilerVersion: compiled.compilerVersion,
            continuity: { ...plan.continuity, sceneRootAssetId: plan.source.currentSceneBaselineId || undefined },
            ...(scene ? { fallback: { reason: "scene_selection_required" } } : {}),
        },
    });
    assert(saved);
    return saved;
}

// Historical receipt creation belongs to the fixture; its public endpoint is retired.
export async function persistFrozenSceneSelection(run: AgentRun, region: ImageProcessingRectangle): Promise<AgentRun> {
    const { getStoredGenerationTaskRecord } = await import("./generation-task-store");
    const { updateAgentRunById } = await import("./agent-run-store");
    const { scheduleGenerationTask } = await import("./generation-task-scheduler");
    const snapshot = run.ecommerceSnapshot;
    const assetId = snapshot?.plan?.source.currentSceneBaselineId;
    const reference = snapshot?.referenceCheckpoint?.assets.find((item) => item.asset.id === assetId);
    const prepare = snapshot?.processing?.prepareReferences.find((item) => item.assetId === assetId);
    assert(snapshot?.processing && reference?.contentSha256 && prepare?.manifest);
    const source = prepare.manifest.sourceIdentities[0];
    const record = await getStoredGenerationTaskRecord("image_processing", prepare.jobId);
    const manifestDigest = record?.resultPayload?.manifestDigest;
    assert(record?.status === "success" && typeof manifestDigest === "string" && source.width && source.height);
    const receipt: SceneSelectionReceipt = {
        version: "scene-selection-receipt.v1",
        parentTaskId: run.tasks[0].id,
        baseline: { assetId: reference.asset.id, assetVersion: reference.assetVersion, sha256: reference.contentSha256, bytes: source.bytes, width: source.width, height: source.height },
        prepare: { jobId: prepare.jobId, inputDigest: prepare.inputDigest, executionId: prepare.manifest.executionId, manifestDigest, assetVersion: prepare.assetVersion },
        region,
        semantics: snapshot.plan!.delta.requestedChanges,
        confirmation: { actorUserId: run.userId, confirmedAt: Date.now() },
    };
    const saved = await updateAgentRunById(run.id, { status: "running", executionId: undefined, ecommerceSnapshot: { ...snapshot, processing: { ...snapshot.processing, sceneSelection: receipt } } }, undefined, [run.status]);
    assert(saved);
    const parent = await getStoredGenerationTaskRecord("agent", run.id);
    assert(parent);
    if (parent.workerId) {
        const { releaseGenerationTaskLease } = await import("./generation-task-scheduler");
        assert(await releaseGenerationTaskLease("agent", run.id, parent.workerId, { executionPhase: "created", nextPollAt: Date.now() }));
    } else await scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
    return saved;
}

const HALO_RATIO = 0.08;
export async function buildWhiteBackgroundProductProtection(source: Buffer, analysis: EcommerceVisualAnalysis, productAssetId: string, sourceFraming?: EcommerceEditPlan["preserve"]["sourceFraming"]): Promise<ProductProtectionRegions> {
    const anchors = analysis.references.filter((item) => item.assetId === productAssetId);
    const reference = anchors.length === 1 && anchors[0].role === "product" ? anchors[0] : undefined;
    const detailAnchorAllowed = reference?.role === "product" && reference.confidence === "medium" && reference.visualEvidence.isolatedSubject && (reference.visualEvidence.whiteBackground || reference.visualEvidence.transparentBackground);
    if (!reference || (!detailAnchorAllowed && reference.confidence !== "high") || !reference.visualEvidence.isolatedSubject || (!reference.visualEvidence.whiteBackground && !reference.visualEvidence.transparentBackground)) {
        throw new EcommerceProductSegmentationError("商品图不是高置信度白色或透明背景单主体");
    }

    let decoded: Awaited<ReturnType<typeof decodeProductPixels>>;
    try {
        decoded = await decodeProductPixels(source);
    } catch {
        throw new EcommerceProductSegmentationError("商品图片无法解码");
    }
    const { width, height, channels } = decoded.info;
    if (!width || !height || channels !== 4) throw new EcommerceProductSegmentationError("商品图片像素格式无效");
    const bounds = buildWhiteBackgroundProductMaskPixels(decoded.data, width, height, reference.visualEvidence.transparentBackground, sourceFraming);
    const halo = expand(bounds, width, height);
    const normalizedAnalysis: EcommerceVisualAnalysis = {
        ...analysis,
        references: [{ ...reference, productCore: normalize(bounds, width, height), fusionHalo: normalize(halo, width, height) }],
    };
    const regions = buildProductProtectionRegions(normalizedAnalysis, { width, height });
    const mask = await sharp(decoded.data, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
    regions.editableBackground.mask = {
        trust: "trusted",
        provider: "white-background-flood-fill.v1",
        reference: {
            id: productAssetId + "-background-mask",
            name: "editable-background.png",
            type: "image/png",
            dataUrl: "data:image/png;base64," + mask.toString("base64"),
            width,
            height,
        },
    };
    return regions;
}

export async function buildLocalEditProductProtection(source: Buffer, analysis: EcommerceVisualAnalysis, sourceAssetId: string, productAnchorId: string, target: EcommerceResolvedLocalEditTarget): Promise<ProductProtectionRegions> {
    let decoded: Awaited<ReturnType<typeof decodeProductPixels>>;
    try {
        decoded = await decodeProductPixels(source);
    } catch {
        throw new EcommerceProductSegmentationError("当前场景图片无法解码");
    }
    const { width, height, channels } = decoded.info;
    if (!width || !height || channels !== 4) throw new EcommerceProductSegmentationError("当前场景图片像素格式无效");
    const regions = buildSceneProductProtectionRegions(analysis, sourceAssetId, productAnchorId, { width, height });
    const protectedRectangles = [...regions.productCore.rectangles, ...regions.fusionHalo.rectangles];
    const mask = await buildLocalEditMask({ width, height }, target.region, protectedRectangles);
    regions.editableBackground.mask = {
        trust: "trusted",
        provider: "local-edit-target.v1",
        reference: {
            id: sourceAssetId + "-local-edit-mask",
            name: "local-edit-mask.png",
            type: "image/png",
            dataUrl: "data:image/png;base64," + mask.toString("base64"),
            width,
            height,
        },
    };
    return regions;
}

function decodeProductPixels(source: Buffer) {
    return sharp(source).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function expand(bounds: ProductProtectionRectangle, width: number, height: number) {
    const horizontalPadding = Math.max(1, Math.ceil(bounds.width * HALO_RATIO));
    const verticalPadding = Math.max(1, Math.ceil(bounds.height * HALO_RATIO));
    const left = Math.max(0, bounds.x - horizontalPadding);
    const top = Math.max(0, bounds.y - verticalPadding);
    const right = Math.min(width, bounds.x + bounds.width + horizontalPadding);
    const bottom = Math.min(height, bounds.y + bounds.height + verticalPadding);
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalize(bounds: ProductProtectionRectangle, width: number, height: number) {
    return { x: bounds.x / width, y: bounds.y / height, width: bounds.width / width, height: bounds.height / height };
}

export async function buildSceneEditProtection(source: Buffer, sourceAssetId: string, region: ProductProtectionRectangle, semantics: string[], selectionSource: "user_selection" | "analysis_hint"): Promise<SceneEditProtection> {
    if (selectionSource !== "user_selection") throw new Error("局部场景编辑需要用户确认允许区域，自动矩形不是可信语义蒙版");
    const { info } = await decodeScenePixels(source);
    const sourceSize = { width: info.width, height: info.height };
    if (!sourceAssetId?.trim() || !validRectangle(region, sourceSize)) throw new Error("允许编辑区域越界或尺寸无效");
    if (region.width * region.height === sourceSize.width * sourceSize.height) throw new Error("整图选区必须使用全局编辑范围");
    if (!semantics.length || semantics.some((value) => typeof value !== "string" || !value.trim())) throw new Error("允许编辑区域缺少语义");
    const bytes = await buildSceneSelectionMask(sourceSize, region, semantics, selectionSource);
    return {
        version: "scene-edit-protection.v1",
        sourceAssetId,
        sourceSize,
        sourceDigest: digest(source),
        maskSize: { ...sourceSize },
        maskDigest: digest(bytes),
        targetRegion: { ...region },
        semantics: [...semantics],
        selectionSource,
        maskSemantics: "alpha_zero_edit",
        method: "source_pixels_copy",
        mask: { id: sourceAssetId + "-scene-edit-mask", name: "scene-edit-mask.png", type: "image/png", ...sourceSize, dataUrl: "data:image/png;base64," + bytes.toString("base64") },
    };
}

function digest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}

function validRectangle(rectangle: ProductProtectionRectangle, sourceSize: ProductProtectionSourceSize) {
    return (
        rectangle &&
        [rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isInteger) &&
        rectangle.x >= 0 &&
        rectangle.y >= 0 &&
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        rectangle.x + rectangle.width <= sourceSize.width &&
        rectangle.y + rectangle.height <= sourceSize.height
    );
}
