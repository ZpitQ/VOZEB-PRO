import { buildSceneEditProtection } from "./ecommerce-protection.test-fixtures";
import assert from "node:assert/strict";
import { prepareAdvisoryReview, recoverAdvisoryReview } from "./ecommerce-visual-review.test-fixture";
import { completeClaimedImageProcessingFixture, completeImageTaskResultFixture, readImageTaskResultBytesFixture } from "./image-processing.test-fixture";
import { imageProcessingResourceConfig } from "../image-processing/resource-config";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSettings } from "@/lib/auth/store";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { AgentRunTask } from "./agent-run-store";
import type { ImageTask } from "./image-task-store";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { routeEcommerceRole } from "./ecommerce-model-routing";
import { toSystemGenerationChannel } from "./generation-channel";

const textPlanningActual = vi.hoisted((): { module?: typeof import("./text-planning-runtime") } => ({}));
const boundary = vi.hoisted(() => ({ request: vi.fn(), outbound: vi.fn(), create: vi.fn(), submit: vi.fn(), poll: vi.fn(), structured: vi.fn(), refund: vi.fn(), settings: {} as AuthSettings }));
type OriginalReadStream = typeof import("node:fs").createReadStream;
const finalRead = vi.hoisted(() => ({ path: "", armed: false, failures: 0 }));
vi.mock("node:fs", async (original) => {
    const actual = await original<typeof import("node:fs")>();
    return {
        ...actual,
        createReadStream: (...args: Parameters<OriginalReadStream>) => {
            const stream = actual.createReadStream(...args);
            if (finalRead.armed && args[0] === finalRead.path) {
                finalRead.failures += 1;
                stream.once("open", () => stream.destroy(Object.assign(new Error("private-final-read-unavailable"), { code: "EIO" })));
            }
            return stream;
        },
    };
});
vi.mock("./database", async (original) => ({ ...(await original<typeof import("./database")>()), getDatabaseProvider: () => "file" }));
vi.mock("@/lib/auth/store", async (original) => ({ ...(await original<typeof import("@/lib/auth/store")>()), getAuthSettings: async () => boundary.settings, refundUserPoints: boundary.refund }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => ({ id: "batch-user", role: "user" }) }));
vi.mock("./internal-origin", async (original) => ({ ...(await original<typeof import("./internal-origin")>()), fetchInternalApi: boundary.request }));
vi.mock("./safe-outbound-fetch", () => ({ fetchSafeOutbound: boundary.outbound }));
vi.mock("@/app/api/image-tasks/image-task-openai", () => ({ runOpenAiImageTask: boundary.create }));
vi.mock("@/app/api/image-tasks/image-task-support", async (original) => ({
    ...(await original<typeof import("@/app/api/image-tasks/image-task-support")>()),
    imageSubmissionFetch: boundary.submit,
    pollOpenAiImageTask: boundary.poll,
    inlineRemoteImageResult: async (dataUrl: string, _origin: string, _auth: string, remoteUrl?: string) => (dataUrl.startsWith("data:image/") ? { dataUrl, remoteUrl } : null),
}));
vi.mock("./text-planning-runtime", async (original) => {
    const actual = await original<typeof import("./text-planning-runtime")>();
    textPlanningActual.module = actual;
    return { ...actual, requestStructuredText: boundary.structured };
});
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));

import { imageTask, settings } from "./agent-run-executor.test-fixtures";

