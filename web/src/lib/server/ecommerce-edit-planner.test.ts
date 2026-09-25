import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import { planEcommerceEdit } from "./ecommerce-edit-planner";
import type { EcommercePlanningInput } from "./ecommerce-generation-snapshot";
import type { EcommerceRoleCandidate } from "./ecommerce-model-routing";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { requestStructuredText, type TextPlanningCandidate } from "./text-planning-runtime";

const mocks = vi.hoisted(() => ({ refundUserPoints: vi.fn(async () => undefined) }));

vi.mock("@/lib/auth/store", () => ({ refundUserPoints: mocks.refundUserPoints }));

vi.mock("./text-planning-runtime", () => ({
    requestStructuredText: vi.fn(),
    rankTextPlanningCandidates: <T>(candidates: T[]) => candidates,
}));

const mockedRequest = vi.mocked(requestStructuredText);

describe("ecommerce edit planner", () => {
    beforeEach(() => {
        mockedRequest.mockReset();
        mocks.refundUserPoints.mockClear();
    });

    it("rejects a plan when a required model field is missing", async () => {
        const value = validPlan() as unknown as Record<string, unknown>;
        value.baseline = { ...(value.baseline as Record<string, unknown>), productFacts: { ...productFacts(), material: undefined } };
        mockedRequest.mockResolvedValue(modelCall(value));

        await expect(planEcommerceEdit(planningRequest(), visualAnalysis(), plannerRole([candidate("planner")]))).rejects.toThrow("字段");
    });

    it("adapts the scene-generation contract returned by a compatible planner", async () => {
        mockedRequest.mockResolvedValue(
            modelCall({
                operation: "scene_generation_and_product_compositing",
                source: { productAssetId: "product", sceneReferenceAssetId: null, inputType: "white-background-product" },
                baseline: {
                    productFacts: productFacts(),
                    sceneFacts: { background: "white", environment: "no existing scene", referenceAvailable: false },
                },
                delta: {
                    background: "bright modern minimalist home interior",
                    environmentElements: ["warm white wall", "light wood furniture"],
                    lighting: "soft natural window light",
                    composition: "product centered with generous negative space",
                    style: "modern minimalist European home",
                    mood: "bright and comfortable",
                },
                preserve: {
                    productIdentity: true,
                    geometry: true,
                    outline: true,
                    proportions: true,
                    color: true,
                    woodMaterial: true,
                    woodGrain: true,
                    frontView: true,
                    brandText: true,
                    prohibitedChanges: ["do not change the product structure"],
                },
                strategy: { method: "lock the product and redraw the background", steps: ["segment product", "generate scene"] },
                modelRoles: { visionAnalysis: "vision-model", editPlanning: "planner-model", generation: "image-generation", qualityCheck: "quality-check" },
                continuity: { branchId: "branch-one" },
                validation: { checks: [{ name: "product identity", criterion: "product remains unchanged", required: true }] },
            }),
        );

        const result = await planEcommerceEdit(planningRequest(), visualAnalysis(), plannerRole([candidate("planner")]));

        expect(result.plan.operation).toBe("product_to_scene");
        expect(result.plan.source).toMatchObject({ productAnchorId: "product", currentSceneBaselineId: null, sceneReferenceIds: ["scene"] });
        expect(result.plan.baseline.sceneFacts).toEqual({
            space: "living room",
            composition: "eye-level wide view",
            lighting: "soft daylight",
        });
        expect(result.plan.delta.requestedChanges).toEqual(expect.arrayContaining(["bright modern minimalist home interior", "warm white wall", "soft natural window light"]));
        expect(result.plan.preserve.productCore).toEqual(expect.arrayContaining(["outline", "brand_text", "color", "material", "scale", "view"]));
        expect(result.plan.validation.requiredChecks).toEqual(["product identity: product remains unchanged"]);
    });

    it("does not make strict_product available when a core preservation constraint is missing", async () => {
        mockedRequest.mockResolvedValue(modelCall(validPlan({ preserve: { productCore: ["outline", "brand_text", "color", "material", "scale"], sceneElements: [] } })));

        await expect(planEcommerceEdit(planningRequest(), visualAnalysis(), plannerRole([candidate("planner")]))).rejects.toThrow("商品核心保护项");
    });

    it("anchors accepted plans to visual facts instead of model paraphrases", async () => {
        mockedRequest.mockResolvedValue(
            modelCall(
                validPlan({
                    baseline: {
                        productFacts: { ...productFacts(), identity: "generic table", color: "brown" },
                        sceneFacts: { space: "room", composition: "wide", lighting: "daylight" },
                    },
                }),
            ),
        );

        const result = await planEcommerceEdit(planningRequest(), visualAnalysis(), plannerRole([candidate("planner")]));

        expect(result.plan.baseline.productFacts).toEqual(productFacts());
        expect(result.plan.baseline.sceneFacts).toEqual({ space: "living room", composition: "eye-level wide view", lighting: "soft daylight" });
    });

    it("uses a same-role logical-model fallback and attributes billing to the actual planner", async () => {
        const incorrect = validPlan({
            operation: "local_edit",
            delta: { requestedChanges: ["add a coffee cup next to the product"], targetObjects: ["product body"], targetRegions: ["product_core"] },
            modelRoles: { visionAnalysis: "vision-model", editPlanning: "planner-primary", generation: "image-generation", qualityCheck: "quality-check" },
        });
        const corrected = validPlan({
            operation: "local_edit",
            delta: { requestedChanges: ["add a coffee cup next to the product"], targetObjects: ["coffee cup"], targetRegions: ["scene beside product"] },
            modelRoles: { visionAnalysis: "vision-model", editPlanning: "planner-backup", generation: "image-generation", qualityCheck: "quality-check" },
        });
        mockedRequest.mockResolvedValueOnce(modelCall(incorrect, new Headers({ "x-vozeb-pro-points-cost": "4", "x-vozeb-pro-points-record-id": "planner-primary-charge" }))).mockResolvedValueOnce(modelCall(corrected));

        const result = await planEcommerceEdit({ ...planningRequest(), planningInput: { ...planningInput(), userRequest: "Add a coffee cup next to the product" } }, visualAnalysis(), [
            roleCandidate("edit_planning", "planner-primary", "primary"),
            roleCandidate("edit_planning", "planner-backup", "secondary"),
        ]);

        expect(mockedRequest).toHaveBeenCalledTimes(2);
        expect(result.plan.delta).toMatchObject({ targetObjects: ["coffee cup"], targetRegions: ["scene beside product"] });
        expect(result.modelRole).toMatchObject({ logicalModelId: "planner-backup", channelId: "secondary", upstreamModel: "vendor/secondary" });
        expect(mockedRequest.mock.calls[0]?.[0].headers).toMatchObject({ "x-vozeb-pro-logical-model": "planner-primary", "x-vozeb-pro-upstream-model": "vendor/primary" });
        expect(mockedRequest.mock.calls[1]?.[0].headers).toMatchObject({ "x-vozeb-pro-logical-model": "planner-backup", "x-vozeb-pro-upstream-model": "vendor/secondary" });
        expect(new Headers(mockedRequest.mock.calls[0]?.[0].headers).get("x-vozeb-pro-points-idempotency-key")).not.toBe(new Headers(mockedRequest.mock.calls[1]?.[0].headers).get("x-vozeb-pro-points-idempotency-key"));
        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user-one", "planner-primary", 4, "text", 1, undefined, "planner-primary-charge");
    });

    it("rejects a cross-role candidate group", async () => {
        await expect(planEcommerceEdit(planningRequest(), visualAnalysis(), [roleCandidate("vision_analysis", "vision-model", "vision")])).rejects.toThrow("edit_planning");
        expect(mockedRequest).not.toHaveBeenCalled();
    });
});

