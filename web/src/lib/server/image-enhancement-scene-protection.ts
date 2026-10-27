import type { ProductProtectionRectangle, SceneEditProtection } from "./ecommerce-product-regions";
import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

export type SceneEnhancementProtection = {
    version: "scene-enhancement.v1";
    normalization: "srgb-upright-v1";
    scene: SceneEditProtection;
};

export type SceneEnhancementEvidence = {
    version: "scene-enhancement.v1";
    normalization: "srgb-upright-v1";
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
    mapping: { context: { x: 0; y: 0; width: number; height: number }; targetRegion: ProductProtectionRectangle };
};

export async function compositeSceneEnhancement(baseline: Buffer, ai: Buffer, protection: SceneEnhancementProtection, maxPixels: number): Promise<{ bytes: Buffer; evidence: SceneEnhancementEvidence }> {
    if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) throw new Error("Scene enhancement pixel limit must be a positive safe integer");
    if (protection?.version !== "scene-enhancement.v1" || protection.normalization !== "srgb-upright-v1") throw new Error("Scene enhancement protection version or normalization is invalid");
    const scene = protection.scene;
    if (scene?.version !== "scene-edit-protection.v1" || scene.selectionSource !== "user_selection" || scene.maskSemantics !== "alpha_zero_edit" || scene.method !== "source_pixels_copy")
        throw new Error("Scene enhancement protection source or semantics is invalid");
    if (
        typeof scene.sourceAssetId !== "string" ||
        !scene.sourceAssetId.trim() ||
        !/^[a-f0-9]{64}$/.test(scene.sourceDigest) ||
        !Array.isArray(scene.semantics) ||
        !scene.semantics.length ||
        scene.semantics.some((value) => typeof value !== "string" || !value.trim())
    )
        throw new Error("Scene enhancement protection requires a source identity and semantics");
    const size = scene.sourceSize;
    if (!validSize(size)) throw new Error("Scene enhancement source dimensions must be positive safe integers");
    if (BigInt(size.width) * BigInt(size.height) > BigInt(maxPixels)) throw new Error("Scene enhancement source exceeds the pixel limit");
    const maskReference = scene.mask;
    if (!sameSize(scene.maskSize, size) || !sameSize(maskReference, size)) throw new Error("Scene enhancement mask dimensions must match the source");
    const region = scene.targetRegion;
    if (!region || ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.width > size.width - region.x || region.height > size.height - region.y)
        throw new Error("Scene enhancement target region is out of bounds or invalid");
    if (region.width === size.width && region.height === size.height) throw new Error("Scene enhancement local region cannot cover the whole frame");
    if ([maskReference.serverUrl, maskReference.url, maskReference.remoteUrl].some((value) => value !== undefined)) throw new Error("Scene enhancement mask must be inline without URL aliases");
    const dataUrl = maskReference.dataUrl;
    if (typeof dataUrl !== "string" || !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataUrl)) throw new Error("Scene enhancement mask must be a strict inline PNG data URL");
    const payload = dataUrl.slice("data:image/png;base64,".length);
    const maskBytes = Buffer.from(payload, "base64");
    if (!maskBytes.length || maskBytes.toString("base64") !== payload) throw new Error("Scene enhancement mask must be a strict inline PNG data URL");
    if (digest(maskBytes) !== scene.maskDigest) throw new Error("Scene enhancement mask digest does not match");
    const mask = await decode(maskBytes, "mask", maxPixels);
    if (!sameSize(mask.info, size)) throw new Error("Scene enhancement mask dimensions must match the source");
    let allowedPixels = 0;
    for (let y = 0; y < size.height; y++)
        for (let x = 0; x < size.width; x++) {
            if (mask.data[(y * size.width + x) * 4 + 3] === 255) continue;
            if (x < region.x || x >= region.x + region.width || y < region.y || y >= region.y + region.height) throw new Error("Scene enhancement mask allows pixels outside the frozen target region");
            allowedPixels++;
        }
    const protectedPixels = size.width * size.height - allowedPixels;
    if (!allowedPixels || !protectedPixels) throw new Error("Scene enhancement mask requires both allowed and protected pixels");

    // The qualified baseline is distinct from the original reference bound by scene.sourceDigest.
    const original = await decode(baseline, "baseline", maxPixels);
    if (!sameSize(original.info, size)) throw new Error("Scene enhancement baseline dimensions must match the source");
    const candidate = await decode(ai, "candidate", maxPixels);
    const aiSize = { width: candidate.info.width, height: candidate.info.height };
    if (aiSize.width < size.width || aiSize.height < size.height) throw new Error("Scene enhancement candidate must be at least the source size");
    if (BigInt(aiSize.width) * BigInt(size.height) !== BigInt(aiSize.height) * BigInt(size.width)) throw new Error("Scene enhancement candidate aspect ratio must exactly match the source");
    const mapped = sameSize(aiSize, size)
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
    if (!sameSize(persisted.info, size)) throw new Error("Scene enhancement composite dimensions changed after encoding");
    for (let offset = 0; offset < pixels.length; offset += 4) if (mask.data[offset + 3] === 255 && persisted.data.readUInt32LE(offset) !== original.data.readUInt32LE(offset)) throw new Error("Scene enhancement protected pixels changed after encoding");
    return {
        bytes,
        evidence: {
            version: "scene-enhancement.v1",
            normalization: "srgb-upright-v1",
            sourceAssetId: scene.sourceAssetId,
            sourceSha256: digest(baseline),
            maskSha256: digest(maskBytes),
            aiSha256: digest(ai),
            compositeSha256: digest(bytes),
            sourceSize: { ...size },
            aiSize,
            allowedPixels,
            protectedPixels,
            protectedChangedPixels: 0,
            mapping: { context: { x: 0, y: 0, ...size }, targetRegion: { ...region } },
        },
    };
}

