import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EcommercePlanningInput } from "./ecommerce-generation-snapshot";
import type { EcommerceRoleCandidate } from "./ecommerce-model-routing";
import { analyzeEcommerceReferences, normalizeEcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { requestStructuredText, type TextPlanningCandidate } from "./text-planning-runtime";

const mocks = vi.hoisted(() => ({ refundUserPoints: vi.fn(async () => undefined) }));

vi.mock("@/lib/auth/store", () => ({ refundUserPoints: mocks.refundUserPoints }));

vi.mock("./text-planning-runtime", () => ({
    requestStructuredText: vi.fn(),
    rankTextPlanningCandidates: <T>(candidates: T[]) => candidates,
}));

const mockedRequest = vi.mocked(requestStructuredText);

describe("ecommerce visual analysis", () => {
    beforeEach(() => {
        mockedRequest.mockReset();
        mocks.refundUserPoints.mockClear();
    });

    it("keeps product and scene evidence in separate reference roles", async () => {
        mockedRequest.mockResolvedValue(modelCall(analysisFixture()));

        const result = await analyzeEcommerceReferences(requestInput(), role("vision_analysis", [candidate("primary")]));

        expect(result.references).toEqual([
            expect.objectContaining({ assetId: "product", role: "product", productFacts: expect.objectContaining({ identity: "oak side table" }), sceneFacts: null }),
            expect.objectContaining({ assetId: "scene", role: "scene", productFacts: null, sceneFacts: expect.objectContaining({ space: "living room" }) }),
        ]);
        expect(result.modelRole).toMatchObject({ logicalRole: "vision_analysis", logicalModelId: "vision-model", channelId: "primary" });
    });

    it("rejects output that attaches scene facts or scene regions to a product reference", () => {
        const value = analysisFixture() as { references: Array<Record<string, unknown>> } & Record<string, unknown>;
        value.references[0] = { ...value.references[0], sceneFacts: sceneFacts(), role: "product" };

        expect(normalizeEcommerceVisualAnalysis(value, planningInput().assetCandidates)).toBeNull();
    });

    it("accepts protected product regions and structured editable targets on a generated scene baseline", () => {
        const value = analysisFixture() as { references: Array<Record<string, unknown>> } & Record<string, unknown>;
        value.references[1] = {
            ...value.references[1],
            productCore: { x: 0.35, y: 0.25, width: 0.3, height: 0.5 },
            fusionHalo: { x: 0.31, y: 0.21, width: 0.38, height: 0.58 },
            editableTargets: [
                { id: "background-main", kind: "background", label: "main room background", region: { x: 0, y: 0, width: 1, height: 1 } },
                { id: "plant-right", kind: "prop", label: "right green plant", region: { x: 0.78, y: 0.28, width: 0.18, height: 0.55 } },
            ],
        };

        const result = normalizeEcommerceVisualAnalysis(value, planningInput().assetCandidates);

        expect(result?.references[1]).toMatchObject({
            role: "scene",
            productCore: { x: 0.35, y: 0.25, width: 0.3, height: 0.5 },
            editableTargets: [
                { id: "background-main", kind: "background" },
                { id: "plant-right", kind: "prop" },
            ],
        });
    });

    it("fails over between logical models in the same role and attributes billing to the actual candidate", async () => {
        mockedRequest.mockResolvedValueOnce(modelCall({ invalid: true }, new Headers({ "x-vozeb-pro-points-cost": "3", "x-vozeb-pro-points-record-id": "vision-primary-charge" }))).mockResolvedValueOnce(modelCall(analysisFixture()));

        const result = await analyzeEcommerceReferences(requestInput(), [roleCandidate("vision_analysis", "vision-primary", "primary"), roleCandidate("vision_analysis", "vision-backup", "secondary")]);

        expect(mockedRequest).toHaveBeenCalledTimes(2);
        expect(result.modelRole).toMatchObject({ logicalModelId: "vision-backup", channelId: "secondary", upstreamModel: "vendor/secondary" });
        expect(mockedRequest.mock.calls[0]?.[0].headers).toMatchObject({ "x-vozeb-pro-logical-model": "vision-primary", "x-vozeb-pro-upstream-model": "vendor/primary" });
        expect(mockedRequest.mock.calls[1]?.[0].headers).toMatchObject({ "x-vozeb-pro-logical-model": "vision-backup", "x-vozeb-pro-upstream-model": "vendor/secondary" });
        expect(new Headers(mockedRequest.mock.calls[0]?.[0].headers).get("x-vozeb-pro-points-idempotency-key")).not.toBe(new Headers(mockedRequest.mock.calls[1]?.[0].headers).get("x-vozeb-pro-points-idempotency-key"));
        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user-one", "vision-primary", 3, "text", 1, undefined, "vision-primary-charge");
    });

    it("rejects a cross-role candidate group before calling a model", async () => {
        await expect(analyzeEcommerceReferences(requestInput(), role("edit_planning", [candidate("planner")]))).rejects.toThrow("vision_analysis");
        expect(mockedRequest).not.toHaveBeenCalled();
    });
});

function requestInput() {
    return {
        origin: "http://127.0.0.1:3000",
        cookie: "session=test",
        userId: "user-one",
        requestId: "run-one",
        planningInput: planningInput(),
    };
}

function planningInput(): EcommercePlanningInput {
    return {
        userRequest: "把商品放进简约客厅",
        conversationId: "conversation-one",
        surface: "chat",
        assetCandidates: [
            { id: "product", type: "image", title: "product.png", url: "data:image/png;base64,cHJvZHVjdA==" },
            { id: "scene", type: "image", title: "scene.png", url: "data:image/png;base64,c2NlbmU=" },
        ],
        conversationContext: { summary: "", recentMessages: [] },
    };
}

function analysisFixture() {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1" as const,
        references: [
            {
                assetId: "product",
                role: "product" as const,
                confidence: "high" as const,
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: productFacts(),
                sceneFacts: null,
                productCore: { x: 0.2, y: 0.15, width: 0.6, height: 0.7 },
                fusionHalo: { x: 0.16, y: 0.11, width: 0.68, height: 0.78 },
                editableTargets: [],
            },
            {
                assetId: "scene",
                role: "scene" as const,
                confidence: "high" as const,
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: sceneFacts(),
                productCore: null,
                fusionHalo: null,
                editableTargets: [],
            },
        ],
    };
}

function productFacts() {
    return { identity: "oak side table", outline: "round top and three legs", color: "natural oak", material: "wood", brandText: [], view: "front three-quarter" };
}

function sceneFacts() {
    return { space: "living room", composition: "eye-level wide view", lighting: "soft window daylight" };
}

function role(logicalRole: "vision_analysis" | "edit_planning", candidates: TextPlanningCandidate[]) {
    const logicalModelId = logicalRole === "vision_analysis" ? "vision-model" : "planner-model";
    return candidates.map((value) => roleCandidate(logicalRole, logicalModelId, value.channelId));
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
        channel: {
            id,
            name: id,
            baseUrl: "https://example.com/v1",
            apiKey: "secret",
            apiFormat: "openai",
            models: ["vendor/" + id],
            enabled: true,
        },
    };
}

function modelCall(value: unknown, headers = new Headers()) {
    return { arguments: JSON.stringify(value), headers, protocol: "chat" as const, elapsedMs: 10 };
}
