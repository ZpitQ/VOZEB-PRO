import { describe, expect, it } from "vitest";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { classifyReferenceRoles, resolveContinuitySources, type EcommerceReferenceVisualHint } from "./ecommerce-reference-roles";

describe("classifyReferenceRoles", () => {
    it("classifies a high-confidence isolated white-background subject as the product reference", () => {
        const product = imageAsset("asset-product");

        const decision = classifyReferenceRoles([product], [visualHint(product.id, { whiteBackground: true, isolatedSubject: true })]);

        expect(decision).toMatchObject({
            status: "resolved",
            productAssetId: product.id,
            sceneAssetId: null,
            ambiguityReason: null,
            clarificationQuestion: null,
        });
    });

    it("classifies a complete home interior as a scene reference and asks for the missing product once", () => {
        const scene = imageAsset("asset-scene");

        const decision = classifyReferenceRoles([scene], [visualHint(scene.id, { completeScene: true })]);

        expect(decision).toMatchObject({
            status: "needs_clarification",
            productAssetId: null,
            sceneAssetId: scene.id,
            ambiguityReason: "missing_product_reference",
        });
        expect(decision.clarificationQuestion).toBe("请再提供一张需要保留商品外观的商品图。");
    });

    it("resolves one product and one scene regardless of upload order", () => {
        const product = imageAsset("asset-product");
        const scene = imageAsset("asset-scene");

        const decision = classifyReferenceRoles([scene, product], [visualHint(product.id, { whiteBackground: true, isolatedSubject: true }), visualHint(scene.id, { completeScene: true })]);

        expect(decision).toMatchObject({ status: "resolved", productAssetId: product.id, sceneAssetId: scene.id });
    });

    it("rejects more than two image references with one clarification question", () => {
        const assets = [imageAsset("asset-one"), imageAsset("asset-two"), imageAsset("asset-three")];

        const decision = classifyReferenceRoles(
            assets,
            assets.map((asset) => visualHint(asset.id, { completeScene: true })),
        );

        expect(decision).toMatchObject({
            status: "rejected",
            productAssetId: null,
            sceneAssetId: null,
            ambiguityReason: "too_many_images",
        });
        expect(decision.clarificationQuestion).toBe("首期最多支持一张商品图和一张场景参考图，请只保留两张图片。");
    });

    it("does not guess when visual evidence is unknown", () => {
        const asset = imageAsset("asset-unknown");

        const decision = classifyReferenceRoles([asset], [visualHint(asset.id)]);

        expect(decision).toMatchObject({
            status: "needs_clarification",
            productAssetId: null,
            sceneAssetId: null,
            ambiguityReason: "unclassified_reference",
        });
        expect(decision.clarificationQuestion).toBe("请确认这张图片是商品图还是场景参考图。");
    });
});

describe("resolveContinuitySources", () => {
    it("starts a new product anchor when a new product image is explicit", () => {
        const product = imageAsset("asset-product-new");
        const decision = classifyReferenceRoles([product], [visualHint(product.id, { whiteBackground: true, isolatedSubject: true })]);

        const sources = resolveContinuitySources(run([product.id]), { assets: [product], decision }, []);

        expect(sources).toMatchObject({
            status: "resolved",
            productAnchorId: product.id,
            currentSceneBaselineId: null,
            sceneReferenceIds: [],
            parentResultId: null,
            startsNewProductAnchor: true,
            createsBranch: false,
        });
    });

    it("uses a new scene reference without replacing the selected history product anchor", () => {
        const scene = imageAsset("asset-scene-new");
        const history = imageAsset("asset-result-old", { parentAssetId: "asset-product-original", sourceRunId: "run-old" });
        const decision = classifyReferenceRoles([scene], [visualHint(scene.id, { completeScene: true })]);

        const sources = resolveContinuitySources(run([scene.id, history.id]), { assets: [scene], decision }, [history]);

        expect(sources).toMatchObject({
            status: "resolved",
            productAnchorId: "asset-product-original",
            currentSceneBaselineId: history.id,
            sceneReferenceIds: [scene.id],
            parentResultId: history.id,
            startsNewProductAnchor: false,
            createsBranch: true,
        });
    });

    it("creates a branch from one explicitly selected history result", () => {
        const history = imageAsset("asset-result-selected", { parentAssetId: "asset-product-original", sourceRunId: "run-old" });

        const sources = resolveContinuitySources(run([history.id]), emptySelection(), [history]);

        expect(sources).toMatchObject({
            status: "resolved",
            productAnchorId: "asset-product-original",
            currentSceneBaselineId: history.id,
            parentResultId: history.id,
            createsBranch: true,
        });
    });

    it("asks one question when selected history has no stable product anchor", () => {
        const history = imageAsset("asset-result-legacy", { sourceRunId: "run-old" });

        const sources = resolveContinuitySources(run([history.id]), emptySelection(), [history]);

        expect(sources).toMatchObject({ status: "needs_clarification", ambiguityReason: "missing_product_anchor" });
        expect(sources.clarificationQuestion).toBe("无法确认这张历史结果对应的原始商品图，请重新提供商品图。");
    });
});

function imageAsset(id: string, overrides: Partial<CreativeAsset> = {}): CreativeAsset {
    return {
        id,
        userId: "user-one",
        conversationId: "conversation-one",
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

function visualHint(assetId: string, overrides: Partial<EcommerceReferenceVisualHint> = {}): EcommerceReferenceVisualHint {
    return {
        assetId,
        confidence: "high",
        whiteBackground: false,
        transparentBackground: false,
        isolatedSubject: false,
        completeScene: false,
        ...overrides,
    };
}

function run(referencedAssetIds: string[]) {
    return { id: "run-one", referencedAssetIds };
}

function emptySelection() {
    return {
        assets: [] as CreativeAsset[],
        decision: classifyReferenceRoles([], []),
    };
}
