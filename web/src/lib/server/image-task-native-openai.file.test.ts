import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenerationSubmissionUncertainError } from "./generation-submission-error";
import type { ImageTask } from "./image-task-store";
import type { StoredGenerationTaskRecord } from "./generation-task-store";

type NativeResults = NonNullable<ImageTask["nativeResults"]>;
type StoredNativeSlot = Extract<NativeResults["slots"][number], { status: "stored" }>;

describe("OpenAI native slots through real create HTTP and File collector", () => {
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
    const workerId = "fixture-openai-native-slots-worker";
    const model = "fixture-openai-native-slots-model";
    const apiKey = "fixture-only-openai-native-slots";
    const prompt = "Preserve the declared OpenAI native result slots";

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-openai-native-slots-"));
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
        if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated OpenAI native slot fixture requires local media storage");
        userId = `fixture-openai-native-slots-${randomUUID()}`;
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
        const created = await imageTasks.createImageTask({
            userId,
            username: "fixture-openai-native-slots",
            displayName: "Isolated OpenAI native slots fixture",
            kind: "generation",
            source: "image-workbench",
            config: { baseUrl, apiKey, apiFormat: "openai", model },
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

    async function nativeAssets(taskId: string) {
        return (await registrations.listFileLocalMediaRegistrations()).filter((registration) => registration.ownerUserId === userId && registration.taskId === taskId);
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

    async function expectSealedImage(before: StoredGenerationTaskRecord, nativeResults: NativeResults) {
        expect(await imageRecord(before.id)).toEqual({
            ...before,
            updatedAt: expect.any(Number),
            payload: { ...before.payload, nativeResults, updatedAt: expect.any(Number) },
        });
    }

    async function openAiUpstream() {
        const server = createServer();
        const sockets = new Set<Socket>();
        const responses = new Set<ServerResponse>();
        const operations: Promise<unknown>[] = [];
        let createCount = 0;
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
        });
        server.on("request", (request, response) => {
            if (request.method === "POST") createCount++;
            responses.add(response);
            response.once("close", () => responses.delete(response));
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

        function nextCreateRequest() {
            return new Promise<{ request: IncomingMessage; payload: unknown; respond: (payload: unknown) => void }>((resolve, reject) => {
                const onRequest = (request: IncomingMessage, response: ServerResponse) => {
                    server.off("close", onClose);
                    const readBody = async () => {
                        const chunks: Buffer[] = [];
                        for await (const chunk of request) chunks.push(Buffer.from(chunk));
                        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                        return payload;
                    };
                    void readBody().then(
                        (payload) =>
                            resolve({
                                request,
                                payload,
                                respond(value) {
                                    response.writeHead(200, { "content-type": "application/json" });
                                    response.end(JSON.stringify(value));
                                },
                            }),
                        reject,
                    );
                };
                const onClose = () => {
                    server.off("request", onRequest);
                    reject(new Error("OpenAI fixture closed before its create request"));
                };
                server.once("request", onRequest);
                server.once("close", onClose);
            });
        }

        function nextMediaRequest(taskId: string) {
            return new Promise<{ record: StoredGenerationTaskRecord; finish: () => void }>((resolve, reject) => {
                const onRequest = (request: IncomingMessage, response: ServerResponse) => {
                    server.off("close", onClose);
                    if (request.method !== "GET" || request.url !== "/native.png") {
                        response.writeHead(404);
                        response.end();
                        reject(new Error(`Unexpected native media request: ${request.method} ${request.url}`));
                        return;
                    }
                    void tasks
                        .withGenerationTaskFileMutation(async (records) => {
                            const record = records.find((item) => item.type === "image" && item.id === taskId);
                            assert.ok(record);
                            return { tasks: records, result: record };
                        })
                        .then(
                            (record) =>
                                resolve({
                                    record,
                                    finish() {
                                        response.writeHead(200, { "content-type": "image/png" });
                                        response.end(source);
                                    },
                                }),
                            reject,
                        );
                };
                const onClose = () => {
                    server.off("request", onRequest);
                    reject(new Error("OpenAI fixture closed before its native media request"));
                };
                server.once("request", onRequest);
                server.once("close", onClose);
            });
        }

        return {
            origin,
            nativeUrl: `${origin}/native.png`,
            get createCount() {
                return createCount;
            },
            generate(task: ImageTask) {
                const request = nextCreateRequest();
                const result = openai.runOpenAiImageTask(task, origin, origin, "", true);
                operations.push(result);
                return {
                    result,
                    request: Promise.race([
                        request,
                        result.then(() => {
                            throw new Error("OpenAI adapter settled before its create request");
                        }),
                    ]),
                };
            },
            capture(input: Parameters<typeof nativeCapture.captureImageTaskNativeResults>[0]) {
                const request = nextMediaRequest(input.taskId);
                const result = nativeCapture.captureImageTaskNativeResults(input);
                operations.push(result);
                return {
                    result,
                    request: Promise.race([
                        request,
                        result.then((outcome) => {
                            throw new Error(`Native capture settled before its media request: ${outcome.state}`);
                        }),
                    ]),
                };
            },
            nextMediaRequest,
            async close() {
                responses.forEach((response) => response.destroy());
                sockets.forEach((socket) => socket.destroy());
                await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
                await Promise.allSettled(operations);
            },
        };
    }

    it("preserves duplicate declared OpenAI data items and an empty middle slot through adapter and native sealing", async () => {
        const upstream = await openAiUpstream();
        try {
            const original = await claimImage(upstream.origin);
            const before = await imageRecord(original.task.id);
            const generating = upstream.generate(original.task);
            const create = await generating.request;
            expect(create.request.method).toBe("POST");
            expect(create.request.url).toBe("/v1/images/generations");
            expect(create.request.headers.authorization).toBe(`Bearer ${apiKey}`);
            expect(create.request.headers["idempotency-key"]).toBe(`image-task:${original.task.id}:attempt:1`);
            expect(create.request.headers["x-client-request-id"]).toBe(`image-task:${original.task.id}:attempt:1`);
            expect(create.request.headers.cookie).toBeUndefined();
            expect(create.payload).toMatchObject({ model, prompt, n: 1, response_format: "url" });
            create.respond({ data: [{ url: upstream.nativeUrl }, { url: "" }, { url: upstream.nativeUrl }] });

            const result = await generating.result;

            expect(result.results).toHaveLength(3);
            expect(result.results).toMatchObject([{ dataUrl: upstream.nativeUrl }, { dataUrl: "" }, { dataUrl: upstream.nativeUrl }]);
            expect(result.pending).toBeUndefined();
            expect(result.needsReview).toBeUndefined();
            expect(result.pointsCost).toBeUndefined();
            expect(result.pointsRecordId).toBeUndefined();
            expect(await imageRecord(original.task.id)).toEqual(before);
            const capturing = upstream.capture({ ...original.claim, result, origin: upstream.origin, authContext: "" });
            const first = await capturing.request;
            expect(first.record.payload.nativeAcquisition).toEqual({
                version: "image-task-native-acquisition.v1",
                attemptNo: 1,
                upstreamTaskId: null,
                slots: [
                    { resultId: `${original.task.id}:1`, resultIndex: 1, source: { url: upstream.nativeUrl } },
                    { resultId: `${original.task.id}:2`, resultIndex: 2 },
                    { resultId: `${original.task.id}:3`, resultIndex: 3, source: { url: upstream.nativeUrl } },
                ],
            });
            expect(first.record.payload.nativeResults).toBeUndefined();
            expect(first.record.payload.resultProcessing).toBeUndefined();
            expect(await nativeAssets(original.task.id)).toEqual([]);
            const nextRequest = Promise.race([
                upstream.nextMediaRequest(original.task.id),
                capturing.result.then((outcome) => {
                    throw new Error(`Native capture settled before the third original slot: ${outcome.state}`);
                }),
            ]);
            first.finish();
            const third = await nextRequest;
            expect(third.record.payload.nativeAcquisition).toEqual(first.record.payload.nativeAcquisition);
            expect(third.record.payload.nativeResults).toBeUndefined();
            third.finish();
            const outcome = await capturing.result;
            assert.ok(outcome.state === "native_ready");
            expect(outcome.nativeResults.slots).toHaveLength(3);
            const [storedFirst, missing, storedThird] = outcome.nativeResults.slots;
            assert.ok(storedFirst?.status === "stored");
            assert.ok(storedThird?.status === "stored");
            expect(storedFirst).toMatchObject({ resultId: `${original.task.id}:1`, resultIndex: 1 });
            expect(missing).toEqual({ resultId: `${original.task.id}:2`, resultIndex: 2, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
            expect(storedThird).toMatchObject({ resultId: `${original.task.id}:3`, resultIndex: 3 });
            await expectStoredSlot(storedFirst, original.task.id);
            await expectStoredSlot(storedThird, original.task.id);
            await expectSealedImage(before, outcome.nativeResults);
            expect(upstream.createCount).toBe(1);
        } finally {
            await upstream.close();
        }
    }, 30_000);

    it("keeps two aliases of the same original OpenAI data item in one native slot", async () => {
        const upstream = await openAiUpstream();
        try {
            const original = await claimImage(upstream.origin);
            const before = await imageRecord(original.task.id);
            const generating = upstream.generate(original.task);
            const create = await generating.request;
            expect(create.request.method).toBe("POST");
            expect(create.request.url).toBe("/v1/images/generations");
            expect(create.request.headers.authorization).toBe(`Bearer ${apiKey}`);
            expect(create.request.headers["idempotency-key"]).toBe(`image-task:${original.task.id}:attempt:1`);
            expect(create.request.headers["x-client-request-id"]).toBe(`image-task:${original.task.id}:attempt:1`);
            expect(create.request.headers.cookie).toBeUndefined();
            expect(create.payload).toMatchObject({ model, prompt, n: 1, response_format: "url" });
            create.respond({ data: [{ url: upstream.nativeUrl, image_url: upstream.nativeUrl }] });

            const result = await generating.result;

            expect(result.results).toHaveLength(1);
            expect(result.results).toMatchObject([{ dataUrl: upstream.nativeUrl }]);
            expect(result.pointsCost).toBeUndefined();
            expect(result.pointsRecordId).toBeUndefined();
            expect(await imageRecord(original.task.id)).toEqual(before);
            const capturing = upstream.capture({ ...original.claim, result, origin: upstream.origin, authContext: "" });
            const request = await capturing.request;
            expect(request.record.payload.nativeAcquisition).toEqual({
                version: "image-task-native-acquisition.v1",
                attemptNo: 1,
                upstreamTaskId: null,
                slots: [{ resultId: `${original.task.id}:1`, resultIndex: 1, source: { url: upstream.nativeUrl } }],
            });
            expect(request.record.payload.nativeResults).toBeUndefined();
            expect(await nativeAssets(original.task.id)).toEqual([]);
            request.finish();
            const outcome = await capturing.result;
            assert.ok(outcome.state === "native_ready");
            expect(outcome.nativeResults.slots).toHaveLength(1);
            const slot = outcome.nativeResults.slots[0];
            assert.ok(slot?.status === "stored");
            expect(slot).toMatchObject({ resultId: `${original.task.id}:1`, resultIndex: 1 });
            await expectStoredSlot(slot, original.task.id);
            await expectSealedImage(before, outcome.nativeResults);
            expect(upstream.createCount).toBe(1);
        } finally {
            await upstream.close();
        }
    }, 30_000);

    it.each([
        { name: "an empty authoritative data array", data: [] },
        { name: "only unreadable authoritative data items", data: [{ url: "" }, { url: "" }] },
    ])(
        "OpenAI native authority rejects $name without borrowing top-level or nested media",
        async ({ data }) => {
            const upstream = await openAiUpstream();
            try {
                const original = await claimImage(upstream.origin);
                const before = await imageRecord(original.task.id);
                const assetsBefore = await nativeAssets(original.task.id);
                expect(before.payload.nativeAcquisition).toBeUndefined();
                expect(before.payload.nativeResults).toBeUndefined();
                expect(before.payload.resultProcessing).toBeUndefined();
                expect(assetsBefore).toEqual([]);
                const generating = upstream.generate(original.task);
                const create = await generating.request;
                expect(create.request.method).toBe("POST");
                expect(create.request.url).toBe("/v1/images/generations");
                expect(create.request.headers.authorization).toBe(`Bearer ${apiKey}`);
                expect(create.request.headers["idempotency-key"]).toBe(`image-task:${original.task.id}:attempt:1`);
                expect(create.request.headers["x-client-request-id"]).toBe(`image-task:${original.task.id}:attempt:1`);
                expect(create.payload).toMatchObject({ model, prompt, n: 1, response_format: "url" });
                const unexpectedMedia = upstream.nextMediaRequest(original.task.id).then((request) => {
                    request.finish();
                    throw new Error("An authoritative data array without a source requested side-branch media");
                });
                create.respond({ data, url: upstream.nativeUrl, result: { url: upstream.nativeUrl } });

                await expect(Promise.race([generating.result, unexpectedMedia])).rejects.toBeInstanceOf(GenerationSubmissionUncertainError);

                expect(await imageRecord(original.task.id)).toEqual(before);
                expect(await nativeAssets(original.task.id)).toEqual(assetsBefore);
                expect(upstream.createCount).toBe(1);
            } finally {
                await upstream.close();
            }
        },
        30_000,
    );

    it("OpenAI native authority preserves an empty first slot and the later successful top-level media view", async () => {
        const upstream = await openAiUpstream();
        try {
            const original = await claimImage(upstream.origin);
            const before = await imageRecord(original.task.id);
            const generating = upstream.generate(original.task);
            const create = await generating.request;
            expect(create.request.method).toBe("POST");
            expect(create.request.url).toBe("/v1/images/generations");
            expect(create.request.headers.authorization).toBe(`Bearer ${apiKey}`);
            expect(create.request.headers["idempotency-key"]).toBe(`image-task:${original.task.id}:attempt:1`);
            expect(create.request.headers["x-client-request-id"]).toBe(`image-task:${original.task.id}:attempt:1`);
            expect(create.payload).toMatchObject({ model, prompt, n: 1, response_format: "url" });
            create.respond({ data: [{ url: "" }, { url: upstream.nativeUrl }] });

            const result = await generating.result;

            expect(result.results).toHaveLength(2);
            expect(result.results).toMatchObject([{ dataUrl: "" }, { dataUrl: upstream.nativeUrl }]);
            expect(result.dataUrl).toBe(upstream.nativeUrl);
            expect(result.remoteUrl).toBe(upstream.nativeUrl);
            expect(result.pending).toBeUndefined();
            expect(result.needsReview).toBeUndefined();
            expect(result.pointsCost).toBeUndefined();
            expect(result.pointsRecordId).toBeUndefined();
            expect(await imageRecord(original.task.id)).toEqual(before);
            const capturing = upstream.capture({ ...original.claim, result, origin: upstream.origin, authContext: "" });
            const request = await capturing.request;
            expect(request.record.payload.nativeAcquisition).toEqual({
                version: "image-task-native-acquisition.v1",
                attemptNo: 1,
                upstreamTaskId: null,
                slots: [
                    { resultId: `${original.task.id}:1`, resultIndex: 1 },
                    { resultId: `${original.task.id}:2`, resultIndex: 2, source: { url: upstream.nativeUrl } },
                ],
            });
            expect(request.record.payload.nativeResults).toBeUndefined();
            expect(request.record.payload.resultProcessing).toBeUndefined();
            expect(await nativeAssets(original.task.id)).toEqual([]);
            request.finish();
            const outcome = await capturing.result;
            assert.ok(outcome.state === "native_ready");
            expect(outcome.nativeResults.slots).toHaveLength(2);
            const [missing, stored] = outcome.nativeResults.slots;
            expect(missing).toEqual({ resultId: `${original.task.id}:1`, resultIndex: 1, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
            assert.ok(stored?.status === "stored");
            expect(stored).toMatchObject({ resultId: `${original.task.id}:2`, resultIndex: 2 });
            await expectStoredSlot(stored, original.task.id);
            await expectSealedImage(before, outcome.nativeResults);
            expect(upstream.createCount).toBe(1);
        } finally {
            await upstream.close();
        }
    }, 30_000);

    it("OpenAI native authority retains real upstream identity for query recovery without borrowing side-branch media", async () => {
        const upstream = await openAiUpstream();
        try {
            const original = await claimImage(upstream.origin);
            const before = await imageRecord(original.task.id);
            const assetsBefore = await nativeAssets(original.task.id);
            expect(before.payload.nativeAcquisition).toBeUndefined();
            expect(before.payload.nativeResults).toBeUndefined();
            expect(before.payload.resultProcessing).toBeUndefined();
            expect(assetsBefore).toEqual([]);
            const generating = upstream.generate(original.task);
            const create = await generating.request;
            expect(create.request.method).toBe("POST");
            expect(create.request.url).toBe("/v1/images/generations");
            expect(create.request.headers.authorization).toBe(`Bearer ${apiKey}`);
            expect(create.request.headers["idempotency-key"]).toBe(`image-task:${original.task.id}:attempt:1`);
            expect(create.request.headers["x-client-request-id"]).toBe(`image-task:${original.task.id}:attempt:1`);
            expect(create.payload).toMatchObject({ model, prompt, n: 1, response_format: "url" });
            const unexpectedMedia = upstream.nextMediaRequest(original.task.id).then((request) => {
                request.finish();
                throw new Error("An empty authoritative data array with a real upstream ID requested side-branch media");
            });
            create.respond({ data: [], id: "fixture-authority-upstream", url: upstream.nativeUrl, result: { url: upstream.nativeUrl } });

            const result = await Promise.race([generating.result, unexpectedMedia]);

            expect(result).toMatchObject({ dataUrl: "", pending: { id: "fixture-authority-upstream" } });
            expect(result.needsReview).toBeUndefined();
            expect(result.pointsCost).toBeUndefined();
            expect(result.pointsRecordId).toBeUndefined();
            expect(await imageRecord(original.task.id)).toEqual(before);
            expect(await nativeAssets(original.task.id)).toEqual(assetsBefore);
            expect(upstream.createCount).toBe(1);
        } finally {
            await upstream.close();
        }
    }, 30_000);
});
