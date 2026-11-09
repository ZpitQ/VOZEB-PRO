import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImageTask } from "./image-task-store";

describe("File user recovery after native sealing and during a live owner", () => {
    let directory: string;
    let userId: string;
    let source: Buffer;
    let imageTasks: typeof import("./image-task-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let capture: typeof import("./image-task-native-capture");
    let processing: typeof import("./image-task-result-processing");
    let registrations: typeof import("./local-media-registry");
    let media: typeof import("./local-media-storage");
    let userRecovery: typeof import("./generation-task-user-recovery");
    let outbound: typeof import("./safe-outbound-fetch");
    const workerId = "fixture-native-seal-owner-worker";
    const upstreamId = "fixture-native-seal-owner-upstream";
    const channelId = "fixture-native-seal-owner-channel";
    const apiKey = "fixture-only-native-seal-owner-api-key";
    const queryPath = "/fixture-native-owner-query/{taskId}";
    const advancedConfig = {
        protocol: "openai",
        authMode: "bearer",
        textModel: "",
        imageModel: "fixture-native-seal-owner-model",
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

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-native-seal-owner-"));
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
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-native-seal-owner-worker-token-0001");
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-native-seal-owner-maintenance-token-0001");
        const { isWorkerTokenConfigured } = await import("./maintenance-auth");
        assert.ok(isWorkerTokenConfigured(), "Fixture requires an independent configured Worker token");
        [imageTasks, tasks, scheduler, capture, processing, registrations, media, userRecovery, outbound] = await Promise.all([
            import("./image-task-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./image-task-native-capture"),
            import("./image-task-result-processing"),
            import("./local-media-registry"),
            import("./local-media-storage"),
            import("./generation-task-user-recovery"),
            import("./safe-outbound-fetch"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated native seal fixture requires local media storage");
        userId = `fixture-native-seal-owner-${randomUUID()}`;
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

    async function createRunningImage(origin: string) {
        const created = await imageTasks.createImageTask({
            userId,
            username: "fixture-native-seal-owner",
            displayName: "Isolated native seal and owner fixture",
            kind: "generation",
            source: "image-workbench",
            config: { apiSource: "custom", baseUrl: origin, apiKey, apiFormat: "openai", channelId, model: advancedConfig.imageModel, outputBackground: "opaque", advancedConfig },
            prompt: "Preserve native sealing and the current image owner during a user check",
            references: [],
            attemptNo: 1,
            attempts: [],
            upstream: { id: upstreamId, mediaBaseUrl: origin, pollBaseUrl: origin, explicitPollUrl: queryPath },
        });
        assert.ok(await imageTasks.transitionImageTask(created, ["pending"], { status: "running" }));
        assert.ok(await scheduler.scheduleGenerationTask("image", created.id, { executionPhase: "polling", upstreamTaskId: upstreamId, channelId, provider: "openai", queryPath, submittedAt: created.createdAt, nextPollAt: 1 }));
        return created;
    }

    async function snapshot(taskId: string) {
        return tasks.withGenerationTaskFileMutation(async (records) => {
            const image = records.find((record) => record.type === "image" && record.id === taskId);
            assert.ok(image);
            return { tasks: records, result: { image, children: records.filter((record) => record.type === "image_processing" && record.parentTaskId === taskId) } };
        });
    }

    async function nativeState(taskId: string, storageKey: string) {
        return {
            ...(await snapshot(taskId)),
            registrations: (await registrations.listFileLocalMediaRegistrations()).filter((record) => record.ownerUserId === userId && record.taskId === taskId),
            bytes: await readFile(path.join(media.REFERENCE_MEDIA_ROOT, storageKey)),
        };
    }

    async function queryFixture() {
        const requests: string[] = [];
        const sockets = new Set<Socket>();
        const server = createServer((request, response) => {
            requests.push(`${request.method} ${request.url}`);
            response.setHeader("connection", "close");
            if (request.headers.authorization !== `Bearer ${apiKey}`) {
                response.writeHead(401, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "Fixture API credential missing" }));
                return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: upstreamId, status: "processing" }));
        });
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
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
        return {
            origin: `http://127.0.0.1:${address.port}`,
            requests,
            async close() {
                sockets.forEach((socket) => socket.destroy());
                await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
            },
        };
    }

    it("keeps a real sealed child against old and current fallback observations and ignores replacement upstream metadata", async () => {
        const origin = "https://fixture.invalid";
        const created = await createRunningImage(origin);
        const observed = await snapshot(created.id);
        expect(observed.children).toEqual([]);
        expect(observed.image.payload.nativeResults).toBeUndefined();
        const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [created.id], limit: 1 });
        assert.equal(claimed.length, 1);
        const lease = claimed[0];
        assert.ok(lease?.workerId);
        assert.ok(lease.executionId);
        const captured = await capture.captureImageTaskNativeResults({
            taskId: created.id,
            workerId: lease.workerId,
            executionId: lease.executionId,
            attemptNo: 1,
            upstreamTaskId: upstreamId,
            result: { dataUrl: `data:image/png;base64,${source.toString("base64")}` },
            origin,
            authContext: "",
        });
        assert.ok(captured.state === "native_ready");
        expect(captured.nativeResults.slots).toHaveLength(1);
        const slot = captured.nativeResults.slots[0];
        assert.ok(slot?.status === "stored");
        expect(slot).toMatchObject({ bytes: 95, sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6" });
        expect(await processing.ensureImageTaskResultProcessing({ taskId: created.id, workerId: lease.workerId, executionId: lease.executionId })).toEqual({ state: "waiting" });
        const before = await nativeState(created.id, slot.storageKey);
        expect(before.image).toMatchObject({ status: "running", executionPhase: "persisting", upstreamTaskId: upstreamId, channelId, provider: "openai", queryPath, submittedAt: created.createdAt, lastUpstreamStatus: "image_processing_waiting" });
        // Capture retains optional undefined fields that the File JSON boundary omits.
        expect(before.image.payload.nativeResults).toEqual(captured.nativeResults);
        expect(before.image.payload.executionId).toBeUndefined();
        expect(before.image.workerId).toBeUndefined();
        expect(before.image.leaseUntil).toBeUndefined();
        expect(before.image.lastHeartbeatAt).toBeUndefined();
        expect(before.image.nextPollAt).toBeUndefined();
        expect(before.children).toHaveLength(1);
        const child = before.children[0];
        assert.ok(child);
        expect(child).toMatchObject({
            type: "image_processing",
            status: "pending",
            userId,
            parentTaskId: created.id,
            payload: { operation: "process_result" },
        });
        expect(child.payload.imageResultBinding).toStrictEqual({ imageTaskId: created.id, userId, nativeResults: before.image.payload.nativeResults });
        expect(before.image.payload.resultProcessing).toStrictEqual({ jobId: child.id, inputDigest: child.payload.inputDigest });
        expect(before.registrations).toHaveLength(1);
        expect(before.registrations[0]).toMatchObject({ ownerUserId: userId, taskId: created.id, scope: "reference", storageProvider: "local", bytes: 95 });
        expect(before.bytes).toEqual(source);

        expect(await scheduler.markImageTaskUserCheckPending(observed.image, "Stale user fallback")).toBeNull();
        expect(await nativeState(created.id, slot.storageKey)).toStrictEqual(before);
        expect(await scheduler.markImageTaskUserCheckPending(before.image, "Current user fallback")).toBeNull();
        expect(await nativeState(created.id, slot.storageKey)).toStrictEqual(before);

        const startedAt = Date.now();
        const rearmed = await scheduler.rearmImageTaskForUser({
            id: created.id,
            upstreamTaskId: "replacement-upstream",
            channelId: "replacement-channel",
            provider: "replacement-provider",
            queryPath: "/replacement-query/{taskId}",
            submittedAt: 1_600_000_000_000,
        });
        assert.ok(rearmed);
        expect(rearmed.executionPhase).toBe("persisting");
        expect(rearmed.nextPollAt).toBeGreaterThanOrEqual(startedAt);
        expect(rearmed.nextPollAt).toBeLessThanOrEqual(Date.now());
        expect(await nativeState(created.id, slot.storageKey)).toStrictEqual({ ...before, image: { ...before.image, nextPollAt: rearmed.nextPollAt } });
    }, 30_000);

    it("returns false from the real user service while preserving the current owner and issuing no query", async () => {
        const fixture = await queryFixture();
        try {
            // Prove the production outbound path accepts this private host before checking for no query.
            const preflight = await outbound.fetchSafeOutbound(`${fixture.origin}/fixture-ready`, { headers: { authorization: `Bearer ${apiKey}` } });
            expect(preflight.status).toBe(200);
            await preflight.arrayBuffer();
            expect(fixture.requests).toEqual(["GET /fixture-ready"]);
            const created = await createRunningImage(fixture.origin);
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [created.id], limit: 1 });
            assert.equal(claimed.length, 1);
            const lease = claimed[0];
            assert.ok(lease?.executionId);
            const before = await snapshot(created.id);
            expect(before.image).toMatchObject({ status: "running", executionPhase: "polling", workerId, upstreamTaskId: upstreamId, payload: { executionId: lease.executionId, upstream: { id: upstreamId } } });
            expect(before.image.leaseUntil).toBeGreaterThan(Date.now());
            expect(before.image.expiresAt).toBeGreaterThan(Date.now());
            expect(before.children).toEqual([]);

            expect(
                await userRecovery.recoverGenerationTaskFromUpstream({
                    type: "image",
                    id: created.id,
                    upstreamTaskId: upstreamId,
                    channelId,
                    provider: "openai",
                    queryPath,
                    submittedAt: created.createdAt,
                    origin: fixture.origin,
                    publicOrigin: fixture.origin,
                    cookie: "",
                }),
            ).toBe(false);
            expect(await snapshot(created.id)).toStrictEqual(before);
            expect(fixture.requests).toEqual(["GET /fixture-ready"]);
        } finally {
            await fixture.close();
        }
    }, 30_000);
});
