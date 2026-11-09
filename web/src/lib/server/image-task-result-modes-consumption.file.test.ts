import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ImageTask } from "./image-task-store";
import { imageProcessingS3Fixture, imageProcessingStreamBytes } from "./image-processing-s3-fixture";
import type { ImageProcessingOutcome, ImageProcessingRequest } from "@/lib/image-processing/contracts";
import type { ClaimedImageProcessingTask, CompleteImageProcessingInput, StoredImageProcessingArtifact } from "./image-processing-service";

const nextContext = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (nextContext.cookie ? { value: nextContext.cookie } : undefined) }) }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));

describe("File result modes consumed by the same ImageTask", () => {
    let directory: string;
    let userId: string;
    let imageTasks: typeof import("./image-task-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let capture: typeof import("./image-task-native-capture");
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
    const config: ImageTask["config"] = { baseUrl: "https://fixture.invalid", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model", outputBackground: "opaque" };

    beforeEach(async () => {
        vi.resetModules();
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-result-modes-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_INSTALL_TOKEN", "fixture-result-modes-install-token");
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-result-modes-worker-token-00000001");
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-result-modes-maintenance-token-01");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        // Control-plane admission fixture for conservative uncheckpointed bounds; the ordinary 4k native is 1024 x 1024 and other fixtures are at most 12 x 8.
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "8192");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "6144");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        [imageTasks, tasks, scheduler, capture, processing, service, operations, references, registrations] = await Promise.all([
            import("./image-task-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./image-task-native-capture"),
            import("./image-task-result-processing"),
            import("./image-processing-service"),
            import("@/lib/image-processing/operations"),
            import("./reference-asset-store"),
            import("./local-media-registry"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
        [auth, support, creative, logs, recovery, attempts, runtime] = await Promise.all([
            import("@/lib/auth/store"),
            import("@/app/api/image-tasks/image-task-support"),
            import("./creative-runtime-service"),
            import("./generation-log-store"),
            import("./generation-task-recovery-service"),
            import("./generation-attempt"),
            import("./image-task-runtime"),
        ]);
        const admin = await auth.createFirstAdmin({ username: "fixture-result-modes-admin", password: "FixtureModesPassword1!", displayName: "Fixture administrator", installToken: process.env.VOZEB_PRO_INSTALL_TOKEN });
        const user = await auth.createUserByAdmin({ actorId: admin.id, username: "fixture-result-modes-user", password: "FixtureModesPassword1!", displayName: "Fixture result modes", pointsBalance: 100 });
        userId = user.id;
    }, 30_000);

    afterEach(async () => {
        try {
            if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
            vi.unstubAllEnvs();
        }
    });

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
                    ...process.env,
                    TMPDIR: workerTemp,
                    TMP: workerTemp,
                    TEMP: workerTemp,
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

    async function consume(image: ImageTask, nativeBytes: Buffer[], expectedMode: "ordinary" | "layers" | "scene_protection" | "product_protection", expectedAuxiliaryInputs: number, beforeConsumption?: () => Promise<void>) {
        const conversationId = image.conversationId;
        assert.ok(conversationId);
        const charge = await auth.consumeUserPoints(userId, image.config.model, 1, "image", `fixture-result-modes:${image.id}`);
        await support.persistChargedImageResponse(image, new Headers({ "x-vozeb-pro-points-cost": String(charge.cost), "x-vozeb-pro-points-record-id": charge.recordId, "x-vozeb-pro-points-remaining": String(charge.remaining) }));
        const pointRecords = await auth.listPointRecordsPage(userId, { pageSize: 50 });
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
        await beforeConsumption?.();
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
        const recoveryInput = { origin: "https://fixture.invalid", workerId: "fixture-modes-consumer-worker", taskIds: [image.id], limit: 1 };
        expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 1, failed: 0, needsReview: 0, deferred: 0 });
        const published = await imageTasks.getImageTask(image.id);
        assert.ok(published?.result?.results);
        const delivered = published.result.results;
        expect(published).toMatchObject({ status: "success", nativeResults: sealed.nativeResults, resultProcessing: waiting.resultProcessing, billing: { pointsCost: charge.cost, pointsRecordId: charge.recordId, refunded: false } });
        expect(published.attempts?.map((attempt) => attempt.status)).toStrictEqual(["succeeded"]);
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
        expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
        expect(await imageTasks.getImageTask(image.id)).toStrictEqual(published);
        return { image, payload, result, bindings, finals, published, delivered };
    }

    it.each([
        { width: 1, height: 1 },
        { width: 2, height: 4 },
    ])(
        "rejects a genuinely staged $width x $height final that violates the real child resize contract",
        async (size) => {
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Final target geometry" });
            const image = await createImage({ kind: "generation", conversationId: conversation.id, config: { ...config, size: "6x4" }, references: [] });
            assert.ok(await imageTasks.transitionImageTask(image, ["pending"], { status: "running" }));
            assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: 1 }));
            const claims = await scheduler.claimDueGenerationTasks({ workerId: "fixture-geometry-image-worker", taskIds: [image.id], limit: 1 });
            const lease = claims[0];
            assert.ok(lease?.executionId);
            const identity = { taskId: image.id, workerId: "fixture-geometry-image-worker", executionId: lease.executionId };
            const native = await solid(12, 8, "#abcdef");
            expect(await capture.captureImageTaskNativeResults({ ...identity, attemptNo: 1, upstreamTaskId: null, result: { dataUrl: dataUrl(native) }, origin: "https://fixture.invalid", authContext: "" })).toMatchObject({ state: "native_ready" });
            expect(await processing.ensureImageTaskResultProcessing(identity)).toStrictEqual({ state: "waiting" });
            const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
            const resource = imageProcessingResourceConfig(process.env);
            const claimed = await service.claimImageProcessingTasks({ workerId: "fixture-geometry-child-worker", profileVersion: resource.profileVersion, availableMemoryBytes: resource.budgetBytes, slots: 1 });
            const child = claimed.tasks[0];
            assert.ok(child && child.payload.operation === "process_result" && child.payload.options.mode === "ordinary");
            const taskDirectory = await mkdtemp(path.join(directory, "geometry-child-"));
            const outputDirectory = path.join(taskDirectory, "output");
            await mkdir(outputDirectory);
            const nativePath = path.join(taskDirectory, "native.png");
            await writeFile(nativePath, native);
            const supervisorUrl = new URL("../../../scripts/image-processing-supervisor.mjs", import.meta.url).href;
            const { runImageProcessing }: { runImageProcessing: (request: ImageProcessingRequest, execution: { taskDirectory: string; maxHeapMiB: number }) => Promise<ImageProcessingOutcome> } = await import(supervisorUrl);
            const outcome = await runImageProcessing(
                { ...child.payload, jobId: child.id, executionId: child.executionId, inputs: child.payload.inputs.map((input) => ({ ...input, path: nativePath })), outputDirectory },
                { taskDirectory, maxHeapMiB: 384 },
            );
            assert.ok(outcome.status === "completed");
            expect(outcome.result.artifacts).toMatchObject([{ width: 6, height: 4 }]);
            expect(outcome.result.metrics.pid).not.toBe(process.pid);
            expect(outcome.result.metrics.peakRssBytes).toBeGreaterThan(0);
            const outputRoute = await import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route");
            const invalid = await solid(size.width, size.height, "#abcdef");
            const resultId = child.payload.options.results[0].resultId;
            const uploaded = await outputRoute.PUT(
                new Request(`http://fixture.invalid/api/maintenance/image-processing/${child.id}/outputs/final?resultId=${encodeURIComponent(resultId)}`, {
                    method: "PUT",
                    headers: { authorization: "Bearer " + process.env.VOZEB_PRO_WORKER_TOKEN, "content-type": "image/png", "x-vozeb-pro-worker-id": "fixture-geometry-child-worker", "x-vozeb-pro-execution-id": child.executionId },
                    body: new Uint8Array(invalid),
                }),
                { params: Promise.resolve({ id: child.id, kind: "final" }) },
            );
            expect(uploaded.status).toBe(201);
            const staged: { data: StoredImageProcessingArtifact } = await uploaded.json();
            expect(staged.data).toMatchObject({ ...size, sha256: digest(invalid), bytes: invalid.length });
            const { metrics, ...manifest } = outcome.result;
            // Only the boundary's artifact is replaced; native facts and telemetry are the actual closed child reply.
            const completion: CompleteImageProcessingInput = { workerId: "fixture-geometry-child-worker", executionId: child.executionId, manifest: { ...manifest, artifacts: [staged.data] }, metrics };
            const before = await Promise.all([tasks.getStoredGenerationTaskRecord("image", image.id), tasks.getStoredGenerationTaskRecord("image_processing", child.id)]);
            const completeRoute = await import("@/app/api/maintenance/image-processing/[id]/complete/route");
            const response = await completeRoute.POST(
                new Request(`http://fixture.invalid/api/maintenance/image-processing/${child.id}/complete`, {
                    method: "POST",
                    headers: { authorization: "Bearer " + process.env.VOZEB_PRO_WORKER_TOKEN, "content-type": "application/json" },
                    body: JSON.stringify(completion),
                }),
                { params: Promise.resolve({ id: child.id }) },
            );
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ msg: "普通结果目标尺寸与等比缩放不符" });
            expect(await Promise.all([tasks.getStoredGenerationTaskRecord("image", image.id), tasks.getStoredGenerationTaskRecord("image_processing", child.id)])).toStrictEqual(before);
        },
        30_000,
    );

    it("rejects an old persistence epoch after a real new claim without reading the old result URL or changing its owner", async () => {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        const native = await solid(12, 8, "#abcdef");
        let downloads = 0;
        const provider = createServer((_request, response) => {
            downloads++;
            response.writeHead(200, { "content-type": "image/png" });
            response.end(native);
        });
        try {
            await new Promise<void>((resolve, reject) => {
                provider.once("error", reject);
                provider.listen(0, "127.0.0.1", () => {
                    provider.off("error", reject);
                    resolve();
                });
            });
            const address = provider.address();
            assert.ok(address !== null && typeof address !== "string");
            const origin = `http://127.0.0.1:${address.port}`;
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Original persistence epoch" });
            const image = await createImage({ kind: "generation", conversationId: conversation.id, config: { ...config, size: "6x4" }, references: [] });
            assert.ok(await imageTasks.transitionImageTask(image, ["pending"], { status: "running" }));
            assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "result_ready", nextPollAt: 1, resultPayload: { url: `${origin}/old-result.png` } }));
            const first = await scheduler.claimDueGenerationTasks({ workerId: "fixture-persist-owner-A", taskIds: [image.id], limit: 1 });
            expect(first).toHaveLength(1);
            const old = await imageTasks.getImageTask(image.id);
            assert.ok(old && typeof old.executionId === "string");
            assert.ok(await scheduler.releaseGenerationTaskLease("image", image.id, "fixture-persist-owner-A", { executionPhase: "result_ready", nextPollAt: 1 }, { executionId: old.executionId }));
            const next = await scheduler.claimDueGenerationTasks({ workerId: "fixture-persist-owner-B", taskIds: [image.id], limit: 1 });
            expect(next).toHaveLength(1);
            const current = await tasks.getStoredGenerationTaskRecord("image", image.id);
            assert.ok(current);
            expect(current).toMatchObject({ workerId: "fixture-persist-owner-B", status: "running", payload: { id: image.id } });
            expect(current.payload.executionId).not.toBe(old.executionId);
            const before = await readFile(path.join(directory, tasks.GENERATION_TASK_FILE));
            await expect(runtime.persistImageTaskResult(old, origin, `${origin}/old-result.png`, "", userId)).rejects.toThrow("Image result processing requires its current generation claim");
            expect(downloads).toBe(0);
            expect(await tasks.getStoredGenerationTaskRecord("image", image.id)).toStrictEqual(current);
            expect(await readFile(path.join(directory, tasks.GENERATION_TASK_FILE))).toEqual(before);
        } finally {
            provider.closeAllConnections();
            if (provider.listening) await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
        }
    }, 30_000);

    it.each(["mask", "resultProcessing"] as const)(
        "rejects a parent %s replacement while the same child lease remains valid",
        async (replacement) => {
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Parent mask input fence" });
            const source = await solid(4, 4, "#123456");
            const registered = await registeredReference(conversation.id, source);
            const buildDirectory = await mkdtemp(path.join(directory, "parent-mask-build-"));
            const built = await operations.executeImageProcessing(
                {
                    version: "image-processing.v1",
                    jobId: "fixture-parent-mask-build",
                    executionId: "fixture-parent-mask-build-execution",
                    operation: "build_protection",
                    inputs: [{ path: registered.path, assetId: registered.reference.id, assetVersion: "fixture-parent-mask-source", expectedSha256: digest(source) }],
                    outputDirectory: buildDirectory,
                    options: { mode: "scene_selection", region: { x: 1, y: 1, width: 2, height: 2 }, semantics: ["replace the selected prop"], selectionSource: "user_selection" },
                },
                () => {},
            );
            const protection = built.geometry.sceneProtection;
            assert.ok(protection);
            const maskBytes = await readFile(built.artifacts[0].path);
            const mask = { id: "fixture-parent-mask", type: "image/png", dataUrl: dataUrl(maskBytes) };
            const image = await createImage({ kind: "edit", conversationId: conversation.id, config, references: [registered.reference], mask, sceneProtection: { ...protection, mask } });
            assert.ok(await imageTasks.transitionImageTask(image, ["pending"], { status: "running" }));
            assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: 1 }));
            const imageClaims = await scheduler.claimDueGenerationTasks({ workerId: "fixture-parent-mask-image-worker", taskIds: [image.id], limit: 1 });
            const imageClaim = imageClaims[0];
            assert.ok(imageClaim && typeof imageClaim.payload.executionId === "string");
            const identity = { taskId: image.id, workerId: "fixture-parent-mask-image-worker", executionId: imageClaim.payload.executionId };
            expect(await capture.captureImageTaskNativeResults({ ...identity, attemptNo: 1, upstreamTaskId: null, result: { dataUrl: dataUrl(await solid(4, 4, "#abcdef")) }, origin: "https://fixture.invalid", authContext: "" })).toMatchObject({
                state: "native_ready",
            });
            expect(await processing.ensureImageTaskResultProcessing(identity)).toStrictEqual({ state: "waiting" });
            const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
            const resource = imageProcessingResourceConfig(process.env);
            const claimed = await service.claimImageProcessingTasks({ workerId: "fixture-parent-mask-child-worker", profileVersion: resource.profileVersion, availableMemoryBytes: resource.budgetBytes, slots: 1 });
            const child = claimed.tasks[0];
            assert.ok(child && child.payload.operation === "process_result" && child.payload.options.mode === "scene_protection");
            const maskInput = child.payload.inputs[child.payload.options.maskInputIndex];
            expect(child.payload.parentMask).toStrictEqual({ inputIndex: child.payload.options.maskInputIndex, imageTaskId: image.id });
            expect(child.payload.resource.facts.decodedInputs).toStrictEqual([]);
            const inputRoute = await import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route");
            const request = () =>
                new Request(`http://fixture.invalid/api/maintenance/image-processing/${child.id}/inputs/${maskInput.assetId}`, {
                    headers: { authorization: "Bearer " + process.env.VOZEB_PRO_WORKER_TOKEN, "x-vozeb-pro-worker-id": "fixture-parent-mask-child-worker", "x-vozeb-pro-execution-id": child.executionId },
                });
            const context = { params: Promise.resolve({ id: child.id, assetId: maskInput.assetId }) };
            const valid = await inputRoute.GET(request(), context);
            expect(valid.status).toBe(200);
            expect(Buffer.from(await valid.arrayBuffer())).toEqual(maskBytes);
            const changedMask = { ...mask, dataUrl: dataUrl(await solid(4, 4, "#ffffff")) };
            const patches: Record<"mask" | "resultProcessing", Partial<ImageTask>> = {
                mask: { mask: changedMask, sceneProtection: { ...protection, mask: changedMask } },
                resultProcessing: { resultProcessing: { jobId: "fixture-replaced-job", inputDigest: "fixture-replaced-digest" } },
            };
            await imageTasks.updateImageTask(image.id, patches[replacement]);
            const before = await Promise.all([tasks.getStoredGenerationTaskRecord("image", image.id), tasks.getStoredGenerationTaskRecord("image_processing", child.id)]);
            expect(before[1]).toMatchObject({ status: "running", workerId: "fixture-parent-mask-child-worker", leaseUntil: expect.any(Number), payload: { executionId: child.executionId } });
            expect((await inputRoute.GET(request(), context)).status).toBe(409);
            expect(await Promise.all([tasks.getStoredGenerationTaskRecord("image", image.id), tasks.getStoredGenerationTaskRecord("image_processing", child.id)])).toStrictEqual(before);
        },
        30_000,
    );

    it("routes a direct provider response through the real runtime claim and Worker without publishing its raw result", async () => {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        const native = await sharp(await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
            .composite([{ input: await solid(2, 2, "#ef4444"), left: 1, top: 1 }])
            .png()
            .toBuffer();
        const fixtureFailure = Promise.withResolvers<never>();
        let providerRequests = 0;
        const provider = createServer((request, response) => {
            void (async () => {
                expect(request.method).toBe("POST");
                expect(request.url).toBe("/v1/images/generations");
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toMatchObject({ model: config.model });
                providerRequests++;
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ created: 1, data: [{ b64_json: native.toString("base64") }] }));
            })().catch((error: unknown) => {
                fixtureFailure.reject(error);
                if (!response.headersSent) response.writeHead(500);
                response.end();
            });
        });
        try {
            await new Promise<void>((resolve, reject) => {
                provider.once("error", reject);
                provider.listen(0, "127.0.0.1", () => {
                    provider.off("error", reject);
                    resolve();
                });
            });
            const address = provider.address();
            assert.ok(address !== null && typeof address !== "string");
            const origin = `http://127.0.0.1:${address.port}`;
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Real provider result routing" });
            const image = await createImage({ kind: "generation", conversationId: conversation.id, config: { ...config, baseUrl: origin, apiSource: "custom", outputBackground: "transparent" }, references: [] });
            assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: 1 }));
            const claimed = await scheduler.claimDueGenerationTasks({ workerId: "fixture-provider-result-worker", taskIds: [image.id], limit: 1 });
            expect(claimed).toHaveLength(1);
            const owned = await imageTasks.getImageTask(image.id);
            assert.ok(owned && typeof owned.executionId === "string");
            expect(await Promise.race([runtime.createImageTaskUpstreamStep(owned, origin, origin, "", userId), fixtureFailure.promise])).toMatchObject({ state: "result_ready", status: "native_ready" });
            const sealed = await imageTasks.getImageTask(image.id);
            assert.ok(sealed?.nativeResults);
            expect(sealed.result).toBeUndefined();
            expect(sealed.nativeResults.slots).toMatchObject([{ resultId: `${image.id}:1`, resultIndex: 1, status: "stored", sha256: digest(native) }]);
            expect(await processing.ensureImageTaskResultProcessing({ taskId: image.id, workerId: "fixture-provider-result-worker", executionId: owned.executionId })).toStrictEqual({ state: "waiting" });
            const waiting = await imageTasks.getImageTask(image.id);
            assert.ok(waiting?.resultProcessing);
            await processWithWorker(waiting.resultProcessing.jobId);
            expect(await recovery.runGenerationTaskRecoveryBatch({ origin, workerId: "fixture-provider-result-consumer", taskIds: [image.id], limit: 1 })).toMatchObject({ claimed: 1, completed: 1, failed: 0, deferred: 0 });
            const delivered = await imageTasks.getImageTask(image.id);
            expect(delivered).toMatchObject({ status: "success", result: { resultId: `${image.id}:1` } });
            expect(providerRequests).toBe(1);
        } finally {
            provider.closeAllConnections();
            if (provider.listening) await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
        }
    }, 90_000);

    it("S4 persists an unclaimed AVIF admission pause without losing the sealed native", async () => {
        const source = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#112233" } })
            .avif()
            .toBuffer();
        const native = await solid(2, 2, "#112233");
        const image = await createImage({
            kind: "edit",
            config: { ...config, outputMode: "layers" },
            references: [{ id: "fixture-inline-avif-source", name: "source.avif", type: "image/avif", dataUrl: `data:image/avif;base64,${source.toString("base64")}` }],
        });
        assert.ok(await imageTasks.transitionImageTask(image, ["pending"], { status: "running" }));
        assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: 1 }));
        const workerId = "fixture-inline-avif-owner";
        const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [image.id], limit: 1 });
        expect(claimed).toHaveLength(1);
        const lease = claimed[0];
        assert.ok(lease?.executionId);
        const identity = { taskId: image.id, workerId, executionId: lease.executionId };
        expect(await capture.captureImageTaskNativeResults({ ...identity, attemptNo: 1, upstreamTaskId: null, result: { dataUrl: dataUrl(native) }, origin: "https://fixture.invalid", authContext: "" })).toMatchObject({ state: "native_ready" });
        const before = await tasks.getStoredGenerationTaskRecord("image", image.id);
        assert.ok(before);

        const [admission] = await Promise.allSettled([processing.ensureImageTaskResultProcessing(identity)]);

        const frozen = (await registrations.listFileLocalMediaRegistrations()).filter((registration) => registration.ownerUserId === userId && registration.taskId === image.id && registration.source === "image-task-result-source");
        expect(frozen).toHaveLength(1);
        const registration = frozen[0];
        assert.ok(registration);
        expect(registration).toMatchObject({ ownerUserId: userId, taskId: image.id, scope: "reference", storageClass: "permanent", type: "image", mimeType: "image/avif", bytes: source.length });
        expect(registration.expiresAt).toBeUndefined();
        const stored = await references.readReferenceAsset(registration.storageKey);
        assert.ok(stored);
        const bytes = await readFile(stored.filePath);
        expect(bytes).toEqual(source);
        expect(digest(bytes)).toBe(digest(source));
        const stages = await tasks.queryStoredGenerationTasks("image_processing", { userId });
        expect(stages, "RED: unavailable admission must commit its paused stage instead of leaving only the native").toHaveLength(1);
        const paused = await imageTasks.getImageTask(image.id);
        assert.ok(paused?.nativeResults && paused.resultProcessing);
        const stage = await tasks.getStoredGenerationTaskRecord("image_processing", paused.resultProcessing.jobId);
        assert.ok(stage);
        expect(admission).toStrictEqual({ status: "fulfilled", value: { state: "waiting" } });
        expect(stage).toMatchObject({
            id: paused.resultProcessing.jobId,
            parentTaskId: image.id,
            status: "paused",
            executionPhase: "needs_review",
            payload: { operation: "process_result", inputDigest: paused.resultProcessing.inputDigest, resource: { unavailable: { code: "image_processing_resource_unavailable", reason: "profile_uncalibrated" } } },
        });
        expect(stage.id).toBe(`image-process-${paused.resultProcessing.inputDigest}`);
        expect(stage.runId).toBeUndefined();
        expect(stage.payload.executionId).toBeUndefined();
        expect(stage.workerId).toBeUndefined();
        expect(stage.leaseUntil).toBeUndefined();
        expect(stage.nextPollAt).toBeUndefined();
        const pausedImage = await tasks.getStoredGenerationTaskRecord("image", image.id);
        expect(pausedImage).toMatchObject({ status: "running", executionPhase: "needs_review", payload: { nativeResults: before.payload.nativeResults, resultProcessing: paused.resultProcessing }, resultPayload: { reviewReason: expect.any(String) } });
        expect(pausedImage?.payload.executionId).toBeUndefined();
        expect(pausedImage?.workerId).toBeUndefined();
        expect(pausedImage?.leaseUntil).toBeUndefined();
        expect(pausedImage?.nextPollAt).toBeUndefined();
        expect(paused.runId).toBeUndefined();
        expect(paused.result).toBeUndefined();
        const nativeSlot = paused.nativeResults.slots[0];
        assert.ok(nativeSlot.status === "stored");
        const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
        expect(await readFile(path.join(REFERENCE_MEDIA_ROOT, nativeSlot.storageKey))).toEqual(native);
        expect(await tasks.queryStoredGenerationTasks("agent", { userId })).toStrictEqual([]);
        const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
        const originalResource = imageProcessingResourceConfig(process.env);
        expect(await service.claimImageProcessingTasks({ workerId: "fixture-avif-admission", profileVersion: originalResource.profileVersion, availableMemoryBytes: originalResource.budgetBytes, slots: 1 })).toStrictEqual({ tasks: [] });

        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "7168");
        await expect(service.checkImageProcessingTaskForImage({ userId, taskId: image.id })).rejects.toMatchObject({ status: 409 });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", stage.id)).toMatchObject({ id: stage.id, status: "paused", executionPhase: "needs_review", payload: { resource: { unavailable: { reason: "profile_uncalibrated" } } } });
        expect(await imageTasks.getImageTask(image.id)).toMatchObject({ id: image.id, status: "running", nativeResults: paused.nativeResults, resultProcessing: paused.resultProcessing });
        const adjustedResource = imageProcessingResourceConfig(process.env);
        expect(await service.claimImageProcessingTasks({ workerId: "fixture-avif-larger-budget", profileVersion: adjustedResource.profileVersion, availableMemoryBytes: adjustedResource.budgetBytes, slots: 1 })).toStrictEqual({ tasks: [] });
    });

    it("seals both native slots from a real non-Run 4k layers POST before publishing a result", async () => {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        const background = await solid(4, 4, "#112233");
        const element = await sharp(await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
            .composite([{ input: await solid(2, 2, "#ef4444"), left: 1, top: 1 }])
            .png()
            .toBuffer();
        const source = await sharp(background)
            .composite([{ input: element }])
            .png()
            .toBuffer();
        const reference = { id: "fixture-post-4k-layer-source", name: "source.png", type: "image/png", dataUrl: dataUrl(source) };
        const [postRoute, systemRoute] = await Promise.all([import("@/app/api/image-tasks/route"), import("@/app/api/ai/system/[channelId]/[...path]/route")]);
        const session = await auth.createSession(userId);
        const cookie = "vozeb_pro_session=" + session;
        const fixtureFailure = Promise.withResolvers<never>();
        async function startWebPixelWindow() {
            const webSharp = (await import("sharp")).default;
            const pixelSpies = {
                raw: vi.spyOn(webSharp.prototype, "raw"),
                stats: vi.spyOn(webSharp.prototype, "stats"),
                resize: vi.spyOn(webSharp.prototype, "resize"),
                toBuffer: vi.spyOn(webSharp.prototype, "toBuffer"),
                toFile: vi.spyOn(webSharp.prototype, "toFile"),
            };
            return () => {
                const observed = {
                    pid: process.pid,
                    raw: pixelSpies.raw.mock.calls.length,
                    stats: pixelSpies.stats.mock.calls.length,
                    resize: pixelSpies.resize.mock.calls.length,
                    toBuffer: pixelSpies.toBuffer.mock.calls.length,
                    toFile: pixelSpies.toFile.mock.calls.length,
                };
                pixelSpies.raw.mockRestore();
                pixelSpies.stats.mockRestore();
                pixelSpies.resize.mockRestore();
                pixelSpies.toBuffer.mockRestore();
                pixelSpies.toFile.mockRestore();
                return observed;
            };
        }
        let stopWebPixels: Awaited<ReturnType<typeof startWebPixelWindow>> | undefined;
        let origin: string;
        let postRequests = 0;
        let proxyRequests = 0;
        let providerRequests = 0;
        const server = createServer((incoming, outgoing) => {
            void (async () => {
                const url = new URL(incoming.url || "/", origin);
                const chunks: Buffer[] = [];
                for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
                const bytes = Buffer.concat(chunks);
                const headers = new Headers();
                for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
                const request = new Request(url, { method: incoming.method, headers, ...(bytes.length ? { body: bytes } : {}) });
                let response: Response;
                if (incoming.method === "POST" && url.pathname === "/v1/images/edits") {
                    expect(headers.get("authorization"), "SETUP: actual system proxy forwards the fixture channel credential").toBe("Bearer fixture-only");
                    const form = await request.formData();
                    expect(form.get("model")).toBe("gpt-image-2.5-flare");
                    expect(form.get("quality"), "SETUP: existing 4k quality normalization remains high").toBe("high");
                    expect(form.get("size"), "SETUP: existing high square request remains 2880x2880").toBe("2880x2880");
                    expect(form.has("n"), "SETUP: layers preserve the provider's variable result count").toBe(false);
                    expect(form.getAll("image")).toHaveLength(1);
                    const image = form.get("image");
                    assert.ok(image instanceof Blob);
                    expect(Buffer.from(await image.arrayBuffer()), "SETUP: the provider receives the exact original source bytes").toEqual(source);
                    providerRequests++;
                    response = new Response(JSON.stringify({ created: 1, data: [{ b64_json: element.toString("base64") }, { b64_json: background.toString("base64") }] }), { headers: { "content-type": "application/json" } });
                } else if (incoming.method === "POST" && url.pathname === "/api/image-tasks") {
                    expect(headers.get("cookie")).toBe(cookie);
                    postRequests++;
                    response = await postRoute.POST(request);
                } else {
                    const channel = url.pathname.match(/^\/api\/ai\/system\/([^/]+)\/(.+)$/);
                    assert.ok(incoming.method === "POST" && channel, "SETUP: only the actual image POST, system proxy and provider routes are available");
                    expect(headers.get("cookie")).toBe(cookie);
                    expect(channel[1]).toBe("fixture-post-layers");
                    proxyRequests++;
                    response = await systemRoute.POST(request, { params: Promise.resolve({ channelId: channel[1], path: channel[2].split("/") }) });
                }
                outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                outgoing.end(Buffer.from(await response.arrayBuffer()));
            })().catch((error: unknown) => {
                fixtureFailure.reject(error);
                if (!outgoing.headersSent) outgoing.writeHead(500);
                outgoing.end();
            });
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                });
            });
            const address = server.address();
            assert.ok(address !== null && typeof address !== "string");
            origin = `http://127.0.0.1:${address.port}`;
            vi.stubEnv("VOZEB_PRO_INTERNAL_ORIGIN", origin);
            nextContext.cookie = session;
            await auth.setAuthSettings({
                systemChannels: [
                    {
                        id: "fixture-post-layers",
                        name: "Isolated layers provider",
                        enabled: true,
                        baseUrl: `${origin}/v1`,
                        apiKey: "fixture-only",
                        apiFormat: "openai",
                        models: ["gpt-image-2.5-flare"],
                        advancedConfig: {
                            protocol: "openai",
                            textModel: "",
                            imageModel: "",
                            videoModel: "",
                            createPath: "/images/generations",
                            editPath: "/images/edits",
                            queryPath: "",
                            requestTemplate: "",
                            resultField: "",
                            statusField: "",
                            durationRange: "",
                            referenceRule: "",
                            supportsReferenceImage: true,
                            supportsReferenceVideo: false,
                            supportsReferenceAudio: false,
                        },
                    },
                ],
                logicalModels: [
                    {
                        id: "fixture-post-layers-image",
                        name: "Isolated layers image",
                        capability: "image",
                        enabled: true,
                        bindings: [{ id: "fixture-post-layers-binding", channelId: "fixture-post-layers", upstreamModel: "gpt-image-2.5-flare", enabled: true, priority: 1 }],
                    },
                ],
                defaultModels: { textModel: "", imageModel: "fixture-post-layers-image", videoModel: "", audioModel: "" },
                modelPointCosts: { "fixture-post-layers-image": 2 },
            });
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Real POST 4k layers native gate" });
            stopWebPixels = await startWebPixelWindow();
            const response = await Promise.race([
                fetch(origin + "/api/image-tasks", {
                    method: "POST",
                    headers: { "content-type": "application/json", cookie },
                    body: JSON.stringify({
                        kind: "edit",
                        source: "image-workbench",
                        prompt: "Separate the original element and its clean background into independent layers.",
                        config: { model: "fixture-post-layers-image", quality: "4k", size: "1:1", outputMode: "layers", outputBackground: "opaque" },
                        references: [reference],
                        context: { conversationId: conversation.id, surface: "chat" },
                    }),
                }),
                fixtureFailure.promise,
            ]);
            const postPixels = stopWebPixels();
            stopWebPixels = undefined;
            expect(response.status, "SETUP: actual authenticated POST accepts the non-Run layers request").toBe(200);
            const body: { task?: { id: string } } = await response.json();
            assert.ok(body.task);
            const image = await imageTasks.getImageTask(body.task.id);
            assert.ok(image);
            expect(image).toMatchObject({
                userId,
                conversationId: conversation.id,
                kind: "edit",
                config: { apiSource: "system", baseUrl: "/api/ai/system/fixture-post-layers", logicalModel: "fixture-post-layers-image", model: "gpt-image-2.5-flare", quality: "4k", size: "1:1", outputMode: "layers" },
                references: [reference],
                enhancementPolicy: { enabled: false, connection: null },
            });
            expect({
                runId: image.runId,
                ecommerceExecution: image.ecommerceExecution,
                canvas: image.ecommerceCanvasRequest,
                mask: image.mask,
                sceneProtection: image.sceneProtection,
                productProtection: image.productProtection,
                enhancementDelivery: image.enhancementDelivery,
            }).toStrictEqual({
                runId: undefined,
                ecommerceExecution: undefined,
                canvas: undefined,
                mask: undefined,
                sceneProtection: undefined,
                productProtection: undefined,
                enhancementDelivery: undefined,
            });
            expect(image.result).toBeUndefined();
            expect(image.nativeResults).toBeUndefined();
            stopWebPixels = await startWebPixelWindow();
            expect(await scheduler.claimDueGenerationTasks({ workerId: "fixture-post-4k-layer-worker", taskIds: [image.id], limit: 1 })).toHaveLength(1);
            const owned = await imageTasks.getImageTask(image.id);
            assert.ok(owned);
            const step = await Promise.race([runtime.createImageTaskUpstreamStep(owned, origin, origin, cookie, userId), fixtureFailure.promise]);
            const createPixels = stopWebPixels();
            stopWebPixels = undefined;
            expect(step, "SETUP: the original claimed ImageTask receives its actual provider response").toMatchObject({ state: "result_ready" });
            const ready = await imageTasks.getImageTask(image.id);
            assert.ok(ready);
            expect({ postRequests, proxyRequests, providerRequests }).toStrictEqual({ postRequests: 1, proxyRequests: 1, providerRequests: 1 });
            expect(ready).toMatchObject({ id: image.id, userId, config: image.config, references: image.references, enhancementPolicy: image.enhancementPolicy });
            assert.ok(ready.billing?.pointsRecordId);
            const debits = await auth.listPointRecordsPage(userId, { direction: "debit", pageSize: 50 });
            expect(debits.total).toBe(1);
            expect(debits.records).toMatchObject([{ id: ready.billing.pointsRecordId, userId, type: "consume", model: "fixture-post-layers-image" }]);

            expect(ready.nativeResults, "RED: the same non-Run 4k layers ImageTask must seal both provider natives before result publication").toMatchObject({
                version: "image-task-native-results.v1",
                attemptNo: ready.attemptNo,
                slots: [
                    { resultId: `${image.id}:1`, resultIndex: 1, status: "stored", scope: "reference", storageProvider: "local", assetVersion: digest(element), sha256: digest(element), bytes: element.length },
                    { resultId: `${image.id}:2`, resultIndex: 2, status: "stored", scope: "reference", storageProvider: "local", assetVersion: digest(background), sha256: digest(background), bytes: background.length },
                ],
            });
            expect(ready.result, "RED: sealed native slots must precede a published result on the original ImageTask").toBeUndefined();
            assert.ok(ready.nativeResults && step.state === "result_ready");
            const sealedNative = ready.nativeResults;
            const pointRecords = await auth.listPointRecordsPage(userId, { pageSize: 50 });
            expect(debits.records).toMatchObject([{ id: ready.billing.pointsRecordId, amount: -2 }]);
            expect(ready.billing).toMatchObject({ pointsCost: 2, refunded: false });
            stopWebPixels = await startWebPixelWindow();
            const waiting = await runtime.persistImageTaskResult(ready, origin, step.resultUrl, cookie, userId);
            const persistPixels = stopWebPixels();
            stopWebPixels = undefined;
            expect(waiting).toMatchObject({ status: "running", nativeResults: sealedNative, resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
            assert.ok(waiting?.resultProcessing);
            expect(waiting.result).toBeUndefined();

            const worker = await processWithWorker(waiting.resultProcessing.jobId);
            const payload = worker.child.payload;
            assert.ok(payload.operation === "process_result" && payload.options.mode === "layers");
            expect(payload.options).toStrictEqual({
                mode: "layers",
                results: [
                    { resultId: `${image.id}:1`, resultIndex: 1, inputIndex: 0 },
                    { resultId: `${image.id}:2`, resultIndex: 2, inputIndex: 1 },
                ],
                sourceInputIndex: 2,
            });
            expect(payload.inputs).toHaveLength(3);
            expect(payload.inputs[2]).toMatchObject({ assetId: reference.id, expectedSha256: digest(source) });
            expect(payload.resource.facts.decodedInputs).toStrictEqual([]);
            expect(payload.sources).toHaveLength(3);
            expect(payload.sources[2]).toMatchObject({ inputIndex: 2, scope: "reference", storageProvider: "local", frozenResultSource: true });
            const sourceRegistration = await registrations.getLocalMediaRegistration(payload.sources[2].storageKey);
            expect(sourceRegistration).toMatchObject({ ownerUserId: userId, conversationId: conversation.id, taskId: image.id, scope: "reference", storageClass: "permanent", source: "image-task-result-source" });
            expect(sourceRegistration?.expiresAt).toBeUndefined();
            expect(await registeredMediaBytes(payload.sources[2].storageKey)).toEqual(source);
            const manifest = worker.completion.manifest;
            expect(manifest.sourceIdentities[2]).toMatchObject({ assetId: reference.id, sha256: digest(source), bytes: source.length, width: 4, height: 4 });
            expect(manifest.sourceIdentities[2]).not.toHaveProperty("nativeImage");
            expect(manifest.results).toMatchObject([
                { resultId: `${image.id}:1`, resultIndex: 1, nativeInputIndex: 0, finalArtifactIndex: 0 },
                { resultId: `${image.id}:2`, resultIndex: 2, nativeInputIndex: 1, finalArtifactIndex: 1 },
            ]);
            expect(manifest.artifacts).toMatchObject([{ layerKind: "element" }, { layerKind: "background" }]);
            expect(worker.uploads.map((upload) => upload.bytes)).toStrictEqual([element, background]);
            expect(worker.uploads.map((upload) => ({ resultId: upload.stored.resultId, resultIndex: upload.stored.resultIndex, width: upload.stored.width, height: upload.stored.height, sha256: upload.stored.sha256 }))).toStrictEqual([
                { resultId: `${image.id}:1`, resultIndex: 1, width: 4, height: 4, sha256: digest(element) },
                { resultId: `${image.id}:2`, resultIndex: 2, width: 4, height: 4, sha256: digest(background) },
            ]);
            expect(worker.completion.metrics.pid).not.toBe(process.pid);
            const recoveryInput = { origin, cookie, workerId: "fixture-post-4k-layer-consumer", taskIds: [image.id], limit: 1 };
            stopWebPixels = await startWebPixelWindow();
            expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 1, pending: 0, resultReady: 0, completed: 1, failed: 0, needsReview: 0, deferred: 0 });
            const consumePixels = stopWebPixels();
            stopWebPixels = undefined;
            const delivered = await imageTasks.getImageTask(image.id);
            assert.ok(delivered?.result?.results);
            expect(delivered).toMatchObject({
                id: image.id,
                userId,
                status: "success",
                config: image.config,
                references: image.references,
                nativeResults: sealedNative,
                resultProcessing: waiting.resultProcessing,
                billing: ready.billing,
                enhancementPolicy: image.enhancementPolicy,
            });
            expect(delivered.attempts?.map((attempt) => ({ attemptNo: attempt.attemptNo, status: attempt.status }))).toStrictEqual([{ attemptNo: ready.attemptNo, status: "succeeded" }]);
            expect(delivered.result.results).toMatchObject([
                { resultId: `${image.id}:1`, width: 4, height: 4, bytes: element.length, mimeType: "image/png", enhancementSkip: { status: "skipped", reason: "disabled" } },
                { resultId: `${image.id}:2`, width: 4, height: 4, bytes: background.length, mimeType: "image/png", enhancementSkip: { status: "skipped", reason: "disabled" } },
            ]);
            expect(delivered.result.enhancementSkip).toStrictEqual({ status: "skipped", reason: "disabled" });
            expect(delivered.result.enhancementId).toBeUndefined();
            expect(delivered.result.nativeSource).toBeUndefined();
            expect(delivered.result.results.map((result) => ({ enhancementId: result.enhancementId, nativeSource: result.nativeSource }))).toStrictEqual([
                { enhancementId: undefined, nativeSource: undefined },
                { enhancementId: undefined, nativeSource: undefined },
            ]);
            expect(delivered.result.results.map((result) => result.serverUrl)).toStrictEqual(worker.uploads.map((upload) => `/api/reference-assets/${upload.stored.storageKey.split("/").map(encodeURIComponent).join("/")}`));
            const saved = await Promise.all(
                worker.uploads.map(async (upload) => {
                    expect(await registrations.getLocalMediaRegistration(upload.stored.storageKey)).toMatchObject({ ownerUserId: userId, storageClass: "permanent" });
                    return registeredMediaBytes(upload.stored.storageKey);
                }),
            );
            expect(saved).toStrictEqual([element, background]);
            const taskLogs = (await logs.listGenerationLogs({ userId })).items.filter((item) => item.taskId === image.id);
            expect(taskLogs).toHaveLength(1);
            expect(taskLogs[0]).toMatchObject({ taskId: image.id, status: "success", count: 2, successCount: 2 });
            expect(taskLogs[0].assets).toMatchObject([
                { resultId: `${image.id}:1`, width: 4, height: 4, enhancementSkip: { status: "skipped", reason: "disabled" } },
                { resultId: `${image.id}:2`, width: 4, height: 4, enhancementSkip: { status: "skipped", reason: "disabled" } },
            ]);
            const assets = (await creative.listAssetsForUser(userId, conversation.id)).filter((asset) => asset.sourceTaskId === image.id).sort((left, right) => left.ordinal - right.ordinal);
            expect(assets).toMatchObject([
                { sourceTaskId: image.id, ordinal: 0, status: "ready", width: 4, height: 4 },
                { sourceTaskId: image.id, ordinal: 1, status: "ready", width: 4, height: 4 },
            ]);
            expect(assets.map((asset) => asset.serverUrl)).toStrictEqual(delivered.result.results.map((result) => result.serverUrl));
            expect(await auth.listPointRecordsPage(userId, { pageSize: 50 })).toStrictEqual(pointRecords);
            const [enhancement, jobs] = await Promise.all([import("./image-enhancement-enqueue"), import("./database/image-enhancement-job-repository")]);
            expect(await jobs.listEnhancementJobsForTask(image.id, userId)).toStrictEqual([]);
            const settledChild = await tasks.getStoredGenerationTaskRecord("image_processing", worker.child.id);
            const registeredKeys = [...payload.sources.map((input) => input.storageKey), ...manifest.artifacts.map((artifact) => artifact.storageKey)];
            const registrationsBeforeReplay = await Promise.all(registeredKeys.map((key) => registrations.getLocalMediaRegistration(key)));

            stopWebPixels = await startWebPixelWindow();
            expect(await runtime.persistImageTaskResult(delivered, origin, step.resultUrl, cookie, userId)).toStrictEqual(delivered);
            expect(await service.completeImageProcessingTask(worker.child.id, worker.completion)).toStrictEqual(worker.receipt);
            expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toStrictEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
            await enhancement.enqueueImageEnhancement(delivered);
            const replayPixels = stopWebPixels();
            stopWebPixels = undefined;
            expect(await imageTasks.getImageTask(image.id)).toStrictEqual(delivered);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", worker.child.id)).toStrictEqual(settledChild);
            expect(await Promise.all(registeredKeys.map((key) => registrations.getLocalMediaRegistration(key)))).toStrictEqual(registrationsBeforeReplay);
            expect((await logs.listGenerationLogs({ userId })).items.filter((item) => item.taskId === image.id)).toStrictEqual(taskLogs);
            expect((await creative.listAssetsForUser(userId, conversation.id)).filter((asset) => asset.sourceTaskId === image.id).sort((left, right) => left.ordinal - right.ordinal)).toStrictEqual(assets);
            expect(await auth.listPointRecordsPage(userId, { pageSize: 50 })).toStrictEqual(pointRecords);
            expect(await jobs.listEnhancementJobsForTask(image.id, userId)).toStrictEqual([]);
            expect({ postRequests, proxyRequests, providerRequests }).toStrictEqual({ postRequests: 1, proxyRequests: 1, providerRequests: 1 });
            const noWebPixels = { pid: process.pid, raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 };
            expect({ post: postPixels, create: createPixels, persist: persistPixels, consume: consumePixels, replay: replayPixels }).toStrictEqual({
                post: noWebPixels,
                create: noWebPixels,
                persist: noWebPixels,
                consume: noWebPixels,
                replay: noWebPixels,
            });
        } finally {
            stopWebPixels?.();
            nextContext.cookie = "";
            server.closeAllConnections();
            if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    }, 30_000);

    it("delivers a real provider layer response with its legal inline source reference", async () => {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        const background = await solid(4, 4, "#112233");
        const element = await sharp(await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
            .composite([{ input: await solid(2, 2, "#ef4444"), left: 1, top: 1 }])
            .png()
            .toBuffer();
        const source = await sharp(background)
            .composite([{ input: element }])
            .png()
            .toBuffer();
        let providerRequests = 0;
        const fixtureFailure = Promise.withResolvers<never>();
        const provider = createServer((request, response) => {
            void (async () => {
                expect(request.method).toBe("POST");
                expect(request.url).toBe("/v1/images/edits");
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                expect(Buffer.concat(chunks).includes(source)).toBe(true);
                providerRequests++;
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ created: 1, data: [{ b64_json: element.toString("base64") }, { b64_json: background.toString("base64") }] }));
            })().catch((error: unknown) => {
                fixtureFailure.reject(error);
                if (!response.headersSent) response.writeHead(500);
                response.end();
            });
        });
        try {
            await new Promise<void>((resolve, reject) => {
                provider.once("error", reject);
                provider.listen(0, "127.0.0.1", () => {
                    provider.off("error", reject);
                    resolve();
                });
            });
            const address = provider.address();
            assert.ok(address !== null && typeof address !== "string");
            const origin = `http://127.0.0.1:${address.port}`;
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Inline source layers" });
            const image = await createImage({
                kind: "edit",
                conversationId: conversation.id,
                config: { ...config, baseUrl: origin, apiSource: "custom", outputMode: "layers" },
                references: [{ id: "fixture-inline-layer-source", name: "source.png", type: "image/png", dataUrl: dataUrl(source) }],
            });
            assert.ok(await scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: 1 }));
            expect(await scheduler.claimDueGenerationTasks({ workerId: "fixture-inline-layer-worker", taskIds: [image.id], limit: 1 })).toHaveLength(1);
            const owned = await imageTasks.getImageTask(image.id);
            assert.ok(owned);
            const step = await Promise.race([runtime.createImageTaskUpstreamStep(owned, origin, origin, "", userId), fixtureFailure.promise]);
            expect(step).toMatchObject({ state: "result_ready", status: "native_ready" });
            assert.ok(step.state === "result_ready");
            const ready = await imageTasks.getImageTask(image.id);
            assert.ok(ready);
            const pointRecords = await auth.listPointRecordsPage(userId, { pageSize: 50 });
            const waiting = await runtime.persistImageTaskResult(ready, origin, step.resultUrl, "", userId);
            expect(waiting).toMatchObject({ status: "running", resultProcessing: { jobId: expect.any(String), inputDigest: expect.any(String) } });
            assert.ok(waiting?.nativeResults && waiting.resultProcessing);
            expect(waiting.result).toBeUndefined();
            expect(waiting.nativeResults.slots).toMatchObject([
                { resultId: `${image.id}:1`, resultIndex: 1, status: "stored" },
                { resultId: `${image.id}:2`, resultIndex: 2, status: "stored" },
            ]);
            const worker = await processWithWorker(waiting.resultProcessing.jobId);
            const payload = worker.child.payload;
            assert.ok(payload.operation === "process_result" && payload.options.mode === "layers");
            expect(payload.inputs).toHaveLength(3);
            expect(payload.inputs[2]).toMatchObject({ assetId: "fixture-inline-layer-source", expectedSha256: digest(source) });
            expect(worker.completion.manifest.sourceIdentities[2]).toMatchObject({ assetId: "fixture-inline-layer-source", sha256: digest(source), width: 4, height: 4 });
            expect(worker.completion.manifest.sourceIdentities[2]).not.toHaveProperty("nativeImage");
            expect(worker.uploads.map((upload) => upload.bytes)).toStrictEqual([element, background]);
            const recoveryInput = { origin, workerId: "fixture-inline-layer-consumer", taskIds: [image.id], limit: 1 };
            expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toMatchObject({ claimed: 1, completed: 1, failed: 0, deferred: 0 });
            const delivered = await imageTasks.getImageTask(image.id);
            assert.ok(delivered?.result?.results);
            expect(delivered).toMatchObject({ status: "success", nativeResults: waiting.nativeResults, resultProcessing: waiting.resultProcessing });
            expect(delivered.result.results).toHaveLength(2);
            const saved = await Promise.all(
                worker.uploads.map(async (upload) => {
                    const stored = await references.readReferenceAsset(upload.stored.storageKey);
                    assert.ok(stored);
                    expect(await registrations.getLocalMediaRegistration(upload.stored.storageKey)).toMatchObject({ ownerUserId: userId, storageClass: "permanent" });
                    return readFile(stored.filePath);
                }),
            );
            expect(saved).toStrictEqual([element, background]);
            expect((await logs.listGenerationLogs({ userId })).items.filter((item) => item.taskId === image.id)).toHaveLength(1);
            expect((await creative.listAssetsForUser(userId, conversation.id)).filter((asset) => asset.sourceTaskId === image.id)).toHaveLength(2);
            expect(await auth.listPointRecordsPage(userId, { pageSize: 50 })).toStrictEqual(pointRecords);
            expect(await recovery.runGenerationTaskRecoveryBatch(recoveryInput)).toMatchObject({ claimed: 0, completed: 0, failed: 0, deferred: 0 });
            expect(await imageTasks.getImageTask(image.id)).toStrictEqual(delivered);
            expect(await service.completeImageProcessingTask(worker.child.id, worker.completion)).toStrictEqual(worker.receipt);
            expect(providerRequests).toBe(1);
        } finally {
            provider.closeAllConnections();
            if (provider.listening) await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
        }
    }, 30_000);

    it("consumes an ordinary non-Run 4k mask result through the Worker with its protected delivery unchanged", async () => {
        const settings = await import("./database/image-enhancement-repository");
        await settings.mutateImageEnhancementSettings((stored) => {
            stored.enabled = true;
        });
        const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Ordinary non-Run 4k mask result" });
        const source = await solid(8, 8, "#112233");
        const native = await solid(8, 8, "#abcdef");
        const maskBytes = await solid(8, 8, "#ffffff");
        const registered = await registeredReference(conversation.id, source);
        const mask = { id: "fixture-ordinary-4k-mask", name: "mask.png", type: "image/png", dataUrl: dataUrl(maskBytes) };
        const image = await createImage({ kind: "edit", conversationId: conversation.id, config: { ...config, quality: "4k", size: "1:1" }, references: [registered.reference], mask });
        expect(image.enhancementPolicy).toMatchObject({ enabled: true, connection: null });

        const outcome = await consume(image, [native], "ordinary", 0);

        expect(outcome.payload.options).not.toHaveProperty("targetSize");
        expect(outcome.finals).toHaveLength(1);
        expect(outcome.finals[0].bytes).toEqual(native);
        expect(outcome.result.artifacts).toMatchObject([{ sha256: digest(native), bytes: native.length, width: 8, height: 8, mimeType: "image/png" }]);
        expect(outcome.published).toMatchObject({ id: image.id, config: { quality: "4k", size: "1:1" }, enhancementPolicy: image.enhancementPolicy });
        expect(outcome.published.references).toStrictEqual(image.references);
        expect(outcome.published.mask).toStrictEqual(mask);
        expect(outcome.delivered).toMatchObject([
            { resultId: `${image.id}:1`, width: 8, height: 8, enhancementId: `enhancement:${image.id}:1`, enhancementSource: { url: outcome.delivered[0].serverUrl, sha256: digest(native), provenance: "generation_final" } },
        ]);
        expect(outcome.delivered[0]).not.toHaveProperty("enhancementSkip");
        const jobs = await import("./database/image-enhancement-job-repository");
        expect(await jobs.listEnhancementJobsForTask(image.id, userId)).toMatchObject([{ status: "skipped", reason: "provider_unavailable" }]);
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

    it("consumes a historical object auxiliary through the real Worker after new object writes are disabled", async () => {
        const [storageConfig, storageRepository, media] = await Promise.all([import("./object-storage-config"), import("./database/object-storage-repository"), import("./local-media-storage")]);
        const originalSettings = await storageRepository.readObjectStorageSettings();
        const fixture = await imageProcessingS3Fixture();
        try {
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Historical object layer source" });
            const background = await solid(4, 4, "#112233");
            const element = await sharp(await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
                .composite([{ input: await solid(2, 2, "#ef4444"), left: 1, top: 1 }])
                .png()
                .toBuffer();
            const source = await sharp(background)
                .composite([{ input: element }])
                .png()
                .toBuffer();
            await storageConfig.saveObjectStorageAdminSettings(fixture.config);
            const stored = await references.writePersistentMediaDataUrl(dataUrl(source), "image", { ownerUserId: userId, conversationId: conversation.id, source: "image-workbench" });
            const original = await registrations.getLocalMediaRegistration(stored.token);
            assert.ok(original?.externalObjectKey);
            expect(original).toMatchObject({ ownerUserId: userId, type: "image", storageClass: "permanent", storageProvider: "object", externalStorageId: "default", bytes: source.length });
            expect(fixture.requests).toContainEqual({ method: "PUT", key: original.externalObjectKey });
            await expect(stat(path.join(media.REFERENCE_MEDIA_ROOT, stored.token))).rejects.toMatchObject({ code: "ENOENT" });
            await storageConfig.saveObjectStorageAdminSettings({ ...fixture.config, enabled: false });
            expect((await storageConfig.getObjectStorageRuntimeConfig()).enabled).toBe(false);
            const serverUrl = `/api/reference-assets/${stored.token}`;
            const reference = { id: "fixture-object-layer-source", name: "source.png", type: "image/png", dataUrl: serverUrl, serverUrl };
            const image = await createImage({ kind: "edit", conversationId: conversation.id, config: { ...config, outputMode: "layers" }, references: [reference] });

            const outcome = await consume(image, [element, background], "layers", 1);

            expect(outcome.payload.sources[2]).toMatchObject({ inputIndex: 2, scope: "reference", storageKey: stored.token, storageProvider: "object", externalStorageId: "default" });
            expect(outcome.payload.inputs[2]).toMatchObject({ assetId: reference.id, expectedSha256: digest(source) });
            expect(outcome.result.sourceIdentities[2]).toMatchObject({ assetId: reference.id, sha256: digest(source), bytes: source.length, width: 4, height: 4 });
            expect(outcome.finals.map((final) => final.bytes)).toStrictEqual([element, background]);
            expect(outcome.published).toMatchObject({ status: "success", references: [reference] });
            expect(fixture.requests).toContainEqual({ method: "GET", key: original.externalObjectKey });
            expect(await registrations.getLocalMediaRegistration(stored.token)).toStrictEqual(original);
            await expect(stat(path.join(media.REFERENCE_MEDIA_ROOT, stored.token))).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            try {
                await fixture.close();
            } finally {
                await storageRepository.writeObjectStorageSettings(originalSettings);
                await storageConfig.getObjectStorageAdminSettings();
                expect(await storageRepository.readObjectStorageSettings()).toStrictEqual(originalSettings);
            }
        }
    }, 90_000);

    it("delivers object native, inline auxiliary and final layers after new object writes are disabled", async () => {
        const [storageConfig, storageRepository, media] = await Promise.all([import("./object-storage-config"), import("./database/object-storage-repository"), import("./local-media-storage")]);
        const originalSettings = await storageRepository.readObjectStorageSettings();
        const fixture = await imageProcessingS3Fixture();
        try {
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Object native and final layers" });
            const background = await solid(4, 4, "#112233");
            const element = await sharp(await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
                .composite([{ input: await solid(2, 2, "#ef4444"), left: 1, top: 1 }])
                .png()
                .toBuffer();
            const source = await sharp(background)
                .composite([{ input: element }])
                .png()
                .toBuffer();
            const reference = { id: "fixture-object-inline-layer-source", name: "source.png", type: "image/png", dataUrl: dataUrl(source) };
            await storageConfig.saveObjectStorageAdminSettings(fixture.config);
            expect((await storageConfig.getObjectStorageRuntimeConfig()).enabled).toBe(true);
            const image = await createImage({ kind: "edit", conversationId: conversation.id, config: { ...config, outputMode: "layers" }, references: [reference] });
            const writesBeforeDisable: typeof fixture.requests = [];
            let requestCountAtDisable = 0;

            const outcome = await consume(image, [element, background], "layers", 1, async () => {
                // The real Worker finishes with writes enabled; the original ImageTask consumes with writes disabled.
                writesBeforeDisable.push(...fixture.requests.filter((request) => request.method === "PUT"));
                expect(writesBeforeDisable).toHaveLength(5);
                await storageConfig.saveObjectStorageAdminSettings({ ...fixture.config, enabled: false });
                expect((await storageConfig.getObjectStorageRuntimeConfig()).enabled).toBe(false);
                requestCountAtDisable = fixture.requests.length;
            });

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
                await storageRepository.writeObjectStorageSettings(originalSettings);
                await storageConfig.getObjectStorageAdminSettings();
                expect(await storageRepository.readObjectStorageSettings()).toStrictEqual(originalSettings);
            }
        }
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

    it.each([
        { background: "#123456", outside: [18, 52, 86, 255], hasAlpha: false },
        { background: { r: 18, g: 52, b: 86, alpha: 0.5 }, outside: [18, 52, 86, 128], hasAlpha: true },
    ])(
        "consumes a protected scene with actual final transparency=$hasAlpha before full-image enhancement",
        async ({ background, outside, hasAlpha }) => {
            const conversation = await creative.createConversationForUser(userId, { surface: "chat", title: "Protected scene result" });
            const source = await solid(6, 4, background);
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
            expect([...pixels.subarray(0, 4)]).toStrictEqual(outside);
            expect([...pixels.subarray(32, 36)]).toStrictEqual([171, 205, 239, 255]);
            expect(outcome.bindings[1]).toMatchObject({ finalImage: { format: "png", hasAlpha } });
            expect(outcome.delivered[0].sceneProtectionEvidence).toMatchObject({
                sourceDigest: digest(source),
                maskDigest: digest(maskBytes),
                nativeDigest: digest(native),
                compositeDigest: digest(outcome.finals[0].bytes),
                compositeOutsideChangedPixels: 0,
            });
        },
        90_000,
    );

    it("consumes a qualified product final and durably queues full-image enhancement", async () => {
        const [deliveryService, enhancement, jobs, settings, secrets] = await Promise.all([
            import("./image-enhancement-delivery"),
            import("./image-enhancement-enqueue"),
            import("./database/image-enhancement-job-repository"),
            import("./database/image-enhancement-repository"),
            import("./secret-crypto"),
        ]);
        // Owned File fixture only: capture a legal policy; readiness and GPU execution are not under test.
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
        const input = { kind: "edit" as const, conversationId: conversation.id, config: { ...config, quality: "4k", size: "32x32" }, references: [registered.reference], mask, productProtection };
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
        expect(delivered.enhancementSource).toMatchObject({ url: delivered.serverUrl, sha256: digest(outcome.finals[0].bytes), format: "png", hasAlpha: false, provenance: "generation_final" });
        const decision = enhancement.planImageTaskEnhancement(outcome.published, delivered);
        expect(decision).not.toHaveProperty("delivery");
        expect(decision).toMatchObject({
            status: "queued",
            reason: null,
            source: delivered.enhancementSource,
            target: { width: 32, height: 32 },
            inference: { width: 32, height: 32 },
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
        await enhancement.enqueueImageEnhancement(outcome.published);
        expect(await jobs.listEnhancementJobsForTask(image.id, userId)).toStrictEqual(queued);
    }, 90_000);

    it("queues ordinary 4k enhancement from its real Worker final and preserves the original task", async () => {
        const [enhancement, jobs, settings, secrets] = await Promise.all([import("./image-enhancement-enqueue"), import("./database/image-enhancement-job-repository"), import("./database/image-enhancement-repository"), import("./secret-crypto")]);
        // Owned File fixture only: capture a legal policy; readiness and GPU execution are not under test.
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
    }, 90_000);

    describe("remote auxiliary freeze", () => {
        const testBudgetMs = 90_000;
        let closeFixture: (() => Promise<void>) | undefined;
        type FreezeIdentity = Parameters<typeof processing.ensureImageTaskResultProcessing>[0];
        type SourceRequest = { finish(): void };

        beforeEach(() => {
            closeFixture = undefined;
        });

        afterEach(async () => {
            await closeFixture?.();
        }, testBudgetMs);

        async function remoteOriginal(initial: Buffer) {
            let bytes = initial;
            let holding = true;
            let closed = false;
            let closePromise: Promise<void> | undefined;
            const closeError = new Error("REMOTE_SOURCE_CLOSED: fixture closed before the requested source gate arrived");
            const received: SourceRequest[] = [];
            const waiting = new Map<number, { resolve(request: SourceRequest): void; reject(error: Error): void }>();
            const server = createServer((request, response) => {
                if (request.method !== "GET" || request.url !== "/source.png") {
                    response.writeHead(404);
                    response.end();
                    return;
                }
                const original = bytes;
                response.writeHead(200, { "content-type": "image/png", "content-length": original.length });
                response.write(original.subarray(0, 8));
                const gate = { finish: () => response.end(original.subarray(8)) };
                const index = received.push(gate) - 1;
                waiting.get(index)?.resolve(gate);
                waiting.delete(index);
                if (!holding) gate.finish();
            });
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                });
            });
            const address = server.address();
            assert.ok(address !== null && typeof address !== "string");
            return {
                url: `http://127.0.0.1:${address.port}/source.png`,
                get downloads() {
                    return received.length;
                },
                request(index: number) {
                    if (closed) return Promise.reject(closeError);
                    const existing = received[index];
                    if (existing) return Promise.resolve(existing);
                    const pending = Promise.withResolvers<SourceRequest>();
                    waiting.set(index, pending);
                    return pending.promise;
                },
                replace(replacement: Buffer) {
                    bytes = replacement;
                    holding = false;
                },
                close() {
                    closed = true;
                    for (const pending of waiting.values()) pending.reject(closeError);
                    waiting.clear();
                    server.closeAllConnections();
                    closePromise ??= server.listening ? new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) : Promise.resolve();
                    return closePromise;
                },
            };
        }

        async function remoteLayerImage() {
            vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
            vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
            const background = await solid(4, 4, "#112233");
            const element = await sharp(await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
                .composite([{ input: await solid(2, 2, "#ef4444"), left: 1, top: 1 }])
                .png()
                .toBuffer();
            const source = await sharp(background)
                .composite([{ input: element }])
                .png()
                .toBuffer();
            const remote = await remoteOriginal(source);
            const inFlight: Promise<unknown>[] = [];
            const stopped = Promise.withResolvers<Error>();
            let stopping: Error | undefined;
            let cleanup: Promise<void> | undefined;
            function run<T>(operation: () => Promise<T>): Promise<T> {
                if (stopping) return Promise.reject(stopping);
                const pending = operation();
                inFlight.push(pending);
                return Promise.race([
                    pending,
                    stopped.promise.then((error) => {
                        throw error;
                    }),
                ]);
            }
            function close() {
                cleanup ??= (async () => {
                    stopping = new Error("REMOTE_FIXTURE_FINISHED: stop waiting for fixture work after the test lifecycle closes");
                    stopped.resolve(stopping);
                    await remote.close();
                    await Promise.allSettled(inFlight);
                })();
                return cleanup;
            }
            closeFixture = close;
            onTestFinished(close, testBudgetMs);
            const conversation = await run(() => creative.createConversationForUser(userId, { surface: "chat", title: "Frozen remote layer source" }));
            const reference = { id: "fixture-remote-layer-source", name: "source.png", type: "image/png", dataUrl: "", remoteUrl: remote.url };
            const image = await run(() =>
                createImage({
                    kind: "edit",
                    conversationId: conversation.id,
                    config: { ...config, outputMode: "layers" },
                    references: [reference],
                }),
            );
            const charge = await run(() => auth.consumeUserPoints(userId, image.config.model, 1, "image", `fixture-remote-source:${image.id}`));
            await run(() => support.persistChargedImageResponse(image, new Headers({ "x-vozeb-pro-points-cost": String(charge.cost), "x-vozeb-pro-points-record-id": charge.recordId, "x-vozeb-pro-points-remaining": String(charge.remaining) })));
            assert.ok(await run(() => imageTasks.transitionImageTask(image, ["pending"], { status: "running" })));
            assert.ok(await run(() => scheduler.scheduleGenerationTask("image", image.id, { executionPhase: "created", nextPollAt: 1 })));
            const workerId = "fixture-remote-source-owner";
            const claimed = await run(() => scheduler.claimDueGenerationTasks({ workerId, taskIds: [image.id], limit: 1 }));
            expect(claimed).toHaveLength(1);
            const lease = claimed[0];
            assert.ok(lease?.executionId);
            const identity = { taskId: image.id, workerId, executionId: lease.executionId };
            expect(
                await run(() =>
                    capture.captureImageTaskNativeResults({
                        ...identity,
                        attemptNo: 1,
                        upstreamTaskId: null,
                        result: { dataUrl: dataUrl(element), results: [{ dataUrl: dataUrl(element) }, { dataUrl: dataUrl(background) }] },
                        origin: "https://fixture.invalid",
                        authContext: "",
                    }),
                ),
            ).toMatchObject({ state: "native_ready" });
            const sealed = await run(() => imageTasks.getImageTask(image.id));
            assert.ok(sealed?.nativeResults);
            return { image, reference, conversationId: conversation.id, source, element, background, remote, identity, sealed, run };
        }

        type RemoteLayers = Awaited<ReturnType<typeof remoteLayerImage>>;

        function beginFreeze(fixture: RemoteLayers, identity: FreezeIdentity, requestIndex: number) {
            const pending = fixture.run(() => processing.ensureImageTaskResultProcessing(identity));
            const premature = pending.then(
                (outcome) => {
                    throw new Error(`FREEZE_GATE_NOT_REACHED: ensure settled with ${outcome.state} before remote auxiliary I/O`);
                },
                (cause: unknown) => {
                    throw new Error("FREEZE_GATE_NOT_REACHED: ensure rejected before remote auxiliary I/O", { cause });
                },
            );
            return { pending, request: Promise.race([fixture.run(() => fixture.remote.request(requestIndex)), premature]) };
        }

        async function taskFileSnapshot() {
            const filePath = path.join(directory, tasks.GENERATION_TASK_FILE);
            const [bytes, identity] = await Promise.all([readFile(filePath), stat(filePath, { bigint: true })]);
            return { bytes, dev: identity.dev, ino: identity.ino, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs };
        }

        async function billingSnapshot() {
            const [ledger, users] = await Promise.all([auth.listPointRecordsPage(userId, { pageSize: 50 }), auth.getPublicUsersByIds([userId])]);
            expect(ledger.records).toHaveLength(ledger.total);
            expect(users).toHaveLength(1);
            const user = users[0];
            assert.ok(user);
            return { ledger, pointsBalance: user.pointsBalance, permanentPointsBalance: user.permanentPointsBalance, dailyPointsBalance: user.dailyPointsBalance };
        }

        async function claimReplay(fixture: RemoteLayers, workerId: string): Promise<FreezeIdentity> {
            assert.ok(await fixture.run(() => scheduler.scheduleGenerationTask("image", fixture.image.id, { executionPhase: "persisting", nextPollAt: 1 })));
            const claimed = await fixture.run(() => scheduler.claimDueGenerationTasks({ workerId, taskIds: [fixture.image.id], limit: 1 }));
            expect(claimed).toHaveLength(1);
            const lease = claimed[0];
            assert.ok(lease?.executionId);
            expect(lease.executionId).not.toBe(fixture.identity.executionId);
            return { taskId: fixture.image.id, workerId, executionId: lease.executionId };
        }

        async function changeImage(fixture: RemoteLayers, patch: Partial<Pick<ImageTask, "references" | "config">>) {
            await fixture.run(() =>
                tasks.withGenerationTaskFileMutation(async (records) => {
                    const image = records.find((record) => record.type === "image" && record.id === fixture.image.id);
                    assert.ok(image);
                    const changed = { ...image, payload: { ...image.payload, ...patch } };
                    return { tasks: records.map((record) => (record === image ? changed : record)), result: undefined };
                }),
            );
        }

        const replacements = [
            {
                name: "source gains a higher-priority serverUrl",
                async replace(fixture: RemoteLayers) {
                    const replacement = await registeredReference(fixture.conversationId, await solid(4, 4, "#10b981"));
                    await changeImage(fixture, { references: [{ ...fixture.reference, serverUrl: replacement.reference.serverUrl }] });
                },
            },
            {
                name: "result options change from layers to ordinary",
                async replace(fixture: RemoteLayers) {
                    await changeImage(fixture, { config: { ...fixture.image.config, outputMode: undefined, outputBackground: "transparent" } });
                },
            },
        ];

        it.each([
            { name: "changed origin bytes", retire: async (fixture: RemoteLayers) => fixture.remote.replace(await solid(4, 4, "#10b981")) },
            { name: "offline origin", retire: async (fixture: RemoteLayers) => fixture.remote.close() },
        ])(
            "replays its published child after $name and consumes the frozen source through the real Worker",
            async ({ retire }) => {
                const fixture = await remoteLayerImage();
                const billing = await billingSnapshot();
                const first = beginFreeze(fixture, fixture.identity, 0);
                const request = await first.request;
                expect(fixture.remote.downloads).toBe(1);
                expect((await imageTasks.getImageTask(fixture.image.id))?.resultProcessing).toBeUndefined();
                request.finish();
                expect(await first.pending).toStrictEqual({ state: "waiting" });
                const frozen = await imageTasks.getImageTask(fixture.image.id);
                assert.ok(frozen?.resultProcessing);
                const child = await tasks.getStoredGenerationTaskRecord("image_processing", frozen.resultProcessing.jobId);
                assert.ok(child);
                const payload = await tasks.getStoredGenerationTask<ClaimedImageProcessingTask["payload"]>("image_processing", child.id);
                assert.ok(payload?.operation === "process_result" && payload.options.mode === "layers");
                expect(payload).toMatchObject({ operation: "process_result", options: { mode: "layers" }, inputs: [{}, {}, { assetId: "fixture-remote-layer-source", expectedSha256: digest(fixture.source) }] });
                expect(frozen.references).toStrictEqual(fixture.image.references);
                expect(frozen.config).toStrictEqual(fixture.image.config);
                const sources = payload.sources;
                const source = sources[2];
                assert.ok(source);
                expect(source).toMatchObject({ inputIndex: 2, scope: "reference", storageProvider: "local" });
                expect(await registrations.getLocalMediaRegistration(source.storageKey)).toMatchObject({ ownerUserId: userId, taskId: fixture.image.id, type: "image", storageClass: "permanent", bytes: fixture.source.length });
                const stored = await references.readReferenceAsset(source.storageKey);
                assert.ok(stored);
                expect(await readFile(stored.filePath)).toEqual(fixture.source);

                await fixture.run(() => retire(fixture));
                const replay = await claimReplay(fixture, "fixture-remote-replay-owner");
                expect(await fixture.run(() => processing.ensureImageTaskResultProcessing(replay))).toStrictEqual({ state: "waiting" });
                expect((await imageTasks.getImageTask(fixture.image.id))?.resultProcessing).toStrictEqual(frozen.resultProcessing);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", child.id)).toStrictEqual(child);
                expect(await tasks.queryStoredGenerationTasks("image_processing", { userId })).toHaveLength(1);
                expect(fixture.remote.downloads).toBe(1);

                const worker = await fixture.run(() => processWithWorker(child.id));
                expect(worker.child.payload).toMatchObject({ inputs: [{}, {}, { assetId: "fixture-remote-layer-source", assetVersion: digest(fixture.source), expectedSha256: digest(fixture.source) }], sources });
                expect(worker.completion.manifest.sourceIdentities[2]).toMatchObject({ assetId: "fixture-remote-layer-source", sha256: digest(fixture.source), width: 4, height: 4 });
                expect(worker.completion.manifest.sourceIdentities[2]).not.toHaveProperty("nativeImage");
                expect(worker.uploads.map((upload) => upload.bytes)).toStrictEqual([fixture.element, fixture.background]);
                const recoveryInput = { origin: "https://fixture.invalid", workerId: "fixture-remote-source-consumer", taskIds: [fixture.image.id], limit: 1 };
                expect(await fixture.run(() => recovery.runGenerationTaskRecoveryBatch(recoveryInput))).toMatchObject({ claimed: 1, completed: 1, failed: 0, deferred: 0 });
                const delivered = await imageTasks.getImageTask(fixture.image.id);
                expect(delivered).toMatchObject({ status: "success", nativeResults: fixture.sealed.nativeResults, resultProcessing: frozen.resultProcessing, references: fixture.image.references });
                expect(delivered?.result?.results).toMatchObject([{ resultId: `${fixture.image.id}:1` }, { resultId: `${fixture.image.id}:2` }]);
                expect((await logs.listGenerationLogs({ userId })).items.filter((item) => item.taskId === fixture.image.id)).toHaveLength(1);
                expect((await creative.listAssetsForUser(userId, fixture.conversationId)).filter((asset) => asset.sourceTaskId === fixture.image.id)).toHaveLength(2);
                expect(await billingSnapshot()).toStrictEqual(billing);
                expect(await fixture.run(() => recovery.runGenerationTaskRecoveryBatch(recoveryInput))).toMatchObject({ claimed: 0, completed: 0, failed: 0, deferred: 0 });
                expect(await imageTasks.getImageTask(fixture.image.id)).toStrictEqual(delivered);
                expect(await fixture.run(() => service.completeImageProcessingTask(worker.child.id, worker.completion))).toStrictEqual(worker.receipt);
                expect(fixture.remote.downloads).toBe(1);
                expect(await billingSnapshot()).toStrictEqual(billing);
            },
            testBudgetMs,
        );

        it.each([
            ...replacements,
            {
                name: "original owner is replaced by a real new claim",
                async replace(fixture: RemoteLayers) {
                    expect(await fixture.run(() => scheduler.releaseGenerationTaskLease("image", fixture.image.id, fixture.identity.workerId, { executionPhase: "persisting", nextPollAt: 1 }, { executionId: fixture.identity.executionId }))).toMatchObject({
                        id: fixture.image.id,
                        type: "image",
                        userId,
                        status: "running",
                        executionPhase: "persisting",
                        workerId: undefined,
                        leaseUntil: undefined,
                        nextPollAt: 1,
                        payload: { executionId: fixture.identity.executionId },
                    });
                    await claimReplay(fixture, "fixture-remote-source-next-owner");
                },
            },
        ])(
            "loses publication ownership when $name during source I/O",
            async ({ replace }) => {
                const fixture = await remoteLayerImage();
                const billing = await billingSnapshot();
                const first = beginFreeze(fixture, fixture.identity, 0);
                const request = await first.request;
                await fixture.run(() => replace(fixture));
                const current = await tasks.getStoredGenerationTaskRecord("image", fixture.image.id);
                const before = await taskFileSnapshot();
                request.finish();
                expect(await first.pending).toStrictEqual({ state: "ownership_lost" });
                expect(await tasks.getStoredGenerationTaskRecord("image", fixture.image.id)).toStrictEqual(current);
                expect(await tasks.queryStoredGenerationTasks("image_processing", { userId })).toStrictEqual([]);
                expect(await taskFileSnapshot()).toStrictEqual(before);
                expect(fixture.remote.downloads).toBe(1);
                expect(await billingSnapshot()).toStrictEqual(billing);
            },
            testBudgetMs,
        );

        it.each(replacements)(
            "rejects its frozen child without downloading or replacing it when $name",
            async ({ replace }) => {
                const fixture = await remoteLayerImage();
                const first = beginFreeze(fixture, fixture.identity, 0);
                (await first.request).finish();
                expect(await first.pending).toStrictEqual({ state: "waiting" });
                const frozen = await imageTasks.getImageTask(fixture.image.id);
                assert.ok(frozen?.resultProcessing);
                const replay = await claimReplay(fixture, "fixture-remote-mutated-replay-owner");
                await fixture.run(() => replace(fixture));
                const current = await tasks.getStoredGenerationTaskRecord("image", fixture.image.id);
                const child = await tasks.getStoredGenerationTaskRecord("image_processing", frozen.resultProcessing.jobId);
                const billing = await billingSnapshot();
                const before = await taskFileSnapshot();
                fixture.remote.replace(await solid(4, 4, "#f59e0b"));
                expect(await fixture.run(() => processing.ensureImageTaskResultProcessing(replay))).toStrictEqual({ state: "ownership_lost" });
                expect(await tasks.getStoredGenerationTaskRecord("image", fixture.image.id)).toStrictEqual(current);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", frozen.resultProcessing.jobId)).toStrictEqual(child);
                expect(await tasks.queryStoredGenerationTasks("image_processing", { userId })).toHaveLength(1);
                expect(await taskFileSnapshot()).toStrictEqual(before);
                expect(fixture.remote.downloads).toBe(1);
                expect(await billingSnapshot()).toStrictEqual(billing);
            },
            testBudgetMs,
        );

        it(
            "publishes only one child for concurrent freezes of the same remote source",
            async () => {
                const fixture = await remoteLayerImage();
                const billing = await billingSnapshot();
                const first = beginFreeze(fixture, fixture.identity, 0);
                const firstRequest = await first.request;
                const second = beginFreeze(fixture, fixture.identity, 1);
                const secondRequest = await second.request;
                firstRequest.finish();
                expect(await first.pending).toStrictEqual({ state: "waiting" });
                const winner = await tasks.getStoredGenerationTaskRecord("image", fixture.image.id);
                assert.ok(winner?.payload.resultProcessing);
                const children = await tasks.queryStoredGenerationTasks("image_processing", { userId });
                expect(children).toHaveLength(1);
                expect(await billingSnapshot()).toStrictEqual(billing);
                const before = await taskFileSnapshot();
                secondRequest.finish();
                expect(await second.pending).toStrictEqual({ state: "ownership_lost" });
                expect(await tasks.getStoredGenerationTaskRecord("image", fixture.image.id)).toStrictEqual(winner);
                expect(await tasks.queryStoredGenerationTasks("image_processing", { userId })).toStrictEqual(children);
                expect(await taskFileSnapshot()).toStrictEqual(before);
                expect(fixture.remote.downloads).toBe(2);
                expect(await billingSnapshot()).toStrictEqual(billing);
            },
            testBudgetMs,
        );
    });
});
