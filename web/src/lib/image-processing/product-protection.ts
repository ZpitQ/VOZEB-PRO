import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

import type { ProductEnhancementDescriptor, ProductEnhancementEvidence } from "./contracts.ts";
import { ImageProcessingRejection } from "./errors.ts";
import { validPixelRectangle } from "./protection-masks.ts";

type ProductPixelDescriptor = Omit<ProductEnhancementDescriptor, "product"> & {
    product: Pick<ProductEnhancementDescriptor["product"], "compilerVersion" | "state" | "productAnchorId" | "sourceAssetId" | "sourceSize" | "productCore">;
};
export type ProductEnhancementProtection = ProductEnhancementDescriptor & { maskDataUrl: string };
export type { ProductEnhancementEvidence } from "./contracts.ts";

export function compositeProductEnhancement(source: Buffer, ai: Buffer, protection: ProductEnhancementProtection, maxPixels: number, candidateRole: "ai" | "native" = "ai") {
    return composite(source, ai, protection.maskDataUrl, protection, maxPixels, candidateRole, () => {});
}

async function composite(
    source: Buffer,
    ai: Buffer,
    maskInput: Buffer | string,
    protection: ProductEnhancementDescriptor,
    maxPixels: number,
    candidateRole: "ai" | "native",
    sampleMemory: () => void,
): Promise<{ bytes: Buffer; finalImage: { format: "png"; hasAlpha: boolean }; evidence: ProductEnhancementEvidence }> {
    const context = await prepareProductProtection(source, maskInput, protection, maxPixels, sampleMemory);
    return compositePreparedProduct(ai, context, candidateRole, sampleMemory);
}

export async function prepareProductProtection(source: Buffer, maskInput: Buffer | string, protection: ProductPixelDescriptor, maxPixels: number, sampleMemory: () => void) {
    if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) reject("Product enhancement pixel limit must be a positive safe integer");
    const product = protection?.product;
    if (protection?.version !== "product-enhancement.v2" || protection.normalization !== "srgb-upright-v1") reject("Product enhancement protection version or normalization is invalid");
    if (product?.compilerVersion !== "strict-product.v1" || product.state !== "ready") reject("Product protection snapshot is invalid");
    if (typeof product.productAnchorId !== "string" || !product.productAnchorId.trim() || typeof product.sourceAssetId !== "string" || !product.sourceAssetId.trim()) reject("Product protection requires a product anchor and source asset");
    const size = product.sourceSize;
    if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0) reject("Product protection source dimensions must be positive safe integers");
    if (BigInt(size.width) * BigInt(size.height) > BigInt(maxPixels)) reject("Product protection source exceeds the pixel limit");
    if (!Array.isArray(product.productCore) || !product.productCore.length || product.productCore.some((region) => !region || !validPixelRectangle(region, size))) reject("Product core rectangles are empty or invalid");
    const original = await decodeProductPixels(source, "source", maxPixels);
    sampleMemory();
    if (original.info.width !== size.width || original.info.height !== size.height) reject("Product protection source dimensions do not match the normalized source");
    assertOpaque(original.data, "source");
    const maskBytes = typeof maskInput === "string" ? strictMaskBytes(maskInput) : maskInput;
    if (digest(maskBytes) !== protection.maskSha256) reject("Product enhancement mask digest does not match");
    const mask = await decodeProductPixels(maskBytes, "mask", maxPixels, true);
    sampleMemory();
    if (mask.info.width !== size.width || mask.info.height !== size.height) reject("Product enhancement mask dimensions must match the normalized source");
    for (const region of product.productCore)
        for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) if (mask.data[y * size.width + x] !== 255) reject("Product enhancement mask overlaps the protected product core");
    let allowedPixels = 0;
    for (const alpha of mask.data) if (alpha < 255) allowedPixels++;
    if (!allowedPixels) reject("Product enhancement mask has no allowed pixels");
    return { original, mask, allowedPixels, size, protection, maxPixels, sourceSha256: digest(source), maskSha256: digest(maskBytes) };
}

