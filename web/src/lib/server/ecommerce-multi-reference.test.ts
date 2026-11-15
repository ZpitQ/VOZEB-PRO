import { describe, expect, it } from "vitest";
import { normalizeCreativeRunRequest, type CreativeAsset } from "@/lib/creative-runtime-contract";
import { buildEcommercePlanningInput } from "./ecommerce-generation-snapshot";
import { resolveEcommerceReferenceDecision } from "./ecommerce-reference-purpose";
import { resolveSourcesFromEcommerceReferenceDecision } from "./ecommerce-reference-roles";
import { confirmedReferenceDecision, createEcommerceReferenceCheckpoint, parseCreativeReferenceRecovery, referenceReviewKind, referenceSourcesLoaded } from "./ecommerce-reference-recovery";
import { normalizeEcommerceVisualAnalysis, type EcommerceVisualReferenceV4 } from "./ecommerce-visual-analysis";
import type { AgentRun } from "./agent-run-store";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";

const assets: CreativeAsset[] = ["main", "style", "light", "composition"].map((id) => ({
    id,
    userId: "user",
    conversationId: "conversation",
    ordinal: 0,
    type: "image",
    status: "ready",
    title: id,
    serverUrl: `/api/reference-assets/${id}.png`,
    width: 100,
    height: 100,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
}));

function input(prompt: string) {
    return buildEcommercePlanningInput({ userId: "user", conversationId: "conversation", surface: "chat", prompt, referencedAssetIds: ["main", "style", "light", "composition"] }, assets, { summary: "", recentMessages: [] });
}

function reference(assetId: string): EcommerceVisualReferenceV4 {
    return {
        assetId,
        contentType: "isolated_product",
        confidence: "high",
        visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
        productFacts: { identity: "oak cabinet", outline: "four doors", color: "oak", material: "wood", brandText: [], view: "front" },
        sceneFacts: null,
        productCore: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
        fusionHalo: { x: 0.1, y: 0.1, width: 0.7, height: 0.7 },
        editableTargets: [],
        visibleStructure: [],
        cues: [
            { id: "style", facet: "style", description: "natural oak", confidence: "high" },
            { id: "light", facet: "lighting", description: "daylight", confidence: "high" },
            { id: "composition", facet: "composition", description: "front view", confidence: "high" },
        ],
    };
}

function vision(planning: ReturnType<typeof input>) {
    const result = normalizeEcommerceVisualAnalysis({ analysisVersion: "ecommerce-visual-analysis.v4", references: [reference("main"), reference("style"), reference("light"), reference("composition")], purposeSuggestions: [] }, planning.assetCandidates);
    if (result?.analysisVersion !== "ecommerce-visual-analysis.v4") throw new Error("Invalid fixture");
    return { ...result, modelRole: { logicalRole: "vision_analysis" as const, logicalModelId: "vision", channelId: "channel", upstreamModel: "vision" } };
}

