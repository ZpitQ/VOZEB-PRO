import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSettings } from "@/lib/auth/store";
import type { AgentRun } from "./agent-run-store";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { settings } from "./agent-run-executor.test-fixtures";

const boundary = vi.hoisted(() => ({ settings: vi.fn<() => Promise<AuthSettings>>() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => ({ id: "history-retry-user" }) }));
vi.mock("@/lib/auth/store", async (original) => ({ ...(await original<typeof import("@/lib/auth/store")>()), getAuthSettings: boundary.settings }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("./agent-run-executor", () => ({ abortAgentRun: vi.fn() }));
vi.mock("./generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: vi.fn() }));

describe("historical full-image retry through the File parent and child lock", () => {
    let directory: string;
    let runs: typeof import("./agent-run-store");
    let runtime: typeof import("./creative-runtime-store");
    let tasks: typeof import("./generation-task-store");
    let post: typeof import("@/app/api/agent/runs/[id]/[action]/route").POST;
    let configured: AuthSettings;

    beforeEach(async () => {
        vi.resetModules();
        directory = await mkdtemp(join(tmpdir(), "vozeb-history-retry-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        configured = settings("image-model", "image-channel");
        configured.generationConcurrency.agent = 2;
        boundary.settings.mockReset().mockResolvedValue(configured);
        [runs, runtime, tasks] = await Promise.all([import("./agent-run-store"), import("./creative-runtime-store"), import("./generation-task-store")]);
        post = (await import("@/app/api/agent/runs/[id]/[action]/route")).POST;
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    async function oldPause() {
        const userId = "history-retry-user";
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const [asset] = await runtime.registerCreativeAssets([
            { userId, conversationId: conversation.id, ordinal: 0, type: "image", title: "original.png", sourceRunId: "upload", serverUrl: "/api/reference-assets/original.png", width: 64, height: 48, metadata: {} },
        ]);
        const { run } = await runs.createAgentRun(userId, { conversationId: conversation.id, surface: "chat", clientRequestId: randomUUID(), prompt: "移除左侧花瓶，其他保持不变", assetIds: [asset.id], skillIds: [], modelIds: [] });
        const { buildEcommercePlanningInput } = await import("./ecommerce-generation-snapshot");
        const { createEcommerceReferenceCheckpoint } = await import("./ecommerce-reference-recovery");
        const checkpoint = createEcommerceReferenceCheckpoint(run, buildEcommercePlanningInput(run, [asset], { summary: "", recentMessages: [] }), [asset]);
        const plan: EcommerceEditPlan = {
            planVersion: "ecommerce-edit.v6",
            operation: "scene_edit",
            strategy: "integrated_scene",
            source: { productAnchorId: null, currentSceneBaselineId: asset.id, sceneReferenceIds: [] },
            referenceUses: [{ assetId: asset.id, alias: "图片1", purposes: ["edit_target"], usedCueIds: [] }],
            baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye level", lighting: "daylight" } },
            delta: { requestedChanges: [run.prompt], targetObjects: ["vase"], targetRegions: [] },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            protection: { scope: "local", protectedObjectIds: [], preserveOutsideMask: true, allowLightingChange: false },
            canvas: { mode: "exact", size: { width: 64, height: 48 }, source: "baseline", allowReframe: false },
            modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image-model", qualityCheck: null },
            continuity: { branchId: "old-branch", parentResultId: null },
            validation: { requiredChecks: ["requested_edit"] },
        };
        const profile = resolveEcommerceImageProviderProfile({
            logicalRole: "image_generation",
            logicalModelId: "image-model",
            channelId: "image-channel",
            upstreamModel: "gpt-image-2.5-flare",
            capability: "image",
            apiFormat: "openai",
            imageEdit: { protocol: "sub2api", editPath: "/images/edits", transport: "json", supportsIndependentMask: true },
        });
        assert(profile);
        const execution = compileEcommerceImageRequest(plan, profile);
        const paused = await runs.updateAgentRunById(run.id, {
            status: "paused",
            tasks: [{ id: "old-scene-edit", type: "image", title: "场景修改", prompt: execution.prompt, ecommerceExecution: execution, count: 1, dependencies: [], status: "needs_review", attempts: 0 }],
            ecommerceSnapshot: {
                version: "ecommerce-generation.v1",
                mode: "active",
                runId: run.id,
                userId,
                createdAt: run.createdAt,
                input: { userRequest: run.prompt, assetIds: [asset.id], conversationId: conversation.id, surface: "chat" },
                referenceCheckpoint: { ...checkpoint, state: "resolved", analysisStage: { ...checkpoint.analysisStage, state: "completed" } },
                plan,
                compilerVersion: execution.compilerVersion,
                fallback: { reason: "scene_selection_required" },
            },
        });
        assert(paused);
        return paused;
    }

    function retry(run: AgentRun) {
        return post(new Request(`http://localhost/api/agent/runs/${run.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: run.conversationId }) }), {
            params: Promise.resolve({ id: run.id, action: "retry" }),
        });
    }

    async function holdAfterRead(run: AgentRun) {
        let arrive!: () => void;
        let release!: () => void;
        const reached = new Promise<void>((resolve) => {
            arrive = resolve;
        });
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        boundary.settings.mockImplementationOnce(async () => {
            arrive();
            await released;
            return configured;
        });
        const response = retry(run);
        await reached;
        return { response, release };
    }

    it("replans once in the same Run and keeps its messages, original references and checkpoint", async () => {
        const run = await oldPause();
        const before = await runtime.listCreativeMessages(run.conversationId);
        const response = await retry(run);
        expect(response.status).toBe(200);
        const saved = await runs.getAgentRun(run.id);
        expect(saved).toMatchObject({ id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId, status: "planning", tasks: [], referencedAssetIds: run.referencedAssetIds });
        expect(saved?.ecommerceSnapshot?.referenceCheckpoint).toEqual(run.ecommerceSnapshot?.referenceCheckpoint);
        expect(saved?.ecommerceSnapshot?.plan).toBeUndefined();
        const messages = await runtime.listCreativeMessages(run.conversationId);
        expect(messages.map((message) => message.id)).toEqual(before.map((message) => message.id));
        expect(messages[0].content).toBe(run.prompt);
        expect(messages[1]).toMatchObject({ id: run.assistantMessageId, status: "running", content: "正在重新分析并执行这次请求…" });
        expect((await runtime.listCreativeRunEvents(run.id)).filter((event) => event.type === "run.retry.requested")).toMatchObject([{ data: { previousPlanVersion: "ecommerce-edit.v6", strategy: "full_image" } }]);
        expect((await retry(run)).status).toBe(409);
    });

    it("rejects a retry when cancellation starts after the HTTP read", async () => {
        const run = await oldPause();
        const pending = await holdAfterRead(run);
        const cancellation = { requestedAt: Date.now(), pendingChildTaskIds: [] };
        // This is the persisted first step of cancelAgentRun: paused and tasks stay unchanged.
        await runs.updateAgentRunById(run.id, { status: "paused", executionId: undefined, cancellation }, { type: "run.cancel.requested" }, ["paused"]);
        pending.release();
        expect((await pending.response).status).toBe(409);
        const saved = await runs.getAgentRun(run.id);
        expect(saved).toMatchObject({ status: "paused", cancellation, tasks: run.tasks, ecommerceSnapshot: run.ecommerceSnapshot });
        expect((await runtime.listCreativeRunEvents(run.id)).filter((event) => event.type === "run.retry.requested")).toEqual([]);
    });

    it("rejects a persisted image submission even when the old parent has no child link", async () => {
        const run = await oldPause();
        const now = Date.now();
        // An interrupted historical write may leave the actual child outside the parent task array.
        await tasks.updateStoredGenerationTask("image", { id: "unlinked-image", userId: run.userId, runId: run.id, conversationId: run.conversationId, status: "running", upstream: { id: "existing-upstream" }, createdAt: now, updatedAt: now }, 60_000);
        expect((await retry(run)).status).toBe(409);
        expect(await runs.getAgentRun(run.id)).toMatchObject({ status: "paused", tasks: run.tasks, ecommerceSnapshot: run.ecommerceSnapshot });
        expect(await tasks.getStoredGenerationTask("image", "unlinked-image")).toMatchObject({ upstream: { id: "existing-upstream" } });
    });

    it.each(["waitingFor", "protection"] as const)("rejects a %s stage that appears after the HTTP read", async (stage) => {
        const run = await oldPause();
        const pending = await holdAfterRead(run);
        const snapshot = { ...run.ecommerceSnapshot!, processing: { version: "image-processing-checkpoint.v1" as const, prepareReferences: [], [stage]: { jobId: "started-stage", inputDigest: "started-input" } } };
        await runs.updateAgentRunById(run.id, { ecommerceSnapshot: snapshot }, undefined, ["paused"]);
        pending.release();
        expect((await pending.response).status).toBe(409);
        expect(await runs.getAgentRun(run.id)).toMatchObject({ status: "paused", tasks: run.tasks, ecommerceSnapshot: snapshot });
    });
});
