import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CompleteImageProcessingInput } from "./image-processing-service";

describe("File completed result reuse by the actual ImageTask owner", () => {
    let directory: string;
    let userId: string;
    let source: Buffer;
    let imageTasks: typeof import("./image-task-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let capture: typeof import("./image-task-native-capture");
    let processing: typeof import("./image-task-result-processing");
    let service: typeof import("./image-processing-service");
    let operations: typeof import("@/lib/image-processing/operations");
    let registrations: typeof import("./local-media-registry");
    let media: typeof import("./local-media-storage");
    let references: typeof import("./reference-asset-store");
    const imageWorkerId = "fixture-result-complete-image-worker";
    const childWorkerId = "fixture-result-complete-child-worker";

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-result-complete-wake-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        [imageTasks, tasks, scheduler, capture, processing, service, operations, registrations, media, references] = await Promise.all([
            import("./image-task-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./image-task-native-capture"),
            import("./image-task-result-processing"),
            import("./image-processing-service"),
            import("@/lib/image-processing/operations"),
            import("./local-media-registry"),
            import("./local-media-storage"),
            import("./reference-asset-store"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        assert.equal((await getObjectStorageRuntimeConfig()).enabled, false);
        userId = `fixture-result-complete-${randomUUID()}`;
        source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 24, g: 48, b: 72 } } })
            .png()
            .toBuffer();
    }, 30_000);

    afterAll(async () => {
        try {
            if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    async function ownedRows() {
        return tasks.withGenerationTaskFileMutation(async (records) => ({
            tasks: records,
            result: records.filter((record) => record.userId === userId).toSorted((left, right) => left.id.localeCompare(right.id)),
        }));
    }

    async function ownedRegistrations() {
        return (await registrations.listFileLocalMediaRegistrations()).filter((record) => record.ownerUserId === userId).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey));
    }

    async function snapshot(nativePath: string, finalPath: string) {
        return { rows: await ownedRows(), registrations: await ownedRegistrations(), nativeBytes: await readFile(nativePath), finalBytes: await readFile(finalPath) };
    }

    it("returns ready without yielding a new image execution after its actual result child completed", async () => {
        expect(source).toHaveLength(95);
        expect(createHash("sha256").update(source).digest("hex")).toBe("a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6");
        const image = await imageTasks.createImageTask({
            userId,
            username: "fixture-result-complete",
            displayName: "Isolated result completion fixture",
            kind: "generation",
            source: "image-workbench",
            config: { baseUrl: "https://fixture.invalid", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model", outputBackground: "opaque" },
            prompt: "Complete local processing while leaving final ImageTask publication to its consumer",
            references: [],
            attemptNo: 1,
            attempts: [],
        });
        assert.ok(await imageTasks.transitionImageTask(image, ["pending"], { status: "running" }));
        assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: 1 }));
        const imageClaims = await scheduler.claimDueGenerationTasks({ workerId: imageWorkerId, taskIds: [image.id], limit: 1 });
        expect(imageClaims).toHaveLength(1);
        const imageClaim = imageClaims[0];
        assert.ok(imageClaim?.executionId);
        assert.ok(imageClaim.workerId);
        const imageIdentity = { taskId: image.id, workerId: imageClaim.workerId, executionId: imageClaim.executionId };
        expect(
            await capture.captureImageTaskNativeResults({ ...imageIdentity, attemptNo: 1, upstreamTaskId: null, result: { dataUrl: `data:image/png;base64,${source.toString("base64")}` }, origin: "https://fixture.invalid", authContext: "" }),
        ).toMatchObject({ state: "native_ready" });

        // All following native comparisons use the actual persisted File representation.
        const sealed = await imageTasks.getImageTask(image.id);
        assert.ok(sealed?.nativeResults);
        expect(sealed.nativeResults.slots).toHaveLength(1);
        const slot = sealed.nativeResults.slots[0];
        assert.ok(slot?.status === "stored");
        expect(slot).toMatchObject({ resultId: `${image.id}:1`, resultIndex: 1, scope: "reference", storageProvider: "local", sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6", bytes: 95 });
        const nativePath = path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey);
        expect(await readFile(nativePath)).toEqual(source);
        expect(await processing.ensureImageTaskResultProcessing(imageIdentity)).toStrictEqual({ state: "waiting" });
        const waiting = await imageTasks.getImageTask(image.id);
        assert.ok(waiting?.resultProcessing);
        const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
        const childClaims = await service.claimImageProcessingTasks({ workerId: childWorkerId, profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
        expect(childClaims.tasks).toHaveLength(1);
        const childClaim = childClaims.tasks[0];
        assert.ok(childClaim);
        expect(childClaim.id).toBe(waiting.resultProcessing.jobId);
        expect(childClaim.leaseUntil).toBeGreaterThan(Date.now());
        const payload = childClaim.payload;
        assert.ok(payload.operation === "process_result");
        assert.ok(payload.options.mode === "ordinary");
        expect(payload.options).toStrictEqual({ mode: "ordinary", results: [{ resultId: slot.resultId, resultIndex: 1, inputIndex: 0 }], transparentBackground: false });
        expect(payload.inputs).toStrictEqual([{ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: slot.sha256 }]);
        expect(payload.imageResultBinding).toStrictEqual({ imageTaskId: image.id, userId, nativeResults: sealed.nativeResults });
        const input = payload.inputs[0];
        assert.ok(input);
        const outputDirectory = await mkdtemp(path.join(directory, "ordinary-operation-"));
        const result = await operations.executeImageProcessing({ ...payload, jobId: childClaim.id, executionId: childClaim.executionId, inputs: [{ ...input, path: nativePath }], outputDirectory }, () => {});
        expect(result.sourceIdentities).toStrictEqual([{ assetId: slot.assetId, assetVersion: slot.assetVersion, sha256: slot.sha256, bytes: 95, mimeType: "image/png", width: 2, height: 2, nativeImage: { format: "png", hasAlpha: false } }]);
        expect(result.results).toStrictEqual([{ resultId: slot.resultId, resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 0 }]);
        expect(result.geometry).toStrictEqual({});
        expect(result.artifacts).toHaveLength(1);
        const final = result.artifacts[0];
        assert.ok(final);
        expect(final).toStrictEqual({ kind: "final", path: expect.any(String), sha256: slot.sha256, mimeType: "image/png", bytes: 95, width: 2, height: 2, resultId: slot.resultId, resultIndex: 1 });
        const finalBytes = await readFile(final.path);
        expect(finalBytes).toEqual(source);
        const response = new Response(new Uint8Array(finalBytes));
        assert.ok(response.body);
        const childIdentity = { workerId: childWorkerId, executionId: childClaim.executionId };
        const stored = await service.writeImageProcessingOutput(childClaim.id, "final", childIdentity, { stream: response.body, mimeType: final.mimeType, resultId: slot.resultId });
        expect(stored).toStrictEqual({ kind: "final", storageKey: expect.any(String), sha256: final.sha256, mimeType: final.mimeType, bytes: 95, width: 2, height: 2, resultId: slot.resultId, resultIndex: 1 });
        const registered = await references.readReferenceAsset(stored.storageKey);
        assert.ok(registered);
        const before = await snapshot(nativePath, registered.filePath);
        expect(before.rows).toHaveLength(2);
        expect(before.registrations).toHaveLength(2);
        expect(before.nativeBytes).toEqual(source);
        expect(before.finalBytes).toEqual(finalBytes);
        expect(before.registrations.find((record) => record.storageKey === slot.storageKey)).toMatchObject({
            ownerUserId: userId,
            taskId: image.id,
            scope: "reference",
            storageClass: "permanent",
            type: "attachment",
            storageProvider: "local",
            mimeType: "application/octet-stream",
            bytes: 95,
        });
        expect(before.registrations.find((record) => record.storageKey === stored.storageKey)).toMatchObject({
            ownerUserId: userId,
            taskId: childClaim.id,
            scope: "reference",
            storageClass: "temporary",
            type: "image",
            storageProvider: "local",
            mimeType: "image/png",
            bytes: 95,
        });
        const beforeImage = before.rows.find((record) => record.type === "image" && record.id === image.id);
        const beforeChild = before.rows.find((record) => record.type === "image_processing" && record.id === childClaim.id);
        assert.ok(beforeImage);
        assert.ok(beforeChild);
        expect(beforeImage).toMatchObject({ status: "running", executionPhase: "persisting", payload: { status: "running", nativeResults: sealed.nativeResults, resultProcessing: waiting.resultProcessing } });
        expect(beforeImage.nextPollAt).toBeUndefined();
        expect(beforeImage.workerId).toBeUndefined();
        expect(beforeImage.leaseUntil).toBeUndefined();
        expect(beforeImage.payload.executionId).toBeUndefined();
        expect(beforeImage.payload.result).toBeUndefined();
        expect(beforeImage.payload.billing).toBeUndefined();
        expect(beforeImage.runId).toBeUndefined();
        expect(beforeChild).toMatchObject({ status: "running", parentTaskId: image.id, payload: { executionId: childClaim.executionId, inputDigest: waiting.resultProcessing.inputDigest } });
        expect(beforeChild.resultPayload).toStrictEqual({ executionId: childClaim.executionId, artifacts: [stored] });
        const { workerId: ownedWorkerId, leaseUntil, lastHeartbeatAt, nextPollAt, ...closedChildBase } = beforeChild;
        expect(ownedWorkerId).toBe(childWorkerId);
        expect(leaseUntil).toBe(childClaim.leaseUntil);
        expect(lastHeartbeatAt).toBeTypeOf("number");
        expect(nextPollAt).toBeTypeOf("number");
        // Service DTO telemetry fixture; independent child metrics remain a separate Worker gate.
        const metrics: CompleteImageProcessingInput["metrics"] = { pid: process.pid, peakRssBytes: 64 * 1024 * 1024, peakHeapUsedBytes: 8 * 1024 * 1024, peakExternalBytes: 4 * 1024 * 1024, elapsedMs: 12 };
        const completion: CompleteImageProcessingInput = {
            ...childIdentity,
            manifest: { jobId: result.jobId, executionId: result.executionId, sourceIdentities: result.sourceIdentities, artifacts: [stored], results: result.results, geometry: result.geometry },
            metrics,
        };

        try {
            const startedAt = Date.now();
            const receipt = await service.completeImageProcessingTask(childClaim.id, completion).catch(async (error: unknown) => {
                expect(await snapshot(nativePath, registered.filePath)).toStrictEqual(before);
                throw error;
            });
            const completedAt = Date.now();
            const after = await snapshot(nativePath, registered.filePath);
            expect(receipt).toStrictEqual({ jobId: childClaim.id, inputDigest: payload.inputDigest, executionId: childClaim.executionId, manifest: completion.manifest, parentRescheduled: true });
            const expectedImage = {
                ...beforeImage,
                updatedAt: expect.any(Number),
                payload: { ...beforeImage.payload, updatedAt: expect.any(Number) },
                executionPhase: "persisting",
                nextPollAt: expect.any(Number),
                lastUpstreamStatus: "image_processing_completed",
            };
            const expectedChild = {
                ...closedChildBase,
                status: "success",
                executionPhase: "completed",
                updatedAt: expect.any(Number),
                lastUpstreamStatus: "completed",
                resultPayload: { ...childIdentity, manifest: completion.manifest, manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/), metrics, parentRescheduled: true },
            };
            expect(after).toStrictEqual({ ...before, rows: [expectedImage, expectedChild].toSorted((left, right) => left.id.localeCompare(right.id)) });
            const awakened = after.rows.find((record) => record.id === image.id);
            assert.ok(awakened);
            expect(awakened.nextPollAt).toBeGreaterThanOrEqual(startedAt);
            expect(awakened.nextPollAt).toBeLessThanOrEqual(completedAt);

            expect(await service.completeImageProcessingTask(childClaim.id, completion)).toStrictEqual(receipt);
            expect(await snapshot(nativePath, registered.filePath)).toStrictEqual(after);

            const consumerWorkerId = "fixture-result-complete-consumer-worker";
            const consumerClaims = await scheduler.claimDueGenerationTasks({ workerId: consumerWorkerId, taskIds: [image.id], limit: 1 });
            expect(consumerClaims).toHaveLength(1);
            const consumer = consumerClaims[0];
            assert.ok(consumer?.executionId);
            expect(consumer.id).toBe(image.id);
            expect(consumer.workerId).toBe(consumerWorkerId);
            expect(consumer.executionId).not.toBe(imageIdentity.executionId);
            expect(consumer.leaseUntil).toBeGreaterThan(Date.now());
            const beforeReuse = await snapshot(nativePath, registered.filePath);
            expect(beforeReuse.rows).toHaveLength(2);
            expect(beforeReuse.rows.find((record) => record.id === image.id)).toMatchObject({
                status: "running",
                executionPhase: "persisting",
                workerId: consumerWorkerId,
                leaseUntil: consumer.leaseUntil,
                payload: { executionId: consumer.executionId, resultProcessing: waiting.resultProcessing, nativeResults: sealed.nativeResults },
            });
            expect(beforeReuse.rows.find((record) => record.id === childClaim.id)).toStrictEqual(after.rows.find((record) => record.id === childClaim.id));
            try {
                const outcome = await processing.ensureImageTaskResultProcessing({ taskId: image.id, workerId: consumerWorkerId, executionId: consumer.executionId });
                expect(outcome).toStrictEqual({ state: "ready" });
            } finally {
                expect(await snapshot(nativePath, registered.filePath)).toStrictEqual(beforeReuse);
            }
        } finally {
            expect(await ownedRegistrations()).toStrictEqual(before.registrations);
            expect(await readFile(nativePath)).toEqual(before.nativeBytes);
            expect(await readFile(registered.filePath)).toEqual(before.finalBytes);
        }
    }, 30_000);
});
