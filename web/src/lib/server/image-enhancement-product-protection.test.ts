import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { ProductProtectionSnapshot } from "./ecommerce-product-regions";
import { compositeProductEnhancement, type ProductEnhancementProtection } from "./image-enhancement-product-protection";

const maxPixels = 4096;
// Pillow's fixed 16x16, two-frame fixture: Tests/images/apng/different_durations.png.
const animatedPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAQAAAAEAAAAAAAAAAAQAAQAAAADPA+sAAAACdJREFUeJxjyNpn8J8SzAAi7heqgTHFBpCDqWMAJYaMGjBqwDAxAAAB126PJW/SAQAAABpmY1RMAAAAAQAAABAAAAAQAAAAAAAAAABAAEAAAABcjtvGAAAAHWZkQVQAAAACeJxjMJ+S958SzDBqwKgBowYMFwMA7pA4H/+0mG8AAAAASUVORK5CYII=",
    "base64",
);

function digest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}

function png(data: Buffer, width: number, height: number) {
    return sharp(data, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
}

function normalized(bytes: Buffer) {
    return sharp(bytes).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function fixture(sourceBytes?: Buffer) {
    const original = Buffer.alloc(12 * 8 * 4, 255);
    for (let y = 0; y < 8; y++)
        for (let x = 0; x < 12; x++) {
            const offset = (y * 12 + x) * 4;
            const ink = x >= 4 && x < 8 && y >= 2 && y < 6 && (x + y) % 2 === 0;
            original[offset] = ink ? 5 : 197;
            original[offset + 1] = ink ? 7 : 69;
            original[offset + 2] = ink ? 11 : 42;
        }
    const source = sourceBytes ?? (await png(original, 12, 8));
    const sourcePixels = await normalized(source);
    const { width, height } = sourcePixels.info;
    const maskPixels = Buffer.alloc(width * height * 4, 255);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) maskPixels[(y * width + x) * 4 + 3] = 0;
    const mask = await png(maskPixels, width, height);
    const ai = await sharp({ create: { width: width * 4, height: height * 4, channels: 3, background: "#2385e9" } })
        .png()
        .toBuffer();
    const product: ProductProtectionSnapshot = {
        compilerVersion: "strict-product.v1",
        state: "ready",
        productAnchorId: "product-colour-and-logo",
        sourceAssetId: "qualified-scene-native",
        sourceSize: { width, height },
        productCore: [{ x: Math.floor(width / 3), y: Math.floor(height / 3), width: Math.floor(width / 3), height: Math.floor(height / 3) }],
        fusionHalo: [],
        editableBackground: [],
    };
    const protection: ProductEnhancementProtection = { version: "product-enhancement.v2", normalization: "srgb-upright-v1", product, maskDataUrl: `data:image/png;base64,${mask.toString("base64")}`, maskSha256: digest(mask) };
    return { source, ai, protection, mask, maskPixels, sourcePixels };
}

function withMask(protection: ProductEnhancementProtection, mask: Buffer) {
    return { ...protection, maskDataUrl: `data:image/png;base64,${mask.toString("base64")}`, maskSha256: digest(mask) };
}

async function assertProtectedPixels(source: Buffer, output: Buffer, mask: Buffer, product: ProductProtectionSnapshot) {
    const original = await normalized(source);
    const persisted = await normalized(output);
    const allowed = await normalized(mask);
    expect(persisted.info).toMatchObject({ width: original.info.width, height: original.info.height, channels: 4 });
    for (let y = 0; y < original.info.height; y++)
        for (let x = 0; x < original.info.width; x++) {
            const offset = (y * original.info.width + x) * 4;
            const core = product.productCore.some((region) => x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height);
            if (core || allowed.data[offset + 3] === 255) expect(persisted.data.subarray(offset, offset + 4)).toEqual(original.data.subarray(offset, offset + 4));
        }
}

describe("product enhancement protection", () => {
    it.each([1, 6])("preserves the JPEG provider native identity with orientation %s while composing the protected PNG baseline", async (orientation) => {
        const { source, protection, mask } = await fixture();
        const native = await sharp({ create: { width: orientation === 6 ? 8 : 12, height: orientation === 6 ? 12 : 8, channels: 3, background: "#2385e9" } })
            .jpeg()
            .withMetadata({ orientation })
            .toBuffer();
        const result = await compositeProductEnhancement(source, native, protection, maxPixels, "native");
        expect(result.evidence).toMatchObject({ aiSha256: digest(native), aiSize: { width: 12, height: 8 }, protectedChangedPixels: 0 });
        await assertProtectedPixels(source, result.bytes, mask, protection.product);
        expect(await sharp(result.bytes).metadata()).toMatchObject({ format: "png", width: 12, height: 8 });
        await expect(compositeProductEnhancement(source, native, protection, maxPixels)).rejects.toThrow(/single-frame PNG/);
    });
    it("keeps every product colour/logo and protected RGBA pixel while changing the allowed background", async () => {
        const { source, ai, protection, mask } = await fixture();
        const sourceBefore = Buffer.from(source);
        const aiBefore = Buffer.from(ai);
        const descriptorBefore = structuredClone(protection);
        const result = await compositeProductEnhancement(source, ai, protection, maxPixels);
        await assertProtectedPixels(source, result.bytes, mask, protection.product);
        const output = await normalized(result.bytes);
        expect([...output.data.subarray(0, 4)]).toEqual([35, 133, 233, 255]);
        expect(await sharp(result.bytes).metadata()).toMatchObject({ format: "png", width: 12, height: 8 });
        expect(result.evidence).toEqual({
            version: "product-enhancement.v2",
            normalization: "srgb-upright-v1",
            productAnchorId: protection.product.productAnchorId,
            sourceAssetId: protection.product.sourceAssetId,
            sourceSha256: digest(source),
            maskSha256: digest(mask),
            aiSha256: digest(ai),
            compositeSha256: digest(result.bytes),
            sourceSize: { width: 12, height: 8 },
            aiSize: { width: 48, height: 32 },
            allowedPixels: 6,
            protectedPixels: 90,
            protectedChangedPixels: 0,
        });
        expect(source).toEqual(sourceBefore);
        expect(ai).toEqual(aiBefore);
        expect(protection).toEqual(descriptorBefore);
    });

    it("rebuilds the same lossless bytes independently from the frozen inputs", async () => {
        const { source, ai, protection, maskPixels, sourcePixels } = await fixture();
        const { width, height } = sourcePixels.info;
        const candidate = await sharp(ai).rotate().toColourspace("srgb").ensureAlpha().resize(width, height).raw().toBuffer();
        const rebuilt = Buffer.from(sourcePixels.data);
        for (let offset = 0; offset < rebuilt.length; offset += 4)
            for (let channel = 0; channel < 3; channel++) {
                const alpha = maskPixels[offset + 3];
                rebuilt[offset + channel] = Math.round((sourcePixels.data[offset + channel] * alpha + candidate[offset + channel] * (255 - alpha)) / 255);
            }
        const result = await compositeProductEnhancement(source, ai, protection, maxPixels);
        expect(result.bytes).toEqual(await png(rebuilt, width, height));
        const replay = await compositeProductEnhancement(Buffer.from(source), Buffer.from(ai), structuredClone(protection), maxPixels);
        expect(replay).toEqual(result);
    });

    it("allows same-size native candidates and blends soft edges with source alpha preserved", async () => {
        const { source, ai, protection, maskPixels } = await fixture();
        maskPixels[3] = 128;
        const mask = await png(maskPixels, 12, 8);
        const native = await sharp(ai).resize(12, 8).png().toBuffer();
        const result = await compositeProductEnhancement(source, native, withMask(protection, mask), maxPixels);
        const output = await normalized(result.bytes);
        expect([...output.data.subarray(0, 4)]).toEqual([116, 101, 137, 255]);
        expect(result.evidence.aiSize).toEqual({ width: 12, height: 8 });
        await assertProtectedPixels(source, result.bytes, mask, protection.product);
    });

    it.each([0, 254])("rejects alpha %i in a product core instead of silently shrinking E", async (alpha) => {
        const { source, ai, protection, maskPixels } = await fixture();
        const core = protection.product.productCore[0];
        maskPixels[(core.y * 12 + core.x) * 4 + 3] = alpha;
        await expect(compositeProductEnhancement(source, ai, withMask(protection, await png(maskPixels, 12, 8)), maxPixels)).rejects.toThrow(/mask.*product core/i);
    });

    it.each([0, 255])("rejects a globally constant mask with alpha %i", async (alpha) => {
        const { source, ai, protection, maskPixels } = await fixture();
        for (let offset = 3; offset < maskPixels.length; offset += 4) maskPixels[offset] = alpha;
        await expect(compositeProductEnhancement(source, ai, withMask(protection, await png(maskPixels, 12, 8)), maxPixels)).rejects.toThrow(alpha === 0 ? /mask.*product core/i : /mask.*no allowed pixels/i);
    });

    it("rejects forged mask digests, malformed data URLs, real non-PNGs and incomplete PNG decoding", async () => {
        const { source, ai, protection, mask } = await fixture();
        const jpeg = await sharp(mask).flatten().jpeg().toBuffer();
        const truncated = mask.subarray(0, Math.floor(mask.length * 0.7));
        const cases: [ProductEnhancementProtection, RegExp][] = [
            [{ ...protection, maskSha256: "0".repeat(64) }, /mask.*digest/i],
            [{ ...protection, maskDataUrl: protection.maskDataUrl + "\n" }, /mask.*strict PNG data URL/i],
            [{ ...protection, maskDataUrl: protection.maskDataUrl.replace("image/png", "image/jpeg") }, /mask.*strict PNG data URL/i],
            [{ ...protection, maskDataUrl: "data:image/png;base64,@@@@" }, /mask.*strict PNG data URL/i],
            [withMask(protection, jpeg), /mask.*single-frame PNG/i],
            [withMask(protection, truncated), /mask.*decode/i],
        ];
        for (const [invalid, reason] of cases) await expect(compositeProductEnhancement(source, ai, invalid, maxPixels)).rejects.toThrow(reason);
    });

    it("rejects actual mask dimensions and display orientation that disagree with the frozen coordinate space", async () => {
        const { source, ai, protection, mask } = await fixture();
        const cases: [Buffer, RegExp][] = [
            [await sharp(mask).resize(6, 4).png().toBuffer(), /mask.*dimensions/i],
            [await sharp(mask).withMetadata({ orientation: 6 }).png().toBuffer(), /mask.*orientation/i],
        ];
        for (const [invalid, reason] of cases) await expect(compositeProductEnhancement(source, ai, withMask(protection, invalid), maxPixels)).rejects.toThrow(reason);
        const wrongSource = await sharp(source).resize(6, 4).png().toBuffer();
        await expect(compositeProductEnhancement(wrongSource, ai, protection, maxPixels)).rejects.toThrow(/source.*dimensions/i);
    });

    it("rejects a fixed multi-frame PNG mask and candidate even if the decoder exposes only its first frame", async () => {
        const source = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        const input = await fixture(source);
        await expect(compositeProductEnhancement(source, input.ai, withMask(input.protection, animatedPng), maxPixels)).rejects.toThrow(/single|frame|page|动画|多页|单帧/i);
        await expect(compositeProductEnhancement(source, animatedPng, input.protection, maxPixels)).rejects.toThrow(/single|frame|page|动画|多页|单帧/i);
    });

    it("rejects candidate distortion, undersizing, corrupt encoding, non-PNGs, orientation and transparency", async () => {
        const { source, ai, protection } = await fixture();
        const candidates: [Buffer, RegExp][] = [
            [await sharp(ai).resize(49, 32, { fit: "fill" }).png().toBuffer(), /candidate.*aspect ratio/i],
            [await sharp(ai).resize(6, 4).png().toBuffer(), /candidate.*source size/i],
            [ai.subarray(0, Math.floor(ai.length * 0.7)), /candidate.*decode/i],
            [await sharp(ai).jpeg().toBuffer(), /candidate.*single-frame PNG/i],
            [await sharp(ai).withMetadata({ orientation: 6 }).png().toBuffer(), /candidate.*orientation/i],
            [
                await sharp({ create: { width: 48, height: 32, channels: 4, background: { r: 35, g: 133, b: 233, alpha: 0.5 } } })
                    .png()
                    .toBuffer(),
                /candidate.*opaque/i,
            ],
        ];
        for (const [invalid, reason] of candidates) await expect(compositeProductEnhancement(source, invalid, protection, maxPixels)).rejects.toThrow(reason);
    });

    it("rejects a transparent source", async () => {
        const { source, ai, protection } = await fixture();
        const pixels = (await normalized(source)).data;
        pixels[3] = 254;
        await expect(compositeProductEnhancement(await png(pixels, 12, 8), ai, protection, maxPixels)).rejects.toThrow(/source.*opaque/i);
    });

    it("uses EXIF6 display coordinates and measures the actual original bytes", async () => {
        const base = await fixture();
        const oriented = await sharp(base.source).withMetadata({ orientation: 6 }).png().toBuffer();
        const { source, ai, protection, mask } = await fixture(oriented);
        expect(await sharp(source).metadata()).toMatchObject({ width: 12, height: 8, orientation: 6 });
        const result = await compositeProductEnhancement(source, ai, protection, maxPixels);
        expect(result.evidence.sourceSize).toEqual({ width: 8, height: 12 });
        expect(result.evidence.sourceSha256).toBe(digest(oriented));
        expect((await sharp(result.bytes).metadata()).orientation).toBeUndefined();
        await assertProtectedPixels(source, result.bytes, mask, protection.product);
    });

    it("freezes protected ICC colours in the sRGB baseline before encoding", async () => {
        const base = await fixture();
        const profiled = await sharp(base.source).withIccProfile("p3").png().toBuffer();
        expect((await sharp(profiled).metadata()).hasProfile).toBe(true);
        const { source, ai, protection, mask } = await fixture(profiled);
        const result = await compositeProductEnhancement(source, ai, protection, maxPixels);
        await assertProtectedPixels(source, result.bytes, mask, protection.product);
        expect(result.evidence.sourceSha256).toBe(digest(profiled));
    });

    it("rejects invalid descriptor versions, identities, dimensions and product rectangles", async () => {
        const { source, ai, protection } = await fixture();
        const mutations: ((value: ProductEnhancementProtection) => void)[] = [
            (v) => {
                (v as { version: string }).version = "other";
            },
            (v) => {
                (v as { normalization: string }).normalization = "none";
            },
            (v) => {
                (v.product as { compilerVersion: string }).compilerVersion = "other";
            },
            (v) => {
                v.product.state = "needs_review";
            },
            (v) => {
                v.product.productAnchorId = " ";
            },
            (v) => {
                v.product.sourceAssetId = "";
            },
            (v) => {
                v.product.sourceSize.width = 0;
            },
            (v) => {
                v.product.sourceSize.height = 8.5;
            },
            (v) => {
                v.product.sourceSize.width = Number.MAX_SAFE_INTEGER + 1;
            },
            (v) => {
                v.product.productCore = [];
            },
            (v) => {
                v.product.productCore[0].x = -1;
            },
            (v) => {
                v.product.productCore[0].y = 0.5;
            },
            (v) => {
                v.product.productCore[0].width = 0;
            },
            (v) => {
                v.product.productCore[0].height = Number.MAX_SAFE_INTEGER + 1;
            },
            (v) => {
                v.product.productCore[0].x = 12;
            },
        ];
        for (const mutate of mutations) {
            const invalid = structuredClone(protection);
            mutate(invalid);
            await expect(compositeProductEnhancement(source, ai, invalid, maxPixels)).rejects.toThrow(/protection|product|rectangle|dimension|anchor|asset/i);
        }
    });

    it("uses the supplied positive safe pixel limit for source, mask and AI decoding", async () => {
        const { source, ai, protection } = await fixture();
        for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 95, 96]) await expect(compositeProductEnhancement(source, ai, protection, limit)).rejects.toThrow(/pixel limit/i);
        const native = await sharp(ai).resize(12, 8).png().toBuffer();
        await expect(compositeProductEnhancement(source, native, protection, 96)).resolves.toMatchObject({ evidence: { protectedChangedPixels: 0 } });
    });
});
