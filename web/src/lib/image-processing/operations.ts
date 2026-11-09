import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp, { type Metadata } from "sharp";

import type {
    ImageProcessingArtifact,
    ImageProcessingRectangle,
    ImageProcessingRequest,
    ImageProcessingResult,
    ImageProcessingResultBinding,
    ImageProcessingResultOptions,
    ImageProcessingSourceIdentity,
    ImageProcessingBaseline,
    ImageProcessingSize,
    SceneProtectionEvidence,
    ProductEnhancementEvidence,
} from "./contracts.ts";
import { buildWhiteBackgroundProductMaskPixels, EcommerceProductSegmentationError } from "./core.ts";
import { ImageProcessingRejection } from "./errors.ts";
import { normalizeGeneratedImageBytes } from "./generated-image.ts";
import { buildLocalEditMask, buildSceneSelectionMask, validPixelRectangle } from "./protection-masks.ts";
import { assertTransparentImageBytes, validateImageLayerBytes } from "./output-validation.ts";
import { validateSceneProtectionBytes, compositePreparedScene } from "./scene-protection.ts";
import { prepareProductProtection, compositePreparedProduct } from "./product-protection.ts";
import { canonicalPng, freezeEnhancementBaseline } from "./enhancement-baseline.ts";
import { processEnhancement } from "./enhancement-publication.ts";

export { ImageProcessingRejection } from "./errors.ts";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 64_000_000;
const MAX_ANALYSIS_BYTES = 4 * 1024 * 1024;
const MAX_ANALYSIS_DIMENSION = 2048;
const decodeOptions = { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS } as const;

