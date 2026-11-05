import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImageTask } from "./image-task-store";

type StoredNativeSlot = Extract<NonNullable<ImageTask["nativeResults"]>["slots"][number], { status: "stored" }>;

describe("OpenAI native query slots through real create HTTP and File collector", () => {
    let directory: string;
    let userId: string;
    let source: Buffer;
    let imageTasks: typeof import("./image-task-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let registrations: typeof import("./local-media-registry");
    let media: typeof import("./local-media-storage");
    let nativeCapture: typeof import("./image-task-native-capture");
    let openai: typeof import("@/app/api/image-tasks/image-task-openai");
    const workerId = "fixture-openai-native-query-worker";
    const model = "fixture-openai-native-query-model";
    const apiKey = "fixture-only-openai-native-query";
    const prompt = "Preserve the declared OpenAI query result slots";
    const upstreamId = "fixture-openai-native-query-id";

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-openai-native-query-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        [imageTasks, tasks, scheduler, registrations, media, nativeCapture, openai] = await Promise.all([
            import("./image-task-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./local-media-registry"),
            import("./local-media-storage"),
            import("./image-task-native-capture"),
            import("@/app/api/image-tasks/image-task-openai"),
        ]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated OpenAI native query fixture requires local media storage");
        userId = `fixture-openai-native-query-${randomUUID()}`;
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

    async function imageRecord(id: string) {
        const record = await tasks.getStoredGenerationTaskRecord("image", id);
        assert.ok(record);
        return record;
    }

    async function claimImage(baseUrl: string) {
        const advancedConfig = {
            protocol: "openai",
            authMode: "bearer",
            textModel: "",
            imageModel: model,
            videoModel: "",
            createPath: "/images/generations",
            queryPath: "/native-query/{taskId}",
            requestTemplate: "",
            resultField: "",
            statusField: "",
            durationRange: "",
            referenceRule: "",
            supportsReferenceImage: false,
            supportsReferenceVideo: false,
            supportsReferenceAudio: false,
        } satisfies NonNullable<ImageTask["config"]["advancedConfig"]>;
        const created = await imageTasks.createImageTask({
            userId,
            username: "fixture-openai-native-query",
            displayName: "Isolated OpenAI native query fixture",
            kind: "generation",
            source: "image-workbench",
            config: { baseUrl, apiKey, apiFormat: "openai", model, advancedConfig },
            prompt,
            references: [],
            attemptNo: 1,
        });
        assert.ok(await imageTasks.transitionImageTask(created, ["pending"], { status: "running" }));
        await scheduler.scheduleGenerationTask("image", created.id, { executionPhase: "created", nextPollAt: Date.now() - 1 });
        const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [created.id], limit: 1 });
        assert.equal(claimed.length, 1);
        const lease = claimed[0];
        assert.ok(lease?.executionId);
        const task = await imageTasks.getImageTask(created.id);
        assert.ok(task);
        expect(task.executionId).toBe(lease.executionId);
        const record = await imageRecord(task.id);
        expect(record.runId).toBeUndefined();
        expect(record.payload.runId).toBeUndefined();
        expect(record.upstreamTaskId).toBeUndefined();
        expect(record.payload.upstream).toBeUndefined();
        expect(record.payload.billing).toBeUndefined();
        expect(record.leaseUntil).toBeGreaterThan(Date.now());
        return { task, claim: { taskId: task.id, workerId, executionId: lease.executionId, attemptNo: 1, upstreamTaskId: null } };
    }

    async function expectStoredSlot(slot: StoredNativeSlot, taskId: string) {
        expect(slot).toMatchObject({ sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6", bytes: 95 });
        expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({
            storageKey: slot.storageKey,
            ownerUserId: userId,
            taskId,
            scope: "reference",
            storageClass: "permanent",
            type: "attachment",
            source: "image-task-native-result",
            storageProvider: "local",
            bytes: 95,
        });
        expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(source);
    }

    async function readRequestJson(request: IncomingMessage): Promise<unknown> {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }

    function requestBeforeTerminal<T>(request: Promise<T>, operation: Promise<unknown>, stage: string) {
        return Promise.race([
            request,
            operation.then(() => {
                throw new Error(`OpenAI query fixture operation settled before ${stage}`);
            }),
        ]);
    }

    async function openAiUpstream() {
        const server = createServer();
        const sockets = new Set<Socket>();
        const responses = new Set<ServerResponse>();
        const operations: Promise<unknown>[] = [];
        const unexpected: string[] = [];
        let createCount = 0;
        let queryCount = 0;
        let mediaCount = 0;
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
        });
        server.on("request", (request, response) => {
            responses.add(response);
            response.once("close", () => responses.delete(response));
            if (request.method === "POST" && request.url === "/v1/images/generations") {
                createCount++;
                if (createCount === 1) return;
            } else if (request.method === "GET" && request.url === `/v1/native-query/${upstreamId}`) {
                queryCount++;
                if (queryCount === 1) return;
            } else if (request.method === "GET" && request.url === "/native.png") {
                mediaCount++;
                response.writeHead(200, { "content-type": "image/png" });
                response.end(source);
                return;
            }
            unexpected.push(`${request.method} ${request.url}`);
            response.writeHead(404);
            response.end();
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
            unexpected,
            counts() {
                return { create: createCount, query: queryCount, media: mediaCount };
            },
            nextRequest() {
                return new Promise<{ request: IncomingMessage; respond: (payload: unknown) => void }>((resolve, reject) => {
                    const onRequest = (request: IncomingMessage, response: ServerResponse) => {
                        server.off("close", onClose);
                        resolve({
                            request,
                            respond(payload) {
                                response.writeHead(200, { "content-type": "application/json" });
                                response.end(JSON.stringify(payload));
                            },
                        });
                    };
                    const onClose = () => {
                        server.off("request", onRequest);
                        reject(new Error("OpenAI query fixture closed before its request"));
                    };
                    server.once("request", onRequest);
                    server.once("close", onClose);
                });
            },
            async close() {
                responses.forEach((response) => response.destroy());
                sockets.forEach((socket) => socket.destroy());
                await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
                await Promise.allSettled(operations);
            },
        };
    }

    it("preserves original query slots after a real create returns the same upstream ID", async () => {
        const upstream = await openAiUpstream();
        try {
            const original = await claimImage(upstream.origin);
            const before = await imageRecord(original.task.id);
            const createRequest = upstream.nextRequest();
            const generating = openai.runOpenAiImageTask(original.task, upstream.origin, upstream.origin, "", false);
            upstream.operations.push(generating);
            const create = await requestBeforeTerminal(createRequest, generating, "create HTTP");
            expect(create.request.method).toBe("POST");
            expect(create.request.url).toBe("/v1/images/generations");
            expect(create.request.headers.authorization).toBe(`Bearer ${apiKey}`);
            expect(create.request.headers["idempotency-key"]).toBe(`image-task:${original.task.id}:attempt:1`);
            expect(create.request.headers["x-client-request-id"]).toBe(`image-task:${original.task.id}:attempt:1`);
            expect(create.request.headers.cookie).toBeUndefined();
            expect(await readRequestJson(create.request)).toMatchObject({ model, prompt, n: 1 });
            const queryRequest = upstream.nextRequest();
            create.respond({ id: upstreamId, status: "queued", data: [] });
            const query = await requestBeforeTerminal(queryRequest, generating, "same-ID query HTTP");
            expect(query.request.method).toBe("GET");
            expect(query.request.url).toBe("/v1/native-query/fixture-openai-native-query-id");
            expect(query.request.headers.authorization).toBe(`Bearer ${apiKey}`);
            expect(query.request.headers.cookie).toBeUndefined();
            query.respond({ id: upstreamId, status: "completed", data: [{ url: upstream.nativeUrl }, { url: "" }, { url: upstream.nativeUrl }] });
            const result = await generating;
            expect(await imageRecord(original.task.id)).toEqual(before);

            // This provider fixture keeps its original null claim; it does not exercise runtime ID persistence.
            const mediaRequest = upstream.nextRequest();
            const capturing = nativeCapture.captureImageTaskNativeResults({ ...original.claim, result, origin: upstream.origin, authContext: "" });
            upstream.operations.push(capturing);
            const download = await requestBeforeTerminal(mediaRequest, capturing, "native media HTTP");
            expect(download.request.method).toBe("GET");
            expect(download.request.url).toBe("/native.png");
            const outcome = await capturing;
            assert.ok(outcome.state === "native_ready");
            const storedFirst = outcome.nativeResults.slots[0];
            assert.ok(storedFirst?.status === "stored");
            await expectStoredSlot(storedFirst, original.task.id);
            expect(await imageRecord(original.task.id)).toEqual({
                ...before,
                updatedAt: expect.any(Number),
                payload: { ...before.payload, nativeResults: outcome.nativeResults, updatedAt: expect.any(Number) },
            });

            // Complete and verify actual native storage before asserting the query adapter's three-slot contract.
            expect(result.results).toHaveLength(3);
            expect(result.results).toMatchObject([{ dataUrl: upstream.nativeUrl }, { dataUrl: "" }, { dataUrl: upstream.nativeUrl }]);
            expect(result).toMatchObject({ dataUrl: upstream.nativeUrl, remoteUrl: upstream.nativeUrl });
            expect(result.pending).toBeUndefined();
            expect(result.needsReview).toBeUndefined();
            expect(result.pointsCost).toBeUndefined();
            expect(result.pointsRecordId).toBeUndefined();
            expect(outcome.nativeResults).toMatchObject({ version: "image-task-native-results.v1", attemptNo: 1, upstreamTaskId: null });
            expect(outcome.nativeResults.slots).toHaveLength(3);
            const [, missing, storedThird] = outcome.nativeResults.slots;
            expect(storedFirst).toMatchObject({ resultId: `${original.task.id}:1`, resultIndex: 1 });
            expect(missing).toEqual({ resultId: `${original.task.id}:2`, resultIndex: 2, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
            assert.ok(storedThird?.status === "stored");
            expect(storedThird).toMatchObject({ resultId: `${original.task.id}:3`, resultIndex: 3 });
            await expectStoredSlot(storedThird, original.task.id);
            expect((await registrations.listFileLocalMediaRegistrations()).filter((registration) => registration.ownerUserId === userId && registration.taskId === original.task.id)).toHaveLength(2);
            expect(upstream.counts()).toEqual({ create: 1, query: 1, media: 2 });
            expect(upstream.unexpected).toEqual([]);
        } finally {
            await upstream.close();
        }
    }, 30_000);
});
