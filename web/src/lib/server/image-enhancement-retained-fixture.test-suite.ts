import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { imageProcessingResourceConfig } from "../image-processing/resource-config";
import { estimateImageProcessingMemory } from "../image-processing/resource-model";
import type { FrozenImageEnhancementPolicy } from "./image-enhancement-config";
import type { ImageTask } from "./image-task-store";
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { EnhancementProcessingTask } from "./image-enhancement-processing-store";
import type { ImageProcessingManifest } from "./image-processing-service";
import type { LocalMediaRegistration } from "./local-media-registry";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";
import { openRetainedEnhancementWorker, retainedDataSnapshot, retainedDigest, retainedWorkerToken, type RetainedWorkerState } from "./image-enhancement-retained-worker-fixture";
import { completeClaimedImageProcessingFixture, readImageTaskResultBytesFixture } from "./image-processing.test-fixture";

const connection = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./image-enhancement-config", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./image-enhancement-config")>()),
    resolveImageEnhancementConnection: connection.resolve,
}));
vi.mock("next/headers", async (importOriginal) => ({
    ...(await importOriginal<typeof import("next/headers")>()),
    cookies: async () => ({ get: () => undefined }),
}));

type DatabaseIdentity = { name: string; oid: string; poolMax: string };
type RetainedLocators = { userId: string; conversationId: string; imageTaskId: string; enhancementId: string; childId: string; nativeStorageKey: string; rawStorageKey: string };
type RetainedManifest<BeforeState> = {
    provider: "file" | "postgres";
    database: DatabaseIdentity | null;
    nativeStorageKey: string;
    createdPid: number;
    identities: { userId: string; conversationId: string; imageTaskId: string; enhancementId: string; resultId: string; childId: string; inputDigest: string; bindingDigest: string };
    raw: { storageKey: string; sha256: string; bytes: number; expiresAt: string };
    resource: { modelVersion: string; profileVersion: string; factsDigest: string; configuration: ReturnType<typeof imageProcessingResourceConfig> };
    imageExpiresAt: number;
    childExpiresAt: number;
    earliestExpiresAt: number;
    remote: RetainedWorkerState;
    beforeState: BeforeState;
};
const policy = {
    revision: "retained-enhancement-fixture",
    enabled: true,
    connection: {
        revision: "retained-enhancement-fixture",
        credentialRef: "retained-fixture-credential",
        serviceId: "42424242-4242-4242-8242-424242424242",
        timeoutMs: 10_000,
        model: { id: "retained-fixture-x4", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 },
    },
} satisfies FrozenImageEnhancementPolicy;
const budgets = { input: { maxBytes: 20971520, maxPixels: 40000000 }, ai: { maxBytes: 167772160, maxPixels: 40000000 }, delivery: { maxBytes: 100663296, maxPixels: 40000000 } };
const workerToken = "retained-cpu-worker-token-".repeat(3);

