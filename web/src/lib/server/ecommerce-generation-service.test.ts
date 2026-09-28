import sharp from "sharp";
import { describe, expect, it } from "vitest";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";

import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import type { EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { createEcommerceSceneEditTask } from "./ecommerce-generation-service";
import { buildWhiteBackgroundProductProtection, createEcommerceProductSceneTask, ecommerceGenerationEnabled, ecommerceRolloutStage, publicEcommerceProgress } from "./ecommerce-generation-service";

describe("ecommerce generation service", () => {
    it("enables only the explicit internal /create image slice", () => {
        const run = {
            surface: "chat" as const,
            referencedAssetIds: ["product"],
            generationPreferences: { mode: "image" as const },
        };

        expect(ecommerceGenerationEnabled("off", run, false, [], true)).toBe(false);
        expect(ecommerceGenerationEnabled("shadow", run, false, [], true)).toBe(false);
        expect(ecommerceGenerationEnabled("internal", run, false, [], true)).toBe(true);
        expect(ecommerceGenerationEnabled("enabled", run, false, [], true)).toBe(true);
        expect(ecommerceGenerationEnabled("internal", { ...run, surface: "canvas" }, false, [], true)).toBe(false);
        expect(ecommerceGenerationEnabled("internal", { ...run, surface: "drama" }, false, [], true)).toBe(false);
        expect(ecommerceGenerationEnabled("internal", { ...run, generationPreferences: { mode: "video" } }, false, [], true)).toBe(false);
        expect(ecommerceGenerationEnabled("internal", { ...run, referencedAssetIds: [] }, false, [], true)).toBe(false);
        expect(ecommerceGenerationEnabled("internal", { ...run, referencedAssetIds: ["product", "scene-a", "scene-b"] }, false, [], true)).toBe(true);
    });

    it("infers an image request from one explicitly selected image model", () => {
        const run = {
            surface: "chat" as const,
            referencedAssetIds: ["scene"],
        };

        expect(ecommerceGenerationEnabled("internal", run, false, ["image"], true)).toBe(true);
        expect(ecommerceGenerationEnabled("internal", run, false, ["video"])).toBe(false);
        expect(ecommerceGenerationEnabled("internal", run, false, ["audio"])).toBe(false);
        expect(ecommerceGenerationEnabled("internal", run, false, ["image", "video"])).toBe(false);
    });

    it("infers an image request from a referenced image in the image-only create entry", () => {
        const run = {
            surface: "chat" as const,
            referencedAssetIds: ["scene"],
        };

        expect(ecommerceGenerationEnabled("internal", run, false, [], true)).toBe(true);
        expect(ecommerceGenerationEnabled("internal", run, false, [], false)).toBe(false);
        expect(ecommerceGenerationEnabled("internal", { ...run, generationPreferences: { mode: "video" as const } }, false, [], true)).toBe(false);
    });

    it("does not infer image mode when no reference image is selected", () => {
        expect(ecommerceGenerationEnabled("internal", { surface: "chat", referencedAssetIds: [] }, false, ["image"])).toBe(false);
    });

    it("keeps off and non-selected canary users on the legacy flow", () => {
        expect(ecommerceRolloutStage({ mode: "off" }, "user-a")).toBe("default");
        expect(ecommerceRolloutStage({ mode: "shadow" }, "user-a")).toBe("shadow");
        expect(ecommerceRolloutStage({ mode: "internal" }, "user-a")).toBe("internal");
        expect(ecommerceRolloutStage({ mode: "canary", canaryUserIds: ["user-a"] }, "user-a")).toBe("canary");
        expect(ecommerceRolloutStage({ mode: "canary", canaryUserIds: ["user-a"] }, "user-b")).toBe("default");
        expect(ecommerceRolloutStage({ mode: "enabled" }, "user-b")).toBe("canary");
    });

    it("builds an exact-size trusted mask from one isolated white-background product", async () => {
        const source = await productImage({ background: "#ffffff", products: [{ left: 22, top: 10, width: 20, height: 28 }] });

        const regions = await buildWhiteBackgroundProductProtection(source, analysis(), "product");

        expect(regions.sourceSize).toEqual({ width: 64, height: 48 });
        expect(regions.productCore.rectangles).toEqual([{ x: 22, y: 10, width: 20, height: 28 }]);
        expect(regions.editableBackground.mask).toMatchObject({
            trust: "trusted",
            provider: "white-background-flood-fill.v1",
            reference: { id: "product-background-mask", type: "image/png", width: 64, height: 48 },
        });
        const maskUrl = regions.editableBackground.mask?.reference.dataUrl || "";
        const mask = await sharp(Buffer.from(maskUrl.split(",")[1], "base64"))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        expect(mask.info).toMatchObject({ width: 64, height: 48, channels: 4 });
        expect(mask.data[(2 * 64 + 2) * 4 + 3]).toBe(0);
        expect(mask.data[(20 * 64 + 30) * 4 + 3]).toBe(255);
    });

    it("computes product bounds for production-size images without overflowing the call stack", async () => {
        const source = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 800, height: 800, channels: 4, background: "#252525" } }, left: 112, top: 112 }])
            .png()
            .toBuffer();

        const regions = await buildWhiteBackgroundProductProtection(source, analysis(), "product");

        expect(regions.sourceSize).toEqual({ width: 1024, height: 1024 });
        expect(regions.productCore.rectangles).toEqual([{ x: 112, y: 112, width: 800, height: 800 }]);
    });

    it("accepts a neutral near-white background used by uploaded product images", async () => {
        const source = await productImage({ background: "#f5f5f4", products: [{ left: 22, top: 10, width: 20, height: 28 }] });

        const regions = await buildWhiteBackgroundProductProtection(source, analysis(), "product");

        expect(regions.productCore.rectangles).toEqual([{ x: 22, y: 10, width: 20, height: 28 }]);
        expect(regions.editableBackground.mask?.trust).toBe("trusted");
    });

    it("accepts one isolated product on a transparent background", async () => {
        const source = await productImage({ background: "#00000000", products: [{ left: 18, top: 8, width: 28, height: 32 }] });

        const regions = await buildWhiteBackgroundProductProtection(source, transparentAnalysis(), "product");

        expect(regions.productCore.rectangles).toEqual([{ x: 18, y: 8, width: 28, height: 32 }]);
        expect(regions.editableBackground.mask?.trust).toBe("trusted");
    });

    it("keeps the fusion halo bounded for a tall narrow transparent product", async () => {
        const source = await sharp({ create: { width: 64, height: 96, channels: 4, background: "#00000000" } })
            .composite([{ input: { create: { width: 8, height: 80, channels: 4, background: "#252525" } }, left: 28, top: 8 }])
            .png()
            .toBuffer();

        const regions = await buildWhiteBackgroundProductProtection(source, transparentAnalysis(), "product");

        expect(regions.productCore.rectangles).toEqual([{ x: 28, y: 8, width: 8, height: 80 }]);
        expect(regions.fusionHalo.rectangles).toEqual([
            { x: 27, y: 1, width: 10, height: 7 },
            { x: 27, y: 8, width: 1, height: 80 },
            { x: 36, y: 8, width: 1, height: 80 },
            { x: 27, y: 88, width: 10, height: 7 },
        ]);
    });

    it.each([
        ["non-white background", () => productImage({ background: "#6f91b8", products: [{ left: 22, top: 10, width: 20, height: 28 }] }), /白色或透明背景/],
        [
            "multiple subjects",
            () =>
                productImage({
                    background: "#ffffff",
                    products: [
                        { left: 8, top: 12, width: 14, height: 24 },
                        { left: 42, top: 12, width: 14, height: 24 },
                    ],
                }),
            /多个独立主体/,
        ],
        ["edge uncertainty", () => productImage({ background: "#ffffff", products: [{ left: 0, top: 10, width: 24, height: 28 }] }), /接触图片边缘/],
        ["empty subject", () => productImage({ background: "#ffffff", products: [] }), /没有检测到商品主体/],
    ])("fails closed for %s", async (_name, makeSource, expected) => {
        await expect(buildWhiteBackgroundProductProtection(await makeSource(), analysis(), "product")).rejects.toThrow(expected);
    });

    it("creates a strict task with product first, scene second, and a western-home default", async () => {
        const source = await productImage({ background: "#ffffff", products: [{ left: 22, top: 10, width: 20, height: 28 }] });
        const regions = await buildWhiteBackgroundProductProtection(source, analysis(true), "product");
        const run = {
            id: "run",
            prompt: "生成简约家具图",
            generationPreferences: { mode: "image" as const, image: { size: "4:3", quality: "high", count: 1 } },
        };

        const editPlan = plan(true);
        const compiled = compileEcommerceImageRequest(editPlan, resolveEcommerceImageProviderProfile(generationSnapshot())!);
        const task = createEcommerceProductSceneTask(run, editPlan, [asset("product", "product.png"), asset("scene", "scene.png")], regions, compiled);

        expect(task).toMatchObject({
            id: "ecommerce-product-scene",
            type: "image",
            model: "image-role",
            ratio: "4:3",
            quality: "high",
            count: 1,
            status: "ready",
            productProtectionRegions: regions,
            ecommerceExecution: {
                compilerVersion: "ecommerce-openai-image-2.5.v1",
                providerProfileId: "gpt-image-2.5-flare",
                modelSnapshot: generationSnapshot(),
            },
        });
        expect(task.references).toEqual([expect.objectContaining({ assetId: "product", ecommerceRole: "product", width: 64, height: 48 }), expect.objectContaining({ assetId: "scene", ecommerceRole: "scene", width: 64, height: 48 })]);
        expect(task.prompt).toBe(compiled.prompt);
        expect(task.prompt).toContain("strict_product");
        expect(task.optimizedPrompt).toContain("生成简约家具图");
        expect(task.optimizedPrompt).not.toContain("modelRoles");
        expect(task.optimizedPrompt).not.toContain("vision-role");
    });

    it("does not replace an explicit room direction with the controlled default", async () => {
        const source = await productImage({ background: "#ffffff", products: [{ left: 22, top: 10, width: 20, height: 28 }] });
        const regions = await buildWhiteBackgroundProductProtection(source, analysis(), "product");
        const editPlan = plan();
        editPlan.delta.requestedChanges = ["放在纽约 loft 客厅，午后阳光"];
        const compiled = compileEcommerceImageRequest(editPlan, resolveEcommerceImageProviderProfile(generationSnapshot())!);
        const task = createEcommerceProductSceneTask({ id: "run", prompt: "放在纽约 loft 客厅，午后阳光", generationPreferences: { mode: "image" as const } }, editPlan, [asset("product", "product.png")], regions, compiled);

        expect(task.prompt).toContain("纽约 loft 客厅，午后阳光");
        expect(task.prompt).not.toContain("明亮现代简约欧美客厅");
    });

    it("creates a scene edit task from the scene baseline without product protection", () => {
        const scenePlan = {
            ...plan(),
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            baseline: {
                productFacts: null,
                sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
            },
            delta: {
                requestedChanges: ["改为冬日阳光"],
                targetObjects: ["lighting-main"],
                targetRegions: ["whole-scene"],
            },
            preserve: { productCore: [], sceneElements: ["layout", "furniture", "camera"] },
            strategy: "integrated_scene",
            validation: { requiredChecks: ["requested_edit", "scene_preservation"] },
        } as EcommerceEditPlan;
        const compiled = compileEcommerceImageRequest(scenePlan, resolveEcommerceImageProviderProfile(generationSnapshot())!);

        const task = createEcommerceSceneEditTask({ id: "run", prompt: "改为冬日阳光", generationPreferences: { mode: "image", image: { count: 1 } } }, scenePlan, [asset("scene", "scene.png")], compiled);

        expect(task).toMatchObject({
            id: "ecommerce-scene-edit",
            title: "场景图片修改",
            referenceAssetId: "scene",
            references: [{ assetId: "scene", ecommerceRole: "scene" }],
        });
        expect(task).not.toHaveProperty("productProtectionRegions");
    });

    it("publishes only the ecommerce phases that are actually executing", () => {
        expect(publicEcommerceProgress("identifying_product")).toBe("正在识别商品");
        expect(publicEcommerceProgress("planning_scene")).toBe("正在规划场景");
        expect(publicEcommerceProgress("generating_image")).toBe("正在生成图片");
        expect(publicEcommerceProgress("checking_result")).toBe("正在检查商品细节");
    });
});

