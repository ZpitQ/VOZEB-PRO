import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { expect, it } from "vitest";

import { runImageProcessing } from "./image-processing-supervisor.mjs";

it("rejects a known wrong scene mask canvas before decoding its damaged pixels", async () => {
    const source = await sharp({ create: { width: 8, height: 6, channels: 4, background: "#667788" } })
        .png()
        .toBuffer();
    const mask = await sharp({ create: { width: 16, height: 12, channels: 4, background: "#ffffff" } })
        .png()
        .toBuffer();
    const damaged = mask.subarray(0, mask.length - 20);
    const native = await sharp({ create: { width: 8, height: 6, channels: 4, background: "#abcdef" } })
        .png()
        .toBuffer();
    expect(await sharp(damaged).metadata()).toMatchObject({ width: 16, height: 12 });
    await expect(sharp(damaged).raw().toBuffer()).rejects.toThrow();
    const directory = await mkdtemp(path.join(tmpdir(), "image-processing-scene-mask-geometry-"));
    try {
        const outputDirectory = path.join(directory, "output");
        await mkdir(outputDirectory);
        const sourcePath = path.join(directory, "source.png");
        const maskPath = path.join(directory, "mask.png");
        const nativePath = path.join(directory, "native.png");
        await writeFile(sourcePath, source);
        await writeFile(maskPath, damaged);
        await writeFile(nativePath, native);
        const request = {
            version: "image-processing.v1",
            jobId: "scene-mask-geometry",
            executionId: "scene-mask-geometry-execution",
            operation: "process_result",
            outputDirectory,
            inputs: [
                { path: sourcePath, assetId: "source", assetVersion: "source-v1", expectedSha256: digest(source) },
                { path: maskPath, assetId: "mask", assetVersion: "mask-v1", expectedSha256: digest(damaged) },
                { path: nativePath, assetId: "native", assetVersion: "native-v1", expectedSha256: digest(native) },
            ],
            options: {
                mode: "scene_protection",
                sourceInputIndex: 0,
                maskInputIndex: 1,
                results: [{ resultId: "scene-result:1", resultIndex: 1, inputIndex: 2 }],
                protection: {
                    version: "scene-edit-protection.v1",
                    sourceAssetId: "source",
                    sourceSize: { width: 8, height: 6 },
                    sourceDigest: digest(source),
                    maskSize: { width: 8, height: 6 },
                    maskDigest: digest(damaged),
                    targetRegion: { x: 1, y: 1, width: 2, height: 2 },
                    semantics: ["selected background"],
                    selectionSource: "user_selection",
                    maskSemantics: "alpha_zero_edit",
                    method: "source_pixels_copy",
                },
            },
        };
        const outcome = await runImageProcessing(request, { taskDirectory: directory, maxHeapMiB: 128 });
        expect(outcome.pid).toBeGreaterThan(0);
        expect(outcome.exitCode).toBe(0);
        expect(outcome.status, JSON.stringify(outcome)).toBe("rejected");
        expect(outcome.error).toEqual({ code: "scene_protection_rejected", message: "蒙版尺寸必须与源图一致" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