export async function executeImageProcessing(request: ImageProcessingRequest, sampleMemory: () => void): Promise<Omit<ImageProcessingResult, "metrics">> {
    if (request.operation === "process_result") return processResults(request, sampleMemory);
    if (request.operation === "process_enhancement") return processEnhancement(request, sampleMemory);
    const input = request.inputs[0];
    let source: Buffer;
    try {
        const file = await stat(input.path);
        if (!file.isFile() || file.size === 0 || file.size > MAX_INPUT_BYTES) throw new ImageProcessingRejection("invalid_source_size", "商品图片无效或超过20MiB");
        source = await readFile(input.path);
    } catch (error) {
        if (error instanceof ImageProcessingRejection) throw error;
        throw new ImageProcessingRejection("source_read_failed", "商品图片无法读取", { cause: error });
    }
    if (!source.length || source.length > MAX_INPUT_BYTES) throw new ImageProcessingRejection("invalid_source_size", "商品图片无效或超过20MiB");
    sampleMemory();
    const sha256 = digest(source);
    if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) throw new ImageProcessingRejection("source_hash_mismatch", "参考图片内容与冻结身份不符");

    let metadata: Metadata;
    try {
        metadata = await sharp(source, decodeOptions).metadata();
    } catch (error) {
        throw new ImageProcessingRejection("invalid_image", "商品图片无法解码", { cause: error });
    }
    const sourceSize = displayDimensions(metadata);
    const mimeType = imageMimeType(metadata);
    sampleMemory();
    const base = {
        jobId: request.jobId,
        executionId: request.executionId,
        sourceIdentities: [{ assetId: input.assetId, assetVersion: input.assetVersion, sha256, bytes: source.length, mimeType, ...sourceSize }],
    };

    if (request.operation === "prepare_reference" || request.operation === "prepare_review") {
        try {
            // Reading metadata alone does not prove that the source's pixels are intact.
            await sharp(source, decodeOptions).stats();
        } catch (error) {
            throw new ImageProcessingRejection("invalid_image", "商品图片像素无法解码", { cause: error });
        }
        sampleMemory();
        if (request.operation === "prepare_reference" && request.options.generationInput) {
            const reference = await generationReference(source, mimeType, request.options.generationInput.bounds, sampleMemory);
            const artifact = await persistArtifact(request.outputDirectory, "generation_reference", reference.data, reference.mimeType, reference.size);
            return { ...base, artifacts: [artifact], geometry: { sourceSize } };
        }
        let analysisSource = source;
        let analysisMimeType = mimeType;
        let analysisSize = sourceSize;
        if (request.operation === "prepare_review") {
            const region = request.options.region;
            if (region && !validPixelRectangle(region, sourceSize)) throw new ImageProcessingRejection("review_region_invalid", "结构取证裁片超出原文件");
            try {
                analysisSource = await sharp(source, decodeOptions).rotate().png().toBuffer();
                sampleMemory();
                if (region) {
                    analysisSource = await sharp(analysisSource, decodeOptions).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).png().toBuffer();
                    analysisSize = { width: region.width, height: region.height };
                    sampleMemory();
                }
            } catch (error) {
                throw new ImageProcessingRejection("invalid_image", "视觉取证图片像素无法处理", { cause: error });
            }
            analysisMimeType = "image/png";
        }
        const analysis = await analysisImage(analysisSource, analysisMimeType, analysisSize, sampleMemory);
        const artifact = await persistArtifact(request.outputDirectory, "analysis", analysis.bytes, analysis.mimeType, analysis.size);
        sampleMemory();
        return { ...base, artifacts: [artifact], geometry: { sourceSize } };
    }

    if ("mode" in request.options) {
        try {
            await sharp(source, decodeOptions).stats();
        } catch (error) {
            throw new ImageProcessingRejection("invalid_image", "商品图片像素无法解码", { cause: error });
        }
        sampleMemory();
        const options = request.options;
        let mask: Buffer;
        try {
            mask = options.mode === "local_edit" ? await buildLocalEditMask(sourceSize, options.targetRegion, options.protectedRectangles) : await buildSceneSelectionMask(sourceSize, options.region, options.semantics, options.selectionSource);
        } catch (error) {
            if (error instanceof EcommerceProductSegmentationError) throw new ImageProcessingRejection("segmentation_rejected", error.message, { cause: error });
            throw error;
        }
        sampleMemory();
        const artifact = await persistArtifact(request.outputDirectory, "mask", mask, "image/png", sourceSize);
        const sceneProtection =
            options.mode === "scene_selection"
                ? {
                      version: "scene-edit-protection.v1" as const,
                      sourceAssetId: input.assetId,
                      sourceSize,
                      sourceDigest: sha256,
                      maskSize: { ...sourceSize },
                      maskDigest: artifact.sha256,
                      targetRegion: { ...options.region },
                      semantics: [...options.semantics],
                      selectionSource: options.selectionSource,
                      maskSemantics: "alpha_zero_edit" as const,
                      method: "source_pixels_copy" as const,
                  }
                : undefined;
        let enhancementBaseline;
        if (sceneProtection && options.freezeEnhancementBaseline === true) enhancementBaseline = await freezeEnhancementBaseline(source, mask, input.assetId, sourceSize, { scope: "local_edit", protection: sceneProtection }, sampleMemory);
        else if (options.mode === "local_edit" && options.freezeEnhancementBaseline)
            enhancementBaseline = await freezeEnhancementBaseline(source, mask, input.assetId, sourceSize, { scope: "product_background", ...options.freezeEnhancementBaseline }, sampleMemory);
        return { ...base, artifacts: [artifact], geometry: { sourceSize, ...(sceneProtection ? { sceneProtection } : {}), ...(enhancementBaseline ? { enhancementBaseline } : {}) } };
    }
    const { mask, productBounds, width, height } = await buildWhiteMask(source, request.options.transparentBackground, sampleMemory, request.options.sourceFraming);
    const artifact = await persistArtifact(request.outputDirectory, "mask", mask, "image/png", { width, height });
    const enhancementBaseline = request.options.freezeEnhancementBaseline
        ? await freezeEnhancementBaseline(source, mask, input.assetId, { width, height }, { scope: "product_background", productAnchorId: input.assetId, productCore: [productBounds] }, sampleMemory)
        : undefined;
    const artifacts = [artifact];
    if (request.options.generationInput) {
        const reference = await generationReference(source, mimeType, request.options.generationInput.bounds, sampleMemory);
        const size = reference.size;
        artifacts.push(await persistArtifact(request.outputDirectory, "generation_reference", reference.data, reference.mimeType, size));
        const generationMask = await sharp(mask, decodeOptions)
            .resize({ ...size, kernel: "nearest" })
            .png()
            .toBuffer();
        sampleMemory();
        artifacts.push(await persistArtifact(request.outputDirectory, "generation_mask", generationMask, "image/png", size));
    }
    return { ...base, artifacts, geometry: { sourceSize: { width, height }, productBounds, haloBounds: expand(productBounds, width, height), ...(enhancementBaseline ? { enhancementBaseline } : {}) } };
}

