import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FrozenImageEnhancementPolicy } from "./image-enhancement-config";
import type { ImageTask } from "./image-task-store";

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

describe("file enhancement publication through real HTTP and permanent media", () => {
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

    afterAll(async () => {
        try {
            await closeServer?.();
        } finally {
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("keeps global enhancement unpublished until a real CPU child receipt with zero parent pixel work", async () => {
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
        const ai = await sharp(source).resize(128, 128).png().toBuffer();
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
                for await (const _bytes of request) {
                    /* Drain the real ACK body before replying. */
                }
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
        try {
            await run();
            const pending = await jobs.getEnhancementJob(enhancementId, userId);
            // First post-batch behavioral gate: no publication before the CPU receipt.
            expect(pending?.publication).toBeUndefined();

            // These gates are deliberately unreached on the synchronous baseline.
            expect(pending).toMatchObject({ status: "running", remoteKey: beforePublication!.remoteKey, receiptId: beforePublication!.receiptId });
            expect((await images.getImageTask(taskId))?.status).toBe("success");
            expect((await images.getImageTask(taskId))?.result).toEqual(originalResult);
            expect(await runtime.listCreativeAssets(conversation.id, userId)).toEqual(originalAssets);
            expect(traffic.receipts).toBe(0);
            const children = (await tasks.listStoredGenerationTaskRecords({ type: "image_processing", userId })).items;
            expect(children).toHaveLength(1);
            expect(children[0]).toMatchObject({ type: "image_processing", userId, payload: { version: "image-processing.v1" } });
            expect(children[0].id).not.toBe(taskId);
            expect(children[0].payload.inputDigest).toMatch(/^[a-f0-9]{64}$/);
            expect(raw).not.toHaveBeenCalled();
            expect(stats).not.toHaveBeenCalled();
            expect(resize).not.toHaveBeenCalled();
            expect(toBuffer).not.toHaveBeenCalled();
            expect(toFile).not.toHaveBeenCalled();
        } finally {
            vi.restoreAllMocks();
        }
    }, 30_000);
});