export async function compositePreparedProduct(
    ai: Buffer,
    context: Awaited<ReturnType<typeof prepareProductProtection>>,
    candidateRole: "ai" | "native",
    sampleMemory: () => void,
): Promise<{ bytes: Buffer; finalImage: { format: "png"; hasAlpha: boolean }; evidence: ProductEnhancementEvidence }> {
    const { original, mask, allowedPixels, size, protection, maxPixels, sourceSha256, maskSha256 } = context;
    const product = protection.product;
    const { pixels, aiSize } = await mapProductCandidate(ai, size, maxPixels, candidateRole);
    sampleMemory();
    for (let offset = 0, index = 0; offset < pixels.length; offset += 4, index++) {
        const alpha = mask.data[index];
        for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round((original.data[offset + channel] * alpha + pixels[offset + channel] * (255 - alpha)) / 255);
        pixels[offset + 3] = original.data[offset + 3];
    }
    const bytes = await sharp(pixels, { raw: { ...size, channels: 4 }, limitInputPixels: maxPixels })
        .png()
        .toBuffer();
    sampleMemory();
    const persisted = await decodeProductPixels(bytes, "composite", maxPixels);
    sampleMemory();
    let protectedPixels = 0;
    for (let offset = 0, index = 0; offset < pixels.length; offset += 4, index++) {
        if (mask.data[index] !== 255) continue;
        protectedPixels++;
        if (persisted.data.readUInt32LE(offset) !== original.data.readUInt32LE(offset)) reject("Product enhancement protected pixels changed after encoding");
    }
    return {
        bytes,
        finalImage: { format: "png", hasAlpha: false },
        evidence: {
            version: "product-enhancement.v2",
            normalization: "srgb-upright-v1",
            productAnchorId: product.productAnchorId,
            sourceAssetId: product.sourceAssetId,
            sourceSha256,
            maskSha256,
            aiSha256: digest(ai),
            compositeSha256: digest(bytes),
            sourceSize: { width: original.info.width, height: original.info.height },
            aiSize,
            allowedPixels,
            protectedPixels,
            protectedChangedPixels: 0,
        },
    };
}

async function mapProductCandidate(ai: Buffer, size: { width: number; height: number }, maxPixels: number, role: "ai" | "native") {
    const candidate = await decodeProductPixels(ai, role === "native" ? "native" : "candidate", maxPixels);
    assertOpaque(candidate.data, "candidate");
    const aiSize = { width: candidate.info.width, height: candidate.info.height };
    if (role === "native" && (aiSize.width !== size.width || aiSize.height !== size.height)) reject("Product native dimensions must exactly match the source");
    if (aiSize.width < size.width || aiSize.height < size.height) reject("Product enhancement candidate must be at least the source size");
    if (BigInt(aiSize.width) * BigInt(size.height) !== BigInt(aiSize.height) * BigInt(size.width)) reject("Product enhancement candidate aspect ratio must exactly match the source");
    const pixels =
        aiSize.width === size.width && aiSize.height === size.height
            ? candidate.data
            : await sharp(candidate.data, { raw: { ...aiSize, channels: 4 }, limitInputPixels: maxPixels })
                  .resize(size.width, size.height, { fit: "fill", withoutEnlargement: true })
                  .raw()
                  .toBuffer();
    return { pixels, aiSize };
}

async function decodeProductPixels(bytes: Buffer, kind: "source" | "native" | "mask" | "candidate" | "composite", maxPixels: number, alphaOnly = false) {
    const type = await fileTypeFromBuffer(bytes).catch(() => undefined);
    if (type?.mime === "image/apng" || (kind === "native" ? !["image/png", "image/jpeg"].includes(type?.mime || "") : kind !== "source" && type?.mime !== "image/png"))
        reject(`Product enhancement ${kind} must be a single-frame PNG${kind === "native" ? " or JPEG" : ""}`);
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: maxPixels });
    const metadata = await image.metadata().catch((error: unknown) => {
        throw new ImageProcessingRejection("product_protection_rejected", `Product enhancement ${kind} could not decode within the pixel limit`, { cause: error });
    });
    if ((metadata.pages && metadata.pages !== 1) || (metadata.pageHeight && metadata.pageHeight !== metadata.height)) reject(`Product enhancement ${kind} must have a single frame`);
    if (kind !== "source" && kind !== "native" && metadata.orientation && metadata.orientation !== 1) reject(`Product enhancement ${kind} must have upright orientation`);
    if (!metadata.width || !metadata.height || BigInt(metadata.width) * BigInt(metadata.height) > BigInt(maxPixels)) reject(`Product enhancement ${kind} exceeds the pixel limit`);
    const normalized = image.rotate().toColourspace("srgb").ensureAlpha();
    return (alphaOnly ? normalized.extractChannel("alpha") : normalized)
        .raw()
        .toBuffer({ resolveWithObject: true })
        .catch((error: unknown) => {
            throw new ImageProcessingRejection("product_protection_rejected", `Product enhancement ${kind} could not decode completely within the pixel limit`, { cause: error });
        });
}

function strictMaskBytes(dataUrl: string) {
    if (typeof dataUrl !== "string" || !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataUrl)) reject("Product enhancement mask must be a strict PNG data URL");
    const payload = dataUrl.slice("data:image/png;base64,".length);
    const bytes = Buffer.from(payload, "base64");
    if (!bytes.length || bytes.toString("base64") !== payload) reject("Product enhancement mask must be a strict PNG data URL");
    return bytes;
}
function assertOpaque(data: Buffer, kind: "source" | "candidate") {
    for (let offset = 3; offset < data.length; offset += 4) if (data[offset] !== 255) reject(`Product enhancement ${kind} must be opaque`);
}
function digest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}
function reject(message: string): never {
    throw new ImageProcessingRejection("product_protection_rejected", message);
}
