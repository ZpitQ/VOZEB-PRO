import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { expect, it } from "vitest";

import { runImageProcessing } from "./image-processing-supervisor.mjs";

it("rejects a known wrong layer canvas before decoding its damaged pixels", async () => {
    const source = await sharp({ create: { width: 8, height: 6, channels: 4, background: "#667788" } })
        .png()
        .toBuffer();
    const native = await sharp({ create: { width: 16, height: 12, channels: 4, background: "#cc9966" } })
        .png()
        .toBuffer();
    const damaged = native.subarray(0, native.length - 20);
    // This fixture has a readable wrong canvas and cannot pass complete pixel decoding.
    expect(await sharp(damaged).metadata()).toMatchObject({ width: 16, height: 12 });
    await expect(sharp(damaged, { failOn: "error" }).raw().toBuffer()).rejects.toThrow();

    const directory = await mkdtemp(path.join(tmpdir(), "image-processing-layer-geometry-"));
    try {
        const outputDirectory = path.join(directory, "output");
        await mkdir(outputDirectory);
        const sourcePath = path.join(directory, "source");
        const nativePath = path.join(directory, "native");
        await writeFile(sourcePath, source);
        await writeFile(nativePath, damaged);
        const request = {
            version: "image-processing.v1",
            jobId: "layer-geometry",
            executionId: "layer-geometry-execution",
            operation: "process_result",
            outputDirectory,
            inputs: [
                { path: sourcePath, assetId: "source", assetVersion: "source-v1", expectedSha256: createHash("sha256").update(source).digest("hex") },
                { path: nativePath, assetId: "native", assetVersion: "native-v1", expectedSha256: createHash("sha256").update(damaged).digest("hex") },
            ],
            options: { mode: "layers", sourceInputIndex: 0, results: [{ resultId: "layer-result:1", resultIndex: 1, inputIndex: 1 }] },
        };
        const outcome = await runImageProcessing(request, { taskDirectory: directory, maxHeapMiB: 128 });
        expect(outcome.pid).toBeGreaterThan(0);
        expect(outcome.exitCode).toBe(0);
        expect(outcome.status, JSON.stringify(outcome)).toBe("rejected");
        expect(outcome.error).toEqual({ code: "invalid_layers", message: "分层结果尺寸与源图不一致，无法验证原图像素" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
