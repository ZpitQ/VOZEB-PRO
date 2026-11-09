import { normalizeQuality, resolveEcommerceCanvasRequestSize } from "@/lib/image-generation-size";
import { parseImageDimensions } from "@/lib/image-size";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import type { ImageProcessingProtectionOptions } from "../image-processing/contracts";
import {
    compileConfirmedSceneExecution,
    ecommerceSceneSelectionReceiptState,
    ecommerceSceneProtectionOptions,
    enqueueImageProcessingTask,
    readCompletedEcommerceProductProtection,
    readCompletedEcommerceSceneProtection,
    prepareEcommerceGenerationReferences,
} from "./image-processing-service";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { resolveLocalEditTarget } from "./ecommerce-edit-planner";
import { createEcommerceLocalEditTask, createEcommerceProductSceneTask, createEcommerceSceneEditTask, EcommerceProductSegmentationError } from "./ecommerce-generation-service";
import { buildSceneProductProtectionRegions, STRICT_PRODUCT_COMPILER_VERSION, type ProductProtectionRegions } from "./ecommerce-product-regions";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { verifyPreparedEcommerceReferenceSource } from "./ecommerce-reference-preparation";

export async function prepareEcommerceProtectionTask(run: AgentRun, executionId: string, analysis: EcommerceVisualAnalysis, defaults: { imageQuality: string; imageSize: string }): Promise<AgentRunTask | undefined> {
    const snapshot = run.ecommerceSnapshot;
    const plan = snapshot?.plan;
    const checkpoint = snapshot?.referenceCheckpoint;
    const route = snapshot?.modelRouteSnapshots?.image_generation;
    if (!snapshot || !plan || !checkpoint || !route || (plan.operation !== "product_to_scene" && plan.operation !== "local_edit")) throw new Error("商品保护缺少已持久化的计划、参考或模型路由");
    const profile = resolveEcommerceImageProviderProfile(route);
    if (!profile) throw new Error("已保存的生图模型不支持电商编译器");
    let ecommerceExecution = compileEcommerceImageRequest(plan, profile);
    if (ecommerceExecution.state !== "ready" || ecommerceExecution.compilerVersion !== snapshot.compilerVersion) throw new Error("已保存的生图计划与编译器快照不一致");
    const sourceAssetId = plan.source.currentSceneBaselineId || plan.source.productAnchorId;
    const reference = checkpoint.assets.find((item) => item.asset.id === sourceAssetId);
    if (!reference?.contentSha256 || reference.asset.width === undefined || reference.asset.height === undefined) throw new Error("商品保护缺少已冻结的参考原件身份或尺寸");
    const parentTaskId = plan.operation === "local_edit" ? "ecommerce-local-edit" : "ecommerce-product-scene";
    let regions: ProductProtectionRegions | undefined;
    let options: ImageProcessingProtectionOptions;
    if (plan.operation === "local_edit") {
        const target = resolveLocalEditTarget(plan, analysis);
        if (target.state !== "resolved" || !plan.source.productAnchorId) throw new Error("已保存的局部编辑计划缺少可信目标或商品锚点");
        regions = buildSceneProductProtectionRegions(analysis, reference.asset.id, plan.source.productAnchorId, { width: reference.asset.width, height: reference.asset.height });
        options = { mode: "local_edit", targetRegion: target.target.region, protectedRectangles: [...regions.productCore.rectangles, ...regions.fusionHalo.rectangles] };
    } else {
        const anchors = analysis.references.filter((item) => item.assetId === sourceAssetId);
        const product = anchors.length === 1 && anchors[0].role === "product" ? anchors[0] : undefined;
        const detailAnchorAllowed = product?.confidence === "medium" && product.visualEvidence.isolatedSubject && (product.visualEvidence.whiteBackground || product.visualEvidence.transparentBackground);
        if (!product || (!detailAnchorAllowed && product.confidence !== "high") || !product.visualEvidence.isolatedSubject || (!product.visualEvidence.whiteBackground && !product.visualEvidence.transparentBackground))
            throw new EcommerceProductSegmentationError("商品图不是高置信度白色或透明背景单主体");
        const previous = snapshot.processing?.protection;
        let generationInput = previous?.generationInput;
        if (!previous && ecommerceExecution.mask && route.imageEdit?.protocol === "sub2api") {
            const quality = (run.generationPreferences?.image?.quality || defaults.imageQuality).trim();
            const bounds = parseImageDimensions(resolveEcommerceCanvasRequestSize(ecommerceExecution.canvas, normalizeQuality(quality), defaults.imageSize) || "");
            if (bounds) generationInput = { bounds, quality };
        }
        options = { transparentBackground: product.visualEvidence.transparentBackground, ...(plan.preserve.sourceFraming ? { sourceFraming: plan.preserve.sourceFraming } : {}), ...(generationInput ? { generationInput } : {}) };
    }
    const stage = await enqueueImageProcessingTask({
        runId: run.id,
        parentExecutionId: executionId,
        parentTaskId,
        operation: "build_protection",
        algorithmVersion: STRICT_PRODUCT_COMPILER_VERSION,
        inputs: [{ assetId: reference.asset.id, assetVersion: reference.assetVersion, expectedSha256: reference.contentSha256 }],
        options,
    });
    // Enqueue releases the parent. Only a new claim may consume the completion.
    if (stage.status !== "success") return;
    const protection = snapshot.processing?.protection;
    const manifest = protection?.manifest;
    const source = manifest?.sourceIdentities[0];
    const mask = manifest?.artifacts.find((artifact) => artifact.kind === "mask");
    const sourceSize = manifest?.geometry.sourceSize;
    if (
        !protection ||
        protection.jobId !== stage.id ||
        protection.inputDigest !== stage.payload.inputDigest ||
        !manifest ||
        manifest.jobId !== stage.id ||
        manifest.executionId !== stage.payload.executionId ||
        JSON.stringify(stage.resultPayload?.manifest) !== JSON.stringify(manifest) ||
        !source ||
        source.decodeError ||
        source.assetId !== reference.asset.id ||
        source.assetVersion !== reference.assetVersion ||
        source.sha256 !== reference.contentSha256 ||
        !sourceSize ||
        sourceSize.width !== source.width ||
        sourceSize.height !== source.height ||
        !mask ||
        mask.mimeType !== "image/png" ||
        mask.width !== source.width ||
        mask.height !== source.height
    )
        throw new Error("商品保护产物与实际完成的阶段或参考原件不一致");
    if (!regions) {
        const completed = await readCompletedEcommerceProductProtection(run);
        regions = completed.regions;
        ecommerceExecution = completed.execution;
    }
    regions.editableBackground.mask = {
        trust: "trusted",
        provider: plan.operation === "local_edit" ? "local-edit-target.v1" : "white-background-flood-fill.v1",
        reference: {
            id: reference.asset.id + (plan.operation === "local_edit" ? "-local-edit-mask" : "-background-mask"),
            name: plan.operation === "local_edit" ? "local-edit-mask.png" : "editable-background.png",
            type: mask.mimeType,
            dataUrl: "",
            serverUrl: "/api/reference-assets/" + mask.storageKey.split("/").map(encodeURIComponent).join("/"),
            width: mask.width,
            height: mask.height,
        },
    };
    const assets = checkpoint.assets.map((item) => item.asset);
    if (!(await prepareEcommerceGenerationReferences(run, executionId, ecommerceExecution, defaults))) return;
    const task = plan.operation === "local_edit" ? createEcommerceLocalEditTask(run, plan, assets, regions, ecommerceExecution) : createEcommerceProductSceneTask(run, plan, assets, regions, ecommerceExecution);
    const generation = snapshot.processing?.generationReferences?.[0]?.generationInput;
    return generation ? { ...task, quality: generation.quality, ratio: `${generation.bounds.width}x${generation.bounds.height}` } : task;
}