async function decode(bytes: Buffer, kind: "baseline" | "mask" | "candidate" | "composite", maxPixels: number) {
    const type = await fileTypeFromBuffer(bytes).catch(() => undefined);
    if (type?.mime !== "image/png") throw new Error(`Scene enhancement ${kind} must be a single-frame PNG`);
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: maxPixels });
    let metadata;
    try {
        metadata = await image.metadata();
    } catch {
        throw new Error(`Scene enhancement ${kind} could not decode within the pixel limit`);
    }
    if ((metadata.pages && metadata.pages !== 1) || (metadata.pageHeight && metadata.pageHeight !== metadata.height)) throw new Error(`Scene enhancement ${kind} must have a single frame`);
    if (metadata.orientation && metadata.orientation !== 1) throw new Error(`Scene enhancement ${kind} must have upright orientation`);
    if (!validSize(metadata) || BigInt(metadata.width) * BigInt(metadata.height) > BigInt(maxPixels)) throw new Error(`Scene enhancement ${kind} exceeds the pixel limit`);
    if (kind !== "mask" && (metadata.space !== "srgb" || metadata.hasProfile || metadata.icc?.length)) throw new Error(`Scene enhancement ${kind} must use canonical sRGB without an ICC profile`);
    let decoded;
    try {
        decoded = await image.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    } catch {
        throw new Error(`Scene enhancement ${kind} could not decode completely within the pixel limit`);
    }
    if (kind !== "mask") for (let offset = 3; offset < decoded.data.length; offset += 4) if (decoded.data[offset] !== 255) throw new Error(`Scene enhancement ${kind} must be opaque`);
    return decoded;
}

function validSize(size: { width?: number; height?: number } | undefined): size is { width: number; height: number } {
    return !!size && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) && size.width! > 0 && size.height! > 0;
}

function sameSize(value: { width?: number; height?: number } | undefined, size: { width: number; height: number }) {
    return value?.width === size.width && value.height === size.height;
}

function digest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}
