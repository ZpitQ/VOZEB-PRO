import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredImageProcessingArtifact } from "./image-processing-service";
import type { ImageTask } from "./image-task-store";

type StoredNativeSlot = Extract<NonNullable<ImageTask["nativeResults"]>["slots"][number], { status: "stored" }>;
type RawTaskRow = { id: string; task_type: string; result_payload: unknown; updated_at: Date; [column: string]: unknown };
type RawMediaRow = { storage_key: string; [column: string]: unknown };

(process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1" ? describe : describe.skip)("postgres image task result final upload basic gates", () => {
    let directory: string;
    let userId = "";
    let username: string;
    let sourceUrl: string;
    let differentUrl: string;
    let database: typeof import("./database");
    let imageTasks: typeof import("./image-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let registrations: typeof import("./local-media-registry");
    let media: typeof import("./local-media-storage");
    let capture: typeof import("./image-task-native-capture");
    let processing: typeof import("./image-task-result-processing");
    let service: typeof import("./image-processing-service");
    let operations: typeof import("@/lib/image-processing/operations");
    let resourceConfig: typeof import("@/lib/image-processing/resource-config");
    let references: typeof import("./reference-asset-store");
    let outputRoute: typeof import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route");
    const workerToken = "fixture-final-upload-http-worker-token-0001";

    beforeAll(async () => {
        if (
            process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION !== "1" ||
            process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" ||
            process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" ||
            process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" ||
            !process.env.DATABASE_URL
        )
            throw new Error("Explicit isolated PostgreSQL fixture with integration enabled and startup pool maximum one is required");
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-final-upload-pg-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-final-upload-http-maintenance-token-0001");
        const { isWorkerTokenConfigured } = await import("./maintenance-auth");
        assert.ok(isWorkerTokenConfigured(), "Fixture requires distinct configured Worker credentials");
        [database, imageTasks, scheduler, registrations, media, capture, processing, service, operations, resourceConfig, references, outputRoute] = await Promise.all([
            import("./database"),
            import("./image-task-store"),
            import("./generation-task-scheduler"),
            import("./local-media-registry"),
            import("./local-media-storage"),
            import("./image-task-native-capture"),
            import("./image-task-result-processing"),
            import("./image-processing-service"),
            import("@/lib/image-processing/operations"),
            import("@/lib/image-processing/resource-config"),
            import("./reference-asset-store"),
            import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route"),
        ]);
        await database.initializePostgresSchema();
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated final upload fixture requires local media storage");
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

    beforeEach(async () => {
        userId = "fixture-final-upload-pg-" + randomUUID();
        username = "fixture_" + randomUUID().replaceAll("-", "").slice(0, 16);
        const repositories = database.createPostgresRepositories();
        const settings = await repositories.settings.getSettings();
        const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
        assert.ok(planId, "Fixture entitlement plan missing");
        await repositories.users.createWithNextAccountId({
            id: userId,
            username,
            displayName: "Isolated final upload fixture",
            bio: "",
            role: "user",
            adminPermissions: [],
            status: "active",
            planId,
            pointsBalance: 1000,
            passwordHash: "fixture-only",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
    });

    afterEach(async () => {
        if (userId) await database.createPostgresRepositories().users.delete(userId);
        userId = "";
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
            username,
            displayName: "Isolated final upload fixture",
            kind: "generation",
            source: "image-workbench",
            config: { baseUrl: "https://image.example.com", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model", outputBackground: "opaque" },
            prompt: "Exercise ordinary final staging with real captured slots",
            references: [],
            attemptNo: 1,
            attempts: [],
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
        const outputDirectory = await mkdtemp(path.join(directory, "ordinary-pg-output-"));
        const result = await operations.executeImageProcessing({ ...payload, jobId: child.id, executionId: child.executionId, inputs, outputDirectory }, () => {});
        expect(result.artifacts).toHaveLength(slots.length);
        expect(result.geometry).toEqual({});
        return { image, slots, child, identity: { workerId, executionId: child.executionId }, result };
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
        const stream = new Response(new Uint8Array(bytes)).body;
        assert.ok(stream);
        return stream;
    }

    async function upload(current: Fixture, output: OperationOutput) {
        const request = new Request(`http://worker.invalid/api/maintenance/image-processing/${current.child.id}/outputs/final?resultId=${encodeURIComponent(output.slot.resultId)}`, {
            method: "PUT",
            headers: { authorization: `Bearer ${workerToken}`, "content-type": output.artifact.mimeType, "x-vozeb-pro-worker-id": current.identity.workerId, "x-vozeb-pro-execution-id": current.identity.executionId },
            body: new Uint8Array(output.bytes),
        });
        const response = await outputRoute.PUT(request, { params: Promise.resolve({ id: current.child.id, kind: "final" }) });
        expect(response.status).toBe(201);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const envelope: { code: number; data: StoredImageProcessingArtifact; msg: string } = await response.json();
        expect(envelope.code).toBe(0);
        expect(envelope.msg).toBe("OK");
        return envelope.data;
    }

    async function snapshot(slots: StoredNativeSlot[]) {
        const stored = await database.withPostgresTransaction(async (executor) => {
            await executor.query("SET TRANSACTION READ ONLY");
            const rows = await executor.query<RawTaskRow>("SELECT * FROM generation_tasks WHERE user_id = $1 ORDER BY task_type, id", [userId]);
            const registry = await executor.query<RawMediaRow>("SELECT * FROM local_media_assets WHERE owner_user_id = $1 ORDER BY storage_key", [userId]);
            return { rows: rows.rows, registry: registry.rows };
        });
        // SQL and nested JSON nulls stay intact; files are read outside the SQL transaction.
        const nativeFiles = await Promise.all(slots.map(async (slot) => ({ storageKey: slot.storageKey, bytes: await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey)) })));
        return { ...stored, nativeFiles };
    }

    type Snapshot = Awaited<ReturnType<typeof snapshot>>;

    function expectStaged(current: Fixture, before: Snapshot, after: Snapshot, artifacts: StoredImageProcessingArtifact[]) {
        const child = before.rows.find((row) => row.id === current.child.id);
        assert.ok(child);
        expect(after.rows).toHaveLength(before.rows.length);
        expect(after.rows.filter((row) => row.id !== current.child.id)).toEqual(before.rows.filter((row) => row.id !== current.child.id));
        expect(after.rows.find((row) => row.id === current.child.id)).toEqual({ ...child, updated_at: expect.any(Date), result_payload: { executionId: current.identity.executionId, artifacts } });
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

    it("P1 stages one real final while preserving the complete image and native rows", async () => {
        const current = await fixture([sourceUrl]);
        const output = await outputAt(current, 0);
        expect(current.result.results).toEqual([{ resultId: current.image.id + ":1", resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 0 }]);
        const before = await snapshot(current.slots);
        expect(before.rows).toHaveLength(2);
        expect(before.registry).toHaveLength(1);
        const stored = await upload(current, output);
        await expectStored(current, output, stored);
        const after = await snapshot(current.slots);
        expectStaged(current, before, after, [stored]);
        expect(after.registry).toHaveLength(2);
    }, 30_000);

    it("P2 preserves two real final slots whose native bytes are identical", async () => {
        const current = await fixture([sourceUrl, sourceUrl]);
        const firstOutput = await outputAt(current, 0);
        const secondOutput = await outputAt(current, 1);
        expect(firstOutput.bytes).toEqual(secondOutput.bytes);
        expect(current.result.results).toEqual([
            { resultId: current.image.id + ":1", resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 0 },
            { resultId: current.image.id + ":2", resultIndex: 2, nativeInputIndex: 1, finalArtifactIndex: 1 },
        ]);
        const before = await snapshot(current.slots);
        expect(before.rows).toHaveLength(2);
        expect(before.registry).toHaveLength(2);
        const first = await upload(current, firstOutput);
        const second = await upload(current, secondOutput);
        expect(first.resultId).toBe(current.image.id + ":1");
        expect(first.resultIndex).toBe(1);
        expect(second.resultId).toBe(current.image.id + ":2");
        expect(second.resultIndex).toBe(2);
        expect(second.storageKey).not.toBe(first.storageKey);
        await expectStored(current, firstOutput, first);
        await expectStored(current, secondOutput, second);
        const after = await snapshot(current.slots);
        expectStaged(current, before, after, [first, second]);
        expect(after.registry).toHaveLength(4);
    }, 30_000);

    it("P3 returns the first same-slot receipt without changing either staged slot", async () => {
        const current = await fixture([sourceUrl, sourceUrl]);
        const firstOutput = await outputAt(current, 0);
        const secondOutput = await outputAt(current, 1);
        const first = await upload(current, firstOutput);
        const second = await upload(current, secondOutput);
        const before = await snapshot(current.slots);
        const replay = await upload(current, firstOutput);
        expect(replay).toEqual(first);
        const after = await snapshot(current.slots);
        expect(after.rows).toEqual(before.rows);
        expect(after.nativeFiles).toEqual(before.nativeFiles);
        expect(after.registry).toEqual(expect.arrayContaining(before.registry));
        await expectStored(current, firstOutput, first);
        await expectStored(current, secondOutput, second);
    }, 30_000);

    it("P4 rejects real conflicting final bytes while retaining both first receipts", async () => {
        const current = await fixture([sourceUrl, sourceUrl]);
        const firstOutput = await outputAt(current, 0);
        const secondOutput = await outputAt(current, 1);
        const first = await upload(current, firstOutput);
        const second = await upload(current, secondOutput);
        const other = await fixture([differentUrl]);
        const conflicting = await outputAt(other, 0);
        expect(conflicting.bytes).not.toEqual(firstOutput.bytes);
        // The additional real job belongs in the all-user fault baseline.
        const allSlots = [...current.slots, ...other.slots];
        const before = await snapshot(allSlots);
        expect(before.rows).toHaveLength(4);
        const pending = service.writeImageProcessingOutput(current.child.id, "final", current.identity, { stream: body(conflicting.bytes), mimeType: conflicting.artifact.mimeType, resultId: firstOutput.slot.resultId });
        await expectFailure(pending, 409, "本执行已登记不同的结果槽位工件");
        const after = await snapshot(allSlots);
        expect(after.rows).toEqual(before.rows);
        expect(after.nativeFiles).toEqual(before.nativeFiles);
        expect(after.registry).toEqual(expect.arrayContaining(before.registry));
        await expectStored(current, firstOutput, first);
        await expectStored(current, secondOutput, second);
    }, 30_000);
});
