import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Client } from "pg";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredImageProcessingArtifact } from "./image-processing-service";
import type { ImageTask } from "./image-task-store";

type StoredNativeSlot = Extract<NonNullable<ImageTask["nativeResults"]>["slots"][number], { status: "stored" }>;
type RawTaskRow = { id: string; task_type: string; result_payload: unknown; updated_at: Date; [column: string]: unknown };
type RawMediaRow = { storage_key: string; [column: string]: unknown };

(process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1" ? describe : describe.skip)("postgres image task result final upload lock gates", () => {
    let directory: string;
    let userId = "";
    let username: string;
    let sourceUrl: string;
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

    beforeAll(async () => {
        if (
            process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION !== "1" ||
            process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" ||
            process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" ||
            process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" ||
            !process.env.DATABASE_URL
        )
            throw new Error("Explicit isolated PostgreSQL fixture with integration enabled and startup pool maximum one is required");
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-final-upload-locks-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        [database, imageTasks, scheduler, registrations, media, capture, processing, service, operations, resourceConfig, references] = await Promise.all([
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
        ]);
        await database.initializePostgresSchema();
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated final upload fixture requires local media storage");
        const source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 24, g: 48, b: 72 } } })
            .png()
            .toBuffer();
        expect(source.length).toBe(95);
        expect(createHash("sha256").update(source).digest("hex")).toBe("a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6");
        sourceUrl = "data:image/png;base64," + source.toString("base64");
    }, 30_000);

    beforeEach(async () => {
        userId = "fixture-final-upload-locks-" + randomUUID();
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

    async function fixture() {
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
                result: { dataUrl: sourceUrl, results: [{ dataUrl: sourceUrl }] },
                origin: "https://image.example.com",
                authContext: "",
            }),
        ).toMatchObject({ state: "native_ready" });
        const sealed = await imageTasks.getImageTask(image.id);
        assert.ok(sealed?.nativeResults);
        expect(sealed.runId).toBeUndefined();
        expect(sealed.upstream).toBeUndefined();
        expect(sealed.nativeResults.slots).toHaveLength(1);
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

    async function outputAt(current: Fixture) {
        const artifact = current.result.artifacts[0];
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

    function upload(current: Fixture, output: OperationOutput) {
        return service.writeImageProcessingOutput(current.child.id, "final", current.identity, { stream: body(output.bytes), mimeType: output.artifact.mimeType, resultId: output.slot.resultId });
    }

    async function snapshot(locker: Client, slots: StoredNativeSlot[]) {
        const rows = await locker.query<RawTaskRow>("SELECT * FROM vozeb_pro_generation_tasks WHERE user_id = $1 ORDER BY task_type, id", [userId]);
        const registry = await locker.query<RawMediaRow>("SELECT * FROM vozeb_pro_local_media_assets WHERE owner_user_id = $1 ORDER BY storage_key", [userId]);
        const nativeFiles = await Promise.all(slots.map(async (slot) => ({ storageKey: slot.storageKey, bytes: await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey)) })));
        return { rows: rows.rows, registry: registry.rows, nativeFiles };
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

    async function control() {
        const { Client } = await import("pg");
        const locker = new Client({ connectionString: database.getPostgresConnectionString() });
        await locker.connect();
        return locker;
    }

    async function backendPid(locker: Client) {
        const result = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = result.rows[0]?.pid;
        assert.ok(pid);
        return pid;
    }

    async function waitForLock(locker: Client, pid: number, blockers: number[], settled: () => boolean, deadline: string | null) {
        const stopAt = Date.now() + 10_000;
        while (Date.now() < stopAt) {
            if (settled()) throw new Error("Fixture setup: upload settled before its actual lock wait was observed");
            await locker.query("SELECT pg_stat_clear_snapshot()");
            const result = await locker.query<{ blocked: boolean; active: boolean; observed_at: string; blockers: number[] }>(
                "SELECT clock_timestamp()::text AS observed_at, pg_blocking_pids($1::int) AS blockers, $2::int[] && pg_blocking_pids($1::int) AND EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1::int AND wait_event_type = 'Lock') AS blocked, ($3::timestamptz IS NULL OR clock_timestamp() < $3::timestamptz) AS active",
                [pid, blockers, deadline],
            );
            const state = result.rows[0];
            assert.ok(state);
            assert.ok(state.active, "Fixture setup: no active lock wait was observed before the persisted deadline");
            if (state.blocked) return state;
        }
        throw new Error("Fixture setup: actual PostgreSQL lock wait was not observed within the fixture deadline");
    }

    async function waitForDeadline(locker: Client, deadline: string) {
        const stopAt = Date.now() + 10_000;
        while (Date.now() < stopAt) {
            const result = await locker.query<{ expired: boolean; observed_at: string }>("SELECT clock_timestamp() >= $1::timestamptz AS expired, clock_timestamp()::text AS observed_at", [deadline]);
            const state = result.rows[0];
            assert.ok(state);
            if (state.expired) return state;
        }
        throw new Error("Fixture setup: persisted deadline did not expire within the fixture deadline");
    }

    async function validity(locker: Client, current: Fixture) {
        const result = await locker.query<{ lease_live: boolean; child_live: boolean; image_live: boolean }>(
            "SELECT child.lease_until > clock_timestamp() AS lease_live, child.expires_at > clock_timestamp() AS child_live, image.expires_at > clock_timestamp() AS image_live FROM vozeb_pro_generation_tasks AS child JOIN vozeb_pro_generation_tasks AS image ON image.id = $2 AND image.task_type = 'image' AND image.user_id = $3 WHERE child.id = $1 AND child.task_type = 'image_processing' AND child.user_id = $3",
            [current.child.id, current.image.id, userId],
        );
        return result.rows;
    }

    async function writtenOutputs(current: Fixture, state: Snapshot) {
        const outputs = state.registry.filter((row) => row.task_id === current.child.id && row.source === "image-processing-final");
        return Promise.all(
            outputs.map(async (row) => {
                expect(row).toMatchObject({ owner_user_id: userId, scope: "reference", type: "image", mime_type: "image/png", storage_provider: "local" });
                const bytes = await readFile(path.join(media.REFERENCE_MEDIA_ROOT, row.storage_key));
                expect(row.bytes).toBe(String(bytes.length));
                return { storageKey: row.storage_key, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
            }),
        );
    }

    function expectUnchanged(before: Snapshot, after: Snapshot) {
        expect(after.rows).toEqual(before.rows);
        expect(after.nativeFiles).toEqual(before.nativeFiles);
        expect(after.registry).toEqual(expect.arrayContaining(before.registry));
    }

    async function actorReceipt(receiptPath: string): Promise<StoredImageProcessingArtifact> {
        const value: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
        assert.ok(value !== null && typeof value === "object");
        assert.ok("kind" in value && value.kind === "final");
        assert.ok("storageKey" in value && typeof value.storageKey === "string");
        assert.ok("sha256" in value && typeof value.sha256 === "string");
        assert.ok("mimeType" in value && value.mimeType === "image/png");
        assert.ok("bytes" in value && typeof value.bytes === "number");
        assert.ok("width" in value && typeof value.width === "number");
        assert.ok("height" in value && typeof value.height === "number");
        assert.ok("resultId" in value && typeof value.resultId === "string");
        assert.ok("resultIndex" in value && typeof value.resultIndex === "number");
        return { kind: "final", storageKey: value.storageKey, sha256: value.sha256, mimeType: "image/png", bytes: value.bytes, width: value.width, height: value.height, resultId: value.resultId, resultIndex: value.resultIndex };
    }

    async function uploadActor(current: Fixture, output: OperationOutput) {
        const connection = database.getPostgresConnectionString();
        const encryptionKey = process.env.VOZEB_PRO_ENCRYPTION_KEY;
        assert.ok(connection && encryptionKey);
        const key = randomUUID();
        const ready = Promise.withResolvers<number>();
        const release = Promise.withResolvers<void>();
        const server = createServer((request, response) => {
            try {
                assert.equal(request.method, "POST");
                assert.ok(request.url);
                const url = new URL(request.url, "http://127.0.0.1");
                assert.equal(url.pathname, "/final-upload-actor/" + key);
                const pid = Number(url.searchParams.get("pid"));
                assert.ok(Number.isSafeInteger(pid) && pid > 0);
                ready.resolve(pid);
                void release.promise.then(() => response.end("ready"));
            } catch (error) {
                ready.reject(error);
                response.statusCode = 400;
                response.end();
            }
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const receiptPath = path.join(await mkdtemp(path.join(directory, "upload-actor-")), "receipt.json");
        const input = {
            origin: "http://127.0.0.1:" + String(address.port),
            key,
            userId,
            taskId: current.child.id,
            workerId: current.identity.workerId,
            executionId: current.identity.executionId,
            resultId: output.slot.resultId,
            filePath: output.artifact.path,
            receiptPath,
        };
        const child = spawn(
            process.execPath,
            [path.resolve("node_modules/vitest/vitest.mjs"), "run", "src/lib/server/image-task-result-final-upload-process-fixture.test.ts", "--pool=threads", "--maxWorkers=1", "--no-file-parallelism", "--reporter=dot"],
            {
                cwd: process.cwd(),
                env: { ...process.env, VOZEB_PRO_DATABASE_POOL_MAX: "1", VOZEB_PRO_FINAL_UPLOAD_ACTOR_INPUT: JSON.stringify(input) },
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let outputText = "";
        assert.ok(child.stdout && child.stderr);
        child.stdout.on("data", (chunk: Buffer) => {
            outputText += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            outputText += chunk.toString();
        });
        let settled = false;
        const completed = new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => {
                if (code === 0) resolve();
                else {
                    const redacted = outputText.replaceAll(connection, "[redacted]").replaceAll(encryptionKey, "[redacted]");
                    reject(new Error("Independent final upload actor failed (" + String(code) + "): " + redacted));
                }
            });
        }).then(async () => actorReceipt(receiptPath));
        void completed.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        return {
            ready: Promise.race([
                ready.promise,
                completed.then(() => {
                    throw new Error("Fixture setup: upload actor exited before ready");
                }),
            ]),
            start: release.resolve,
            completed,
            settled: () => settled,
            async close() {
                release.resolve();
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
                await Promise.allSettled([completed]);
                const closing = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
                server.closeAllConnections();
                await closing;
            },
        };
    }

    it("L1 merges two real concurrent same-slot uploads after both wait on the image row", async () => {
        const current = await fixture();
        const output = await outputAt(current);
        const locker = await control();
        let transactionOpen = false;
        let actor: Awaited<ReturnType<typeof uploadActor>> | undefined;
        let pending: Promise<StoredImageProcessingArtifact> | undefined;
        try {
            const ownerPid = await backendPid(locker);
            const backend = await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const applicationPid = backend.rows[0]?.pid;
            assert.ok(applicationPid);
            actor = await uploadActor(current, output);
            const actorPid = await actor.ready;
            expect(new Set([ownerPid, applicationPid, actorPid]).size).toBe(3);
            const before = await snapshot(locker, current.slots);
            await locker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            transactionOpen = true;
            const locked = await locker.query("SELECT id FROM vozeb_pro_generation_tasks WHERE id = $1 AND user_id = $2 AND task_type = 'image' FOR UPDATE", [current.image.id, userId]);
            expect(locked.rowCount).toBe(1);
            let settled = false;
            pending = upload(current, output);
            void pending.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            actor.start();
            const appWait = await waitForLock(locker, applicationPid, [ownerPid, actorPid], () => settled, null);
            const actorWait = await waitForLock(locker, actorPid, [ownerPid, applicationPid], actor.settled, null);
            const stalled = await snapshot(locker, current.slots);
            expectUnchanged(before, stalled);
            const written = await writtenOutputs(current, stalled);
            expect(written).toEqual([
                { storageKey: expect.any(String), bytes: output.bytes.length, sha256: output.artifact.sha256 },
                { storageKey: expect.any(String), bytes: output.bytes.length, sha256: output.artifact.sha256 },
            ]);
            expect(written[0]?.storageKey).not.toBe(written[1]?.storageKey);
            await locker.query("COMMIT");
            transactionOpen = false;
            const first = await pending;
            const second = await actor.completed;
            expect(second).toEqual(first);
            expect(written.map((item) => item.storageKey)).toContain(first.storageKey);
            await expectStored(current, output, first);
            const after = await snapshot(locker, current.slots);
            expectStaged(current, before, after, [first]);
            expect(after.registry).toHaveLength(3);
            console.info("Final upload same-slot lock gate", { applicationPid, actorPid, ownerPid, appWait, actorWait });
        } finally {
            try {
                if (transactionOpen) await locker.query("ROLLBACK");
            } finally {
                try {
                    if (actor) await actor.close();
                } finally {
                    try {
                        if (pending) await Promise.allSettled([pending]);
                    } finally {
                        await locker.end();
                    }
                }
            }
        }
    }, 30_000);

    it("L2 rejects after a real child lock wait outlives its jointly shortened lease and TTL", async () => {
        const current = await fixture();
        const output = await outputAt(current);
        const locker = await control();
        let transactionOpen = false;
        let pending: Promise<StoredImageProcessingArtifact> | undefined;
        try {
            const ownerPid = await backendPid(locker);
            const backend = await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const applicationPid = backend.rows[0]?.pid;
            assert.ok(applicationPid);
            expect(applicationPid).not.toBe(ownerPid);
            const changed = await locker.query<{ deadline: string }>(
                "UPDATE vozeb_pro_generation_tasks SET lease_until = statement_timestamp() + interval '3 seconds', expires_at = statement_timestamp() + interval '3 seconds' WHERE id = $1 AND user_id = $2 AND task_type = 'image_processing' AND status = 'running' AND worker_id = $3 AND payload ->> 'executionId' = $4 AND lease_until > statement_timestamp() AND expires_at > statement_timestamp() RETURNING lease_until::text AS deadline",
                [current.child.id, userId, current.identity.workerId, current.identity.executionId],
            );
            expect(changed.rowCount).toBe(1);
            const deadline = changed.rows[0]?.deadline;
            assert.ok(deadline);
            const before = await snapshot(locker, current.slots);
            await locker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            transactionOpen = true;
            const locked = await locker.query("SELECT id FROM vozeb_pro_generation_tasks WHERE id = $1 AND user_id = $2 AND task_type = 'image_processing' FOR NO KEY UPDATE", [current.child.id, userId]);
            expect(locked.rowCount).toBe(1);
            let settled = false;
            pending = upload(current, output);
            void pending.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            const waiting = await waitForLock(locker, applicationPid, [ownerPid], () => settled, deadline);
            const stalled = await snapshot(locker, current.slots);
            expectUnchanged(before, stalled);
            expect(await writtenOutputs(current, stalled)).toEqual([{ storageKey: expect.any(String), bytes: output.bytes.length, sha256: output.artifact.sha256 }]);
            const expired = await waitForDeadline(locker, deadline);
            expect(await validity(locker, current)).toEqual([{ lease_live: false, child_live: false, image_live: true }]);
            await locker.query("COMMIT");
            transactionOpen = false;
            await expectFailure(pending, 409, "图像阶段执行身份或租约已失效");
            expectUnchanged(before, await snapshot(locker, current.slots));
            expect(await database.postgresQuery("SELECT 1 AS reusable")).toMatchObject({ rows: [{ reusable: 1 }] });
            console.info("Final upload joint child expiry gate", { applicationPid, ownerPid, waiting, deadline, expired });
        } finally {
            try {
                if (transactionOpen) await locker.query("ROLLBACK");
            } finally {
                try {
                    if (pending) await Promise.allSettled([pending]);
                } finally {
                    await locker.end();
                }
            }
        }
    }, 30_000);

    it("L3 rejects image TTL expiry after a real registration wait while its child remains live", async () => {
        const current = await fixture();
        const output = await outputAt(current);
        const slot = current.slots[0];
        assert.ok(slot);
        const locker = await control();
        let transactionOpen = false;
        let pending: Promise<StoredImageProcessingArtifact> | undefined;
        try {
            const ownerPid = await backendPid(locker);
            const backend = await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const applicationPid = backend.rows[0]?.pid;
            assert.ok(applicationPid);
            expect(applicationPid).not.toBe(ownerPid);
            const changed = await locker.query<{ deadline: string }>(
                "UPDATE vozeb_pro_generation_tasks SET expires_at = statement_timestamp() + interval '3 seconds' WHERE id = $1 AND user_id = $2 AND task_type = 'image' AND status = 'running' AND expires_at > statement_timestamp() RETURNING expires_at::text AS deadline",
                [current.image.id, userId],
            );
            expect(changed.rowCount).toBe(1);
            const deadline = changed.rows[0]?.deadline;
            assert.ok(deadline);
            const before = await snapshot(locker, current.slots);
            await locker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            transactionOpen = true;
            const locked = await locker.query("SELECT storage_key FROM vozeb_pro_local_media_assets WHERE storage_key = $1 AND owner_user_id = $2 AND task_id = $3 FOR UPDATE", [slot.storageKey, userId, current.image.id]);
            expect(locked.rowCount).toBe(1);
            let settled = false;
            pending = upload(current, output);
            void pending.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            const waiting = await waitForLock(locker, applicationPid, [ownerPid], () => settled, deadline);
            const stalled = await snapshot(locker, current.slots);
            expectUnchanged(before, stalled);
            expect(await writtenOutputs(current, stalled)).toEqual([{ storageKey: expect.any(String), bytes: output.bytes.length, sha256: output.artifact.sha256 }]);
            const expired = await waitForDeadline(locker, deadline);
            expect(await validity(locker, current)).toEqual([{ lease_live: true, child_live: true, image_live: false }]);
            await locker.query("COMMIT");
            transactionOpen = false;
            await expectFailure(pending, 409, "结果阶段的图像业务或原件绑定已失效");
            expectUnchanged(before, await snapshot(locker, current.slots));
            expect(await validity(locker, current)).toEqual([{ lease_live: true, child_live: true, image_live: false }]);
            expect(await database.postgresQuery("SELECT 1 AS reusable")).toMatchObject({ rows: [{ reusable: 1 }] });
            console.info("Final upload image TTL registration gate", { applicationPid, ownerPid, waiting, deadline, expired });
        } finally {
            try {
                if (transactionOpen) await locker.query("ROLLBACK");
            } finally {
                try {
                    if (pending) await Promise.allSettled([pending]);
                } finally {
                    await locker.end();
                }
            }
        }
    }, 30_000);
});