function planningRequest() {
    return {
        origin: "http://127.0.0.1:3000",
        cookie: "session=test",
        userId: "user-one",
        requestId: "run-one",
        planningInput: planningInput(),
        sources: {
            status: "resolved" as const,
            productAnchorId: "product",
            currentSceneBaselineId: null,
            sceneReferenceIds: ["scene"],
            parentResultId: null,
            startsNewProductAnchor: true,
            createsBranch: false,
            ambiguityReason: null,
            clarificationQuestion: null,
        },
        branchId: "branch-one",
        generationModelRole: "image-generation",
        qualityCheckModelRole: "quality-check",
    };
}

function planningInput(): EcommercePlanningInput {
    return {
        userRequest: "把商品放进简约客厅",
        conversationId: "conversation-one",
        surface: "chat",
        assetCandidates: [
            { id: "product", type: "image", title: "product.png", url: "/api/reference-assets/product.png" },
            { id: "scene", type: "image", title: "scene.png", url: "/api/reference-assets/scene.png" },
        ],
        conversationContext: { summary: "", recentMessages: [] },
    };
}

function visualAnalysis(): EcommerceVisualAnalysis {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1",
        references: [
            {
                assetId: "product",
                role: "product",
                confidence: "high",
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: productFacts(),
                sceneFacts: null,
                productCore: { x: 0.2, y: 0.15, width: 0.6, height: 0.7 },
                fusionHalo: { x: 0.16, y: 0.11, width: 0.68, height: 0.78 },
                editableTargets: [],
            },
            {
                assetId: "scene",
                role: "scene",
                confidence: "high",
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: { space: "living room", composition: "eye-level wide view", lighting: "soft daylight" },
                productCore: null,
                fusionHalo: null,
                editableTargets: [],
            },
        ],
        modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision-model", channelId: "vision", upstreamModel: "vendor/vision" },
    };
}