// This manual integration entry stays inactive in normal suites; inactive cases supply no evidence.
export function retainedEnhancementFixtureSuite(provider: "file" | "postgres") {
    describe.skipIf(process.env.VOZEB_PRO_RUN_RETAINED_ENHANCEMENT_FIXTURE !== "1")(`retained enhancement admission fixture (${provider})`, () => {
        let root: string;
        let dataDirectory: string;
        let config: ReturnType<typeof imageProcessingResourceConfig>;
        let database: typeof import("./database");
        let databaseIdentity: DatabaseIdentity | null = null;
        let closeWorker: (() => Promise<void>) | undefined;
        let tasks: typeof import("./generation-task-store");
        let images: typeof import("./image-task-store");
        let jobs: typeof import("./database/image-enhancement-job-repository");
        let runtime: typeof import("./creative-runtime-store");
        let storage: typeof import("./generation-log-repository");
        let service: typeof import("./image-enhancement-service");
        let relations: typeof import("./image-enhancement-processing-store");
        let registry: typeof import("./local-media-registry");
        let generationAssetGet: typeof import("@/app/api/generation-log-assets/[...path]/route").GET;

        beforeAll(async () => {
            const requested = process.env.VOZEB_PRO_RETAINED_ENHANCEMENT_FIXTURE_DIR;
            assert.ok(requested && isAbsolute(requested), "Root must provide a new owned absolute fixture directory");
            root = resolve(requested);
            dataDirectory = join(root, "data");
            config = imageProcessingResourceConfig(process.env);
            vi.stubEnv("VOZEB_PRO_DATA_DIR", dataDirectory);
            vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
            vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "retained-maintenance-token-".repeat(3));
            vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
            if (provider === "file") {
                vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
                vi.stubEnv("DATABASE_URL", "");
                vi.stubEnv("POSTGRES_URL", "");
                vi.stubEnv("VOZEB_PRO_E2E_DATABASE_URL", "");
                database = await import("./database");
            } else {
                const poolMax = process.env.VOZEB_PRO_DATABASE_POOL_MAX;
                assert.ok(
                    process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1" && process.env.VOZEB_PRO_DATABASE_PROVIDER === "postgres" && poolMax === "1" && process.env.DATABASE_URL,
                    "SETUP: Root-owned isolated PostgreSQL and startup pool1 are required",
                );
                database = await import("./database");
                const identity = await database.postgresQuery<{ name: string; oid: string }>("SELECT current_database() AS name, oid::text AS oid FROM pg_database WHERE datname=current_database()");
                assert.equal(identity.rows.length, 1);
                const row = identity.rows[0];
                assert.equal(row.name, decodeURIComponent(new URL(database.getPostgresConnectionString()).pathname.slice(1)));
                databaseIdentity = { ...row, poolMax };
                await database.initializePostgresSchema();
            }
            [tasks, images, jobs, runtime, storage, service, relations, registry] = await Promise.all([
                import("./generation-task-store"),
                import("./image-task-store"),
                import("./database/image-enhancement-job-repository"),
                import("./creative-runtime-store"),
                import("./generation-log-repository"),
                import("./image-enhancement-service"),
                import("./image-enhancement-processing-store"),
                import("./local-media-registry"),
            ]);
            generationAssetGet = (await import("@/app/api/generation-log-assets/[...path]/route")).GET;
        });
        afterAll(async () => {
            try {
                await closeWorker?.();
            } finally {
                vi.restoreAllMocks();
                vi.unstubAllEnvs();
            }
            // Owned business and remote files survive success or failure for Root inspection/resume.
        });
        const mediaGet = async (request: Request) => {
            const url = new URL(request.url);
            return generationAssetGet(request, { params: Promise.resolve({ path: url.pathname.slice("/api/generation-log-assets/".length).split("/").map(decodeURIComponent) }) });
        };
        const connect = (endpoint: string) => {
            connection.resolve.mockImplementation(async (captured: NonNullable<FrozenImageEnhancementPolicy["connection"]>) => {
                expect(captured).toStrictEqual(policy.connection);
                return { endpoint, token: retainedWorkerToken, serviceId: captured.serviceId, timeoutMs: captured.timeoutMs, trust: "system", caPem: "" };
            });
        };
        const runWhenDue = async (enhancementId: string, userId: string, origin: string) => {
            const current = await jobs.getEnhancementJob(enhancementId, userId);
            assert.ok(current && current.nextPollAt !== null);
            await delay(Math.max(0, current.nextPollAt - Date.now()));
            return service.runImageEnhancementBatch({ origin, workerId: "retained-enhancement-parent", limit: 1 });
        };

        const recordDigest = (value: unknown) => retainedDigest(Buffer.from(JSON.stringify(value)));
        const retainedState = async (ids: RetainedLocators) => {
            if (provider === "file") return { provider, files: await retainedDataSnapshot(dataDirectory) };
            const owner = await database.createPostgresRepositories().users.getById(ids.userId);
            const conversation = await runtime.getCreativeConversation(ids.conversationId, ids.userId);
            const image = await tasks.getStoredGenerationTaskRecord("image", ids.imageTaskId);
            const child = await tasks.getStoredGenerationTaskRecord("image_processing", ids.childId);
            const parent = await jobs.getEnhancementJob(ids.enhancementId, ids.userId);
            const assets = await runtime.listCreativeAssets(ids.conversationId, ids.userId);
            const native = await registry.getLocalMediaRegistration(ids.nativeStorageKey);
            const raw = await registry.getLocalMediaRegistration(ids.rawStorageKey);
            assert.ok(owner && conversation && image && child && parent && native && raw);
            expect([image.userId, child.userId, native.ownerUserId, raw.ownerUserId]).toEqual([ids.userId, ids.userId, ids.userId, ids.userId]);
            return {
                provider,
                database: databaseIdentity,
                rows: {
                    owner: recordDigest(owner),
                    conversation: recordDigest(conversation),
                    image: recordDigest(image),
                    child: recordDigest(child),
                    enhancement: recordDigest(parent),
                    assets: recordDigest(assets),
                    nativeRegistration: recordDigest(native),
                    rawRegistration: recordDigest(raw),
                },
                mediaFiles: { generation: await retainedDataSnapshot(join(dataDirectory, "generation-assets")), references: await retainedDataSnapshot(join(dataDirectory, "reference-assets")) },
            };
        };
        type Manifest = RetainedManifest<Awaited<ReturnType<typeof retainedState>>>;
        type Readback = Pick<Manifest, "provider" | "database" | "createdPid" | "identities" | "remote" | "beforeState" | "earliestExpiresAt"> & { readbackPid: number; resumeExecuted: false };
        type ResumeWitness = {
            pid: number;
            manifest: Manifest;
            readback: Readback;
            parent: ImageEnhancementJob;
            child: EnhancementProcessingTask;
            original: NonNullable<Awaited<ReturnType<typeof tasks.getStoredGenerationTaskRecord>>>;
            assets: Awaited<ReturnType<typeof runtime.listCreativeAssets>>;
            raw: LocalMediaRegistration;
            native: LocalMediaRegistration;
        };
        const publishAndAcknowledge = async (witness: ResumeWitness, completedChild: EnhancementProcessingTask, taskIds: string[], worker: Awaited<ReturnType<typeof openRetainedEnhancementWorker>>) => {
            const { manifest, readback, parent, original, assets, raw, native } = witness;
            const { userId, conversationId, imageTaskId, enhancementId, childId } = manifest.identities;
            const rawPath = join(dataDirectory, "reference-assets", manifest.raw.storageKey);
            const nativePath = join(dataDirectory, "generation-assets", manifest.nativeStorageKey);
            await runWhenDue(enhancementId, userId, worker.endpoint);
            const published = await jobs.getEnhancementJob(enhancementId, userId);
            expect(published).toMatchObject({ status: "succeeded", phase: "receipt", remoteKey: parent.remoteKey, remoteJobId: parent.remoteJobId, receiptId: parent.receiptId });
            assert.ok(published?.publication);
            expect(published.receiptConfirmedAt).toBeUndefined();
            expect(published.publication.ai).toMatchObject(manifest.remote.output);
            const aiBytes = await readImageTaskResultBytesFixture(published.publication.ai.url);
            expect({ sha256: retainedDigest(aiBytes), byteLength: aiBytes.length }).toEqual({ sha256: manifest.remote.output.sha256, byteLength: manifest.remote.output.byteLength });
            expect(await sharp(aiBytes).metadata()).toMatchObject({ format: manifest.remote.output.format, width: manifest.remote.output.width, height: manifest.remote.output.height });
            const { delivered } = published.publication;
            const artifact = (completedChild.resultPayload!.manifest as ImageProcessingManifest).artifacts[0];
            expect(delivered).toMatchObject({ sha256: artifact.sha256, byteLength: artifact.bytes, width: 64, height: 64, format: "jpeg" });
            expect(delivered.url).toMatch(/^\/api\/generation-log-assets\//);
            const bytes = await readImageTaskResultBytesFixture(delivered.url);
            expect({ sha256: retainedDigest(bytes), bytes: bytes.length }).toEqual({ sha256: artifact.sha256, bytes: artifact.bytes });
            expect(await sharp(bytes).metadata()).toMatchObject({ format: "jpeg", width: 64, height: 64 });
            const publishedAssets = await runtime.listCreativeAssets(conversationId, userId);
            expect(publishedAssets).toHaveLength(assets.length + 1);
            expect(publishedAssets).toEqual(expect.arrayContaining(assets));
            expect(publishedAssets.find((asset) => asset.id === published.publication!.assetId)).toMatchObject({
                sourceTaskId: enhancementId,
                parentAssetId: assets[0].id,
                serverUrl: delivered.url,
                width: 64,
                height: 64,
                bytes: artifact.bytes,
                mimeType: "image/jpeg",
                metadata: { enhancementId, parentResultId: manifest.identities.resultId, nativeSha256: manifest.remote.sourceSha256, sha256: artifact.sha256 },
            });
            const beforeAck = await worker.readState();
            expect(beforeAck).toStrictEqual(readback.remote);
            expect(beforeAck.receipt).toBeUndefined();

            await runWhenDue(enhancementId, userId, worker.endpoint);
            const completed = await jobs.getEnhancementJob(enhancementId, userId);
            expect(completed).toMatchObject({ status: "succeeded", phase: "completed", publication: published.publication, remoteKey: parent.remoteKey, remoteJobId: parent.remoteJobId, receiptId: parent.receiptId, nextPollAt: null });
            expect(completed?.receiptConfirmedAt).toBeGreaterThanOrEqual(published.publication.publishedAt);
            const remote = await worker.readState();
            const ack = { serviceId: readback.remote.serviceId, receiptId: parent.receiptId, result: readback.remote.output };
            expect(remote).toStrictEqual({
                ...readback.remote,
                receipt: ack,
                requests: [...readback.remote.requests, { method: "GET", path: "/v1/capabilities" }, { method: "POST", path: `/v1/enhancement-jobs/${parent.remoteJobId}/receipt`, body: ack }],
            });
            expect(await tasks.getStoredGenerationTaskRecord("image", imageTaskId)).toStrictEqual(original);
            expect(await relations.readEnhancementProcessingTask(childId)).toStrictEqual(completedChild);
            expect((await tasks.listStoredGenerationTaskRecords({ userId, includeAll: true })).items.map((record) => record.id).sort()).toEqual(taskIds);
            expect(await registry.getLocalMediaRegistration(manifest.nativeStorageKey)).toStrictEqual(native);
            expect(await registry.getLocalMediaRegistration(manifest.raw.storageKey)).toStrictEqual(raw);
            expect(retainedDigest(await readFile(nativePath))).toBe(manifest.remote.sourceSha256);
            expect(retainedDigest(await readFile(rawPath))).toBe(manifest.raw.sha256);
            expect(manifest.earliestExpiresAt).toBeGreaterThan(Date.now());
            return { completed, remote, delivered, bytes };
        };

        const openCompletedRetainedPublication = async () => {
            assert.equal(provider, "file", "This tail resumes the retained File RED; the untouched PG fixture uses the full chain case");
            const witnesses = (await readdir(root)).filter((name) => /^resume-before-[0-9]+\.json$/.test(name));
            expect(witnesses).toHaveLength(1);
            const witness: ResumeWitness = JSON.parse(await readFile(join(root, witnesses[0]), "utf8"));
            const { manifest, readback, parent, original, assets, raw, native } = witness;
            const { userId, conversationId, imageTaskId, enhancementId, childId } = manifest.identities;
            const owner = JSON.parse(await readFile(join(root, "owner.json"), "utf8")) as { directory: string; createdPid: number; provider: "file" | "postgres"; database: DatabaseIdentity | null };
            expect(owner).toEqual({ directory: root, createdPid: manifest.createdPid, provider, database: databaseIdentity });
            expect(JSON.parse(await readFile(join(root, "before-calibration.json"), "utf8"))).toStrictEqual(manifest);
            expect(JSON.parse(await readFile(join(root, "readback.json"), "utf8"))).toStrictEqual(readback);
            expect(manifest.earliestExpiresAt).toBeGreaterThan(Date.now());
            expect(await tasks.getStoredGenerationTaskRecord("image", imageTaskId)).toStrictEqual(original);
            expect(await runtime.listCreativeAssets(conversationId, userId)).toStrictEqual(assets);
            expect(await registry.getLocalMediaRegistration(manifest.raw.storageKey)).toStrictEqual(raw);
            expect(await registry.getLocalMediaRegistration(manifest.nativeStorageKey)).toStrictEqual(native);
            const completedChild = await relations.readEnhancementProcessingTask(childId);
            const waiting = await jobs.getEnhancementJob(enhancementId, userId);
            assert.ok(completedChild && waiting);
            const outcome = relations.closedEnhancementOutcome(completedChild);
            assert.ok(outcome?.status === "completed");
            expect(waiting).toMatchObject({ status: "running", phase: "publish", remoteKey: parent.remoteKey, remoteJobId: parent.remoteJobId, receiptId: parent.receiptId, publicationProcessing: { outcome } });
            expect(waiting.publication).toBeUndefined();
            expect(completedChild).toMatchObject({
                id: childId,
                parentTaskId: enhancementId,
                status: "success",
                executionPhase: "completed",
                expiresAt: manifest.childExpiresAt,
                payload: { inputDigest: manifest.identities.inputDigest, enhancementBinding: { bindingDigest: manifest.identities.bindingDigest } },
            });
            const taskIds = (await tasks.listStoredGenerationTaskRecords({ userId, includeAll: true })).items.map((record) => record.id).sort();
            expect(taskIds).toEqual([imageTaskId, childId].sort());
            const worker = await openRetainedEnhancementWorker({ controlDirectory: join(root, "control"), readParent: () => jobs.getEnhancementJob(enhancementId, userId), mediaGet, expectedState: readback.remote });
            closeWorker = worker.close;
            connect(worker.endpoint);
            return { witness, witnessName: witnesses[0], completedChild, taskIds, worker };
        };

        it("creates and retains a genuine never-started unavailable CPU child", async () => {
            await mkdir(root);
            await mkdir(join(root, "control"));
            await mkdir(dataDirectory);
            await writeFile(join(root, "owner.json"), JSON.stringify({ directory: root, createdPid: process.pid, provider, database: databaseIdentity }) + "\n", { flag: "wx" });
            const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
            expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
            const userId = `retained-enhancement-${randomUUID()}`;
            if (provider === "file") {
                const { mutateAuthDb } = await import("@/lib/auth/store-repository");
                await mutateAuthDb((db) => {
                    db.users.push({
                        id: userId,
                        accountId: "9002",
                        username: "retained_enhancement_fixture",
                        displayName: "Retained enhancement fixture",
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
                await repositories.users.createWithNextAccountId({
                    id: userId,
                    username: "retained_" + randomUUID().replaceAll("-", "").slice(0, 16),
                    displayName: "Retained enhancement fixture",
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
            const conversation = await runtime.createCreativeConversation(userId, { surface: "chat", title: "Retained enhancement fixture" });
            const taskId = randomUUID();
            const enhancementId = `enhancement:${taskId}:1`;
            const source = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#517b9d" } })
                .png()
                .toBuffer();
            const ai = await sharp(source).resize(128, 128).png().toBuffer();
            const nativeAsset = await storage.writeAssetBytes(source, "image/png", "image", { ownerUserId: userId, source: "image-workbench", conversationId: conversation.id, taskId });
            assert.ok(nativeAsset.serverUrl);
            const nativeStorageKey = new URL(nativeAsset.serverUrl, "http://fixture.local").pathname.slice("/api/generation-log-assets/".length).split("/").map(decodeURIComponent).join("/");
            const native = { url: nativeAsset.serverUrl, sha256: retainedDigest(source), width: 32, height: 32, byteLength: source.length, format: "png", hasAlpha: false, provenance: "provider_native" as const };
            const result = { resultId: `${taskId}:1`, enhancementId, dataUrl: native.url, serverUrl: native.url, nativeSource: native, width: 32, height: 32, bytes: source.length, mimeType: "image/png" };
            const running = await tasks.createStoredGenerationTask<ImageTask>(
                "image",
                {
                    id: taskId,
                    userId,
                    username: "retained_enhancement_fixture",
                    displayName: "Retained enhancement fixture",
                    kind: "generation",
                    source: "image-workbench",
                    conversationId: conversation.id,
                    status: "running",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    config: { baseUrl: "https://fixture.invalid", apiKey: "system", apiFormat: "openai", model: "fixture", quality: "4k", size: "64x64" },
                    prompt: "Retained enhancement fixture",
                    references: [],
                    enhancementPolicy: structuredClone(policy),
                },
                GENERATION_TASK_RETENTION_MS,
            );
            assert.ok(await images.transitionImageTask(running, ["running"], { status: "success", result: { ...result, results: [result] } }));
            expect(await jobs.listEnhancementJobsForTask(taskId, userId)).toHaveLength(1);
            await runtime.registerCreativeAssets([
                {
                    userId,
                    conversationId: conversation.id,
                    sourceTaskId: taskId,
                    ordinal: 0,
                    type: "image",
                    title: "Retained native original",
                    storageKind: "local",
                    serverUrl: native.url,
                    width: 32,
                    height: 32,
                    mimeType: "image/png",
                    bytes: source.length,
                },
            ]);
            const originalRecord = await tasks.getStoredGenerationTaskRecord("image", taskId);
            assert.ok(originalRecord);
            const originalAssets = await runtime.listCreativeAssets(conversation.id, userId);
            const worker = await openRetainedEnhancementWorker({
                controlDirectory: join(root, "control"),
                readParent: () => jobs.getEnhancementJob(enhancementId, userId),
                mediaGet,
                create: { serviceId: policy.connection.serviceId, model: policy.connection.model, budgets, source, ai },
            });
            closeWorker = worker.close;
            connect(worker.endpoint);
            await runWhenDue(enhancementId, userId, worker.endpoint);
            await runWhenDue(enhancementId, userId, worker.endpoint);
            await runWhenDue(enhancementId, userId, worker.endpoint);
            await runWhenDue(enhancementId, userId, worker.endpoint);
            const parent = await jobs.getEnhancementJob(enhancementId, userId);
            assert.ok(parent?.publicationProcessing?.admission);
            const admission = parent.publicationProcessing.admission;
            const checkpoint = parent.publicationProcessing;
            const child = await relations.readEnhancementProcessingTask(checkpoint.jobId);
            assert.ok(child);
            expect(parent).toMatchObject({
                status: "failed",
                phase: "publish",
                reason: "image_processing_resource_unavailable",
                workerId: null,
                leaseToken: null,
                leaseUntil: null,
                publicationProcessing: { admission: { kind: "never_started_unavailable", reason: "profile_uncalibrated" } },
            });
            expect(child).toMatchObject({ status: "paused", executionPhase: "needs_review", attemptNo: 0, parentTaskId: enhancementId, payload: { enhancementBinding: { enhancementId, imageTaskId: taskId, resultId: result.resultId } } });
            expect([child.payload.executionId, child.workerId, child.leaseUntil, child.runId, parent.publication, checkpoint.outcome, child.payload.resource.requiredMemoryBytes]).toEqual([
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
            ]);
            expect(child.payload.inputDigest).toBe(checkpoint.inputDigest);
            expect(child.payload.enhancementBinding.bindingDigest).toBe(checkpoint.bindingDigest);
            expect(estimateImageProcessingMemory(child.payload, child.payload.resource.facts).status).toBe("uncalibrated");
            const rawSource = child.payload.sources[child.payload.options.aiInputIndex];
            const registration = await registry.getLocalMediaRegistration(rawSource.storageKey);
            assert.ok(registration?.expiresAt);
            expect(registration).toMatchObject({ ownerUserId: userId, scope: "reference", storageClass: "temporary", source: "enhancement-raw-ai", taskId: enhancementId });
            expect(await readFile(join(dataDirectory, "reference-assets", rawSource.storageKey))).toEqual(ai);
            expect(Date.parse(registration.expiresAt) - Date.parse(registration.createdAt)).toBe(24 * 60 * 60 * 1000);
            expect(child.expiresAt).toBe(originalRecord.expiresAt);
            expect(await tasks.getStoredGenerationTaskRecord("image", taskId)).toStrictEqual(originalRecord);
            expect(await runtime.listCreativeAssets(conversation.id, userId)).toStrictEqual(originalAssets);
            const locators = { userId, conversationId: conversation.id, imageTaskId: taskId, enhancementId, childId: child.id, nativeStorageKey, rawStorageKey: rawSource.storageKey };
            const beforeState = await retainedState(locators);
            const remote = await worker.readState();
            assert.ok(remote.job && remote.acceptedRequest);
            const claim = await import("@/app/api/maintenance/image-processing/claim/route");
            const claimed = await claim.POST(
                new Request(worker.endpoint + "/api/maintenance/image-processing/claim", {
                    method: "POST",
                    headers: { authorization: "Bearer " + workerToken, "content-type": "application/json" },
                    body: JSON.stringify({ workerId: "retained-unavailable-cpu", profileVersion: config.profileVersion, availableMemoryBytes: config.budgetBytes, slots: 1 }),
                }),
            );
            expect(claimed.status).toBe(200);
            expect(await claimed.json()).toMatchObject({ code: 0, data: { tasks: [] } });
            await expect(service.retryImageEnhancement(enhancementId, userId)).rejects.toThrow("profile_uncalibrated");
            expect(await retainedState(locators)).toStrictEqual(beforeState);
            expect(await worker.readState()).toStrictEqual(remote);
            expect(remote.job.jobId).toBe(parent.remoteJobId);
            expect(remote.acceptedRequest.key).toBe(parent.remoteKey);
            await worker.close();
            closeWorker = undefined;
            const manifest: Manifest = {
                provider,
                database: databaseIdentity,
                nativeStorageKey,
                createdPid: process.pid,
                identities: { userId, conversationId: conversation.id, imageTaskId: taskId, enhancementId, resultId: result.resultId, childId: child.id, inputDigest: checkpoint.inputDigest, bindingDigest: checkpoint.bindingDigest },
                raw: { storageKey: rawSource.storageKey, sha256: retainedDigest(ai), bytes: ai.length, expiresAt: registration.expiresAt },
                resource: { modelVersion: admission.modelVersion, profileVersion: admission.profileVersion, factsDigest: admission.factsDigest, configuration: config },
                imageExpiresAt: originalRecord.expiresAt,
                childExpiresAt: child.expiresAt,
                earliestExpiresAt: Math.min(originalRecord.expiresAt, child.expiresAt, Date.parse(registration.expiresAt)),
                remote,
                beforeState,
            };
            await writeFile(join(root, "before-calibration.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
            console.log(JSON.stringify({ retainedEnhancementCreated: { directory: root, childId: child.id, earliestExpiresAt: manifest.earliestExpiresAt, resumeExecuted: false } }));
        }, 30_000);

        it("reads the same retained unavailable chain in a fresh process and reopens its original remote endpoint", async () => {
            const manifest: Manifest = JSON.parse(await readFile(join(root, "before-calibration.json"), "utf8"));
            const owner: { directory: string; createdPid: number; provider: "file" | "postgres"; database: DatabaseIdentity | null } = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
            expect(owner).toEqual({ directory: root, createdPid: manifest.createdPid, provider, database: databaseIdentity });
            expect(manifest.provider).toBe(provider);
            expect(manifest.database).toStrictEqual(databaseIdentity);
            expect(process.pid).not.toBe(manifest.createdPid);
            expect(manifest.earliestExpiresAt).toBeGreaterThan(Date.now());
            const locators = { ...manifest.identities, nativeStorageKey: manifest.nativeStorageKey, rawStorageKey: manifest.raw.storageKey };
            expect(await retainedState(locators)).toStrictEqual(manifest.beforeState);
            const { userId, enhancementId, imageTaskId, childId } = manifest.identities;
            const parent = await jobs.getEnhancementJob(enhancementId, userId);
            const child = await relations.readEnhancementProcessingTask(childId);
            assert.ok(parent?.remotePlan && parent.remoteJobId && child);
            expect((await tasks.getStoredGenerationTaskRecord("image", imageTaskId))?.id).toBe(imageTaskId);
            expect(parent).toMatchObject({ status: "failed", phase: "publish" });
            expect(child).toMatchObject({ status: "paused", attemptNo: 0, payload: { inputDigest: manifest.identities.inputDigest, enhancementBinding: { bindingDigest: manifest.identities.bindingDigest } } });
            const worker = await openRetainedEnhancementWorker({ controlDirectory: join(root, "control"), readParent: () => jobs.getEnhancementJob(enhancementId, userId), mediaGet, expectedState: manifest.remote });
            closeWorker = worker.close;
            connect(worker.endpoint);
            assert.ok(parent.decision.status === "queued");
            const { resolveImageEnhancementConnection } = await import("./image-enhancement-config");
            const { createEnhancementTaskClient } = await import("./image-enhancement-worker-client");
            const client = createEnhancementTaskClient(await resolveImageEnhancementConnection(parent.decision.connection));
            try {
                expect(await client.query(parent.remotePlan, parent.remoteJobId)).toMatchObject({ jobId: parent.remoteJobId, status: "succeeded", result: manifest.remote.output });
            } finally {
                await client.close();
            }
            const after = await worker.readState();
            expect(after.job).toStrictEqual(manifest.remote.job);
            expect(after.acceptedRequest).toStrictEqual(manifest.remote.acceptedRequest);
            const requests = after.requests.slice(manifest.remote.requests.length);
            expect(requests).toContainEqual({ method: "GET", path: `/v1/enhancement-jobs/${parent.remoteJobId}` });
            expect(requests).not.toContainEqual(expect.objectContaining({ method: "POST" }));
            expect(requests).not.toContainEqual(expect.objectContaining({ path: `/v1/enhancement-jobs/${parent.remoteJobId}/result` }));
            await worker.close();
            closeWorker = undefined;
            expect(await retainedState(locators)).toStrictEqual(manifest.beforeState);
            await writeFile(
                join(root, "readback.json"),
                JSON.stringify(
                    {
                        createdPid: manifest.createdPid,
                        readbackPid: process.pid,
                        identities: manifest.identities,
                        remote: after,
                        provider,
                        database: databaseIdentity,
                        beforeState: manifest.beforeState,
                        earliestExpiresAt: manifest.earliestExpiresAt,
                        resumeExecuted: false,
                    },
                    null,
                    2,
                ) + "\n",
                { flag: "wx" },
            );
            console.log(JSON.stringify({ retainedEnhancementReadback: { childId, sameRemoteJob: parent.remoteJobId, businessDataUnchanged: true, resumeExecuted: false } }));
        }, 30_000);

        it("resumes the original retained chain after calibration through a real CPU child, publication and ACK", async () => {
            const manifest: Manifest = JSON.parse(await readFile(join(root, "before-calibration.json"), "utf8"));
            const readback: Readback = JSON.parse(await readFile(join(root, "readback.json"), "utf8"));
            const owner: { directory: string; createdPid: number; provider: "file" | "postgres"; database: DatabaseIdentity | null } = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
            expect(owner).toEqual({ directory: root, createdPid: manifest.createdPid, provider, database: databaseIdentity });
            expect(readback).toMatchObject({
                provider,
                database: databaseIdentity,
                createdPid: manifest.createdPid,
                identities: manifest.identities,
                beforeState: manifest.beforeState,
                earliestExpiresAt: manifest.earliestExpiresAt,
                resumeExecuted: false,
            });
            expect([manifest.createdPid, readback.readbackPid]).not.toContain(process.pid);
            expect(manifest.earliestExpiresAt).toBeGreaterThan(Date.now());
            const locators = { ...manifest.identities, nativeStorageKey: manifest.nativeStorageKey, rawStorageKey: manifest.raw.storageKey };
            expect(await retainedState(locators)).toStrictEqual(manifest.beforeState);
            const { userId, conversationId, imageTaskId, enhancementId, childId } = manifest.identities;
            const original = await tasks.getStoredGenerationTaskRecord("image", imageTaskId);
            const taskIds = (await tasks.listStoredGenerationTaskRecords({ userId, includeAll: true })).items.map((record) => record.id).sort();
            const assets = await runtime.listCreativeAssets(conversationId, userId);
            const parent = await jobs.getEnhancementJob(enhancementId, userId);
            const child = await relations.readEnhancementProcessingTask(childId);
            const raw = await registry.getLocalMediaRegistration(manifest.raw.storageKey);
            const native = await registry.getLocalMediaRegistration(manifest.nativeStorageKey);
            assert.ok(original && parent?.publicationProcessing?.admission && child && raw && native);
            expect(parent).toMatchObject({ status: "failed", phase: "publish", publicationProcessing: { admission: { kind: "never_started_unavailable", reason: "profile_uncalibrated" } } });
            expect(child).toMatchObject({ status: "paused", attemptNo: 0, payload: { resource: { modelVersion: manifest.resource.modelVersion, profileVersion: manifest.resource.profileVersion } } });
            expect(child.payload.executionId).toBeUndefined();
            expect(raw.expiresAt).toBe(manifest.raw.expiresAt);
            const rawPath = join(dataDirectory, "reference-assets", manifest.raw.storageKey);
            const nativePath = join(dataDirectory, "generation-assets", manifest.nativeStorageKey);
            expect(retainedDigest(await readFile(rawPath))).toBe(manifest.raw.sha256);
            expect(retainedDigest(await readFile(nativePath))).toBe(manifest.remote.sourceSha256);
            const worker = await openRetainedEnhancementWorker({ controlDirectory: join(root, "control"), readParent: () => jobs.getEnhancementJob(enhancementId, userId), mediaGet, expectedState: readback.remote });
            closeWorker = worker.close;
            connect(worker.endpoint);
            await writeFile(join(root, `resume-before-${process.pid}.json`), JSON.stringify({ pid: process.pid, manifest, readback, parent, child, original, assets, raw, native }, null, 2) + "\n", { flag: "wx" });

            // On the original uncalibrated model this rejects without changing the retained chain.
            const resumed = await service.retryImageEnhancement(enhancementId, userId);
            const pending = await relations.readEnhancementProcessingTask(childId);
            assert.ok(resumed?.publicationProcessing && pending);
            expect(resumed).toStrictEqual({ ...parent, status: "running", reason: null, updatedAt: resumed.updatedAt, publicationProcessing: { ...parent.publicationProcessing, admission: undefined } });
            const { resource: oldResource, ...frozen } = child.payload;
            const { resource, ...afterResume } = pending.payload;
            expect(afterResume).toStrictEqual(frozen);
            expect(pending).toMatchObject({ id: childId, status: "pending", executionPhase: "created", attemptNo: 0, createdAt: child.createdAt, expiresAt: manifest.childExpiresAt });
            expect(resource.modelVersion).not.toBe(oldResource.modelVersion);
            expect(resource.profileVersion).not.toBe(oldResource.profileVersion);
            expect(resource.profileVersion).toBe(config.profileVersion);
            const { profileVersion: _oldProfile, ...configuration } = manifest.resource.configuration;
            expect(resource.configuration).toStrictEqual(configuration);
            expect(resource.facts).toStrictEqual(oldResource.facts);
            expect(resource.unavailable).toBeUndefined();
            expect(estimateImageProcessingMemory(pending.payload, resource.facts)).toMatchObject({ status: "calibrated", profile: "enhancement_global_jpeg", modelVersion: resource.modelVersion, requiredMemoryBytes: resource.requiredMemoryBytes });
            expect(resource.requiredMemoryBytes).toBeGreaterThan(0);
            expect(resource.requiredMemoryBytes).toBeLessThanOrEqual(config.budgetBytes);
            expect(await tasks.getStoredGenerationTaskRecord("image", imageTaskId)).toStrictEqual(original);
            expect(await runtime.listCreativeAssets(conversationId, userId)).toStrictEqual(assets);
            expect(await registry.getLocalMediaRegistration(manifest.raw.storageKey)).toStrictEqual(raw);
            expect(await worker.readState()).toStrictEqual(readback.remote);

            const processing = await import("./image-processing-service");
            const cpuId = "retained-calibrated-cpu";
            const claimed = await processing.claimImageProcessingTasks({ workerId: cpuId, profileVersion: config.profileVersion, availableMemoryBytes: config.budgetBytes, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const execution = claimed.tasks[0];
            expect(execution.id).toBe(childId);
            expect(execution.executionId).toMatch(/^[0-9a-f-]{36}$/);
            expect(execution.payload).toStrictEqual({ ...pending.payload, executionId: execution.executionId });
            const cpu = await completeClaimedImageProcessingFixture(execution, cpuId, root);
            expect(cpu.receipt).toMatchObject({ jobId: childId, inputDigest: manifest.identities.inputDigest, executionId: execution.executionId, parentRescheduled: true });
            const completedChild = await relations.readEnhancementProcessingTask(childId);
            expect(completedChild).toMatchObject({ status: "success", executionPhase: "completed", expiresAt: manifest.childExpiresAt, resultPayload: { manifest: cpu.manifest } });
            const waiting = await jobs.getEnhancementJob(enhancementId, userId);
            expect(waiting).toMatchObject({ phase: "publish", publicationProcessing: { outcome: { status: "completed", executionId: execution.executionId, manifest: cpu.manifest } } });
            expect(waiting?.publication).toBeUndefined();
            expect(await tasks.getStoredGenerationTaskRecord("image", imageTaskId)).toStrictEqual(original);
            expect(await runtime.listCreativeAssets(conversationId, userId)).toStrictEqual(assets);
            expect(await worker.readState()).toStrictEqual(readback.remote);

            assert.ok(completedChild);
            const { completed, remote, delivered, bytes } = await publishAndAcknowledge({ pid: process.pid, manifest, readback, parent, child, original, assets, raw, native }, completedChild, taskIds, worker);
            await worker.close();
            closeWorker = undefined;
            await writeFile(
                join(root, `resume-after-${process.pid}.json`),
                JSON.stringify(
                    {
                        pid: process.pid,
                        identities: manifest.identities,
                        beforeState: manifest.beforeState,
                        afterState: await retainedState(locators),
                        resource,
                        cpu,
                        parent: completed,
                        child: completedChild,
                        remote,
                        final: { ...delivered, sha256: retainedDigest(bytes), bytes: bytes.length },
                        raw,
                        native,
                        resumeExecuted: true,
                    },
                    null,
                    2,
                ) + "\n",
                { flag: "wx" },
            );
            console.log(
                JSON.stringify({
                    retainedEnhancementResumed: { provider, childId, executionId: execution.executionId, cpuPid: cpu.metrics.pid, remoteJobId: parent.remoteJobId, finalSha256: retainedDigest(bytes), receiptConfirmedAt: completed?.receiptConfirmedAt },
                }),
            );
        }, 30_000);

        it("publishes and acknowledges the original already completed retained CPU child", async () => {
            const { witness, witnessName, completedChild, taskIds, worker } = await openCompletedRetainedPublication();
            const { manifest } = witness;
            const { completed, remote, delivered, bytes } = await publishAndAcknowledge(witness, completedChild, taskIds, worker);
            await worker.close();
            closeWorker = undefined;
            await writeFile(
                join(root, `publication-tail-after-${process.pid}.json`),
                JSON.stringify(
                    {
                        witness: witnessName,
                        identities: manifest.identities,
                        parent: completed,
                        child: completedChild,
                        remote,
                        final: { ...delivered, sha256: retainedDigest(bytes), bytes: bytes.length },
                        cpuExecuted: false,
                        publicationTailExecuted: true,
                    },
                    null,
                    2,
                ) + "\n",
                { flag: "wx" },
            );
        }, 30_000);

        it("retries only publication after a permanent delivery storage failure on a closed retained CPU child", async () => {
            // Root supplies an owned copy of the closed File fixture; the original chain has its separate tail round.
            const { witness, witnessName, completedChild, taskIds, worker } = await openCompletedRetainedPublication();
            const { manifest, readback, raw, native } = witness;
            const { enhancementId, userId, imageTaskId, conversationId, childId } = manifest.identities;
            const mediaBefore = await retainedDataSnapshot(join(dataDirectory, "generation-assets"));
            const writeArtifact = storage.writeEnhancementArtifactFile;
            const unavailable = vi.spyOn(storage, "writeEnhancementArtifactFile").mockImplementationOnce(writeArtifact).mockRejectedValueOnce(new Error("fixture permanent delivery storage unavailable"));
            try {
                await runWhenDue(enhancementId, userId, worker.endpoint);
            } finally {
                unavailable.mockRestore();
            }
            const failed = await jobs.getEnhancementJob(enhancementId, userId);
            expect(failed).toMatchObject({ status: "failed", phase: "publish", reason: "output_storage_invalid", nextPollAt: null, workerId: null, leaseToken: null, leaseUntil: null });
            assert.ok(failed?.publicationProcessing?.promotion);
            expect(failed.publication).toBeUndefined();
            expect(failed.publicationProcessing.outcome).toStrictEqual(relations.closedEnhancementOutcome(completedChild));
            const promotion = failed.publicationProcessing.promotion;
            const aiBytes = await readFile(join(dataDirectory, "generation-assets", promotion.aiStorageKey));
            expect({ sha256: retainedDigest(aiBytes), bytes: aiBytes.length }).toEqual({ sha256: manifest.remote.output.sha256, bytes: manifest.remote.output.byteLength });
            expect(await retainedDataSnapshot(join(dataDirectory, "generation-assets"))).toStrictEqual({ ...mediaBefore, [promotion.aiStorageKey]: { sha256: manifest.remote.output.sha256, bytes: manifest.remote.output.byteLength } });
            expect(await relations.readEnhancementProcessingTask(childId)).toStrictEqual(completedChild);
            expect(await tasks.getStoredGenerationTaskRecord("image", imageTaskId)).toStrictEqual(witness.original);
            expect(await runtime.listCreativeAssets(conversationId, userId)).toStrictEqual(witness.assets);
            expect(await registry.getLocalMediaRegistration(manifest.raw.storageKey)).toStrictEqual(raw);
            expect(await registry.getLocalMediaRegistration(manifest.nativeStorageKey)).toStrictEqual(native);
            expect(await worker.readState()).toStrictEqual(readback.remote);
            const resumed = await service.retryImageEnhancement(enhancementId, userId);
            assert.ok(resumed);
            expect(resumed).toStrictEqual({ ...failed, status: "running", reason: null, nextPollAt: resumed.nextPollAt, updatedAt: resumed.updatedAt });
            expect(resumed.nextPollAt).toBeLessThanOrEqual(Date.now());
            expect(await relations.readEnhancementProcessingTask(childId)).toStrictEqual(completedChild);
            expect(await worker.readState()).toStrictEqual(readback.remote);
            const { completed, remote, delivered, bytes } = await publishAndAcknowledge(witness, completedChild, taskIds, worker);
            const artifact = (completedChild.resultPayload!.manifest as ImageProcessingManifest).artifacts[0];
            expect(await retainedDataSnapshot(join(dataDirectory, "generation-assets"))).toStrictEqual({
                ...mediaBefore,
                [promotion.aiStorageKey]: { sha256: manifest.remote.output.sha256, bytes: manifest.remote.output.byteLength },
                [promotion.deliveredStorageKey]: { sha256: artifact.sha256, bytes: artifact.bytes },
            });
            expect(completed?.publicationProcessing?.promotion).toStrictEqual(promotion);
            await worker.close();
            closeWorker = undefined;
            await writeFile(
                join(root, `publication-storage-retry-after-${process.pid}.json`),
                JSON.stringify(
                    {
                        witness: witnessName,
                        identities: manifest.identities,
                        failed,
                        resumed,
                        parent: completed,
                        child: completedChild,
                        remote,
                        final: { ...delivered, sha256: retainedDigest(bytes), bytes: bytes.length },
                        cpuExecuted: false,
                        storageRetryExecuted: true,
                    },
                    null,
                    2,
                ) + "\n",
                { flag: "wx" },
            );
        }, 30_000);
    });
}
