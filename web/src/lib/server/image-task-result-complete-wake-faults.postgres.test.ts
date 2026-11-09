import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteImageProcessingInput, CompletedImageProcessingStage, StoredImageProcessingArtifact } from "./image-processing-service";

type RawTaskRow = { id: string; task_type: string; payload: Record<string, unknown>; result_payload: unknown; updated_at: Date; next_poll_at: Date | null; [column: string]: unknown };
type RawMediaRow = { storage_key: string; [column: string]: unknown };

(process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1" ? describe : describe.skip)("PostgreSQL result completion owner, lease wait and rollback gates", () => {
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
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-result-complete-pg-fault-"));
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
        userId = "fixture-result-complete-pg-fault-" + randomUUID();
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

    async function stagedResult() {
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
        expect(result.results).toStrictEqual([{ resultId: slot.resultId, resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 0, finalImage: { format: "png", hasAlpha: false } }]);
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

        return { image, imageIdentity, slot, childClaim, childIdentity, payload, stored, completion, nativePath, finalPath: registered.filePath, ready: before };
    }

    type Fixture = Awaited<ReturnType<typeof stagedResult>>;
    type Snapshot = Awaited<ReturnType<typeof snapshot>>;
    type LeaseState = { observed_at: string; lease_until: string; lease_live: boolean; lease_expired: boolean; child_live: boolean; image_live: boolean };
    type ConstraintRow = { conname: string; contype: string; convalidated: boolean; definition: string; [column: string]: unknown };

    async function assertMediaUnchanged(current: Fixture, before: Snapshot) {
        expect(await ownedRegistrations()).toStrictEqual(before.registrations);
        expect(await readFile(current.nativePath)).toEqual(before.nativeBytes);
        expect(await readFile(current.finalPath)).toEqual(before.finalBytes);
    }

    async function control() {
        const { Client } = await import("pg");
        const locker = new Client({ connectionString: database.getPostgresConnectionString() });
        await locker.connect();
        return locker;
    }

    async function controlSnapshot(locker: Client, current: Fixture) {
        const rows = await locker.query<RawTaskRow>("SELECT * FROM vozeb_pro_generation_tasks WHERE user_id = $1 ORDER BY task_type, id", [userId]);
        const registry = await locker.query<RawMediaRow>("SELECT * FROM vozeb_pro_local_media_assets WHERE owner_user_id = $1 ORDER BY storage_key", [userId]);
        return { rows: rows.rows, registrations: registry.rows, nativeBytes: await readFile(current.nativePath), finalBytes: await readFile(current.finalPath) };
    }

    async function leaseState(locker: Client, current: Fixture) {
        const result = await locker.query<LeaseState>(
            `WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS now)
             SELECT observed.now::text AS observed_at, child.lease_until::text AS lease_until,
                    child.lease_until > observed.now AS lease_live, child.lease_until <= observed.now AS lease_expired,
                    child.expires_at > observed.now AS child_live, image.expires_at > observed.now AS image_live
             FROM vozeb_pro_generation_tasks AS child
             JOIN vozeb_pro_generation_tasks AS image ON image.id = $2 AND image.task_type = 'image' AND image.user_id = $3
             CROSS JOIN observed
             WHERE child.id = $1 AND child.task_type = 'image_processing' AND child.user_id = $3`,
            [current.childClaim.id, current.image.id, userId],
        );
        const state = result.rows[0];
        assert.ok(state);
        return state;
    }

    async function waitForParentLock(locker: Client, current: Fixture, applicationPid: number, ownerPid: number, settled: () => boolean) {
        const stopAt = Date.now() + 10_000;
        while (Date.now() < stopAt) {
            if (settled()) throw new Error("Fixture setup: complete settled before its actual parent lock wait was observed");
            await locker.query("SELECT pg_stat_clear_snapshot()");
            const result = await locker.query<LeaseState & { blockers: number[]; blocked: boolean }>(
                `WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS now)
                 SELECT observed.now::text AS observed_at, child.lease_until::text AS lease_until,
                        child.lease_until > observed.now AS lease_live, child.lease_until <= observed.now AS lease_expired,
                        child.expires_at > observed.now AS child_live, image.expires_at > observed.now AS image_live,
                        pg_blocking_pids($1::int) AS blockers,
                        $2::int = ANY(pg_blocking_pids($1::int))
                        AND EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1::int AND wait_event_type = 'Lock') AS blocked
                 FROM vozeb_pro_generation_tasks AS child
                 JOIN vozeb_pro_generation_tasks AS image ON image.id = $4 AND image.task_type = 'image' AND image.user_id = $5
                 CROSS JOIN observed
                 WHERE child.id = $3 AND child.task_type = 'image_processing' AND child.user_id = $5`,
                [applicationPid, ownerPid, current.childClaim.id, current.image.id, userId],
            );
            const state = result.rows[0];
            assert.ok(state);
            assert.ok(state.lease_live, "Fixture setup: no actual parent lock wait was observed before the stored lease expired");
            assert.ok(state.child_live && state.image_live, "Fixture setup: task TTL expired before the parent lock wait was observed");
            if (state.blocked) return state;
        }
        throw new Error("Fixture setup: actual PostgreSQL parent lock wait was not observed within the fixture budget");
    }

    async function waitForLeaseExpiry(locker: Client, current: Fixture, settled: () => boolean) {
        const stopAt = Date.now() + 10_000;
        while (Date.now() < stopAt) {
            if (settled()) throw new Error("Fixture setup: complete settled before the stored child lease expired under the parent lock");
            const state = await leaseState(locker, current);
            assert.ok(state.child_live && state.image_live, "Fixture setup: this gate requires both task TTLs to remain live");
            if (state.lease_expired) return state;
        }
        throw new Error("Fixture setup: stored child lease did not expire within the fixture budget");
    }

    async function constraintRows(locker: Client) {
        const result = await locker.query<ConstraintRow>("SELECT oid::text AS fixture_oid, *, pg_get_constraintdef(oid, true) AS definition FROM pg_constraint WHERE conrelid = 'vozeb_pro_generation_tasks'::regclass ORDER BY conname");
        return result.rows;
    }

    it("keeps a real new image owner and its complete raw row while closing and replaying the child", async () => {
        const current = await stagedResult();
        assert.ok(await scheduler.scheduleGenerationTask("image", current.image.id, { executionPhase: "persisting", nextPollAt: 1 }));
        const claims = await scheduler.claimDueGenerationTasks({ workerId: "fixture-result-complete-pg-new-image-worker", taskIds: [current.image.id], limit: 1 });
        expect(claims).toHaveLength(1);
        const claim = claims[0];
        assert.ok(claim?.executionId);
        assert.ok(claim.leaseUntil);
        expect(claim.executionId).not.toBe(current.imageIdentity.executionId);
        const validity = await database.postgresQuery<{ worker_id: string; execution_id: string; lease_live: boolean; image_live: boolean }>(
            "SELECT worker_id, payload ->> 'executionId' AS execution_id, lease_until > clock_timestamp() AS lease_live, expires_at > clock_timestamp() AS image_live FROM generation_tasks WHERE id = $1 AND task_type = 'image' AND user_id = $2",
            [current.image.id, userId],
        );
        expect(validity.rows).toStrictEqual([{ worker_id: "fixture-result-complete-pg-new-image-worker", execution_id: claim.executionId, lease_live: true, image_live: true }]);
        const before = await snapshot(current.nativePath, current.finalPath);
        const image = before.rows.find((row) => row.task_type === "image" && row.id === current.image.id);
        const child = before.rows.find((row) => row.task_type === "image_processing" && row.id === current.childClaim.id);
        assert.ok(image);
        assert.ok(child);
        expect(image).toMatchObject({ worker_id: claim.workerId, lease_until: new Date(claim.leaseUntil), last_heartbeat_at: expect.any(Date), next_poll_at: new Date(1), payload: { executionId: claim.executionId } });
        try {
            const receipt = await service.completeImageProcessingTask(current.childClaim.id, current.completion).catch(async (error: unknown) => {
                expect(await snapshot(current.nativePath, current.finalPath)).toStrictEqual(before);
                throw error;
            });
            const after = await snapshot(current.nativePath, current.finalPath);
            const expectedChild = {
                ...child,
                status: "success",
                execution_phase: "completed",
                updated_at: expect.any(Date),
                worker_id: null,
                lease_until: null,
                last_heartbeat_at: null,
                next_poll_at: null,
                last_upstream_status: "completed",
                result_payload: { ...current.childIdentity, manifest: current.completion.manifest, manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/), metrics: current.completion.metrics, parentRescheduled: false },
            };
            expect(after).toStrictEqual({ ...before, rows: [image, expectedChild] });
            expect(receipt).toStrictEqual({ jobId: current.childClaim.id, inputDigest: current.payload.inputDigest, executionId: current.childClaim.executionId, manifest: current.completion.manifest, parentRescheduled: false });
            try {
                expect(await service.completeImageProcessingTask(current.childClaim.id, current.completion)).toStrictEqual(receipt);
            } finally {
                expect(await snapshot(current.nativePath, current.finalPath)).toStrictEqual(after);
            }
        } finally {
            await assertMediaUnchanged(current, before);
        }
    }, 30_000);

    it("rejects after a proven parent lock wait outlives the stored child lease with both task TTLs still live", async () => {
        const current = await stagedResult();
        const locker = await control();
        let transactionOpen = false;
        let pending: Promise<CompletedImageProcessingStage> | undefined;
        let before: Snapshot | undefined;
        try {
            const owner = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const backend = await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const ownerPid = owner.rows[0]?.pid;
            const applicationPid = backend.rows[0]?.pid;
            assert.ok(ownerPid);
            assert.ok(applicationPid);
            expect(applicationPid).not.toBe(ownerPid);
            const changed = await locker.query<{ lease_until: string }>(
                `UPDATE vozeb_pro_generation_tasks SET lease_until = clock_timestamp() + interval '3 seconds'
                 WHERE id = $1 AND user_id = $2 AND task_type = 'image_processing' AND status = 'running'
                   AND worker_id = $3 AND payload ->> 'executionId' = $4
                   AND lease_until > clock_timestamp() AND expires_at > clock_timestamp()
                 RETURNING lease_until::text`,
                [current.childClaim.id, userId, current.childIdentity.workerId, current.childIdentity.executionId],
            );
            expect(changed.rowCount).toBe(1);
            const lease = changed.rows[0]?.lease_until;
            assert.ok(lease);
            before = await snapshot(current.nativePath, current.finalPath);
            await locker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            transactionOpen = true;
            const locked = await locker.query("SELECT id FROM vozeb_pro_generation_tasks WHERE id = $1 AND user_id = $2 AND task_type = 'image' FOR UPDATE", [current.image.id, userId]);
            expect(locked.rowCount).toBe(1);
            expect(await leaseState(locker, current)).toMatchObject({ lease_until: lease, lease_live: true, lease_expired: false, child_live: true, image_live: true });
            let settled = false;
            pending = service.completeImageProcessingTask(current.childClaim.id, current.completion);
            void pending.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            const waiting = await waitForParentLock(locker, current, applicationPid, ownerPid, () => settled);
            expect(waiting.blockers).toContain(ownerPid);
            expect(await controlSnapshot(locker, current)).toStrictEqual(before);
            const expired = await waitForLeaseExpiry(locker, current, () => settled);
            expect(expired).toMatchObject({ lease_until: lease, lease_live: false, lease_expired: true, child_live: true, image_live: true });
            await locker.query("COMMIT");
            transactionOpen = false;
            await expect(pending).rejects.toBeInstanceOf(service.ImageProcessingInputError);
            await expect(pending).rejects.toMatchObject({ status: 409, message: "图像阶段执行身份或租约已失效" });
            expect(await snapshot(current.nativePath, current.finalPath)).toStrictEqual(before);
            console.info("PG complete parent-lock child lease expiry", { applicationPid, ownerPid, waiting, expired });
        } finally {
            try {
                if (transactionOpen) await locker.query("ROLLBACK");
            } finally {
                try {
                    if (pending) await Promise.allSettled([pending]);
                } finally {
                    try {
                        if (before) expect(await snapshot(current.nativePath, current.finalPath)).toStrictEqual(before);
                    } finally {
                        try {
                            await assertMediaUnchanged(current, current.ready);
                        } finally {
                            await locker.end();
                        }
                    }
                }
            }
        }
    }, 30_000);

    it("rolls back the complete raw parent wake and child state when this fixture's named CHECK rejects child success", async () => {
        const current = await stagedResult();
        const locker = await control();
        const constraintName = "fixture_complete_rollback_" + randomUUID().replaceAll("-", "");
        try {
            const originalConstraints = await constraintRows(locker);
            let constraintCreated = false;
            try {
                expect(await leaseState(locker, current)).toMatchObject({ lease_live: true, child_live: true, image_live: true });
                const definition = await locker.query<{ statement: string }>(
                    "SELECT format('ALTER TABLE vozeb_pro_generation_tasks ADD CONSTRAINT %I CHECK (NOT (id = %L AND user_id = %L AND task_type = ''image_processing'' AND status = ''success'')) NOT VALID', $1::text, $2::text, $3::text) AS statement",
                    [constraintName, current.childClaim.id, userId],
                );
                const statement = definition.rows[0]?.statement;
                assert.ok(statement);
                // Autocommit releases the DDL lock before the application transaction starts.
                await locker.query(statement);
                constraintCreated = true;
                const activeConstraints = await constraintRows(locker);
                expect(activeConstraints.filter((row) => row.conname !== constraintName)).toStrictEqual(originalConstraints);
                const constraint = activeConstraints.find((row) => row.conname === constraintName);
                assert.ok(constraint);
                expect(constraint).toMatchObject({ contype: "c", convalidated: false });
                expect(constraint.definition).toContain(current.childClaim.id);
                expect(constraint.definition).toContain(userId);
                expect(constraint.definition).toContain("image_processing");
                expect(constraint.definition).toContain("success");
                const before = await snapshot(current.nativePath, current.finalPath);
                try {
                    await expect(service.completeImageProcessingTask(current.childClaim.id, current.completion)).rejects.toMatchObject({ code: "23514", constraint: constraintName });
                } finally {
                    expect(await snapshot(current.nativePath, current.finalPath)).toStrictEqual(before);
                }
            } finally {
                try {
                    if (constraintCreated) {
                        const removal = await locker.query<{ statement: string }>("SELECT format('ALTER TABLE vozeb_pro_generation_tasks DROP CONSTRAINT %I', $1::text) AS statement", [constraintName]);
                        const statement = removal.rows[0]?.statement;
                        assert.ok(statement);
                        await locker.query(statement);
                    }
                    expect(await constraintRows(locker)).toStrictEqual(originalConstraints);
                } finally {
                    await assertMediaUnchanged(current, current.ready);
                }
            }
        } finally {
            await locker.end();
        }
    }, 30_000);
});
