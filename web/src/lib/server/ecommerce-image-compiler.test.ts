import { describe, expect, it } from "vitest";

import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import type { EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";

describe("ecommerce image compiler", () => {
    it.each([
        ["gpt-image-2.5-flare", "gpt-image-2.5-flare"],
        ["gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst"],
    ])("keeps the %s execution profile distinct while using the OpenAI compiler family", (upstreamModel, profileId) => {
        const profile = resolveEcommerceImageProviderProfile(snapshot(upstreamModel, "openai"));
        const compiled = compileEcommerceImageRequest(plan(), profile!);

        expect(profile).toMatchObject({ profileId, compilerFamily: "openai-image-2.5", supportsIndependentMask: true });
        expect(compiled).toMatchObject({
            state: "ready",
            compilerVersion: "ecommerce-openai-image-2.5.v1",
            providerProfileId: profileId,
            referenceRoles: [
                { assetId: "product", role: "product" },
                { assetId: "scene", role: "scene" },
            ],
            mask: { mode: "independent", required: true },
        });
        expect(compiled.prompt).toContain("strict_product");
        expect(compiled.prompt).toContain("product");
        expect(compiled.prompt).not.toContain("foundation");
        expect(compiled.prompt).not.toContain("model reason");
    });

    it("uses the Nano Banana compiler but fails closed for strict independent-mask editing", () => {
        const profile = resolveEcommerceImageProviderProfile(snapshot("nano-banana-2", "gemini"));
        const compiled = compileEcommerceImageRequest(plan(), profile!);

        expect(profile).toMatchObject({ profileId: "nano-banana-2", compilerFamily: "nano-banana-2", supportsIndependentMask: false });
        expect(compiled).toMatchObject({
            state: "needs_review",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            reason: "independent_mask_unsupported",
        });
        expect(compiled.prompt).toContain("商品锚点");
        expect(compiled).not.toHaveProperty("mask");
    });

    it("orders local-edit references as current scene baseline then immutable product anchor", () => {
        const profile = resolveEcommerceImageProviderProfile(snapshot("gpt-image-2.5-flare", "openai"));
        const compiled = compileEcommerceImageRequest(localEditPlan(), profile!);

        expect(compiled.referenceRoles).toEqual([
            { assetId: "result", role: "scene" },
            { assetId: "product", role: "product" },
        ]);
        expect(compiled.prompt).toContain("coffee table");
        expect(compiled.prompt).toContain("right background");
    });

    it("compiles a scene edit with only the scene baseline and no product mask", () => {
        const profile = resolveEcommerceImageProviderProfile(snapshot("nano-banana-2", "gemini"));
        const compiled = compileEcommerceImageRequest(sceneEditPlan(), profile!);

        expect(compiled).toMatchObject({
            state: "ready",
            referenceRoles: [{ assetId: "scene-original", role: "scene" }],
        });
        expect(compiled).not.toHaveProperty("mask");
        expect(compiled.prompt).toContain("冬日阳光");
        expect(compiled.prompt).toContain("保持房间布局");
    });

    it("does not guess a provider profile for an unknown generation model", () => {
        expect(resolveEcommerceImageProviderProfile(snapshot("future-image-model", "openai"))).toBeNull();
    });
});

function snapshot(upstreamModel: string, apiFormat: "openai" | "gemini"): EcommerceRoleRouteSnapshot {
    return {
        logicalRole: "image_generation",
        capability: "image",
        logicalModelId: upstreamModel,
        channelId: `${apiFormat}-channel`,
        upstreamModel,
        apiFormat,
    };
}

function plan(): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v1",
        operation: "product_to_scene",
        source: { productAnchorId: "product", currentSceneBaselineId: null, sceneReferenceIds: ["scene"] },
        baseline: {
            productFacts: { identity: "oak chair", outline: "curved back", color: "oak", material: "wood", brandText: [], view: "front" },
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: ["place in a modern room"], targetObjects: ["room"], targetRegions: ["background"] },
        preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
        strategy: "strict_product",
        modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "quality" },
        continuity: { parentResultId: null, branchId: "branch" },
        validation: { requiredChecks: ["product_identity"] },
    };
}

function localEditPlan(): EcommerceEditPlan {
    return {
        ...plan(),
        operation: "local_edit",
        source: { productAnchorId: "product", currentSceneBaselineId: "result", sceneReferenceIds: [] },
        delta: { requestedChanges: ["add a coffee table"], targetObjects: ["coffee table"], targetRegions: ["right background"] },
    };
}

function sceneEditPlan(): EcommerceEditPlan {
    return {
        ...plan(),
        operation: "scene_edit",
        source: { productAnchorId: null, currentSceneBaselineId: "scene-original", sceneReferenceIds: [] },
        baseline: {
            productFacts: null,
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: {
            requestedChanges: ["改为冬日阳光"],
            targetObjects: ["lighting-main"],
            targetRegions: ["whole-scene"],
        },
        preserve: { productCore: [], sceneElements: ["保持房间布局", "保持家具和机位"] },
        strategy: "integrated_scene",
        validation: { requiredChecks: ["requested_edit", "scene_preservation"] },
    } as EcommerceEditPlan;
}
