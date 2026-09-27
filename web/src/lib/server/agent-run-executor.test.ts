import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { CreativeConversationContext } from "@/lib/creative-runtime-contract";
import { AGENT_PLAN_SCHEMA_VERSION } from "./agent-run-audit";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import { canvasPlan, canvasSettings, conversationPlan, creativeImageAsset, disabledSettings, imageTask, plannerFailoverSettings, planningRun, runFixture, runWithTasks, settings } from "./agent-run-executor.test-fixtures";

const mocks = vi.hoisted(() => ({
    fetchInternalApi: vi.fn(),
    getAuthSettings: vi.fn(),
    refundUserPoints: vi.fn(async () => undefined),
    getCreativeAssetsByIds: vi.fn(async (_ids: string[] = []): Promise<Array<Record<string, unknown>>> => {
        void _ids;
        return [];
    }),
    listRecentCreativeMediaAssets: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    getCreativeConversationContext: vi.fn(async (): Promise<CreativeConversationContext> => ({ summary: "", summaryThroughSequence: 0, recentMessages: [] })),
    registerCreativeAssets: vi.fn(),
    reviewCreativeOutputs: vi.fn(),
    linkStoredGenerationTask: vi.fn(async () => undefined),
    events: [] as Array<{ type: string; data?: unknown }>,
    run: null as AgentRun | null,
    updateAgentRunById: vi.fn(),
    updateAgentRunTaskById: vi.fn(),
    scheduleGenerationTask: vi.fn(async () => undefined),
    analyzeEcommerceReferences: vi.fn(),
    planEcommerceEdit: vi.fn(),
    selectCurrentSceneBaseline: vi.fn(),
    createEditBranch: vi.fn(),
    checkEcommerceResult: vi.fn(),
    attachEcommerceTraceToGenerationLogs: vi.fn(async () => ({ updated: 1 })),
    updateImageTask: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
}));

vi.mock("@/lib/auth/store", () => ({
    getAuthSettings: mocks.getAuthSettings,
    refundUserPoints: mocks.refundUserPoints,
}));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetchInternalApi }));
vi.mock("@/lib/server/creative-runtime-store", () => ({
    getCreativeAssetsByIds: mocks.getCreativeAssetsByIds,
    getCreativeConversationContext: mocks.getCreativeConversationContext,
    listRecentCreativeMediaAssets: mocks.listRecentCreativeMediaAssets,
    registerCreativeAssets: mocks.registerCreativeAssets,
}));
vi.mock("@/lib/server/generation-task-store", () => ({ linkStoredGenerationTask: mocks.linkStoredGenerationTask }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.scheduleGenerationTask }));
vi.mock("@/lib/server/generation-log-store", () => ({ attachEcommerceTraceToGenerationLogs: mocks.attachEcommerceTraceToGenerationLogs }));
vi.mock("@/lib/server/image-task-store", () => ({ updateImageTask: mocks.updateImageTask }));
vi.mock("@/lib/server/creative-review-service", () => ({ reviewCreativeOutputs: mocks.reviewCreativeOutputs }));
vi.mock("./ecommerce-visual-analysis", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./ecommerce-visual-analysis")>();
    return { ...actual, analyzeEcommerceReferences: mocks.analyzeEcommerceReferences };
});
vi.mock("./ecommerce-edit-planner", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./ecommerce-edit-planner")>();
    return { ...actual, planEcommerceEdit: mocks.planEcommerceEdit };
});
vi.mock("./ecommerce-quality-check", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./ecommerce-quality-check")>();
    return { ...actual, checkEcommerceResult: mocks.checkEcommerceResult, checkEcommerceResultWithFallback: mocks.checkEcommerceResult };
});
vi.mock("@/lib/server/agent-run-store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/server/agent-run-store")>();
    return {
        ...actual,
        getAgentRun: vi.fn(async () => mocks.run),
        updateAgentRunById: mocks.updateAgentRunById,
        updateAgentRunTaskById: mocks.updateAgentRunTaskById,
        selectCurrentSceneBaseline: mocks.selectCurrentSceneBaseline,
        createEditBranch: mocks.createEditBranch,
    };
});

import { executeAgentRun } from "./agent-run-executor";
import { processAgentRunReview, taskResultOps } from "./agent-run-execution";
import { resetTextPlanningRuntime } from "./text-planning-runtime";

