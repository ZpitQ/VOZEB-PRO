import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImageTaskRunResult } from "@/app/api/image-tasks/image-task-types";
import type { AgentRun, AgentRunStatus } from "./agent-run-store";
import type { ImageTask } from "./image-task-store";

export function imageTaskNativeCaptureSuite(provider: "file" | "postgres") {
    const enabled = provider === "file" || process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1";
    (enabled ? describe : describe.skip)(`${provider} image task native capture`, () => {
        let directory: string;
        let userId: string;
        let source: Buffer;
        let providerResult: ImageTaskRunResult;
        let database: typeof import("./database");
        let imageTasks: typeof import("./image-task-store");
        let tasks: typeof import("./generation-task-store");
        let scheduler: typeof import("./generation-task-scheduler");
        let registrations: typeof import("./local-media-registry");
        let media: typeof import("./local-media-storage");
        let capture: typeof import("./image-task-native-capture");
        const workerId = "fixture-image-native-capture-worker";

        beforeAll(async () => {
            if (provider === "postgres" && (process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" || process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" || !process.env.DATABASE_URL))
                throw new Error("Explicit isolated PostgreSQL fixture with startup pool maximum one is required");
            directory = await mkdtemp(path.join(tmpdir(), "vozeb-image-native-capture-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            [database, imageTasks, tasks, scheduler, registrations, media, capture] = await Promise.all([
                import("./database"),
                import("./image-task-store"),
                import("./generation-task-store"),
                import("./generation-task-scheduler"),
                import("./local-media-registry"),
                import("./local-media-storage"),
                import("./image-task-native-capture"),
            ]);
            if (provider === "postgres") await database.initializePostgresSchema();
            const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
            if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated native capture fixture requires local media storage");
            userId = `fixture-image-native-capture-${randomUUID()}`;
            if (provider === "postgres") {
                const repositories = database.createPostgresRepositories();
                const settings = await repositories.settings.getSettings();
                const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
                if (!planId) throw new Error("Fixture entitlement plan missing");
                await repositories.users.createWithNextAccountId({
                    id: userId,
                    username: `fixture_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
                    displayName: "Isolated image native capture fixture",
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
            providerResult = { dataUrl: `data:image/png;base64,${source.toString("base64")}` };
        }, 30_000);

        afterAll(async () => {
            try {
                if (provider === "postgres" && userId) await database.postgresQuery("DELETE FROM users WHERE id = $1", [userId]);
            } finally {
                vi.unstubAllEnvs();
                if (directory) await rm(directory, { recursive: true, force: true });
            }
        });

        async function claimNewImage() {
            const task = await imageTasks.createImageTask({
                userId,
                username: "fixture-image-native-capture",
                displayName: "Isolated image native capture fixture",
                kind: "generation",
                source: "image-workbench",
                config: { baseUrl: "https://image.example.com", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model" },
                prompt: "Preserve the provider native result under the original image claim",
                references: [],
                attemptNo: 1,
            });
            assert.ok(await imageTasks.transitionImageTask(task, ["pending"], { status: "running" }));
            await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "created", nextPollAt: Date.now() - 1 });
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [task.id], limit: 1 });
            assert.equal(claimed.length, 1);
            const lease = claimed[0];
            assert.ok(lease);
            assert.ok(lease.executionId);
            return { taskId: task.id, workerId, executionId: lease.executionId, attemptNo: 1, upstreamTaskId: null, result: providerResult, origin: "https://image.example.com", authContext: "" };
        }

        async function imageRecord(id: string) {
            const saved = await tasks.getStoredGenerationTaskRecord("image", id);
            assert.ok(saved);
            return saved;
        }

        async function expireImageLease(id: string) {
            if (provider === "postgres") {
                await database.postgresQuery("UPDATE generation_tasks SET lease_until = clock_timestamp() - interval '1 millisecond' WHERE id = $1 AND task_type = 'image'", [id]);
                return;
            }
            await tasks.withGenerationTaskFileMutation(async (records) => ({
                tasks: records.map((task) => (task.type === "image" && task.id === id ? { ...task, leaseUntil: Date.now() - 1 } : task)),
                result: undefined,
            }));
        }

        async function sealedImage() {
            const original = await claimNewImage();
            await capture.captureImageTaskNativeResults(original);
            const saved = await imageTasks.getImageTask(original.taskId);
            assert.ok(saved?.nativeResults);
            expect(saved.nativeResults.slots).toHaveLength(1);
            const slot = saved.nativeResults.slots[0];
            assert.ok(slot);
            assert.ok(slot.status === "stored");
            return { original, nativeResults: saved.nativeResults, slot };
        }

        async function nativeAssets(taskId: string) {
            if (provider === "postgres") return (await database.postgresQuery("SELECT * FROM local_media_assets WHERE owner_user_id = $1 AND task_id = $2 ORDER BY storage_key", [userId, taskId])).rows;
            return (await registrations.listFileLocalMediaRegistrations()).filter((registration) => registration.ownerUserId === userId && registration.taskId === taskId).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey));
        }

        async function remoteImageSource(taskId: string) {
            vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
            vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
            const server = createServer();
            const sockets = new Set<Socket>();
            const responses = new Set<ServerResponse>();
            const captures: Array<ReturnType<typeof capture.captureImageTaskNativeResults>> = [];
            let requestCount = 0;
            server.on("connection", (socket) => {
                sockets.add(socket);
                socket.once("close", () => sockets.delete(socket));
            });
            server.on("request", (_request, response) => {
                requestCount++;
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

            function nextRequest() {
                return new Promise<{ record: Awaited<ReturnType<typeof imageRecord>>; socket: Socket; writePrefix: () => Promise<void>; finish: () => void }>((resolve, reject) => {
                    const onRequest = (request: IncomingMessage, response: ServerResponse) => {
                        server.off("close", onClose);
                        const inspection =
                            provider === "postgres"
                                ? imageRecord(taskId)
                                : tasks.withGenerationTaskFileMutation(async (records) => {
                                      const record = records.find((record) => record.type === "image" && record.id === taskId);
                                      assert.ok(record);
                                      return { tasks: records, result: record };
                                  });
                        void inspection.then(
                            (record) =>
                                resolve({
                                    record,
                                    socket: request.socket,
                                    writePrefix: () =>
                                        new Promise<void>((done, fail) => {
                                            response.writeHead(200, { "content-type": "image/png" });
                                            response.write(source.subarray(0, 48), (error) => (error ? fail(error) : done()));
                                        }),
                                    finish: () => {
                                        response.end(source.subarray(48));
                                    },
                                }),
                            reject,
                        );
                    };
                    const onClose = () => {
                        server.off("request", onRequest);
                        reject(new Error("Remote fixture closed before the media request"));
                    };
                    server.once("request", onRequest);
                    server.once("close", onClose);
                });
            }

            return {
                url: `http://127.0.0.1:${address.port}/native.png`,
                get requestCount() {
                    return requestCount;
                },
                nextRequest,
                capture(input: Parameters<typeof capture.captureImageTaskNativeResults>[0]) {
                    const request = nextRequest();
                    const result = capture.captureImageTaskNativeResults(input);
                    captures.push(result);
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
                async close() {
                    responses.forEach((response) => response.destroy());
                    sockets.forEach((socket) => socket.destroy());
                    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
                    await Promise.allSettled(captures);
                },
            };
        }

        it("discards private execution context from factory input before persisting the new image task", async () => {
            const baseInput: Parameters<typeof imageTasks.createImageTask>[0] = {
                userId,
                username: "fixture-image-native-capture",
                displayName: "Isolated image native capture fixture",
                kind: "generation",
                source: "image-workbench",
                config: { baseUrl: "https://image.example.com", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model" },
                prompt: "Discard injected private execution context",
                references: [],
                attemptNo: 1,
            };
            const nativeAcquisition: NonNullable<ImageTask["nativeAcquisition"]> = {
                version: "image-task-native-acquisition.v1",
                attemptNo: 1,
                upstreamTaskId: null,
                slots: [{ resultId: "fixture-context:1", resultIndex: 1, source: { url: "https://image.example.invalid/native.png" } }],
            };
            const nativeResults: NonNullable<ImageTask["nativeResults"]> = {
                version: "image-task-native-results.v1",
                attemptNo: 1,
                upstreamTaskId: null,
                slots: [
                    {
                        resultId: "fixture-context:1",
                        resultIndex: 1,
                        status: "stored",
                        assetId: "fixture-context-native.bin",
                        assetVersion: "a8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811",
                        scope: "reference",
                        storageKey: "fixture-context-native.bin",
                        storageProvider: "local",
                        sha256: "a8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811",
                        bytes: 16,
                        metadataRejected: true,
                    },
                ],
            };
            const resultProcessing: NonNullable<ImageTask["resultProcessing"]> = { jobId: "fixture-context-processing", inputDigest: "fixture-context-digest" };
            const context = { executionId: "fixture-context-execution", nativeAcquisition, nativeResults, resultProcessing };
            const inputWithContext = { ...baseInput, ...context };

            const task = await imageTasks.createImageTask(inputWithContext);
            const saved = await imageTasks.getImageTask(task.id);
            assert.ok(saved);
            expect(task).toMatchObject({ userId, kind: "generation", source: "image-workbench", prompt: "Discard injected private execution context", attemptNo: 1, status: "pending" });
            expect(saved).toMatchObject({ id: task.id, userId, kind: "generation", source: "image-workbench", prompt: "Discard injected private execution context", attemptNo: 1, status: "pending" });
            expect({
                returned: { executionId: task.executionId, nativeAcquisition: task.nativeAcquisition, nativeResults: task.nativeResults, resultProcessing: task.resultProcessing },
                persisted: { executionId: saved.executionId, nativeAcquisition: saved.nativeAcquisition, nativeResults: saved.nativeResults, resultProcessing: saved.resultProcessing },
            }).toEqual({
                returned: { executionId: undefined, nativeAcquisition: undefined, nativeResults: undefined, resultProcessing: undefined },
                persisted: { executionId: undefined, nativeAcquisition: undefined, nativeResults: undefined, resultProcessing: undefined },
            });
        });

        it("seals a native mapping and owned attachment from a provider result under the original image claim", async () => {
            const task = await imageTasks.createImageTask({
                userId,
                username: "fixture-image-native-capture",
                displayName: "Isolated image native capture fixture",
                kind: "generation",
                source: "image-workbench",
                config: { baseUrl: "https://image.example.com", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model" },
                prompt: "Preserve the provider native result under the original image claim",
                references: [],
                attemptNo: 1,
            });
            assert.ok(await imageTasks.transitionImageTask(task, ["pending"], { status: "running" }));
            await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "created", nextPollAt: Date.now() - 1 });
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [task.id], limit: 1 });
            assert.equal(claimed.length, 1);
            const lease = claimed[0];
            assert.ok(lease);
            assert.ok(lease.executionId);

            await capture.captureImageTaskNativeResults({
                taskId: task.id,
                workerId,
                executionId: lease.executionId,
                attemptNo: 1,
                upstreamTaskId: null,
                result: providerResult,
                origin: "https://image.example.com",
                authContext: "",
            });

            const saved = await imageTasks.getImageTask(task.id);
            assert.ok(saved?.nativeResults);
            expect(saved.nativeResults).toMatchObject({ version: "image-task-native-results.v1", attemptNo: 1, upstreamTaskId: null });
            expect(saved.nativeResults.slots).toHaveLength(1);
            const slot = saved.nativeResults.slots[0];
            assert.ok(slot);
            assert.ok(slot.status === "stored");
            expect(slot).toMatchObject({ resultId: `${task.id}:1`, resultIndex: 1, status: "stored", assetId: expect.stringMatching(/\S/), assetVersion: expect.stringMatching(/\S/), scope: "reference", storageProvider: "local" });
            expect(slot).toMatchObject({ sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6", bytes: 95 });
            expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({
                storageKey: slot.storageKey,
                scope: "reference",
                storageClass: "permanent",
                type: "attachment",
                mimeType: "application/octet-stream",
                ownerUserId: userId,
                taskId: task.id,
                source: "image-task-native-result",
                storageProvider: "local",
                bytes: 95,
            });
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(source);
        });

        it("clears provider media at native sealing while preserving the original batch diagnostics through same-claim reuse", async () => {
            const original = await claimNewImage();
            const rawResult = {
                dataUrl: providerResult.dataUrl,
                results: [{ dataUrl: providerResult.dataUrl }],
                batchEvidence: [{ resultId: `${original.taskId}:1`, resultIndex: 1, nativeStatus: "readable", nativeSize: { width: 2, height: 2 }, storageStatus: "unavailable", failureStage: "store", failureReason: "Original storage diagnostic" }],
            } satisfies NonNullable<ImageTask["result"]>;
            assert.ok(await imageTasks.updateImageTask(original.taskId, { result: rawResult }));
            const before = await completeRecord("image", original.taskId);
            expect(before.payload.result).toStrictEqual(rawResult);
            expect(before.payload.nativeResults).toBeUndefined();
            expect(await nativeAssets(original.taskId)).toStrictEqual([]);

            const outcome = await capture.captureImageTaskNativeResults(original);
            const sealed = await imageTasks.getImageTask(original.taskId);
            assert.ok(sealed?.nativeResults);
            expect(outcome).toEqual({ state: "native_ready", nativeResults: sealed.nativeResults });
            expect(sealed).toMatchObject({ id: original.taskId, userId, status: "running", executionId: original.executionId, attemptNo: 1 });
            expect(sealed.nativeResults).toMatchObject({ version: "image-task-native-results.v1", attemptNo: 1, upstreamTaskId: null });
            expect(sealed.nativeResults.slots).toHaveLength(1);
            const slot = sealed.nativeResults.slots[0];
            assert.ok(slot.status === "stored");
            expect(slot).toMatchObject({
                resultId: `${original.taskId}:1`,
                resultIndex: 1,
                status: "stored",
                assetId: slot.storageKey,
                assetVersion: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6",
                scope: "reference",
                storageProvider: "local",
                sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6",
                bytes: 95,
            });
            const registration = await registrations.getLocalMediaRegistration(slot.storageKey);
            assert.ok(registration);
            expect(registration).toMatchObject({
                storageKey: slot.storageKey,
                ownerUserId: userId,
                taskId: original.taskId,
                scope: "reference",
                storageClass: "permanent",
                storageProvider: "local",
                type: "attachment",
                mimeType: "application/octet-stream",
                source: "image-task-native-result",
                bytes: 95,
            });
            expect(registration.runId).toBeUndefined();
            expect(registration.expiresAt).toBeUndefined();
            const nativePath = path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey);
            expect(await readFile(nativePath)).toEqual(source);
            expect(sealed.result?.batchEvidence).toStrictEqual(rawResult.batchEvidence);
            expect(sealed.result).toStrictEqual({ dataUrl: "", batchEvidence: rawResult.batchEvidence });

            const sealedRecord = await completeRecord("image", original.taskId);
            const sealedAssets = await nativeAssets(original.taskId);
            expect(sealedAssets).toHaveLength(1);
            const differentSource = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 96, g: 128, b: 160 } } })
                .png()
                .toBuffer();
            expect(differentSource).not.toEqual(source);
            expect(await capture.captureImageTaskNativeResults({ ...original, result: { dataUrl: `data:image/png;base64,${differentSource.toString("base64")}` } })).toStrictEqual({ state: "native_ready", nativeResults: sealed.nativeResults });
            expect(await completeRecord("image", original.taskId)).toStrictEqual(sealedRecord);
            expect(await nativeAssets(original.taskId)).toStrictEqual(sealedAssets);
            expect(await readFile(nativePath)).toEqual(source);
        });

        it("seals intact native bytes as a stored metadata rejection when image metadata is unreadable", async () => {
            const original = await claimNewImage();
            const raw = Buffer.from("00112233445566778899aabbccddeeff", "hex");

            await capture.captureImageTaskNativeResults({ ...original, result: { dataUrl: "data:image/png;base64,ABEiM0RVZneImaq7zN3u/w==" } });

            const saved = await imageTasks.getImageTask(original.taskId);
            assert.ok(saved?.nativeResults);
            expect(saved.nativeResults).toMatchObject({ version: "image-task-native-results.v1", attemptNo: 1, upstreamTaskId: null });
            expect(saved.nativeResults.slots).toHaveLength(1);
            const slot = saved.nativeResults.slots[0];
            assert.ok(slot);
            assert.ok(slot.status === "stored");
            expect(slot).toMatchObject({
                resultId: `${original.taskId}:1`,
                resultIndex: 1,
                status: "stored",
                metadataRejected: true,
                scope: "reference",
                storageProvider: "local",
                bytes: 16,
                sha256: "a8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811",
            });
            expect(slot).not.toHaveProperty("layout");
            expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({
                storageKey: slot.storageKey,
                scope: "reference",
                storageClass: "permanent",
                type: "attachment",
                mimeType: "application/octet-stream",
                ownerUserId: userId,
                taskId: original.taskId,
                source: "image-task-native-result",
                storageProvider: "local",
                bytes: 16,
            });
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(raw);
        });

        it("rejects the original image execution after the same worker reclaims without changing the new complete record", async () => {
            const original = await claimNewImage();
            await expireImageLease(original.taskId);
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [original.taskId], limit: 1 });
            assert.equal(claimed.length, 1);
            const current = claimed[0];
            assert.ok(current?.executionId);
            expect(current.executionId).not.toBe(original.executionId);
            const before = await imageRecord(original.taskId);
            expect(before.workerId).toBe(workerId);
            expect(before.payload.executionId).toBe(current.executionId);
            expect(before.leaseUntil).toBeGreaterThan(Date.now());

            expect(await capture.captureImageTaskNativeResults(original)).toEqual({ state: "ownership_lost" });

            expect(await imageRecord(original.taskId)).toEqual(before);
        });

        it.each([
            { name: "business attempt", attemptNo: 2, upstreamTaskId: null },
            { name: "upstream task", attemptNo: 1, upstreamTaskId: "fixture-unmatched-upstream" },
        ])("rejects a mismatched $name binding without changing the complete image record", async ({ attemptNo, upstreamTaskId }) => {
            const original = await claimNewImage();
            const before = await imageRecord(original.taskId);

            expect(await capture.captureImageTaskNativeResults({ ...original, attemptNo, upstreamTaskId })).toEqual({ state: "ownership_lost" });

            expect(await imageRecord(original.taskId)).toEqual(before);
        });

        it("reuses the complete sealed mapping for the same claim instead of a different valid provider image", async () => {
            const sealed = await sealedImage();
            const before = await imageRecord(sealed.original.taskId);
            const assetsBefore = await nativeAssets(sealed.original.taskId);
            expect(assetsBefore).toHaveLength(1);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
            const differentSource = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 96, g: 128, b: 160 } } })
                .png()
                .toBuffer();
            expect(differentSource).not.toEqual(source);

            expect(await capture.captureImageTaskNativeResults({ ...sealed.original, result: { dataUrl: `data:image/png;base64,${differentSource.toString("base64")}` } })).toEqual({ state: "native_ready", nativeResults: sealed.nativeResults });

            expect(await imageRecord(sealed.original.taskId)).toEqual(before);
            expect(await nativeAssets(sealed.original.taskId)).toEqual(assetsBefore);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
        });

        it("rejects the old sealed claim and reuses the original mapping for the same worker's new claim with an unavailable provider URL", async () => {
            const sealed = await sealedImage();
            await expireImageLease(sealed.original.taskId);
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [sealed.original.taskId], limit: 1 });
            assert.equal(claimed.length, 1);
            const current = claimed[0];
            assert.ok(current?.executionId);
            expect(current.executionId).not.toBe(sealed.original.executionId);
            const before = await imageRecord(sealed.original.taskId);
            expect(before.workerId).toBe(workerId);
            expect(before.payload.executionId).toBe(current.executionId);
            expect(before.leaseUntil).toBeGreaterThan(Date.now());
            expect(before.payload.nativeResults).toEqual(sealed.nativeResults);
            const assetsBefore = await nativeAssets(sealed.original.taskId);
            expect(assetsBefore).toHaveLength(1);

            expect(await capture.captureImageTaskNativeResults(sealed.original)).toEqual({ state: "ownership_lost" });
            expect(await imageRecord(sealed.original.taskId)).toEqual(before);
            expect(await nativeAssets(sealed.original.taskId)).toEqual(assetsBefore);

            expect(await capture.captureImageTaskNativeResults({ ...sealed.original, executionId: current.executionId, result: { dataUrl: "https://image.example.invalid/unavailable-native.png" } })).toEqual({
                state: "native_ready",
                nativeResults: sealed.nativeResults,
            });

            expect(await imageRecord(sealed.original.taskId)).toEqual(before);
            expect(await nativeAssets(sealed.original.taskId)).toEqual(assetsBefore);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
        });

        it("rejects a sealed mapping lookup after the same claim's actual lease expires without changing its complete record or assets", async () => {
            const sealed = await sealedImage();
            await expireImageLease(sealed.original.taskId);
            const before = await imageRecord(sealed.original.taskId);
            expect(before.payload.executionId).toBe(sealed.original.executionId);
            expect(before.leaseUntil).toBeLessThanOrEqual(Date.now());
            const assetsBefore = await nativeAssets(sealed.original.taskId);
            expect(assetsBefore).toHaveLength(1);

            expect(await capture.captureImageTaskNativeResults(sealed.original)).toEqual({ state: "ownership_lost" });

            expect(await imageRecord(sealed.original.taskId)).toEqual(before);
            expect(await nativeAssets(sealed.original.taskId)).toEqual(assetsBefore);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
        });

        it("rejects a sealed mapping whose real attachment registration source changed without replacing the mapping or assets", async () => {
            const sealed = await sealedImage();
            const registration = await registrations.getLocalMediaRegistration(sealed.slot.storageKey);
            assert.ok(registration);
            await registrations.registerLocalMediaAsset({ ...registration, source: "fixture-native-registration-changed" });
            const before = await imageRecord(sealed.original.taskId);
            const assetsBefore = await nativeAssets(sealed.original.taskId);
            expect(assetsBefore).toHaveLength(1);

            await expect(capture.captureImageTaskNativeResults(sealed.original)).rejects.toThrow("Native image attachment registration changed");

            expect(await imageRecord(sealed.original.taskId)).toEqual(before);
            expect(await nativeAssets(sealed.original.taskId)).toEqual(assetsBefore);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
        });

        it("returns ownership_lost for an expired sealed claim even when its real attachment registration source changed", async () => {
            const sealed = await sealedImage();
            const registration = await registrations.getLocalMediaRegistration(sealed.slot.storageKey);
            assert.ok(registration);
            await registrations.registerLocalMediaAsset({ ...registration, source: "fixture-native-registration-changed" });
            await expireImageLease(sealed.original.taskId);
            const before = await imageRecord(sealed.original.taskId);
            expect(before.workerId).toBe(workerId);
            expect(before.payload.executionId).toBe(sealed.original.executionId);
            expect(before.payload.nativeResults).toEqual(sealed.nativeResults);
            expect(before.expiresAt).toBeGreaterThan(Date.now());
            expect(before.leaseUntil).toBeLessThanOrEqual(Date.now());
            const assetsBefore = await nativeAssets(sealed.original.taskId);
            expect(assetsBefore).toHaveLength(1);

            expect(await capture.captureImageTaskNativeResults(sealed.original)).toEqual({ state: "ownership_lost" });

            expect(await imageRecord(sealed.original.taskId)).toEqual(before);
            expect(await nativeAssets(sealed.original.taskId)).toEqual(assetsBefore);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
        });

        it("preserves declared inline slots and duplicate native bytes around an unreadable slot", async () => {
            const original = await claimNewImage();

            const outcome = await capture.captureImageTaskNativeResults({ ...original, result: { dataUrl: providerResult.dataUrl, results: [{ dataUrl: providerResult.dataUrl }, { dataUrl: "" }, { dataUrl: providerResult.dataUrl }] } });

            const saved = await imageTasks.getImageTask(original.taskId);
            assert.ok(saved?.nativeResults);
            expect(outcome).toEqual({ state: "native_ready", nativeResults: saved.nativeResults });
            expect(saved.nativeResults).toMatchObject({ version: "image-task-native-results.v1", attemptNo: 1, upstreamTaskId: null });
            expect(saved.nativeResults.slots).toHaveLength(3);
            const [first, missing, third] = saved.nativeResults.slots;
            assert.ok(first);
            assert.ok(first.status === "stored");
            assert.ok(third);
            assert.ok(third.status === "stored");
            expect(first).toMatchObject({
                resultId: `${original.taskId}:1`,
                resultIndex: 1,
                status: "stored",
                assetId: first.storageKey,
                assetVersion: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6",
                sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6",
                bytes: 95,
            });
            expect(missing).toEqual({ resultId: `${original.taskId}:2`, resultIndex: 2, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
            expect(third).toMatchObject({
                resultId: `${original.taskId}:3`,
                resultIndex: 3,
                status: "stored",
                assetId: third.storageKey,
                assetVersion: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6",
                sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6",
                bytes: 95,
            });
            expect(await registrations.getLocalMediaRegistration(first.storageKey)).toMatchObject({
                storageKey: first.storageKey,
                ownerUserId: userId,
                taskId: original.taskId,
                scope: "reference",
                storageClass: "permanent",
                type: "attachment",
                mimeType: "application/octet-stream",
                source: "image-task-native-result",
                storageProvider: "local",
                bytes: 95,
            });
            expect(await registrations.getLocalMediaRegistration(third.storageKey)).toMatchObject({
                storageKey: third.storageKey,
                ownerUserId: userId,
                taskId: original.taskId,
                scope: "reference",
                storageClass: "permanent",
                type: "attachment",
                mimeType: "application/octet-stream",
                source: "image-task-native-result",
                storageProvider: "local",
                bytes: 95,
            });
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, first.storageKey))).toEqual(source);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, third.storageKey))).toEqual(source);
        });

        it("reuses sealed inline slots without filling their terminal unreadable hole from new valid images", async () => {
            const original = await claimNewImage();
            await capture.captureImageTaskNativeResults({ ...original, result: { dataUrl: providerResult.dataUrl, results: [{ dataUrl: providerResult.dataUrl }, { dataUrl: "" }, { dataUrl: providerResult.dataUrl }] } });
            const saved = await imageTasks.getImageTask(original.taskId);
            assert.ok(saved?.nativeResults);
            expect(saved.nativeResults.slots).toHaveLength(3);
            const [first, missing, third] = saved.nativeResults.slots;
            assert.ok(first);
            assert.ok(first.status === "stored");
            assert.ok(third);
            assert.ok(third.status === "stored");
            expect(missing).toEqual({ resultId: `${original.taskId}:2`, resultIndex: 2, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
            const before = await imageRecord(original.taskId);
            const assetsBefore = await nativeAssets(original.taskId);
            const differentSource = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 96, g: 128, b: 160 } } })
                .png()
                .toBuffer();
            expect(differentSource).not.toEqual(source);
            const differentDataUrl = `data:image/png;base64,${differentSource.toString("base64")}`;

            expect(await capture.captureImageTaskNativeResults({ ...original, result: { dataUrl: differentDataUrl, results: [{ dataUrl: differentDataUrl }, { dataUrl: differentDataUrl }, { dataUrl: differentDataUrl }] } })).toEqual({
                state: "native_ready",
                nativeResults: saved.nativeResults,
            });

            expect(await imageRecord(original.taskId)).toEqual(before);
            expect(await nativeAssets(original.taskId)).toEqual(assetsBefore);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, first.storageKey))).toEqual(source);
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, third.storageKey))).toEqual(source);
        });

        it.each([
            { name: "an empty declared array", results: [] },
            { name: "only unreadable declared slots", results: [{ dataUrl: "" }, { dataUrl: "data:image/png;base64,%%%%" }] },
        ])("returns needs_review for inline slots with $name without using a valid top-level image", async ({ results }) => {
            const original = await claimNewImage();
            const before = await imageRecord(original.taskId);
            expect(before.payload.nativeResults).toBeUndefined();
            expect(before.payload.resultProcessing).toBeUndefined();
            const assetsBefore = await nativeAssets(original.taskId);
            expect(assetsBefore).toEqual([]);

            expect(await capture.captureImageTaskNativeResults({ ...original, result: { dataUrl: providerResult.dataUrl, results } })).toEqual({
                state: "needs_review",
                reason: "未能取得上游图片原件，需要人工确认。",
                status: "image_native_acquisition_unavailable",
            });

            expect(await imageRecord(original.taskId)).toEqual(before);
            expect(await nativeAssets(original.taskId)).toEqual(assetsBefore);
        });

        it("treats intact metadata-rejected inline slots as stored when another declared slot has no source", async () => {
            const original = await claimNewImage();
            const raw = Buffer.from("00112233445566778899aabbccddeeff", "hex");

            const outcome = await capture.captureImageTaskNativeResults({ ...original, result: { dataUrl: providerResult.dataUrl, results: [{ dataUrl: "data:image/png;base64,ABEiM0RVZneImaq7zN3u/w==" }, { dataUrl: "" }] } });

            const saved = await imageTasks.getImageTask(original.taskId);
            assert.ok(saved?.nativeResults);
            expect(outcome).toEqual({ state: "native_ready", nativeResults: saved.nativeResults });
            expect(saved.nativeResults.slots).toHaveLength(2);
            const [stored, missing] = saved.nativeResults.slots;
            assert.ok(stored);
            assert.ok(stored.status === "stored");
            expect(stored).toMatchObject({
                resultId: `${original.taskId}:1`,
                resultIndex: 1,
                status: "stored",
                metadataRejected: true,
                assetId: stored.storageKey,
                assetVersion: "a8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811",
                sha256: "a8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811",
                bytes: 16,
            });
            expect(stored).not.toHaveProperty("layout");
            expect(missing).toEqual({ resultId: `${original.taskId}:2`, resultIndex: 2, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
            expect(await registrations.getLocalMediaRegistration(stored.storageKey)).toMatchObject({
                storageKey: stored.storageKey,
                ownerUserId: userId,
                taskId: original.taskId,
                scope: "reference",
                storageClass: "permanent",
                type: "attachment",
                mimeType: "application/octet-stream",
                source: "image-task-native-result",
                storageProvider: "local",
                bytes: 16,
            });
            expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, stored.storageKey))).toEqual(raw);
        });

        it("returns ownership_lost for an expired unsealed claim with unreadable inline slots", async () => {
            const original = await claimNewImage();
            await expireImageLease(original.taskId);
            const before = await imageRecord(original.taskId);
            expect(before.workerId).toBe(workerId);
            expect(before.payload.executionId).toBe(original.executionId);
            expect(before.payload.attemptNo).toBe(1);
            expect(before.payload.nativeResults).toBeUndefined();
            expect(before.payload.resultProcessing).toBeUndefined();
            expect(before.expiresAt).toBeGreaterThan(Date.now());
            expect(before.leaseUntil).toBeLessThanOrEqual(Date.now());
            const assetsBefore = await nativeAssets(original.taskId);
            expect(assetsBefore).toEqual([]);

            expect(await capture.captureImageTaskNativeResults({ ...original, result: { dataUrl: providerResult.dataUrl, results: [{ dataUrl: "" }, { dataUrl: "data:image/png;base64,%%%%" }] } })).toEqual({ state: "ownership_lost" });

            expect(await imageRecord(original.taskId)).toEqual(before);
            expect(await nativeAssets(original.taskId)).toEqual(assetsBefore);
        });

        it("persists a no-ID remote snapshot before its first request and seals only complete EOF bytes while clearing it", async () => {
            const original = await claimNewImage();
            const remote = await remoteImageSource(original.taskId);
            const running = remote.capture({ ...original, result: { dataUrl: remote.url, results: [{ dataUrl: remote.url }, { dataUrl: "" }] } });
            try {
                const request = await running.request;
                expect(request.record.payload.nativeAcquisition).toEqual({
                    version: "image-task-native-acquisition.v1",
                    attemptNo: 1,
                    upstreamTaskId: null,
                    slots: [
                        { resultId: `${original.taskId}:1`, resultIndex: 1, source: { url: remote.url } },
                        { resultId: `${original.taskId}:2`, resultIndex: 2 },
                    ],
                });
                expect(request.record.payload.nativeResults).toBeUndefined();
                await request.writePrefix();
                const pending = await imageRecord(original.taskId);
                expect(pending.payload.nativeAcquisition).toEqual(request.record.payload.nativeAcquisition);
                expect(pending.payload.nativeResults).toBeUndefined();
                expect(pending.payload.resultProcessing).toBeUndefined();
                expect(await nativeAssets(original.taskId)).toEqual([]);

                request.finish();
                const outcome = await running.result;

                const saved = await imageTasks.getImageTask(original.taskId);
                assert.ok(saved?.nativeResults);
                expect(outcome).toEqual({ state: "native_ready", nativeResults: saved.nativeResults });
                expect(saved.nativeAcquisition).toBeUndefined();
                expect(saved.nativeResults.slots).toHaveLength(2);
                const [stored, missing] = saved.nativeResults.slots;
                assert.ok(stored);
                assert.ok(stored.status === "stored");
                expect(stored).toMatchObject({ resultId: `${original.taskId}:1`, resultIndex: 1, status: "stored", sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6", bytes: 95 });
                expect(missing).toEqual({ resultId: `${original.taskId}:2`, resultIndex: 2, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
                expect(await registrations.getLocalMediaRegistration(stored.storageKey)).toMatchObject({
                    storageKey: stored.storageKey,
                    ownerUserId: userId,
                    taskId: original.taskId,
                    scope: "reference",
                    storageClass: "permanent",
                    type: "attachment",
                    mimeType: "application/octet-stream",
                    source: "image-task-native-result",
                    storageProvider: "local",
                    bytes: 95,
                });
                expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, stored.storageKey))).toEqual(source);
            } finally {
                await remote.close();
            }
        });

        it("keeps a no-ID remote locator after a real socket interruption and restores its original slots under a new claim", async () => {
            const original = await claimNewImage();
            const remote = await remoteImageSource(original.taskId);
            const replacement = await remoteImageSource(original.taskId);
            const first = remote.capture({ ...original, result: { dataUrl: remote.url, results: [{ dataUrl: remote.url }, { dataUrl: "" }] } });
            try {
                const request = await first.request;
                expect(request.record.payload.nativeAcquisition).toEqual({
                    version: "image-task-native-acquisition.v1",
                    attemptNo: 1,
                    upstreamTaskId: null,
                    slots: [
                        { resultId: `${original.taskId}:1`, resultIndex: 1, source: { url: remote.url } },
                        { resultId: `${original.taskId}:2`, resultIndex: 2 },
                    ],
                });
                await request.writePrefix();
                request.socket.destroy();

                expect(await first.result).toEqual({ state: "needs_review", reason: "未能取得上游图片原件，需要人工确认。", status: "image_native_acquisition_unavailable" });

                const interrupted = await imageRecord(original.taskId);
                expect(interrupted.payload.nativeAcquisition).toEqual(request.record.payload.nativeAcquisition);
                expect(interrupted.payload.nativeResults).toBeUndefined();
                expect(interrupted.payload.resultProcessing).toBeUndefined();
                expect(await nativeAssets(original.taskId)).toEqual([]);
                await expireImageLease(original.taskId);
                const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [original.taskId], limit: 1 });
                assert.equal(claimed.length, 1);
                const current = claimed[0];
                assert.ok(current?.executionId);
                expect(current.executionId).not.toBe(original.executionId);
                const wrongSource = replacement.nextRequest().then(() => {
                    throw new Error("Native recovery requested the replacement origin");
                });
                const retried = remote.capture({ ...original, executionId: current.executionId, result: { dataUrl: replacement.url, results: [{ dataUrl: replacement.url }, { dataUrl: replacement.url }, { dataUrl: replacement.url }] } });
                const resumed = await Promise.race([retried.request, wrongSource]);
                expect(resumed.record.payload.executionId).toBe(current.executionId);
                expect(resumed.record.payload.nativeAcquisition).toEqual(request.record.payload.nativeAcquisition);
                await resumed.writePrefix();
                resumed.finish();

                const outcome = await retried.result;

                const saved = await imageTasks.getImageTask(original.taskId);
                assert.ok(saved?.nativeResults);
                expect(outcome).toEqual({ state: "native_ready", nativeResults: saved.nativeResults });
                expect(saved.nativeAcquisition).toBeUndefined();
                expect(saved.nativeResults.slots).toHaveLength(2);
                const [stored, missing] = saved.nativeResults.slots;
                assert.ok(stored);
                assert.ok(stored.status === "stored");
                expect(stored).toMatchObject({ resultId: `${original.taskId}:1`, resultIndex: 1, status: "stored", sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6", bytes: 95 });
                expect(missing).toEqual({ resultId: `${original.taskId}:2`, resultIndex: 2, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
                expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, stored.storageKey))).toEqual(source);
                expect(remote.requestCount).toBe(2);
                expect(replacement.requestCount).toBe(0);
            } finally {
                await replacement.close();
                await remote.close();
            }
        });

        it("rejects a no-ID remote execution after another claim takes ownership during real media I/O without changing its complete record", async () => {
            const original = await claimNewImage();
            await imageTasks.updateImageTask(original.taskId, { billing: { pointsCost: 7, refunded: false } });
            const remote = await remoteImageSource(original.taskId);
            const running = remote.capture({ ...original, result: { dataUrl: remote.url, results: [{ dataUrl: remote.url }, { dataUrl: "" }] } });
            try {
                const request = await running.request;
                expect(request.record.payload.nativeAcquisition).toEqual({
                    version: "image-task-native-acquisition.v1",
                    attemptNo: 1,
                    upstreamTaskId: null,
                    slots: [
                        { resultId: `${original.taskId}:1`, resultIndex: 1, source: { url: remote.url } },
                        { resultId: `${original.taskId}:2`, resultIndex: 2 },
                    ],
                });
                await request.writePrefix();
                await expireImageLease(original.taskId);
                const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [original.taskId], limit: 1 });
                assert.equal(claimed.length, 1);
                const current = claimed[0];
                assert.ok(current?.executionId);
                expect(current.executionId).not.toBe(original.executionId);
                const before = await imageRecord(original.taskId);
                expect(before.workerId).toBe(workerId);
                expect(before.payload.executionId).toBe(current.executionId);
                expect(before.payload.billing).toEqual({ pointsCost: 7, refunded: false });
                expect(before.payload.nativeAcquisition).toEqual(request.record.payload.nativeAcquisition);
                expect(before.payload.nativeResults).toBeUndefined();
                expect(before.payload.resultProcessing).toBeUndefined();
                expect(before.nextPollAt).toBeGreaterThan(0);
                expect(before.leaseUntil).toBeGreaterThan(Date.now());

                request.finish();

                expect(await running.result).toEqual({ state: "ownership_lost" });
                expect(await imageRecord(original.taskId)).toEqual(before);
            } finally {
                await remote.close();
            }
        });

        it("captures a with-ID remote result through complete EOF and reuses its sealed mapping after reclaim without another media request", async () => {
            const upstreamTaskId = `fixture-image-native-upstream-${randomUUID()}`;
            const upstream = { id: upstreamTaskId, mediaBaseUrl: "https://image.example.com", pollBaseUrl: "https://image.example.com" };
            const task = await imageTasks.createImageTask({
                userId,
                username: "fixture-image-native-capture",
                displayName: "Isolated image native capture fixture",
                kind: "generation",
                source: "image-workbench",
                config: { baseUrl: "https://image.example.com", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model" },
                prompt: "Preserve the same submitted upstream result across image claims",
                references: [],
                attemptNo: 1,
                upstream,
            });
            assert.ok(await imageTasks.transitionImageTask(task, ["pending"], { status: "running" }));
            await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "submitted", upstreamTaskId, nextPollAt: Date.now() - 1 });
            const firstClaim = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [task.id], limit: 1 });
            assert.equal(firstClaim.length, 1);
            const firstLease = firstClaim[0];
            assert.ok(firstLease?.executionId);
            const claimedRecord = await imageRecord(task.id);
            expect(claimedRecord.upstreamTaskId).toBe(upstreamTaskId);
            expect(claimedRecord.payload.upstream).toEqual(upstream);
            expect(claimedRecord.workerId).toBe(workerId);
            expect(claimedRecord.payload.executionId).toBe(firstLease.executionId);
            expect(claimedRecord.payload.attemptNo).toBe(1);
            expect(claimedRecord.payload.nativeAcquisition).toBeUndefined();
            const remote = await remoteImageSource(task.id);
            const original = {
                taskId: task.id,
                workerId,
                executionId: firstLease.executionId,
                attemptNo: 1,
                upstreamTaskId,
                origin: "https://image.example.com",
                authContext: "",
                result: { dataUrl: remote.url, results: [{ dataUrl: remote.url }, { dataUrl: "" }] },
            };
            const running = remote.capture(original);
            let reused: ReturnType<typeof capture.captureImageTaskNativeResults> | undefined;
            try {
                const request = await running.request;
                expect(request.record.upstreamTaskId).toBe(upstreamTaskId);
                expect(request.record.payload.upstream).toEqual(upstream);
                expect(request.record.payload.executionId).toBe(firstLease.executionId);
                expect(request.record.payload.nativeAcquisition).toBeUndefined();
                expect(request.record.payload.nativeResults).toBeUndefined();
                await request.writePrefix();
                const pending = await imageRecord(task.id);
                expect(pending.upstreamTaskId).toBe(upstreamTaskId);
                expect(pending.payload.upstream).toEqual(upstream);
                expect(pending.payload.nativeAcquisition).toBeUndefined();
                expect(pending.payload.nativeResults).toBeUndefined();
                expect(pending.payload.resultProcessing).toBeUndefined();
                expect(await nativeAssets(task.id)).toEqual([]);

                request.finish();
                const outcome = await running.result;

                const saved = await imageTasks.getImageTask(task.id);
                assert.ok(saved?.nativeResults);
                expect(outcome).toEqual({ state: "native_ready", nativeResults: saved.nativeResults });
                expect(saved.upstream).toEqual(upstream);
                expect(saved.nativeAcquisition).toBeUndefined();
                expect(saved.nativeResults).toMatchObject({ version: "image-task-native-results.v1", attemptNo: 1, upstreamTaskId });
                expect(saved.nativeResults.slots).toHaveLength(2);
                const [stored, missing] = saved.nativeResults.slots;
                assert.ok(stored);
                assert.ok(stored.status === "stored");
                expect(stored).toMatchObject({ resultId: `${task.id}:1`, resultIndex: 1, status: "stored", sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6", bytes: 95 });
                expect(missing).toEqual({ resultId: `${task.id}:2`, resultIndex: 2, status: "failed", failureStage: "read", failureCode: "image_native_read_failed" });
                expect(await registrations.getLocalMediaRegistration(stored.storageKey)).toMatchObject({
                    storageKey: stored.storageKey,
                    ownerUserId: userId,
                    taskId: task.id,
                    scope: "reference",
                    storageClass: "permanent",
                    type: "attachment",
                    mimeType: "application/octet-stream",
                    source: "image-task-native-result",
                    storageProvider: "local",
                    bytes: 95,
                });
                expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, stored.storageKey))).toEqual(source);
                expect(remote.requestCount).toBe(1);

                await expireImageLease(task.id);
                const secondClaim = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [task.id], limit: 1 });
                assert.equal(secondClaim.length, 1);
                const secondLease = secondClaim[0];
                assert.ok(secondLease?.executionId);
                expect(secondLease.executionId).not.toBe(firstLease.executionId);
                const beforeReuse = await imageRecord(task.id);
                expect(beforeReuse.workerId).toBe(workerId);
                expect(beforeReuse.payload.executionId).toBe(secondLease.executionId);
                expect(beforeReuse.payload.attemptNo).toBe(1);
                expect(beforeReuse.upstreamTaskId).toBe(upstreamTaskId);
                expect(beforeReuse.payload.upstream).toEqual(upstream);
                expect(beforeReuse.payload.nativeAcquisition).toBeUndefined();
                expect(beforeReuse.payload.nativeResults).toEqual(saved.nativeResults);
                expect(beforeReuse.leaseUntil).toBeGreaterThan(Date.now());
                const assetsBeforeReuse = await nativeAssets(task.id);
                expect(assetsBeforeReuse).toHaveLength(1);
                const unexpectedRequest = remote.nextRequest().then(() => {
                    throw new Error("Sealed with-ID native reuse requested media again");
                });
                reused = capture.captureImageTaskNativeResults({ ...original, executionId: secondLease.executionId, result: { dataUrl: remote.url, results: [{ dataUrl: remote.url }, { dataUrl: remote.url }, { dataUrl: remote.url }] } });

                expect(await Promise.race([reused, unexpectedRequest])).toEqual({ state: "native_ready", nativeResults: saved.nativeResults });

                expect(await imageRecord(task.id)).toEqual(beforeReuse);
                expect(await nativeAssets(task.id)).toEqual(assetsBeforeReuse);
                expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, stored.storageKey))).toEqual(source);
                expect(remote.requestCount).toBe(1);
            } finally {
                await remote.close();
                if (reused) await Promise.allSettled([reused]);
            }
        });

        async function ordinaryRun(status: AgentRunStatus = "planning", conversationId?: string) {
            const runs = await import("./agent-run-store");
            const bundle = await runs.createAgentRun(userId, {
                clientRequestId: `fixture-native-run-${randomUUID()}`,
                surface: "chat",
                conversationId,
                prompt: "Fence native image association with an ordinary Run",
                assetIds: [],
                skillIds: [],
                modelIds: [],
            });
            const run = status === "planning" ? bundle.run : await runs.setAgentRunStatus(bundle.run, status);
            assert.ok(run);
            const record = await tasks.getStoredGenerationTaskRecord("agent", run.id);
            assert.ok(record);
            expect(record.payload).toMatchObject({ id: run.id, userId, status, tasks: [] });
            expect(record.workerId).toBeUndefined();
            expect(record.leaseUntil).toBeUndefined();
            expect(record.payload.executionId).toBeUndefined();
            expect(record.payload.cancellation).toBeUndefined();
            return run;
        }

        async function claimRunImage(run: AgentRun) {
            const task = await imageTasks.createImageTask({
                userId,
                username: "fixture-image-native-capture",
                displayName: "Isolated image native capture fixture",
                kind: "generation",
                source: "image-workbench",
                runId: run.id,
                conversationId: run.conversationId,
                surface: run.surface,
                config: { baseUrl: "https://image.example.com", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model" },
                prompt: "Preserve the original image claim and Run binding",
                references: [],
                attemptNo: 1,
            });
            assert.ok(await imageTasks.transitionImageTask(task, ["pending"], { status: "running" }));
            await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "created", nextPollAt: Date.now() - 1 });
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [task.id], limit: 1 });
            assert.equal(claimed.length, 1);
            const lease = claimed[0];
            assert.ok(lease?.executionId);
            const record = await imageRecord(task.id);
            expect(record.runId).toBe(run.id);
            expect(record.payload.runId).toBe(run.id);
            expect(record.conversationId).toBe(run.conversationId);
            expect(record.payload.conversationId).toBe(run.conversationId);
            return { taskId: task.id, workerId, executionId: lease.executionId, attemptNo: 1, upstreamTaskId: null, result: providerResult, origin: "https://image.example.com", authContext: "" };
        }

        async function completeRecord(type: "image" | "agent", id: string) {
            if (provider === "postgres") {
                const result = await database.postgresQuery<{ payload: Record<string, unknown> }>("SELECT * FROM generation_tasks WHERE id = $1 AND task_type = $2", [id, type]);
                const record = result.rows[0];
                assert.ok(record);
                return record;
            }
            const record = await tasks.getStoredGenerationTaskRecord(type, id);
            assert.ok(record);
            return record;
        }

        async function sealedRunImage(run: AgentRun) {
            const original = await claimRunImage(run);
            const outcome = await capture.captureImageTaskNativeResults(original);
            assert.ok(outcome.state === "native_ready");
            expect((await imageRecord(original.taskId)).payload.nativeResults).toEqual(outcome.nativeResults);
            expect(outcome.nativeResults.slots).toHaveLength(1);
            const slot = outcome.nativeResults.slots[0];
            assert.ok(slot?.status === "stored");
            return { original, nativeResults: outcome.nativeResults, slot };
        }

        type RunFenceRejection = "cancellation" | "cancelled" | "completed" | "failed";

        async function blockRun(run: AgentRun, taskId: string, reason: RunFenceRejection) {
            const runs = await import("./agent-run-store");
            const cancellation = { requestedAt: Date.now(), pendingChildTaskIds: [taskId] };
            const blocked = reason === "cancellation" ? await runs.updateAgentRunById(run.id, { cancellation }) : await runs.setAgentRunStatus(run, reason);
            assert.ok(blocked);
            const record = await tasks.getStoredGenerationTaskRecord("agent", run.id);
            assert.ok(record);
            expect(record.payload.status).toBe(reason === "cancellation" ? "running" : reason);
            expect(record.payload.cancellation).toEqual(reason === "cancellation" ? cancellation : undefined);
            return blocked;
        }

        async function immediateRemoteImageSource(taskId: string) {
            const remote = await remoteImageSource(taskId);
            // Rejected captures never request media; close settles that unused request gate.
            const serving = Promise.allSettled([
                remote.nextRequest().then(async (request) => {
                    await request.writePrefix();
                    request.finish();
                }),
            ]);
            return {
                url: remote.url,
                get requestCount() {
                    return remote.requestCount;
                },
                async close() {
                    try {
                        await remote.close();
                    } finally {
                        await serving;
                    }
                },
            };
        }

        const nonterminalRunStatuses: AgentRunStatus[] = ["planning", "running", "paused"];

        it.each(nonterminalRunStatuses)(
            "Run fence permits native capture for an ordinary %s Run without an Agent lease or logical copy link",
            async (status) => {
                const run = await ordinaryRun(status);
                const original = await claimRunImage(run);
                const imageBefore = await completeRecord("image", original.taskId);
                const runBefore = await completeRecord("agent", run.id);
                expect(await nativeAssets(original.taskId)).toEqual([]);

                const outcome = await capture.captureImageTaskNativeResults(original);

                assert.ok(outcome.state === "native_ready");
                expect(outcome.nativeResults).toMatchObject({
                    version: "image-task-native-results.v1",
                    attemptNo: 1,
                    upstreamTaskId: null,
                    slots: [{ resultId: `${original.taskId}:1`, resultIndex: 1, status: "stored", sha256: "a19d822cdb8eebfbbd5a5521f524b002fee7db2dc90513e6647ec005ed6b1db6", bytes: 95 }],
                });
                expect(await completeRecord("agent", run.id)).toEqual(runBefore);
                expect(await completeRecord("image", original.taskId)).toEqual({
                    ...imageBefore,
                    [provider === "postgres" ? "updated_at" : "updatedAt"]: expect.anything(),
                    payload: { ...imageBefore.payload, nativeResults: outcome.nativeResults, updatedAt: expect.any(Number) },
                });
                expect(await nativeAssets(original.taskId)).toHaveLength(1);
                const slot = outcome.nativeResults.slots[0];
                assert.ok(slot?.status === "stored");
                expect(await registrations.getLocalMediaRegistration(slot.storageKey)).toMatchObject({ ownerUserId: userId, taskId: original.taskId, source: "image-task-native-result", bytes: 95 });
                expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, slot.storageKey))).toEqual(source);
            },
            30_000,
        );

        const rejectedRunStates: RunFenceRejection[] = ["cancellation", "cancelled", "completed", "failed"];

        it.each(rejectedRunStates)(
            "Run fence rejects preexisting %s before native acquisition without changing complete records or registrations",
            async (reason) => {
                const run = await ordinaryRun("running");
                const original = await claimRunImage(run);
                await blockRun(run, original.taskId, reason);
                const imageBefore = await completeRecord("image", original.taskId);
                const runBefore = await completeRecord("agent", run.id);
                const assetsBefore = await nativeAssets(original.taskId);
                expect(imageBefore.payload.nativeAcquisition).toBeUndefined();
                expect(imageBefore.payload.nativeResults).toBeUndefined();
                expect(imageBefore.payload.resultProcessing).toBeUndefined();
                expect(assetsBefore).toEqual([]);
                const remote = await immediateRemoteImageSource(original.taskId);
                try {
                    expect(await capture.captureImageTaskNativeResults({ ...original, result: { dataUrl: remote.url } })).toEqual({ state: "ownership_lost" });

                    expect(remote.requestCount).toBe(0);
                    expect(await completeRecord("image", original.taskId)).toEqual(imageBefore);
                    expect(await completeRecord("agent", run.id)).toEqual(runBefore);
                    expect(await nativeAssets(original.taskId)).toEqual(assetsBefore);
                } finally {
                    await remote.close();
                }
            },
            30_000,
        );

        it("Run fence permits pure local sealed reuse for an ordinary paused Run without cancellation", async () => {
            const run = await ordinaryRun();
            const sealed = await sealedRunImage(run);
            const runs = await import("./agent-run-store");
            const paused = await runs.setAgentRunStatus(run, "paused");
            assert.ok(paused);
            expect(paused.status).toBe("paused");
            expect(paused.cancellation).toBeUndefined();
            const imageBefore = await completeRecord("image", sealed.original.taskId);
            const runBefore = await completeRecord("agent", run.id);
            const assetsBefore = await nativeAssets(sealed.original.taskId);
            expect(assetsBefore).toHaveLength(1);
            const remote = await immediateRemoteImageSource(sealed.original.taskId);
            try {
                expect(await capture.captureImageTaskNativeResults({ ...sealed.original, result: { dataUrl: remote.url } })).toEqual({ state: "native_ready", nativeResults: sealed.nativeResults });

                expect(remote.requestCount).toBe(0);
                expect(await completeRecord("image", sealed.original.taskId)).toEqual(imageBefore);
                expect(await completeRecord("agent", run.id)).toEqual(runBefore);
                expect(await nativeAssets(sealed.original.taskId)).toEqual(assetsBefore);
                expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
            } finally {
                await remote.close();
            }
        }, 30_000);

        const rejectedReuseStates: RunFenceRejection[] = ["cancellation", "completed"];

        it.each(rejectedReuseStates)(
            "Run fence rejects sealed native reuse after %s without changing the complete mapping, Run or registrations",
            async (reason) => {
                const run = await ordinaryRun("running");
                const sealed = await sealedRunImage(run);
                await blockRun(run, sealed.original.taskId, reason);
                const imageBefore = await completeRecord("image", sealed.original.taskId);
                const runBefore = await completeRecord("agent", run.id);
                const assetsBefore = await nativeAssets(sealed.original.taskId);
                expect(imageBefore.payload.nativeResults).toEqual(sealed.nativeResults);
                expect(assetsBefore).toHaveLength(1);
                const remote = await immediateRemoteImageSource(sealed.original.taskId);
                try {
                    expect(await capture.captureImageTaskNativeResults({ ...sealed.original, result: { dataUrl: remote.url } })).toEqual({ state: "ownership_lost" });

                    expect(remote.requestCount).toBe(0);
                    expect(await completeRecord("image", sealed.original.taskId)).toEqual(imageBefore);
                    expect(await completeRecord("agent", run.id)).toEqual(runBefore);
                    expect(await nativeAssets(sealed.original.taskId)).toEqual(assetsBefore);
                    expect(await readFile(path.join(media.REFERENCE_MEDIA_ROOT, sealed.slot.storageKey))).toEqual(source);
                } finally {
                    await remote.close();
                }
            },
            30_000,
        );

        it("Run fence rejects cancellation persisted during real native media I/O while preserving the complete post-cancellation records", async () => {
            const run = await ordinaryRun("running");
            const original = await claimRunImage(run);
            const remote = await remoteImageSource(original.taskId);
            const running = remote.capture({ ...original, result: { dataUrl: remote.url } });
            try {
                const request = await running.request;
                expect(request.record.payload.nativeAcquisition).toEqual({
                    version: "image-task-native-acquisition.v1",
                    attemptNo: 1,
                    upstreamTaskId: null,
                    slots: [{ resultId: `${original.taskId}:1`, resultIndex: 1, source: { url: remote.url } }],
                });
                expect(request.record.payload.nativeResults).toBeUndefined();
                expect(request.record.payload.resultProcessing).toBeUndefined();
                expect(await nativeAssets(original.taskId)).toEqual([]);
                await request.writePrefix();

                await blockRun(run, original.taskId, "cancellation");
                const pending = await imageRecord(original.taskId);
                expect(pending.workerId).toBe(workerId);
                expect(pending.payload.executionId).toBe(original.executionId);
                expect(pending.payload.status).toBe("running");
                expect(pending.payload.nativeAcquisition).toEqual(request.record.payload.nativeAcquisition);
                expect(pending.leaseUntil).toBeGreaterThan(Date.now());
                expect(pending.payload.nativeResults).toBeUndefined();
                expect(pending.payload.resultProcessing).toBeUndefined();
                expect(await nativeAssets(original.taskId)).toEqual([]);
                const imageBefore = await completeRecord("image", original.taskId);
                const runBefore = await completeRecord("agent", run.id);

                request.finish();

                expect(await running.result).toEqual({ state: "ownership_lost" });
                expect(await completeRecord("image", original.taskId)).toEqual(imageBefore);
                expect(await completeRecord("agent", run.id)).toEqual(runBefore);
                expect(remote.requestCount).toBe(1);
            } finally {
                await remote.close();
            }
        }, 30_000);

        it("Run fence rejects an original Run binding changed during real native media I/O while both Runs remain legal", async () => {
            const runA = await ordinaryRun("running");
            const runB = await ordinaryRun("running", runA.conversationId);
            const original = await claimRunImage(runA);
            const remote = await remoteImageSource(original.taskId);
            const running = remote.capture({ ...original, result: { dataUrl: remote.url } });
            try {
                const request = await running.request;
                expect(request.record.runId).toBe(runA.id);
                expect(request.record.payload.runId).toBe(runA.id);
                expect(request.record.payload.nativeAcquisition).toEqual({
                    version: "image-task-native-acquisition.v1",
                    attemptNo: 1,
                    upstreamTaskId: null,
                    slots: [{ resultId: `${original.taskId}:1`, resultIndex: 1, source: { url: remote.url } }],
                });
                expect(request.record.payload.nativeResults).toBeUndefined();
                expect(request.record.payload.resultProcessing).toBeUndefined();
                expect(await nativeAssets(original.taskId)).toEqual([]);
                await request.writePrefix();

                await tasks.linkStoredGenerationTask("image", original.taskId, { runId: runB.id, conversationId: runB.conversationId });
                const pending = await imageRecord(original.taskId);
                expect(pending.runId).toBe(runB.id);
                expect(pending.payload.runId).toBe(runB.id);
                expect(pending.workerId).toBe(workerId);
                expect(pending.payload.executionId).toBe(original.executionId);
                expect(pending.payload.attemptNo).toBe(1);
                expect(pending.upstreamTaskId).toBeUndefined();
                expect(pending.payload.upstream).toBeUndefined();
                expect(pending.payload.nativeAcquisition).toEqual(request.record.payload.nativeAcquisition);
                expect(pending.leaseUntil).toBeGreaterThan(Date.now());
                expect(pending.payload.nativeResults).toBeUndefined();
                expect(pending.payload.resultProcessing).toBeUndefined();
                expect(await nativeAssets(original.taskId)).toEqual([]);
                const imageBefore = await completeRecord("image", original.taskId);
                const runABefore = await completeRecord("agent", runA.id);
                const runBBefore = await completeRecord("agent", runB.id);
                expect(runABefore.payload.status).toBe("running");
                expect(runBBefore.payload.status).toBe("running");
                expect(runABefore.payload.cancellation).toBeUndefined();
                expect(runBBefore.payload.cancellation).toBeUndefined();

                request.finish();

                expect(await running.result).toEqual({ state: "ownership_lost" });
                expect(await completeRecord("image", original.taskId)).toEqual(imageBefore);
                expect(await completeRecord("agent", runA.id)).toEqual(runABefore);
                expect(await completeRecord("agent", runB.id)).toEqual(runBBefore);
                expect(remote.requestCount).toBe(1);
            } finally {
                await remote.close();
            }
        }, 30_000);
    });
}