describe("agent canvas batch evidence through real file/runtime/QA services", { timeout: 120_000 }, () => {
    let directory: string;
    let childIds: string[];
    let nativeResults: Array<{ dataUrl: string; remoteUrl?: string }>;
    let childBeforeQuality: ImageTask | undefined;
    let baseline: string;
    let getPublicImageTask: typeof import("@/app/api/image-tasks/[id]/route").GET;
    let recoverPublicImageTask: typeof import("@/app/api/image-tasks/[id]/route").POST;
    let runTaskWithRetry: typeof import("./agent-run-execution").runTaskWithRetry;
    let executeTasks: typeof import("./agent-run-execution").executeTasks;
    let createAgentRun: typeof import("./agent-run-store").createAgentRun;
    let getAgentRun: typeof import("./agent-run-store").getAgentRun;
    let updateAgentRunById: typeof import("./agent-run-store").updateAgentRunById;
    let publicAgentRun: typeof import("./agent-run-public").publicAgentRun;
    let publicAgentRunEvent: typeof import("./agent-run-public").publicAgentRunEvent;
    let createCreativeConversation: typeof import("./creative-runtime-store").createCreativeConversation;
    let listCreativeRunEvents: typeof import("./creative-runtime-store").listCreativeRunEvents;
    let listCreativeMessages: typeof import("./creative-runtime-store").listCreativeMessages;
    let schedulePreparedImageTask: typeof import("./ecommerce-image-task-orchestration").schedulePreparedImageTask;
    let getStoredGenerationTaskRecord: typeof import("./generation-task-store").getStoredGenerationTaskRecord;
    let createImageTask: typeof import("./image-task-store").createImageTask;
    let getImageTask: typeof import("./image-task-store").getImageTask;
    let createImageTaskUpstreamStep: typeof import("./image-task-runtime").createImageTaskUpstreamStep;
    let persistImageTaskResult: typeof import("./image-task-runtime").persistImageTaskResult;
    let queryImageTaskUpstreamStep: typeof import("./image-task-runtime").queryImageTaskUpstreamStep;
    let localAssetUrlToPath: typeof import("./generation-log-repository").localAssetUrlToPath;
    let listGenerationLogs: typeof import("./generation-log-store").listGenerationLogs;
    let ECOMMERCE_QUALITY_CHECK_KEYS: typeof import("./ecommerce-quality-check").ECOMMERCE_QUALITY_CHECK_KEYS;
    const structure = [{ objectId: "cabinet", feature: "drawers" as const, count: 3, certainty: "confirmed" as const, evidenceRegion: { x: 0, y: 0, width: 120, height: 160 } }];
    const observation = { readable: true, logo: "absent", packagingText: "absent", visibleStructure: structure };

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-agent-batch-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "2048");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "3072");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        ({ GET: getPublicImageTask, POST: recoverPublicImageTask } = await import("@/app/api/image-tasks/[id]/route"));
        ({ runTaskWithRetry, executeTasks } = await import("./agent-run-execution"));
        ({ createAgentRun, getAgentRun, updateAgentRunById } = await import("./agent-run-store"));
        ({ publicAgentRun, publicAgentRunEvent } = await import("./agent-run-public"));
        ({ createCreativeConversation, listCreativeRunEvents, listCreativeMessages } = await import("./creative-runtime-store"));
        ({ schedulePreparedImageTask } = await import("./ecommerce-image-task-orchestration"));
        ({ getStoredGenerationTaskRecord } = await import("./generation-task-store"));
        ({ createImageTask, getImageTask } = await import("./image-task-store"));
        ({ createImageTaskUpstreamStep, persistImageTaskResult, queryImageTaskUpstreamStep } = await import("./image-task-runtime"));
        ({ localAssetUrlToPath } = await import("./generation-log-repository"));
        ({ listGenerationLogs } = await import("./generation-log-store"));
        ({ ECOMMERCE_QUALITY_CHECK_KEYS } = await import("./ecommerce-quality-check"));
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        textPlanningActual.module?.resetTextPlanningRuntime();
        boundary.outbound.mockImplementation(() => {
            throw new Error("fixture forbids external requests");
        });
        boundary.settings = settings("image-model", "image-channel");
        boundary.settings.dataLifecycle = { ...(await import("@/lib/auth/store")).DEFAULT_DATA_LIFECYCLE };
        boundary.settings.systemChannels.find((channel) => channel.id === "image-channel")!.models = ["nano-banana-2"];
        boundary.settings.logicalModels.find((model) => model.id === "image-model")!.bindings[0].upstreamModel = "nano-banana-2";
        childIds = [];
        childBeforeQuality = undefined;
        baseline = await image(120, 160, "blue");
        boundary.create.mockResolvedValue({ pending: { id: "original-upstream", mediaBaseUrl: "https://fixture.example/media", pollBaseUrl: "http://fixture.local/api/ai/system/image-channel" } });
        boundary.poll.mockImplementation(async () => ({ dataUrl: nativeResults[0].dataUrl, results: nativeResults }));
        boundary.structured.mockImplementation(async ({ messages }) => {
            const content = messages.find((message: { role: string }) => message.role === "user").content;
            const payload = content
                .filter((part: { text?: string }) => part.text?.startsWith("{"))
                .map((part: { text: string }) => JSON.parse(part.text))
                .find((value: { resultIds?: string[] }) => value.resultIds);
            return {
                arguments: JSON.stringify({
                    baselineObservation: observation,
                    ...(content.some((part: { text?: string }) => part.text?.startsWith("originalProductAnchor=")) ? { productAnchorObservation: observation } : {}),
                    results: payload.resultIds.map((resultId: string) => ({
                        resultId,
                        observation,
                        checks: ECOMMERCE_QUALITY_CHECK_KEYS.map((key) => ({ key, status: key === "brand_logo" || key === "packaging_text" ? "not_applicable" : "passed", reason: "fixture observed" })),
                    })),
                }),
                headers: new Headers(),
                protocol: "chat",
                elapsedMs: 1,
            };
        });
        boundary.request.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/image-tasks") && init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                const child = await createImageTask({
                    ...body,
                    ...body.context,
                    userId: "batch-user",
                    username: "fixture-user",
                    displayName: "Fixture User",
                    config: { ...body.config, ...toSystemGenerationChannel(routeEcommerceRole(boundary.settings, "image_generation")!) },
                });
                childIds.push(child.id);
                expect(await createImageTaskUpstreamStep(child, "http://fixture.local", "https://public.example", "session=fixture")).toMatchObject({ state: "pending" });
                const submitted = (await getImageTask(child.id))!;
                const step = await queryImageTaskUpstreamStep(submitted, "http://fixture.local", "session=fixture");
                if (step.state === "result_ready") await persistImageTaskResult(submitted, "http://fixture.local", step.resultUrl, "session=fixture");
                else expect(step).toEqual({ state: "completed" });
                childBeforeQuality = (await getImageTask(child.id))!;
                return Response.json({ task: { id: child.id } });
            }
            if (/\/api\/image-tasks\//.test(url)) return getPublicImageTask(new Request(url), { params: Promise.resolve({ id: url.split("/").at(-1)! }) });
            if (/\/api\/reference-assets\//.test(url)) {
                const { readReferenceAsset } = await import("./reference-asset-store");
                const asset = await readReferenceAsset(new URL(url).pathname.slice("/api/reference-assets/".length));
                assert.ok(asset);
                return new Response(new Uint8Array(await readFile(asset.filePath)), { headers: { "content-type": asset.mimeType } });
            }
            if (/\/api\/generation-log-assets\//.test(url)) {
                const bytes = await readFile(localAssetUrlToPath(new URL(url).pathname));
                return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } });
            }
            throw new Error("unexpected fixture transport");
        });
    });

    afterEach(() => {
        finalRead.path = "";
        finalRead.armed = false;
        finalRead.failures = 0;
    });

    async function completedFinalState(image: ImageTask) {
        assert.ok(image.resultProcessing);
        const media = image.result?.results?.[0];
        assert.ok(media?.serverUrl && media.resultId);
        assert.match(media.serverUrl, /^\/api\/reference-assets\//);
        const { readReferenceAsset } = await import("./reference-asset-store");
        const final = await readReferenceAsset(decodeURIComponent(media.serverUrl.slice("/api/reference-assets/".length)));
        assert.ok(final?.registration);
        const stage = await getStoredGenerationTaskRecord("image_processing", image.resultProcessing.jobId);
        assert.ok(stage);
        expect(stage).toMatchObject({ status: "success", executionPhase: "completed", parentTaskId: image.id });
        expect(final.registration).toMatchObject({ ownerUserId: "batch-user", source: "image-processing-final", storageClass: "permanent" });
        return { image, stage, final, bytes: await readFile(final.filePath), resultId: media.resultId };
    }

    afterAll(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    async function prepareDeliveryFixture(requestId: string, advisory: boolean, multipleModels = false) {
        if (multipleModels) {
            const first = boundary.settings.logicalModels.find((model) => model.id === "image-model")!;
            boundary.settings.logicalModels.push({ ...structuredClone(first), id: "image-model-two", name: "Second image model", bindings: first.bindings.map((binding) => ({ ...binding, id: "second-binding", upstreamModel: "gpt-image-2.5-sunburst" })) });
            boundary.settings.systemChannels.find((channel) => channel.id === "image-channel")!.models.push("gpt-image-2.5-sunburst");
        }
        const conversation = await createCreativeConversation("batch-user", { surface: "chat" });
        const { uploadAssetForUser } = await import("./creative-runtime-service");
        const source = await uploadAssetForUser("batch-user", conversation.id, new File([new Uint8Array(Buffer.from(baseline.slice(baseline.indexOf(",") + 1), "base64"))], "scene.png", { type: "image/png" }));
        assert.ok(source.serverUrl);
        const initial = (
            await createAgentRun("batch-user", {
                clientRequestId: requestId,
                conversationId: conversation.id,
                surface: "chat",
                prompt: "调整光线，保持原图尺寸",
                assetIds: [source.id],
                skillIds: [],
                modelIds: multipleModels ? ["image-model", "image-model-two"] : [],
            })
        ).run;
        const plan: EcommerceEditPlan = {
            planVersion: "ecommerce-edit.v5",
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: source.id, sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye level", lighting: "daylight" } },
            delta: { requestedChanges: ["adjust lighting"], targetObjects: ["lighting"], targetRegions: ["whole-scene"] },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            strategy: "integrated_scene",
            modelRoles: { visionAnalysis: "planner", editPlanning: "planner", generation: "image-model", qualityCheck: advisory ? "planner" : null },
            continuity: { parentResultId: null, branchId: "delivery-branch" },
            validation: { requiredChecks: ["requested_edit"] },
            canvas: { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false },
            protection: { scope: "global", protectedObjectIds: ["cabinet"], preserveOutsideMask: false, allowLightingChange: true },
            visibleStructure: structure,
        };
        const reviewResponse = boundary.structured.getMockImplementation()!;
        boundary.settings.ecommerceGenerationEnabled = true;
        boundary.settings.ecommerceVisualQualityCheckEnabled = advisory;
        const provider = await vi.importActual<typeof import("@/app/api/image-tasks/image-task-openai")>("@/app/api/image-tasks/image-task-openai");
        boundary.create.mockImplementation(provider.runOpenAiImageTask);
        boundary.submit.mockImplementation(async (_config, _url, init) => {
            expect(init.method).toBe("POST");
            return Response.json({ id: multipleModels ? "original-upstream-" + _config.model : "original-upstream", status: "pending" });
        });
        boundary.structured.mockImplementation(async (request: Parameters<typeof import("./text-planning-runtime").requestStructuredText>[0]) => {
            const content = request.messages.find((message) => message.role === "user")!.content;
            const payloads = (typeof content === "string" ? [content] : content.flatMap((part) => (part.type === "text" && part.text.startsWith("{") ? [part.text] : []))).map((text) => JSON.parse(text));
            const payload = payloads.find((value) => Array.isArray(value.assets) || Boolean(value.sources));
            assert.ok(payload);
            let value;
            if (request.tool.name === "analyze_ecommerce_references") {
                value = {
                    analysisVersion: "ecommerce-visual-analysis.v4",
                    purposeSuggestions: [],
                    references: payload.assets.map((asset: { id: string }) => ({
                        assetId: asset.id,
                        contentType: "interior_scene",
                        confidence: "high",
                        visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                        productFacts: null,
                        sceneFacts: plan.baseline.sceneFacts,
                        productCore: null,
                        fusionHalo: null,
                        editableTargets: [{ id: "lighting", kind: "lighting", label: "lighting", region: { x: 0, y: 0, width: 1, height: 1 } }],
                        visibleStructure: structure,
                        cues: [],
                    })),
                };
            } else {
                expect(request.tool.name).toBe("plan_ecommerce_edit");
                expect(payload.sources).toMatchObject({ currentSceneBaselineId: source.id, productAnchorId: null });
                const { referenceUsesFromEcommerceDecision } = await import("./ecommerce-reference-purpose");
                value = {
                    ...plan,
                    planVersion: "ecommerce-edit.v7",
                    strategy: "full_image",
                    modelRoles: payload.requiredModelRoles,
                    continuity: payload.continuity,
                    referenceUses: referenceUsesFromEcommerceDecision({ decision: payload.referenceDecision, sourceOrder: [source.id] }),
                };
            }
            return { arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat", elapsedMs: 1 };
        });
        const transport = boundary.request.getMockImplementation()!;
        boundary.request.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/image-tasks") && init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                const { prepareEcommerceImageTask } = await import("./ecommerce-image-task-orchestration");
                const { reviewReason, ...prepared } = prepareEcommerceImageTask({
                    ...body,
                    compatibleConfigs: [{ ...body.config, ...toSystemGenerationChannel(routeEcommerceRole(boundary.settings, "image_generation", body.ecommerceExecution.modelSnapshot)!) }],
                });
                expect(reviewReason).toBe("");
                const child = await createImageTask({ ...body, ...body.context, userId: "batch-user", username: "fixture-user", displayName: "Fixture User", ...prepared });
                childIds.push(child.id);
                expect(await schedulePreparedImageTask(child, reviewReason)).toEqual({ needsReview: false });
                return Response.json({ task: { id: child.id } });
            }
            if (/\/api\/image-tasks\//.test(url)) {
                childBeforeQuality = await completeImageTaskResultFixture(url.split("/").at(-1)!, { origin: "http://fixture.local", cookie: "session=fixture", directory });
                assert.ok(childBeforeQuality.nativeResults && childBeforeQuality.resultProcessing);
                expect(await getStoredGenerationTaskRecord("image_processing", childBeforeQuality.resultProcessing.jobId)).toMatchObject({
                    status: "success",
                    executionPhase: "completed",
                    parentTaskId: childBeforeQuality.id,
                    runId: initial.id,
                    payload: { operation: "process_result" },
                });
                return getPublicImageTask(new Request(url), { params: Promise.resolve({ id: childBeforeQuality.id }) });
            }
            return transport(url, init);
        });
        const scheduler = await import("./generation-task-scheduler");
        const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
        const processing = await import("./image-processing-service");
        await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
        expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-disabled-reference-parent", taskIds: [initial.id], limit: 1 })).toMatchObject({ claimed: 1 });
        const preparing = (await getAgentRun(initial.id))!;
        const waiting = preparing.ecommerceSnapshot?.processing?.waitingFor;
        assert.ok(waiting);
        expect(preparing.ecommerceSnapshot?.referenceCheckpoint).toMatchObject({ state: "analyzing", analysisStage: { state: "created" }, assets: [{ asset: { id: source.id } }] });
        const workerId = "fixture-disabled-reference-cpu";
        const { profileVersion, budgetBytes } = imageProcessingResourceConfig(process.env);
        const claimed = await processing.claimImageProcessingTasks({ workerId, profileVersion, availableMemoryBytes: budgetBytes, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const child = claimed.tasks[0];
        expect(child.id).toBe(waiting.jobId);
        expect(child.payload).toMatchObject({ operation: "prepare_reference", inputs: [{ assetId: source.id }] });
        const prepared = await completeClaimedImageProcessingFixture(child, workerId, directory);
        expect(prepared.receipt.parentRescheduled).toBe(true);
        expect(await getStoredGenerationTaskRecord("image_processing", child.id)).toMatchObject({ status: "success", executionPhase: "completed", runId: initial.id, parentTaskId: initial.id, resultPayload: { manifest: prepared.manifest } });
        return { conversation, initial, prepared, referenceChild: child, reviewResponse };
    }

    it.each([false, true])(
        "reviews both delivered models and retains full-parent ownership (sibling changed: %s)",
        async (changeSibling) => {
            nativeResults = [{ dataUrl: baseline }];
            const { initial, reviewResponse } = await prepareDeliveryFixture(`multi-advisory-${changeSibling}`, true, true);
            const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
            const scheduler = await import("./generation-task-scheduler");
            const input = { origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-multi-delivery", taskIds: [initial.id], limit: 1 };
            await runGenerationTaskRecoveryBatch(input);
            await scheduler.scheduleGenerationTask("agent", initial.id, { nextPollAt: Date.now() });
            await runGenerationTaskRecoveryBatch(input);
            await scheduler.scheduleGenerationTask("agent", initial.id, { nextPollAt: Date.now() });
            await runGenerationTaskRecoveryBatch(input);
            const delivered = (await getAgentRun(initial.id))!;
            expect(delivered.tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
            const resultIds = delivered.tasks.map((task) => task.taskIds![0] + ":1");
            const originalTransport = boundary.request.getMockImplementation()!;
            let modelArguments = "";
            boundary.structured.mockImplementation(async (request) => {
                modelArguments = (await reviewResponse(request)).arguments;
                assert.ok(textPlanningActual.module);
                return textPlanningActual.module.requestStructuredText(request);
            });
            const prepared = await prepareAdvisoryReview(delivered.id, { origin: "http://fixture.local", cookie: "session=fixture", directory });
            expect(prepared.ecommerceSnapshot?.visualReview?.sources.filter((source) => source.source.startsWith("result:")).map((source) => source.original.resultId)).toEqual(resultIds);
            expect(prepared.ecommerceSnapshot?.visualReview?.views).toHaveLength(6);
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            boundary.request.mockImplementation(async (url: string, init?: RequestInit) => {
                if (!url.includes("/api/ai/system/")) return originalTransport(url, init);
                entered.resolve();
                if (changeSibling) await release.promise;
                return Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "check_ecommerce_results", arguments: modelArguments } }] } }] });
            });
            const pending = recoverAdvisoryReview(delivered.id);
            if (changeSibling) {
                await entered.promise;
                const held = (await getAgentRun(delivered.id))!;
                await updateAgentRunById(held.id, { tasks: [held.tasks[0], { ...held.tasks[1], title: "Changed sibling" }] }, undefined, ["completed"], held.executionId);
                release.resolve();
            }
            await pending;
            const reviewed = (await getAgentRun(delivered.id))!;
            if (changeSibling) {
                expect(reviewed.reviewed).toBe(false);
                expect(reviewed.tasks[1].title).toBe("Changed sibling");
                expect(reviewed.ecommerceSnapshot?.qualityCheck).toBeUndefined();
                return;
            }
            expect(reviewed.reviewStatus).toBe("review_completed");
            expect(reviewed.ecommerceSnapshot?.qualityCheck?.canvasEvidence?.map((item) => item.resultId)).toEqual(resultIds);
            expect(publicAgentRun(reviewed).assetIds).toHaveLength(2);
            expect(publicAgentRun({ ...reviewed, ecommerceSnapshot: { ...reviewed.ecommerceGenerations![1].snapshot, qualityCheck: { ...reviewed.ecommerceSnapshot!.qualityCheck!, status: "blocked", publicStatus: "needs_review" } } })).toMatchObject({
                ecommerceQualityStatus: "needs_adjustment",
                assetIds: reviewed.assetIds,
            });
            const images = await Promise.all(reviewed.tasks.map((task) => getImageTask(task.taskIds![0])));
            const traces = images.map((image) => image!.ecommerceTrace!);
            expect(traces.map((trace) => trace.agentTaskId)).toEqual(reviewed.tasks.map((task) => task.id));
            expect(traces.map((trace) => trace.stages.find((stage) => stage.key === "image_generation")?.model?.logicalModelId)).toEqual(["image-model", "image-model-two"]);
            expect(traces.map((trace) => trace.imageTaskIds)).toEqual(reviewed.tasks.map((task) => task.taskIds));
            const logs = (await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true })).items;
            expect(images.map((image) => logs.find((log) => log.taskId === image!.id)?.ecommerceTrace)).toEqual(traces);
        },
        120_000,
    );

    function useFailedNativeCapture() {
        const transport = boundary.request.getMockImplementation()!;
        boundary.request.mockImplementation(async (url: string, init?: RequestInit) => {
            if (/\/api\/image-tasks\//.test(url) && !init?.method) {
                const imageId = url.split("/").at(-1)!;
                const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
                const { scheduleGenerationTask } = await import("./generation-task-scheduler");
                expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-native-unavailable-submit", taskIds: [imageId], limit: 1 })).toMatchObject({ claimed: 1, pending: 1 });
                await scheduleGenerationTask("image", imageId, { nextPollAt: Date.now() });
                expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-native-unavailable-query", taskIds: [imageId], limit: 1 })).toMatchObject({ claimed: 1, needsReview: 1 });
                return getPublicImageTask(new Request(url), { params: Promise.resolve({ id: imageId }) });
            }
            return transport(url, init);
        });
        return transport;
    }

    it.each(["disabled", "advisory_blocked", "advisory_unavailable", "advisory_preparation_failed", "advisory_source_expired", "advisory_context_changed", "advisory_late", "wrong_native"] as const)(
        "delivers before optional background quality while retaining technical gates (%s)",
        async (condition) => {
            nativeResults = condition === "wrong_native" ? [{ dataUrl: await image(120, 120, "blue") }, { dataUrl: baseline }] : [{ dataUrl: baseline }];
            const advisory = condition.startsWith("advisory") || condition === "wrong_native";
            const { conversation, initial, prepared, referenceChild: child, reviewResponse } = await prepareDeliveryFixture(`delivery-${condition}`, advisory);
            const scheduler = await import("./generation-task-scheduler");
            const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
            expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-disabled-delivery-parent", taskIds: [initial.id], limit: 1 })).toMatchObject({
                claimed: 1,
                pending: 1,
                completed: 0,
                failed: 0,
            });
            assert.ok(childBeforeQuality);
            const observing = (await getAgentRun(initial.id))!;
            expect(observing).toMatchObject({
                status: "running",
                tasks: [{ status: "running", attempts: 1, taskIds: [childBeforeQuality.id], childTasks: [{ id: childBeforeQuality.id, status: "pending", attempt: 1 }] }],
            });
            expect(childIds).toEqual([childBeforeQuality.id]);
            // The GET completed this image; a new observation must consume its durable fact.
            await scheduler.scheduleGenerationTask("agent", initial.id, { nextPollAt: Date.now() });
            expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-disabled-observation-parent", taskIds: [initial.id], limit: 1 })).toMatchObject(
                condition === "wrong_native" ? { claimed: 1, completed: 0, failed: 1 } : { claimed: 1, completed: 1 },
            );
            const run = (await getAgentRun(initial.id))!;
            expect(run.tasks[0]).toMatchObject({
                id: observing.tasks[0].id,
                attempts: 1,
                taskIds: [childBeforeQuality.id],
                childTasks: [{ id: childBeforeQuality.id, status: "completed", attempt: 1 }],
            });
            expect(run.ecommerceSnapshot).toMatchObject({
                referenceCheckpoint: { state: "resolved", analysisStage: { state: "completed" } },
                processing: { prepareReferences: [{ jobId: child.id, manifest: prepared.manifest }] },
                compilerVersion: run.tasks[0].ecommerceExecution!.compilerVersion,
                modelRouteSnapshots: { image_generation: routeEcommerceRole(boundary.settings, "image_generation")!.snapshot },
            });
            expect(childBeforeQuality).toMatchObject({ status: "success", runId: run.id, parentTaskId: run.id, upstream: { id: "original-upstream" } });
            const native = childBeforeQuality!.nativeResults!.slots[0];
            assert.ok(native.status === "stored");
            const { getLocalMediaRegistration } = await import("./local-media-registry");
            const { REFERENCE_MEDIA_ROOT } = await import("./local-media-storage");
            expect(await getLocalMediaRegistration(native.storageKey)).toMatchObject({ ownerUserId: "batch-user", taskId: childBeforeQuality!.id, source: "image-task-native-result", scope: "reference", type: "attachment", storageClass: "permanent" });
            expect(await readFile(join(REFERENCE_MEDIA_ROOT, native.storageKey))).toEqual(Buffer.from((condition === "wrong_native" ? nativeResults[0].dataUrl : baseline).split(",")[1], "base64"));
            expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
            expect(boundary.poll).toHaveBeenCalledTimes(1);
            expect(boundary.submit).toHaveBeenCalledTimes(1);
            boundary.structured.mockImplementation(reviewResponse);
            const delivered = (await getAgentRun(run.id))!;
            expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
            expect(boundary.create).toHaveBeenCalledTimes(1);
            if (condition === "wrong_native") {
                expect(delivered).toMatchObject({ status: "paused", assetIds: [], ecommerceSnapshot: { technicalCheck: { status: "blocked" } } });
                const originalChild = await getImageTask(childIds[0]);
                assert.ok(originalChild?.nativeResults && originalChild.resultProcessing);
                expect(originalChild.nativeResults.slots).toMatchObject([
                    { resultId: originalChild.id + ":1", resultIndex: 1, status: "stored" },
                    { resultId: originalChild.id + ":2", resultIndex: 2, status: "stored" },
                ]);
                expect(originalChild.result?.results?.map((result) => result.resultId)).toEqual([originalChild.id + ":1", originalChild.id + ":2"]);
                const media = originalChild.result?.results?.[0];
                assert.ok(media?.serverUrl);
                expect(delivered.ecommerceSnapshot?.technicalCheck?.canvasEvidence?.[1]).toMatchObject({
                    resultId: originalChild.id + ":2",
                    nativeSize: { width: 120, height: 160 },
                    storedSize: { width: 120, height: 160 },
                    nativeMatches: true,
                    storedMatches: true,
                });
                expect(media.canvasEvidence).toMatchObject({ constraint: { mode: "exact", size: { width: 120, height: 160 } }, nativeSize: { width: 120, height: 120 }, storedSize: { width: 120, height: 120 } });
                const storedBytes = await readImageTaskResultBytesFixture(media.serverUrl);
                expect(storedBytes).toEqual(Buffer.from(nativeResults[0].dataUrl.split(",")[1], "base64"));
                expect(await sharp(storedBytes).metadata()).toMatchObject({ width: 120, height: 120 });
                const visible = publicAgentRun(delivered);
                expect(visible).toMatchObject({ status: "paused", assetIds: [], ecommerceQualityStatus: "needs_review", tasks: [{ status: "needs_review", error: "图片保存、尺寸或选区保护检查未完成，请检查原任务。" }] });
                expect(visible.ecommerceQualityReview).toEqual({ kind: "hard_failure", failureKeys: ["canvas_geometry"], message: "画幅与要求不一致：要求 120×160，上游原图 120×120，落盘图片 120×120。" });
                expect(JSON.stringify(visible)).not.toMatch(/technicalCheck|TypeError|"stack"/);
                const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
                expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-wrong-native-replay", taskIds: [run.id], limit: 1 })).toMatchObject({ claimed: 0 });
                expect(await getAgentRun(run.id)).toStrictEqual(delivered);
                expect(await getImageTask(originalChild.id)).toStrictEqual(originalChild);
                expect(childIds).toEqual([originalChild.id]);
                expect(originalChild.upstream).toMatchObject({ id: "original-upstream" });
                expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                expect(delivered.ecommerceSnapshot?.qualityCheck).toBeUndefined();
                expect(boundary.create).toHaveBeenCalledTimes(1);
                expect(boundary.submit).toHaveBeenCalledTimes(1);
                expect(boundary.poll).toHaveBeenCalledTimes(1);
                expect(boundary.refund).not.toHaveBeenCalled();
                return;
            }
            expect(delivered).toMatchObject({
                status: "completed",
                ecommerceSnapshot: { technicalCheck: { status: "passed" } },
            });
            expect(delivered.assetIds).toHaveLength(1);
            expect(publicAgentRun(delivered).assetIds).toEqual(delivered.assetIds);
            const messageBefore = (await listCreativeMessages(conversation.id)).find((message) => message.id === delivered.assistantMessageId);
            const logsBefore = await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true });
            expect(logsBefore.items[0]?.ecommerceTrace?.stages.find((stage) => stage.key === "quality_check")).toMatchObject({ status: "not_run", output: { policy: advisory ? "advisory" : "disabled" } });
            const { processAgentRunReview } = await import("./agent-run-execution");
            if (advisory) {
                expect(delivered.reviewStatus).toBe("review_pending");
                expect(await getStoredGenerationTaskRecord("agent", delivered.id)).toMatchObject({ status: "success", executionPhase: "review_pending", nextPollAt: expect.any(Number) });
                const { releaseGenerationTaskLease } = await import("./generation-task-scheduler");
                const originalCall = boundary.structured.getMockImplementation()!;
                const originalTransport = boundary.request.getMockImplementation()!;
                let modelArguments = "";
                let modelTransmissions = 0;
                boundary.structured.mockImplementation(async (input) => {
                    const response = await originalCall(input);
                    const value = JSON.parse(response.arguments);
                    value.results[0].observation = { ...observation, visibleStructure: [{ ...structure[0], count: 4 }] };
                    modelArguments = JSON.stringify(value);
                    assert.ok(textPlanningActual.module);
                    return textPlanningActual.module.requestStructuredText(input);
                });
                const prepared = await prepareAdvisoryReview(delivered.id, { origin: "http://fixture.local", cookie: "session=fixture", directory, failFirst: condition === "advisory_preparation_failed" });
                let enter!: () => void;
                let release!: () => void;
                const entered = new Promise<void>((resolve) => {
                    enter = resolve;
                });
                const pending = new Promise<void>((resolve) => {
                    release = resolve;
                });
                boundary.request.mockImplementation(async (url: string, init?: RequestInit) => {
                    if (!url.includes("/api/ai/system/")) return originalTransport(url, init);
                    modelTransmissions += 1;
                    const submitted = (await getAgentRun(delivered.id))!;
                    expect(submitted.ecommerceSnapshot?.visualReview?.submission).toMatchObject({ state: "started" });
                    if (condition === "advisory_late") {
                        enter();
                        await pending;
                    }
                    if (condition === "advisory_unavailable") return new Response("fixture proxy cannot confirm upstream submission", { status: 502 });
                    return Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "check_ecommerce_results", arguments: modelArguments } }] } }] });
                });
                if (condition === "advisory_late") {
                    const firstReview = recoverAdvisoryReview(delivered.id);
                    await entered;
                    try {
                        const current = (await getAgentRun(delivered.id))!;
                        expect(current).toMatchObject({ reviewAttempts: 1, reviewed: false, ecommerceSnapshot: { visualReview: { submission: { state: "started" } } } });
                        const held = await getStoredGenerationTaskRecord("agent", delivered.id);
                        assert.ok(held?.workerId && current.executionId);
                        await releaseGenerationTaskLease("agent", delivered.id, held.workerId, { executionPhase: "review_pending", nextPollAt: Date.now() }, { executionId: current.executionId });
                        await recoverAdvisoryReview(delivered.id);
                        const frozen = (await getAgentRun(delivered.id))!;
                        expect(frozen).toMatchObject({ status: "completed", reviewAttempts: 1, reviewed: true, ecommerceSnapshot: { qualityCheck: { status: "unavailable" }, visualReview: { submission: { state: "unknown" } } } });
                        const childTrace = (await getImageTask(frozen.tasks[0].taskIds![0]))?.ecommerceTrace;
                        const logTrace = (await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true })).items.find((log) => log.taskId === frozen.tasks[0].taskIds![0])?.ecommerceTrace;
                        const messages = await listCreativeMessages(conversation.id);
                        const events = await listCreativeRunEvents(frozen.id);
                        release();
                        await firstReview;
                        expect(await getAgentRun(frozen.id)).toEqual(frozen);
                        expect((await getImageTask(frozen.tasks[0].taskIds![0]))?.ecommerceTrace).toEqual(childTrace);
                        expect((await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true })).items.find((log) => log.taskId === frozen.tasks[0].taskIds![0])?.ecommerceTrace).toEqual(logTrace);
                        expect(await listCreativeMessages(conversation.id)).toEqual(messages);
                        expect(await listCreativeRunEvents(frozen.id)).toEqual(events);
                        expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit", "check_ecommerce_results"]);
                        expect(boundary.structured.mock.calls.filter(([request]) => request.tool.name === "check_ecommerce_results")).toHaveLength(1);
                        expect(modelTransmissions).toBe(1);
                        expect(boundary.create).toHaveBeenCalledTimes(1);
                    } finally {
                        release();
                        await firstReview;
                    }
                    return;
                }
                if (condition === "advisory_source_expired") {
                    const frozen = prepared.ecommerceSnapshot!.visualReview!.sources.find((item) => item.original.imageTaskId)!.frozen!;
                    const { getLocalMediaRegistration, registerLocalMediaAsset } = await import("./local-media-registry");
                    const original = await getLocalMediaRegistration(frozen.location.storageKey);
                    assert.ok(original);
                    await registerLocalMediaAsset({ ...original, storageClass: "temporary", expiresAt: new Date(Date.now() - 1000).toISOString() });
                }
                if (condition === "advisory_context_changed") {
                    const snapshot = prepared.ecommerceSnapshot!;
                    const plan = snapshot.plan!;
                    await updateAgentRunById(
                        prepared.id,
                        { ecommerceSnapshot: { ...snapshot, plan: { ...plan, delta: { ...plan.delta, requestedChanges: ["fixture: current plan changed after preparation"] } } } },
                        { type: "run.review.fixture_context_changed" },
                        ["completed"],
                        undefined,
                        prepared.tasks,
                    );
                }
                await recoverAdvisoryReview(delivered.id);
                const checked = (await getAgentRun(delivered.id))!;
                expect(checked).toMatchObject({
                    status: "completed",
                    assetIds: delivered.assetIds,
                    tasks: [{ status: "completed", attempts: 1 }],
                    ecommerceSnapshot: { qualityCheck: { status: condition === "advisory_blocked" ? "blocked" : "unavailable" } },
                });
                expect(checked.reviewAttempts).toBe(1);
                if (condition === "advisory_blocked") {
                    expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit", "check_ecommerce_results"]);
                    expect(boundary.structured.mock.calls.filter(([request]) => request.tool.name === "check_ecommerce_results")).toHaveLength(1);
                    const qualityEvent = (await listCreativeRunEvents(checked.id)).filter((event) => event.type === "ecommerce.quality").at(-1);
                    assert.ok(qualityEvent);
                    expect(publicAgentRunEvent(qualityEvent).data).toEqual({ status: "needs_adjustment", text: "图片已生成，可按需要继续调整。" });
                }
                expect(modelTransmissions).toBe(["advisory_preparation_failed", "advisory_source_expired", "advisory_context_changed"].includes(condition) ? 0 : 1);
                if (condition === "advisory_preparation_failed") {
                    expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                    expect(boundary.structured.mock.calls.filter(([request]) => request.tool.name === "check_ecommerce_results")).toHaveLength(0);
                    expect(checked.ecommerceSnapshot?.visualReview).toMatchObject({ failure: { code: "review_preparation_failed" }, submission: { state: "failed" } });
                }
                if (condition === "advisory_source_expired") {
                    expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                    expect(boundary.structured.mock.calls.filter(([request]) => request.tool.name === "check_ecommerce_results")).toHaveLength(0);
                    expect(checked.ecommerceSnapshot?.visualReview?.submission).toMatchObject({ state: "failed" });
                }
                if (condition === "advisory_context_changed") {
                    expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                    expect(boundary.structured.mock.calls.filter(([request]) => request.tool.name === "check_ecommerce_results")).toHaveLength(0);
                    expect(checked.ecommerceSnapshot?.visualReview).toMatchObject({ attempt: 1, contextDigest: prepared.ecommerceSnapshot!.visualReview!.contextDigest, failure: { code: "review_context_changed" }, submission: { state: "failed" } });
                }
                if (condition === "advisory_unavailable") {
                    expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit", "check_ecommerce_results"]);
                    expect(boundary.structured.mock.calls.filter(([request]) => request.tool.name === "check_ecommerce_results")).toHaveLength(1);
                    expect(checked.ecommerceSnapshot?.visualReview?.submission).toMatchObject({ state: "unknown" });
                }
                expect(publicAgentRun(checked)).toMatchObject({ assetIds: delivered.assetIds, ecommerceQualityStatus: "needs_adjustment" });
                expect((await listCreativeMessages(conversation.id)).find((message) => message.id === delivered.assistantMessageId)).toEqual(messageBefore);
                expect(boundary.create).toHaveBeenCalledTimes(1);
                const { attachEcommerceTraceToGenerationLogs } = await import("./generation-log-store");
                const initialTrace = logsBefore.items[0].ecommerceTrace!;
                // Readback performs the guarded authoritative projection before attempting an old trace CAS.
                expect((await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true })).items.find((log) => log.taskId === checked.tasks[0].taskIds![0])?.ecommerceTrace?.stages.find((stage) => stage.key === "quality_check")?.status).toBe(
                    condition === "advisory_blocked" ? "blocked" : "unavailable",
                );
                expect(await attachEcommerceTraceToGenerationLogs(checked.tasks[0].taskIds!, initialTrace, initialTrace)).toEqual({ updated: 0 });
                if (condition === "advisory_unavailable") {
                    const child = await getImageTask(checked.tasks[0].taskIds![0]);
                    assert.ok(child?.nativeResults && child.resultProcessing);
                    const messages = await listCreativeMessages(conversation.id);
                    const events = await listCreativeRunEvents(checked.id);
                    const scheduled = await getStoredGenerationTaskRecord("agent", checked.id);
                    assert.ok(scheduled);
                    expect(scheduled).toMatchObject({ status: "success", executionPhase: "review_unavailable" });
                    expect(scheduled.nextPollAt).toBeUndefined();
                    expect(await recoverAdvisoryReview(checked.id)).toMatchObject({ claimed: 0 });
                    const replayed = (await getAgentRun(checked.id))!;
                    expect(replayed).toMatchObject({
                        id: checked.id,
                        status: "completed",
                        assetIds: checked.assetIds,
                        tasks: checked.tasks,
                        reviewed: true,
                        reviewStatus: "review_unavailable",
                        reviewAttempts: 1,
                        ecommerceSnapshot: { qualityCheck: checked.ecommerceSnapshot!.qualityCheck, visualReview: checked.ecommerceSnapshot!.visualReview },
                    });
                    expect(replayed.executionId).toBe(checked.executionId);
                    const replayedChild = await getImageTask(child.id);
                    assert.ok(replayedChild);
                    expect(replayedChild).toMatchObject({
                        id: child.id,
                        status: "success",
                        runId: checked.id,
                        parentTaskId: checked.id,
                        upstream: child.upstream,
                        nativeResults: child.nativeResults,
                        resultProcessing: child.resultProcessing,
                        result: child.result,
                        ecommerceTrace: child.ecommerceTrace,
                    });
                    expect(replayedChild.executionId).toBe(child.executionId);
                    expect(await listCreativeMessages(conversation.id)).toEqual(messages);
                    expect(await listCreativeRunEvents(checked.id)).toEqual(events);
                    expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit", "check_ecommerce_results"]);
                    expect(boundary.structured.mock.calls.filter(([request]) => request.tool.name === "check_ecommerce_results")).toHaveLength(1);
                    expect(modelTransmissions).toBe(1);
                    expect(boundary.create).toHaveBeenCalledTimes(1);
                    expect(boundary.submit).toHaveBeenCalledTimes(1);
                    expect(boundary.poll).toHaveBeenCalledTimes(1);
                }
            } else {
                const staleReview = (await updateAgentRunById(delivered.id, { reviewed: false }, undefined, ["completed"]))!;
                await processAgentRunReview(staleReview, "http://fixture.local", "session=fixture");
                expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
                expect((await getAgentRun(delivered.id))?.reviewed).toBe(true);
            }
        },
        120_000,
    );

    it("recovers the same ImageTask after all native acquisition is unavailable", async () => {
        const nativeUrl = "https://fixture.example/native-recovery.png";
        nativeResults = [{ dataUrl: nativeUrl }];
        boundary.outbound.mockImplementation(async (url: string) => {
            expect(url).toBe(nativeUrl);
            return new Response(null, { status: 503 });
        });
        const { conversation, initial } = await prepareDeliveryFixture("native-unavailable", false);
        const transport = useFailedNativeCapture();
        const scheduler = await import("./generation-task-scheduler");
        const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
        expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-native-unavailable-parent", taskIds: [initial.id], limit: 1 })).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
        const paused = (await getAgentRun(initial.id))!;
        const original = (await getImageTask(childIds[0]))!;
        const reason = "未能取得上游图片原件，需要人工确认。";
        expect(paused).toMatchObject({ status: "paused", assetIds: [], tasks: [{ status: "needs_review", attempts: 1, taskIds: [original.id], error: reason, childTasks: [{ id: original.id, status: "needs_review", attempt: 1 }] }] });
        expect(original).toMatchObject({ status: "running", runId: initial.id, parentTaskId: initial.id, attemptNo: 1, upstream: { id: "original-upstream" } });
        expect(original.nativeResults).toBeUndefined();
        expect(original.resultProcessing).toBeUndefined();
        expect(original.result).toBeUndefined();
        expect(paused.ecommerceSnapshot?.technicalCheck).toBeUndefined();
        expect(paused.ecommerceSnapshot?.qualityCheck).toBeUndefined();
        const originalSchedule = await getStoredGenerationTaskRecord("image", original.id);
        assert.ok(originalSchedule);
        expect(originalSchedule).toMatchObject({ executionPhase: "needs_review", upstreamTaskId: "original-upstream" });
        expect([originalSchedule.nextPollAt, originalSchedule.workerId, originalSchedule.leaseUntil]).toEqual([undefined, undefined, undefined]);
        const detail = await getPublicImageTask(new Request(`http://fixture.local/api/image-tasks/${original.id}`), { params: Promise.resolve({ id: original.id }) });
        expect(await detail.json()).toMatchObject({ task: { id: original.id, status: "running", needsReview: true, reviewReason: reason, executionPhase: "needs_review", canRetry: false } });
        expect(publicAgentRun(paused)).toMatchObject({ status: "paused", assetIds: [], tasks: [{ status: "needs_review", error: reason }] });
        expect((await listCreativeMessages(conversation.id)).find((message) => message.id === paused.assistantMessageId)).toMatchObject({ content: reason, status: "running" });
        expect((await listCreativeRunEvents(paused.id)).map(publicAgentRunEvent)).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: "task.needs_review", data: expect.objectContaining({ error: reason }) }), expect.objectContaining({ type: "run.paused", data: { message: reason } })]),
        );
        const { listStoredGenerationTaskRecordsByRunIds } = await import("./generation-task-store");
        expect((await listStoredGenerationTaskRecordsByRunIds([initial.id], [initial.userId])).filter((item) => item.type === "image_processing" && item.payload.operation === "process_result")).toEqual([]);
        expect(boundary.submit).toHaveBeenCalledTimes(1);
        expect(boundary.poll).toHaveBeenCalledTimes(1);
        expect(boundary.refund).not.toHaveBeenCalled();
        boundary.request.mockImplementation(transport);
        boundary.outbound.mockImplementation(async (url: string) => {
            expect(url).toBe(nativeUrl);
            return new Response(new Uint8Array(Buffer.from(baseline.split(",")[1], "base64")), { headers: { "content-type": "image/png" } });
        });
        const recovered = await recoverPublicImageTask(
            new Request(`http://fixture.local/api/image-tasks/${original.id}`, { method: "POST", headers: { cookie: "session=fixture", "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }),
            { params: Promise.resolve({ id: original.id }) },
        );
        expect(recovered.status).toBe(200);
        expect(await recovered.json()).toMatchObject({ task: { id: original.id, status: "running" } });
        const acquired = (await getImageTask(original.id))!;
        assert.ok(acquired.nativeResults && acquired.resultProcessing);
        expect(acquired).toMatchObject({ id: original.id, clientRequestId: original.clientRequestId, attemptNo: original.attemptNo, upstream: original.upstream });
        expect(acquired.billing).toEqual(original.billing);
        const recoveredSchedule = await getStoredGenerationTaskRecord("image", original.id);
        assert.ok(recoveredSchedule);
        expect([recoveredSchedule.upstreamTaskId, recoveredSchedule.channelId, recoveredSchedule.provider, recoveredSchedule.queryPath, recoveredSchedule.submittedAt]).toEqual([
            originalSchedule.upstreamTaskId,
            originalSchedule.channelId,
            originalSchedule.provider,
            originalSchedule.queryPath,
            originalSchedule.submittedAt,
        ]);
        const processing = await import("./image-processing-service");
        const { profileVersion, budgetBytes } = imageProcessingResourceConfig(process.env);
        const cpuWorker = "fixture-native-unavailable-result-cpu";
        const resultClaims = await processing.claimImageProcessingTasks({ workerId: cpuWorker, profileVersion, availableMemoryBytes: budgetBytes, slots: 1 });
        expect(resultClaims.tasks).toHaveLength(1);
        expect(resultClaims.tasks[0]).toMatchObject({
            id: acquired.resultProcessing.jobId,
            payload: { operation: "process_result", imageResultBinding: { imageTaskId: original.id, run: { runId: initial.id, agentTaskId: paused.tasks[0].id, agentAttempt: 1 } } },
        });
        const completed = await completeClaimedImageProcessingFixture(resultClaims.tasks[0], cpuWorker, directory);
        expect(completed.receipt.parentRescheduled).toBe(true);
        expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-native-unavailable-consumer", taskIds: [original.id], limit: 1 })).toMatchObject({ claimed: 1, completed: 1 });
        const completedImage = (await getImageTask(original.id))!;
        expect(completedImage).toMatchObject({ status: "success", nativeResults: acquired.nativeResults, resultProcessing: acquired.resultProcessing, upstream: original.upstream, attemptNo: original.attemptNo });
        expect(completedImage.billing).toEqual(original.billing);
        expect((await listStoredGenerationTaskRecordsByRunIds([initial.id], [initial.userId])).filter((item) => item.type === "image_processing" && item.payload.operation === "process_result").map((item) => item.id)).toEqual([
            acquired.resultProcessing.jobId,
        ]);
        const { setAgentRunStatus } = await import("./agent-run-store");
        expect(await setAgentRunStatus(paused, "running")).not.toBeNull();
        await scheduler.scheduleGenerationTask("agent", initial.id, { executionPhase: "created", nextPollAt: Date.now() });
        expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-native-unavailable-agent-recovery", taskIds: [initial.id], limit: 1 })).toMatchObject({ claimed: 1, completed: 1 });
        const delivered = (await getAgentRun(initial.id))!;
        expect(delivered).toMatchObject({ status: "completed", ecommerceSnapshot: { technicalCheck: { status: "passed" } } });
        expect(delivered.assetIds).toHaveLength(1);
        expect(delivered.tasks[0]).toMatchObject({ id: paused.tasks[0].id, attempts: 1, taskIds: [original.id], childTasks: [{ id: original.id, status: "completed", attempt: 1 }] });
        expect(childIds).toEqual([original.id]);
        expect(boundary.outbound.mock.calls.map(([url]) => url)).toEqual([nativeUrl, nativeUrl]);
        expect(boundary.poll.mock.calls.map(([, upstreamId]) => upstreamId)).toEqual(["original-upstream", "original-upstream"]);
        expect(boundary.create).toHaveBeenCalledTimes(1);
        expect(boundary.submit).toHaveBeenCalledTimes(1);
        expect(boundary.refund).not.toHaveBeenCalled();
        expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
    });

    it.each([
        {
            name: "wrong native",
            inputHeight: 120,
            expectedNativeSize: { width: 120, height: 120 },
            expectedStoredSize: { width: 120, height: 120 },
            nativeMatches: false,
            failureStatus: "blocked",
            hardFailureKeys: ["canvas_geometry"],
            recheckBatch: { claimed: 1, failed: 1 },
            recheckRunStatus: "paused",
            recheckTechnicalStatus: "blocked",
            recheckAssets: 0,
        },
        {
            name: "valid native",
            inputHeight: 160,
            expectedNativeSize: { width: 120, height: 160 },
            expectedStoredSize: { width: 120, height: 160 },
            nativeMatches: true,
            failureStatus: "unavailable",
            hardFailureKeys: [],
            recheckBatch: { claimed: 1, completed: 1 },
            recheckRunStatus: "completed",
            recheckTechnicalStatus: "passed",
            recheckAssets: 2,
        },
    ])(
        "retains completed facts through final read I/O failure: $name",
        async ({ name, inputHeight, expectedNativeSize, expectedStoredSize, nativeMatches, failureStatus, hardFailureKeys, recheckBatch, recheckRunStatus, recheckTechnicalStatus, recheckAssets }) => {
            nativeResults = [{ dataUrl: await image(120, inputHeight, "red") }, { dataUrl: baseline }];
            const { initial } = await prepareDeliveryFixture(`final-read-${name}`, false);
            const scheduler = await import("./generation-task-scheduler");
            const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
            expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-final-read-first-observation", taskIds: [initial.id], limit: 1 })).toMatchObject({
                claimed: 1,
                pending: 1,
                completed: 0,
                failed: 0,
            });
            assert.ok(childBeforeQuality);
            const completed = await completedFinalState(childBeforeQuality);
            const observing = (await getAgentRun(initial.id))!;
            expect(observing.tasks[0]).toMatchObject({ status: "running", attempts: 1, taskIds: [childBeforeQuality.id], childTasks: [{ id: childBeforeQuality.id, status: "pending", attempt: 1 }] });
            finalRead.path = completed.final.filePath;
            finalRead.armed = true;
            await scheduler.scheduleGenerationTask("agent", initial.id, { nextPollAt: Date.now() });
            expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-final-read-stable-observation", taskIds: [initial.id], limit: 1 })).toMatchObject({
                claimed: 1,
                completed: 0,
                failed: 1,
            });
            const paused = (await getAgentRun(initial.id))!;
            expect(finalRead.failures).toBe(1);
            expect(paused).toMatchObject({ status: "paused", assetIds: [], ecommerceSnapshot: { technicalCheck: { status: failureStatus } } });
            expect(paused.ecommerceSnapshot?.technicalCheck?.canvasEvidence?.[0]).toMatchObject({ resultId: completed.resultId, nativeSize: expectedNativeSize, nativeMatches, storedStatus: "unavailable", storedMatches: null });
            expect(paused.ecommerceSnapshot?.technicalCheck?.hardFailures.map((failure) => failure.key)).toEqual(hardFailureKeys);
            expect(publicAgentRun(paused)).toMatchObject({ status: "paused", assetIds: [], ecommerceQualityStatus: "needs_review" });
            expect(paused.ecommerceSnapshot?.qualityCheck).toBeUndefined();
            expect(JSON.stringify({ run: publicAgentRun(paused), events: (await listCreativeRunEvents(paused.id)).map(publicAgentRunEvent) })).not.toMatch(/private-final-read-unavailable|batchEvidence|canvasEvidence|"stack"/);
            const intact = await completedFinalState((await getImageTask(childBeforeQuality.id))!);
            expect(intact.stage).toEqual(completed.stage);
            expect(intact.final.registration).toEqual(completed.final.registration);
            expect(intact.bytes).toEqual(completed.bytes);
            expect(intact.image.nativeResults).toEqual(completed.image.nativeResults);
            expect(intact.image.resultProcessing).toEqual(completed.image.resultProcessing);
            expect(intact.image.result).toEqual(completed.image.result);
            expect(intact.image.billing).toEqual(completed.image.billing);
            finalRead.armed = false;
            const { readCompletedImageTaskResult } = await import("./image-task-result-processing");
            expect(await readCompletedImageTaskResult(paused, intact.image, intact.resultId)).toMatchObject({ resultId: intact.resultId, nativeSize: expectedNativeSize, storedSize: expectedStoredSize });
            const { setAgentRunStatus } = await import("./agent-run-store");
            expect(await setAgentRunStatus(paused, "running")).not.toBeNull();
            await scheduler.scheduleGenerationTask("agent", paused.id, { executionPhase: "created", nextPollAt: Date.now() });
            expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-final-read-recheck", taskIds: [paused.id], limit: 1 })).toMatchObject(recheckBatch);
            const rechecked = (await getAgentRun(paused.id))!;
            expect(rechecked).toMatchObject({ status: recheckRunStatus, ecommerceSnapshot: { technicalCheck: { status: recheckTechnicalStatus } } });
            expect(rechecked.assetIds).toHaveLength(recheckAssets);
            expect(rechecked.tasks[0]).toMatchObject({ id: observing.tasks[0].id, attempts: 1, taskIds: [childBeforeQuality.id], childTasks: [{ id: childBeforeQuality.id, status: "completed", attempt: 1 }] });
            const recheckedImage = (await getImageTask(childBeforeQuality.id))!;
            expect(recheckedImage.nativeResults).toEqual(intact.image.nativeResults);
            expect(recheckedImage.resultProcessing).toEqual(intact.image.resultProcessing);
            expect(recheckedImage.result).toEqual(intact.image.result);
            expect(recheckedImage.upstream).toEqual(intact.image.upstream);
            expect(recheckedImage.billing).toEqual(intact.image.billing);
            expect(await getStoredGenerationTaskRecord("image_processing", intact.stage.id)).toEqual(intact.stage);
            expect(await readFile(intact.final.filePath)).toEqual(intact.bytes);
            expect(childIds).toEqual([childBeforeQuality.id]);
            expect(boundary.create).toHaveBeenCalledTimes(1);
            expect(boundary.submit).toHaveBeenCalledTimes(1);
            expect(boundary.poll).toHaveBeenCalledTimes(1);
            expect(boundary.refund).not.toHaveBeenCalled();
            expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
        },
    );

    it("persists the pre-submission review reason from the child GET through the agent and assistant", async () => {
        const reason = "当前协议不支持可信独立蒙版，请选择支持局部编辑的模型。";
        const conversation = await createCreativeConversation("batch-user", { surface: "chat" });
        const initial = (await createAgentRun("batch-user", { clientRequestId: "pre-submission-review", conversationId: conversation.id, surface: "chat", prompt: "只修改选区内的花瓶", assetIds: [], skillIds: [], modelIds: [] })).run;
        const run = (await updateAgentRunById(initial.id, { status: "running", executionId: "review-executor", reviewed: true, tasks: [{ ...imageTask("local-edit"), model: "image-model" }] }))!;
        boundary.request.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/image-tasks") && init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                const child = await createImageTask({
                    ...body,
                    ...body.context,
                    userId: "batch-user",
                    username: "fixture-user",
                    displayName: "Fixture User",
                    config: { ...body.config, ...toSystemGenerationChannel(routeEcommerceRole(boundary.settings, "image_generation")!) },
                });
                childIds.push(child.id);
                await schedulePreparedImageTask(child, reason);
                return Response.json({ task: { id: child.id } });
            }
            if (/\/api\/image-tasks\//.test(url) && !init?.method) return getPublicImageTask(new Request(url), { params: Promise.resolve({ id: url.split("/").at(-1)! }) });
            throw new Error("unexpected fixture transport");
        });

        await executeTasks(run.id, "http://fixture.local", "session=fixture", "review-executor", boundary.settings);

        const paused = (await getAgentRun(run.id))!;
        expect(paused).toMatchObject({
            status: "paused",
            tasks: [{ status: "needs_review", attempts: 1, taskId: childIds[0], taskIds: childIds, error: reason, childTasks: [{ id: childIds[0], status: "needs_review", attempt: 1, error: reason }] }],
        });
        expect(publicAgentRun(paused).tasks[0]).toMatchObject({ status: "needs_review", error: reason });
        const events = await listCreativeRunEvents(run.id);
        expect(events.map(publicAgentRunEvent)).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: "task.needs_review", data: expect.objectContaining({ error: reason }) }), expect.objectContaining({ type: "run.paused", data: { message: reason } })]),
        );
        expect((await listCreativeMessages(conversation.id)).find((message) => message.id === run.assistantMessageId)).toMatchObject({ content: reason, status: "running" });
        const schedule = await getStoredGenerationTaskRecord("image", childIds[0]);
        expect(schedule).toMatchObject({ executionPhase: "needs_review", lastUpstreamStatus: "strict_product_mask_review_required" });
        expect(schedule?.submittedAt).toBeFalsy();
        expect((await getImageTask(childIds[0]))?.upstream).toBeUndefined();
        await executeTasks(run.id, "http://fixture.local", "session=fixture", "review-executor", boundary.settings);
        expect(await getAgentRun(run.id)).toEqual(paused);
        expect((await listCreativeMessages(conversation.id)).find((message) => message.id === run.assistantMessageId)?.content).toBe(reason);
        expect(childIds).toHaveLength(1);
        expect(boundary.create).not.toHaveBeenCalled();
        expect(boundary.poll).not.toHaveBeenCalled();
    });

    it("resumes the same unsubmitted pending masked child without creating another child", async () => {
        const channel = boundary.settings.systemChannels.find((value) => value.id === "image-channel")!;
        channel.models = ["gpt-image-2.5-flare"];
        channel.advancedConfig = { ...emptyAdvancedConfig(), protocol: "sub2api", supportsReferenceImage: true };
        boundary.settings.logicalModels.find((model) => model.id === "image-model")!.bindings[0].upstreamModel = "gpt-image-2.5-flare";
        const candidate = routeEcommerceRole(boundary.settings, "image_generation")!;
        const config = toSystemGenerationChannel(candidate);
        const source = Buffer.from(baseline.split(",")[1], "base64");
        const region = { x: 20, y: 50, width: 35, height: 30 };
        const sceneProtection = { ...(await buildSceneEditProtection(source, "scene-root", region, ["vase", "contact shadow"], "user_selection")), confirmation: { actorUserId: "batch-user", confirmedAt: Date.now() } };
        const conversation = await createCreativeConversation("batch-user", { surface: "chat" });
        const initial = (await createAgentRun("batch-user", { clientRequestId: "pending-mask-recovery", conversationId: conversation.id, surface: "chat", prompt: "只修改选区内的花瓶", assetIds: [], skillIds: [], modelIds: [] })).run;
        const plan: EcommerceEditPlan = {
            planVersion: "ecommerce-edit.v4",
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene-root", sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye level", lighting: "daylight" } },
            delta: { requestedChanges: ["replace vase"], targetObjects: ["vase"], targetRegions: ["cabinet top"], manualRegion: region },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            strategy: "integrated_scene",
            modelRoles: { visionAnalysis: "planner", editPlanning: "planner", generation: "image-model", qualityCheck: null },
            continuity: { parentResultId: null, branchId: "pending-mask-branch" },
            validation: { requiredChecks: ["requested_edit"] },
            canvas: { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false },
            protection: { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false },
        };
        const execution = compileEcommerceImageRequest(plan, resolveEcommerceImageProviderProfile(candidate.snapshot)!);
        expect(execution).toMatchObject({ state: "ready", mask: { mode: "independent", required: true }, modelSnapshot: { imageEdit: { protocol: "sub2api", transport: "json", supportsIndependentMask: true } } });
        const child = await createImageTask({
            userId: initial.userId,
            username: "fixture-user",
            displayName: "Fixture User",
            runId: initial.id,
            conversationId: conversation.id,
            parentTaskId: "local-edit",
            source: "agent",
            kind: "edit",
            prompt: execution.prompt,
            config: { ...config, size: "120x160" },
            references: [{ id: "scene-root", name: "scene.png", dataUrl: baseline, ecommerceRole: "scene" }],
            mask: sceneProtection.mask,
            sceneProtection,
            ecommerceExecution: execution,
            attempts: [],
        });
        const reason = "当前协议不支持可信独立蒙版，请选择支持局部编辑的模型。";
        await schedulePreparedImageTask(child, reason);
        const task: AgentRunTask = {
            ...imageTask("local-edit"),
            prompt: execution.prompt,
            optimizedPrompt: initial.prompt,
            status: "needs_review",
            attempts: 1,
            taskId: child.id,
            taskIds: [child.id],
            childTasks: [{ id: child.id, status: "needs_review", attempt: 1, error: reason }],
            references: [{ assetId: "scene-root", url: baseline, type: "image", ecommerceRole: "scene" }],
            sceneProtection,
            ecommerceExecution: execution,
            error: reason,
        };
        const paused = (await updateAgentRunById(initial.id, {
            status: "paused",
            tasks: [task],
            reviewed: true,
            ecommerceSnapshot: {
                version: "ecommerce-generation.v1",
                mode: "active",
                qualityPolicy: "disabled",
                input: { userRequest: initial.prompt, assetIds: ["scene-root"], conversationId: conversation.id, surface: "chat" },
                plan,
                createdAt: Date.now(),
                runId: initial.id,
                userId: initial.userId,
            },
        }))!;
        expect(await getStoredGenerationTaskRecord("image", child.id)).toMatchObject({ status: "pending", executionPhase: "needs_review" });
        expect((await getImageTask(child.id))?.attempts).toEqual([]);
        const { publicAgentRunForRequest } = await import("./agent-run-public-selection");
        expect(await publicAgentRunForRequest(paused, new Request("http://fixture.local/api/agent-runs/fixture"))).toMatchObject({ canCheckStatus: true });
        boundary.create.mockResolvedValue({ dataUrl: await image(120, 160, "red") });
        const originalTransport = boundary.request.getMockImplementation()!;
        boundary.request.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                expect(url).toBe(`http://fixture.local/api/image-tasks/${child.id}`);
                expect(JSON.parse(String(init.body))).toEqual({ action: "recover" });
                return recoverPublicImageTask(new Request(url, init), { params: Promise.resolve({ id: child.id }) });
            }
            return originalTransport(url, init);
        });
        const resumed = (await updateAgentRunById(paused.id, { status: "running", executionId: "mask-resume-executor" }, undefined, ["paused"]))!;
        await executeTasks(resumed.id, "http://fixture.local", "session=fixture", "mask-resume-executor", boundary.settings);
        expect(await getAgentRun(resumed.id)).toMatchObject({ status: "running", tasks: [{ taskId: child.id, taskIds: [child.id], attempts: 1 }] });
        expect(await getStoredGenerationTaskRecord("image", child.id)).toMatchObject({ executionPhase: "result_ready" });
        const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
        expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", publicOrigin: "https://public.example", cookie: "session=fixture", limit: 1, taskIds: [child.id] })).toMatchObject({ claimed: 1, completed: 1 });
        await executeTasks(resumed.id, "http://fixture.local", "session=fixture", "mask-resume-executor", boundary.settings);
        const completed = (await getAgentRun(resumed.id))!;
        const recovered = (await getImageTask(child.id))!;
        expect(completed).toMatchObject({ status: "completed", tasks: [{ taskId: child.id, taskIds: [child.id], attempts: 1, childTasks: [{ id: child.id, status: "completed", attempt: 1 }] }] });
        expect(recovered).toMatchObject({ status: "success", sceneProtection, mask: sceneProtection.mask, attempts: [{ attemptNo: 1, status: "succeeded" }] });
        expect(recovered.result?.sceneProtectionEvidence).toMatchObject({ nativeOutsideChangedPixels: 18150, compositeOutsideChangedPixels: 0 });
        expect(boundary.create).toHaveBeenCalledTimes(1);
        expect(boundary.create.mock.calls[0][0]).toMatchObject({ id: child.id, sceneProtection, mask: sceneProtection.mask });
        expect(boundary.poll).not.toHaveBeenCalled();
        expect(boundary.structured).not.toHaveBeenCalled();
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
        expect(childIds).toEqual([]);
        await executeTasks(completed.id, "http://fixture.local", "session=fixture", "mask-resume-executor", boundary.settings);
        expect(boundary.create).toHaveBeenCalledTimes(1);
        expect((await getAgentRun(completed.id))?.tasks[0].taskIds).toEqual([child.id]);
    });

    async function prepareBatchFixture(missingIndex: number | null) {
        nativeResults = [baseline, await image(120, 160, "red"), baseline].map((dataUrl, index) => ({
            dataUrl: index === missingIndex ? "https://fixture.invalid/unreadable.png" : dataUrl,
            remoteUrl: "https://fixture.example/shared-result.png",
        }));
        const { initial } = await prepareDeliveryFixture(`batch-${missingIndex}`, false);
        const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
        expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-batch-first-observation", taskIds: [initial.id], limit: 1 })).toMatchObject({
            claimed: 1,
            pending: 1,
            completed: 0,
            failed: 0,
        });
        const observing = (await getAgentRun(initial.id))!;
        assert.ok(observing.executionId && childBeforeQuality?.nativeResults && childBeforeQuality.resultProcessing);
        expect(observing.ecommerceSnapshot?.qualityPolicy).toBe("disabled");
        expect(observing.tasks[0]).toMatchObject({ status: "running", attempts: 1, error: "图像结果处理状态已变化，请稍后检查。", taskIds: [childBeforeQuality.id], childTasks: [{ id: childBeforeQuality.id, status: "pending", attempt: 1 }] });
        expect(childBeforeQuality).toMatchObject({ status: "success", runId: initial.id, parentTaskId: initial.id, upstream: { id: "original-upstream" } });
        return { observing, executionId: observing.executionId, image: childBeforeQuality };
    }

    it.each([
        { name: "unreadable_first", missingIndex: 0, expectedStoredIndices: [2, 3] },
        { name: "unreadable_middle", missingIndex: 1, expectedStoredIndices: [1, 3] },
        { name: "unreadable_last", missingIndex: 2, expectedStoredIndices: [1, 2] },
    ])("retains the original child/upstream through $name recovery", async ({ missingIndex, expectedStoredIndices }) => {
        const { observing, executionId, image: original } = await prepareBatchFixture(missingIndex);
        expect(await runTaskWithRetry(observing.id, observing.tasks[0], "http://fixture.local", "session=fixture", executionId, boundary.settings)).toBe("needs_review");
        const paused = (await getAgentRun(observing.id))!;
        const image = (await getImageTask(original.id))!;
        expect(paused).toMatchObject({ status: "paused", assetIds: [], ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "unavailable", hardFailures: [] } } });
        expect(paused.ecommerceSnapshot?.qualityCheck).toBeUndefined();
        expect(paused.ecommerceSnapshot?.technicalCheck?.canvasEvidence?.map((slot) => slot.resultId)).toEqual([image.id + ":1", image.id + ":2", image.id + ":3"]);
        expect(image.result?.results).toHaveLength(2);
        expect(image.result?.batchEvidence).toHaveLength(3);
        expect(image.result?.batchEvidence?.filter((slot) => slot.storageStatus === "stored").map((slot) => slot.resultIndex)).toEqual(expectedStoredIndices);
        expect(image).toMatchObject({ status: "success", attemptNo: 1, upstream: original.upstream, nativeResults: original.nativeResults, resultProcessing: original.resultProcessing, result: original.result });
        expect(publicAgentRun(paused)).toMatchObject({ status: "paused", assetIds: [], ecommerceQualityStatus: "needs_review" });
        const publicData = { run: publicAgentRun(paused), events: (await listCreativeRunEvents(paused.id)).map(publicAgentRunEvent), logs: await listGenerationLogs({ userId: "batch-user" }) };
        expect(JSON.stringify(publicData)).not.toMatch(/batchEvidence|canvasEvidence|failureReason/);
        const { setAgentRunStatus } = await import("./agent-run-store");
        expect(await setAgentRunStatus(paused, "running")).not.toBeNull();
        const { scheduleGenerationTask } = await import("./generation-task-scheduler");
        const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
        await scheduleGenerationTask("agent", paused.id, { executionPhase: "created", nextPollAt: Date.now() });
        expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", cookie: "session=fixture", workerId: "fixture-partial-native-recheck", taskIds: [paused.id], limit: 1 })).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
        const rechecked = (await getAgentRun(paused.id))!;
        expect(rechecked).toMatchObject({ status: "paused", assetIds: [], ecommerceSnapshot: { technicalCheck: { status: "unavailable" } } });
        expect(rechecked.tasks[0]).toMatchObject({ id: observing.tasks[0].id, attempts: 1, taskIds: [image.id], childTasks: [{ id: image.id, status: "completed", attempt: 1 }] });
        const recheckedImage = (await getImageTask(image.id))!;
        expect(recheckedImage.nativeResults).toEqual(image.nativeResults);
        expect(recheckedImage.resultProcessing).toEqual(image.resultProcessing);
        expect(recheckedImage.result).toEqual(image.result);
        expect(recheckedImage.billing).toEqual(image.billing);
        expect(childIds).toEqual([image.id]);
        expect(boundary.create).toHaveBeenCalledTimes(1);
        expect(boundary.submit).toHaveBeenCalledTimes(1);
        expect(boundary.poll).toHaveBeenCalledTimes(1);
        expect(boundary.refund).not.toHaveBeenCalled();
        expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
    });

    it("retains all completed slots behind one shared upstream URL", async () => {
        const { observing, executionId, image: original } = await prepareBatchFixture(null);
        expect(await runTaskWithRetry(observing.id, observing.tasks[0], "http://fixture.local", "session=fixture", executionId, boundary.settings)).toBe("completed");
        await executeTasks(observing.id, "http://fixture.local", "session=fixture", executionId, boundary.settings);
        const completed = (await getAgentRun(observing.id))!;
        const image = (await getImageTask(original.id))!;
        expect(completed).toMatchObject({ status: "completed", ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "passed", hardFailures: [] } } });
        expect(completed.ecommerceSnapshot?.qualityCheck).toBeUndefined();
        expect(completed.assetIds).toHaveLength(3);
        expect(completed.ecommerceSnapshot?.technicalCheck?.canvasEvidence?.map((slot) => slot.resultId)).toEqual([image.id + ":1", image.id + ":2", image.id + ":3"]);
        expect(image.result?.results).toHaveLength(3);
        expect(image.result?.batchEvidence?.map((slot) => slot.resultIndex)).toEqual([1, 2, 3]);
        expect(image).toMatchObject({ status: "success", attemptNo: 1, upstream: original.upstream, nativeResults: original.nativeResults, resultProcessing: original.resultProcessing, result: original.result });
        expect(completed.tasks[0]).toMatchObject({ id: observing.tasks[0].id, attempts: 1, taskIds: [image.id], childTasks: [{ id: image.id, status: "completed", attempt: 1 }] });
        const visible = publicAgentRun(completed);
        expect(visible).toMatchObject({ status: "completed", assetIds: completed.assetIds });
        expect(visible).not.toHaveProperty("ecommerceQualityStatus");
        expect(childIds).toEqual([image.id]);
        expect(boundary.create).toHaveBeenCalledTimes(1);
        expect(boundary.submit).toHaveBeenCalledTimes(1);
        expect(boundary.poll).toHaveBeenCalledTimes(1);
        expect(boundary.refund).not.toHaveBeenCalled();
        expect(boundary.structured.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
    });
});

async function image(width: number, height: number, background: string) {
    return (
        "data:image/png;base64," +
        (
            await sharp({ create: { width, height, channels: 3, background } })
                .png()
                .toBuffer()
        ).toString("base64")
    );
}