describe("executeAgentRun backend settings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "off");
        resetTextPlanningRuntime();
        mocks.events = [];
        mocks.getCreativeAssetsByIds.mockResolvedValue([]);
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([]);
        mocks.analyzeEcommerceReferences.mockReset();
        mocks.planEcommerceEdit.mockReset();
        mocks.selectCurrentSceneBaseline.mockReset().mockResolvedValue(null);
        mocks.createEditBranch.mockReset().mockImplementation(async (parentResultId: string, run: AgentRun) => ({ parentResultId, branchId: `ecommerce-${run.id}` }));
        mocks.checkEcommerceResult.mockReset().mockResolvedValue(passedQualityCheck());
        mocks.updateImageTask.mockReset().mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
        mocks.getCreativeConversationContext.mockResolvedValue({ summary: "", summaryThroughSequence: 0, recentMessages: [] });
        mocks.reviewCreativeOutputs.mockResolvedValue({ mode: "visual", status: "passed", summary: "检查通过", issues: [], retryTaskIds: [] });
        mocks.registerCreativeAssets.mockImplementation(async (inputs: Array<Record<string, unknown>>) => inputs.map((input, index) => ({ ...input, id: `asset-${index}`, status: "ready", createdAt: 1, updatedAt: 1 })));
        mocks.updateAgentRunById.mockImplementation(async (_id, patch, event, allowedStatuses, expectedExecutionId) => {
            if (!mocks.run || (allowedStatuses && !allowedStatuses.includes(mocks.run.status)) || (expectedExecutionId && mocks.run.executionId !== expectedExecutionId)) return null;
            mocks.run = {
                ...mocks.run,
                ...patch,
            };
            if (event) mocks.events.push(event);
            return mocks.run;
        });
        mocks.updateAgentRunTaskById.mockImplementation(async (_id, taskId, patch, eventType, expectedExecutionId) => {
            if (!mocks.run || mocks.run.status !== "running" || mocks.run.executionId !== expectedExecutionId) return null;
            const tasks = mocks.run.tasks.map((task) => {
                if (task.id !== taskId) return task;
                const children = new Map((task.childTasks || []).map((child) => [child.id, child]));
                for (const child of patch.childTasks || []) children.set(child.id, child);
                return {
                    ...task,
                    ...patch,
                    ...(patch.childTasks ? { childTasks: Array.from(children.values()) } : {}),
                    ...(patch.taskIds ? { taskIds: Array.from(new Set([...(task.taskIds || []), ...patch.taskIds])) } : {}),
                    ...(patch.assetIds ? { assetIds: Array.from(new Set([...(task.assetIds || []), ...patch.assetIds])) } : {}),
                };
            });
            const taskIndex = tasks.findIndex((item) => item.id === taskId);
            const task = tasks[taskIndex];
            mocks.run = { ...mocks.run, tasks, assetIds: Array.from(new Set([...mocks.run.assetIds, ...(task?.assetIds || [])])) };
            const output = task && mocks.run.surface === "canvas" && eventType === "task.completed" ? taskResultOps(mocks.run.id, taskIndex, task) : undefined;
            mocks.events.push({
                type: eventType,
                data: task ? { taskId, title: task.title, type: task.type, status: task.status, attempts: task.attempts, error: task.error, message: eventType === "task.completed" ? "任务已完成" : undefined, ops: output?.ops } : { taskId },
            });
            return mocks.run;
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") return Response.json({ task: { id: `child-${mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length}` } });
            if (url.includes("/api/image-tasks/")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/output.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });
    });

    afterEach(() => vi.unstubAllEnvs());

    it("records an ecommerce shadow snapshot without changing the legacy planner request", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "shadow");
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "把白底台灯放到明亮客厅", referencedAssetIds: ["asset-product"] });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-product", "白底台灯", "https://cdn.example.com/product.png")]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "已按原流程处理。")) }] });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.ecommerceSnapshot).toMatchObject({ mode: "shadow", input: { userRequest: "把白底台灯放到明亮客厅", assetIds: ["asset-product"] }, fallback: { reason: "ecommerce_planner_disabled" } });
        expect(mocks.analyzeEcommerceReferences).not.toHaveBeenCalled();
        expect(mocks.checkEcommerceResult).not.toHaveBeenCalled();
        const plannerBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls.find(([url]) => url.endsWith("/chat/completions"))?.[1]?.body)) as { messages: Array<{ content: string }> };
        expect(JSON.parse(plannerBody.messages[1].content)).toMatchObject({ requirement: "把白底台灯放到明亮客厅" });
        expect(mocks.run?.tasks).toEqual([]);
    });

    it("pauses for review when every visual-analysis candidate fails", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "生成简约家具图",
            referencedAssetIds: ["asset-product"],
            generationPreferences: { mode: "image", image: { count: 1 } },
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-product", "product.png", "upload")]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockRejectedValue(new Error("all vision candidates rejected the contract"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [{ status: "needs_review", error: "无法可靠分析参考图，任务已暂停等待复核。" }],
            ecommerceSnapshot: { fallback: { reason: "visual_analysis_unavailable" } },
        });
        expect(mocks.run).not.toHaveProperty("failure");
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it("executes the internal product-to-scene slice and preserves strict reference metadata", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const source = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 20, height: 28, channels: 4, background: "#252525" } }, left: 22, top: 10 }])
            .png()
            .toBuffer();
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "生成简约家具图",
            referencedAssetIds: ["asset-product"],
            generationPreferences: { mode: "image", image: { size: "4:3", quality: "high", count: 1 } },
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            {
                ...creativeImageAsset("asset-product", "product.png", "upload"),
                remoteUrl: undefined,
                serverUrl: "/api/reference-assets/product.png",
                width: 64,
                height: 48,
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettingsWithQualityFallback());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceAnalysis("product"));
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommercePlan(),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/product.png")) return new Response(source, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-ecommerce" } });
            if (url.endsWith("/api/image-tasks/child-ecommerce")) {
                return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/ecommerce.png" } } });
            }
            throw new Error("unexpected request: " + url);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const body = JSON.parse(String(createCall?.[1]?.body)) as {
            references: Array<Record<string, unknown>>;
            productProtectionRegions: Record<string, unknown>;
            ecommerceExecution: Record<string, unknown>;
        };
        expect(body.references).toEqual([expect.objectContaining({ id: "asset-product", url: "/api/reference-assets/product.png", width: 64, height: 48 })]);
        expect(body.productProtectionRegions).toMatchObject({
            productAnchorId: "asset-product",
            sourceSize: { width: 64, height: 48 },
            editableBackground: { mask: { trust: "trusted", provider: "white-background-flood-fill.v1" } },
        });
        expect(body.ecommerceExecution).toMatchObject({
            state: "ready",
            compilerVersion: "ecommerce-openai-image-2.5.v1",
            providerProfileId: "gpt-image-2.5-flare",
            modelSnapshot: {
                logicalRole: "image_generation",
                logicalModelId: "image-model",
                channelId: "image-channel",
                upstreamModel: "gpt-image-2.5-flare",
            },
        });
        expect(mocks.run).toMatchObject({
            status: "completed",
            ecommerceSnapshot: {
                mode: "active",
                plan: { operation: "product_to_scene", strategy: "strict_product" },
                compilerVersion: "ecommerce-openai-image-2.5.v1",
                modelRouteSnapshots: {
                    vision_analysis: expect.objectContaining({ logicalRole: "vision_analysis", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" }),
                    edit_planning: expect.objectContaining({ logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" }),
                    image_generation: expect.objectContaining({ channelId: "image-channel", upstreamModel: "gpt-image-2.5-flare" }),
                    quality_check: expect.objectContaining({ logicalRole: "quality_check", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" }),
                },
                qualityCheck: expect.objectContaining({ status: "passed", publicStatus: "passed" }),
            },
        });
        expect(mocks.checkEcommerceResult).toHaveBeenCalledOnce();
        expect(mocks.checkEcommerceResult.mock.calls[0]?.[1]).toEqual([
            expect.objectContaining({ logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" }),
            expect.objectContaining({
                logicalModelId: "quality-fallback",
                channelId: "quality-fallback-channel",
                upstreamModel: "gpt-5.6-sol",
            }),
        ]);
        expect(mocks.attachEcommerceTraceToGenerationLogs).toHaveBeenCalledWith(
            ["child-ecommerce"],
            expect.objectContaining({
                version: "ecommerce-generation-trace.v1",
                runId: mocks.run?.id,
                finalStatus: "passed",
                stages: expect.arrayContaining([
                    expect.objectContaining({ key: "visual_analysis", status: "completed" }),
                    expect.objectContaining({ key: "edit_planning", status: "completed" }),
                    expect.objectContaining({ key: "image_generation", status: "completed" }),
                    expect.objectContaining({ key: "quality_check", status: "passed" }),
                ]),
            }),
        );
        expect(mocks.updateImageTask).toHaveBeenCalledWith("child-ecommerce", expect.objectContaining({ ecommerceTrace: expect.objectContaining({ finalStatus: "passed" }) }));
        expect(mocks.updateImageTask.mock.invocationCallOrder[0]).toBeLessThan(mocks.attachEcommerceTraceToGenerationLogs.mock.invocationCallOrder[0]);
        expect(mocks.checkEcommerceResult.mock.invocationCallOrder[0]).toBeLessThan(mocks.registerCreativeAssets.mock.invocationCallOrder[0]);
        expect(mocks.events.filter((event) => event.type === "ecommerce.progress").map((event) => event.data)).toEqual([
            { stage: "identifying_product", text: "正在识别商品" },
            { stage: "planning_scene", text: "正在规划场景" },
            { stage: "generating_image", text: "正在生成图片" },
            { stage: "checking_result", text: "正在检查商品细节" },
        ]);
        expect(JSON.stringify(mocks.events)).not.toContain("vision-role-private");
    });

    it("routes one uploaded scene through scene editing when an image model is selected without an explicit mode", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "把画面改成冬日阳光，其他内容保持不变",
            requestedModelIds: ["image-model"],
            referencedAssetIds: ["asset-scene"],
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            {
                ...creativeImageAsset("asset-scene", "scene.png", "https://cdn.example.com/scene.png"),
                sourceRunId: "upload",
                width: 1200,
                height: 900,
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceSceneAnalysis());
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommerceScenePlan(),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-scene-edit" } });
            if (url.endsWith("/api/image-tasks/child-scene-edit")) {
                return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/scene-edited.png" } } });
            }
            throw new Error("unexpected request: " + url);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const body = JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
        expect(body.references).toEqual([expect.objectContaining({ id: "asset-scene", ecommerceRole: "scene" })]);
        expect(body).not.toHaveProperty("productProtectionRegions");
        expect(mocks.checkEcommerceResult).toHaveBeenCalledWith(
            expect.objectContaining({
                plan: expect.objectContaining({ operation: "scene_edit" }),
                baselineReference: expect.objectContaining({ assetId: "asset-scene", role: "scene" }),
            }),
            expect.any(Array),
        );
        expect(mocks.run).toMatchObject({
            status: "completed",
            ecommerceSnapshot: { plan: { operation: "scene_edit", source: { productAnchorId: null, currentSceneBaselineId: "asset-scene" } } },
        });
        expect(mocks.events.filter((event) => event.type === "ecommerce.progress")).toHaveLength(4);
    });

    it("keeps a hard-failed ecommerce result internal and pauses before asset publication", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const source = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 20, height: 28, channels: 4, background: "#252525" } }, left: 22, top: 10 }])
            .png()
            .toBuffer();
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "生成简约家具图",
            referencedAssetIds: ["asset-product"],
            generationPreferences: { mode: "image", image: { size: "4:3", quality: "high", count: 1 } },
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            {
                ...creativeImageAsset("asset-product", "product.png", ""),
                remoteUrl: undefined,
                serverUrl: "/api/reference-assets/product.png",
                width: 64,
                height: 48,
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceAnalysis("product"));
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommercePlan(),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.checkEcommerceResult.mockResolvedValue(blockedQualityCheck());
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/product.png")) return new Response(source, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-blocked" } });
            if (url.endsWith("/api/image-tasks/child-blocked")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/blocked.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.checkEcommerceResult).toHaveBeenCalledOnce();
        expect(mocks.registerCreativeAssets).not.toHaveBeenCalled();
        expect(mocks.run).toMatchObject({
            status: "paused",
            assetIds: [],
            tasks: [{ status: "needs_review", result: { url: "https://cdn.example.com/blocked.png" }, assetIds: [] }],
            ecommerceSnapshot: { qualityCheck: { status: "blocked", publicStatus: "needs_review" } },
        });
        expect(mocks.events).toContainEqual({ type: "ecommerce.quality", data: { status: "needs_review", text: "商品一致性检查未通过，需要复核。" } });
        expect(JSON.stringify(mocks.events)).not.toContain("product silhouette changed");
    });

    it("edits one explicitly referenced history result using the recovered product anchor", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const sceneBytes = await sharp({ create: { width: 100, height: 80, channels: 4, background: "#d8d8d8" } })
            .png()
            .toBuffer();
        const product = { ...creativeImageAsset("product-anchor", "product.png", ""), serverUrl: "/api/reference-assets/product.png", width: 100, height: 80 };
        const history = {
            ...creativeImageAsset("scene-result", "scene.png", ""),
            serverUrl: "/api/reference-assets/scene.png",
            width: 100,
            height: 80,
            sourceRunId: "run-product-scene",
            parentAssetId: "product-anchor",
        };
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "把背景换成厨房",
            referencedAssetIds: [history.id],
            generationPreferences: { mode: "image", image: { count: 1 } },
        });
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => {
            if (ids.includes(history.id)) return [history];
            if (ids.includes(product.id)) return [product];
            return [];
        });
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceLocalAnalysis());
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommerceLocalPlan(["background-main"]),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/scene.png")) return new Response(sceneBytes, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-local-edit" } });
            if (url.endsWith("/api/image-tasks/child-local-edit")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/local-edit.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const body = JSON.parse(String(createCall?.[1]?.body)) as { references: Array<Record<string, unknown>>; productProtectionRegions: Record<string, unknown> };
        expect(body.references).toEqual([expect.objectContaining({ id: "scene-result", ecommerceRole: "scene" }), expect.objectContaining({ id: "product-anchor", ecommerceRole: "product" })]);
        expect(body.productProtectionRegions).toMatchObject({ productAnchorId: "product-anchor", sourceAssetId: "scene-result" });
        expect(mocks.run).toMatchObject({ status: "completed", ecommerceSnapshot: { plan: { operation: "local_edit", source: { currentSceneBaselineId: "scene-result" } } } });
    });

    it("continues the latest completed scene without a new upload", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const sceneBytes = await sharp({ create: { width: 100, height: 80, channels: 4, background: "#d8d8d8" } })
            .png()
            .toBuffer();
        const product = { ...creativeImageAsset("product-anchor", "product.png", ""), serverUrl: "/api/reference-assets/product.png", width: 100, height: 80 };
        const history = {
            ...creativeImageAsset("scene-result", "scene.png", ""),
            serverUrl: "/api/reference-assets/scene.png",
            width: 100,
            height: 80,
            sourceRunId: "run-product-scene",
            parentAssetId: product.id,
        };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "再亮一点", referencedAssetIds: [], generationPreferences: { mode: "image", image: { count: 1 } } });
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([history]);
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => (ids.includes(product.id) ? [product] : []));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceLocalAnalysis());
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommerceLocalPlan(["background-main"], "再亮一点"),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/scene.png")) return new Response(sceneBytes, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-continuation" } });
            if (url.endsWith("/api/image-tasks/child-continuation")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/brighter.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.selectCurrentSceneBaseline).toHaveBeenCalledWith(mocks.run?.conversationId, undefined, mocks.run?.userId);
        expect(mocks.createEditBranch).toHaveBeenCalledWith(history.id, expect.objectContaining({ id: mocks.run?.id }), expect.any(String));
        expect(mocks.run).toMatchObject({ status: "completed", ecommerceSnapshot: { plan: { source: { productAnchorId: product.id, currentSceneBaselineId: history.id } } } });
    });

    it("uses an uploaded empty room as a scene reference while retaining product and branch IDs", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const productBytes = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 20, height: 28, channels: 4, background: "#252525" } }, left: 22, top: 10 }])
            .png()
            .toBuffer();
        const product = { ...creativeImageAsset("product-anchor", "product.png", ""), serverUrl: "/api/reference-assets/product.png", width: 64, height: 48 };
        const room = { ...creativeImageAsset("scene-reference", "room.png", ""), serverUrl: "/api/reference-assets/room.png", width: 64, height: 48 };
        const history = { ...creativeImageAsset("scene-result", "previous.png", ""), sourceRunId: "run-prior", parentAssetId: product.id };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "改成这个房间", referencedAssetIds: [room.id], generationPreferences: { mode: "image" } });
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => (ids.includes(room.id) ? [room] : ids.includes(product.id) ? [product] : []));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        const analysis = ecommerceLocalAnalysis();
        mocks.analyzeEcommerceReferences.mockResolvedValue({ ...analysis, references: [{ ...analysis.references[0], assetId: room.id, productCore: null, fusionHalo: null, editableTargets: [] }, analysis.references[1]] });
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: { ...ecommercePlan(), source: { productAnchorId: product.id, currentSceneBaselineId: null, sceneReferenceIds: [room.id] }, continuity: { parentResultId: history.id, branchId: "ecommerce-agent-run" } },
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/product.png")) return new Response(productBytes, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-room" } });
            if (url.endsWith("/api/image-tasks/child-room")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/new-room.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledWith(
            expect.objectContaining({ planningInput: expect.objectContaining({ assetCandidates: [expect.objectContaining({ id: room.id }), expect.objectContaining({ id: product.id })] }) }),
            expect.anything(),
        );
        expect(mocks.run).toMatchObject({
            status: "completed",
            ecommerceSnapshot: { plan: { operation: "product_to_scene", source: { productAnchorId: product.id, currentSceneBaselineId: null, sceneReferenceIds: [room.id] }, continuity: { parentResultId: history.id } } },
        });
    });

    it("uses both new uploads instead of the inherited product when replacing the product", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const replacementBytes = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 20, height: 28, channels: 4, background: "#252525" } }, left: 22, top: 10 }])
            .png()
            .toBuffer();
        const replacement = { ...creativeImageAsset("replacement-product", "replacement.png", ""), serverUrl: "/api/reference-assets/replacement.png", width: 64, height: 48 };
        const room = { ...creativeImageAsset("room-reference", "room.png", ""), serverUrl: "/api/reference-assets/room.png", width: 64, height: 48 };
        const oldAnchor = { ...creativeImageAsset("product-anchor", "old-product.png", ""), serverUrl: "/api/reference-assets/old-product.png" };
        const history = { ...creativeImageAsset("scene-result", "previous.png", ""), sourceRunId: "run-prior", parentAssetId: oldAnchor.id };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "换成新商品，放进这个房间", referencedAssetIds: [replacement.id, room.id], generationPreferences: { mode: "image" } });
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => (ids.includes(oldAnchor.id) ? [oldAnchor] : [replacement, room].filter((asset) => ids.includes(asset.id))));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        const analysis = ecommerceLocalAnalysis();
        mocks.analyzeEcommerceReferences.mockResolvedValue({
            ...analysis,
            references: [
                { ...analysis.references[1], assetId: replacement.id },
                { ...analysis.references[0], assetId: room.id, productCore: null, fusionHalo: null, editableTargets: [] },
            ],
        });
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: { ...ecommercePlan(), source: { productAnchorId: replacement.id, currentSceneBaselineId: null, sceneReferenceIds: [room.id] }, continuity: { parentResultId: history.id, branchId: "ecommerce-agent-run" } },
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/replacement.png")) return new Response(replacementBytes, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-replacement" } });
            if (url.endsWith("/api/image-tasks/child-replacement")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/replacement-room.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledWith(
            expect.objectContaining({ planningInput: expect.objectContaining({ assetCandidates: [expect.objectContaining({ id: replacement.id }), expect.objectContaining({ id: room.id })] }) }),
            expect.anything(),
        );
        expect(mocks.planEcommerceEdit).toHaveBeenCalledWith(
            expect.objectContaining({ sources: expect.objectContaining({ productAnchorId: replacement.id, sceneReferenceIds: [room.id], parentResultId: history.id }) }),
            expect.anything(),
            expect.anything(),
        );
        expect(mocks.createEditBranch).toHaveBeenCalledWith(history.id, expect.objectContaining({ id: mocks.run?.id }), expect.any(String));
        expect(mocks.run).toMatchObject({
            status: "completed",
            ecommerceSnapshot: { plan: { operation: "product_to_scene", source: { productAnchorId: replacement.id, currentSceneBaselineId: null, sceneReferenceIds: [room.id] }, continuity: { parentResultId: history.id } } },
        });
    });

    it("pauses an ambiguous local edit target without creating a provider task", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const product = { ...creativeImageAsset("product-anchor", "product.png", ""), serverUrl: "/api/reference-assets/product.png", width: 100, height: 80 };
        const history = {
            ...creativeImageAsset("scene-result", "scene.png", ""),
            serverUrl: "/api/reference-assets/scene.png",
            width: 100,
            height: 80,
            sourceRunId: "run-product-scene",
            parentAssetId: "product-anchor",
        };
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "去掉绿植", referencedAssetIds: [history.id], generationPreferences: { mode: "image" } });
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => (ids.includes(history.id) ? [history] : ids.includes(product.id) ? [product] : []));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceLocalAnalysis());
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommerceLocalPlan(["plant-left", "plant-right"], "去掉绿植"),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
        expect(mocks.run).toMatchObject({ status: "paused", tasks: [expect.objectContaining({ status: "needs_review", error: "检测到多个可编辑目标，请明确要修改哪一个位置或物品。" })] });
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it("persists ambiguous ecommerce references as needs_review without submitting a provider task", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "生成场景图",
            referencedAssetIds: ["asset-unknown"],
            generationPreferences: { mode: "image" },
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-unknown", "unknown.png", "https://cdn.example.com/unknown.png")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceAnalysis("unknown"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [expect.objectContaining({ id: "ecommerce-product-scene", status: "needs_review", error: expect.any(String) })],
            ecommerceSnapshot: { mode: "active", fallback: { reason: expect.any(String) } },
        });
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it("preserves generated media dimensions in canvas output ops", () => {
        const task = {
            ...imageTask("image-one"),
            attempts: 1,
            result: { url: "https://cdn.example.com/output.png", width: 1024, height: 1024, mimeType: "image/png" },
        } as AgentRunTask;

        const output = taskResultOps("agent-run", 0, task);

        expect(output.ops[0]).toMatchObject({
            type: "update_node",
            id: "output-agent-run-0-0",
            metadata: { remoteUrl: "https://cdn.example.com/output.png", naturalWidth: 1024, naturalHeight: 1024, mimeType: "image/png", size: task.ratio },
        });
        expect(output.ops).not.toContainEqual({ type: "select_nodes", ids: ["output-agent-run-0-0"] });
    });

    it("uses one immutable settings snapshot for a resumed run", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValueOnce(settings("old-image", "old-channel")).mockResolvedValue(settings("new-image", "new-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const createCall = mocks.fetchInternalApi.mock.calls.find((call) => call[1]?.method === "POST");
        const body = JSON.parse(String(createCall?.[1]?.body)) as { config: { model: string; baseUrl: string; apiKey: string } };
        expect(body.config).toMatchObject({ model: "old-image", baseUrl: "/api/ai/system/old-channel", apiKey: "" });
        expect(mocks.run?.status).toBe("completed");
    });

    it("completes a single media run and schedules its persistent review", async () => {
        mocks.run = { ...runWithTasks([imageTask("image-one")]), reviewed: false };
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.status).toBe("completed");
        expect(mocks.run?.reviewed).toBe(false);
        expect(mocks.run?.reviewStatus).toBe("review_pending");
        expect(mocks.events.at(-1)?.type).toBe("run.completed");
        expect(mocks.reviewCreativeOutputs).not.toHaveBeenCalled();
        expect(mocks.scheduleGenerationTask).toHaveBeenCalledWith("agent", "agent-run", expect.objectContaining({ executionPhase: "review_pending", lastUpstreamStatus: "review_pending" }));
    });

    it("settles a failed persistent review without unconfigured paid retries", async () => {
        mocks.run = { ...runWithTasks([imageTask("image-one")]), status: "completed", reviewed: false, reviewStatus: "review_pending" };
        mocks.reviewCreativeOutputs.mockRejectedValue(new Error("review offline"));

        await expect(processAgentRunReview(mocks.run, "http://localhost", "session=test")).resolves.toEqual({ status: "unavailable", attempts: 1 });

        expect(mocks.run).toMatchObject({ status: "completed", reviewed: true, reviewStatus: "review_unavailable", reviewAttempts: 1, review: { mode: "unavailable", status: "unavailable" } });
        expect(mocks.events.map((event) => event.type)).toEqual(["run.review.started", "run.review.background"]);
    });

    it("keeps review blocking for multi-task runs", async () => {
        mocks.run = { ...runWithTasks([imageTask("image-one"), imageTask("image-two")]), reviewed: false };
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        let finishReview: ((value: { mode: "visual"; status: "passed"; summary: string; issues: never[]; retryTaskIds: never[] }) => void) | undefined;
        mocks.reviewCreativeOutputs.mockReturnValue(
            new Promise((resolve) => {
                finishReview = resolve;
            }),
        );

        const execution = executeAgentRun(mocks.run, "http://localhost", "session=test");
        await vi.waitFor(() => expect(mocks.reviewCreativeOutputs).toHaveBeenCalledOnce());

        expect(mocks.run?.status).toBe("running");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(false);

        finishReview?.({ mode: "visual", status: "passed", summary: "检查通过", issues: [], retryTaskIds: [] });
        await execution;
        expect(mocks.run?.status).toBe("completed");
    });

    it("keeps completed media identities when review suggests revisions", async () => {
        mocks.run = { ...runWithTasks([imageTask("image-one"), imageTask("image-two")]), reviewed: false };
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.reviewCreativeOutputs.mockResolvedValue({
            mode: "visual",
            status: "needs_revision",
            summary: "第一张需要调整",
            issues: [{ taskId: "image-one", category: "composition", severity: "high", message: "主体偏移", correction: "主体居中" }],
            retryTaskIds: ["image-one"],
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
        expect(mocks.run).toMatchObject({ status: "completed", reviewed: true, reviewStatus: "review_completed", review: { status: "needs_revision", retryTaskIds: ["image-one"] } });
        expect(mocks.run?.tasks).toEqual([
            expect.objectContaining({ id: "image-one", status: "completed", taskId: expect.any(String), assetIds: expect.any(Array), result: expect.any(Object) }),
            expect.objectContaining({ id: "image-two", status: "completed", taskId: expect.any(String), assetIds: expect.any(Array), result: expect.any(Object) }),
        ]);
        expect(mocks.events.some((event) => event.type === "run.review.needs_revision")).toBe(true);
    });

    it("plans a chat request before executing every explicitly selected generation model", async () => {
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "把白底台灯放到明亮的现代客厅",
            requestedModelIds: ["image-model"],
            referencedAssetIds: ["asset-product"],
            generationPreferences: { mode: "image" },
        });
        mocks.getCreativeConversationContext.mockResolvedValue({
            summary: "同一商品使用红色包装",
            summaryThroughSequence: 1,
            recentMessages: [],
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-product", "白底台灯", "https://cdn.example.com/product.png")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        const basePlan = canvasPlan("image-model");
        const plan = {
            ...basePlan,
            deliverables: [{ ...basePlan.deliverables[0], prompt: "保留台灯外观，将白底替换为明亮现代客厅，使用自然窗光和真实接触阴影", assetIds: ["asset-product"] }],
        };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-planned" } });
            if (url.endsWith("/api/image-tasks/child-planned")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/planned.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.getCreativeConversationContext).toHaveBeenCalledWith("conversation", "user", "agent-run");
        expect(mocks.listRecentCreativeMediaAssets).not.toHaveBeenCalled();
        const planningCall = mocks.fetchInternalApi.mock.calls.find(([url]) => String(url).endsWith("/chat/completions"));
        expect(planningCall).toBeDefined();
        const planningBody = JSON.parse(String(planningCall?.[1]?.body)) as { messages: Array<{ content: string }> };
        const planningInput = JSON.parse(planningBody.messages[1].content) as { requestedModelIds: string[]; availableModels: Array<{ id: string }>; conversationContext: { summary: string } };
        expect(planningInput.requestedModelIds).toEqual(["image-model"]);
        expect(planningInput.availableModels.map((model) => model.id)).toEqual(["image-model"]);
        expect(planningInput.conversationContext.summary).toBe("同一商品使用红色包装");
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(true);
        expect(mocks.run?.tasks[0]).toMatchObject({ model: "image-model", optimizedPrompt: plan.deliverables[0].prompt });
        expect(mocks.run?.plannerAudit).toMatchObject({ mode: "model", logicalModelId: "planner" });
        expect(mocks.run?.status).toBe("completed");
    });

    it("creates Canvas plan nodes when a generation model is selected explicitly", async () => {
        mocks.run = runFixture({ surface: "canvas", prompt: "生成商品主图", requestedModelIds: ["image-model"] });
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.events.find((event) => event.type === "run.planned")).toBeUndefined();
        expect(mocks.events.find((event) => event.type === "canvas.ops")?.data).toMatchObject({
            ops: expect.arrayContaining([expect.objectContaining({ type: "add_node", id: "task-agent-run-0", nodeType: "task" }), expect.objectContaining({ type: "add_node", id: "output-agent-run-0-0", nodeType: "image" })]),
        });
        expect(mocks.run?.status).toBe("completed");
    });

    it("does not complete the run when it is paused during a parallel batch", async () => {
        mocks.run = runWithTasks([imageTask("image-one"), imageTask("image-two")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.updateAgentRunTaskById.mockImplementation(async (_id, taskId, patch, eventType, expectedExecutionId) => {
            const current = mocks.run;
            if (!current || current.status !== "running" || current.executionId !== expectedExecutionId) return null;
            const tasks = current.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task));
            mocks.run = { ...current, tasks, status: eventType === "task.completed" ? "paused" : current.status };
            return mocks.run;
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
        expect(mocks.run?.status).toBe("paused");
    });

    it("creates two independent tasks before polling either result", async () => {
        mocks.run = runWithTasks([imageTask("image-one"), imageTask("image-two")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        const postCountsAtPoll: number[] = [];
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                const count = mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length;
                return Response.json({ task: { id: "child-" + count } });
            }
            postCountsAtPoll.push(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length);
            if (url.includes("/api/image-tasks/")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/output.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(postCountsAtPoll).toEqual([2, 2]);
        expect(mocks.run?.tasks).toEqual([expect.objectContaining({ status: "completed" }), expect.objectContaining({ status: "completed" })]);
    });

    it("does not change channel settings halfway through a run", async () => {
        mocks.run = runWithTasks([imageTask("image-one"), imageTask("image-two")]);
        mocks.getAuthSettings.mockResolvedValueOnce(settings("image-model", "image-channel")).mockResolvedValueOnce(settings("image-model", "image-channel")).mockResolvedValue(disabledSettings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
        expect(mocks.run?.tasks[1]).toMatchObject({ status: "completed", attempts: 1 });
        expect(mocks.run?.status).toBe("completed");
    });

    it("resumes polling an in-flight child task instead of failing the run", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-one"), status: "running", attempts: 1, taskId: "child-existing" }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).endsWith("/api/image-tasks/child-existing"))).toBe(true);
        expect(mocks.run?.status).toBe("completed");
    });

    it("persists every child result for a multi-copy image task", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-one"), count: 2 }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => JSON.parse(String(call[1]?.body)).context.clientRequestId)).toEqual(["request:image-one:1:1", "request:image-one:1:2"]);
        expect(mocks.run?.tasks[0].childTasks).toEqual([
            expect.objectContaining({ id: "child-1", status: "completed", result: expect.objectContaining({ url: "https://cdn.example.com/output.png" }) }),
            expect.objectContaining({ id: "child-2", status: "completed", result: expect.objectContaining({ url: "https://cdn.example.com/output.png" }) }),
        ]);
        expect(mocks.run?.tasks[0].result).toMatchObject({ results: [{ url: "https://cdn.example.com/output.png" }, { url: "https://cdn.example.com/output.png" }] });
    });

    it("creates two copies before polling either result", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-one"), count: 2 }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        const postCountsAtPoll: number[] = [];
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                const count = mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length;
                return Response.json({ task: { id: "copy-" + count } });
            }
            postCountsAtPoll.push(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length);
            if (url.includes("/api/image-tasks/")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/output.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(postCountsAtPoll).toEqual([2, 2]);
        expect(mocks.run?.tasks[0].childTasks).toHaveLength(2);
    });

    it("keeps successful assets and completes the run as partial when a later image copy fails", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-one"), count: 2 }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.registerCreativeAssets.mockImplementation(async (inputs: Array<Record<string, unknown>>) => inputs.map((input) => ({ ...input, id: `asset-${input.sourceTaskId}`, status: "ready", createdAt: 1, updatedAt: 1 })));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                const count = mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length;
                return Response.json({ task: { id: `child-${count}` } });
            }
            if (url.endsWith("/api/image-tasks/child-1")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/one.png" } } });
            if (url.endsWith("/api/image-tasks/child-2")) return Response.json({ task: { status: "error", error: "第二张生成失败" } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.tasks[0]).toMatchObject({
            status: "failed",
            assetIds: ["asset-child-1"],
            childTasks: [expect.objectContaining({ id: "child-1", status: "completed" }), expect.objectContaining({ id: "child-2", status: "failed", error: "第二张生成失败" })],
        });
        expect(mocks.run?.assetIds).toEqual(["asset-child-1"]);
        expect(mocks.run?.status).toBe("completed");
        expect(mocks.events.find((event) => event.type === "run.completed")?.data).toMatchObject({ partial: true, assetIds: ["asset-child-1"], reply: expect.stringContaining("成功 1 张，失败 1 张") });
        expect(mocks.events.some((event) => event.type === "run.failed")).toBe(false);
    });

    it("resumes only unfinished children after a multi-copy run restarts", async () => {
        mocks.run = runWithTasks([
            {
                ...imageTask("image-one"),
                count: 2,
                status: "running",
                attempts: 1,
                taskId: "child-two",
                taskIds: ["child-one", "child-two"],
                childTasks: [
                    { id: "child-one", status: "completed", attempt: 1, result: { url: "https://cdn.example.com/one.png" } },
                    { id: "child-two", status: "pending", attempt: 1 },
                ],
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).endsWith("/api/image-tasks/child-one"))).toBe(false);
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).endsWith("/api/image-tasks/child-two"))).toBe(true);
        expect(mocks.run?.tasks[0].result).toMatchObject({ results: [{ url: "https://cdn.example.com/one.png" }, { url: "https://cdn.example.com/output.png" }] });
    });

    it("releases execution after a transient response and resumes the same child on the next lease", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        let polls = 0;
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") return Response.json({ task: { id: "child-transient" } });
            if (String(url).endsWith("/api/image-tasks/child-transient")) {
                polls += 1;
                return polls === 1 ? new Response("temporary", { status: 502 }) : Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/recovered.png" } } });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(polls).toBe(1);
        expect(mocks.run?.status).toBe("running");
        expect(mocks.run?.tasks[0]).toMatchObject({ status: "running", taskId: "child-transient", childTasks: [{ id: "child-transient", status: "pending" }], error: "生成任务查询暂时不可用" });
        expect(mocks.events.filter((event) => event.type === "task.waiting")).toHaveLength(1);

        await executeAgentRun(mocks.run!, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(polls).toBe(2);
        expect(mocks.events.filter((event) => event.type === "task.running")).toHaveLength(1);
        expect(mocks.run?.status).toBe("completed");
    });

    it("pauses on needs_review and resumes the same child without another upstream creation", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        let polls = 0;
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-review" } });
            if (url.endsWith("/api/image-tasks/child-review")) {
                polls += 1;
                return polls === 1 ? Response.json({ task: { status: "running", needsReview: true, reviewReason: "上游创建状态待确认" } }) : Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/recovered.png" } } });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [expect.objectContaining({ status: "needs_review", taskId: "child-review", childTasks: [expect.objectContaining({ id: "child-review", status: "needs_review" })] })],
        });
        expect(mocks.events.some((event) => event.type === "task.needs_review")).toBe(true);
        expect(mocks.events.some((event) => event.type === "run.paused")).toBe(true);

        mocks.run = { ...mocks.run!, status: "running" };
        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST" && String(call[0]).endsWith("/api/image-tasks"))).toHaveLength(1);
        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST" && String(call[0]).endsWith("/api/image-tasks/child-review"))).toHaveLength(1);
        expect(polls).toBe(2);
        expect(mocks.run?.status).toBe("completed");
    });

    it("does not create another child after an upstream task reports an error", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-error" } });
            if (url.endsWith("/api/image-tasks/child-error")) return Response.json({ task: { status: "error", error: "上游生成失败" } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(mocks.run?.tasks[0]).toMatchObject({ status: "failed", attempts: 1, taskId: "child-error", childTasks: [{ id: "child-error", status: "failed", attempt: 1, error: "上游生成失败" }], error: "上游生成失败" });
        expect(mocks.run).toMatchObject({ status: "failed", failureStage: "task_execution", failure: expect.stringContaining("上游生成失败") });
    });

    it("turns explicit canvas text-node content into a node result without calling the text task API", async () => {
        mocks.run = runWithTasks([
            {
                id: "text-one",
                title: "欢迎文案",
                type: "text",
                prompt: "创建一个文字节点，内容写“欢迎使用 VOZEB PRO Agent”，放在画布中央，并选中它。\n\n严格输出要求：只输出最终文本，不要标题、Markdown、解释或列表。",
                count: 1,
                dependencies: [],
                status: "ready",
                attempts: 0,
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).includes("/api/text-tasks"))).toBe(false);
        expect(mocks.run?.tasks[0].result).toEqual({ content: "欢迎使用 VOZEB PRO Agent" });
        const completed = mocks.events.find((event) => event.type === "task.completed") as { data?: { message?: string; ops?: Array<Record<string, unknown>> } } | undefined;
        expect(completed?.data?.message).not.toContain("无法直接操作");
        expect(completed?.data?.ops).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "add_node",
                    id: "output-agent-run-0-0",
                    nodeType: "text",
                    position: { x: 800, y: 96 },
                    metadata: expect.objectContaining({ content: "欢迎使用 VOZEB PRO Agent" }),
                }),
                { type: "select_nodes", ids: ["output-agent-run-0-0"] },
            ]),
        );
        expect(mocks.run?.status).toBe("completed");
    });

    it("stops a stale executor before it dispatches a child task", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.updateAgentRunTaskById.mockImplementationOnce(async () => {
            if (mocks.run) mocks.run = { ...mocks.run, executionId: "replacement-executor" };
            return null;
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
        expect(mocks.run?.executionId).toBe("replacement-executor");
    });

    it("accepts a strict JSON canvas plan and executes the model selected by the Agent", async () => {
        mocks.run = { ...planningRun(), selectedSkillIds: ["skill-one"] };
        const nextSettings = canvasSettings("image-default", "image-default-channel", "image-creative", "image-creative-channel") as unknown as { agentSkills: Array<Record<string, unknown>> };
        nextSettings.agentSkills = [
            {
                id: "skill-one",
                name: "商品视觉",
                description: "商品视觉规划",
                instructions: "保持商品一致",
                enabled: true,
                keywords: ["商品"],
                workspaces: ["canvas"],
                sourceVersion: "1.2.0",
                sourceCommit: "abcdef",
                sourceContentHash: "hash",
            },
        ];
        mocks.getAuthSettings.mockResolvedValue(nextSettings as never);
        const plan = canvasPlan("image-creative");
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/responses")) return new Response("unsupported endpoint", { status: 404 });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] }, { headers: { "x-vozeb-pro-points-cost": "1.25", "x-vozeb-pro-points-record-id": "points-plan" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-planned" } });
            if (url.endsWith("/api/image-tasks/child-planned")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/planned.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const planningCall = mocks.fetchInternalApi.mock.calls.find(([url]) => String(url).endsWith("/chat/completions"));
        const planningBody = JSON.parse(String(planningCall?.[1]?.body)) as { messages: Array<{ content: string }> };
        expect(planningBody.messages[0].content).toContain("你是 星河创作 画布创作 Agent");
        const planningInput = JSON.parse(planningBody.messages[1].content) as { availableModels: Array<{ id: string; capability: string }> };
        expect(planningInput.availableModels).toEqual(expect.arrayContaining([expect.objectContaining({ id: "image-default", capability: "image" }), expect.objectContaining({ id: "image-creative", capability: "image" })]));
        expect(mocks.run?.plannerContext).toMatchObject({
            serializedChars: expect.any(Number),
            kept: { modelIds: expect.arrayContaining(["image-default", "image-creative"]) },
            omitted: { modelIds: [], skillIds: [], assetIds: [], recentMessageSequences: [] },
        });
        expect(mocks.run?.plannerContext).not.toHaveProperty("maxInputChars");
        expect(mocks.run?.plannerAudit).toMatchObject({
            schemaVersion: AGENT_PLAN_SCHEMA_VERSION,
            mode: "model",
            logicalModelId: "planner",
            channelId: "planner-channel",
            upstreamModel: "vendor/planner",
            protocol: "chat",
            elapsedMs: expect.any(Number),
            pointsCost: 1.25,
            pointsRecordId: "points-plan",
            skills: [
                {
                    id: "skill-one",
                    name: "商品视觉",
                    description: "商品视觉规划",
                    plannerSummary: "商品视觉规划",
                    instructions: "保持商品一致",
                    enabled: true,
                    keywords: ["商品"],
                    workspaces: ["canvas"],
                    action: "generate",
                    requiresReference: false,
                    defaultConfig: {},
                    sourceVersion: "1.2.0",
                    sourceCommit: "abcdef",
                    sourceContentHash: "hash",
                },
            ],
        });
        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const createBody = JSON.parse(String(createCall?.[1]?.body)) as { config: { model: string } };
        expect(createBody.config.model).toBe("image-creative");
        const planEvent = mocks.events.find((event) => event.type === "canvas.ops") as { data?: { reply?: string } } | undefined;
        expect(planEvent?.data?.reply).toBe("已收到，我会按你的要求完成这次画布创作。");
        expect(mocks.run?.status).toBe("completed");
    });

    it("passes the persistent summary and recent messages to the planner", async () => {
        mocks.run = planningRun("继续刚才的红色服装方案");
        mocks.getCreativeConversationContext.mockResolvedValue({
            summary: "用户正在制作统一的新中式女主角色。",
            summaryThroughSequence: 8,
            recentMessages: [{ id: "history-one", conversationId: "conversation", sequence: 9, role: "assistant", status: "completed", content: "第二张采用红色服装。", metadata: {}, createdAt: 1, updatedAt: 1 }],
        });
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockResolvedValue(Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify({ ...canvasPlan("image-default"), intent: "conversation", decisions: [], deliverables: [] }) }] }));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const body = JSON.parse(String(mocks.fetchInternalApi.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> };
        expect(JSON.parse(body.messages[1].content)).toMatchObject({
            conversationContext: { summary: "用户正在制作统一的新中式女主角色。", recentMessages: [{ role: "assistant", content: "第二张采用红色服装。", sequence: 9 }] },
        });
        expect(mocks.getCreativeConversationContext).toHaveBeenCalledWith("conversation", "user", "agent-run");
    });

    it("lets the text model select a same-conversation media candidate for continuous creation", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "继续上一张，把衣服换成红色" });
        const memoryAsset = creativeImageAsset("asset-memory", "上一张角色图", "https://cdn.example.com/memory.png");
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([memoryAsset]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const plan = {
            ...canvasPlan("image-default"),
            deliverables: [{ ...canvasPlan("image-default").deliverables[0], assetIds: [memoryAsset.id] }],
        };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-memory" } });
            if (url.endsWith("/api/image-tasks/child-memory")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/continued.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.listRecentCreativeMediaAssets).toHaveBeenCalledWith("conversation", "user", 6);
        const planningBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls.find(([url]) => String(url).endsWith("/chat/completions"))?.[1]?.body)) as { messages: Array<{ content: string }> };
        expect(JSON.parse(planningBody.messages[1].content)).toMatchObject({
            referenceContext: { source: "conversation-memory-candidates" },
            referencedAssets: [{ id: "asset-memory", title: "上一张角色图" }],
        });
        const createBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))?.[1]?.body));
        expect(createBody.references).toEqual([{ dataUrl: "", url: "https://cdn.example.com/memory.png" }]);
    });

    it("keeps current-turn attachments exclusive and does not mix conversation memory", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "@图片1 保持人物，@图片2 改成夜景", referencedAssetIds: ["asset-first", "asset-second"] });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-second", "第二张附件", "https://cdn.example.com/second.png"), creativeImageAsset("asset-first", "第一张附件", "https://cdn.example.com/first.png")]);
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([creativeImageAsset("asset-memory", "历史图片", "https://cdn.example.com/memory.png")]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockResolvedValue(Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify({ ...canvasPlan("image-default"), intent: "conversation", decisions: [], deliverables: [] }) }] }));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.listRecentCreativeMediaAssets).not.toHaveBeenCalled();
        const planningBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> };
        expect(JSON.parse(planningBody.messages[1].content)).toMatchObject({
            referenceContext: { source: "current-turn-explicit" },
            referencedAssets: [
                { id: "asset-first", alias: "@图片1", title: "第一张附件" },
                { id: "asset-second", alias: "@图片2", title: "第二张附件" },
            ],
        });
    });

    it("does not attach an old candidate when the text model plans a new subject", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "新建一个完全独立的海边产品主视觉" });
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([creativeImageAsset("asset-old", "旧角色", "https://cdn.example.com/old.png")]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const plan = { ...canvasPlan("image-default"), deliverables: [{ ...canvasPlan("image-default").deliverables[0], assetIds: [] }] };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-new-subject" } });
            if (url.endsWith("/api/image-tasks/child-new-subject")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/new.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const createBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))?.[1]?.body));
        expect(createBody.references).toEqual([]);
        expect(mocks.run?.tasks[0].referenceAssetId).toBeUndefined();
    });

    it("answers ordinary conversation without creating canvas ops or media tasks", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockResolvedValue(
            Response.json({
                output: [
                    {
                        type: "function_call",
                        name: "create_agent_plan",
                        arguments: JSON.stringify({ ...canvasPlan("image-default"), intent: "conversation", reply: "在的，你可以直接和我聊天，也可以让我操作当前画布。", decisions: [], deliverables: [] }),
                    },
                ],
            }),
        );

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.status).toBe("completed");
        expect(mocks.run?.tasks).toEqual([]);
        expect(mocks.events.some((event) => event.type === "canvas.ops")).toBe(false);
        expect(mocks.events.find((event) => event.type === "run.completed")?.data).toMatchObject({ completed: 0, reply: "在的，你可以直接和我聊天，也可以让我操作当前画布。" });
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => /\/api\/(?:image|video|audio|text)-tasks/.test(String(url)))).toBe(false);
    });

    it("falls back to structured Chat Completions when Responses returns prose", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/responses")) return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "在的，你可以直接告诉我想创作什么。" }] }] });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: JSON.stringify(conversationPlan("image-default", "在的，你可以直接告诉我想创作什么。")) } }] });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.status).toBe("completed");
        expect(mocks.events.find((event) => event.type === "run.completed")?.data).toMatchObject({ completed: 0, reply: "在的，你可以直接告诉我想创作什么。" });
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
    });

    it("rejects an unstructured prose planner response instead of pretending generation completed", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/responses")) return new Response("unsupported", { status: 404 });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "在的，需要我帮你做什么？" } }] });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.status).toBe("failed");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(false);
    });

    it("does not submit a second planning request when the Responses outcome is unknown", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const timeoutController = new AbortController();
        timeoutController.abort(new DOMException("timed out", "TimeoutError"));
        const timeoutCalls: number[] = [];
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
            timeoutCalls.push(milliseconds);
            return timeoutController.signal;
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) {
                expect(init?.signal?.aborted).toBe(true);
                throw new DOMException("timed out", "TimeoutError");
            }
            throw new Error(`unexpected request: ${url}`);
        });

        try {
            await executeAgentRun(mocks.run, "http://localhost", "session=test");
        } finally {
            timeoutSpy.mockRestore();
        }

        expect(timeoutCalls).toContain(3 * 60_000);
        expect(mocks.fetchInternalApi.mock.calls.map(([url]) => String(url))).toEqual([expect.stringMatching(/\/chat\/completions$/)]);
        expect(mocks.run?.status).toBe("failed");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(false);
    });

    it("switches to a healthy planning channel after a 5xx response", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(plannerFailoverSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.includes("/planner-primary/") && (url.endsWith("/responses") || url.endsWith("/chat/completions"))) return new Response("unavailable", { status: 502 });
            if (url.includes("/planner-backup/") && url.endsWith("/chat/completions"))
                return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "备用规划渠道已接管。")) }] });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).includes("/planner-primary/"))).toBe(true);
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).includes("/planner-backup/"))).toBe(true);
        expect(mocks.run?.status).toBe("completed");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(true);
    });

    it("automatically switches to the next planning model after a timeout", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(plannerFailoverSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.includes("/planner-primary/") && url.endsWith("/chat/completions")) throw new DOMException("timed out", "TimeoutError");
            if (url.includes("/planner-backup/") && url.endsWith("/chat/completions"))
                return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "备用文本模型已自动接管。")) }] });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const primaryCalls = mocks.fetchInternalApi.mock.calls.filter(([url]) => String(url).includes("/planner-primary/"));
        const backupCalls = mocks.fetchInternalApi.mock.calls.filter(([url]) => String(url).includes("/planner-backup/"));
        expect(primaryCalls).toHaveLength(1);
        expect(backupCalls).toHaveLength(1);
        expect(mocks.run?.status).toBe("completed");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(true);
    });

    it("plans chat media without canvas ops, links the child task and registers a stable asset", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "把这张图改成红色服装", referencedAssetIds: ["asset-source"], requestedImageSize: "1080x1213" });
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            {
                id: "asset-source",
                userId: "user",
                conversationId: "conversation",
                ordinal: 0,
                type: "image",
                status: "ready",
                title: "参考角色",
                remoteUrl: "https://cdn.example.com/source.png",
                metadata: {},
                createdAt: 1,
                updatedAt: 1,
            },
            {
                id: "asset-style",
                userId: "user",
                conversationId: "conversation",
                ordinal: 1,
                type: "image",
                status: "ready",
                title: "风格参考",
                remoteUrl: "https://cdn.example.com/style.png",
                metadata: {},
                createdAt: 1,
                updatedAt: 1,
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const plan = { ...canvasPlan("image-default"), deliverables: [{ ...canvasPlan("image-default").deliverables[0], assetIds: ["asset-source", "asset-style"] }] };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-chat" } });
            if (url.endsWith("/api/image-tasks/child-chat")) return Response.json({ task: { status: "success", result: { dataUrl: "data:image/png;base64,abc", remoteUrl: "https://cdn.example.com/result.png", mimeType: "image/png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.events.some((event) => event.type === "canvas.ops")).toBe(false);
        expect(mocks.events.some((event) => event.type === "run.planned")).toBe(true);
        expect(mocks.events.find((event) => event.type === "task.completed")?.data).not.toMatchObject({ ops: expect.anything() });
        expect(mocks.linkStoredGenerationTask).toHaveBeenCalledWith("image", "child-chat", {
            conversationId: "conversation",
            runId: "agent-run",
            surface: "chat",
            projectId: undefined,
            parentTaskId: "agent-run",
            attemptNo: 1,
        });
        expect(mocks.registerCreativeAssets).toHaveBeenCalledWith([expect.objectContaining({ sourceTaskId: "child-chat", parentAssetId: "asset-source", remoteUrl: "https://cdn.example.com/result.png", messageId: "assistant-message" })]);
        expect(mocks.registerCreativeAssets.mock.calls[0][0][0]).not.toHaveProperty("dataUrl");
        expect(mocks.run?.assetIds).toEqual(["asset-0"]);
        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({ source: "agent", config: { size: "1080x1213" }, references: [{ url: "https://cdn.example.com/source.png" }, { url: "https://cdn.example.com/style.png" }] });
    });

    it("uses completed dependency assets as real references for downstream video", async () => {
        mocks.run = runWithTasks([imageTask("image-one"), { id: "video-one", title: "角色动画", type: "video", model: "video-model", prompt: "让角色缓慢转身", count: 1, dependencies: ["image-one"], status: "ready", attempts: 0 }]);
        const nextSettings = settings("image-model", "image-channel") as unknown as {
            defaultModels: { videoModel: string };
            systemChannels: Array<Record<string, unknown>>;
            logicalModels: Array<Record<string, unknown>>;
        };
        nextSettings.defaultModels.videoModel = "video-model";
        nextSettings.systemChannels.push({ id: "video-channel", name: "视频", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "video-secret", models: ["vendor/video-model"] });
        nextSettings.logicalModels.push({ id: "video-model", name: "视频", capability: "video", enabled: true, bindings: [{ id: "video-binding", channelId: "video-channel", upstreamModel: "vendor/video-model", enabled: true, priority: 1 }] });
        mocks.getAuthSettings.mockResolvedValue(nextSettings as never);
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids?: string[]) =>
            ids?.includes("asset-0")
                ? [
                      {
                          id: "asset-0",
                          userId: "user",
                          conversationId: "conversation",
                          sourceTaskId: "child-image",
                          ordinal: 0,
                          type: "image",
                          status: "ready",
                          title: "角色图",
                          remoteUrl: "https://cdn.example.com/dependency.png",
                          metadata: {},
                          createdAt: 1,
                          updatedAt: 1,
                      },
                  ]
                : [],
        );
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-image" } });
            if (url.endsWith("/api/image-tasks/child-image")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/dependency.png" } } });
            if (init?.method === "POST" && url.endsWith("/api/video-generation-tasks")) return Response.json({ task: { id: "child-video" } });
            if (url.endsWith("/api/video-tasks/child-video")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/dependency.mp4" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const videoCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/video-generation-tasks"));
        expect(JSON.parse(String(videoCall?.[1]?.body))).toMatchObject({ references: [{ type: "image", url: "https://cdn.example.com/dependency.png" }] });
        expect(mocks.run?.tasks[1]).toMatchObject({ status: "completed", referenceAssetId: "asset-0", references: [{ assetId: "asset-0", url: "https://cdn.example.com/dependency.png", type: "image" }] });
    });

    it("dispatches explicit video frame roles unchanged to the video route", async () => {
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            status: "running",
            reviewed: true,
            tasks: [
                {
                    id: "video-frames",
                    title: "首尾衔接视频",
                    type: "video",
                    model: "video-model",
                    prompt: "自然运镜",
                    count: 1,
                    dependencies: [],
                    status: "ready",
                    attempts: 0,
                    references: [
                        { assetId: "first-image", type: "image", url: "https://cdn.example.com/first.png", role: "first_frame" },
                        { assetId: "last-image", type: "image", url: "https://cdn.example.com/last.png", role: "last_frame" },
                    ],
                },
            ],
        });
        const nextSettings = settings("image-model", "image-channel") as unknown as {
            defaultModels: { videoModel: string };
            systemChannels: Array<Record<string, unknown>>;
            logicalModels: Array<Record<string, unknown>>;
        };
        nextSettings.defaultModels.videoModel = "video-model";
        nextSettings.systemChannels.push({ id: "video-channel", name: "视频", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "video-secret", models: ["vendor/video-model"] });
        nextSettings.logicalModels.push({ id: "video-model", name: "视频", capability: "video", enabled: true, bindings: [{ id: "video-binding", channelId: "video-channel", upstreamModel: "vendor/video-model", enabled: true, priority: 1 }] });
        mocks.getAuthSettings.mockResolvedValue(nextSettings as never);
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/video-generation-tasks")) return Response.json({ task: { id: "child-video-frames" } });
            if (url.endsWith("/api/video-tasks/child-video-frames")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/result.mp4" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const videoCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/video-generation-tasks"));
        expect(JSON.parse(String(videoCall?.[1]?.body))).toMatchObject({
            references: [
                { type: "image", url: "https://cdn.example.com/first.png", role: "first_frame" },
                { type: "image", url: "https://cdn.example.com/last.png", role: "last_frame" },
            ],
        });
    });

    it("passes explicit video flags and audio speed to child task routes", async () => {
        mocks.run = runWithTasks([
            { id: "video-one", title: "产品视频", type: "video", model: "video-model", prompt: "生成产品视频", count: 1, ratio: "21:9", quality: "2160", seconds: 60, generateAudio: false, watermark: true, dependencies: [], status: "ready", attempts: 0 },
            { id: "audio-one", title: "产品旁白", type: "audio", model: "audio-model", prompt: "生成产品旁白", count: 1, voice: "nova", format: "wav", speed: 1.25, dependencies: [], status: "ready", attempts: 0 },
        ]);
        const nextSettings = settings("image-model", "image-channel") as unknown as {
            defaultModels: { videoModel: string; audioModel: string };
            systemChannels: Array<Record<string, unknown>>;
            logicalModels: Array<Record<string, unknown>>;
        };
        nextSettings.defaultModels.videoModel = "video-model";
        nextSettings.defaultModels.audioModel = "audio-model";
        nextSettings.systemChannels.push(
            { id: "video-channel", name: "视频", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "video-secret", models: ["vendor/video-model"] },
            { id: "audio-channel", name: "音频", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "audio-secret", models: ["vendor/audio-model"] },
        );
        nextSettings.logicalModels.push(
            { id: "video-model", name: "视频", capability: "video", enabled: true, bindings: [{ id: "video-binding", channelId: "video-channel", upstreamModel: "vendor/video-model", enabled: true, priority: 1 }] },
            { id: "audio-model", name: "音频", capability: "audio", enabled: true, bindings: [{ id: "audio-binding", channelId: "audio-channel", upstreamModel: "vendor/audio-model", enabled: true, priority: 1 }] },
        );
        mocks.getAuthSettings.mockResolvedValue(nextSettings as never);
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/video-generation-tasks")) return Response.json({ task: { id: "child-video" } });
            if (init?.method === "POST" && url.endsWith("/api/audio-tasks")) return Response.json({ task: { id: "child-audio" } });
            if (url.endsWith("/api/video-tasks/child-video")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/result.mp4" } } });
            if (url.endsWith("/api/audio-tasks/child-audio")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/result.wav" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const videoCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/video-generation-tasks"));
        const audioCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/audio-tasks"));
        expect(JSON.parse(String(videoCall?.[1]?.body))).toMatchObject({ config: { size: "21:9", vquality: "2160", videoSeconds: "60", videoGenerateAudio: "false", videoWatermark: "true" } });
        expect(JSON.parse(String(audioCall?.[1]?.body))).toMatchObject({ config: { voice: "nova", format: "wav", speed: "1.25" } });
    });

    it("passes drama project context to planning without creating canvas operations", async () => {
        mocks.run = runFixture({ surface: "drama", projectId: "drama-project", snapshot: { episodeId: "episode-one" }, prompt: "这个角色为什么要离开？" });
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockResolvedValue(
            Response.json({
                output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify({ ...canvasPlan("image-default"), intent: "conversation", reply: "因为当前冲突迫使角色主动离开。", decisions: [], deliverables: [] }) }],
            }),
        );

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const planningBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> };
        expect(JSON.parse(planningBody.messages[1].content)).toMatchObject({ surface: "drama", projectId: "drama-project", projectSnapshot: { episodeId: "episode-one" } });
        expect(mocks.events.some((event) => event.type === "canvas.ops")).toBe(false);
        expect(mocks.run?.status).toBe("completed");
    });

    it("emits an idempotent project handoff for chat without creating media tasks", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "把这些内容建立成短剧项目", referencedAssetIds: ["asset-source"] });
        const sourceAsset = {
            id: "asset-source",
            userId: "user",
            conversationId: "conversation",
            ordinal: 0,
            type: "image",
            status: "ready",
            title: "女主设定",
            remoteUrl: "https://cdn.example.com/hero.png",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        mocks.getCreativeAssetsByIds.mockResolvedValue([sourceAsset]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const plan = {
            ...canvasPlan("image-default"),
            deliverables: [],
            projectHandoff: { surface: "drama", title: "都市悬疑", summary: "女主追查失踪案", style: "写实电影感", ratio: "9:16", assetIds: ["asset-source"] },
        };
        mocks.fetchInternalApi.mockResolvedValue(Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] }));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => /\/api\/(?:image|video|audio|text)-tasks/.test(String(url)))).toBe(false);
        expect(mocks.events.find((event) => event.type === "project.handoff")?.data).toMatchObject({
            id: "handoff-agent-run",
            surface: "drama",
            title: "都市悬疑",
            assetIds: ["asset-source"],
            assets: [expect.objectContaining({ id: "asset-source" })],
        });
        expect(mocks.events.filter((event) => event.type === "project.handoff")).toHaveLength(1);
        expect(mocks.events.find((event) => event.type === "run.completed")?.data).toMatchObject({ projectHandoff: { id: "handoff-agent-run" } });
        expect(mocks.run).toMatchObject({ status: "completed", projectHandoffEmitted: true });
    });

    it("ignores an invalid project handoff attached to an ordinary image plan", async () => {
        mocks.run = planningRun("生成森林女子角色设定图");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const plan = {
            ...canvasPlan("image-default"),
            projectHandoff: { surface: "canvas", title: "", ratio: "1:1", assetIds: [""] },
        };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-image" } });
            if (url.endsWith("/api/image-tasks/child-image")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/forest.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run).toMatchObject({ status: "completed", projectHandoff: undefined });
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(true);
        expect(mocks.events.some((event) => event.type === "project.handoff")).toBe(false);
    });

    it("falls back to the backend default when the planned model is invalid", async () => {
        mocks.run = planningRun();
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/responses")) return new Response("unsupported endpoint", { status: 404 });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: JSON.stringify(canvasPlan("forged-upstream-model")) } }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-default" } });
            if (url.endsWith("/api/image-tasks/child-default")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/default.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const createBody = JSON.parse(String(createCall?.[1]?.body)) as { config: { model: string } };
        expect(createBody.config.model).toBe("image-default");
        expect(mocks.run?.tasks[0].model).toBe("image-default");
    });

    it("refunds text planning cost when chat fallback returns prose instead of structured JSON", async () => {
        mocks.run = planningRun();
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/responses")) return new Response("unsupported endpoint", { status: 404 });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "我建议使用横版构图。" } }] }, { headers: { "x-vozeb-pro-points-cost": "2", "x-vozeb-pro-points-record-id": "points-agent-plan" } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user", "planner", 2, "text", 1, undefined, "points-agent-plan");
        expect(mocks.run).toMatchObject({
            status: "failed",
            failureStage: "planning",
            failure: expect.any(String),
            candidateFailures: [{ channelId: "planner-channel", upstreamModel: "vendor/planner", error: expect.any(String) }],
        });
    });

    it("refunds a zero-cost planning record when persisting the conversation reply fails", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockResolvedValue(
            Response.json(
                { output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "在的。")) }] },
                { headers: { "x-vozeb-pro-points-cost": "0", "x-vozeb-pro-points-record-id": "points-agent-free" } },
            ),
        );
        mocks.updateAgentRunById.mockImplementation(async (_id, patch, event, allowedStatuses, expectedExecutionId) => {
            if (!mocks.run || (allowedStatuses && !allowedStatuses.includes(mocks.run.status)) || (expectedExecutionId && mocks.run.executionId !== expectedExecutionId)) return null;
            if (event?.type === "run.completed") throw new Error("conversation persistence failed");
            mocks.run = { ...mocks.run, ...patch };
            if (event) mocks.events.push(event);
            return mocks.run;
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user", "planner", 0, "text", 1, undefined, "points-agent-free");
        expect(mocks.run?.status).toBe("failed");
    });

    it("refunds a completed planning call when the run is cancelled before persistence", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async () => {
            mocks.run = mocks.run ? { ...mocks.run, status: "cancelled" } : null;
            return Response.json(
                { output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "在的。")) }] },
                { headers: { "x-vozeb-pro-points-cost": "3", "x-vozeb-pro-points-record-id": "points-agent-cancelled" } },
            );
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user", "planner", 3, "text", 1, undefined, "points-agent-cancelled");
        expect(mocks.run?.status).toBe("cancelled");
    });
});

