import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";
import type { FrozenImageEnhancementPolicy } from "./image-enhancement-config";
import type { ImageTask } from "./image-task-store";
import type { PreparedEnhancementPublication } from "./image-enhancement-processing-store";
import type { ImageProcessingEnhancementOptions, ImageProcessingResult } from "../image-processing/contracts";
import type { StoredImageProcessingArtifact } from "./image-processing-service";
import { openRetainedEnhancementWorker, retainedWorkerToken } from "./image-enhancement-retained-worker-fixture";
import { readImageTaskResultBytesFixture } from "./image-processing.test-fixture";

const connection = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./image-enhancement-config", async (original) => ({ ...(await original<typeof import("./image-enhancement-config")>()), resolveImageEnhancementConnection: connection.resolve }));
vi.mock("next/headers", async (original) => ({ ...(await original<typeof import("next/headers")>()), cookies: async () => ({ get: () => undefined }) }));
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const policy: FrozenImageEnhancementPolicy = {
    revision: "scene-contract-fixture",
    enabled: true,
    connection: {
        revision: "scene-contract-fixture",
        credentialRef: "fixture-credential",
        serviceId: "31313131-3131-4131-8131-313131313131",
        timeoutMs: 10_000,
        model: { id: "fixture-x4", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 },
    },
};

