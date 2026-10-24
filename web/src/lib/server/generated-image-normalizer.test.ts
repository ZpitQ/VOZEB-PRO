import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { normalizeGeneratedImageBytes } from "./generated-image-normalizer";

describe("generated image normalization", () => {
    it("preserves the upstream bytes when both displayed edges are below the request", async () => {
        const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#7c8da5" } })
            .png()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/png", "1824x1024");

        expect(result).toMatchObject({ mimeType: "image/png", width: 1600, height: 900 });
        expect(result.bytes).toEqual(source);
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "png", width: 1600, height: 900 });
    });

    it("preserves a single insufficient edge even when the source area exceeds the target area", async () => {
        const source = await sharp({ create: { width: 6000, height: 3000, channels: 3, background: "#7c8da5" } })
            .png()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/png", "4096x4096");

        expect(6000 * 3000).toBeGreaterThan(4096 * 4096);
        expect(result).toMatchObject({ mimeType: "image/png", width: 6000, height: 3000 });
        expect(result.bytes).toEqual(source);
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ width: 6000, height: 3000 });
    });

    it("restores a provider-safe image to a small exact requested size", async () => {
        const source = await sharp({ create: { width: 672, height: 1008, channels: 3, background: "#9a6b4f" } })
            .png()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/png", "400x600");

        expect(result).toMatchObject({ mimeType: "image/png", width: 400, height: 600 });
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "png", width: 400, height: 600 });
    });

    it("shrinks a larger image inside a different target ratio without cropping its edges", async () => {
        const leftEdge = await sharp({ create: { width: 160, height: 1152, channels: 3, background: "red" } })
            .png()
            .toBuffer();
        const rightEdge = await sharp({ create: { width: 160, height: 1152, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        const source = await sharp({ create: { width: 2048, height: 1152, channels: 3, background: "#203040" } })
            .composite([
                { input: leftEdge, left: 0, top: 0 },
                { input: rightEdge, left: 1888, top: 0 },
            ])
            .png()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/png", "768x512");

        expect(result).toMatchObject({ mimeType: "image/png", width: 768, height: 432 });
        const { data, info } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
        expect(info).toMatchObject({ width: 768, height: 432 });
        const pixel = (x: number) => Array.from(data.subarray((216 * info.width + x) * info.channels, (216 * info.width + x) * info.channels + 3));
        expect(pixel(0)).toEqual([255, 0, 0]);
        expect(pixel(767)).toEqual([0, 0, 255]);
    });

    it("keeps full chroma detail when resizing a generated JPEG", async () => {
        const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#9a6b4f" } })
            .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/jpeg", "1280x720");

        expect(result).toMatchObject({ mimeType: "image/jpeg", width: 1280, height: 720 });
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "jpeg", width: 1280, height: 720, chromaSubsampling: "4:4:4" });
    });

    it.each([undefined, "16:9"])("keeps the upstream file unchanged when no exact target is configured (%s)", async (targetSize) => {
        const source = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#506070" } })
            .jpeg({ quality: 92 })
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/jpeg", targetSize);

        expect(result).toMatchObject({ mimeType: "image/jpeg", width: 1280, height: 720 });
        expect(result.bytes).toEqual(source);
    });

    it("preserves the actual native file for a 4K request", async () => {
        const source = await sharp({ create: { width: 1254, height: 1254, channels: 3, background: "#203040" } })
            .webp()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/webp", "4096x4096");

        expect(result).toMatchObject({ mimeType: "image/webp", width: 1254, height: 1254 });
        expect(result.bytes).toEqual(source);
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "webp", width: 1254, height: 1254 });
    });

    it("leaves an exactly sized generated JPEG byte-for-byte unchanged", async () => {
        const source = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#203040" } })
            .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/jpeg", "1280x720");

        expect(result).toMatchObject({ mimeType: "image/jpeg", width: 1280, height: 720 });
        expect(result.bytes).toEqual(source);
    });

    it("uses EXIF display geometry for preservation and applies orientation once when shrinking", async () => {
        const blueHalf = await sharp({ create: { width: 800, height: 900, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "red" } })
            .composite([{ input: blueHalf, left: 800, top: 0 }])
            .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
            .withMetadata({ orientation: 6 })
            .toBuffer();
        const retained = await normalizeGeneratedImageBytes(source, "image/jpeg", "1000x1600");
        expect(retained).toMatchObject({ mimeType: "image/jpeg", width: 900, height: 1600 });
        expect(retained.bytes).toEqual(source);
        await expect(sharp(retained.bytes).metadata()).resolves.toMatchObject({ width: 1600, height: 900, orientation: 6 });

        const shrunk = await normalizeGeneratedImageBytes(source, "image/jpeg", "675x1200");
        expect(shrunk).toMatchObject({ mimeType: "image/jpeg", width: 675, height: 1200 });
        const metadata = await sharp(shrunk.bytes).metadata();
        expect(metadata).toMatchObject({ width: 675, height: 1200, chromaSubsampling: "4:4:4" });
        expect(metadata.orientation).toBeUndefined();
        const { data, info } = await sharp(shrunk.bytes).raw().toBuffer({ resolveWithObject: true });
        const pixel = (y: number) => data.subarray((y * info.width + 300) * info.channels, (y * info.width + 300) * info.channels + 3);
        expect(pixel(100)[0]).toBeGreaterThan(240);
        expect(pixel(100)[2]).toBeLessThan(20);
        expect(pixel(1100)[0]).toBeLessThan(20);
        expect(pixel(1100)[2]).toBeGreaterThan(240);
    });

    it("derives the stored MIME from the supported image bytes instead of a caller fallback", async () => {
        const source = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#203040" } })
            .png()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/jpeg");

        expect(result).toMatchObject({ mimeType: "image/png", width: 20, height: 10 });
        expect(result.bytes).toEqual(source);
    });

    it.each([
        { target: undefined, width: 64, height: 32, unchanged: true },
        { target: "64x32", width: 64, height: 32, unchanged: true },
        { target: "4096x4096", width: 64, height: 32, unchanged: true },
        { target: "32x16", width: 32, height: 16, unchanged: false },
    ])("recognizes AVIF container and codec for target $target", async ({ target, width, height, unchanged }) => {
        const source = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#203040" } })
            .avif()
            .toBuffer();
        await expect(sharp(source).metadata()).resolves.toMatchObject({ format: "heif", compression: "av1" });

        const result = await normalizeGeneratedImageBytes(source, "image/png", target);
        expect(result).toMatchObject({ mimeType: "image/avif", width, height });
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "heif", compression: "av1", width, height });
        if (unchanged) expect(result.bytes).toEqual(source);
    });

    it("rejects bytes that cannot be decoded as an image", async () => {
        await expect(normalizeGeneratedImageBytes(Buffer.from("not an image"), "image/png", "4096x4096")).rejects.toThrow();
    });

    it.each([undefined, "64x64", "4096x4096"])("rejects corrupt pixels with readable PNG metadata before preserving bytes (%s)", async (targetSize) => {
        const source = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#203040" } })
            .png()
            .toBuffer();
        const damaged = Buffer.from(source);
        const pixelChunk = damaged.indexOf(Buffer.from("IDAT"));
        expect(pixelChunk).toBeGreaterThan(0);
        damaged[pixelChunk + 4] ^= 0xff;
        await expect(sharp(damaged, { failOn: "error" }).metadata()).resolves.toMatchObject({ format: "png", width: 64, height: 64 });
        await expect(sharp(damaged, { failOn: "error" }).raw().toBuffer()).rejects.toThrow();

        await expect(normalizeGeneratedImageBytes(damaged, "image/png", targetSize)).rejects.toThrow();
    });

    it("does not persist unsupported image formats using the caller MIME fallback", async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>');

        await expect(normalizeGeneratedImageBytes(svg, "image/png")).rejects.toThrow();
    });

    it("retains the existing forty-megapixel decode budget", async () => {
        const source = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: "#203040" } })
            .png()
            .toBuffer();

        await expect(normalizeGeneratedImageBytes(source, "image/png")).rejects.toThrow(/pixel limit/i);
    });
});