function ecommerceSettings() {
    const value = settings("image-model", "image-channel") as unknown as {
        systemChannels: Array<{ id: string; apiFormat?: string; models: string[] }>;
        logicalModels: Array<{ id: string; bindings: Array<{ upstreamModel: string }> }>;
    };
    const channel = value.systemChannels.find((item) => item.id === "image-channel");
    const model = value.logicalModels.find((item) => item.id === "image-model");
    if (!channel || !model) throw new Error("missing ecommerce image fixture");
    channel.apiFormat = "openai";
    channel.models = ["gpt-image-2.5-flare"];
    model.bindings[0].upstreamModel = "gpt-image-2.5-flare";
    return value as never;
}

function ecommerceSettingsWithQualityFallback() {
    const value = ecommerceSettings() as unknown as {
        systemChannels: Array<Record<string, unknown>>;
        logicalModels: Array<Record<string, unknown>>;
        ecommerceModelRoles?: Record<string, string[]>;
    };
    value.systemChannels.push({
        id: "quality-fallback-channel",
        name: "Quality fallback",
        enabled: true,
        apiFormat: "openai",
        baseUrl: "https://api.example.com/v1",
        apiKey: "quality-fallback-secret",
        models: ["gpt-5.6-sol"],
    });
    value.logicalModels.push({
        id: "quality-fallback",
        name: "Quality fallback",
        capability: "text",
        enabled: true,
        bindings: [{ id: "quality-fallback-binding", channelId: "quality-fallback-channel", upstreamModel: "gpt-5.6-sol", enabled: true, priority: 1 }],
    });
    value.ecommerceModelRoles = { quality_check: ["planner", "quality-fallback"] };
    return value as never;
}