export async function prepareEcommerceSceneProtectionTask(run: AgentRun, executionId: string, origin: string, cookie: string): Promise<AgentRunTask | undefined> {
    const state = ecommerceSceneSelectionReceiptState(run);
    if (
        !state ||
        run.cancellation ||
        run.status !== "running" ||
        state.snapshot.qualityCheck ||
        state.task.status !== "needs_review" ||
        state.task.sceneProtection ||
        state.task.taskId ||
        state.task.taskIds?.length ||
        state.task.childTasks?.length ||
        state.task.attempts
    )
        throw new Error("场景保护缺少当前任务的有效确认记录");
    const { receipt, plan, task, reference } = state;
    const execution = compileConfirmedSceneExecution(state);
    const options = ecommerceSceneProtectionOptions(state);
    const stage = await enqueueImageProcessingTask({
        runId: run.id,
        parentExecutionId: executionId,
        parentTaskId: task.id,
        operation: "build_protection",
        algorithmVersion: "scene-edit-protection.v1",
        inputs: [{ assetId: reference.asset.id, assetVersion: reference.assetVersion, expectedSha256: receipt.baseline.sha256 }],
        options,
    });
    // A pending native stage owns the parent release. Its real completion needs a new claim.
    if (stage.status !== "success") return;
    const prepared = await readCompletedEcommerceSceneProtection(run, stage);
    const { sceneProtection, mask } = prepared;
    const maskUrl = sceneProtection.mask.serverUrl;
    await Promise.all([
        verifyPreparedEcommerceReferenceSource({ sourceUrl: state.sourceUrl, sourceBytes: receipt.baseline.bytes, contentSha256: receipt.baseline.sha256 }, origin, cookie),
        verifyPreparedEcommerceReferenceSource({ sourceUrl: maskUrl, sourceBytes: mask.bytes, contentSha256: mask.sha256 }, origin, cookie),
    ]);
    const executable = createEcommerceSceneEditTask(
        run,
        plan,
        state.checkpoint.assets.map((item) => item.asset),
        execution,
        sceneProtection,
    );
    return { ...executable, id: task.id, count: task.count, attempts: task.attempts };
}

export { readCompletedEcommerceSceneProtection } from "./image-processing-service";
