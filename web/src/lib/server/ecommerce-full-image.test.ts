import { describe, expect, it } from "vitest";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { normalizeEcommerceEditPlan, resolveEcommerceCanvasConstraint, type EcommerceEditPlan } from "./ecommerce-edit-plan";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { createEcommerceSceneEditTask, ecommerceCanvasInputFromRequest } from "./ecommerce-generation-service";
import { prepareEcommerceImageTask } from "./ecommerce-image-task-orchestration";
import { freezeEcommerceEnhancementDelivery } from "./image-enhancement-delivery";
import { isNativeGlobalSceneImageTaskResult, imageTaskResultOptions } from "./image-task-result-contract";
import type { ImageTask } from "./image-task-store";

function plan(operation: EcommerceEditPlan["operation"]): EcommerceEditPlan {
    const product = operation !== "scene_edit";
    const target = operation === "product_to_scene" ? "product" : "scene";
    return {
        planVersion: "ecommerce-edit.v7",
        strategy: "full_image",
        operation,
        source: { productAnchorId: product ? "product" : null, currentSceneBaselineId: target === "scene" ? "scene" : null, sceneReferenceIds: [] },
        referenceUses: [
            { assetId: target, alias: "图片1", purposes: product && target === "product" ? ["edit_target", "product_identity"] : ["edit_target"], usedCueIds: [] },
            ...(operation === "local_edit" ? [{ assetId: "product", alias: null, purposes: ["product_identity" as const], usedCueIds: [] }] : []),
        ],
        baseline: { productFacts: product ? { identity: "oak cabinet", outline: "four doors", color: "oak", material: "wood", brandText: [], view: "front" } : null, sceneFacts: null },
        delta: { requestedChanges: ["移除左侧花瓶，其他保持不变"], targetObjects: [], targetRegions: [] },
        preserve: { productCore: product ? ["outline", "color", "material"] : [], sceneElements: ["柜体和光线"] },
        protection: { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: false },
        canvas: { mode: "exact", size: { width: 1900, height: 1700 }, source: "explicit_size", allowReframe: true },
        modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "nano-banana-2", qualityCheck: null },
        continuity: { branchId: "branch", parentResultId: null },
        validation: { requiredChecks: ["requested_edit"] },
    };
}

describe("create full-image delivery", () => {
    it("honors the configured aspect ratio before inheriting the original picture", () => {
        const input = ecommerceCanvasInputFromRequest("移除左侧花瓶", "16:9", { width: 1513, height: 1511 });
        expect(resolveEcommerceCanvasConstraint({ ...input, operation: "scene_edit", strategy: "full_image" })).toMatchObject({ mode: "ratio", source: "explicit_size", size: { width: 16, height: 9 } });
    });
    it("inherits the reference aspect ratio without locking a requested camera change", () => {
        const canvas = resolveEcommerceCanvasConstraint({ operation: "scene_edit", strategy: "full_image", baselineSize: { width: 1513, height: 1511 } });
        expect(canvas).toMatchObject({ mode: "ratio", source: "baseline" });
        const edit = { ...plan("scene_edit"), canvas: { ...canvas!, allowReframe: false }, delta: { requestedChanges: ["改为正面平视角度"], targetObjects: [], targetRegions: [] } };
        const profile = resolveEcommerceImageProviderProfile({ logicalRole: "image_generation", capability: "image", logicalModelId: "nano-banana-2", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "gemini" })!;
        expect(compileEcommerceImageRequest(edit, profile).prompt).not.toContain("保持原机位和构图");
    });
    it.each(["product_to_scene", "local_edit", "scene_edit"] as const)("creates an unmasked %s with the original reference roles and canvas", (operation) => {
        const edit = plan(operation);
        expect(normalizeEcommerceEditPlan(edit)).toEqual(edit);
        const profile = resolveEcommerceImageProviderProfile({ logicalRole: "image_generation", capability: "image", logicalModelId: "nano-banana-2", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "gemini" })!;
        const execution = compileEcommerceImageRequest(edit, profile);
        expect(execution).toMatchObject({ state: "ready", compilerVersion: "ecommerce-nano-banana-2.v5", canvas: edit.canvas });
        expect(execution.mask).toBeUndefined();
        expect(execution.prompt).not.toMatch(/strict_product|独立蒙版|选区外.*恢复/);
        expect(execution.referenceMapping?.[0]).toMatchObject({ assetId: edit.referenceUses![0].assetId, userAlias: "图片1", providerIndex: 0 });
        const assets = ["product", "scene"].map((id) => ({ id, type: "image", status: "ready", serverUrl: `/api/reference-assets/${id}.png`, width: 1513, height: 1511 }) as CreativeAsset);
        const task = createEcommerceSceneEditTask({ id: "run", prompt: "移除左侧花瓶，其他保持不变" }, edit, assets, execution);
        expect(task.status).toBe("ready");
        expect(task.references?.map((reference) => ({ assetId: reference.assetId, role: reference.ecommerceRole }))).toEqual(execution.referenceRoles);
        const prepared = prepareEcommerceImageTask({
            kind: "edit",
            prompt: task.prompt,
            references: task.references!.map((reference) => ({ id: reference.assetId!, dataUrl: "", url: reference.url, ecommerceRole: reference.ecommerceRole })),
            ecommerceExecution: execution,
            compatibleConfigs: [{ apiFormat: "gemini", model: "nano-banana-2", baseUrl: "https://fixture.invalid", apiKey: "fixture" }],
        });
        expect(prepared.reviewReason).toBe("");
        expect(prepared.mask).toBeUndefined();
        expect(prepared.productProtection).toBeUndefined();
        expect(prepared.sceneProtection).toBeUndefined();
    });

    it("retains ordinary CPU processing and full-image enhancement for product references", async () => {
        const edit = plan("product_to_scene");
        const profile = resolveEcommerceImageProviderProfile({ logicalRole: "image_generation", capability: "image", logicalModelId: "nano-banana-2", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "gemini" })!;
        const execution = compileEcommerceImageRequest(edit, profile);
        const config = { apiFormat: "gemini" as const, model: "nano-banana-2", baseUrl: "https://fixture.invalid", apiKey: "fixture", quality: "4k" };
        const references = [{ id: "product", dataUrl: "", serverUrl: "/api/reference-assets/product.png", ecommerceRole: "product" as const }];
        const delivery = await freezeEcommerceEnhancementDelivery({ kind: "edit", config, references, ecommerceExecution: execution }, async () => {
            throw new Error("Full-image delivery must not read or composite an original protection baseline");
        });
        expect(delivery).toEqual({ version: "ecommerce-delivery.v2", scope: "full_image", canvas: edit.canvas });
        const image = { id: "image", runId: "run", kind: "edit", config, references, ecommerceExecution: execution, enhancementDelivery: delivery } as ImageTask;
        expect(isNativeGlobalSceneImageTaskResult(image)).toBe(true);
        expect(imageTaskResultOptions(image, [])).toMatchObject({ mode: "ordinary" });
    });
});
