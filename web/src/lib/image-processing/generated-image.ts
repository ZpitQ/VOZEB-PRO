import sharp, { type Metadata } from "sharp";

import { parseImageDimensions } from "../image-size.ts";
import { ImageProcessingRejection } from "./errors.ts";

export async function normalizeGeneratedImageBytes(
    bytes: Buffer,
    mimeType: string,
    targetSize?: string,
    limitInputPixels = 40_000_000,
): Promise<{ bytes: Buffer; mimeType: string; width: number; height: number; nativeImage?: { format: string; hasAlpha: boolean } }> {
    const image = sharp(bytes, { failOn: "error", limitInputPixels });
    const metadata = await image.metadata().catch(decodeFailure);
    const dimensions = orientedDimensions(metadata);
    mimeType = imageMimeType(metadata);
    const target = targetSize ? parseImageDimensions(targetSize) : null;
    if (target && (!Number.isSafeInteger(target.width) || !Number.isSafeInteger(target.height) || target.width <= 0 || target.height <= 0)) throw new ImageProcessingRejection("invalid_result", "目标图片尺寸无效");
    if (!target || (dimensions.width === target.width && dimensions.height === target.height) || dimensions.width < target.width || dimensions.height < target.height) {
        const stats = await image.stats().catch(decodeFailure);
        return { bytes, mimeType, ...dimensions, nativeImage: { format: mimeType.slice("image/".length), hasAlpha: !stats.isOpaque } };
    }
    const pipeline = image.rotate().resize(target.width, target.height, { fit: "inside", withoutEnlargement: true });
    if (metadata.format === "jpeg") pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
    const result = await pipeline.toBuffer({ resolveWithObject: true }).catch(decodeFailure);
    const outputMetadata = result.info.format === "heif" ? await sharp(result.data, { failOn: "error", limitInputPixels }).metadata().catch(decodeFailure) : result.info;
    return { bytes: result.data, mimeType: imageMimeType(outputMetadata), width: result.info.width, height: result.info.height };
}

function decodeFailure(error: unknown): never {
    throw new ImageProcessingRejection("invalid_result", error instanceof Error ? error.message : "上游图片无法解码", { cause: error });
}

export function orientedDimensions(metadata: Metadata) {
    const rotated = metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = Number(rotated ? metadata.height : metadata.width);
    const height = Number(rotated ? metadata.width : metadata.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new ImageProcessingRejection("invalid_result", "上游图片尺寸无效");
    return { width, height };
}

export function imageMimeType({ format, compression }: { format?: string; compression?: string }) {
    if (format === "heif" && compression === "av1") return "image/avif";
    if (format === "jpg" || format === "jpeg") return "image/jpeg";
    if (format === "png" || format === "webp" || format === "gif" || format === "avif" || format === "tiff") return `image/${format}`;
    throw new ImageProcessingRejection("invalid_result", "上游图片格式不支持");
}
