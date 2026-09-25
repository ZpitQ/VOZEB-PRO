import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceRoleCandidate } from "./ecommerce-model-routing";
import { ECOMMERCE_QUALITY_CHECK_KEYS, checkEcommerceResult, ecommerceQualityGate, shouldBlockEcommerceResult, unavailableEcommerceQualityCheck } from "./ecommerce-quality-check";

const mocks = vi.hoisted(() => ({
    requestStructuredText: vi.fn(),
    refundUserPoints: vi.fn(async () => undefined),
}));

vi.mock("./text-planning-runtime", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./text-planning-runtime")>();
    return { ...actual, requestStructuredText: mocks.requestStructuredText };
});

vi.mock("@/lib/auth/store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/auth/store")>();
    return { ...actual, refundUserPoints: mocks.refundUserPoints };
});

describe("ecommerce quality check", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("blocks publication when a generated result changes the product silhouette", async () => {
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult({ product_silhouette: "failed" })));

        const checked = await checkEcommerceResult(request(), candidate());

        expect(checked.status).toBe("blocked");
        expect(checked.publicStatus).toBe("needs_review");
        expect(checked.hardFailures).toEqual([expect.objectContaining({ resultId: "result-1", key: "product_silhouette", status: "failed" })]);
        expect(shouldBlockEcommerceResult(checked)).toBe(true);
        expect(ecommerceQualityGate(checked)).toEqual({ action: "pause", publicStatus: "needs_review", publicMessage: "商品一致性检查未通过，需要复核。" });
    });

    it("fails closed when a required product invariant cannot be evaluated", async () => {
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult({ product_identity: "not_applicable" })));

        const checked = await checkEcommerceResult(request(), candidate());

        expect(checked.status).toBe("blocked");
        expect(checked.hardFailures).toEqual([expect.objectContaining({ resultId: "result-1", key: "product_identity", status: "not_applicable" })]);
    });

    it("only allows logo and packaging checks to be not applicable when the baseline has no brand text", async () => {
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult({ brand_logo: "not_applicable", packaging_text: "not_applicable" })));
        const withoutBrandText = await checkEcommerceResult(request(), candidate());
        const brandedRequest = request();
        brandedRequest.plan.baseline.productFacts.brandText = ["ACME"];
        const withBrandText = await checkEcommerceResult(brandedRequest, candidate());

        expect(withoutBrandText.status).toBe("passed");
        expect(withBrandText.status).toBe("blocked");
        expect(withBrandText.hardFailures.map((item) => item.key)).toEqual(["brand_logo", "packaging_text"]);
    });

    it("publishes a result with a short adjustment status for scene-only drift", async () => {
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult({ scene_intent: "failed" })));

        const checked = await checkEcommerceResult(request(), candidate());

        expect(checked.status).toBe("needs_adjustment");
        expect(checked.publicStatus).toBe("needs_adjustment");
        expect(checked.hardFailures).toEqual([]);
        expect(shouldBlockEcommerceResult(checked)).toBe(false);
        expect(ecommerceQualityGate(checked)).toEqual({ action: "publish", publicStatus: "needs_adjustment", publicMessage: "图片已生成，场景细节可继续调整。" });
    });

    it("fails closed when the frozen quality-check model is unavailable", async () => {
        mocks.requestStructuredText.mockRejectedValue(new Error("quality model offline"));

        const checked = await checkEcommerceResult(request(), candidate());

        expect(checked).toMatchObject({ status: "unavailable", publicStatus: "needs_review", hardFailures: [], internalReason: "quality model offline" });
        expect(shouldBlockEcommerceResult(checked)).toBe(true);
        expect(ecommerceQualityGate(checked).action).toBe("pause");
    });

    it("does not turn an unavailable snapshot into a pass", () => {
        const checked = unavailableEcommerceQualityCheck("quality route missing", candidate().snapshot);

        expect(checked.status).toBe("unavailable");
        expect(checked.publicStatus).toBe("needs_review");
        expect(shouldBlockEcommerceResult(checked)).toBe(true);
    });
});

function request() {
    return {
        origin: "http://localhost",
        cookie: "session=test",
        userId: "user-1",
        requestId: "run-1",
        plan: plan(),
        productReference: { assetId: "product-1", url: "https://cdn.example.com/product.png" },
        resultImages: [{ resultId: "result-1", url: "https://cdn.example.com/result.png" }],
    };
}

function candidate(): EcommerceRoleCandidate {
    return {
        logicalRole: "quality_check",
        capability: "text",
        logicalModelId: "quality-model",
        channelId: "quality-channel",
        upstreamModel: "gpt-5.6-sol",
        channel: { id: "quality-channel", name: "Quality", enabled: true, apiFormat: "openai", baseUrl: "https://example.com", apiKey: "secret", models: [] },
        snapshot: {
            logicalRole: "quality_check",
            capability: "text",
            logicalModelId: "quality-model",
            channelId: "quality-channel",
            upstreamModel: "gpt-5.6-sol",
            apiFormat: "openai",
        },
    } as EcommerceRoleCandidate;
}

function modelCall(value: unknown) {
    return { arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat" as const, elapsedMs: 10 };
}

function modelResult(overrides: Partial<Record<(typeof ECOMMERCE_QUALITY_CHECK_KEYS)[number], "passed" | "failed" | "not_applicable">> = {}) {
    return {
        results: [
            {
                resultId: "result-1",
                checks: ECOMMERCE_QUALITY_CHECK_KEYS.map((key) => ({
                    key,
                    status: overrides[key] || (key === "brand_logo" || key === "packaging_text" ? "not_applicable" : "passed"),
                    reason: overrides[key] === "failed" ? `${key} mismatch` : "ok",
                })),
            },
        ],
    };
}

function plan(): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v1",
        operation: "product_to_scene",
        source: { productAnchorId: "product-1", currentSceneBaselineId: null, sceneReferenceIds: [] },
        baseline: {
            productFacts: { identity: "oak bed", outline: "rectangular bed frame", color: "oak", material: "wood", brandText: [], view: "front three-quarter" },
            sceneFacts: { space: "bedroom", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: ["place in a modern bedroom"], targetObjects: ["scene"], targetRegions: ["background"] },
        preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
        strategy: "strict_product",
        modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "quality-model" },
        continuity: { parentResultId: null, branchId: "branch-1" },
        validation: { requiredChecks: ["product_identity"] },
    };
}
