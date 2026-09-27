import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceRoleCandidate } from "./ecommerce-model-routing";
import { ECOMMERCE_QUALITY_CHECK_KEYS, checkEcommerceResult, checkEcommerceResultWithFallback, ecommerceQualityGate, shouldBlockEcommerceResult, unavailableEcommerceQualityCheck, type EcommerceQualityCheckRequest } from "./ecommerce-quality-check";

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
        brandedRequest.plan.baseline.productFacts!.brandText = ["ACME"];
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

    it("checks a scene edit against its scene baseline without product hard failures", async () => {
        mocks.requestStructuredText.mockResolvedValue(
            modelCall(
                modelResult({
                    product_identity: "failed",
                    product_silhouette: "failed",
                    product_color_material: "failed",
                    product_proportions_view: "failed",
                }),
            ),
        );
        const sceneRequest = request(scenePlan());
        sceneRequest.baselineReference = { assetId: "scene-1", url: "https://cdn.example.com/scene.png", role: "scene" };

        const checked = await checkEcommerceResult(sceneRequest, candidate());

        expect(checked.status).toBe("passed");
        expect(checked.hardFailures).toEqual([]);
        expect(checked.checks.filter((item) => item.key.startsWith("product_")).every((item) => item.status === "not_applicable")).toBe(true);
    });

    it("fails closed when the frozen quality-check model is unavailable", async () => {
        mocks.requestStructuredText.mockRejectedValue(new Error("quality model offline"));

        const checked = await checkEcommerceResult(request(), candidate());

        expect(checked).toMatchObject({ status: "unavailable", publicStatus: "needs_review", hardFailures: [], internalReason: "quality model offline" });
        expect(shouldBlockEcommerceResult(checked)).toBe(true);
        expect(ecommerceQualityGate(checked).action).toBe("pause");
    });

    it("uses the next quality-check candidate only when the preferred candidate is unavailable", async () => {
        const preferred = candidate("quality-primary", "gemini-3.8-flash-high", "quality-primary-channel");
        const fallback = candidate("quality-fallback", "gpt-5.6-sol", "quality-fallback-channel");
        mocks.requestStructuredText.mockRejectedValueOnce(new Error("Verify your account to continue.")).mockResolvedValueOnce(modelCall(modelResult()));

        const checked = await checkEcommerceResultWithFallback(request(), [preferred, fallback]);

        expect(checked.status).toBe("passed");
        expect(checked.modelRole).toEqual(fallback.snapshot);
        expect(mocks.requestStructuredText).toHaveBeenCalledTimes(2);
        expect(mocks.requestStructuredText.mock.calls.map(([input]) => input.candidate.snapshot)).toEqual([preferred.snapshot, fallback.snapshot]);
    });

    it("does not turn an unavailable snapshot into a pass", () => {
        const checked = unavailableEcommerceQualityCheck("quality route missing", candidate().snapshot);

        expect(checked.status).toBe("unavailable");
        expect(checked.publicStatus).toBe("needs_review");
        expect(shouldBlockEcommerceResult(checked)).toBe(true);
    });
});

function request(requestPlan = plan()): EcommerceQualityCheckRequest {
    return {
        origin: "http://localhost",
        cookie: "session=test",
        userId: "user-1",
        requestId: "run-1",
        plan: requestPlan,
        baselineReference: { assetId: "product-1", url: "https://cdn.example.com/product.png", role: "product" as const },
        resultImages: [{ resultId: "result-1", url: "https://cdn.example.com/result.png" }],
    };
}

function candidate(logicalModelId = "quality-model", upstreamModel = "gpt-5.6-sol", channelId = "quality-channel"): EcommerceRoleCandidate {
    return {
        logicalRole: "quality_check",
        capability: "text",
        logicalModelId,
        channelId,
        upstreamModel,
        channel: { id: channelId, name: "Quality", enabled: true, apiFormat: "openai", baseUrl: "https://example.com", apiKey: "secret", models: [] },
        snapshot: {
            logicalRole: "quality_check",
            capability: "text",
            logicalModelId,
            channelId,
            upstreamModel,
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

function scenePlan(): EcommerceEditPlan {
    return {
        ...plan(),
        operation: "scene_edit",
        source: { productAnchorId: null, currentSceneBaselineId: "scene-1", sceneReferenceIds: [] },
        baseline: {
            productFacts: null,
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: {
            requestedChanges: ["改成冬日阳光"],
            targetObjects: ["lighting-main"],
            targetRegions: ["whole-scene"],
        },
        preserve: { productCore: [], sceneElements: ["layout", "furniture", "camera"] },
        strategy: "integrated_scene",
        validation: { requiredChecks: ["requested_edit", "scene_preservation", "composition_lighting"] },
    } as EcommerceEditPlan;
}
