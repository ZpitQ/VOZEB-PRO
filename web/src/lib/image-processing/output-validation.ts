import sharp from "sharp";

import { ImageProcessingRejection } from "./errors.ts";
import { imageMimeType } from "./generated-image.ts";

export async function assertTransparentImageBytes(bytes: Buffer) {
    const image = sharp(bytes, { failOn: "error" });
    const metadata = await image.metadata();
    if (!metadata.hasAlpha) rejectTransparent("上游没有生成透明背景");
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = false;
    let transparent = false;
    for (let offset = info.channels - 1; offset < data.length; offset += info.channels) {
        const alpha = data[offset];
        if (alpha > 0) visible = true;
        if (alpha < 255) transparent = true;
        if (visible && transparent) return;
    }
    if (!visible) rejectTransparent("上游生成了全透明空图");
    rejectTransparent("上游没有生成透明背景");
}

export async function validateImageLayerBytes(sourceBytes: Buffer, outputBytes: AsyncIterable<Buffer>) {
    const source = await readLayerImage(sourceBytes, "源图");
    const pixelCount = source.width * source.height;
    const coverageOwner = new Uint32Array(pixelCount);
    const outputs: Array<{ width: number; height: number; bytes: number; mimeType: string; kind: "element" | "background" }> = [];
    const elementIndexes: number[] = [];
    let background: Awaited<ReturnType<typeof readLayerImage>> | undefined;
    for await (const bytes of outputBytes) {
        const outputIndex = outputs.length;
        const output = await readLayerImage(bytes, "分层结果", source);
        outputs.push({ width: output.width, height: output.height, bytes: bytes.length, mimeType: output.mimeType, kind: output.hasTransparentPixel ? "element" : "background" });
        if (!output.hasTransparentPixel) {
            if (background) rejectLayers("上游未返回完整分层：只能包含一张干净背景");
            background = output;
            continue;
        }
        elementIndexes.push(outputIndex);
        for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
            const offset = pixelIndex * 4;
            if (output.pixels[offset + 3] === 0) continue;
            if (coverageOwner[pixelIndex]) rejectLayers("上游返回的元素图层存在重复像素，没有独立分层");
            if (!sameRgb(source.pixels, output.pixels, offset)) rejectLayers("上游返回的元素不是源图原始像素");
            coverageOwner[pixelIndex] = outputIndex + 1;
        }
    }
    if (!outputs.length) rejectLayers("上游没有返回分层图片");
    if (!elementIndexes.length || !background) rejectLayers("上游未返回完整分层：需要独立透明元素和一张干净背景");
    const changedElements = new Set<number>();
    let uncovered = false;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        const offset = pixelIndex * 4;
        const owner = coverageOwner[pixelIndex];
        if (!owner) {
            uncovered = true;
            if (!sameRgba(source.pixels, background.pixels, offset)) rejectLayers("上游背景改动了元素之外的源图内容");
        } else if (!sameRgba(source.pixels, background.pixels, offset)) changedElements.add(owner - 1);
    }
    if (!uncovered) rejectLayers("上游没有保留可验证的原图背景区域");
    if (elementIndexes.some((index) => !changedElements.has(index))) rejectLayers("上游背景没有移除全部独立元素");
    return outputs;
}

async function readLayerImage(bytes: Buffer, label: string, expectedSize?: { width: number; height: number }) {
    if (!bytes.length) rejectLayers(`${label}为空`);
    const image = sharp(bytes, { failOn: "error" });
    const metadata = await image.metadata().catch((error: unknown) => {
        throw new ImageProcessingRejection("invalid_layers", `${label}无法读取`, { cause: error });
    });
    if (expectedSize) {
        const rotated = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
        const width = rotated ? metadata.height : metadata.width;
        const height = rotated ? metadata.width : metadata.height;
        if (width !== expectedSize.width || height !== expectedSize.height) rejectLayers("分层结果尺寸与源图不一致，无法验证原图像素");
    }
    const { data, info } = await image
        .rotate()
        .toColourspace("srgb")
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .catch((error: unknown) => {
            throw new ImageProcessingRejection("invalid_layers", `${label}无法读取`, { cause: error });
        });
    let visible = false;
    let transparent = false;
    for (let offset = 3; offset < data.length; offset += 4) {
        if (data[offset] > 0) visible = true;
        if (data[offset] < 255) transparent = true;
    }
    if (!visible) rejectLayers(`${label}是全透明空图`);
    return { pixels: data, width: info.width, height: info.height, mimeType: imageMimeType(metadata), hasTransparentPixel: transparent };
}

function sameRgb(left: Buffer, right: Buffer, offset: number) {
    return left[offset] === right[offset] && left[offset + 1] === right[offset + 1] && left[offset + 2] === right[offset + 2];
}
function sameRgba(left: Buffer, right: Buffer, offset: number) {
    return sameRgb(left, right, offset) && left[offset + 3] === right[offset + 3];
}
function rejectTransparent(message: string): never {
    throw new ImageProcessingRejection("invalid_transparent_result", message);
}
function rejectLayers(message: string): never {
    throw new ImageProcessingRejection("invalid_layers", message);
}
