import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageTask } from "./image-task-store";
import { imageProcessingS3Fixture, imageProcessingStreamBytes } from "./image-processing-s3-fixture";
import type { QueryExecutor } from "./database";
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { StoredImageEnhancementSettings } from "./database/image-enhancement-repository";
import type { ClaimedImageProcessingTask, CompleteImageProcessingInput, StoredImageProcessingArtifact } from "./image-processing-service";

type RawSqlRow = Record<string, unknown>;
type RawTaskRow = RawSqlRow & { id: string; task_type: string; payload: Record<string, unknown> };
type RawMediaRow = RawSqlRow & { storage_key: string };
type RawEnhancementJobRow = RawSqlRow & { id: string; payload: ImageEnhancementJob };
type EnhancementSettingsRow = { id: string; value: StoredImageEnhancementSettings };

(process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1" ? describe : describe.skip)("PostgreSQL pool-one result modes consumed by the same ImageTask", () => {
    let directory: string;
    let userId = "";
    let closeRemoteFixture: (() => Promise<void>) | undefined;
    let database: typeof import("./database");
    let wallet: typeof import("./points-wallet-service");
    let imageTasks: typeof import("./image-task-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let processing: typeof import("./image-task-result-processing");
    let service: typeof import("./image-processing-service");
    let operations: typeof import("@/lib/image-processing/operations");
    let references: typeof import("./reference-asset-store");
    let registrations: typeof import("./local-media-registry");
    let auth: typeof import("@/lib/auth/store");
    let support: typeof import("@/app/api/image-tasks/image-task-support");
    let creative: typeof import("./creative-runtime-service");
    let logs: typeof import("./generation-log-store");
    let recovery: typeof import("./generation-task-recovery-service");
    let attempts: typeof import("./generation-attempt");
    let runtime: typeof import("./image-task-runtime");
    const workerToken = "fixture-result-modes-worker-token-00000001";
    const resourceEnvironment = {
        VOZEB_PRO_GENERATION_WORKER_MEMORY_MB: "8192",
        VOZEB_PRO_GENERATION_WORKER_HEAP_MB: "64",
        VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB: "6144",
        VOZEB_PRO_IMAGE_PROCESS_HEAP_MB: "384",
        VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY: "1",
    };
    const config: ImageTask["config"] = { baseUrl: "https://fixture.invalid", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model", outputBackground: "opaque" };

    beforeAll(async () => {
        if (
            process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION !== "1" ||
            process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" ||
            process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" ||
            process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" ||
            !process.env.DATABASE_URL
        )
            throw new Error("Explicit isolated PostgreSQL fixture with integration enabled and startup pool maximum one is required");
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-result-modes-pg-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-result-modes-maintenance-token-01");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        // The ordinary 4k native is 1024 x 1024; the remaining images use the qualified tiny fixtures.
        for (const [key, value] of Object.entries(resourceEnvironment)) vi.stubEnv(key, value);
        database = await import("./database");
        await database.initializePostgresSchema();
        [imageTasks, tasks, scheduler, processing, service, operations, references, registrations] = await Promise.all([
            import("./image-task-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./image-task-result-processing"),
            import("./image-processing-service"),
            import("@/lib/image-processing/operations"),
            import("./reference-asset-store"),
            import("./local-media-registry"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
        [auth, support, creative, logs, recovery, attempts, runtime, wallet] = await Promise.all([
            import("@/lib/auth/store"),
            import("@/app/api/image-tasks/image-task-support"),
            import("./creative-runtime-service"),
            import("./generation-log-store"),
            import("./generation-task-recovery-service"),
            import("./generation-attempt"),
            import("./image-task-runtime"),
            import("./points-wallet-service"),
        ]);
    }, 30_000);

    beforeEach(async () => {
        userId = "fixture-result-modes-pg-" + randomUUID();
        const repositories = database.createPostgresRepositories();
        const settings = await repositories.settings.getSettings();
        const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
        assert.ok(planId, "Fixture entitlement plan missing");
        await repositories.users.createWithNextAccountId({
            id: userId,
            username: "fixture_" + randomUUID().replaceAll("-", "").slice(0, 16),
            displayName: "Isolated PostgreSQL result modes fixture",
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
        const credit = await wallet.creditPermanentPoints({ userId, amount: 1000, description: "Isolated PostgreSQL result modes fixture", idempotencyKey: "fixture-result-modes-credit:" + userId });
        expect(credit.applied).toBe(true);
        expect(credit.record).toMatchObject({ userId, type: "credit", amount: 1000 });
    });

    afterEach(async () => {
        await closeRemoteFixture?.();
        closeRemoteFixture = undefined;
        if (userId) {
            // Enhancement jobs have no user foreign key; delete only this case's rows.
            await database.postgresQuery("DELETE FROM image_enhancement_jobs WHERE user_id = $1", [userId]);
            await database.createPostgresRepositories().users.delete(userId);
            userId = "";
        }
    });

    afterAll(async () => {
        try {
            if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
            vi.unstubAllEnvs();
        }
    });

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

    async function ownedRows() {
        return database.withPostgresTransaction(async (executor) => {
            await executor.query("SET TRANSACTION READ ONLY");
            return {
                rows: (await executor.query<RawTaskRow>("SELECT * FROM generation_tasks WHERE user_id = $1 ORDER BY task_type, id", [userId])).rows,
                registrations: (await executor.query<RawMediaRow>("SELECT * FROM local_media_assets WHERE owner_user_id = $1 ORDER BY storage_key", [userId])).rows,
                logs: (await executor.query<RawSqlRow>("SELECT * FROM generation_logs WHERE user_id = $1 ORDER BY id", [userId])).rows,
                logAssets: (
                    await executor.query<RawSqlRow>("SELECT asset.* FROM generation_log_assets AS asset JOIN generation_logs AS log ON log.id = asset.generation_log_id WHERE log.user_id = $1 ORDER BY asset.generation_log_id, asset.sort_order, asset.id", [
                        userId,
                    ])
                ).rows,
                assets: (await executor.query<RawSqlRow>("SELECT * FROM creative_assets WHERE user_id = $1 ORDER BY ordinal, id", [userId])).rows,
                enhancementJobs: (await executor.query<RawEnhancementJobRow>("SELECT * FROM image_enhancement_jobs WHERE user_id = $1 ORDER BY id", [userId])).rows,
                financial: await financialRows(executor),
            };
        });
    }

    function digest(bytes: Buffer) {
        return createHash("sha256").update(bytes).digest("hex");
    }

    function dataUrl(bytes: Buffer) {
        return `data:image/png;base64,${bytes.toString("base64")}`;
    }

    function solid(width: number, height: number, background: string | { r: number; g: number; b: number; alpha: number }) {
        return sharp({ create: { width, height, channels: 4, background } })
            .png()
            .toBuffer();
    }

    async function registeredReference(conversationId: string, bytes: Buffer) {
        const stored = await references.writePersistentMediaDataUrl(dataUrl(bytes), "image", { ownerUserId: userId, conversationId, source: "image-workbench" });
        const serverUrl = `/api/reference-assets/${stored.token}`;
        const reference = { id: randomUUID(), name: "source.png", type: "image/png", dataUrl: serverUrl, serverUrl };
        const local = await references.readReferenceAsset(stored.token);
        assert.ok(local);
        expect(await readFile(local.filePath)).toEqual(bytes);
        return { reference, path: local.filePath, token: stored.token };
    }

    async function createImage(input: Pick<ImageTask, "kind" | "conversationId" | "config" | "references" | "mask" | "sceneProtection" | "productProtection" | "enhancementDelivery">) {
        const started = attempts.startGenerationAttempt(undefined, { model: config.model, capability: "image" });
        return imageTasks.createImageTask({
            userId,
            username: "fixture-result-modes",
            displayName: "Isolated result mode fixture",
            source: "image-workbench",
            surface: "chat",
            prompt: "Consume this result mode through its original ImageTask",
            ...input,
            attemptNo: started.attempt.attemptNo,
            attempts: started.attempts,
        });
    }

    async function processWithWorker(jobId: string) {
        const [claimRoute, inputRoute, heartbeatRoute, outputRoute, completeRoute] = await Promise.all([
            import("@/app/api/maintenance/image-processing/claim/route"),
            import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route"),
            import("@/app/api/maintenance/image-processing/[id]/heartbeat/route"),
            import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route"),
            import("@/app/api/maintenance/image-processing/[id]/complete/route"),
        ]);
        const workerScript = fileURLToPath(new URL("../../../scripts/generation-worker.mjs", import.meta.url));
        const runtimeChild = fileURLToPath(new URL("../../../.image-processing-runtime/workers/image-processing-child.mjs", import.meta.url));
        const runtimeLane = fileURLToPath(new URL("../../../.image-processing-runtime/workers/image-processing-lane.mjs", import.meta.url));
        assert.ok((await stat(runtimeChild)).isFile(), "SETUP: build the actual image runtime before the result mode cases");
        assert.ok((await stat(runtimeLane)).isFile());
        const workerTemp = await mkdtemp(path.join(directory, "worker-temp-"));
        const workerId = "fixture-result-mode-worker-" + randomUUID();
        const uploads: Array<{ stored: StoredImageProcessingArtifact; bytes: Buffer }> = [];
        const completed = Promise.withResolvers<{ child: ClaimedImageProcessingTask; completion: CompleteImageProcessingInput; receipt: Awaited<ReturnType<typeof service.completeImageProcessingTask>> }>();
        const terminalSeen = Promise.withResolvers<void>();
        const failure = Promise.withResolvers<never>();
        const requests = new Set<Promise<void>>();
        let child: ClaimedImageProcessingTask | undefined;
        let origin: string;
        let stdout = "";
        let stderr = "";
        let workerPid: number | undefined;
        let completionSaved = false;

        async function requestBytes(request: IncomingMessage) {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
                assert.ok(Buffer.isBuffer(chunk));
                chunks.push(chunk);
            }
            return Buffer.concat(chunks);
        }

        async function relay(result: Response, response: ServerResponse) {
            const bytes = Buffer.from(await result.arrayBuffer());
            for (const [name, value] of result.headers) response.setHeader(name, value);
            response.writeHead(result.status);
            response.end(bytes);
        }

        async function bounded<T>(pending: Promise<T>, milliseconds: number, message: string): Promise<T> {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                return await Promise.race([
                    pending,
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error(message + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr)), milliseconds);
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
        }

        async function handle(request: IncomingMessage, response: ServerResponse) {
            assert.ok(request.url);
            const url = new URL(request.url, origin);
            const authorization = request.headers.authorization;
            assert.ok(typeof authorization === "string");
            expect(authorization).toBe("Bearer " + process.env.VOZEB_PRO_WORKER_TOKEN);
            if (["/api/maintenance/generation-tasks/run", "/api/maintenance/billing-refunds/run", "/api/maintenance/generation-tasks/heartbeat"].includes(url.pathname)) {
                expect(request.method).toBe("POST");
                await requestBytes(request);
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ code: 0, data: { claimed: 0 }, msg: "OK" }));
                return;
            }
            if (url.pathname === "/api/maintenance/image-processing/claim") {
                expect(request.method).toBe("POST");
                const text = (await requestBytes(request)).toString("utf8");
                const result = await claimRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }));
                expect(result.status).toBe(200);
                const envelope: { code: number; data: { tasks: ClaimedImageProcessingTask[] } } = await result.clone().json();
                expect(envelope.code).toBe(0);
                if (child) {
                    expect(completionSaved).toBe(true);
                    expect(envelope.data.tasks).toStrictEqual([]);
                    await relay(result, response);
                    terminalSeen.resolve();
                    return;
                }
                expect(envelope.data.tasks).toHaveLength(1);
                child = envelope.data.tasks[0];
                assert.ok(child);
                expect(child.id).toBe(jobId);
                await relay(result, response);
                return;
            }
            assert.ok(child);
            const endpoint = `/api/maintenance/image-processing/${encodeURIComponent(jobId)}`;
            if (url.pathname.startsWith(endpoint + "/inputs/")) {
                expect(request.method).toBe("GET");
                const assetId = decodeURIComponent(url.pathname.slice((endpoint + "/inputs/").length));
                const transportWorker = request.headers["x-vozeb-pro-worker-id"];
                const executionId = request.headers["x-vozeb-pro-execution-id"];
                assert.ok(typeof transportWorker === "string" && typeof executionId === "string");
                expect(executionId).toBe(child.executionId);
                const result = await inputRoute.GET(new Request(url, { headers: { authorization, "x-vozeb-pro-worker-id": transportWorker, "x-vozeb-pro-execution-id": executionId } }), { params: Promise.resolve({ id: jobId, assetId }) });
                expect(result.status).toBe(200);
                await relay(result, response);
                return;
            }
            if (url.pathname === endpoint + "/outputs/final") {
                expect(request.method).toBe("PUT");
                const transportWorker = request.headers["x-vozeb-pro-worker-id"];
                const executionId = request.headers["x-vozeb-pro-execution-id"];
                const mimeType = request.headers["content-type"];
                assert.ok(typeof transportWorker === "string" && typeof executionId === "string" && typeof mimeType === "string");
                expect(executionId).toBe(child.executionId);
                const bytes = await requestBytes(request);
                const result = await outputRoute.PUT(
                    new Request(url, { method: "PUT", headers: { authorization, "content-type": mimeType, "x-vozeb-pro-worker-id": transportWorker, "x-vozeb-pro-execution-id": executionId }, body: new Uint8Array(bytes) }),
                    { params: Promise.resolve({ id: jobId, kind: "final" }) },
                );
                expect(result.status).toBe(201);
                const envelope: { code: number; data: StoredImageProcessingArtifact } = await result.clone().json();
                expect(envelope.code).toBe(0);
                expect(envelope.data).toMatchObject({ sha256: digest(bytes), bytes: bytes.length, resultId: url.searchParams.get("resultId") });
                uploads.push({ stored: envelope.data, bytes });
                await relay(result, response);
                return;
            }
            const text = (await requestBytes(request)).toString("utf8");
            const routeRequest = new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text });
            if (url.pathname === endpoint + "/heartbeat") {
                const result = await heartbeatRoute.POST(routeRequest, { params: Promise.resolve({ id: jobId }) });
                expect(result.status).toBe(200);
                await relay(result, response);
                return;
            }
            expect(url.pathname).toBe(endpoint + "/complete");
            expect(request.method).toBe("POST");
            const result = await completeRoute.POST(routeRequest, { params: Promise.resolve({ id: jobId }) });
            expect(result.status).toBe(200);
            // The actual Route validates this Worker DTO before the test reads its typed fields.
            const completion: CompleteImageProcessingInput = JSON.parse(text);
            expect(completion.executionId).toBe(child.executionId);
            expect(completion.metrics.pid).toBeGreaterThan(0);
            expect(completion.metrics.pid).not.toBe(workerPid);
            expect(completion.metrics.pid).not.toBe(process.pid);
            expect(() => process.kill(completion.metrics.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
            expect(completion.metrics.peakRssBytes).toBeGreaterThan(0);
            expect(completion.metrics.peakHeapUsedBytes).toBeGreaterThan(0);
            expect(completion.metrics.peakExternalBytes).toBeGreaterThan(0);
            const envelope: { code: number; data: Awaited<ReturnType<typeof service.completeImageProcessingTask>> } = await result.clone().json();
            expect(envelope.code).toBe(0);
            completionSaved = true;
            await relay(result, response);
            completed.resolve({ child, completion, receipt: envelope.data });
        }

        const server = createServer((request, response) => {
            const running = handle(request, response)
                .catch((error: unknown) => {
                    failure.reject(error);
                    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
                    response.end(JSON.stringify({ code: 500, data: null, msg: "Result mode TCP fixture rejected the request" }));
                })
                .finally(() => requests.delete(running));
            requests.add(running);
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                });
            });
            server.on("error", (error) => failure.reject(error));
            const address = server.address();
            assert.ok(address !== null && typeof address !== "string");
            origin = `http://127.0.0.1:${address.port}`;
            const worker = spawn(process.execPath, ["--max-old-space-size=64", workerScript], {
                cwd: path.dirname(path.dirname(workerScript)),
                env: {
                    // Match the supervisor's runtime boundary; database credentials stay in this Web/Route process.
                    NODE_ENV: "production",
                    UV_THREADPOOL_SIZE: "2",
                    SystemRoot: process.env.SystemRoot,
                    WINDIR: process.env.WINDIR,
                    LANG: process.env.LANG,
                    LC_ALL: process.env.LC_ALL,
                    TZ: process.env.TZ,
                    TMPDIR: workerTemp,
                    TMP: workerTemp,
                    TEMP: workerTemp,
                    ...resourceEnvironment,
                    VOZEB_PRO_WORKER_TOKEN: workerToken,
                    VOZEB_PRO_WORKER_API_ORIGIN: origin,
                    VOZEB_PRO_GENERATION_WORKER_ID: workerId,
                    VOZEB_PRO_GENERATION_WORKER_LANES: "1",
                    VOZEB_PRO_GENERATION_WORKER_HEARTBEAT_MS: "5000",
                },
                stdio: "pipe",
            });
            const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
                worker.once("error", reject);
                worker.once("close", (code, signal) => resolve({ code, signal }));
            });
            workerPid = worker.pid;
            worker.stdin.end();
            worker.stdout.setEncoding("utf8");
            worker.stderr.setEncoding("utf8");
            worker.stdout.on("data", (chunk: string) => {
                stdout += chunk;
            });
            worker.stderr.on("data", (chunk: string) => {
                stderr += chunk;
                failure.reject(new Error("Actual result Worker reported an error: " + stderr));
            });
            try {
                assert.ok(workerPid);
                const [observed] = await bounded(
                    Promise.race([
                        Promise.all([completed.promise, terminalSeen.promise]),
                        failure.promise,
                        closed.then((exit) => {
                            throw new Error("Actual result Worker exited before completion: " + JSON.stringify(exit));
                        }),
                    ]),
                    30_000,
                    "Actual result Worker did not complete its claimed task",
                );
                return { ...observed, uploads };
            } finally {
                if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
                try {
                    expect(await bounded(closed, 15_000, "Actual result Worker did not drain on SIGTERM")).toStrictEqual({ code: 0, signal: null });
                } catch (error) {
                    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
                    await closed;
                    throw error;
                }
                await Promise.all([...requests]);
                expect(stderr).toBe("");
                expect(await readdir(workerTemp)).toStrictEqual([]);
            }
        } finally {
            server.closeAllConnections();
            if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    }

    async function registeredMediaBytes(storageKey: string) {
        const registration = await registrations.getLocalMediaRegistration(storageKey);
        assert.ok(registration);
        if (registration.storageProvider === "object") {
            const { readExternalMediaStream } = await import("./object-storage-service");
            return imageProcessingStreamBytes(await readExternalMediaStream(registration));
        }
        const saved = await references.readReferenceAsset(storageKey);
        assert.ok(saved);
        return readFile(saved.filePath);
    }

    async function objectStorageSettingsTruth() {
        return (await database.postgresQuery<{ raw: RawSqlRow; nonAudit: RawSqlRow }>(`SELECT to_jsonb(s) AS raw, to_jsonb(s) - 'updated_at' AS "nonAudit" FROM object_storage_settings AS s WHERE id = 'default'`)).rows;
    }

    async function consume(
        image: ImageTask,
        nativeBytes: Buffer[],
        expectedMode: "ordinary" | "layers" | "scene_protection" | "product_protection",
        expectedAuxiliaryInputs: number,
        afterFreeze?: (image: ImageTask) => Promise<void>,
        afterWorker?: () => Promise<void>,
        expectedFinalStorageProvider: "local" | "object" = "local",
    ) {
        const conversationId = image.conversationId;
        assert.ok(conversationId);
        const charge = await auth.consumeUserPoints(userId, image.config.model, 1, "image", `fixture-result-modes:${image.id}`);
        await support.persistChargedImageResponse(image, new Headers({ "x-vozeb-pro-points-cost": String(charge.cost), "x-vozeb-pro-points-record-id": charge.recordId, "x-vozeb-pro-points-remaining": String(charge.remaining) }));
        const pointRecords = await auth.listPointRecordsPage(userId, { pageSize: 50 });
        const chargedFinancial = await ownedFinancialRows();
        expect(chargedFinancial.pointRecords).toHaveLength(2);
        expect(chargedFinancial.pointRecords).toEqual(expect.arrayContaining([expect.objectContaining({ id: charge.recordId, user_id: userId, type: "consume", idempotency_key: charge.idempotencyKey })]));
        assert.ok(await imageTasks.transitionImageTask(image, ["pending"], { status: "running" }));
        assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: 1 }));
        const imageClaims = await scheduler.claimDueGenerationTasks({ workerId: "fixture-modes-image-worker", taskIds: [image.id], limit: 1 });
        expect(imageClaims).toHaveLength(1);
        const imageClaim = imageClaims[0];
        assert.ok(imageClaim);
        assert.ok(typeof imageClaim.payload.executionId === "string");
        const identity = { taskId: image.id, workerId: "fixture-modes-image-worker", executionId: imageClaim.payload.executionId };
        const upstreamResults = nativeBytes.map((bytes) => ({ dataUrl: dataUrl(bytes) }));
        await imageTasks.updateImageTask(image.id, { result: { ...upstreamResults[0], results: upstreamResults } });
        const requested = await imageTasks.getImageTask(image.id);
        assert.ok(requested);
        expect(await runtime.persistImageTaskResult(requested, "https://fixture.invalid", "inline://image-task-result", "", userId)).toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
        const sealed = await imageTasks.getImageTask(image.id);
        assert.ok(sealed?.nativeResults);
        expect(sealed.nativeResults.slots.map((slot) => ({ resultId: slot.resultId, resultIndex: slot.resultIndex }))).toStrictEqual(nativeBytes.map((_, index) => ({ resultId: `${image.id}:${index + 1}`, resultIndex: index + 1 })));

        const waiting = await imageTasks.getImageTask(image.id);
        assert.ok(waiting?.resultProcessing);
        expect(await processing.ensureImageTaskResultProcessing(identity)).toStrictEqual({ state: "ownership_lost" });
        if (afterFreeze) await afterFreeze(waiting);
        const worker = await processWithWorker(waiting.resultProcessing.jobId);
        const child = worker.child;
        const childRecord = await tasks.getStoredGenerationTaskRecord("image_processing", child.id);
        assert.ok(childRecord);
        expect(childRecord.parentTaskId).toBe(image.id);
        expect(childRecord.runId).toBeUndefined();
        const payload = child.payload;
        assert.ok(payload.operation === "process_result");
        expect(payload.options.mode).toBe(expectedMode);
        expect(payload.options.results.map((slot) => ({ resultId: slot.resultId, resultIndex: slot.resultIndex }))).toStrictEqual(sealed.nativeResults.slots.map((slot) => ({ resultId: slot.resultId, resultIndex: slot.resultIndex })));
        const nativeIndices = payload.options.results.map((slot) => slot.inputIndex);
        expect(payload.inputs.filter((_, index) => !nativeIndices.includes(index))).toHaveLength(expectedAuxiliaryInputs);
        expect(payload.resource.facts.decodedInputs).toStrictEqual([]);
        expect(payload.imageResultBinding).toMatchObject({ imageTaskId: image.id, userId, nativeResults: sealed.nativeResults });
        const result = worker.completion.manifest;
        const bindings = result.results;
        assert.ok(bindings);
        expect(result.sourceIdentities.filter((_, index) => !nativeIndices.includes(index)).filter((source) => source.nativeImage !== undefined)).toStrictEqual([]);
        await afterWorker?.();
        const finals = await Promise.all(
            result.artifacts.map(async (stored) => {
                const upload = worker.uploads.find((item) => item.stored.resultId === stored.resultId);
                assert.ok(upload);
                expect(upload.stored).toMatchObject({
                    kind: stored.kind,
                    sha256: stored.sha256,
                    bytes: stored.bytes,
                    storageKey: stored.storageKey,
                    mimeType: stored.mimeType,
                    width: stored.width,
                    height: stored.height,
                    resultId: stored.resultId,
                    resultIndex: stored.resultIndex,
                });
                const bytes = await registeredMediaBytes(stored.storageKey);
                expect(bytes).toEqual(upload.bytes);
                expect(digest(bytes)).toBe(stored.sha256);
                return { stored, bytes };
            }),
        );
        expect(worker.receipt).toMatchObject({ jobId: child.id, inputDigest: payload.inputDigest, executionId: child.executionId, manifest: result, parentRescheduled: true });
        expect(await service.completeImageProcessingTask(child.id, worker.completion)).toStrictEqual(worker.receipt);
        const before = await ownedRows();
        expect(before.rows).toHaveLength(2);
        expect(before.rows.find((row) => row.id === image.id)).toMatchObject({ status: "running", execution_phase: "persisting", worker_id: null, lease_until: null });
        const completedChild = before.rows.find((row) => row.id === child.id);
        assert.ok(completedChild);
        expect(completedChild).toMatchObject({ task_type: "image_processing", status: "success", execution_phase: "completed", parent_task_id: image.id, run_id: null });
        expect(before.logs).toStrictEqual([]);
        expect(before.logAssets).toStrictEqual([]);
        expect(before.assets).toStrictEqual([]);
        expect(before.enhancementJobs).toStrictEqual([]);
        expect(before.financial).toStrictEqual(chargedFinancial);
        const finalKeys = finals.map((final) => final.stored.storageKey);
        expect(before.registrations.filter((row) => finalKeys.includes(row.storage_key))).toMatchObject(finals.map(() => ({ storage_class: "temporary", storage_provider: expectedFinalStorageProvider, task_id: child.id })));
        const recoveryInput = { origin: "https://fixture.invalid", workerId: "fixture-modes-consumer-worker", taskIds: [image.id], limit: 1 };
        expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 1, failed: 0, needsReview: 0, deferred: 0 });
        const published = await imageTasks.getImageTask(image.id);
        assert.ok(published?.result?.results);
        const delivered = published.result.results;
        expect(published).toMatchObject({ status: "success", nativeResults: sealed.nativeResults, resultProcessing: waiting.resultProcessing, billing: { pointsCost: charge.cost, pointsRecordId: charge.recordId, refunded: false } });
        const originalAttempt = image.attempts?.[0];
        assert.ok(originalAttempt);
        expect(published.attemptNo).toBe(image.attemptNo);
        expect(published.attempts).toStrictEqual([{ ...originalAttempt, status: "succeeded", completedAt: expect.any(Number), pointsCost: charge.cost, pointsRecordId: charge.recordId }]);
        expect(delivered.map((output) => output.resultId)).toStrictEqual(bindings.filter((binding) => !binding.error).map((binding) => binding.resultId));
        expect(delivered.map((output) => output.serverUrl)).toStrictEqual(finals.map((final) => `/api/reference-assets/${final.stored.storageKey.split("/").map(encodeURIComponent).join("/")}`));
        const promoted = await Promise.all(finals.map((final) => registrations.getLocalMediaRegistration(final.stored.storageKey)));
        expect(promoted.map((registration) => registration?.storageClass)).toStrictEqual(finals.map(() => "permanent"));
        const log = (await logs.listGenerationLogs({ userId })).items.filter((item) => item.taskId === image.id);
        expect(log).toHaveLength(1);
        expect(log[0]?.assets).toHaveLength(finals.length);
        const assets = (await creative.listAssetsForUser(userId, conversationId)).filter((asset) => asset.sourceTaskId === image.id);
        expect(assets).toHaveLength(finals.length);
        expect(await auth.listPointRecordsPage(userId, { pageSize: 50 })).toStrictEqual(pointRecords);
        const successful = await ownedRows();
        expect(successful.rows).toHaveLength(2);
        expect(successful.rows.find((row) => row.id === image.id)).toMatchObject({ status: "success", execution_phase: "completed", worker_id: null, lease_until: null, next_poll_at: null });
        expect(successful.rows.find((row) => row.id === child.id)).toStrictEqual(completedChild);
        expect(successful.financial).toStrictEqual(chargedFinancial);
        expect(successful.registrations).toStrictEqual(before.registrations.map((row) => (finalKeys.includes(row.storage_key) ? { ...row, storage_class: "permanent", expires_at: null } : row)));
        expect(successful.logs).toHaveLength(1);
        expect(successful.logs[0]).toMatchObject({ id: "image-task:" + image.id, task_id: image.id, user_id: userId, status: "success", count: finals.length, success_count: finals.length, fail_count: 0 });
        expect(successful.logAssets).toHaveLength(finals.length);
        expect(successful.logAssets.map((row) => row.server_url)).toStrictEqual(delivered.map((output) => output.serverUrl));
        expect(successful.assets).toHaveLength(finals.length);
        expect(successful.assets).toMatchObject(delivered.map((output) => ({ user_id: userId, conversation_id: conversationId, source_task_id: image.id, status: "ready", storage_kind: "local", server_url: output.serverUrl })));
        expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
        expect(await imageTasks.getImageTask(image.id)).toStrictEqual(published);
        expect(await service.completeImageProcessingTask(child.id, worker.completion)).toStrictEqual(worker.receipt);
        expect(await ownedRows()).toStrictEqual(successful);
        return { image, payload, result, bindings, finals, published, delivered };
    }

    it("consumes object native, new inline source and final layers after new writes are disabled", async () => {
        const expectedDatabaseOid = process.env.VOZEB_PRO_PG_OBJECT_DATABASE_OID;
        assert.ok(expectedDatabaseOid, "SETUP: Root must supply the dedicated child database OID before this global-settings case");
        expect((await database.postgresQuery<{ oid: string }>("SELECT oid::text AS oid FROM pg_database WHERE datname = current_database()")).rows).toStrictEqual([{ oid: expectedDatabaseOid }]);
        const originalSettingsTruth = await objectStorageSettingsTruth();
        expect(originalSettingsTruth, "SETUP: child schema must seed the settings row; an empty raw snapshot means no settings writes may start").toHaveLength(1);
        const [storageConfig, storageRepository, media] = await Promise.all([import("./object-storage-config"), import("./database/object-storage-repository"), import("./local-media-storage")]);
        const originalSettings = await storageRepository.readObjectStorageSettings();
        const originalRuntime = await storageConfig.getObjectStorageRuntimeConfig();
        const fixture = await imageProcessingS3Fixture();
        try {
            const { source, element, background } = await remoteLayers();
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "PG object native and final layers" });
            const reference = { id: "fixture-pg-object-inline-layer-source", name: "source.png", type: "image/png", dataUrl: dataUrl(source) };
            await storageConfig.saveObjectStorageAdminSettings(fixture.config);
            expect((await storageConfig.getObjectStorageRuntimeConfig()).enabled).toBe(true);
            const image = await createImage({ kind: "edit", conversationId: conversation.id, config: { ...config, outputMode: "layers" }, references: [reference] });
            const writesBeforeDisable: typeof fixture.requests = [];
            let requestCountAtDisable = 0;

            const outcome = await consume(
                image,
                [element, background],
                "layers",
                1,
                undefined,
                async () => {
                    // Worker completes while writes are enabled; the original PG ImageTask consumes after disabling them.
                    writesBeforeDisable.push(...fixture.requests.filter((request) => request.method === "PUT"));
                    expect(writesBeforeDisable).toHaveLength(5);
                    await storageConfig.saveObjectStorageAdminSettings({ ...fixture.config, enabled: false });
                    expect((await storageConfig.getObjectStorageRuntimeConfig()).enabled).toBe(false);
                    requestCountAtDisable = fixture.requests.length;
                },
                "object",
            );

            expect((await storageConfig.getObjectStorageRuntimeConfig()).enabled).toBe(false);
            expect(outcome.payload.sources).toMatchObject([
                { inputIndex: 0, scope: "reference", storageProvider: "object", externalStorageId: "default" },
                { inputIndex: 1, scope: "reference", storageProvider: "object", externalStorageId: "default" },
                { inputIndex: 2, scope: "reference", storageProvider: "object", externalStorageId: "default", frozenResultSource: true },
            ]);
            expect(outcome.published.nativeResults?.slots).toMatchObject([
                { resultId: `${image.id}:1`, resultIndex: 1, status: "stored", storageKey: outcome.payload.sources[0].storageKey, storageProvider: "object", externalStorageId: "default", sha256: digest(element), bytes: element.length },
                { resultId: `${image.id}:2`, resultIndex: 2, status: "stored", storageKey: outcome.payload.sources[1].storageKey, storageProvider: "object", externalStorageId: "default", sha256: digest(background), bytes: background.length },
            ]);
            expect(outcome.payload.inputs[2]).toMatchObject({ assetId: reference.id, expectedSha256: digest(source) });
            expect(outcome.result.sourceIdentities).toMatchObject([
                { sha256: digest(element), bytes: element.length, width: 4, height: 4 },
                { sha256: digest(background), bytes: background.length, width: 4, height: 4 },
                { assetId: reference.id, sha256: digest(source), bytes: source.length, width: 4, height: 4 },
            ]);
            expect(outcome.result.artifacts.map((artifact) => artifact.layerKind)).toStrictEqual(["element", "background"]);
            expect(outcome.finals.map((final) => final.bytes)).toStrictEqual([element, background]);
            expect(outcome.published).toMatchObject({ status: "success", references: [reference] });
            const jobId = outcome.published.resultProcessing?.jobId;
            assert.ok(jobId);
            const registered = [
                { storageKey: outcome.payload.sources[0].storageKey, taskId: image.id, type: "attachment", source: "image-task-native-result", bytes: element },
                { storageKey: outcome.payload.sources[1].storageKey, taskId: image.id, type: "attachment", source: "image-task-native-result", bytes: background },
                { storageKey: outcome.payload.sources[2].storageKey, taskId: image.id, type: "image", source: "image-task-result-source", bytes: source },
                { storageKey: outcome.finals[0].stored.storageKey, taskId: jobId, type: "image", source: "image-processing-final", bytes: element },
                { storageKey: outcome.finals[1].stored.storageKey, taskId: jobId, type: "image", source: "image-processing-final", bytes: background },
            ];
            const objectKeys = await Promise.all(
                registered.map(async (expected) => {
                    const registration = await registrations.getLocalMediaRegistration(expected.storageKey);
                    assert.ok(registration?.externalObjectKey);
                    expect(registration).toMatchObject({
                        ownerUserId: userId,
                        taskId: expected.taskId,
                        scope: "reference",
                        type: expected.type,
                        source: expected.source,
                        bytes: expected.bytes.length,
                        storageClass: "permanent",
                        storageProvider: "object",
                        externalStorageId: "default",
                    });
                    const bytes = await registeredMediaBytes(expected.storageKey);
                    expect(bytes).toEqual(expected.bytes);
                    expect(digest(bytes)).toBe(digest(expected.bytes));
                    expect(await registrations.getLocalMediaRegistration(expected.storageKey)).toStrictEqual(registration);
                    await expect(stat(path.join(media.REFERENCE_MEDIA_ROOT, expected.storageKey))).rejects.toMatchObject({ code: "ENOENT" });
                    expect(fixture.requests.slice(requestCountAtDisable)).toContainEqual({ method: "GET", key: registration.externalObjectKey });
                    return registration.externalObjectKey;
                }),
            );
            expect(new Set(objectKeys).size).toBe(5);
            expect(writesBeforeDisable.map((request) => request.key).toSorted()).toStrictEqual(objectKeys.toSorted());
            expect(fixture.requests.filter((request) => request.method === "PUT")).toStrictEqual(writesBeforeDisable);
        } finally {
            try {
                await fixture.close();
            } finally {
                // Child fixture audit time changes under its normal trigger; restore all other fields without rewriting history.
                await storageRepository.writeObjectStorageSettings(originalSettings);
                await storageConfig.getObjectStorageAdminSettings();
                const restoredSettingsTruth = await objectStorageSettingsTruth();
                expect(restoredSettingsTruth.map((row) => row.nonAudit)).toStrictEqual(originalSettingsTruth.map((row) => row.nonAudit));
                expect(restoredSettingsTruth[0].raw.updated_at).not.toBe(originalSettingsTruth[0].raw.updated_at);
                expect(await storageConfig.getObjectStorageRuntimeConfig()).toStrictEqual(originalRuntime);
            }
        }
    }, 90_000);

    it("reads registered object media facts inside the pool-one transaction after the runtime cache expires", async () => {
        const expectedDatabaseOid = process.env.VOZEB_PRO_PG_OBJECT_DATABASE_OID;
        assert.ok(expectedDatabaseOid, "SETUP: Root must supply the dedicated child database OID before this global-settings case");
        expect((await database.postgresQuery<{ oid: string }>("SELECT oid::text AS oid FROM pg_database WHERE datname = current_database()")).rows).toStrictEqual([{ oid: expectedDatabaseOid }]);
        const originalSettingsTruth = await objectStorageSettingsTruth();
        expect(originalSettingsTruth, "SETUP: child schema must seed the settings row before any settings writes").toHaveLength(1);
        const [storageConfig, storageRepository] = await Promise.all([import("./object-storage-config"), import("./database/object-storage-repository")]);
        const originalSettings = await storageRepository.readObjectStorageSettings();
        const originalRuntime = await storageConfig.getObjectStorageRuntimeConfig();
        const fixture = await imageProcessingS3Fixture();
        const inFlight: Promise<unknown>[] = [];
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let transactionOpen = false;
        let completedInsideTransaction = false;
        try {
            await storageConfig.saveObjectStorageAdminSettings(fixture.config);
            const source = await solid(4, 4, "#8a6243");
            const stored = await references.writePersistentMediaDataUrl(dataUrl(source), "image", { ownerUserId: userId, source: "image-workbench" });
            const registration = await registrations.getLocalMediaRegistration(stored.token);
            assert.ok(registration?.externalObjectKey);
            const objectKey = registration.externalObjectKey;
            expect(registration).toMatchObject({ ownerUserId: userId, scope: "reference", type: "image", storageClass: "permanent", storageProvider: "object", externalStorageId: "default", mimeType: "image/png", bytes: source.length });
            expect(fixture.requests).toStrictEqual([{ method: "PUT", key: objectKey }]);
            const expected = { sha256: digest(source), bytes: source.length, width: 4, height: 4, mimeType: "image/png" };
            const readMediaFacts: (
                registration: Parameters<typeof service.readImageProcessingMediaFacts>[0],
                expected: Parameters<typeof service.readImageProcessingMediaFacts>[1],
                executor: QueryExecutor,
            ) => ReturnType<typeof service.readImageProcessingMediaFacts> = service.readImageProcessingMediaFacts;
            await storageConfig.getObjectStorageRuntimeConfig();
            // Use the real 3-second cache lifetime; no configuration read may warm it after this wait.
            await new Promise<void>((resolve) => setTimeout(resolve, 3100));
            const facts = await database.withPostgresTransaction(async (executor) => {
                await executor.query("SET TRANSACTION READ ONLY");
                transactionOpen = true;
                try {
                    const reading = readMediaFacts(registration, expected, executor).then((value) => {
                        completedInsideTransaction = transactionOpen;
                        return value;
                    });
                    inFlight.push(reading);
                    return await Promise.race([
                        reading,
                        new Promise<never>((_resolve, reject) => {
                            deadline = setTimeout(() => reject(new Error("RED: registered object media facts did not complete inside the pool-one transaction within 5000ms; S3 requests: " + JSON.stringify(fixture.requests))), 5000);
                        }),
                    ]);
                } finally {
                    transactionOpen = false;
                    clearTimeout(deadline);
                }
            });
            expect(completedInsideTransaction).toBe(true);
            expect(facts).toStrictEqual(expected);
            expect(fixture.requests).toStrictEqual([
                { method: "PUT", key: objectKey },
                { method: "GET", key: objectKey },
            ]);
            expect(await registrations.getLocalMediaRegistration(stored.token)).toStrictEqual(registration);
        } finally {
            clearTimeout(deadline);
            // A failed transaction releases pool-one before its queued config read can drain.
            await Promise.allSettled(inFlight);
            try {
                await fixture.close();
            } finally {
                await storageRepository.writeObjectStorageSettings(originalSettings);
                await storageConfig.getObjectStorageAdminSettings();
                const restoredSettingsTruth = await objectStorageSettingsTruth();
                expect(restoredSettingsTruth.map((row) => row.nonAudit)).toStrictEqual(originalSettingsTruth.map((row) => row.nonAudit));
                expect(restoredSettingsTruth[0].raw.updated_at).not.toBe(originalSettingsTruth[0].raw.updated_at);
                expect(await storageConfig.getObjectStorageRuntimeConfig()).toStrictEqual(originalRuntime);
            }
        }
    }, 30_000);

    it("consumes an ordinary target result without renumbering the good slot after a corrupt native", async () => {
        const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Target result slots" });
        const image = await createImage({ kind: "generation", conversationId: conversation.id, config: { ...config, size: "6x4" }, references: [] });
        const outcome = await consume(image, [Buffer.from("not an image"), await solid(12, 8, "#abcdef")], "ordinary", 0);
        expect(outcome.payload.options).toMatchObject({ mode: "ordinary", targetSize: { width: 6, height: 4 }, transparentBackground: false });
        expect(outcome.bindings).toMatchObject([
            { resultId: `${image.id}:1`, resultIndex: 1, error: { failureStage: "decode" } },
            { resultId: `${image.id}:2`, resultIndex: 2, finalArtifactIndex: 0 },
        ]);
        expect(outcome.delivered).toMatchObject([{ resultId: `${image.id}:2`, width: 6, height: 4 }]);
        expect(await sharp(outcome.finals[0].bytes).metadata()).toMatchObject({ width: 6, height: 4 });
    }, 90_000);

    it("consumes a visible transparent ordinary result with its original bytes", async () => {
        const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Transparent result" });
        const native = await sharp(await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
            .composite([{ input: await solid(2, 2, "#ef4444"), left: 1, top: 1 }])
            .png()
            .toBuffer();
        const image = await createImage({ kind: "generation", conversationId: conversation.id, config: { ...config, outputBackground: "transparent" }, references: [] });
        const outcome = await consume(image, [native], "ordinary", 0);
        expect(outcome.payload.options).toMatchObject({ mode: "ordinary", transparentBackground: true });
        expect(outcome.finals[0].bytes).toEqual(native);
        expect(await sharp(outcome.finals[0].bytes).stats()).toMatchObject({ isOpaque: false });
    }, 90_000);

    it("consumes complete layers while keeping the source auxiliary and both original result identities", async () => {
        const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Layered result" });
        const background = await solid(4, 4, "#112233");
        const element = await sharp(await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
            .composite([{ input: await solid(2, 2, "#ef4444"), left: 1, top: 1 }])
            .png()
            .toBuffer();
        const source = await sharp(background)
            .composite([{ input: element }])
            .png()
            .toBuffer();
        const registered = await registeredReference(conversation.id, source);
        const previewUrl = registered.reference.serverUrl + "?width=1600&format=webp#preview";
        const image = await createImage({ kind: "edit", conversationId: conversation.id, config: { ...config, outputMode: "layers" }, references: [{ ...registered.reference, dataUrl: previewUrl, serverUrl: previewUrl }] });
        const outcome = await consume(image, [element, background], "layers", 1);
        assert.ok(outcome.payload.options.mode === "layers");
        expect(outcome.payload.inputs[outcome.payload.options.sourceInputIndex]).toMatchObject({ assetId: registered.reference.id, expectedSha256: digest(source) });
        expect(outcome.result.artifacts.map((artifact) => artifact.layerKind)).toStrictEqual(["element", "background"]);
        expect(outcome.finals.map((final) => final.bytes)).toStrictEqual([element, background]);
        expect(outcome.delivered.map((output) => output.resultId)).toStrictEqual([`${image.id}:1`, `${image.id}:2`]);
    }, 90_000);

    it("consumes a good scene slot with bound auxiliary source and mask and preserved outside pixels", async () => {
        const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Protected scene result" });
        const source = await solid(6, 4, "#123456");
        const registered = await registeredReference(conversation.id, source);
        const buildDirectory = await mkdtemp(path.join(directory, "scene-mask-"));
        const built = await operations.executeImageProcessing(
            {
                version: "image-processing.v1",
                jobId: "fixture-scene-build",
                executionId: "fixture-scene-build-execution",
                operation: "build_protection",
                inputs: [{ path: registered.path, assetId: registered.reference.id, assetVersion: "fixture-scene-source-v1", expectedSha256: digest(source) }],
                outputDirectory: buildDirectory,
                options: { mode: "scene_selection", region: { x: 2, y: 1, width: 2, height: 2 }, semantics: ["replace the selected background"], selectionSource: "user_selection" },
            },
            () => {},
        );
        const protection = built.geometry.sceneProtection;
        assert.ok(protection);
        const maskBytes = await readFile(built.artifacts[0].path);
        const registeredMask = await registeredReference(conversation.id, maskBytes);
        const mask = { ...registeredMask.reference, dataUrl: dataUrl(maskBytes) };
        const image = await createImage({ kind: "edit", conversationId: conversation.id, config, references: [registered.reference], mask, sceneProtection: { ...protection, mask } });
        const native = await solid(6, 4, "#abcdef");
        const outcome = await consume(image, [Buffer.from("not an image"), native], "scene_protection", 2);
        assert.ok(outcome.payload.options.mode === "scene_protection");
        expect(outcome.payload.inputs[outcome.payload.options.sourceInputIndex]).toMatchObject({ assetId: registered.reference.id, expectedSha256: digest(source) });
        expect(outcome.payload.inputs[outcome.payload.options.maskInputIndex]).toMatchObject({ assetId: mask.id, expectedSha256: digest(maskBytes) });
        expect(outcome.bindings).toMatchObject([
            { resultId: `${image.id}:1`, error: { failureStage: "decode" } },
            { resultId: `${image.id}:2`, resultIndex: 2, sceneProtectionEvidence: { sourceDigest: digest(source), maskDigest: digest(maskBytes), nativeDigest: digest(native), compositeOutsideChangedPixels: 0 } },
        ]);
        const pixels = await sharp(outcome.finals[0].bytes).ensureAlpha().raw().toBuffer();
        expect([...pixels.subarray(0, 4)]).toStrictEqual([18, 52, 86, 255]);
        expect([...pixels.subarray(32, 36)]).toStrictEqual([171, 205, 239, 255]);
        expect(outcome.delivered[0].sceneProtectionEvidence).toMatchObject({ sourceDigest: digest(source), maskDigest: digest(maskBytes), nativeDigest: digest(native), compositeDigest: digest(outcome.finals[0].bytes), compositeOutsideChangedPixels: 0 });
    }, 90_000);

    it("consumes a true 4k product baseline and durably queues the existing protected enhancement plan", async () => {
        const [deliveryService, enhancement, jobs, settings, secrets] = await Promise.all([
            import("./image-enhancement-delivery"),
            import("./image-enhancement-enqueue"),
            import("./database/image-enhancement-job-repository"),
            import("./database/image-enhancement-repository"),
            import("./secret-crypto"),
        ]);
        const originalSettings = await database.withPostgresTransaction(async (executor) => {
            await executor.query("SET TRANSACTION READ ONLY");
            return (await executor.query<EnhancementSettingsRow>("SELECT id, value FROM image_enhancement_settings WHERE id = 'default'")).rows;
        });
        try {
            // Owned PostgreSQL fixture only: queue a legal frozen policy without dispatching enhancement.
            await settings.mutateImageEnhancementSettings((stored) => {
                stored.revision = "fixture-product-policy-v1";
                stored.enabled = true;
                stored.tta = false;
                stored.profileId = "fixture-product-profile";
                stored.profiles = {
                    "fixture-product-profile": {
                        id: "fixture-product-profile",
                        endpoint: "http://127.0.0.1:1",
                        trust: "system",
                        caPem: "",
                        tokenCiphertext: secrets.encryptSecretValue("fixture-product-token"),
                        credentialRevision: "fixture-product-credential-v1",
                        serviceId: "fixture-product-service",
                    },
                };
                stored.timeoutMs = 10_000;
                stored.modelId = "fixture-product-model";
                stored.models = [
                    { id: "fixture-product-model", binaryVersion: "fixture-binary-v1", binarySha256: "b".repeat(64), modelVersion: "fixture-model-v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 },
                ];
                stored.check = { revision: stored.revision, state: "ready", stage: "capabilities", reason: "fixture-only", checkedAt: "2026-10-29T00:00:00.000Z" };
                stored.checkRunId = null;
            });
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Protected 4k product result" });
            const source = await sharp(await solid(8, 8, "#123456"))
                .composite([{ input: await solid(2, 2, "#ef4444"), left: 3, top: 3 }])
                .png()
                .toBuffer();
            const registered = await registeredReference(conversation.id, source);
            const productCore = [{ x: 3, y: 3, width: 2, height: 2 }];
            const buildDirectory = await mkdtemp(path.join(directory, "product-mask-"));
            const built = await operations.executeImageProcessing(
                {
                    version: "image-processing.v1",
                    jobId: "fixture-product-build",
                    executionId: "fixture-product-build-execution",
                    operation: "build_protection",
                    inputs: [{ path: registered.path, assetId: registered.reference.id, assetVersion: "fixture-product-source-v1", expectedSha256: digest(source) }],
                    outputDirectory: buildDirectory,
                    options: { mode: "local_edit", targetRegion: { x: 0, y: 0, width: 1, height: 1 }, protectedRectangles: productCore, freezeEnhancementBaseline: { productAnchorId: "fixture-product-anchor", productCore } },
                },
                () => {},
            );
            const qualified = built.geometry.enhancementBaseline;
            assert.ok(qualified?.status === "qualified" && qualified.scope === "product_background");
            expect(qualified).toMatchObject({
                normalization: "srgb-upright-v1",
                hasAlpha: false,
                baseline: { sha256: digest(source), byteLength: source.length, width: 8, height: 8 },
                composition: { productAnchorId: "fixture-product-anchor", sourceAssetId: registered.reference.id, sourceSha256: digest(source), protectedChangedPixels: 0 },
            });
            const maskBytes = await readFile(built.artifacts[0].path);
            const registeredMask = await registeredReference(conversation.id, maskBytes);
            const mask = { id: registeredMask.reference.id, type: "image/png", dataUrl: dataUrl(maskBytes) };
            const productProtection: NonNullable<ImageTask["productProtection"]> = {
                compilerVersion: "strict-product.v1",
                state: "ready",
                productAnchorId: "fixture-product-anchor",
                sourceAssetId: registered.reference.id,
                sourceSize: { width: 8, height: 8 },
                productCore,
                fusionHalo: [],
                editableBackground: [],
            };
            const input = { kind: "edit" as const, conversationId: conversation.id, config: { ...config, quality: "4k", size: "1:1" }, references: [registered.reference], mask, productProtection };
            const files = new Map<string, string>([
                [registered.reference.id, registered.path],
                [mask.id, registeredMask.path],
            ]);
            const enhancementDelivery = await deliveryService.freezeEcommerceEnhancementDelivery(input, async (reference) => {
                assert.ok(reference.id);
                const file = files.get(reference.id);
                assert.ok(file);
                return readFile(file);
            });
            assert.ok(enhancementDelivery?.scope === "product_background");
            expect(enhancementDelivery.baseline).toStrictEqual({ ...qualified.baseline, url: registered.reference.serverUrl });
            expect(enhancementDelivery.protection).toMatchObject({ product: productProtection, maskSha256: digest(maskBytes), maskDataUrl: dataUrl(maskBytes) });
            const image = await createImage({ ...input, enhancementDelivery });
            expect(image.enhancementPolicy).toMatchObject({ enabled: true, revision: "fixture-product-policy-v1", connection: { serviceId: "fixture-product-service", model: { id: "fixture-product-model", nativeScale: 4, tta: false } } });
            const native = await solid(8, 8, "#abcdef");
            const outcome = await consume(image, [native], "product_protection", 2);
            assert.ok(outcome.payload.options.mode === "product_protection");
            expect(outcome.payload.options.baseline).toStrictEqual(qualified.baseline);
            expect(outcome.payload.inputs[outcome.payload.options.sourceInputIndex]).toMatchObject({ assetId: registered.reference.id, expectedSha256: digest(source) });
            expect(outcome.payload.inputs[outcome.payload.options.maskInputIndex]).toMatchObject({ assetId: mask.id, expectedSha256: digest(maskBytes) });
            const binding = outcome.bindings[0];
            assert.ok(binding && !binding.error);
            expect(binding).toMatchObject({
                resultId: `${image.id}:1`,
                resultIndex: 1,
                baselineValidated: true,
                productEnhancementEvidence: { sourceSha256: digest(source), maskSha256: digest(maskBytes), aiSha256: digest(native), compositeSha256: digest(outcome.finals[0].bytes), allowedPixels: 60, protectedPixels: 4, protectedChangedPixels: 0 },
            });
            const pixels = await sharp(outcome.finals[0].bytes).ensureAlpha().raw().toBuffer();
            expect([...pixels.subarray(0, 4)]).toStrictEqual([171, 205, 239, 255]);
            expect([...pixels.subarray(108, 112)]).toStrictEqual([239, 68, 68, 255]);
            const nativeSlot = outcome.published.nativeResults?.slots[0];
            assert.ok(nativeSlot?.status === "stored");
            const nativeUrl = `/api/reference-assets/${nativeSlot.storageKey.split("/").map(encodeURIComponent).join("/")}`;
            const delivered = outcome.delivered[0];
            assert.ok(delivered);
            expect(delivered).toMatchObject({
                resultId: `${image.id}:1`,
                enhancementId: `enhancement:${image.id}:1`,
                nativeSource: { url: nativeUrl, sha256: digest(native), width: 8, height: 8, byteLength: native.length, format: "png", hasAlpha: false, provenance: "provider_native" },
                productEnhancementEvidence: { version: "product-baseline.v2", nativeUrl, nativeSha256: digest(native), baselineUrl: delivered.serverUrl, baselineSha256: digest(outcome.finals[0].bytes), composition: binding.productEnhancementEvidence },
            });
            const decision = enhancement.planImageTaskEnhancement(outcome.published, delivered);
            expect(decision).toMatchObject({
                status: "queued",
                reason: null,
                source: delivered.nativeSource,
                target: { width: 8, height: 8 },
                requestedTarget: { width: 2880, height: 2880 },
                inference: { width: 32, height: 32 },
                delivery: { contract: enhancementDelivery, baseline: { url: delivered.serverUrl, sha256: digest(outcome.finals[0].bytes), width: 8, height: 8, format: "png", hasAlpha: false } },
            });
            const queued = await jobs.listEnhancementJobsForTask(image.id, userId);
            expect(queued).toHaveLength(1);
            expect(queued[0]).toMatchObject({
                id: `enhancement:${image.id}:1`,
                userId,
                imageTaskId: image.id,
                resultId: `${image.id}:1`,
                status: "queued",
                phase: "prepare",
                decision,
                attempt: 1,
                nextPollAt: outcome.published.updatedAt,
                workerId: null,
                leaseToken: null,
                leaseUntil: null,
            });
            expect(queued[0]?.remoteJobId).toBeUndefined();
            expect(queued[0]?.submittedAt).toBeUndefined();
            const storedJobs = (await database.postgresQuery<RawEnhancementJobRow>("SELECT * FROM image_enhancement_jobs WHERE user_id = $1 AND image_task_id = $2 ORDER BY id", [userId, image.id])).rows;
            expect(storedJobs).toHaveLength(1);
            expect(storedJobs[0]).toMatchObject({
                id: `enhancement:${image.id}:1`,
                user_id: userId,
                image_task_id: image.id,
                result_id: `${image.id}:1`,
                status: "queued",
                phase: "prepare",
                next_poll_at: new Date(outcome.published.updatedAt),
                lease_token: null,
                lease_until: null,
                payload: queued[0],
            });
            const beforeReplay = await ownedRows();
            await enhancement.enqueueImageEnhancement(outcome.published);
            expect(await jobs.listEnhancementJobsForTask(image.id, userId)).toStrictEqual(queued);
            expect((await database.postgresQuery<RawEnhancementJobRow>("SELECT * FROM image_enhancement_jobs WHERE user_id = $1 AND image_task_id = $2 ORDER BY id", [userId, image.id])).rows).toStrictEqual(storedJobs);
            expect(await ownedRows()).toStrictEqual(beforeReplay);
        } finally {
            await database.withPostgresTransaction(async (executor) => {
                await executor.query("DELETE FROM image_enhancement_settings WHERE id = 'default'");
                await executor.query("INSERT INTO image_enhancement_settings (id, value) SELECT id, value FROM jsonb_to_recordset($1::jsonb) AS snapshot(id text, value jsonb)", [JSON.stringify(originalSettings)]);
            });
            expect((await database.postgresQuery<EnhancementSettingsRow>("SELECT id, value FROM image_enhancement_settings WHERE id = 'default'")).rows).toStrictEqual(originalSettings);
        }
    }, 90_000);

    it("queues ordinary 4k enhancement from its real Worker final and preserves the original task", async () => {
        const [enhancement, jobs, settings, secrets] = await Promise.all([import("./image-enhancement-enqueue"), import("./database/image-enhancement-job-repository"), import("./database/image-enhancement-repository"), import("./secret-crypto")]);
        const originalSettings = await database.withPostgresTransaction(async (executor) => {
            await executor.query("SET TRANSACTION READ ONLY");
            return (await executor.query<EnhancementSettingsRow>("SELECT id, value FROM image_enhancement_settings WHERE id = 'default'")).rows;
        });
        try {
            // Owned PostgreSQL fixture only: queue a legal frozen policy without dispatching enhancement.
            await settings.mutateImageEnhancementSettings((stored) => {
                stored.revision = "fixture-product-policy-v1";
                stored.enabled = true;
                stored.tta = false;
                stored.profileId = "fixture-product-profile";
                stored.profiles = {
                    "fixture-product-profile": {
                        id: "fixture-product-profile",
                        endpoint: "http://127.0.0.1:1",
                        trust: "system",
                        caPem: "",
                        tokenCiphertext: secrets.encryptSecretValue("fixture-product-token"),
                        credentialRevision: "fixture-product-credential-v1",
                        serviceId: "fixture-product-service",
                    },
                };
                stored.timeoutMs = 10_000;
                stored.modelId = "fixture-product-model";
                stored.models = [
                    { id: "fixture-product-model", binaryVersion: "fixture-binary-v1", binarySha256: "b".repeat(64), modelVersion: "fixture-model-v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 },
                ];
                stored.check = { revision: stored.revision, state: "ready", stage: "capabilities", reason: "fixture-only", checkedAt: "2026-10-29T00:00:00.000Z" };
                stored.checkRunId = null;
            });
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Ordinary 4k result" });
            const native = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } })
                .png()
                .toBuffer();
            const image = await createImage({ kind: "generation", conversationId: conversation.id, config: { ...config, quality: "4k", size: "1:1" }, references: [] });
            expect(image.enhancementPolicy).toMatchObject({ enabled: true, revision: "fixture-product-policy-v1" });
            const outcome = await consume(image, [native], "ordinary", 0);
            expect(outcome.payload.options).not.toHaveProperty("targetSize");
            expect(outcome.finals[0].bytes).toEqual(native);
            expect(outcome.result.artifacts).toMatchObject([{ width: 1024, height: 1024, sha256: digest(native) }]);
            const delivered = outcome.delivered[0];
            assert.ok(delivered);
            expect(delivered).toMatchObject({
                resultId: `${image.id}:1`,
                enhancementId: `enhancement:${image.id}:1`,
                nativeSource: { url: delivered.serverUrl, sha256: digest(native), width: 1024, height: 1024, byteLength: native.length, format: "png", hasAlpha: false, provenance: "provider_native" },
            });
            expect(enhancement.planImageTaskEnhancement(outcome.published, delivered)).toMatchObject({ status: "queued", reason: null, target: { width: 2880, height: 2880 }, inference: { width: 4096, height: 4096 } });
            const queued = await jobs.listEnhancementJobsForTask(image.id, userId);
            expect(queued).toHaveLength(1);
            expect(queued[0]).toMatchObject({ id: `enhancement:${image.id}:1`, userId, imageTaskId: image.id, resultId: `${image.id}:1`, status: "queued", phase: "prepare", attempt: 1, workerId: null, leaseToken: null, leaseUntil: null });
            expect(queued[0]?.remoteJobId).toBeUndefined();
            expect(queued[0]?.submittedAt).toBeUndefined();
            await enhancement.enqueueImageEnhancement(outcome.published);
            expect(await jobs.listEnhancementJobsForTask(image.id, userId)).toStrictEqual(queued);
        } finally {
            await database.withPostgresTransaction(async (executor) => {
                await executor.query("DELETE FROM image_enhancement_settings WHERE id = 'default'");
                await executor.query("INSERT INTO image_enhancement_settings (id, value) SELECT id, value FROM jsonb_to_recordset($1::jsonb) AS snapshot(id text, value jsonb)", [JSON.stringify(originalSettings)]);
            });
            expect((await database.postgresQuery<EnhancementSettingsRow>("SELECT id, value FROM image_enhancement_settings WHERE id = 'default'")).rows).toStrictEqual(originalSettings);
        }
    }, 90_000);

    async function withRemoteOriginal<T>(
        bytes: Buffer,
        action: (remote: { url: string; request: Promise<{ finish(): void }>; readonly downloads: number; offline(): Promise<void>; run<R>(operation: () => Promise<R>): Promise<R> }) => Promise<T>,
    ): Promise<T> {
        const savedPrivate = process.env.VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS;
        const savedHosts = process.env.VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS;
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        const request = Promise.withResolvers<{ finish(): void }>();
        const stopped = Promise.withResolvers<Error>();
        const inFlight: Promise<unknown>[] = [];
        let downloads = 0;
        let stopping: Error | undefined;
        let closed: Promise<void> | undefined;
        let cleanup: Promise<void> | undefined;
        const server = createServer((incoming, response) => {
            downloads += 1;
            if (incoming.method !== "GET" || incoming.url !== "/original.png" || downloads !== 1) {
                request.reject(new Error("Remote auxiliary fixture received an unexpected request"));
                response.writeHead(500).end();
                return;
            }
            incoming.resume();
            request.resolve({
                finish() {
                    response.writeHead(200, { "content-type": "image/png", "content-length": bytes.length });
                    response.end(bytes);
                },
            });
        });
        function offline() {
            server.closeAllConnections();
            closed ??= server.listening ? new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) : Promise.resolve();
            return closed;
        }
        function close() {
            cleanup ??= (async () => {
                stopping = new Error("REMOTE_FIXTURE_FINISHED: stop waiting for fixture work before database cleanup");
                stopped.resolve(stopping);
                await offline();
                await Promise.allSettled(inFlight);
                vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", savedPrivate);
                vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", savedHosts);
            })();
            return cleanup;
        }
        closeRemoteFixture = close;
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                });
            });
            server.on("error", (error) => request.reject(error));
            const address = server.address();
            assert.ok(address && typeof address !== "string");
            return await action({
                url: `http://127.0.0.1:${address.port}/original.png`,
                request: request.promise,
                get downloads() {
                    return downloads;
                },
                offline,
                run<R>(operation: () => Promise<R>): Promise<R> {
                    if (stopping) return Promise.reject(stopping);
                    const pending = operation();
                    inFlight.push(pending);
                    return Promise.race([
                        pending,
                        stopped.promise.then((error) => {
                            throw error;
                        }),
                    ]);
                },
            });
        } finally {
            await close();
        }
    }

    async function remoteLayers() {
        const background = await solid(4, 4, "#112233");
        const element = await sharp(await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
            .composite([{ input: await solid(2, 2, "#ef4444"), left: 1, top: 1 }])
            .png()
            .toBuffer();
        const source = await sharp(background)
            .composite([{ input: element }])
            .png()
            .toBuffer();
        return { source, element, background };
    }

    async function remoteLayerImage(url: string) {
        const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "PG frozen remote layers" });
        const reference = { id: "fixture-pg-remote-layer-source", name: "source.png", type: "image/png", dataUrl: "", remoteUrl: url };
        const image = await createImage({ kind: "edit", conversationId: conversation.id, config: { ...config, outputMode: "layers" }, references: [reference] });
        return { image, reference, conversationId: conversation.id };
    }

    function beforeRemoteResponse<T>(pending: Promise<T>, request: Promise<{ finish(): void }>) {
        const premature = pending.then(
            () => {
                throw new Error("FREEZE_GATE_NOT_REACHED: work settled before remote auxiliary I/O");
            },
            (cause: unknown) => {
                throw new Error("FREEZE_GATE_NOT_REACHED: work rejected before remote auxiliary I/O", { cause });
            },
        );
        return Promise.race([request, premature]);
    }

    it("consumes frozen remote layers through the real Worker after the original origin goes offline", async () => {
        const layers = await remoteLayers();
        await withRemoteOriginal(layers.source, async (remote) => {
            const fixture = await remote.run(() => remoteLayerImage(remote.url));
            const pending = remote.run(() =>
                consume(fixture.image, [layers.element, layers.background], "layers", 1, async (frozen) => {
                    assert.ok(frozen.resultProcessing);
                    const payload = await tasks.getStoredGenerationTask<ClaimedImageProcessingTask["payload"]>("image_processing", frozen.resultProcessing.jobId);
                    assert.ok(payload?.operation === "process_result" && payload.options.mode === "layers");
                    const sourceInputIndex = payload.options.sourceInputIndex;
                    const source = payload.sources.find((item) => item.inputIndex === sourceInputIndex);
                    assert.ok(source);
                    expect(source).toMatchObject({ scope: "reference", storageProvider: "local" });
                    expect(await registrations.getLocalMediaRegistration(source.storageKey)).toMatchObject({
                        ownerUserId: userId,
                        taskId: fixture.image.id,
                        scope: "reference",
                        type: "image",
                        storageClass: "permanent",
                        bytes: layers.source.length,
                        source: "image-task-result-source",
                    });
                    const saved = await references.readReferenceAsset(source.storageKey);
                    assert.ok(saved);
                    expect(await readFile(saved.filePath)).toEqual(layers.source);
                    expect(frozen.references).toStrictEqual(fixture.image.references);
                    expect(frozen.config).toStrictEqual(fixture.image.config);
                    await remote.offline();
                }),
            );
            const request = await beforeRemoteResponse(pending, remote.request);
            expect(remote.downloads).toBe(1);
            expect((await remote.run(() => imageTasks.getImageTask(fixture.image.id)))?.resultProcessing).toBeUndefined();
            request.finish();
            const outcome = await pending;
            assert.ok(outcome.payload.options.mode === "layers");
            expect(outcome.payload.inputs[outcome.payload.options.sourceInputIndex]).toMatchObject({ assetId: fixture.reference.id, assetVersion: digest(layers.source), expectedSha256: digest(layers.source) });
            expect(outcome.result.sourceIdentities[2]).toMatchObject({ assetId: fixture.reference.id, sha256: digest(layers.source), width: 4, height: 4 });
            expect(outcome.result.sourceIdentities[2]).not.toHaveProperty("nativeImage");
            expect(outcome.result.artifacts.map((artifact) => artifact.layerKind)).toStrictEqual(["element", "background"]);
            expect(outcome.finals.map((final) => final.bytes)).toStrictEqual([layers.element, layers.background]);
            expect(outcome.delivered.map((result) => result.resultId)).toStrictEqual([`${fixture.image.id}:1`, `${fixture.image.id}:2`]);
            expect(outcome.published.references).toStrictEqual(fixture.image.references);
            expect(remote.downloads).toBe(1);
        });
    }, 90_000);

    it.each([
        {
            name: "source gains a higher-priority serverUrl",
            async replacement(fixture: Awaited<ReturnType<typeof remoteLayerImage>>): Promise<{ path: string[]; value: ImageTask["references"] | ImageTask["config"] }> {
                const local = await registeredReference(fixture.conversationId, await solid(4, 4, "#10b981"));
                return { path: ["references"], value: [{ ...fixture.reference, serverUrl: local.reference.serverUrl }] };
            },
        },
        {
            name: "result options change from layers to ordinary",
            async replacement(fixture: Awaited<ReturnType<typeof remoteLayerImage>>): Promise<{ path: string[]; value: ImageTask["references"] | ImageTask["config"] }> {
                return { path: ["config"], value: { ...fixture.image.config, outputMode: undefined, outputBackground: "transparent" } };
            },
        },
    ])(
        "preserves the current PG parent without publishing or yielding when $name during remote source I/O",
        async ({ replacement }) => {
            const layers = await remoteLayers();
            await withRemoteOriginal(layers.source, async (remote) => {
                const fixture = await remote.run(() => remoteLayerImage(remote.url));
                const image = fixture.image;
                const charge = await remote.run(() => auth.consumeUserPoints(userId, image.config.model, 1, "image", `fixture-pg-remote-source:${image.id}`));
                await remote.run(() => support.persistChargedImageResponse(image, new Headers({ "x-vozeb-pro-points-cost": String(charge.cost), "x-vozeb-pro-points-record-id": charge.recordId, "x-vozeb-pro-points-remaining": String(charge.remaining) })));
                assert.ok(await remote.run(() => imageTasks.transitionImageTask(image, ["pending"], { status: "running" })));
                assert.ok(await remote.run(() => scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: 1 })));
                const workerId = "fixture-pg-remote-source-owner";
                const claimed = await remote.run(() => scheduler.claimDueGenerationTasks({ workerId, taskIds: [image.id], limit: 1 }));
                expect(claimed).toHaveLength(1);
                const lease = claimed[0];
                assert.ok(lease && typeof lease.payload.executionId === "string");
                const identity = { taskId: image.id, workerId, executionId: lease.payload.executionId };
                const capture = await import("./image-task-native-capture");
                const attemptNo = image.attemptNo;
                assert.ok(attemptNo);
                expect(
                    await remote.run(() =>
                        capture.captureImageTaskNativeResults({
                            ...identity,
                            attemptNo,
                            upstreamTaskId: null,
                            result: { dataUrl: dataUrl(layers.element), results: [{ dataUrl: dataUrl(layers.element) }, { dataUrl: dataUrl(layers.background) }] },
                            origin: "https://fixture.invalid",
                            authContext: "",
                        }),
                    ),
                ).toMatchObject({ state: "native_ready" });
                const sealed = await remote.run(() => imageTasks.getImageTask(image.id));
                assert.ok(sealed?.nativeResults);
                const before = await remote.run(ownedRows);
                expect(before.rows).toHaveLength(1);
                const pending = remote.run(() => processing.ensureImageTaskResultProcessing(identity));
                const request = await beforeRemoteResponse(pending, remote.request);
                const owner = await remote.run(() => tasks.getStoredGenerationTaskRecord("image", image.id));
                assert.ok(owner);
                expect(owner).toMatchObject({ userId, status: "running", workerId, payload: { executionId: identity.executionId, nativeResults: sealed.nativeResults } });
                expect(owner.leaseUntil).toBeGreaterThan(Date.now());
                const changedSource = await remote.run(() => replacement(fixture));
                const changed = await remote.run(() =>
                    database.postgresQuery(
                        `UPDATE generation_tasks SET payload = jsonb_set(payload, $3::text[], $4::jsonb), updated_at = clock_timestamp()
                 WHERE id = $1 AND user_id = $2 AND task_type = 'image' AND status = 'running' AND worker_id = $5
                   AND payload ->> 'executionId' = $6 AND lease_until > clock_timestamp() RETURNING id`,
                        [image.id, userId, changedSource.path, JSON.stringify(changedSource.value), workerId, identity.executionId],
                    ),
                );
                expect(changed.rowCount).toBe(1);
                const current = await remote.run(ownedRows);
                expect(current.rows).toHaveLength(1);
                expect(current.rows[0]).toMatchObject({ id: image.id, task_type: "image", status: "running", worker_id: workerId, payload: { executionId: identity.executionId, nativeResults: sealed.nativeResults } });
                expect(current.financial).toStrictEqual(before.financial);
                request.finish();
                expect(await pending).toStrictEqual({ state: "ownership_lost" });
                const after = await remote.run(ownedRows);
                expect(after.rows).toStrictEqual(current.rows);
                expect(after.logs).toStrictEqual(current.logs);
                expect(after.logAssets).toStrictEqual(current.logAssets);
                expect(after.assets).toStrictEqual(current.assets);
                expect(after.enhancementJobs).toStrictEqual(current.enhancementJobs);
                expect(after.financial).toStrictEqual(current.financial);
                const originalKeys = new Set(current.registrations.map((row) => row.storage_key));
                expect(after.registrations.filter((row) => originalKeys.has(row.storage_key))).toStrictEqual(current.registrations);
                expect(remote.downloads).toBe(1);
            });
        },
        90_000,
    );
});
