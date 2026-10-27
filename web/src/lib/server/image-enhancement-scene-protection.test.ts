import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { ProductProtectionRectangle } from "./ecommerce-product-regions";
import { compositeSceneEnhancement, type SceneEnhancementProtection } from "./image-enhancement-scene-protection";

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

function rgba(bytes: Buffer) {
    return sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function inside(region: ProductProtectionRectangle, x: number, y: number) {
    return x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
}

async function fixture(region = { x: 3, y: 2, width: 5, height: 3 }, width = 12, height = 8) {
    const original = Buffer.alloc(width * height * 4, 255);
    const enhanced = Buffer.from(original);
    const maskPixels = Buffer.from(original);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            original[offset] = (x * 17 + y * 3) % 251;
            original[offset + 1] = (x * 7 + y * 23) % 251;
            original[offset + 2] = (x * 11 + y * 13 + 1) % 251;
            enhanced[offset] = 255 - original[offset];
            enhanced[offset + 1] = 255 - original[offset + 1];
            enhanced[offset + 2] = 255 - original[offset + 2];
            maskPixels[offset + 3] = inside(region, x, y) ? 0 : 255;
        }
    const baseline = await png(original, width, height);
    const ai = await png(enhanced, width, height);
    const mask = await png(maskPixels, width, height);
    const protection: SceneEnhancementProtection = {
        version: "scene-enhancement.v1",
        normalization: "srgb-upright-v1",
        scene: {
            version: "scene-edit-protection.v1",
            sourceAssetId: "scene-reference-fixture",
            sourceSize: { width, height },
            sourceDigest: digest(Buffer.from("original reference before qualified local edit")),
            maskSize: { width, height },
            maskDigest: digest(mask),
            targetRegion: { ...region },
            semantics: ["add a book in the confirmed region"],
            selectionSource: "user_selection",
            maskSemantics: "alpha_zero_edit",
            method: "source_pixels_copy",
            mask: { id: "scene-mask-fixture", name: "mask.png", type: "image/png", width, height, dataUrl: `data:image/png;base64,${mask.toString("base64")}` },
        },
    };
    return { baseline, ai, mask, protection, original, enhanced, maskPixels };
}

function withMask(protection: SceneEnhancementProtection, mask: Buffer) {
    const value = structuredClone(protection);
    value.scene.mask.dataUrl = `data:image/png;base64,${mask.toString("base64")}`;
    value.scene.maskDigest = digest(mask);
    return value;
}

async function assertPixels(baseline: Buffer, output: Buffer, candidate: Buffer, mask: Buffer) {
    const source = await rgba(baseline);
    const result = await rgba(output);
    const allowed = await rgba(mask);
    const mapped = await sharp(candidate).ensureAlpha().resize(source.info.width, source.info.height, { fit: "fill", withoutEnlargement: true }).raw().toBuffer();
    expect(result.info).toMatchObject({ width: source.info.width, height: source.info.height, channels: 4 });
    for (let offset = 0; offset < source.data.length; offset += 4) {
        const alpha = allowed.data[offset + 3];
        const expected = [...source.data.subarray(offset, offset + 4)];
        for (let channel = 0; channel < 3; channel++) expected[channel] = Math.round((source.data[offset + channel] * alpha + mapped[offset + channel] * (255 - alpha)) / 255);
        expect([...result.data.subarray(offset, offset + 4)]).toEqual(expected);
    }
}

