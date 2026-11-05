import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { ImageTask } from "./image-task-store";
import type { PreparedEnhancementPublication } from "./image-enhancement-processing-store";

const session = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("@/lib/auth/session", async (original) => ({ ...(await original<typeof import("@/lib/auth/session")>()), getCurrentUser: session.current }));

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function enhancementProcessingRelationSuite(provider: "file" | "postgres") {
    describe(`${provider} enhancement CPU publication relation`, () => {
        let directory: string;
        let userId: string;
        let database: typeof import("./database");
        let tasks: typeof import("./generation-task-store");
        let jobs: typeof import("./database/image-enhancement-job-repository");
        let store: typeof import("./image-enhancement-processing-store");
        let service: typeof import("./image-processing-service");
        let adapter: typeof import("./data-adapter");
        let references: typeof import("./reference-asset-store");
        let registrations: typeof import("./local-media-registry");
        let logs: typeof import("./generation-log-repository");

        beforeEach(async () => {
            if (
                provider === "postgres" &&
                (process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION !== "1" ||
                    process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" ||
                    process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" ||
                    process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" ||
                    !process.env.DATABASE_URL)
            )
                throw new Error("SETUP: explicit owned isolated PostgreSQL with startup pool maximum one is required");
            vi.resetModules();
            session.current.mockReset();
            userId = "";
            directory = await mkdtemp(join(tmpdir(), `vozeb-enhancement-relation-${provider}-`));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
            vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "8192");
            vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "6144");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
            database = await import("./database");
            if (provider === "postgres") await database.initializePostgresSchema();
            [tasks, jobs, store, service, adapter, references, registrations, logs] = await Promise.all([
                import("./generation-task-store"),
                import("./database/image-enhancement-job-repository"),
                import("./image-enhancement-processing-store"),
                import("./image-processing-service"),
                import("./data-adapter"),
                import("./reference-asset-store"),
                import("./local-media-registry"),
                import("./generation-log-repository"),
            ]);
            expect((await (await import("./object-storage-config")).getObjectStorageRuntimeConfig()).enabled).toBe(false);
            if (provider === "file") {
                const auth = await import("@/lib/auth/store-repository");
                userId = "fixture-enhancement-relation-" + randomUUID();
                await auth.mutateAuthDb((db) => {
                    db.users.push({
                        id: userId,
                        accountId: "9001",
                        username: "fixture_enhancement_relation",
                        displayName: "Enhancement relation fixture",
                        bio: "",
                        role: "user",
                        adminPermissions: [],
                        status: "active",
                        planId: db.settings.entitlements.defaultPlanId,
                        pointsBalance: 0,
                        passwordHash: "fixture-only",
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    });
                });
            } else {
                const repositories = database.createPostgresRepositories();
                const settings = await repositories.settings.getSettings();
                const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
                assert.ok(planId, "SETUP: fixture entitlement plan missing");
                userId = "fixture-enhancement-relation-" + randomUUID();
                await repositories.users.createWithNextAccountId({
                    id: userId,
                    username: "fixture_" + randomUUID().replaceAll("-", "").slice(0, 16),
                    displayName: "Enhancement relation fixture",
                    bio: "",
                    role: "user",
                    adminPermissions: [],
                    status: "active",
                    planId,
                    pointsBalance: 0,
                    passwordHash: "fixture-only",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
            }
        });
        afterEach(async () => {
            vi.restoreAllMocks();
            try {
                if (provider === "postgres" && userId) {
                    await database.postgresQuery("DELETE FROM image_enhancement_jobs WHERE user_id=$1", [userId]);
                    await database.createPostgresRepositories().users.delete(userId);
                    expect((await database.postgresQuery("SELECT id FROM users WHERE id=$1", [userId])).rows).toStrictEqual([]);
                    expect((await database.postgresQuery("SELECT id FROM generation_tasks WHERE user_id=$1", [userId])).rows).toStrictEqual([]);
                    expect((await database.postgresQuery("SELECT storage_key FROM local_media_assets WHERE owner_user_id=$1", [userId])).rows).toStrictEqual([]);
                }
            } finally {
                vi.unstubAllEnvs();
                await rm(directory, { recursive: true, force: true });
            }
        });

        async function fixture(leaseMs = 60_000) {
            const imageTaskId = randomUUID();
            const enhancementId = "enhancement:" + imageTaskId + ":1";
            const nativeBytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#517b9d" } })
                .png()
                .toBuffer();
            const aiBytes = await sharp(nativeBytes).resize(128, 128).ensureAlpha().toColourspace("rgb16").png().toBuffer();
            const nativeAsset = await logs.writeAssetBytes(nativeBytes, "image/png", "image", { ownerUserId: userId, source: "image-workbench", taskId: imageTaskId });
            assert.ok(nativeAsset.serverUrl);
            const native = { url: nativeAsset.serverUrl, sha256: digest(nativeBytes), width: 32, height: 32, byteLength: nativeBytes.length, format: "png", hasAlpha: false, provenance: "provider_native" as const };
            const result = { resultId: imageTaskId + ":1", enhancementId, dataUrl: native.url, serverUrl: native.url, nativeSource: native, width: 32, height: 32, bytes: nativeBytes.length, mimeType: "image/png" };
            await tasks.createStoredGenerationTask<ImageTask>(
                "image",
                {
                    id: imageTaskId,
                    userId,
                    username: "fixture_enhancement_relation",
                    displayName: "Enhancement relation fixture",
                    kind: "generation",
                    source: "image-workbench",
                    status: "success",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    config: { baseUrl: "https://fixture.invalid", apiKey: "system", apiFormat: "openai", model: "fixture", quality: "4k", size: "64x64" },
                    prompt: "Enhancement relation fixture",
                    references: [],
                    result: { ...result, results: [result] },
                },
                60_000,
            );
            const model = { id: "fixture-x4", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4 as const, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 };
            const now = Date.now();
            const parent: ImageEnhancementJob = {
                id: enhancementId,
                userId,
                imageTaskId,
                resultId: result.resultId,
                status: "running",
                phase: "publish",
                reason: null,
                attempt: 1,
                remoteKey: enhancementId + ":1",
                remoteJobId: "fixture-remote",
                remoteStatus: "succeeded",
                receiptId: randomUUID(),
                cancelRequested: false,
                createdAt: now,
                updatedAt: now,
                nextPollAt: now,
                workerId: "fixture-parent-worker",
                leaseToken: randomUUID(),
                leaseUntil: now + leaseMs,
                events: [],
                decision: {
                    status: "queued",
                    reason: null,
                    source: native,
                    target: { width: 64, height: 64 },
                    inference: { width: 128, height: 128 },
                    connection: { revision: "fixture-policy", credentialRef: "fixture-credential", serviceId: "fixture-service", timeoutMs: 60_000, model },
                },
                remotePlan: {
                    protocolVersion: "image-enhancement.v1",
                    scope: "full_image",
                    normalizationProfile: "srgb-upright-v1",
                    source: native,
                    sourceSha256: native.sha256,
                    target: { width: 128, height: 128, format: "png" },
                    engine: { modelId: model.id, binaryVersion: model.binaryVersion, binarySha256: model.binarySha256, modelVersion: model.modelVersion, modelSha256: model.modelSha256, nativeScale: 4, tile: 0, tta: false, gpuId: 0 },
                    budgets: { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } },
                    planFingerprint: "d".repeat(64),
                    strategyFingerprint: "e".repeat(64),
                },
                remoteResult: { width: 128, height: 128, format: "png", byteLength: aiBytes.length, sha256: digest(aiBytes) },
            };
            await jobs.insertEnhancementJob(parent);
            const image = await tasks.getStoredGenerationTaskRecord("image", imageTaskId);
            assert.ok(image);
            const binding = store.currentEnhancementPublicationBinding(parent, image, Date.now());
            const aiPath = join(directory, "raw-ai.png");
            await writeFile(aiPath, aiBytes);
            const ai = await references.writeReferenceMediaFile(aiPath, "image", "image/png", false, { ownerUserId: userId, source: "enhancement-raw-ai", taskId: enhancementId, maxBytes: 1_000_000 });
            const registration = await registrations.getLocalMediaRegistration(ai.token);
            assert.ok(registration);
            const observed = { expectedSha256: digest(aiBytes), width: 128, height: 128 };
            const input = { assetId: "raw-ai:" + enhancementId, assetVersion: store.enhancementInputAssetVersion(registration, observed), expectedSha256: observed.expectedSha256 };
            const source = { inputIndex: 0, scope: registration.scope, storageKey: ai.token, storageProvider: "local" as const };
            const metadata = await sharp(aiBytes).metadata();
            assert.ok(metadata.format && metadata.depth && metadata.channels);
            expect(metadata.depth).toBe("ushort");
            const identity = { inputIndex: 0, assetId: input.assetId, assetVersion: input.assetVersion, sha256: input.expectedSha256 };
            const prepared: PreparedEnhancementPublication = {
                binding,
                options: {
                    scope: "full_image",
                    bindingDigest: binding.bindingDigest,
                    resultId: result.resultId,
                    resultIndex: 1,
                    aiInputIndex: 0,
                    engineInput: { width: 32, height: 32 },
                    expectedAi: parent.remoteResult!,
                    targetSize: { width: 64, height: 64 },
                    budgets: parent.remotePlan!.budgets,
                },
                inputs: [input],
                sources: [source],
                facts: { encodedInputs: [{ ...identity, bytes: aiBytes.length, layout: { format: metadata.format, depth: metadata.depth, channels: metadata.channels } }], decodedInputs: [{ ...identity, width: 128, height: 128 }] },
                frozenInputs: [{ ...input, ...source, ...observed, ownerUserId: userId, bytes: aiBytes.length, width: 128, height: 128, mimeType: "image/png" }],
                rawAi: { input, source },
            };
            return { parent, image, prepared };
        }

        async function legacyDeliveryFixture() {
            const input = await fixture();
            const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#df9762" } })
                .png()
                .toBuffer();
            const saved = await logs.writeAssetBytes(bytes, "image/png", "image", { ownerUserId: userId, source: "image-workbench", taskId: input.parent.id });
            assert.ok(saved.serverUrl);
            const key = new URL(saved.serverUrl, "http://fixture.local").pathname.slice("/api/generation-log-assets/".length).split("/").map(decodeURIComponent).join("/");
            const filePath = join(directory, "generation-assets", key);
            const actualBytes = await readFile(filePath);
            const registration = await registrations.getLocalMediaRegistration(key);
            assert.ok(registration);
            const expected = { sha256: digest(actualBytes), byteLength: actualBytes.length, width: 64, height: 64, format: "png" as const };
            const stored = { ...expected, url: saved.serverUrl };
            const parent = await jobs.mutateEnhancementJob(input.parent.id, userId, (row) => ({ ...row, staged: { delivered: stored } }));
            assert.ok(parent);
            const observed = { expectedSha256: expected.sha256, width: 64, height: 64 };
            const deliveryInput = { assetId: "legacy-delivery:" + parent.id, assetVersion: store.enhancementInputAssetVersion(registration, observed), expectedSha256: expected.sha256 };
            const deliverySource = { inputIndex: 1, scope: registration.scope, storageKey: key, storageProvider: "local" as const };
            const metadata = await sharp(actualBytes).metadata();
            assert.ok(metadata.format && metadata.depth && metadata.channels);
            const identity = { inputIndex: 1, assetId: deliveryInput.assetId, assetVersion: deliveryInput.assetVersion, sha256: expected.sha256 };
            const prepared: PreparedEnhancementPublication = {
                ...input.prepared,
                options: { ...input.prepared.options, stagedDelivered: { inputIndex: 1, expected } },
                inputs: [...input.prepared.inputs, deliveryInput],
                sources: [...input.prepared.sources, deliverySource],
                frozenInputs: [...input.prepared.frozenInputs, { ...deliveryInput, ...deliverySource, ownerUserId: userId, bytes: expected.byteLength, width: 64, height: 64, mimeType: "image/png" }],
                facts: {
                    encodedInputs: [...input.prepared.facts.encodedInputs, { ...identity, bytes: expected.byteLength, layout: { format: metadata.format, depth: metadata.depth, channels: metadata.channels } }],
                    decodedInputs: [...input.prepared.facts.decodedInputs, { ...identity, width: 64, height: 64 }],
                },
            };
            return { input, parent, prepared, stored, registration, filePath, actualBytes };
        }

        async function claimAvailable() {
            const config = (await import("../image-processing/resource-config")).imageProcessingResourceConfig(process.env);
            return service.claimImageProcessingTasks({ workerId: "fixture-cpu-worker", profileVersion: config.profileVersion, availableMemoryBytes: config.budgetBytes, slots: 1 });
        }
        async function heldParent(parent: ImageEnhancementJob, run: () => Promise<void>) {
            let release!: () => void;
            let acquired!: () => void;
            const held = new Promise<void>((resolve) => {
                acquired = resolve;
            });
            const untilReleased = new Promise<void>((resolve) => {
                release = resolve;
            });
            const hold =
                provider === "postgres"
                    ? database.withPostgresTransaction(async (executor) => {
                          await executor.query("SELECT id FROM image_enhancement_jobs WHERE id=$1 FOR UPDATE", [parent.id]);
                          acquired();
                          await untilReleased;
                      })
                    : jobs.withEnhancementJobFileLock(parent.id, parent.userId, async () => {
                          acquired();
                          await untilReleased;
                      });
            await held;
            try {
                await run();
            } finally {
                release();
                await hold;
            }
        }

        it("persists one unavailable child without an execution identity and leaves the successful original unchanged", async () => {
            const input = await fixture();
            const enqueued = await store.enqueueEnhancementPublication(input.parent, input.prepared);
            const child = await store.readEnhancementProcessingTask(enqueued.id);
            assert.ok(child);
            expect(child).toMatchObject({
                id: "image-process-" + child.payload.inputDigest,
                parentTaskId: input.parent.id,
                status: "paused",
                executionPhase: "needs_review",
                attemptNo: 0,
                payload: { operation: "process_enhancement", resource: { unavailable: { code: "image_processing_resource_unavailable", reason: "profile_uncalibrated" } } },
            });
            expect([child.payload.executionId, child.workerId, child.leaseUntil, child.lastHeartbeatAt, child.runId]).toEqual([undefined, undefined, undefined, undefined, undefined]);
            expect(Object.keys(child.resultPayload || {})).toEqual([]);
            const parent = await jobs.getEnhancementJob(input.parent.id, userId);
            expect(parent).toMatchObject({
                status: "failed",
                phase: "publish",
                nextPollAt: null,
                workerId: null,
                leaseToken: null,
                leaseUntil: null,
                publicationProcessing: { jobId: child.id, admission: { kind: "never_started_unavailable", reason: "profile_uncalibrated" } },
            });
            expect(parent?.publication).toBeUndefined();
            expect(parent?.publicationProcessing?.outcome).toBeUndefined();
            expect(await claimAvailable()).toEqual({ tasks: [] });
            expect(await tasks.getStoredGenerationTaskRecord("image", input.parent.imageTaskId)).toStrictEqual(input.image);
        });

        it.each(["unchanged", "heap_only"] as const)("rejects %s retry through the public service while retaining the exact admission and child", async (change) => {
            const input = await fixture();
            const enqueued = await store.enqueueEnhancementPublication(input.parent, input.prepared);
            const child = await store.readEnhancementProcessingTask(enqueued.id);
            assert.ok(child);
            const parent = await jobs.getEnhancementJob(input.parent.id, userId);
            assert.ok(parent);
            const heap = { unchanged: "384", heap_only: "512" };
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", heap[change]);
            await expect(service.retryEnhancementPublication(parent)).rejects.toMatchObject({ status: 409 });
            expect(await jobs.getEnhancementJob(parent.id, userId)).toStrictEqual(parent);
            expect(await store.readEnhancementProcessingTask(child.id)).toStrictEqual(child);
            expect(await claimAvailable()).toEqual({ tasks: [] });
            expect(await tasks.getStoredGenerationTaskRecord("image", parent.imageTaskId)).toStrictEqual(input.image);
        });

        it("returns the actual resource conflict as HTTP409 through the authenticated control route", async () => {
            const input = await fixture();
            const enqueued = await store.enqueueEnhancementPublication(input.parent, input.prepared);
            const child = await store.readEnhancementProcessingTask(enqueued.id);
            const parent = await jobs.getEnhancementJob(input.parent.id, userId);
            assert.ok(child && parent);
            session.current.mockResolvedValue({ id: userId, role: "user" });
            const route = await import("@/app/api/image-enhancements/[id]/route");
            const response = await route.POST(new Request("http://fixture.local/api/image-enhancements/" + encodeURIComponent(parent.id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry" }) }), {
                params: Promise.resolve({ id: parent.id }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual({ code: 409, data: null, msg: "profile_uncalibrated" });
            expect(await jobs.getEnhancementJob(parent.id, userId)).toStrictEqual(parent);
            expect(await store.readEnhancementProcessingTask(child.id)).toStrictEqual(child);
        });

        it("rejects a different raw AI locator before persisting a child or checkpoint", async () => {
            const input = await fixture();
            const prepared = { ...input.prepared, rawAi: { ...input.prepared.rawAi, input: { ...input.prepared.rawAi.input, assetId: "different-raw-ai" } } };
            await expect(store.enqueueEnhancementPublication(input.parent, prepared)).rejects.toMatchObject({ status: 409 });
            expect(await jobs.getEnhancementJob(input.parent.id, userId)).toStrictEqual(input.parent);
            expect(await store.findEnhancementPublicationChild(input.parent, input.prepared.binding.bindingDigest)).toBeNull();
        });

        it("rejects omitted legacy delivery roles from persisted parent facts and preserves the original PNG", async () => {
            const legacy = await legacyDeliveryFixture();
            await expect(store.enqueueEnhancementPublication(legacy.parent, legacy.input.prepared)).rejects.toMatchObject({ status: 409 });
            expect(await jobs.getEnhancementJob(legacy.parent.id, userId)).toStrictEqual(legacy.parent);
            expect(await store.findEnhancementPublicationChild(legacy.parent, legacy.prepared.binding.bindingDigest)).toBeNull();
            expect(await tasks.getStoredGenerationTaskRecord("image", legacy.parent.imageTaskId)).toStrictEqual(legacy.input.image);
            expect(await registrations.getLocalMediaRegistration(legacy.registration.storageKey)).toStrictEqual(legacy.registration);
            expect(await readFile(legacy.filePath)).toEqual(legacy.actualBytes);
        });

        it.each(["format", "sha256", "byteLength", "width", "height"] as const)("rejects persisted legacy delivery %s drift despite otherwise matching owned inputs", async (field) => {
            const legacy = await legacyDeliveryFixture();
            const descriptors = {
                format: { ...legacy.stored, format: "jpeg" as const },
                sha256: { ...legacy.stored, sha256: "0".repeat(64) },
                byteLength: { ...legacy.stored, byteLength: 1 },
                width: { ...legacy.stored, width: 63 },
                height: { ...legacy.stored, height: 63 },
            };
            const parent = await jobs.mutateEnhancementJob(legacy.parent.id, userId, (row) => ({ ...row, staged: { delivered: descriptors[field] } }));
            assert.ok(parent);
            await expect(store.enqueueEnhancementPublication(parent, legacy.prepared)).rejects.toMatchObject({ status: 409 });
            expect(await jobs.getEnhancementJob(parent.id, userId)).toStrictEqual(parent);
            expect(await store.findEnhancementPublicationChild(parent, legacy.prepared.binding.bindingDigest)).toBeNull();
            expect(await tasks.getStoredGenerationTaskRecord("image", parent.imageTaskId)).toStrictEqual(legacy.input.image);
            expect(await registrations.getLocalMediaRegistration(legacy.registration.storageKey)).toStrictEqual(legacy.registration);
            expect(await readFile(legacy.filePath)).toEqual(legacy.actualBytes);
        });

        it("cancels an unavailable never-claimed child without inventing a UUID", async () => {
            const input = await fixture();
            const enqueued = await store.enqueueEnhancementPublication(input.parent, input.prepared);
            const child = await store.readEnhancementProcessingTask(enqueued.id);
            assert.ok(child);
            const parent = await jobs.getEnhancementJob(input.parent.id, userId);
            assert.ok(parent);
            expect(await service.cancelEnhancementPublication(parent)).toMatchObject({ status: "queued", cancelRequested: true, publicationProcessing: { jobId: child.id } });
            const cancelled = await store.readEnhancementProcessingTask(child.id);
            expect(cancelled).toMatchObject({ status: "cancelled", executionPhase: "completed", attemptNo: 0 });
            expect([cancelled?.payload.executionId, cancelled?.workerId, cancelled?.leaseUntil, cancelled?.lastHeartbeatAt]).toEqual([undefined, undefined, undefined, undefined]);
            expect(Object.keys(cancelled?.resultPayload || {})).toEqual([]);
            expect(await claimAvailable()).toEqual({ tasks: [] });
        });

        it("rechecks the actual parent lease after a held lock passes its expiry", async () => {
            const input = await fixture(1_000);
            assert.ok(input.parent.leaseUntil! > Date.now());
            let pending!: Promise<unknown>;
            await heldParent(input.parent, async () => {
                pending = store.enqueueEnhancementPublication(input.parent, input.prepared);
                await new Promise<void>((resolve) => setTimeout(resolve, input.parent.leaseUntil! - Date.now() + 30));
            });
            await expect(pending).rejects.toMatchObject({ status: 409 });
            expect(await jobs.getEnhancementJob(input.parent.id, userId)).toStrictEqual(input.parent);
            expect(await store.findEnhancementPublicationChild(input.parent, input.prepared.binding.bindingDigest)).toBeNull();
        });

        if (provider === "postgres")
            it("rolls back relation assets and the parent when its lease expires during the asset write await", async () => {
                const input = await fixture();
                const child = await store.enqueueEnhancementPublication(input.parent, input.prepared);
                const creative = await import("./creative-runtime-store");
                const conversation = await creative.createCreativeConversation(userId, { surface: "chat", source: "image-workbench" });
                const rawAi = input.prepared.frozenInputs[0];
                const keys = store.enhancementRelationStorageKeys(child);
                // Leave the real enqueued child intact; make this owned parent available to the real claimant.
                await jobs.mutateEnhancementJob(input.parent.id, userId, (row) => ({ ...row, status: "running", reason: null, nextPollAt: Date.now(), workerId: null, leaseToken: null, leaseUntil: null }));
                const locker = new Client({ connectionString: database.getPostgresConnectionString() });
                let transactionOpen = false;
                let pending: Promise<unknown> | undefined;
                try {
                    await locker.connect();
                    const businessPid = (await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
                    const lockerPid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
                    assert.notEqual(businessPid, lockerPid);
                    await locker.query("BEGIN");
                    transactionOpen = true;
                    await locker.query("LOCK TABLE vozeb_pro_creative_assets IN SHARE MODE");
                    const [parent] = await jobs.claimEnhancementJobs({ workerId: "fixture-asset-await-parent", now: Date.now(), leaseMs: 1_000, limit: 1 });
                    assert.ok(parent?.leaseToken && parent.leaseUntil !== null);
                    expect(parent.id).toBe(input.parent.id);
                    const deadline = new Date(parent.leaseUntil).toISOString();
                    let settled = false;
                    pending = store.mutateEnhancementRelation(
                        store.enhancementRelationLocator(child),
                        keys,
                        async (state, executor) => {
                            assert.ok(executor);
                            const [asset] = await creative.registerCreativeAssets(
                                [
                                    {
                                        userId,
                                        conversationId: conversation.id,
                                        sourceRunId: "fixture:" + parent.imageTaskId,
                                        sourceTaskId: parent.id,
                                        ordinal: 0,
                                        type: "image",
                                        title: "Relation asset lease fixture",
                                        serverUrl: "/api/reference-assets/" + rawAi.storageKey,
                                        storageKind: "local",
                                        width: rawAi.width,
                                        height: rawAi.height,
                                        bytes: rawAi.bytes,
                                        mimeType: rawAi.mimeType,
                                        metadata: { provenance: "ai_enhanced", enhancementId: parent.id },
                                    },
                                ],
                                executor,
                            );
                            return { parent: { ...state.parent, reason: "fixture_asset_committed", updatedAt: state.now }, result: asset, requireOriginal: true };
                        },
                        { parentLease: { token: parent.leaseToken, now: Date.now() } },
                    );
                    void pending.then(
                        () => {
                            settled = true;
                        },
                        () => {
                            settled = true;
                        },
                    );
                    const waitTimeout = (await locker.query<{ remaining_ms: number }>("SELECT (EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) * 1000)::double precision AS remaining_ms", [deadline])).rows[0].remaining_ms;
                    expect(waitTimeout).toBeGreaterThan(0);
                    await expect
                        .poll(
                            async () => {
                                assert.ok(!settled, "Fixture setup: relation settled before the asset write lock wait was observed");
                                const observed = (
                                    await locker.query<{ active: boolean; blocked: boolean }>(
                                        `SELECT $3::timestamptz > clock_timestamp() AS active,
                                    $2::int = ANY(pg_blocking_pids($1::int)) AND EXISTS (
                                        SELECT 1 FROM pg_locks WHERE pid=$1::int AND relation='public.vozeb_pro_creative_assets'::regclass
                                            AND mode='RowExclusiveLock' AND NOT granted
                                    ) AS blocked`,
                                        [businessPid, lockerPid, deadline],
                                    )
                                ).rows[0];
                                assert.ok(observed.active, "Fixture setup: no asset write wait was observed before the actual parent lease expired");
                                return observed.blocked;
                            },
                            { timeout: waitTimeout },
                        )
                        .toBe(true);
                    await locker.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))))", [deadline]);
                    expect((await locker.query<{ expired: boolean }>("SELECT clock_timestamp() >= $1::timestamptz AS expired", [deadline])).rows[0].expired).toBe(true);
                    await locker.query("COMMIT");
                    transactionOpen = false;
                    await expect(pending).rejects.toThrow(store.EnhancementProcessingConflict);
                    expect(await creative.listCreativeAssets(conversation.id, userId)).toStrictEqual([]);
                    expect(await jobs.getEnhancementJob(parent.id, userId)).toStrictEqual(parent);
                } finally {
                    try {
                        if (transactionOpen) await locker.query("ROLLBACK");
                    } finally {
                        try {
                            if (pending) await pending.catch(() => undefined);
                        } finally {
                            await locker.end();
                        }
                    }
                }
            }, 30_000);

        if (provider === "file")
            it("rejects a child write after a successful lookup waits on relation locks beyond its actual TTL", async () => {
                const input = await fixture();
                const enqueued = await store.enqueueEnhancementPublication(input.parent, input.prepared);
                await tasks.withGenerationTaskFileMutation(async (records) => ({ tasks: records.map((record) => (record.id === enqueued.id ? { ...record, expiresAt: Date.now() + 1_000 } : record)), result: undefined }));
                const child = await store.readEnhancementProcessingTask(enqueued.id);
                const parent = await jobs.getEnhancementJob(input.parent.id, userId);
                assert.ok(child && parent);
                const read = store.readEnhancementProcessingTask;
                let sawLiveLookup!: () => void;
                const lookedUp = new Promise<void>((resolve) => {
                    sawLiveLookup = resolve;
                });
                const observer = vi.spyOn(store, "readEnhancementProcessingTask").mockImplementation(async (id, executor) => {
                    const found = await read(id, executor);
                    if (id === child.id && found) sawLiveLookup();
                    return found;
                });
                let pending!: ReturnType<typeof service.cancelEnhancementPublication>;
                await heldParent(parent, async () => {
                    pending = service.cancelEnhancementPublication(parent);
                    await lookedUp;
                    await new Promise<void>((resolve) => setTimeout(resolve, child.expiresAt - Date.now() + 30));
                });
                await expect(pending).rejects.toMatchObject({ status: 409 });
                observer.mockRestore();
                expect(await jobs.getEnhancementJob(parent.id, userId)).toStrictEqual(parent);
                expect(await tasks.withGenerationTaskFileRead(async (records) => records.find((record) => record.id === child.id))).toStrictEqual(child);
                expect(await tasks.getStoredGenerationTaskRecord("image", parent.imageTaskId)).toStrictEqual(input.image);
            });

        if (provider === "file")
            it("recovers the same durable orphan after the second File save fails", async () => {
                const input = await fixture();
                const write = adapter.writeJsonDataFile;
                const failure = vi.spyOn(adapter, "writeJsonDataFile").mockImplementation(async (filename, value) => {
                    if (filename === "image-enhancement-jobs.json") throw new Error("fixture second File save failed");
                    return write(filename, value);
                });
                await expect(store.enqueueEnhancementPublication(input.parent, input.prepared)).rejects.toThrow("fixture second File save failed");
                failure.mockRestore();
                const orphan = await store.findEnhancementPublicationChild(input.parent, input.prepared.binding.bindingDigest);
                assert.ok(orphan);
                expect(await jobs.getEnhancementJob(input.parent.id, userId)).toStrictEqual(input.parent);
                expect(orphan.payload.executionId).toBeUndefined();
                const recovered = await store.enqueueEnhancementPublication(input.parent, input.prepared);
                expect(recovered).toStrictEqual(orphan);
                expect((await jobs.getEnhancementJob(input.parent.id, userId))?.publicationProcessing?.jobId).toBe(orphan.id);
                expect(await store.findEnhancementPublicationChild(input.parent, input.prepared.binding.bindingDigest)).toStrictEqual(orphan);
                expect(await claimAvailable()).toEqual({ tasks: [] });
            });
    });
}