describe("four image references", () => {
    it("sends all four references in order, including an auxiliary product identity", () => {
        const plan: EcommerceEditPlan = {
            planVersion: "ecommerce-edit.v7",
            strategy: "full_image",
            operation: "product_to_scene",
            source: { productAnchorId: "main", currentSceneBaselineId: null, sceneReferenceIds: ["style", "light", "composition"] },
            referenceUses: [
                { assetId: "main", alias: "图片1", purposes: ["edit_target", "product_identity"], usedCueIds: [] },
                { assetId: "style", alias: "图片2", purposes: ["product_identity"], usedCueIds: [] },
                { assetId: "light", alias: "图片3", purposes: ["lighting"], usedCueIds: ["daylight"] },
                { assetId: "composition", alias: "图片4", purposes: ["composition"], usedCueIds: ["view"] },
            ],
            baseline: { productFacts: { identity: "cabinet", outline: "rectangle", color: "oak", material: "wood", brandText: [], view: "front" }, sceneFacts: null },
            delta: { requestedChanges: ["change scene"], targetObjects: [], targetRegions: [] },
            preserve: { productCore: [], sceneElements: [] },
            protection: { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: true },
            modelRoles: { visionAnalysis: "vision", editPlanning: "planning", generation: "image", qualityCheck: null },
            continuity: { parentResultId: null, branchId: "branch" },
            validation: { requiredChecks: [] },
        };
        const profile = resolveEcommerceImageProviderProfile({ logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "channel", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" });
        if (!profile) throw new Error("Expected image profile");
        const request = compileEcommerceImageRequest(plan, profile);
        expect(request.referenceRoles).toEqual([
            { assetId: "main", role: "product" },
            { assetId: "style", role: "product" },
            { assetId: "light", role: "scene" },
            { assetId: "composition", role: "scene" },
        ]);
        expect(request.referenceMapping?.[3]).toEqual({ assetId: "composition", userAlias: "图片4", providerIndex: 3, purposes: ["composition"] });
        expect(request.mask).toBeUndefined();
    });

    it("keeps all three auxiliary purposes beside one explicit product target", () => {
        const planning = input("修改图片1，参考图片2的风格，参考图片3的光线，参考图片4的构图");
        const decision = resolveEcommerceReferenceDecision({ planningInput: planning, analysis: vision(planning) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "main", productAnchorId: "main" });
        expect(resolveSourcesFromEcommerceReferenceDecision(decision, assets)).toMatchObject({ status: "resolved", productAnchorId: "main", sceneReferenceIds: ["style", "light", "composition"] });
    });

    it("lets four ambiguous references be confirmed without repeating visual analysis", () => {
        const planning = input("参考这些商品图调整效果");
        const analysis = vision(planning);
        const run = { id: "run", userId: "user", conversationId: "conversation" } as AgentRun;
        const checkpoint = referenceSourcesLoaded(
            createEcommerceReferenceCheckpoint(run, planning, assets),
            assets.map((asset) => ({ assetId: asset.id, contentSha256: "a".repeat(64), sourceSize: { width: 100, height: 100 } })),
        );
        checkpoint.analysis = analysis;
        checkpoint.analysisStage.state = "completed";
        checkpoint.decision = resolveEcommerceReferenceDecision({ planningInput: planning, analysis });
        expect(referenceReviewKind(checkpoint)).toBe("confirm_purposes");
        const bindings = checkpoint.assets.map((item) => ({ assetId: item.asset.id, assetVersion: item.assetVersion, purposes: item.asset.id === "main" ? ["edit_target", "product_identity"] : ["style"] }));
        const recovery = parseCreativeReferenceRecovery({ reviewId: checkpoint.reviewId, action: "confirm_purposes", decisionVersion: "ecommerce-reference-decision.v1", bindings });
        if (recovery.action !== "confirm_purposes") throw new Error("Expected confirmation");
        expect(confirmedReferenceDecision(checkpoint, recovery)?.decision).toMatchObject({ state: "resolved", editTargetId: "main", productAnchorId: "main" });
    });

    it("chooses the declared historical target without making auxiliary history into parents", () => {
        const history = [
            { ...assets[1], sourceRunId: "other-run" },
            { ...assets[0], sourceRunId: "target-run" },
        ];
        const decision = {
            state: "resolved" as const,
            editTargetId: "main",
            productAnchorId: null,
            currentSceneBaselineId: "main",
            bindings: [
                { assetId: "main", purposes: ["edit_target" as const] },
                { assetId: "style", purposes: ["style" as const] },
            ],
        };
        expect(resolveSourcesFromEcommerceReferenceDecision(decision, history, history)).toMatchObject({ status: "resolved", currentSceneBaselineId: "main", parentResultId: "main", sceneReferenceIds: ["style"] });
    });

    it("rejects a fifth image at the create submission boundary", () => {
        expect(() => normalizeCreativeRunRequest({ surface: "chat", clientRequestId: "five", prompt: "生成商品图", assetIds: ["one", "two", "three", "four", "five"], preferences: { mode: "image" } })).toThrow("4");
    });
});
