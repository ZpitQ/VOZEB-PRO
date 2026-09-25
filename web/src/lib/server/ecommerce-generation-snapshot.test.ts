import { describe, expect, it } from "vitest";

import { buildEcommercePlanningInput, ecommerceShadowPlanningEnabled, legacyPlanFallback, recordEcommerceGenerationSnapshot, type EcommerceGenerationSnapshot } from "./ecommerce-generation-snapshot";
import { publicAgentRun } from "./agent-run-public";
import type { AgentRun } from "./agent-run-store";

describe("ecommerce generation shadow snapshot", () => {
    it("keeps shadow planning disabled unless the rollout mode explicitly enables it", () => {
        expect(ecommerceShadowPlanningEnabled(undefined)).toBe(false);
        expect(ecommerceShadowPlanningEnabled("off")).toBe(false);
        expect(ecommerceShadowPlanningEnabled("shadow")).toBe(true);
    });

    it("builds a bounded planning input from the user request and asset metadata", () => {
        const input = buildEcommercePlanningInput(
            {
                conversationId: "conversation",
                surface: "chat",
                prompt: "把白底台灯放到明亮客厅",
                referencedAssetIds: ["asset-product", "asset-scene"],
            },
            [
                { id: "asset-product", type: "image", title: "白底台灯", remoteUrl: "https://cdn.example.com/product.png", metadata: {}, userId: "user", conversationId: "conversation", ordinal: 0, status: "ready", createdAt: 1, updatedAt: 1 },
                {
                    id: "asset-scene",
                    type: "image",
                    title: "客厅参考",
                    serverUrl: "/api/assets/scene",
                    metadata: { content: "data:image/png;base64,secret" },
                    userId: "user",
                    conversationId: "conversation",
                    ordinal: 1,
                    status: "ready",
                    createdAt: 1,
                    updatedAt: 1,
                },
            ] as never,
            { summary: "家居商品连续创作", recentMessages: [{ role: "assistant", content: "上一轮生成了台灯场景", sequence: 2 }] } as never,
        );

        expect(input).toMatchObject({
            userRequest: "把白底台灯放到明亮客厅",
            conversationId: "conversation",
            assetCandidates: [
                { id: "asset-product", type: "image", title: "白底台灯", url: "https://cdn.example.com/product.png" },
                { id: "asset-scene", type: "image", title: "客厅参考", url: "/api/assets/scene" },
            ],
            conversationContext: { summary: "家居商品连续创作" },
        });
        expect(JSON.stringify(input)).not.toContain("data:image/png;base64,secret");
    });

    it("appends a recovered product anchor after the explicitly referenced history result", () => {
        const input = buildEcommercePlanningInput(
            {
                conversationId: "conversation",
                surface: "chat",
                prompt: "把背景换成厨房",
                referencedAssetIds: ["asset-scene-result"],
            },
            [imageAsset("asset-product-anchor", "原始商品", "/api/assets/product"), imageAsset("asset-scene-result", "上一轮场景", "/api/assets/scene-result")],
            { summary: "", recentMessages: [] } as never,
        );

        expect(input.assetCandidates.map((asset) => asset.id)).toEqual(["asset-scene-result", "asset-product-anchor"]);
    });

    it("records a server-only snapshot without changing the user-visible task", () => {
        const snapshot: EcommerceGenerationSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "shadow",
            input: { userRequest: "换成客厅", assetIds: ["asset-product"], conversationId: "conversation", surface: "chat" },
            compilerVersion: "legacy-shadow.v1",
            createdAt: 10,
        };
        const recorded = recordEcommerceGenerationSnapshot({ id: "agent-run", userId: "user" }, snapshot);

        expect(recorded).toEqual({ ...snapshot, runId: "agent-run", userId: "user" });
        expect(recorded).toHaveProperty("input.userRequest", "换成客厅");
    });

    it("keeps the legacy path explicit when the ecommerce planner is not enabled", () => {
        const input = { userRequest: "把背景改成厨房", assetIds: ["asset-product"], conversationId: "conversation", surface: "chat" as const };

        expect(legacyPlanFallback(input)).toEqual({ mode: "legacy", reason: "ecommerce_planner_disabled", input });
    });

    it("does not expose the internal snapshot through the public Agent Run shape", () => {
        const snapshot: EcommerceGenerationSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "shadow",
            input: { userRequest: "生成场景", assetIds: ["asset-product"], conversationId: "conversation", surface: "chat" },
            createdAt: 10,
        };
        const publicRun = publicAgentRun({
            id: "agent-run",
            userId: "user",
            conversationId: "conversation",
            clientRequestId: "request",
            surface: "chat",
            inputMessageId: "message-user",
            assistantMessageId: "message-assistant",
            prompt: "生成场景",
            referencedAssetIds: ["asset-product"],
            assetIds: [],
            status: "planning",
            tasks: [],
            reviewed: false,
            ecommerceSnapshot: recordEcommerceGenerationSnapshot({ id: "agent-run", userId: "user" }, snapshot),
            createdAt: 1,
            updatedAt: 1,
        } as AgentRun);

        expect(publicRun).not.toHaveProperty("ecommerceSnapshot");
    });
});

function imageAsset(id: string, title: string, serverUrl: string) {
    return {
        id,
        userId: "user",
        conversationId: "conversation",
        ordinal: 0,
        type: "image" as const,
        status: "ready" as const,
        title,
        serverUrl,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
    };
}
