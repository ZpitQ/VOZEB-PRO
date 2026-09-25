import sharp from "sharp";

import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import type { CreativeAsset, CreativeGenerationPreferences, CreativeSurface } from "@/lib/creative-runtime-contract";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceCompiledImageRequest } from "./ecommerce-image-compiler";
import type { EcommerceResolvedLocalEditTarget } from "./ecommerce-edit-planner";
import { buildProductProtectionRegions, buildSceneProductProtectionRegions, type ProductProtectionRectangle, type ProductProtectionRegions } from "./ecommerce-product-regions";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import type { AgentRunTask } from "./agent-run-store";
import { assetAccessUrl } from "./agent-run-surface-policy";

const WHITE_BACKGROUND_MIN_CHANNEL = 240;
const TRANSPARENT_BACKGROUND_MAX_ALPHA = 24;
const MIN_BORDER_BACKGROUND_RATIO = 0.9;
const MIN_SUBJECT_PIXELS = 16;
const SECOND_SUBJECT_RATIO = 0.05;
const HALO_RATIO = 0.08;

export type EcommerceProgressStage = "identifying_product" | "planning_scene" | "generating_image" | "checking_result";
export type EcommerceRolloutStage = "default" | "shadow" | "internal" | "canary";
export type EcommerceRolloutSettings = { mode?: unknown; canaryUserIds?: unknown };

export class EcommerceProductSegmentationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EcommerceProductSegmentationError";
    }
}

export function ecommerceGenerationEnabled(value: unknown, run: { userId?: string; surface: CreativeSurface; referencedAssetIds: string[]; generationPreferences?: CreativeGenerationPreferences }, hasContinuityResult = false): boolean {
    const stage = ecommerceRolloutStage(value, run.userId || "");
    return (stage === "internal" || stage === "canary") && run.surface === "chat" && run.generationPreferences?.mode === "image" && (run.referencedAssetIds.length >= 1 || hasContinuityResult) && run.referencedAssetIds.length <= 2;
}

export function ecommerceRolloutStage(value: unknown, userId: string): EcommerceRolloutStage {
    const settings = normalizeRolloutSettings(value);
    const mode = typeof settings.mode === "string" ? settings.mode.trim().toLowerCase() : "";
    if (mode === "shadow") return "shadow";
    if (mode === "internal") return "internal";
    if (mode === "enabled") return "canary";
    if (mode !== "canary") return "default";
    const canaryUserIds = Array.isArray(settings.canaryUserIds)
        ? settings.canaryUserIds
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
        : [];
    return userId.trim() && canaryUserIds.includes(userId.trim()) ? "canary" : "default";
}

export function publicEcommerceProgress(stage: EcommerceProgressStage): string {
    return {
        identifying_product: "正在识别商品",
        planning_scene: "正在规划场景",
        generating_image: "正在生成图片",
        checking_result: "正在检查商品细节",
    }[stage];
}

function normalizeRolloutSettings(value: unknown): EcommerceRolloutSettings {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as EcommerceRolloutSettings;
    if (typeof value !== "string") return {};
    const source = value.trim();
    if (!source.startsWith("{")) return { mode: source };
    try {
        const parsed = JSON.parse(source);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as EcommerceRolloutSettings) : {};
    } catch {
        return {};
    }
}

export async function loadEcommercePlanningImage(url: string, origin: string, cookie: string): Promise<Buffer> {
    const source = url.trim();
    const response = source.startsWith("/api/") ? await fetchInternalApi(`${origin}${source}`, { headers: { cookie }, cache: "no-store" }) : /^https:\/\//i.test(source) ? await fetchSafeOutbound(source, { cache: "no-store" }) : null;
    if (!response?.ok) throw new EcommerceProductSegmentationError("无法读取商品图片");
    const mimeType = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!mimeType.startsWith("image/") || contentLength > CREATIVE_UPLOAD_MAX_BYTES) {
        throw new EcommerceProductSegmentationError("商品图片无效或过大");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) {
        throw new EcommerceProductSegmentationError("商品图片无效或过大");
    }
    return bytes;
}

