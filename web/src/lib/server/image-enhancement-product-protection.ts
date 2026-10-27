import type { ProductProtectionSnapshot } from "./ecommerce-product-regions";
import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

export type ProductEnhancementProtection = {
    version: "product-enhancement.v2";
    normalization: "srgb-upright-v1";
    product: ProductProtectionSnapshot;
    maskDataUrl: string;
    maskSha256: string;
};

export type ProductEnhancementEvidence = {
    version: "product-enhancement.v2";
    normalization: "srgb-upright-v1";
    productAnchorId: string;
    sourceAssetId: string;
    sourceSha256: string;
    maskSha256: string;
    aiSha256: string;
    compositeSha256: string;
    sourceSize: { width: number; height: number };
    aiSize: { width: number; height: number };
    allowedPixels: number;
    protectedPixels: number;
    protectedChangedPixels: 0;
};

export async function compositeProductEnhancement(source: Buffer, ai: Buffer, protection: ProductEnhancementProtection, maxPixels: number, candidateRole: "ai" | "native" = "ai"): Promise<{ bytes: Buffer; evidence: ProductEnhancementEvidence }> {
    if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) throw new Error("Product enhancement pixel limit must be a positive safe integer");
    const product = protection?.product;
    if (protection?.version !== "product-enhancement.v2" || protection.normalization !== "srgb-upright-v1") throw new Error("Product enhancement protection version or normalization is invalid");
    if (product?.compilerVersion !== "strict-product.v1" || product.state !== "ready") throw new Error("Product protection snapshot is invalid");
    if (typeof product.productAnchorId !== "string" || !product.productAnchorId.trim() || typeof product.sourceAssetId !== "string" || !product.sourceAssetId.trim()) throw new Error("Product protection requires a product anchor and source asset");
    const size = product.sourceSize;
    if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0) throw new Error("Product protection source dimensions must be positive safe integers");
    if (BigInt(size.width) * BigInt(size.height) > BigInt(maxPixels)) throw new Error("Product protection source exceeds the pixel limit");
    if (
        !Array.isArray(product.productCore) ||
        !product.productCore.length ||
        product.productCore.some(
            (region) =>
                !region ||
                ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
                region.x < 0 ||
                region.y < 0 ||
                region.width <= 0 ||
                region.height <= 0 ||
                region.width > size.width - region.x ||
                region.height > size.height - region.y,
        )
    )
        throw new Error("Product core rectangles are empty or invalid");

    const original = await decode(source, "source", maxPixels);
    if (original.info.width !== size.width || original.info.height !== size.height) throw new Error("Product protection source dimensions do not match the normalized source");
    assertOpaque(original.data, "source");
    const dataUrl = protection.maskDataUrl;
    if (typeof dataUrl !== "string" || !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataUrl)) throw new Error("Product enhancement mask must be a strict PNG data URL");
    const payload = dataUrl.slice("data:image/png;base64,".length);
    const maskBytes = Buffer.from(payload, "base64");
    if (!maskBytes.length || maskBytes.toString("base64") !== payload) throw new Error("Product enhancement mask must be a strict PNG data URL");
    if (digest(maskBytes) !== protection.maskSha256) throw new Error("Product enhancement mask digest does not match");
    const mask = await decode(maskBytes, "mask", maxPixels);
    if (mask.info.width !== size.width || mask.info.height !== size.height) throw new Error("Product enhancement mask dimensions must match the normalized source");
    for (const region of product.productCore)
        for (let y = region.y; y < region.y + region.height; y++)
            for (let x = region.x; x < region.x + region.width; x++) if (mask.data[(y * size.width + x) * 4 + 3] !== 255) throw new Error("Product enhancement mask overlaps the protected product core");
    let allowedPixels = 0;
    for (let offset = 3; offset < mask.data.length; offset += 4) if (mask.data[offset] < 255) allowedPixels++;
    if (!allowedPixels) throw new Error("Product enhancement mask has no allowed pixels");

    const candidate = await decode(ai, candidateRole === "native" ? "native" : "candidate", maxPixels);
    assertOpaque(candidate.data, "candidate");
    const aiSize = { width: candidate.info.width, height: candidate.info.height };
    if (candidateRole === "native" && (aiSize.width !== size.width || aiSize.height !== size.height)) throw new Error("Product native dimensions must exactly match the source");
    if (aiSize.width < size.width || aiSize.height < size.height) throw new Error("Product enhancement candidate must be at least the source size");
    if (BigInt(aiSize.width) * BigInt(size.height) !== BigInt(aiSize.height) * BigInt(size.width)) throw new Error("Product enhancement candidate aspect ratio must exactly match the source");
    const mapped =
        aiSize.width === size.width && aiSize.height === size.height
            ? candidate.data
            : await sharp(candidate.data, { raw: { ...aiSize, channels: 4 }, limitInputPixels: maxPixels })
                  .resize(size.width, size.height, { fit: "fill", withoutEnlargement: true })
                  .raw()
                  .toBuffer();
    const pixels = Buffer.from(original.data);
    for (let offset = 0; offset < pixels.length; offset += 4) {
        const alpha = mask.data[offset + 3];
        if (alpha === 255) continue;
        for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round((original.data[offset + channel] * alpha + mapped[offset + channel] * (255 - alpha)) / 255);
    }
    const bytes = await sharp(pixels, { raw: { ...size, channels: 4 }, limitInputPixels: maxPixels })
        .png()
        .toBuffer();
    const persisted = await decode(bytes, "composite", maxPixels);
    let protectedPixels = 0;
    let protectedChangedPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
        if (mask.data[offset + 3] !== 255) continue;
        protectedPixels++;
        if (persisted.data.readUInt32LE(offset) !== original.data.readUInt32LE(offset)) protectedChangedPixels++;
    }
    if (protectedChangedPixels) throw new Error("Product enhancement protected pixels changed after encoding");
    return {
        bytes,
        evidence: {
            version: "product-enhancement.v2",
            normalization: "srgb-upright-v1",
            productAnchorId: product.productAnchorId,
            sourceAssetId: product.sourceAssetId,
            sourceSha256: digest(source),
            maskSha256: digest(maskBytes),
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

async function decode(bytes: Buffer, kind: "source" | "native" | "mask" | "candidate" | "composite", maxPixels: number) {
    const type = await fileTypeFromBuffer(bytes).catch(() => undefined);
    if (type?.mime === "image/apng" || (kind === "native" ? !["image/png", "image/jpeg"].includes(type?.mime || "") : kind !== "source" && type?.mime !== "image/png"))
        throw new Error(`Product enhancement ${kind} must be a single-frame PNG${kind === "native" ? " or JPEG" : ""}`);
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: maxPixels });
    let metadata;
    try {
        metadata = await image.metadata();
    } catch {
        throw new Error(`Product enhancement ${kind} could not decode within the pixel limit`);
    }
    if ((metadata.pages && metadata.pages !== 1) || (metadata.pageHeight && metadata.pageHeight !== metadata.height)) throw new Error(`Product enhancement ${kind} must have a single frame`);
    if (kind !== "source" && kind !== "native" && metadata.orientation && metadata.orientation !== 1) throw new Error(`Product enhancement ${kind} must have upright orientation`);
    if (!metadata.width || !metadata.height || BigInt(metadata.width) * BigInt(metadata.height) > BigInt(maxPixels)) throw new Error(`Product enhancement ${kind} exceeds the pixel limit`);
    try {
        return await image.rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    } catch {
        throw new Error(`Product enhancement ${kind} could not decode completely within the pixel limit`);
    }
}

function assertOpaque(data: Buffer, kind: "source" | "candidate") {
    for (let offset = 3; offset < data.length; offset += 4) if (data[offset] !== 255) throw new Error(`Product enhancement ${kind} must be opaque`);
}

function digest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}
