import { createHash } from "node:crypto";
import sharp from "sharp";
import { buildWhiteBackgroundProductMaskPixels, EcommerceProductSegmentationError } from "../image-processing/core";
import { buildLocalEditMask, buildSceneSelectionMask } from "../image-processing/protection-masks";
import { decodeScenePixels } from "../image-processing/scene-protection";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceResolvedLocalEditTarget } from "./ecommerce-edit-planner";
import { buildProductProtectionRegions, buildSceneProductProtectionRegions, type ProductProtectionRectangle, type ProductProtectionSourceSize, type ProductProtectionRegions, type SceneEditProtection } from "./ecommerce-product-regions";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";

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