// Keep the producer proof boundary separate from the representative claimed CPU publication chain.
describe("real scene producer proof and protected CPU publication", () => {
    let directory: string;
    let closeServer: (() => Promise<void>) | undefined;
    let origin: string;
    let userId: string;
    let tasks: typeof import("./generation-task-store");
    let images: typeof import("./image-task-store");
    let jobs: typeof import("./database/image-enhancement-job-repository");
    let logs: typeof import("./generation-log-repository");
    let store: typeof import("./image-enhancement-processing-store");
    let media: typeof import("@/app/api/image-tasks/image-task-support");
    let auth: typeof import("./maintenance-auth");

    beforeEach(async () => {
        vi.resetModules();
        connection.resolve.mockReset();
        directory = await mkdtemp(join(tmpdir(), "vozeb-scene-contract-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-maintenance-token-".repeat(3));
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-worker-token-".repeat(3));
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "3072");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "2048");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        [tasks, images, jobs, logs, store, media, auth] = await Promise.all([
            import("./generation-task-store"),
            import("./image-task-store"),
            import("./database/image-enhancement-job-repository"),
            import("./generation-log-repository"),
            import("./image-enhancement-processing-store"),
            import("@/app/api/image-tasks/image-task-support"),
            import("./maintenance-auth"),
        ]);
        expect((await (await import("./object-storage-config")).getObjectStorageRuntimeConfig()).enabled).toBe(false);
        userId = "scene-contract-" + randomUUID();
        const { mutateAuthDb } = await import("@/lib/auth/store-repository");
        await mutateAuthDb((db) => {
            db.users.push({
                id: userId,
                accountId: "9001",
                username: "scene_contract_fixture",
                displayName: "Scene contract fixture",
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
        const [route, outputRoute, completeRoute] = await Promise.all([
            import("@/app/api/generation-log-assets/[...path]/route"),
            import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route"),
            import("@/app/api/maintenance/image-processing/[id]/complete/route"),
        ]);
        const failures: unknown[] = [];
        const reply = async (response: ServerResponse, result: Response) => {
            response.writeHead(result.status, Object.fromEntries(result.headers));
            response.end(Buffer.from(await result.arrayBuffer()));
        };
        const bodyRequest = async (request: IncomingMessage, url: URL, headers: Headers) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            return new Request(url, { method: request.method, headers, body: new Uint8Array(Buffer.concat(chunks)) });
        };
        const handle = async (request: IncomingMessage, response: ServerResponse) => {
            const url = new URL(request.url!, origin);
            const headers = new Headers();
            for (const [key, value] of Object.entries(request.headers)) {
                if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
                else if (value !== undefined) headers.set(key, value);
            }
            if (url.pathname.startsWith("/api/generation-log-assets/")) {
                const result = await route.GET(new Request(url, { headers }), { params: Promise.resolve({ path: url.pathname.slice("/api/generation-log-assets/".length).split("/").map(decodeURIComponent) }) });
                assert.equal(result.status, 200);
                await reply(response, result);
                return;
            }
            const output = /^\/api\/maintenance\/image-processing\/([^/]+)\/outputs\/final$/.exec(url.pathname);
            if (request.method === "PUT" && output) {
                await reply(response, await outputRoute.PUT(await bodyRequest(request, url, headers), { params: Promise.resolve({ id: decodeURIComponent(output[1]), kind: "final" }) }));
                return;
            }
            const complete = /^\/api\/maintenance\/image-processing\/([^/]+)\/complete$/.exec(url.pathname);
            if (request.method === "POST" && complete) {
                await reply(response, await completeRoute.POST(await bodyRequest(request, url, headers), { params: Promise.resolve({ id: decodeURIComponent(complete[1]) }) }));
                return;
            }
            assert.equal(request.headers.authorization, "Bearer fixture-gpu-token");
            assert.equal(request.method, "GET");
            assert.equal(url.pathname, "/v1/capabilities");
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    code: "ok",
                    data: {
                        serviceId: policy.connection!.serviceId,
                        protocolVersion: "image-enhancement.v1",
                        normalizationProfile: "srgb-upright-v1",
                        features: { expectedStrategyFingerprint: true },
                        ready: true,
                        models: [policy.connection!.model],
                        budgets: { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } },
                    },
                }),
            );
        };
        const server = createServer((request, response) => {
            void handle(request, response).catch((error: unknown) => {
                failures.push(error);
                response.writeHead(500);
                response.end("fixture boundary failure");
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        origin = `http://127.0.0.1:${address.port}`;
        closeServer = async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
            });
            if (failures.length) throw new AggregateError(failures, "Real owned-media fixture failed");
        };
    });
    afterEach(async () => {
        try {
            await closeServer?.();
        } finally {
            closeServer = undefined;
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });

    async function produceSceneOriginal(nativeWidth = 32) {
        const taskId = randomUUID();
        const source = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#517b9d" } })
            .png()
            .toBuffer();
        const native = await sharp({ create: { width: nativeWidth, height: nativeWidth, channels: 3, background: "#a68143" } })
            .png()
            .toBuffer();
        const sourceFile = await logs.writeAssetBytes(source, "image/png", "image", { ownerUserId: userId, source: "image-workbench", taskId });
        assert.ok(sourceFile.serverUrl);
        const runtime = await import("./creative-runtime-store");
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat", source: "image-workbench", title: "Scene enhancement fixture" });
        const [sourceAsset] = await runtime.registerCreativeAssets([
            {
                id: "scene-source",
                userId,
                conversationId: conversation.id,
                sourceRunId: "scene-source:" + taskId,
                sourceTaskId: "source:" + taskId,
                ordinal: 0,
                type: "image",
                title: "Scene source",
                serverUrl: sourceFile.serverUrl,
                storageKind: "local",
                width: 32,
                height: 32,
                bytes: source.length,
                mimeType: "image/png",
            },
        ]);
        const regions = await import("./ecommerce-product-regions");
        const { buildSceneEditProtection } = await import("./ecommerce-protection.test-fixtures");
        const protection = await buildSceneEditProtection(source, "scene-source", { x: 8, y: 8, width: 8, height: 8 }, ["replace selected prop"], "user_selection");
        protection.confirmation = { actorUserId: userId, confirmedAt: 1 };
        const task: ImageTask = {
            id: taskId,
            userId,
            username: "scene_contract_fixture",
            displayName: "Scene contract fixture",
            kind: "edit",
            source: "image-workbench",
            conversationId: conversation.id,
            surface: "chat",
            status: "running",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            config: { baseUrl: "https://fixture.invalid", apiKey: "system", apiFormat: "openai", model: "fixture", quality: "4k", size: "32x32" },
            prompt: "Scene contract fixture",
            references: [{ id: "scene-source", name: "source.png", type: "image/png", dataUrl: sourceFile.serverUrl, serverUrl: sourceFile.serverUrl, width: 32, height: 32 }],
            ecommerceExecution: {
                state: "ready",
                compilerVersion: "ecommerce-nano-banana-2.v1",
                providerProfileId: "nano-banana-2",
                prompt: "Scene contract fixture",
                parameters: { variant: "nano-banana-2" },
                modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "openai" },
                protection: { scope: "local", preserveOutsideMask: true, protectedObjectIds: [], allowLightingChange: false },
                referenceRoles: [{ assetId: "scene-source", role: "scene" }],
                canvas: { mode: "ratio", size: { width: 32, height: 32 }, source: "baseline", allowReframe: true },
            },
            mask: protection.mask,
            sceneProtection: protection,
            enhancementPolicy: structuredClone(policy),
        };
        const authContext = auth.maintenanceWorkerContext(userId);
        const { freezeEcommerceEnhancementDelivery } = await import("./image-enhancement-delivery");
        task.enhancementDelivery = await freezeEcommerceEnhancementDelivery(task, async (reference) => Buffer.from((await media.imageReferenceToDataUrl(reference, "source.png", origin, authContext)).split(",")[1], "base64"));
        assert.ok(task.enhancementDelivery?.scope === "local_edit");
        const running = await tasks.createStoredGenerationTask<ImageTask>("image", task, 60_000);
        const pureBaseline = await regions.compositeSceneEdit(source, native, protection);
        const { prepareImageTaskResults } = await import("./image-task-result-service");
        const produced = await prepareImageTaskResults(running, { dataUrl: "data:image/png;base64," + native.toString("base64") }, origin, authContext);
        expect(produced.results).toHaveLength(1);
        // Select the supported local_edit contract with the producer's actual native evidence.
        const { enhancementSource: _enhancementSource, ...original } = produced.results[0];
        assert.ok(original.nativeSource && original.enhancementId && original.sceneProtectionEvidence);
        expect(original.sceneProtectionEvidence).toMatchObject({
            nativeUrl: expect.stringMatching(/^\/api\/generation-log-assets\//),
            compositeUrl: expect.stringMatching(/^\/api\/generation-log-assets\//),
            maskUrl: expect.stringMatching(/^\/api\/generation-log-assets\//),
        });
        const successful = await images.transitionImageTask(running, ["running"], { status: "success", result: { ...original, results: [original] } });
        assert.ok(successful);
        const queued = await jobs.getEnhancementJob(original.enhancementId, userId);
        assert.ok(queued?.decision.status === "queued");
        return { taskId, conversation, sourceAsset, original, pureBaseline, queued, queuedDecision: queued.decision };
    }

    async function fixture(nativeWidth = 32) {
        const { taskId, original, pureBaseline, queued, queuedDecision } = await produceSceneOriginal(nativeWidth);
        const { createEnhancementTaskClient } = await import("./image-enhancement-worker-client");
        const client = createEnhancementTaskClient({ endpoint: origin, token: "fixture-gpu-token", serviceId: policy.connection!.serviceId, timeoutMs: 10_000, trust: "system", caPem: "" });
        const plan = await client.prepare(queuedDecision).finally(() => client.close());
        const ai = await sharp({ create: { width: 128, height: 128, channels: 3, background: "#496d81" } })
            .png()
            .toBuffer();
        const aiPath = join(directory, "controlled-ai.png");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(aiPath, ai);
        await jobs.mutateEnhancementJob(queued.id, userId, (row) => ({
            ...row,
            status: "running",
            phase: "publish",
            remotePlan: plan,
            remoteJobId: "schema-fixture-remote",
            remoteStatus: "succeeded",
            remoteResult: { width: 128, height: 128, format: "png", sha256: digest(ai), byteLength: ai.length },
            nextPollAt: Date.now(),
        }));
        const [parent] = await jobs.claimEnhancementJobs({ workerId: "fixture-enhancement-parent", now: Date.now(), leaseMs: 60_000, limit: 1 });
        assert.ok(parent);
        const before = await tasks.getStoredGenerationTaskRecord("image", taskId);
        const record = await tasks.getStoredGenerationTaskRecord("image", taskId);
        const binding = store.currentEnhancementPublicationBinding(parent, record, Date.now());
        const delivery = binding.decision.delivery;
        assert.ok(delivery?.contract.scope === "local_edit");
        const contract = delivery.contract;
        const originalProof = original.sceneProtectionEvidence;
        assert.ok(originalProof?.maskUrl);
        const references = await import("./reference-asset-store");
        const rawAi = await references.writeReferenceMediaFile(aiPath, "image", "image/png", false, { ownerUserId: userId, source: "enhancement-raw-ai", taskId: parent.id, maxBytes: 1_000_000 });
        const registry = await import("./local-media-registry");
        const roots = await import("./local-media-storage");
        const { readFile } = await import("node:fs/promises");
        const inputs: PreparedEnhancementPublication["inputs"] = [];
        const sources: PreparedEnhancementPublication["sources"] = [];
        const frozenInputs: PreparedEnhancementPublication["frozenInputs"] = [];
        const encodedInputs: PreparedEnhancementPublication["facts"]["encodedInputs"][number][] = [];
        const decodedInputs: PreparedEnhancementPublication["facts"]["decodedInputs"][number][] = [];
        const facts: PreparedEnhancementPublication["facts"] = { encodedInputs, decodedInputs };
        const add = async (assetId: string, url: string) => {
            const location = new URL(url, origin);
            const scope = location.pathname.startsWith("/api/generation-log-assets/") ? "generation" : "reference";
            const prefix = scope === "generation" ? "/api/generation-log-assets/" : "/api/reference-assets/";
            const storageKey = location.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
            const registration = await registry.getLocalMediaRegistration(storageKey);
            assert.ok(registration);
            const bytes = await readFile(join(scope === "generation" ? roots.GENERATION_MEDIA_ROOT : roots.REFERENCE_MEDIA_ROOT, storageKey));
            const metadata = await sharp(bytes).metadata();
            assert.ok(metadata.width && metadata.height && metadata.format && metadata.depth && metadata.channels);
            const observed = { expectedSha256: digest(bytes), width: metadata.width, height: metadata.height };
            const input = { assetId, expectedSha256: observed.expectedSha256, assetVersion: store.enhancementInputAssetVersion(registration, observed) };
            const inputIndex = inputs.length;
            const source: PreparedEnhancementPublication["sources"][number] = { inputIndex, scope, storageKey, storageProvider: "local" };
            inputs.push(input);
            sources.push(source);
            frozenInputs.push({ ...input, ...source, ownerUserId: userId, bytes: bytes.length, width: metadata.width, height: metadata.height, mimeType: registration.mimeType });
            const identity = { inputIndex, assetId, assetVersion: input.assetVersion, sha256: observed.expectedSha256 };
            encodedInputs.push({ ...identity, bytes: bytes.length, layout: { format: metadata.format, depth: metadata.depth, channels: metadata.channels } });
            decodedInputs.push({ ...identity, width: metadata.width, height: metadata.height });
            return inputIndex;
        };
        const aiInputIndex = await add("ai:" + parent.id, "/api/reference-assets/" + rawAi.token);
        const sourceInputIndex = await add(contract.protection.scene.sourceAssetId, contract.baseline.url);
        const nativeInputIndex = await add("native:" + parent.id, binding.decision.source.url);
        const baselineInputIndex = await add("baseline:" + parent.id, delivery.baseline.url);
        const maskInputIndex = await add("mask:" + parent.id, originalProof.maskUrl);
        const { mask: _mask, ...scene } = contract.protection.scene;
        const nativeSource = binding.decision.source;
        assert.ok(nativeSource.format === "png" || nativeSource.format === "jpeg");
        const roles: ImageProcessingEnhancementOptions = {
            scope: "local_edit",
            bindingDigest: binding.bindingDigest,
            resultId: binding.resultId,
            resultIndex: binding.resultIndex,
            aiInputIndex,
            sourceInputIndex,
            nativeInputIndex,
            baselineInputIndex,
            maskInputIndex,
            engineInput: { width: delivery.baseline.width, height: delivery.baseline.height },
            expectedAi: binding.remoteResult,
            targetSize: binding.decision.target,
            budgets: binding.remotePlan.budgets,
            source: { sha256: contract.baseline.sha256, byteLength: contract.baseline.byteLength, width: contract.baseline.width, height: contract.baseline.height, normalizedSha256: contract.baseline.normalizedSha256 },
            native: { sha256: nativeSource.sha256, byteLength: nativeSource.byteLength, width: nativeSource.width, height: nativeSource.height, format: nativeSource.format },
            baseline: { sha256: delivery.baseline.sha256, byteLength: delivery.baseline.byteLength, width: delivery.baseline.width, height: delivery.baseline.height, format: "png" },
            protection: { version: contract.protection.version, normalization: contract.protection.normalization, scene },
            originalProof: pureBaseline.evidence,
        };
        // This is the existing 635 server options boundary; its real binding proof came from the actual producer above.
        const options = store.enhancementOptionsForBinding(binding, roles);
        const prepared: PreparedEnhancementPublication = { binding, options, inputs, sources, frozenInputs, facts, rawAi: { input: inputs[aiInputIndex], source: sources[aiInputIndex] } };
        const enqueued = await store.enqueueEnhancementPublication(parent, prepared);
        const child = await store.readEnhancementProcessingTask(enqueued.id);
        assert.ok(child);
        expect(child).toMatchObject({ status: "pending", executionPhase: "created", attemptNo: 0, payload: { operation: "process_enhancement", resource: { requiredMemoryBytes: 1280 * 1024 * 1024 } } });
        expect(child.payload.executionId).toBeUndefined();
        expect(child.workerId).toBeUndefined();
        expect(child.resultPayload).toBeUndefined();
        const inputFiles = prepared.inputs.map((input, index) => ({ ...input, path: join(prepared.sources[index].scope === "generation" ? roots.GENERATION_MEDIA_ROOT : roots.REFERENCE_MEDIA_ROOT, prepared.sources[index].storageKey) }));
        return { taskId, before, original, pureBaseline, prepared, child, inputs: inputFiles };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function kernel(current: Fixture, options: ImageProcessingEnhancementOptions) {
        const outputDirectory = join(directory, "real-kernel-output");
        await mkdir(outputDirectory);
        const metrics: ImageProcessingResult["metrics"] = { pid: process.pid, peakRssBytes: 0, peakHeapUsedBytes: 0, peakExternalBytes: 0, elapsedMs: 0 };
        const sample = () => {
            const memory = process.memoryUsage();
            metrics.peakRssBytes = Math.max(metrics.peakRssBytes, memory.rss);
            metrics.peakHeapUsedBytes = Math.max(metrics.peakHeapUsedBytes, memory.heapUsed);
            metrics.peakExternalBytes = Math.max(metrics.peakExternalBytes, memory.external);
        };
        const started = performance.now();
        sample();
        const { processEnhancement } = await import("../image-processing/enhancement-publication");
        const result = await processEnhancement({ version: "image-processing.v1", jobId: current.child.id, executionId: "kernel-schema-only-no-claim", operation: "process_enhancement", options, inputs: current.inputs, outputDirectory }, sample);
        sample();
        metrics.elapsedMs = performance.now() - started;
        return { result, metrics };
    }

    it("passes actual producer URL-bearing scene evidence to the CPU as pure pixel proof without changing the original", async () => {
        const current = await fixture();
        // Against v1 the real CPU operation rejects its rebuilt baseline here, before any later assertion.
        const actual = await kernel(current, current.prepared.options);
        expect(actual.result.enhancement).toMatchObject({ scope: "local_edit", protection: { version: "scene-enhancement.v1", sourceSize: { width: 32, height: 32 }, aiSize: { width: 128, height: 128 } } });
        expect(current.prepared.options).toHaveProperty("originalProof", current.pureBaseline.evidence);
        expect(current.prepared.options).not.toHaveProperty("originalProof.nativeUrl");
        expect(current.prepared.options).not.toHaveProperty("originalProof.compositeUrl");
        expect(current.prepared.options).not.toHaveProperty("originalProof.maskUrl");
        expect(current.prepared.binding.originalProof).toStrictEqual(current.original.sceneProtectionEvidence);
        expect(await tasks.getStoredGenerationTaskRecord("image", current.taskId)).toStrictEqual(current.before);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.child.id)).toStrictEqual(current.child);
    }, 30_000);

    it("publishes a protected scene through a claimed CPU child, HTTP completion and the original remote receipt", async () => {
        const current = await produceSceneOriginal(64);
        assert.ok(current.queued.decision.status === "queued" && current.queued.decision.delivery?.contract.scope === "local_edit");
        const frozen = current.queued.decision.connection;
        const baseline = await readImageTaskResultBytesFixture(current.queued.decision.delivery.baseline.url);
        const ai = await sharp({ create: { width: 128, height: 128, channels: 3, background: "#496d81" } })
            .png()
            .toBuffer();
        const controlDirectory = join(directory, "scene-worker");
        await mkdir(controlDirectory);
        const generationAssetGet = (await import("@/app/api/generation-log-assets/[...path]/route")).GET;
        const worker = await openRetainedEnhancementWorker({
            controlDirectory,
            readParent: () => jobs.getEnhancementJob(current.queued.id, userId),
            mediaGet: (request) => generationAssetGet(request, { params: Promise.resolve({ path: new URL(request.url).pathname.slice("/api/generation-log-assets/".length).split("/").map(decodeURIComponent) }) }),
            create: {
                serviceId: frozen.serviceId,
                model: frozen.model,
                budgets: { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } },
                source: baseline,
                ai,
            },
        });
        try {
            connection.resolve.mockResolvedValue({ endpoint: worker.endpoint, token: retainedWorkerToken, serviceId: frozen.serviceId, timeoutMs: frozen.timeoutMs, trust: "system", caPem: "" });
            const enhancement = await import("./image-enhancement-service");
            const processing = await import("./image-processing-service");
            const runtime = await import("./creative-runtime-store");
            const registry = await import("./local-media-registry");
            const runWhenDue = async () => {
                const parent = await jobs.getEnhancementJob(current.queued.id, userId);
                assert.ok(parent && parent.nextPollAt !== null);
                await delay(Math.max(0, parent.nextPollAt - Date.now()));
                await enhancement.runImageEnhancementBatch({ origin, workerId: "scene-enhancement-parent", limit: 1 });
            };
            await runWhenDue();
            await runWhenDue();
            await runWhenDue();
            await runWhenDue();
            const pending = await jobs.getEnhancementJob(current.queued.id, userId);
            assert.ok(pending?.publicationProcessing);
            expect(pending.publication).toBeUndefined();
            const child = await store.readEnhancementProcessingTask(pending.publicationProcessing.jobId);
            assert.ok(child);
            expect(child).toMatchObject({ status: "pending", payload: { operation: "process_enhancement", options: { scope: "local_edit" } } });
            expect((await worker.readState()).receipt).toBeUndefined();

            const config = (await import("../image-processing/resource-config")).imageProcessingResourceConfig(process.env);
            const workerId = "scene-enhancement-cpu";
            const claimed = await processing.claimImageProcessingTasks({ workerId, profileVersion: config.profileVersion, availableMemoryBytes: config.budgetBytes, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const execution = claimed.tasks[0];
            expect(execution.id).toBe(child.id);
            assert.ok(execution.payload.operation === "process_enhancement");
            const identity = { workerId, executionId: execution.executionId };
            const taskDirectory = await mkdtemp(join(directory, "scene-cpu-"));
            const inputs = await Promise.all(
                execution.payload.inputs.map(async (input, index) => {
                    const path = join(taskDirectory, "input-" + index);
                    const source = await processing.readImageProcessingInput(execution.id, input.assetId, identity);
                    await pipeline(source.stream, createWriteStream(path, { flags: "wx" }));
                    return { ...input, path };
                }),
            );
            const outputDirectory = join(taskDirectory, "outputs");
            await mkdir(outputDirectory);
            const closed = await runImageProcessing({ ...execution.payload, jobId: execution.id, executionId: execution.executionId, inputs, outputDirectory }, { taskDirectory, maxHeapMiB: execution.payload.resource.configuration.processHeapMb });
            expect(closed).toMatchObject({ status: "completed", jobId: child.id, executionId: execution.executionId, exitCode: 0, signal: null });
            assert.ok(closed.status === "completed");
            expect(closed.result.metrics.pid).not.toBe(process.pid);
            const artifact = closed.result.artifacts[0];
            assert.ok(artifact.resultId);
            expect(artifact).toMatchObject({ kind: "final", mimeType: "image/png", width: 32, height: 32 });
            const upload = await fetch(`${origin}/api/maintenance/image-processing/${encodeURIComponent(child.id)}/outputs/final?resultId=${encodeURIComponent(artifact.resultId)}`, {
                method: "PUT",
                headers: { authorization: "Bearer " + process.env.VOZEB_PRO_WORKER_TOKEN, "content-type": artifact.mimeType, "x-vozeb-pro-worker-id": workerId, "x-vozeb-pro-execution-id": execution.executionId },
                body: new Uint8Array(await readFile(artifact.path)),
            });
            expect(upload.status).toBe(201);
            const stored: StoredImageProcessingArtifact = (await upload.json()).data;
            const { metrics, ...result } = closed.result;
            const manifest = { ...result, artifacts: [stored] };
            const complete = await fetch(`${origin}/api/maintenance/image-processing/${encodeURIComponent(child.id)}/complete`, {
                method: "POST",
                headers: { authorization: "Bearer " + process.env.VOZEB_PRO_WORKER_TOKEN, "content-type": "application/json" },
                body: JSON.stringify({ ...identity, manifest, metrics }),
            });
            expect(complete.status).toBe(200);
            expect(await complete.json()).toMatchObject({ code: 0, data: { jobId: child.id, executionId: execution.executionId, inputDigest: child.payload.inputDigest, parentRescheduled: true } });
            const completedChild = await store.readEnhancementProcessingTask(child.id);
            expect(completedChild).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { manifest } });
            expect((await jobs.getEnhancementJob(current.queued.id, userId))?.publication).toBeUndefined();
            const remote = await worker.readState();

            const originalTask = await images.getImageTask(current.taskId);
            assert.ok(originalTask);
            const otherId = randomUUID();
            const otherSource = current.queued.decision.source;
            const otherMedia = {
                resultId: otherId + ":1",
                enhancementId: "enhancement:" + otherId + ":1",
                dataUrl: otherSource.url,
                serverUrl: otherSource.url,
                nativeSource: otherSource,
                width: otherSource.width,
                height: otherSource.height,
                bytes: otherSource.byteLength,
                mimeType: "image/" + otherSource.format,
            };
            const otherResult = { ...otherMedia, results: [otherMedia] };
            const other = await tasks.createStoredGenerationTask<ImageTask>(
                "image",
                {
                    id: otherId,
                    userId,
                    username: originalTask.username,
                    displayName: originalTask.displayName,
                    kind: "generation",
                    source: "image-workbench",
                    conversationId: current.conversation.id,
                    status: "running",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    config: originalTask.config,
                    prompt: "Concurrent native completion fixture",
                    references: [],
                    enhancementPolicy: { ...policy, enabled: false },
                },
                60_000,
            );
            let enteredConsumer!: () => void;
            let releaseConsumer!: () => void;
            const consumerEntered = new Promise<void>((resolve) => {
                enteredConsumer = resolve;
            });
            const consumerReleased = new Promise<void>((resolve) => {
                releaseConsumer = resolve;
            });
            const adapter = await import("./data-adapter");
            const fileLock = adapter.withJsonDataFileLock;
            const observeConsumer: typeof fileLock = (name, callback, options) =>
                fileLock(
                    name,
                    async () => {
                        if (name === "creative-runtime.json") {
                            enteredConsumer();
                            await consumerReleased;
                        }
                        return callback();
                    },
                    options,
                );
            const observer = vi.spyOn(adapter, "withJsonDataFileLock").mockImplementation(observeConsumer);
            const publishing = runWhenDue();
            try {
                await Promise.race([
                    consumerEntered,
                    publishing.then(() => {
                        throw new Error("Consumer completed without entering the held creative write");
                    }),
                ]);
                const completedNative = await images.transitionImageTask(other, ["running"], { status: "success", result: otherResult });
                expect(completedNative).toMatchObject({ id: otherId, status: "success", result: otherResult });
                expect(await jobs.getEnhancementJob(current.queued.id, userId)).not.toHaveProperty("publication");
            } finally {
                releaseConsumer();
                await publishing;
                observer.mockRestore();
            }
            expect(await images.getImageTask(otherId)).toMatchObject({ id: otherId, status: "success", result: otherResult });
            expect(await images.getImageTask(current.taskId)).toStrictEqual(originalTask);
            const published = await jobs.getEnhancementJob(current.queued.id, userId);
            assert.ok(published?.publication && manifest.enhancement?.protection?.version === "scene-enhancement.v1");
            expect(published).toMatchObject({ status: "succeeded", phase: "receipt", receiptId: current.queued.receiptId, remoteJobId: pending.remoteJobId });
            const { delivered, protection, assetId } = published.publication;
            const { publicImageEnhancement } = await import("./image-enhancement-public");
            expect(publicImageEnhancement(published).enhanced).toMatchObject({ format: "png", url: delivered.url, sha256: artifact.sha256 });
            expect(delivered).toMatchObject({ format: "png", width: 32, height: 32, sha256: artifact.sha256, byteLength: artifact.bytes });
            expect(delivered.url).toMatch(/^\/api\/generation-log-assets\//);
            const deliveredBytes = await readImageTaskResultBytesFixture(delivered.url);
            expect({ sha256: digest(deliveredBytes), bytes: deliveredBytes.length }).toEqual({ sha256: artifact.sha256, bytes: artifact.bytes });
            expect(await sharp(deliveredBytes).metadata()).toMatchObject({ format: "png", width: 32, height: 32 });
            const deliveredKey = new URL(delivered.url, origin).pathname.slice("/api/generation-log-assets/".length).split("/").map(decodeURIComponent).join("/");
            expect(await registry.getLocalMediaRegistration(deliveredKey)).toMatchObject({ scope: "generation", storageClass: "permanent", ownerUserId: userId, taskId: current.queued.id, mimeType: "image/png" });
            expect(protection).toStrictEqual(manifest.enhancement.protection);
            expect(protection).toMatchObject({
                version: "scene-enhancement.v1",
                protectedChangedPixels: 0,
                sourceSize: { width: 32, height: 32 },
                aiSize: { width: 128, height: 128 },
                mapping: { context: { x: 0, y: 0, width: 32, height: 32 }, targetRegion: { x: 8, y: 8, width: 8, height: 8 } },
            });
            const pixels = await sharp(deliveredBytes).ensureAlpha().raw().toBuffer();
            expect([...pixels.subarray(0, 4)]).toEqual([81, 123, 157, 255]);
            expect([...pixels.subarray((10 * 32 + 10) * 4, (10 * 32 + 10) * 4 + 4)]).toEqual([73, 109, 129, 255]);
            const assets = await runtime.listCreativeAssets(current.conversation.id, userId);
            const originalAsset = assets.find((asset) => asset.sourceTaskId === current.taskId && asset.serverUrl === current.original.serverUrl);
            assert.ok(originalAsset);
            expect(originalAsset).toMatchObject({ parentAssetId: current.sourceAsset.id, metadata: { provenance: "protected_baseline", parentAssetIds: [current.sourceAsset.id] } });
            expect(assets.find((asset) => asset.id === assetId)).toMatchObject({
                parentAssetId: originalAsset.id,
                serverUrl: delivered.url,
                width: 32,
                height: 32,
                bytes: artifact.bytes,
                mimeType: "image/png",
                metadata: { enhancementId: current.queued.id, parentResultId: current.original.resultId, parentAssetIds: [originalAsset.id], sha256: artifact.sha256, protection },
            });
            expect((await images.getImageTask(current.taskId))?.result?.sceneProtectionEvidence).toStrictEqual(current.original.sceneProtectionEvidence);
            expect(await store.readEnhancementProcessingTask(child.id)).toStrictEqual(completedChild);
            const beforeAck = await worker.readState();
            expect(beforeAck.receipt).toBeUndefined();
            expect(beforeAck.requests).toStrictEqual(remote.requests);

            await runWhenDue();
            expect(await jobs.getEnhancementJob(current.queued.id, userId)).toMatchObject({
                status: "succeeded",
                phase: "completed",
                publication: published.publication,
                remoteKey: pending.remoteKey,
                remoteJobId: pending.remoteJobId,
                receiptId: current.queued.receiptId,
                nextPollAt: null,
            });
            const acknowledged = await worker.readState();
            const ack = { serviceId: frozen.serviceId, receiptId: current.queued.receiptId, result: remote.output };
            expect(acknowledged.receipt).toEqual(ack);
            expect(acknowledged.acceptedRequest).toStrictEqual(remote.acceptedRequest);
            expect(acknowledged.requests.slice(remote.requests.length)).toEqual([
                { method: "GET", path: "/v1/capabilities" },
                { method: "POST", path: `/v1/enhancement-jobs/${pending.remoteJobId}/receipt`, body: ack },
            ]);
            expect(await store.readEnhancementProcessingTask(child.id)).toStrictEqual(completedChild);
        } finally {
            await worker.close();
        }
    }, 30_000);
});
