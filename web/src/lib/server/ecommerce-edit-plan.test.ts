import { describe, expect, it } from "vitest";

import { normalizeEcommerceEditPlan, planPublicSummary, validateEcommerceEditPlan, type EcommerceEditPlan } from "./ecommerce-edit-plan";

function validPlan(overrides: Partial<EcommerceEditPlan> = {}): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v1",
        operation: "product_to_scene",
        source: {
            productAnchorId: "asset-product-001",
            currentSceneBaselineId: null,
            sceneReferenceIds: ["asset-scene-001"],
        },
        baseline: {
            productFacts: {
                identity: "白色陶瓷台灯",
                outline: "圆柱灯罩和木质底座",
                color: "暖白和浅木色",
                material: "陶瓷、木材",
                brandText: [],
                view: "三分之二正面",
            },
            sceneFacts: {
                space: "现代客厅",
                composition: "商品位于画面右侧",
                lighting: "柔和自然窗光",
            },
        },
        delta: {
            requestedChanges: ["生成现代客厅环境"],
            targetObjects: ["background"],
            targetRegions: ["background", "product_halo"],
        },
        preserve: {
            productCore: ["outline", "brand_text", "color", "material", "scale", "view"],
            sceneElements: [],
        },
        strategy: "strict_product",
        modelRoles: {
            visionAnalysis: "logical-vision-model",
            editPlanning: "logical-planner-model",
            generation: "logical-image-model",
            qualityCheck: "logical-quality-model",
        },
        continuity: {
            parentResultId: null,
            branchId: "branch-001",
        },
        validation: {
            requiredChecks: ["product_identity", "product_outline", "brand_text", "requested_scene_change"],
        },
        ...overrides,
    };
}

describe("EcommerceEditPlan", () => {
    it("accepts a strict product-to-scene plan with a product anchor", () => {
        expect(() => validateEcommerceEditPlan(validPlan())).not.toThrow();
    });

    it("rejects product-to-scene plans without a product anchor", () => {
        const plan = validPlan({ source: { ...validPlan().source, productAnchorId: "" } });

        expect(() => validateEcommerceEditPlan(plan)).toThrow("商品主参考图");
    });

    it("requires strict product core protections", () => {
        const plan = validPlan({ preserve: { productCore: ["outline"], sceneElements: [] } });

        expect(() => validateEcommerceEditPlan(plan)).toThrow("商品核心保护项");
    });

    it("rejects a scene reference that is also declared as the product anchor", () => {
        const plan = validPlan({ source: { ...validPlan().source, sceneReferenceIds: ["asset-product-001"] } });

        expect(() => validateEcommerceEditPlan(plan)).toThrow("场景参考图不能作为商品主参考图");
    });

    it("requires a target object or manual region for local edits", () => {
        const plan = validPlan({ operation: "local_edit", delta: { requestedChanges: ["调整画面"], targetObjects: [], targetRegions: [] } });

        expect(() => validateEcommerceEditPlan(plan)).toThrow("局部编辑目标");
    });

    it("does not silently accept an invalid continuity parent result", () => {
        const value = validPlan({ continuity: { parentResultId: "", branchId: "branch-001" } });

        expect(normalizeEcommerceEditPlan(value)).toBeNull();
        expect(() => validateEcommerceEditPlan(value)).toThrow("父结果");
    });

    it("normalizes a valid plan without mutating its input", () => {
        const input = validPlan();
        const normalized = normalizeEcommerceEditPlan(input);

        expect(normalized).toEqual(input);
        expect(normalized).not.toBe(input);
        expect(normalized?.delta.requestedChanges).not.toBe(input.delta.requestedChanges);
    });

    it("returns only a public operation summary", () => {
        const summary = planPublicSummary(validPlan());

        expect(summary).toEqual({ operation: "product_to_scene", strategy: "strict_product", requestedChanges: ["生成现代客厅环境"], targetObjects: ["background"] });
        expect(summary).not.toHaveProperty("source");
        expect(summary).not.toHaveProperty("baseline");
        expect(summary).not.toHaveProperty("modelRoles");
        expect(summary).not.toHaveProperty("validation");
    });
});