function ecommerceAnalysis(role: "product" | "unknown") {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1" as const,
        modelRole: {
            logicalRole: "vision_analysis" as const,
            logicalModelId: "planner",
            channelId: "planner-channel",
            upstreamModel: "vendor/planner",
        },
        references: [
            role === "product"
                ? {
                      assetId: "asset-product",
                      role,
                      confidence: "high" as const,
                      visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                      productFacts: { identity: "chair", outline: "chair", color: "oak", material: "wood", brandText: [], view: "front" },
                      sceneFacts: null,
                      productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
                      fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
                      editableTargets: [],
                  }
                : {
                      assetId: "asset-unknown",
                      role,
                      confidence: "low" as const,
                      visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: false },
                      productFacts: null,
                      sceneFacts: null,
                      productCore: null,
                      fusionHalo: null,
                      editableTargets: [],
                  },
        ],
    };
}

function ecommercePlan() {
    return {
        planVersion: "ecommerce-edit.v1" as const,
        operation: "product_to_scene" as const,
        source: { productAnchorId: "asset-product", currentSceneBaselineId: null, sceneReferenceIds: [] },
        baseline: {
            productFacts: { identity: "chair", outline: "chair", color: "oak", material: "wood", brandText: [], view: "front" },
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: ["place in room"], targetObjects: ["scene"], targetRegions: ["background"] },
        preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
        strategy: "strict_product" as const,
        modelRoles: { visionAnalysis: "vision-role-private", editPlanning: "planner", generation: "image-model", qualityCheck: "planner" },
        continuity: { parentResultId: null, branchId: "ecommerce-agent-run" },
        validation: { requiredChecks: ["product_identity"] },
    };
}

