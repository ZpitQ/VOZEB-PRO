import assert from "node:assert/strict";
import { persistFrozenEcommercePlan } from "./ecommerce-protection.test-fixtures";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";
import type { AuthSettings } from "@/lib/auth/store";
import type { ImageProcessingOperation } from "../image-processing/contracts";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { ImageTask } from "./image-task-store";
import type { ClosedImageProcessingFailure } from "./image-processing-service";
import type { StructuredTextRequest } from "./text-planning-runtime";
import { settings } from "./agent-run-executor.test-fixtures";

const boundary = vi.hoisted(() => ({
    settings: vi.fn<() => Promise<AuthSettings>>(),
    request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
    model: vi.fn<typeof import("./text-planning-runtime").requestStructuredText>(),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => ({ id: "agent-plan-protection-user" }) }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/auth/store", async (original) => ({ ...(await original<typeof import("@/lib/auth/store")>()), getAuthSettings: boundary.settings }));
vi.mock("./internal-origin", async (original) => ({ ...(await original<typeof import("./internal-origin")>()), fetchInternalApi: boundary.request }));
vi.mock("./text-planning-runtime", async (original) => ({ ...(await original<typeof import("./text-planning-runtime")>()), requestStructuredText: boundary.model }));
vi.mock("./object-storage-service", async (original) => ({ ...(await original<typeof import("./object-storage-service")>()), persistExternalMediaIfEnabled: async () => null }));
vi.mock("./safe-outbound-fetch", async (original) => ({
    ...(await original<typeof import("./safe-outbound-fetch")>()),
    fetchSafeOutbound: async () => {
        throw new Error("Fixture forbids outbound HTTP");
    },
}));

const historicalPlanning = vi.hoisted(() => ({ stopped: false }));
vi.mock("./ecommerce-protection-preparation", async (original) => {
    const actual = await original<typeof import("./ecommerce-protection-preparation")>();
    return {
        ...actual,
        prepareEcommerceFullImageTask: async () => {
            historicalPlanning.stopped = true;
            return undefined;
        },
    };
});

describe("Agent recovers archived protection plans through native stages in the same Run", () => {
    let directory: string;
    let runtime: typeof import("./creative-runtime-store");
    let runs: typeof import("./agent-run-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let references: typeof import("./reference-asset-store");
    let executor: typeof import("./agent-run-executor");
    let service: typeof import("./image-processing-service");
    const userId = "agent-plan-protection-user";
    const origin = "http://fixture.local";
    const productFacts = { identity: "cabinet", outline: "rectangular cabinet", color: "oak", material: "wood", brandText: [], view: "front" };
    const sceneFacts = { space: "living room", composition: "eye level", lighting: "soft daylight" };

    beforeEach(async () => {
        vi.resetModules();
        historicalPlanning.stopped = false;
        boundary.settings.mockReset();
        boundary.request.mockReset();
        boundary.model.mockReset();
        directory = await mkdtemp(join(tmpdir(), "vozeb-agent-plan-protection-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const configured: AuthSettings = settings("image-model", "image-channel");
        configured.ecommerceGenerationEnabled = true;
        configured.ecommerceVisualQualityCheckEnabled = false;
        configured.ecommerceModelRoles = { vision_analysis: ["planner"], edit_planning: ["planner"], image_generation: ["image-model"], quality_check: [] };
        configured.systemChannels[1].models = ["gpt-image-2.5-flare"];
        configured.logicalModels[1].bindings[0].upstreamModel = "gpt-image-2.5-flare";
        boundary.settings.mockResolvedValue(configured);
        [runtime, runs, tasks, scheduler, references, executor, service] = await Promise.all([
            import("./creative-runtime-store"),
            import("./agent-run-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./reference-asset-store"),
            import("./agent-run-executor"),
            import("./image-processing-service"),
        ]);
        const { getDatabaseProvider } = await import("./database");
        expect(getDatabaseProvider()).toBe("file");
        boundary.request.mockImplementation(async (url, init) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/api/image-tasks" && init?.method === "POST") return new Response("Fixture stops at the downstream image submission boundary", { status: 502 });
            expect(init?.method || "GET").toBe("GET");
            expect(parsed.pathname).toMatch(/^\/api\/reference-assets\//);
            const media = await references.readReferenceAsset(decodeURIComponent(parsed.pathname.slice("/api/reference-assets/".length)));
            assert(media, "Fixture HTTP must read actual registered media");
            expect(media.registration?.ownerUserId).toBe(userId);
            return new Response(new Uint8Array(await readFile(media.filePath)), { headers: { "content-type": media.mimeType } });
        });
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    async function registerSource(conversationId: string, ordinal: number, source: Buffer) {
        const stored = await references.writeReferenceImageDataUrl("data:image/png;base64," + source.toString("base64"), { ownerUserId: userId, conversationId, source: "fixture-agent-plan-protection" });
        const media = await references.readReferenceAsset(stored.token);
        assert(media);
        expect(media.registration).toMatchObject({ ownerUserId: userId, storageKey: stored.token, scope: "reference" });
        expect(await readFile(media.filePath)).toEqual(source);
        const [asset] = await runtime.registerCreativeAssets([
            { userId, conversationId, ordinal, type: "image", title: "reference.png", sourceRunId: "upload", serverUrl: "/api/reference-assets/" + stored.token, storageKey: stored.token, width: 100, height: 80, metadata: {} },
        ]);
        return { asset, sourceSha256: createHash("sha256").update(source).digest("hex") };
    }

    async function claimAndExecute(runId: string, workerId: string) {
        const due = await tasks.getStoredGenerationTaskRecord("agent", runId);
        assert(due);
        expect(due.workerId).toBeUndefined();
        expect(due.leaseUntil).toBeUndefined();
        expect(due.nextPollAt).toBeGreaterThan(0);
        expect(await scheduler.claimDueGenerationTasks({ workerId, taskIds: [runId], limit: 1 })).toMatchObject([{ id: runId, workerId }]);
        const current = await runs.getAgentRun(runId);
        assert(current);
        await executor.executeAgentRun(current, origin, "session=fixture");
        let saved = await runs.getAgentRun(runId);
        assert(saved);
        if (historicalPlanning.stopped) {
            historicalPlanning.stopped = false;
            saved = await persistFrozenEcommercePlan(saved, origin, "session=fixture");
            const released = await scheduler.releaseGenerationTaskLease("agent", runId, workerId, { executionPhase: "created", nextPollAt: Date.now() });
            assert(released);
            return claimAndExecute(runId, workerId + "-historical");
        }
        return saved;
    }

    async function waitingStage(runId: string, operation: "prepare_reference" | "build_protection", count: number, parentTaskId: string) {
        const run = await runs.getAgentRun(runId);
        assert(run?.ecommerceSnapshot);
        const children = (await tasks.listStoredGenerationTaskRecordsByRunIds([runId], [userId])).filter((record) => record.type === "image_processing" && record.payload.operation === operation);
        const diagnostic = JSON.stringify({
            status: run.status,
            failure: run.failure,
            fallback: run.ecommerceSnapshot.fallback,
            tasks: run.tasks,
            children,
            modelTools: boundary.model.mock.calls.map(([request]) => request.tool.name),
            http: boundary.request.mock.calls.map(([url, init]) => ({ url, method: init?.method || "GET" })),
        });
        expect(children, diagnostic).toHaveLength(count);
        const waiting = run.ecommerceSnapshot.processing?.waitingFor;
        assert(waiting, diagnostic);
        const stage = await tasks.getStoredGenerationTaskRecord("image_processing", waiting.jobId);
        assert(stage);
        expect(stage).toMatchObject({ userId, runId, parentTaskId, status: "pending", payload: { operation } });
        expect(waiting.inputDigest).toBe(stage.payload.inputDigest);
        expect(run.executionId).toBeUndefined();
        const parent = await tasks.getStoredGenerationTaskRecord("agent", runId);
        assert(parent);
        expect(parent.workerId).toBeUndefined();
        expect(parent.leaseUntil).toBeUndefined();
        expect(parent.nextPollAt).toBeUndefined();
        return stage;
    }

    async function completeStage(jobId: string) {
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const workerId = "plan-protection-image-worker";
        const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const task = claimed.tasks[0];
        expect(task.id).toBe(jobId);
        assert(task.payload.operation === "prepare_reference" || task.payload.operation === "build_protection");
        const identity = { workerId, executionId: task.executionId };
        const taskDirectory = await mkdtemp(join(directory, "native-stage-"));
        const inputPath = join(taskDirectory, "source.png");
        const source = await service.readImageProcessingInput(jobId, task.payload.inputs[0].assetId, identity);
        await pipeline(source.stream, createWriteStream(inputPath, { flags: "wx" }));
        const outputDirectory = join(taskDirectory, "outputs");
        await mkdir(outputDirectory);
        const operation: ImageProcessingOperation = task.payload.operation === "prepare_reference" ? { operation: "prepare_reference", options: {} } : { operation: "build_protection", options: task.payload.options };
        const outcome = await runImageProcessing(
            { ...operation, version: "image-processing.v1", jobId, executionId: identity.executionId, inputs: [{ ...task.payload.inputs[0], path: inputPath }], outputDirectory },
            { taskDirectory, maxHeapMiB: task.payload.resource.configuration.processHeapMb },
        );
        expect(outcome).toMatchObject({ status: "completed", jobId, executionId: identity.executionId, exitCode: 0, signal: null });
        expect(outcome.pid).toBeGreaterThan(0);
        assert(outcome.status === "completed");
        const { artifacts, metrics, ...manifest } = outcome.result;
        expect(artifacts).toHaveLength(1);
        const native = artifacts[0];
        expect(native.kind).toBe(task.payload.operation === "prepare_reference" ? "analysis" : "mask");
        assert(native.kind === "analysis" || native.kind === "mask");
        const bytes = await readFile(native.path);
        const response = new Response(new Uint8Array(bytes));
        assert(response.body);
        const artifact = await service.writeImageProcessingOutput(jobId, native.kind, identity, { stream: response.body, mimeType: native.mimeType });
        expect(artifact).toMatchObject({ kind: native.kind, sha256: native.sha256, bytes: native.bytes, width: native.width, height: native.height });
        const completedManifest = { ...manifest, artifacts: [artifact] };
        expect(await service.completeImageProcessingTask(jobId, { ...identity, manifest: completedManifest, metrics })).toMatchObject({ jobId, executionId: identity.executionId, parentRescheduled: true });
        return { payload: task.payload, manifest: completedManifest, artifact };
    }

    function modelReply(value: unknown) {
        return { arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat" as const, elapsedMs: 1 };
    }

    type PlannerMessage = {
        sources: { productAnchorId: string | null; currentSceneBaselineId: string | null; sceneReferenceIds: string[] };
        requiredModelRoles: EcommerceEditPlan["modelRoles"];
        continuity: EcommerceEditPlan["continuity"];
        visualAnalysis: { references: Array<{ assetId: string; alias: string | null; purposes: string[]; productFacts: EcommerceEditPlan["baseline"]["productFacts"]; sceneFacts: EcommerceEditPlan["baseline"]["sceneFacts"] }> };
    };

    function installModelReplies(analysis: unknown, operation: "product_to_scene" | "local_edit") {
        boundary.model.mockImplementation(async (request: StructuredTextRequest) => {
            if (request.tool.name === "analyze_ecommerce_references") return modelReply(analysis);
            expect(request.tool.name).toBe("plan_ecommerce_edit");
            const user = request.messages.find((message) => message.role === "user");
            assert(user && typeof user.content === "string");
            const input: PlannerMessage = JSON.parse(user.content);
            const product = input.visualAnalysis.references.find((reference) => reference.assetId === input.sources.productAnchorId);
            const scene = input.visualAnalysis.references.find((reference) => reference.assetId === input.sources.currentSceneBaselineId);
            assert(product?.productFacts, "The real planner must receive a confirmed product anchor");
            return modelReply({
                planVersion: "ecommerce-edit.v7",
                operation,
                source: { productAnchorId: input.sources.productAnchorId, currentSceneBaselineId: input.sources.currentSceneBaselineId, sceneReferenceIds: input.sources.sceneReferenceIds },
                baseline: { productFacts: product.productFacts, sceneFacts: scene?.sceneFacts ?? null },
                delta: { requestedChanges: ["把背景换成厨房"], targetObjects: ["background-main"], targetRegions: [] },
                preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
                strategy: "full_image",
                modelRoles: input.requiredModelRoles,
                continuity: input.continuity,
                referenceUses: input.visualAnalysis.references.map((reference) => ({ assetId: reference.assetId, alias: reference.alias, purposes: reference.purposes, usedCueIds: [] })),
                validation: { requiredChecks: ["product_identity"] },
            });
        });
    }

    function productObservation(assetId: string, transparentBackground: boolean) {
        return {
            assetId,
            contentType: "isolated_product",
            confidence: "high",
            visualEvidence: { whiteBackground: !transparentBackground, transparentBackground, isolatedSubject: true, completeScene: false },
            productFacts,
            sceneFacts: null,
            productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
            fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
            editableTargets: [],
            visibleStructure: [],
            cues: [],
        };
    }

    function sceneObservation(assetId: string) {
        return {
            assetId,
            contentType: "interior_scene",
            confidence: "high",
            visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
            productFacts: null,
            sceneFacts,
            productCore: { x: 0.4, y: 0.25, width: 0.2, height: 0.5 },
            fusionHalo: { x: 0.35, y: 0.2, width: 0.3, height: 0.6 },
            editableTargets: [{ id: "background-main", kind: "background", label: "main background", region: { x: 0, y: 0, width: 1, height: 1 } }],
            visibleStructure: [],
            cues: [],
        };
    }

    async function productSource(alpha: number) {
        return sharp({ create: { width: 100, height: 80, channels: 4, background: { r: 255, g: 255, b: 255, alpha } } })
            .composite([{ input: { create: { width: 32, height: 40, channels: 4, background: "#8a6243" } }, left: 34, top: 20 }])
            .png()
            .toBuffer();
    }

    async function startRun(conversationId: string, assetIds: string[], prompt: string) {
        const { run } = await runs.createAgentRun(userId, { clientRequestId: "plan-before-protection", conversationId, surface: "chat", prompt, assetIds, skillIds: [], modelIds: [], preferences: { mode: "image" } });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        await claimAndExecute(run.id, "prepare-parent-one");
        return run;
    }

    async function completeReference(runId: string, assetId: string, count: number) {
        const stage = await waitingStage(runId, "prepare_reference", count, runId);
        expect(stage.payload.inputs).toMatchObject([{ assetId }]);
        expect(boundary.model).not.toHaveBeenCalled();
        await completeStage(stage.id);
        return stage.id;
    }

    async function arrangeProduct(conversationId: string, alpha: number, transparentBackground: boolean) {
        const product = await registerSource(conversationId, 0, await productSource(alpha));
        installModelReplies({ analysisVersion: "ecommerce-visual-analysis.v4", references: [productObservation(product.asset.id, transparentBackground)], purposeSuggestions: [] }, "product_to_scene");
        const run = await startRun(conversationId, [product.asset.id], "修改图片1，把背景换成厨房，保留商品外观");
        const prepareJob = await completeReference(run.id, product.asset.id, 1);
        const planned = await claimAndExecute(run.id, "planning-parent");
        return { run, planned, product, baseline: product, prepareJobs: [prepareJob] };
    }

    async function arrangeWhite(conversationId: string) {
        return arrangeProduct(conversationId, 1, false);
    }

    async function arrangeTransparent(conversationId: string) {
        return arrangeProduct(conversationId, 0, true);
    }

    async function arrangeLocal(conversationId: string, prompt = "参考图片1的商品身份，把图片2 这张图修改成厨房背景并保留商品外观", createProduct = productSource) {
        const product = await registerSource(conversationId, 0, await createProduct(1));
        const sceneBytes = await sharp({ create: { width: 100, height: 80, channels: 4, background: "#a0b0c0" } })
            .composite([{ input: { create: { width: 20, height: 40, channels: 4, background: "#8a6243" } }, left: 40, top: 20 }])
            .png()
            .toBuffer();
        const scene = await registerSource(conversationId, 1, sceneBytes);
        installModelReplies(
            {
                analysisVersion: "ecommerce-visual-analysis.v4",
                references: [productObservation(product.asset.id, false), sceneObservation(scene.asset.id)],
                purposeSuggestions: [
                    { assetId: product.asset.id, purposes: ["product_identity"], confidence: "high" },
                    { assetId: scene.asset.id, purposes: ["edit_target"], confidence: "high" },
                ],
            },
            "local_edit",
        );
        const run = await startRun(conversationId, [product.asset.id, scene.asset.id], prompt);
        const firstPrepare = await completeReference(run.id, product.asset.id, 1);
        await claimAndExecute(run.id, "prepare-parent-two");
        const secondPrepare = await completeReference(run.id, scene.asset.id, 2);
        const planned = await claimAndExecute(run.id, "planning-parent");
        return { run, planned, product, baseline: scene, prepareJobs: [firstPrepare, secondPrepare] };
    }

    async function arrangeGlobalLighting(conversationId: string) {
        const fixture = await arrangeLocal(conversationId, "参考图片1的商品身份，把图片2的自然光略微提亮，保留商品外观");
        expect(fixture.planned.ecommerceSnapshot?.plan?.protection).toMatchObject({ scope: "global", protectedObjectIds: [fixture.product.asset.id], preserveOutsideMask: false, allowLightingChange: true });
        return fixture;
    }

    it("keeps local-edit generation quality across a queued auxiliary prepare and a changed default", async () => {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const fixture = await arrangeLocal(conversation.id, "参考图片1的商品身份，把图片2 这张图修改成厨房背景并保留商品外观", async (alpha) =>
            sharp(await productSource(alpha))
                .resize(200, 160)
                .png()
                .toBuffer(),
        );
        const protection = await waitingStage(fixture.run.id, "build_protection", 1, "ecommerce-local-edit");
        await completeStage(protection.id);
        const executionId = "fixture-generation-preparation";
        const ready = await tasks.mutateStoredGenerationTask<import("./agent-run-store").AgentRun>("agent", fixture.run.id, 60_000, (run) => {
            assert(run.ecommerceSnapshot?.plan && run.ecommerceSnapshot.modelRouteSnapshots?.image_generation);
            const image = run.ecommerceSnapshot.modelRouteSnapshots.image_generation;
            return {
                ...run,
                executionId,
                ecommerceSnapshot: {
                    ...run.ecommerceSnapshot,
                    plan: { ...run.ecommerceSnapshot.plan, canvas: { mode: "exact", size: { width: 100, height: 80 }, source: "user_text", allowReframe: false } },
                    modelRouteSnapshots: { ...run.ecommerceSnapshot.modelRouteSnapshots, image_generation: { ...image, imageEdit: { protocol: "sub2api", editPath: "/images/edits", transport: "json", supportsIndependentMask: true } } },
                },
            };
        });
        assert(ready?.ecommerceSnapshot?.visualAnalysis);
        await scheduler.scheduleGenerationTask("agent", ready.id, { executionPhase: "created", nextPollAt: Date.now() });
        expect(await scheduler.claimDueGenerationTasks({ workerId: "fixture-generation-parent", taskIds: [ready.id], limit: 1 })).toHaveLength(1);
        const { prepareEcommerceProtectionTask } = await import("./ecommerce-protection-preparation");
        const { toLegacyEcommerceVisualAnalysis } = await import("./ecommerce-reference-roles");
        const analysis = toLegacyEcommerceVisualAnalysis(ready.ecommerceSnapshot.visualAnalysis, fixture.baseline.asset.id);
        const checkpoint = structuredClone(ready.ecommerceSnapshot.referenceCheckpoint);
        expect(await prepareEcommerceProtectionTask(ready, executionId, analysis, { imageQuality: "high", imageSize: "100x80" })).toBeUndefined();
        const pending = await waitingStage(ready.id, "prepare_reference", 3, "ecommerce-local-edit");
        expect(pending.payload.options).toEqual({ generationInput: { bounds: { width: 100, height: 80 }, quality: "high" } });
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const leases = await service.claimImageProcessingTasks({ workerId: "fixture-local-generation", profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
        expect(leases.tasks).toHaveLength(1);
        const { completeClaimedImageProcessingFixture } = await import("./image-processing.test-fixture");
        await completeClaimedImageProcessingFixture(leases.tasks[0], "fixture-local-generation", directory);
        const resumed = await tasks.mutateStoredGenerationTask<import("./agent-run-store").AgentRun>("agent", ready.id, 60_000, (run) => ({ ...run, executionId: "fixture-generation-resumed" }));
        assert(resumed);
        await scheduler.scheduleGenerationTask("agent", ready.id, { executionPhase: "created", nextPollAt: Date.now() });
        expect(await scheduler.claimDueGenerationTasks({ workerId: "fixture-local-resumed", taskIds: [ready.id], limit: 1 })).toHaveLength(1);
        const executable = await prepareEcommerceProtectionTask(resumed, "fixture-generation-resumed", analysis, { imageQuality: "low", imageSize: "1024x1024" });
        expect(executable).toMatchObject({ id: "ecommerce-local-edit", quality: "high", ratio: "100x80", references: [{ assetId: fixture.baseline.asset.id }, { assetId: fixture.product.asset.id, width: 200, height: 160 }] });
        expect(resumed.ecommerceSnapshot?.referenceCheckpoint).toEqual(checkpoint);
        expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
    }, 30_000);

    it("retries failed planning with a new persisted billing identity in the same Run", async () => {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat", title: "planning retry" });
        const product = await registerSource(conversation.id, 0, await productSource(1));
        const analysis = { analysisVersion: "ecommerce-visual-analysis.v4", references: [productObservation(product.asset.id, false)], purposeSuggestions: [] };
        installModelReplies(analysis, "product_to_scene");
        const respond = boundary.model.getMockImplementation()!;
        let failedBillingKey: string | null = null;
        boundary.model.mockImplementation(async (request) => {
            if (request.tool.name === "plan_ecommerce_edit") {
                failedBillingKey = new Headers(request.headers).get("x-vozeb-pro-points-idempotency-key");
                throw new Error("Fixture planning response failed validation");
            }
            return respond(request);
        });
        const run = await startRun(conversation.id, [product.asset.id], "修改图片1，把背景换成厨房，保留商品外观");
        await completeReference(run.id, product.asset.id, 1);
        const failed = await claimAndExecute(run.id, "failed-planning-parent");
        expect(failed).toMatchObject({ status: "failed", tasks: [], failure: "Fixture planning response failed validation" });
        expect(failedBillingKey).toBeTruthy();
        expect(await scheduler.releaseGenerationTaskLease("agent", run.id, "failed-planning-parent", { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "fixture-planning-failed" })).not.toBeNull();
        const frozenAnalysis = failed.ecommerceSnapshot!.referenceCheckpoint!.analysis;
        const { POST } = await import("@/app/api/agent/runs/[id]/[action]/route");
        const retry = () =>
            POST(new Request(origin + `/api/agent/runs/${run.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conversation.id }) }), {
                params: Promise.resolve({ id: run.id, action: "retry" }),
            });
        expect((await retry()).status).toBe(200);
        const accepted = await runs.getAgentRun(run.id);
        expect(accepted).toMatchObject({ id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId, status: "planning" });
        installModelReplies(analysis, "product_to_scene");
        const complete = boundary.model.getMockImplementation()!;
        let retryBillingKey: string | null = null;
        boundary.model.mockImplementation(async (request) => {
            retryBillingKey = new Headers(request.headers).get("x-vozeb-pro-points-idempotency-key");
            return complete(request);
        });
        const planned = await claimAndExecute(run.id, "retry-planning-parent");
        expect(retryBillingKey).toBeTruthy();
        expect(retryBillingKey).not.toBe(failedBillingKey);
        expect(planned.ecommerceSnapshot?.referenceCheckpoint?.analysis).toEqual(frozenAnalysis);
        expect(planned.ecommerceSnapshot?.plan).toMatchObject({ operation: "product_to_scene" });
        expect((await retry()).status).toBe(409);
        expect((await runs.getAgentRun(run.id))?.ecommerceSnapshot?.plan).toEqual(planned.ecommerceSnapshot?.plan);
    }, 30_000);

    it.each([
        { name: "white background product", arrange: arrangeWhite, operation: "product_to_scene", parentTaskId: "ecommerce-product-scene", expectedOptions: { transparentBackground: false } },
        { name: "transparent background product", arrange: arrangeTransparent, operation: "product_to_scene", parentTaskId: "ecommerce-product-scene", expectedOptions: { transparentBackground: true } },
        {
            name: "local product edit",
            arrange: arrangeLocal,
            operation: "local_edit",
            parentTaskId: "ecommerce-local-edit",
            expectedOptions: { mode: "local_edit", targetRegion: { x: 0, y: 0, width: 1, height: 1 }, protectedRectangles: expect.arrayContaining([{ x: 40, y: 20, width: 20, height: 40 }]) },
        },
        {
            name: "global product lighting",
            arrange: arrangeGlobalLighting,
            operation: "local_edit",
            parentTaskId: "ecommerce-local-edit",
            expectedOptions: { mode: "local_edit", targetRegion: { x: 0, y: 0, width: 1, height: 1 }, protectedRectangles: expect.arrayContaining([{ x: 40, y: 20, width: 20, height: 40 }]) },
        },
    ])(
        "stores the accepted plan before enqueueing $name protection, then consumes its real completion on a new claim",
        async ({ arrange, operation, parentTaskId, expectedOptions }) => {
            const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
            const fixture = await arrange(conversation.id);
            const snapshot = fixture.planned.ecommerceSnapshot;
            const qualification = JSON.stringify({
                status: fixture.planned.status,
                failure: fixture.planned.failure,
                fallback: snapshot?.fallback,
                visualFailure: snapshot?.visualAnalysisFailure,
                tasks: fixture.planned.tasks,
                tools: boundary.model.mock.calls.map(([request]) => request.tool.name),
            });
            expect(
                boundary.model.mock.calls.map(([request]) => request.tool.name),
                qualification,
            ).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
            expect(snapshot, "A parser/config/role/build-pixel failure is not a valid missing-build RED: " + qualification).toMatchObject({
                mode: "active",
                referenceCheckpoint: { analysisStage: { state: "completed" }, analysis: { analysisVersion: "ecommerce-visual-analysis.v4" } },
                plan: { planVersion: "ecommerce-edit.v6", operation },
                compilerVersion: "ecommerce-openai-image-2.5.v4",
                modelRouteSnapshots: { vision_analysis: { channelId: "planner-channel" }, edit_planning: { channelId: "planner-channel" }, image_generation: { channelId: "image-channel" } },
            });
            assert(snapshot?.plan && snapshot.referenceCheckpoint && snapshot.processing);
            const protection = await waitingStage(fixture.run.id, "build_protection", 1, parentTaskId);
            expect(protection.payload).toMatchObject({ operation: "build_protection", inputs: [{ assetId: fixture.baseline.asset.id, expectedSha256: fixture.baseline.sourceSha256 }], options: expectedOptions });
            expect(snapshot.processing.protection).toEqual({ jobId: protection.id, inputDigest: protection.payload.inputDigest });
            expect(snapshot.processing.prepareReferences.map((reference) => reference.jobId)).toEqual(fixture.prepareJobs);
            expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
            const frozen = structuredClone({ plan: snapshot.plan, modelRoles: snapshot.modelRoles, modelRouteSnapshots: snapshot.modelRouteSnapshots, stageTimings: snapshot.stageTimings, continuity: snapshot.continuity });
            const frozenReference = structuredClone({
                inputId: snapshot.referenceCheckpoint.inputId,
                assets: snapshot.referenceCheckpoint.assets,
                analysisStage: snapshot.referenceCheckpoint.analysisStage,
                analysis: snapshot.referenceCheckpoint.analysis,
                route: snapshot.referenceCheckpoint.route,
            });
            expect(snapshot.stageTimings).toMatchObject({ analysisCompletedAt: expect.any(Number), planningCompletedAt: expect.any(Number) });
            const beforeBuild = await runs.getAgentRun(fixture.run.id);
            expect(beforeBuild?.ecommerceSnapshot?.plan).toEqual(frozen.plan);
            const completed = await completeStage(protection.id);
            expect(completed.manifest.sourceIdentities).toMatchObject([{ assetId: fixture.baseline.asset.id, sha256: fixture.baseline.sourceSha256, width: 100, height: 80 }]);
            expect(completed.artifact).toMatchObject({ kind: "mask", width: 100, height: 80 });
            const afterBuild = await runs.getAgentRun(fixture.run.id);
            expect(afterBuild?.ecommerceSnapshot).toMatchObject(frozen);
            expect(afterBuild?.ecommerceSnapshot?.referenceCheckpoint).toMatchObject(frozenReference);
            expect(afterBuild?.ecommerceSnapshot?.processing?.protection).toEqual({ jobId: protection.id, inputDigest: protection.payload.inputDigest, manifest: completed.manifest });
            assert(afterBuild);
            const evidence = await service.readCompletedEcommerceProductProtection(afterBuild);
            expect(evidence.regions).toMatchObject({ productAnchorId: fixture.product.asset.id, sourceAssetId: fixture.baseline.asset.id, sourceSize: { width: 100, height: 80 } });
            const resumed = await claimAndExecute(fixture.run.id, "protection-complete-parent");
            expect(resumed).toMatchObject({ id: fixture.run.id, conversationId: fixture.run.conversationId, inputMessageId: fixture.run.inputMessageId, assistantMessageId: fixture.run.assistantMessageId });
            expect(resumed.ecommerceSnapshot).toMatchObject(frozen);
            expect(resumed.ecommerceSnapshot?.referenceCheckpoint).toMatchObject(frozenReference);
            expect(resumed.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
            expect(resumed.ecommerceSnapshot?.processing?.prepareReferences.map((reference) => reference.jobId)).toEqual(fixture.prepareJobs);
            expect(resumed.ecommerceSnapshot?.processing?.protection).toEqual({ jobId: protection.id, inputDigest: protection.payload.inputDigest, manifest: completed.manifest });
            const builds = (await tasks.listStoredGenerationTaskRecordsByRunIds([fixture.run.id], [userId])).filter((record) => record.type === "image_processing" && record.payload.operation === "build_protection");
            expect(builds).toMatchObject([{ id: protection.id, status: "success", payload: { inputDigest: protection.payload.inputDigest } }]);
            expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
            const submissions = boundary.request.mock.calls.filter(([, init]) => init?.method === "POST");
            expect(submissions).toHaveLength(1);
            expect(submissions[0][0]).toBe(origin + "/api/image-tasks");
            const submitted = String(submissions[0][1]?.body);
            expect(submitted).toContain(completed.artifact.storageKey);
            expect(submitted).not.toContain("data:image/png;base64,");
            const submittedInput: Pick<ImageTask, "config" | "prompt" | "references" | "ecommerceExecution"> & { kind: "edit" } = JSON.parse(submitted);
            const { compileStrictProductEdit } = await import("./ecommerce-product-regions");
            const compiled = compileStrictProductEdit(submittedInput, evidence.regions);
            expect(compiled.state).toBe("ready");
            const image: ImageTask = {
                ...compiled.task,
                id: "fixture-image-result",
                userId,
                username: "fixture-user",
                displayName: "Fixture User",
                source: "agent",
                kind: "edit",
                status: "running",
                createdAt: 1,
                updatedAt: 1,
                conversationId: conversation.id,
                runId: fixture.run.id,
                parentTaskId,
            };
            const { isNativeProductImageTaskResult, usesImageTaskResultProcessing } = await import("./image-task-result-contract");
            expect(isNativeProductImageTaskResult(image)).toBe(true);
            expect(usesImageTaskResultProcessing(image)).toBe(true);
            expect(resumed.tasks).toMatchObject([{ status: "failed", productProtectionRegions: { productAnchorId: fixture.product.asset.id, sourceAssetId: fixture.baseline.asset.id, sourceSize: { width: 100, height: 80 } } }]);
        },
        30_000,
    );

    it("resumes the same Run after its saved white-background plan's real protection child startup OOM", async () => {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const product = await registerSource(conversation.id, 0, await productSource(1));
        installModelReplies({ analysisVersion: "ecommerce-visual-analysis.v4", references: [productObservation(product.asset.id, false)], purposeSuggestions: [] }, "product_to_scene");
        const run = await startRun(conversation.id, [product.asset.id], "修改图片1，把背景换成厨房，保留商品外观");
        const prepareJob = await completeReference(run.id, product.asset.id, 1);
        const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", prepareJob);
        assert(prepareBefore);
        expect(prepareBefore).toMatchObject({ status: "success", payload: { resource: { configuration: { processHeapMb: 384 } } } });

        // The existing isolated heap setting fails the real build child at startup, after prepare completed.
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "1");
        const planned = await claimAndExecute(run.id, "startup-oom-planning-parent");
        const snapshot = planned.ecommerceSnapshot;
        assert(snapshot?.plan && snapshot.referenceCheckpoint && snapshot.processing);
        expect(snapshot).toMatchObject({ plan: { planVersion: "ecommerce-edit.v6", operation: "product_to_scene" }, referenceCheckpoint: { analysisStage: { state: "completed" } } });
        expect(snapshot.stageTimings).toMatchObject({ analysisCompletedAt: expect.any(Number), planningCompletedAt: expect.any(Number) });
        const frozen = structuredClone({
            plan: snapshot.plan,
            referenceCheckpoint: snapshot.referenceCheckpoint,
            visualAnalysis: snapshot.visualAnalysis,
            modelRoles: snapshot.modelRoles,
            modelRouteSnapshots: snapshot.modelRouteSnapshots,
            stageTimings: snapshot.stageTimings,
            continuity: snapshot.continuity,
        });
        const publicIdentity = { id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId };
        const modelLedger = boundary.model.mock.calls.map(([request]) => request.tool.name);
        expect(modelLedger).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
        const protection = await waitingStage(run.id, "build_protection", 1, "ecommerce-product-scene");
        expect(protection.payload).toMatchObject({ inputs: [{ assetId: product.asset.id, expectedSha256: product.sourceSha256 }], options: { transparentBackground: false }, resource: { configuration: { processHeapMb: 1 } } });
        expect((await runs.getAgentRun(run.id))?.ecommerceSnapshot).toMatchObject(frozen);
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const failingConfiguration = imageProcessingResourceConfig(process.env);
        const workerId = "startup-oom-protection-worker";
        const claimInput = { workerId, profileVersion: failingConfiguration.profileVersion, availableMemoryBytes: failingConfiguration.budgetBytes, slots: 1 };
        const claimed = await service.claimImageProcessingTasks(claimInput);
        expect(claimed.tasks).toHaveLength(1);
        const native = claimed.tasks[0];
        expect(native.id).toBe(protection.id);
        assert(native.payload.operation === "build_protection");
        const identity = { workerId, executionId: native.executionId };
        const taskDirectory = await mkdtemp(join(directory, "startup-oom-build-"));
        const inputPath = join(taskDirectory, "source.png");
        const source = await service.readImageProcessingInput(protection.id, native.payload.inputs[0].assetId, identity);
        await pipeline(source.stream, createWriteStream(inputPath, { flags: "wx" }));
        const outputDirectory = join(taskDirectory, "outputs");
        await mkdir(outputDirectory);
        const failure = await runImageProcessing(
            { version: "image-processing.v1", operation: "build_protection", jobId: protection.id, executionId: native.executionId, inputs: [{ ...native.payload.inputs[0], path: inputPath }], options: native.payload.options, outputDirectory },
            { taskDirectory, maxHeapMiB: native.payload.resource.configuration.processHeapMb },
        );
        console.info("TC-R02 real protection child close", JSON.stringify(failure));
        expect(failure).toMatchObject({ status: "resource_failure", reason: "v8_heap_oom", jobId: protection.id, executionId: native.executionId });
        expect(failure.stderr).toMatch(/(?:FATAL ERROR:[^\r\n]*(?:heap out of memory|Reached heap limit|Ineffective mark-compacts)|^# Fatal JavaScript out of memory:)/im);
        expect(failure.exitCode).not.toBe(0);
        const failedPid = failure.pid;
        assert(failedPid !== null);
        expect(failedPid).toBeGreaterThan(0);
        expect(() => process.kill(failedPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        assert(failure.status === "resource_failure");

        const workerToken = "fixture-startup-oom-worker-token-aaaaaaaaaaaaaaaaaaaaaaaaaa";
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-startup-oom-maintenance-token-bbbbbbbbbbbbbbbbbbbbb");
        const failRoute = await import("@/app/api/maintenance/image-processing/[id]/fail/route");
        const failed = await failRoute.POST(
            new Request(origin + "/api/maintenance/image-processing/" + protection.id + "/fail", { method: "POST", headers: { authorization: "Bearer " + workerToken, "content-type": "application/json" }, body: JSON.stringify({ ...identity, failure }) }),
            { params: Promise.resolve({ id: protection.id }) },
        );
        const failReceipt = await failed.json();
        expect(failed.status).toBe(200);
        expect(failReceipt).toMatchObject({ code: 0, data: { jobId: protection.id, status: "paused", executionPhase: "needs_review" } });
        const paused = await runs.getAgentRun(run.id);
        const pausedChild = await tasks.getStoredGenerationTaskRecord("image_processing", protection.id);
        assert(paused && pausedChild);
        expect(paused).toMatchObject({ ...publicIdentity, status: "paused", ecommerceSnapshot: frozen });
        expect(paused.ecommerceSnapshot?.processing?.waitingFor).toEqual({ jobId: protection.id, inputDigest: protection.payload.inputDigest });
        expect(pausedChild).toMatchObject({ status: "paused", executionPhase: "needs_review", resultPayload: { ...identity, failure } });
        expect(pausedChild.payload).toEqual(native.payload);
        expect(pausedChild.workerId).toBeUndefined();
        expect(pausedChild.leaseUntil).toBeUndefined();
        expect(await service.claimImageProcessingTasks(claimInput)).toEqual({ tasks: [] });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareJob)).toEqual(prepareBefore);
        console.info(
            "TC-R02 persisted protection failure",
            JSON.stringify({ publicIdentity, jobId: protection.id, inputDigest: protection.payload.inputDigest, failHttpStatus: failed.status, failReceipt, child: pausedChild, plan: paused.ecommerceSnapshot?.plan, modelLedger }),
        );

        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        const recoveredConfiguration = imageProcessingResourceConfig(process.env);
        expect(recoveredConfiguration.profileVersion).not.toBe(failingConfiguration.profileVersion);
        const actionRoute = await import("@/app/api/agent/runs/[id]/[action]/route");
        const response = await actionRoute.POST(new Request(origin + "/api/agent/runs/" + run.id + "/resume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conversation.id }) }), {
            params: Promise.resolve({ id: run.id, action: "resume" }),
        });
        const resumeReceipt = await response.json();
        expect(response.status).toBe(200);
        expect(resumeReceipt).toMatchObject({ code: 0, data: { run: { id: run.id, status: "running" } } });
        const reopened = await tasks.getStoredGenerationTaskRecord("image_processing", protection.id);
        assert(reopened);
        expect(reopened).toMatchObject({
            id: protection.id,
            status: "pending",
            executionPhase: "created",
            payload: { inputDigest: native.payload.inputDigest, inputs: native.payload.inputs, options: native.payload.options, resource: { profileVersion: recoveredConfiguration.profileVersion, configuration: { processHeapMb: 384 } } },
        });
        expect(reopened.payload.executionId).toBeUndefined();
        expect(reopened.resultPayload?.checkpoints).toEqual([{ executionId: native.executionId, workerId, failure, resource: native.payload.resource }]);
        expect((await runs.getAgentRun(run.id))?.ecommerceSnapshot).toMatchObject(frozen);
        expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(modelLedger);

        const completed = await completeStage(protection.id);
        expect(completed.payload.executionId).not.toBe(native.executionId);
        expect(completed.payload.inputDigest).toBe(native.payload.inputDigest);
        expect(completed.manifest.sourceIdentities).toMatchObject([{ assetId: product.asset.id, sha256: product.sourceSha256, width: 100, height: 80 }]);
        expect(completed.artifact).toMatchObject({ kind: "mask", width: 100, height: 80 });
        const completedChild = await tasks.getStoredGenerationTaskRecord("image_processing", protection.id);
        expect(completedChild).toMatchObject({ id: protection.id, status: "success" });
        expect(completedChild?.resultPayload?.checkpoints).toEqual(reopened.resultPayload?.checkpoints);
        const delivered = await claimAndExecute(run.id, "startup-oom-protection-complete-parent");
        expect(delivered).toMatchObject({ ...publicIdentity, ecommerceSnapshot: frozen });
        expect(delivered.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
        expect(delivered.ecommerceSnapshot?.processing?.protection).toEqual({ jobId: protection.id, inputDigest: protection.payload.inputDigest, manifest: completed.manifest });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareJob)).toEqual(prepareBefore);
        expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(modelLedger);
        const builds = (await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).filter((record) => record.type === "image_processing" && record.payload.operation === "build_protection");
        expect(builds).toMatchObject([{ id: protection.id, status: "success", payload: { inputDigest: protection.payload.inputDigest } }]);
        const submissions = boundary.request.mock.calls.filter(([, init]) => init?.method === "POST");
        expect(submissions).toHaveLength(1);
        expect(submissions[0][0]).toBe(origin + "/api/image-tasks");
        expect(String(submissions[0][1]?.body)).toContain(completed.artifact.storageKey);
        console.info(
            "TC-R02 same Run protection recovery",
            JSON.stringify({
                publicIdentity,
                resumeHttpStatus: response.status,
                resumeReceipt,
                jobId: protection.id,
                inputDigest: protection.payload.inputDigest,
                failure,
                checkpoint: reopened.resultPayload?.checkpoints,
                completedChild,
                modelLedger: boundary.model.mock.calls.map(([request]) => request.tool.name),
                submissions: submissions.length,
            }),
        );
    }, 30_000);

    async function resourcePausedPrepare() {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const product = await registerSource(conversation.id, 0, await productSource(1));
        installModelReplies({ analysisVersion: "ecommerce-visual-analysis.v4", references: [productObservation(product.asset.id, false)], purposeSuggestions: [] }, "product_to_scene");
        const run = await startRun(conversation.id, [product.asset.id], "修改图片1，把背景换成厨房，保留商品外观");
        const stage = await waitingStage(run.id, "prepare_reference", 1, run.id);
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const configuration = imageProcessingResourceConfig(process.env);
        const workerId = "prepare-resource-resume-worker";
        const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: configuration.profileVersion, availableMemoryBytes: configuration.budgetBytes, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const attempt = claimed.tasks[0];
        expect(attempt).toMatchObject({ id: stage.id, payload: { operation: "prepare_reference", inputDigest: stage.payload.inputDigest, inputs: [{ assetId: product.asset.id, expectedSha256: product.sourceSha256 }] } });
        const identity = { workerId, executionId: attempt.executionId };
        // This is a controlled closed failure report; only the later recovered prepare executes native work.
        const failure: ClosedImageProcessingFailure = {
            status: "resource_failure",
            reason: "v8_heap_oom",
            jobId: stage.id,
            executionId: attempt.executionId,
            pid: 4331,
            exitCode: 134,
            signal: null,
            stderr: "controlled prepare resource report: FATAL ERROR: Reached heap limit",
        };
        const workerToken = "fixture-prepare-resource-worker-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-prepare-resource-maintenance-token-bbbbbbbbbbbbbbbbbbbbbb");
        const failRoute = await import("@/app/api/maintenance/image-processing/[id]/fail/route");
        const failed = await failRoute.POST(
            new Request(origin + "/api/maintenance/image-processing/" + stage.id + "/fail", { method: "POST", headers: { authorization: "Bearer " + workerToken, "content-type": "application/json" }, body: JSON.stringify({ ...identity, failure }) }),
            { params: Promise.resolve({ id: stage.id }) },
        );
        expect(failed.status).toBe(200);
        expect(await failed.json()).toMatchObject({ code: 0, data: { jobId: stage.id, status: "paused", executionPhase: "needs_review" } });
        const paused = await runs.getAgentRun(run.id);
        const parentRecord = await tasks.getStoredGenerationTaskRecord("agent", run.id);
        const childRecord = await tasks.getStoredGenerationTaskRecord("image_processing", stage.id);
        assert(paused?.ecommerceSnapshot?.referenceCheckpoint && parentRecord && childRecord);
        expect(paused).toMatchObject({ id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId, status: "paused" });
        expect(paused.ecommerceSnapshot.processing?.waitingFor).toEqual({ jobId: stage.id, inputDigest: stage.payload.inputDigest });
        expect(paused.ecommerceSnapshot.plan).toBeUndefined();
        expect(parentRecord).toMatchObject({ status: "paused", executionPhase: "needs_review" });
        expect(childRecord).toMatchObject({ status: "paused", executionPhase: "needs_review", resultPayload: { ...identity, failure } });
        expect(parentRecord.workerId).toBeUndefined();
        expect(parentRecord.leaseUntil).toBeUndefined();
        expect(parentRecord.nextPollAt).toBeUndefined();
        expect(childRecord.workerId).toBeUndefined();
        expect(childRecord.leaseUntil).toBeUndefined();
        expect(childRecord.nextPollAt).toBeUndefined();
        expect(boundary.model).not.toHaveBeenCalled();
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
        return { run, product, stage, attempt, identity, failure, configuration, paused, parentRecord, childRecord };
    }

    it.each([
        { reason: "the failed profile is unchanged", heapMb: "384", budgetMb: "1024", message: "资源配置尚未调整" },
        { reason: "the configured heap is invalid", heapMb: "0", budgetMb: "1024", message: "资源配置无效" },
        { reason: "the changed legal budget cannot admit the original stage", heapMb: "512", budgetMb: "1", message: "当前资源配置仍无法执行原图像阶段" },
    ])(
        "rejects original prepare resume when $reason and leaves both truth rows unchanged",
        async ({ heapMb, budgetMb, message }) => {
            const fixture = await resourcePausedPrepare();
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", heapMb);
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", budgetMb);
            const actionRoute = await import("@/app/api/agent/runs/[id]/[action]/route");
            const response = await actionRoute.POST(
                new Request(origin + "/api/agent/runs/" + fixture.run.id + "/resume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: fixture.run.conversationId }) }),
                {
                    params: Promise.resolve({ id: fixture.run.id, action: "resume" }),
                },
            );
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual({ code: 409, data: null, msg: expect.stringContaining(message) });
            expect(await tasks.getStoredGenerationTaskRecord("agent", fixture.run.id)).toEqual(fixture.parentRecord);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.stage.id)).toEqual(fixture.childRecord);
            expect(boundary.model).not.toHaveBeenCalled();
            expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
        },
        30_000,
    );

    it("resumes the original resource-paused prepare and consumes its real native completion before first planning", async () => {
        const fixture = await resourcePausedPrepare();
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "512");
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const configuration = imageProcessingResourceConfig(process.env);
        expect(configuration.profileVersion).not.toBe(fixture.configuration.profileVersion);
        const actionRoute = await import("@/app/api/agent/runs/[id]/[action]/route");
        const response = await actionRoute.POST(
            new Request(origin + "/api/agent/runs/" + fixture.run.id + "/resume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: fixture.run.conversationId }) }),
            {
                params: Promise.resolve({ id: fixture.run.id, action: "resume" }),
            },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ code: 0, data: { run: { id: fixture.run.id, status: "running" } } });
        const reopened = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.stage.id);
        assert(reopened);
        expect(reopened).toMatchObject({ id: fixture.stage.id, userId, runId: fixture.run.id, parentTaskId: fixture.run.id, status: "pending", executionPhase: "created" });
        expect(reopened.payload).toMatchObject({
            operation: "prepare_reference",
            inputDigest: fixture.attempt.payload.inputDigest,
            inputs: fixture.attempt.payload.inputs,
            sources: fixture.attempt.payload.sources,
            options: fixture.attempt.payload.options,
            resource: { profileVersion: configuration.profileVersion, facts: fixture.attempt.payload.resource.facts },
        });
        expect(reopened.payload.executionId).toBeUndefined();
        expect(reopened.workerId).toBeUndefined();
        expect(reopened.leaseUntil).toBeUndefined();
        expect(reopened.resultPayload).toEqual({ executionId: fixture.identity.executionId, checkpoints: [{ ...fixture.identity, failure: fixture.failure, resource: fixture.attempt.payload.resource }] });
        const resumedParent = await runs.getAgentRun(fixture.run.id);
        expect(resumedParent).toMatchObject({
            id: fixture.run.id,
            conversationId: fixture.run.conversationId,
            inputMessageId: fixture.run.inputMessageId,
            assistantMessageId: fixture.run.assistantMessageId,
            status: "running",
            ecommerceSnapshot: fixture.paused.ecommerceSnapshot,
        });
        expect(boundary.model).not.toHaveBeenCalled();

        const completed = await completeStage(fixture.stage.id);
        expect(completed.payload.executionId).not.toBe(fixture.identity.executionId);
        expect(completed.payload.inputDigest).toBe(fixture.attempt.payload.inputDigest);
        expect(completed.artifact).toMatchObject({ kind: "analysis", width: 100, height: 80 });
        expect(completed.manifest.sourceIdentities).toMatchObject([{ assetId: fixture.product.asset.id, sha256: fixture.product.sourceSha256, width: 100, height: 80 }]);
        const completedChild = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.stage.id);
        expect(completedChild).toMatchObject({ id: fixture.stage.id, status: "success", executionPhase: "completed" });
        expect(completedChild?.resultPayload?.checkpoints).toEqual(reopened.resultPayload?.checkpoints);
        const prepared = await runs.getAgentRun(fixture.run.id);
        expect(prepared?.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
        expect(prepared?.ecommerceSnapshot?.processing?.prepareReferences).toEqual([
            { jobId: fixture.stage.id, inputDigest: fixture.stage.payload.inputDigest, assetId: fixture.product.asset.id, assetVersion: fixture.attempt.payload.inputs[0].assetVersion, manifest: completed.manifest },
        ]);
        expect(prepared?.ecommerceSnapshot?.plan).toBeUndefined();
        expect(boundary.model).not.toHaveBeenCalled();
        const planned = await claimAndExecute(fixture.run.id, "recovered-prepare-first-planning");
        expect(planned).toMatchObject({
            id: fixture.run.id,
            conversationId: fixture.run.conversationId,
            inputMessageId: fixture.run.inputMessageId,
            assistantMessageId: fixture.run.assistantMessageId,
            ecommerceSnapshot: { plan: { planVersion: "ecommerce-edit.v6", operation: "product_to_scene" } },
        });
        expect(planned.ecommerceSnapshot?.processing?.prepareReferences).toEqual([
            { jobId: fixture.stage.id, inputDigest: fixture.stage.payload.inputDigest, assetId: fixture.product.asset.id, assetVersion: fixture.attempt.payload.inputs[0].assetVersion, manifest: completed.manifest },
        ]);
        await waitingStage(fixture.run.id, "build_protection", 1, "ecommerce-product-scene");
        const prepares = (await tasks.listStoredGenerationTaskRecordsByRunIds([fixture.run.id], [userId])).filter((record) => record.type === "image_processing" && record.payload.operation === "prepare_reference");
        expect(prepares).toMatchObject([{ id: fixture.stage.id, status: "success" }]);
        expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    }, 30_000);

    it("reopens the same resource-paused build through the original Run resume without repeating its accepted plan", async () => {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const fixture = await arrangeWhite(conversation.id);
        const snapshot = fixture.planned.ecommerceSnapshot;
        assert(snapshot?.plan && snapshot.referenceCheckpoint && snapshot.processing);
        expect(snapshot).toMatchObject({ plan: { planVersion: "ecommerce-edit.v6", operation: "product_to_scene" }, referenceCheckpoint: { analysisStage: { state: "completed" } } });
        expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
        const frozen = structuredClone({
            plan: snapshot.plan,
            referenceCheckpoint: snapshot.referenceCheckpoint,
            visualAnalysis: snapshot.visualAnalysis,
            modelRoles: snapshot.modelRoles,
            modelRouteSnapshots: snapshot.modelRouteSnapshots,
            continuity: snapshot.continuity,
        });
        const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareJobs[0]);
        assert(prepareBefore);
        expect(prepareBefore).toMatchObject({ status: "success", runId: fixture.run.id, userId, payload: { operation: "prepare_reference" } });
        const protection = await waitingStage(fixture.run.id, "build_protection", 1, "ecommerce-product-scene");
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const oldConfiguration = imageProcessingResourceConfig(process.env);
        const workerId = "resource-resume-image-worker";
        const claimInput = { workerId, profileVersion: oldConfiguration.profileVersion, availableMemoryBytes: oldConfiguration.budgetBytes, slots: 1 };
        const claimed = await service.claimImageProcessingTasks(claimInput);
        expect(claimed.tasks).toHaveLength(1);
        const native = claimed.tasks[0];
        expect(native.id).toBe(protection.id);
        assert(native.payload.operation === "build_protection");
        const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", protection.id);
        assert(beforeChild);
        expect(beforeChild).toMatchObject({ status: "running", userId, runId: fixture.run.id, parentTaskId: "ecommerce-product-scene", workerId, payload: { executionId: native.executionId, inputDigest: protection.payload.inputDigest } });
        expect(beforeChild.leaseUntil).toBe(native.leaseUntil);
        expect(beforeChild.leaseUntil).toBeGreaterThan(Date.now());

        // This controlled Worker report tests resume wiring; actual metadata OOM has a separate supervisor gate.
        const failure: ClosedImageProcessingFailure = {
            status: "resource_failure",
            reason: "v8_heap_oom",
            jobId: protection.id,
            executionId: native.executionId,
            pid: 4321,
            exitCode: 134,
            signal: null,
            stderr: "controlled Agent bridge report: FATAL ERROR: Reached heap limit",
        };
        const identity = { workerId, executionId: native.executionId };
        const workerToken = "fixture-resource-worker-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-resource-maintenance-token-bbbbbbbbbbbbbbbbbbbbbbbb");
        const failRoute = await import("@/app/api/maintenance/image-processing/[id]/fail/route");
        const failed = await failRoute.POST(
            new Request(origin + "/api/maintenance/image-processing/" + protection.id + "/fail", { method: "POST", headers: { authorization: "Bearer " + workerToken, "content-type": "application/json" }, body: JSON.stringify({ ...identity, failure }) }),
            { params: Promise.resolve({ id: protection.id }) },
        );
        expect(failed.status).toBe(200);
        expect(await failed.json()).toMatchObject({ code: 0, data: { jobId: protection.id, status: "paused", executionPhase: "needs_review" } });
        const paused = await runs.getAgentRun(fixture.run.id);
        const pausedChild = await tasks.getStoredGenerationTaskRecord("image_processing", protection.id);
        const pausedParent = await tasks.getStoredGenerationTaskRecord("agent", fixture.run.id);
        assert(paused && pausedChild && pausedParent);
        expect(paused).toMatchObject({ id: fixture.run.id, status: "paused", ecommerceSnapshot: frozen });
        expect(paused.ecommerceSnapshot?.processing?.waitingFor).toEqual({ jobId: protection.id, inputDigest: protection.payload.inputDigest });
        expect(pausedChild).toMatchObject({ status: "paused", executionPhase: "needs_review", resultPayload: { ...identity, failure } });
        expect(pausedChild.payload).toEqual(beforeChild.payload);
        expect(pausedChild.workerId).toBeUndefined();
        expect(pausedChild.leaseUntil).toBeUndefined();
        expect(pausedChild.lastHeartbeatAt).toBeUndefined();
        expect(pausedChild.nextPollAt).toBeUndefined();
        expect(pausedParent.workerId).toBeUndefined();
        expect(pausedParent.leaseUntil).toBeUndefined();
        expect(pausedParent.nextPollAt).toBeUndefined();
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBefore.id)).toEqual(prepareBefore);
        expect(await service.claimImageProcessingTasks(claimInput)).toEqual({ tasks: [] });
        expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

        const publicSelection = await import("./agent-run-public-selection");
        const publicRequest = new Request(origin + "/api/agent/runs/" + fixture.run.id);
        const unchangedPublic = await publicSelection.publicAgentRunForRequest(paused, publicRequest);
        expect(unchangedPublic).toMatchObject({ imageProcessingRecovery: { reason: "resource_failure", canResume: false, message: expect.stringContaining("资源配置尚未调整") }, canCheckStatus: false });
        const unchangedSnapshot = await publicSelection.publicAgentRunSnapshotForRequest(paused, publicRequest);
        expect(unchangedSnapshot).toMatchObject({ imageProcessingRecovery: { reason: "resource_failure", canResume: false } });
        expect(await publicSelection.publicAgentRunForRequest({ ...paused, userId: "other-owner" }, publicRequest)).not.toHaveProperty("imageProcessingRecovery", expect.anything());
        expect(
            await publicSelection.publicAgentRunForRequest(
                { ...paused, ecommerceSnapshot: { ...paused.ecommerceSnapshot!, processing: { ...paused.ecommerceSnapshot!.processing!, waitingFor: { jobId: "other-job", inputDigest: "other-digest" } } } },
                publicRequest,
            ),
        ).not.toHaveProperty("imageProcessingRecovery", expect.anything());
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "0");
        expect(await publicSelection.publicAgentRunForRequest(paused, publicRequest)).toMatchObject({ imageProcessingRecovery: { reason: "resource_failure", canResume: false, message: expect.stringContaining("资源配置无效") } });
        expect(await tasks.getStoredGenerationTaskRecord("agent", fixture.run.id)).toEqual(pausedParent);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", protection.id)).toEqual(pausedChild);
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "512");
        const currentConfiguration = imageProcessingResourceConfig(process.env);
        expect(currentConfiguration.profileVersion).not.toBe(oldConfiguration.profileVersion);
        const readyPublic = await publicSelection.publicAgentRunForRequest(paused, publicRequest);
        expect(readyPublic).toMatchObject({ imageProcessingRecovery: { reason: "resource_failure", canResume: true, message: expect.stringContaining("图像处理因资源不足暂停") }, canCheckStatus: false });
        expect(readyPublic).toHaveProperty("imageProcessingRecovery", { reason: "resource_failure", canResume: true, message: expect.any(String) });
        const readySnapshot = await publicSelection.publicAgentRunSnapshotForRequest(paused, publicRequest);
        expect(readySnapshot).toHaveProperty("imageProcessingRecovery", { reason: "resource_failure", canResume: true, message: expect.any(String) });
        expect(await tasks.getStoredGenerationTaskRecord("agent", fixture.run.id)).toEqual(pausedParent);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", protection.id)).toEqual(pausedChild);
        const actionRoute = await import("@/app/api/agent/runs/[id]/[action]/route");
        const response = await actionRoute.POST(new Request(origin + "/api/agent/runs/" + fixture.run.id + "/resume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conversation.id }) }), {
            params: Promise.resolve({ id: fixture.run.id, action: "resume" }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ code: 0, data: { run: { id: fixture.run.id, status: "running" } } });
        const reopened = await tasks.getStoredGenerationTaskRecord("image_processing", protection.id);
        assert(reopened);
        expect(reopened).toMatchObject({ id: protection.id, userId, runId: fixture.run.id, parentTaskId: "ecommerce-product-scene" });

        expect(reopened, "A Run resume must reopen its same confirmed resource-paused native job, not only mark the parent running").toMatchObject({ status: "pending", executionPhase: "created" });
        expect(reopened.workerId).toBeUndefined();
        expect(reopened.leaseUntil).toBeUndefined();
        expect(reopened.lastHeartbeatAt).toBeUndefined();
        expect(reopened.payload.executionId).toBeUndefined();
        expect(reopened.nextPollAt).toBeGreaterThan(0);
        expect(reopened.payload).toMatchObject({
            version: native.payload.version,
            operation: "build_protection",
            algorithmVersion: native.payload.algorithmVersion,
            inputDigest: native.payload.inputDigest,
            inputs: native.payload.inputs,
            sources: native.payload.sources,
            options: native.payload.options,
        });
        expect(reopened.payload.resource).toMatchObject({ profileVersion: currentConfiguration.profileVersion, configuration: { processHeapMb: 512 }, facts: native.payload.resource.facts });
        expect(reopened.resultPayload).toMatchObject({ checkpoints: [{ executionId: native.executionId, workerId, failure, resource: native.payload.resource }] });
        const resumedParent = await runs.getAgentRun(fixture.run.id);
        expect(resumedParent).toMatchObject({ id: fixture.run.id, conversationId: fixture.run.conversationId, inputMessageId: fixture.run.inputMessageId, assistantMessageId: fixture.run.assistantMessageId, status: "running", ecommerceSnapshot: frozen });
        expect(resumedParent?.ecommerceSnapshot?.processing?.waitingFor).toEqual({ jobId: protection.id, inputDigest: protection.payload.inputDigest });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBefore.id)).toEqual(prepareBefore);
        expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

        const completed = await completeStage(protection.id);
        expect(completed.payload.executionId).not.toBe(native.executionId);
        expect(completed.payload.inputDigest).toBe(native.payload.inputDigest);
        expect(completed.manifest.sourceIdentities).toMatchObject([{ assetId: fixture.baseline.asset.id, sha256: fixture.baseline.sourceSha256, width: 100, height: 80 }]);
        const completedChild = await tasks.getStoredGenerationTaskRecord("image_processing", protection.id);
        expect(completedChild).toMatchObject({ id: protection.id, status: "success" });
        expect(completedChild?.resultPayload?.checkpoints).toEqual(reopened.resultPayload?.checkpoints);
        const delivered = await claimAndExecute(fixture.run.id, "resource-build-complete-parent");
        expect(delivered).toMatchObject({ id: fixture.run.id, conversationId: fixture.run.conversationId, inputMessageId: fixture.run.inputMessageId, assistantMessageId: fixture.run.assistantMessageId, ecommerceSnapshot: frozen });
        expect(delivered.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
        expect(delivered.ecommerceSnapshot?.processing?.protection).toEqual({ jobId: protection.id, inputDigest: protection.payload.inputDigest, manifest: completed.manifest });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBefore.id)).toEqual(prepareBefore);
        expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
        const submissions = boundary.request.mock.calls.filter(([, init]) => init?.method === "POST");
        expect(submissions).toHaveLength(1);
        expect(submissions[0][0]).toBe(origin + "/api/image-tasks");
    }, 30_000);

    it("keeps staged artifacts with their original epoch across repeated explicit resource resumes", async () => {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const fixture = await arrangeWhite(conversation.id);
        const protection = await waitingStage(fixture.run.id, "build_protection", 1, "ecommerce-product-scene");
        const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareJobs[0]);
        assert(prepareBefore);
        expect(prepareBefore).toMatchObject({ status: "success", payload: { operation: "prepare_reference" } });
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const configurationA = imageProcessingResourceConfig(process.env);
        const workerA = "resource-history-worker-a";
        const claimedA = await service.claimImageProcessingTasks({ workerId: workerA, profileVersion: configurationA.profileVersion, availableMemoryBytes: configurationA.budgetBytes, slots: 1 });
        expect(claimedA.tasks).toHaveLength(1);
        const attemptA = claimedA.tasks[0];
        expect(attemptA.id).toBe(protection.id);
        assert(attemptA.payload.operation === "build_protection");
        const identityA = { workerId: workerA, executionId: attemptA.executionId };
        const taskDirectory = await mkdtemp(join(directory, "resource-history-native-"));
        const inputPath = join(taskDirectory, "source.png");
        const source = await service.readImageProcessingInput(protection.id, attemptA.payload.inputs[0].assetId, identityA);
        await pipeline(source.stream, createWriteStream(inputPath, { flags: "wx" }));
        const outputDirectory = join(taskDirectory, "outputs");
        await mkdir(outputDirectory);
        const outcome = await runImageProcessing(
            { version: "image-processing.v1", jobId: protection.id, executionId: attemptA.executionId, operation: "build_protection", options: attemptA.payload.options, inputs: [{ ...attemptA.payload.inputs[0], path: inputPath }], outputDirectory },
            { taskDirectory, maxHeapMiB: attemptA.payload.resource.configuration.processHeapMb },
        );
        expect(outcome).toMatchObject({ status: "completed", jobId: protection.id, executionId: attemptA.executionId, exitCode: 0, signal: null });
        expect(outcome.pid).toBeGreaterThan(0);
        assert(outcome.status === "completed");
        expect(outcome.result.artifacts).toHaveLength(1);
        const native = outcome.result.artifacts[0];
        expect(native.kind).toBe("mask");
        assert(native.kind === "mask");
        const upload = new Response(new Uint8Array(await readFile(native.path)));
        assert(upload.body);
        const artifactA = await service.writeImageProcessingOutput(protection.id, "mask", identityA, { stream: upload.body, mimeType: native.mimeType });
        expect(artifactA).toMatchObject({ kind: "mask", sha256: native.sha256, bytes: native.bytes, width: 100, height: 80 });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", protection.id)).toMatchObject({
            status: "running",
            payload: { executionId: attemptA.executionId },
            resultPayload: { executionId: attemptA.executionId, artifacts: [artifactA] },
        });
        const registered = await references.readReferenceAsset(artifactA.storageKey);
        assert(registered);
        expect(registered.registration).toMatchObject({ ownerUserId: userId, storageKey: artifactA.storageKey });
        expect(
            createHash("sha256")
                .update(await readFile(registered.filePath))
                .digest("hex"),
        ).toBe(artifactA.sha256);

        // These controlled reports test stored epoch evidence; the real native process above completed, without OOM.
        const failureA: ClosedImageProcessingFailure = {
            status: "resource_failure",
            reason: "v8_heap_oom",
            jobId: protection.id,
            executionId: attemptA.executionId,
            pid: 4321,
            exitCode: 134,
            signal: null,
            stderr: "controlled history A report: FATAL ERROR: Reached heap limit",
        };
        await expect(service.failImageProcessingTask(protection.id, { ...identityA, failure: failureA })).resolves.toEqual({ jobId: protection.id, status: "paused", executionPhase: "needs_review" });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", protection.id)).toMatchObject({ status: "paused", resultPayload: { ...identityA, failure: failureA, artifacts: [artifactA] } });
        expect(await runs.getAgentRun(fixture.run.id)).toMatchObject({ status: "paused", ecommerceSnapshot: fixture.planned.ecommerceSnapshot });
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "512");
        const configurationB = imageProcessingResourceConfig(process.env);
        expect(configurationB.profileVersion).not.toBe(configurationA.profileVersion);
        const actionRoute = await import("@/app/api/agent/runs/[id]/[action]/route");
        const resumeB = await actionRoute.POST(new Request(origin + "/api/agent/runs/" + fixture.run.id + "/resume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conversation.id }) }), {
            params: Promise.resolve({ id: fixture.run.id, action: "resume" }),
        });
        expect(resumeB.status).toBe(200);
        expect(await resumeB.json()).toMatchObject({ code: 0, data: { run: { id: fixture.run.id, status: "running" } } });
        const checkpointA = { ...identityA, failure: failureA, resource: attemptA.payload.resource, artifacts: [artifactA] };
        const reopenedB = await tasks.getStoredGenerationTaskRecord("image_processing", protection.id);
        expect(reopenedB).toMatchObject({ id: protection.id, status: "pending", executionPhase: "created", resultPayload: { checkpoints: [checkpointA] } });
        expect(reopenedB?.payload.executionId).toBeUndefined();
        const workerB = "resource-history-worker-b";
        const claimedB = await service.claimImageProcessingTasks({ workerId: workerB, profileVersion: configurationB.profileVersion, availableMemoryBytes: configurationB.budgetBytes, slots: 1 });
        expect(claimedB.tasks).toHaveLength(1);
        const attemptB = claimedB.tasks[0];
        expect(attemptB.id).toBe(protection.id);
        expect(attemptB.executionId).not.toBe(attemptA.executionId);
        expect(attemptB.payload).toMatchObject({
            operation: "build_protection",
            inputDigest: attemptA.payload.inputDigest,
            inputs: attemptA.payload.inputs,
            sources: attemptA.payload.sources,
            options: attemptA.payload.options,
            resource: { profileVersion: configurationB.profileVersion, configuration: { processHeapMb: 512 }, facts: attemptA.payload.resource.facts },
        });
        const identityB = { workerId: workerB, executionId: attemptB.executionId };
        const failureB: ClosedImageProcessingFailure = {
            status: "resource_failure",
            reason: "v8_heap_oom",
            jobId: protection.id,
            executionId: attemptB.executionId,
            pid: 4322,
            exitCode: 134,
            signal: null,
            stderr: "controlled history B report before any B upload: FATAL ERROR: Reached heap limit",
        };
        await expect(service.failImageProcessingTask(protection.id, { ...identityB, failure: failureB })).resolves.toEqual({ jobId: protection.id, status: "paused", executionPhase: "needs_review" });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", protection.id)).toMatchObject({
            status: "paused",
            executionPhase: "needs_review",
            payload: { executionId: attemptB.executionId },
            resultPayload: { ...identityB, failure: failureB, checkpoints: [checkpointA] },
        });
        expect(await runs.getAgentRun(fixture.run.id)).toMatchObject({ status: "paused", ecommerceSnapshot: fixture.planned.ecommerceSnapshot });
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "640");
        const configurationC = imageProcessingResourceConfig(process.env);
        expect(configurationC.profileVersion).not.toBe(configurationB.profileVersion);
        const resumeC = await actionRoute.POST(new Request(origin + "/api/agent/runs/" + fixture.run.id + "/resume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conversation.id }) }), {
            params: Promise.resolve({ id: fixture.run.id, action: "resume" }),
        });
        expect(resumeC.status).toBe(200);
        expect(await resumeC.json()).toMatchObject({ code: 0, data: { run: { id: fixture.run.id, status: "running" } } });
        const reopenedC = await tasks.getStoredGenerationTaskRecord("image_processing", protection.id);
        expect(reopenedC).toMatchObject({
            id: protection.id,
            userId,
            runId: fixture.run.id,
            parentTaskId: "ecommerce-product-scene",
            status: "pending",
            executionPhase: "created",
            payload: { inputDigest: protection.payload.inputDigest, resource: { profileVersion: configurationC.profileVersion, configuration: { processHeapMb: 640 } } },
        });
        expect(reopenedC?.payload.executionId).toBeUndefined();
        expect(reopenedC?.resultPayload?.checkpoints, "Each failure checkpoint must keep only its own epoch artifacts; B never uploaded artifact A").toEqual([checkpointA, { ...identityB, failure: failureB, resource: attemptB.payload.resource }]);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBefore.id)).toEqual(prepareBefore);
        expect(await runs.getAgentRun(fixture.run.id)).toMatchObject({
            id: fixture.run.id,
            conversationId: fixture.run.conversationId,
            inputMessageId: fixture.run.inputMessageId,
            assistantMessageId: fixture.run.assistantMessageId,
            ecommerceSnapshot: fixture.planned.ecommerceSnapshot,
        });
        expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    }, 30_000);
});
