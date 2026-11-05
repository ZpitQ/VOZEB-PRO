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
async function task(images, options) {
    const directory = await mkdtemp(path.join(tmpdir(), "image-processing-protected-"));
    directories.push(directory);
    const outputDirectory = path.join(directory, "output");
    await mkdir(outputDirectory);
    const inputs = await Promise.all(
        images.map(async (bytes, index) => {
            const input = path.join(directory, `input-${index}`);
            await writeFile(input, bytes);
            return { path: input, assetId: `asset-${index}`, assetVersion: `version-${index}`, expectedSha256: digest(bytes) };
        }),
    );
    return { request: { version: "image-processing.v1", jobId: "job-protected", executionId: "execution-protected", operation: "process_result", inputs, options, outputDirectory }, execution: { taskDirectory: directory, maxHeapMiB: 128 } };
}
const slot = { resultId: "image-task:1", resultIndex: 1, inputIndex: 2 };

async function protectionFixture() {
    const source = await solid(6, 4, "#123456");
    const selected = await solid(2, 2, "#ffffff");
    const mask = await sharp(await solid(6, 4, "#ffffff"))
        .composite([{ input: selected, left: 2, top: 1, blend: "dest-out" }])
        .png()
        .toBuffer();
    const normalized = await sharp(source).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
    const baseline = { width: 6, height: 4, sha256: digest(source), byteLength: source.length, normalizedSha256: digest(normalized) };
    const scene = {
        version: "scene-edit-protection.v1",
        sourceAssetId: "asset-0",
        sourceSize: { width: 6, height: 4 },
        sourceDigest: digest(source),
        maskSize: { width: 6, height: 4 },
        maskDigest: digest(mask),
        targetRegion: { x: 2, y: 1, width: 2, height: 2 },
        semantics: ["change selected background"],
        selectionSource: "user_selection",
        maskSemantics: "alpha_zero_edit",
        method: "source_pixels_copy",
    };
    const product = {
        version: "product-enhancement.v2",
        normalization: "srgb-upright-v1",
        product: {
            compilerVersion: "strict-product.v1",
            state: "ready",
            productAnchorId: "product-anchor",
            sourceAssetId: "asset-0",
            sourceSize: { width: 6, height: 4 },
            productCore: [{ x: 0, y: 0, width: 1, height: 1 }],
            fusionHalo: [],
            editableBackground: [],
        },
        maskSha256: digest(mask),
    };
    return { source, mask, wrongMask: await solid(6, 4, "#ffffff"), baseline, wrongNormalizedBaseline: { ...baseline, normalizedSha256: "0".repeat(64) }, wrongSourceBaseline: { ...baseline, sha256: "0".repeat(64) }, scene, product };
}