function passedQualityCheck() {
    return {
        version: "ecommerce-quality.v1" as const,
        status: "passed" as const,
        publicStatus: "passed" as const,
        modelRole: { logicalRole: "quality_check" as const, capability: "text" as const, logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner", apiFormat: "openai" as const },
        checks: [],
        hardFailures: [],
        internalReason: "all required checks passed",
        checkedAt: 1,
    };
}

function blockedQualityCheck() {
    return {
        ...passedQualityCheck(),
        status: "blocked" as const,
        publicStatus: "needs_review" as const,
        checks: [{ resultId: "child-blocked", key: "product_silhouette" as const, status: "failed" as const, reason: "product silhouette changed" }],
        hardFailures: [{ resultId: "child-blocked", key: "product_silhouette" as const, status: "failed" as const, reason: "product silhouette changed" }],
        internalReason: "product silhouette changed",
    };
}

function ecommerceLocalAnalysis() {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1" as const,
        modelRole: { logicalRole: "vision_analysis" as const, logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        references: [
            {
                assetId: "scene-result",
                role: "scene" as const,
                confidence: "high" as const,
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
                productCore: { x: 0.4, y: 0.25, width: 0.2, height: 0.5 },
                fusionHalo: { x: 0.35, y: 0.2, width: 0.3, height: 0.6 },
                editableTargets: [
                    { id: "background-main", kind: "background" as const, label: "main background", region: { x: 0, y: 0, width: 1, height: 1 } },
                    { id: "plant-left", kind: "prop" as const, label: "left plant", region: { x: 0.02, y: 0.2, width: 0.2, height: 0.58 } },
                    { id: "plant-right", kind: "prop" as const, label: "right plant", region: { x: 0.72, y: 0.2, width: 0.2, height: 0.58 } },
                ],
            },
            {
                assetId: "product-anchor",
                role: "product" as const,
                confidence: "high" as const,
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: { identity: "chair", outline: "chair", color: "oak", material: "wood", brandText: [], view: "front" },
                sceneFacts: null,
                productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
                fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
                editableTargets: [],
            },
        ],
    };
}

function ecommerceLocalPlan(targetObjects: string[], request = "把背景换成厨房") {
    return {
        ...ecommercePlan(),
        operation: "local_edit" as const,
        source: { productAnchorId: "product-anchor", currentSceneBaselineId: "scene-result", sceneReferenceIds: [] },
        baseline: {
            productFacts: { identity: "chair", outline: "chair", color: "oak", material: "wood", brandText: [], view: "front" },
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: [request], targetObjects, targetRegions: [] },
        continuity: { parentResultId: "scene-result", branchId: "ecommerce-agent-run" },
    };
}

function ecommerceSceneAnalysis() {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1" as const,
        modelRole: {
            logicalRole: "vision_analysis" as const,
            logicalModelId: "planner",
            channelId: "planner-channel",
            upstreamModel: "vendor/planner",
        },
        references: [
            {
                assetId: "asset-scene",
                role: "scene" as const,
                confidence: "high" as const,
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
                productCore: null,
                fusionHalo: null,
                editableTargets: [
                    {
                        id: "lighting-main",
                        kind: "lighting" as const,
                        label: "main scene lighting",
                        region: { x: 0, y: 0, width: 1, height: 1 },
                    },
                ],
            },
        ],
    };
}

function ecommerceScenePlan() {
    return {
        ...ecommercePlan(),
        operation: "scene_edit" as const,
        source: { productAnchorId: null, currentSceneBaselineId: "asset-scene", sceneReferenceIds: [] },
        baseline: {
            productFacts: null,
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: ["winter sunlight"], targetObjects: ["lighting-main"], targetRegions: ["whole-scene"] },
        preserve: { productCore: [], sceneElements: ["layout", "furniture", "camera"] },
        strategy: "integrated_scene" as const,
        validation: { requiredChecks: ["requested_edit", "scene_preservation", "composition_lighting"] },
    };
}
