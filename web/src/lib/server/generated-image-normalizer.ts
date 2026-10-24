import sharp, { type Metadata } from "sharp";

import { parseImageDimensions } from "@/lib/image-size";

const MAX_INPUT_PIXELS = 40_000_000;

type NormalizedGeneratedImage = {
    bytes: Buffer;
    mimeType: string;
    width?: number;
    height?: number;
};

export async function normalizeGeneratedImageBytes(bytes: Buffer, mimeType: string, targetSize?: string): Promise<NormalizedGeneratedImage> {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS });
    const metadata = await image.metadata();
    const dimensions = orientedDimensions(metadata);
    mimeType = imageMimeType(metadata);
    const target = targetSize ? parseImageDimensions(targetSize) : null;
    if (target) assertTargetDimensions(target.width, target.height);
    if (!target || (dimensions.width === target.width && dimensions.height === target.height) || dimensions.width < target.width || dimensions.height < target.height) {
        await image.stats();
        return { bytes, mimeType, ...dimensions };
    }

    const pipeline = image.rotate().resize(target.width, target.height, { fit: "inside", withoutEnlargement: true });
    if (metadata.format === "jpeg") pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
    const result = await pipeline.toBuffer({ resolveWithObject: true });
    const outputMetadata = result.info.format === "heif" ? await sharp(result.data, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).metadata() : result.info;
    return {
        bytes: result.data,
        mimeType: imageMimeType(outputMetadata),
        width: result.info.width,
        height: result.info.height,
    };
}

function orientedDimensions(metadata: Metadata) {
    const rotated = metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = Number(rotated ? metadata.height : metadata.width);
    const height = Number(rotated ? metadata.width : metadata.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error("上游图片尺寸无效");
    return { width, height };
}

function assertTargetDimensions(width: number, height: number) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        throw new Error("目标图片尺寸无效");
    }
}

function imageMimeType({ format, compression }: { format?: string; compression?: string }) {
    if (format === "heif" && compression === "av1") return "image/avif";
    if (format === "jpg" || format === "jpeg") return "image/jpeg";
    if (format === "png" || format === "webp" || format === "gif" || format === "avif" || format === "tiff") return `image/${format}`;
    throw new Error("上游图片格式不支持");
}
