import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteImageProcessingInput, StoredImageProcessingArtifact } from "./image-processing-service";

type RawTaskRow = { id: string; task_type: string; payload: Record<string, unknown>; result_payload: unknown; updated_at: Date; next_poll_at: Date | null; [column: string]: unknown };
type RawMediaRow = { storage_key: string; [column: string]: unknown };

(process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1" ? describe : describe.skip)("PostgreSQL completed result reuse by a new ImageTask execution", () => {
    let directory: string;
    let userId = "";
    let username: string;
    let source: Buffer;
    let database: typeof import("./database");
    let imageTasks: typeof import("./image-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let media: typeof import("./local-media-storage");
    let capture: typeof import("./image-task-native-capture");
    let processing: typeof import("./image-task-result-processing");
    let service: typeof import("./image-processing-service");
    let operations: typeof import("@/lib/image-processing/operations");
    let resourceConfig: typeof import("@/lib/image-processing/resource-config");
    let references: typeof import("./reference-asset-store");
    let outputRoute: typeof import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route");
    const workerToken = "fixture-result-complete-http-worker-token-0001";
    const imageWorkerId = "fixture-result-complete-image-worker";
    const childWorkerId = "fixture-result-complete-child-worker";

    beforeAll(async () => {
        if (
            process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION !== "1" ||
            process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" ||
            process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" ||
            process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" ||
            !process.env.DATABASE_URL
        )
            throw new Error("Explicit isolated PostgreSQL fixture with integration enabled and startup pool maximum one is required");
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-result-complete-pg-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-result-complete-http-maintenance-token-0001");
        const { isWorkerTokenConfigured } = await import("./maintenance-auth");
        assert.ok(isWorkerTokenConfigured(), "Fixture requires distinct configured Worker credentials");
        [database, imageTasks, scheduler, media, capture, processing, service, operations, resourceConfig, references, outputRoute] = await Promise.all([
            import("./database"),
            import("./image-task-store"),
            import("./generation-task-scheduler"),
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
        if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated result completion fixture requires local media storage");
        source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 24, g: 48, b: 72 } } })
            .png()
            .toBuffer();
    }, 30_000);

    beforeEach(async () => {
        userId = "fixture-result-complete-pg-" + randomUUID();
        username = "fixture_" + randomUUID().replaceAll("-", "").slice(0, 16);
        const repositories = database.createPostgresRepositories();
        const settings = await repositories.settings.getSettings();
        const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
        assert.ok(planId, "Fixture entitlement plan missing");
        await repositories.users.createWithNextAccountId({
            id: userId,
            username,
            displayName: "Isolated result completion fixture",
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

    async function ownedRegistrations() {
        return database.withPostgresTransaction(async (executor) => {
            await executor.query("SET TRANSACTION READ ONLY");
            const registry = await executor.query<RawMediaRow>("SELECT * FROM local_media_assets WHERE owner_user_id = $1 ORDER BY storage_key", [userId]);
            return registry.rows;
        });
    }

    async function snapshot(nativePath: string, finalPath: string) {
        const stored = await database.withPostgresTransaction(async (executor) => {
            await executor.query("SET TRANSACTION READ ONLY");
            const rows = await executor.query<RawTaskRow>("SELECT * FROM generation_tasks WHERE user_id = $1 ORDER BY task_type, id", [userId]);
            const registry = await executor.query<RawMediaRow>("SELECT * FROM local_media_assets WHERE owner_user_id = $1 ORDER BY storage_key", [userId]);
            return { rows: rows.rows, registrations: registry.rows };
        });
        // Preserve raw SQL rows and JSON nulls; read file bytes outside the transaction.
        return { ...stored, nativeBytes: await readFile(nativePath), finalBytes: await readFile(finalPath) };
    }

    async function databaseNow() {
        return database.withPostgresTransaction(async (executor) => {
            await executor.query("SET TRANSACTION READ ONLY");
            const result = await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now");
            const row = result.rows[0];
            assert.ok(row);
            return row.now.getTime();
        });
    }

    it("returns ready without yielding a real new image owner after its actual result child completed", async () => {
        expect(source).toHaveLength(95);
        expect(createHash("sha256").update(source).digest("hex")).toBe("a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6");
        const image = await imageTasks.createImageTask({
            userId,
            username,
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

        // All native comparisons use the actual persisted PostgreSQL representation.
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
        const childClaims = await service.claimImageProcessingTasks({ workerId: childWorkerId, profileVersion: resourceConfig.imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
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
        const childIdentity = { workerId: childWorkerId, executionId: childClaim.executionId };
        const request = new Request(`http://worker.invalid/api/maintenance/image-processing/${childClaim.id}/outputs/final?resultId=${encodeURIComponent(slot.resultId)}`, {
            method: "PUT",
            headers: { authorization: `Bearer ${workerToken}`, "content-type": final.mimeType, "x-vozeb-pro-worker-id": childIdentity.workerId, "x-vozeb-pro-execution-id": childIdentity.executionId },
            body: new Uint8Array(finalBytes),
        });
        const response = await outputRoute.PUT(request, { params: Promise.resolve({ id: childClaim.id, kind: "final" }) });
        expect(response.status).toBe(201);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const envelope: { code: number; data: StoredImageProcessingArtifact; msg: string } = await response.json();
        expect(envelope.code).toBe(0);
        expect(envelope.msg).toBe("OK");
        const stored = envelope.data;
        expect(stored).toStrictEqual({ kind: "final", storageKey: expect.any(String), sha256: final.sha256, mimeType: final.mimeType, bytes: 95, width: 2, height: 2, resultId: slot.resultId, resultIndex: 1 });
        const registered = await references.readReferenceAsset(stored.storageKey);
        assert.ok(registered);
        const before = await snapshot(nativePath, registered.filePath);
        expect(before.rows).toHaveLength(2);
        expect(before.registrations).toHaveLength(2);
        expect(before.nativeBytes).toEqual(source);
        expect(before.finalBytes).toEqual(finalBytes);
        expect(before.registrations.find((record) => record.storage_key === slot.storageKey)).toMatchObject({
            owner_user_id: userId,
            task_id: image.id,
            scope: "reference",
            storage_class: "permanent",
            type: "attachment",
            storage_provider: "local",
            mime_type: "application/octet-stream",
            bytes: "95",
        });
        expect(before.registrations.find((record) => record.storage_key === stored.storageKey)).toMatchObject({
            owner_user_id: userId,
            task_id: childClaim.id,
            scope: "reference",
            storage_class: "temporary",
            type: "image",
            storage_provider: "local",
            mime_type: "image/png",
            bytes: "95",
        });
        const beforeImage = before.rows.find((record) => record.task_type === "image" && record.id === image.id);
        const beforeChild = before.rows.find((record) => record.task_type === "image_processing" && record.id === childClaim.id);
        assert.ok(beforeImage);
        assert.ok(beforeChild);
        expect(beforeImage).toMatchObject({ status: "running", execution_phase: "persisting", payload: { status: "running", nativeResults: sealed.nativeResults, resultProcessing: waiting.resultProcessing } });
        expect(beforeImage.next_poll_at).toBeNull();
        expect(beforeImage.worker_id).toBeNull();
        expect(beforeImage.lease_until).toBeNull();
        expect(beforeImage.last_heartbeat_at).toBeNull();
        expect(beforeImage.payload.executionId).toBeUndefined();
        expect(beforeImage.payload.result).toBeUndefined();
        expect(beforeImage.payload.billing).toBeUndefined();
        expect(beforeImage.run_id).toBeNull();
        expect(beforeChild).toMatchObject({ status: "running", parent_task_id: image.id, payload: { executionId: childClaim.executionId, inputDigest: waiting.resultProcessing.inputDigest } });
        expect(beforeChild.result_payload).toStrictEqual({ executionId: childClaim.executionId, artifacts: [stored] });
        expect(beforeChild.worker_id).toBe(childWorkerId);
        expect(beforeChild.lease_until).toStrictEqual(new Date(childClaim.leaseUntil));
        expect(beforeChild.last_heartbeat_at).toBeInstanceOf(Date);
        expect(beforeChild.next_poll_at).toBeInstanceOf(Date);
        // Service DTO telemetry fixture; independent child metrics remain a separate Worker gate.
        const metrics: CompleteImageProcessingInput["metrics"] = { pid: process.pid, peakRssBytes: 64 * 1024 * 1024, peakHeapUsedBytes: 8 * 1024 * 1024, peakExternalBytes: 4 * 1024 * 1024, elapsedMs: 12 };
        const completion: CompleteImageProcessingInput = {
            ...childIdentity,
            manifest: { jobId: result.jobId, executionId: result.executionId, sourceIdentities: result.sourceIdentities, artifacts: [stored], results: result.results, geometry: result.geometry },
            metrics,
        };

        try {
            const startedAt = await databaseNow();
            const receipt = await service.completeImageProcessingTask(childClaim.id, completion).catch(async (error: unknown) => {
                expect(await snapshot(nativePath, registered.filePath)).toStrictEqual(before);
                throw error;
            });
            const completedAt = await databaseNow();
            const after = await snapshot(nativePath, registered.filePath);
            expect(receipt).toStrictEqual({ jobId: childClaim.id, inputDigest: payload.inputDigest, executionId: childClaim.executionId, manifest: completion.manifest, parentRescheduled: true });
            const expectedImage = {
                ...beforeImage,
                updated_at: expect.any(Date),
                payload: { ...beforeImage.payload, updatedAt: expect.any(Number) },
                execution_phase: "persisting",
                next_poll_at: expect.any(Date),
                last_upstream_status: "image_processing_completed",
            };
            const expectedChild = {
                ...beforeChild,
                status: "success",
                execution_phase: "completed",
                updated_at: expect.any(Date),
                worker_id: null,
                lease_until: null,
                last_heartbeat_at: null,
                next_poll_at: null,
                last_upstream_status: "completed",
                result_payload: { ...childIdentity, manifest: completion.manifest, manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/), metrics, parentRescheduled: true },
            };
            expect(after).toStrictEqual({ ...before, rows: [expectedImage, expectedChild] });
            const awakened = after.rows.find((record) => record.id === image.id);
            assert.ok(awakened);
            assert.ok(awakened.next_poll_at);
            expect(awakened.next_poll_at.getTime()).toBeGreaterThanOrEqual(startedAt);
            expect(awakened.next_poll_at.getTime()).toBeLessThanOrEqual(completedAt);

            expect(await service.completeImageProcessingTask(childClaim.id, completion)).toStrictEqual(receipt);
            expect(await snapshot(nativePath, registered.filePath)).toStrictEqual(after);

            const consumerWorkerId = "fixture-result-completed-reuse-consumer-worker";
            const consumerClaims = await scheduler.claimDueGenerationTasks({ workerId: consumerWorkerId, taskIds: [image.id], limit: 1 });
            expect(consumerClaims).toHaveLength(1);
            const consumer = consumerClaims[0];
            assert.ok(consumer?.executionId);
            assert.ok(consumer.leaseUntil);
            expect(consumer.id).toBe(image.id);
            expect(consumer.workerId).toBe(consumerWorkerId);
            expect(consumer.executionId).not.toBe(imageIdentity.executionId);
            const beforeReuse = await snapshot(nativePath, registered.filePath);
            expect(beforeReuse.rows).toHaveLength(2);
            const newOwner = beforeReuse.rows.find((record) => record.task_type === "image" && record.id === image.id);
            const closedChild = beforeReuse.rows.find((record) => record.task_type === "image_processing" && record.id === childClaim.id);
            const completedChild = after.rows.find((record) => record.task_type === "image_processing" && record.id === childClaim.id);
            assert.ok(newOwner);
            assert.ok(closedChild);
            assert.ok(completedChild);
            expect(newOwner).toMatchObject({
                status: "running",
                execution_phase: "persisting",
                worker_id: consumerWorkerId,
                lease_until: new Date(consumer.leaseUntil),
                payload: { executionId: consumer.executionId, resultProcessing: waiting.resultProcessing, nativeResults: sealed.nativeResults },
            });
            expect(closedChild).toStrictEqual(completedChild);
            assert.ok(newOwner.lease_until instanceof Date);
            assert.ok(newOwner.expires_at instanceof Date);
            assert.ok(closedChild.expires_at instanceof Date);
            const reuseNow = await databaseNow();
            expect(newOwner.lease_until.getTime()).toBeGreaterThan(reuseNow);
            expect(newOwner.expires_at.getTime()).toBeGreaterThan(reuseNow);
            expect(closedChild.expires_at.getTime()).toBeGreaterThan(reuseNow);
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
