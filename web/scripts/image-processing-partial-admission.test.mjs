import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { expect, it } from "vitest";

import { decideImageProcessingAdmission, estimateImageProcessingMemory } from "../.image-processing-runtime/lib/image-processing/resource-model.js";
import { runImageProcessing } from "./image-processing-supervisor.mjs";

it("admits a good result beside a hash-bound native whose metadata actually failed", async () => {
    const bad = Buffer.from("not an image");
    const good = await sharp({ create: { width: 6, height: 4, channels: 4, background: "#0044bb" } })
        .png()
        .toBuffer();
    await expect(sharp(bad).metadata()).rejects.toThrow();
    const layout = await sharp(good).metadata();
    const directory = await mkdtemp(path.join(tmpdir(), "image-processing-partial-admission-"));
    try {
        const outputDirectory = path.join(directory, "output");
        await mkdir(outputDirectory);
        const badPath = path.join(directory, "bad-native");
        const goodPath = path.join(directory, "good-native.png");
        await writeFile(badPath, bad);
        await writeFile(goodPath, good);
        const request = {
            version: "image-processing.v1",
            jobId: "partial-admission",
            executionId: "partial-admission-execution",
            operation: "process_result",
            outputDirectory,
            inputs: [
                { path: badPath, assetId: "bad-native", assetVersion: "bad-v1", expectedSha256: digest(bad) },
                { path: goodPath, assetId: "good-native", assetVersion: "good-v1", expectedSha256: digest(good) },
            ],
            options: {
                mode: "ordinary",
                transparentBackground: false,
                results: [
                    { resultId: "partial:1", resultIndex: 1, inputIndex: 0 },
                    { resultId: "partial:2", resultIndex: 2, inputIndex: 1 },
                ],
            },
        };
        const estimate = estimateImageProcessingMemory(request, {
            encodedInputs: [
                { inputIndex: 0, assetId: "bad-native", assetVersion: "bad-v1", sha256: digest(bad), bytes: bad.length, metadataRejected: true },
                { inputIndex: 1, assetId: "good-native", assetVersion: "good-v1", sha256: digest(good), bytes: good.length, layout: { format: layout.format, depth: layout.depth, channels: layout.channels } },
            ],
            decodedInputs: [],
        });
        expect(estimate.status).toBe("calibrated");
        expect(decideImageProcessingAdmission(estimate, { totalMemoryBytes: 1536 * 1024 * 1024, availableMemoryBytes: 1536 * 1024 * 1024, availableSlots: 1 }).status).toBe("admit");
        const outcome = await runImageProcessing(request, { taskDirectory: directory, maxHeapMiB: 128 });
        expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
        expect(outcome.result.sourceIdentities[0]).toMatchObject({ assetId: "bad-native", assetVersion: "bad-v1", sha256: digest(bad), bytes: 12, decodeError: { code: "invalid_result", message: expect.any(String) } });
        expect(outcome.result.sourceIdentities[0]).not.toHaveProperty("width");
        expect(outcome.result.results).toMatchObject([
            { resultId: "partial:1", resultIndex: 1, nativeInputIndex: 0, error: { code: "invalid_result", failureStage: "decode" } },
            { resultId: "partial:2", resultIndex: 2, nativeInputIndex: 1, finalArtifactIndex: 0 },
        ]);
        expect(outcome.result.artifacts).toHaveLength(1);
        expect(await readFile(outcome.result.artifacts[0].path)).toEqual(good);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
