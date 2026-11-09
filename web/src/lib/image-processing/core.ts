const WHITE_BACKGROUND_MIN_CHANNEL = 240;
const TRANSPARENT_BACKGROUND_MAX_ALPHA = 24;
const MIN_BORDER_BACKGROUND_RATIO = 0.9;
const MIN_SUBJECT_PIXELS = 16;
const SECOND_SUBJECT_RATIO = 0.05;

export class EcommerceProductSegmentationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EcommerceProductSegmentationError";
    }
}

type Component = { seed: number; area: number; bounds: { x: number; y: number; width: number; height: number } };

// The caller owns these decoded RGBA bytes; replace them with the mask to avoid a second full-size RGBA buffer.
export function buildWhiteBackgroundProductMaskPixels(data: Uint8Array, width: number, height: number, transparent: boolean, sourceFraming?: "visible_extent") {
    const pixels = width * height;
    const state = new Uint8Array(pixels);
    const queue = new Uint32Array(pixels);
    let queued = 0;
    let borderPixels = 0;
    let backgroundBorderPixels = 0;
    let subjectBorderPixels = 0;

    const backgroundCandidate = (index: number) => {
        const offset = index * 4;
        if (data[offset + 3] <= TRANSPARENT_BACKGROUND_MAX_ALPHA) return true;
        if (transparent) return false;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        return Math.min(red, green, blue) >= WHITE_BACKGROUND_MIN_CHANNEL && Math.max(red, green, blue) - Math.min(red, green, blue) <= 10;
    };
    const visitBorder = (index: number) => {
        borderPixels += 1;
        if (!backgroundCandidate(index)) return;
        backgroundBorderPixels += 1;
        state[index] = 1;
        queue[queued++] = index;
    };
    for (let x = 0; x < width; x += 1) visitBorder(x);
    if (height > 1) for (let x = 0; x < width; x += 1) visitBorder((height - 1) * width + x);
    for (let y = 1; y < height - 1; y += 1) {
        visitBorder(y * width);
        if (width > 1) visitBorder(y * width + width - 1);
    }
    const borderRatio = backgroundBorderPixels / borderPixels;
    if (borderRatio < 0.1) throw new EcommerceProductSegmentationError("商品图边界不是可信白色或透明背景");

    const appendBackground = (index: number) => {
        if (state[index] || !backgroundCandidate(index)) return;
        state[index] = 1;
        queue[queued++] = index;
    };
    for (let cursor = 0; cursor < queued; cursor += 1) {
        const index = queue[cursor];
        const x = index % width;
        if (x > 0) appendBackground(index - 1);
        if (x + 1 < width) appendBackground(index + 1);
        if (index >= width) appendBackground(index - width);
        if (index + width < pixels) appendBackground(index + width);
    }

    const visitComponent = (seed: number, from: number, to: number): Component => {
        let length = 1;
        queue[0] = seed;
        state[seed] = to;
        let left = width;
        let top = height;
        let right = -1;
        let bottom = -1;
        const append = (index: number) => {
            if (state[index] !== from || data[index * 4 + 3] <= TRANSPARENT_BACKGROUND_MAX_ALPHA) return;
            state[index] = to;
            queue[length++] = index;
        };
        for (let cursor = 0; cursor < length; cursor += 1) {
            const index = queue[cursor];
            const x = index % width;
            const y = Math.floor(index / width);
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
            if (to === 3 && (x === 0 || x === width - 1 || y === 0 || y === height - 1)) subjectBorderPixels += 1;
            if (x > 0) append(index - 1);
            if (x + 1 < width) append(index + 1);
            if (index >= width) append(index - width);
            if (index + width < pixels) append(index + width);
        }
        return { seed, area: length, bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } };
    };

    const minimumArea = Math.max(MIN_SUBJECT_PIXELS, Math.ceil(pixels * 0.005));
    let largest: Component | undefined;
    let secondLargestArea = 0;
    for (let start = 0; start < pixels; start += 1) {
        if (state[start] || data[start * 4 + 3] <= TRANSPARENT_BACKGROUND_MAX_ALPHA) continue;
        const component = visitComponent(start, 0, 2);
        if (component.area < minimumArea) continue;
        if (!largest) largest = component;
        else if (component.area > largest.area) {
            secondLargestArea = largest.area;
            largest = component;
        } else secondLargestArea = Math.max(secondLargestArea, component.area);
    }
    if (!largest) throw new EcommerceProductSegmentationError("没有检测到商品主体");
    if (secondLargestArea >= largest.area * SECOND_SUBJECT_RATIO) throw new EcommerceProductSegmentationError("检测到多个独立主体，需要人工复核");
    const bounds = largest.bounds;
    if (sourceFraming !== "visible_extent" && (bounds.x === 0 || bounds.y === 0 || bounds.x + bounds.width === width || bounds.y + bounds.height === height)) {
        throw new EcommerceProductSegmentationError("商品主体接触图片边缘，无法生成可信保护蒙版");
    }
    visitComponent(largest.seed, 2, 3);
    // A confirmed detail can meet the frame; only its selected subject is excluded from the background boundary.
    const backgroundBorder = sourceFraming === "visible_extent" ? borderPixels - subjectBorderPixels : borderPixels;
    if (backgroundBorderPixels / backgroundBorder < MIN_BORDER_BACKGROUND_RATIO) throw new EcommerceProductSegmentationError("商品图边界不是可信白色或透明背景");
    data.fill(255);
    for (let index = 0; index < pixels; index += 1) data[index * 4 + 3] = state[index] === 3 ? 255 : 0;
    return bounds;
}
