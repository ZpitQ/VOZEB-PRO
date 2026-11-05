import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import type { RunMutation, RunMutationContext } from "./creative-runtime-repository";

const mocks = vi.hoisted(() => ({ assets: vi.fn(), fetch: vi.fn(), mutate: vi.fn(), getRun: vi.fn(), completedReference: vi.fn(), completedPrepares: vi.fn() }));
vi.mock("./creative-runtime-store", () => ({ getCreativeAssetsByIds: mocks.assets, mutateCreativeRun: mocks.mutate }));
vi.mock("./agent-run-store", async (original) => ({ ...(await original<typeof import("./agent-run-store")>()), getAgentRun: mocks.getRun }));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetch }));
vi.mock("./ecommerce-reference-preparation", async (original) => ({ ...(await original<typeof import("./ecommerce-reference-preparation")>()), readCompletedEcommerceReference: mocks.completedReference }));
vi.mock("./image-processing-service", async (original) => ({ ...(await original<typeof import("./image-processing-service")>()), hasOnlyCompletedEcommerceReferencePrepares: mocks.completedPrepares }));

import { replayEcommerceSceneSelection, resumeEcommerceSceneSelection } from "./ecommerce-scene-selection-service";
import { compileEcommerceImageRequest } from "./ecommerce-image-compiler";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import { buildEcommercePlanningInput, recordEcommerceGenerationSnapshot, type EcommerceGenerationSnapshotRecord } from "./ecommerce-generation-snapshot";
import { createEcommerceReferenceCheckpoint, referenceSourcesLoaded } from "./ecommerce-reference-recovery";
import { buildSceneEditProtection } from "./ecommerce-product-regions";
import { imageTask, runFixture } from "./agent-run-executor.test-fixtures";
import type { ImageProcessingCheckpoint, ImageProcessingManifest } from "./image-processing-service";

const selection = { baselineAssetId: "scene", region: { x: 2, y: 1, width: 2, height: 2 } };
const baseline: CreativeAsset = {
    id: "scene",
    type: "image",
    userId: "user",
    conversationId: "conversation",
    ordinal: 0,
    serverUrl: "/api/reference-assets/scene.png",
    status: "ready",
    metadata: {},
    title: "scene",
    width: 6,
    height: 4,
    createdAt: 1,
    updatedAt: 1,
};
const style: CreativeAsset = { ...baseline, id: "style", title: "style", serverUrl: "/api/reference-assets/style.png" };
const imageRoute = { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" } as const;
let source: Buffer;

// Rule tests stub native-completion and store-lock boundaries. The separate File
// receipt test owns actual prepare, atomic scheduling and claim A evidence.
function pausedRun(version: EcommerceEditPlan["planVersion"] = "ecommerce-edit.v3", withStyle = false, facts: Partial<EcommerceEditPlan> = {}) {
    const plan: EcommerceEditPlan = {
        planVersion: version,
        operation: "scene_edit",
        source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: withStyle ? ["style"] : [] },
        baseline: { productFacts: null, sceneFacts: { space: "room", composition: "front", lighting: "soft" } },
        canvas: { mode: "exact", size: { width: 6, height: 4 }, source: "baseline", allowReframe: false },
        protection: { scope: "local", protectedObjectIds: ["doors", "drawers", "handles", "background"], preserveOutsideMask: true, allowLightingChange: false },
        delta: { requestedChanges: ["add vase and contact shadow"], targetObjects: ["vase"], targetRegions: ["cabinet top"], manualRegion: { x: 0, y: 0, width: 1, height: 1 } },
        preserve: { productCore: [], sceneElements: ["cabinet", "room"] },
        strategy: "integrated_scene",
        modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "quality" },
        continuity: { branchId: "branch", parentResultId: null },
        validation: { requiredChecks: ["outside_mask"] },
        ...(withStyle
            ? {
                  referenceUses: [
                      { assetId: "scene", alias: "图片2", purposes: ["edit_target" as const], usedCueIds: [] },
                      { assetId: "style", alias: "图片1", purposes: ["style" as const], usedCueIds: ["style-cue"] },
                  ],
              }
            : {}),
        ...facts,
    };
    const execution = compileEcommerceImageRequest(plan, { profileId: "gpt-image-2.5-flare", compilerFamily: "openai-image-2.5", supportsIndependentMask: true, modelSnapshot: imageRoute });
    const task: AgentRunTask = { ...imageTask("scene-task"), status: "needs_review", ecommerceExecution: execution };
    const run = runFixture({ id: "run", prompt: "add vase", surface: "chat", status: "paused", referencedAssetIds: withStyle ? ["scene", "style"] : ["scene"], tasks: [task] });
    const assets = withStyle ? [baseline, style] : [baseline];
    const initial = createEcommerceReferenceCheckpoint(run, buildEcommercePlanningInput(run, assets, { summary: "", recentMessages: [] }), assets);
    const sha256 = createHash("sha256").update(source).digest("hex");
    const checkpoint = referenceSourcesLoaded(
        initial,
        assets.map((asset) => ({ assetId: asset.id, contentSha256: sha256, sourceSize: { width: 6, height: 4 } })),
    );
    const manifest: ImageProcessingManifest = {
        jobId: "prepare-scene",
        executionId: "prepare-execution",
        sourceIdentities: [{ assetId: baseline.id, assetVersion: initial.assets[0].assetVersion, sha256, bytes: source.byteLength, width: 6, height: 4, mimeType: "image/png" }],
        artifacts: [{ kind: "analysis", storageKey: "analysis.png", sha256, bytes: source.byteLength, mimeType: "image/png", width: 6, height: 4 }],
        geometry: { sourceSize: { width: 6, height: 4 } },
    };
    const processing: ImageProcessingCheckpoint = { version: "image-processing-checkpoint.v1", prepareReferences: [{ assetId: baseline.id, assetVersion: initial.assets[0].assetVersion, jobId: manifest.jobId, inputDigest: "prepare-input", manifest }] };
    const snapshot: EcommerceGenerationSnapshotRecord = {
        ...recordEcommerceGenerationSnapshot(run, {
            version: "ecommerce-generation.v1",
            mode: "active",
            input: { userRequest: run.prompt, assetIds: assets.map((asset) => asset.id), conversationId: run.conversationId, surface: "chat" },
            plan,
            fallback: { reason: "scene_selection_required" },
            createdAt: 1,
        }),
        plan,
        referenceCheckpoint: checkpoint,
        processing,
    };
    run.ecommerceSnapshot = snapshot;
    mocks.assets.mockResolvedValue(assets);
    mocks.completedReference.mockResolvedValue({ assetId: baseline.id, contentSha256: sha256, sourceSize: { width: 6, height: 4 }, sourceUrl: baseline.serverUrl, sourceBytes: source.byteLength, analysis: manifest.artifacts[0] });
    mocks.mutate.mockImplementation(async (_id: string, _ttl: number, mutate: (current: AgentRun, context: RunMutationContext) => RunMutation<AgentRun> | null) => mutate(structuredClone(run), { persistedChildren: [] })?.run ?? null);
    return { run, snapshot, plan, task, execution, checkpoint };
}

