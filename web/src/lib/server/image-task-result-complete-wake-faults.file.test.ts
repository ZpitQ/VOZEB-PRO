import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredGenerationTaskRecord } from "./generation-task-types";
import type { CompleteImageProcessingInput } from "./image-processing-service";

describe("File result completion ownership, rejection and semantic replay", () => {
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
    const imageWorkerId = "fixture-result-complete-fault-image-worker";
    const childWorkerId = "fixture-result-complete-fault-child-worker";

    beforeEach(async () => {
        vi.resetModules();
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-result-complete-fault-"));
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
        userId = `fixture-result-complete-fault-${randomUUID()}`;
        source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 24, g: 48, b: 72 } } })
            .png()
            .toBuffer();
    }, 30_000);

    afterEach(async () => {
        try {
            if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    async function mediaSnapshot(nativePath: string, finalPath: string) {
        return {
            registrations: (await registrations.listFileLocalMediaRegistrations()).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey)),
            nativeBytes: await readFile(nativePath),
            finalBytes: await readFile(finalPath),
            fileEntries: (await readdir(directory, { recursive: true })).toSorted(),
        };
    }

    async function snapshot(nativePath: string, finalPath: string) {
        const { readJsonDataFile } = await import("./data-adapter");
        const all = await readJsonDataFile<StoredGenerationTaskRecord[]>(tasks.GENERATION_TASK_FILE, []);
        return { rows: all.toSorted((left, right) => left.id.localeCompare(right.id)), ...(await mediaSnapshot(nativePath, finalPath)) };
    }

    async function stagedResult() {
        expect(source).toHaveLength(95);
        expect(createHash("sha256").update(source).digest("hex")).toBe("a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6");
        const image = await imageTasks.createImageTask({
            userId,
            username: "fixture-result-complete-fault",
            displayName: "Isolated result completion fault fixture",
            kind: "generation",
            source: "image-workbench",
            config: { baseUrl: "https://fixture.invalid", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model", outputBackground: "opaque" },
            prompt: "Protect original ImageTask ownership while closing its actual result child",
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
        const profileVersion = imageProcessingResourceConfig(process.env).profileVersion;
        const childClaims = await service.claimImageProcessingTasks({ workerId: childWorkerId, profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
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
        expect(result.results).toStrictEqual([{ resultId: slot.resultId, resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 0, finalImage: { format: "png", hasAlpha: false } }]);
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
        expect(stored.storageKey).not.toBe(slot.storageKey);
        const registered = await references.readReferenceAsset(stored.storageKey);
        assert.ok(registered);
        const ready = await snapshot(nativePath, registered.filePath);
        expect(ready.rows).toHaveLength(2);
        expect(ready.registrations).toHaveLength(2);
        expect(ready.nativeBytes).toEqual(source);
        expect(ready.finalBytes).toEqual(finalBytes);
        expect(ready.registrations.find((record) => record.storageKey === slot.storageKey)).toMatchObject({
            ownerUserId: userId,
            taskId: image.id,
            scope: "reference",
            storageClass: "permanent",
            type: "attachment",
            storageProvider: "local",
            mimeType: "application/octet-stream",
            bytes: 95,
        });
        expect(ready.registrations.find((record) => record.storageKey === stored.storageKey)).toMatchObject({
            ownerUserId: userId,
            taskId: childClaim.id,
            scope: "reference",
            storageClass: "temporary",
            type: "image",
            storageProvider: "local",
            mimeType: "image/png",
            bytes: 95,
        });
        const imageRow = ready.rows.find((record) => record.type === "image" && record.id === image.id);
        const childRow = ready.rows.find((record) => record.type === "image_processing" && record.id === childClaim.id);
        assert.ok(imageRow);
        assert.ok(childRow);
        expect(imageRow).toMatchObject({ status: "running", executionPhase: "persisting", payload: { status: "running", nativeResults: sealed.nativeResults, resultProcessing: waiting.resultProcessing } });
        expect(imageRow.nextPollAt).toBeUndefined();
        expect(imageRow.workerId).toBeUndefined();
        expect(imageRow.leaseUntil).toBeUndefined();
        expect(imageRow.payload.executionId).toBeUndefined();
        expect(imageRow.payload.result).toBeUndefined();
        expect(imageRow.payload.billing).toBeUndefined();
        expect(imageRow.runId).toBeUndefined();
        expect(childRow).toMatchObject({ status: "running", parentTaskId: image.id, payload: { executionId: childClaim.executionId, inputDigest: waiting.resultProcessing.inputDigest } });
        expect(childRow.resultPayload).toStrictEqual({ executionId: childClaim.executionId, artifacts: [stored] });
        // Service DTO telemetry fixture; independent child measurements remain a Worker gate.
        const metrics: CompleteImageProcessingInput["metrics"] = { pid: process.pid, peakRssBytes: 64 * 1024 * 1024, peakHeapUsedBytes: 8 * 1024 * 1024, peakExternalBytes: 4 * 1024 * 1024, elapsedMs: 12 };
        const completion: CompleteImageProcessingInput = {
            ...childIdentity,
            manifest: { jobId: result.jobId, executionId: result.executionId, sourceIdentities: result.sourceIdentities, artifacts: [stored], results: result.results, geometry: result.geometry },
            metrics,
        };
        return { image, imageIdentity, slot, childClaim, childIdentity, payload, profileVersion, stored, completion, snapshot: () => snapshot(nativePath, registered.filePath), mediaSnapshot: () => mediaSnapshot(nativePath, registered.filePath) };
    }

    type Fixture = Awaited<ReturnType<typeof stagedResult>>;
    type Snapshot = Awaited<ReturnType<typeof snapshot>>;

    function closedChild(fixture: Fixture, before: Snapshot["rows"][number], parentRescheduled: boolean) {
        const { workerId, leaseUntil, lastHeartbeatAt, nextPollAt, ...base } = before;
        expect(workerId).toBe(childWorkerId);
        expect(leaseUntil).toBe(fixture.childClaim.leaseUntil);
        expect(lastHeartbeatAt).toBeTypeOf("number");
        expect(nextPollAt).toBeTypeOf("number");
        return {
            ...base,
            status: "success",
            executionPhase: "completed",
            updatedAt: expect.any(Number),
            lastUpstreamStatus: "completed",
            resultPayload: { ...fixture.childIdentity, manifest: fixture.completion.manifest, manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/), metrics: fixture.completion.metrics, parentRescheduled },
        };
    }

    async function assertMediaUnchanged(fixture: Fixture, before: Snapshot) {
        expect(await fixture.mediaSnapshot()).toStrictEqual({ registrations: before.registrations, nativeBytes: before.nativeBytes, finalBytes: before.finalBytes, fileEntries: before.fileEntries });
    }

    async function closeWithoutWaking(fixture: Fixture, before: Snapshot) {
        const receipt = await service.completeImageProcessingTask(fixture.childClaim.id, fixture.completion).catch(async (error: unknown) => {
            expect(await fixture.snapshot()).toStrictEqual(before);
            throw error;
        });
        const after = await fixture.snapshot();
        const image = before.rows.find((record) => record.type === "image" && record.id === fixture.image.id);
        const child = before.rows.find((record) => record.type === "image_processing" && record.id === fixture.childClaim.id);
        assert.ok(image);
        assert.ok(child);
        expect(after).toStrictEqual({ ...before, rows: [image, closedChild(fixture, child, false)].toSorted((left, right) => left.id.localeCompare(right.id)) });
        expect(receipt).toStrictEqual({ jobId: fixture.childClaim.id, inputDigest: fixture.payload.inputDigest, executionId: fixture.childClaim.executionId, manifest: fixture.completion.manifest, parentRescheduled: false });
        return { receipt, after };
    }

    async function closeAndWake(fixture: Fixture, before: Snapshot) {
        const startedAt = Date.now();
        const receipt = await service.completeImageProcessingTask(fixture.childClaim.id, fixture.completion).catch(async (error: unknown) => {
            expect(await fixture.snapshot()).toStrictEqual(before);
            throw error;
        });
        const completedAt = Date.now();
        const after = await fixture.snapshot();
        const image = before.rows.find((record) => record.type === "image" && record.id === fixture.image.id);
        const child = before.rows.find((record) => record.type === "image_processing" && record.id === fixture.childClaim.id);
        assert.ok(image);
        assert.ok(child);
        const awakened = { ...image, payload: { ...image.payload, updatedAt: expect.any(Number) }, updatedAt: expect.any(Number), executionPhase: "persisting", nextPollAt: expect.any(Number), lastUpstreamStatus: "image_processing_completed" };
        expect(after).toStrictEqual({ ...before, rows: [awakened, closedChild(fixture, child, true)].toSorted((left, right) => left.id.localeCompare(right.id)) });
        expect(receipt).toStrictEqual({ jobId: fixture.childClaim.id, inputDigest: fixture.payload.inputDigest, executionId: fixture.childClaim.executionId, manifest: fixture.completion.manifest, parentRescheduled: true });
        const savedImage = after.rows.find((record) => record.id === fixture.image.id);
        assert.ok(savedImage);
        expect(savedImage.nextPollAt).toBeGreaterThanOrEqual(startedAt);
        expect(savedImage.nextPollAt).toBeLessThanOrEqual(completedAt);
        return { receipt, after };
    }

    it("keeps a genuinely claimed new image owner and its entire row unchanged while closing and replaying the child", async () => {
        const fixture = await stagedResult();
        const dueAt = Date.now();
        assert.ok(await scheduler.scheduleGenerationTask("image", fixture.image.id, { executionPhase: "persisting", nextPollAt: dueAt }));
        const claims = await scheduler.claimDueGenerationTasks({ workerId: "fixture-result-complete-new-image-worker", taskIds: [fixture.image.id], limit: 1 });
        expect(claims).toHaveLength(1);
        const claim = claims[0];
        assert.ok(claim?.executionId);
        expect(claim.executionId).not.toBe(fixture.imageIdentity.executionId);
        expect(claim.workerId).toBe("fixture-result-complete-new-image-worker");
        expect(claim.leaseUntil).toBeGreaterThan(Date.now());
        const before = await fixture.snapshot();
        expect(before.rows.find((record) => record.id === fixture.image.id)).toMatchObject({
            workerId: claim.workerId,
            leaseUntil: claim.leaseUntil,
            lastHeartbeatAt: expect.any(Number),
            nextPollAt: dueAt,
            executionPhase: "persisting",
            payload: { executionId: claim.executionId },
        });
        try {
            const { receipt, after } = await closeWithoutWaking(fixture, before);
            try {
                expect(await service.completeImageProcessingTask(fixture.childClaim.id, fixture.completion)).toStrictEqual(receipt);
            } finally {
                expect(await fixture.snapshot()).toStrictEqual(after);
            }
        } finally {
            await assertMediaUnchanged(fixture, before);
        }
    }, 30_000);

    it.each([
        {
            name: "cancelled",
            change: async (fixture: Fixture) => {
                const current = await imageTasks.getImageTask(fixture.image.id);
                assert.ok(current);
                assert.ok(await imageTasks.transitionImageTask(current, ["running"], { status: "cancelled" }));
                expect(await imageTasks.getImageTask(fixture.image.id)).toMatchObject({ status: "cancelled" });
            },
        },
        {
            name: "a changed business attempt",
            change: async (fixture: Fixture) => {
                assert.ok(await imageTasks.updateImageTask(fixture.image.id, { attemptNo: 2 }));
                expect(await imageTasks.getImageTask(fixture.image.id)).toMatchObject({ status: "running", attemptNo: 2 });
            },
        },
    ])(
        "closes the qualified child without waking or rewriting a parent with $name",
        async ({ change }) => {
            const fixture = await stagedResult();
            await change(fixture);
            const before = await fixture.snapshot();
            try {
                await closeWithoutWaking(fixture, before);
            } finally {
                await assertMediaUnchanged(fixture, before);
            }
        },
        30_000,
    );

    it("rejects the actual old child tuple after a real replacement claim without changing the new owner's state", async () => {
        const fixture = await stagedResult();
        const expiredAt = Date.now() - 1;
        await tasks.withGenerationTaskFileMutation(async (records) => {
            const current = records.find((record) => record.type === "image_processing" && record.id === fixture.childClaim.id);
            assert.ok(current);
            expect(current.workerId).toBe(childWorkerId);
            expect(current.payload.executionId).toBe(fixture.childClaim.executionId);
            expect(current.leaseUntil).toBe(fixture.childClaim.leaseUntil);
            expect(current.resultPayload).toStrictEqual({ executionId: fixture.childClaim.executionId, artifacts: [fixture.stored] });
            current.leaseUntil = expiredAt;
            return { tasks: records, result: undefined };
        });
        const claimed = await service.claimImageProcessingTasks({ workerId: "fixture-result-complete-new-child-worker", profileVersion: fixture.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const claim = claimed.tasks[0];
        assert.ok(claim);
        expect(claim.id).toBe(fixture.childClaim.id);
        expect(claim.executionId).not.toBe(fixture.childClaim.executionId);
        expect(claim.leaseUntil).toBeGreaterThan(Date.now());
        const before = await fixture.snapshot();
        expect(before.rows.find((record) => record.id === fixture.childClaim.id)).toMatchObject({
            workerId: "fixture-result-complete-new-child-worker",
            leaseUntil: claim.leaseUntil,
            payload: { executionId: claim.executionId },
            resultPayload: { executionId: fixture.childClaim.executionId, artifacts: [fixture.stored] },
        });
        try {
            await expect(service.completeImageProcessingTask(fixture.childClaim.id, fixture.completion)).rejects.toMatchObject({ status: 409 });
        } finally {
            expect(await fixture.snapshot()).toStrictEqual(before);
        }
    }, 30_000);

    it("rejects the real native file as a substitute for this execution's staged final", async () => {
        const fixture = await stagedResult();
        const completion: CompleteImageProcessingInput = { ...fixture.completion, manifest: { ...fixture.completion.manifest, artifacts: [{ ...fixture.stored, storageKey: fixture.slot.storageKey }] } };
        const before = await fixture.snapshot();
        try {
            await expect(service.completeImageProcessingTask(fixture.childClaim.id, completion)).rejects.toMatchObject({ status: 400 });
        } finally {
            expect(await fixture.snapshot()).toStrictEqual(before);
        }
    }, 30_000);

    it("rejects a real final registration reassigned to the image and leaves that changed registration intact", async () => {
        const fixture = await stagedResult();
        const registration = await registrations.getLocalMediaRegistration(fixture.stored.storageKey);
        assert.ok(registration);
        expect(registration.taskId).toBe(fixture.childClaim.id);
        await registrations.registerLocalMediaAsset({ ...registration, taskId: fixture.image.id });
        const before = await fixture.snapshot();
        expect(before.registrations.find((record) => record.storageKey === fixture.stored.storageKey)).toStrictEqual({ ...registration, taskId: fixture.image.id });
        try {
            await expect(service.completeImageProcessingTask(fixture.childClaim.id, fixture.completion)).rejects.toMatchObject({ status: 400 });
        } finally {
            expect(await fixture.snapshot()).toStrictEqual(before);
        }
    }, 30_000);

    it("replays an equal manifest with different object key order using the original receipt without writes", async () => {
        const fixture = await stagedResult();
        const initial = await fixture.snapshot();
        try {
            const { receipt, after } = await closeAndWake(fixture, initial);
            const { manifest } = fixture.completion;
            const identity = manifest.sourceIdentities[0];
            const result = manifest.results?.[0];
            assert.ok(identity && !identity.decodeError);
            assert.ok(identity.nativeImage);
            assert.ok(result && !result.error);
            const reordered: CompleteImageProcessingInput["manifest"] = {
                geometry: manifest.geometry,
                results: [{ finalImage: result.finalImage, finalArtifactIndex: result.finalArtifactIndex, nativeInputIndex: result.nativeInputIndex, resultIndex: result.resultIndex, resultId: result.resultId }],
                artifacts: [
                    {
                        resultIndex: fixture.stored.resultIndex,
                        resultId: fixture.stored.resultId,
                        height: fixture.stored.height,
                        width: fixture.stored.width,
                        bytes: fixture.stored.bytes,
                        mimeType: fixture.stored.mimeType,
                        sha256: fixture.stored.sha256,
                        storageKey: fixture.stored.storageKey,
                        kind: fixture.stored.kind,
                    },
                ],
                sourceIdentities: [
                    {
                        nativeImage: { hasAlpha: identity.nativeImage.hasAlpha, format: identity.nativeImage.format },
                        height: identity.height,
                        width: identity.width,
                        mimeType: identity.mimeType,
                        bytes: identity.bytes,
                        sha256: identity.sha256,
                        assetVersion: identity.assetVersion,
                        assetId: identity.assetId,
                    },
                ],
                executionId: manifest.executionId,
                jobId: manifest.jobId,
            };
            expect(reordered).toStrictEqual(manifest);
            expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(manifest));
            try {
                expect(await service.completeImageProcessingTask(fixture.childClaim.id, { ...fixture.completion, manifest: reordered })).toStrictEqual(receipt);
            } finally {
                expect(await fixture.snapshot()).toStrictEqual(after);
            }
        } finally {
            await assertMediaUnchanged(fixture, initial);
        }
    }, 30_000);

    it("rejects a literal changed result index on completed replay without changing the first receipt or state", async () => {
        const fixture = await stagedResult();
        const initial = await fixture.snapshot();
        try {
            const { receipt, after } = await closeAndWake(fixture, initial);
            const result = fixture.completion.manifest.results?.[0];
            assert.ok(result);
            expect(result.resultIndex).toBe(1);
            const completion: CompleteImageProcessingInput = { ...fixture.completion, manifest: { ...fixture.completion.manifest, results: [{ ...result, resultIndex: 2 }] } };
            try {
                await expect(service.completeImageProcessingTask(fixture.childClaim.id, completion)).rejects.toMatchObject({ status: 409 });
                expect(await service.completeImageProcessingTask(fixture.childClaim.id, fixture.completion)).toStrictEqual(receipt);
            } finally {
                expect(await fixture.snapshot()).toStrictEqual(after);
            }
        } finally {
            await assertMediaUnchanged(fixture, initial);
        }
    }, 30_000);
});
