import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { runImageProcessing } from "./image-processing-supervisor.mjs";
import { boundEcommerceVisionImage } from "../src/lib/server/ecommerce-vision-image.ts";

const directories = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function task(images, operation, options) {
    const directory = await mkdtemp(path.join(tmpdir(), "image-processing-operations-"));
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
    return { request: { version: "image-processing.v1", jobId: "job-operations", executionId: "execution-operations", operation, inputs, options, outputDirectory }, execution: { taskDirectory: directory, maxHeapMiB: 128 } };
}

function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function solid(width, height, background) {
    return sharp({ create: { width, height, channels: 4, background } })
        .png()
        .toBuffer();
}

describe("compiled full pixel operations", () => {
    it("prepares an upright original-coordinate review crop before vision bounding", async () => {
        const foreground = await solid(2000, 1400, "#e63946");
        const source = await sharp({ create: { width: 5000, height: 3000, channels: 3, background: "#ffffff" } })
            .composite([{ input: foreground, left: 1000, top: 800 }])
            .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
            .withMetadata({ orientation: 6 })
            .toBuffer();
        const setup = await task([source], "prepare_review", { region: { x: 300, y: 700, width: 2400, height: 3200 } });
        const outcome = await runImageProcessing(setup.request, setup.execution);

        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.sourceIdentities).toEqual([{ assetId: "asset-0", assetVersion: "version-0", sha256: digest(source), bytes: source.length, mimeType: "image/jpeg", width: 3000, height: 5000 }]);
        expect(outcome.result.geometry).toEqual({ sourceSize: { width: 3000, height: 5000 } });
        expect(outcome.result.artifacts).toHaveLength(1);
        const [artifact] = outcome.result.artifacts;
        expect(artifact).toMatchObject({ kind: "analysis", width: 1536, height: 2048, mimeType: "image/jpeg" });
        const bytes = await readFile(artifact.path);
        expect(artifact.sha256).toBe(digest(bytes));
        expect(artifact.bytes).toBe(bytes.length);
        expect(bytes.length).toBeLessThanOrEqual(4 * 1024 * 1024);
        const upright = await sharp(source).rotate().png().toBuffer();
        const crop = await sharp(upright).extract({ left: 300, top: 700, width: 2400, height: 3200 }).png().toBuffer();
        const compatible = await boundEcommerceVisionImage(`data:image/png;base64,${crop.toString("base64")}`);
        expect(bytes).toEqual(Buffer.from(compatible.split(",")[1], "base64"));
        const pixels = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(pixels.info).toMatchObject({ width: 1536, height: 2048, channels: 3 });
        expect([...pixels.data.subarray((128 * 1536 + 128) * 3, (128 * 1536 + 128) * 3 + 3)]).toEqual([255, 255, 255]);
        expect(pixels.data[(1024 * 1536 + 768) * 3]).toBeGreaterThan(200);
        expect(pixels.data[(1024 * 1536 + 768) * 3 + 1]).toBeLessThan(80);
        expect(pixels.data[(1024 * 1536 + 768) * 3 + 2]).toBeLessThan(90);
        expect(await readFile(setup.request.inputs[0].path)).toEqual(source);
        expect(outcome.result.metrics.pid).toBe(outcome.pid);
        expect(outcome.pid).not.toBe(process.pid);
        expect(() => process.kill(outcome.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }, 120_000);

    it("builds a local target mask while keeping product rectangles protected", async () => {
        const setup = await task([await solid(8, 6, "#6699aa")], "build_protection", { mode: "local_edit", targetRegion: { x: 0.25, y: 0.16666666666666666, width: 0.5, height: 0.5 }, protectedRectangles: [{ x: 3, y: 2, width: 2, height: 1 }] });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        const [artifact] = outcome.result.artifacts;
        const { data, info } = await sharp(artifact.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(info).toMatchObject({ width: 8, height: 6, channels: 4 });
        expect(data[3]).toBe(255);
        expect(data[(1 * 8 + 2) * 4 + 3]).toBe(0);
        expect(data[(2 * 8 + 3) * 4 + 3]).toBe(255);
        expect(data[(3 * 8 + 5) * 4 + 3]).toBe(0);
        expect(data[(4 * 8 + 6) * 4 + 3]).toBe(255);
    });

    it("builds the exact user-confirmed scene selection and immutable mask identity", async () => {
        const source = await solid(8, 6, "#556677");
        const setup = await task([source], "build_protection", { mode: "scene_selection", region: { x: 2, y: 1, width: 3, height: 2 }, semantics: ["replace selected background"], selectionSource: "user_selection" });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        const [artifact] = outcome.result.artifacts;
        const bytes = await readFile(artifact.path);
        const data = await sharp(bytes).ensureAlpha().raw().toBuffer();
        expect(data[(1 * 8 + 2) * 4 + 3]).toBe(0);
        expect(data[(2 * 8 + 4) * 4 + 3]).toBe(0);
        expect(data[(3 * 8 + 4) * 4 + 3]).toBe(255);
        expect(outcome.result.geometry.sceneProtection).toMatchObject({
            version: "scene-edit-protection.v1",
            sourceAssetId: "asset-0",
            sourceDigest: digest(source),
            maskDigest: digest(bytes),
            sourceSize: { width: 8, height: 6 },
            maskSize: { width: 8, height: 6 },
            selectionSource: "user_selection",
            maskSemantics: "alpha_zero_edit",
            method: "source_pixels_copy",
        });
    });

    it.each([
        { width: 10, height: 6, targetSize: { width: 8, height: 8 }, expected: { width: 10, height: 6 }, preserve: true },
        { width: 12, height: 8, targetSize: { width: 6, height: 6 }, expected: { width: 6, height: 4 }, preserve: false },
    ])("preserves undersized native bytes or shrinks inside the target: $width x $height", async ({ width, height, targetSize, expected, preserve }) => {
        const native = await solid(width, height, "#c26a32");
        const setup = await task([native], "process_result", { mode: "ordinary", results: [{ resultId: "image-task:1", resultIndex: 1, inputIndex: 0 }], targetSize, transparentBackground: false });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        const [artifact] = outcome.result.artifacts;
        expect(artifact).toMatchObject({ kind: "final", resultId: "image-task:1", resultIndex: 1, mimeType: "image/png", ...expected });
        const final = await readFile(artifact.path);
        expect(await sharp(final).metadata()).toMatchObject(expected);
        expect(final.equals(native)).toBe(preserve);
        expect(artifact.sha256).toBe(digest(final));
        expect(outcome.result.results).toEqual([{ resultId: "image-task:1", resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 0 }]);
    });

    it("binds two distinct slots to their original native identities even when ordered differently", async () => {
        const first = await solid(6, 4, "#aa2200");
        const second = await solid(6, 4, "#0044bb");
        const setup = await task([first, second], "process_result", {
            mode: "ordinary",
            results: [
                { resultId: "image-task:2", resultIndex: 2, inputIndex: 1 },
                { resultId: "image-task:1", resultIndex: 1, inputIndex: 0 },
            ],
            transparentBackground: false,
        });
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.results).toEqual([
            { resultId: "image-task:2", resultIndex: 2, nativeInputIndex: 1, finalArtifactIndex: 0 },
            { resultId: "image-task:1", resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 1 },
        ]);
        expect(outcome.result.sourceIdentities).toMatchObject([
            { assetId: "asset-0", assetVersion: "version-0", sha256: digest(first) },
            { assetId: "asset-1", assetVersion: "version-1", sha256: digest(second) },
        ]);
        expect(await readFile(outcome.result.artifacts[0].path)).toEqual(second);
        expect(await readFile(outcome.result.artifacts[1].path)).toEqual(first);
        expect(outcome.result.artifacts).toMatchObject([
            { kind: "final", resultId: "image-task:2", resultIndex: 2 },
            { kind: "final", resultId: "image-task:1", resultIndex: 1 },
        ]);
        expect(outcome.pid).toBeGreaterThan(0);
        expect(() => process.kill(outcome.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    });
});
