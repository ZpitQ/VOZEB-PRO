import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { runImageProcessing } from "./image-processing-supervisor.mjs";
import { compositeSceneEditBytes } from "../.image-processing-runtime/lib/image-processing/scene-protection.js";

const directories = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const solid = (width, height, background) =>
    sharp({ create: { width, height, channels: 3, background } })
        .png()
        .toBuffer();
const artifact = (bytes, width, height) => ({ width, height, format: "png", sha256: digest(bytes), byteLength: bytes.length });

describe("compiled scene enhancement provider-native alpha", () => {
    it("rebuilds a legal scene baseline when discarded native outside pixels are transparent", async () => {
        const source = await solid(6, 4, "#5a4632");
        const native = await sharp({ create: { width: 6, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
            .composite([{ input: await solid(2, 2, "#be6e2d"), left: 2, top: 1 }])
            .png()
            .toBuffer();
        const mask = await sharp({ create: { width: 6, height: 4, channels: 4, background: "white" } })
            .composite([{ input: await solid(2, 2, "white"), left: 2, top: 1, blend: "dest-out" }])
            .png()
            .toBuffer();
        const ai = await solid(24, 16, "#2385e9");
        const scene = {
            version: "scene-edit-protection.v1",
            sourceAssetId: "scene-source",
            sourceSize: { width: 6, height: 4 },
            sourceDigest: digest(source),
            maskSize: { width: 6, height: 4 },
            maskDigest: digest(mask),
            targetRegion: { x: 2, y: 1, width: 2, height: 2 },
            semantics: ["replace selected background"],
            selectionSource: "user_selection",
            maskSemantics: "alpha_zero_edit",
            method: "source_pixels_copy",
        };
        const rebuilt = await compositeSceneEditBytes(source, native, mask, scene);
        expect(rebuilt.evidence).toMatchObject({ normalization: "none", outsidePixels: 20, mappedOutsideChangedPixels: 20, nativeOutsideChangedPixels: 20, compositeOutsideChangedPixels: 0 });
        expect((await sharp(native).stats()).isOpaque).toBe(false);
        expect((await sharp(rebuilt.bytes).stats()).isOpaque).toBe(true);
        const normalized = await sharp(source).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
        const directory = await mkdtemp(path.join(tmpdir(), "image-processing-enhancement-native-alpha-"));
        directories.push(directory);
        const outputDirectory = path.join(directory, "output");
        await mkdir(outputDirectory);
        const inputs = await Promise.all(
            [ai, source, native, rebuilt.bytes, mask].map(async (bytes, index) => {
                const filename = path.join(directory, `input-${index}`);
                await writeFile(filename, bytes);
                return { path: filename, assetId: index === 1 ? "scene-source" : `input-${index}`, assetVersion: digest(bytes), expectedSha256: digest(bytes) };
            }),
        );
        const budget = { maxBytes: 1_000_000, maxPixels: 1_000_000 };
        const request = {
            version: "image-processing.v1",
            jobId: randomUUID(),
            executionId: randomUUID(),
            operation: "process_enhancement",
            inputs,
            outputDirectory,
            options: {
                scope: "local_edit",
                bindingDigest: "b".repeat(64),
                resultId: "scene-result:1",
                resultIndex: 1,
                aiInputIndex: 0,
                engineInput: { width: 6, height: 4 },
                expectedAi: artifact(ai, 24, 16),
                targetSize: { width: 6, height: 4 },
                budgets: { input: budget, ai: budget, delivery: budget },
                sourceInputIndex: 1,
                nativeInputIndex: 2,
                baselineInputIndex: 3,
                maskInputIndex: 4,
                source: { width: 6, height: 4, sha256: digest(source), byteLength: source.length, normalizedSha256: digest(normalized) },
                native: artifact(native, 6, 4),
                baseline: artifact(rebuilt.bytes, 6, 4),
                protection: { version: "scene-enhancement.v1", normalization: "srgb-upright-v1", scene },
                originalProof: rebuilt.evidence,
            },
        };
        const outcome = await runImageProcessing(request, { taskDirectory: directory, maxHeapMiB: 128 });
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.exitCode).toBe(0);
        expect(outcome.result.metrics.pid).toBe(outcome.pid);
        expect(outcome.pid).not.toBe(process.pid);
        expect(() => process.kill(outcome.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        const delivered = outcome.result.artifacts[0];
        expect(delivered).toMatchObject({ kind: "final", resultId: "scene-result:1", resultIndex: 1, mimeType: "image/png", width: 6, height: 4 });
        expect(outcome.result.enhancement.protection).toMatchObject({ sourceSha256: digest(rebuilt.bytes), maskSha256: digest(mask), aiSha256: digest(ai), allowedPixels: 4, protectedPixels: 20, protectedChangedPixels: 0 });
        const pixels = await sharp(delivered.path).ensureAlpha().raw().toBuffer();
        expect([...pixels.subarray(0, 4)]).toEqual([90, 70, 50, 255]);
        expect([...pixels.subarray(32, 36)]).toEqual([35, 133, 233, 255]);
        expect((await sharp(delivered.path).stats()).isOpaque).toBe(true);
        expect(await readFile(inputs[2].path)).toEqual(native);
    });
});