describe("compiled scene and product result protection", () => {
    it.each([
        { native: "opaque JPEG", format: "jpeg", background: "#abcdef", encodedAlpha: false, hasAlpha: false },
        { native: "transparent PNG", format: "png", background: { r: 171, g: 205, b: 239, alpha: 0 }, encodedAlpha: true, hasAlpha: true },
        { native: "opaque PNG with an alpha channel", format: "png", background: "#abcdef", encodedAlpha: true, hasAlpha: false },
    ])("reports the original native image facts for $native before opaque PNG composition", async ({ format, background, encodedAlpha, hasAlpha }) => {
        const fixture = await protectionFixture();
        const native = await sharp(await solid(6, 4, background))
            .composite([{ input: await solid(2, 2, "#abcdef"), left: 2, top: 1 }])
            .toFormat(format)
            .toBuffer();
        expect(await sharp(native).metadata()).toMatchObject({ format, hasAlpha: encodedAlpha });
        const setup = await task([fixture.source, fixture.mask, native], { mode: "scene_protection", results: [slot], sourceInputIndex: 0, maskInputIndex: 1, protection: fixture.scene, baseline: fixture.baseline });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.pid).toBeGreaterThan(0);
        expect(outcome.exitCode).toBe(0);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        const [artifact] = outcome.result.artifacts;
        const final = await readFile(artifact.path);
        expect(artifact).toMatchObject({ kind: "final", resultId: slot.resultId, resultIndex: 1, mimeType: "image/png", width: 6, height: 4, bytes: final.length, sha256: digest(final) });
        expect(artifact.sha256).not.toBe(digest(native));
        expect(await sharp(final).stats()).toMatchObject({ isOpaque: true });
        expect(outcome.result.results[0]).toMatchObject({ resultId: slot.resultId, resultIndex: 1, nativeInputIndex: 2, finalArtifactIndex: 0, baselineValidated: true });
        expect(await readFile(setup.request.inputs[2].path)).toEqual(native);
        expect(outcome.result.sourceIdentities[2]).toMatchObject({ assetId: "asset-2", assetVersion: "version-2", sha256: digest(native), bytes: native.length, width: 6, height: 4 });
        expect(outcome.result.sourceIdentities[2]).toMatchObject({ nativeImage: { format, hasAlpha } });
    });

    it.each([
        { width: 6, height: 4, normalization: "none" },
        { width: 12, height: 8, normalization: "uniform_scale" },
        { width: 5, height: 4, normalization: "pixel_grid_scale" },
    ])("preserves encoded outside pixels with $normalization native mapping", async ({ width, height, normalization }) => {
        const fixture = await protectionFixture();
        const native = await solid(width, height, "#abcdef");
        const setup = await task([fixture.source, fixture.mask, native], { mode: "scene_protection", results: [slot], sourceInputIndex: 0, maskInputIndex: 1, protection: fixture.scene, baseline: fixture.baseline });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        const final = await readFile(outcome.result.artifacts[0].path);
        const pixels = await sharp(final).ensureAlpha().raw().toBuffer();
        expect([...pixels.subarray(0, 4)]).toEqual([18, 52, 86, 255]);
        expect([...pixels.subarray(32, 36)]).toEqual([171, 205, 239, 255]);
        expect([...pixels.subarray(92, 96)]).toEqual([18, 52, 86, 255]);
        expect(outcome.result.results[0]).toMatchObject({
            resultId: slot.resultId,
            resultIndex: 1,
            nativeInputIndex: 2,
            finalArtifactIndex: 0,
            baselineValidated: true,
            sceneProtectionEvidence: { normalization, nativeDigest: digest(native), compositeDigest: digest(final), outsidePixels: 20, mappedOutsideChangedPixels: 20, compositeOutsideChangedPixels: 0 },
        });
        expect(outcome.result.results[0]).not.toHaveProperty("inputIndex");
        expect(await readFile(setup.request.inputs[2].path)).toEqual(native);
    });

    it.each([
        { violation: "ratio", width: 5, height: 5, maskKey: "mask", baselineKey: "baseline", expected: /原生画幅比例/ },
        { violation: "mask", width: 6, height: 4, maskKey: "wrongMask", baselineKey: "baseline", expected: /蒙版/ },
        { violation: "baseline", width: 6, height: 4, maskKey: "mask", baselineKey: "wrongNormalizedBaseline", expected: /基线/ },
    ])("rejects the actual invalid scene $violation contract", async ({ width, height, maskKey, baselineKey, expected }) => {
        const fixture = await protectionFixture();
        const native = await solid(width, height, "#abcdef");
        const setup = await task([fixture.source, fixture[maskKey], native], { mode: "scene_protection", results: [slot], sourceInputIndex: 0, maskInputIndex: 1, protection: fixture.scene, baseline: fixture[baselineKey] });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome).toMatchObject({ status: "rejected", error: { code: "scene_protection_rejected", message: expect.stringMatching(expected) } });
    });

    it("retains native JPEG identity and a separate lossless product baseline", async () => {
        const fixture = await protectionFixture();
        const native = await sharp({ create: { width: 4, height: 6, channels: 3, background: "#abcdef" } })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toBuffer();
        const setup = await task([fixture.source, fixture.mask, native], { mode: "product_protection", results: [slot], sourceInputIndex: 0, maskInputIndex: 1, protection: fixture.product, baseline: fixture.baseline });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        const final = await readFile(outcome.result.artifacts[0].path);
        const pixels = await sharp(final).ensureAlpha().raw().toBuffer();
        expect([...pixels.subarray(0, 4)]).toEqual([18, 52, 86, 255]);
        expect([...pixels.subarray(92, 96)]).toEqual([18, 52, 86, 255]);
        expect(outcome.result.sourceIdentities[2]).toMatchObject({ sha256: digest(native), mimeType: "image/jpeg", width: 6, height: 4 });
        expect(outcome.result.results[0]).toMatchObject({
            resultId: slot.resultId,
            resultIndex: 1,
            nativeInputIndex: 2,
            baselineValidated: true,
            productEnhancementEvidence: {
                sourceSha256: digest(fixture.source),
                maskSha256: digest(fixture.mask),
                aiSha256: digest(native),
                compositeSha256: digest(final),
                sourceSize: { width: 6, height: 4 },
                aiSize: { width: 6, height: 4 },
                allowedPixels: 4,
                protectedPixels: 20,
                protectedChangedPixels: 0,
            },
        });
        expect(await sharp(final).metadata()).toMatchObject({ format: "png", width: 6, height: 4 });
        expect(await readFile(setup.request.inputs[2].path)).toEqual(native);
    });

    it.each([
        { violation: "native_size", width: 12, height: 8, baselineKey: "baseline", expected: /native dimensions/ },
        { violation: "baseline", width: 6, height: 4, baselineKey: "wrongSourceBaseline", expected: /基线/ },
    ])("rejects a product $violation violation before claiming qualified delivery", async ({ width, height, baselineKey, expected }) => {
        const fixture = await protectionFixture();
        const native = await solid(width, height, "#abcdef");
        const setup = await task([fixture.source, fixture.mask, native], { mode: "product_protection", results: [slot], sourceInputIndex: 0, maskInputIndex: 1, protection: fixture.product, baseline: fixture[baselineKey] });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome).toMatchObject({ status: "rejected", error: { code: "product_protection_rejected", message: expect.stringMatching(expected) } });
    });

    it("keeps a qualified product slot when another native has the wrong dimensions", async () => {
        const fixture = await protectionFixture();
        const badNative = await solid(12, 8, "#ff0000");
        const goodNative = await solid(6, 4, "#abcdef");
        const setup = await task([fixture.source, fixture.mask, badNative, goodNative], {
            mode: "product_protection",
            results: [slot, { resultId: "image-task:2", resultIndex: 2, inputIndex: 3 }],
            sourceInputIndex: 0,
            maskInputIndex: 1,
            protection: fixture.product,
            baseline: fixture.baseline,
        });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.sourceIdentities[2]).toMatchObject({ assetId: "asset-2", sha256: digest(badNative), width: 12, height: 8 });
        expect(outcome.result.results).toMatchObject([
            { resultId: "image-task:1", resultIndex: 1, nativeInputIndex: 2, error: { code: "product_protection_rejected", failureStage: "validation", message: expect.stringMatching(/native dimensions/) } },
            { resultId: "image-task:2", resultIndex: 2, nativeInputIndex: 3, finalArtifactIndex: 0, productEnhancementEvidence: { aiSha256: digest(goodNative), protectedChangedPixels: 0 } },
        ]);
        expect(outcome.result.results[0]).not.toHaveProperty("finalArtifactIndex");
        expect(outcome.result.artifacts).toMatchObject([{ kind: "final", resultId: "image-task:2", resultIndex: 2 }]);
        expect(outcome.result.artifacts).toHaveLength(1);
        const pixels = await sharp(outcome.result.artifacts[0].path).ensureAlpha().raw().toBuffer();
        expect([...pixels.subarray(32, 36)]).toEqual([171, 205, 239, 255]);
    });

    it("keeps a qualified scene slot when another native has an incompatible ratio", async () => {
        const fixture = await protectionFixture();
        const badNative = await solid(5, 5, "#ff0000");
        const goodNative = await solid(6, 4, "#abcdef");
        const setup = await task([fixture.source, fixture.mask, badNative, goodNative], {
            mode: "scene_protection",
            results: [slot, { resultId: "image-task:2", resultIndex: 2, inputIndex: 3 }],
            sourceInputIndex: 0,
            maskInputIndex: 1,
            protection: fixture.scene,
            baseline: fixture.baseline,
        });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.results).toMatchObject([
            { resultId: "image-task:1", resultIndex: 1, nativeInputIndex: 2, error: { code: "scene_protection_rejected", failureStage: "validation", message: expect.stringMatching(/原生画幅比例/) } },
            { resultId: "image-task:2", resultIndex: 2, nativeInputIndex: 3, finalArtifactIndex: 0, sceneProtectionEvidence: { nativeDigest: digest(goodNative), compositeOutsideChangedPixels: 0 } },
        ]);
        expect(outcome.result.results[0]).not.toHaveProperty("finalArtifactIndex");
        expect(outcome.result.artifacts).toMatchObject([{ kind: "final", resultId: "image-task:2", resultIndex: 2 }]);
        expect(outcome.result.artifacts).toHaveLength(1);
        const pixels = await sharp(outcome.result.artifacts[0].path).ensureAlpha().raw().toBuffer();
        expect([...pixels.subarray(0, 4)]).toEqual([18, 52, 86, 255]);
        expect([...pixels.subarray(32, 36)]).toEqual([171, 205, 239, 255]);
    });
});

