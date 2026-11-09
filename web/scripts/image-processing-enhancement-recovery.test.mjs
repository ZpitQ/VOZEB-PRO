import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { runImageProcessing } from "./image-processing-supervisor.mjs";
import { compositeProductEnhancement } from "../.image-processing-runtime/lib/image-processing/product-protection.js";
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
const descriptor = (bytes, width, height, format = "png") => ({ sha256: digest(bytes), byteLength: bytes.length, width, height, format });
const budget = { maxBytes: 1_000_000, maxPixels: 1_000_000 };
function common(ai, width, height) {
    return {
        bindingDigest: "a".repeat(64),
        resultId: "result:1",
        resultIndex: 1,
        aiInputIndex: 0,
        engineInput: { width: width / 4, height: height / 4 },
        expectedAi: descriptor(ai, width, height),
        budgets: { input: budget, ai: budget, delivery: budget },
    };
}
function legacyDelivery(ai, format) {
    const image = sharp(ai).resize(64, 64);
    return format === "png" ? image.png().toBuffer() : image.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
}
async function task(images, options) {
    const directory = await mkdtemp(path.join(tmpdir(), "image-processing-enhancement-recovery-"));
    directories.push(directory);
    const outputDirectory = path.join(directory, "output");
    await mkdir(outputDirectory);
    const inputs = await Promise.all(
        images.map(async ({ bytes, id }, index) => {
            const filename = path.join(directory, `input-${index}`);
            await writeFile(filename, bytes);
            return { path: filename, assetId: id || `asset-${index}`, assetVersion: `version-${index}`, expectedSha256: digest(bytes) };
        }),
    );
    return { request: { version: "image-processing.v1", jobId: randomUUID(), executionId: randomUUID(), operation: "process_enhancement", inputs, options, outputDirectory }, execution: { taskDirectory: directory, maxHeapMiB: 128 } };
}
async function protectedFixture(scope) {
    const source = await solid(6, 4, "#5a4632");
    const native = await solid(scope === "local_edit" ? 3 : 6, scope === "local_edit" ? 2 : 4, "#be6e2d");
    const ai = await solid(24, 16, "#2385e9");
    const mask = await sharp({ create: { width: 6, height: 4, channels: 4, background: "white" } })
        .composite([{ input: await solid(2, 2, "white"), left: 2, top: 1, blend: "dest-out" }])
        .png()
        .toBuffer();
    const scene = {
        version: "scene-edit-protection.v1",
        sourceAssetId: "source",
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
    const product = {
        version: "product-enhancement.v2",
        normalization: "srgb-upright-v1",
        maskSha256: digest(mask),
        product: {
            compilerVersion: "strict-product.v1",
            state: "ready",
            productAnchorId: "product-anchor",
            sourceAssetId: "source",
            sourceSize: { width: 6, height: 4 },
            productCore: [{ x: 0, y: 0, width: 1, height: 1 }],
            fusionHalo: [],
            editableBackground: [{ x: 2, y: 1, width: 2, height: 2 }],
        },
    };
    const baseline =
        scope === "local_edit" ? await compositeSceneEditBytes(source, native, mask, scene) : await compositeProductEnhancement(source, native, { ...product, maskDataUrl: `data:image/png;base64,${mask.toString("base64")}` }, 1_000_000, "native");
    const normalized = await sharp(source).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
    const options = {
        ...common(ai, 24, 16),
        scope,
        targetSize: { width: 6, height: 4 },
        sourceInputIndex: 1,
        nativeInputIndex: 2,
        baselineInputIndex: 3,
        maskInputIndex: 4,
        source: { ...descriptor(source, 6, 4), normalizedSha256: digest(normalized) },
        native: descriptor(native, scope === "local_edit" ? 3 : 6, scope === "local_edit" ? 2 : 4),
        baseline: descriptor(baseline.bytes, 6, 4),
        protection: scope === "local_edit" ? { version: "scene-enhancement.v1", normalization: "srgb-upright-v1", scene } : product,
        originalProof: baseline.evidence,
    };
    return { source, native, ai, mask, baseline: baseline.bytes, options, images: [{ bytes: ai }, { bytes: source, id: "source" }, { bytes: native }, { bytes: baseline.bytes }, { bytes: mask }] };
}

describe("compiled enhancement stage recovery and protection", () => {
    it("rejects transparent AI before any delivery is written", async () => {
        const ai = await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 35, g: 133, b: 233, alpha: 0 } } })
            .png()
            .toBuffer();
        const setup = await task([{ bytes: ai }], { ...common(ai, 128, 128), scope: "full_image", targetSize: { width: 64, height: 64 } });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("rejected");
        expect(outcome.error.code).toBe("enhancement_publication_rejected");
        expect(outcome.exitCode).toBe(0);
    });
    it("rejects a truncated AI PNG with matching byte length and SHA in the CPU before delivery", async () => {
        const ai = (await solid(8, 8, "#2385e9")).subarray(0, 50);
        const setup = await task([{ bytes: ai }], { ...common(ai, 8, 8), scope: "full_image", targetSize: { width: 6, height: 6 } });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("rejected");
        expect(outcome.error.code).toBe("enhancement_publication_rejected");
        expect(outcome.pid).toBeGreaterThan(0);
        expect(outcome.pid).not.toBe(process.pid);
        expect(outcome.exitCode).toBe(0);
        expect(outcome.signal).toBeNull();
        expect(await readdir(setup.request.outputDirectory)).toEqual([]);
    });
    it("rejects JPEG bytes recorded as a legacy PNG stage", async () => {
        const ai = await solid(128, 128, "#2385e9");
        const staged = await sharp(ai).resize(64, 64).jpeg().toBuffer();
        const setup = await task([{ bytes: ai }, { bytes: staged }], { ...common(ai, 128, 128), scope: "full_image", targetSize: { width: 64, height: 64 }, stagedDelivered: { inputIndex: 1, expected: descriptor(staged, 64, 64, "png") } });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("rejected");
        expect(outcome.error.code).toBe("enhancement_publication_rejected");
        expect(outcome.exitCode).toBe(0);
    });
    it.each([{ format: "png" }, { format: "jpeg" }])("reuses an existing legal global $format stage byte for byte", async ({ format }) => {
        const ai = await solid(128, 128, "#2385e9");
        const staged = await legacyDelivery(ai, format);
        const setup = await task([{ bytes: ai }, { bytes: staged }], { ...common(ai, 128, 128), scope: "full_image", targetSize: { width: 64, height: 64 }, stagedDelivered: { inputIndex: 1, expected: descriptor(staged, 64, 64, format) } });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(await readFile(outcome.result.artifacts[0].path)).toEqual(staged);
        expect(outcome.result.artifacts[0]).toMatchObject({ mimeType: `image/${format}`, sha256: digest(staged) });
        expect(outcome.result.enhancement.deliveryEncodingMs).toBeUndefined();
    });
    it.each([
        { width: 128, height: 128, target: { width: 128, height: 128 }, expected: { width: 128, height: 128 } },
        { width: 128, height: 76, target: { width: 64, height: 36 }, expected: { width: 61, height: 36 } },
    ])("encodes the requested global fit $width x $height as JPEG", async ({ width, height, target, expected }) => {
        const ai = await solid(width, height, "#2385e9");
        const setup = await task([{ bytes: ai }], { ...common(ai, width, height), scope: "full_image", targetSize: target });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.artifacts[0]).toMatchObject({ mimeType: "image/jpeg", ...expected });
        expect(await sharp(outcome.result.artifacts[0].path).metadata()).toMatchObject({ format: "jpeg", chromaSubsampling: "4:4:4", ...expected });
    });
    it.each([{ scope: "product_background" }, { scope: "local_edit" }])("rebuilds the native baseline and preserves protected pixels for $scope", async ({ scope }) => {
        const fixture = await protectedFixture(scope);
        const setup = await task(fixture.images, fixture.options);
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.artifacts[0]).toMatchObject({ mimeType: "image/png", width: 6, height: 4 });
        expect(outcome.result.enhancement.protection).toMatchObject({ sourceSha256: digest(fixture.baseline), maskSha256: digest(fixture.mask), aiSha256: digest(fixture.ai), protectedPixels: 20, allowedPixels: 4, protectedChangedPixels: 0 });
        const pixels = await sharp(outcome.result.artifacts[0].path).ensureAlpha().raw().toBuffer();
        expect([...pixels.subarray(0, 4)]).toEqual([90, 70, 50, 255]);
        expect([...pixels.subarray((1 * 6 + 2) * 4, (1 * 6 + 2) * 4 + 4)]).toEqual([35, 133, 233, 255]);
        expect(await readFile(setup.request.inputs[0].path)).toEqual(fixture.ai);
        expect(outcome.result.metrics.pid).toBe(outcome.pid);
        expect(outcome.pid).not.toBe(process.pid);
        expect(() => process.kill(outcome.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    });
    it.each([
        { scope: "product_background", field: "compositeSha256" },
        { scope: "local_edit", field: "compositeDigest" },
    ])("rejects a changed original baseline proof for $scope", async ({ scope, field }) => {
        const fixture = await protectedFixture(scope);
        const setup = await task(fixture.images, { ...fixture.options, originalProof: { ...fixture.options.originalProof, [field]: "0".repeat(64) } });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("rejected");
        expect(outcome.error.code).toBe("enhancement_publication_rejected");
        expect(outcome.exitCode).toBe(0);
        expect(outcome.pid).not.toBe(process.pid);
    });
});