function confirm(run: AgentRun, input: unknown = selection, actorUserId = "user") {
    return resumeEcommerceSceneSelection({ run, selection: input, actorUserId, origin: "http://fixture.local", cookie: "fixture-session" });
}

type RuleFixture = ReturnType<typeof pausedRun>;
const ineligibleStates: Array<{ name: string; change: (fixture: RuleFixture) => void | Promise<void> }> = [
    {
        name: "submitted",
        change: ({ task }) => {
            task.taskId = "existing-child";
        },
    },
    {
        name: "qa",
        change: ({ snapshot }) => {
            snapshot.qualityCheck = {
                version: "ecommerce-quality.v1",
                status: "passed",
                publicStatus: "passed",
                modelRole: { ...imageRoute, logicalRole: "quality_check", capability: "text" },
                checks: [],
                hardFailures: [],
                internalReason: "",
                checkedAt: 1,
            };
        },
    },
    {
        name: "scope",
        change: ({ plan }) => {
            plan.protection = { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: true };
        },
    },
    {
        name: "running",
        change: ({ run }) => {
            run.status = "running";
        },
    },
    {
        name: "already_confirmed",
        change: async ({ task, plan }) => {
            task.sceneProtection = await buildSceneEditProtection(source, "scene", selection.region, plan.delta.requestedChanges, "user_selection");
        },
    },
];

