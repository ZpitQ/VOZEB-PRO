import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteImageProcessingInput, StoredImageProcessingArtifact } from "./image-processing-service";
import type { QueryExecutor } from "./database";

type RawTaskRow = { id: string; task_type: string; payload: Record<string, unknown>; result_payload: unknown; updated_at: Date; next_poll_at: Date | null; [column: string]: unknown };
type RawMediaRow = { storage_key: string; [column: string]: unknown };
type RawSqlRow = Record<string, unknown>;

(process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1" ? describe : describe.skip)("PostgreSQL consumer post-promotion log wait and natural owner-lease rollback", () => {
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
    let auth: typeof import("@/lib/auth/store");
    let wallet: typeof import("./points-wallet-service");
    let support: typeof import("@/app/api/image-tasks/image-task-support");
    let creative: typeof import("./creative-runtime-service");
    let attempts: typeof import("./generation-attempt");
    let generationLogs: typeof import("./generation-log-store");
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
        [auth, wallet, support, creative, attempts, generationLogs] = await Promise.all([
            import("@/lib/auth/store"),
            import("./points-wallet-service"),
            import("@/app/api/image-tasks/image-task-support"),
            import("./creative-runtime-service"),
            import("./generation-attempt"),
            import("./generation-log-store"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated result completion fixture requires local media storage");
        source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 24, g: 48, b: 72 } } })
            .png()
            .toBuffer();
    }, 30_000);

    beforeEach(async () => {
        userId = "fixture-result-consumption-pg-" + randomUUID();
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
            pointsBalance: 0,
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

    async function financialRows(executor: QueryExecutor) {
        return {
            users: (await executor.query<RawSqlRow>("SELECT * FROM users WHERE id = $1 ORDER BY id", [userId])).rows,
            pointRecords: (await executor.query<RawSqlRow>("SELECT * FROM point_records WHERE user_id = $1 ORDER BY id", [userId])).rows,
            quotaUsage: (await executor.query<RawSqlRow>("SELECT * FROM quota_usage WHERE user_id = $1 ORDER BY date, usage_kind", [userId])).rows,
            dailyWallets: (await executor.query<RawSqlRow>("SELECT * FROM daily_plan_point_wallets WHERE user_id = $1 ORDER BY date", [userId])).rows,
            planAssignments: (await executor.query<RawSqlRow>("SELECT * FROM user_plan_assignments WHERE user_id = $1 ORDER BY id", [userId])).rows,
        };
    }

    async function ownedFinancialRows() {
        return database.withPostgresTransaction(async (executor) => {
            await executor.query("SET TRANSACTION READ ONLY");
            return financialRows(executor);
        });
    }

    async function snapshot(nativePath: string, finalPath: string) {
        const stored = await database.withPostgresTransaction(async (executor) => {
            await executor.query("SET TRANSACTION READ ONLY");
            const rows = await executor.query<RawTaskRow>("SELECT * FROM generation_tasks WHERE user_id = $1 ORDER BY task_type, id", [userId]);
            const registry = await executor.query<RawMediaRow>("SELECT * FROM local_media_assets WHERE owner_user_id = $1 ORDER BY storage_key", [userId]);
            const logs = await executor.query<RawSqlRow>("SELECT * FROM generation_logs WHERE user_id = $1 ORDER BY id", [userId]);
            const logAssets = await executor.query<RawSqlRow>(
                "SELECT asset.* FROM generation_log_assets AS asset JOIN generation_logs AS log ON log.id = asset.generation_log_id WHERE log.user_id = $1 ORDER BY asset.generation_log_id, asset.sort_order, asset.id",
                [userId],
            );
            const conversations = await executor.query<RawSqlRow>("SELECT * FROM creative_conversations WHERE user_id = $1 ORDER BY id", [userId]);
            const assets = await executor.query<RawSqlRow>("SELECT * FROM creative_assets WHERE user_id = $1 ORDER BY id", [userId]);
            const financial = await financialRows(executor);
            return { rows: rows.rows, registrations: registry.rows, logs: logs.rows, logAssets: logAssets.rows, conversations: conversations.rows, assets: assets.rows, financial };
        });
        // Preserve raw SQL rows and JSON nulls; read file bytes outside the transaction.
        return { ...stored, nativeBytes: await readFile(nativePath), finalBytes: await readFile(finalPath) };
    }

    async function controlSnapshot(locker: Client, nativePath: string, finalPath: string) {
        const rows = await locker.query<RawTaskRow>("SELECT * FROM vozeb_pro_generation_tasks WHERE user_id = $1 ORDER BY task_type, id", [userId]);
        const registry = await locker.query<RawMediaRow>("SELECT * FROM vozeb_pro_local_media_assets WHERE owner_user_id = $1 ORDER BY storage_key", [userId]);
        const logs = await locker.query<RawSqlRow>("SELECT * FROM vozeb_pro_generation_logs WHERE user_id = $1 ORDER BY id", [userId]);
        const logAssets = await locker.query<RawSqlRow>(
            "SELECT asset.* FROM vozeb_pro_generation_log_assets AS asset JOIN vozeb_pro_generation_logs AS log ON log.id = asset.generation_log_id WHERE log.user_id = $1 ORDER BY asset.generation_log_id, asset.sort_order, asset.id",
            [userId],
        );
        const conversations = await locker.query<RawSqlRow>("SELECT * FROM vozeb_pro_creative_conversations WHERE user_id = $1 ORDER BY id", [userId]);
        const assets = await locker.query<RawSqlRow>("SELECT * FROM vozeb_pro_creative_assets WHERE user_id = $1 ORDER BY id", [userId]);
        const financial = {
            users: (await locker.query<RawSqlRow>("SELECT * FROM vozeb_pro_users WHERE id = $1 ORDER BY id", [userId])).rows,
            pointRecords: (await locker.query<RawSqlRow>("SELECT * FROM vozeb_pro_point_records WHERE user_id = $1 ORDER BY id", [userId])).rows,
            quotaUsage: (await locker.query<RawSqlRow>("SELECT * FROM vozeb_pro_quota_usage WHERE user_id = $1 ORDER BY date, usage_kind", [userId])).rows,
            dailyWallets: (await locker.query<RawSqlRow>("SELECT * FROM vozeb_pro_daily_plan_point_wallets WHERE user_id = $1 ORDER BY date", [userId])).rows,
            planAssignments: (await locker.query<RawSqlRow>("SELECT * FROM vozeb_pro_user_plan_assignments WHERE user_id = $1 ORDER BY id", [userId])).rows,
        };
        return {
            rows: rows.rows,
            registrations: registry.rows,
            logs: logs.rows,
            logAssets: logAssets.rows,
            conversations: conversations.rows,
            assets: assets.rows,
            financial,
            nativeBytes: await readFile(nativePath),
            finalBytes: await readFile(finalPath),
        };
    }

    type WaitIdentity = { imageId: string; childId: string; storageKey: string; workerId: string; executionId: string };
    type LockObservation = {
        observed_at: Date;
        lease_until: Date;
        last_heartbeat_at: Date;
        lease_live: boolean;
        lease_expired: boolean;
        image_live: boolean;
        child_live: boolean;
        final_live: boolean;
        remaining_ms: number;
        blockers: number[];
        pid: number | null;
        state: string | null;
        wait_event_type: string | null;
        wait_event: string | null;
        query: string | null;
        query_start: Date | null;
        xact_start: Date | null;
    };
    const logQuery = "SELECT * FROM vozeb_pro_generation_logs WHERE id = $1 FOR UPDATE";

    async function observeLock(locker: Client, applicationPid: number, identity: WaitIdentity) {
        await locker.query("SELECT pg_stat_clear_snapshot()");
        const observed = await locker.query<LockObservation>(
            "WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS now) SELECT observed.now AS observed_at, image.lease_until, image.last_heartbeat_at, image.lease_until > observed.now AS lease_live, image.lease_until <= observed.now AS lease_expired, image.expires_at > observed.now AS image_live, child.expires_at > observed.now AS child_live, media.expires_at > observed.now AS final_live, (extract(epoch FROM (image.lease_until - observed.now)) * 1000)::double precision AS remaining_ms, pg_blocking_pids($1::int) AS blockers, activity.pid, activity.state, activity.wait_event_type, activity.wait_event, activity.query, activity.query_start, activity.xact_start FROM vozeb_pro_generation_tasks AS image JOIN vozeb_pro_generation_tasks AS child ON child.id = $4 AND child.task_type = 'image_processing' AND child.user_id = $2 AND child.parent_task_id = image.id AND child.status = 'success' AND child.execution_phase = 'completed' JOIN vozeb_pro_local_media_assets AS media ON media.storage_key = $5 AND media.owner_user_id = $2 AND media.task_id = child.id CROSS JOIN observed LEFT JOIN pg_stat_activity AS activity ON activity.pid = $1::int WHERE image.id = $3 AND image.task_type = 'image' AND image.user_id = $2 AND image.worker_id = $6 AND image.payload ->> 'executionId' = $7",
            [applicationPid, userId, identity.imageId, identity.childId, identity.storageKey, identity.workerId, identity.executionId],
        );
        expect(observed.rows).toHaveLength(1);
        const state = observed.rows[0];
        assert.ok(state);
        return state;
    }

    function expectLogWait(state: LockObservation, applicationPid: number, lockerPid: number) {
        expect(state).toMatchObject({ pid: applicationPid, state: "active", wait_event_type: "Lock", image_live: true, child_live: true, final_live: true });
        expect(state.blockers).toContain(lockerPid);
        assert.ok(typeof state.query === "string");
        expect(state.query.replace(/\s+/g, " ").trim()).toBe(logQuery);
        expect(state.query_start).toBeInstanceOf(Date);
        expect(state.xact_start).toBeInstanceOf(Date);
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

    it("rolls back the full charged publication when its post-promotion log wait outlives the original scheduler lease", async () => {
        expect(source).toHaveLength(95);
        expect(createHash("sha256").update(source).digest("hex")).toBe("a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6");
        const credit = await wallet.creditPermanentPoints({ userId, amount: 1000, description: "Isolated completed-result consumption fixture", idempotencyKey: "fixture-result-consumption-credit:" + userId });
        expect(credit.applied).toBe(true);
        expect(credit.record).toMatchObject({ userId, type: "credit", amount: 1000 });
        const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Completed image result consumption" });
        const started = attempts.startGenerationAttempt(undefined, { model: "fixture-image-model", capability: "image" });
        const image = await imageTasks.createImageTask({
            userId,
            username,
            displayName: "Isolated result completion fixture",
            kind: "generation",
            source: "image-workbench",
            conversationId: conversation.id,
            surface: "chat",
            config: { baseUrl: "https://fixture.invalid", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model", outputBackground: "opaque" },
            prompt: "Complete local processing while leaving final ImageTask publication to its consumer",
            references: [],
            candidateConfigs: [{ baseUrl: "https://fixture.invalid", apiKey: "fixture-candidate-only", apiFormat: "openai", model: "fixture-image-model" }],
            attemptNo: started.attempt.attemptNo,
            attempts: started.attempts,
        });
        const charge = await auth.consumeUserPoints(userId, image.config.model, 1, "image", "fixture-result-consumption:" + image.id);
        expect(charge.cost).toBeGreaterThanOrEqual(0);
        expect(charge.recordId).toBeTruthy();
        await support.persistChargedImageResponse(
            image,
            new Headers({
                "x-vozeb-pro-points-cost": String(charge.cost),
                "x-vozeb-pro-points-record-id": charge.recordId,
                "x-vozeb-pro-points-remaining": String(charge.remaining),
            }),
        );
        const chargedFinancial = await ownedFinancialRows();
        expect(chargedFinancial.users).toHaveLength(1);
        expect(chargedFinancial.pointRecords).toHaveLength(2);
        expect(chargedFinancial.pointRecords.find((record) => record.id === credit.record.id)).toMatchObject({ user_id: userId, type: "credit", idempotency_key: credit.record.idempotencyKey });
        expect(chargedFinancial.pointRecords.find((record) => record.id === charge.recordId)).toMatchObject({
            user_id: userId,
            type: "consume",
            model: image.config.model,
            idempotency_key: charge.idempotencyKey,
            request_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
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
        expect(before.financial).toStrictEqual(chargedFinancial);
        expect(before.logs).toStrictEqual([]);
        expect(before.logAssets).toStrictEqual([]);
        expect(before.assets).toStrictEqual([]);
        expect(before.conversations).toHaveLength(1);
        expect(before.conversations[0]).toMatchObject({ id: conversation.id, user_id: userId });
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
        expect(beforeImage.payload.billing).toStrictEqual({ pointsCost: charge.cost, pointsRecordId: charge.recordId, refunded: false });
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

        let locker: Client | undefined;
        let transactionOpen = false;
        let consumption: ReturnType<typeof processing.consumeCompletedImageTaskResultProcessing> | undefined;
        let beforeWait: Awaited<ReturnType<typeof snapshot>> | undefined;
        let bodyFailure: { error: unknown } | undefined;

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

            expect(image.generationLogId).toBeUndefined();
            expect(image.generationSlotId).toBeUndefined();
            const logId = `image-task:${image.id}`;
            const pendingLog = await generationLogs.recordGenerationLog({
                id: logId,
                taskId: image.id,
                userId,
                username,
                displayName: image.displayName,
                conversationId: conversation.id,
                kind: "image",
                source: "image-workbench",
                status: "pending",
                title: image.prompt.slice(0, 36),
                prompt: image.prompt,
                model: image.config.model,
                summary: "Image generation pending",
                durationMs: 0,
                count: 1,
                successCount: 0,
                failCount: 0,
                assets: [],
                createdAt: image.createdAt,
            });
            expect(pendingLog).toMatchObject({ id: logId, taskId: image.id, userId, conversationId: conversation.id, status: "pending", assets: [] });
            expect(pendingLog.completedAt).toBeUndefined();
            const seeded = await snapshot(nativePath, registered.filePath);
            expect(seeded.logs).toHaveLength(1);
            const pendingLogRow = seeded.logs[0];
            assert.ok(pendingLogRow);
            expect(pendingLogRow).toMatchObject({ id: logId, user_id: userId, task_id: image.id, conversation_id: conversation.id, status: "pending" });
            expect(seeded).toStrictEqual({ ...after, logs: [pendingLogRow] });

            const { Client } = await import("pg");
            locker = new Client({ connectionString: database.getPostgresConnectionString() });
            await locker.connect();
            const owner = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const backend = await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const lockerPid = owner.rows[0]?.pid;
            const applicationPid = backend.rows[0]?.pid;
            assert.ok(lockerPid);
            assert.ok(applicationPid);
            expect(lockerPid).toBeGreaterThan(0);
            expect(applicationPid).toBeGreaterThan(0);
            expect(applicationPid).not.toBe(lockerPid);

            const consumerWorkerId = "fixture-log-lease-consumer-worker";
            const claims = await scheduler.claimDueGenerationTasks({ workerId: consumerWorkerId, taskIds: [image.id], limit: 1, leaseMs: 30_000 });
            expect(claims).toHaveLength(1);
            const claim = claims[0];
            assert.ok(claim?.executionId);
            assert.ok(typeof claim.leaseUntil === "number");
            expect(claim.id).toBe(image.id);
            expect(claim.workerId).toBe(consumerWorkerId);
            expect(claim.executionId).not.toBe(imageIdentity.executionId);
            const consumerIdentity = { taskId: image.id, workerId: consumerWorkerId, executionId: claim.executionId };
            expect(await processing.ensureImageTaskResultProcessing(consumerIdentity)).toStrictEqual({ state: "ready" });
            beforeWait = await snapshot(nativePath, registered.filePath);
            const claimedImage = beforeWait.rows.find((record) => record.id === image.id);
            assert.ok(claimedImage);
            assert.ok(claimedImage.lease_until instanceof Date);
            assert.ok(claimedImage.last_heartbeat_at instanceof Date);
            expect(claimedImage).toStrictEqual({
                ...awakened,
                payload: { ...awakened.payload, executionId: claim.executionId },
                worker_id: consumerWorkerId,
                lease_until: new Date(claim.leaseUntil),
                last_heartbeat_at: claimedImage.last_heartbeat_at,
            });
            expect(beforeWait).toStrictEqual({ ...seeded, rows: seeded.rows.map((record) => (record.id === image.id ? claimedImage : record)) });
            const waitIdentity = { imageId: image.id, childId: childClaim.id, storageKey: stored.storageKey, workerId: consumerWorkerId, executionId: claim.executionId };
            await locker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            transactionOpen = true;
            const locked = await locker.query<RawSqlRow>("SELECT * FROM vozeb_pro_generation_logs WHERE id = $1 AND user_id = $2 AND task_id = $3 FOR UPDATE", [logId, userId, image.id]);
            expect(locked.rows).toHaveLength(1);
            expect(locked.rows[0]).toStrictEqual(pendingLogRow);
            const initial = await observeLock(locker, applicationPid, waitIdentity);
            expect(initial).toMatchObject({ lease_live: true, lease_expired: false, image_live: true, child_live: true, final_live: true });
            expect(initial.lease_until).toStrictEqual(claimedImage.lease_until);
            expect(initial.last_heartbeat_at).toStrictEqual(claimedImage.last_heartbeat_at);
            expect(initial.remaining_ms).toBeGreaterThan(0);
            expect(await controlSnapshot(locker, nativePath, registered.filePath)).toStrictEqual(beforeWait);

            let settled = false;
            // The consumer promotes finals before taking this existing log-row lock.
            consumption = processing.consumeCompletedImageTaskResultProcessing(consumerIdentity);
            void consumption.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            // All pending-time queries use this external Client, never the occupied application pool.
            const blocked = await vi.waitFor(
                async () => {
                    expect(settled).toBe(false);
                    assert.ok(locker);
                    const state = await observeLock(locker, applicationPid, waitIdentity);
                    expect(state).toMatchObject({ lease_live: true, lease_expired: false });
                    expectLogWait(state, applicationPid, lockerPid);
                    expect(state.lease_until).toStrictEqual(claimedImage.lease_until);
                    expect(state.last_heartbeat_at).toStrictEqual(claimedImage.last_heartbeat_at);
                    return state;
                },
                { timeout: Math.ceil(initial.remaining_ms) },
            );
            expect(await controlSnapshot(locker, nativePath, registered.filePath)).toStrictEqual(beforeWait);
            const deadline = await observeLock(locker, applicationPid, waitIdentity);
            expectLogWait(deadline, applicationPid, lockerPid);
            expect(deadline).toMatchObject({ lease_live: true, lease_expired: false });
            // Wait only for the stored real lease's remaining database-clock interval.
            await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.ceil(deadline.remaining_ms))));
            expect(settled).toBe(false);
            const expired = await observeLock(locker, applicationPid, waitIdentity);
            expectLogWait(expired, applicationPid, lockerPid);
            expect(expired).toMatchObject({ lease_live: false, lease_expired: true });
            expect(expired.lease_until).toStrictEqual(claimedImage.lease_until);
            expect(expired.last_heartbeat_at).toStrictEqual(claimedImage.last_heartbeat_at);
            expect(expired.observed_at.getTime()).toBeGreaterThanOrEqual(claimedImage.lease_until.getTime());
            expect(expired.query_start).toStrictEqual(blocked.query_start);
            expect(expired.xact_start).toStrictEqual(blocked.xact_start);
            expect(await controlSnapshot(locker, nativePath, registered.filePath)).toStrictEqual(beforeWait);
            await locker.query("ROLLBACK");
            transactionOpen = false;
            expect(await consumption).toStrictEqual({ state: "ownership_lost" });
            expect(await snapshot(nativePath, registered.filePath)).toStrictEqual(beforeWait);
            expect(await database.postgresQuery("SELECT 1 AS reusable")).toMatchObject({ rows: [{ reusable: 1 }] });
            console.info("PG consumer post-promotion log wait natural owner lease expiry", { applicationPid, lockerPid, logId, storageKey: stored.storageKey, blocked, expired });
        } catch (error) {
            bodyFailure = { error };
            throw error;
        } finally {
            const cleanupErrors: unknown[] = [];
            if (locker && transactionOpen) {
                try {
                    await locker.query("ROLLBACK");
                    transactionOpen = false;
                } catch (error) {
                    cleanupErrors.push(error);
                }
            }
            // Closing this owned control connection also releases its lock if rollback failed.
            if (locker) {
                try {
                    await locker.end();
                } catch (error) {
                    cleanupErrors.push(error);
                }
            }
            if (consumption) {
                const settlements = await Promise.allSettled([consumption]);
                cleanupErrors.push(...settlements.flatMap((result) => (result.status === "rejected" && result.reason !== bodyFailure?.error ? [result.reason] : [])));
            }
            // The consumer is fully drained before any application-pool read is issued.
            const conservation = await Promise.allSettled([
                beforeWait ? snapshot(nativePath, registered.filePath).then((state) => expect(state).toStrictEqual(beforeWait)) : Promise.resolve(),
                ownedRegistrations().then((records) => expect(records.find((record) => record.storage_key === slot.storageKey)).toStrictEqual(before.registrations.find((record) => record.storage_key === slot.storageKey))),
                ownedFinancialRows().then((state) => expect(state).toStrictEqual(chargedFinancial)),
                readFile(nativePath).then((bytes) => expect(bytes).toEqual(before.nativeBytes)),
                readFile(registered.filePath).then((bytes) => expect(bytes).toEqual(before.finalBytes)),
            ]);
            cleanupErrors.push(...conservation.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
            if (cleanupErrors.length) throw new AggregateError(bodyFailure ? [bodyFailure.error, ...cleanupErrors] : cleanupErrors, "PG consumer post-promotion log lease gate cleanup or conservation failed");
        }
    }, 60_000);
});