describe("scene enhancement protection", () => {
    it.each([
        { x: 3, y: 2, width: 5, height: 3 },
        { x: 0, y: 5, width: 4, height: 3 },
    ])("confines complete-context AI changes to the frozen region $x,$y", async (region) => {
        const { baseline, ai, protection, mask } = await fixture(region);
        const sourceBefore = Buffer.from(baseline);
        const aiBefore = Buffer.from(ai);
        const descriptorBefore = structuredClone(protection);
        const result = await compositeSceneEnhancement(baseline, ai, protection, maxPixels);
        await assertPixels(baseline, result.bytes, ai, mask);
        expect(result.evidence).toEqual({
            version: "scene-enhancement.v1",
            normalization: "srgb-upright-v1",
            sourceAssetId: protection.scene.sourceAssetId,
            sourceSha256: digest(baseline),
            maskSha256: digest(mask),
            aiSha256: digest(ai),
            compositeSha256: digest(result.bytes),
            sourceSize: { width: 12, height: 8 },
            aiSize: { width: 12, height: 8 },
            allowedPixels: region.width * region.height,
            protectedPixels: 96 - region.width * region.height,
            protectedChangedPixels: 0,
            mapping: { context: { x: 0, y: 0, width: 12, height: 8 }, targetRegion: region },
        });
        expect(await sharp(result.bytes).metadata()).toMatchObject({ format: "png", width: 12, height: 8 });
        expect(baseline).toEqual(sourceBefore);
        expect(ai).toEqual(aiBefore);
        expect(protection).toEqual(descriptorBefore);
    });

    it("blends alpha 0/128/255 as edit/soft/protect without expanding the allowed support", async () => {
        const input = await fixture({ x: 2, y: 1, width: 3, height: 1 });
        input.maskPixels[(1 * 12 + 3) * 4 + 3] = 128;
        input.maskPixels[(1 * 12 + 4) * 4 + 3] = 255;
        const mask = await png(input.maskPixels, 12, 8);
        const result = await compositeSceneEnhancement(input.baseline, input.ai, withMask(input.protection, mask), maxPixels);
        await assertPixels(input.baseline, result.bytes, input.ai, mask);
        expect(result.evidence).toMatchObject({ allowedPixels: 2, protectedPixels: 94, protectedChangedPixels: 0 });
    });

    it("maps a four-times AI candidate to the complete source frame before applying E", async () => {
        const { baseline, ai, protection, mask } = await fixture();
        const candidate = await sharp(ai).resize(48, 32, { kernel: "nearest" }).png().toBuffer();
        const result = await compositeSceneEnhancement(baseline, candidate, protection, maxPixels);
        await assertPixels(baseline, result.bytes, candidate, mask);
        expect(result.evidence).toMatchObject({ sourceSize: { width: 12, height: 8 }, aiSize: { width: 48, height: 32 }, mapping: { context: { x: 0, y: 0, width: 12, height: 8 }, targetRegion: protection.scene.targetRegion } });
    });

    it("rebuilds identical bytes from saved inputs and records baseline, AI and mask digests independently", async () => {
        const { baseline, ai, protection, mask } = await fixture();
        expect(protection.scene.sourceDigest).not.toBe(digest(baseline));
        const result = await compositeSceneEnhancement(baseline, ai, protection, maxPixels);
        expect(await compositeSceneEnhancement(Buffer.from(baseline), Buffer.from(ai), structuredClone(protection), maxPixels)).toEqual(result);
        expect(new Set([result.evidence.sourceSha256, result.evidence.aiSha256, result.evidence.maskSha256]).size).toBe(3);
        expect(result.evidence.sourceSha256).toBe(digest(baseline));
        expect(result.evidence.aiSha256).toBe(digest(ai));
        expect(result.evidence.maskSha256).toBe(digest(mask));
    });

    it("keeps a 4096x3072 baseline at its actual frame size", async () => {
        const width = 4096;
        const height = 3072;
        const { baseline, ai, protection } = await fixture({ x: 100, y: 200, width: 3, height: 2 }, width, height);
        const result = await compositeSceneEnhancement(baseline, ai, protection, width * height);
        expect(await sharp(result.bytes).metadata()).toMatchObject({ width, height });
        const pixels = await rgba(result.bytes);
        const original = await rgba(baseline);
        expect(pixels.data.subarray(0, 4)).toEqual(original.data.subarray(0, 4));
        expect(pixels.data.subarray(-4)).toEqual(original.data.subarray(-4));
        expect(result.evidence).toMatchObject({ sourceSize: { width, height }, aiSize: { width, height }, allowedPixels: 6, protectedPixels: width * height - 6, protectedChangedPixels: 0 });
    }, 30_000);

    it.each<[string, (value: SceneEnhancementProtection) => void]>([
        [
            "enhancement version",
            (v) => {
                (v as { version: string }).version = "other";
            },
        ],
        [
            "normalization",
            (v) => {
                (v as { normalization: string }).normalization = "none";
            },
        ],
        [
            "scene version",
            (v) => {
                (v.scene as { version: string }).version = "other";
            },
        ],
        [
            "selection source",
            (v) => {
                (v.scene as { selectionSource: string }).selectionSource = "analysis_hint";
            },
        ],
        [
            "mask semantics",
            (v) => {
                (v.scene as { maskSemantics: string }).maskSemantics = "white_edit";
            },
        ],
        [
            "method",
            (v) => {
                (v.scene as { method: string }).method = "regenerate";
            },
        ],
        [
            "source asset",
            (v) => {
                v.scene.sourceAssetId = " ";
            },
        ],
        [
            "source digest",
            (v) => {
                v.scene.sourceDigest = "not-a-sha256";
            },
        ],
        [
            "missing semantics",
            (v) => {
                v.scene.semantics = [];
            },
        ],
        [
            "blank semantics",
            (v) => {
                v.scene.semantics = [" "];
            },
        ],
        [
            "source width",
            (v) => {
                v.scene.sourceSize.width = 0;
            },
        ],
        [
            "source height",
            (v) => {
                v.scene.sourceSize.height = 8.5;
            },
        ],
        [
            "unsafe source",
            (v) => {
                v.scene.sourceSize.width = Number.MAX_SAFE_INTEGER + 1;
            },
        ],
        [
            "mask size",
            (v) => {
                v.scene.maskSize.width = 11;
            },
        ],
        [
            "mask descriptor",
            (v) => {
                v.scene.mask.height = 7;
            },
        ],
        [
            "negative region",
            (v) => {
                v.scene.targetRegion.x = -1;
            },
        ],
        [
            "fractional region",
            (v) => {
                v.scene.targetRegion.y = 1.5;
            },
        ],
        [
            "empty region",
            (v) => {
                v.scene.targetRegion.width = 0;
            },
        ],
        [
            "unsafe region",
            (v) => {
                v.scene.targetRegion.height = Number.MAX_SAFE_INTEGER + 1;
            },
        ],
        [
            "overflow region",
            (v) => {
                v.scene.targetRegion.x = 12;
            },
        ],
        [
            "whole frame region",
            (v) => {
                v.scene.targetRegion = { x: 0, y: 0, width: 12, height: 8 };
            },
        ],
    ])("rejects invalid frozen %s", async (_label, mutate) => {
        const { baseline, ai, protection } = await fixture();
        mutate(protection);
        await expect(compositeSceneEnhancement(baseline, ai, protection, maxPixels)).rejects.toThrow();
    });

    it.each(["serverUrl", "url", "remoteUrl"] as const)("rejects mask %s aliases even alongside a valid inline PNG", async (key) => {
        const { baseline, ai, protection } = await fixture();
        protection.scene.mask[key] = "/api/fixture-mask";
        await expect(compositeSceneEnhancement(baseline, ai, protection, maxPixels)).rejects.toThrow(/mask.*inline|mask.*URL|mask.*alias/i);
    });

    it("rejects noncanonical data URLs, forged mask digests, non-PNG and incomplete mask decoding", async () => {
        const { baseline, ai, protection, mask } = await fixture();
        const cases: SceneEnhancementProtection[] = [
            { ...protection, scene: { ...protection.scene, maskDigest: "0".repeat(64) } },
            { ...protection, scene: { ...protection.scene, mask: { ...protection.scene.mask, dataUrl: protection.scene.mask.dataUrl + "\n" } } },
            { ...protection, scene: { ...protection.scene, mask: { ...protection.scene.mask, dataUrl: "data:image/png;base64,@@@@" } } },
            { ...protection, scene: { ...protection.scene, mask: { ...protection.scene.mask, dataUrl: "data:image/png;base64," } } },
            { ...protection, scene: { ...protection.scene, mask: { ...protection.scene.mask, dataUrl: protection.scene.mask.dataUrl!.replace("image/png", "image/jpeg") } } },
            withMask(protection, await sharp(mask).flatten().jpeg().toBuffer()),
            withMask(protection, mask.subarray(0, Math.floor(mask.length * 0.7))),
        ];
        for (const invalid of cases) await expect(compositeSceneEnhancement(baseline, ai, invalid, maxPixels)).rejects.toThrow(/mask/i);
    });

    it("rejects constant, reversed and out-of-region masks instead of clipping E", async () => {
        const { baseline, ai, protection, maskPixels } = await fixture();
        const masks = [Buffer.from(maskPixels), Buffer.from(maskPixels), Buffer.from(maskPixels), Buffer.from(maskPixels)];
        for (let offset = 3; offset < maskPixels.length; offset += 4) {
            masks[0][offset] = 255;
            masks[1][offset] = 0;
            masks[2][offset] = 255 - maskPixels[offset];
        }
        masks[3][3] = 254;
        for (const pixels of masks) await expect(compositeSceneEnhancement(baseline, ai, withMask(protection, await png(pixels, 12, 8)), maxPixels)).rejects.toThrow(/mask|allowed|protected|region/i);
    });

    it("rejects actual baseline/mask dimensions or mask orientation that differ from frozen coordinates", async () => {
        const { baseline, ai, protection, mask } = await fixture();
        await expect(compositeSceneEnhancement(await sharp(baseline).resize(6, 4).png().toBuffer(), ai, protection, maxPixels)).rejects.toThrow(/baseline|source|dimension/i);
        for (const invalid of [await sharp(mask).resize(6, 4).png().toBuffer(), await sharp(mask).withMetadata({ orientation: 6 }).png().toBuffer()])
            await expect(compositeSceneEnhancement(baseline, ai, withMask(protection, invalid), maxPixels)).rejects.toThrow(/mask.*dimension|mask.*orientation/i);
    });

    it("rejects APNG baseline, mask and candidate even if only a first frame could be decoded", async () => {
        const { baseline, ai, protection } = await fixture({ x: 2, y: 1, width: 3, height: 2 }, 16, 16);
        await expect(compositeSceneEnhancement(animatedPng, ai, protection, maxPixels)).rejects.toThrow(/single|frame|PNG/i);
        await expect(compositeSceneEnhancement(baseline, animatedPng, protection, maxPixels)).rejects.toThrow(/single|frame|PNG/i);
        await expect(compositeSceneEnhancement(baseline, ai, withMask(protection, animatedPng), maxPixels)).rejects.toThrow(/single|frame|PNG/i);
    });

    it.each(["baseline", "candidate"] as const)("rejects non-PNG, truncated, rotated and transparent %s", async (role) => {
        const { baseline, ai, protection } = await fixture();
        const bytes = role === "baseline" ? baseline : ai;
        const pixels = (await rgba(bytes)).data;
        pixels[3] = 254;
        const invalidImages = [await sharp(bytes).jpeg().toBuffer(), bytes.subarray(0, Math.floor(bytes.length * 0.7)), await sharp(bytes).withMetadata({ orientation: 6 }).png().toBuffer(), await png(pixels, 12, 8)];
        for (const invalid of invalidImages) await expect(compositeSceneEnhancement(role === "baseline" ? invalid : baseline, role === "candidate" ? invalid : ai, protection, maxPixels)).rejects.toThrow(/PNG|decode|orientation|opaque/i);
    });

    it.each(["baseline", "candidate"] as const)("rejects noncanonical ICC-bearing %s rather than changing its canonical colour space", async (role) => {
        const { baseline, ai, protection } = await fixture();
        const profiled = await sharp(role === "baseline" ? baseline : ai)
            .withIccProfile("p3")
            .png()
            .toBuffer();
        expect((await sharp(profiled).metadata()).hasProfile).toBe(true);
        await expect(compositeSceneEnhancement(role === "baseline" ? profiled : baseline, role === "candidate" ? profiled : ai, protection, maxPixels)).rejects.toThrow(/srgb|profile|colour/i);
    });

    it("rejects smaller or distorted AI candidates without upscale or crop repair", async () => {
        const { baseline, ai, protection } = await fixture();
        for (const invalid of [await sharp(ai).resize(6, 4).png().toBuffer(), await sharp(ai).resize(13, 8, { fit: "fill" }).png().toBuffer()])
            await expect(compositeSceneEnhancement(baseline, invalid, protection, maxPixels)).rejects.toThrow(/candidate.*source size|candidate.*aspect ratio/i);
    });

    it("enforces the supplied safe pixel budget through complete baseline, mask and candidate decoding", async () => {
        const { baseline, ai, protection } = await fixture();
        for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 95]) await expect(compositeSceneEnhancement(baseline, ai, protection, limit)).rejects.toThrow(/pixel limit/i);
        await expect(compositeSceneEnhancement(baseline, await sharp(ai).resize(48, 32).png().toBuffer(), protection, 96)).rejects.toThrow(/pixel limit/i);
        await expect(compositeSceneEnhancement(baseline, ai, protection, 96)).resolves.toMatchObject({ evidence: { protectedChangedPixels: 0 } });
    });
});