describe("authenticated scene selection receipt rules", () => {
    beforeEach(async () => {
        vi.resetAllMocks();
        source = await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        mocks.fetch.mockImplementation(async () => new Response(new Uint8Array(source), { headers: { "Content-Type": "image/png" } }));
        mocks.completedPrepares.mockReturnValue(true);
        mocks.getRun.mockResolvedValue(null);
    });
    it("records selected pixels and server confirmation while retaining original tasks and plan", async () => {
        const { run } = pausedRun();
        const before = structuredClone(run);
        const confirmed = await confirm(run);
        expect(confirmed).toMatchObject({
            replayed: false,
            run: {
                status: "running",
                tasks: before.tasks,
                ecommerceSnapshot: {
                    plan: before.ecommerceSnapshot?.plan,
                    fallback: { reason: "scene_selection_required" },
                    processing: {
                        sceneSelection: {
                            version: "scene-selection-receipt.v1",
                            parentTaskId: "scene-task",
                            baseline: { assetId: "scene", width: 6, height: 4 },
                            region: selection.region,
                            semantics: ["add vase and contact shadow"],
                            confirmation: { actorUserId: "user", confirmedAt: expect.any(Number) },
                        },
                    },
                },
            },
        });
        expect(confirmed?.run.tasks[0].sceneProtection).toBeUndefined();
        expect(run).toEqual(before);
        expect(mocks.assets).toHaveBeenCalledWith(["scene"], "user");
        expect(mocks.mutate).toHaveBeenCalledWith("run", expect.any(Number), expect.any(Function), ["paused"], undefined, { resumeWithChildren: true });
    });
    it.each(["ecommerce-edit.v1", "ecommerce-edit.v2"] as const)("never upgrades a saved %s snapshot through selection", async (version) => {
        await expect(confirm(pausedRun(version).run)).rejects.toThrow("不能确认");
    });
    it.each([
        { version: "ecommerce-edit.v4" as const, facts: { visibleStructure: [{ objectId: "cabinet", feature: "doors" as const, count: 2, certainty: "confirmed" as const, evidenceRegion: { x: 0, y: 0, width: 6, height: 4 } }] } },
        {
            version: "ecommerce-edit.v5" as const,
            facts: {
                visibleStructure: [{ objectId: "cabinet", feature: "doors" as const, count: 2, certainty: "confirmed" as const, evidenceRegion: { x: 0, y: 0, width: 6, height: 4 } }],
                photography: {
                    materials: [{ objectId: "cabinet", textureDirection: "vertical wood", textureScale: "fine", roughness: "matte", gloss: "low" }],
                    lighting: { keyLight: "soft", fillLight: "low", whiteBalance: "neutral", contactShadow: "local shadow" },
                    composition: { focalSubject: "cabinet", depth: "room", negativeSpace: "above cabinet" },
                },
            },
        },
    ])("retains original $version facts and photography", async ({ version, facts }) => {
        const { run } = pausedRun(version, false, facts);
        const before = structuredClone(run);
        const confirmed = await confirm(run);
        expect(confirmed?.run.ecommerceSnapshot?.plan).toEqual(before.ecommerceSnapshot?.plan);
        expect(confirmed?.run.tasks).toEqual(before.tasks);
        expect(run).toEqual(before);
    });
    it.each(ineligibleStates)("rejects ineligible selection state $name", async ({ change }) => {
        const fixture = pausedRun();
        await change(fixture);
        await expect(confirm(fixture.run)).rejects.toThrow("不能确认");
    });
    it.each([null, { ...selection, baselineAssetId: "other" }, { ...selection, region: { x: 5, y: 1, width: 2, height: 2 } }, { ...selection, region: { x: 0, y: 0, width: 6, height: 4 } }])(
        "rejects invalid, stale, or full-frame selection %j",
        async (input) => {
            await expect(confirm(pausedRun().run, input)).rejects.toThrow();
            expect(mocks.mutate).not.toHaveBeenCalled();
        },
    );
    it("requires a nonempty authenticated actor", async () => {
        await expect(confirm(pausedRun().run, selection, " ")).rejects.toThrow("选择需要修改");
        expect(mocks.mutate).not.toHaveBeenCalled();
    });
    it("rejects another user's baseline", async () => {
        const { run } = pausedRun();
        mocks.assets.mockResolvedValue([{ ...baseline, userId: "other" }]);
        await expect(confirm(run)).rejects.toThrow("访问权限");
    });
    it("rejects a canvas that changes the source dimensions", async () => {
        const { run, plan } = pausedRun();
        plan.canvas = { mode: "exact", size: { width: 8, height: 4 }, source: "baseline", allowReframe: false };
        await expect(confirm(run)).rejects.toThrow("画幅");
    });
    it("preserves every frozen v6 reference in the original execution", async () => {
        const { run, execution } = pausedRun("ecommerce-edit.v6", true);
        expect((await confirm(run))?.run.tasks[0].ecommerceExecution).toEqual(execution);
        expect(execution.referenceRoles.map((reference) => reference.assetId)).toEqual(["scene", "style"]);
        expect(mocks.assets).toHaveBeenCalledWith(["scene", "style"], "user");
    });
    it.each([
        { condition: "foreign", assets: [baseline, { ...style, userId: "foreign" }] },
        { condition: "missing", assets: [baseline] },
    ])("rejects a $condition frozen v6 style reference", async ({ assets }) => {
        const { run } = pausedRun("ecommerce-edit.v6", true);
        mocks.assets.mockResolvedValue(assets);
        await expect(confirm(run)).rejects.toThrow("权限");
    });
    it("rejects a missing native prepare before any write", async () => {
        const { run } = pausedRun();
        mocks.completedReference.mockResolvedValue(undefined);
        await expect(confirm(run)).rejects.toThrow("预处理证据");
        expect(mocks.mutate).not.toHaveBeenCalled();
    });
    it("leaves the run paused when the locked child proof changes", async () => {
        const { run } = pausedRun();
        mocks.completedPrepares.mockReturnValue(false);
        expect(await confirm(run)).toBeNull();
        expect(run.status).toBe("paused");
    });
    it("replays the same receipt and actor without preflight or mutation", async () => {
        const confirmed = await confirm(pausedRun().run);
        if (!confirmed) throw new Error("fixture confirmation failed");
        vi.clearAllMocks();
        expect(replayEcommerceSceneSelection(confirmed.run, selection, "user")).toBe(confirmed.run);
        expect(mocks.assets).not.toHaveBeenCalled();
        expect(mocks.completedReference).not.toHaveBeenCalled();
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.mutate).not.toHaveBeenCalled();
    });
});
