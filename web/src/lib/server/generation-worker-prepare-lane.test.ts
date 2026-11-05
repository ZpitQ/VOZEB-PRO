import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import type { AgentRun } from "./agent-run-store";
import type { ClaimedImageProcessingTask, ClaimImageProcessingInput, CompleteImageProcessingInput, StoredImageProcessingArtifact } from "./image-processing-service";

async function arrivedBefore(pending: Promise<unknown>, milliseconds: number) {
    const cleanup = new AbortController();
    const deadline = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), milliseconds);
        cleanup.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    });
    try {
        return await Promise.race([pending.then(() => true), deadline]);
    } finally {
        cleanup.abort();
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

it("W2 processes a real prepare reference over TCP after a 25s input heartbeat and wakes its original Run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vozeb-worker-prepare-lane-"));
    const workerId = "fixture-prepare-lane-" + randomUUID();
    const userId = "fixture-prepare-user-" + randomUUID();
    const laneOneId = workerId + ":lane-1";
    const laneTwoId = workerId + ":lane-2";
    const refundId = workerId + ":billing-refunds";
    const workerToken = "fixture-worker-prepare-lane-worker-token-0001";
    const observations = new EventEmitter();
    const releaseInput = Promise.withResolvers<void>();
    const positive = once(observations, "positive");
    const claimed = once(observations, "claimed");
    const inputStarted = once(observations, "input-started");
    const renewed = once(observations, "renewed");
    const completed = once(observations, "completed");
    const fixtureFailure = new Promise<never>((_resolve, reject) => observations.on("failure", reject));
    const startupSignal = Promise.race([positive, fixtureFailure]);
    const requests = new Set<Promise<void>>();
    const ordinaryIds = new Set<string>();
    const ordinaryDuringInput = new Set<string>();
    let refundSeen = false;
    let refundDuringInput = false;
    let globalHeartbeatDuringInput = false;
    let inputHeld = false;
    let inputReleased = false;
    let claimReturnedAt = 0;
    let origin: string;
    let stdout = "";
    let stderr = "";
    let workerPid: number | undefined;
    let lease: ClaimedImageProcessingTask | undefined;
    let identity: { workerId: string; executionId: string } | undefined;
    let stored: StoredImageProcessingArtifact | undefined;
    let analysisPath: string | undefined;
    let completionSaved = false;
    let finalSnapshot: Awaited<ReturnType<typeof snapshot>> | undefined;
    const timeline: string[] = [];

    vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
    vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
    vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-worker-prepare-lane-maintenance-token-0001");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");

    const server = createServer((request, response) => {
        const running = handle(request, response)
            .catch((error: unknown) => {
                observations.emit("failure", error);
                if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
                response.end(JSON.stringify({ code: 500, data: null, msg: "TCP fixture rejected the request" }));
            })
            .finally(() => requests.delete(running));
        requests.add(running);
    });

    function diagnostics(message: string) {
        return message + "\ntimeline: " + JSON.stringify(timeline) + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr;
    }

    async function snapshot() {
        const rows = await tasks.withGenerationTaskFileMutation(async (records) => ({
            tasks: records,
            result: records.filter((record) => record.userId === userId).toSorted((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id)),
        }));
        const media = (await registrations.listFileLocalMediaRegistrations()).filter((record) => record.ownerUserId === userId).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey));
        return {
            rows,
            media,
            sourceBytes: await readFile(nativePath),
            analysisBytes: analysisPath === undefined ? undefined : await readFile(analysisPath),
            conversation: await runtime.getCreativeConversation(conversation.id, userId),
            messages: await runtime.listCreativeMessages(conversation.id),
            assets: await runtime.listCreativeAssets(conversation.id, userId),
            events: await runtime.listCreativeRunEvents(run.id),
        };
    }

    async function handle(request: IncomingMessage, response: ServerResponse) {
        assert.ok(request.url);
        const url = new URL(request.url, origin);
        const authorization = request.headers.authorization;
        assert.ok(typeof authorization === "string");
        expect(authorization).toBe("Bearer " + workerToken);
        if (url.pathname === "/api/maintenance/generation-tasks/run") {
            expect(request.method).toBe("POST");
            const id = request.headers["x-vozeb-pro-worker-id"];
            assert.ok(typeof id === "string");
            expect([laneOneId, laneTwoId]).toContain(id);
            ordinaryIds.add(id);
            if (inputHeld) ordinaryDuringInput.add(id);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: 0, data: { claimed: 0 }, msg: "OK" }));
            return;
        }
        if (url.pathname === "/api/maintenance/billing-refunds/run") {
            expect(request.method).toBe("POST");
            expect(request.headers["x-vozeb-pro-worker-id"]).toBe(refundId);
            refundSeen = true;
            if (inputHeld) refundDuringInput = true;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: 0, data: { claimed: 0 }, msg: "OK" }));
            return;
        }
        if (url.pathname === "/api/maintenance/generation-tasks/heartbeat") {
            expect(request.method).toBe("POST");
            expect(request.headers["x-vozeb-pro-worker-id"]).toBe(workerId);
            if (inputHeld) globalHeartbeatDuringInput = true;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: 0, data: {}, msg: "OK" }));
            if (ordinaryIds.size === 2 && refundSeen) observations.emit("positive");
            return;
        }
        if (url.pathname === "/api/maintenance/image-processing/claim") {
            expect(request.method).toBe("POST");
            expect(request.headers["content-type"]).toMatch(/^application\/json(?:;|$)/i);
            assert.ok(!lease || completionSaved, "W2: image dispatcher claimed again while its only slot was occupied");
            const text = (await requestBytes(request)).toString("utf8");
            const body: unknown = JSON.parse(text);
            assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
            assert.ok("workerId" in body && typeof body.workerId === "string");
            expect(body.workerId).toBe(body.workerId.trim());
            expect(body.workerId === workerId || (body.workerId.startsWith(workerId + ":") && body.workerId.length > workerId.length + 1)).toBe(true);
            expect([laneOneId, laneTwoId, refundId]).not.toContain(body.workerId);
            const claimInput: ClaimImageProcessingInput = { workerId: body.workerId, profileVersion: profile.profileVersion, availableMemoryBytes: 1073741824, slots: 1 };
            expect(body).toStrictEqual(claimInput);
            const before = await snapshot();
            const result = await claimRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }));
            expect(result.status).toBe(200);
            expect(result.headers.get("cache-control")).toBe("no-store");
            const envelope: { code: number; data: { tasks: ClaimedImageProcessingTask[] }; msg: string } = await result.clone().json();
            expect(envelope.code).toBe(0);
            expect(envelope.msg).toBe("OK");
            if (completionSaved) {
                expect(envelope.data.tasks).toStrictEqual([]);
                expect(await snapshot()).toStrictEqual(before);
            } else {
                expect(envelope.data.tasks).toHaveLength(1);
                const actual = envelope.data.tasks[0];
                assert.ok(actual);
                expect(actual).toStrictEqual({
                    id: child.id,
                    executionId: expect.any(String),
                    leaseUntil: expect.any(Number),
                    payload: { ...child.payload, executionId: actual.executionId },
                    inputUrls: [`/api/maintenance/image-processing/${child.id}/inputs/${asset.id}`],
                });
                expect(actual.payload.resource.requiredMemoryBytes).toBe(405 * 1024 * 1024);
                lease = actual;
                identity = { workerId: claimInput.workerId, executionId: actual.executionId };
                const pending = before.rows.find((row) => row.id === child.id);
                assert.ok(pending);
                expect(await snapshot()).toStrictEqual({
                    ...before,
                    rows: [waitingParent, { ...pending, status: "running", payload: actual.payload, workerId: identity.workerId, leaseUntil: actual.leaseUntil, lastHeartbeatAt: expect.any(Number), updatedAt: expect.any(Number) }],
                });
                timeline.push("claim");
                claimReturnedAt = Date.now();
                observations.emit("claimed");
            }
            await relay(result, response);
            return;
        }
        assert.ok(lease && identity, "W2: image transport requires an actual Route claim receipt");
        if (url.pathname === `/api/maintenance/image-processing/${child.id}/inputs/${asset.id}`) {
            expect(request.method).toBe("GET");
            expect(request.headers["x-vozeb-pro-worker-id"]).toBe(identity.workerId);
            expect(request.headers["x-vozeb-pro-execution-id"]).toBe(identity.executionId);
            const before = await snapshot();
            const result = await inputRoute.GET(new Request(url, { headers: { authorization, "x-vozeb-pro-worker-id": identity.workerId, "x-vozeb-pro-execution-id": identity.executionId } }), {
                params: Promise.resolve({ id: child.id, assetId: asset.id }),
            });
            expect(result.status).toBe(200);
            expect(result.headers.get("content-type")).toBe("image/png");
            expect(result.headers.get("cache-control")).toBe("no-store");
            expect(await snapshot()).toStrictEqual(before);
            assert.ok(result.body);
            const reader = result.body.getReader();
            try {
                const first = await reader.read();
                assert.ok(!first.done && first.value.byteLength > 0);
                const chunks = [Buffer.from(first.value)];
                for (const [name, value] of result.headers) response.setHeader(name, value);
                response.writeHead(result.status);
                response.write(first.value.subarray(0, 1));
                inputHeld = true;
                timeline.push("input_first_byte");
                observations.emit("input-started");
                await releaseInput.promise;
                response.write(first.value.subarray(1));
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
        if (url.pathname === `/api/maintenance/image-processing/${child.id}/heartbeat`) {
            expect(request.method).toBe("POST");
            expect(request.headers["content-type"]).toMatch(/^application\/json(?:;|$)/i);
            const text = (await requestBytes(request)).toString("utf8");
            const body: unknown = JSON.parse(text);
            expect(body).toStrictEqual(identity);
            const before = await snapshot();
            const beforeChild = before.rows.find((row) => row.id === child.id);
            assert.ok(beforeChild);
            const startedAt = Date.now();
            const result = await heartbeatRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }), { params: Promise.resolve({ id: child.id }) });
            const endedAt = Date.now();
            expect(result.status).toBe(200);
            const envelope: { code: number; data: { leaseUntil: number; cancelRequested: boolean }; msg: string } = await result.clone().json();
            expect(envelope).toStrictEqual({ code: 0, data: { leaseUntil: expect.any(Number), cancelRequested: false }, msg: "OK" });
            expect(envelope.data.leaseUntil).toBeGreaterThanOrEqual(startedAt + 90_000);
            expect(envelope.data.leaseUntil).toBeLessThanOrEqual(endedAt + 90_000);
            expect(envelope.data.leaseUntil).toBeGreaterThan(lease.leaseUntil);
            expect(await snapshot()).toStrictEqual({ ...before, rows: [waitingParent, { ...beforeChild, leaseUntil: envelope.data.leaseUntil, lastHeartbeatAt: expect.any(Number) }] });
            await relay(result, response);
            if (inputHeld && startedAt - claimReturnedAt >= 25_000) {
                expect(ordinaryDuringInput).toStrictEqual(new Set([laneOneId, laneTwoId]));
                expect(refundDuringInput).toBe(true);
                expect(globalHeartbeatDuringInput).toBe(true);
                timeline.push("heartbeat_25s");
                observations.emit("renewed");
            }
            return;
        }
        if (url.pathname === `/api/maintenance/image-processing/${child.id}/outputs/analysis`) {
            expect(request.method).toBe("PUT");
            expect(inputReleased).toBe(true);
            expect(timeline).toContain("heartbeat_25s");
            expect(stored).toBeUndefined();
            expect(request.headers["x-vozeb-pro-worker-id"]).toBe(identity.workerId);
            expect(request.headers["x-vozeb-pro-execution-id"]).toBe(identity.executionId);
            expect(request.headers["content-type"]).toBe("image/png");
            const bytes = await requestBytes(request);
            expect(bytes).toEqual(source);
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(sourceHash);
            const before = await snapshot();
            const beforeChild = before.rows.find((row) => row.id === child.id);
            assert.ok(beforeChild);
            const result = await outputRoute.PUT(
                new Request(url, { method: "PUT", headers: { authorization, "content-type": "image/png", "x-vozeb-pro-worker-id": identity.workerId, "x-vozeb-pro-execution-id": identity.executionId }, body: new Uint8Array(bytes) }),
                { params: Promise.resolve({ id: child.id, kind: "analysis" }) },
            );
            expect(result.status).toBe(201);
            const envelope: { code: number; data: StoredImageProcessingArtifact; msg: string } = await result.clone().json();
            expect(envelope.code).toBe(0);
            expect(envelope.msg).toBe("OK");
            stored = envelope.data;
            expect(stored).toStrictEqual({ kind: "analysis", storageKey: expect.any(String), sha256: sourceHash, mimeType: "image/png", bytes: source.length, width: 24, height: 18 });
            expect(stored.storageKey).not.toBe(nativeKey);
            const saved = await references.readReferenceAsset(stored.storageKey);
            assert.ok(saved);
            analysisPath = saved.filePath;
            const registration = await registrations.getLocalMediaRegistration(stored.storageKey);
            assert.ok(registration);
            expect(registration).toMatchObject({ ownerUserId: userId, runId: run.id, taskId: child.id, scope: "reference", type: "image", mimeType: "image/png", bytes: source.length, storageProvider: "local" });
            expect(await sharp(bytes).metadata()).toMatchObject({ format: "png", width: 24, height: 18 });
            expect(await snapshot()).toStrictEqual({
                ...before,
                rows: [waitingParent, { ...beforeChild, updatedAt: expect.any(Number), resultPayload: { executionId: identity.executionId, artifacts: [stored] } }],
                media: [...before.media, registration].toSorted((left, right) => left.storageKey.localeCompare(right.storageKey)),
                analysisBytes: source,
            });
            timeline.push("upload");
            await relay(result, response);
            return;
        }
        if (url.pathname === `/api/maintenance/image-processing/${child.id}/complete`) {
            expect(request.method).toBe("POST");
            expect(request.headers["content-type"]).toMatch(/^application\/json(?:;|$)/i);
            assert.ok(stored && analysisPath);
            expect(timeline).toContain("upload");
            const text = (await requestBytes(request)).toString("utf8");
            const body: unknown = JSON.parse(text);
            assert.ok(body !== null && typeof body === "object" && "metrics" in body && body.metrics !== null && typeof body.metrics === "object");
            assert.ok("pid" in body.metrics && typeof body.metrics.pid === "number" && Number.isSafeInteger(body.metrics.pid) && body.metrics.pid > 0);
            expect(body.metrics.pid).not.toBe(workerPid);
            expect(body.metrics.pid).not.toBe(process.pid);
            // This observes closed at complete; prior supervisor checks establish close before upload.
            const childPid = body.metrics.pid;
            expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
            const before = await snapshot();
            const beforeChild = before.rows.find((row) => row.id === child.id);
            assert.ok(beforeChild);
            const startedAt = Date.now();
            const result = await completeRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }), { params: Promise.resolve({ id: child.id }) });
            const endedAt = Date.now();
            expect(result.status).toBe(200);
            // Route acceptance validates the Worker DTO before its manifest and metrics are read.
            const completion: CompleteImageProcessingInput = JSON.parse(text);
            expect(completion.workerId).toBe(identity.workerId);
            expect(completion.executionId).toBe(identity.executionId);
            expect(completion.manifest).toStrictEqual({
                jobId: child.id,
                executionId: identity.executionId,
                sourceIdentities: [{ assetId: asset.id, assetVersion: child.payload.inputs[0].assetVersion, sha256: sourceHash, bytes: source.length, mimeType: "image/png", width: 24, height: 18 }],
                artifacts: [stored],
                geometry: { sourceSize: { width: 24, height: 18 } },
            });
            expect(completion.metrics.peakRssBytes).toBeGreaterThan(0);
            expect(completion.metrics.peakHeapUsedBytes).toBeGreaterThan(0);
            expect(completion.metrics.peakExternalBytes).toBeGreaterThan(0);
            expect(completion.metrics.elapsedMs).toBeGreaterThan(0);
            expect(await result.clone().json()).toStrictEqual({ code: 0, data: { jobId: child.id, inputDigest: child.payload.inputDigest, executionId: identity.executionId, manifest: completion.manifest, parentRescheduled: true }, msg: "OK" });
            const { workerId: ownedWorker, leaseUntil, lastHeartbeatAt, nextPollAt, ...closedChild } = beforeChild;
            expect(ownedWorker).toBe(identity.workerId);
            expect(leaseUntil).toBeGreaterThan(startedAt);
            expect(lastHeartbeatAt).toBeTypeOf("number");
            expect(nextPollAt).toBeTypeOf("number");
            const { waitingFor, ...releasedProcessing } = waitingProcessing;
            expect(waitingFor).toStrictEqual({ jobId: child.id, inputDigest: child.payload.inputDigest });
            const expectedParent = {
                ...waitingParent,
                updatedAt: expect.any(Number),
                payload: {
                    ...waitingParent.payload,
                    updatedAt: expect.any(Number),
                    ecommerceSnapshot: {
                        ...waitingSnapshot,
                        referenceCheckpoint: {
                            ...waitingCheckpoint,
                            assets: [{ ...waitingReference, asset: { ...waitingReference.asset, width: 24, height: 18 }, contentSha256: sourceHash, assetVersion: referenceAssetVersion(waitingReference.asset, sourceHash) }],
                            analysisStage: { ...waitingCheckpoint.analysisStage, state: "sources_loaded" },
                        },
                        processing: { ...releasedProcessing, prepareReferences: [{ ...waitingProcessing.prepareReferences[0], manifest: completion.manifest }] },
                    },
                },
                executionPhase: "created",
                nextPollAt: expect.any(Number),
                lastUpstreamStatus: "image_processing_completed",
            };
            const expectedChild = {
                ...closedChild,
                status: "success",
                executionPhase: "completed",
                updatedAt: expect.any(Number),
                lastUpstreamStatus: "completed",
                resultPayload: { ...identity, manifest: completion.manifest, manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/), metrics: completion.metrics, parentRescheduled: true },
            };
            const after = await snapshot();
            expect(after).toStrictEqual({ ...before, rows: [expectedParent, expectedChild] });
            const awakened = after.rows.find((row) => row.id === run.id);
            assert.ok(awakened?.nextPollAt);
            expect(awakened.nextPollAt).toBeGreaterThanOrEqual(startedAt);
            expect(awakened.nextPollAt).toBeLessThanOrEqual(endedAt);
            finalSnapshot = after;
            completionSaved = true;
            timeline.push("complete");
            await relay(result, response);
            observations.emit("completed");
            return;
        }
        throw new Error("Unexpected Worker TCP path: " + url.pathname);
    }

    let tasks: typeof import("./generation-task-store");
    let runtime: typeof import("./creative-runtime-store");
    let registrations: typeof import("./local-media-registry");
    let references: typeof import("./reference-asset-store");
    let claimRoute: typeof import("@/app/api/maintenance/image-processing/claim/route");
    let inputRoute: typeof import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route");
    let heartbeatRoute: typeof import("@/app/api/maintenance/image-processing/[id]/heartbeat/route");
    let outputRoute: typeof import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route");
    let completeRoute: typeof import("@/app/api/maintenance/image-processing/[id]/complete/route");
    let profile: ReturnType<(typeof import("@/lib/image-processing/resource-config"))["imageProcessingResourceConfig"]>;
    let source: Buffer;
    let sourceHash: string;
    let nativePath: string;
    let nativeKey: string;
    let conversation: Awaited<ReturnType<typeof runtime.createCreativeConversation>>;
    let run: AgentRun;
    let asset: Awaited<ReturnType<typeof runtime.registerCreativeAssets>>[number];
    let child: Awaited<ReturnType<(typeof import("./image-processing-service"))["enqueueImageProcessingTask"]>>;
    let waitingParent: NonNullable<Awaited<ReturnType<typeof tasks.getStoredGenerationTaskRecord>>>;
    let waitingRun: AgentRun;
    let waitingSnapshot: NonNullable<AgentRun["ecommerceSnapshot"]>;
    let waitingCheckpoint: NonNullable<typeof waitingSnapshot.referenceCheckpoint>;
    let waitingReference: (typeof waitingCheckpoint.assets)[number];
    let waitingProcessing: NonNullable<typeof waitingSnapshot.processing>;
    let referenceAssetVersion: (typeof import("./ecommerce-reference-recovery"))["referenceAssetVersion"];
    try {
        const workerScript = fileURLToPath(new URL("../../../scripts/generation-worker.mjs", import.meta.url));
        const childEntry = fileURLToPath(new URL("../../../.image-processing-runtime/workers/image-processing-child.mjs", import.meta.url));
        const childStat = await stat(childEntry).catch((error: unknown) => {
            throw new Error("SETUP: build the existing image-processing child runtime before W2", { cause: error });
        });
        assert.ok(childStat.isFile(), "SETUP: compiled image-processing child must be a file");
        [tasks, runtime, registrations, references, claimRoute, inputRoute, heartbeatRoute, outputRoute, completeRoute] = await Promise.all([
            import("./generation-task-store"),
            import("./creative-runtime-store"),
            import("./local-media-registry"),
            import("./reference-asset-store"),
            import("@/app/api/maintenance/image-processing/claim/route"),
            import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route"),
            import("@/app/api/maintenance/image-processing/[id]/heartbeat/route"),
            import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route"),
            import("@/app/api/maintenance/image-processing/[id]/complete/route"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        assert.equal((await getObjectStorageRuntimeConfig()).enabled, false, "SETUP: W2 requires isolated local media storage");
        const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
        profile = imageProcessingResourceConfig(process.env);
        expect(profile).toMatchObject({ budgetBytes: 1073741824, processHeapMb: 384, concurrency: 1 });
        const probe = await claimRoute.POST(
            new Request("http://fixture.invalid/api/maintenance/image-processing/claim", {
                method: "POST",
                headers: { authorization: "Bearer " + workerToken, "content-type": "application/json" },
                body: JSON.stringify({ workerId, profileVersion: profile.profileVersion, availableMemoryBytes: 1073741824, slots: 1 }),
            }),
        );
        expect(probe.status).toBe(200);
        expect(await probe.json()).toStrictEqual({ code: 0, data: { tasks: [] }, msg: "OK" });
        source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#8a6243" } })
            .png()
            .toBuffer();
        sourceHash = createHash("sha256").update(source).digest("hex");
        conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const original = await references.writeReferenceImageDataUrl(`data:image/png;base64,${source.toString("base64")}`, { ownerUserId: userId, conversationId: conversation.id, source: "fixture-worker-prepare" });
        nativeKey = original.token;
        const saved = await references.readReferenceAsset(nativeKey);
        assert.ok(saved);
        nativePath = saved.filePath;
        const [registeredAsset] = await runtime.registerCreativeAssets([
            {
                id: "fixture-reference-" + randomUUID(),
                userId,
                conversationId: conversation.id,
                ordinal: 0,
                type: "image",
                title: "reference.png",
                sourceRunId: "fixture-upload-" + randomUUID(),
                serverUrl: "/api/reference-assets/" + nativeKey,
                metadata: {},
            },
        ]);
        assert.ok(registeredAsset);
        asset = registeredAsset;
        const now = Date.now();
        const parentExecutionId = randomUUID();
        run = {
            id: "agent-fixture-" + randomUUID(),
            userId,
            conversationId: conversation.id,
            clientRequestId: randomUUID(),
            surface: "chat",
            inputMessageId: "message-" + randomUUID(),
            assistantMessageId: "message-" + randomUUID(),
            prompt: "Prepare the registered reference through the real Worker",
            referencedAssetIds: [asset.id],
            assetIds: [],
            status: "running",
            executionId: parentExecutionId,
            tasks: [],
            reviewed: false,
            createdAt: now,
            updatedAt: now,
        };
        const { buildEcommercePlanningInput } = await import("./ecommerce-generation-snapshot");
        const recovery = await import("./ecommerce-reference-recovery");
        referenceAssetVersion = recovery.referenceAssetVersion;
        const checkpoint = recovery.createEcommerceReferenceCheckpoint(run, buildEcommercePlanningInput(run, [asset], { summary: "", recentMessages: [] }), [asset]);
        run.ecommerceSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            input: { userRequest: run.prompt, assetIds: [asset.id], conversationId: conversation.id, surface: "chat" },
            referenceCheckpoint: checkpoint,
            createdAt: now,
            runId: run.id,
            userId,
        };
        await runtime.createCreativeRunBundle(userId, { run, conversationId: conversation.id, title: "Worker prepare fixture", prompt: run.prompt, assetIds: [asset.id], ttlMs: 365 * 24 * 60 * 60 * 1000 });
        const scheduler = await import("./generation-task-scheduler");
        assert.ok(await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: now }));
        expect((await scheduler.claimDueGenerationTasks({ workerId: "fixture-parent-worker", taskIds: [run.id], limit: 1 })).map((task) => task.id)).toStrictEqual([run.id]);
        const service = await import("./image-processing-service");
        const checkpointInput = checkpoint.assets[0];
        assert.ok(checkpointInput);
        child = await service.enqueueImageProcessingTask({
            runId: run.id,
            parentExecutionId,
            algorithmVersion: "reference-input-policy.v1",
            operation: "prepare_reference",
            inputs: [{ assetId: asset.id, assetVersion: checkpointInput.assetVersion }],
            options: {},
        });
        const parentRow = await tasks.getStoredGenerationTaskRecord("agent", run.id);
        const parentRun = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
        assert.ok(parentRow && parentRun?.ecommerceSnapshot?.referenceCheckpoint && parentRun.ecommerceSnapshot.processing);
        waitingParent = parentRow;
        waitingRun = parentRun;
        waitingSnapshot = parentRun.ecommerceSnapshot;
        waitingCheckpoint = parentRun.ecommerceSnapshot.referenceCheckpoint;
        waitingProcessing = parentRun.ecommerceSnapshot.processing;
        const reference = waitingCheckpoint.assets[0];
        assert.ok(reference);
        waitingReference = reference;
        expect(waitingProcessing.waitingFor).toStrictEqual({ jobId: child.id, inputDigest: child.payload.inputDigest });
        expect(waitingProcessing.prepareReferences).toStrictEqual([{ jobId: child.id, inputDigest: child.payload.inputDigest, assetId: asset.id, assetVersion: checkpointInput.assetVersion }]);
        expect(waitingParent.workerId).toBeUndefined();
        expect(waitingParent.leaseUntil).toBeUndefined();
        expect(waitingParent.nextPollAt).toBeUndefined();
        expect(waitingRun.executionId).toBeUndefined();
        const beforeWorker = await snapshot();
        expect(beforeWorker.rows).toHaveLength(2);
        expect(beforeWorker.media).toHaveLength(1);
        expect(beforeWorker.sourceBytes).toEqual(source);
        const pending = beforeWorker.rows.find((row) => row.id === child.id);
        assert.ok(pending);
        expect(pending).toMatchObject({ status: "pending", type: "image_processing", runId: run.id, payload: { operation: "prepare_reference", inputs: [{ assetId: asset.id, assetVersion: checkpointInput.assetVersion, expectedSha256: sourceHash }] } });

        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        server.on("error", (error) => observations.emit("failure", error));
        const address = server.address();
        assert.ok(address !== null && typeof address !== "string");
        origin = "http://127.0.0.1:" + address.port;
        const worker = spawn(process.execPath, ["--max-old-space-size=64", workerScript], {
            cwd: path.dirname(path.dirname(workerScript)),
            env: { ...process.env, VOZEB_PRO_WORKER_API_ORIGIN: origin, VOZEB_PRO_GENERATION_WORKER_ID: workerId, VOZEB_PRO_GENERATION_WORKER_LANES: "2", VOZEB_PRO_GENERATION_WORKER_HEARTBEAT_MS: "5000" },
            stdio: "pipe",
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            worker.once("error", (error) => reject(new Error("SETUP: real Worker could not start", { cause: error })));
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
        });
        const unexpectedExit = closed.then((exit) => {
            throw new Error(diagnostics("SETUP: real Worker exited before W2 completed: " + JSON.stringify(exit)));
        });
        const guarded = (event: Promise<unknown>) => Promise.race([event, fixtureFailure, unexpectedExit]);
        try {
            assert.ok(workerPid, "SETUP: actual Worker has no process identity");
            assert.ok(await arrivedBefore(guarded(startupSignal), 20_000), diagnostics("SETUP: authenticated ordinary/refund requests and global heartbeat are required before W2"));
            expect(stderr, diagnostics("SETUP: Worker startup error")).toBe("");
            const reached = await arrivedBefore(guarded(claimed), 10_000);
            try {
                expect(reached, diagnostics("W2: real pending prepare_reference was not claimed by the actual Worker over TCP")).toBe(true);
            } catch (error) {
                expect(await snapshot()).toStrictEqual(beforeWorker);
                throw error;
            }
            expect(await arrivedBefore(guarded(inputStarted), 10_000), diagnostics("W2: actual Worker did not start the bound original input stream")).toBe(true);
            expect(await arrivedBefore(guarded(renewed), 45_000), diagnostics("W2: occupied input stream did not receive the real 25s job heartbeat and lease renewal")).toBe(true);
            expect(inputHeld).toBe(true);
            expect(stored).toBeUndefined();
            releaseInput.resolve();
            expect(await arrivedBefore(guarded(completed), 30_000), diagnostics("W2: real child analysis upload and complete did not reach original parent wake")).toBe(true);
            assert.ok(finalSnapshot);
            expect(await snapshot()).toStrictEqual(finalSnapshot);
            expect(stderr, diagnostics("Worker transport failed during W2")).toBe("");
        } finally {
            if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
            releaseInput.resolve();
            const exited = await arrivedBefore(closed, 15_000);
            if (!exited) {
                worker.kill("SIGKILL");
                await closed;
                throw new Error(diagnostics("CLEANUP: real Worker required SIGKILL; this is not valid W2 business RED"));
            }
            expect(await closed, diagnostics("CLEANUP: real Worker did not stop normally")).toStrictEqual({ code: 0, signal: null });
            await Promise.all([...requests]);
            expect(await registrations.getLocalMediaRegistration(nativeKey)).toStrictEqual(beforeWorker.media[0]);
            expect(await readFile(nativePath)).toEqual(source);
            if (stored && analysisPath) expect(await readFile(analysisPath)).toEqual(source);
            if (finalSnapshot) expect(await snapshot()).toStrictEqual(finalSnapshot);
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
