import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { runImageProcessing } from "./image-processing-supervisor.mjs";

const directories = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function solid(width, height, background) {
    return sharp({ create: { width, height, channels: 4, background } })
        .png()
        .toBuffer();
}
async function task(source, options) {
    const directory = await mkdtemp(path.join(tmpdir(), "image-enhancement-baseline-"));
    directories.push(directory);
    const outputDirectory = path.join(directory, "output");
    await mkdir(outputDirectory);
    const inputPath = path.join(directory, "source.png");
    await writeFile(inputPath, source);
    return {
        request: {
            version: "image-processing.v1",
            jobId: "baseline-job",
            executionId: "baseline-execution",
            operation: "build_protection",
            inputs: [{ path: inputPath, assetId: "actual-source", assetVersion: "source-version", expectedSha256: digest(source) }],
            options,
            outputDirectory,
        },
        execution: { taskDirectory: directory, maxHeapMiB: 128 },
    };
}

describe("build-time enhancement baseline qualification", () => {
    it("qualifies an opaque product using its known canonical PNG and actual mask", async () => {
        const foreground = await solid(12, 10, "#2e5ba8");
        const source = await sharp(await solid(32, 24, "#ffffff"))
            .composite([{ input: foreground, left: 8, top: 6 }])
            .png()
            .toBuffer();
        const setup = await task(source, { transparentBackground: false, freezeEnhancementBaseline: true });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.geometry.enhancementBaseline).toMatchObject({
            status: "qualified",
            scope: "product_background",
            normalization: "srgb-upright-v1",
            hasAlpha: false,
            baseline: { sha256: digest(source), byteLength: source.length, width: 32, height: 24, normalizedSha256: digest(source) },
            composition: { productAnchorId: "actual-source", sourceAssetId: "actual-source", sourceSha256: digest(source), maskSha256: outcome.result.artifacts[0].sha256, aiSha256: digest(source), protectedChangedPixels: 0 },
        });
        expect(outcome.result.artifacts).toHaveLength(1);
        expect(outcome.result.artifacts[0].kind).toBe("mask");
    });

    it("keeps a valid transparent product mask while explicitly refusing enhancement qualification", async () => {
        const foreground = await solid(12, 10, "#2e5ba8");
        const source = await sharp(await solid(32, 24, { r: 0, g: 0, b: 0, alpha: 0 }))
            .composite([{ input: foreground, left: 8, top: 6 }])
            .png()
            .toBuffer();
        const setup = await task(source, { transparentBackground: true, freezeEnhancementBaseline: true });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.geometry.enhancementBaseline).toMatchObject({ status: "unsupported", scope: "product_background", error: { code: "product_protection_rejected", message: expect.stringMatching(/source must be opaque/) } });
        expect(outcome.result.geometry.enhancementBaseline).not.toHaveProperty("baseline");
        const pixels = await sharp(await readFile(outcome.result.artifacts[0].path))
            .ensureAlpha()
            .raw()
            .toBuffer();
        expect(pixels[3]).toBe(0);
        expect(pixels[(6 * 32 + 8) * 4 + 3]).toBe(255);
    });

    it("qualifies the user scene mask and reports real transparent source pixels", async () => {
        const foreground = await solid(4, 3, "#2e5ba8");
        const source = await sharp(await solid(8, 6, { r: 0, g: 0, b: 0, alpha: 0 }))
            .composite([{ input: foreground, left: 2, top: 1 }])
            .png()
            .toBuffer();
        const setup = await task(source, { mode: "scene_selection", region: { x: 1, y: 1, width: 2, height: 2 }, semantics: ["selected prop"], selectionSource: "user_selection", freezeEnhancementBaseline: true });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.geometry.enhancementBaseline).toMatchObject({
            status: "qualified",
            scope: "local_edit",
            normalization: "srgb-upright-v1",
            hasAlpha: true,
            baseline: { sha256: digest(source), byteLength: source.length, width: 8, height: 6, normalizedSha256: digest(source) },
        });
        expect(outcome.result.geometry.sceneProtection).toMatchObject({ sourceDigest: digest(source), maskDigest: outcome.result.artifacts[0].sha256 });
        expect(outcome.result.artifacts).toHaveLength(1);
    });

    it("qualifies local product protection with the actual anchor and separate core", async () => {
        const source = await solid(8, 6, "#556677");
        const setup = await task(source, {
            mode: "local_edit",
            targetRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
            protectedRectangles: [{ x: 4, y: 2, width: 4, height: 4 }],
            freezeEnhancementBaseline: { productAnchorId: "actual-product-anchor", productCore: [{ x: 5, y: 3, width: 2, height: 2 }] },
        });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.geometry.enhancementBaseline).toMatchObject({
            status: "qualified",
            scope: "product_background",
            baseline: { normalizedSha256: digest(source), width: 8, height: 6 },
            hasAlpha: false,
            composition: { productAnchorId: "actual-product-anchor", sourceAssetId: "actual-source", sourceSha256: digest(source), maskSha256: outcome.result.artifacts[0].sha256, protectedChangedPixels: 0 },
        });
    });
});
