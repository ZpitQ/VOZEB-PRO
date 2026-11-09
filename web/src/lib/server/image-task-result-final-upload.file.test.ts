import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("file image task result final upload", () => {
    let directory: string;
    let userId: string;
    let source: Buffer;
    let imageTasks: typeof import("./image-task-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let registrations: typeof import("./local-media-registry");
    let media: typeof import("./local-media-storage");
    let capture: typeof import("./image-task-native-capture");
    let processing: typeof import("./image-task-result-processing");
    let service: typeof import("./image-processing-service");
    let operations: typeof import("@/lib/image-processing/operations");
    let references: typeof import("./reference-asset-store");
    const imageWorkerId = "fixture-result-final-image-worker";
    const childWorkerId = "fixture-result-final-processing-worker";

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-result-final-upload-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        [imageTasks, tasks, scheduler, registrations, media, capture, processing, service, operations, references] = await Promise.all([
            import("./image-task-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./local-media-registry"),
            import("./local-media-storage"),
            import("./image-task-native-capture"),
            import("./image-task-result-processing"),
            import("./image-processing-service"),
            import("@/lib/image-processing/operations"),
            import("./reference-asset-store"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
        userId = "fixture-result-final-upload-" + randomUUID();
        source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 24, g: 48, b: 72 } } })
            .png()
            .toBuffer();
    }, 30_000);

    afterAll(async () => {
        vi.unstubAllEnvs();
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function ownedRows() {
        // One locked snapshot includes wrong-parent or orphan processing rows too.
        return tasks.withGenerationTaskFileMutation(async (records) => ({
            tasks: records,
            result: records.filter((record) => record.userId === userId).toSorted((left, right) => left.id.localeCompare(right.id)),
        }));
    }

    async function ownedRegistrations() {
        return (await registrations.listFileLocalMediaRegistrations()).filter((registration) => registration.ownerUserId === userId).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey));
    }

    it("stages the actual ordinary final stream for its frozen slot without completing or waking its image", async () => {
        expect(source.length).toBe(95);
        expect(createHash("sha256").update(source).digest("hex")).toBe("a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6");
        const image = await imageTasks.createImageTask({
            userId,
            username: "fixture-result-final-upload",
            displayName: "Isolated result final upload fixture",
            kind: "generation",
            source: "image-workbench",
            config: { baseUrl: "https://image.example.com", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model", outputBackground: "opaque" },
            prompt: "Stage the actual ordinary final for the captured native slot",
            references: [],
            attemptNo: 1,
            attempts: [],
            billing: { pointsCost: 3, pointsRecordId: "fixture-billing-" + randomUUID(), refunded: false },
        });
        assert.ok(await imageTasks.transitionImageTask(image, ["pending"], { status: "running" }));
        assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: Date.now() - 1 }));
        const imageClaims = await scheduler.claimDueGenerationTasks({ workerId: imageWorkerId, taskIds: [image.id], limit: 1 });
        expect(imageClaims).toHaveLength(1);
        const imageClaim = imageClaims[0];
        assert.ok(imageClaim?.executionId);
        const original = { taskId: image.id, workerId: imageWorkerId, executionId: imageClaim.executionId };
        expect(
            await capture.captureImageTaskNativeResults({
                ...original,
                attemptNo: 1,
                upstreamTaskId: null,
                result: { dataUrl: "data:image/png;base64," + source.toString("base64") },
                origin: "https://image.example.com",
                authContext: "",
            }),
        ).toMatchObject({ state: "native_ready" });
        const sealed = await imageTasks.getImageTask(image.id);
        assert.ok(sealed?.nativeResults);
        expect(sealed.runId).toBeUndefined();
        expect(sealed.upstream).toBeUndefined();
        expect(sealed.nativeResults.slots).toHaveLength(1);
        const slot = sealed.nativeResults.slots[0];
        assert.ok(slot?.status === "stored");
        expect(slot).toMatchObject({
            resultId: image.id + ":1",
            resultIndex: 1,
            scope: "reference",
            storageProvider: "local",
            bytes: 95,
            sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6",
            layout: { format: "png", depth: "uchar", channels: 3 },
        });
        const nativePath = path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey);
        expect(await readFile(nativePath)).toEqual(source);
        expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({
            ownerUserId: userId,
            taskId: image.id,
            scope: "reference",
            storageClass: "permanent",
            type: "attachment",
            mimeType: "application/octet-stream",
            storageProvider: "local",
            bytes: 95,
        });

        expect(await processing.ensureImageTaskResultProcessing(original)).toEqual({ state: "waiting" });
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
        expect(payload.inputs).toEqual([{ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: slot.sha256 }]);
        expect(payload.options).toEqual({ mode: "ordinary", results: [{ resultId: slot.resultId, resultIndex: 1, inputIndex: 0 }], transparentBackground: false });
        expect(payload.sources).toEqual([{ inputIndex: 0, scope: "reference", storageKey: slot.storageKey, storageProvider: "local" }]);
        expect(payload).toMatchObject({
            imageResultBinding: { imageTaskId: image.id, userId, nativeResults: sealed.nativeResults },
            resource: { facts: { encodedInputs: [{ inputIndex: 0, assetId: slot.assetId, assetVersion: slot.assetVersion, sha256: slot.sha256, bytes: 95, layout: { format: "png", depth: "uchar", channels: 3 } }], decodedInputs: [] } },
        });
        const input = payload.inputs[0];
        assert.ok(input);
        const outputDirectory = await mkdtemp(path.join(directory, "ordinary-operation-"));
        // Direct operation execution is this service fixture; it does not qualify Worker input HTTP or process isolation.
        const result = await operations.executeImageProcessing({ ...payload, jobId: childClaim.id, executionId: childClaim.executionId, inputs: [{ ...input, path: nativePath }], outputDirectory }, () => {});
        expect(result.sourceIdentities).toHaveLength(1);
        expect(result.sourceIdentities[0]).toMatchObject({ assetId: slot.assetId, assetVersion: slot.assetVersion, sha256: slot.sha256, bytes: 95, mimeType: "image/png", width: 2, height: 2 });
        expect(result.results).toEqual([{ resultId: slot.resultId, resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 0 }]);
        expect(result.geometry).toEqual({});
        expect(result.artifacts).toHaveLength(1);
        const final = result.artifacts[0];
        assert.ok(final);
        expect(final).toEqual({ kind: "final", path: expect.any(String), sha256: slot.sha256, mimeType: "image/png", bytes: 95, width: 2, height: 2, resultId: slot.resultId, resultIndex: 1 });
        const finalBytes = await readFile(final.path);
        expect(finalBytes).toEqual(source);
        expect(createHash("sha256").update(finalBytes).digest("hex")).toBe(final.sha256);
        expect(await sharp(finalBytes).metadata()).toMatchObject({ format: "png", width: 2, height: 2 });

        const beforeRows = await ownedRows();
        const beforeRegistrations = await ownedRegistrations();
        expect(beforeRows).toHaveLength(2);
        expect(beforeRegistrations).toHaveLength(1);
        const beforeImage = beforeRows.find((record) => record.type === "image" && record.id === image.id);
        const beforeChild = beforeRows.find((record) => record.type === "image_processing" && record.id === childClaim.id);
        assert.ok(beforeImage);
        assert.ok(beforeChild);
        expect(beforeImage).toMatchObject({ status: "running", executionPhase: "persisting", payload: { status: "running", nativeResults: sealed.nativeResults, resultProcessing: waiting.resultProcessing } });
        expect(beforeImage.workerId).toBeUndefined();
        expect(beforeImage.leaseUntil).toBeUndefined();
        expect(beforeImage.nextPollAt).toBeUndefined();
        expect(beforeImage.payload.executionId).toBeUndefined();
        expect(beforeImage.runId).toBeUndefined();
        expect(beforeChild).toMatchObject({
            type: "image_processing",
            userId,
            parentTaskId: image.id,
            status: "running",
            workerId: childWorkerId,
            leaseUntil: childClaim.leaseUntil,
            payload: { executionId: childClaim.executionId, inputDigest: waiting.resultProcessing.inputDigest },
        });
        expect(beforeChild.runId).toBeUndefined();
        expect(beforeChild.resultPayload).toBeUndefined();
        const response = new Response(new Uint8Array(finalBytes));
        assert.ok(response.body);
        const identity = { workerId: childWorkerId, executionId: childClaim.executionId };
        // resultId selects the frozen slot; the Worker never supplies resultIndex.
        const upload = { stream: response.body, mimeType: final.mimeType, resultId: slot.resultId };
        const stored = await service.writeImageProcessingOutput(childClaim.id, "final", identity, upload).catch(async (error: unknown) => {
            expect(error).toBeInstanceOf(service.ImageProcessingInputError);
            expect(error).toMatchObject({ status: 400, message: "当前阶段不接受此工件类别" });
            expect(await ownedRows()).toEqual(beforeRows);
            expect(await ownedRegistrations()).toEqual(beforeRegistrations);
            expect(await readFile(nativePath)).toEqual(source);
            expect(await readFile(final.path)).toEqual(finalBytes);
            throw error;
        });

        expect(stored).toEqual({ kind: "final", storageKey: expect.any(String), sha256: final.sha256, mimeType: "image/png", bytes: 95, width: 2, height: 2, resultId: slot.resultId, resultIndex: 1 });
        expect(stored.storageKey).not.toBe(slot.storageKey);
        const afterRows = await ownedRows();
        expect(afterRows).toHaveLength(2);
        expect(afterRows.find((record) => record.id === image.id)).toEqual(beforeImage);
        expect(afterRows.find((record) => record.id === childClaim.id)).toEqual({ ...beforeChild, updatedAt: expect.any(Number), resultPayload: { executionId: childClaim.executionId, artifacts: [stored] } });
        const afterRegistrations = await ownedRegistrations();
        expect(afterRegistrations).toHaveLength(2);
        expect(afterRegistrations.filter((registration) => registration.storageKey !== stored.storageKey)).toEqual(beforeRegistrations);
        const finalRegistration = afterRegistrations.find((registration) => registration.storageKey === stored.storageKey);
        assert.ok(finalRegistration);
        expect(finalRegistration).toMatchObject({ ownerUserId: userId, taskId: childClaim.id, scope: "reference", type: "image", storageProvider: "local", bytes: 95, mimeType: "image/png" });
        expect(finalRegistration.runId).toBeUndefined();
        const registered = await references.readReferenceAsset(stored.storageKey);
        assert.ok(registered);
        expect(await readFile(registered.filePath)).toEqual(finalBytes);
        expect(await readFile(nativePath)).toEqual(source);
    }, 30_000);
});
