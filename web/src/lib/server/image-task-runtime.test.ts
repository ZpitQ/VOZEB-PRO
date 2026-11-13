import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

const directory = await vi.hoisted(async () => {
    const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([import("node:fs/promises"), import("node:os"), import("node:path")]);
    const directory = await mkdtemp(join(tmpdir(), "vozeb-image-runtime-"));
    vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "8192");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
    // Layer admission reserves the maximum native source before CPU facts exist.
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "6144");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
    return directory;
});

const mocks = vi.hoisted(() => ({
    runCustom: vi.fn(),
    pollCustom: vi.fn(),
    runGemini: vi.fn(),
    runOpenAi: vi.fn(),
    pollOpenAi: vi.fn(),
    getTask: vi.fn(),
    getAgentRun: vi.fn(),
    updateTask: vi.fn(),
    transitionTask: vi.fn(),
    schedule: vi.fn(),
    writeLog: vi.fn(),
    inlineResult: vi.fn(),
    directResult: vi.fn(),
    resolveMedia: vi.fn(() => ({})),
    referenceDataUrl: vi.fn(),
    mediaHeaders: vi.fn(() => ({ "x-media-auth": "signed" })),
    normalizeAssets: vi.fn(),
    deleteAsset: vi.fn(),
    getSettings: vi.fn(),
    register: vi.fn(),
    refund: vi.fn(),
    nativeFetch: vi.fn(),
    logs: [] as Array<Record<string, unknown>>,
    QueryContractError: class extends Error {},
    UpstreamTerminalError: class extends Error {},
}));

vi.mock("@/app/api/image-tasks/image-task-custom", () => ({ runCustomImageTask: mocks.runCustom, pollCustomImageTask: mocks.pollCustom }));
vi.mock("@/app/api/image-tasks/image-task-gemini", () => ({ runGeminiImageTask: mocks.runGemini }));
vi.mock("@/app/api/image-tasks/image-task-openai", () => ({ runOpenAiImageTask: mocks.runOpenAi }));
vi.mock("@/app/api/image-tasks/image-task-support", () => ({
    directRemoteImageResult: mocks.directResult,
    imageReferenceToDataUrl: mocks.referenceDataUrl,
    imageUnits: vi.fn(() => 1),
    ImageQueryContractError: mocks.QueryContractError,
    ImageUpstreamTerminalError: mocks.UpstreamTerminalError,
    inlineRemoteImageResult: mocks.inlineResult,
    pollOpenAiImageTask: mocks.pollOpenAi,
    resolveProxiedMediaSource: mocks.resolveMedia,
    shouldUseJsonImageEdit: vi.fn(async () => false),
    openAiImageTaskPath: vi.fn(async () => "/images/edits"),
    resolveImageTaskEditProtocol: async (config: ImageTask["config"]) => (await import("./image-edit-protocol")).resolveImageEditProtocol(config),
}));
vi.mock("@/app/api/image-tasks/image-task-runner", () => ({ stableMediaUrl: vi.fn((value: string) => (value && !value.startsWith("data:") ? value : "")), writeImageGenerationLog: mocks.writeLog }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getSettings, refundUserPoints: mocks.refund }));
vi.mock("@/lib/server/creative-runtime-service", () => ({ registerGenerationTaskAssetsForUser: mocks.register }));
vi.mock("@/lib/server/generation-task-scheduler", async (original) => ({ ...(await original<typeof import("./generation-task-scheduler")>()), scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/generation-log-repository", async (original) => ({
    ...(await original<typeof import("./generation-log-repository")>()),
    normalizeAssets: mocks.normalizeAssets,
    deleteLocalAsset: mocks.deleteAsset,
    readGenerationLogDb: vi.fn(async () => ({ logs: mocks.logs })),
}));
vi.mock("@/lib/server/image-task-store", () => ({
    getImageTask: mocks.getTask,
    updateImageTask: mocks.updateTask,
    transitionImageTask: mocks.transitionTask,
}));
vi.mock("./agent-run-store", () => ({ getAgentRun: mocks.getAgentRun }));
vi.mock("@/lib/server/maintenance-auth", () => ({ maintenanceWorkerContext: vi.fn(() => "worker-context"), maintenanceWorkerContextHeaders: vi.fn(() => undefined) }));
vi.mock("@/lib/server/generation-media-authorization", () => ({ generationMediaProxyHeaders: mocks.mediaHeaders }));
vi.mock("@/lib/server/safe-outbound-fetch", async (original) => ({ ...(await original<typeof import("./safe-outbound-fetch")>()), fetchSafeOutbound: mocks.nativeFetch }));
vi.mock("@/lib/server/internal-origin", async (original) => ({ ...(await original<typeof import("./internal-origin")>()), fetchInternalApi: mocks.nativeFetch }));

import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError } from "./generation-submission-error";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import * as runtime from "./image-task-runtime";
import type { ImageTask } from "./image-task-store";
import { referenceAssetVersion } from "./ecommerce-reference-recovery";
import * as tasks from "./generation-task-store";
import { imageProcessingResourceConfig } from "../image-processing/resource-config";
import { completeClaimedImageProcessingFixture } from "./image-processing.test-fixture";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";

