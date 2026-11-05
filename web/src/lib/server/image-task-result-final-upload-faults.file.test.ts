import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredImageProcessingArtifact } from "./image-processing-service";
import type { ImageTask } from "./image-task-store";
import { imageProcessingS3Fixture, imageProcessingStreamBytes } from "./image-processing-s3-fixture";

type StoredNativeSlot = Extract<NonNullable<ImageTask["nativeResults"]>["slots"][number], { status: "stored" }>;

describe("file image task result final upload fault gates", () => {
    let directory: string;
    let userId: string;
    let sourceUrl: string;
    let differentUrl: string;
    let imageTasks: typeof import("./image-task-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let registrations: typeof import("./local-media-registry");
    let media: typeof import("./local-media-storage");
    let capture: typeof import("./image-task-native-capture");
    let processing: typeof import("./image-task-result-processing");
    let service: typeof import("./image-processing-service");
    let operations: typeof import("@/lib/image-processing/operations");
    let resourceConfig: typeof import("@/lib/image-processing/resource-config");
    let references: typeof import("./reference-asset-store");

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-final-upload-faults-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-final-store-worker-token-00000001");
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-final-store-maintenance-token-001");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        [imageTasks, tasks, scheduler, registrations, media, capture, processing, service, operations, resourceConfig, references] = await Promise.all([
            import("./image-task-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./local-media-registry"),
            import("./local-media-storage"),
            import("./image-task-native-capture"),
            import("./image-task-result-processing"),
            import("./image-processing-service"),
            import("@/lib/image-processing/operations"),
            import("@/lib/image-processing/resource-config"),
            import("./reference-asset-store"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
        const source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 24, g: 48, b: 72 } } })
            .png()
            .toBuffer();
        expect(source.length).toBe(95);
        expect(createHash("sha256").update(source).digest("hex")).toBe("a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6");
        const different = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 96, g: 64, b: 32 } } })
            .png()
            .toBuffer();
        expect(different).not.toEqual(source);
        sourceUrl = "data:image/png;base64," + source.toString("base64");
        differentUrl = "data:image/png;base64," + different.toString("base64");
    }, 30_000);

    beforeEach(() => {
        userId = "fixture-final-upload-fault-" + randomUUID();
    });

    afterEach(async () => {
        // All uploads settle in their tests before removing this isolated user's leased rows.
        await tasks.withGenerationTaskFileMutation(async (records) => ({ tasks: records.filter((record) => record.userId !== userId), result: undefined }));
    });

    afterAll(async () => {
        vi.unstubAllEnvs();
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function fixture(dataUrls: string[]) {
        const firstUrl = dataUrls[0];
        assert.ok(firstUrl);
        const image = await imageTasks.createImageTask({
            userId,
            username: "fixture-final-upload-fault",
            displayName: "Isolated final upload fault fixture",
            kind: "generation",
            source: "image-workbench",
            config: { baseUrl: "https://image.example.com", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model", outputBackground: "opaque" },
            prompt: "Exercise ordinary final staging with real captured slots",
            references: [],
            attemptNo: 1,
            attempts: [],
            billing: { pointsCost: 3, pointsRecordId: "fixture-billing-" + randomUUID(), refunded: false },
        });
        assert.ok(await imageTasks.transitionImageTask(image, ["pending"], { status: "running" }));
        assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: Date.now() - 1 }));
        const imageWorkerId = "fixture-final-image-" + randomUUID();
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
                result: { dataUrl: firstUrl, results: dataUrls.map((dataUrl) => ({ dataUrl })) },
                origin: "https://image.example.com",
                authContext: "",
            }),
        ).toMatchObject({ state: "native_ready" });
        const sealed = await imageTasks.getImageTask(image.id);
        assert.ok(sealed?.nativeResults);
        expect(sealed.runId).toBeUndefined();
        expect(sealed.upstream).toBeUndefined();
        expect(sealed.nativeResults.slots).toHaveLength(dataUrls.length);
        const slots = sealed.nativeResults.slots.filter((slot): slot is StoredNativeSlot => slot.status === "stored");
        expect(await processing.ensureImageTaskResultProcessing(original)).toEqual({ state: "waiting" });
        const waiting = await imageTasks.getImageTask(image.id);
        assert.ok(waiting?.resultProcessing);
        const profileVersion = resourceConfig.imageProcessingResourceConfig(process.env).profileVersion;
        const workerId = "fixture-final-child-" + randomUUID();
        const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const child = claimed.tasks[0];
        assert.ok(child);
        expect(child.id).toBe(waiting.resultProcessing.jobId);
        expect(child.leaseUntil).toBeGreaterThan(Date.now());
        const payload = child.payload;
        assert.ok(payload.operation === "process_result");
        assert.ok(payload.options.mode === "ordinary");
        expect(payload.options.transparentBackground).toBe(false);
        expect(payload.options.targetSize).toBeUndefined();
        const inputs = payload.inputs.map((input, index) => {
            const slot = slots[index];
            assert.ok(slot);
            expect(input).toEqual({ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: slot.sha256 });
            return { ...input, path: path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey) };
        });
        const outputDirectory = await mkdtemp(path.join(directory, "ordinary-fault-output-"));
        const result = await operations.executeImageProcessing({ ...payload, jobId: child.id, executionId: child.executionId, inputs, outputDirectory }, () => {});
        expect(result.artifacts).toHaveLength(slots.length);
        expect(result.geometry).toEqual({});
        return { image, nativeResults: sealed.nativeResults, slots, child, identity: { workerId, executionId: child.executionId }, original, profileVersion, result };
    }

    type Fixture = Awaited<ReturnType<typeof fixture>>;

    async function outputAt(current: Fixture, index: number) {
        const artifact = current.result.artifacts[index];
        assert.ok(artifact);
        const slot = current.slots.find((item) => item.resultId === artifact.resultId);
        assert.ok(slot);
        const bytes = await readFile(artifact.path);
        expect(artifact).toMatchObject({ kind: "final", resultId: slot.resultId, resultIndex: slot.resultIndex, mimeType: "image/png", width: 2, height: 2, bytes: bytes.length });
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
        expect(await sharp(bytes).metadata()).toMatchObject({ format: "png", width: 2, height: 2 });
        expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(bytes);
        return { artifact, slot, bytes };
    }

    type OperationOutput = Awaited<ReturnType<typeof outputAt>>;

    function body(bytes: Buffer) {
        const response = new Response(new Uint8Array(bytes));
        assert.ok(response.body);
        return { response, stream: response.body };
    }

    function upload(current: Fixture, output: OperationOutput) {
        return service.writeImageProcessingOutput(current.child.id, "final", current.identity, { stream: body(output.bytes).stream, mimeType: output.artifact.mimeType, resultId: output.slot.resultId });
    }

    async function snapshot(current: Fixture) {
        const rows = await tasks.withGenerationTaskFileMutation(async (records) => ({ tasks: records, result: records.filter((record) => record.userId === userId).toSorted((left, right) => left.id.localeCompare(right.id)) }));
        const registry = (await registrations.listFileLocalMediaRegistrations()).filter((registration) => registration.ownerUserId === userId).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey));
        const nativeFiles = await Promise.all(current.slots.map(async (slot) => ({ storageKey: slot.storageKey, bytes: await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey)) })));
        return { rows, registry, nativeFiles };
    }

    type Snapshot = Awaited<ReturnType<typeof snapshot>>;

    function expectStaged(current: Fixture, before: Snapshot, after: Snapshot, artifacts: StoredImageProcessingArtifact[]) {
        const child = before.rows.find((record) => record.id === current.child.id);
        assert.ok(child);
        expect(after.rows).toHaveLength(before.rows.length);
        expect(after.rows.filter((record) => record.id !== current.child.id)).toEqual(before.rows.filter((record) => record.id !== current.child.id));
        expect(after.rows.find((record) => record.id === current.child.id)).toEqual({ ...child, updatedAt: expect.any(Number), resultPayload: { executionId: current.identity.executionId, artifacts } });
        expect(after.nativeFiles).toEqual(before.nativeFiles);
        expect(after.registry).toEqual(expect.arrayContaining(before.registry));
    }

    async function expectStored(current: Fixture, output: OperationOutput, stored: StoredImageProcessingArtifact) {
        expect(stored).toEqual({
            kind: "final",
            storageKey: expect.any(String),
            sha256: output.artifact.sha256,
            mimeType: "image/png",
            bytes: output.bytes.length,
            width: 2,
            height: 2,
            resultId: output.slot.resultId,
            resultIndex: output.slot.resultIndex,
        });
        expect(stored.storageKey).not.toBe(output.slot.storageKey);
        expect(await registrations.getLocalMediaRegistration(stored.storageKey)).toMatchObject({
            ownerUserId: userId,
            taskId: current.child.id,
            scope: "reference",
            type: "image",
            storageProvider: "local",
            mimeType: "image/png",
            bytes: output.bytes.length,
        });
        const registered = await references.readReferenceAsset(stored.storageKey);
        assert.ok(registered);
        expect(await readFile(registered.filePath)).toEqual(output.bytes);
    }

    async function expectFailure(pending: Promise<StoredImageProcessingArtifact>, status: number, message: string) {
        await expect(pending).rejects.toBeInstanceOf(service.ImageProcessingInputError);
        await expect(pending).rejects.toMatchObject({ status, message });
    }

    function heldStream(bytes: Buffer) {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const stream = new ReadableStream<Uint8Array>(
            {
                async pull(controller) {
                    controller.enqueue(new Uint8Array(bytes));
                    started.resolve();
                    await release.promise;
                    controller.close();
                },
            },
            { highWaterMark: 0 },
        );
        return { stream, started: started.promise, release: release.resolve };
    }

    async function waitForStreamStart(held: ReturnType<typeof heldStream>, pending: Promise<StoredImageProcessingArtifact>) {
        await Promise.race([
            held.started,
            pending.then(() => {
                throw new Error("Upload completed before held stream EOF");
            }),
        ]);
    }

    it("F1 preserves both real final slots even when their native bytes are identical", async () => {
        const current = await fixture([sourceUrl, sourceUrl]);
        const firstOutput = await outputAt(current, 0);
        const secondOutput = await outputAt(current, 1);
        expect(firstOutput.bytes).toEqual(secondOutput.bytes);
        expect(current.result.results).toEqual([
            { resultId: current.image.id + ":1", resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 0 },
            { resultId: current.image.id + ":2", resultIndex: 2, nativeInputIndex: 1, finalArtifactIndex: 1 },
        ]);
        const before = await snapshot(current);
        const first = await upload(current, firstOutput);
        const second = await upload(current, secondOutput);
        expect(first.resultId).toBe(current.image.id + ":1");
        expect(first.resultIndex).toBe(1);
        expect(second.resultId).toBe(current.image.id + ":2");
        expect(second.resultIndex).toBe(2);
        expect(second.storageKey).not.toBe(first.storageKey);
        await expectStored(current, firstOutput, first);
        await expectStored(current, secondOutput, second);
        const after = await snapshot(current);
        expectStaged(current, before, after, [first, second]);
        expect(after.registry).toHaveLength(4);
    });

    it("F2 returns the first same-slot receipt without changing either staged slot", async () => {
        const current = await fixture([sourceUrl, sourceUrl]);
        const firstOutput = await outputAt(current, 0);
        const secondOutput = await outputAt(current, 1);
        const first = await upload(current, firstOutput);
        const second = await upload(current, secondOutput);
        const before = await snapshot(current);
        const replay = await upload(current, firstOutput);
        expect(replay).toEqual(first);
        const after = await snapshot(current);
        expect(after.rows).toEqual(before.rows);
        expect(after.nativeFiles).toEqual(before.nativeFiles);
        expect(after.registry).toEqual(expect.arrayContaining(before.registry));
        await expectStored(current, firstOutput, first);
        await expectStored(current, secondOutput, second);
    });

    it("F3 rejects real conflicting final bytes while retaining both first receipts", async () => {
        const current = await fixture([sourceUrl, sourceUrl]);
        const firstOutput = await outputAt(current, 0);
        const secondOutput = await outputAt(current, 1);
        const first = await upload(current, firstOutput);
        const second = await upload(current, secondOutput);
        const other = await fixture([differentUrl]);
        const conflicting = await outputAt(other, 0);
        expect(conflicting.bytes).not.toEqual(firstOutput.bytes);
        // The additional real job must exist before taking the all-user fault baseline.
        const before = await snapshot(current);
        const beforeOther = await snapshot(other);
        const pending = service.writeImageProcessingOutput(current.child.id, "final", current.identity, { stream: body(conflicting.bytes).stream, mimeType: conflicting.artifact.mimeType, resultId: firstOutput.slot.resultId });
        await expectFailure(pending, 409, "本执行已登记不同的结果槽位工件");
        const after = await snapshot(current);
        expect(after.rows).toEqual(before.rows);
        expect(after.nativeFiles).toEqual(before.nativeFiles);
        expect(after.registry).toEqual(expect.arrayContaining(before.registry));
        expect((await snapshot(other)).nativeFiles).toEqual(beforeOther.nativeFiles);
        await expectStored(current, firstOutput, first);
        await expectStored(current, secondOutput, second);
    });

    it.each([
        { name: "missing", sources: () => [sourceUrl, sourceUrl], statuses: ["stored", "stored"], selector: (_current: Fixture) => undefined },
        { name: "unknown", sources: () => [sourceUrl, sourceUrl], statuses: ["stored", "stored"], selector: (current: Fixture) => current.image.id + ":unknown" },
        { name: "a genuinely failed original slot", sources: () => [sourceUrl, ""], statuses: ["stored", "failed"], selector: (current: Fixture) => current.image.id + ":2" },
    ])("F4 rejects $name selector without consuming or associating the real final", async ({ sources, statuses, selector }) => {
        const current = await fixture(sources());
        expect(current.nativeResults.slots.map((slot) => slot.status)).toEqual(statuses);
        const output = await outputAt(current, 0);
        const before = await snapshot(current);
        const input = body(output.bytes);
        const pending = service.writeImageProcessingOutput(current.child.id, "final", current.identity, { stream: input.stream, mimeType: output.artifact.mimeType, resultId: selector(current) });
        await expectFailure(pending, 400, "结果槽位不在本阶段允许清单");
        expect(input.response.bodyUsed).toBe(false);
        expect(await snapshot(current)).toEqual(before);
    });

    it("F5 rejects the old upload after a real lease release and child takeover", async () => {
        const current = await fixture([sourceUrl]);
        const output = await outputAt(current, 0);
        const held = heldStream(output.bytes);
        const pending = service.writeImageProcessingOutput(current.child.id, "final", current.identity, { stream: held.stream, mimeType: output.artifact.mimeType, resultId: output.slot.resultId });
        try {
            await waitForStreamStart(held, pending);
            expect(current.child.leaseUntil).toBeGreaterThan(Date.now());
            assert.ok(await scheduler.releaseGenerationTaskLease("image_processing", current.child.id, current.identity.workerId, { executionPhase: "created", nextPollAt: Date.now() - 1 }));
            const released = await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id);
            assert.ok(released);
            expect(released.workerId).toBeUndefined();
            expect(released.leaseUntil).toBeUndefined();
            const nextWorker = "fixture-final-takeover-" + randomUUID();
            const claimed = await service.claimImageProcessingTasks({ workerId: nextWorker, profileVersion: current.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const next = claimed.tasks[0];
            assert.ok(next);
            expect(next.id).toBe(current.child.id);
            expect(next.executionId).not.toBe(current.identity.executionId);
            expect(next.leaseUntil).toBeGreaterThan(Date.now());
            const before = await snapshot(current);
            expect(before.rows.find((record) => record.id === current.child.id)).toMatchObject({ workerId: nextWorker, leaseUntil: next.leaseUntil, payload: { executionId: next.executionId } });
            held.release();
            await expectFailure(pending, 409, "图像阶段执行身份或租约已失效");
            expect(await snapshot(current)).toEqual(before);
        } finally {
            held.release();
            await Promise.allSettled([pending]);
        }
    });

    it("F6 stages successfully while preserving a newly claimed image owner and due", async () => {
        const current = await fixture([sourceUrl]);
        const output = await outputAt(current, 0);
        const held = heldStream(output.bytes);
        const pending = service.writeImageProcessingOutput(current.child.id, "final", current.identity, { stream: held.stream, mimeType: output.artifact.mimeType, resultId: output.slot.resultId });
        try {
            await waitForStreamStart(held, pending);
            const due = Date.now() - 1;
            assert.ok(await scheduler.scheduleGenerationTask("image", current.image.id, { executionPhase: "persisting", nextPollAt: due }));
            const nextWorker = "fixture-final-image-owner-" + randomUUID();
            const claimed = await scheduler.claimDueGenerationTasks({ workerId: nextWorker, taskIds: [current.image.id], limit: 1 });
            expect(claimed).toHaveLength(1);
            const next = claimed[0];
            assert.ok(next?.executionId);
            expect(next.executionId).not.toBe(current.original.executionId);
            const before = await snapshot(current);
            const image = before.rows.find((record) => record.id === current.image.id);
            assert.ok(image);
            expect(image).toMatchObject({ workerId: nextWorker, nextPollAt: due, payload: { executionId: next.executionId } });
            assert.ok(image.leaseUntil);
            expect(image.leaseUntil).toBeGreaterThan(Date.now());
            held.release();
            const stored = await pending;
            await expectStored(current, output, stored);
            expectStaged(current, before, await snapshot(current), [stored]);
        } finally {
            held.release();
            await Promise.allSettled([pending]);
        }
    });

    it("F7 rejects after the image business attempt changes without rewriting native evidence", async () => {
        const current = await fixture([sourceUrl]);
        const output = await outputAt(current, 0);
        const held = heldStream(output.bytes);
        const pending = service.writeImageProcessingOutput(current.child.id, "final", current.identity, { stream: held.stream, mimeType: output.artifact.mimeType, resultId: output.slot.resultId });
        try {
            await waitForStreamStart(held, pending);
            assert.ok(await imageTasks.updateImageTask(current.image.id, { attemptNo: 2 }));
            const before = await snapshot(current);
            expect(before.rows.find((record) => record.id === current.image.id)).toMatchObject({ payload: { attemptNo: 2, nativeResults: current.nativeResults } });
            expect(current.child.leaseUntil).toBeGreaterThan(Date.now());
            held.release();
            await expectFailure(pending, 409, "结果阶段的图像业务或原件绑定已失效");
            expect(await snapshot(current)).toEqual(before);
        } finally {
            held.release();
            await Promise.allSettled([pending]);
        }
    });

    it("F8 preserves a bad native registration and leaves the written output unassociated", async () => {
        const current = await fixture([sourceUrl]);
        const output = await outputAt(current, 0);
        const native = await registrations.getLocalMediaRegistration(output.slot.storageKey);
        assert.ok(native);
        expect(native.bytes).toBe(95);
        await registrations.registerLocalMediaAsset({ ...native, bytes: 94 });
        const before = await snapshot(current);
        expect(before.registry).toEqual([expect.objectContaining({ storageKey: output.slot.storageKey, bytes: 94 })]);
        const beforeChild = before.rows.find((record) => record.id === current.child.id);
        assert.ok(beforeChild);
        expect(beforeChild.resultPayload).toBeUndefined();
        expect(current.child.leaseUntil).toBeGreaterThan(Date.now());
        await expectFailure(upload(current, output), 409, "结果原件媒体登记或存储位置已变化");
        const after = await snapshot(current);
        expect(after.rows).toEqual(before.rows);
        expect(after.nativeFiles).toEqual(before.nativeFiles);
        expect(after.registry).toEqual(expect.arrayContaining(before.registry));
        expect(after.registry).toHaveLength(2);
        const unreferenced = after.registry.find((registration) => registration.taskId === current.child.id);
        assert.ok(unreferenced);
        expect(unreferenced).toMatchObject({ ownerUserId: userId, scope: "reference", type: "image", storageProvider: "local", source: "image-processing-final", mimeType: "image/png", bytes: 95 });
        const registered = await references.readReferenceAsset(unreferenced.storageKey);
        assert.ok(registered);
        expect(await readFile(registered.filePath)).toEqual(output.bytes);
    });

    it.each([
        { name: "a false JPEG declaration", mimeType: "image/jpeg", bytes: (output: OperationOutput) => output.bytes, status: 415, message: "结果图像签名与媒体类型不匹配" },
        { name: "truncated PNG metadata", mimeType: "image/png", bytes: (output: OperationOutput) => output.bytes.subarray(0, 8), status: 400, message: "结果图像签名或元数据无效" },
    ])("F9 rejects $name without staging or registering an output", async ({ mimeType, bytes, status, message }) => {
        const current = await fixture([sourceUrl]);
        const output = await outputAt(current, 0);
        const before = await snapshot(current);
        const pending = service.writeImageProcessingOutput(current.child.id, "final", current.identity, { stream: body(bytes(output)).stream, mimeType, resultId: output.slot.resultId });
        await expectFailure(pending, status, message);
        expect(await snapshot(current)).toEqual(before);
    });

    it.each([
        { name: "all final writes unavailable; second final unattempted", successfulIndices: [], failedIndex: 0 },
        { name: "second final write unavailable after one staged final", successfulIndices: [0], failedIndex: 1 },
    ] as const)(
        "F10 restores actual S3 final writes on the original identity: $name",
        async ({ successfulIndices, failedIndex }) => {
            const current = await fixture([sourceUrl, sourceUrl]);
            const outputs = [await outputAt(current, 0), await outputAt(current, 1)] as const;
            const [config, repository, outputRoute, storage] = await Promise.all([
                import("./object-storage-config"),
                import("./database/object-storage-repository"),
                import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route"),
                import("./object-storage-service"),
            ]);
            const originalSettings = await repository.readObjectStorageSettings();
            const s3 = await imageProcessingS3Fixture();
            try {
                await config.saveObjectStorageAdminSettings(s3.config);
                const before = await snapshot(current);
                const staged = await Promise.all(successfulIndices.map((index) => upload(current, outputs[index])));
                const beforeFailure = await snapshot(current);
                const failed = outputs[failedIndex];
                s3.failPuts(true);
                const response = await outputRoute.PUT(
                    new Request(`http://fixture.invalid/api/maintenance/image-processing/${current.child.id}/outputs/final?resultId=${encodeURIComponent(failed.slot.resultId)}`, {
                        method: "PUT",
                        headers: { authorization: "Bearer " + process.env.VOZEB_PRO_WORKER_TOKEN, "x-vozeb-pro-worker-id": current.identity.workerId, "x-vozeb-pro-execution-id": current.identity.executionId, "content-type": failed.artifact.mimeType },
                        body: new Uint8Array(failed.bytes),
                    }),
                    { params: Promise.resolve({ id: current.child.id, kind: "final" }) },
                );
                expect(response.status).toBe(500);
                expect(await response.json()).toStrictEqual({ code: 500, data: null, msg: "图像工件登记失败" });
                expect(s3.rejectedPuts).toEqual(expect.arrayContaining([{ key: expect.any(String), bytes: failed.bytes }]));
                expect(new Set(s3.rejectedPuts.map((put) => put.key)).size).toBe(1);
                expect(await snapshot(current)).toEqual(beforeFailure);

                s3.failPuts(false);
                expect(current.child.leaseUntil).toBeGreaterThan(Date.now());
                const first = await upload(current, outputs[0]);
                const second = await upload(current, outputs[1]);
                expect([first, second]).toEqual(expect.arrayContaining(staged));
                expectStaged(current, before, await snapshot(current), [first, second]);
                const storedBytes = await Promise.all(
                    [first, second].map(async (artifact) => {
                        const registration = await registrations.getLocalMediaRegistration(artifact.storageKey);
                        assert.ok(registration);
                        expect(registration).toMatchObject({ ownerUserId: userId, taskId: current.child.id, storageProvider: "object" });
                        return imageProcessingStreamBytes(await storage.readExternalMediaStream(registration));
                    }),
                );
                expect(storedBytes).toEqual([outputs[0].bytes, outputs[1].bytes]);
                const { artifacts: _artifacts, ...manifest } = current.result;
                // Fixture protocol metrics; the image operation runs inside Vitest.
                const metrics = { pid: process.pid, peakRssBytes: 64 * 1024 * 1024, peakHeapUsedBytes: 8 * 1024 * 1024, peakExternalBytes: 4 * 1024 * 1024, elapsedMs: 12 };
                const completed = await service.completeImageProcessingTask(current.child.id, { ...current.identity, manifest: { ...manifest, artifacts: [first, second] }, metrics });
                expect(completed).toMatchObject({ jobId: current.child.id, executionId: current.identity.executionId, parentRescheduled: true });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id)).toMatchObject({ status: "success", executionPhase: "completed", payload: current.child.payload });
                const image = await imageTasks.getImageTask(current.image.id);
                assert.ok(image);
                expect(image).toMatchObject({ id: current.image.id, status: "running", nativeResults: current.nativeResults, attemptNo: 1, billing: current.image.billing });
                expect(image.result).toBeUndefined();
                expect((await snapshot(current)).nativeFiles).toEqual(before.nativeFiles);
            } finally {
                s3.failPuts(false);
                try {
                    await s3.close();
                } finally {
                    await repository.writeObjectStorageSettings(originalSettings);
                    await config.getObjectStorageAdminSettings();
                }
            }
        },
        30_000,
    );
});