describe("compiled transparent and layer validation", () => {
    it("keeps a visible transparent ordinary result and its original bytes", async () => {
        const native = (await layers()).element;
        const setup = await task([native], { mode: "ordinary", results: [{ ...slot, inputIndex: 0 }], transparentBackground: true });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.artifacts).toMatchObject([{ kind: "final", resultId: "image-task:1", resultIndex: 1, width: 4, height: 4, sha256: digest(native) }]);
        expect(await readFile(outcome.result.artifacts[0].path)).toEqual(native);
        const pixels = await sharp(outcome.result.artifacts[0].path).ensureAlpha().raw().toBuffer();
        expect([...pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
        expect([...pixels.subarray(20, 24)]).toEqual([239, 68, 68, 255]);
    });

    it("keeps a valid ordinary slot and records a corrupt native under its original identity", async () => {
        const full = await solid(6, 4, "#ff0000");
        const corrupt = full.subarray(0, full.length - 24);
        const native = await solid(6, 4, "#0044bb");
        const setup = await task([corrupt, native], {
            mode: "ordinary",
            results: [
                { ...slot, inputIndex: 0 },
                { resultId: "image-task:2", resultIndex: 2, inputIndex: 1 },
            ],
            transparentBackground: false,
        });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.sourceIdentities[0]).toMatchObject({ assetId: "asset-0", assetVersion: "version-0", sha256: digest(corrupt), bytes: corrupt.length, decodeError: { code: "invalid_result", message: expect.any(String) } });
        expect(outcome.result.sourceIdentities[0]).not.toHaveProperty("width");
        expect(outcome.result.sourceIdentities[0]).not.toHaveProperty("nativeImage");
        expect(outcome.result.results).toMatchObject([
            { resultId: "image-task:1", resultIndex: 1, nativeInputIndex: 0, error: { code: "invalid_result", failureStage: "decode", message: expect.any(String) } },
            { resultId: "image-task:2", resultIndex: 2, nativeInputIndex: 1, finalArtifactIndex: 0 },
        ]);
        expect(outcome.result.results[0]).not.toHaveProperty("finalArtifactIndex");
        expect(outcome.result.artifacts).toMatchObject([{ kind: "final", resultId: "image-task:2", resultIndex: 2 }]);
        expect(outcome.result.artifacts).toHaveLength(1);
        expect(await readFile(outcome.result.artifacts[0].path)).toEqual(native);
    });

    it.each([
        { background: "#ef4444", message: "上游没有生成透明背景" },
        { background: { r: 0, g: 0, b: 0, alpha: 0 }, message: "上游生成了全透明空图" },
    ])("rejects unqualified transparent output: $message", async ({ background, message }) => {
        const native = await solid(4, 4, background);
        const setup = await task([native], { mode: "ordinary", results: [{ ...slot, inputIndex: 0 }], transparentBackground: true });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome).toMatchObject({ status: "rejected", error: { code: "invalid_transparent_result", message } });
    });

    it("preserves exact independent layer bytes and identifies element versus background", async () => {
        const fixture = await layers();
        const setup = await task([fixture.source, fixture.element, fixture.background], {
            mode: "layers",
            sourceInputIndex: 0,
            results: [
                { ...slot, inputIndex: 1 },
                { resultId: "image-task:2", resultIndex: 2, inputIndex: 2 },
            ],
        });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.artifacts).toMatchObject([
            { resultId: "image-task:1", resultIndex: 1, layerKind: "element", width: 4, height: 4 },
            { resultId: "image-task:2", resultIndex: 2, layerKind: "background", width: 4, height: 4 },
        ]);
        expect(await readFile(outcome.result.artifacts[0].path)).toEqual(fixture.element);
        expect(await readFile(outcome.result.artifacts[1].path)).toEqual(fixture.background);
    });

    it("rejects duplicate visible layer pixels instead of collapsing result slots", async () => {
        const fixture = await layers();
        const setup = await task([fixture.source, fixture.element, fixture.background], {
            mode: "layers",
            sourceInputIndex: 0,
            results: [
                { ...slot, inputIndex: 1 },
                { resultId: "image-task:2", resultIndex: 2, inputIndex: 1 },
                { resultId: "image-task:3", resultIndex: 3, inputIndex: 2 },
            ],
        });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome).toMatchObject({ status: "rejected", error: { code: "invalid_layers", message: expect.stringContaining("重复像素") } });
    });
});

async function layers() {
    const background = await solid(4, 4, "#dbeafe");
    const elementPixels = await solid(2, 2, "#ef4444");
    const element = await sharp(await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
        .composite([{ input: elementPixels, left: 1, top: 1 }])
        .png()
        .toBuffer();
    const source = await sharp(background)
        .composite([{ input: elementPixels, left: 1, top: 1 }])
        .png()
        .toBuffer();
    return { source, element, background };
}
