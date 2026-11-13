import { buildWhiteBackgroundProductProtection } from "./ecommerce-protection.test-fixtures";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";

import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import type { EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import { resolveImageEditProtocol } from "./image-edit-protocol";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { createEcommerceSceneEditTask, createEcommerceLocalEditTask, decodeEcommerceCanvasSize, loadEcommercePlanningImage } from "./ecommerce-generation-service";
import { authorizedWorkerUserId, maintenanceWorkerContext } from "./maintenance-auth";
import { createEcommerceProductSceneTask, ecommerceGenerationEnabled, ecommerceRolloutStage, publicEcommerceProgress } from "./ecommerce-generation-service";

describe("ecommerce generation service", () => {
    describe("original reference dimensions", () => {
        const sources = new Map<number, Buffer>();
        beforeAll(async () => {
            for (const height of [6000, 8000]) {
                sources.set(
                    height,
                    await sharp({ create: { width: 8000, height, channels: 3, background: "#203040" } })
                        .withMetadata({ orientation: 6 })
                        .jpeg()
                        .toBuffer(),
                );
            }
        });

        it.each([6000, 8000])("reads original oriented dimensions within the reference budget (8000 x %s)", async (height) => {
            await expect(decodeEcommerceCanvasSize(sources.get(height)!)).resolves.toEqual({ width: height, height: 8000 });
        });
    });

    it("rejects reference originals above the existing sixty-four-megapixel budget", async () => {
        const source = await sharp({ create: { width: 8001, height: 8000, channels: 3, background: "#203040" } })
            .jpeg()
            .toBuffer();

        await expect(decodeEcommerceCanvasSize(source)).rejects.toThrow(/pixel limit/i);
    });

    it("still fully decodes reference pixels with readable metadata", async () => {
        const source = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#203040" } })
            .png()
            .toBuffer();
        const pixelChunk = source.indexOf(Buffer.from("IDAT"));
        expect(pixelChunk).toBeGreaterThan(0);
        source[pixelChunk + 4] ^= 0xff;
        await expect(sharp(source, { failOn: "error" }).metadata()).resolves.toMatchObject({ width: 64, height: 64 });

        await expect(decodeEcommerceCanvasSize(source)).rejects.toThrow();
    });

    it.each(["local_edit", "scene_edit"] as const)("retains a v6 auxiliary image in the actual %s task", async (operation) => {
        const editPlan: EcommerceEditPlan = {
            ...plan(),
            planVersion: "ecommerce-edit.v6",
            operation,
            source: { productAnchorId: operation === "local_edit" ? "product" : null, currentSceneBaselineId: "current", sceneReferenceIds: ["style"] },
            baseline: { productFacts: operation === "local_edit" ? plan().baseline.productFacts : null, sceneFacts: { space: "room", composition: "front", lighting: "soft" } },
            strategy: operation === "local_edit" ? "strict_product" : "integrated_scene",
            preserve: { productCore: operation === "local_edit" ? plan().preserve.productCore : [], sceneElements: [] },
            referenceUses: [
                { assetId: "current", alias: null, purposes: ["edit_target"], usedCueIds: [] },
                ...(operation === "local_edit" ? [{ assetId: "product", alias: null, purposes: ["product_identity" as const], usedCueIds: [] }] : []),
                { assetId: "style", alias: "图片1", purposes: ["style"], usedCueIds: ["style-cue"] },
            ],
        };
        const compiled = compileEcommerceImageRequest(editPlan, resolveEcommerceImageProviderProfile(generationSnapshot())!);
        const assets = [asset("style", "style.png"), asset("product", "product.png"), asset("current", "current.png")];
        const regions = await buildWhiteBackgroundProductProtection(await productImage({ background: "white", products: [{ left: 22, top: 10, width: 20, height: 28 }] }), analysis(), "product");
        regions.sourceAssetId = "current";
        const task = operation === "local_edit" ? createEcommerceLocalEditTask({ id: "run", prompt: "edit" }, editPlan, assets, regions, compiled) : createEcommerceSceneEditTask({ id: "run", prompt: "edit" }, editPlan, assets, compiled);
        expect(task.references?.map((reference) => reference.assetId)).toEqual(compiled.referenceRoles.map((reference) => reference.assetId));
        expect(task.ecommerceExecution?.referenceMapping).toEqual(compiled.referenceMapping);
    });
    it.each([
        { kind: "missing protocol", edit: undefined },
        { kind: "JSON reference transport", edit: { referenceRule: "JSON images[].image_url" } },
        { kind: "generation path", edit: { editPath: "/images/generations" } },
        { kind: "Nano Banana", edit: {} },
    ])("rejects unsupported independent-mask execution before creating tasks or requesting a provider: $kind", async ({ kind, edit }) => {
        const snapshot = generationSnapshot();
        if (kind === "Nano Banana") {
            snapshot.upstreamModel = "nano-banana-2";
            snapshot.apiFormat = "gemini";
        }
        snapshot.imageEdit = edit ? resolveImageEditProtocol({ apiFormat: snapshot.apiFormat, model: snapshot.upstreamModel, advancedConfig: { ...emptyAdvancedConfig(), ...edit } }) : undefined;
        const editPlan = plan();
        const compiled = compileEcommerceImageRequest(editPlan, resolveEcommerceImageProviderProfile(snapshot)!);
        expect(compiled).toMatchObject({ state: "needs_review", reason: "independent_mask_unsupported" });
        const regions = await buildWhiteBackgroundProductProtection(await productImage({ background: "white", products: [{ left: 22, top: 10, width: 20, height: 28 }] }), analysis(), "product");
        const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider request"));
        try {
            expect(() => createEcommerceProductSceneTask({ id: "run", prompt: "scene" }, editPlan, [asset("product", "product.png")], regions, compiled)).toThrow("当前生图模型不满足电商图片执行要求");
            const localPlan: EcommerceEditPlan = { ...editPlan, operation: "local_edit", source: { ...editPlan.source, currentSceneBaselineId: "current" } };
            const localCompiled = compileEcommerceImageRequest(localPlan, resolveEcommerceImageProviderProfile(snapshot)!);
            expect(() => createEcommerceLocalEditTask({ id: "run", prompt: "edit" }, localPlan, [asset("product", "product.png"), asset("current", "current.png")], { ...regions, sourceAssetId: "current" }, localCompiled)).toThrow(
                "当前生图模型不满足电商图片执行要求",
            );
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            fetch.mockRestore();
        }
    });
    it.each(["worker", "cookie"] as const)("reads protected baseline images with %s credentials", async (credentialKind) => {
        const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        const server = createServer((request, response) => {
            const worker = authorizedWorkerUserId(new Request("http://127.0.0.1", { headers: { authorization: request.headers.authorization || "", "x-vozeb-pro-worker-user-id": String(request.headers["x-vozeb-pro-worker-user-id"] || "") } }));
            if (worker !== "worker-user" && request.headers.cookie !== "session=test") {
                response.writeHead(401).end();
                return;
            }
            response.writeHead(200, { "content-type": "image/png" }).end(bytes);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "baseline-worker-test-token-32-characters");
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "baseline-maintenance-test-token-32-characters");
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Baseline image fixture is unavailable");
            const credential = credentialKind === "worker" ? maintenanceWorkerContext("worker-user") : "session=test";
            const loaded = await loadEcommercePlanningImage("/api/reference-assets/baseline.png", `http://127.0.0.1:${address.port}`, credential);
            expect(loaded.equals(bytes)).toBe(true);
        } finally {
            vi.unstubAllEnvs();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });

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

    it.each(["audio", "video", "text"])("does not use no-attachment continuity for an explicit %s attachment", (type) => {
        const run = { surface: "chat" as const, referencedAssetIds: [`${type}-current`] };

        expect(ecommerceGenerationEnabled("internal", run, true)).toBe(false);
        expect(ecommerceGenerationEnabled("internal", { ...run, referencedAssetIds: [] }, true)).toBe(true);
        expect(ecommerceGenerationEnabled("internal", { ...run, generationPreferences: { mode: "image" } }, true)).toBe(true);
        expect(ecommerceGenerationEnabled("internal", { ...run, generationPreferences: { mode: "audio" } }, true)).toBe(false);
        expect(ecommerceGenerationEnabled("internal", { ...run, generationPreferences: { mode: "video" } }, true)).toBe(false);
    });

    it("keeps off and non-selected canary users on the legacy flow", () => {
        expect(ecommerceRolloutStage({ mode: "off" }, "user-a")).toBe("default");
        expect(ecommerceRolloutStage({ mode: "shadow" }, "user-a")).toBe("shadow");
        expect(ecommerceRolloutStage({ mode: "internal" }, "user-a")).toBe("internal");
        expect(ecommerceRolloutStage({ mode: "canary", canaryUserIds: ["user-a"] }, "user-a")).toBe("canary");
        expect(ecommerceRolloutStage({ mode: "canary", canaryUserIds: ["user-a"] }, "user-b")).toBe("default");
        expect(ecommerceRolloutStage({ mode: "enabled" }, "user-b")).toBe("canary");
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
        imageEdit: resolveImageEditProtocol({ apiFormat: "openai", model: "gpt-image-2.5-flare" }),
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
