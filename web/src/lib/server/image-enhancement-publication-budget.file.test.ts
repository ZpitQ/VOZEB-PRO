import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FrozenImageEnhancementPolicy } from "./image-enhancement-config";
import type { ImageTask } from "./image-task-store";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";
import { readImageTaskResultBytesFixture } from "./image-processing.test-fixture";
import { openRetainedEnhancementWorker, retainedDataSnapshot, retainedDigest, retainedWorkerToken } from "./image-enhancement-retained-worker-fixture";

const connection = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./image-enhancement-config", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./image-enhancement-config")>()),
    resolveImageEnhancementConnection: connection.resolve,
}));
vi.mock("next/headers", async (importOriginal) => ({
    ...(await importOriginal<typeof import("next/headers")>()),
    cookies: async () => ({ get: () => undefined }),
}));

const policy = {
    revision: "enhancement-publication-budget-fixture",
    enabled: true,
    connection: {
        revision: "enhancement-publication-budget-fixture",
        credentialRef: "fixture-credential",
        serviceId: "53535353-5353-4353-8353-535353535353",
        timeoutMs: 10_000,
        model: { id: "fixture-x4", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 },
    },
} satisfies FrozenImageEnhancementPolicy;
const budgets = { input: { maxBytes: 20_971_520, maxPixels: 4_000_000 }, ai: { maxBytes: 167_772_160, maxPixels: 67_108_864 }, delivery: { maxBytes: 100_663_296, maxPixels: 67_108_864 } };

