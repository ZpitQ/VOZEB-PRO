import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { expect, it } from "vitest";

import { runImageProcessing } from "./image-processing-supervisor.mjs";

it("reuses a qualified JPEG baseline when processing the same frozen source", async () => {
    const source = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#29537f" } })
        .jpeg()
        .withMetadata({ density: 144 })
        .toBuffer();
    expect(await sharp(source).metadata()).toMatchObject({ format: "jpeg", width: 32, height: 24, density: 144 });
    const directory = await mkdtemp(path.join(tmpdir(), "image-processing-jpeg-baseline-"));
    try {
        const buildDirectory = path.join(directory, "build");
        const processDirectory = path.join(directory, "process");
        await mkdir(buildDirectory);
        await mkdir(processDirectory);
        const sourcePath = path.join(directory, "source.jpeg");
        await writeFile(sourcePath, source);
        const input = { path: sourcePath, assetId: "jpeg-source", assetVersion: "jpeg-source-v1", expectedSha256: digest(source) };
        const execution = { taskDirectory: directory, maxHeapMiB: 128 };
        const built = await runImageProcessing(
            {
                version: "image-processing.v1",
                jobId: "jpeg-build",
                executionId: "jpeg-build-execution",
                operation: "build_protection",
                inputs: [input],
                outputDirectory: buildDirectory,
                options: { mode: "scene_selection", region: { x: 16, y: 12, width: 16, height: 12 }, semantics: ["replace the selected background"], selectionSource: "user_selection", freezeEnhancementBaseline: true },
            },
            execution,
        );
        expect(built.status, JSON.stringify(built)).toBe("completed");
        expect(built.result.geometry.enhancementBaseline).toMatchObject({ status: "qualified", scope: "local_edit", baseline: { sha256: digest(source), byteLength: source.length, width: 32, height: 24 } });
        const mask = built.result.artifacts[0];
        const native = await sharp({ create: { width: 32, height: 24, channels: 4, background: "#abcdef" } })
            .png()
            .toBuffer();
        const nativePath = path.join(directory, "native.png");
        await writeFile(nativePath, native);
        const outcome = await runImageProcessing(
            {
                version: "image-processing.v1",
                jobId: "jpeg-process",
                executionId: "jpeg-process-execution",
                operation: "process_result",
                outputDirectory: processDirectory,
                inputs: [input, { path: mask.path, assetId: "qualified-mask", assetVersion: mask.sha256, expectedSha256: mask.sha256 }, { path: nativePath, assetId: "native", assetVersion: "native-v1", expectedSha256: digest(native) }],
                options: {
                    mode: "scene_protection",
                    sourceInputIndex: 0,
                    maskInputIndex: 1,
                    results: [{ resultId: "jpeg-result:1", resultIndex: 1, inputIndex: 2 }],
                    protection: built.result.geometry.sceneProtection,
                    baseline: built.result.geometry.enhancementBaseline.baseline,
                },
            },
            execution,
        );
        expect(outcome.pid).toBeGreaterThan(0);
        expect(outcome.exitCode).toBe(0);
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        const final = await readFile(outcome.result.artifacts[0].path);
        const sourcePixels = await sharp(source).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer();
        const finalPixels = await sharp(final).ensureAlpha().raw().toBuffer();
        expect(finalPixels.subarray(0, 4)).toEqual(sourcePixels.subarray(0, 4));
        expect([...finalPixels.subarray((18 * 32 + 24) * 4, (18 * 32 + 24) * 4 + 4)]).toEqual([171, 205, 239, 255]);
        expect(outcome.result.results[0]).toMatchObject({
            resultId: "jpeg-result:1",
            resultIndex: 1,
            nativeInputIndex: 2,
            finalArtifactIndex: 0,
            baselineValidated: true,
            sceneProtectionEvidence: { compositeDigest: digest(final), compositeOutsideChangedPixels: 0 },
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
