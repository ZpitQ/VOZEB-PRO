import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";
import { imageProcessingResourceConfig } from "../image-processing/resource-config";
import { completeClaimedImageProcessingFixture, readImageTaskResultBytesFixture } from "./image-processing.test-fixture";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), prepare: vi.fn(), submit: vi.fn(), query: vi.fn(), download: vi.fn(), acknowledge: vi.fn(), cancel: vi.fn(), close: vi.fn(), readSource: vi.fn(), store: vi.fn() }));
vi.mock("./image-enhancement-config", async (importOriginal) => ({ ...(await importOriginal<typeof import("./image-enhancement-config")>()), resolveImageEnhancementConnection: mocks.resolve }));
vi.mock("./image-enhancement-worker-client", async (importOriginal) => ({ ...(await importOriginal<typeof import("./image-enhancement-worker-client")>()), createEnhancementTaskClient: () => mocks }));
vi.mock("@/app/api/image-tasks/image-task-support", () => ({ imageReferenceToDataUrl: mocks.readSource, inlineRemoteImageResult: async (dataUrl: string) => ({ dataUrl }), resolveProxiedMediaSource: () => ({}), directRemoteImageResult: vi.fn() }));
vi.mock("./maintenance-auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("./maintenance-auth")>()), maintenanceWorkerContext: () => "fixture-worker-context" }));
let claimEnhancementJobs: (typeof import("./database/image-enhancement-job-repository"))["claimEnhancementJobs"];
let getEnhancementJob: (typeof import("./database/image-enhancement-job-repository"))["getEnhancementJob"];
let listEnhancementJobsForTask: (typeof import("./database/image-enhancement-job-repository"))["listEnhancementJobsForTask"];
let mutateEnhancementJob: (typeof import("./database/image-enhancement-job-repository"))["mutateEnhancementJob"];
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
let readJsonDataFile: (typeof import("./data-adapter"))["readJsonDataFile"];
let writeJsonDataFile: (typeof import("./data-adapter"))["writeJsonDataFile"];
let createStoredGenerationTask: (typeof import("./generation-task-store"))["createStoredGenerationTask"];
let mutateStoredGenerationTask: (typeof import("./generation-task-store"))["mutateStoredGenerationTask"];
let getImageTask: (typeof import("./image-task-store"))["getImageTask"];
let transitionImageTask: (typeof import("./image-task-store"))["transitionImageTask"];
let updateImageTask: (typeof import("./image-task-store"))["updateImageTask"];
import type { ImageTask } from "./image-task-store";
let cancelImageEnhancement: (typeof import("./image-enhancement-service"))["cancelImageEnhancement"];
let retryImageEnhancement: (typeof import("./image-enhancement-service"))["retryImageEnhancement"];
let runImageEnhancementBatch: (typeof import("./image-enhancement-service"))["runImageEnhancementBatch"];
let publicImageEnhancement: (typeof import("./image-enhancement-public"))["publicImageEnhancement"];
let planImageTaskEnhancement: (typeof import("./image-enhancement-enqueue"))["planImageTaskEnhancement"];
import type { FrozenImageEnhancementPolicy } from "./image-enhancement-config";
import type { FrozenWorkerEnhancementPlan, RemoteEnhancementJob } from "./image-enhancement-worker-client";
import type { EnhancementSource } from "./image-enhancement-plan";
import type { EcommerceEnhancementDelivery } from "./image-enhancement-delivery";
let compositeProductEnhancement: (typeof import("./image-enhancement-product-protection"))["compositeProductEnhancement"];
import type { ProductEnhancementProtection } from "./image-enhancement-product-protection";
import type { EcommerceResultTechnicalCheck } from "./ecommerce-quality-check";
let buildSceneEditProtection: (typeof import("./ecommerce-product-regions"))["buildSceneEditProtection"];
let compositeSceneEdit: (typeof import("./ecommerce-product-regions"))["compositeSceneEdit"];
let createCreativeConversation: (typeof import("./creative-runtime-store"))["createCreativeConversation"];
let getCreativeAssetsByIds: (typeof import("./creative-runtime-store"))["getCreativeAssetsByIds"];
let listCreativeAssets: (typeof import("./creative-runtime-store"))["listCreativeAssets"];
let registerCreativeAssets: (typeof import("./creative-runtime-store"))["registerCreativeAssets"];
let initializePostgresSchema: (typeof import("./database/postgres"))["initializePostgresSchema"];
let postgresQuery: (typeof import("./database/postgres"))["postgresQuery"];
let prepareImageTaskResults: (typeof import("./image-task-result-service"))["prepareImageTaskResults"];
let creativeRuntime: typeof import("./creative-runtime-store");

const policy: FrozenImageEnhancementPolicy = {
    revision: "policy-one",
    enabled: true,
    connection: {
        revision: "policy-one",
        credentialRef: "credential-fixture",
        serviceId: "31313131-3131-4131-8131-313131313131",
        timeoutMs: 60_000,
        model: { id: "model-fixture", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 },
    },
};
const pg = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
for (const provider of ["file", "postgres"] as const) {
    describe.skipIf(provider === "postgres" && !pg)(`${provider} durable enhancement execution`, () => {
        let directory: string;
        let task: ImageTask;
        let id: string;
        let source: Buffer;
        let plan: FrozenWorkerEnhancementPlan;
        let remote: RemoteEnhancementJob;
        let ai: Buffer;
        let logs: typeof import("./generation-log-repository");
        let registry: typeof import("./local-media-registry");
        let processing: typeof import("./image-processing-service");
        let cpuFailureExpected: boolean;
        async function writeFixtureAsset(url: string, bytes: Buffer) {
            const path = logs.localAssetUrlToPath(url);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, bytes);
            const metadata = await sharp(bytes).metadata();
            await registry.registerLocalMediaAsset({
                storageKey: new URL(url, "http://fixture.local").pathname.slice("/api/generation-log-assets/".length),
                scope: "generation",
                storageClass: "permanent",
                type: "image",
                ownerUserId: "enhancement-service-owner",
                source: "image-workbench",
                conversationId: task.conversationId,
                taskId: id,
                mimeType: `image/${metadata.format}`,
                bytes: bytes.length,
            });
        }
        const readFixtureAsset = readImageTaskResultBytesFixture;
        async function run() {
            const batch = await runImageEnhancementBatch({ origin: "http://fixture.local", workerId: "enhancement-fixture", limit: 50 });
            const parent = await job();
            if (parent?.status !== "running" || !parent.publicationProcessing || parent.publicationProcessing.outcome || parent.cancelRequested) return batch;
            const workerId = "enhancement-cpu-fixture";
            const { profileVersion, budgetBytes } = imageProcessingResourceConfig(process.env);
            const claimed = await processing.claimImageProcessingTasks({ workerId, profileVersion, availableMemoryBytes: budgetBytes, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const child = claimed.tasks[0];
            expect(child.id).toBe(parent.publicationProcessing.jobId);
            if (cpuFailureExpected) {
                const taskDirectory = await mkdtemp(join(directory, "rejected-cpu-"));
                const inputs = [];
                for (const [index, input] of child.payload.inputs.entries()) {
                    const path = join(taskDirectory, `input-${index}`);
                    const source = await processing.readImageProcessingInput(child.id, input.assetId, { workerId, executionId: child.executionId });
                    await pipeline(source.stream, createWriteStream(path, { flags: "wx" }));
                    inputs.push({ ...input, path });
                }
                const outputDirectory = join(taskDirectory, "outputs");
                await mkdir(outputDirectory);
                const outcome = await runImageProcessing({ ...child.payload, jobId: child.id, executionId: child.executionId, inputs, outputDirectory }, { taskDirectory, maxHeapMiB: child.payload.resource.configuration.processHeapMb });
                expect(outcome.status).toBe("rejected");
                assert.ok(outcome.status === "rejected");
                await processing.failImageProcessingTask(child.id, { workerId, executionId: child.executionId, failure: outcome });
            } else await completeClaimedImageProcessingFixture(child, workerId, directory);
            await runImageEnhancementBatch({ origin: "http://fixture.local", workerId: "enhancement-fixture", limit: 50 });
            return batch;
        }
        const job = () => getEnhancementJob(id, task.userId);
        const due = () => mutateEnhancementJob(id, task.userId, (row) => ({ ...row, nextPollAt: Date.now() - 1 }));
        async function submitted() {
            await run();
            await due();
            await run();
        }
        async function createTask(
            targetSize = 64,
            nativeSize = 32,
            nativeUrl = "/api/generation-log-assets/native.png",
            nativeHeight = nativeSize,
            targetHeight = targetSize,
            customize: (value: ImageTask) => ImageTask | Promise<ImageTask> = (value) => value,
        ) {
            const conversation = await createCreativeConversation("enhancement-service-owner", { surface: "chat", title: "fixture" });
            const taskId = randomUUID();
            id = `enhancement:${taskId}:1`;
            const native = { url: nativeUrl, sha256: createHash("sha256").update(source).digest("hex"), width: nativeSize, height: nativeHeight, byteLength: source.length, format: "png", hasAlpha: false, provenance: "provider_native" as const };
            const media = { resultId: `${taskId}:1`, enhancementId: id, dataUrl: native.url, serverUrl: native.url, nativeSource: native, width: nativeSize, height: nativeHeight, bytes: source.length, mimeType: "image/png" };
            task = await createStoredGenerationTask(
                "image",
                await customize({
                    id: taskId,
                    userId: "enhancement-service-owner",
                    username: "fixture",
                    displayName: "fixture",
                    kind: "generation",
                    source: "image-workbench",
                    conversationId: conversation.id,
                    runId: "fixture-run",
                    status: "running",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    config: { baseUrl: "https://fixture.invalid", apiKey: "system", apiFormat: "openai", model: "fixture", quality: "4k", size: `${targetSize}x${targetHeight}` },
                    prompt: "fixture",
                    references: [],
                    enhancementPolicy: structuredClone(policy),
                    result: { ...media, results: [media] },
                } satisfies ImageTask),
                60_000,
            );
            await writeFixtureAsset(nativeUrl, source);
            task = (await transitionImageTask(task, ["running"], { status: "success", result: task.result }))!;
            await registerCreativeAssets([
                {
                    userId: task.userId,
                    conversationId: conversation.id,
                    sourceRunId: task.runId,
                    sourceTaskId: task.id,
                    ordinal: 0,
                    type: "image",
                    title: "native",
                    storageKind: "local",
                    serverUrl: task.result!.serverUrl,
                    width: task.result!.width,
                    height: task.result!.height,
                    mimeType: "image/png",
                    bytes: task.result!.bytes,
                },
            ]);
        }
        beforeEach(async () => {
            vi.restoreAllMocks();
            vi.resetModules();
            vi.resetAllMocks();
            directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-execution-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "8192");
            vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "6144");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
            ({ claimEnhancementJobs, getEnhancementJob, listEnhancementJobsForTask, mutateEnhancementJob } = await import("./database/image-enhancement-job-repository"));
            ({ readJsonDataFile, writeJsonDataFile } = await import("./data-adapter"));
            ({ createStoredGenerationTask, mutateStoredGenerationTask } = await import("./generation-task-store"));
            ({ getImageTask, transitionImageTask, updateImageTask } = await import("./image-task-store"));
            ({ cancelImageEnhancement, retryImageEnhancement, runImageEnhancementBatch } = await import("./image-enhancement-service"));
            ({ publicImageEnhancement } = await import("./image-enhancement-public"));
            ({ planImageTaskEnhancement } = await import("./image-enhancement-enqueue"));
            ({ compositeProductEnhancement } = await import("./image-enhancement-product-protection"));
            ({ buildSceneEditProtection, compositeSceneEdit } = await import("./ecommerce-product-regions"));
            ({ createCreativeConversation, getCreativeAssetsByIds, listCreativeAssets, registerCreativeAssets } = await import("./creative-runtime-store"));
            ({ initializePostgresSchema, postgresQuery } = await import("./database/postgres"));
            ({ prepareImageTaskResults } = await import("./image-task-result-service"));
            creativeRuntime = await import("./creative-runtime-store");
            logs = await import("./generation-log-repository");
            registry = await import("./local-media-registry");
            processing = await import("./image-processing-service");
            mocks.store.mockImplementation(logs.writeEnhancementArtifactFile);
            vi.spyOn(logs, "writeEnhancementArtifactFile").mockImplementation(mocks.store);
            cpuFailureExpected = false;
            if (provider === "postgres") {
                const target = new URL(process.env.DATABASE_URL || "");
                if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_m5_e2e")) throw new Error("An explicitly isolated M5 PostgreSQL fixture is required");
                await initializePostgresSchema();
                await postgresQuery("INSERT INTO users (id,username,display_name,password_hash) VALUES ('enhancement-service-owner','enhancement-service-owner','fixture','fixture-hash') ON CONFLICT (id) DO NOTHING");
            }
            source = await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } })
                .png()
                .toBuffer();
            ai = await sharp(source).resize(128, 128).png().toBuffer();
            await createTask();
            const native = task.result!.nativeSource!;
            plan = {
                protocolVersion: "image-enhancement.v1",
                scope: "full_image",
                target: { width: 64, height: 64, format: "png" },
                normalizationProfile: "srgb-upright-v1",
                engine: { modelId: "model-fixture", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, tile: 0, tta: false, gpuId: 0 },
                budgets: { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } },
                sourceSha256: native.sha256,
                source: native,
                strategyFingerprint: "d".repeat(64),
                planFingerprint: "e".repeat(64),
            };
            remote = { jobId: randomUUID(), status: "queued", reason: null, result: null, createdAt: Date.now(), completedAt: null };
            mocks.resolve.mockResolvedValue({ endpoint: "http://fixture.invalid", token: "fixture", serviceId: policy.connection!.serviceId, timeoutMs: 60_000, trust: "system", caPem: "" });
            mocks.prepare.mockResolvedValue(plan);
            mocks.submit.mockResolvedValue({ job: remote, replayed: false });
            mocks.query.mockImplementation(async () => remote);
            mocks.cancel.mockImplementation(async () => ({ ...remote, status: "cancelled", completedAt: Date.now() }));
            mocks.readSource.mockImplementation(async (reference: { dataUrl: string }) => {
                if (reference.dataUrl.startsWith("data:")) return reference.dataUrl;
                const bytes = await readFixtureAsset(reference.dataUrl);
                return `data:image/${reference.dataUrl.endsWith(".jpg") ? "jpeg" : "png"};base64,${bytes.toString("base64")}`;
            });
            mocks.download.mockImplementation(async (_plan, _remoteId, _result, destination: string) => {
                await writeFile(destination, ai);
            });
            mocks.acknowledge.mockResolvedValue(undefined);
            mocks.close.mockResolvedValue(undefined);
        });
        async function legacyRatioSkip(overrides: Partial<ImageEnhancementJob> = {}) {
            const current = (await job())!;
            const legacy: ImageEnhancementJob = {
                ...current,
                decision: { status: "skipped", reason: "aspect_ratio_mismatch", source: current.decision.source, target: current.decision.target },
                status: "skipped",
                phase: "completed",
                reason: "aspect_ratio_mismatch",
                nextPollAt: null,
                events: [{ stage: "skipped", reason: "aspect_ratio_mismatch", at: current.createdAt, attempt: 1 }],
                ...overrides,
            };
            if (provider === "postgres") await postgresQuery("UPDATE image_enhancement_jobs SET status=$2,phase=$3,next_poll_at=NULL,payload=$4::jsonb WHERE id=$1 AND user_id=$5", [id, legacy.status, legacy.phase, JSON.stringify(legacy), task.userId]);
            else {
                const rows = await readJsonDataFile<ImageEnhancementJob[]>("image-enhancement-jobs.json", []);
                await writeJsonDataFile(
                    "image-enhancement-jobs.json",
                    rows.map((row) => (row.id === id ? legacy : row)),
                );
            }
            return legacy;
        }
        it("resumes a legacy ratio skip once with the original native result and frozen model", async () => {
            const legacy = await legacyRatioSkip();
            expect(publicImageEnhancement(legacy).canRetry).toBe(true);
            const original = structuredClone(task);
            const outcomes = await Promise.all([retryImageEnhancement(id, task.userId), retryImageEnhancement(id, task.userId)]);
            expect(outcomes.filter(Boolean)).toHaveLength(1);
            expect(await job()).toMatchObject({
                id,
                status: "queued",
                phase: "prepare",
                attempt: 1,
                remoteKey: legacy.remoteKey,
                decision: { status: "queued", source: legacy.decision.source, target: legacy.decision.target, connection: policy.connection },
                events: [legacy.events[0], expect.objectContaining({ stage: "retry_requested" })],
            });
            await submitted();
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect((await getImageTask(task.id))?.result).toEqual(original.result);
            expect((await getImageTask(task.id))?.config).toEqual(original.config);
        });
        it("refuses signing a new delivery contract onto a legacy ratio skip during retry", async () => {
            const legacy = await legacyRatioSkip();
            const canvas = { mode: "ratio" as const, size: { width: 1, height: 1 }, source: "baseline" as const, allowReframe: true };
            const native = task.result!.nativeSource!;
            const media = {
                ...task.result!.results![0],
                canvasEvidence: { constraint: canvas, nativeSize: { width: native.width, height: native.height }, storedSize: { width: native.width, height: native.height }, nativeUrl: native.url, normalization: "none" as const },
            };
            task = (await mutateStoredGenerationTask<ImageTask>("image", task.id, 60_000, (current) => ({
                ...current,
                enhancementDelivery: { version: "ecommerce-delivery.v2", scope: "full_image", canvas },
                ecommerceExecution: {
                    state: "ready",
                    compilerVersion: "ecommerce-nano-banana-2.v1",
                    providerProfileId: "nano-banana-2",
                    prompt: "fixture",
                    parameters: { variant: "nano-banana-2" },
                    modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "openai" },
                    canvas,
                    protection: { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: true },
                    referenceRoles: [],
                },
                result: { ...media, results: [media] },
            })))!;
            expect(planImageTaskEnhancement(task, media)).toMatchObject({ status: "queued", delivery: { contract: task.enhancementDelivery } });
            expect(await retryImageEnhancement(id, task.userId)).toBeNull();
            expect(await job()).toEqual(legacy);
            expect(mocks.prepare).not.toHaveBeenCalled();
            expect(mocks.submit).not.toHaveBeenCalled();
        });
        it.each(["submitted", "prepared", "remote", "cancelled", "other_reason", "changed_native", "layers"])("refuses legacy ratio recovery after %s", async (condition) => {
            const overrides: Partial<ImageEnhancementJob> =
                condition === "submitted"
                    ? { submittedAt: Date.now() }
                    : condition === "prepared"
                      ? { remotePlan: plan }
                      : condition === "remote"
                        ? { remoteJobId: remote.jobId }
                        : condition === "cancelled"
                          ? { cancelRequested: true }
                          : condition === "other_reason"
                            ? { reason: "unsupported_target" }
                            : {};
            await legacyRatioSkip(overrides);
            if (condition === "changed_native") await updateImageTask(task.id, { result: { ...task.result!, results: [{ ...task.result!, nativeSource: { ...task.result!.nativeSource!, sha256: "f".repeat(64) } }] } });
            if (condition === "layers") await updateImageTask(task.id, { config: { ...task.config, outputMode: "layers" } });
            expect(await retryImageEnhancement(id, task.userId)).toBeNull();
            expect((await job())?.status).toBe("skipped");
            expect(mocks.submit).not.toHaveBeenCalled();
        });
        afterEach(async () => {
            vi.restoreAllMocks();
            if (provider === "postgres") {
                for (const table of ["local_media_assets", "image_enhancement_jobs", "generation_tasks", "creative_assets", "creative_conversations"]) await postgresQuery(`DELETE FROM ${table} WHERE user_id=$1`, ["enhancement-service-owner"]);
                await postgresQuery("DELETE FROM users WHERE id=$1", ["enhancement-service-owner"]);
            }
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        });
        it("prepares a persisted plan before POST and polls the accepted job without changing native success", async () => {
            await run();
            expect(await job()).toMatchObject({ status: "running", phase: "submit", remotePlan: plan });
            expect(mocks.submit).not.toHaveBeenCalled();
            await due();
            await run();
            expect(await job()).toMatchObject({ phase: "poll", remoteJobId: remote.jobId, remoteKey: `${id}:1`, leaseToken: null });
            expect(mocks.submit).toHaveBeenCalledWith(plan, source, `${id}:1`);
            await due();
            await run();
            expect(mocks.query).toHaveBeenCalledWith(plan, remote.jobId);
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect((await getImageTask(task.id))?.result).toEqual(task.result);
            expect((await getImageTask(task.id))?.status).toBe("success");
        });
        it.each(["pending", "changed"])("refuses a %s native source before preparing or submitting", async (condition) => {
            if (condition === "pending") await mutateStoredGenerationTask<ImageTask>("image", task.id, 60_000, (current) => ({ ...current, status: "running" }));
            else await updateImageTask(task.id, { result: { ...task.result!, results: [{ ...task.result!, resultId: task.result!.resultId, nativeSource: { ...task.result!.nativeSource!, sha256: "f".repeat(64) } }] } });
            await run();
            expect(await job()).toMatchObject({ status: "failed", reason: "native_identity_changed" });
            expect(mocks.prepare).not.toHaveBeenCalled();
            expect(mocks.submit).not.toHaveBeenCalled();
        });
        it.each(["prepare", "publish"] as const)("rejects an F14 failed native canvas at %s despite a decodable target-size enhancement candidate and retains qualified history", async (phase) => {
            const providerFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native rejection must not recreate image generation"));
            const historyTaskId = task.id;
            const historyResult = structuredClone(task.result);
            const [history] = await listCreativeAssets(task.conversationId!, task.userId);
            await cancelImageEnhancement(id, task.userId);
            await run();
            const taskId = randomUUID();
            id = `enhancement:${taskId}:1`;
            const native = { ...task.result!.nativeSource!, url: "/api/generation-log-assets/f14-native.png" };
            const candidate = { ...task.result!.results![0], resultId: `${taskId}:1`, enhancementId: id, dataUrl: native.url, serverUrl: native.url, nativeSource: native };
            task = await createStoredGenerationTask<ImageTask>("image", { ...task, id: taskId, status: "running", config: { ...task.config, size: "128x128" }, result: { ...candidate, results: [candidate] } }, 60_000);
            await writeFixtureAsset(native.url, source);
            task = (await transitionImageTask(task, ["running"], { status: "success", result: task.result }))!;
            expect(await listCreativeAssets(task.conversationId!, task.userId)).toEqual([history]);
            plan = { ...plan, source: native, sourceSha256: native.sha256, target: { width: 128, height: 128, format: "png" } };
            mocks.prepare.mockResolvedValue(plan);
            if (phase === "publish") await readyForPublication();
            const canvas = { mode: "exact" as const, size: { width: 128, height: 128 }, source: "user_text" as const, allowReframe: false };
            const canvasEvidence = { constraint: canvas, requestedSize: canvas.size, nativeSize: { width: 32, height: 32 }, storedSize: { width: 32, height: 32 }, nativeUrl: native.url, normalization: "none" as const };
            const geometryFailure: EcommerceResultTechnicalCheck["checks"][number] = {
                resultId: task.result!.resultId!,
                key: "canvas_geometry",
                status: "failed",
                source: "media",
                reason: "native=32x32;stored=32x32;constraint=exact:128x128;normalization=none",
            };
            const technicalCheck: EcommerceResultTechnicalCheck = {
                version: "ecommerce-technical.v1",
                status: "blocked",
                checks: [geometryFailure],
                hardFailures: [geometryFailure],
                sceneProtectionEvidence: [],
                checkedAt: Date.now(),
                canvasEvidence: [
                    {
                        resultId: task.result!.resultId!,
                        constraint: canvas,
                        nativeSize: canvasEvidence.nativeSize,
                        storedSize: canvasEvidence.storedSize,
                        nativeUrl: native.url,
                        storedUrl: native.url,
                        nativeStatus: "readable",
                        storedStatus: "readable",
                        nativeMatches: false,
                        storedMatches: false,
                        normalization: "none",
                        mappingVerified: false,
                        hardFailures: ["canvas_geometry"],
                    },
                ],
            };
            const ecommerceTrace: NonNullable<ImageTask["ecommerceTrace"]> = {
                version: "ecommerce-generation-trace.v1",
                runId: task.runId!,
                agentTaskId: "fixture-f14",
                imageTaskIds: [task.id],
                finalStatus: "needs_review",
                recordedAt: technicalCheck.checkedAt,
                stages: [
                    { key: "visual_analysis", status: "not_run", output: {} },
                    { key: "edit_planning", status: "completed", output: { canvas } },
                    { key: "image_generation", status: "needs_review", output: { technicalCheck } },
                    { key: "quality_check", status: "not_run", output: { policy: "disabled" } },
                ],
            };
            const media = { ...task.result!.results![0], canvasEvidence };
            const failedResult = { ...media, results: [media] };
            await updateImageTask(task.id, { result: failedResult, ecommerceTrace });
            const before = await getImageTask(task.id);
            expect(before?.ecommerceTrace).toHaveProperty("stages.2.output.technicalCheck.canvasEvidence.0.nativeMatches", false);
            expect(before?.result).toEqual(failedResult);
            mocks.download.mockImplementation(async (_plan, _remoteId, _result, destination: string) => {
                await writeFile(destination, ai);
            });
            expect(await sharp(ai).metadata()).toMatchObject({ format: "png", width: 128, height: 128 });
            expect((await sharp(ai).stats()).isOpaque).toBe(true);
            await run();
            const rejected = await job();
            const restored = await getImageTask(task.id);
            expect(restored?.result).toEqual(failedResult);
            expect(restored?.result?.canvasEvidence?.nativeUrl).toBe(native.url);
            expect(restored?.result?.results?.[0].nativeSource).toEqual(native);
            expect(restored?.ecommerceTrace).toEqual(ecommerceTrace);
            expect(restored?.ecommerceTrace).toHaveProperty("stages.2.output.technicalCheck.canvasEvidence.0.nativeMatches", false);
            expect(rejected).toMatchObject({ status: "failed", reason: expect.any(String) });
            expect(rejected).not.toHaveProperty("publication");
            expect(await listCreativeAssets(task.conversationId!, task.userId)).toEqual([history]);
            expect(await getCreativeAssetsByIds([history.id], task.userId)).toEqual([history]);
            expect(history).toMatchObject({ status: "ready", serverUrl: historyResult!.nativeSource!.url });
            const restoredHistory = await getImageTask(historyTaskId);
            expect(restoredHistory?.status).toBe("success");
            expect(restoredHistory?.result).toEqual(historyResult);
            expect(mocks.prepare).toHaveBeenCalledTimes(phase === "publish" ? 1 : 0);
            expect(mocks.submit).toHaveBeenCalledTimes(phase === "publish" ? 1 : 0);
            expect(mocks.query).toHaveBeenCalledTimes(phase === "publish" ? 1 : 0);
            expect(mocks.download).not.toHaveBeenCalled();
            expect(mocks.store).not.toHaveBeenCalled();
            expect(mocks.acknowledge).not.toHaveBeenCalled();
            expect(providerFetch).not.toHaveBeenCalled();
        });
        it("enhances a technically passed mapped native result with nativeMatches false while keeping blocked visual quality advisory", async () => {
            const providerFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Enhancement must not recreate image generation or visual review"));
            const [baseline] = await listCreativeAssets(task.conversationId!, task.userId);
            const protection = await buildSceneEditProtection(source, baseline.id, { x: 8, y: 8, width: 16, height: 16 }, ["fixture local edit"], "user_selection");
            const upstream = await sharp(source).resize(16, 16).png().toBuffer();
            const composite = await compositeSceneEdit(source, upstream, protection);
            expect(composite.evidence).toMatchObject({ normalization: "uniform_scale", nativeSize: { width: 16, height: 16 }, compositeOutsideChangedPixels: 0 });
            await writeFixtureAsset(baseline.serverUrl!, source);
            const nativeUrl = "/api/generation-log-assets/mapped-upstream.png";
            const maskUrl = "/api/generation-log-assets/mapped-mask.png";
            await writeFixtureAsset(nativeUrl, upstream);
            await writeFixtureAsset(maskUrl, Buffer.from(protection.mask.dataUrl.split(",")[1], "base64"));
            await cancelImageEnhancement(id, task.userId);
            await run();
            source = composite.bytes;
            await createTask(64, 32, "/api/generation-log-assets/mapped-composite.png");
            const native = task.result!.nativeSource!;
            plan = { ...plan, source: native, sourceSha256: native.sha256 };
            mocks.prepare.mockResolvedValue(plan);
            const canvas = { mode: "exact" as const, size: { width: 32, height: 32 }, source: "user_text" as const, allowReframe: false };
            const checks: EcommerceResultTechnicalCheck["checks"] = [
                { resultId: task.result!.resultId!, key: "canvas_geometry", status: "passed", source: "media", reason: "native=16x16;stored=32x32;constraint=exact:32x32;normalization=uniform_scale" },
                { resultId: task.result!.resultId!, key: "unmodified_region", status: "passed", source: "protection", reason: "Source pixels outside the edit region are unchanged" },
            ];
            const technicalCheck: EcommerceResultTechnicalCheck = {
                version: "ecommerce-technical.v1",
                status: "passed",
                checks,
                hardFailures: [],
                checkedAt: Date.now(),
                canvasEvidence: [
                    {
                        resultId: task.result!.resultId!,
                        constraint: canvas,
                        nativeSize: { width: 16, height: 16 },
                        storedSize: { width: 32, height: 32 },
                        nativeUrl,
                        storedUrl: native.url,
                        nativeStatus: "readable",
                        storedStatus: "readable",
                        nativeMatches: false,
                        storedMatches: true,
                        normalization: "uniform_scale",
                        mappingVerified: true,
                        hardFailures: [],
                    },
                ],
                sceneProtectionEvidence: [{ resultId: task.result!.resultId!, evidence: { ...composite.evidence, maskUrl, nativeUrl, compositeUrl: native.url } }],
            };
            const visualFailure: EcommerceResultTechnicalCheck["checks"][number] = { resultId: task.result!.resultId!, key: "product_identity", status: "failed", source: "vision", reason: "Fixture visual adjustment advice" };
            const ecommerceTrace: NonNullable<ImageTask["ecommerceTrace"]> = {
                version: "ecommerce-generation-trace.v1",
                runId: task.runId!,
                agentTaskId: "fixture-mapped",
                imageTaskIds: [task.id],
                finalStatus: "completed",
                recordedAt: technicalCheck.checkedAt,
                stages: [
                    { key: "visual_analysis", status: "not_run", output: {} },
                    { key: "edit_planning", status: "completed", output: { canvas } },
                    { key: "image_generation", status: "completed", output: { technicalCheck } },
                    {
                        key: "quality_check",
                        status: "blocked",
                        output: { policy: "advisory", version: "ecommerce-quality.v2", status: "blocked", publicStatus: "needs_review", checks: [visualFailure], hardFailures: [visualFailure], checkedAt: technicalCheck.checkedAt },
                    },
                ],
            };
            const media = {
                ...task.result!.results![0],
                canvasEvidence: { constraint: canvas, requestedSize: canvas.size, nativeSize: { width: 16, height: 16 }, storedSize: { width: 32, height: 32 }, nativeUrl, normalization: "uniform_scale" as const },
                sceneProtectionEvidence: technicalCheck.sceneProtectionEvidence[0].evidence,
            };
            const result = { ...media, results: [media] };
            await updateImageTask(task.id, { result, ecommerceTrace });
            const before = await getImageTask(task.id);
            expect(before?.ecommerceTrace).toHaveProperty("stages.2.output.technicalCheck.status", "passed");
            expect(before?.ecommerceTrace).toHaveProperty("stages.2.output.technicalCheck.canvasEvidence.0.nativeMatches", false);
            expect(before?.ecommerceTrace).toHaveProperty("stages.3.status", "blocked");
            await readyForPublication();
            await run();
            await due();
            await run();
            expect(await job()).toMatchObject({ status: "succeeded", phase: "completed", reason: null, publication: { delivered: { width: 64, height: 64 } } });
            expect(await listCreativeAssets(task.conversationId!, task.userId)).toHaveLength(2);
            expect((await getImageTask(task.id))?.result).toEqual(result);
            expect((await getImageTask(task.id))?.ecommerceTrace).toEqual(ecommerceTrace);
            expect(mocks.prepare).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.query).toHaveBeenCalledOnce();
            expect(mocks.download).toHaveBeenCalledOnce();
            expect(mocks.store).toHaveBeenCalledTimes(2);
            expect(mocks.acknowledge).toHaveBeenCalledOnce();
            expect(providerFetch).not.toHaveBeenCalled();
        });
        it("fails changed native bytes before POST and preserves the original source", async () => {
            await run();
            source = Buffer.from("changed-private-native");
            await writeFile(logs.localAssetUrlToPath(plan.source.url), source);
            await due();
            await run();
            expect(await job()).toMatchObject({ status: "failed", phase: "submit", reason: "input_digest_mismatch" });
            expect(mocks.submit).not.toHaveBeenCalled();
            expect((await getImageTask(task.id))?.status).toBe("success");
        });
        it("recovers a lost POST response with the same plan and key only after an explicit deduplicated retry", async () => {
            mocks.submit.mockRejectedValueOnce(new Error("private endpoint or token must not escape"));
            await submitted();
            const failed = await job();
            expect(failed).toMatchObject({ status: "failed", phase: "submit", reason: "enhancement_unavailable", remotePlan: plan });
            const outcomes = await Promise.all([retryImageEnhancement(id, task.userId), retryImageEnhancement(id, task.userId)]);
            expect(outcomes.filter(Boolean)).toHaveLength(1);
            await run();
            expect(await job()).toMatchObject({ phase: "poll", remoteJobId: remote.jobId, remoteKey: failed!.remoteKey, attempt: 1 });
            expect(mocks.submit.mock.calls.map((call) => call[2])).toEqual([failed!.remoteKey, failed!.remoteKey]);
            expect(mocks.prepare).toHaveBeenCalledOnce();
            expect(JSON.stringify(await job())).not.toContain("private endpoint");
        });
        it("keeps polling identity and does not recreate generation after a query failure", async () => {
            Object.assign(remote, { timings: { workerQueueMs: 25 } });
            await submitted();
            expect(await job()).toMatchObject({ attempt: 1, timings: { workerQueueMs: 25 } });
            mocks.query.mockRejectedValueOnce(new Error("private query details"));
            await due();
            await run();
            expect(await job()).toMatchObject({ status: "failed", phase: "poll", remoteJobId: remote.jobId });
            await retryImageEnhancement(id, task.userId);
            expect(await job()).toMatchObject({ attempt: 1, timings: { workerQueueMs: 25 } });
            await run();
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.query).toHaveBeenCalledTimes(2);
            expect((await getImageTask(task.id))?.result).toEqual(task.result);
        });
        it("starts a new inference attempt only after an explicitly failed remote job", async () => {
            await submitted();
            remote = { ...remote, status: "failed", reason: "engine_failed", completedAt: Date.now() };
            Object.assign(remote, { timings: { workerQueueMs: 25, workerExecutionMs: 900 } });
            await due();
            await run();
            expect(await job()).toMatchObject({ status: "failed", reason: "engine_failed", timings: { workerQueueMs: 25, workerExecutionMs: 900 } });
            await retryImageEnhancement(id, task.userId);
            expect(await job()).toMatchObject({ phase: "submit", attempt: 2, remoteKey: `${id}:2`, decision: { connection: policy.connection } });
            expect((await job())?.remoteJobId).toBeUndefined();
            expect(await job()).not.toHaveProperty("timings");
        });
        it("replaces current Worker timing facts after an internal attempt change and preserves delivery timing", async () => {
            Object.assign(remote, { status: "running", timings: { workerQueueMs: 0, workerExecutionMs: 900 } });
            await submitted();
            expect(await job()).toMatchObject({ attempt: 1, remoteJobId: remote.jobId, timings: { workerQueueMs: 0, workerExecutionMs: 900 } });
            await mutateEnhancementJob(id, task.userId, (row) => ({ ...row, timings: { ...row.timings, deliveryEncodingMs: 12.5 } }));
            mocks.query.mockRejectedValueOnce(new Error("fixture query response unavailable"));
            await due();
            await run();
            const unavailable = await job();
            expect(unavailable).toMatchObject({ status: "failed", phase: "poll", attempt: 1, remoteJobId: remote.jobId, timings: { workerQueueMs: 0, workerExecutionMs: 900, deliveryEncodingMs: 12.5 } });
            expect(publicImageEnhancement(unavailable!)).toHaveProperty("timings.workerExecutionMs", 900);
            remote = { ...remote, timings: { workerQueueMs: 0 } };
            await retryImageEnhancement(id, task.userId);
            await run();
            const current = await job();
            expect(current).toMatchObject({ status: "running", phase: "poll", attempt: 1, remoteJobId: remote.jobId });
            expect(current!.timings).toEqual({ workerQueueMs: 0, deliveryEncodingMs: 12.5 });
            expect(publicImageEnhancement(current!)).not.toHaveProperty("timings.workerExecutionMs");
            expect(publicImageEnhancement(current!)).toHaveProperty("timings.deliveryEncodingMs", 12.5);
            remote = { ...remote, timings: { workerQueueMs: 0, workerExecutionMs: 300 } };
            await due();
            await run();
            expect((await job())!.timings).toEqual({ workerQueueMs: 0, workerExecutionMs: 300, deliveryEncodingMs: 12.5 });
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.query).toHaveBeenCalledTimes(3);
        });
        it("cancels an unsubmitted job without contacting the Worker", async () => {
            await cancelImageEnhancement(id, task.userId);
            await run();
            expect(await job()).toMatchObject({ status: "cancelled", phase: "completed", nextPollAt: null });
            expect(mocks.prepare).not.toHaveBeenCalled();
            expect(mocks.submit).not.toHaveBeenCalled();
            expect((await getImageTask(task.id))?.status).toBe("success");
        });
        it("cancels an accepted job using the frozen connection and polls only that job", async () => {
            await submitted();
            await cancelImageEnhancement(id, task.userId);
            await due();
            await run();
            expect(mocks.cancel).toHaveBeenCalledWith(plan, remote.jobId);
            expect(await job()).toMatchObject({ status: "cancelled", phase: "completed" });
            expect(mocks.submit).toHaveBeenCalledOnce();
        });
        it.each(["known", "unacknowledged"] as const)("keeps explicit cancellation after native technical failure scoped to a %s remote identity", async (identity) => {
            const providerFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Cancellation must not recreate image generation"));
            const originalResult = structuredClone(task.result);
            const originalAssets = await listCreativeAssets(task.conversationId!, task.userId);
            if (identity === "unacknowledged") mocks.submit.mockRejectedValueOnce(new Error("Fixture POST response lost after submission"));
            await submitted();
            const accepted = (await job())!;
            expect(accepted).toMatchObject({ submittedAt: expect.any(Number), remotePlan: plan });
            expect(accepted.remoteJobId).toBe(identity === "known" ? remote.jobId : undefined);
            const canvas = { mode: "exact" as const, size: { width: 64, height: 64 }, source: "user_text" as const, allowReframe: false };
            const failure: EcommerceResultTechnicalCheck["checks"][number] = { resultId: task.result!.resultId!, key: "canvas_geometry", status: "failed", source: "media", reason: "native=32x32;stored=32x32;constraint=exact:64x64;normalization=none" };
            const technicalCheck: EcommerceResultTechnicalCheck = {
                version: "ecommerce-technical.v1",
                status: "blocked",
                checks: [failure],
                hardFailures: [failure],
                sceneProtectionEvidence: [],
                checkedAt: Date.now(),
                canvasEvidence: [
                    {
                        resultId: task.result!.resultId!,
                        constraint: canvas,
                        nativeSize: { width: 32, height: 32 },
                        storedSize: { width: 32, height: 32 },
                        nativeUrl: task.result!.nativeSource!.url,
                        storedUrl: task.result!.nativeSource!.url,
                        nativeStatus: "readable",
                        storedStatus: "readable",
                        nativeMatches: false,
                        storedMatches: false,
                        normalization: "none",
                        mappingVerified: false,
                        hardFailures: ["canvas_geometry"],
                    },
                ],
            };
            const ecommerceTrace: NonNullable<ImageTask["ecommerceTrace"]> = {
                version: "ecommerce-generation-trace.v1",
                runId: task.runId!,
                agentTaskId: "fixture-cancel-native-failure",
                imageTaskIds: [task.id],
                finalStatus: "needs_review",
                recordedAt: technicalCheck.checkedAt,
                stages: [
                    { key: "visual_analysis", status: "not_run", output: {} },
                    { key: "edit_planning", status: "completed", output: { canvas } },
                    { key: "image_generation", status: "needs_review", output: { technicalCheck } },
                    { key: "quality_check", status: "not_run", output: { policy: "disabled" } },
                ],
            };
            await updateImageTask(task.id, { ecommerceTrace });
            expect((await getImageTask(task.id))?.ecommerceTrace).toEqual(ecommerceTrace);
            expect(await cancelImageEnhancement(id, task.userId)).not.toBeNull();
            await due();
            await run();
            const cancelled = await job();
            const restored = await getImageTask(task.id);
            expect(restored?.status).toBe("success");
            expect(restored?.result).toEqual(originalResult);
            expect(restored?.ecommerceTrace).toEqual(ecommerceTrace);
            expect(restored?.ecommerceTrace).toHaveProperty("stages.2.output.technicalCheck.canvasEvidence.0.nativeMatches", false);
            expect(await listCreativeAssets(task.conversationId!, task.userId)).toEqual(originalAssets);
            expect(cancelled).toMatchObject({ cancelRequested: true, remotePlan: plan, remoteKey: accepted.remoteKey, submittedAt: accepted.submittedAt, attempt: accepted.attempt, nextPollAt: null });
            expect(cancelled).not.toHaveProperty("publication");
            if (identity === "known") {
                expect(cancelled).toMatchObject({ status: "cancelled", phase: "completed", remoteJobId: accepted.remoteJobId });
                expect(mocks.cancel).toHaveBeenCalledOnce();
                expect(mocks.cancel).toHaveBeenCalledWith(plan, accepted.remoteJobId);
            } else {
                expect(cancelled).toMatchObject({ status: "failed", phase: "submit", reason: "native_invalid" });
                expect(cancelled?.remoteJobId).toBeUndefined();
                expect(mocks.cancel).not.toHaveBeenCalled();
            }
            expect(mocks.resolve).toHaveBeenCalledTimes(identity === "known" ? 3 : 2);
            expect(mocks.resolve).toHaveBeenLastCalledWith(policy.connection);
            expect(mocks.prepare).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.query).not.toHaveBeenCalled();
            expect(mocks.download).not.toHaveBeenCalled();
            expect(mocks.store).not.toHaveBeenCalled();
            expect(mocks.acknowledge).not.toHaveBeenCalled();
            expect(providerFetch).not.toHaveBeenCalled();
        });
        it("deduplicates concurrent workers and denies actions by another owner", async () => {
            expect(await cancelImageEnhancement(id, "other-owner")).toBeNull();
            expect(await retryImageEnhancement(id, "other-owner")).toBeNull();
            const intent = await job();
            await Promise.all([run(), run()]);
            await run();
            expect(mocks.prepare).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledWith(plan, source, intent!.remoteKey);
            expect(await listEnhancementJobsForTask(task.id, task.userId)).toEqual([expect.objectContaining({ id, userId: task.userId, attempt: 1, remoteKey: intent!.remoteKey, receiptId: intent!.receiptId, remoteJobId: remote.jobId })]);
        });
        async function readyForPublication(aiSize = 128, aiHeight = aiSize) {
            await submitted();
            remote = { ...remote, status: "succeeded", completedAt: Date.now(), result: { width: aiSize, height: aiHeight, format: "png", byteLength: ai.length, sha256: createHash("sha256").update(ai).digest("hex") } };
            await due();
            await run();
            await due();
        }
        async function protectedTask(maskConflict = false) {
            await cancelImageEnhancement(id, task.userId);
            await run();
            const original = Buffer.from(source);
            source = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#17b060" } })
                .png()
                .toBuffer();
            ai = await sharp({ create: { width: 128, height: 128, channels: 3, background: "#2385e9" } })
                .png()
                .toBuffer();
            const maskPixels = Buffer.alloc(32 * 32 * 4, 255);
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) maskPixels[(y * 32 + x) * 4 + 3] = 0;
            const mask = await sharp(maskPixels, { raw: { width: 32, height: 32, channels: 4 } })
                .png()
                .toBuffer();
            const protection: ProductEnhancementProtection = {
                version: "product-enhancement.v2",
                normalization: "srgb-upright-v1",
                product: {
                    compilerVersion: "strict-product.v1",
                    state: "ready",
                    productAnchorId: "product-anchor-fixture",
                    sourceAssetId: "product-source-fixture",
                    sourceSize: { width: 32, height: 32 },
                    productCore: [{ x: 8, y: 8, width: 16, height: 16 }],
                    fusionHalo: [],
                    editableBackground: [],
                },
                maskDataUrl: `data:image/png;base64,${mask.toString("base64")}`,
                maskSha256: createHash("sha256").update(mask).digest("hex"),
            };
            const originalUrl = "/api/generation-log-assets/product-source.png";
            const nativeUrl = "/api/generation-log-assets/product-raw-native.png";
            const baselineUrl = "/api/generation-log-assets/product-qualified-base.png";
            const baseline = await compositeProductEnhancement(original, source, protection, plan.budgets.ai.maxPixels);
            if (maskConflict) {
                const pixels = Buffer.from(maskPixels);
                pixels[(16 * 32 + 16) * 4 + 3] = 0;
                const conflicting = await sharp(pixels, { raw: { width: 32, height: 32, channels: 4 } })
                    .png()
                    .toBuffer();
                protection.maskDataUrl = `data:image/png;base64,${conflicting.toString("base64")}`;
                protection.maskSha256 = createHash("sha256").update(conflicting).digest("hex");
                baseline.evidence.maskSha256 = protection.maskSha256;
            }
            const normalized = await sharp(original).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
            const contract: EcommerceEnhancementDelivery = {
                version: "ecommerce-delivery.v2",
                scope: "product_background",
                protection,
                baseline: { url: originalUrl, sha256: createHash("sha256").update(original).digest("hex"), byteLength: original.length, width: 32, height: 32, normalizedSha256: createHash("sha256").update(normalized).digest("hex") },
            };
            await writeFixtureAsset(originalUrl, original);
            await writeFixtureAsset(nativeUrl, source);
            await writeFixtureAsset(baselineUrl, baseline.bytes);
            await createTask(4096, 32, nativeUrl, 32, 4096, (value) => {
                const media = {
                    ...value.result!,
                    dataUrl: baselineUrl,
                    serverUrl: baselineUrl,
                    bytes: baseline.bytes.length,
                    productEnhancementEvidence: { version: "product-baseline.v2" as const, nativeUrl, nativeSha256: value.result!.nativeSource!.sha256, baselineUrl, baselineSha256: baseline.evidence.compositeSha256, composition: baseline.evidence },
                };
                return {
                    ...value,
                    kind: "edit",
                    enhancementDelivery: contract,
                    productProtection: structuredClone(protection.product),
                    mask: { dataUrl: protection.maskDataUrl },
                    references: [{ id: protection.product.sourceAssetId, dataUrl: originalUrl, serverUrl: originalUrl }],
                    result: { ...media, results: [media] },
                };
            });
            const native = task.result!.nativeSource!;
            plan = { ...plan, source: native, sourceSha256: native.sha256, target: { width: 128, height: 128, format: "png" } };
            mocks.prepare.mockResolvedValue(plan);
            mocks.download.mockImplementation(async (_plan, _remoteId, _result, destination: string) => {
                await writeFile(destination, ai);
            });
            mocks.prepare.mockClear();
            mocks.submit.mockClear();
            return { original, rawNative: source, originalUrl, nativeUrl, baselineUrl, baseline, mask, maskPixels, protection };
        }
        async function localTask() {
            await cancelImageEnhancement(id, task.userId);
            await run();
            const original = await sharp({ create: { width: 24, height: 32, channels: 3, background: "#ab6130" } })
                .jpeg()
                .withMetadata({ orientation: 6 })
                .toBuffer();
            const originalUrl = "/api/generation-log-assets/local-source.jpg";
            await writeFixtureAsset(originalUrl, original);
            source = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#17b060" } })
                .png()
                .toBuffer();
            ai = await sharp({ create: { width: 128, height: 96, channels: 3, background: "#2385e9" } })
                .png()
                .toBuffer();
            await createTask(4096, 16, "/api/generation-log-assets/local-raw.png", 12, 3072, async (value) => {
                const scene = await buildSceneEditProtection(original, "scene", { x: 2, y: 2, width: 8, height: 6 }, ["vase"], "user_selection");
                scene.confirmation = { actorUserId: value.userId, confirmedAt: 1 };
                value.kind = "edit";
                value.references = [{ id: "scene", dataUrl: originalUrl, ecommerceRole: "scene" }];
                value.sceneProtection = scene;
                value.mask = structuredClone(scene.mask);
                value.ecommerceExecution = {
                    state: "ready",
                    compilerVersion: "ecommerce-nano-banana-2.v1",
                    providerProfileId: "nano-banana-2",
                    prompt: "fixture",
                    parameters: { variant: "nano-banana-2" },
                    modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "openai" },
                    protection: { scope: "local", preserveOutsideMask: true, protectedObjectIds: [], allowLightingChange: false },
                    referenceRoles: [{ assetId: "scene", role: "scene" }],
                    canvas: { mode: "ratio", size: { width: 32, height: 24 }, source: "baseline", allowReframe: false },
                };
                const normalized = await sharp(original).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
                value.enhancementDelivery = {
                    version: "ecommerce-delivery.v2",
                    scope: "local_edit",
                    canvas: structuredClone(value.ecommerceExecution.canvas),
                    protection: { version: "scene-enhancement.v1", normalization: "srgb-upright-v1", scene: structuredClone(scene) },
                    baseline: { url: originalUrl, sha256: createHash("sha256").update(original).digest("hex"), byteLength: original.length, width: 32, height: 24, normalizedSha256: createHash("sha256").update(normalized).digest("hex") },
                } as unknown as EcommerceEnhancementDelivery;
                const prepared = await prepareImageTaskResults(value, { dataUrl: `data:image/png;base64,${source.toString("base64")}` }, "http://fixture.local", "fixture");
                // Exercise the retained protected contract; new generation_final publication has its own real HTTP regression.
                const { enhancementSource: _enhancementSource, ...legacy } = prepared.results[0];
                value.result = { ...legacy, results: [legacy] };
                return value;
            });
            const baselineUrl = task.result!.serverUrl!;
            const baseline = await readFixtureAsset(baselineUrl);
            const inference = { url: baselineUrl, sha256: createHash("sha256").update(baseline).digest("hex"), byteLength: baseline.length, width: 32, height: 24, format: "png", hasAlpha: false };
            plan = { ...plan, source: inference, sourceSha256: inference.sha256, target: { width: 128, height: 96, format: "png" } };
            mocks.prepare.mockResolvedValue(plan);
            mocks.download.mockImplementation(async (_plan, _remoteId, _result, destination: string) => {
                await writeFile(destination, ai);
            });
            mocks.prepare.mockClear();
            mocks.submit.mockClear();
            return { original, originalUrl, baselineUrl, baseline };
        }
        it("prepares a legal scaled local native, queues the qualified context, and publishes only allowed pixels", async () => {
            const fixture = await localTask();
            expect(task.result!.nativeSource).toMatchObject({ width: 16, height: 12, sha256: createHash("sha256").update(source).digest("hex") });
            expect(await job()).toMatchObject({
                status: "queued",
                decision: { source: { width: 16, height: 12 }, target: { width: 32, height: 24 }, inference: { width: 128, height: 96 }, delivery: { contract: { scope: "local_edit" }, baseline: { url: fixture.baselineUrl } } },
            });
            await readyForPublication(128, 96);
            await run();
            const published = (await job())!;
            expect(published).toMatchObject({
                status: "succeeded",
                publication: { delivered: { width: 32, height: 24 }, ai: { width: 128, height: 96 }, protection: { version: "scene-enhancement.v1", protectedChangedPixels: 0, allowedPixels: 48, protectedPixels: 720 } },
            });
            expect(mocks.readSource).toHaveBeenCalledWith({ dataUrl: fixture.baselineUrl }, "enhancement-native.png", "http://fixture.local", "fixture-worker-context", plan.budgets.input.maxBytes);
            const final = await readFixtureAsset(published.publication!.delivered.url);
            const pixels = await sharp(final).ensureAlpha().raw().toBuffer();
            const before = await sharp(fixture.baseline).ensureAlpha().raw().toBuffer();
            for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) if (x < 2 || x >= 10 || y < 2 || y >= 8) expect(pixels.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)).toEqual(before.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
            expect(publicImageEnhancement(published)).toMatchObject({ native: { url: fixture.baselineUrl }, providerNative: { width: 16, height: 12 }, delivery: { scope: "local_edit" } });
            expect(await readFixtureAsset(fixture.originalUrl)).toEqual(fixture.original);
        });
        it.each(["source", "baseline", "task_mask", "scene", "target"])("rejects changed local %s and retains the qualified original", async (variant) => {
            const fixture = await localTask();
            expect(await job()).toMatchObject({ status: "queued" });
            if (variant === "target") {
                ai = await sharp(ai).resize(124, 96).png().toBuffer();
                mocks.download.mockImplementation(async (_plan, _remoteId, _result, destination: string) => {
                    await writeFile(destination, ai);
                });
            }
            await readyForPublication(128, 96);
            if (variant === "source") await writeFixtureAsset(fixture.originalUrl, source);
            if (variant === "baseline") await writeFixtureAsset(fixture.baselineUrl, source);
            if (variant === "task_mask") await mutateStoredGenerationTask<ImageTask>("image", task.id, 60_000, (row) => ({ ...row, mask: { ...row.mask!, remoteUrl: "https://fixture.invalid/bypass.png" } }));
            if (variant === "scene") await mutateStoredGenerationTask<ImageTask>("image", task.id, 60_000, (row) => ({ ...row, sceneProtection: { ...row.sceneProtection!, targetRegion: { ...row.sceneProtection!.targetRegion, x: 0 } } }));
            await run();
            expect(await job()).toMatchObject({ status: "failed" });
            expect((await job())!.publication).toBeUndefined();
            expect((await getImageTask(task.id))?.status).toBe("success");
        });
        it.each(["publication_interrupted", "staged_final_replaced"] as const)("recovers local %s from saved full AI without another submit or download", async (interruption) => {
            const fixture = await localTask();
            const original = structuredClone(task.result);
            expect(await job()).toMatchObject({ status: "queued" });
            await readyForPublication(128, 96);
            const register = creativeRuntime.registerCreativeAssets;
            vi.spyOn(creativeRuntime, "registerCreativeAssets").mockImplementationOnce(async (inputs, executor, runtime) => {
                await register(inputs, executor, runtime);
                throw new Error("fixture local publication interrupted");
            });
            await run();
            const interrupted = (await job())!;
            expect(interrupted).toMatchObject({ status: "failed", phase: "publish", publicationProcessing: { outcome: { status: "completed" }, promotion: { aiStorageKey: expect.any(String), deliveredStorageKey: expect.any(String) } } });
            if (interruption === "staged_final_replaced") {
                const replacement = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#915bea" } })
                    .png()
                    .toBuffer();
                await writeFile(logs.localAssetUrlToPath("/api/generation-log-assets/" + interrupted.publicationProcessing!.promotion!.deliveredStorageKey), replacement);
            }
            await retryImageEnhancement(id, task.userId);
            await run();
            const recovered = (await job())!;
            if (interruption === "staged_final_replaced") {
                expect(recovered).toMatchObject({ status: "failed", reason: "output_storage_invalid" });
                expect(recovered.publication).toBeUndefined();
            } else {
                expect(recovered).toMatchObject({
                    status: "succeeded",
                    phase: "receipt",
                    publication: { ai: { sha256: remote.result!.sha256 }, delivered: { width: 32, height: 24 }, protection: { version: "scene-enhancement.v1", protectedChangedPixels: 0, allowedPixels: 48, protectedPixels: 720 } },
                });
                expect(recovered.events.filter((event) => event.stage === "protection_verified")).toHaveLength(1);
            }
            expect(await readFixtureAsset(fixture.baselineUrl)).toEqual(fixture.baseline);
            expect(await readFixtureAsset(fixture.originalUrl)).toEqual(fixture.original);
            expect((await getImageTask(task.id))?.status).toBe("success");
            expect((await getImageTask(task.id))?.result).toEqual(original);
            expect(mocks.prepare).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.download).toHaveBeenCalledOnce();
        });
        it("protects product background delivery from raw native through full AI and retains the qualified base parent and receipt", async () => {
            const fixture = await protectedTask();
            const originalTask = structuredClone(task);
            const [parent] = await listCreativeAssets(task.conversationId!, task.userId);
            expect(await job()).toMatchObject({ status: "queued", decision: { source: { url: fixture.nativeUrl }, target: { width: 32, height: 32 }, requestedTarget: { width: 4096, height: 4096 }, delivery: { baseline: { url: fixture.baselineUrl } } } });
            await readyForPublication();
            await run();
            const published = (await job())!;
            expect(published).toMatchObject({
                status: "succeeded",
                phase: "receipt",
                publication: {
                    ai: { width: 128, height: 128 },
                    delivered: { width: 32, height: 32 },
                    protection: { version: "product-enhancement.v2", sourceSha256: fixture.baseline.evidence.compositeSha256, aiSha256: remote.result!.sha256, protectedChangedPixels: 0, protectedPixels: 960, allowedPixels: 64 },
                },
            });
            const final = await readFixtureAsset(published.publication!.delivered.url);
            const [originalPixels, baselinePixels, nativePixels, finalPixels] = await Promise.all([fixture.original, fixture.baseline.bytes, fixture.rawNative, final].map((bytes) => sharp(bytes).ensureAlpha().raw().toBuffer()));
            for (let offset = 0; offset < finalPixels.length; offset += 4) {
                if (fixture.maskPixels[offset + 3] === 255) {
                    expect(baselinePixels.subarray(offset, offset + 4)).toEqual(originalPixels.subarray(offset, offset + 4));
                    expect(finalPixels.subarray(offset, offset + 4)).toEqual(baselinePixels.subarray(offset, offset + 4));
                }
            }
            expect(nativePixels.subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4)).not.toEqual(originalPixels.subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4));
            expect(finalPixels.subarray(0, 4)).not.toEqual(baselinePixels.subarray(0, 4));
            expect(published.publication!.ai.sha256).not.toBe(published.publication!.delivered.sha256);
            expect(await readFixtureAsset(published.publication!.ai.url)).toEqual(ai);
            expect(await readFixtureAsset(fixture.baselineUrl)).toEqual(fixture.baseline.bytes);
            const assets = await listCreativeAssets(task.conversationId!, task.userId);
            expect(assets).toHaveLength(2);
            expect(assets.find((asset) => asset.id === published.publication!.assetId)).toMatchObject({
                parentAssetId: parent.id,
                metadata: { nativeSha256: originalTask.result!.nativeSource!.sha256, deliveryVersion: "ecommerce-delivery.v2", scope: "product_background", protection: published.publication!.protection },
            });
            expect(JSON.stringify(assets)).not.toContain("maskDataUrl");
            expect(parent.serverUrl).toBe(fixture.baselineUrl);
            expect(publicImageEnhancement(published).native.url).toBe(fixture.baselineUrl);
            expect(published.events.filter((event) => event.stage === "protection_verified")).toHaveLength(1);
            await due();
            await run();
            expect(mocks.acknowledge).toHaveBeenCalledWith(plan, remote.jobId, published.receiptId, remote.result);
            expect((await getImageTask(task.id))?.result).toEqual(originalTask.result);
            expect((await getImageTask(task.id))?.status).toBe("success");
            expect(mocks.submit).toHaveBeenCalledOnce();
        });
        it.each(["contract", "anchor", "mask", "mask_url", "mask_server_url", "native_binding"] as const)("refuses changed product %s before preparing the Worker", async (condition) => {
            await protectedTask();
            if (condition === "contract")
                await mutateStoredGenerationTask<ImageTask>("image", task.id, 60_000, (current) => ({ ...current, enhancementDelivery: { ...current.enhancementDelivery!, version: "changed" } as unknown as EcommerceEnhancementDelivery }));
            if (condition === "anchor") await mutateStoredGenerationTask<ImageTask>("image", task.id, 60_000, (current) => ({ ...current, productProtection: { ...current.productProtection!, productAnchorId: "changed-anchor" } }));
            if (condition === "mask") await mutateStoredGenerationTask<ImageTask>("image", task.id, 60_000, (current) => ({ ...current, mask: { ...current.mask!, dataUrl: "data:image/png;base64,Y2hhbmdlZA==" } }));
            if (condition === "mask_url") await mutateStoredGenerationTask<ImageTask>("image", task.id, 60_000, (current) => ({ ...current, mask: { dataUrl: "/api/generation-log-assets/changed-mask.png" } }));
            if (condition === "mask_server_url") await mutateStoredGenerationTask<ImageTask>("image", task.id, 60_000, (current) => ({ ...current, mask: { ...current.mask!, serverUrl: "/api/generation-log-assets/changed-mask.png" } }));
            if (condition === "native_binding")
                await updateImageTask(task.id, { result: { ...task.result!, results: [{ ...task.result!.results![0], productEnhancementEvidence: { ...task.result!.productEnhancementEvidence!, nativeSha256: "f".repeat(64) } }] } });
            await run();
            expect(await job()).toMatchObject({ status: "failed", reason: "native_identity_changed" });
            expect(mocks.prepare).not.toHaveBeenCalled();
            expect(mocks.submit).not.toHaveBeenCalled();
            expect((await getImageTask(task.id))?.status).toBe("success");
        });
        it.each([
            { condition: "source", reason: "Enhancement owned input bytes or MIME differ from its frozen facts" },
            { condition: "native", reason: "Enhancement owned input bytes or MIME differ from its frozen facts" },
            { condition: "base", reason: "Enhancement owned input bytes or MIME differ from its frozen facts" },
            { condition: "mask_conflict", reason: "product_protection_rejected" },
            { condition: "candidate_dimensions", reason: "Enhancement owned input metadata changed" },
        ])("keeps the qualified product base available after $condition validation fails", async ({ condition, reason }) => {
            const fixture = await protectedTask(condition === "mask_conflict");
            cpuFailureExpected = condition === "mask_conflict";
            const original = structuredClone(task.result);
            if (condition === "candidate_dimensions") {
                ai = await sharp(ai).resize(128, 124).png().toBuffer();
                mocks.download.mockImplementation(async (_plan, _remoteId, _result, destination: string) => {
                    await writeFile(destination, ai);
                });
            }
            await readyForPublication();
            if (condition === "source") await writeFixtureAsset(fixture.originalUrl, fixture.rawNative);
            if (condition === "native") await writeFixtureAsset(fixture.nativeUrl, fixture.original);
            if (condition === "base") await writeFixtureAsset(fixture.baselineUrl, fixture.rawNative);
            await run();
            expect(await job()).toMatchObject({ status: "failed", reason });
            expect((await job())?.publication).toBeUndefined();
            expect((await job())!.events.some((event) => event.stage === "protection_verified")).toBe(false);
            expect((await getImageTask(task.id))?.status).toBe("success");
            expect((await getImageTask(task.id))?.result).toEqual(original);
            expect(await listCreativeAssets(task.conversationId!, task.userId)).toHaveLength(1);
            expect(mocks.acknowledge).not.toHaveBeenCalled();
            expect(mocks.submit).toHaveBeenCalledOnce();
        });
        it.each(["delivery_storage", "asset_publication", "staged_replacement", "staged_ai_replacement"] as const)("recovers protected publication from completed CPU output after %s without another inference or download", async (interruption) => {
            const fixture = await protectedTask();
            await readyForPublication();
            if (interruption === "delivery_storage") mocks.store.mockImplementationOnce(mocks.store.getMockImplementation()!).mockRejectedValueOnce(new Error("fixture delivery storage interrupted"));
            else {
                const register = creativeRuntime.registerCreativeAssets;
                vi.spyOn(creativeRuntime, "registerCreativeAssets").mockImplementationOnce(async (inputs, executor, runtime) => {
                    await register(inputs, executor, runtime);
                    throw new Error("fixture asset publication interrupted");
                });
            }
            await run();
            const interrupted = (await job())!;
            expect(interrupted).toMatchObject({ status: "failed", publicationProcessing: { outcome: { status: "completed" }, rawAi: { input: { expectedSha256: remote.result!.sha256 } } } });
            if (interruption === "staged_replacement" || interruption === "staged_ai_replacement") {
                const role = interruption === "staged_ai_replacement" ? "ai" : "delivered";
                const bytes = await sharp({ create: { width: role === "ai" ? 128 : 32, height: role === "ai" ? 128 : 32, channels: 3, background: "#915bea" } })
                    .png()
                    .toBuffer();
                const storageKey = role === "ai" ? interrupted.publicationProcessing!.promotion!.aiStorageKey : interrupted.publicationProcessing!.promotion!.deliveredStorageKey;
                await writeFile(logs.localAssetUrlToPath("/api/generation-log-assets/" + storageKey), bytes);
            }
            await retryImageEnhancement(id, task.userId);
            await run();
            const recovered = (await job())!;
            if (interruption === "staged_replacement" || interruption === "staged_ai_replacement") {
                expect(recovered).toMatchObject({ status: "failed", reason: "output_storage_invalid" });
                expect(recovered.publication).toBeUndefined();
                expect(await listCreativeAssets(task.conversationId!, task.userId)).toHaveLength(1);
            } else {
                const expected = await compositeProductEnhancement(fixture.baseline.bytes, ai, fixture.protection, plan.budgets.ai.maxPixels);
                expect(recovered).toMatchObject({ status: "succeeded", phase: "receipt", publication: { protection: expected.evidence } });
                expect(await readFixtureAsset(recovered.publication!.delivered.url)).toEqual(expected.bytes);
                expect(recovered.events.filter((event) => event.stage === "protection_verified")).toHaveLength(1);
                expect(await listCreativeAssets(task.conversationId!, task.userId)).toHaveLength(2);
            }
            expect(mocks.download).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.prepare).toHaveBeenCalledOnce();
            expect((await getImageTask(task.id))?.result).toEqual(task.result);
            expect((await getImageTask(task.id))?.status).toBe("success");
        });
        it("delivers the actual rounded aspect dimensions after native 4x without changing the original", async () => {
            await cancelImageEnhancement(id, task.userId);
            await run();
            source = await sharp({ create: { width: 32, height: 19, channels: 3, background: "#d2b48c" } })
                .png()
                .toBuffer();
            ai = await sharp(source).resize(128, 76).png().toBuffer();
            await createTask(64, 32, "/api/generation-log-assets/rounded-native.png", 19, 36);
            const original = structuredClone(task.result);
            const native = task.result!.nativeSource!;
            plan = { ...plan, target: { width: 128, height: 76, format: "png" }, source: native, sourceSha256: native.sha256 };
            mocks.prepare.mockResolvedValue(plan);
            mocks.download.mockImplementation(async (_plan, _remoteId, _result, destination: string) => {
                await writeFile(destination, ai);
            });
            await readyForPublication(128, 76);
            await run();
            const published = (await job())!;
            expect(published).toMatchObject({ status: "succeeded", phase: "receipt", decision: { target: { width: 64, height: 36 } }, publication: { ai: { width: 128, height: 76 }, delivered: { width: 61, height: 36 } } });
            expect(await sharp(await readFixtureAsset(published.publication!.delivered.url)).metadata()).toMatchObject({ width: 61, height: 36 });
            expect((await getImageTask(task.id))?.result).toEqual(original);
            expect(mocks.submit).toHaveBeenCalledOnce();
        });
        it("persists Worker facts and retains measured CPU delivery timing across receipt retries", async () => {
            Object.assign(remote, { timings: { workerQueueMs: 25, workerExecutionMs: 900 } });
            await readyForPublication();
            expect(await job()).toMatchObject({ attempt: 1, timings: { workerQueueMs: 25, workerExecutionMs: 900 } });
            expect(await job()).not.toHaveProperty("timings.deliveryEncodingMs");
            await run();
            expect(await job()).toMatchObject({ timings: { workerQueueMs: 25, workerExecutionMs: 900, deliveryEncodingMs: expect.any(Number) }, staged: { delivered: { width: 64, height: 64 } } });
            const published = await job();
            expect(published!.timings!.deliveryEncodingMs).toBeGreaterThanOrEqual(0);
            expect(await sharp(await readFixtureAsset(published!.publication!.delivered.url)).metadata()).toMatchObject({ format: "jpeg", width: 64, height: 64 });
            mocks.acknowledge.mockRejectedValueOnce(new Error("receipt response lost"));
            await due();
            await run();
            await due();
            await run();
            expect(await job()).toMatchObject({ status: "succeeded", phase: "completed", timings: { workerQueueMs: 25, workerExecutionMs: 900, deliveryEncodingMs: published!.timings!.deliveryEncodingMs } });
            expect(mocks.download).toHaveBeenCalledOnce();
            expect(mocks.store).toHaveBeenCalledTimes(2);
        });
        it("encodes a separate JPG even at native inference dimensions", async () => {
            await cancelImageEnhancement(id, task.userId);
            await run();
            await createTask(128);
            plan = { ...plan, target: { width: 128, height: 128, format: "png" } };
            mocks.prepare.mockResolvedValue(plan);
            await readyForPublication();
            await run();
            const published = await job();
            expect(published).toMatchObject({ status: "succeeded", phase: "receipt", publication: { ai: { width: 128, height: 128 }, delivered: { width: 128, height: 128 } } });
            expect(published!.publication!.delivered.url).not.toBe(published!.publication!.ai.url);
            expect(published!.publication!.delivered).toMatchObject({ format: "jpeg", url: expect.stringMatching(/\.jpg$/) });
            expect(published!.publication!.ai.format).toBe("png");
            expect(await sharp(await readFixtureAsset(published!.publication!.delivered.url)).metadata()).toMatchObject({ format: "jpeg", width: 128, height: 128 });
            expect(published!.timings!.deliveryEncodingMs).toBeGreaterThanOrEqual(0);
            expect(mocks.store).toHaveBeenCalledTimes(2);
        });
        it("retains delivered 4096-square provenance through repeat saves and references, skips default re-enhancement, and independently refuses a target above native 4x", async () => {
            const providerFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("This route must not recreate image generation"));
            await cancelImageEnhancement(id, task.userId);
            await run();
            source = await sharp(source).resize(1024, 1024).png().toBuffer();
            ai = await sharp(source).resize(4096, 4096).png().toBuffer();
            await createTask(4096, 1024);
            plan = {
                ...plan,
                source: task.result!.nativeSource!,
                sourceSha256: task.result!.nativeSource!.sha256,
                target: { width: 4096, height: 4096, format: "png" },
                budgets: { input: { ...plan.budgets.input, maxPixels: 1024 ** 2 }, ai: { ...plan.budgets.ai, maxPixels: 4096 ** 2 }, delivery: { ...plan.budgets.delivery, maxPixels: 4096 ** 2 } },
            };
            mocks.prepare.mockResolvedValue(plan);
            mocks.download.mockImplementation(async (_plan, _remoteId, _result, destination: string) => {
                await writeFile(destination, ai);
            });
            const [original] = await listCreativeAssets(task.conversationId!, task.userId);
            const frozenNative = structuredClone(task.result);
            await readyForPublication(4096);
            await run();
            await due();
            await run();
            const published = await job();
            expect(published).toMatchObject({ status: "succeeded", phase: "completed", publication: { delivered: { width: 4096, height: 4096 } } });
            const [enhanced] = await getCreativeAssetsByIds([published!.publication!.assetId!], task.userId);
            expect(enhanced).toMatchObject({ parentAssetId: original.id, status: "ready", width: 4096, height: 4096, metadata: { provenance: "ai_enhanced", sha256: published!.publication!.delivered.sha256 } });
            for (let refresh = 0; refresh < 2; refresh++) {
                const [saved] = await registerCreativeAssets([{ ...enhanced }]);
                const [reference] = await getCreativeAssetsByIds([saved.id], task.userId);
                expect(reference).toMatchObject({ id: enhanced.id, parentAssetId: original.id, status: "ready", serverUrl: enhanced.serverUrl, width: 4096, height: 4096, metadata: enhanced.metadata });
                const { provenance, sha256 } = reference.metadata;
                if (provenance !== "ai_enhanced" || typeof sha256 !== "string") throw new Error("Persisted enhancement provenance and digest are required");
                const referenceTaskId = randomUUID();
                const nativeSource: EnhancementSource = { url: reference.serverUrl!, sha256, width: reference.width!, height: reference.height!, byteLength: reference.bytes!, format: "jpeg", hasAlpha: false, provenance };
                const media = {
                    resultId: `${referenceTaskId}:1`,
                    enhancementId: `enhancement:${referenceTaskId}:1`,
                    dataUrl: nativeSource.url,
                    serverUrl: nativeSource.url,
                    nativeSource,
                    width: nativeSource.width,
                    height: nativeSource.height,
                    bytes: nativeSource.byteLength,
                    mimeType: reference.mimeType,
                };
                const repeated = await createStoredGenerationTask<ImageTask>("image", { ...task, id: referenceTaskId, status: "running", references: [{ id: reference.id, dataUrl: reference.serverUrl! }], result: { ...media, results: [media] } }, 60_000);
                await transitionImageTask(repeated, ["running"], { status: "success", result: repeated.result });
                expect(await listEnhancementJobsForTask(referenceTaskId, task.userId)).toEqual([
                    expect.objectContaining({ status: "skipped", phase: "completed", reason: "native_sufficient", nextPollAt: null, decision: expect.objectContaining({ source: nativeSource, target: { width: 4096, height: 4096 } }) }),
                ]);
                expect((await getImageTask(referenceTaskId))?.result).toEqual(repeated.result);
                expect(await run()).toMatchObject({ claimed: 0 });
            }
            const overScaleTaskId = randomUUID();
            const overScale = task.result!.nativeSource!.width * policy.connection!.model.nativeScale + 1;
            const media = { ...task.result!.results![0], resultId: `${overScaleTaskId}:1`, enhancementId: `enhancement:${overScaleTaskId}:1` };
            const overLimit = await createStoredGenerationTask<ImageTask>(
                "image",
                { ...task, id: overScaleTaskId, status: "running", config: { ...task.config, size: `${overScale}x${overScale}` }, references: [{ id: original.id, dataUrl: original.serverUrl! }], result: { ...media, results: [media] } },
                60_000,
            );
            await transitionImageTask(overLimit, ["running"], { status: "success", result: overLimit.result });
            expect(await listEnhancementJobsForTask(overScaleTaskId, task.userId)).toEqual([
                expect.objectContaining({ status: "skipped", phase: "completed", reason: "unsupported_target", nextPollAt: null, decision: expect.objectContaining({ source: task.result!.nativeSource, target: { width: overScale, height: overScale } }) }),
            ]);
            expect(await run()).toMatchObject({ claimed: 0 });
            expect((await getImageTask(overScaleTaskId))?.result).toEqual(overLimit.result);
            expect((await getImageTask(task.id))?.result).toEqual(frozenNative);
            const assets = await listCreativeAssets(task.conversationId!, task.userId);
            expect(assets).toHaveLength(2);
            expect(assets.find((asset) => asset.id === original.id)).toEqual(original);
            const [available] = await getCreativeAssetsByIds([enhanced.id], task.userId);
            expect(available).toMatchObject({ id: enhanced.id, serverUrl: enhanced.serverUrl, status: "ready", metadata: enhanced.metadata });
            const bytes = await readFixtureAsset(available.serverUrl!);
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(published!.publication!.delivered.sha256);
            expect(await sharp(bytes).metadata()).toMatchObject({ format: "jpeg", width: 4096, height: 4096 });
            expect(mocks.prepare).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.query).toHaveBeenCalledOnce();
            expect(mocks.download).toHaveBeenCalledOnce();
            expect(mocks.store).toHaveBeenCalledTimes(2);
            expect(mocks.acknowledge).toHaveBeenCalledOnce();
            expect(providerFetch).not.toHaveBeenCalled();
        });
        it("keeps the original available on storage failure and retries only the saved remote result", async () => {
            await readyForPublication();
            mocks.store.mockRejectedValueOnce(new Error("private storage error"));
            await run();
            expect(await job()).toMatchObject({ status: "failed", phase: "publish", publicationProcessing: { outcome: { status: "completed" } } });
            expect(await listCreativeAssets(task.conversationId!, task.userId)).toHaveLength(1);
            expect(mocks.acknowledge).not.toHaveBeenCalled();
            expect((await getImageTask(task.id))?.status).toBe("success");
            await retryImageEnhancement(id, task.userId);
            await run();
            expect(await job()).toMatchObject({ status: "succeeded", phase: "receipt" });
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.prepare).toHaveBeenCalledOnce();
        });
        it("keeps published success and retries the same receipt after its response is lost", async () => {
            await readyForPublication();
            await run();
            const published = await job();
            mocks.acknowledge.mockRejectedValueOnce(new Error("receipt response lost"));
            await due();
            await run();
            expect(await job()).toMatchObject({ status: "succeeded", phase: "receipt", publication: published!.publication });
            await due();
            await run();
            expect(mocks.acknowledge.mock.calls).toEqual([
                [plan, remote.jobId, published!.receiptId, remote.result],
                [plan, remote.jobId, published!.receiptId, remote.result],
            ]);
            expect(mocks.download).toHaveBeenCalledOnce();
            expect(mocks.store).toHaveBeenCalledTimes(2);
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(await listCreativeAssets(task.conversationId!, task.userId)).toHaveLength(2);
        });
        it("retains the saved full AI artifact after delivery storage fails and resumes without another download", async () => {
            await readyForPublication();
            const save = mocks.store.getMockImplementation()!;
            mocks.store.mockImplementationOnce(save).mockRejectedValueOnce(new Error("delivery storage failed"));
            await run();
            expect(await job()).toMatchObject({ status: "failed", publicationProcessing: { outcome: { status: "completed" }, rawAi: { input: { expectedSha256: remote.result!.sha256 } } } });
            expect(mocks.acknowledge).not.toHaveBeenCalled();
            await retryImageEnhancement(id, task.userId);
            await run();
            expect(await job()).toMatchObject({ status: "succeeded", phase: "receipt" });
            expect(mocks.store).toHaveBeenCalledTimes(4);
            expect(mocks.download).toHaveBeenCalledOnce();
        });
        it("refuses corrupted CPU artifact bytes before permanent publication or receipt", async () => {
            await readyForPublication();
            const save = mocks.store.getMockImplementation()!;
            mocks.store.mockImplementationOnce(async (sourcePath: string, ...args) => {
                await writeFile(sourcePath, Buffer.from("corrupt-storage"));
                return save(sourcePath, ...args);
            });
            await run();
            expect(await job()).toMatchObject({ status: "failed", reason: "output_storage_invalid" });
            expect(await listCreativeAssets(task.conversationId!, task.userId)).toHaveLength(1);
            expect(mocks.acknowledge).not.toHaveBeenCalled();
        });
        it.each([false, true])("recovers an existing staged PNG without re-encoding and rejects a false JPEG declaration=%s", async (falseJpeg) => {
            await readyForPublication();
            const bytes = await sharp(ai).resize(64, 64).png().toBuffer();
            const aiUrl = "/api/generation-log-assets/permanent/staged-ai.png";
            const deliveryUrl = "/api/generation-log-assets/permanent/staged-delivery.png";
            await writeFixtureAsset(aiUrl, ai);
            await writeFixtureAsset(deliveryUrl, bytes);
            await mutateEnhancementJob(id, task.userId, (row) => ({
                ...row,
                phase: "publish",
                staged: {
                    ai: { ...remote.result!, url: aiUrl },
                    delivered: { url: deliveryUrl, width: 64, height: 64, format: falseJpeg ? "jpeg" : "png", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
                },
            }));
            await run();
            if (falseJpeg) {
                expect(await job()).toMatchObject({ status: "failed", reason: "Enhancement owned input bytes or MIME differ from its frozen facts" });
                expect(await listCreativeAssets(task.conversationId!, task.userId)).toHaveLength(1);
            } else {
                expect(await job()).toMatchObject({ status: "succeeded", publication: { delivered: { url: deliveryUrl, format: "png" } } });
                expect(await readFixtureAsset(deliveryUrl)).toEqual(bytes);
            }
            expect(mocks.download).not.toHaveBeenCalled();
            expect(mocks.store).toHaveBeenCalledTimes(falseJpeg ? 0 : 2);
            if (!falseJpeg) expect((await job())!.timings?.deliveryEncodingMs).toBeUndefined();
            expect(mocks.acknowledge).not.toHaveBeenCalled();
            expect((await getImageTask(task.id))?.result).toEqual(task.result);
        });
        it("does not publish when cancellation arrives during artifact storage", async () => {
            await readyForPublication();
            const save = mocks.store.getMockImplementation()!;
            mocks.store.mockImplementationOnce(async (...args) => {
                const result = await save(...args);
                await cancelImageEnhancement(id, task.userId);
                return result;
            });
            await run();
            expect(await job()).toMatchObject({ status: "cancelled", phase: "completed" });
            expect(await listCreativeAssets(task.conversationId!, task.userId)).toHaveLength(1);
            expect(mocks.acknowledge).not.toHaveBeenCalled();
        });
        it("fences a late query response after another worker takes the expired lease", async () => {
            await submitted();
            let entered!: () => void;
            let release!: () => void;
            const pending = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const barrier = new Promise<void>((resolve) => {
                release = resolve;
            });
            mocks.query.mockImplementationOnce(async () => {
                entered();
                await barrier;
                return remote;
            });
            await due();
            const running = run();
            await pending;
            await mutateEnhancementJob(id, task.userId, (row) => ({ ...row, leaseUntil: Date.now() - 1, nextPollAt: Date.now() - 1 }));
            const [replacement] = await claimEnhancementJobs({ workerId: "replacement-worker", now: Date.now(), leaseMs: 90_000, limit: 1 });
            release();
            await running;
            expect(await job()).toMatchObject({ phase: "poll", workerId: "replacement-worker", leaseToken: replacement.leaseToken });
            expect(mocks.download).not.toHaveBeenCalled();
        });
        it("lets explicit cancellation recover a failed cancellation request without recreating inference", async () => {
            await submitted();
            await cancelImageEnhancement(id, task.userId);
            mocks.cancel.mockRejectedValueOnce(new Error("private cancel transport error"));
            await due();
            await run();
            expect(await job()).toMatchObject({ status: "failed", cancelRequested: true });
            expect(await cancelImageEnhancement(id, task.userId)).not.toBeNull();
            await run();
            expect(await job()).toMatchObject({ status: "cancelled", phase: "completed" });
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.cancel).toHaveBeenCalledTimes(2);
        });
        it("recovers an interrupted asset publication from one completed CPU result and stable permanent identities", async () => {
            await readyForPublication();
            const register = creativeRuntime.registerCreativeAssets;
            vi.spyOn(creativeRuntime, "registerCreativeAssets").mockImplementationOnce(async (inputs, executor, runtime) => {
                await register(inputs, executor, runtime);
                throw new Error("fixture interrupted asset registration");
            });
            await run();
            expect(await job()).toMatchObject({ status: "failed", phase: "publish", publicationProcessing: { outcome: { status: "completed" } } });
            const interrupted = (await job())!;
            const beforeRetry = await listCreativeAssets(task.conversationId!, task.userId);
            expect(beforeRetry).toHaveLength(1);
            expect(mocks.acknowledge).not.toHaveBeenCalled();
            await retryImageEnhancement(id, task.userId);
            await run();
            const published = await job();
            expect(published).toMatchObject({ status: "succeeded", phase: "receipt", timings: { deliveryEncodingMs: expect.any(Number) } });
            expect(published!.publicationProcessing).toEqual(interrupted.publicationProcessing);
            const afterRetry = await listCreativeAssets(task.conversationId!, task.userId);
            expect(afterRetry).toHaveLength(2);
            expect(afterRetry.find((asset) => asset.id === beforeRetry[0].id)).toEqual(beforeRetry[0]);
            expect(mocks.download).toHaveBeenCalledOnce();
            expect(mocks.store).toHaveBeenCalledTimes(4);
            expect(mocks.submit).toHaveBeenCalledOnce();
        });
    });
}
