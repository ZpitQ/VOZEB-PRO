import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { expect } from "vitest";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";
import { imageProcessingResourceConfig } from "../image-processing/resource-config";
import type { ClaimedImageProcessingTask, StoredImageProcessingArtifact } from "./image-processing-service";

export async function completeClaimedImageProcessingFixture(child: ClaimedImageProcessingTask, workerId: string, directory: string) {
    const service = await import("./image-processing-service");
    const identity = { workerId, executionId: child.executionId };
    const taskDirectory = await mkdtemp(path.join(directory, "image-cpu-"));
    const inputs = [];
    for (const [index, input] of child.payload.inputs.entries()) {
        const sourcePath = path.join(taskDirectory, `input-${index}`);
        const source = await service.readImageProcessingInput(child.id, input.assetId, identity);
        await pipeline(source.stream, createWriteStream(sourcePath, { flags: "wx" }));
        inputs.push({ ...input, path: sourcePath });
    }
    const outputDirectory = path.join(taskDirectory, "outputs");
    await mkdir(outputDirectory);
    const outcome = await runImageProcessing({ ...child.payload, jobId: child.id, executionId: child.executionId, inputs, outputDirectory }, { taskDirectory, maxHeapMiB: child.payload.resource.configuration.processHeapMb });
    expect(outcome).toMatchObject({ status: "completed", jobId: child.id, executionId: child.executionId, exitCode: 0, signal: null });
    assert.ok(outcome.status === "completed");
    expect(outcome.result.metrics.pid).toBeGreaterThan(0);
    expect(outcome.result.metrics.pid).not.toBe(process.pid);
    const artifacts: StoredImageProcessingArtifact[] = [];
    for (const artifact of outcome.result.artifacts) {
        const response = new Response(new Uint8Array(await readFile(artifact.path)));
        assert.ok(response.body);
        const stored = await service.writeImageProcessingOutput(child.id, artifact.kind, identity, { mimeType: artifact.mimeType, stream: response.body, ...(artifact.resultId ? { resultId: artifact.resultId } : {}) });
        expect(stored).toMatchObject({ kind: artifact.kind, sha256: artifact.sha256, bytes: artifact.bytes, width: artifact.width, height: artifact.height });
        artifacts.push(stored);
    }
    const { metrics, ...result } = outcome.result;
    const manifest = { ...result, artifacts };
    const receipt = await service.completeImageProcessingTask(child.id, { ...identity, manifest, metrics });
    expect(receipt).toMatchObject({ jobId: child.id, executionId: child.executionId, manifest });
    return { manifest, metrics, receipt };
}

// Call after the Agent has linked its child; both image epochs and the CPU receipt are real.
export async function completeImageTaskResultFixture(imageId: string, input: { origin: string; cookie: string; directory: string }) {
    const [images, runtime, scheduler, processing, results, contract] = await Promise.all([
        import("./image-task-store"),
        import("./image-task-runtime"),
        import("./generation-task-scheduler"),
        import("./image-processing-service"),
        import("./image-task-result-processing"),
        import("./image-task-result-contract"),
    ]);
    const current = await images.getImageTask(imageId);
    assert.ok(current);
    if (current.status === "success") return current;
    const workerId = "fixture-image-acquisition-" + randomUUID();
    const claims = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [imageId], limit: 1 });
    expect(claims).toHaveLength(1);
    const task = await images.getImageTask(imageId);
    assert.ok(task?.executionId);
    expect(task.executionId).toBe(claims[0].executionId);
    if (!task.upstream) expect(await runtime.createImageTaskUpstreamStep(task, input.origin, input.origin, input.cookie)).toMatchObject({ state: "pending" });
    const submitted = await images.getImageTask(imageId);
    assert.ok(submitted);
    const step = await runtime.queryImageTaskUpstreamStep(submitted, input.origin, input.cookie);
    expect(step).toMatchObject({ state: "result_ready" });
    assert.ok(step.state === "result_ready");
    const sealed = await images.getImageTask(imageId);
    assert.ok(sealed);
    const waiting = await runtime.persistImageTaskResult(sealed, input.origin, step.resultUrl, input.cookie);
    assert.ok(waiting);
    if (waiting.status === "success") {
        expect(contract.usesImageTaskResultProcessing(sealed)).toBe(false);
        return waiting;
    }
    expect(contract.usesImageTaskResultProcessing(sealed)).toBe(true);
    assert.ok(waiting.nativeResults && waiting.resultProcessing);
    expect(waiting.status).toBe("running");
    const cpuId = "fixture-image-result-cpu-" + randomUUID();
    const { profileVersion, budgetBytes } = imageProcessingResourceConfig(process.env);
    const claimed = await processing.claimImageProcessingTasks({ workerId: cpuId, profileVersion, availableMemoryBytes: budgetBytes, slots: 1 });
    expect(claimed.tasks).toHaveLength(1);
    const child = claimed.tasks[0];
    expect(child.id).toBe(waiting.resultProcessing.jobId);
    expect(child.payload.operation).toBe("process_result");
    const { receipt } = await completeClaimedImageProcessingFixture(child, cpuId, input.directory);
    expect(receipt.parentRescheduled).toBe(true);
    const consumerId = "fixture-image-consumer-" + randomUUID();
    const consumers = await scheduler.claimDueGenerationTasks({ workerId: consumerId, taskIds: [imageId], limit: 1 });
    expect(consumers).toHaveLength(1);
    const consumer = await images.getImageTask(imageId);
    assert.ok(consumer?.executionId);
    expect(consumer.executionId).toBe(consumers[0].executionId);
    expect(consumer.executionId).not.toBe(task.executionId);
    expect(await results.consumeCompletedImageTaskResultProcessing({ taskId: imageId, workerId: consumerId, executionId: consumer.executionId })).toEqual({ state: "completed" });
    const completed = await images.getImageTask(imageId);
    assert.ok(completed);
    expect(completed).toMatchObject({ status: "success", nativeResults: waiting.nativeResults, resultProcessing: waiting.resultProcessing });
    return completed;
}

// Read the physical artifact; QA transport may intentionally reject this URL.
export async function readImageTaskResultBytesFixture(url: string) {
    if (url.startsWith("/api/reference-assets/")) {
        const { readReferenceAsset } = await import("./reference-asset-store");
        const asset = await readReferenceAsset(decodeURIComponent(url.slice("/api/reference-assets/".length)));
        assert.ok(asset?.registration);
        return readFile(asset.filePath);
    }
    const { localAssetUrlToPath } = await import("./generation-log-repository");
    return readFile(localAssetUrlToPath(url));
}
