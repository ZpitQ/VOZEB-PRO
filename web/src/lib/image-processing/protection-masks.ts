import sharp from "sharp";

import type { ImageProcessingRectangle, ImageProcessingSize } from "./contracts.ts";
import { EcommerceProductSegmentationError } from "./core.ts";
import { ImageProcessingRejection } from "./errors.ts";

export async function buildLocalEditMask(size: ImageProcessingSize, target: ImageProcessingRectangle, protectedRectangles: ImageProcessingRectangle[]) {
    const left = Math.round(target.x * size.width);
    const top = Math.round(target.y * size.height);
    const right = Math.round((target.x + target.width) * size.width);
    const bottom = Math.round((target.y + target.height) * size.height);
    if (left < 0 || top < 0 || right > size.width || bottom > size.height || right <= left || bottom <= top) throw new EcommerceProductSegmentationError("局部编辑目标区域无效");
    if (protectedRectangles.some((region) => !validPixelRectangle(region, size))) throw new EcommerceProductSegmentationError("商品保护区域无效");
    const pixels = Buffer.alloc(size.width * size.height * 4, 255);
    let editablePixels = 0;
    for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
            if (protectedRectangles.some((region) => inside(region, x, y))) continue;
            pixels[(y * size.width + x) * 4 + 3] = 0;
            editablePixels++;
        }
    }
    if (!editablePixels) throw new EcommerceProductSegmentationError("局部编辑目标完全位于商品保护区域内");
    return sharp(pixels, { raw: { ...size, channels: 4 } })
        .png()
        .toBuffer();
}

export async function buildSceneSelectionMask(size: ImageProcessingSize, region: ImageProcessingRectangle, semantics: string[], selectionSource: "user_selection" | "analysis_hint") {
    if (selectionSource !== "user_selection") throw new ImageProcessingRejection("selection_rejected", "局部场景编辑需要用户确认允许区域，自动矩形不是可信语义蒙版");
    if (!validPixelRectangle(region, size)) throw new ImageProcessingRejection("selection_rejected", "允许编辑区域越界或尺寸无效");
    if (region.width * region.height === size.width * size.height) throw new ImageProcessingRejection("selection_rejected", "整图选区必须使用全局编辑范围");
    if (!semantics.length || semantics.some((value) => typeof value !== "string" || !value.trim())) throw new ImageProcessingRejection("selection_rejected", "允许编辑区域缺少语义");
    const pixels = Buffer.alloc(size.width * size.height * 4, 255);
    for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) pixels[(y * size.width + x) * 4 + 3] = 0;
    return sharp(pixels, { raw: { ...size, channels: 4 } })
        .png()
        .toBuffer();
}

export function validPixelRectangle(region: ImageProcessingRectangle, size: ImageProcessingSize) {
    return [region.x, region.y, region.width, region.height].every(Number.isSafeInteger) && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 && region.width <= size.width - region.x && region.height <= size.height - region.y;
}

export function inside(region: ImageProcessingRectangle, x: number, y: number) {
    return x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
}