describe("image task runtime submission safety", () => {
    let state: ImageTask;
    let validImage: string;
    const workerId = "fixture-image-runtime";

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.logs = [];
        await tasks.withGenerationTaskFileMutation(async () => ({ tasks: [], result: undefined }));
        state = imageTask();
        validImage = dataUrl(
            await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } })
                .png()
                .toBuffer(),
        );
        mocks.nativeFetch.mockImplementation(async () => new Response(new Uint8Array(Buffer.from(validImage.split(",")[1], "base64")), { headers: { "content-type": "image/png" } }));
        const images = await vi.importActual<typeof import("./image-task-store")>("./image-task-store");
        const scheduler = await vi.importActual<typeof import("./generation-task-scheduler")>("./generation-task-scheduler");
        mocks.schedule.mockImplementation(scheduler.scheduleGenerationTask);
        mocks.getTask.mockImplementation(async (id: string) => {
            const current = await images.getImageTask(id);
            if (current) state = current;
            return current;
        });
        mocks.getAgentRun.mockReset().mockResolvedValue(null);
        mocks.updateTask.mockImplementation(async (id: string, patch: Partial<ImageTask>) => {
            state = (await images.updateImageTask(id, patch))!;
            return state;
        });
        mocks.transitionTask.mockImplementation(async (task: ImageTask, allowed: ImageTask["status"][], patch: Parameters<typeof images.transitionImageTask>[2]) => {
            const updated = await images.transitionImageTask(task, allowed, patch);
            if (updated) state = updated;
            return updated;
        });
        mocks.getSettings.mockResolvedValue({ generationPointMultipliers: { imageQuality: {} } });
        mocks.inlineResult.mockImplementation(async (dataUrl: string) => ({ dataUrl }));
        mocks.referenceDataUrl.mockImplementation(async (reference: { dataUrl: string }) => reference.dataUrl);
        mocks.normalizeAssets.mockImplementation(async (assets: Array<{ url: string; remoteUrl?: string }>) => {
            const source = assets[0];
            const name = source.url.includes("first") ? "first" : source.url.includes("second") ? "second" : `asset-${mocks.normalizeAssets.mock.calls.length}`;
            const serverUrl = `/api/generation-log-assets/${name}.png`;
            return [{ type: "image", url: serverUrl, serverUrl, remoteUrl: source.remoteUrl, mimeType: "image/png", width: 4, height: 4, bytes: 128 }];
        });
        mocks.deleteAsset.mockResolvedValue(undefined);
        mocks.register.mockResolvedValue(undefined);
        mocks.writeLog.mockImplementation(async (task: ImageTask, status: string, _results: unknown, _duration: number, error?: string) => {
            const log = { id: `image-task:${task.id}`, taskId: task.id, userId: task.userId, kind: "image", status, error, count: 1, successCount: status === "success" ? 1 : 0, failCount: status === "failed" ? 1 : 0, assets: [] };
            mocks.logs.push(log);
            return { log };
        });
    });

    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    async function storeCurrentImage() {
        await tasks.withGenerationTaskFileMutation(async (records) => {
            const existing = records.find((record) => record.type === "image" && record.id === state.id);
            const now = Date.now();
            const record = {
                ...existing,
                id: state.id,
                type: "image" as const,
                userId: state.userId,
                status: state.status,
                payload: state,
                createdAt: state.createdAt,
                updatedAt: state.updatedAt,
                expiresAt: now + 90_000,
                workerId,
                leaseUntil: now + 90_000,
                executionPhase: existing?.executionPhase || ("created" as const),
                nextPollAt: existing?.nextPollAt ?? now,
                upstreamTaskId: state.upstream?.id,
                conversationId: state.conversationId,
                runId: state.runId,
                attemptNo: state.attemptNo,
            };
            return { tasks: [...records.filter((item) => item !== existing), record], result: undefined };
        });
    }

    async function invoke<T>(operation: () => Promise<T>) {
        await storeCurrentImage();
        try {
            return await operation();
        } finally {
            state = (await tasks.getStoredGenerationTask<ImageTask>("image", state.id))!;
        }
    }

    const createImageTaskUpstreamStep = (...args: Parameters<typeof runtime.createImageTaskUpstreamStep>) => invoke(() => runtime.createImageTaskUpstreamStep(...args));
    const queryImageTaskUpstreamStep = (...args: Parameters<typeof runtime.queryImageTaskUpstreamStep>) => invoke(() => runtime.queryImageTaskUpstreamStep(...args));
    const markImageTaskFailed = (...args: Parameters<typeof runtime.markImageTaskFailed>) => invoke(() => runtime.markImageTaskFailed(...args));
    const prepareImageTaskAutomaticRetry = (...args: Parameters<typeof runtime.prepareImageTaskAutomaticRetry>) => invoke(() => runtime.prepareImageTaskAutomaticRetry(...args));
    const persistImageTaskResult = (...args: Parameters<typeof runtime.persistImageTaskResult>) => invoke(() => runtime.persistImageTaskResult(...args));

    async function persistAndCompleteImageTaskResult(resultUrl: string, failureCode?: string) {
        const waiting = await persistImageTaskResult(state, "http://internal", resultUrl);
        if (!waiting?.resultProcessing) return waiting;
        const processing = await import("./image-processing-service");
        const scheduler = await vi.importActual<typeof import("./generation-task-scheduler")>("./generation-task-scheduler");
        const configured = imageProcessingResourceConfig(process.env);
        const cpuId = "fixture-image-runtime-cpu";
        const claimed = await processing.claimImageProcessingTasks({ workerId: cpuId, profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const child = claimed.tasks[0];
        expect(child.id).toBe(waiting.resultProcessing.jobId);
        if (failureCode) {
            const taskDirectory = await mkdtemp(join(directory, "rejected-cpu-"));
            const identity = { workerId: cpuId, executionId: child.executionId };
            const inputs = await Promise.all(
                child.payload.inputs.map(async (input, index) => {
                    const path = join(taskDirectory, `input-${index}`);
                    await pipeline((await processing.readImageProcessingInput(child.id, input.assetId, identity)).stream, createWriteStream(path, { flags: "wx" }));
                    return { ...input, path };
                }),
            );
            const outputDirectory = join(taskDirectory, "outputs");
            await mkdir(outputDirectory);
            const failure = await runImageProcessing({ ...child.payload, jobId: child.id, executionId: child.executionId, inputs, outputDirectory }, { taskDirectory, maxHeapMiB: child.payload.resource.configuration.processHeapMb });
            expect(failure).toMatchObject({ status: "rejected", error: { code: failureCode } });
            if (failure.status !== "rejected") throw new Error("Expected CPU result rejection");
            await processing.failImageProcessingTask(child.id, { ...identity, failure });
        } else {
            await completeClaimedImageProcessingFixture(child, cpuId, directory);
            const [consumer] = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [state.id], limit: 1 });
            expect(consumer.executionId).not.toBe(waiting.executionId);
            const results = await import("./image-task-result-processing");
            expect(await results.consumeCompletedImageTaskResultProcessing({ taskId: state.id, workerId, executionId: consumer.executionId! })).toEqual({ state: "completed" });
        }
        state = (await tasks.getStoredGenerationTask<ImageTask>("image", state.id))!;
        return state;
    }

    it.each([false, true])("checks frozen original bytes before image submission and keeps verified input temporary (replaced: %s)", async (replaced) => {
        const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        const replacement = await sharp({ create: { width: 64, height: 48, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        state.runId = "frozen-run";
        state.conversationId = "frozen-conversation";
        state.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "openai" };
        state.references = [{ id: "product", dataUrl: "", url: "/api/reference-assets/product.png?width=120", ecommerceRole: "product" }];
        const persistedReferences = structuredClone(state.references);
        const asset = {
            id: "product",
            userId: state.userId,
            conversationId: state.conversationId,
            ordinal: 0,
            type: "image" as const,
            status: "ready" as const,
            serverUrl: "/api/reference-assets/product.png",
            title: "product",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const contentSha256 = createHash("sha256").update(source).digest("hex");
        state.referenceDispatch = { executionId: "original-worker", inputId: "frozen-input", decisionId: "frozen-decision", analysisRequestId: "frozen-analysis", copy: 1 };
        mocks.getAgentRun.mockResolvedValue({
            id: state.runId,
            userId: state.userId,
            conversationId: state.conversationId,
            ecommerceSnapshot: {
                referenceCheckpoint: {
                    version: "ecommerce-reference-checkpoint.v1",
                    inputId: "frozen-input",
                    decisionId: "frozen-decision",
                    state: "resolved",
                    analysisStage: { requestId: "frozen-analysis", state: "completed" },
                    assets: [{ asset, assetVersion: referenceAssetVersion(asset, contentSha256), contentSha256 }],
                    planningInput: { conversationId: state.conversationId, assetCandidates: [{ id: "product", type: "image", url: "/api/reference-assets/product.png?width=120" }] },
                },
            },
        });
        mocks.referenceDataUrl.mockResolvedValue(dataUrl(replaced ? replacement : source));
        mocks.runOpenAi.mockResolvedValue({ pending: { id: "same-upstream", pollBaseUrl: "http://fixture", mediaBaseUrl: "http://fixture" } });
        const result = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture", "session=test");
        if (replaced) {
            expect(result).toMatchObject({ state: "needs_review", status: "reference_source_changed" });
            expect(mocks.runOpenAi).not.toHaveBeenCalled();
            expect(mocks.schedule.mock.calls.some(([, , patch]) => patch.executionPhase === "submitting")).toBe(false);
        } else {
            expect(result.state).toBe("pending");
            const temporary = mocks.runOpenAi.mock.calls[0][0];
            expect(temporary.references).toEqual([{ ...persistedReferences[0], dataUrl: dataUrl(source), url: undefined, remoteUrl: undefined, serverUrl: undefined }]);
            expect(state.upstream?.id).toBe("same-upstream");
        }
        expect(mocks.referenceDataUrl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "product", url: "/api/reference-assets/product.png", dataUrl: "" }), "reference-1.png", "http://fixture", "session=test");
        expect(state.references).toEqual(persistedReferences);
        expect(mocks.updateTask.mock.calls.every(([, patch]) => patch.references === undefined)).toBe(true);
        if (replaced) expect(mocks.updateTask).not.toHaveBeenCalled();
    });

    it("streams frozen full-image originals before sub2api submission and keeps their URLs", async () => {
        const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        const changed = Buffer.from(source);
        changed[changed.length - 1] ^= 1;
        state.kind = "edit";
        state.runId = "frozen-full-image-run";
        state.conversationId = "frozen-conversation";
        state.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "sub2api" };
        state.references = [{ id: "product", dataUrl: "", url: "/api/reference-assets/product.png?width=120", ecommerceRole: "product" }];
        const persistedReferences = structuredClone(state.references);
        const asset = {
            id: "product",
            userId: state.userId,
            conversationId: state.conversationId,
            ordinal: 0,
            type: "image" as const,
            status: "ready" as const,
            serverUrl: "/api/reference-assets/product.png",
            title: "product",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const contentSha256 = createHash("sha256").update(source).digest("hex");
        state.referenceDispatch = { executionId: "original-worker", inputId: "frozen-input", decisionId: "frozen-decision", analysisRequestId: "frozen-analysis", copy: 1 };
        state.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-openai-image-2.5.v5",
            providerProfileId: "gpt-image-2.5-sunburst",
            prompt: state.prompt,
            referenceRoles: [{ assetId: "product", role: "product" }],
            canvas: { mode: "exact", size: { width: 32, height: 32 }, source: "explicit_size", allowReframe: true },
            protection: { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: false },
            parameters: { variant: "gpt-image-2.5-sunburst" },
            modelSnapshot: {
                logicalRole: "image_generation",
                capability: "image",
                logicalModelId: "image",
                channelId: "fixture",
                upstreamModel: "gpt-image-2.5-sunburst",
                apiFormat: "openai",
                imageEdit: { protocol: "sub2api", editPath: "/images/edits", transport: "json", supportsIndependentMask: true },
            },
        };
        mocks.getAgentRun.mockResolvedValue({
            id: state.runId,
            userId: state.userId,
            conversationId: state.conversationId,
            ecommerceSnapshot: {
                referenceCheckpoint: {
                    version: "ecommerce-reference-checkpoint.v1",
                    inputId: "frozen-input",
                    decisionId: "frozen-decision",
                    state: "resolved",
                    analysisStage: { requestId: "frozen-analysis", state: "completed" },
                    assets: [{ asset, assetVersion: referenceAssetVersion(asset, contentSha256), contentSha256 }],
                    planningInput: { conversationId: state.conversationId, assetCandidates: [{ id: "product", type: "image", url: "/api/reference-assets/product.png?width=120" }] },
                },
                processing: { prepareReferences: [{ assetId: "product", manifest: { sourceIdentities: [{ assetId: "product", sha256: contentSha256, bytes: source.length, width: 64, height: 48, mimeType: "image/png" }] } }] },
            },
        });
        mocks.referenceDataUrl.mockResolvedValue(dataUrl(source));
        mocks.nativeFetch.mockResolvedValueOnce(new Response(new Uint8Array(changed))).mockResolvedValueOnce(new Response(new Uint8Array(source)));
        mocks.runOpenAi.mockResolvedValue({ pending: { id: "same-upstream", pollBaseUrl: "http://fixture", mediaBaseUrl: "http://fixture" } });
        const rejected = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture", "session=test");
        expect(rejected).toMatchObject({ state: "needs_review", status: "reference_source_changed" });
        expect(mocks.runOpenAi).not.toHaveBeenCalled();
        const submitted = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture", "session=test");
        expect(submitted.state).toBe("pending");
        expect(mocks.runOpenAi).toHaveBeenCalledWith(
            expect.objectContaining({ references: [{ ...persistedReferences[0], url: "/api/reference-assets/product.png", remoteUrl: undefined, serverUrl: undefined }] }),
            "http://fixture",
            "http://fixture",
            "session=test",
            true,
        );
        expect(mocks.referenceDataUrl).not.toHaveBeenCalled();
        expect(state.references).toEqual(persistedReferences);
    });

    it.each(["source_read", "parent_database"] as const)("recovers the same unsubmitted image from %s without misclassifying the source or starting a provider attempt", async (failure) => {
        const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        state.runId = "frozen-run";
        state.conversationId = "frozen-conversation";
        state.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "openai" };
        state.references = [{ id: "product", dataUrl: "", url: "/api/reference-assets/product.png?width=120", ecommerceRole: "product" }];
        state.referenceDispatch = { executionId: "original-worker", inputId: "frozen-input", decisionId: "frozen-decision", analysisRequestId: "frozen-analysis", copy: 1 };
        const asset = {
            id: "product",
            userId: state.userId,
            conversationId: state.conversationId,
            ordinal: 0,
            type: "image" as const,
            status: "ready" as const,
            serverUrl: "/api/reference-assets/product.png",
            title: "product",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const contentSha256 = createHash("sha256").update(source).digest("hex");
        const parent = {
            id: state.runId,
            userId: state.userId,
            conversationId: state.conversationId,
            ecommerceSnapshot: {
                referenceCheckpoint: {
                    version: "ecommerce-reference-checkpoint.v1",
                    inputId: "frozen-input",
                    decisionId: "frozen-decision",
                    state: "resolved",
                    analysisStage: { requestId: "frozen-analysis", state: "completed" },
                    assets: [{ asset, assetVersion: referenceAssetVersion(asset, contentSha256), contentSha256 }],
                    planningInput: { conversationId: state.conversationId, assetCandidates: [{ id: "product", type: "image", url: "/api/reference-assets/product.png?width=120" }] },
                },
            },
        };
        const frozen = structuredClone(parent);
        const originalReferences = structuredClone(state.references);
        mocks.getAgentRun.mockResolvedValue(parent);
        mocks.referenceDataUrl.mockResolvedValue(dataUrl(source));
        if (failure === "parent_database") mocks.getAgentRun.mockRejectedValueOnce(new Error("database temporarily unavailable"));
        else mocks.referenceDataUrl.mockRejectedValueOnce(new Error("reference GET returned 503"));
        mocks.runOpenAi.mockResolvedValue({ pending: { id: "same-upstream", pollBaseUrl: "http://fixture", mediaBaseUrl: "http://fixture" } });
        const first = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture", "session=test");
        expect(first).toMatchObject({ state: "needs_review", status: failure === "source_read" ? "reference_source_unavailable" : "reference_validation_unavailable", reason: expect.stringContaining("检查状态") });
        expect(first).not.toMatchObject({ status: "reference_source_changed" });
        expect(mocks.runOpenAi).not.toHaveBeenCalled();
        expect(mocks.updateTask).not.toHaveBeenCalled();
        expect(mocks.schedule).not.toHaveBeenCalled();
        expect(state.attempts).toBeUndefined();
        expect(state.billing).toBeUndefined();
        expect(state.upstream).toBeUndefined();
        expect(parent).toEqual(frozen);
        const second = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture", "session=test");
        expect(second).toMatchObject({ state: "pending", upstream: { id: "same-upstream" } });
        expect(mocks.runOpenAi).toHaveBeenCalledOnce();
        expect(state.references).toEqual(originalReferences);
        expect(parent).toEqual(frozen);
        mocks.pollOpenAi.mockResolvedValue({ pending: { id: "same-upstream", pollBaseUrl: "http://fixture", mediaBaseUrl: "http://fixture" } });
        mocks.referenceDataUrl.mockRejectedValue(new Error("source unavailable after submission must not be read again"));
        const reads = mocks.referenceDataUrl.mock.calls.length;
        const queries = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture", "session=test");
        expect(queries.state).toBe("pending");
        expect(mocks.referenceDataUrl).toHaveBeenCalledTimes(reads);
        expect(mocks.runOpenAi).toHaveBeenCalledOnce();
        expect(mocks.pollOpenAi).toHaveBeenCalledWith(expect.anything(), "same-upstream", "http://fixture", "http://fixture", "session=test", "", true);
    });

    it.each(["valid", "sub2api", "exchanged_order", "invalid_mapping", "system_changed", "product_changed", "product_json"])("keeps v4 auxiliary references and validates the frozen local baseline (%s)", async (condition) => {
        const { buildSceneEditProtection } = await import("./ecommerce-protection.test-fixtures");
        const source = await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        state.kind = "edit";
        state.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: condition === "sub2api" ? "sub2api" : "openai" };
        state.references = [
            { id: "scene", dataUrl: dataUrl(source), ecommerceRole: "scene" },
            { id: "style", dataUrl: dataUrl(source), ecommerceRole: "scene" },
        ];
        state.sceneProtection = await buildSceneEditProtection(source, "scene", { x: 2, y: 1, width: 2, height: 2 }, ["vase"], "user_selection");
        state.mask = state.sceneProtection.mask;
        state.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-openai-image-2.5.v4",
            providerProfileId: "gpt-image-2.5-flare",
            prompt: "edit",
            referenceRoles: [
                { assetId: "scene", role: "scene" },
                { assetId: "style", role: "scene" },
            ],
            referenceMapping: [
                { assetId: "scene", userAlias: "图片2", providerIndex: 0, purposes: ["edit_target"] },
                { assetId: "style", userAlias: "图片1", providerIndex: condition === "invalid_mapping" ? 0 : 1, purposes: ["style"] },
            ],
            mask: { mode: "independent", required: true },
            protection: { scope: "local", protectedObjectIds: [], preserveOutsideMask: true, allowLightingChange: false },
            parameters: { variant: "gpt-image-2.5-flare" },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" },
        };
        if (condition === "product_json") {
            state.config.advancedConfig = { ...emptyAdvancedConfig(), referenceRule: "JSON images[].image_url" };
            state.sceneProtection = undefined;
            state.ecommerceExecution = undefined;
            state.productProtection = { sourceAssetId: "scene" } as ImageTask["productProtection"];
        }
        if (condition.endsWith("changed")) {
            state.config = { ...state.config, apiSource: "system", model: "gpt-image-2.5-flare", channelId: "fixture", logicalModel: "image", advancedConfig: { ...emptyAdvancedConfig(), protocol: "sub2api" } };
            mocks.getSettings.mockResolvedValue({
                defaultModels: { imageModel: "image" },
                logicalModels: [{ id: "image", name: "image", capability: "image", enabled: true, bindings: [{ id: "binding", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", enabled: true, priority: 1 }] }],
                systemChannels: [
                    { id: "fixture", name: "image", enabled: true, baseUrl: "https://image.example.com", apiKey: "fixture-key", apiFormat: "openai", models: ["gpt-image-2.5-flare"], advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } },
                ],
            });
            if (condition === "product_changed") {
                state.sceneProtection = undefined;
                state.productProtection = { sourceAssetId: "scene" } as ImageTask["productProtection"];
            }
        }
        if (condition === "exchanged_order") state.references.reverse();
        mocks.runOpenAi.mockResolvedValue({ pending: { id: "same-upstream", pollBaseUrl: "http://fixture", mediaBaseUrl: "http://fixture" } });
        const step = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture");
        expect(step.state).toBe(condition === "valid" || condition === "sub2api" ? "pending" : "needs_review");
        if (condition === "valid" || condition === "sub2api") expect(mocks.runOpenAi).toHaveBeenCalledWith(expect.objectContaining({ references: state.references, mask: state.mask }), expect.anything(), expect.anything(), expect.anything(), true);
        else expect(mocks.runOpenAi).not.toHaveBeenCalled();
    });

    it("keeps native ecommerce evidence when a success log returns replacement assets", async () => {
        const canvas = { mode: "exact" as const, size: { width: 3840, height: 2160 }, source: "user_text" as const, allowReframe: false };
        state.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            prompt: "preserve",
            canvas,
            parameters: { variant: "nano-banana-2", size: "3840x2160" },
            referenceRoles: [],
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "gemini" },
        };
        const media = {
            dataUrl: "/api/generation-log-assets/native.png",
            serverUrl: "/api/generation-log-assets/native.png",
            width: 2880,
            height: 2880,
            canvasEvidence: { constraint: canvas, requestedSize: canvas.size, nativeSize: { width: 2880, height: 2880 }, storedSize: { width: 2880, height: 2880 }, nativeUrl: "/api/generation-log-assets/native.png", normalization: "none" as const },
        };
        state.result = { ...media, results: [media] };
        mocks.writeLog.mockResolvedValueOnce({ assets: [{ url: "/api/generation-log-assets/cropped.png", serverUrl: "/api/generation-log-assets/cropped.png", width: 3840, height: 2160 }] });
        await persistImageTaskResult(state, "http://internal", media.serverUrl);
        expect(state.result?.results?.[0]).toEqual(media);
    });

    it("keeps immutable ordinary native variants and their enhancement identities after log normalization and repeat persistence", async () => {
        const media = [1, 2].map((index) => ({
            resultId: `${state.id}:${index}`,
            enhancementId: `enhancement:${state.id}:${index}`,
            dataUrl: `/api/generation-log-assets/native-${index}.png`,
            serverUrl: `/api/generation-log-assets/native-${index}.png`,
            width: 1254,
            height: 1254,
            bytes: 128,
            mimeType: "image/png",
            nativeSource: { url: `/api/generation-log-assets/native-${index}.png`, sha256: String(index).repeat(64), width: 1254, height: 1254, byteLength: 128, format: "png", hasAlpha: false, provenance: "provider_native" as const },
        }));
        state = { ...state, status: "running", result: { ...media[0], results: media } };
        mocks.writeLog.mockResolvedValueOnce({ assets: [{ url: "/api/generation-log-assets/log-preview.png", width: 4096, height: 4096 }] });

        await persistImageTaskResult(state, "http://internal", media[0].serverUrl);
        expect(state.result).toEqual({ ...media[0], results: media });
        expect(mocks.register).toHaveBeenCalledWith(
            state.userId,
            expect.objectContaining({
                assets: media.map((item) => ({ type: "image", url: item.serverUrl, width: 1254, height: 1254, bytes: 128, mimeType: "image/png", resultId: item.resultId, enhancementId: item.enhancementId, nativeSource: item.nativeSource })),
            }),
        );
        await persistImageTaskResult(state, "http://internal", media[0].serverUrl);
        expect(state.result).toEqual({ ...media[0], results: media });
        expect(mocks.writeLog).toHaveBeenCalledOnce();
        expect(mocks.normalizeAssets).not.toHaveBeenCalled();
    });

    it("retains skipped identity through log replacement and passes it to actual asset registration", async () => {
        const media = {
            resultId: `${state.id}:1`,
            dataUrl: "/api/generation-log-assets/skipped.png",
            serverUrl: "/api/generation-log-assets/skipped.png",
            width: 8,
            height: 8,
            enhancementSkip: { status: "skipped" as const, reason: "not_requested" as const },
        };
        state = { ...state, status: "running", result: { ...media, results: [media] } };
        mocks.writeLog.mockResolvedValueOnce({ assets: [{ url: "/api/generation-log-assets/logged.png", serverUrl: "/api/generation-log-assets/logged.png", width: 8, height: 8 }] });
        await persistImageTaskResult(state, "http://internal", media.serverUrl);
        expect(state.result).toMatchObject({ resultId: media.resultId, enhancementSkip: media.enhancementSkip, results: [{ resultId: media.resultId, enhancementSkip: media.enhancementSkip, serverUrl: "/api/generation-log-assets/logged.png" }] });
        expect(mocks.writeLog).toHaveBeenCalledWith(expect.anything(), "success", [media], expect.any(Number));
        expect(mocks.register).toHaveBeenCalledWith(state.userId, expect.objectContaining({ assets: [expect.objectContaining({ resultId: media.resultId, enhancementSkip: media.enhancementSkip })] }));
        expect(mocks.runOpenAi).not.toHaveBeenCalled();
        expect(mocks.runCustom).not.toHaveBeenCalled();
        expect(mocks.runGemini).not.toHaveBeenCalled();
    });

    it.each(["unreadable", "save_failed", "wrong_native", "all_unreadable"] as const)("durably recovers the same upstream canvas batch after %s without recreating or refunding", async (condition) => {
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            prompt: "preserve",
            referenceRoles: [],
            parameters: { variant: "nano-banana-2", size: "6x4" },
            canvas: { mode: "exact", size: { width: 6, height: 4 }, source: "user_text", allowReframe: false },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "channel-one", upstreamModel: "image-one", apiFormat: "openai" },
        };
        const good = dataUrl(
            await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
                .png()
                .toBuffer(),
        );
        const second = dataUrl(
            await sharp({ create: { width: condition === "wrong_native" ? 8 : 6, height: 4, channels: 3, background: "red" } })
                .png()
                .toBuffer(),
        );
        const unavailable = "https://fixture.invalid/unreadable.png";
        const inputs = [{ dataUrl: condition === "all_unreadable" ? unavailable : good }, { dataUrl: condition === "unreadable" || condition === "all_unreadable" ? unavailable : second }];
        mocks.writeLog.mockResolvedValue(undefined);
        mocks.normalizeAssets.mockImplementation(async ([asset]: Array<{ url: string }>) => {
            if (asset.url === second && (condition === "save_failed" || condition === "wrong_native")) throw new Error("private-storage-rejection");
            const size = await sharp(Buffer.from(asset.url.split(",")[1], "base64")).metadata();
            const serverUrl = `/api/generation-log-assets/slot-${mocks.normalizeAssets.mock.calls.length}.png`;
            return [{ type: "image", url: serverUrl, serverUrl, width: size.width, height: size.height }];
        });
        const upstream = { id: "original-upstream", mediaBaseUrl: "https://fixture.example/media", pollBaseUrl: "http://internal/api/ai/system/channel-one" };
        mocks.runOpenAi.mockResolvedValueOnce({ pending: upstream, pointsCost: 2, pointsRecordId: "original-charge" });
        expect(await createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).toMatchObject({ state: "pending", upstream });
        mocks.pollOpenAi.mockResolvedValueOnce({ dataUrl: inputs[0].dataUrl, results: inputs });
        const step = await queryImageTaskUpstreamStep(state, "http://internal");
        expect(state.result).toMatchObject({ batchEvidence: [expect.objectContaining({ resultId: "image-one:1", resultIndex: 1 }), expect.objectContaining({ resultId: "image-one:2", resultIndex: 2, storageStatus: "unavailable" })] });
        if (condition === "all_unreadable") expect(step).toEqual({ state: "completed" });
        else {
            expect(step.state).toBe("result_ready");
            if (step.state !== "result_ready") throw new Error("canvas batch not ready");
            await persistImageTaskResult(state, "http://internal", step.resultUrl);
        }
        const saved = JSON.parse(JSON.stringify(state));
        state = saved;
        expect(state).toMatchObject({ status: "success", upstream, billing: { pointsRecordId: "original-charge", refunded: false }, retryable: false });
        expect(state.result?.results).toHaveLength(condition === "all_unreadable" ? 0 : 1);
        expect(state.result?.batchEvidence).toHaveLength(2);
        if (condition === "wrong_native") expect(state.result?.batchEvidence?.[1].nativeSize).toEqual({ width: 8, height: 4 });
        await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        expect(state.result?.batchEvidence).toEqual(saved.result.batchEvidence);
        expect(mocks.runOpenAi).toHaveBeenCalledTimes(1);
        expect(mocks.pollOpenAi).toHaveBeenCalledTimes(1);
        expect(mocks.runCustom).not.toHaveBeenCalled();
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(mocks.refund).not.toHaveBeenCalled();
        expect(mocks.deleteAsset).not.toHaveBeenCalled();
        expect(JSON.stringify(state.result)).not.toContain("private-storage-rejection");
    });

    it("pauses a new canvas task when the actual adapter cannot express geometry", async () => {
        const canvas = { mode: "exact" as const, size: { width: 384, height: 216 }, source: "baseline" as const, allowReframe: false };
        state.config.apiFormat = "gemini";
        state.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "gemini" };
        state.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            prompt: "preserve",
            canvas,
            parameters: { variant: "nano-banana-2" },
            referenceRoles: [],
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "gemini" },
        };
        const snapshot = JSON.stringify(state.ecommerceExecution);
        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        expect(step).toMatchObject({ state: "needs_review", reason: expect.stringContaining("适配器尚不支持画布约束") });
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(mocks.runCustom).not.toHaveBeenCalled();
        expect(mocks.runOpenAi).not.toHaveBeenCalled();
        expect(JSON.stringify(state.ecommerceExecution)).toBe(snapshot);
    });

    it("does not resubmit after a safe request rejection", async () => {
        mocks.runCustom.mockRejectedValueOnce(new GenerationSubmissionSafeFailure("参数不受支持", 422));

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        expect(step).toMatchObject({ state: "failed", error: "参数不受支持" });
        expect(step).not.toHaveProperty("retryReason");
        expect(mocks.runCustom).toHaveBeenCalledTimes(1);
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(state.config.channelId).toBe("channel-one");
        expect(state.candidateConfigs).toHaveLength(1);
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed"]);
    });

    it("prepares exactly one new attempt after an explicit upstream generation failure", async () => {
        mocks.runCustom.mockRejectedValueOnce(new mocks.UpstreamTerminalError("上游生成失败"));

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        expect(step).toMatchObject({ state: "failed", error: "上游生成失败", retryReason: "upstream_failed" });

        await expect(prepareImageTaskAutomaticRetry(state, "上游生成失败")).resolves.toMatchObject({ config: { channelId: "channel-two" }, candidateConfigs: [], attemptNo: 1 });
        expect(state.attempts).toEqual([expect.objectContaining({ attemptNo: 1, status: "failed", error: "上游生成失败" })]);
        expect(state.upstream).toBeUndefined();

        mocks.runGemini.mockResolvedValueOnce({ dataUrl: "", pending: { id: "upstream-two", mediaBaseUrl: "https://two.example", pollBaseUrl: "https://two.example" } });
        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).resolves.toMatchObject({ state: "pending", upstream: { id: "upstream-two" } });
        expect(mocks.runGemini.mock.calls[0]?.[0]).toMatchObject({ attemptNo: 2, config: { channelId: "channel-two" } });
        expect(state.attempts).toEqual([expect.objectContaining({ attemptNo: 1, status: "failed" }), expect.objectContaining({ attemptNo: 2, status: "running" })]);

        await expect(prepareImageTaskAutomaticRetry(state, "再次失败")).resolves.toBeNull();
    });

    it("keeps the submitting phase unavailable until the configured image deadline", async () => {
        vi.spyOn(Date, "now").mockReturnValue(10_000);
        state.config = { ...state.config, capabilityProfile: { timeoutMs: 150_000 } };
        state.candidateConfigs = [];
        mocks.runCustom.mockResolvedValueOnce({ dataUrl: "", pending: { id: "upstream-one", mediaBaseUrl: "https://one.example", pollBaseUrl: "https://one.example" } });

        await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");

        expect(mocks.schedule).toHaveBeenNthCalledWith(1, "image", "image-one", expect.objectContaining({ executionPhase: "submitting", submittedAt: 10_000, nextPollAt: 160_000 }));
    });

    it("routes Yumeng image tasks through the declarative async runtime", async () => {
        state.config = { ...state.config, advancedConfig: { ...state.config.advancedConfig!, protocol: "yumeng", createPath: "/kyyReactApiServer/v2/model-center/tasks", queryPath: "/kyyReactApiServer/v2/model-center/tasks/:task_id" } };
        state.candidateConfigs = [];
        mocks.runCustom.mockResolvedValueOnce({ dataUrl: "", pending: { id: "yumeng-task", mediaBaseUrl: "https://zcbservice.aizfw.cn/kyyReactApiServer", pollBaseUrl: "https://zcbservice.aizfw.cn/kyyReactApiServer" } });

        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).resolves.toMatchObject({ state: "pending", upstream: { id: "yumeng-task" } });
        expect(mocks.runCustom).toHaveBeenCalledOnce();
        expect(mocks.runOpenAi).not.toHaveBeenCalled();
        expect(mocks.runGemini).not.toHaveBeenCalled();
    });

    it("routes a native Gemini custom image edit through the inlineData runtime", async () => {
        state.kind = "edit";
        state.references = [{ name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }];
        state.config = {
            ...state.config,
            apiFormat: "gemini",
            model: "gemini-3.1-flash-image",
            size: "16:9",
            quality: "high",
            advancedConfig: {
                ...emptyAdvancedConfig(),
                protocol: "custom",
                createPath: "/v1/models/gemini-3.1-flash-image:generateContent",
                editPath: "/v1/models/gemini-3.1-flash-image:generateContent",
                requestTemplate: '{"contents":[{"role":"user","parts":[{"text":"{{prompt}}"}]}],"size":"{{size}}"}',
                resultField: "candidates[0].content.parts[0].inlineData",
            },
        };
        state.candidateConfigs = [];
        mocks.runGemini.mockResolvedValueOnce({ dataUrl: validImage });

        await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");

        expect(mocks.runGemini).toHaveBeenCalledOnce();
        expect(mocks.runCustom).not.toHaveBeenCalled();
    });

    it("keeps declarative media resolution separate from system-proxy polling", async () => {
        state.config = { ...state.config, baseUrl: "/api/ai/system/channel-one", advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom", queryPath: "/jobs/:task_id" } };
        state.upstream = {
            id: "upstream-one",
            mediaBaseUrl: "https://provider.example/v1/images",
            pollBaseUrl: "http://internal/api/ai/system/channel-one/images",
        };
        const polled = structuredClone(state);
        mocks.pollCustom.mockResolvedValueOnce({ dataUrl: "", pending: state.upstream });

        await expect(queryImageTaskUpstreamStep(state, "http://internal")).resolves.toMatchObject({ state: "pending" });
        expect(mocks.pollCustom).toHaveBeenCalledWith(polled, "upstream-one", "https://provider.example/v1/images", "http://internal/api/ai/system/channel-one/images", "worker-context", true);
    });

    it("does not switch candidates when the submission outcome is unknown", async () => {
        mocks.runCustom.mockRejectedValueOnce(new Error("socket closed"));

        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).rejects.toBeInstanceOf(GenerationSubmissionUncertainError);
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(state.config.channelId).toBe("channel-one");
        expect(state.candidateConfigs).toHaveLength(1);
        expect(state.attempts?.map(({ status }) => status)).toEqual(["running"]);
    });

    it("keeps an OpenAI id-only response for manual review without trying another channel", async () => {
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        mocks.runOpenAi.mockResolvedValueOnce({
            dataUrl: "",
            needsReview: {
                upstream: { id: "upstream-one", mediaBaseUrl: "http://internal", pollBaseUrl: "http://internal" },
                reason: "OpenAI 图片接口未返回图片，且渠道没有声明异步查询路径",
            },
            pointsCost: 1,
            pointsRecordId: "record-one",
        });

        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).resolves.toMatchObject({ state: "needs_review", status: "query_contract_missing" });
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(state.upstream?.id).toBe("upstream-one");
        expect(state.billing).toMatchObject({ pointsRecordId: "record-one", refunded: false });
        expect(mocks.schedule).toHaveBeenLastCalledWith(
            "image",
            "image-one",
            expect.objectContaining({
                executionPhase: "needs_review",
                upstreamTaskId: "upstream-one",
                channelId: "channel-one",
                nextPollAt: undefined,
                resultPayload: { reviewReason: "OpenAI 图片接口未返回图片，且渠道没有声明异步查询路径" },
            }),
        );
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("does not refund when success wins the failure transition race", async () => {
        state = { ...imageTask(), status: "running", billing: { pointsCost: 2, pointsRecordId: "image-race", refunded: false } };
        mocks.transitionTask.mockImplementationOnce(async () => {
            state = { ...state, status: "success" };
            await storeCurrentImage();
            return null;
        });

        await expect(markImageTaskFailed(state, "late failure")).resolves.toMatchObject({ status: "success" });
        expect(mocks.refund).not.toHaveBeenCalled();
        expect(mocks.writeLog).not.toHaveBeenCalled();
    });

    it("commits the image error state before refunding", async () => {
        state = { ...imageTask(), status: "running", billing: { pointsCost: 2, pointsRecordId: "image-failed", refunded: false } };
        mocks.refund.mockImplementationOnce(async () => {
            expect(state.status).toBe("error");
            return undefined;
        });
        mocks.writeLog.mockResolvedValueOnce(undefined);

        await expect(markImageTaskFailed(state, "provider failed")).resolves.toMatchObject({ status: "error", billing: { refunded: true } });
        expect(mocks.refund).toHaveBeenCalledOnce();
    });

    it("publishes a CPU result only after its generation log is saved", async () => {
        state = { ...imageTask(), status: "running", result: { dataUrl: validImage } };
        mocks.writeLog.mockImplementationOnce(async () => {
            expect((await tasks.getStoredGenerationTask<ImageTask>("image", state.id))?.status).toBe("running");
            return { log: { id: `image-task:${state.id}` } };
        });

        await expect(persistAndCompleteImageTaskResult("inline://image-task-result")).resolves.toMatchObject({ status: "success" });
        expect(mocks.writeLog).toHaveBeenCalledOnce();
    });

    it("rejects a corrupt synchronous image in the CPU stage before publishing media", async () => {
        state = imageTask();
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.candidateConfigs = [];
        mocks.runOpenAi.mockResolvedValueOnce({ dataUrl: dataUrl(Buffer.from("corrupt PNG")), pointsCost: 1, pointsRecordId: "record-one" });

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        expect(step).toMatchObject({ state: "result_ready", status: "native_ready" });
        if (step.state !== "result_ready") throw new Error("Native result was not sealed");
        await expect(persistAndCompleteImageTaskResult(step.resultUrl, "invalid_result")).resolves.toMatchObject({ status: "error", billing: { refunded: true } });
        expect(mocks.schedule).not.toHaveBeenCalledWith("image", "image-one", expect.objectContaining({ executionPhase: "result_ready" }));
        expect(state.result).toBeUndefined();
        expect(mocks.register).not.toHaveBeenCalled();
        expect(mocks.runOpenAi).toHaveBeenCalledOnce();
    });

    it("stores only stable media references before scheduling a synchronous result", async () => {
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.candidateConfigs = [];
        mocks.runOpenAi.mockResolvedValueOnce({ dataUrl: validImage, pointsCost: 1, pointsRecordId: "record-one" });

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");

        expect(step).toMatchObject({ state: "result_ready", status: "native_ready", resultUrl: expect.stringContaining("/api/reference-assets/") });
        expect(state.nativeResults?.slots).toEqual([expect.objectContaining({ status: "stored", scope: "reference", resultId: "image-one:1" })]);
        expect(JSON.stringify(await tasks.getStoredGenerationTaskRecord("image", state.id))).not.toContain("data:image");
        expect(state.result).toBeUndefined();
    });

    it("resumes a prepared result without creating the upstream task again", async () => {
        const serverUrl = "/api/generation-log-assets/prepared.png";
        state = { ...imageTask(), status: "running", result: { dataUrl: serverUrl, serverUrl, results: [{ dataUrl: serverUrl, serverUrl }] } };

        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).resolves.toMatchObject({ state: "result_ready", resultUrl: serverUrl });

        expect(mocks.runCustom).not.toHaveBeenCalled();
        expect(mocks.runOpenAi).not.toHaveBeenCalled();
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(mocks.schedule).toHaveBeenLastCalledWith("image", "image-one", expect.objectContaining({ executionPhase: "result_ready", resultPayload: { url: serverUrl } }));
    });

    it.each(["async result", "prepared result"])("preserves the real file schedule submission identity when recovering %s", async (path) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(20_000);
        try {
            const scheduler = await vi.importActual<typeof import("./generation-task-scheduler")>("./generation-task-scheduler");
            const store = await import("./generation-task-store");
            mocks.schedule.mockImplementation(scheduler.scheduleGenerationTask);
            const serverUrl = "/api/generation-log-assets/prepared.png";
            state = {
                ...imageTask(),
                status: "running",
                createdAt: 20_000,
                updatedAt: 20_000,
                upstream: { id: "upstream-one", mediaBaseUrl: "https://provider.example/images", pollBaseUrl: "http://internal/api/ai/system/channel-one/images" },
                ...(path === "prepared result" ? { result: { dataUrl: serverUrl, serverUrl, results: [{ dataUrl: serverUrl, serverUrl }] } } : {}),
            };
            await store.createStoredGenerationTask("image", state, 60_000);
            await scheduler.scheduleGenerationTask("image", state.id, { executionPhase: "polling", upstreamTaskId: state.upstream!.id, channelId: state.config.channelId, queryPath: "/images/upstream-one", submittedAt: 10_000, nextPollAt: 15_000 });
            if (path === "async result") mocks.pollCustom.mockResolvedValueOnce({ dataUrl: validImage });
            const step = path === "async result" ? await queryImageTaskUpstreamStep(state, "http://internal") : await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
            expect(step.state).toBe("result_ready");
            if (step.state !== "result_ready") throw new Error("image result was not ready");
            expect(await store.getStoredGenerationTaskRecord("image", state.id)).toMatchObject({
                executionPhase: path === "async result" ? "polling" : "result_ready",
                upstreamTaskId: "upstream-one",
                channelId: "channel-one",
                queryPath: "/images/upstream-one",
                submittedAt: 10_000,
                nextPollAt: path === "async result" ? 15_000 : 20_000,
                ...(path === "prepared result" ? { resultPayload: { url: step.resultUrl } } : { payload: { nativeResults: { upstreamTaskId: "upstream-one" } } }),
            });
            expect(mocks.pollCustom).toHaveBeenCalledTimes(path === "async result" ? 1 : 0);
            expect(mocks.runCustom).not.toHaveBeenCalled();
            expect(mocks.runOpenAi).not.toHaveBeenCalled();
            expect(mocks.runGemini).not.toHaveBeenCalled();
        } finally {
            mocks.schedule.mockReset();
            clock.mockRestore();
        }
    });

    it("removes a newly prepared ecommerce canvas asset when cancellation wins the persistence race", async () => {
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.candidateConfigs = [];
        state.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            prompt: "preserve",
            referenceRoles: [],
            parameters: { variant: "nano-banana-2", size: "4x4" },
            canvas: { mode: "exact", size: { width: 4, height: 4 }, source: "user_text", allowReframe: false },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "channel-one", upstreamModel: "image-one", apiFormat: "openai" },
        };
        mocks.runOpenAi.mockResolvedValueOnce({ dataUrl: validImage, pointsCost: 1, pointsRecordId: "record-one" });
        mocks.normalizeAssets.mockImplementationOnce(async () => {
            state = { ...state, status: "cancelled" };
            await storeCurrentImage();
            const serverUrl = "/api/generation-log-assets/cancelled.png";
            return [{ type: "image", url: serverUrl, serverUrl, width: 4, height: 4 }];
        });

        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).resolves.toMatchObject({ state: "failed", status: "cancelled" });

        expect(mocks.deleteAsset).toHaveBeenCalledWith("/api/generation-log-assets/cancelled.png");
        expect(state.result).toBeUndefined();
    });

    it("downloads system-proxied image results with task-bound media authorization", async () => {
        state.config = { ...state.config, baseUrl: "/api/ai/system/channel-one", advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.candidateConfigs = [];
        const remoteUrl = "https://provider.example/media/result.png";
        const proxyUrl = `/api/ai/system/channel-one/_media?url=${encodeURIComponent(remoteUrl)}`;
        mocks.runOpenAi.mockResolvedValueOnce({ dataUrl: proxyUrl, remoteUrl });

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        if (step.state !== "result_ready") throw new Error("image result was not ready");
        await expect(persistAndCompleteImageTaskResult(step.resultUrl)).resolves.toMatchObject({ status: "success" });

        expect(mocks.mediaHeaders).toHaveBeenCalledWith({ userId: "user-one", taskType: "image", taskId: "image-one", channelId: "channel-one", upstreamModel: "image-one", url: remoteUrl });
        expect(mocks.nativeFetch).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(proxyUrl), expect.objectContaining({ headers: expect.any(Headers), cache: "no-store" }));
        expect((mocks.nativeFetch.mock.calls[0][1].headers as Headers).get("x-media-auth")).toBe("signed");
        expect(mocks.directResult).not.toHaveBeenCalled();
    });

    it("persists and registers every image returned by one upstream task", async () => {
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.candidateConfigs = [];
        mocks.runOpenAi.mockResolvedValueOnce({
            dataUrl: "https://provider.example/first.png",
            remoteUrl: "https://provider.example/first.png",
            results: [
                { dataUrl: "https://provider.example/first.png", remoteUrl: "https://provider.example/first.png" },
                { dataUrl: "https://provider.example/second.png", remoteUrl: "https://provider.example/second.png" },
            ],
        });

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        if (step.state !== "result_ready") throw new Error("image result was not ready");
        await persistAndCompleteImageTaskResult(step.resultUrl);

        expect(state.result?.results).toEqual([
            expect.objectContaining({ resultId: "image-one:1", dataUrl: expect.stringMatching(/^\/api\/reference-assets\//), width: 4, height: 4 }),
            expect.objectContaining({ resultId: "image-one:2", dataUrl: expect.stringMatching(/^\/api\/reference-assets\//), width: 4, height: 4 }),
        ]);
        expect(state.result!.results![0]).not.toHaveProperty("enhancementId");
        expect(state.result!.results![1]).not.toHaveProperty("enhancementId");
        expect(mocks.register).toHaveBeenCalledWith(
            "user-one",
            expect.objectContaining({
                assets: [expect.objectContaining({ type: "image", url: state.result!.results![0].dataUrl, width: 4, height: 4 }), expect.objectContaining({ type: "image", url: state.result!.results![1].dataUrl, width: 4, height: 4 })],
            }),
            expect.any(Object),
        );
        expect(mocks.nativeFetch.mock.calls.map(([url]) => url)).toEqual(["https://provider.example/first.png", "https://provider.example/second.png"]);
        expect(mocks.runOpenAi).toHaveBeenCalledOnce();
    });

    it("fails and refunds a charged transparent task when the provider returns an opaque image", async () => {
        const opaque = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ef4444" } })
            .png()
            .toBuffer();
        state = {
            ...imageTask(),
            status: "running",
            config: { ...imageTask().config, outputBackground: "transparent" },
            billing: { pointsCost: 3, pointsRecordId: "transparent-charge", refunded: false },
            result: { dataUrl: `data:image/png;base64,${opaque.toString("base64")}` },
        };
        await expect(persistAndCompleteImageTaskResult("inline://image-task-result", "invalid_transparent_result")).resolves.toMatchObject({ status: "error", billing: { refunded: true } });
        expect(mocks.refund).toHaveBeenCalledWith("user-one", "image-one", 3, "image", 1, expect.stringContaining("image-task:image-one"), "transparent-charge");
        expect(mocks.register).not.toHaveBeenCalled();
    });

    it("rejects a layer task when upstream returns only a composed image", async () => {
        const opaque = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ef4444" } })
            .png()
            .toBuffer();
        state = {
            ...imageTask(),
            status: "running",
            kind: "edit",
            config: { ...imageTask().config, outputMode: "layers" },
            billing: { pointsCost: 3, pointsRecordId: "layer-charge", refunded: false },
            references: [{ dataUrl: dataUrl(opaque) }],
            result: { dataUrl: dataUrl(opaque) },
        };

        await expect(persistAndCompleteImageTaskResult("inline://image-task-result", "invalid_layers")).resolves.toMatchObject({
            status: "error",
            error: "图像结果处理未能完成，请检查图片后重试。",
            billing: { refunded: true },
        });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", state.resultProcessing!.jobId)).toMatchObject({ resultPayload: { failure: { error: { code: "invalid_layers", message: expect.stringContaining("上游未返回完整分层") } } } });
        expect(mocks.register).not.toHaveBeenCalled();
    });

    it("accepts one upstream layer task containing transparent elements and a clean background", async () => {
        const { source, foreground, background } = await exactLayerFixture();
        state = {
            ...imageTask(),
            status: "running",
            kind: "edit",
            config: { ...imageTask().config, outputMode: "layers", quality: "4k" },
            references: [{ dataUrl: source }],
            enhancementPolicy: { revision: "frozen-enabled", enabled: true, connection: null },
            result: { dataUrl: foreground, results: [{ dataUrl: foreground }, { dataUrl: background }] },
        };
        await expect(persistAndCompleteImageTaskResult("inline://image-task-result")).resolves.toMatchObject({ status: "success", result: { results: expect.any(Array) } });
        expect(state.result?.results).toHaveLength(2);
        for (const result of state.result!.results!) {
            expect(result).toHaveProperty("enhancementSkip", { status: "skipped", reason: "unsupported_layers" });
            expect(result).not.toHaveProperty("nativeSource");
            expect(result).not.toHaveProperty("enhancementId");
        }
        expect(mocks.register).toHaveBeenCalledWith(
            state.userId,
            expect.objectContaining({ assets: [expect.objectContaining({ url: state.result!.results![0].dataUrl }), expect.objectContaining({ url: state.result!.results![1].dataUrl })] }),
            expect.any(Object),
        );
        expect(mocks.writeLog).toHaveBeenCalledOnce();
        expect(mocks.register).toHaveBeenCalledOnce();
    });

    it("rejects duplicate images in a layer task instead of dropping them", async () => {
        const { source, foreground, background } = await exactLayerFixture();
        state = {
            ...imageTask(),
            status: "running",
            kind: "edit",
            config: { ...imageTask().config, outputMode: "layers" },
            billing: { pointsCost: 3, pointsRecordId: "duplicate-layer-charge", refunded: false },
            references: [{ dataUrl: source }],
            result: { dataUrl: foreground, results: [{ dataUrl: foreground }, { dataUrl: foreground }, { dataUrl: background }] },
        };

        await expect(persistAndCompleteImageTaskResult("inline://image-task-result", "invalid_layers")).resolves.toMatchObject({
            status: "error",
            error: "图像结果处理未能完成，请检查图片后重试。",
            billing: { refunded: true },
        });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", state.resultProcessing!.jobId)).toMatchObject({ resultPayload: { failure: { error: { code: "invalid_layers", message: expect.stringContaining("重复像素") } } } });
        expect(mocks.register).not.toHaveBeenCalled();
    });
});

function dataUrl(bytes: Buffer) {
    return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function exactLayerFixture() {
    const foregroundBytes = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([
            {
                input: await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ef4444" } })
                    .png()
                    .toBuffer(),
                left: 1,
                top: 1,
            },
        ])
        .png()
        .toBuffer();
    const backgroundBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#dbeafe" } })
        .png()
        .toBuffer();
    const sourceBytes = await sharp(backgroundBytes)
        .composite([
            {
                input: await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ef4444" } })
                    .png()
                    .toBuffer(),
                left: 1,
                top: 1,
            },
        ])
        .png()
        .toBuffer();
    return { source: dataUrl(sourceBytes), foreground: dataUrl(foregroundBytes), background: dataUrl(backgroundBytes) };
}

function imageTask(): ImageTask {
    const second = { baseUrl: "https://two.example", apiKey: "two", apiFormat: "gemini" as const, model: "image-two", channelId: "channel-two" };
    return {
        id: "image-one",
        userId: "user-one",
        username: "user",
        displayName: "User",
        kind: "generation",
        source: "image-workbench",
        conversationId: "fixture-image-runtime-conversation",
        executionId: "fixture-image-runtime-execution",
        attemptNo: 1,
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
        config: {
            baseUrl: "https://one.example",
            apiKey: "one",
            apiFormat: "openai",
            model: "image-one",
            channelId: "channel-one",
            advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom", createPath: "/images", requestTemplate: "{}", resultField: "url" },
        },
        candidateConfigs: [second],
        prompt: "test",
        references: [],
    };
}
