import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import type { ImageProcessingEnhancementArtifact, ImageProcessingEnhancementOptions, ImageProcessingRequest, ImageProcessingResult, ImageProcessingSourceIdentity, ProductEnhancementEvidence, SceneEnhancementEvidence } from "./contracts.ts";
import { ImageProcessingRejection } from "./errors.ts";
import { imageMimeType, orientedDimensions } from "./generated-image.ts";
import { prepareProductProtection, compositePreparedProduct } from "./product-protection.ts";
import { compositeSceneEditBytes } from "./scene-protection.ts";
import { compositeSceneEnhancementBytes } from "./scene-enhancement.ts";

type Request = Extract<ImageProcessingRequest, { operation: "process_enhancement" }>;
type Budget = ImageProcessingEnhancementOptions["budgets"]["ai"];
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function processEnhancement(request: Request, sampleMemory: () => void): Promise<Omit<ImageProcessingResult, "metrics">> {
    try {
        return await process(request, sampleMemory);
    } catch (error) {
        if (error instanceof ImageProcessingRejection) throw error;
        throw new ImageProcessingRejection("enhancement_publication_rejected", error instanceof Error ? error.message : "Enhancement pixels could not be processed", { cause: error });
    }
}

async function process(request: Request, sampleMemory: () => void): Promise<Omit<ImageProcessingResult, "metrics">> {
    const options = request.options;
    const inputs: Buffer[] = [];
    const sourceIdentities: ImageProcessingSourceIdentity[] = [];
    for (const [index, input] of request.inputs.entries()) {
        const budget = inputBudget(options, index);
        const file = await stat(input.path);
        if (!file.isFile() || !file.size || file.size > budget.maxBytes) reject("Enhancement input exceeds its byte budget");
        const bytes = await readFile(input.path);
        if (bytes.length !== file.size || bytes.length > budget.maxBytes || digest(bytes) !== input.expectedSha256) reject("Enhancement input identity changed");
        const metadata = await sharp(bytes, { failOn: "warning", limitInputPixels: budget.maxPixels }).metadata();
        const size = orientedDimensions(metadata);
        if (BigInt(size.width) * BigInt(size.height) > BigInt(budget.maxPixels)) reject("Enhancement input dimensions exceed its budget");
        inputs.push(bytes);
        sourceIdentities.push({ assetId: input.assetId, assetVersion: input.assetVersion, sha256: digest(bytes), bytes: bytes.length, mimeType: imageMimeType(metadata), ...size });
        sampleMemory();
    }
    const ai = inputs[options.aiInputIndex];
    const expected = options.expectedAi;
    if (expected.width !== options.engineInput.width * 4 || expected.height !== options.engineInput.height * 4) reject("Enhancement AI must match the native four-times inference size");
    const qualifiedAi = await validate(ai, expected, options.budgets.ai, sampleMemory);
    let delivered: Buffer;
    let deliveredSize = { width: expected.width, height: expected.height };
    let format: "png" | "jpeg";
    let protection: ProductEnhancementEvidence | SceneEnhancementEvidence | undefined;
    let deliveryEncodingMs: number | undefined;
    if (options.scope === "full_image") {
        if (Math.min(options.targetSize.width / expected.width, options.targetSize.height / expected.height) > 1) reject("Enhancement delivery cannot enlarge the AI image");
        const scale = Math.min(1, options.targetSize.width / expected.width, options.targetSize.height / expected.height);
        deliveredSize = { width: Math.round(expected.width * scale), height: Math.round(expected.height * scale) };
        if (options.stagedDelivered) {
            const staged = options.stagedDelivered;
            delivered = inputs[staged.inputIndex];
            await validate(delivered, staged.expected, options.budgets.delivery, sampleMemory);
            if (staged.expected.width !== deliveredSize.width || staged.expected.height !== deliveredSize.height) reject("Staged global enhancement dimensions do not match the frozen target");
            format = staged.expected.format;
        } else {
            const started = performance.now();
            const encoded = await sharp(ai, { failOn: "warning", limitInputPixels: options.budgets.ai.maxPixels })
                .resize(options.targetSize.width, options.targetSize.height, { fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
                .toBuffer({ resolveWithObject: true });
            deliveryEncodingMs = performance.now() - started;
            delivered = encoded.data;
            deliveredSize = { width: encoded.info.width, height: encoded.info.height };
            format = "jpeg";
            sampleMemory();
        }
    } else {
        const source = inputs[options.sourceInputIndex];
        const native = inputs[options.nativeInputIndex];
        const baseline = inputs[options.baselineInputIndex];
        const mask = inputs[options.maskInputIndex];
        if (source.length !== options.source.byteLength || digest(source) !== options.source.sha256) reject("Enhancement original source changed");
        await validate(native, options.native, options.budgets.input, sampleMemory, false);
        await validate(baseline, options.baseline, options.budgets.delivery, sampleMemory);
        const normalized = await sharp(source, { failOn: "warning", limitInputPixels: options.budgets.input.maxPixels }).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer({ resolveWithObject: true });
        sampleMemory();
        if (normalized.info.width !== options.source.width || normalized.info.height !== options.source.height || digest(normalized.data) !== options.source.normalizedSha256) reject("Enhancement source normalization changed");
        const sourceAssetId = options.scope === "product_background" ? options.protection.product.sourceAssetId : options.protection.scene.sourceAssetId;
        if (request.inputs[options.sourceInputIndex].assetId !== sourceAssetId) reject("Enhancement protection source asset changed");
        let composed: { bytes: Buffer; evidence: ProductEnhancementEvidence | SceneEnhancementEvidence };
        if (options.scope === "product_background") {
            const context = await prepareProductProtection(source, mask, options.protection, options.budgets.input.maxPixels, sampleMemory);
            const rebuilt = await compositePreparedProduct(native, context, "native", sampleMemory);
            if (!rebuilt.bytes.equals(baseline) || !isDeepStrictEqual(rebuilt.evidence, options.originalProof)) reject("Enhancement product baseline proof changed");
            const finalContext = await prepareProductProtection(baseline, mask, options.protection, options.budgets.ai.maxPixels, sampleMemory);
            const started = performance.now();
            composed = await compositePreparedProduct(ai, finalContext, "ai", sampleMemory);
            deliveryEncodingMs = performance.now() - started;
        } else {
            const rebuilt = await compositeSceneEditBytes(source, native, mask, options.protection.scene, sampleMemory);
            if (!rebuilt.bytes.equals(baseline) || !isDeepStrictEqual(rebuilt.evidence, options.originalProof)) reject("Enhancement scene baseline proof changed");
            const started = performance.now();
            composed = await compositeSceneEnhancementBytes(baseline, ai, mask, options.protection, options.budgets.ai.maxPixels, sampleMemory);
            deliveryEncodingMs = performance.now() - started;
        }
        delivered = composed.bytes;
        protection = composed.evidence;
        deliveredSize = protection.sourceSize;
        format = "png";
        if (deliveredSize.width !== options.targetSize.width || deliveredSize.height !== options.targetSize.height) reject("Protected enhancement delivery dimensions changed");
        if (options.stagedDelivered) {
            const staged = options.stagedDelivered;
            await validate(inputs[staged.inputIndex], staged.expected, options.budgets.delivery, sampleMemory);
            if (staged.expected.format !== "png" || !inputs[staged.inputIndex].equals(delivered)) reject("Staged protected enhancement does not match recomposition");
            delivered = inputs[staged.inputIndex];
            deliveryEncodingMs = undefined;
        }
    }
    const descriptor = { ...deliveredSize, format, sha256: digest(delivered), byteLength: delivered.length };
    await validate(delivered, descriptor, options.budgets.delivery, sampleMemory);
    const filename = path.join(request.outputDirectory, `final-${options.resultIndex}.${format === "jpeg" ? "jpg" : "png"}`);
    await writeFile(filename, delivered, { flag: "wx" });
    sampleMemory();
    return {
        jobId: request.jobId,
        executionId: request.executionId,
        sourceIdentities,
        artifacts: [{ kind: "final", path: filename, sha256: descriptor.sha256, bytes: delivered.length, mimeType: `image/${format}`, ...deliveredSize, resultId: options.resultId, resultIndex: options.resultIndex }],
        geometry: { sourceSize: options.scope === "full_image" ? { width: expected.width, height: expected.height } : { width: options.source.width, height: options.source.height } },
        enhancement: {
            version: "enhancement-processing-result.v1",
            bindingDigest: options.bindingDigest,
            scope: options.scope,
            aiInputIndex: options.aiInputIndex,
            ai: qualifiedAi,
            deliveredArtifactIndex: 0,
            ...(deliveryEncodingMs === undefined ? {} : { deliveryEncodingMs }),
            ...(protection ? { protection } : {}),
        },
    };
}

function inputBudget(options: ImageProcessingEnhancementOptions, index: number): Budget {
    const budgets: Budget[] = [];
    if (index === options.aiInputIndex) budgets.push(options.budgets.ai);
    if (options.stagedDelivered?.inputIndex === index || (options.scope !== "full_image" && options.baselineInputIndex === index)) budgets.push(options.budgets.delivery);
    if (options.scope !== "full_image" && [options.sourceInputIndex, options.nativeInputIndex, options.maskInputIndex].includes(index)) budgets.push(options.budgets.input);
    return { maxBytes: Math.min(...budgets.map((budget) => budget.maxBytes)), maxPixels: Math.min(...budgets.map((budget) => budget.maxPixels)) };
}

async function validate<Format extends "png" | "jpeg">(
    bytes: Buffer,
    expected: ImageProcessingEnhancementArtifact & { format: Format },
    budget: Budget,
    sampleMemory: () => void,
    permanent = true,
): Promise<ImageProcessingEnhancementArtifact & { format: Format }> {
    if (bytes.length !== expected.byteLength || bytes.length > budget.maxBytes || digest(bytes) !== expected.sha256) reject("Enhancement artifact bytes changed or exceed their budget");
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: budget.maxPixels });
    const metadata = await image.metadata();
    const stats = await image.stats();
    sampleMemory();
    const observedSize = orientedDimensions(metadata);
    if (
        metadata.format !== expected.format ||
        observedSize.width !== expected.width ||
        observedSize.height !== expected.height ||
        (metadata.pages !== undefined && metadata.pages !== 1) ||
        (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height) ||
        (permanent && metadata.orientation !== undefined && metadata.orientation !== 1) ||
        (permanent && !stats.isOpaque) ||
        BigInt(observedSize.width) * BigInt(observedSize.height) > BigInt(budget.maxPixels)
    )
        reject("Enhancement artifact pixels are invalid");
    return { ...observedSize, format: expected.format, sha256: digest(bytes), byteLength: bytes.length };
}

function reject(message: string): never {
    throw new ImageProcessingRejection("enhancement_publication_rejected", message);
}
