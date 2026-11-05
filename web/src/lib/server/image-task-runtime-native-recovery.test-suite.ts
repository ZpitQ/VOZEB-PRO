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
import type { StoredGenerationTaskRecord } from "./generation-task-types";

type StoredNativeSlot = Extract<NonNullable<ImageTask["nativeResults"]>["slots"][number], { status: "stored" }>;

export function imageTaskRuntimeNativeRecoverySuite(provider: "file" | "postgres") {
    describe(`${provider} image runtime recovery from sealed native results`, () => {
        let directory: string;
        let userId: string;
        let source: Buffer;
        let database: typeof import("./database");
        let imageTasks: typeof import("./image-task-store");
        let tasks: typeof import("./generation-task-store");
        let scheduler: typeof import("./generation-task-scheduler");
        let registrations: typeof import("./local-media-registry");
        let media: typeof import("./local-media-storage");
        let capture: typeof import("./image-task-native-capture");
        let openai: typeof import("@/app/api/image-tasks/image-task-openai");
        let recovery: typeof import("./generation-task-recovery-service");
        const workerA = "fixture-native-recovery-original-worker";
        const workerB = "fixture-native-recovery-next-worker";
        const model = "fixture-native-recovery-model";
        const apiKey = "fixture-only-native-recovery";
        const prompt = "Resume the sealed native result through its local dependency";

        beforeAll(async () => {
            if (
                provider === "postgres" &&
                (process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION !== "1" ||
                    process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" ||
                    process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" ||
                    process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" ||
                    !process.env.DATABASE_URL)
            )
                throw new Error("Explicit isolated PostgreSQL fixture with integration enabled and startup pool maximum one is required");
            directory = await mkdtemp(path.join(tmpdir(), "vozeb-native-recovery-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
            vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
            vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
            vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
            [database, imageTasks, tasks, scheduler, registrations, media, capture, openai, recovery] = await Promise.all([
                import("./database"),
                import("./image-task-store"),
                import("./generation-task-store"),
                import("./generation-task-scheduler"),
                import("./local-media-registry"),
                import("./local-media-storage"),
                import("./image-task-native-capture"),
                import("@/app/api/image-tasks/image-task-openai"),
                import("./generation-task-recovery-service"),
            ]);
            if (provider === "postgres") await database.initializePostgresSchema();
            const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
            if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated native recovery fixture requires local media storage");
            userId = `fixture-native-recovery-${randomUUID()}`;
            if (provider === "postgres") {
                const repositories = database.createPostgresRepositories();
                const settings = await repositories.settings.getSettings();
                const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
                if (!planId) throw new Error("Fixture entitlement plan missing");
                await repositories.users.createWithNextAccountId({
                    id: userId,
                    username: `fixture_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
                    displayName: "Isolated native recovery fixture",
                    bio: "",
                    role: "user",
                    adminPermissions: [],
                    status: "active",
                    planId,
                    pointsBalance: 1000,
                    passwordHash: "fixture-only",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
            }
            source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 24, g: 48, b: 72 } } })
                .png()
                .toBuffer();
        }, 30_000);

        afterAll(async () => {
            try {
                if (provider === "postgres" && userId) await database.postgresQuery("DELETE FROM users WHERE id = $1", [userId]);
            } finally {
                vi.unstubAllEnvs();
                if (directory) await rm(directory, { recursive: true, force: true });
            }
        });

        async function snapshot(taskId: string) {
            if (provider === "postgres") {
                return database.withPostgresTransaction(async (executor) => {
                    await executor.query("SET TRANSACTION READ ONLY");
                    // Remove only top-level SQL nulls; nativeResults.upstreamTaskId stays JSON null.
                    const result = await executor.query<{ record: StoredGenerationTaskRecord }>(
                        `SELECT jsonb_object_agg(field.key, field.value) AS record
                         FROM generation_tasks AS task
                         CROSS JOIN LATERAL jsonb_each(jsonb_build_object(
                             'id', task.id, 'userId', task.user_id, 'type', task.task_type,
                             'status', task.status, 'payload', task.payload,
                             'createdAt', floor(extract(epoch FROM task.created_at) * 1000),
                             'updatedAt', floor(extract(epoch FROM task.updated_at) * 1000),
                             'expiresAt', floor(extract(epoch FROM task.expires_at) * 1000),
                             'conversationId', task.conversation_id, 'runId', task.run_id,
                             'surface', task.surface, 'projectId', task.project_id,
                             'episodeId', task.payload ->> 'episodeId', 'shotId', task.payload ->> 'shotId',
                             'estimatedPoints', task.payload -> 'estimatedPoints',
                             'parentTaskId', task.parent_task_id, 'attemptNo', task.attempt_no,
                             'clientRequestId', task.client_request_id, 'executionPhase', task.execution_phase,
                             'upstreamTaskId', task.upstream_task_id, 'channelId', task.channel_id,
                             'provider', task.provider, 'queryPath', task.query_path,
                             'submittedAt', floor(extract(epoch FROM task.submitted_at) * 1000),
                             'nextPollAt', floor(extract(epoch FROM task.next_poll_at) * 1000),
                             'lastPollAt', floor(extract(epoch FROM task.last_poll_at) * 1000),
                             'lastUpstreamStatus', task.last_upstream_status,
                             'resultPayload', COALESCE(task.result_payload, '{}'::jsonb),
                             'workerId', task.worker_id,
                             'leaseUntil', floor(extract(epoch FROM task.lease_until) * 1000),
                             'lastHeartbeatAt', floor(extract(epoch FROM task.last_heartbeat_at) * 1000)
                         )) AS field
                         WHERE task.user_id = $2
                           AND ((task.task_type = 'image' AND task.id = $1)
                             OR (task.task_type = 'image_processing' AND task.parent_task_id = $1))
                           AND field.value <> 'null'::jsonb
                         GROUP BY task.id
                         ORDER BY task.id`,
                        [taskId, userId],
                    );
                    const records = result.rows.map((row) => row.record);
                    const image = records.find((record) => record.type === "image" && record.id === taskId);
                    assert.ok(image);
                    return { image, children: records.filter((record) => record.type === "image_processing" && record.parentTaskId === taskId) };
                });
            }
            return tasks.withGenerationTaskFileMutation(async (records) => {
                const image = records.find((record) => record.type === "image" && record.id === taskId);
                assert.ok(image);
                const children = records.filter((record) => record.type === "image_processing" && record.parentTaskId === taskId);
                return { tasks: records, result: { image, children } };
            });
        }

        async function nativeRegistrations(taskId: string) {
            if (provider === "postgres") return (await database.postgresQuery("SELECT * FROM local_media_assets WHERE owner_user_id = $1 AND task_id = $2 ORDER BY storage_key", [userId, taskId])).rows;
            return (await registrations.listFileLocalMediaRegistrations()).filter((registration) => registration.ownerUserId === userId && registration.taskId === taskId);
        }

        async function expectStoredSlot(slot: StoredNativeSlot, taskId: string) {
            expect(slot).toMatchObject({
                resultId: `${taskId}:1`,
                resultIndex: 1,
                sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6",
                bytes: 95,
                layout: { format: "png", depth: "uchar", channels: 3 },
            });
            expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({
                storageKey: slot.storageKey,
                ownerUserId: userId,
                taskId,
                scope: "reference",
                storageClass: "permanent",
                type: "attachment",
                source: "image-task-native-result",
                storageProvider: "local",
                mimeType: "application/octet-stream",
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
                    throw new Error(`Native recovery fixture operation settled before ${stage}`);
                }),
            ]);
        }

        async function openAiUpstream() {
            const server = createServer();
            const sockets = new Set<Socket>();
            const responses = new Set<ServerResponse>();
            const operations: Promise<unknown>[] = [];
            const requests: string[] = [];
            let createCount = 0;
            server.on("connection", (socket) => {
                sockets.add(socket);
                socket.once("close", () => sockets.delete(socket));
            });
            server.on("request", (request, response) => {
                requests.push(`${request.method} ${request.url}`);
                responses.add(response);
                response.once("close", () => responses.delete(response));
                if (request.method === "POST" && request.url === "/v1/images/generations") {
                    createCount++;
                    if (createCount === 1) return;
                } else if (request.method === "GET" && request.url === "/native.png") {
                    response.writeHead(200, { "content-type": "image/png" });
                    response.end(source);
                    return;
                }
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
                requests,
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
                            reject(new Error("Native recovery fixture closed before its request"));
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

        it("enqueues the sealed native result after recovery reclaims an image with no result URL", async () => {
            const upstream = await openAiUpstream();
            try {
                const advancedConfig = {
                    protocol: "openai",
                    authMode: "bearer",
                    textModel: "",
                    imageModel: model,
                    videoModel: "",
                    createPath: "/images/generations",
                    queryPath: "",
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
                    username: "fixture-native-recovery",
                    displayName: "Isolated native recovery fixture",
                    kind: "generation",
                    source: "image-workbench",
                    config: { baseUrl: upstream.origin, apiKey, apiFormat: "openai", model, outputBackground: "opaque", advancedConfig },
                    prompt,
                    references: [],
                    attemptNo: 1,
                    attempts: [],
                });
                assert.ok(await imageTasks.transitionImageTask(created, ["pending"], { status: "running" }));
                await scheduler.scheduleGenerationTask("image", created.id, { executionPhase: "created", nextPollAt: Date.now() - 1 });
                const claimed = await scheduler.claimDueGenerationTasks({ workerId: workerA, taskIds: [created.id], limit: 1 });
                assert.equal(claimed.length, 1);
                const leaseA = claimed[0];
                assert.ok(leaseA?.executionId);
                const task = await imageTasks.getImageTask(created.id);
                assert.ok(task);
                expect(task.executionId).toBe(leaseA.executionId);
                const initial = await snapshot(task.id);
                expect(initial.image).toMatchObject({ workerId: workerA, payload: { attemptNo: 1, executionId: leaseA.executionId } });
                expect(initial.image.runId).toBeUndefined();
                expect(initial.image.upstreamTaskId).toBeUndefined();
                expect(initial.image.payload.upstream).toBeUndefined();
                expect(initial.image.payload.billing).toBeUndefined();
                expect(initial.children).toEqual([]);

                const createRequest = upstream.nextRequest();
                const generating = openai.runOpenAiImageTask(task, upstream.origin, upstream.origin, "", true);
                upstream.operations.push(generating);
                const create = await requestBeforeTerminal(createRequest, generating, "create HTTP");
                expect(create.request.method).toBe("POST");
                expect(create.request.url).toBe("/v1/images/generations");
                expect(create.request.headers.authorization).toBe(`Bearer ${apiKey}`);
                expect(create.request.headers["idempotency-key"]).toBe(`image-task:${task.id}:attempt:1`);
                expect(create.request.headers["x-client-request-id"]).toBe(`image-task:${task.id}:attempt:1`);
                expect(create.request.headers.cookie).toBeUndefined();
                expect(await readRequestJson(create.request)).toMatchObject({ model, prompt, n: 1 });
                create.respond({ data: [{ url: upstream.nativeUrl }] });
                const result = await generating;
                expect(result).toMatchObject({ dataUrl: upstream.nativeUrl, results: [{ dataUrl: upstream.nativeUrl }] });
                expect(result.pending).toBeUndefined();
                expect(result.needsReview).toBeUndefined();
                expect(result.pointsRecordId).toBeUndefined();

                const mediaRequest = upstream.nextRequest();
                const capturing = capture.captureImageTaskNativeResults({
                    taskId: task.id,
                    workerId: workerA,
                    executionId: leaseA.executionId,
                    attemptNo: 1,
                    upstreamTaskId: null,
                    result,
                    origin: upstream.origin,
                    authContext: "",
                });
                upstream.operations.push(capturing);
                const download = await requestBeforeTerminal(mediaRequest, capturing, "native media HTTP");
                expect(download.request.method).toBe("GET");
                expect(download.request.url).toBe("/native.png");
                const captured = await capturing;
                assert.ok(captured.state === "native_ready");
                expect(captured.nativeResults).toMatchObject({ version: "image-task-native-results.v1", attemptNo: 1, upstreamTaskId: null });
                expect(captured.nativeResults.slots).toHaveLength(1);
                const slot = captured.nativeResults.slots[0];
                assert.ok(slot?.status === "stored");
                await expectStoredSlot(slot, task.id);
                const sealed = await snapshot(task.id);
                expect(sealed.image.payload.nativeResults).toEqual(captured.nativeResults);
                expect(sealed.image.payload.resultProcessing).toBeUndefined();
                expect(sealed.image.payload.result).toBeUndefined();
                expect(sealed.children).toEqual([]);
                const registrationsBefore = await nativeRegistrations(task.id);
                expect(registrationsBefore).toHaveLength(1);
                expect(upstream.requests).toEqual(["POST /v1/images/generations", "GET /native.png"]);

                // This guarded release models a persisted checkpoint, not a killed worker or the initial runtime capture path.
                const due = Date.now() - 1;
                assert.ok(await scheduler.releaseGenerationTaskLease("image", task.id, workerA, { executionPhase: "persisting", nextPollAt: due }, { executionId: leaseA.executionId }));
                const released = await snapshot(task.id);
                expect(released.image.executionPhase).toBe("persisting");
                expect(released.image.nextPollAt).toBe(due);
                expect(released.image.workerId).toBeUndefined();
                expect(released.image.leaseUntil).toBeUndefined();
                expect(released.image.resultPayload?.url).toBeUndefined();
                expect(released.image.payload.nativeResults).toEqual(captured.nativeResults);
                const networkBefore = upstream.requests.slice();

                const recovering = recovery.runGenerationTaskRecoveryBatch({ origin: upstream.origin, publicOrigin: upstream.origin, cookie: "", limit: 1, taskIds: [task.id], workerId: workerB, userRequested: false });
                upstream.operations.push(recovering);
                const outcome = await recovering;
                const after = await snapshot(task.id);
                expect(outcome).toEqual({ claimed: 1, pending: 1, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
                expect(after.children).toHaveLength(1);
                const child = after.children[0];
                assert.ok(child);
                const reference = { jobId: child.id, inputDigest: child.payload.inputDigest };
                expect(after.image).toEqual({
                    ...released.image,
                    status: "running",
                    executionPhase: "persisting",
                    updatedAt: expect.any(Number),
                    nextPollAt: undefined,
                    workerId: undefined,
                    leaseUntil: undefined,
                    lastHeartbeatAt: undefined,
                    lastUpstreamStatus: "image_processing_waiting",
                    payload: { ...released.image.payload, status: "running", executionId: undefined, resultProcessing: reference, updatedAt: expect.any(Number) },
                });
                expect(child.id).toMatch(/^image-process-[a-f0-9]{64}$/);
                expect(child.id).toBe(`image-process-${child.payload.inputDigest}`);
                expect(child).toMatchObject({
                    type: "image_processing",
                    userId,
                    parentTaskId: task.id,
                    status: "pending",
                    executionPhase: "created",
                    attemptNo: 0,
                    clientRequestId: child.payload.inputDigest,
                });
                expect(child.runId).toBeUndefined();
                expect(child.workerId).toBeUndefined();
                expect(child.nextPollAt).toBeTypeOf("number");
                expect(child.payload).toMatchObject({
                    version: "image-processing.v1",
                    operation: "process_result",
                    algorithmVersion: "image-task-result-processing.v1",
                    imageResultBinding: { imageTaskId: task.id, userId, nativeResults: sealed.image.payload.nativeResults },
                });
                expect(child.payload.inputs).toEqual([{ assetId: slot.assetId, assetVersion: slot.assetVersion, expectedSha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6" }]);
                expect(child.payload.sources).toEqual([{ inputIndex: 0, scope: "reference", storageKey: slot.storageKey, storageProvider: "local" }]);
                expect(child.payload.options).toEqual({ mode: "ordinary", results: [{ resultId: `${task.id}:1`, resultIndex: 1, inputIndex: 0 }], transparentBackground: false });
                expect(after.image.payload.nativeResults).toEqual(captured.nativeResults);
                expect(after.image.payload.attemptNo).toBe(1);
                expect(after.image.payload.attempts).toEqual(released.image.payload.attempts);
                // No real billing receipt was issued; this checks record preservation, not a refund ledger.
                expect(after.image.payload.billing).toEqual(released.image.payload.billing);
                expect(await nativeRegistrations(task.id)).toEqual(registrationsBefore);
                await expectStoredSlot(slot, task.id);
                expect(upstream.requests).toEqual(networkBefore);
            } finally {
                await upstream.close();
            }
        }, 30_000);
    });
}
