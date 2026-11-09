import { createHash } from "node:crypto";
import sharp from "sharp";

import type { SceneProtectionSnapshot, SceneProtectionEvidence, ImageProcessingSize } from "./contracts.ts";
import { ImageProcessingRejection } from "./errors.ts";
import { inside, validPixelRectangle } from "./protection-masks.ts";

export async function validateSceneProtectionBytes(source: Buffer, maskBytes: Buffer, protection: SceneProtectionSnapshot) {
    if (protection.version !== "scene-edit-protection.v1" || protection.selectionSource !== "user_selection" || protection.maskSemantics !== "alpha_zero_edit" || protection.method !== "source_pixels_copy" || protection.sourceDigest !== digest(source))
        reject("局部场景保护来源或语义无效");
    const original = await decodeScenePixels(source);
    if (!sameSize(original.info, protection.sourceSize) || !sameSize(protection.maskSize, protection.sourceSize) || !validPixelRectangle(protection.targetRegion, protection.sourceSize)) reject("源图或蒙版尺寸与保护快照不一致");
    if (protection.targetRegion.width * protection.targetRegion.height === protection.sourceSize.width * protection.sourceSize.height) reject("局部场景保护不能覆盖整图");
    const mask = await decodeScenePixels(maskBytes, protection.sourceSize);
    for (let y = 0; y < mask.info.height; y++) for (let x = 0; x < mask.info.width; x++) if (mask.data[(y * mask.info.width + x) * 4 + 3] !== (inside(protection.targetRegion, x, y) ? 0 : 255)) reject("蒙版反向或覆盖了允许区域之外的像素");
    if (digest(maskBytes) !== protection.maskDigest) reject("蒙版与不可变快照不一致");
    return original;
}

export async function compositeSceneEditBytes(
    source: Buffer,
    generated: Buffer,
    mask: Buffer,
    protection: SceneProtectionSnapshot,
    sampleMemory: () => void = () => {},
): Promise<{ bytes: Buffer; finalImage: { format: "png"; hasAlpha: boolean }; evidence: SceneProtectionEvidence }> {
    const original = await validateSceneProtectionBytes(source, mask, protection);
    return compositePreparedScene(generated, { original, protection }, sampleMemory);
}

export async function compositePreparedScene(
    generated: Buffer,
    context: { original: Awaited<ReturnType<typeof validateSceneProtectionBytes>>; protection: SceneProtectionSnapshot },
    sampleMemory: () => void,
): Promise<{ bytes: Buffer; finalImage: { format: "png"; hasAlpha: boolean }; evidence: SceneProtectionEvidence }> {
    const { original, protection } = context;
    sampleMemory();
    const sourceSize = protection.sourceSize;
    const { pixels, nativeSize, normalization } = await mapSceneCandidate(generated, sourceSize);
    sampleMemory();
    let outsidePixels = 0;
    let mappedOutsideChangedPixels = 0;
    for (let y = 0; y < sourceSize.height; y++)
        for (let x = 0; x < sourceSize.width; x++) {
            if (inside(protection.targetRegion, x, y)) continue;
            const offset = (y * sourceSize.width + x) * 4;
            outsidePixels++;
            const originalPixel = original.data.readUInt32LE(offset);
            if (pixels.readUInt32LE(offset) !== originalPixel) mappedOutsideChangedPixels++;
            pixels.writeUInt32LE(originalPixel, offset);
        }
    const bytes = await sharp(pixels, { raw: { ...sourceSize, channels: 4 } })
        .png()
        .toBuffer();
    sampleMemory();
    const persisted = await decodeScenePixels(bytes);
    let hasAlpha = false;
    sampleMemory();
    for (let y = 0; y < sourceSize.height; y++)
        for (let x = 0; x < sourceSize.width; x++) {
            const offset = (y * sourceSize.width + x) * 4;
            if (persisted.data[offset + 3] !== 255) hasAlpha = true;
            if (inside(protection.targetRegion, x, y)) continue;
            if (persisted.data.readUInt32LE(offset) !== original.data.readUInt32LE(offset)) reject("选区外像素保护验证失败");
        }
    return {
        bytes,
        finalImage: { format: "png", hasAlpha },
        evidence: {
            ...structuredClone(protection),
            nativeSize,
            normalization,
            nativeDigest: digest(generated),
            compositeDigest: digest(bytes),
            outsidePixels,
            mappedOutsideChangedPixels,
            ...(normalization === "none" ? { nativeOutsideChangedPixels: mappedOutsideChangedPixels } : {}),
            compositeOutsideChangedPixels: 0,
        },
    };
}

async function mapSceneCandidate(generated: Buffer, sourceSize: ImageProcessingSize) {
    const native = await decodeScenePixels(generated);
    const nativeSize = { width: native.info.width, height: native.info.height };
    const cross = BigInt(nativeSize.width) * BigInt(sourceSize.height) - BigInt(nativeSize.height) * BigInt(sourceSize.width);
    // Both half-up rounded edges must admit the same scale; equality has no common scale.
    if (BigInt(2) * (cross < BigInt(0) ? -cross : cross) >= BigInt(sourceSize.width) + BigInt(sourceSize.height))
        reject(`局部编辑上游原生画幅比例与源图不一致，禁止拉伸或裁切（源图 ${sourceSize.width}x${sourceSize.height}，原生 ${nativeSize.width}x${nativeSize.height}）`);
    const normalization = sameSize(nativeSize, sourceSize) ? ("none" as const) : cross === BigInt(0) ? ("uniform_scale" as const) : ("pixel_grid_scale" as const);
    const pixels =
        normalization === "none"
            ? native.data
            : await sharp(native.data, { raw: { ...nativeSize, channels: 4 } })
                  .resize(sourceSize.width, sourceSize.height, { fit: "fill" })
                  .raw()
                  .toBuffer();
    return { pixels, nativeSize, normalization };
}

export async function decodeScenePixels(bytes: Buffer, expectedMaskSize?: ImageProcessingSize) {
    try {
        const image = sharp(bytes);
        if (expectedMaskSize) {
            const metadata = await image.metadata();
            const rotated = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
            const width = rotated ? metadata.height : metadata.width;
            const height = rotated ? metadata.width : metadata.height;
            if (width !== expectedMaskSize.width || height !== expectedMaskSize.height) reject("蒙版尺寸必须与源图一致");
        }
        return await image.rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    } catch (error) {
        if (error instanceof ImageProcessingRejection) throw error;
        throw new ImageProcessingRejection("scene_protection_rejected", error instanceof Error ? error.message : "场景图片无法解码", { cause: error });
    }
}

function sameSize(value: ImageProcessingSize, expected: ImageProcessingSize) {
    return value.width === expected.width && value.height === expected.height;
}
function digest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}
function reject(message: string): never {
    throw new ImageProcessingRejection("scene_protection_rejected", message);
}
