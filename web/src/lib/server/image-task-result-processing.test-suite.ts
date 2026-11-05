import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoredGenerationTaskRecord } from "./generation-task-types";
import type { AuthDatabase, StoredPointRecord } from "@/lib/auth/store-types";
import type { GenerationLogDatabase, StoredGenerationLog } from "./generation-log-types";
import type { ClosedImageProcessingFailure, FailImageProcessingInput } from "./image-processing-service";

const boundary = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", async () => {
    const { RequestCookies } = await import("next/dist/server/web/spec-extension/cookies");
    return { cookies: async () => new RequestCookies(new Headers({ cookie: boundary.cookie })) };
});

export function imageTaskResultProcessingSuite(provider: "file" | "postgres") {
    const enabled = provider === "file" || process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1";
    (enabled ? describe : describe.skip)(`${provider} image task result processing enqueue`, () => {
        let directory: string;
        let userId: string;
        let source: Buffer;
        let database: typeof import("./database");
        let imageTasks: typeof import("./image-task-store");
        let tasks: typeof import("./generation-task-store");
        let scheduler: typeof import("./generation-task-scheduler");
        let registrations: typeof import("./local-media-registry");
        let media: typeof import("./local-media-storage");
        let capture: typeof import("./image-task-native-capture");
        let processing: typeof import("./image-task-result-processing");
        let service: typeof import("./image-processing-service");
        let auth: typeof import("@/lib/auth/store");
        const workerId = "fixture-image-result-enqueue-worker";
        const workerToken = "fixture-result-failure-worker-token-000001";

        beforeAll(async () => {
            if (provider === "postgres" && (process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" || process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" || !process.env.DATABASE_URL))
                throw new Error("Explicit isolated PostgreSQL fixture with startup pool maximum one is required");
            directory = await mkdtemp(path.join(tmpdir(), "vozeb-image-result-enqueue-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            if (provider === "file") {
                vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
                vi.stubEnv("VOZEB_PRO_INSTALL_TOKEN", "fixture-result-failure-file-install-token");
            }
            vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
            vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-result-failure-maintenance-token-01");
            vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
            vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
            [database, imageTasks, tasks, scheduler, registrations, media, capture, processing, service, auth] = await Promise.all([
                import("./database"),
                import("./image-task-store"),
                import("./generation-task-store"),
                import("./generation-task-scheduler"),
                import("./local-media-registry"),
                import("./local-media-storage"),
                import("./image-task-native-capture"),
                import("./image-task-result-processing"),
                import("./image-processing-service"),
                import("@/lib/auth/store"),
            ]);
            if (provider === "postgres") await database.initializePostgresSchema();
            const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
            if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated result enqueue fixture requires local media storage");
            userId = `fixture-image-result-enqueue-${randomUUID()}`;
            if (provider === "file") {
                const admin = await auth.createFirstAdmin({ username: "fixture-result-file-admin", password: "FixtureResultPassword1!", displayName: "Fixture administrator", installToken: process.env.VOZEB_PRO_INSTALL_TOKEN });
                const user = await auth.createUserByAdmin({ actorId: admin.id, username: "fixture-result-file-user", password: "FixtureResultPassword1!", displayName: "Isolated image result fixture", pointsBalance: 1000 });
                userId = user.id;
            } else {
                const repositories = database.createPostgresRepositories();
                const settings = await repositories.settings.getSettings();
                const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
                if (!planId) throw new Error("Fixture entitlement plan missing");
                await repositories.users.createWithNextAccountId({
                    id: userId,
                    username: `fixture_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
                    displayName: "Isolated image result enqueue fixture",
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
            }
            const session = await auth.createSession(userId);
            expect(await auth.getUserBySession(session)).toMatchObject({ id: userId, role: "user" });
            boundary.cookie = `vozeb_pro_session=${session}`;
            source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 24, g: 48, b: 72 } } })
                .png()
                .toBuffer();
        }, 30_000);

        afterAll(async () => {
            try {
                if (provider === "postgres" && userId) await database.postgresQuery("DELETE FROM users WHERE id = $1", [userId]);
            } finally {
                boundary.cookie = "";
                vi.unstubAllEnvs();
                if (directory) await rm(directory, { recursive: true, force: true });
            }
        });

        async function sealedImage(leaseMs?: number, origin = "https://image.example.com", billing: "fixture" | "none" | "charged" = "fixture", pointsCost: 0 | 3 = 3) {
            const task = await imageTasks.createImageTask({
                userId,
                username: "fixture-image-result-enqueue",
                displayName: "Isolated image result enqueue fixture",
                kind: "generation",
                source: "image-workbench",
                config: { baseUrl: origin, apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model", outputBackground: "opaque" },
                prompt: "Process the sealed native result without a Run or upstream ID",
                references: [],
                attemptNo: 1,
                attempts: [],
                billing: billing === "fixture" ? { pointsCost: 3, pointsRecordId: `fixture-billing-${randomUUID()}`, refunded: false } : undefined,
            });
            let charged: { baseline: Awaited<ReturnType<typeof financialTruth>>; record: StoredPointRecord; units: number; date: string } | undefined;
            if (billing === "charged") {
                const { consumePoints, getPointsWalletSnapshot } = await import("./points-wallet-service");
                const { imageUnits } = await import("@/app/api/image-tasks/image-task-support");
                // Wallet settlement is fixture setup only; no settling observer is used after fail.
                const wallet = await getPointsWalletSnapshot(userId);
                const settings = await auth.getAuthSettings();
                const units = imageUnits(task.config.quality, settings.generationPointMultipliers.imageQuality);
                const baseline = await financialTruth(task.id, wallet.dailyDate);
                const charge = await consumePoints({ userId, amount: pointsCost, units, usageKind: "image", model: task.config.model, description: "Controlled result failure fixture charge", idempotencyKey: `image-task:${task.id}:attempt:1:consume` });
                expect(charge.applied).toBe(true);
                expect(charge.record).toMatchObject({ userId, type: "consume", amount: 0 - pointsCost, sourceDate: wallet.dailyDate });
                assert.ok(
                    await imageTasks.updateImageTask(task.id, {
                        billing: { pointsCost, pointsRecordId: charge.record.id, refunded: false },
                        attempts: [{ attemptNo: 1, model: task.config.model, status: "running", startedAt: task.createdAt, pointsCost, pointsRecordId: charge.record.id }],
                    }),
                );
                charged = { baseline, record: charge.record, units, date: wallet.dailyDate };
            }
            assert.ok(await imageTasks.transitionImageTask(task, ["pending"], { status: "running" }));
            await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "created", nextPollAt: Date.now() - 1 });
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [task.id], limit: 1, leaseMs });
            assert.equal(claimed.length, 1);
            const lease = claimed[0];
            assert.ok(lease?.executionId);
            const original = { taskId: task.id, workerId, executionId: lease.executionId };
            expect(
                await capture.captureImageTaskNativeResults({
                    ...original,
                    attemptNo: 1,
                    upstreamTaskId: null,
                    result: { dataUrl: `data:image/png;base64,${source.toString("base64")}` },
                    origin,
                    authContext: "",
                }),
            ).toMatchObject({ state: "native_ready" });
            const image = await imageTasks.getImageTask(task.id);
            assert.ok(image?.nativeResults);
            expect(image.runId).toBeUndefined();
            expect(image.upstream).toBeUndefined();
            expect(image.nativeResults).toMatchObject({ version: "image-task-native-results.v1", attemptNo: 1, upstreamTaskId: null });
            expect(image.nativeResults.slots).toHaveLength(1);
            const slot = image.nativeResults.slots[0];
            assert.ok(slot?.status === "stored");
            expect(slot).toMatchObject({
                resultId: `${task.id}:1`,
                resultIndex: 1,
                scope: "reference",
                storageProvider: "local",
                sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6",
                bytes: 95,
                layout: { format: "png", depth: "uchar", channels: 3 },
            });
            expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({
                storageKey: slot.storageKey,
                scope: "reference",
                storageClass: "permanent",
                type: "attachment",
                mimeType: "application/octet-stream",
                ownerUserId: userId,
                taskId: task.id,
                storageProvider: "local",
                bytes: 95,
            });
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(source);
            return { original, image, slot, leaseUntil: lease.leaseUntil, charged };
        }

        async function resultSnapshot(taskId: string) {
            if (provider === "postgres") {
                return database.withPostgresTransaction(async (executor) => {
                    await executor.query("SET TRANSACTION READ ONLY");
                    // Remove only top-level SQL nulls; nativeResults.upstreamTaskId stays JSON null.
                    const result = await executor.query<{ record: StoredGenerationTaskRecord }>(
                        `SELECT jsonb_object_agg(field.key, field.value) AS record
                         FROM generation_tasks AS task
                         CROSS JOIN LATERAL jsonb_each(jsonb_build_object(
                             'id', task.id, 'userId', task.user_id, 'type', task.task_type,
                             'status', task.status, 'payload', task.payload,
                             'createdAt', floor(extract(epoch FROM task.created_at) * 1000),
                             'updatedAt', floor(extract(epoch FROM task.updated_at) * 1000),
                             'expiresAt', floor(extract(epoch FROM task.expires_at) * 1000),
                             'conversationId', task.conversation_id, 'runId', task.run_id,
                             'surface', task.surface, 'projectId', task.project_id,
                             'episodeId', task.payload ->> 'episodeId', 'shotId', task.payload ->> 'shotId',
                             'estimatedPoints', task.payload -> 'estimatedPoints',
                             'parentTaskId', task.parent_task_id, 'attemptNo', task.attempt_no,
                             'clientRequestId', task.client_request_id, 'executionPhase', task.execution_phase,
                             'upstreamTaskId', task.upstream_task_id, 'channelId', task.channel_id,
                             'provider', task.provider, 'queryPath', task.query_path,
                             'submittedAt', floor(extract(epoch FROM task.submitted_at) * 1000),
                             'nextPollAt', floor(extract(epoch FROM task.next_poll_at) * 1000),
                             'lastPollAt', floor(extract(epoch FROM task.last_poll_at) * 1000),
                             'lastUpstreamStatus', task.last_upstream_status,
                             'resultPayload', COALESCE(task.result_payload, '{}'::jsonb),
                             'workerId', task.worker_id,
                             'leaseUntil', floor(extract(epoch FROM task.lease_until) * 1000),
                             'lastHeartbeatAt', floor(extract(epoch FROM task.last_heartbeat_at) * 1000)
                         )) AS field
                         WHERE ((task.task_type = 'image' AND task.id = $1)
                             OR (task.task_type = 'image_processing' AND task.parent_task_id = $1))
                           AND field.value <> 'null'::jsonb
                         GROUP BY task.id
                         ORDER BY task.id`,
                        [taskId],
                    );
                    const records = result.rows.map((row) => row.record);
                    const image = records.find((record) => record.type === "image" && record.id === taskId);
                    assert.ok(image);
                    return { image, children: records.filter((record) => record.type === "image_processing" && record.parentTaskId === taskId) };
                });
            }
            // Read both sides under one file lock so assertions see one committed snapshot.
            return tasks.withGenerationTaskFileMutation(async (records) => {
                const image = records.find((record) => record.type === "image" && record.id === taskId);
                assert.ok(image);
                const children = records.filter((record) => record.type === "image_processing" && record.parentTaskId === taskId);
                return { tasks: records, result: { image, children } };
            });
        }

        async function nativeRegistrations(taskId: string) {
            if (provider === "postgres") return (await database.postgresQuery("SELECT * FROM local_media_assets WHERE owner_user_id = $1 AND task_id = $2 ORDER BY storage_key", [userId, taskId])).rows;
            return (await registrations.listFileLocalMediaRegistrations()).filter((registration) => registration.ownerUserId === userId && registration.taskId === taskId).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey));
        }

        async function ownedProcessingRows() {
            if (provider === "postgres") {
                return database.withPostgresTransaction(async (executor) => {
                    await executor.query("SET TRANSACTION READ ONLY");
                    return (await executor.query<Record<string, unknown>>("SELECT * FROM generation_tasks WHERE task_type = 'image_processing' AND user_id = $1 ORDER BY id", [userId])).rows;
                });
            }
            return tasks.withGenerationTaskFileMutation(async (records) => ({
                tasks: records,
                result: records.filter((record) => record.type === "image_processing" && record.userId === userId).toSorted((left, right) => left.id.localeCompare(right.id)),
            }));
        }

        async function corruptChildBusinessAttempt(childId: string, imageId: string) {
            if (provider === "postgres") {
                const result = await database.postgresQuery(
                    `UPDATE generation_tasks
                     SET payload = jsonb_set(payload, '{imageResultBinding,nativeResults,attemptNo}', '2'::jsonb)
                     WHERE id = $1 AND task_type = 'image_processing' AND user_id = $2 AND parent_task_id = $3
                     RETURNING id`,
                    [childId, userId, imageId],
                );
                assert.equal(result.rows.length, 1);
                return;
            }
            await tasks.withGenerationTaskFileMutation(async (records) => {
                const child = records.find((record) => record.id === childId && record.type === "image_processing" && record.userId === userId && record.parentTaskId === imageId);
                assert.ok(child);
                const binding = child.payload.imageResultBinding;
                assert.ok(binding && typeof binding === "object" && "nativeResults" in binding);
                const native = binding.nativeResults;
                assert.ok(native && typeof native === "object" && "attemptNo" in native);
                assert.equal(native.attemptNo, 1);
                const updated = { ...child, payload: { ...child.payload, imageResultBinding: { ...binding, nativeResults: { ...native, attemptNo: 2 } } } };
                return { tasks: records.map((record) => (record === child ? updated : record)), result: undefined };
            });
        }

        async function persistNullResultProcessing(sealed: Awaited<ReturnType<typeof sealedImage>>) {
            if (provider === "postgres") {
                const changed = await database.postgresQuery(
                    `UPDATE generation_tasks SET payload = jsonb_set(payload, '{resultProcessing}', 'null'::jsonb)
                     WHERE id = $1 AND task_type = 'image' AND user_id = $2 AND worker_id = $3 AND payload ->> 'executionId' = $4
                     RETURNING id`,
                    [sealed.original.taskId, userId, workerId, sealed.original.executionId],
                );
                assert.equal(changed.rows.length, 1);
                return;
            }
            await tasks.withGenerationTaskFileMutation(async (records) => {
                const image = records.find((record) => record.type === "image" && record.id === sealed.original.taskId && record.userId === userId);
                assert.ok(image);
                assert.equal(image.workerId, workerId);
                assert.equal(image.payload.executionId, sealed.original.executionId);
                return { tasks: records.map((record) => (record === image ? { ...record, payload: { ...record.payload, resultProcessing: null } } : record)), result: undefined };
            });
        }

        type EnsureSettlement = PromiseSettledResult<Awaited<ReturnType<typeof processing.ensureImageTaskResultProcessing>>>;
        type RegistryBarrier = { lockWait: boolean; controllerBlocks: boolean; registryQuery: boolean; leaseAlive: boolean };

        async function waitForRegistryBarrier(controller: Client, appPid: number, controllerPid: number, leaseUntil: number, hasSettled: () => boolean) {
            for (;;) {
                // Refresh activity state inside the still-open controller transaction.
                await controller.query("SELECT pg_stat_clear_snapshot()");
                const result = await controller.query<RegistryBarrier>(
                    `SELECT wait_event_type = 'Lock' AS "lockWait",
                            $2::integer = ANY(pg_blocking_pids(pid)) AS "controllerBlocks",
                            query LIKE '%vozeb_pro_local_media_assets%' AND query LIKE '%FOR UPDATE%' AS "registryQuery",
                            clock_timestamp() < $3::timestamptz AS "leaseAlive"
                     FROM pg_stat_activity WHERE pid = $1`,
                    [appPid, controllerPid, new Date(leaseUntil)],
                );
                const state = result.rows[0];
                assert.ok(state, "Application backend disappeared before the registry barrier");
                if (hasSettled()) throw new Error("Ensure settled before the real registry lock barrier");
                if (!state.leaseAlive) throw new Error("Image lease expired before the registry barrier was observed");
                if (state.lockWait && state.controllerBlocks && state.registryQuery) return state;
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
        }

        async function crossRegistryLockLease(sealed: Awaited<ReturnType<typeof sealedImage>>, bytes: number) {
            assert.ok(sealed.leaseUntil !== undefined);
            const controller = new Client({ connectionString: process.env.DATABASE_URL });
            let transactionOpen = false;
            let ensurePending: Promise<void> | undefined;
            let settlement: EnsureSettlement | undefined;
            try {
                await controller.connect();
                await controller.query("BEGIN");
                transactionOpen = true;
                const identity = await controller.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                const controllerPid = identity.rows[0]?.pid;
                assert.ok(controllerPid !== undefined);
                // The isolated controller uses the current physical prefix; application SQL keeps its normal adapter.
                const locked = await controller.query(
                    `UPDATE vozeb_pro_local_media_assets SET bytes = $4::bigint
                     WHERE storage_key = $1 AND owner_user_id = $2 AND task_id = $3 RETURNING storage_key`,
                    [sealed.slot.storageKey, userId, sealed.original.taskId, bytes],
                );
                assert.equal(locked.rows.length, 1);
                const appIdentity = await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                const appPid = appIdentity.rows[0]?.pid;
                assert.ok(appPid !== undefined);
                assert.notEqual(controllerPid, appPid);
                ensurePending = processing.ensureImageTaskResultProcessing(sealed.original).then(
                    (value) => {
                        settlement = { status: "fulfilled", value };
                    },
                    (reason: unknown) => {
                        settlement = { status: "rejected", reason };
                    },
                );
                const barrier = await waitForRegistryBarrier(controller, appPid, controllerPid, sealed.leaseUntil, () => settlement !== undefined);
                // Wait for the actual server deadline, rather than a fixed duration.
                await controller.query("SELECT pg_sleep(GREATEST(0::double precision, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))::double precision))", [new Date(sealed.leaseUntil)]);
                const clock = await controller.query<{ expired: boolean }>("SELECT clock_timestamp() >= $1::timestamptz AS expired", [new Date(sealed.leaseUntil)]);
                const expired = clock.rows[0]?.expired;
                assert.equal(expired, true);
                await controller.query("COMMIT");
                transactionOpen = false;
                await ensurePending;
                assert.ok(settlement);
                return { barrier, expired, settlement };
            } finally {
                try {
                    if (transactionOpen) await controller.query("ROLLBACK");
                } finally {
                    try {
                        await controller.end();
                    } finally {
                        await ensurePending;
                    }
                }
            }
        }

        async function withLocalProvider(action: (origin: string, requests: string[]) => Promise<void>) {
            const requests: string[] = [];
            const server = createServer((request, response) => {
                requests.push(`${request.method} ${request.url}`);
                request.resume();
                response.writeHead(500, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "Sealed native recovery must not call its provider" }));
            });
            try {
                await new Promise<void>((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(0, "127.0.0.1", resolve);
                });
                const address = server.address();
                assert.ok(address && typeof address !== "string");
                await action(`http://127.0.0.1:${address.port}`, requests);
            } finally {
                server.closeAllConnections();
                if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
            }
        }

        type LedgerTruth = Pick<StoredPointRecord, "id" | "userId" | "type" | "amount" | "permanentAmount" | "dailyAmount" | "balanceAfter" | "permanentBalanceAfter" | "dailyBalanceAfter" | "idempotencyKey" | "sourceRecordId" | "sourceDate">;
        type LogTruth = Pick<StoredGenerationLog, "id" | "taskId" | "userId" | "kind" | "source" | "status" | "summary" | "count" | "successCount" | "failCount" | "error" | "completedAt" | "assets">;
        type FinancialTruth = { permanentPoints: number; dailyPoints: number; quota: { pointsSpent: number; units: number }; records: LedgerTruth[]; logs: LogTruth[]; raw: unknown };

        async function rawFinancialFile(name: string) {
            const filePath = path.join(directory, name);
            try {
                const [bytes, identity] = await Promise.all([readFile(filePath), stat(filePath, { bigint: true })]);
                return { bytes, dev: identity.dev, ino: identity.ino, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
            }
        }

        async function financialTruth(taskId: string, date: string): Promise<FinancialTruth> {
            // Read committed durable facts directly. Public GET, recovery and wallet snapshots can repair state.
            if (provider === "postgres")
                return database.withPostgresTransaction(async (executor) => {
                    await executor.query("SET TRANSACTION READ ONLY");
                    const users = await executor.query<{ permanentPoints: number; raw: unknown }>('SELECT points_balance::float8 AS "permanentPoints", to_jsonb(u) AS raw FROM users u WHERE id = $1', [userId]);
                    const user = users.rows[0];
                    assert.ok(user);
                    const wallets = await executor.query<{ dailyPoints: number; raw: unknown }>('SELECT remaining_points::float8 AS "dailyPoints", to_jsonb(w) AS raw FROM daily_plan_point_wallets w WHERE user_id = $1 AND date = $2::date', [userId, date]);
                    const quotas = await executor.query<{ pointsSpent: number; units: number; raw: unknown }>(
                        "SELECT points_spent::float8 AS \"pointsSpent\", units::float8 AS units, to_jsonb(q) AS raw FROM quota_usage q WHERE user_id = $1 AND date = $2::date AND usage_kind = 'image'",
                        [userId, date],
                    );
                    const records = await executor.query<{ record: LedgerTruth; raw: unknown }>(
                        `SELECT jsonb_strip_nulls(jsonb_build_object('id', id, 'userId', user_id, 'type', type, 'amount', amount,
                            'permanentAmount', permanent_amount, 'dailyAmount', daily_amount, 'balanceAfter', balance_after,
                            'permanentBalanceAfter', permanent_balance_after, 'dailyBalanceAfter', daily_balance_after,
                            'idempotencyKey', idempotency_key, 'sourceRecordId', source_record_id, 'sourceDate', source_date)) AS record,
                            to_jsonb(p) AS raw FROM point_records p WHERE user_id = $1 ORDER BY id`,
                        [userId],
                    );
                    const logs = await executor.query<{ log: LogTruth; raw: unknown }>(
                        `SELECT jsonb_strip_nulls(jsonb_build_object('id', id, 'taskId', task_id, 'userId', user_id,
                            'kind', kind, 'source', source, 'status', status, 'summary', summary, 'count', count,
                            'successCount', success_count, 'failCount', fail_count, 'error', error, 'completedAt', completed_at,
                            'assets', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM generation_log_assets a WHERE a.generation_log_id = l.id), '[]'::jsonb))) AS log,
                            to_jsonb(l) AS raw FROM generation_logs l WHERE user_id = $1 AND task_id = $2 ORDER BY id`,
                        [userId, taskId],
                    );
                    const quota = quotas.rows[0];
                    return {
                        permanentPoints: user.permanentPoints,
                        dailyPoints: wallets.rows[0]?.dailyPoints ?? 0,
                        quota: quota ? { pointsSpent: quota.pointsSpent, units: quota.units } : { pointsSpent: 0, units: 0 },
                        records: records.rows.map((row) => row.record),
                        logs: logs.rows.map((row) => row.log),
                        raw: { users: users.rows, wallets: wallets.rows, quotas: quotas.rows, records: records.rows, logs: logs.rows },
                    };
                });
            const [authFile, logFile] = await Promise.all([rawFinancialFile("auth.json"), rawFinancialFile("generation-logs.json")]);
            assert.ok(authFile);
            const db: AuthDatabase = JSON.parse(authFile.bytes.toString("utf8"));
            const user = db.users.find((item) => item.id === userId);
            assert.ok(user);
            const wallet = db.dailyPlanPointWallets.find((item) => item.userId === userId && item.date === date);
            const quota = db.quotaUsage.find((item) => item.userId === userId && item.date === date && item.usageKind === "image");
            const logs: GenerationLogDatabase = logFile ? JSON.parse(logFile.bytes.toString("utf8")) : { version: 1, logs: [] };
            return {
                permanentPoints: user.pointsBalance,
                dailyPoints: wallet?.remainingPoints ?? 0,
                quota: quota ? { pointsSpent: quota.pointsSpent, units: quota.units } : { pointsSpent: 0, units: 0 },
                records: db.pointRecords.filter((item) => item.userId === userId).toSorted((a, b) => a.id.localeCompare(b.id)),
                logs: logs.logs.filter((item) => item.userId === userId && item.taskId === taskId).toSorted((a, b) => a.id.localeCompare(b.id)),
                raw: { authFile, logFile },
            };
        }

        async function withFinancialQuotaTracking(action: () => Promise<void>) {
            // Default fixtures disable quota tracking; enable one existing cost control only in this isolated scope.
            const control = { maxPointsPerTask: 3, dailyUserPointSpend: 0, dailyTotalPointSpend: 0 };
            if (provider === "postgres") {
                const settings = database.createPostgresRepositories().settings;
                const saved = (await settings.getSettings()).settings;
                assert.ok(saved);
                try {
                    await settings.updateSettings({ generationCostControl: control });
                    await action();
                } finally {
                    await settings.updateSettings({ generationCostControl: saved.generationCostControl });
                }
                return;
            }
            const { readAuthDb, mutateAuthDb } = await import("@/lib/auth/store-repository");
            const saved = (await readAuthDb()).settings.generationCostControl;
            try {
                await mutateAuthDb((db) => {
                    db.settings.generationCostControl = control;
                });
                await action();
            } finally {
                await mutateAuthDb((db) => {
                    db.settings.generationCostControl = saved;
                });
            }
        }

        async function claimedChargedResult(origin: string, pointsCost: 0 | 3 = 3) {
            const sealed = await sealedImage(undefined, origin, "charged", pointsCost);
            assert.ok(sealed.charged);
            const charge = sealed.charged;
            // Prove a real consume and quota debit before entering the fail Route.
            const debited = await financialTruth(sealed.original.taskId, charge.date);
            expect(debited.permanentPoints + debited.dailyPoints).toBe(charge.baseline.permanentPoints + charge.baseline.dailyPoints - pointsCost);
            expect(debited.quota).toEqual({ pointsSpent: charge.baseline.quota.pointsSpent + pointsCost, units: charge.baseline.quota.units + charge.units });
            expect(debited.records.find((record) => record.id === charge.record.id)).toMatchObject({ type: "consume", amount: 0 - pointsCost, idempotencyKey: `image-task:${sealed.original.taskId}:attempt:1:consume` });
            expect(debited.logs).toEqual([]);
            expect(await processing.ensureImageTaskResultProcessing(sealed.original)).toMatchObject({ state: "waiting" });
            const image = await imageTasks.getImageTask(sealed.original.taskId);
            assert.ok(image?.resultProcessing);
            const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
            const configured = imageProcessingResourceConfig(process.env);
            const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const child = claimed.tasks[0];
            assert.ok(child);
            expect(child.id).toBe(image.resultProcessing.jobId);
            return { sealed, child, charge, debited };
        }

        function controlledRejectedFailure(current: FailureFixture): ClosedImageProcessingFailure {
            return {
                status: "rejected",
                jobId: current.child.id,
                executionId: current.child.executionId,
                pid: 4321,
                exitCode: 0,
                signal: null,
                stderr: "controlled Worker report: /fixture/private/child.stderr",
                error: { code: "fixture_closed_rejection", message: "controlled Worker report: /fixture/private/input.png" },
            };
        }

        async function withUnreadableFinancialFile<T>(name: "auth.json" | "generation-logs.json", action: () => Promise<T>) {
            const filePath = path.join(directory, name);
            const savedPath = path.join(directory, `${name}.fixture-original-${randomUUID()}`);
            const original = await rawFinancialFile(name);
            if (original) await rename(filePath, savedPath);
            let createdDirectory = false;
            try {
                // A real filesystem boundary failure, after the owner can persist its generation-task receipt.
                await mkdir(filePath);
                createdDirectory = true;
                return await action();
            } finally {
                if (createdDirectory) await rmdir(filePath);
                if (original) await rename(savedPath, filePath);
            }
        }

        function fileSettlementLatch() {
            let resolve!: () => void;
            const promise = new Promise<void>((done) => {
                resolve = done;
            });
            return { promise, resolve };
        }

        async function waitForFileFailCreativeBarrier(leaseUntil: number, settled: () => boolean) {
            for (;;) {
                if (settled()) throw new Error("Fail Route settled before holding the real creative lock");
                if (Date.now() >= leaseUntil) throw new Error("Child lease expired before the File fail lock barrier");
                try {
                    await stat(path.join(directory, "creative-runtime.json.lock"));
                    const observedAt = Date.now();
                    assert.ok(observedAt < leaseUntil, "Child lease must be live at the real creative lock barrier");
                    return observedAt;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
        }

        if (provider === "file") {
            it.each([
                { fileName: "auth.json" as const, maximumRefunds: 0 },
                { fileName: "generation-logs.json" as const, maximumRefunds: 1 },
            ])(
                "persists a rejected receipt before a real $fileName settlement failure and finishes it by original fail replay",
                async ({ fileName, maximumRefunds }) => {
                    await withFinancialQuotaTracking(() =>
                        withLocalProvider(async (origin, requests) => {
                            const current = await claimedChargedResult(origin);
                            const failure = controlledRejectedFailure(current);
                            const response = await withUnreadableFinancialFile(fileName, () => postClosedFailure(origin, current, failure));
                            const body = await response.json();
                            expect(response.status, JSON.stringify(body)).toBe(500);
                            expect(body).toEqual({ code: 500, data: null, msg: "图像处理失败状态登记失败" });
                            const closed = await failureTruth(current.sealed.original.taskId);
                            const interrupted = await financialTruth(current.sealed.original.taskId, current.charge.date);
                            expect(closed.image).toMatchObject({
                                status: "error",
                                executionPhase: "completed",
                                payload: { status: "error", retryable: true, attemptNo: 1, attempts: [{ attemptNo: 1, status: "failed", pointsRecordId: current.charge.record.id }] },
                            });
                            expect(closed.children[0]).toMatchObject({ id: current.child.id, status: "error", executionPhase: "needs_review", resultPayload: { workerId, executionId: current.child.executionId, failure } });
                            expect(closed.children[0]?.workerId).toBeUndefined();
                            expect(closed.children[0]?.leaseUntil).toBeUndefined();
                            expect(interrupted.records.filter((record) => record.type === "refund" && record.sourceRecordId === current.charge.record.id).length).toBeLessThanOrEqual(maximumRefunds);
                            expect(interrupted.records.filter((record) => record.type === "consume")).toEqual(current.debited.records.filter((record) => record.type === "consume"));
                            expect(interrupted.logs).toEqual([]);
                            const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
                            const configured = imageProcessingResourceConfig(process.env);
                            expect(await service.claimImageProcessingTasks({ workerId: "fixture-closed-result-cannot-reclaim", profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 })).toEqual({ tasks: [] });
                            const replay = await postClosedFailure(origin, current, failure);
                            const receipt = { code: 0, data: { jobId: current.child.id, status: "error", executionPhase: "needs_review" }, msg: "OK" };
                            expect(replay.status, JSON.stringify(await replay.clone().json())).toBe(200);
                            expect(await replay.json()).toEqual(receipt);
                            const settled = await failureTruth(current.sealed.original.taskId);
                            const finance = await financialTruth(current.sealed.original.taskId, current.charge.date);
                            expect(settled.image.payload.billing).toEqual({ pointsCost: 3, pointsRecordId: current.charge.record.id, refunded: true });
                            expect(settled.image.payload.nativeResults).toEqual(current.sealed.image.nativeResults);
                            expect(settled.image.payload.resultProcessing).toEqual(closed.image.payload.resultProcessing);
                            expect(settled.children).toEqual(closed.children);
                            expect(settled.registered).toEqual(closed.registered);
                            expect(finance.permanentPoints).toBe(current.charge.baseline.permanentPoints);
                            expect(finance.dailyPoints).toBe(current.charge.baseline.dailyPoints);
                            expect(finance.quota).toEqual(current.charge.baseline.quota);
                            expect(finance.records.filter((record) => record.type === "consume")).toEqual(current.debited.records.filter((record) => record.type === "consume"));
                            expect(finance.records.filter((record) => record.type === "refund" && record.sourceRecordId === current.charge.record.id)).toEqual([
                                expect.objectContaining({ amount: 3, idempotencyKey: `image-task:${current.sealed.original.taskId}:attempt:1:refund` }),
                            ]);
                            expect(finance.records).toHaveLength(current.debited.records.length + 1);
                            expect(finance.logs).toEqual([
                                expect.objectContaining({
                                    id: `image-task:${current.sealed.original.taskId}`,
                                    userId,
                                    taskId: current.sealed.original.taskId,
                                    status: "failed",
                                    count: 1,
                                    successCount: 0,
                                    failCount: 1,
                                    assets: [],
                                    error: settled.image.payload.error,
                                }),
                            ]);
                            const completedReplay = await postClosedFailure(origin, current, failure);
                            expect(completedReplay.status).toBe(200);
                            expect(await completedReplay.json()).toEqual(receipt);
                            expect(await failureTruth(current.sealed.original.taskId)).toEqual(settled);
                            expect(await financialTruth(current.sealed.original.taskId, current.charge.date)).toEqual(finance);
                            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, current.sealed.slot.storageKey))).toEqual(source);
                            expect(requests).toEqual([]);
                        }),
                    );
                },
                30_000,
            );

            it("refuses a rejected fail queued across the real child lease before any durable error or refund", async () => {
                await withFinancialQuotaTracking(() =>
                    withLocalProvider(async (origin, requests) => {
                        const current = await claimedChargedResult(origin);
                        const failure = controlledRejectedFailure(current);
                        const before = await failureTruth(current.sealed.original.taskId);
                        const beforeFinance = await financialTruth(current.sealed.original.taskId, current.charge.date);
                        const entered = fileSettlementLatch();
                        const release = fileSettlementLatch();
                        const releaseWithoutWrite = new Error("Release only the fixture generation lock without writing");
                        const held = tasks
                            .withGenerationTaskFileMutation<never>(async () => {
                                entered.resolve();
                                await release.promise;
                                throw releaseWithoutWrite;
                            })
                            .catch((error: unknown) => {
                                if (error !== releaseWithoutWrite) throw error;
                            });
                        let pending: Promise<Response> | undefined;
                        let settled = false;
                        try {
                            await entered.promise;
                            pending = postClosedFailure(origin, current, failure).then((response) => {
                                settled = true;
                                return response;
                            });
                            await waitForFileFailCreativeBarrier(current.child.leaseUntil, () => settled);
                            // This duration is the real claim's deadline, not a fixed fixture delay or shortened lease.
                            await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, current.child.leaseUntil - Date.now())));
                            expect(Date.now()).toBeGreaterThanOrEqual(current.child.leaseUntil);
                            expect(settled).toBe(false);
                            release.resolve();
                            await held;
                            const response = await pending;
                            const body = await response.json();
                            expect(response.status, JSON.stringify(body)).toBe(409);
                            expect(body).toMatchObject({ code: 409, data: null });
                            expect(await failureTruth(current.sealed.original.taskId)).toEqual(before);
                            expect(await financialTruth(current.sealed.original.taskId, current.charge.date)).toEqual(beforeFinance);
                            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, current.sealed.slot.storageKey))).toEqual(source);
                            expect(requests).toEqual([]);
                        } finally {
                            release.resolve();
                            try {
                                await held;
                                await pending;
                            } finally {
                                // This test intentionally leaves a lease expired; remove only its own claim candidates.
                                await tasks.withGenerationTaskFileMutation(async (records) => ({
                                    tasks: records.filter(
                                        (record) =>
                                            !(
                                                record.userId === userId &&
                                                ((record.type === "image" && record.id === current.sealed.original.taskId) || (record.type === "image_processing" && record.id === current.child.id && record.parentTaskId === current.sealed.original.taskId))
                                            ),
                                    ),
                                    result: undefined,
                                }));
                            }
                        }
                    }),
                );
            }, 120_000);
        }

        it("retains the real charge and quota after a process_result resource failure and exact fail replay", async () => {
            await withFinancialQuotaTracking(() =>
                withLocalProvider(async (origin, requests) => {
                    const current = await claimedChargedResult(origin);
                    const before = await failureTruth(current.sealed.original.taskId);
                    const failure = controlledResourceFailure(current);
                    const response = await postClosedFailure(origin, current, failure);
                    const body = await response.json();
                    expect(response.status, JSON.stringify(body)).toBe(200);
                    expect(body).toEqual({ code: 0, data: { jobId: current.child.id, status: "paused", executionPhase: "needs_review" }, msg: "OK" });
                    const paused = await failureTruth(current.sealed.original.taskId);
                    const finance = await financialTruth(current.sealed.original.taskId, current.charge.date);
                    expect(paused.image).toMatchObject({ status: "running", executionPhase: "needs_review", payload: { status: "running", billing: { pointsCost: 3, pointsRecordId: current.charge.record.id, refunded: false } } });
                    expect(paused.children[0]).toMatchObject({ id: current.child.id, status: "paused", resultPayload: { failure } });
                    expect(finance).toEqual(current.debited);
                    expect(paused.image.payload.attempts).toEqual(before.image.payload.attempts);
                    expect(paused.image.payload.nativeResults).toEqual(before.image.payload.nativeResults);
                    expect(paused.image.payload.resultProcessing).toEqual(before.image.payload.resultProcessing);
                    expect(paused.registered).toEqual(before.registered);
                    const replay = await postClosedFailure(origin, current, failure);
                    expect(replay.status).toBe(200);
                    expect(await replay.json()).toEqual(body);
                    expect(await failureTruth(current.sealed.original.taskId)).toEqual(paused);
                    expect(await financialTruth(current.sealed.original.taskId, current.charge.date)).toEqual(finance);
                    expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, current.sealed.slot.storageKey))).toEqual(source);
                    expect(requests).toEqual([]);
                }),
            );
        }, 30_000);

        it.each([3, 0] as const)(
            "settles the original %i-point charge and failed log at the process_result rejected fail Route before any repairing read",
            async (pointsCost) => {
                await withFinancialQuotaTracking(() =>
                    withLocalProvider(async (origin, requests) => {
                        const current = await claimedChargedResult(origin, pointsCost);
                        const before = await failureTruth(current.sealed.original.taskId);
                        const failure: ClosedImageProcessingFailure = {
                            status: "rejected",
                            jobId: current.child.id,
                            executionId: current.child.executionId,
                            pid: 4321,
                            exitCode: 0,
                            signal: null,
                            stderr: "controlled Worker report: /fixture/private/child.stderr",
                            error: { code: "fixture_closed_rejection", message: "controlled Worker report: /fixture/private/input.png" },
                        };
                        const response = await postClosedFailure(origin, current, failure);
                        const body = await response.json();
                        expect(response.status, JSON.stringify(body)).toBe(200);
                        expect(body).toEqual({ code: 0, data: { jobId: current.child.id, status: "error", executionPhase: "needs_review" }, msg: "OK" });
                        const failed = await failureTruth(current.sealed.original.taskId);
                        const finance = await financialTruth(current.sealed.original.taskId, current.charge.date);
                        expect(failed.image).toMatchObject({
                            status: "error",
                            executionPhase: "completed",
                            payload: { status: "error", retryable: true, error: expect.stringMatching(/[\u4e00-\u9fff]/), attempts: [{ attemptNo: 1, status: "failed", pointsCost, pointsRecordId: current.charge.record.id }] },
                        });
                        expect(failed.children[0]).toMatchObject({ id: current.child.id, status: "error", resultPayload: { failure } });
                        expect(failed.image.payload.nativeResults).toEqual(before.image.payload.nativeResults);
                        expect(failed.image.payload.resultProcessing).toEqual(before.image.payload.resultProcessing);
                        expect(failed.registered).toEqual(before.registered);
                        // Exercise saved-receipt replay before assertions that are expected RED on the current owner.
                        const replay = await postClosedFailure(origin, current, failure);
                        expect(replay.status).toBe(200);
                        expect(await replay.json()).toEqual(body);
                        expect(await failureTruth(current.sealed.original.taskId)).toEqual(failed);
                        expect(await financialTruth(current.sealed.original.taskId, current.charge.date)).toEqual(finance);
                        expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, current.sealed.slot.storageKey))).toEqual(source);
                        expect(requests).toEqual([]);
                        expect.soft(failed.image.payload.billing).toEqual({ pointsCost, pointsRecordId: current.charge.record.id, refunded: true });
                        expect.soft(finance.permanentPoints).toBe(current.charge.baseline.permanentPoints);
                        expect.soft(finance.dailyPoints).toBe(current.charge.baseline.dailyPoints);
                        expect.soft(finance.quota).toEqual(current.charge.baseline.quota);
                        expect.soft(finance.records.filter((record) => record.type === "consume")).toEqual(current.debited.records.filter((record) => record.type === "consume"));
                        const refunds = finance.records.filter((record) => record.type === "refund" && record.sourceRecordId === current.charge.record.id);
                        expect.soft(refunds).toEqual([
                            expect.objectContaining({
                                userId,
                                type: "refund",
                                amount: pointsCost,
                                sourceRecordId: current.charge.record.id,
                                sourceDate: current.charge.date,
                                idempotencyKey: `image-task:${current.sealed.original.taskId}:attempt:1:refund`,
                                permanentAmount: Math.abs(current.charge.record.permanentAmount),
                                dailyAmount: Math.abs(current.charge.record.dailyAmount),
                            }),
                        ]);
                        expect.soft(finance.records).toHaveLength(current.debited.records.length + 1);
                        expect.soft(finance.logs).toEqual([
                            expect.objectContaining({
                                id: `image-task:${current.sealed.original.taskId}`,
                                taskId: current.sealed.original.taskId,
                                userId,
                                kind: "image",
                                source: "image-workbench",
                                status: "failed",
                                summary: "图片生成失败",
                                count: 1,
                                successCount: 0,
                                failCount: 1,
                                assets: [],
                                error: failed.image.payload.error,
                                completedAt: expect.any(String),
                            }),
                        ]);
                        expect.soft(JSON.stringify(finance.logs)).not.toContain("/fixture/private");
                    }),
                );
            },
            30_000,
        );

        it.each([
            {
                outcome: "rejected",
                childStatus: "error",
                report: {
                    status: "rejected" as const,
                    pid: 4321,
                    exitCode: 0,
                    signal: null,
                    stderr: "controlled Worker report: /fixture/private/child.stderr",
                    error: { code: "fixture_closed_rejection", message: "controlled Worker report: /fixture/private/input.png" },
                },
            },
            {
                outcome: "resource_failure",
                childStatus: "paused",
                report: { status: "resource_failure" as const, pid: 4321, exitCode: 134, signal: null, stderr: "controlled Worker report: FATAL ERROR: Reached heap limit /fixture/private/child.stderr", reason: "v8_heap_oom" as const },
            },
        ])(
            "accepts a closed process_result $outcome through the fail Route without a Run or upstream ID",
            async ({ childStatus, report }) => {
                await withLocalProvider(async (origin, requests) => {
                    // These cases qualify controlled closed reports. Actual refunds/logs require their own billable fixture.
                    const sealed = await sealedImage(undefined, origin, "none");
                    expect(sealed.image.billing).toBeUndefined();
                    expect(await processing.ensureImageTaskResultProcessing(sealed.original)).toMatchObject({ state: "waiting" });
                    const queued = await resultSnapshot(sealed.original.taskId);
                    expect(queued.children).toHaveLength(1);
                    const pending = queued.children[0];
                    assert.ok(pending);
                    const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
                    const configured = imageProcessingResourceConfig(process.env);
                    expect(pending).toMatchObject({ status: "pending", parentTaskId: sealed.original.taskId, userId, payload: { operation: "process_result", resource: { profileVersion: configured.profileVersion } } });
                    const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 });
                    expect(claimed.tasks).toHaveLength(1);
                    const child = claimed.tasks[0];
                    assert.ok(child);
                    expect(child.id).toBe(pending.id);
                    const before = await resultSnapshot(sealed.original.taskId);
                    const registered = await nativeRegistrations(sealed.original.taskId);
                    const failure: ClosedImageProcessingFailure = { ...report, jobId: child.id, executionId: child.executionId };
                    const input: FailImageProcessingInput = { workerId, executionId: child.executionId, failure };
                    const { POST } = await import("@/app/api/maintenance/image-processing/[id]/fail/route");

                    const response = await POST(
                        new Request(`${origin}/api/maintenance/image-processing/${child.id}/fail`, { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: JSON.stringify(input) }),
                        { params: Promise.resolve({ id: child.id }) },
                    );

                    const body = await response.json();
                    expect(response.status, JSON.stringify(body)).toBe(200);
                    expect(body).toEqual({ code: 0, data: { jobId: child.id, status: childStatus, executionPhase: "needs_review" }, msg: "OK" });
                    const after = await resultSnapshot(sealed.original.taskId);
                    expect(after.children).toHaveLength(1);
                    const closed = after.children[0];
                    assert.ok(closed);
                    expect(closed).toMatchObject({ id: child.id, userId, parentTaskId: sealed.original.taskId, status: childStatus, executionPhase: "needs_review", resultPayload: { workerId, executionId: child.executionId, failure } });
                    expect(closed.runId).toBeUndefined();
                    expect(closed.payload).toEqual(before.children[0]?.payload);
                    expect(closed.workerId).toBeUndefined();
                    expect(closed.leaseUntil).toBeUndefined();
                    expect(closed.lastHeartbeatAt).toBeUndefined();
                    expect(closed.nextPollAt).toBeUndefined();
                    expect(after.image.payload.nativeResults).toEqual(sealed.image.nativeResults);
                    expect(after.image.payload.resultProcessing).toEqual(before.image.payload.resultProcessing);
                    expect(after.image.payload.attemptNo).toBe(1);
                    expect(after.image.payload.billing).toBeUndefined();
                    expect(after.image.runId).toBeUndefined();
                    expect(after.image.upstreamTaskId).toBeUndefined();
                    expect(after.image.payload.upstream).toBeUndefined();
                    expect(await nativeRegistrations(sealed.original.taskId)).toEqual(registered);
                    expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
                    expect(requests).toEqual([]);
                });
            },
            30_000,
        );

        async function claimedUnbilledResult(origin: string) {
            const sealed = await sealedImage(undefined, origin, "none");
            expect(await processing.ensureImageTaskResultProcessing(sealed.original)).toMatchObject({ state: "waiting" });
            const image = await imageTasks.getImageTask(sealed.original.taskId);
            assert.ok(image?.resultProcessing);
            const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
            const configured = imageProcessingResourceConfig(process.env);
            const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const child = claimed.tasks[0];
            assert.ok(child);
            expect(child.id).toBe(image.resultProcessing.jobId);
            return { sealed, child };
        }

        if (provider === "postgres") {
            it("rolls back a charged rejected fail at a real PostgreSQL log exception and settles the original retry once", async () => {
                await withFinancialQuotaTracking(() =>
                    withLocalProvider(async (origin, requests) => {
                        const current = await claimedChargedResult(origin);
                        const taskId = current.sealed.original.taskId;
                        const logId = `image-task:${taskId}`;
                        const failure: ClosedImageProcessingFailure = {
                            status: "rejected",
                            jobId: current.child.id,
                            executionId: current.child.executionId,
                            pid: 4321,
                            exitCode: 0,
                            signal: null,
                            stderr: "controlled Worker report: /fixture/private/child.stderr",
                            error: { code: "fixture_closed_rejection", message: "controlled Worker report: /fixture/private/input.png" },
                        };
                        const faultName = `fixture_m1_log_rollback_${randomUUID().replaceAll("-", "")}`;
                        const context = await database.postgresQuery<{ relationOid: string; namespace: string; relation: string; function: string; trigger: string; args: string }>(
                            `SELECT c.oid::text AS "relationOid", n.nspname AS namespace,
                            format('%I.%I', n.nspname, c.relname) AS relation,
                            format('%I.%I', n.nspname, $1::text) AS function, format('%I', $1::text) AS trigger,
                            format('%L, %L, %L', $2::text, $3::text, $4::text) AS args
                         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = 'generation_logs'::regclass`,
                            [faultName, userId, taskId, logId],
                        );
                        const fault = context.rows[0];
                        assert.ok(fault);
                        async function logCatalog(executor: import("./database").QueryExecutor) {
                            const triggers = await executor.query<{ name: string; raw: unknown; definition: string; functionRaw: unknown; functionDefinition: string }>(
                                `SELECT t.tgname AS name, to_jsonb(t) AS raw, pg_get_triggerdef(t.oid) AS definition,
                                to_jsonb(p) AS "functionRaw", pg_get_functiondef(p.oid) AS "functionDefinition"
                             FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = $1::oid ORDER BY t.oid`,
                                [fault.relationOid],
                            );
                            const functions = await executor.query<{ raw: unknown; definition: string }>(
                                `SELECT to_jsonb(p) AS raw, pg_get_functiondef(p.oid) AS definition
                             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE n.nspname = $1 AND p.proname = $2 ORDER BY p.oid`,
                                [fault.namespace, faultName],
                            );
                            return { triggers: triggers.rows, functions: functions.rows };
                        }
                        async function originalTaskRows() {
                            return (
                                await database.postgresQuery<{ row: unknown }>(
                                    `SELECT to_jsonb(t) AS row FROM generation_tasks t WHERE user_id = $1
                             AND ((task_type = 'image' AND id = $2) OR (task_type = 'image_processing' AND id = $3 AND parent_task_id = $2)) ORDER BY id`,
                                    [userId, taskId, current.child.id],
                                )
                            ).rows;
                        }
                        const before = await failureTruth(taskId);
                        const beforeRows = await originalTaskRows();
                        const beforeFinance = await financialTruth(taskId, current.charge.date);
                        expect(beforeRows).toHaveLength(2);
                        expect(beforeFinance).toEqual(current.debited);
                        const catalogBefore = await database.withPostgresTransaction(logCatalog);
                        expect(catalogBefore.functions).toEqual([]);
                        expect(catalogBefore.triggers.filter((trigger) => trigger.name === faultName)).toEqual([]);
                        // New owned objects only; ordinary business triggers and their functions are retained verbatim.
                        const installed = await database.withPostgresTransaction(async (executor) => {
                            await executor.query(`CREATE FUNCTION ${fault.function}() RETURNS trigger LANGUAGE plpgsql AS $$
                            BEGIN
                                IF NEW.user_id = TG_ARGV[0] AND NEW.task_id = TG_ARGV[1] AND NEW.id = TG_ARGV[2] THEN
                                    RAISE EXCEPTION USING MESSAGE = 'fixture_m1_generation_log_rollback', ERRCODE = 'P0001';
                                END IF;
                                RETURN NEW;
                            END;
                        $$`);
                            await executor.query(`CREATE TRIGGER ${fault.trigger} BEFORE INSERT OR UPDATE ON ${fault.relation} FOR EACH ROW EXECUTE FUNCTION ${fault.function}(${fault.args})`);
                            const saved = await logCatalog(executor);
                            expect(saved.functions).toHaveLength(1);
                            expect(saved.triggers.filter((trigger) => trigger.name === faultName)).toHaveLength(1);
                            expect(saved.triggers.filter((trigger) => trigger.name !== faultName)).toEqual(catalogBefore.triggers);
                            return saved;
                        });
                        try {
                            // Prove the fixture raises the intended real PG error; the probe can never commit a log.
                            await expect(
                                database.withPostgresTransaction(async (executor) => {
                                    await executor.query(
                                        `INSERT INTO generation_logs (id, user_id, task_id, username, display_name, kind, source, status, title, prompt)
                                VALUES ($1, $2, $3, 'fixture', 'fixture', 'image', 'image-workbench', 'failed', 'fixture', 'fixture')`,
                                        [logId, userId, taskId],
                                    );
                                    throw new Error("Fixture generation-log fault did not fire");
                                }),
                            ).rejects.toMatchObject({ code: "P0001", message: "fixture_m1_generation_log_rollback" });
                            expect(await originalTaskRows()).toEqual(beforeRows);
                            expect(await financialTruth(taskId, current.charge.date)).toEqual(beforeFinance);
                            const response = await postClosedFailure(origin, current, failure);
                            const body = await response.json();
                            const interruptedRows = await originalTaskRows();
                            const interrupted = await failureTruth(taskId);
                            const interruptedFinance = await financialTruth(taskId, current.charge.date);
                            expect(response.status, JSON.stringify(body)).toBe(500);
                            expect(body).toEqual({ code: 500, data: null, msg: "图像处理失败状态登记失败" });
                            expect(interruptedRows).toEqual(beforeRows);
                            expect(interrupted).toEqual(before);
                            expect(interruptedFinance).toEqual(beforeFinance);
                        } finally {
                            await database.withPostgresTransaction(async (executor) => {
                                const owned = await logCatalog(executor);
                                expect(owned.triggers.filter((trigger) => trigger.name === faultName)).toEqual(installed.triggers.filter((trigger) => trigger.name === faultName));
                                expect(owned.functions).toEqual(installed.functions);
                                await executor.query(`DROP TRIGGER ${fault.trigger} ON ${fault.relation}`);
                                await executor.query(`DROP FUNCTION ${fault.function}()`);
                            });
                            // Compare after committed cleanup so a failed restoration assertion cannot resurrect the fault.
                            expect(await database.withPostgresTransaction(logCatalog)).toEqual(catalogBefore);
                        }
                        const response = await postClosedFailure(origin, current, failure);
                        const receipt = { code: 0, data: { jobId: current.child.id, status: "error", executionPhase: "needs_review" }, msg: "OK" };
                        expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
                        expect(await response.json()).toEqual(receipt);
                        const settled = await failureTruth(taskId);
                        const settledRows = await originalTaskRows();
                        const finance = await financialTruth(taskId, current.charge.date);
                        expect(settled.image).toMatchObject({
                            status: "error",
                            executionPhase: "completed",
                            payload: {
                                status: "error",
                                retryable: true,
                                billing: { pointsCost: 3, pointsRecordId: current.charge.record.id, refunded: true },
                                attempts: [{ attemptNo: 1, status: "failed", pointsCost: 3, pointsRecordId: current.charge.record.id }],
                            },
                        });
                        expect(settled.children[0]).toMatchObject({ id: current.child.id, status: "error", executionPhase: "needs_review", resultPayload: { workerId, executionId: current.child.executionId, failure } });
                        expect(settled.children[0]?.workerId).toBeUndefined();
                        expect(settled.children[0]?.leaseUntil).toBeUndefined();
                        expect(settled.image.payload.nativeResults).toEqual(before.image.payload.nativeResults);
                        expect(settled.image.payload.resultProcessing).toEqual(before.image.payload.resultProcessing);
                        expect(settled.registered).toEqual(before.registered);
                        expect(finance.permanentPoints).toBe(current.charge.baseline.permanentPoints);
                        expect(finance.dailyPoints).toBe(current.charge.baseline.dailyPoints);
                        expect(finance.quota).toEqual(current.charge.baseline.quota);
                        expect(finance.records.filter((record) => record.type === "consume")).toEqual(beforeFinance.records.filter((record) => record.type === "consume"));
                        expect(finance.records.filter((record) => record.type === "refund" && record.sourceRecordId === current.charge.record.id)).toEqual([
                            expect.objectContaining({ userId, type: "refund", amount: 3, sourceRecordId: current.charge.record.id, sourceDate: current.charge.date, idempotencyKey: `image-task:${taskId}:attempt:1:refund` }),
                        ]);
                        expect(finance.records).toHaveLength(beforeFinance.records.length + 1);
                        expect(finance.logs).toEqual([
                            expect.objectContaining({
                                id: logId,
                                userId,
                                taskId,
                                kind: "image",
                                source: "image-workbench",
                                status: "failed",
                                summary: "图片生成失败",
                                count: 1,
                                successCount: 0,
                                failCount: 1,
                                assets: [],
                                error: settled.image.payload.error,
                                completedAt: expect.any(String),
                            }),
                        ]);
                        const replay = await postClosedFailure(origin, current, failure);
                        expect(replay.status).toBe(200);
                        expect(await replay.json()).toEqual(receipt);
                        expect(await originalTaskRows()).toEqual(settledRows);
                        expect(await failureTruth(taskId)).toEqual(settled);
                        expect(await financialTruth(taskId, current.charge.date)).toEqual(finance);
                        expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, current.sealed.slot.storageKey))).toEqual(source);
                        expect(requests).toEqual([]);
                    }),
                );
            }, 30_000);
        }

        type FailureFixture = Awaited<ReturnType<typeof claimedUnbilledResult>>;

        function controlledResourceFailure(current: FailureFixture): ClosedImageProcessingFailure {
            return { status: "resource_failure", jobId: current.child.id, executionId: current.child.executionId, pid: 4321, exitCode: 134, signal: null, stderr: "controlled Worker report: /fixture/private/child.stderr", reason: "v8_heap_oom" };
        }

        async function postClosedFailure(origin: string, current: FailureFixture, failure: ClosedImageProcessingFailure) {
            const input: FailImageProcessingInput = { workerId, executionId: current.child.executionId, failure };
            const { POST } = await import("@/app/api/maintenance/image-processing/[id]/fail/route");
            return POST(new Request(`${origin}/api/maintenance/image-processing/${current.child.id}/fail`, { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: JSON.stringify(input) }), {
                params: Promise.resolve({ id: current.child.id }),
            });
        }

        async function failureTruth(taskId: string) {
            const registered = await nativeRegistrations(taskId);
            if (provider === "postgres") return { ...(await resultSnapshot(taskId)), registered };
            // resultSnapshot uses the mutator, which always renames the File; this observer must only read.
            const filePath = path.join(directory, tasks.GENERATION_TASK_FILE);
            const [bytes, identity] = await Promise.all([readFile(filePath), stat(filePath, { bigint: true })]);
            const records: StoredGenerationTaskRecord[] = JSON.parse(bytes.toString("utf8"));
            const image = records.find((record) => record.type === "image" && record.id === taskId);
            assert.ok(image);
            const children = records.filter((record) => record.type === "image_processing" && record.parentTaskId === taskId);
            return { image, children, registered, bytes, dev: identity.dev, ino: identity.ino, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs };
        }

        it("pauses the original ImageTask after a closed resource failure and refuses same-profile public recovery without rewriting truth", async () => {
            await withLocalProvider(async (origin, requests) => {
                const current = await claimedUnbilledResult(origin);
                const before = await failureTruth(current.sealed.original.taskId);
                const response = await postClosedFailure(origin, current, controlledResourceFailure(current));
                const body = await response.json();
                expect(response.status, JSON.stringify(body)).toBe(200);
                expect(body).toEqual({ code: 0, data: { jobId: current.child.id, status: "paused", executionPhase: "needs_review" }, msg: "OK" });
                const paused = await failureTruth(current.sealed.original.taskId);
                expect(paused.image).toMatchObject({ status: "running", executionPhase: "needs_review", payload: { status: "running" }, resultPayload: { reviewReason: expect.stringMatching(/[\u4e00-\u9fff]/) } });
                expect(paused.image.nextPollAt).toBeUndefined();
                expect(paused.image.workerId).toBeUndefined();
                expect(paused.image.leaseUntil).toBeUndefined();
                expect(paused.image.lastHeartbeatAt).toBeUndefined();
                expect(paused.image.payload.executionId).toBeUndefined();
                expect(paused.image.payload.nativeResults).toEqual(before.image.payload.nativeResults);
                expect(paused.image.payload.resultProcessing).toEqual(before.image.payload.resultProcessing);
                expect(paused.image.payload.billing).toEqual(before.image.payload.billing);
                expect(paused.image.payload.attempts).toEqual(before.image.payload.attempts);
                expect(paused.registered).toEqual(before.registered);
                expect(JSON.stringify(paused.image.resultPayload)).not.toContain("/fixture/private");
                const request = new Request(`${origin}/api/image-tasks/${current.sealed.original.taskId}`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) });
                const { getCurrentUser } = await import("@/lib/auth/session");
                expect(await getCurrentUser(request)).toMatchObject({ id: userId, role: "user" });
                const { POST } = await import("@/app/api/image-tasks/[id]/route");

                const recovered = await POST(request, { params: Promise.resolve({ id: current.sealed.original.taskId }) });

                expect(recovered.status, JSON.stringify(await recovered.json())).toBe(409);
                expect(await failureTruth(current.sealed.original.taskId)).toEqual(paused);
                expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, current.sealed.slot.storageKey))).toEqual(source);
                expect(requests).toEqual([]);
            });
        }, 30_000);

        it("reopens the same result child through authenticated public recovery after a valid resource profile change", async () => {
            const previousHeap = process.env.VOZEB_PRO_IMAGE_PROCESS_HEAP_MB;
            try {
                await withLocalProvider(async (origin, requests) => {
                    const { getPointsWalletSnapshot } = await import("./points-wallet-service");
                    const wallet = await getPointsWalletSnapshot(userId);
                    const current = await claimedUnbilledResult(origin);
                    assert.ok(current.child.payload.operation === "process_result");
                    const taskId = current.sealed.original.taskId;
                    expect(current.child.payload.resource.configuration.processHeapMb).toBe(384);
                    const stream = new Response(new Uint8Array(source)).body;
                    assert.ok(stream);
                    const artifact = await service.writeImageProcessingOutput(current.child.id, "final", { workerId, executionId: current.child.executionId }, { mimeType: "image/png", resultId: current.sealed.slot.resultId, stream });
                    const artifactRegistration = await registrations.getLocalMediaRegistration(artifact.storageKey);
                    expect(artifactRegistration).toMatchObject({ ownerUserId: userId, taskId: current.child.id, type: "image", storageClass: "temporary" });
                    const nativePath = path.join(media.REFERENCE_MEDIA_ROOT, current.sealed.slot.storageKey);
                    const nativeIdentity = await stat(nativePath, { bigint: true });
                    const request = new Request(`${origin}/api/image-tasks/${taskId}`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) });
                    const { getCurrentUser } = await import("@/lib/auth/session");
                    expect(await getCurrentUser(request)).toMatchObject({ id: userId, role: "user" });
                    const financial = await financialTruth(taskId, wallet.dailyDate);
                    const before = await failureTruth(taskId);
                    const failure = controlledResourceFailure(current);
                    const failed = await postClosedFailure(origin, current, failure);
                    expect(failed.status, JSON.stringify(await failed.json())).toBe(200);
                    const paused = await failureTruth(taskId);
                    expect(paused.children).toHaveLength(1);
                    expect(paused.children[0]).toMatchObject({ id: current.child.id, status: "paused", executionPhase: "needs_review", resultPayload: { workerId, executionId: current.child.executionId, failure, artifacts: [artifact] } });
                    expect(paused.image).toMatchObject({ status: "running", executionPhase: "needs_review" });
                    expect(await financialTruth(taskId, wallet.dailyDate)).toEqual(financial);
                    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "512");
                    const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
                    const configured = imageProcessingResourceConfig(process.env);
                    expect(configured.profileVersion).not.toBe(current.child.payload.resource.profileVersion);
                    expect(configured).toMatchObject({ processHeapMb: 512, budgetBytes: 1073741824, concurrency: 1 });
                    const { POST } = await import("@/app/api/image-tasks/[id]/route");

                    const recovered = await POST(request, { params: Promise.resolve({ id: taskId }) });

                    const body = await recovered.json();
                    expect(recovered.status, JSON.stringify(body)).toBe(200);
                    expect(body).toMatchObject({ task: { id: taskId, status: "running" } });
                    expect(JSON.stringify(body)).not.toContain("/fixture/private");
                    const resumed = await failureTruth(taskId);
                    expect(resumed.children).toHaveLength(1);
                    const rearmed = resumed.children[0];
                    assert.ok(rearmed);
                    expect(rearmed).toMatchObject({ id: current.child.id, parentTaskId: taskId, userId, status: "pending", executionPhase: "created" });
                    expect(rearmed.payload).toMatchObject({
                        version: current.child.payload.version,
                        operation: "process_result",
                        algorithmVersion: current.child.payload.algorithmVersion,
                        inputDigest: current.child.payload.inputDigest,
                        inputs: current.child.payload.inputs,
                        sources: current.child.payload.sources,
                        options: current.child.payload.options,
                        imageResultBinding: current.child.payload.imageResultBinding,
                        resource: { profileVersion: configured.profileVersion, configuration: { processHeapMb: 512 }, facts: current.child.payload.resource.facts },
                    });
                    expect(rearmed.payload.executionId).toBeUndefined();
                    expect(rearmed.workerId).toBeUndefined();
                    expect(rearmed.leaseUntil).toBeUndefined();
                    expect(rearmed.lastHeartbeatAt).toBeUndefined();
                    expect(rearmed.nextPollAt).toBeGreaterThan(0);
                    expect(rearmed.resultPayload).toEqual({ executionId: current.child.executionId, checkpoints: [{ workerId, executionId: current.child.executionId, failure, resource: current.child.payload.resource, artifacts: [artifact] }] });
                    expect(resumed.image).toMatchObject({ id: taskId, status: "running", executionPhase: "persisting" });
                    expect(resumed.image.payload).toEqual({ ...paused.image.payload, updatedAt: expect.any(Number) });
                    expect(resumed.image.workerId).toBeUndefined();
                    expect(resumed.image.leaseUntil).toBeUndefined();
                    expect(resumed.image.payload.executionId).toBeUndefined();
                    expect(resumed.image.nextPollAt).toBeUndefined();
                    expect(resumed.registered).toEqual(before.registered);
                    const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 });
                    expect(claimed.tasks).toHaveLength(1);
                    const next = claimed.tasks[0];
                    assert.ok(next);
                    expect(next.id).toBe(current.child.id);
                    expect(next.executionId).not.toBe(current.child.executionId);
                    expect(next.payload).toMatchObject({
                        inputDigest: current.child.payload.inputDigest,
                        inputs: current.child.payload.inputs,
                        sources: current.child.payload.sources,
                        options: current.child.payload.options,
                        imageResultBinding: current.child.payload.imageResultBinding,
                        resource: { profileVersion: configured.profileVersion, facts: current.child.payload.resource.facts },
                    });
                    const active = await failureTruth(taskId);
                    expect(active.children).toHaveLength(1);
                    expect(active.children[0]).toMatchObject({ id: current.child.id, status: "running", workerId, payload: { executionId: next.executionId }, resultPayload: rearmed.resultPayload });
                    const oldFailure = await postClosedFailure(origin, current, failure);
                    expect(oldFailure.status, JSON.stringify(await oldFailure.json())).toBe(409);
                    expect(await failureTruth(taskId)).toEqual(active);
                    const heartbeat = await import("@/app/api/maintenance/image-processing/[id]/heartbeat/route");
                    const oldHeartbeat = await heartbeat.POST(
                        new Request(`${origin}/api/maintenance/image-processing/${current.child.id}/heartbeat`, {
                            method: "POST",
                            headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
                            body: JSON.stringify({ workerId, executionId: current.child.executionId }),
                        }),
                        { params: Promise.resolve({ id: current.child.id }) },
                    );
                    expect(oldHeartbeat.status, JSON.stringify(await oldHeartbeat.json())).toBe(409);
                    expect(await failureTruth(taskId)).toEqual(active);
                    expect(await financialTruth(taskId, wallet.dailyDate)).toEqual(financial);
                    expect(active.image.payload.nativeResults).toEqual(before.image.payload.nativeResults);
                    expect(active.image.payload.resultProcessing).toEqual(before.image.payload.resultProcessing);
                    expect(active.image.payload.billing).toBeUndefined();
                    expect(active.image.payload.attempts).toEqual(before.image.payload.attempts);
                    expect(active.registered).toEqual(before.registered);
                    expect(await readFile(nativePath)).toEqual(source);
                    const nativeAfter = await stat(nativePath, { bigint: true });
                    expect({ dev: nativeAfter.dev, ino: nativeAfter.ino, mtimeNs: nativeAfter.mtimeNs, ctimeNs: nativeAfter.ctimeNs }).toEqual({
                        dev: nativeIdentity.dev,
                        ino: nativeIdentity.ino,
                        mtimeNs: nativeIdentity.mtimeNs,
                        ctimeNs: nativeIdentity.ctimeNs,
                    });
                    expect(await registrations.getLocalMediaRegistration(artifact.storageKey)).toEqual(artifactRegistration);
                    expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, artifact.storageKey))).toEqual(source);
                    expect(requests).toEqual([]);
                });
            } finally {
                vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", previousHeap);
            }
        }, 30_000);

        it("settles an unbilled rejected result as an image business failure with a safe public error", async () => {
            await withLocalProvider(async (origin, requests) => {
                const current = await claimedUnbilledResult(origin);
                await imageTasks.updateImageTask(current.sealed.original.taskId, { attempts: [{ attemptNo: 1, model: "fixture-image-model", status: "running", startedAt: current.sealed.image.createdAt }] });
                const before = await failureTruth(current.sealed.original.taskId);
                const failure: ClosedImageProcessingFailure = {
                    status: "rejected",
                    jobId: current.child.id,
                    executionId: current.child.executionId,
                    pid: 4321,
                    exitCode: 0,
                    signal: null,
                    stderr: "controlled Worker report: /fixture/private/child.stderr",
                    error: { code: "fixture_closed_rejection", message: "controlled Worker report: /fixture/private/input.png" },
                };

                const response = await postClosedFailure(origin, current, failure);

                const body = await response.json();
                expect(response.status, JSON.stringify(body)).toBe(200);
                expect(body).toEqual({ code: 0, data: { jobId: current.child.id, status: "error", executionPhase: "needs_review" }, msg: "OK" });
                const after = await failureTruth(current.sealed.original.taskId);
                expect(after.image).toMatchObject({
                    status: "error",
                    payload: { status: "error", error: expect.stringMatching(/[\u4e00-\u9fff]/), retryable: true, attemptNo: 1, attempts: [{ attemptNo: 1, status: "failed", completedAt: expect.any(Number) }] },
                });
                expect(after.image.nextPollAt).toBeUndefined();
                expect(after.image.workerId).toBeUndefined();
                expect(after.image.leaseUntil).toBeUndefined();
                expect(after.image.lastHeartbeatAt).toBeUndefined();
                expect(JSON.stringify({ error: after.image.payload.error, resultPayload: after.image.resultPayload })).not.toContain("/fixture/private");
                expect(after.image.payload.nativeResults).toEqual(before.image.payload.nativeResults);
                expect(after.image.payload.resultProcessing).toEqual(before.image.payload.resultProcessing);
                expect(after.image.payload.billing).toBeUndefined();
                expect(after.registered).toEqual(before.registered);
                expect(after.children[0]).toMatchObject({ status: "error", resultPayload: { failure } });
                expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, current.sealed.slot.storageKey))).toEqual(source);
                expect(requests).toEqual([]);
            });
        }, 30_000);

        it.each([
            {
                name: "the parent was cancelled",
                async replace(current: FailureFixture) {
                    const image = await imageTasks.getImageTask(current.sealed.original.taskId);
                    assert.ok(image);
                    assert.ok(await imageTasks.transitionImageTask(image, ["running"], { status: "cancelled", error: "任务已取消", retryable: false }));
                },
            },
            {
                name: "the native business attempt changed",
                async replace(current: FailureFixture) {
                    assert.ok(await imageTasks.updateImageTask(current.sealed.original.taskId, { attemptNo: 2 }));
                },
            },
            {
                name: "the sealed native registration changed",
                async replace(current: FailureFixture) {
                    const registration = await registrations.getLocalMediaRegistration(current.sealed.slot.storageKey);
                    assert.ok(registration);
                    await registrations.registerLocalMediaAsset({ ...registration, bytes: 94 });
                },
            },
        ])(
            "rejects a closed result report after $name without rewriting parent, child or registrations",
            async ({ replace }) => {
                await withLocalProvider(async (origin, requests) => {
                    const current = await claimedUnbilledResult(origin);
                    await replace(current);
                    const before = await failureTruth(current.sealed.original.taskId);

                    const response = await postClosedFailure(origin, current, controlledResourceFailure(current));

                    const body = await response.json();
                    expect(response.status, JSON.stringify(body)).toBe(409);
                    expect(await failureTruth(current.sealed.original.taskId)).toEqual(before);
                    expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, current.sealed.slot.storageKey))).toEqual(source);
                    expect(requests).toEqual([]);
                });
            },
            30_000,
        );

        it("recovers a sealed native through the authenticated public Route without a Run or upstream ID and retains its original pending child", async () => {
            await withLocalProvider(async (origin, requests) => {
                const sealed = await sealedImage(undefined, origin, "none");
                expect(await processing.ensureImageTaskResultProcessing(sealed.original)).toMatchObject({ state: "waiting" });
                const before = await resultSnapshot(sealed.original.taskId);
                const registered = await nativeRegistrations(sealed.original.taskId);
                expect(before.children).toHaveLength(1);
                expect(before.children[0]).toMatchObject({ status: "pending", userId, parentTaskId: sealed.original.taskId, payload: { operation: "process_result" } });
                expect(before.image).toMatchObject({ status: "running", executionPhase: "persisting" });
                expect(before.image.runId).toBeUndefined();
                expect(before.image.upstreamTaskId).toBeUndefined();
                expect(before.image.payload.upstream).toBeUndefined();
                const request = new Request(`${origin}/api/image-tasks/${sealed.original.taskId}`, { method: "POST", headers: { cookie: boundary.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) });
                const { getCurrentUser } = await import("@/lib/auth/session");
                expect(await getCurrentUser(request)).toMatchObject({ id: userId, role: "user" });
                const { POST } = await import("@/app/api/image-tasks/[id]/route");

                const response = await POST(request, { params: Promise.resolve({ id: sealed.original.taskId }) });

                const body = await response.json();
                expect(response.status, JSON.stringify(body)).toBe(200);
                expect(body).toMatchObject({ task: { id: sealed.original.taskId, status: "running" } });
                const after = await resultSnapshot(sealed.original.taskId);
                expect(after.children).toEqual(before.children);
                expect(after.image.payload.resultProcessing).toEqual(before.image.payload.resultProcessing);
                expect(after.image.payload.nativeResults).toEqual(sealed.image.nativeResults);
                expect(after.image.payload.attemptNo).toEqual(before.image.payload.attemptNo);
                expect(after.image.payload.attempts).toEqual(before.image.payload.attempts);
                expect(after.image.payload.billing).toEqual(before.image.payload.billing);
                expect(after.image.payload.upstream).toBeUndefined();
                expect(after.image.runId).toBeUndefined();
                expect(after.image.upstreamTaskId).toBeUndefined();
                expect(await nativeRegistrations(sealed.original.taskId)).toEqual(registered);
                expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
                expect(requests).toEqual([]);
            });
        }, 30_000);

        it("publishes its original native child when the persisted resultProcessing pointer is JSON null", async () => {
            const sealed = await sealedImage();
            const before = await resultSnapshot(sealed.original.taskId);
            const registered = await nativeRegistrations(sealed.original.taskId);
            expect(before.image).toMatchObject({ workerId, payload: { executionId: sealed.original.executionId, nativeResults: sealed.image.nativeResults } });
            expect(before.image.leaseUntil).toBeGreaterThan(Date.now());
            expect(before.children).toEqual([]);
            await persistNullResultProcessing(sealed);
            expect(await resultSnapshot(sealed.original.taskId)).toEqual({ image: { ...before.image, payload: { ...before.image.payload, resultProcessing: null } }, children: [] });

            expect(await processing.ensureImageTaskResultProcessing(sealed.original)).toMatchObject({ state: "waiting" });

            const after = await resultSnapshot(sealed.original.taskId);
            expect(after.children).toHaveLength(1);
            const child = after.children[0];
            assert.ok(child);
            expect(child).toMatchObject({ type: "image_processing", userId, parentTaskId: sealed.original.taskId, status: "pending", executionPhase: "created", payload: { operation: "process_result" } });
            expect(child.payload.imageResultBinding).toEqual({ imageTaskId: sealed.original.taskId, userId, nativeResults: sealed.image.nativeResults });
            expect(after.image).toMatchObject({ status: "running", executionPhase: "persisting", payload: { resultProcessing: { jobId: child.id, inputDigest: child.payload.inputDigest }, nativeResults: sealed.image.nativeResults } });
            expect(after.image.workerId).toBeUndefined();
            expect(after.image.leaseUntil).toBeUndefined();
            expect(after.image.lastHeartbeatAt).toBeUndefined();
            expect(after.image.nextPollAt).toBeUndefined();
            expect(after.image.payload.billing).toEqual(before.image.payload.billing);
            expect(after.image.payload.attemptNo).toEqual(before.image.payload.attemptNo);
            expect(after.image.payload.attempts).toEqual(before.image.payload.attempts);
            expect(await nativeRegistrations(sealed.original.taskId)).toEqual(registered);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
        });

        it("persists the native result child and yields its image in the same committed snapshot", async () => {
            const sealed = await sealedImage();
            const before = await resultSnapshot(sealed.original.taskId);
            expect(before.children).toEqual([]);
            expect(before.image).toMatchObject({ workerId, payload: { executionId: sealed.original.executionId } });

            expect(await processing.ensureImageTaskResultProcessing(sealed.original)).toMatchObject({ state: "waiting" });

            const snapshot = await resultSnapshot(sealed.original.taskId);
            const image = await imageTasks.getImageTask(sealed.original.taskId);
            assert.ok(image?.resultProcessing);
            expect(snapshot.children).toHaveLength(1);
            const child = snapshot.children[0];
            assert.ok(child);
            expect(image.resultProcessing).toEqual({ jobId: child.id, inputDigest: child.payload.inputDigest });
            expect(child.id).toMatch(/^image-process-[a-f0-9]{64}$/);
            expect(child.id).toBe(`image-process-${child.payload.inputDigest}`);
            expect(child).toMatchObject({
                type: "image_processing",
                userId,
                parentTaskId: sealed.original.taskId,
                status: "pending",
                executionPhase: "created",
                attemptNo: 0,
                clientRequestId: child.payload.inputDigest,
            });
            expect(child.runId).toBeUndefined();
            expect(child.nextPollAt).toBeTypeOf("number");
            expect(child.workerId).toBeUndefined();
            expect(child.leaseUntil).toBeUndefined();
            expect(child.payload).toMatchObject({
                version: "image-processing.v1",
                operation: "process_result",
                algorithmVersion: expect.stringMatching(/\S/),
                resource: {
                    facts: {
                        encodedInputs: [{ inputIndex: 0, assetId: sealed.slot.assetId, assetVersion: sealed.slot.assetVersion, bytes: 95, sha256: sealed.slot.sha256, layout: { format: "png", depth: "uchar", channels: 3 } }],
                        decodedInputs: [],
                    },
                },
            });
            expect(child.payload.inputs).toEqual([{ assetId: sealed.slot.assetId, assetVersion: sealed.slot.assetVersion, expectedSha256: sealed.slot.sha256 }]);
            expect(child.payload.sources).toEqual([{ inputIndex: 0, scope: "reference", storageKey: sealed.slot.storageKey, storageProvider: "local" }]);
            expect(child.payload.options).toEqual({ mode: "ordinary", results: [{ resultId: sealed.slot.resultId, resultIndex: 1, inputIndex: 0 }], transparentBackground: false });
            expect(snapshot.image).toMatchObject({
                status: "running",
                executionPhase: "persisting",
                payload: { status: "running", nativeResults: sealed.image.nativeResults, resultProcessing: image.resultProcessing },
            });
            expect(snapshot.image.runId).toBeUndefined();
            expect(snapshot.image.nextPollAt).toBeUndefined();
            expect(snapshot.image.workerId).toBeUndefined();
            expect(snapshot.image.leaseUntil).toBeUndefined();
            expect(snapshot.image.lastHeartbeatAt).toBeUndefined();
            expect(snapshot.image.payload.billing).toEqual(before.image.payload.billing);
            expect(snapshot.image.payload.attemptNo).toEqual(before.image.payload.attemptNo);
            expect(snapshot.image.payload.attempts).toEqual(before.image.payload.attempts);
            expect(snapshot.image.upstreamTaskId).toEqual(before.image.upstreamTaskId);
            expect(snapshot.image.payload.upstream).toEqual(before.image.payload.upstream);
            expect(image.result).toBeUndefined();
        });

        it("rejects the yielded claim and reuses the same child under a newly claimed image execution", async () => {
            const sealed = await sealedImage();
            const registered = await nativeRegistrations(sealed.original.taskId);
            expect(await processing.ensureImageTaskResultProcessing(sealed.original)).toMatchObject({ state: "waiting" });
            const first = await resultSnapshot(sealed.original.taskId);
            const firstImage = await imageTasks.getImageTask(sealed.original.taskId);
            assert.ok(firstImage?.resultProcessing);
            expect(first.children).toHaveLength(1);

            expect(await processing.ensureImageTaskResultProcessing(sealed.original)).toEqual({ state: "ownership_lost" });
            expect(await resultSnapshot(sealed.original.taskId)).toEqual(first);
            expect(await nativeRegistrations(sealed.original.taskId)).toEqual(registered);

            // Explicit test precondition for local recovery; ordinary runtime wakeup is outside this slice.
            assert.ok(await scheduler.scheduleGenerationTask("image", sealed.original.taskId, { executionPhase: "persisting", nextPollAt: Date.now() - 1 }));
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [sealed.original.taskId], limit: 1 });
            assert.equal(claimed.length, 1);
            const lease = claimed[0];
            assert.ok(lease?.executionId);
            expect(lease.executionId).not.toBe(sealed.original.executionId);
            const nextClaim = { taskId: sealed.original.taskId, workerId, executionId: lease.executionId };
            const beforeReuse = await resultSnapshot(sealed.original.taskId);
            expect(beforeReuse.image).toMatchObject({ workerId, payload: { executionId: nextClaim.executionId } });

            expect(await processing.ensureImageTaskResultProcessing(nextClaim)).toMatchObject({ state: "waiting" });

            const second = await resultSnapshot(sealed.original.taskId);
            const image = await imageTasks.getImageTask(sealed.original.taskId);
            assert.ok(image);
            expect(image.resultProcessing).toEqual(firstImage.resultProcessing);
            expect(second.children).toEqual(first.children);
            expect(image.nativeResults).toEqual(sealed.image.nativeResults);
            expect(await nativeRegistrations(sealed.original.taskId)).toEqual(registered);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
            expect(second.image).toMatchObject({ status: "running", executionPhase: "persisting" });
            expect(second.image.nextPollAt).toBeUndefined();
            expect(second.image.workerId).toBeUndefined();
            expect(second.image.leaseUntil).toBeUndefined();
            expect(second.image.lastHeartbeatAt).toBeUndefined();
            expect(second.image.payload.billing).toEqual(beforeReuse.image.payload.billing);
            expect(second.image.payload.attemptNo).toEqual(beforeReuse.image.payload.attemptNo);
            expect(second.image.payload.attempts).toEqual(beforeReuse.image.payload.attempts);
            expect(second.image.upstreamTaskId).toEqual(beforeReuse.image.upstreamTaskId);
            expect(second.image.payload.upstream).toEqual(beforeReuse.image.payload.upstream);
        });

        it("rejects a bad native registration without committing a child or yielding the image", async () => {
            const sealed = await sealedImage();
            const registration = await registrations.getLocalMediaRegistration(sealed.slot.storageKey);
            assert.ok(registration);
            await registrations.registerLocalMediaAsset({ ...registration, bytes: 94 });
            const before = await resultSnapshot(sealed.original.taskId);
            const ownedBefore = await ownedProcessingRows();
            const registered = await nativeRegistrations(sealed.original.taskId);
            expect(before.children).toEqual([]);
            expect(before.image.payload.resultProcessing).toBeUndefined();

            await expect(processing.ensureImageTaskResultProcessing(sealed.original)).rejects.toThrow("Native image attachment registration changed");

            expect(await resultSnapshot(sealed.original.taskId)).toEqual(before);
            expect(await ownedProcessingRows()).toEqual(ownedBefore);
            expect(await nativeRegistrations(sealed.original.taskId)).toEqual(registered);
            expect(await registrations.getLocalMediaRegistration(sealed.slot.storageKey)).toMatchObject({ bytes: 94 });
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
        });

        it("rejects a conflicting frozen child business attempt without changing its current image claim", async () => {
            const sealed = await sealedImage();
            expect(await processing.ensureImageTaskResultProcessing(sealed.original)).toMatchObject({ state: "waiting" });
            const image = await imageTasks.getImageTask(sealed.original.taskId);
            assert.ok(image?.resultProcessing);
            assert.ok(await scheduler.scheduleGenerationTask("image", sealed.original.taskId, { executionPhase: "persisting", nextPollAt: Date.now() - 1 }));
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [sealed.original.taskId], limit: 1 });
            assert.equal(claimed.length, 1);
            const lease = claimed[0];
            assert.ok(lease?.executionId);
            expect(lease.executionId).not.toBe(sealed.original.executionId);
            const nextClaim = { taskId: sealed.original.taskId, workerId, executionId: lease.executionId };
            await corruptChildBusinessAttempt(image.resultProcessing.jobId, sealed.original.taskId);
            const before = await resultSnapshot(sealed.original.taskId);
            const ownedBefore = await ownedProcessingRows();
            const registered = await nativeRegistrations(sealed.original.taskId);
            expect(before.children).toHaveLength(1);
            expect(before.children[0]?.payload).toMatchObject({ imageResultBinding: { nativeResults: { attemptNo: 2 } } });
            expect(before.image).toMatchObject({ workerId, payload: { executionId: nextClaim.executionId, nativeResults: { attemptNo: 1 } } });

            await expect(processing.ensureImageTaskResultProcessing(nextClaim)).rejects.toThrow("Image result processing stage binding changed");

            expect(await resultSnapshot(sealed.original.taskId)).toEqual(before);
            expect(await ownedProcessingRows()).toEqual(ownedBefore);
            expect(await nativeRegistrations(sealed.original.taskId)).toEqual(registered);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
        });

        if (provider === "postgres") {
            it.each([
                { registration: "healthy", bytes: 95 },
                { registration: "bad", bytes: 94 },
            ])(
                "prioritizes ownership loss after a real registry lock crosses the image lease ($registration)",
                async ({ bytes }) => {
                    const sealed = await sealedImage(30_000);
                    const before = await resultSnapshot(sealed.original.taskId);
                    const ownedBefore = await ownedProcessingRows();
                    expect(before.children).toEqual([]);
                    expect(before.image.payload.resultProcessing).toBeUndefined();

                    const result = await crossRegistryLockLease(sealed, bytes);

                    expect(result.barrier).toEqual({ lockWait: true, controllerBlocks: true, registryQuery: true, leaseAlive: true });
                    expect(result.expired).toBe(true);
                    expect(await resultSnapshot(sealed.original.taskId)).toEqual(before);
                    expect(await ownedProcessingRows()).toEqual(ownedBefore);
                    expect(await registrations.getLocalMediaRegistration(sealed.slot.storageKey)).toMatchObject({ bytes });
                    expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
                    expect(result.settlement).toEqual({ status: "fulfilled", value: { state: "ownership_lost" } });
                },
                120_000,
            );
        }
    });
}