describe("file enhancement publication with frozen role pixel budgets", () => {
    let directory: string;
    let closeWorker: (() => Promise<void>) | undefined;
    let tasks: typeof import("./generation-task-store");
    let images: typeof import("./image-task-store");
    let jobs: typeof import("./database/image-enhancement-job-repository");
    let runtime: typeof import("./creative-runtime-store");
    let storage: typeof import("./generation-log-repository");
    let service: typeof import("./image-enhancement-service");
    let relations: typeof import("./image-enhancement-processing-store");
    let generationAssetGet: typeof import("@/app/api/generation-log-assets/[...path]/route").GET;

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-publication-budget-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", join(directory, "data"));
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("DATABASE_URL", "");
        vi.stubEnv("POSTGRES_URL", "");
        vi.stubEnv("VOZEB_PRO_E2E_DATABASE_URL", "");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-maintenance-token-".repeat(3));
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-worker-token-".repeat(3));
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "2048");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1536");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        [tasks, images, jobs, runtime, storage, service, relations] = await Promise.all([
            import("./generation-task-store"),
            import("./image-task-store"),
            import("./database/image-enhancement-job-repository"),
            import("./creative-runtime-store"),
            import("./generation-log-repository"),
            import("./image-enhancement-service"),
            import("./image-enhancement-processing-store"),
        ]);
        generationAssetGet = (await import("@/app/api/generation-log-assets/[...path]/route")).GET;
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
    });

    afterAll(async () => {
        try {
            await closeWorker?.();
        } finally {
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("retains complete AI pixels above 40MP within its frozen budget while pausing an uncalibrated CPU child", async () => {
        const userId = `enhancement-budget-${randomUUID()}`;
        const { mutateAuthDb } = await import("@/lib/auth/store-repository");
        await mutateAuthDb((db) => {
            db.users.push({
                id: userId,
                accountId: "9003",
                username: "enhancement_budget_fixture",
                displayName: "Enhancement budget fixture",
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
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat", title: "Enhancement budget fixture" });
        const taskId = randomUUID();
        const enhancementId = `enhancement:${taskId}:1`;
        const source = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: "#517b9d" } })
            .png()
            .toBuffer();
        const ai = await sharp(source).resize(6400, 6400).png().toBuffer();
        const nativeAsset = await storage.writeAssetBytes(source, "image/png", "image", { ownerUserId: userId, source: "image-workbench", conversationId: conversation.id, taskId });
        assert.ok(nativeAsset.serverUrl);
        const native = { url: nativeAsset.serverUrl, sha256: retainedDigest(source), width: 1600, height: 1600, byteLength: source.length, format: "png", hasAlpha: false, provenance: "provider_native" as const };
        const result = { resultId: `${taskId}:1`, enhancementId, dataUrl: native.url, serverUrl: native.url, nativeSource: native, width: 1600, height: 1600, bytes: source.length, mimeType: "image/png" };
        const running = await tasks.createStoredGenerationTask<ImageTask>(
            "image",
            {
                id: taskId,
                userId,
                username: "enhancement_budget_fixture",
                displayName: "Enhancement budget fixture",
                kind: "generation",
                source: "image-workbench",
                conversationId: conversation.id,
                status: "running",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                config: { baseUrl: "https://fixture.invalid", apiKey: "system", apiFormat: "openai", model: "fixture", quality: "4k", size: "4096x4096" },
                prompt: "Enhancement budget fixture",
                references: [],
                enhancementPolicy: structuredClone(policy),
            },
            GENERATION_TASK_RETENTION_MS,
        );
        assert.ok(await images.transitionImageTask(running, ["running"], { status: "success", result: { ...result, results: [result] } }));
        await runtime.registerCreativeAssets([
            { userId, conversationId: conversation.id, sourceTaskId: taskId, ordinal: 0, type: "image", title: "Native original", storageKind: "local", serverUrl: native.url, width: 1600, height: 1600, mimeType: "image/png", bytes: source.length },
        ]);
        const original = await tasks.getStoredGenerationTaskRecord("image", taskId);
        const originalAssets = await runtime.listCreativeAssets(conversation.id, userId);
        expect(originalAssets).toHaveLength(1);
        await mkdir(join(directory, "control"));
        const worker = await openRetainedEnhancementWorker({
            controlDirectory: join(directory, "control"),
            readParent: () => jobs.getEnhancementJob(enhancementId, userId),
            mediaGet: (request) => {
                const url = new URL(request.url);
                return generationAssetGet(request, { params: Promise.resolve({ path: url.pathname.slice("/api/generation-log-assets/".length).split("/").map(decodeURIComponent) }) });
            },
            create: { serviceId: policy.connection.serviceId, model: policy.connection.model, budgets, source, ai },
        });
        closeWorker = worker.close;
        connection.resolve.mockResolvedValue({ endpoint: worker.endpoint, token: retainedWorkerToken, serviceId: policy.connection.serviceId, timeoutMs: 10_000, trust: "system", caPem: "" });
        const job = () => jobs.getEnhancementJob(enhancementId, userId);
        const run = async () => {
            await jobs.mutateEnhancementJob(enhancementId, userId, (row) => ({ ...row, nextPollAt: Date.now() - 1 }));
            await service.runImageEnhancementBatch({ origin: worker.endpoint, workerId: "fixture-enhancement-parent", limit: 1 });
            await worker.readState();
        };
        await run();
        await run();
        await run();
        const downloaded = await job();
        expect(downloaded).toMatchObject({
            phase: "download",
            remotePlan: { source: { width: 1600, height: 1600 }, target: { width: 6400, height: 6400 }, budgets },
            remoteResult: { width: 6400, height: 6400, sha256: retainedDigest(ai), byteLength: ai.length },
        });
        await run();
        // First behavioral gate: this AI is in budget, but lies outside the measured CPU domain.
        const paused = await job();
        expect(paused).toMatchObject({
            status: "failed",
            phase: "publish",
            reason: "image_processing_resource_unavailable",
            remoteKey: downloaded!.remoteKey,
            remoteJobId: downloaded!.remoteJobId,
            receiptId: downloaded!.receiptId,
            remotePlan: downloaded!.remotePlan,
            remoteResult: downloaded!.remoteResult,
            publicationProcessing: { version: "enhancement-publication.v1", admission: { kind: "never_started_unavailable", reason: "profile_uncalibrated" } },
        });
        assert.ok(paused?.publicationProcessing);
        expect(paused.publication).toBeUndefined();
        const childId = paused.publicationProcessing.jobId;
        const child = await relations.readEnhancementProcessingTask(childId);
        expect(child).toMatchObject({
            status: "paused",
            executionPhase: "needs_review",
            attemptNo: 0,
            parentTaskId: enhancementId,
            payload: {
                operation: "process_enhancement",
                options: { budgets, expectedAi: { width: 6400, height: 6400, sha256: retainedDigest(ai), byteLength: ai.length } },
                enhancementBinding: { enhancementId, imageTaskId: taskId, receiptId: downloaded!.receiptId },
            },
        });
        assert.ok(child);
        expect(child.payload.executionId).toBeUndefined();
        expect(child.resultPayload?.artifacts).toBeUndefined();
        const raw = child.payload.sources[child.payload.options.aiInputIndex];
        const rawUrl = "/api/reference-assets/" + raw.storageKey.split("/").map(encodeURIComponent).join("/");
        const storedAi = await readImageTaskResultBytesFixture(rawUrl);
        expect(storedAi).toEqual(ai);
        expect(await sharp(storedAi).metadata()).toMatchObject({ format: "png", width: 6400, height: 6400 });
        const permanentMedia = await retainedDataSnapshot(join(directory, "data", "generation-assets"));
        const remote = await worker.readState();
        expect(remote.receipt).toBeUndefined();
        expect(remote.requests.filter((request) => request.method === "POST" && request.path === "/v1/enhancement-jobs")).toHaveLength(1);
        expect(remote.requests.filter((request) => request.path.endsWith("/result"))).toHaveLength(1);
        expect(remote.requests.filter((request) => request.path.endsWith("/receipt"))).toEqual([]);
        await expect(service.retryImageEnhancement(enhancementId, userId)).rejects.toThrow("profile_uncalibrated");
        expect(await job()).toStrictEqual(paused);
        expect(await worker.readState()).toStrictEqual(remote);
        expect(await retainedDataSnapshot(join(directory, "data", "generation-assets"))).toStrictEqual(permanentMedia);
        expect(await runtime.listCreativeAssets(conversation.id, userId)).toStrictEqual(originalAssets);
        expect((await tasks.listStoredGenerationTaskRecords({ type: "image_processing", userId })).items.map((child) => child.id)).toEqual([childId]);
        expect(await relations.readEnhancementProcessingTask(childId)).toStrictEqual(child);
        expect(await tasks.getStoredGenerationTaskRecord("image", taskId)).toStrictEqual(original);
        expect(await readImageTaskResultBytesFixture(native.url)).toEqual(source);
    }, 60_000);
});