async function productImage(input: { background: string; products: Array<{ left: number; top: number; width: number; height: number }> }) {
    return sharp({ create: { width: 64, height: 48, channels: 4, background: input.background } })
        .composite(
            input.products.map((product) => ({
                input: { create: { width: product.width, height: product.height, channels: 4 as const, background: "#252525" } },
                left: product.left,
                top: product.top,
            })),
        )
        .png()
        .toBuffer();
}

function generationSnapshot(): EcommerceRoleRouteSnapshot {
    return {
        logicalRole: "image_generation",
        capability: "image",
        logicalModelId: "image-role",
        channelId: "image-channel",
        upstreamModel: "gpt-image-2.5-flare",
        apiFormat: "openai",
    };
}

function asset(id: string, title: string): CreativeAsset {
    return {
        id,
        userId: "user",
        conversationId: "conversation",
        ordinal: 0,
        type: "image",
        title,
        status: "ready",
        remoteUrl: "https://cdn.example.com/" + title,
        width: 64,
        height: 48,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
    };
}

function analysis(withScene = false): EcommerceVisualAnalysis {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1",
        modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision-role", channelId: "vision-channel", upstreamModel: "vision-upstream" },
        references: [
            {
                assetId: "product",
                role: "product",
                confidence: "high",
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: { identity: "chair", outline: "chair outline", color: "oak", material: "wood", brandText: [], view: "front" },
                sceneFacts: null,
                productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
                fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
                editableTargets: [],
            },
            ...(withScene
                ? [
                      {
                          assetId: "scene",
                          role: "scene" as const,
                          confidence: "high" as const,
                          visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                          productFacts: null,
                          sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
                          productCore: null,
                          fusionHalo: null,
                          editableTargets: [],
                      },
                  ]
                : []),
        ],
    };
}

function transparentAnalysis(): EcommerceVisualAnalysis {
    const value = analysis();
    value.references[0].visualEvidence = { whiteBackground: false, transparentBackground: true, isolatedSubject: true, completeScene: false };
    return value;
}

function plan(withScene = false): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v1",
        operation: "product_to_scene",
        source: { productAnchorId: "product", currentSceneBaselineId: null, sceneReferenceIds: withScene ? ["scene"] : [] },
        baseline: {
            productFacts: { identity: "chair", outline: "chair outline", color: "oak", material: "wood", brandText: [], view: "front" },
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: ["place product in scene"], targetObjects: ["scene"], targetRegions: ["background"] },
        preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
        strategy: "strict_product",
        modelRoles: { visionAnalysis: "vision-role", editPlanning: "planning-role", generation: "image-role", qualityCheck: "quality-role" },
        continuity: { parentResultId: null, branchId: "branch" },
        validation: { requiredChecks: ["product_identity"] },
    };
}