export async function buildWhiteBackgroundProductProtection(source: Buffer, analysis: EcommerceVisualAnalysis, productAssetId: string): Promise<ProductProtectionRegions> {
    const reference = analysis.references.find((item) => item.assetId === productAssetId && item.role === "product");
    if (!reference || reference.confidence !== "high" || !reference.visualEvidence.isolatedSubject || (!reference.visualEvidence.whiteBackground && !reference.visualEvidence.transparentBackground)) {
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
    const pixels = width * height;
    const transparent = reference.visualEvidence.transparentBackground;
    const backgroundCandidate = (index: number) => {
        const offset = index * channels;
        const alpha = decoded.data[offset + 3];
        if (alpha <= TRANSPARENT_BACKGROUND_MAX_ALPHA) return true;
        if (transparent) return false;
        const red = decoded.data[offset];
        const green = decoded.data[offset + 1];
        const blue = decoded.data[offset + 2];
        return Math.min(red, green, blue) >= WHITE_BACKGROUND_MIN_CHANNEL && Math.max(red, green, blue) - Math.min(red, green, blue) <= 10;
    };
    const border = borderIndexes(width, height);
    const borderRatio = border.filter(backgroundCandidate).length / border.length;
    if (borderRatio < 0.1) throw new EcommerceProductSegmentationError("商品图边界不是可信白色或透明背景");

    const background = floodBackground(width, height, backgroundCandidate);
    const components = connectedComponents(width, height, (index) => !background[index] && decoded.data[index * channels + 3] > TRANSPARENT_BACKGROUND_MAX_ALPHA);
    const minimumArea = Math.max(MIN_SUBJECT_PIXELS, Math.ceil(pixels * 0.005));
    const eligible = components.filter((component) => component.length >= minimumArea).sort((left, right) => right.length - left.length);
    if (!eligible.length) throw new EcommerceProductSegmentationError("没有检测到商品主体");
    if (eligible.slice(1).some((component) => component.length >= eligible[0].length * SECOND_SUBJECT_RATIO)) {
        throw new EcommerceProductSegmentationError("检测到多个独立主体，需要人工复核");
    }

    const subject = eligible[0];
    const subjectSet = new Set(subject);
    const bounds = componentBounds(subject, width);
    if (bounds.x === 0 || bounds.y === 0 || bounds.x + bounds.width === width || bounds.y + bounds.height === height) {
        throw new EcommerceProductSegmentationError("商品主体接触图片边缘，无法生成可信保护蒙版");
    }
    if (borderRatio < MIN_BORDER_BACKGROUND_RATIO) throw new EcommerceProductSegmentationError("商品图边界不是可信白色或透明背景");
    const halo = expand(bounds, width, height);
    const normalizedAnalysis: EcommerceVisualAnalysis = {
        ...analysis,
        references: analysis.references.map((item) =>
            item.assetId === productAssetId
                ? {
                      ...item,
                      productCore: normalize(bounds, width, height),
                      fusionHalo: normalize(halo, width, height),
                  }
                : item,
        ),
    };
    const regions = buildProductProtectionRegions(normalizedAnalysis, { width, height });
    const maskBytes = Buffer.alloc(pixels * 4, 255);
    for (let index = 0; index < pixels; index += 1) maskBytes[index * 4 + 3] = subjectSet.has(index) ? 255 : 0;
    const mask = await sharp(maskBytes, { raw: { width, height, channels: 4 } })
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
    const targetRectangle = normalizedRectangle(target.region, width, height);
    const protectedRectangles = [...regions.productCore.rectangles, ...regions.fusionHalo.rectangles];
    const pixels = width * height;
    const maskBytes = Buffer.alloc(pixels * 4, 255);
    let editablePixels = 0;
    for (let y = targetRectangle.y; y < targetRectangle.y + targetRectangle.height; y += 1) {
        for (let x = targetRectangle.x; x < targetRectangle.x + targetRectangle.width; x += 1) {
            if (protectedRectangles.some((rectangle) => containsPixel(rectangle, x, y))) continue;
            maskBytes[(y * width + x) * 4 + 3] = 0;
            editablePixels += 1;
        }
    }
    if (!editablePixels) throw new EcommerceProductSegmentationError("局部编辑目标完全位于商品保护区域内");
    const mask = await sharp(maskBytes, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
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

export function createEcommerceProductSceneTask(
    run: { id: string; prompt: string; generationPreferences?: CreativeGenerationPreferences },
    plan: EcommerceEditPlan,
    assets: CreativeAsset[],
    productProtectionRegions: ProductProtectionRegions,
    ecommerceExecution: EcommerceCompiledImageRequest,
): AgentRunTask {
    if (plan.operation !== "product_to_scene" || plan.strategy !== "strict_product") {
        throw new Error("首期商品场景生成只允许 product_to_scene + strict_product");
    }
    assertReadyEcommerceExecution(plan, ecommerceExecution);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const product = byId.get(plan.source.productAnchorId);
    if (!product || product.type !== "image" || !assetAccessUrl(product)) throw new Error("商品锚点图片不可用");
    const sceneAssets = plan.source.sceneReferenceIds.map((id) => byId.get(id));
    if (sceneAssets.some((asset) => !asset || asset.type !== "image" || !assetAccessUrl(asset))) throw new Error("场景参考图片不可用");
    const references = [product, ...(sceneAssets as CreativeAsset[])].map((asset, index) => ({
        assetId: asset.id,
        url: assetAccessUrl(asset)!,
        type: "image" as const,
        ecommerceRole: index === 0 ? ("product" as const) : ("scene" as const),
        ...(index === 0
            ? {
                  width: productProtectionRegions.sourceSize.width,
                  height: productProtectionRegions.sourceSize.height,
              }
            : {
                  ...(Number.isFinite(asset.width) ? { width: asset.width } : {}),
                  ...(Number.isFinite(asset.height) ? { height: asset.height } : {}),
              }),
    }));
    assertCompiledReferences(references, ecommerceExecution);
    const userPrompt = run.prompt.trim();
    const preferences = run.generationPreferences?.image;
    return {
        id: "ecommerce-product-scene",
        referenceAssetId: product.id,
        referenceUrl: references[0].url,
        referenceType: "image",
        references,
        productProtectionRegions,
        title: "商品场景图",
        type: "image",
        model: ecommerceExecution.modelSnapshot.logicalModelId,
        ecommerceExecution,
        optimizedPrompt: userPrompt,
        prompt: ecommerceExecution.prompt,
        count: Math.max(1, preferences?.count || 1),
        ...(preferences?.size ? { ratio: preferences.size } : {}),
        ...(preferences?.quality ? { quality: preferences.quality } : {}),
        dependencies: [],
        status: "ready",
        attempts: 0,
    };
}

export function createEcommerceLocalEditTask(
    run: { id: string; prompt: string; generationPreferences?: CreativeGenerationPreferences },
    plan: EcommerceEditPlan,
    assets: CreativeAsset[],
    productProtectionRegions: ProductProtectionRegions,
    ecommerceExecution: EcommerceCompiledImageRequest,
): AgentRunTask {
    if (plan.operation !== "local_edit" || plan.strategy !== "strict_product" || !plan.source.currentSceneBaselineId) {
        throw new Error("首期局部编辑只允许有明确场景基线的 local_edit + strict_product");
    }
    if (productProtectionRegions.productAnchorId !== plan.source.productAnchorId || productProtectionRegions.sourceAssetId !== plan.source.currentSceneBaselineId) {
        throw new Error("局部编辑保护区域与商品锚点或当前场景基线不一致");
    }
    assertReadyEcommerceExecution(plan, ecommerceExecution);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const scene = byId.get(plan.source.currentSceneBaselineId);
    const product = byId.get(plan.source.productAnchorId);
    if (!scene || scene.type !== "image" || !assetAccessUrl(scene)) throw new Error("当前场景基线不可用");
    if (!product || product.type !== "image" || !assetAccessUrl(product)) throw new Error("原始商品锚点不可用");
    const references = [
        {
            assetId: scene.id,
            url: assetAccessUrl(scene)!,
            type: "image" as const,
            ecommerceRole: "scene" as const,
            width: productProtectionRegions.sourceSize.width,
            height: productProtectionRegions.sourceSize.height,
        },
        {
            assetId: product.id,
            url: assetAccessUrl(product)!,
            type: "image" as const,
            ecommerceRole: "product" as const,
            ...(Number.isFinite(product.width) ? { width: product.width } : {}),
            ...(Number.isFinite(product.height) ? { height: product.height } : {}),
        },
    ];
    assertCompiledReferences(references, ecommerceExecution);
    const userPrompt = run.prompt.trim();
    const preferences = run.generationPreferences?.image;
    return {
        id: "ecommerce-local-edit",
        referenceAssetId: scene.id,
        referenceUrl: references[0].url,
        referenceType: "image",
        references,
        productProtectionRegions,
        title: "商品场景局部修改",
        type: "image",
        model: ecommerceExecution.modelSnapshot.logicalModelId,
        ecommerceExecution,
        optimizedPrompt: userPrompt,
        prompt: ecommerceExecution.prompt,
        count: Math.max(1, preferences?.count || 1),
        ...(preferences?.size ? { ratio: preferences.size } : {}),
        ...(preferences?.quality ? { quality: preferences.quality } : {}),
        dependencies: [],
        status: "ready",
        attempts: 0,
    };
}

function assertReadyEcommerceExecution(plan: EcommerceEditPlan, execution: EcommerceCompiledImageRequest) {
    if (execution.state !== "ready") throw new Error("当前生图模型不满足 strict_product 执行要求");
    if (execution.modelSnapshot.logicalRole !== "image_generation" || execution.modelSnapshot.logicalModelId !== plan.modelRoles.generation) {
        throw new Error("生图执行快照与编辑计划的模型角色不一致");
    }
}

function assertCompiledReferences(references: NonNullable<AgentRunTask["references"]>, execution: EcommerceCompiledImageRequest) {
    const actual = references.map((reference) => ({ assetId: reference.assetId || "", role: reference.ecommerceRole || "" }));
    if (actual.length !== execution.referenceRoles.length || actual.some((reference, index) => reference.assetId !== execution.referenceRoles[index]?.assetId || reference.role !== execution.referenceRoles[index]?.role)) {
        throw new Error("生图编译器的参考图角色与实际任务不一致");
    }
}

function borderIndexes(width: number, height: number) {
    const indexes = new Set<number>();
    for (let x = 0; x < width; x += 1) {
        indexes.add(x);
        indexes.add((height - 1) * width + x);
    }
    for (let y = 0; y < height; y += 1) {
        indexes.add(y * width);
        indexes.add(y * width + width - 1);
    }
    return [...indexes];
}

function decodeProductPixels(source: Buffer) {
    return sharp(source).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function floodBackground(width: number, height: number, candidate: (index: number) => boolean) {
    const visited = new Uint8Array(width * height);
    const queue = borderIndexes(width, height).filter(candidate);
    queue.forEach((index) => (visited[index] = 1));
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor];
        for (const next of neighbors(index, width, height)) {
            if (!visited[next] && candidate(next)) {
                visited[next] = 1;
                queue.push(next);
            }
        }
    }
    return visited;
}

function connectedComponents(width: number, height: number, foreground: (index: number) => boolean) {
    const visited = new Uint8Array(width * height);
    const output: number[][] = [];
    for (let start = 0; start < visited.length; start += 1) {
        if (visited[start] || !foreground(start)) continue;
        const component: number[] = [];
        const queue = [start];
        visited[start] = 1;
        for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const index = queue[cursor];
            component.push(index);
            for (const next of neighbors(index, width, height)) {
                if (!visited[next] && foreground(next)) {
                    visited[next] = 1;
                    queue.push(next);
                }
            }
        }
        output.push(component);
    }
    return output;
}

function neighbors(index: number, width: number, height: number) {
    const x = index % width;
    const y = Math.floor(index / width);
    return [...(x > 0 ? [index - 1] : []), ...(x + 1 < width ? [index + 1] : []), ...(y > 0 ? [index - width] : []), ...(y + 1 < height ? [index + width] : [])];
}

function componentBounds(component: number[], width: number): ProductProtectionRectangle {
    const xs = component.map((index) => index % width);
    const ys = component.map((index) => Math.floor(index / width));
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function expand(bounds: ProductProtectionRectangle, width: number, height: number) {
    const padding = Math.max(1, Math.ceil(Math.max(bounds.width, bounds.height) * HALO_RATIO));
    const left = Math.max(0, bounds.x - padding);
    const top = Math.max(0, bounds.y - padding);
    const right = Math.min(width, bounds.x + bounds.width + padding);
    const bottom = Math.min(height, bounds.y + bounds.height + padding);
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalize(bounds: ProductProtectionRectangle, width: number, height: number) {
    return { x: bounds.x / width, y: bounds.y / height, width: bounds.width / width, height: bounds.height / height };
}

function normalizedRectangle(region: { x: number; y: number; width: number; height: number }, width: number, height: number): ProductProtectionRectangle {
    const left = Math.round(region.x * width);
    const top = Math.round(region.y * height);
    const right = Math.round((region.x + region.width) * width);
    const bottom = Math.round((region.y + region.height) * height);
    if (left < 0 || top < 0 || right > width || bottom > height || right <= left || bottom <= top) throw new EcommerceProductSegmentationError("局部编辑目标区域无效");
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function containsPixel(rectangle: ProductProtectionRectangle, x: number, y: number) {
    return x >= rectangle.x && x < rectangle.x + rectangle.width && y >= rectangle.y && y < rectangle.y + rectangle.height;
}
