import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageTask } from "./image-task-store";
import type { ClaimedImageProcessingTask, CompleteImageProcessingInput, StoredImageProcessingArtifact } from "./image-processing-service";

describe("File ordinary result consumed into its original log slot", () => {
    let directory: string;
    let userId: string;
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
    let drafts: typeof import("./generation-log-task-service");
    let recovery: typeof import("./generation-task-recovery-service");
    let attempts: typeof import("./generation-attempt");
    let runtime: typeof import("./image-task-runtime");
    const username = "fixture-existing-slot-file-user";
    const workerToken = "fixture-result-modes-worker-token-00000001";
    const resourceEnvironment = {
        VOZEB_PRO_GENERATION_WORKER_MEMORY_MB: "8192",
        VOZEB_PRO_GENERATION_WORKER_HEAP_MB: "64",
        VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB: "6144",
        VOZEB_PRO_IMAGE_PROCESS_HEAP_MB: "384",
        VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY: "1",
    };
    const config: ImageTask["config"] = { baseUrl: "https://fixture.invalid", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model", outputBackground: "opaque" };

    beforeEach(async () => {
        vi.resetModules();
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-existing-slot-file-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_INSTALL_TOKEN", "fixture-existing-slot-file-install-token");
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-result-modes-maintenance-token-01");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        // Same tiny-image admission fixture as the qualified File and PostgreSQL cases.
        for (const [key, value] of Object.entries(resourceEnvironment)) vi.stubEnv(key, value);
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
        [auth, support, creative, logs, drafts, recovery, attempts, runtime] = await Promise.all([
            import("@/lib/auth/store"),
            import("@/app/api/image-tasks/image-task-support"),
            import("./creative-runtime-service"),
            import("./generation-log-store"),
            import("./generation-log-task-service"),
            import("./generation-task-recovery-service"),
            import("./generation-attempt"),
            import("./image-task-runtime"),
        ]);
        const admin = await auth.createFirstAdmin({ username: "fixture-existing-slot-file-admin", password: "FixtureModesPassword1!", displayName: "Fixture administrator", installToken: process.env.VOZEB_PRO_INSTALL_TOKEN });
        const user = await auth.createUserByAdmin({ actorId: admin.id, username, password: "FixtureModesPassword1!", displayName: "Fixture File existing slot", pointsBalance: 100 });
        userId = user.id;
    }, 30_000);

    afterEach(async () => {
        try {
            if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    async function storedFiles(folder = directory): Promise<Array<{ path: string; bytes: Buffer }>> {
        const entries = await readdir(folder, { withFileTypes: true });
        const files = await Promise.all(
            entries
                .toSorted((left, right) => left.name.localeCompare(right.name))
                .map(async (entry) => {
                    const file = path.join(folder, entry.name);
                    return entry.isDirectory() ? storedFiles(file) : [{ path: path.relative(directory, file), bytes: await readFile(file) }];
                }),
        );
        return files.flat();
    }

    async function ownedRows(conversationId: string) {
        return {
            rows: (await tasks.listStoredGenerationTaskRecords({ userId })).all.toSorted((left, right) => left.id.localeCompare(right.id)),
            registrations: (await registrations.listFileLocalMediaRegistrations()).filter((record) => record.ownerUserId === userId).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey)),
            logs: (await logs.listGenerationLogs({ userId })).items,
            assets: await creative.listAssetsForUser(userId, conversationId),
            authBytes: await readFile(path.join(directory, "auth.json")),
            files: await storedFiles(),
        };
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
        const originalLogId = image.generationLogId;
        const originalSlotId = image.generationSlotId;
        const originalRequestId = image.clientRequestId;
        assert.ok(originalLogId && originalSlotId && originalRequestId);
        const conversationId = image.conversationId;
        assert.ok(conversationId);
        const charge = await auth.consumeUserPoints(userId, image.config.model, 1, "image", `fixture-result-modes:${image.id}`);
        await support.persistChargedImageResponse(image, new Headers({ "x-vozeb-pro-points-cost": String(charge.cost), "x-vozeb-pro-points-record-id": charge.recordId, "x-vozeb-pro-points-remaining": String(charge.remaining) }));
        const pointRecords = await auth.listPointRecordsPage(userId, { pageSize: 50 });
        const chargedAuth = await readFile(path.join(directory, "auth.json"));
        const pendingDraft = (await logs.listGenerationLogs({ userId })).items;
        expect(pendingDraft).toHaveLength(1);
        expect(pendingDraft[0]).toMatchObject({
            id: originalLogId,
            userId,
            status: "pending",
            assets: [],
            requestSnapshot: { slots: [{ id: originalSlotId, index: 0, status: "pending", clientRequestId: originalRequestId }] },
        });
        expect(pendingDraft[0].taskId).toBeUndefined();
        assert.ok(await imageTasks.transitionImageTask(image, ["pending"], { status: "running" }));
        assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: 1 }));
        const imageClaims = await scheduler.claimDueGenerationTasks({ workerId: "fixture-modes-image-worker", taskIds: [image.id], limit: 1 });
        expect(imageClaims).toHaveLength(1);
        const imageClaim = imageClaims[0];
        assert.ok(imageClaim);
        assert.ok(typeof imageClaim.payload.executionId === "string");
        const identity = { taskId: image.id, workerId: "fixture-modes-image-worker", executionId: imageClaim.payload.executionId };
        const upstreamResult = { dataUrl: dataUrl(native) };
        await imageTasks.updateImageTask(image.id, { result: { ...upstreamResult, results: [upstreamResult] } });
        const requested = await imageTasks.getImageTask(image.id);
        assert.ok(requested);
        expect(await runtime.persistImageTaskResult(requested, "https://fixture.invalid", "inline://image-task-result", "", userId)).toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
        const sealed = await imageTasks.getImageTask(image.id);
        assert.ok(sealed?.nativeResults);
        expect(sealed.nativeResults.slots.map((slot) => ({ resultId: slot.resultId, resultIndex: slot.resultIndex }))).toStrictEqual([{ resultId: `${image.id}:1`, resultIndex: 1 }]);
        expect(sealed.result).toBeUndefined();
        const nativeSlot = sealed.nativeResults.slots[0];
        assert.ok(nativeSlot.status === "stored");
        const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
        const nativePath = path.join(REFERENCE_MEDIA_ROOT, nativeSlot.storageKey);
        const nativeBytes = await readFile(nativePath);
        expect(nativeBytes).toEqual(native);
        expect(digest(nativeBytes)).toBe(nativeSlot.sha256);
        expect(nativeBytes).toHaveLength(nativeSlot.bytes);
        expect((await logs.listGenerationLogs({ userId })).items).toStrictEqual(pendingDraft);
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
        expect(payload.options.results).toStrictEqual([{ resultId: `${image.id}:1`, resultIndex: 1, inputIndex: 0 }]);
        expect(payload.inputs).toHaveLength(1);
        expect(payload.resource.facts.decodedInputs).toStrictEqual([]);
        expect(payload.imageResultBinding).toMatchObject({ imageTaskId: image.id, userId, nativeResults: sealed.nativeResults });
        const result = worker.completion.manifest;
        const bindings = result.results;
        assert.ok(bindings);
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
        const before = await ownedRows(conversationId);
        expect(before.rows).toHaveLength(2);
        const waitingRecord = before.rows.find((row) => row.id === image.id);
        assert.ok(waitingRecord);
        expect(waitingRecord).toMatchObject({ status: "running", executionPhase: "persisting" });
        expect(waitingRecord.workerId).toBeUndefined();
        expect(waitingRecord.leaseUntil).toBeUndefined();
        const completedChild = before.rows.find((row) => row.id === child.id);
        assert.ok(completedChild);
        expect(completedChild).toMatchObject({ type: "image_processing", status: "success", executionPhase: "completed", parentTaskId: image.id });
        expect(completedChild.runId).toBeUndefined();
        expect(before.logs).toStrictEqual(pendingDraft);
        expect(before.assets).toStrictEqual([]);
        expect(before.authBytes).toEqual(chargedAuth);
        const finalKeys = finals.map((final) => final.stored.storageKey);
        expect(before.registrations.filter((row) => finalKeys.includes(row.storageKey))).toMatchObject([{ storageClass: "temporary", storageProvider: "local", taskId: child.id }]);
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
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({ resultId: `${image.id}:1`, serverUrl: `/api/reference-assets/${finals[0].stored.storageKey.split("/").map(encodeURIComponent).join("/")}` });
        const promoted = await registrations.getLocalMediaRegistration(finals[0].stored.storageKey);
        assert.ok(promoted);
        expect(promoted).toMatchObject({ storageKey: finals[0].stored.storageKey, storageClass: "permanent", storageProvider: "local", taskId: child.id });
        expect(promoted.expiresAt).toBeUndefined();
        expect(await auth.listPointRecordsPage(userId, { pageSize: 50 })).toStrictEqual(pointRecords);
        expect(await readFile(nativePath)).toEqual(native);
        const successful = await ownedRows(conversationId);
        expect(successful.rows).toHaveLength(2);
        const publishedRecord = successful.rows.find((row) => row.id === image.id);
        assert.ok(publishedRecord);
        expect(publishedRecord).toMatchObject({ status: "success", executionPhase: "completed" });
        expect(publishedRecord.workerId).toBeUndefined();
        expect(publishedRecord.leaseUntil).toBeUndefined();
        expect(publishedRecord.nextPollAt).toBeUndefined();
        expect(successful.rows.find((row) => row.id === child.id)).toStrictEqual(completedChild);
        expect(successful.authBytes).toEqual(chargedAuth);
        expect(successful.registrations).toStrictEqual(before.registrations.map((row) => (row.storageKey === promoted.storageKey ? promoted : row)));
        expect(successful.logs).toHaveLength(1);
        expect(successful.logs[0]).toMatchObject({
            id: originalLogId,
            taskId: image.id,
            userId,
            status: "success",
            count: 1,
            successCount: 1,
            failCount: 0,
            requestSnapshot: { slots: [{ id: originalSlotId, index: 0, status: "success", clientRequestId: originalRequestId, taskId: image.id, assetIndex: 0 }] },
        });
        expect(successful.logs.map((log) => log.id)).toStrictEqual([originalLogId]);
        expect(successful.logs[0].assets).toMatchObject([{ serverUrl: delivered[0].serverUrl, width: 6, height: 4 }]);
        expect(successful.assets).toHaveLength(1);
        expect(successful.assets[0]).toMatchObject({ userId, conversationId, sourceTaskId: image.id, ordinal: 0, status: "ready", storageKind: "local", serverUrl: delivered[0].serverUrl });
        expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
        expect(await imageTasks.getImageTask(image.id)).toStrictEqual(published);
        expect(await service.completeImageProcessingTask(child.id, worker.completion)).toStrictEqual(worker.receipt);
        expect(await ownedRows(conversationId)).toStrictEqual(successful);
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
            displayName: "Isolated File existing log slot fixture",
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
        expect(await ownedRows(conversation.id)).toStrictEqual(outcome.persisted);
    }, 90_000);
});
