import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImageTask } from "./image-task-store";

describe("File user recovery while a sealed native result waits for local processing", () => {
    let directory: string;
    let userId: string;
    let source: Buffer;
    let imageTasks: typeof import("./image-task-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let registrations: typeof import("./local-media-registry");
    let media: typeof import("./local-media-storage");
    let capture: typeof import("./image-task-native-capture");
    let processing: typeof import("./image-task-result-processing");
    let userRecovery: typeof import("./generation-task-user-recovery");
    const workerA = "fixture-native-user-recovery-original-worker";
    const upstreamId = "fixture-native-user-recovery-upstream-id";
    const queryPath = "/native-query/{taskId}";
    const model = "fixture-native-user-recovery-model";

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-native-user-recovery-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-native-user-recovery-worker-token-0001");
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-native-user-recovery-maintenance-token-0001");
        const { isWorkerTokenConfigured } = await import("./maintenance-auth");
        assert.ok(isWorkerTokenConfigured(), "Native user recovery fixture requires an independent worker token");
        [imageTasks, tasks, scheduler, registrations, media, capture, processing, userRecovery] = await Promise.all([
            import("./image-task-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./local-media-registry"),
            import("./local-media-storage"),
            import("./image-task-native-capture"),
            import("./image-task-result-processing"),
            import("./generation-task-user-recovery"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated native user recovery fixture requires local media storage");
        userId = `fixture-native-user-recovery-${randomUUID()}`;
        source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 24, g: 48, b: 72 } } })
            .png()
            .toBuffer();
    }, 30_000);

    afterAll(async () => {
        try {
            if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    async function snapshot(taskId: string) {
        return tasks.withGenerationTaskFileMutation(async (records) => {
            const image = records.find((record) => record.type === "image" && record.id === taskId);
            assert.ok(image);
            const children = records.filter((record) => record.type === "image_processing" && record.parentTaskId === taskId);
            return { tasks: records, result: { image, children } };
        });
    }

    async function nativeRegistrations(taskId: string) {
        return (await registrations.listFileLocalMediaRegistrations()).filter((registration) => registration.ownerUserId === userId && registration.taskId === taskId);
    }

    async function nativeUpstream() {
        const server = createServer();
        const sockets = new Set<Socket>();
        const responses = new Set<ServerResponse>();
        const operations: Promise<unknown>[] = [];
        const requests: string[] = [];
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
        });
        server.on("request", (request, response) => {
            requests.push(`${request.method} ${request.url}`);
            responses.add(response);
            response.once("close", () => responses.delete(response));
            if (request.method === "GET" && request.url === "/native.png") {
                response.writeHead(200, { "content-type": "image/png" });
                response.end(source);
                return;
            }
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "Unexpected request after native sealing" } }));
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
        const origin = `http://127.0.0.1:${address.port}`;
        return {
            origin,
            nativeUrl: `${origin}/native.png`,
            operations,
            requests,
            async close() {
                responses.forEach((response) => response.destroy());
                sockets.forEach((socket) => socket.destroy());
                await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
                await Promise.allSettled(operations);
            },
        };
    }

    it("keeps the same pending local result child when the user checks the original task", async () => {
        const upstream = await nativeUpstream();
        try {
            const advancedConfig = {
                protocol: "openai",
                authMode: "bearer",
                textModel: "",
                imageModel: model,
                videoModel: "",
                createPath: "/images/generations",
                queryPath,
                requestTemplate: "",
                resultField: "",
                statusField: "",
                durationRange: "",
                referenceRule: "",
                supportsReferenceImage: false,
                supportsReferenceVideo: false,
                supportsReferenceAudio: false,
            } satisfies NonNullable<ImageTask["config"]["advancedConfig"]>;
            // The saved upstream identity exists before the original claim and native binding.
            const created = await imageTasks.createImageTask({
                userId,
                username: "fixture-native-user-recovery",
                displayName: "Isolated native user recovery fixture",
                kind: "generation",
                source: "image-workbench",
                config: { baseUrl: upstream.origin, apiKey: "fixture-only-native-user-recovery", apiFormat: "openai", model, outputBackground: "opaque", advancedConfig },
                prompt: "Keep the sealed native result waiting on its existing local child",
                references: [],
                attemptNo: 1,
                attempts: [],
                upstream: { id: upstreamId, mediaBaseUrl: upstream.origin, pollBaseUrl: upstream.origin, explicitPollUrl: queryPath },
            });
            assert.ok(await imageTasks.transitionImageTask(created, ["pending"], { status: "running" }));
            assert.ok(
                await scheduler.scheduleGenerationTask("image", created.id, {
                    executionPhase: "polling",
                    upstreamTaskId: upstreamId,
                    channelId: created.config.channelId,
                    provider: created.config.advancedConfig?.protocol || created.config.apiFormat,
                    queryPath,
                    submittedAt: created.createdAt,
                    nextPollAt: Date.now() - 1,
                }),
            );
            const claimed = await scheduler.claimDueGenerationTasks({ workerId: workerA, taskIds: [created.id], limit: 1 });
            assert.equal(claimed.length, 1);
            const leaseA = claimed[0];
            assert.ok(leaseA?.executionId);
            const original = await snapshot(created.id);
            expect(original.image).toMatchObject({ workerId: workerA, upstreamTaskId: upstreamId, payload: { executionId: leaseA.executionId, attemptNo: 1, upstream: { id: upstreamId } } });
            expect(original.image.runId).toBeUndefined();
            expect(original.image.payload.billing).toBeUndefined();
            expect(original.children).toEqual([]);

            const capturing = capture.captureImageTaskNativeResults({
                taskId: created.id,
                workerId: workerA,
                executionId: leaseA.executionId,
                attemptNo: 1,
                upstreamTaskId: upstreamId,
                result: { dataUrl: upstream.nativeUrl },
                origin: upstream.origin,
                authContext: "",
            });
            upstream.operations.push(capturing);
            const captured = await capturing;
            assert.ok(captured.state === "native_ready");
            expect(captured.nativeResults).toMatchObject({ version: "image-task-native-results.v1", attemptNo: 1, upstreamTaskId: upstreamId });
            expect(captured.nativeResults.slots).toHaveLength(1);
            const slot = captured.nativeResults.slots[0];
            assert.ok(slot?.status === "stored");
            expect(slot).toMatchObject({
                resultId: `${created.id}:1`,
                resultIndex: 1,
                bytes: 95,
                sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6",
                layout: { format: "png", depth: "uchar", channels: 3 },
            });
            expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({
                storageKey: slot.storageKey,
                ownerUserId: userId,
                taskId: created.id,
                scope: "reference",
                storageClass: "permanent",
                type: "attachment",
                source: "image-task-native-result",
                storageProvider: "local",
                mimeType: "application/octet-stream",
                bytes: 95,
            });
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(source);
            const sealed = await snapshot(created.id);
            expect(sealed.image.payload.nativeResults).toEqual(captured.nativeResults);
            expect(sealed.image.payload.resultProcessing).toBeUndefined();
            expect(sealed.children).toEqual([]);

            expect(await processing.ensureImageTaskResultProcessing({ taskId: created.id, workerId: workerA, executionId: leaseA.executionId })).toEqual({ state: "waiting" });
            const before = await snapshot(created.id);
            const taskBefore = await imageTasks.getImageTask(created.id);
            assert.ok(taskBefore?.upstream);
            const upstreamTaskId = taskBefore.upstream.id || before.image.upstreamTaskId;
            assert.ok(upstreamTaskId);
            const registrationsBefore = await nativeRegistrations(created.id);
            const bytesBefore = await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey));
            expect(before.image).toMatchObject({ status: "running", executionPhase: "persisting", upstreamTaskId: upstreamId, lastUpstreamStatus: "image_processing_waiting" });
            expect(before.image.nextPollAt).toBeUndefined();
            expect(before.image.workerId).toBeUndefined();
            expect(before.image.leaseUntil).toBeUndefined();
            expect(before.image.lastHeartbeatAt).toBeUndefined();
            expect(before.image.payload.executionId).toBeUndefined();
            expect(before.image.resultPayload?.url).toBeUndefined();
            expect(before.image.payload.result).toBeUndefined();
            expect(before.image.payload.nativeResults).toEqual(sealed.image.payload.nativeResults);
            expect(before.image.payload.billing).toBeUndefined();
            expect(before.children).toHaveLength(1);
            const child = before.children[0];
            assert.ok(child);
            expect(child).toMatchObject({
                type: "image_processing",
                userId,
                parentTaskId: created.id,
                status: "pending",
                executionPhase: "created",
                attemptNo: 0,
                clientRequestId: child.payload.inputDigest,
                payload: {
                    version: "image-processing.v1",
                    operation: "process_result",
                    algorithmVersion: "image-task-result-processing.v1",
                    imageResultBinding: { imageTaskId: created.id, userId, nativeResults: sealed.image.payload.nativeResults },
                },
            });
            expect(child.id).toMatch(/^image-process-[a-f0-9]{64}$/);
            expect(child.id).toBe(`image-process-${child.payload.inputDigest}`);
            expect(child.runId).toBeUndefined();
            expect(child.workerId).toBeUndefined();
            expect(child.nextPollAt).toBeTypeOf("number");
            expect(child.payload.inputs).toEqual([{ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6" }]);
            expect(child.payload.sources).toEqual([{ inputIndex: 0, scope: "reference", storageKey: slot.storageKey, storageProvider: "local" }]);
            expect(child.payload.options).toEqual({ mode: "ordinary", results: [{ resultId: `${created.id}:1`, resultIndex: 1, inputIndex: 0 }], transparentBackground: false });
            expect(before.image.payload.resultProcessing).toEqual({ jobId: child.id, inputDigest: child.payload.inputDigest });
            expect(taskBefore).toMatchObject({ status: "running", executionPhase: "persisting", lastUpstreamStatus: "image_processing_waiting" });
            expect(taskBefore.reviewReason).toBeUndefined();
            expect(registrationsBefore).toHaveLength(1);
            expect(bytesBefore).toEqual(source);
            expect(upstream.requests).toEqual(["GET /native.png"]);
            const networkBefore = upstream.requests.slice();

            // Use the actual Route inputs; the service owns its real batch and next image claim.
            const checking = userRecovery.recoverGenerationTaskFromUpstream({
                type: "image",
                id: taskBefore.id,
                upstreamTaskId,
                channelId: taskBefore.config.channelId,
                provider: taskBefore.config.advancedConfig?.protocol || taskBefore.config.apiFormat,
                queryPath: taskBefore.upstream.explicitPollUrl || before.image.queryPath || taskBefore.config.advancedConfig?.queryPath,
                submittedAt: before.image.submittedAt || taskBefore.createdAt,
                origin: upstream.origin,
                publicOrigin: upstream.origin,
                cookie: "",
            });
            upstream.operations.push(checking);
            const settlements = await Promise.allSettled([checking]);
            const after = await snapshot(created.id);
            const taskAfter = await imageTasks.getImageTask(created.id);
            const registrationsAfter = await nativeRegistrations(created.id);
            const bytesAfter = await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey));
            const requestsAfter = upstream.requests.slice();

            // Collect the complete post-state before one assertion exposes phase, state and HTTP differences.
            expect({ settlements, snapshot: after, task: taskAfter, registrations: registrationsAfter, bytes: bytesAfter, requests: requestsAfter }).toEqual({
                settlements: [{ status: "fulfilled", value: true }],
                snapshot: {
                    image: { ...before.image, updatedAt: expect.any(Number), payload: { ...before.image.payload, updatedAt: expect.any(Number) } },
                    children: before.children,
                },
                task: { ...taskBefore, updatedAt: expect.any(Number) },
                registrations: registrationsBefore,
                bytes: bytesBefore,
                requests: networkBefore,
            });
        } finally {
            await upstream.close();
        }
    }, 30_000);
});
