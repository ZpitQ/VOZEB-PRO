import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import type { AgentRun } from "./agent-run-store";
import type { StoredGenerationTaskRecord } from "./generation-task-store";
import type { ClaimedImageProcessingTask, ClaimImageProcessingInput, CompleteImageProcessingInput, StoredImageProcessingArtifact } from "./image-processing-service";

async function arrivedBefore(pending: Promise<unknown>, milliseconds: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            pending.then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

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

function orderedRows(records: StoredGenerationTaskRecord[]) {
    return records.toSorted((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
}

it("drains an active image input after SIGTERM, renews its lease and leaves a second real job pending", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vozeb-image-drain-"));
    const workerTemp = path.join(directory, "worker-temp");
    const userId = "fixture-drain-user-" + randomUUID();
    const workerId = "fixture-image-drain-" + randomUUID();
    const workerToken = "fixture-image-drain-worker-token-00000001";
    const observations = new EventEmitter();
    const releaseInput = Promise.withResolvers<void>();
    const claimed = once(observations, "claimed");
    const inputStarted = once(observations, "input-started");
    const renewed = once(observations, "renewed-after-stop");
    const completed = once(observations, "completed");
    const positive = once(observations, "positive");
    const fixtureFailure = new Promise<never>((_resolve, reject) => observations.on("failure", reject));
    const startup = Promise.race([positive, fixtureFailure]);
    const requests = new Set<Promise<void>>();
    const ordinary = new Set<string>();
    let refundSeen = false;
    let globalHeartbeatSeen = false;
    let inputHeld = false;
    let inputReleased = false;
    let postStopRenewed = false;
    let signalSentAt = 0;
    let claimReturnedAt = 0;
    let imageClaims = 0;
    let origin: string;
    let stdout = "";
    let stderr = "";
    let workerPid: number | undefined;
    let lease: ClaimedImageProcessingTask | undefined;
    let identity: { workerId: string; executionId: string } | undefined;
    let stored: StoredImageProcessingArtifact | undefined;
    let analysisPath: string | undefined;
    let finalTruth: Awaited<ReturnType<typeof truth>> | undefined;
    const timeline: string[] = [];

    vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
    vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
    vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-image-drain-maintenance-token-0001");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");

    let tasks: typeof import("./generation-task-store");
    let runtime: typeof import("./creative-runtime-store");
    let registrations: typeof import("./local-media-registry");
    let references: typeof import("./reference-asset-store");
    let service: typeof import("./image-processing-service");
    let scheduler: typeof import("./generation-task-scheduler");
    let planning: typeof import("./ecommerce-generation-snapshot");
    let recovery: typeof import("./ecommerce-reference-recovery");
    let claimRoute: typeof import("@/app/api/maintenance/image-processing/claim/route");
    let inputRoute: typeof import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route");
    let heartbeatRoute: typeof import("@/app/api/maintenance/image-processing/[id]/heartbeat/route");
    let outputRoute: typeof import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route");
    let completeRoute: typeof import("@/app/api/maintenance/image-processing/[id]/complete/route");
    let conversation: Awaited<ReturnType<(typeof import("./creative-runtime-store"))["createCreativeConversation"]>>;
    let asset: Awaited<ReturnType<(typeof import("./creative-runtime-store"))["registerCreativeAssets"]>>[number];
    let source: Buffer;
    let sourceHash: string;
    let nativeKey: string;
    let nativePath: string;
    let first: Awaited<ReturnType<typeof enqueueRun>>;
    let second: Awaited<ReturnType<typeof enqueueRun>> | undefined;
    let profile: ReturnType<(typeof import("@/lib/image-processing/resource-config"))["imageProcessingResourceConfig"]>;

    const server = createServer((request, response) => {
        const running = handle(request, response)
            .catch((error: unknown) => {
                observations.emit("failure", error);
                if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
                response.end(JSON.stringify({ code: 500, data: null, msg: "Drain fixture rejected the request" }));
            })
            .finally(() => requests.delete(running));
        requests.add(running);
    });

    function diagnostics(message: string) {
        return message + "\ntimeline: " + JSON.stringify(timeline) + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr;
    }

    async function truth() {
        const rows = await tasks.withGenerationTaskFileMutation(async (records) => ({ tasks: records, result: orderedRows(records.filter((record) => record.userId === userId)) }));
        const media = (await registrations.listFileLocalMediaRegistrations()).filter((record) => record.ownerUserId === userId).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey));
        return { rows, media, sourceBytes: await readFile(nativePath), analysisBytes: analysisPath === undefined ? undefined : await readFile(analysisPath) };
    }

    async function enqueueRun() {
        const now = Date.now();
        const parentExecutionId = randomUUID();
        const run: AgentRun = {
            id: "agent-drain-" + randomUUID(),
            userId,
            conversationId: conversation.id,
            clientRequestId: randomUUID(),
            surface: "chat",
            inputMessageId: "message-" + randomUUID(),
            assistantMessageId: "message-" + randomUUID(),
            prompt: "Prepare the registered drain reference",
            referencedAssetIds: [asset.id],
            assetIds: [],
            status: "running",
            executionId: parentExecutionId,
            tasks: [],
            reviewed: false,
            createdAt: now,
            updatedAt: now,
        };
        const checkpoint = recovery.createEcommerceReferenceCheckpoint(run, planning.buildEcommercePlanningInput(run, [asset], { summary: "", recentMessages: [] }), [asset]);
        run.ecommerceSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            input: { userRequest: run.prompt, assetIds: [asset.id], conversationId: conversation.id, surface: "chat" },
            referenceCheckpoint: checkpoint,
            createdAt: now,
            runId: run.id,
            userId,
        };
        await runtime.createCreativeRunBundle(userId, { run, conversationId: conversation.id, title: "Image drain fixture", prompt: run.prompt, assetIds: [asset.id], ttlMs: 365 * 24 * 60 * 60 * 1000 });
        assert.ok(await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: now }));
        expect((await scheduler.claimDueGenerationTasks({ workerId: "fixture-drain-parent", taskIds: [run.id], limit: 1 })).map((task) => task.id)).toStrictEqual([run.id]);
        const reference = checkpoint.assets[0];
        assert.ok(reference);
        const child = await service.enqueueImageProcessingTask({
            runId: run.id,
            parentExecutionId,
            algorithmVersion: "reference-input-policy.v1",
            operation: "prepare_reference",
            inputs: [{ assetId: asset.id, assetVersion: reference.assetVersion }],
            options: {},
        });
        const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
        const pending = await tasks.getStoredGenerationTaskRecord("image_processing", child.id);
        const view = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
        assert.ok(parent && pending && view?.ecommerceSnapshot);
        const snapshot = view.ecommerceSnapshot;
        const processing = snapshot.processing;
        const waitingCheckpoint = snapshot.referenceCheckpoint;
        assert.ok(processing && waitingCheckpoint);
        const waitingReference = waitingCheckpoint.assets[0];
        assert.ok(waitingReference);
        expect(processing.waitingFor).toStrictEqual({ jobId: child.id, inputDigest: child.payload.inputDigest });
        expect(pending.status).toBe("pending");
        expect(pending.workerId).toBeUndefined();
        expect(pending.leaseUntil).toBeUndefined();
        expect(pending.nextPollAt).toBeLessThanOrEqual(Date.now());
        expect(child.payload.resource.profileVersion).toBe(profile.profileVersion);
        expect(child.payload.resource.requiredMemoryBytes).toBeGreaterThan(0);
        expect(child.payload.resource.requiredMemoryBytes).toBeLessThanOrEqual(1073741824);
        expect(child.payload.resource.unavailable).toBeUndefined();
        return { run, child, parent, pending, snapshot, processing, checkpoint: waitingCheckpoint, reference: waitingReference };
    }

    async function handle(request: IncomingMessage, response: ServerResponse) {
        assert.ok(request.url);
        const url = new URL(request.url, origin);
        const authorization = request.headers.authorization;
        expect(authorization).toBe("Bearer " + workerToken);
        assert.ok(typeof authorization === "string");
        if (url.pathname === "/api/maintenance/generation-tasks/run") {
            expect(request.method).toBe("POST");
            const id = request.headers["x-vozeb-pro-worker-id"];
            assert.ok(typeof id === "string");
            expect([workerId + ":lane-1", workerId + ":lane-2"]).toContain(id);
            ordinary.add(id);
        } else if (url.pathname === "/api/maintenance/billing-refunds/run") {
            expect(request.method).toBe("POST");
            expect(request.headers["x-vozeb-pro-worker-id"]).toBe(workerId + ":billing-refunds");
            refundSeen = true;
        } else if (url.pathname === "/api/maintenance/generation-tasks/heartbeat") {
            expect(request.method).toBe("POST");
            expect(request.headers["x-vozeb-pro-worker-id"]).toBe(workerId);
            globalHeartbeatSeen = true;
        } else {
            return handleImage(request, response, url, authorization);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: 0, data: { claimed: 0 }, msg: "OK" }));
        if (ordinary.size === 2 && refundSeen && globalHeartbeatSeen) observations.emit("positive");
    }

    async function handleImage(request: IncomingMessage, response: ServerResponse, url: URL, authorization: string) {
        if (url.pathname === "/api/maintenance/image-processing/claim") {
            imageClaims += 1;
            expect(imageClaims, "DRAIN: an occupied or stopped image lane claimed another batch").toBe(1);
            expect(signalSentAt).toBe(0);
            expect(request.method).toBe("POST");
            expect(request.headers["content-type"]).toMatch(/^application\/json(?:;|$)/i);
            const text = (await requestBytes(request)).toString("utf8");
            const body: unknown = JSON.parse(text);
            assert.ok(body && typeof body === "object" && "workerId" in body && typeof body.workerId === "string");
            const input: ClaimImageProcessingInput = { workerId: body.workerId, profileVersion: profile.profileVersion, availableMemoryBytes: 1073741824, slots: 1 };
            expect(body).toStrictEqual(input);
            expect([workerId + ":lane-1", workerId + ":lane-2", workerId + ":billing-refunds"]).not.toContain(input.workerId);
            const result = await claimRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }));
            expect(result.status).toBe(200);
            const envelope: { code: number; data: { tasks: ClaimedImageProcessingTask[] }; msg: string } = await result.clone().json();
            expect(envelope.code).toBe(0);
            expect(envelope.data.tasks).toHaveLength(1);
            const actual = envelope.data.tasks[0];
            assert.ok(actual);
            expect(actual).toStrictEqual({
                id: first.child.id,
                executionId: expect.any(String),
                leaseUntil: expect.any(Number),
                payload: { ...first.child.payload, executionId: actual.executionId },
                inputUrls: ["/api/maintenance/image-processing/" + first.child.id + "/inputs/" + asset.id],
            });
            lease = actual;
            identity = { workerId: input.workerId, executionId: actual.executionId };
            claimReturnedAt = Date.now();
            timeline.push("claim");
            await relay(result, response);
            observations.emit("claimed");
            return;
        }
        assert.ok(identity && lease);
        const endpoint = "/api/maintenance/image-processing/" + first.child.id;
        if (url.pathname === endpoint + "/inputs/" + asset.id) {
            expect(request.method).toBe("GET");
            expect(request.headers["x-vozeb-pro-worker-id"]).toBe(identity.workerId);
            expect(request.headers["x-vozeb-pro-execution-id"]).toBe(identity.executionId);
            const before = await truth();
            const result = await inputRoute.GET(new Request(url, { headers: { authorization, "x-vozeb-pro-worker-id": identity.workerId, "x-vozeb-pro-execution-id": identity.executionId } }), {
                params: Promise.resolve({ id: first.child.id, assetId: asset.id }),
            });
            expect(result.status).toBe(200);
            expect(await truth()).toStrictEqual(before);
            assert.ok(result.body);
            const reader = result.body.getReader();
            try {
                const firstChunk = await reader.read();
                assert.ok(!firstChunk.done && firstChunk.value.byteLength > 0);
                const chunks = [Buffer.from(firstChunk.value)];
                for (const [name, value] of result.headers) response.setHeader(name, value);
                response.writeHead(result.status);
                response.write(firstChunk.value.subarray(0, 1));
                inputHeld = true;
                timeline.push("input_first_byte");
                observations.emit("input-started");
                await releaseInput.promise;
                response.write(firstChunk.value.subarray(1));
                for (;;) {
                    const next = await reader.read();
                    if (next.done) break;
                    chunks.push(Buffer.from(next.value));
                    response.write(next.value);
                }
                expect(Buffer.concat(chunks)).toEqual(source);
                inputHeld = false;
                inputReleased = true;
                timeline.push("input_eof");
                response.end();
            } finally {
                await reader.cancel();
                reader.releaseLock();
            }
            return;
        }
        if (url.pathname === endpoint + "/heartbeat") {
            expect(request.method).toBe("POST");
            const text = (await requestBytes(request)).toString("utf8");
            expect(JSON.parse(text)).toStrictEqual(identity);
            const before = await tasks.getStoredGenerationTaskRecord("image_processing", first.child.id);
            assert.ok(before);
            const startedAt = Date.now();
            const result = await heartbeatRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }), { params: Promise.resolve({ id: first.child.id }) });
            const endedAt = Date.now();
            expect(result.status).toBe(200);
            const envelope: { code: number; data: { leaseUntil: number; cancelRequested: boolean }; msg: string } = await result.clone().json();
            expect(envelope).toStrictEqual({ code: 0, data: { leaseUntil: expect.any(Number), cancelRequested: false }, msg: "OK" });
            expect(envelope.data.leaseUntil).toBeGreaterThanOrEqual(startedAt + 90_000);
            expect(envelope.data.leaseUntil).toBeLessThanOrEqual(endedAt + 90_000);
            expect(envelope.data.leaseUntil).toBeGreaterThan(lease.leaseUntil);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", first.child.id)).toStrictEqual({ ...before, leaseUntil: envelope.data.leaseUntil, lastHeartbeatAt: expect.any(Number) });
            await relay(result, response);
            if (!postStopRenewed && signalSentAt > 0 && startedAt >= signalSentAt && startedAt - claimReturnedAt >= 25_000 && inputHeld) {
                postStopRenewed = true;
                timeline.push("heartbeat_25s_after_sigterm");
                observations.emit("renewed-after-stop");
            }
            return;
        }
        if (url.pathname === endpoint + "/outputs/analysis") {
            expect(request.method).toBe("PUT");
            expect(inputReleased && postStopRenewed).toBe(true);
            expect(signalSentAt).toBeGreaterThan(0);
            expect(request.headers["x-vozeb-pro-worker-id"]).toBe(identity.workerId);
            expect(request.headers["x-vozeb-pro-execution-id"]).toBe(identity.executionId);
            expect(request.headers["content-type"]).toBe("image/png");
            const bytes = await requestBytes(request);
            expect(bytes).toEqual(source);
            const result = await outputRoute.PUT(
                new Request(url, { method: "PUT", headers: { authorization, "content-type": "image/png", "x-vozeb-pro-worker-id": identity.workerId, "x-vozeb-pro-execution-id": identity.executionId }, body: new Uint8Array(bytes) }),
                { params: Promise.resolve({ id: first.child.id, kind: "analysis" }) },
            );
            expect(result.status).toBe(201);
            const envelope: { code: number; data: StoredImageProcessingArtifact; msg: string } = await result.clone().json();
            expect(envelope.code).toBe(0);
            stored = envelope.data;
            expect(stored).toStrictEqual({ kind: "analysis", storageKey: expect.any(String), sha256: sourceHash, mimeType: "image/png", bytes: source.length, width: 24, height: 18 });
            const saved = await references.readReferenceAsset(stored.storageKey);
            const registration = await registrations.getLocalMediaRegistration(stored.storageKey);
            assert.ok(saved && registration);
            analysisPath = saved.filePath;
            expect(await readFile(analysisPath)).toEqual(source);
            expect(registration).toMatchObject({ ownerUserId: userId, runId: first.run.id, taskId: first.child.id, scope: "reference", type: "image", mimeType: "image/png", bytes: source.length, storageProvider: "local" });
            timeline.push("upload");
            await relay(result, response);
            return;
        }
        if (url.pathname === endpoint + "/complete") {
            expect(request.method).toBe("POST");
            assert.ok(stored && analysisPath && second);
            const text = (await requestBytes(request)).toString("utf8");
            const body: unknown = JSON.parse(text);
            assert.ok(
                body && typeof body === "object" && "metrics" in body && body.metrics && typeof body.metrics === "object" && "pid" in body.metrics && typeof body.metrics.pid === "number" && Number.isSafeInteger(body.metrics.pid) && body.metrics.pid > 0,
            );
            const childPid = body.metrics.pid;
            expect(childPid).not.toBe(workerPid);
            expect(childPid).not.toBe(process.pid);
            expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
            const before = await truth();
            const beforeChild = before.rows.find((row) => row.id === first.child.id);
            assert.ok(beforeChild);
            const startedAt = Date.now();
            const result = await completeRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }), { params: Promise.resolve({ id: first.child.id }) });
            const endedAt = Date.now();
            expect(result.status).toBe(200);
            const completion: CompleteImageProcessingInput = JSON.parse(text);
            expect(completion.workerId).toBe(identity.workerId);
            expect(completion.executionId).toBe(identity.executionId);
            expect(completion.manifest).toStrictEqual({
                jobId: first.child.id,
                executionId: identity.executionId,
                sourceIdentities: [{ assetId: asset.id, assetVersion: first.child.payload.inputs[0].assetVersion, sha256: sourceHash, bytes: source.length, mimeType: "image/png", width: 24, height: 18 }],
                artifacts: [stored],
                geometry: { sourceSize: { width: 24, height: 18 } },
            });
            expect(completion.metrics.peakRssBytes).toBeGreaterThan(0);
            expect(completion.metrics.peakHeapUsedBytes).toBeGreaterThan(0);
            expect(completion.metrics.peakExternalBytes).toBeGreaterThan(0);
            expect(completion.metrics.elapsedMs).toBeGreaterThan(0);
            expect(await result.clone().json()).toStrictEqual({
                code: 0,
                data: { jobId: first.child.id, inputDigest: first.child.payload.inputDigest, executionId: identity.executionId, manifest: completion.manifest, parentRescheduled: true },
                msg: "OK",
            });
            const { workerId: ownedWorker, leaseUntil, lastHeartbeatAt, nextPollAt, ...closedChild } = beforeChild;
            expect(ownedWorker).toBe(identity.workerId);
            expect(leaseUntil).toBeGreaterThan(startedAt);
            expect(lastHeartbeatAt).toBeTypeOf("number");
            expect(nextPollAt).toBeTypeOf("number");
            const { waitingFor, ...releasedProcessing } = first.processing;
            expect(waitingFor).toStrictEqual({ jobId: first.child.id, inputDigest: first.child.payload.inputDigest });
            const expectedParent: StoredGenerationTaskRecord = {
                ...first.parent,
                updatedAt: expect.any(Number),
                payload: {
                    ...first.parent.payload,
                    updatedAt: expect.any(Number),
                    ecommerceSnapshot: {
                        ...first.snapshot,
                        referenceCheckpoint: {
                            ...first.checkpoint,
                            assets: [{ ...first.reference, asset: { ...first.reference.asset, width: 24, height: 18 }, contentSha256: sourceHash, assetVersion: recovery.referenceAssetVersion(first.reference.asset, sourceHash) }],
                            analysisStage: { ...first.checkpoint.analysisStage, state: "sources_loaded" },
                        },
                        processing: { ...releasedProcessing, prepareReferences: [{ ...first.processing.prepareReferences[0], manifest: completion.manifest }] },
                    },
                },
                executionPhase: "created",
                nextPollAt: expect.any(Number),
                lastUpstreamStatus: "image_processing_completed",
            };
            const expectedChild: StoredGenerationTaskRecord = {
                ...closedChild,
                status: "success",
                executionPhase: "completed",
                updatedAt: expect.any(Number),
                lastUpstreamStatus: "completed",
                resultPayload: { ...identity, manifest: completion.manifest, manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/), metrics: completion.metrics, parentRescheduled: true },
            };
            const after = await truth();
            expect(after).toStrictEqual({ ...before, rows: orderedRows([expectedParent, expectedChild, second.parent, second.pending]) });
            const awakened = after.rows.find((row) => row.id === first.run.id);
            assert.ok(awakened?.nextPollAt);
            expect(awakened.nextPollAt).toBeGreaterThanOrEqual(startedAt);
            expect(awakened.nextPollAt).toBeLessThanOrEqual(endedAt);
            finalTruth = after;
            await relay(result, response);
            timeline.push("complete_receipt");
            observations.emit("completed");
            return;
        }
        throw new Error("Unexpected drain Worker TCP path: " + url.pathname);
    }

    try {
        await mkdir(workerTemp);
        const workerScript = fileURLToPath(new URL("../../../scripts/generation-worker.mjs", import.meta.url));
        for (const name of ["image-processing-child.mjs", "image-processing-lane.mjs"]) {
            const entry = fileURLToPath(new URL("../../../.image-processing-runtime/workers/" + name, import.meta.url));
            const info = await stat(entry).catch((error: unknown) => {
                throw new Error("SETUP: build the actual image runtime before drain", { cause: error });
            });
            assert.ok(info.isFile());
        }
        [tasks, runtime, registrations, references, service, scheduler, planning, recovery, claimRoute, inputRoute, heartbeatRoute, outputRoute, completeRoute] = await Promise.all([
            import("./generation-task-store"),
            import("./creative-runtime-store"),
            import("./local-media-registry"),
            import("./reference-asset-store"),
            import("./image-processing-service"),
            import("./generation-task-scheduler"),
            import("./ecommerce-generation-snapshot"),
            import("./ecommerce-reference-recovery"),
            import("@/app/api/maintenance/image-processing/claim/route"),
            import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route"),
            import("@/app/api/maintenance/image-processing/[id]/heartbeat/route"),
            import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route"),
            import("@/app/api/maintenance/image-processing/[id]/complete/route"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        assert.equal((await getObjectStorageRuntimeConfig()).enabled, false, "SETUP: drain requires isolated local media");
        const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
        profile = imageProcessingResourceConfig(process.env);
        expect(profile).toMatchObject({ budgetBytes: 1073741824, processHeapMb: 384, concurrency: 1 });
        source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#8a6243" } })
            .png()
            .toBuffer();
        sourceHash = createHash("sha256").update(source).digest("hex");
        conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const original = await references.writeReferenceImageDataUrl("data:image/png;base64," + source.toString("base64"), { ownerUserId: userId, conversationId: conversation.id, source: "fixture-image-drain" });
        nativeKey = original.token;
        const saved = await references.readReferenceAsset(nativeKey);
        assert.ok(saved);
        nativePath = saved.filePath;
        const [registered] = await runtime.registerCreativeAssets([
            {
                id: "fixture-drain-reference-" + randomUUID(),
                userId,
                conversationId: conversation.id,
                ordinal: 0,
                type: "image",
                title: "drain.png",
                sourceRunId: "fixture-upload-" + randomUUID(),
                serverUrl: "/api/reference-assets/" + nativeKey,
                metadata: {},
            },
        ]);
        assert.ok(registered);
        asset = registered;
        first = await enqueueRun();
        const beforeWorker = await truth();
        expect(beforeWorker.rows).toHaveLength(2);
        expect(beforeWorker.media).toHaveLength(1);
        expect(beforeWorker.sourceBytes).toEqual(source);
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        server.on("error", (error) => observations.emit("failure", error));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        origin = "http://127.0.0.1:" + address.port;
        const worker = spawn(process.execPath, ["--max-old-space-size=64", workerScript], {
            cwd: path.dirname(path.dirname(workerScript)),
            env: {
                ...process.env,
                TMPDIR: workerTemp,
                TMP: workerTemp,
                TEMP: workerTemp,
                VOZEB_PRO_WORKER_API_ORIGIN: origin,
                VOZEB_PRO_GENERATION_WORKER_ID: workerId,
                VOZEB_PRO_GENERATION_WORKER_LANES: "2",
                VOZEB_PRO_GENERATION_WORKER_HEARTBEAT_MS: "5000",
            },
            stdio: "pipe",
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            worker.once("error", (error) => reject(new Error("SETUP: actual drain Worker could not start", { cause: error })));
            worker.once("close", (code, signal) => {
                timeline.push("worker_close");
                resolve({ code, signal });
            });
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
        });
        const unexpectedExit = closed.then((exit) => {
            throw new Error(diagnostics((signalSentAt ? "DRAIN: Worker exited before active job completion: " : "SETUP: Worker exited before drain: ") + JSON.stringify(exit)));
        });
        const guarded = (event: Promise<unknown>) => Promise.race([event, fixtureFailure, unexpectedExit]);
        try {
            assert.ok(workerPid, "SETUP: actual Worker has no PID");
            assert.ok(await arrivedBefore(guarded(startup), 20_000), diagnostics("SETUP: authenticated ordinary/refund/global heartbeat did not start"));
            expect(stderr).toBe("");
            expect(await arrivedBefore(guarded(claimed), 10_000), diagnostics("DRAIN: actual Worker did not claim the real prepare job")).toBe(true);
            expect(await arrivedBefore(guarded(inputStarted), 10_000), diagnostics("DRAIN: original input stream did not become active")).toBe(true);
            second = await enqueueRun();
            timeline.push("second_pending");
            expect(second.child.id).not.toBe(first.child.id);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", second.child.id)).toStrictEqual(second.pending);
            expect(imageClaims).toBe(1);
            expect(inputHeld).toBe(true);
            signalSentAt = Date.now();
            expect(worker.kill("SIGTERM")).toBe(true);
            timeline.push("sigterm");
            expect(await arrivedBefore(guarded(renewed), 45_000), diagnostics("DRAIN: SIGTERM stopped the active image job heartbeat before its real 25s renewal")).toBe(true);
            expect(inputHeld).toBe(true);
            expect(stored).toBeUndefined();
            const directories = await readdir(workerTemp);
            expect(directories).toHaveLength(1);
            const jobDirectory = directories[0];
            assert.ok(jobDirectory?.startsWith("vozeb-image-processing-"));
            expect(await readFile(path.join(workerTemp, jobDirectory, "input-0"))).toEqual(source.subarray(0, 1));
            releaseInput.resolve();
            expect(await arrivedBefore(guarded(completed), 30_000), diagnostics("DRAIN: actual child/PUT/complete receipt did not finish after SIGTERM")).toBe(true);
            expect(await arrivedBefore(closed, 15_000), diagnostics("DRAIN: Worker did not close after its active job completed")).toBe(true);
            expect(await closed).toStrictEqual({ code: 0, signal: null });
            expect(imageClaims).toBe(1);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", second.child.id)).toStrictEqual(second.pending);
            expect(await tasks.getStoredGenerationTaskRecord("agent", second.run.id)).toStrictEqual(second.parent);
            expect(await readdir(workerTemp), "DRAIN: completed job temporary files survived Worker close").toStrictEqual([]);
            expect(timeline).toStrictEqual(["claim", "input_first_byte", "second_pending", "sigterm", "heartbeat_25s_after_sigterm", "input_eof", "upload", "complete_receipt", "worker_close"]);
            assert.ok(finalTruth);
            expect(await truth()).toStrictEqual(finalTruth);
            expect(stderr, diagnostics("DRAIN: actual Worker reported an unknown transport outcome")).toBe("");
        } finally {
            if (worker.exitCode === null && worker.signalCode === null && signalSentAt === 0) worker.kill("SIGTERM");
            releaseInput.resolve();
            if (!(await arrivedBefore(closed, 15_000))) {
                worker.kill("SIGKILL");
                await closed;
                throw new Error(diagnostics("CLEANUP: forced SIGKILL is not valid drain qualification"));
            }
            expect(await closed).toStrictEqual({ code: 0, signal: null });
            await Promise.all([...requests]);
            expect(await registrations.getLocalMediaRegistration(nativeKey)).toStrictEqual(beforeWorker.media[0]);
            expect(await readFile(nativePath)).toEqual(source);
            if (analysisPath) expect(await readFile(analysisPath)).toEqual(source);
        }
    } finally {
        releaseInput.resolve();
        try {
            server.closeAllConnections();
            if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        } finally {
            try {
                await rm(directory, { recursive: true, force: true });
            } finally {
                vi.unstubAllEnvs();
            }
        }
    }
}, 150_000);
