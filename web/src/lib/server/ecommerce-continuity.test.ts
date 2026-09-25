import { describe, expect, it } from "vitest";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { ecommerceGenerationEnabled } from "./ecommerce-generation-service";
import { classifyReferenceRoles, resolveDualBaseline } from "./ecommerce-reference-roles";

describe("ecommerce dual-baseline continuity", () => {
    const product = image("product-original");
    const older = image("result-older", { sourceRunId: "run-older", parentAssetId: product.id, createdAt: 10 });
    const latest = image("result-latest", { sourceRunId: "run-latest", parentAssetId: product.id, createdAt: 20 });

    it("inherits the latest successful scene while retaining the original product anchor", () => {
        const sources = resolveDualBaseline(run([]), { assets: [], decision: classifyReferenceRoles([], []), results: [older, latest] });

        expect(sources).toMatchObject({ status: "resolved", productAnchorId: product.id, currentSceneBaselineId: latest.id, parentResultId: latest.id });
        expect(ecommerceGenerationEnabled("internal", { surface: "chat", referencedAssetIds: [], generationPreferences: { mode: "image" } }, Boolean(sources.currentSceneBaselineId))).toBe(true);
    });

    it("branches from the exact older result selected by stable asset ID", () => {
        const sources = resolveDualBaseline(run([older.id]), { assets: [], decision: classifyReferenceRoles([], []), results: [latest, older] });

        expect(sources).toMatchObject({ status: "resolved", productAnchorId: product.id, currentSceneBaselineId: older.id, parentResultId: older.id, createsBranch: true });
    });

    it("starts a new product anchor when a new white-background product is uploaded", () => {
        const replacement = image("product-replacement");
        const decision = classifyReferenceRoles([replacement], [{ assetId: replacement.id, confidence: "high", whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false }]);

        expect(resolveDualBaseline(run([replacement.id]), { assets: [replacement], decision, results: [latest] })).toMatchObject({
            status: "resolved",
            productAnchorId: replacement.id,
            currentSceneBaselineId: null,
            parentResultId: null,
            startsNewProductAnchor: true,
        });
    });

    it("keeps the prior result only as branch parent for a replacement product and new room", () => {
        const replacement = image("product-replacement");
        const room = image("room-reference");
        const decision = classifyReferenceRoles(
            [replacement, room],
            [
                { assetId: replacement.id, confidence: "high", whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                { assetId: room.id, confidence: "high", whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
            ],
        );

        expect(resolveDualBaseline(run([replacement.id, room.id]), { assets: [replacement, room], decision, results: [latest] })).toMatchObject({
            status: "resolved",
            productAnchorId: replacement.id,
            currentSceneBaselineId: null,
            sceneReferenceIds: [room.id],
            parentResultId: latest.id,
            startsNewProductAnchor: true,
            createsBranch: true,
        });
    });

    it("keeps a newly uploaded room separate from the product anchor and prior result lineage", () => {
        const scene = image("scene-reference");
        const decision = classifyReferenceRoles([scene], [{ assetId: scene.id, confidence: "high", whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true }]);

        expect(resolveDualBaseline(run([scene.id]), { assets: [scene], decision, results: [latest] })).toMatchObject({
            status: "resolved",
            productAnchorId: product.id,
            currentSceneBaselineId: null,
            sceneReferenceIds: [scene.id],
            parentResultId: latest.id,
        });
    });

    it("uses an explicitly selected older result as branch parent when a new scene is uploaded", () => {
        const scene = image("scene-reference");
        const decision = classifyReferenceRoles([scene], [{ assetId: scene.id, confidence: "high", whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true }]);

        expect(resolveDualBaseline(run([older.id, scene.id]), { assets: [scene], decision, results: [latest, older] })).toMatchObject({
            status: "resolved",
            productAnchorId: product.id,
            currentSceneBaselineId: null,
            sceneReferenceIds: [scene.id],
            parentResultId: older.id,
        });
    });

    it("does not infer a product anchor from a title or prompt", () => {
        const unlinked = image("result-unlinked", { sourceRunId: "run-unlinked", title: "product-original result", metadata: { prompt: "use product-original" } });

        expect(resolveDualBaseline(run([]), { assets: [], decision: classifyReferenceRoles([], []), results: [unlinked] })).toMatchObject({
            status: "needs_clarification",
            ambiguityReason: "missing_product_anchor",
        });
    });
});

function run(referencedAssetIds: string[]) {
    return { id: "run-current", referencedAssetIds };
}

function image(id: string, overrides: Partial<CreativeAsset> = {}): CreativeAsset {
    return {
        id,
        userId: "user",
        conversationId: "conversation",
        ordinal: 0,
        type: "image",
        status: "ready",
        title: id,
        serverUrl: `/api/reference-assets/permanent/${id}.png`,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}
