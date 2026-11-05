import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FrozenImageEnhancementPolicy } from "./image-enhancement-config";
import type { ImageTask } from "./image-task-store";
import { estimateImageProcessingMemory } from "../image-processing/resource-model";
import { imageProcessingResourceConfig } from "../image-processing/resource-config";

const connection = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./image-enhancement-config", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./image-enhancement-config")>()),
    resolveImageEnhancementConnection: connection.resolve,
}));
// Supply the missing Next request context; Worker authentication and media access stay real.
vi.mock("next/headers", async (importOriginal) => ({
    ...(await importOriginal<typeof import("next/headers")>()),
    cookies: async () => ({ get: () => undefined }),
}));

const policy: FrozenImageEnhancementPolicy = {
    revision: "enhancement-publication-cpu-fixture",
    enabled: true,
    connection: {
        revision: "enhancement-publication-cpu-fixture",
        credentialRef: "fixture-credential",
        serviceId: "31313131-3131-4131-8131-313131313131",
        timeoutMs: 10_000,
        model: { id: "fixture-x4", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 },
    },
};
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("file raw AI publication boundary with genuine unavailable CPU admission", () => {
    let directory: string;
    let closeServer: (() => Promise<void>) | undefined;
    let tasks: typeof import("./generation-task-store");
    let images: typeof import("./image-task-store");
    let jobs: typeof import("./database/image-enhancement-job-repository");
    let runtime: typeof import("./creative-runtime-store");
    let storage: typeof import("./generation-log-repository");
    let service: typeof import("./image-enhancement-service");
    let media: typeof import("@/app/api/image-tasks/image-task-support");
    let auth: typeof import("./maintenance-auth");
    let generationAssetGet: typeof import("@/app/api/generation-log-assets/[...path]/route").GET;

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-publication-cpu-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "8192");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "6144");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-maintenance-token-".repeat(3));
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-worker-token-".repeat(3));
        [tasks, images, jobs, runtime, storage, service, media, auth] = await Promise.all([
            import("./generation-task-store"),
            import("./image-task-store"),
            import("./database/image-enhancement-job-repository"),
            import("./creative-runtime-store"),
            import("./generation-log-repository"),
            import("./image-enhancement-service"),
            import("@/app/api/image-tasks/image-task-support"),
            import("./maintenance-auth"),
        ]);
        generationAssetGet = (await import("@/app/api/generation-log-assets/[...path]/route")).GET;
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        assert.equal((await getObjectStorageRuntimeConfig()).enabled, false, "fixture requires local permanent media");
    });

    afterEach(async () => {
        try {
            await closeServer?.();
        } finally {
            closeServer = undefined;
            vi.restoreAllMocks();
        }
    });

    afterAll(async () => {
        try {
            await closeServer?.();
        } finally {
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });

    async function checkpointFixture() {
        const userId = `enhancement-publication-cpu-${randomUUID()}`;
        const { mutateAuthDb } = await import("@/lib/auth/store-repository");
        await mutateAuthDb((db) => {
            db.users.push({
                id: userId,
                accountId: "9001",
                username: "enhancement_cpu_fixture",
                displayName: "Enhancement CPU fixture",
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
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat", title: "Enhancement CPU fixture" });
        const taskId = randomUUID();
        const enhancementId = `enhancement:${taskId}:1`;
        const source = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#517b9d" } })
            .png()
            .toBuffer();
        const ai = await sharp(source).resize(128, 128).ensureAlpha().toColourspace("rgb16").png().toBuffer();
        expect((await sharp(ai).metadata()).depth).toBe("ushort");
        const nativeAsset = await storage.writeAssetBytes(source, "image/png", "image", { ownerUserId: userId, source: "image-workbench", conversationId: conversation.id, taskId });
        assert.ok(nativeAsset.serverUrl);
        const native = { url: nativeAsset.serverUrl, sha256: digest(source), width: 32, height: 32, byteLength: source.length, format: "png", hasAlpha: false, provenance: "provider_native" as const };
        const result = { resultId: `${taskId}:1`, enhancementId, dataUrl: native.url, serverUrl: native.url, nativeSource: native, width: 32, height: 32, bytes: source.length, mimeType: "image/png" };
        const running = await tasks.createStoredGenerationTask<ImageTask>(
            "image",
            {
                id: taskId,
                userId,
                username: "enhancement_cpu_fixture",
                displayName: "Enhancement CPU fixture",
                kind: "generation",
                source: "image-workbench",
                conversationId: conversation.id,
                status: "running",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                config: { baseUrl: "https://fixture.invalid", apiKey: "system", apiFormat: "openai", model: "fixture", quality: "4k", size: "64x64" },
                prompt: "Enhancement CPU fixture",
                references: [],
                enhancementPolicy: structuredClone(policy),
            },
            60_000,
        );
        expect(await jobs.listEnhancementJobsForTask(taskId, userId)).toEqual([]);
        const successful = await images.transitionImageTask(running, ["running"], { status: "success", result: { ...result, results: [result] } });
        assert.ok(successful);
        expect(await jobs.listEnhancementJobsForTask(taskId, userId)).toHaveLength(1);
        await runtime.registerCreativeAssets([
            {
                userId,
                conversationId: conversation.id,
                sourceRunId: `task:${conversation.id}`,
                sourceTaskId: taskId,
                ordinal: 0,
                type: "image",
                title: "Native original",
                storageKind: "local",
                serverUrl: native.url,
                width: 32,
                height: 32,
                mimeType: "image/png",
                bytes: source.length,
            },
        ]);
        const originalResult = structuredClone(successful.result);
        const originalAssets = await runtime.listCreativeAssets(conversation.id, userId);
        expect(originalAssets).toHaveLength(1);
        const remoteId = randomUUID();
        const createdAt = Date.now();
        const remoteResult = { width: 128, height: 128, format: "png" as const, sha256: digest(ai), byteLength: ai.length };
        const httpErrors: unknown[] = [];
        const traffic = { submit: 0, query: 0, download: 0, receipts: 0, mediaReads: 0 };
        const receiptBodies: unknown[] = [];
        let origin = "";
        const json = (response: ServerResponse, value: unknown) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: "ok", data: value }));
        };
        const remoteJob = async (status: "queued" | "succeeded") => {
            const current = await jobs.getEnhancementJob(enhancementId, userId);
            assert.ok(current?.remotePlan);
            return {
                jobId: remoteId,
                serviceId: policy.connection!.serviceId,
                plan: { planFingerprint: current.remotePlan.planFingerprint, strategyFingerprint: current.remotePlan.strategyFingerprint, engine: { tta: false } },
                source: { sha256: native.sha256 },
                engineInput: { width: 32, height: 32 },
                status,
                reason: null,
                result: status === "succeeded" ? remoteResult : null,
                createdAt,
                completedAt: status === "succeeded" ? Date.now() : null,
            };
        };
        const handle = async (request: IncomingMessage, response: ServerResponse) => {
            const url = new URL(request.url!, origin);
            if (request.method === "GET" && url.pathname.startsWith("/api/generation-log-assets/")) {
                traffic.mediaReads++;
                const headers = new Headers();
                for (const [key, value] of Object.entries(request.headers)) {
                    if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
                    else if (value !== undefined) headers.set(key, value);
                }
                const mediaResponse = await generationAssetGet(new Request(url, { headers }), { params: Promise.resolve({ path: url.pathname.slice("/api/generation-log-assets/".length).split("/").map(decodeURIComponent) }) });
                assert.equal(mediaResponse.status, 200, "real permanent-media GET must succeed");
                const bytes = Buffer.from(await mediaResponse.arrayBuffer());
                response.writeHead(mediaResponse.status, Object.fromEntries(mediaResponse.headers));
                response.end(bytes);
                return;
            }
            assert.equal(request.headers.authorization, "Bearer fixture-gpu-token");
            if (request.method === "GET" && url.pathname === "/v1/capabilities") {
                json(response, {
                    serviceId: policy.connection!.serviceId,
                    protocolVersion: "image-enhancement.v1",
                    normalizationProfile: "srgb-upright-v1",
                    features: { expectedStrategyFingerprint: true },
                    ready: true,
                    models: [policy.connection!.model],
                    budgets: { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } },
                });
                return;
            }
            if (request.method === "POST" && url.pathname === "/v1/enhancement-jobs") {
                const chunks: Buffer[] = [];
                for await (const bytes of request) chunks.push(Buffer.from(bytes));
                assert.ok(request.headers["content-type"]);
                const form = await new Request(url, { method: "POST", headers: { "content-type": request.headers["content-type"] }, body: new Uint8Array(Buffer.concat(chunks)) }).formData();
                const outgoingPlan = form.get("plan");
                const image = form.get("image");
                assert.ok(typeof outgoingPlan === "string");
                assert.ok(image instanceof File);
                const current = await jobs.getEnhancementJob(enhancementId, userId);
                assert.ok(current?.remotePlan);
                assert.equal(request.headers["idempotency-key"], current.remoteKey);
                assert.deepEqual(JSON.parse(outgoingPlan), {
                    protocolVersion: "image-enhancement.v1",
                    scope: "full_image",
                    sourceSha256: native.sha256,
                    target: { width: 128, height: 128, format: "png" },
                    modelId: "fixture-x4",
                    normalizationProfile: "srgb-upright-v1",
                    tile: 0,
                    expectedStrategyFingerprint: current.remotePlan.strategyFingerprint,
                });
                assert.deepEqual(Buffer.from(await image.arrayBuffer()), source);
                traffic.submit++;
                json(response, { job: await remoteJob("queued"), replayed: false });
                return;
            }
            if (request.method === "GET" && url.pathname === `/v1/enhancement-jobs/${remoteId}`) {
                traffic.query++;
                json(response, { job: await remoteJob("succeeded") });
                return;
            }
            if (request.method === "GET" && url.pathname === `/v1/enhancement-jobs/${remoteId}/result`) {
                traffic.download++;
                response.writeHead(200, { "content-type": "image/png", "content-length": ai.length });
                response.end(ai);
                return;
            }
            if (request.method === "POST" && url.pathname === `/v1/enhancement-jobs/${remoteId}/receipt`) {
                const body: Buffer[] = [];
                for await (const bytes of request) body.push(Buffer.from(bytes));
                const receipt: unknown = JSON.parse(Buffer.concat(body).toString("utf8"));
                receiptBodies.push(receipt);
                traffic.receipts++;
                json(response, {});
                return;
            }
            throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`);
        };
        const server = createServer((request, response) => {
            void handle(request, response).catch((error: unknown) => {
                httpErrors.push(error);
                response.writeHead(500, { "content-type": "text/plain" });
                response.end("fixture failure");
            });
        });
        closeServer = () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
            });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        origin = `http://127.0.0.1:${address.port}`;
        connection.resolve.mockResolvedValue({ endpoint: origin, token: "fixture-gpu-token", serviceId: policy.connection!.serviceId, timeoutMs: 10_000, trust: "system", caPem: "" });
        const run = async () => {
            await service.runImageEnhancementBatch({ origin, workerId: "fixture-enhancement-parent", limit: 1 });
            if (httpErrors.length) throw new AggregateError(httpErrors, "Real HTTP fixture failed");
        };
        const due = () => jobs.mutateEnhancementJob(enhancementId, userId, (row) => ({ ...row, nextPollAt: Date.now() - 1 }));
        const storedSource = await media.imageReferenceToDataUrl({ dataUrl: native.url }, "native.png", origin, auth.maintenanceWorkerContext(userId));
        expect(Buffer.from(storedSource.split(",")[1], "base64")).toEqual(source);
        await run();
        expect(await jobs.getEnhancementJob(enhancementId, userId)).toMatchObject({ phase: "submit", remotePlan: { target: { width: 128, height: 128 }, source: { width: 32, height: 32 } }, decision: { target: { width: 64, height: 64 } } });
        await due();
        await run();
        expect(await jobs.getEnhancementJob(enhancementId, userId)).toMatchObject({ phase: "poll", remoteJobId: remoteId, remoteStatus: "queued" });
        await due();
        await run();
        const beforePublication = await jobs.getEnhancementJob(enhancementId, userId);
        expect(beforePublication).toMatchObject({ status: "running", phase: "download", remoteResult });
        expect(beforePublication?.publication).toBeUndefined();
        expect(traffic).toEqual({ submit: 1, query: 1, download: 0, receipts: 0, mediaReads: 2 });
        expect((await tasks.listStoredGenerationTaskRecords({ type: "image_processing", userId })).items).toEqual([]);
        await due();

        // Observe the whole parent batch, including real download, storage and readback.
        const raw = vi.spyOn(sharp.prototype, "raw");
        const stats = vi.spyOn(sharp.prototype, "stats");
        const resize = vi.spyOn(sharp.prototype, "resize");
        const toBuffer = vi.spyOn(sharp.prototype, "toBuffer");
        const toFile = vi.spyOn(sharp.prototype, "toFile");
        await run();
        const pending = await jobs.getEnhancementJob(enhancementId, userId);
        // The controlled raw GET must finish before testing the existing inline publication boundary.
        expect(traffic.submit).toBe(1);
        expect(traffic.query).toBe(1);
        expect(traffic.download).toBe(1);
        expect(traffic.receipts).toBe(0);
        expect(pending?.publication, "Enhancement publication must wait for a separately owned CPU child").toBeUndefined();

        assert.ok(pending?.publicationProcessing);
        expect(pending).toMatchObject({
            phase: "publish",
            remoteKey: beforePublication!.remoteKey,
            remoteJobId: remoteId,
            remoteStatus: "succeeded",
            receiptId: beforePublication!.receiptId,
            nextPollAt: null,
            workerId: null,
            leaseToken: null,
            leaseUntil: null,
        });
        expect(pending.staged).toBeUndefined();
        expect(pending.publicationProcessing.outcome).toBeUndefined();
        expect((await images.getImageTask(taskId))?.status).toBe("success");
        expect((await images.getImageTask(taskId))?.result).toEqual(originalResult);
        expect(await runtime.listCreativeAssets(conversation.id, userId)).toEqual(originalAssets);
        expect(traffic).toEqual({ submit: 1, query: 1, download: 1, receipts: 0, mediaReads: 2 });
        const processing = await import("./image-enhancement-processing-store");
        const child = await processing.readEnhancementProcessingTask(pending.publicationProcessing.jobId);
        assert.ok(child);
        expect(child).toMatchObject({
            type: "image_processing",
            userId,
            parentTaskId: enhancementId,
            attemptNo: 0,
            payload: {
                version: "image-processing.v1",
                operation: "process_enhancement",
                inputDigest: pending.publicationProcessing.inputDigest,
                enhancementBinding: { enhancementId, imageTaskId: taskId, resultId: result.resultId, bindingDigest: pending.publicationProcessing.bindingDigest },
            },
        });
        expect([child.payload.executionId, child.workerId, child.leaseUntil, child.lastHeartbeatAt, child.runId]).toEqual([undefined, undefined, undefined, undefined, undefined]);
        const rawSource = child.payload.sources[child.payload.options.aiInputIndex];
        const registry = await import("./local-media-registry");
        expect(rawSource.scope).toBe("reference");
        expect(await registry.getLocalMediaRegistration(rawSource.storageKey)).toMatchObject({
            ownerUserId: userId,
            scope: "reference",
            storageClass: "temporary",
            source: "enhancement-raw-ai",
            taskId: enhancementId,
            bytes: ai.length,
            mimeType: "image/png",
            storageProvider: "local",
        });
        expect(await readFile(join(directory, "reference-assets", rawSource.storageKey))).toEqual(ai);
        expect(raw).not.toHaveBeenCalled();
        expect(stats).not.toHaveBeenCalled();
        expect(resize).not.toHaveBeenCalled();
        expect(toBuffer).not.toHaveBeenCalled();
        expect(toFile).not.toHaveBeenCalled();

        return { userId, conversation, taskId, enhancementId, source, ai, result, originalResult, originalAssets, remoteId, remoteResult, traffic, receiptBodies, origin, run, due, beforePublication, pending, child, raw, stats, resize, toBuffer, toFile };
    }

    it("stages raw AI once and retains a genuine never-started uncalibrated child without publication or ACK", async () => {
        const current = await checkpointFixture();
        expect(current.pending).toMatchObject({
            status: "failed",
            phase: "publish",
            reason: "image_processing_resource_unavailable",
            publicationProcessing: { admission: { kind: "never_started_unavailable", code: "image_processing_resource_unavailable", reason: "profile_uncalibrated" } },
        });
        expect(current.child).toMatchObject({ status: "paused", executionPhase: "needs_review", attemptNo: 0, payload: { resource: { unavailable: { code: "image_processing_resource_unavailable", reason: "profile_uncalibrated" } } } });
        expect(current.child.resultPayload).toBeUndefined();
        expect(current.child.payload.resource.requiredMemoryBytes).toBeUndefined();
        const estimate = estimateImageProcessingMemory(current.child.payload, current.child.payload.resource.facts);
        expect(estimate.status).toBe("uncalibrated");
        const processing = await import("./image-processing-service");
        const config = imageProcessingResourceConfig(process.env);
        const claim = await import("@/app/api/maintenance/image-processing/claim/route");
        const claimed = await claim.POST(
            new Request(current.origin + "/api/maintenance/image-processing/claim", {
                method: "POST",
                headers: { authorization: "Bearer " + "fixture-worker-token-".repeat(3), "content-type": "application/json" },
                body: JSON.stringify({ workerId: "fixture-unavailable-cpu", profileVersion: config.profileVersion, availableMemoryBytes: config.budgetBytes, slots: 1 }),
            }),
        );
        expect(claimed.status).toBe(200);
        expect(await claimed.json()).toMatchObject({ code: 0, data: { tasks: [] } });
        await expect(processing.retryEnhancementPublication(current.pending)).rejects.toThrow("profile_uncalibrated");
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id)).toStrictEqual(current.child);
        expect(await jobs.getEnhancementJob(current.enhancementId, current.userId)).toStrictEqual(current.pending);
        expect(await runtime.listCreativeAssets(current.conversation.id, current.userId)).toStrictEqual(current.originalAssets);
        expect((await images.getImageTask(current.taskId))?.result).toEqual(current.originalResult);
        expect(current.traffic).toEqual({ submit: 1, query: 1, download: 1, receipts: 0, mediaReads: 2 });
        expect(current.receiptBodies).toEqual([]);
        expect(current.raw).not.toHaveBeenCalled();
        expect(current.stats).not.toHaveBeenCalled();
        expect(current.resize).not.toHaveBeenCalled();
        expect(current.toBuffer).not.toHaveBeenCalled();
        expect(current.toFile).not.toHaveBeenCalled();
    }, 30_000);
});