function validPlan(overrides: Partial<EcommerceEditPlan> = {}): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v1",
        operation: "product_to_scene",
        source: { productAnchorId: "product", currentSceneBaselineId: null, sceneReferenceIds: ["scene"] },
        baseline: { productFacts: productFacts(), sceneFacts: { space: "living room", composition: "eye-level wide view", lighting: "soft daylight" } },
        delta: { requestedChanges: ["place product in a minimal living room"], targetObjects: ["scene"], targetRegions: ["background"] },
        preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
        strategy: "strict_product",
        modelRoles: { visionAnalysis: "vision-model", editPlanning: "planner-model", generation: "image-generation", qualityCheck: "quality-check" },
        continuity: { parentResultId: null, branchId: "branch-one" },
        validation: { requiredChecks: ["product_identity", "product_outline"] },
        ...overrides,
    };
}

function productFacts() {
    return { identity: "oak side table", outline: "round top and three legs", color: "natural oak", material: "wood", brandText: [], view: "front three-quarter" };
}

function plannerRole(candidates: TextPlanningCandidate[]) {
    return candidates.map((value) => roleCandidate("edit_planning", "planner-model", value.channelId));
}

function roleCandidate(logicalRole: "vision_analysis" | "edit_planning", logicalModelId: string, channelId: string): EcommerceRoleCandidate {
    const value = candidate(channelId);
    return {
        channelId: value.channelId,
        upstreamModel: value.upstreamModel,
        channel: value.channel,
        logicalRole,
        capability: "text",
        logicalModelId,
        snapshot: { logicalRole, capability: "text", logicalModelId, channelId, upstreamModel: value.upstreamModel, apiFormat: "openai" },
    };
}

function candidate(id: string): TextPlanningCandidate {
    return {
        channelId: id,
        upstreamModel: "vendor/" + id,
        channel: { id, name: id, baseUrl: "https://example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["vendor/" + id], enabled: true },
    };
}

function modelCall(value: unknown, headers = new Headers()) {
    return { arguments: JSON.stringify(value), headers, protocol: "chat" as const, elapsedMs: 10 };
}