async function generationReference(source: Buffer, mimeType: string, bounds: ImageProcessingSize, sampleMemory: () => void) {
    const input = sharp(source, decodeOptions)
        .rotate()
        .resize({ ...bounds, fit: "inside", withoutEnlargement: true });
    const reference = await (mimeType === "image/jpeg" ? input.jpeg({ quality: 90, chromaSubsampling: "4:4:4" }) : input.png()).toBuffer({ resolveWithObject: true });
    sampleMemory();
    return { data: reference.data, mimeType: mimeType === "image/jpeg" ? "image/jpeg" : "image/png", size: { width: reference.info.width, height: reference.info.height } };
}

async function buildWhiteMask(source: Buffer, transparentBackground: boolean, sampleMemory: () => void, sourceFraming?: "visible_extent") {
    const pixels = await decodeProductPixels(source);
    sampleMemory();
    const { width, height } = pixels.info;
    if (pixels.info.channels !== 4) throw new ImageProcessingRejection("invalid_image", "商品图片像素格式无效");
    let productBounds: ImageProcessingRectangle;
    try {
        productBounds = buildWhiteBackgroundProductMaskPixels(pixels.data, width, height, transparentBackground, sourceFraming);
    } catch (error) {
        if (error instanceof EcommerceProductSegmentationError) throw new ImageProcessingRejection("segmentation_rejected", error.message, { cause: error });
        throw error;
    }
    sampleMemory();
    const mask = await sharp(pixels.data, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
    sampleMemory();
    return { mask, productBounds, width, height };
}

async function decodeProductPixels(source: Buffer) {
    try {
        return await sharp(source, decodeOptions).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    } catch (error) {
        throw new ImageProcessingRejection("invalid_image", "商品图片像素无法解码", { cause: error });
    }
}

async function analysisImage(source: Buffer, mimeType: string, size: { width: number; height: number }, sampleMemory: () => void) {
    if (source.length <= MAX_ANALYSIS_BYTES && Math.max(size.width, size.height) <= MAX_ANALYSIS_DIMENSION) return { bytes: source, mimeType, size };
    for (const dimension of [MAX_ANALYSIS_DIMENSION, 1600, 1280, 1024]) {
        for (const quality of [82, 72, 62]) {
            const output = await sharp(source, decodeOptions)
                .rotate()
                .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
                .flatten({ background: "#ffffff" })
                .jpeg({ quality, chromaSubsampling: "4:4:4" })
                .toBuffer({ resolveWithObject: true });
            sampleMemory();
            if (output.data.length <= MAX_ANALYSIS_BYTES) return { bytes: output.data, mimeType: "image/jpeg", size: { width: output.info.width, height: output.info.height } };
        }
    }
    throw new ImageProcessingRejection("analysis_too_large", "视觉分析图片压缩后仍过大");
}

async function persistArtifact(directory: string, kind: ImageProcessingArtifact["kind"], bytes: Buffer, mimeType: string, size: { width: number; height: number }, slot?: { resultId: string; resultIndex: number }): Promise<ImageProcessingArtifact> {
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
    const artifactPath = path.join(directory, `${kind}${slot ? `-${slot.resultIndex}` : ""}.${extension}`);
    await writeFile(artifactPath, bytes, { flag: "wx" });
    return { kind, path: artifactPath, sha256: digest(bytes), mimeType, bytes: bytes.length, width: size.width, height: size.height, ...slot };
}

async function processResults(request: Extract<ImageProcessingRequest, { operation: "process_result" }>, sampleMemory: () => void): Promise<Omit<ImageProcessingResult, "metrics">> {
    const options = request.options;
    const sourceIdentities = await inspectResultInputs(request, sampleMemory);
    if (options.mode === "layers") return processLayers(request, options, sourceIdentities, sampleMemory);
    if (options.mode === "ordinary") {
        const target = options.targetSize;
        return processSlots(
            request,
            sourceIdentities,
            {},
            async (bytes, identity) => {
                const normalized = await normalizeGeneratedImageBytes(bytes, "", target ? `${target.width}x${target.height}` : undefined);
                identity.nativeImage = normalized.nativeImage ?? (await normalizeGeneratedImageBytes(bytes, "")).nativeImage;
                sampleMemory();
                if (options.transparentBackground) await assertTransparentImageBytes(normalized.bytes);
                return normalized;
            },
            sampleMemory,
        );
    }
    const sourceIdentity = sourceIdentities[options.sourceInputIndex];
    const maskIdentity = sourceIdentities[options.maskInputIndex];
    const code = options.mode === "scene_protection" ? "scene_protection_rejected" : "product_protection_rejected";
    if (sourceIdentity.decodeError) throw new ImageProcessingRejection(code, sourceIdentity.decodeError.message);
    if (maskIdentity.decodeError) throw new ImageProcessingRejection(code, maskIdentity.decodeError.message);
    const source = await readResultInput(request.inputs[options.sourceInputIndex]);
    const mask = await readResultInput(request.inputs[options.maskInputIndex]);
    const size = options.mode === "scene_protection" ? options.protection.sourceSize : options.protection.product.sourceSize;
    const sourceAssetId = options.mode === "scene_protection" ? options.protection.sourceAssetId : options.protection.product.sourceAssetId;
    if (sourceAssetId !== sourceIdentity.assetId) throw new ImageProcessingRejection(code, "保护源图身份与冻结输入不一致");
    const baselineValidated = options.baseline !== undefined;
    if (options.baseline) await validateFrozenBaseline(source, options.baseline, size, code, sampleMemory);
    const geometry = { sourceSize: { width: sourceIdentity.width, height: sourceIdentity.height } };
    if (options.mode === "scene_protection") {
        const original = await validateSceneProtectionBytes(source, mask, options.protection);
        sampleMemory();
        const context = { original, protection: options.protection };
        return processSlots(
            request,
            sourceIdentities,
            geometry,
            async (bytes, identity) => {
                const stats = await sharp(bytes)
                    .stats()
                    .catch((error: unknown) => {
                        throw new ImageProcessingRejection("scene_protection_rejected", error instanceof Error ? error.message : "场景图片无法解码", { cause: error });
                    });
                identity.nativeImage = { format: identity.mimeType.slice("image/".length), hasAlpha: !stats.isOpaque };
                sampleMemory();
                const result = await compositePreparedScene(bytes, context, sampleMemory);
                return { bytes: result.bytes, mimeType: "image/png", ...size, finalImage: result.finalImage, evidence: { ...(baselineValidated ? { baselineValidated: true } : {}), sceneProtectionEvidence: result.evidence } };
            },
            sampleMemory,
        );
    }
    const context = await prepareProductProtection(source, mask, options.protection, size.width * size.height, sampleMemory);
    return processSlots(
        request,
        sourceIdentities,
        geometry,
        async (bytes, identity) => {
            const stats = await sharp(bytes, { failOn: "warning" })
                .stats()
                .catch((error: unknown) => {
                    throw new ImageProcessingRejection("product_protection_rejected", error instanceof Error ? error.message : "Product native could not decode completely", { cause: error });
                });
            identity.nativeImage = { format: identity.mimeType.slice("image/".length), hasAlpha: !stats.isOpaque };
            sampleMemory();
            if (identity.width !== size.width || identity.height !== size.height) throw new ImageProcessingRejection(code, "Product native dimensions must exactly match the source");
            const result = await compositePreparedProduct(bytes, context, "native", sampleMemory);
            return { bytes: result.bytes, mimeType: "image/png", ...size, finalImage: result.finalImage, evidence: { baselineValidated: true, productEnhancementEvidence: result.evidence } };
        },
        sampleMemory,
    );
}

async function inspectResultInputs(request: Extract<ImageProcessingRequest, { operation: "process_result" }>, sampleMemory: () => void) {
    const identities: ImageProcessingSourceIdentity[] = [];
    for (const input of request.inputs) {
        const bytes = await readResultInput(input);
        const identity = { assetId: input.assetId, assetVersion: input.assetVersion, sha256: digest(bytes), bytes: bytes.length };
        try {
            const metadata = await sharp(bytes, { failOn: "error", ...(request.options.mode === "ordinary" ? { limitInputPixels: 40_000_000 } : {}) }).metadata();
            identities.push({ ...identity, mimeType: imageMimeType(metadata), ...displayDimensions(metadata) });
        } catch (error) {
            identities.push({ ...identity, decodeError: { code: "invalid_result", message: error instanceof Error ? error.message : "上游图片无法解码" } });
        }
        sampleMemory();
    }
    return identities;
}

type SlotOutput = ImageProcessingSize & {
    bytes: Buffer;
    mimeType: string;
    finalImage?: { format: string; hasAlpha: boolean };
    evidence?: { baselineValidated?: boolean; sceneProtectionEvidence?: SceneProtectionEvidence; productEnhancementEvidence?: ProductEnhancementEvidence };
};
async function processSlots(
    request: Extract<ImageProcessingRequest, { operation: "process_result" }>,
    sourceIdentities: ImageProcessingSourceIdentity[],
    geometry: ImageProcessingResult["geometry"],
    processor: (bytes: Buffer, identity: Extract<ImageProcessingSourceIdentity, { mimeType: string }>) => Promise<SlotOutput>,
    sampleMemory: () => void,
): Promise<Omit<ImageProcessingResult, "metrics">> {
    const artifacts: ImageProcessingArtifact[] = [];
    const results: ImageProcessingResultBinding[] = [];
    let firstFailure: ImageProcessingRejection | undefined;
    for (const slot of request.options.results) {
        const identity = sourceIdentities[slot.inputIndex];
        const binding = { resultId: slot.resultId, resultIndex: slot.resultIndex, nativeInputIndex: slot.inputIndex };
        if (identity.decodeError) {
            const error = new ImageProcessingRejection(identity.decodeError.code, identity.decodeError.message);
            firstFailure ??= error;
            results.push({ ...binding, error: { code: error.code, message: error.message, failureStage: "decode" } });
            continue;
        }
        try {
            const bytes = await readResultInput(request.inputs[slot.inputIndex]);
            const output = await processor(bytes, identity);
            sampleMemory();
            const finalArtifactIndex = artifacts.length;
            artifacts.push(await persistArtifact(request.outputDirectory, "final", output.bytes, output.mimeType, { width: output.width, height: output.height }, { resultId: slot.resultId, resultIndex: slot.resultIndex }));
            const finalImage = output.finalImage || (artifacts[finalArtifactIndex].sha256 === identity.sha256 ? identity.nativeImage : undefined);
            results.push({ ...binding, finalArtifactIndex, ...(finalImage ? { finalImage } : {}), ...output.evidence });
        } catch (error) {
            if (!(error instanceof ImageProcessingRejection)) throw error;
            const decodeFailure = error.code === "invalid_result" || error.cause !== undefined;
            if (decodeFailure) sourceIdentities[slot.inputIndex] = { assetId: identity.assetId, assetVersion: identity.assetVersion, sha256: identity.sha256, bytes: identity.bytes, decodeError: { code: error.code, message: error.message } };
            firstFailure ??= error;
            results.push({ ...binding, error: { code: error.code, message: error.message, failureStage: decodeFailure ? "decode" : "validation" } });
        }
    }
    if (!artifacts.length) throw firstFailure;
    return { jobId: request.jobId, executionId: request.executionId, sourceIdentities, artifacts, results, geometry };
}

async function processLayers(
    request: Extract<ImageProcessingRequest, { operation: "process_result" }>,
    options: Extract<ImageProcessingResultOptions, { mode: "layers" }>,
    sourceIdentities: ImageProcessingSourceIdentity[],
    sampleMemory: () => void,
): Promise<Omit<ImageProcessingResult, "metrics">> {
    const sourceIdentity = sourceIdentities[options.sourceInputIndex];
    if (sourceIdentity.decodeError) throw new ImageProcessingRejection("invalid_layers", sourceIdentity.decodeError.message);
    const source = await readResultInput(request.inputs[options.sourceInputIndex]);
    async function* nativeFiles() {
        for (const slot of options.results) yield await readResultInput(request.inputs[slot.inputIndex]);
    }
    const layers = await validateImageLayerBytes(source, nativeFiles());
    sampleMemory();
    const artifacts: ImageProcessingArtifact[] = [];
    const results: ImageProcessingResultBinding[] = [];
    for (const [index, slot] of options.results.entries()) {
        const bytes = await readResultInput(request.inputs[slot.inputIndex]);
        const layer = layers[index];
        sourceIdentities[slot.inputIndex].nativeImage = { format: layer.mimeType.slice("image/".length), hasAlpha: layer.kind === "element" };
        artifacts.push({ ...(await persistArtifact(request.outputDirectory, "final", bytes, layer.mimeType, layer, { resultId: slot.resultId, resultIndex: slot.resultIndex })), layerKind: layer.kind });
        results.push({ resultId: slot.resultId, resultIndex: slot.resultIndex, nativeInputIndex: slot.inputIndex, finalArtifactIndex: index });
    }
    return { jobId: request.jobId, executionId: request.executionId, sourceIdentities, artifacts, results, geometry: { sourceSize: { width: sourceIdentity.width, height: sourceIdentity.height } } };
}

async function validateFrozenBaseline(source: Buffer, baseline: ImageProcessingBaseline, size: ImageProcessingSize, code: string, sampleMemory: () => void) {
    if (source.length !== baseline.byteLength || digest(source) !== baseline.sha256) throw new ImageProcessingRejection(code, "保护源图与冻结摘要基线不一致");
    try {
        const normalized = await sharp(source, { failOn: "warning", limitInputPixels: size.width * size.height })
            .rotate()
            .toColourspace("srgb")
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        sampleMemory();
        // Qualification freezes the metadata-free RGBA encoding, including for JPEG sources with density metadata.
        const png = await canonicalPng(normalized.data, normalized.info);
        sampleMemory();
        if (baseline.width !== size.width || baseline.height !== size.height || normalized.info.width !== size.width || normalized.info.height !== size.height || digest(png) !== baseline.normalizedSha256)
            throw new ImageProcessingRejection(code, "保护源图与冻结展示基线不一致");
    } catch (error) {
        if (error instanceof ImageProcessingRejection) throw error;
        throw new ImageProcessingRejection(code, "保护源图无法解码为冻结展示基线", { cause: error });
    }
}

async function readResultInput(input: ImageProcessingRequest["inputs"][number]) {
    let bytes: Buffer;
    try {
        bytes = await readFile(input.path);
    } catch (error) {
        throw new ImageProcessingRejection("source_read_failed", "上游图片无法读取", { cause: error });
    }
    if (!bytes.length) throw new ImageProcessingRejection("invalid_result", "上游图片为空");
    if (input.expectedSha256 !== undefined && digest(bytes) !== input.expectedSha256) throw new ImageProcessingRejection("source_hash_mismatch", "参考图片内容与冻结身份不符");
    return bytes;
}

function displayDimensions(metadata: Metadata) {
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = Number(rotated ? metadata.height : metadata.width);
    const height = Number(rotated ? metadata.width : metadata.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new ImageProcessingRejection("invalid_image", "商品图片尺寸无效");
    return { width, height };
}

function imageMimeType({ format, compression }: { format?: string; compression?: string }) {
    if (format === "heif" && compression === "av1") return "image/avif";
    if (format === "jpeg" || format === "jpg") return "image/jpeg";
    if (format === "png" || format === "webp" || format === "gif" || format === "avif" || format === "tiff") return `image/${format}`;
    throw new ImageProcessingRejection("invalid_image", "商品图片格式不支持");
}

function expand(bounds: ImageProcessingRectangle, width: number, height: number) {
    const horizontalPadding = Math.max(1, Math.ceil(bounds.width * 0.08));
    const verticalPadding = Math.max(1, Math.ceil(bounds.height * 0.08));
    const x = Math.max(0, bounds.x - horizontalPadding);
    const y = Math.max(0, bounds.y - verticalPadding);
    const right = Math.min(width, bounds.x + bounds.width + horizontalPadding);
    const bottom = Math.min(height, bounds.y + bounds.height + verticalPadding);
    return { x, y, width: right - x, height: bottom - y };
}

function digest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}
