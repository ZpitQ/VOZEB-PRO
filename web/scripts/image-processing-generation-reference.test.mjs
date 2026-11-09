import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import { runImageProcessing } from "./image-processing-supervisor.mjs";

const directories = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it.each([
    { format: "jpeg", orientation: 6, background: "#ffffff", bounds: { width: 64, height: 64 }, sourceSize: { width: 96, height: 128 }, size: { width: 48, height: 64 }, alpha: 255 },
    { format: "png", orientation: 1, background: "#00000000", bounds: { width: 64, height: 64 }, sourceSize: { width: 128, height: 96 }, size: { width: 64, height: 48 }, alpha: 0 },
    { format: "png", orientation: 1, background: "#ffffff", bounds: { width: 256, height: 256 }, sourceSize: { width: 128, height: 96 }, size: { width: 128, height: 96 }, alpha: 255 },
])("prepares a generation reference from the original without analysis compression: $format/$orientation/$alpha", async ({ format, orientation, background, bounds, sourceSize, size, alpha }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "generation-reference-"));
    directories.push(directory);
    const outputDirectory = path.join(directory, "output");
    await mkdir(outputDirectory);
    const source = await sharp({ create: { width: 128, height: 96, channels: 4, background } })
        .composite([{ input: { create: { width: 64, height: 48, channels: 4, background: "#8a6243" } }, left: 32, top: 24 }])
        .toFormat(format)
        .withMetadata({ orientation })
        .toBuffer();
    const inputPath = path.join(directory, "original");
    await writeFile(inputPath, source);
    const sha256 = createHash("sha256").update(source).digest("hex");
    const outcome = await runImageProcessing(
        {
            version: "image-processing.v1",
            jobId: "generation-reference",
            executionId: "execution-generation",
            operation: "prepare_reference",
            options: { generationInput: { bounds, quality: "high" } },
            inputs: [{ path: inputPath, assetId: "product", assetVersion: "v1", expectedSha256: sha256 }],
            outputDirectory,
        },
        { taskDirectory: directory, maxHeapMiB: 128 },
    );
    expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
    expect(outcome.result.sourceIdentities).toEqual([{ assetId: "product", assetVersion: "v1", sha256, bytes: source.length, mimeType: `image/${format}`, ...sourceSize }]);
    expect(outcome.result.artifacts).toHaveLength(1);
    const [artifact] = outcome.result.artifacts;
    expect(artifact).toMatchObject({ kind: "generation_reference", mimeType: `image/${format}`, ...size });
    expect(outcome.result.geometry).toEqual({ sourceSize });
    const pixels = await sharp(artifact.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(pixels.info).toMatchObject(size);
    expect(pixels.data[3]).toBe(alpha);
    expect(await readFile(inputPath)).toEqual(source);
});
