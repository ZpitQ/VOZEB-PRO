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
import type { QueryExecutor } from "./database";
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { ClaimedImageProcessingTask, CompleteImageProcessingInput, StoredImageProcessingArtifact } from "./image-processing-service";

const nextContext = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", async () => {
    const { RequestCookies } = await import("next/dist/server/web/spec-extension/cookies");
    return { cookies: async () => new RequestCookies(new Headers({ cookie: nextContext.cookie })) };
});

type RawSqlRow = Record<string, unknown>;
type RawTaskRow = RawSqlRow & { id: string; task_type: string; payload: Record<string, unknown> };
type RawMediaRow = RawSqlRow & { storage_key: string };
type RawEnhancementJobRow = RawSqlRow & { id: string; payload: ImageEnhancementJob };
(process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1" ? describe : describe.skip)("PostgreSQL pool-one ordinary result consumed into its original log slot", () => {
    let directory: string;
    let userId = "";
    let username = "";
    let drafts: typeof import("./generation-log-task-service");
    let database: typeof import("./database");
    let wallet: typeof import("./points-wallet-service");
    let imageTasks: typeof import("./image-task-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let processing: typeof import("./image-task-result-processing");
    let service: typeof import("./image-processing-service");
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
        // Same tiny-image admission fixture as the qualified File cases.
        for (const [key, value] of Object.entries(resourceEnvironment)) vi.stubEnv(key, value);
        database = await import("./database");
        await database.initializePostgresSchema();
        [imageTasks, tasks, scheduler, processing, service, references, registrations] = await Promise.all([
            import("./image-task-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./image-task-result-processing"),
            import("./image-processing-service"),
            import("./reference-asset-store"),
            import("./local-media-registry"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
        [auth, support, creative, logs, recovery, attempts, runtime, wallet, drafts] = await Promise.all([
            import("@/lib/auth/store"),
            import("@/app/api/image-tasks/image-task-support"),
            import("./creative-runtime-service"),
            import("./generation-log-store"),
            import("./generation-task-recovery-service"),
            import("./generation-attempt"),
            import("./image-task-runtime"),
            import("./points-wallet-service"),
            import("./generation-log-task-service"),
        ]);
    }, 30_000);

    beforeEach(async () => {
        userId = "fixture-existing-slot-pg-" + randomUUID();
        username = "fixture_" + randomUUID().replaceAll("-", "").slice(0, 16);
        const repositories = database.createPostgresRepositories();
        const settings = await repositories.settings.getSettings();
        const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
        assert.ok(planId, "Fixture entitlement plan missing");
        await repositories.users.createWithNextAccountId({
            id: userId,
            username,
            displayName: "Isolated PostgreSQL existing log slot fixture",
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
        const credit = await wallet.creditPermanentPoints({ userId, amount: 1000, description: "Isolated PostgreSQL existing log slot fixture", idempotencyKey: "fixture-result-modes-credit:" + userId });
        expect(credit.applied).toBe(true);
        expect(credit.record).toMatchObject({ userId, type: "credit", amount: 1000 });
    });

    afterEach(async () => {
        nextContext.cookie = "";
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

    async function createImage(input: Pick<ImageTask, "kind" | "conversationId" | "config" | "references" | "generationLogId" | "generationSlotId" | "clientRequestId">) {
        const started = attempts.startGenerationAttempt(undefined, { model: config.model, capability: "image" });
        return imageTasks.createImageTask({
            userId,
            username,
            displayName: "Isolated result mode fixture",
            source: "image-workbench",
            surface: "chat",
            prompt: "Process this ordinary image into its original pending log slot",
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

    async function consume(image: ImageTask, native: Buffer) {
        const nativeBytes = [native];
        const originalLogId = image.generationLogId;
        const originalSlotId = image.generationSlotId;
        const originalRequestId = image.clientRequestId;
        assert.ok(originalLogId && originalSlotId && originalRequestId);
        const conversationId = image.conversationId;
        assert.ok(conversationId);
        const charge = await auth.consumeUserPoints(userId, image.config.model, 1, "image", `fixture-result-modes:${image.id}`);
        await support.persistChargedImageResponse(image, new Headers({ "x-vozeb-pro-points-cost": String(charge.cost), "x-vozeb-pro-points-record-id": charge.recordId, "x-vozeb-pro-points-remaining": String(charge.remaining) }));
        const pointRecords = await auth.listPointRecordsPage(userId, { pageSize: 50 });
        const chargedFinancial = await ownedFinancialRows();
        expect(chargedFinancial.pointRecords).toHaveLength(2);
        expect(chargedFinancial.pointRecords).toEqual(expect.arrayContaining([expect.objectContaining({ id: charge.recordId, user_id: userId, type: "consume", idempotency_key: charge.idempotencyKey })]));
        const pendingDraft = (await ownedRows()).logs;
        expect(pendingDraft).toHaveLength(1);
        expect(pendingDraft[0]).toMatchObject({
            id: originalLogId,
            user_id: userId,
            status: "pending",
            task_id: null,
            request_snapshot: { slots: [{ id: originalSlotId, index: 0, status: "pending", clientRequestId: originalRequestId }] },
        });
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
        expect(sealed.nativeResults.slots.map((slot) => ({ resultId: slot.resultId, resultIndex: slot.resultIndex }))).toStrictEqual([{ resultId: `${image.id}:1`, resultIndex: 1 }]);
        const session = await auth.createSession(userId);
        expect(await auth.getUserBySession(session)).toMatchObject({ id: userId });
        nextContext.cookie = `vozeb_pro_session=${session}`;
        const { GET } = await import("@/app/api/image-tasks/[id]/route");
        const publicResponse = await GET(new Request(`http://fixture.invalid/api/image-tasks/${image.id}`, { headers: { cookie: nextContext.cookie } }), { params: Promise.resolve({ id: image.id }) });
        expect(publicResponse.status, "SETUP: actual authenticated image detail GET").toBe(200);
        const publicText = await publicResponse.text();
        expect(JSON.parse(publicText)).toMatchObject({ task: { id: image.id, status: "running", executionPhase: "persisting" } });
        expect(publicText).not.toContain(dataUrl(native));
        expect(sealed.result).toBeUndefined();
        expect((await ownedRows()).logs).toStrictEqual(pendingDraft);

        const waiting = await imageTasks.getImageTask(image.id);
        assert.ok(waiting?.resultProcessing);
        expect(await processing.ensureImageTaskResultProcessing(identity)).toStrictEqual({ state: "ownership_lost" });
        const worker = await processWithWorker(waiting.resultProcessing.jobId);
        const child = worker.child;
        const childRecord = await tasks.getStoredGenerationTaskRecord("image_processing", child.id);
        assert.ok(childRecord);
        expect(childRecord.parentTaskId).toBe(image.id);
        expect(childRecord.runId).toBeUndefined();
        const payload = child.payload;
        assert.ok(payload.operation === "process_result");
        expect(payload.options.mode).toBe("ordinary");
        expect(payload.options.results.map((slot) => ({ resultId: slot.resultId, resultIndex: slot.resultIndex }))).toStrictEqual(sealed.nativeResults.slots.map((slot) => ({ resultId: slot.resultId, resultIndex: slot.resultIndex })));
        const nativeIndices = payload.options.results.map((slot) => slot.inputIndex);
        expect(payload.inputs.filter((_, index) => !nativeIndices.includes(index))).toHaveLength(0);
        expect(payload.resource.facts.decodedInputs).toStrictEqual([]);
        expect(payload.imageResultBinding).toMatchObject({ imageTaskId: image.id, userId, nativeResults: sealed.nativeResults });
        const result = worker.completion.manifest;
        const bindings = result.results;
        assert.ok(bindings);
        expect(result.sourceIdentities.filter((_, index) => !nativeIndices.includes(index)).filter((source) => source.nativeImage !== undefined)).toStrictEqual([]);
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
                const saved = await references.readReferenceAsset(stored.storageKey);
                assert.ok(saved);
                const bytes = await readFile(saved.filePath);
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
        expect(before.logs).toStrictEqual(pendingDraft);
        expect(before.logAssets).toStrictEqual([]);
        expect(before.assets).toStrictEqual([]);
        expect(before.enhancementJobs).toStrictEqual([]);
        expect(before.financial).toStrictEqual(chargedFinancial);
        const finalKeys = finals.map((final) => final.stored.storageKey);
        expect(before.registrations.filter((row) => finalKeys.includes(row.storage_key))).toMatchObject(finals.map(() => ({ storage_class: "temporary", storage_provider: "local", task_id: child.id })));
        const recoveryInput = { origin: "https://fixture.invalid", workerId: "fixture-modes-consumer-worker", taskIds: [image.id], limit: 1 };
        expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 1, failed: 0, needsReview: 0, deferred: 0 });
        const published = await imageTasks.getImageTask(image.id);
        assert.ok(published?.result?.results);
        const delivered = published.result.results;
        expect(published).toMatchObject({
            id: image.id,
            status: "success",
            generationLogId: originalLogId,
            generationSlotId: originalSlotId,
            clientRequestId: originalRequestId,
            nativeResults: sealed.nativeResults,
            resultProcessing: waiting.resultProcessing,
            billing: { pointsCost: charge.cost, pointsRecordId: charge.recordId, refunded: false },
        });
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
        expect(successful.logs[0]).toMatchObject({
            id: originalLogId,
            task_id: image.id,
            user_id: userId,
            status: "success",
            count: 1,
            success_count: 1,
            fail_count: 0,
            request_snapshot: { slots: [{ id: originalSlotId, index: 0, status: "success", clientRequestId: originalRequestId, taskId: image.id, assetIndex: 0 }] },
        });
        expect(successful.logs.map((log) => log.id)).toStrictEqual([originalLogId]);
        expect(successful.enhancementJobs).toStrictEqual([]);
        expect(successful.logAssets).toHaveLength(finals.length);
        expect(successful.logAssets.map((row) => row.server_url)).toStrictEqual(delivered.map((output) => output.serverUrl));
        expect(successful.logAssets[0]).toMatchObject({ generation_log_id: originalLogId, sort_order: 0, width: 6, height: 4 });
        expect(successful.assets).toHaveLength(finals.length);
        expect(successful.assets).toMatchObject(delivered.map((output) => ({ user_id: userId, conversation_id: conversationId, source_task_id: image.id, status: "ready", storage_kind: "local", server_url: output.serverUrl })));
        expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
        expect(await imageTasks.getImageTask(image.id)).toStrictEqual(published);
        expect(await service.completeImageProcessingTask(child.id, worker.completion)).toStrictEqual(worker.receipt);
        expect(await ownedRows()).toStrictEqual(successful);
        return { image, payload, result, bindings, finals, published, delivered, persisted: successful };
    }

    it("processes an ordinary result through the real Worker into its original pending log slot without creating a standalone log", async () => {
        const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Original ordinary image log slot" });
        const logId = "fixture-original-log-" + randomUUID();
        const slotId = "fixture-original-slot-" + randomUUID();
        const requestId = "fixture-original-request-" + randomUUID();
        // Same draft contract as POST /api/generation-logs; completion is written only by the server.
        const draft = await drafts.recordGenerationLogDraft({
            id: logId,
            userId,
            username,
            displayName: "Isolated PostgreSQL existing log slot fixture",
            conversationId: conversation.id,
            kind: "image",
            source: "image-workbench",
            status: "pending",
            title: "Original ordinary image log slot",
            prompt: "Process this ordinary image into its original pending log slot",
            requestSnapshot: {
                version: 1,
                userPrompt: "Process this ordinary image into its original pending log slot",
                parameters: {},
                references: [],
                slots: [{ id: slotId, index: 0, status: "pending", clientRequestId: requestId }],
            },
        });
        assert.ok(draft);
        expect(draft).toMatchObject({ id: logId, userId, conversationId: conversation.id, status: "pending", assets: [], requestSnapshot: { slots: [{ id: slotId, index: 0, status: "pending", clientRequestId: requestId }] } });
        const image = await createImage({
            kind: "generation",
            conversationId: conversation.id,
            config: { ...config, size: "6x4" },
            references: [],
            generationLogId: draft.id,
            generationSlotId: slotId,
            clientRequestId: requestId,
        });
        expect(image).toMatchObject({ generationLogId: logId, generationSlotId: slotId, clientRequestId: requestId });
        expect(image.runId).toBeUndefined();
        const native = await solid(12, 8, "#abcdef");
        const outcome = await consume(image, native);
        expect(outcome.payload.options).toMatchObject({ mode: "ordinary", targetSize: { width: 6, height: 4 }, transparentBackground: false });
        expect(outcome.bindings).toMatchObject([{ resultId: `${image.id}:1`, resultIndex: 1, finalArtifactIndex: 0 }]);
        expect(outcome.finals).toHaveLength(1);
        expect(outcome.delivered).toMatchObject([{ resultId: `${image.id}:1`, width: 6, height: 4 }]);
        expect(await sharp(outcome.finals[0].bytes).metadata()).toMatchObject({ width: 6, height: 4 });
        const pixels = await sharp(outcome.finals[0].bytes).ensureAlpha().raw().toBuffer();
        expect([...pixels.subarray(0, 4)]).toStrictEqual([171, 205, 239, 255]);
        expect(await runtime.persistImageTaskResult(outcome.published, "https://fixture.invalid", "inline://image-task-result", "", userId)).toStrictEqual(outcome.published);
        expect(await ownedRows()).toStrictEqual(outcome.persisted);
    }, 90_000);
});
