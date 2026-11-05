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

async function task(bytes, operation = "prepare_reference", options = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), "image-processing-"));
    directories.push(directory);
    const outputDirectory = path.join(directory, "output");
    await mkdir(outputDirectory);
    const input = path.join(directory, "source");
    await writeFile(input, bytes);
    return {
        request: {
            version: "image-processing.v1",
            jobId: "job-one",
            executionId: "execution-one",
            operation,
            inputs: [{ path: input, assetId: "asset-one", assetVersion: "version-one", expectedSha256: digest(bytes) }],
            options,
            outputDirectory,
        },
        execution: { taskDirectory: directory, maxHeapMiB: 128 },
    };
}

function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

async function product(transparent = false) {
    const foreground = await sharp({ create: { width: 12, height: 10, channels: 4, background: "#2e5ba8" } })
        .png()
        .toBuffer();
    return sharp({ create: { width: 32, height: 24, channels: 4, background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : "#ffffff" } })
        .composite([{ input: foreground, left: 8, top: 6 }])
        .png()
        .toBuffer();
}

function expectExited(pid) {
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

describe("compiled image processing child", () => {
    it.each([false, true])("keeps the full-size %s-background mask and exact product geometry", async (transparentBackground) => {
        const setup = await task(await product(transparentBackground), "build_protection", { transparentBackground });
        const outcome = await runImageProcessing(setup.request, setup.execution);

        expect(outcome.status).toBe("completed");
        expect(outcome.result.jobId).toBe("job-one");
        expect(outcome.result.executionId).toBe("execution-one");
        expect(outcome.result.geometry).toEqual({
            sourceSize: { width: 32, height: 24 },
            productBounds: { x: 8, y: 6, width: 12, height: 10 },
            haloBounds: { x: 7, y: 5, width: 14, height: 12 },
        });
        const [artifact] = outcome.result.artifacts;
        expect(artifact).toMatchObject({ kind: "mask", width: 32, height: 24, mimeType: "image/png" });
        expect(path.relative(setup.execution.taskDirectory, artifact.path).startsWith("..")).toBe(false);
        const bytes = await readFile(artifact.path);
        expect(artifact.bytes).toBe(bytes.length);
        expect(artifact.sha256).toBe(digest(bytes));
        const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(decoded.info).toMatchObject({ width: 32, height: 24, channels: 4 });
        expect(decoded.data[3]).toBe(0);
        expect(decoded.data[(6 * 32 + 8) * 4 + 3]).toBe(255);
        expect(decoded.data[(15 * 32 + 19) * 4 + 3]).toBe(255);
        expect(decoded.data[(16 * 32 + 20) * 4 + 3]).toBe(0);
        expect(outcome.result.metrics.pid).toBe(outcome.pid);
        expect(outcome.result.metrics.peakRssBytes).toBeGreaterThan(0);
        expect(outcome.result.metrics.peakHeapUsedBytes).toBeGreaterThan(0);
        expect(outcome.result.metrics.peakExternalBytes).toBeGreaterThan(0);
        expectExited(outcome.pid);
    });

    it("preserves a small reference's original bytes and frozen source identity", async () => {
        const bytes = await product();
        const setup = await task(bytes);
        const outcome = await runImageProcessing(setup.request, setup.execution);

        expect(outcome.status).toBe("completed");
        expect(outcome.result.sourceIdentities).toEqual([{ assetId: "asset-one", assetVersion: "version-one", sha256: digest(bytes), bytes: bytes.length, mimeType: "image/png", width: 32, height: 24 }]);
        expect(outcome.result.geometry).toEqual({ sourceSize: { width: 32, height: 24 } });
        const [artifact] = outcome.result.artifacts;
        expect(artifact).toMatchObject({ kind: "analysis", sha256: digest(bytes), width: 32, height: 24 });
        expect(await readFile(artifact.path)).toEqual(bytes);
        expect(await readFile(setup.request.inputs[0].path)).toEqual(bytes);
        expectExited(outcome.pid);
    });

    it("uses EXIF display dimensions and a 1536x2048 analysis image without rewriting the original", async () => {
        const bytes = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: "#b4a28c" } })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toBuffer();
        const setup = await task(bytes);
        const outcome = await runImageProcessing(setup.request, setup.execution);

        expect(outcome.status).toBe("completed");
        expect(outcome.result.sourceIdentities[0]).toMatchObject({ sha256: digest(bytes), bytes: bytes.length, width: 1800, height: 2400, mimeType: "image/jpeg" });
        expect(outcome.result.geometry.sourceSize).toEqual({ width: 1800, height: 2400 });
        const [artifact] = outcome.result.artifacts;
        expect(artifact).toMatchObject({ kind: "analysis", width: 1536, height: 2048, mimeType: "image/jpeg" });
        expect(artifact.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(await sharp(artifact.path).metadata()).toMatchObject({ width: 1536, height: 2048 });
        expect(await readFile(setup.request.inputs[0].path)).toEqual(bytes);
        expectExited(outcome.pid);
    });

    it("rejects frozen hash mismatch and completes the next legal task", async () => {
        const setup = await task(await product());
        setup.request.inputs[0].expectedSha256 = "0".repeat(64);
        const failed = await runImageProcessing(setup.request, setup.execution);
        expect(failed).toMatchObject({ status: "rejected", error: { code: "source_hash_mismatch" }, exitCode: 0, signal: null });
        expectExited(failed.pid);

        const next = await task(await product());
        next.request.jobId = "job-two";
        next.request.executionId = "execution-two";
        const completed = await runImageProcessing(next.request, next.execution);
        expect(completed.status).toBe("completed");
        expect(completed.result).toMatchObject({ jobId: "job-two", executionId: "execution-two" });
        expect(completed.pid).not.toBe(failed.pid);
        expectExited(completed.pid);
    });

    it("rejects corrupt pixels rather than trusting an image header", async () => {
        const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#5c809c" } })
            .png()
            .toBuffer();
        const setup = await task(bytes.subarray(0, bytes.length - 24));
        const outcome = await runImageProcessing(setup.request, setup.execution);
        expect(outcome).toMatchObject({ status: "rejected", error: { code: "invalid_image" } });
        expectExited(outcome.pid);
    });

    it("rejects inputs outside the controlled task directory before spawning", async () => {
        const setup = await task(await product());
        const other = await task(await product());
        setup.request.inputs[0].path = other.request.inputs[0].path;
        await expect(runImageProcessing(setup.request, setup.execution)).rejects.toThrow("任务目录");
    });

    it("rejects an output directory outside the controlled task directory before spawning", async () => {
        const setup = await task(await product());
        const other = await task(await product());
        setup.request.outputDirectory = other.request.outputDirectory;
        await expect(runImageProcessing(setup.request, setup.execution)).rejects.toThrow("任务目录");
    });

    it("aborts only this execution and waits for its child to exit", async () => {
        const setup = await task(await product());
        const controller = new AbortController();
        const pending = runImageProcessing(setup.request, { ...setup.execution, signal: controller.signal });
        controller.abort();
        const outcome = await pending;
        expect(outcome).toMatchObject({ status: "aborted", jobId: "job-one", executionId: "execution-one" });
        expectExited(outcome.pid);

        const next = await task(await product());
        next.request.executionId = "execution-after-abort";
        const completed = await runImageProcessing(next.request, next.execution);
        expect(completed.status).toBe("completed");
        expect(completed.result.executionId).toBe("execution-after-abort");
        expectExited(completed.pid);
    });

    it("does not let inherited NODE_OPTIONS replace the explicit child heap", async () => {
        const setup = await task(await product());
        const previous = process.env.NODE_OPTIONS;
        process.env.NODE_OPTIONS = "--require=/must-not-be-inherited.cjs --max-old-space-size=4";
        try {
            const outcome = await runImageProcessing(setup.request, setup.execution);
            expect(outcome.status).toBe("completed");
            expectExited(outcome.pid);
        } finally {
            if (previous === undefined) delete process.env.NODE_OPTIONS;
            else process.env.NODE_OPTIONS = previous;
        }
    });

    it("contains a confirmed V8 heap failure and completes the next legal task", async () => {
        const failedTask = await task(await product(), "build_protection", {
            mode: "local_edit",
            targetRegion: { x: 8, y: 6, width: 12, height: 10 },
            protectedRectangles: Array.from({ length: 120000 }, () => ({ x: 0, y: 0, width: 1, height: 1 })),
        });
        const failed = await runImageProcessing(failedTask.request, { ...failedTask.execution, maxHeapMiB: 8 });
        expect(failed).toMatchObject({ status: "resource_failure", reason: "v8_heap_oom", jobId: "job-one", executionId: "execution-one" });
        expect(failed.stderr).toMatch(/FATAL ERROR:[^\r\n]*(?:heap out of memory|Reached heap limit|Ineffective mark-compacts)/i);
        expectExited(failed.pid);

        const next = await task(await product());
        next.request.jobId = "job-after-oom";
        next.request.executionId = "execution-after-oom";
        const completed = await runImageProcessing(next.request, next.execution);
        expect(completed.status).toBe("completed");
        expect(completed.result).toMatchObject({ jobId: "job-after-oom", executionId: "execution-after-oom" });
        expect(completed.pid).not.toBe(failed.pid);
        expectExited(completed.pid);
    });
});
