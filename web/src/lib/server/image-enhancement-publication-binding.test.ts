import { describe, expect, it } from "vitest";

import type { ProductEnhancementEvidence, SceneProtectionEvidence } from "../image-processing/contracts";
import { createEnhancementPublicationBinding, type EnhancementPublicationBindingInput } from "./image-enhancement-publication-binding";

function fixture(): EnhancementPublicationBindingInput {
    const source = { url: "/api/generation-log-assets/fixture-native.png", sha256: "a".repeat(64), byteLength: 100, width: 32, height: 32, format: "png", hasAlpha: false };
    const model = { id: "fixture-model", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4 as const, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 };
    return {
        enhancementId: "fixture-enhancement",
        userId: "fixture-owner",
        imageTaskId: "fixture-image",
        resultId: "fixture-image:1",
        resultIndex: 1,
        attempt: 1,
        remoteKey: "fixture-enhancement:1",
        remoteJobId: "fixture-remote",
        receiptId: "fixture-receipt",
        decision: {
            status: "queued",
            reason: null,
            source: { ...source, provenance: "provider_native" },
            target: { width: 64, height: 64 },
            inference: { width: 128, height: 128 },
            connection: { revision: "fixture-policy", credentialRef: "fixture-credential", serviceId: "fixture-service", timeoutMs: 60_000, model },
        },
        remotePlan: {
            protocolVersion: "image-enhancement.v1",
            scope: "full_image",
            normalizationProfile: "srgb-upright-v1",
            source,
            sourceSha256: source.sha256,
            target: { width: 128, height: 128, format: "png" },
            engine: { modelId: model.id, binaryVersion: model.binaryVersion, binarySha256: model.binarySha256, modelVersion: model.modelVersion, modelSha256: model.modelSha256, nativeScale: 4, tile: 0, tta: false, gpuId: 0 },
            budgets: { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } },
            planFingerprint: "d".repeat(64),
            strategyFingerprint: "e".repeat(64),
        },
        remoteResult: { width: 128, height: 128, format: "png", byteLength: 200, sha256: "f".repeat(64) },
    };
}

// Binding facts do not qualify pixels or create a CPU receipt; those use the real producer/lane tests.
function productFixture() {
    const input = fixture();
    const proof: ProductEnhancementEvidence = {
        version: "product-enhancement.v2",
        normalization: "srgb-upright-v1",
        productAnchorId: "fixture-anchor",
        sourceAssetId: "fixture-source",
        sourceSha256: "1".repeat(64),
        maskSha256: "2".repeat(64),
        aiSha256: input.decision.source.sha256,
        compositeSha256: "3".repeat(64),
        sourceSize: { width: 32, height: 32 },
        aiSize: { width: 32, height: 32 },
        allowedPixels: 512,
        protectedPixels: 512,
        protectedChangedPixels: 0,
    };
    return {
        ...input,
        originalProof: proof,
        decision: {
            ...input.decision,
            delivery: {
                baseline: { ...input.remotePlan.source, sha256: proof.compositeSha256 },
                contract: {
                    version: "ecommerce-delivery.v2",
                    scope: "product_background",
                    baseline: { url: "/api/reference-assets/fixture-source.png", sha256: proof.sourceSha256, byteLength: 100, width: 32, height: 32, normalizedSha256: "4".repeat(64) },
                    protection: {
                        version: "product-enhancement.v2",
                        normalization: "srgb-upright-v1",
                        maskDataUrl: "data:image/png;base64,fixture-domain-identity-only",
                        maskSha256: proof.maskSha256,
                        product: {
                            compilerVersion: "strict-product.v1",
                            state: "ready",
                            productAnchorId: "fixture-anchor",
                            sourceAssetId: "fixture-source",
                            sourceSize: { width: 32, height: 32 },
                            productCore: [
                                { x: 0, y: 0, width: 4, height: 8 },
                                { x: 4, y: 0, width: 4, height: 8 },
                            ],
                            fusionHalo: [{ x: 8, y: 0, width: 8, height: 8 }],
                            editableBackground: [{ x: 16, y: 0, width: 16, height: 32 }],
                        },
                    },
                },
            },
        },
    } satisfies EnhancementPublicationBindingInput;
}

function sceneFixture() {
    const input = fixture();
    const proof: SceneProtectionEvidence = {
        version: "scene-edit-protection.v1",
        sourceAssetId: "fixture-scene",
        sourceDigest: "1".repeat(64),
        sourceSize: { width: 32, height: 32 },
        maskDigest: "2".repeat(64),
        maskSize: { width: 32, height: 32 },
        targetRegion: { x: 8, y: 8, width: 8, height: 8 },
        semantics: ["fixture-region"],
        selectionSource: "user_selection",
        confirmation: { actorUserId: "fixture-owner", confirmedAt: 1 },
        maskSemantics: "alpha_zero_edit",
        method: "source_pixels_copy",
        nativeSize: { width: 32, height: 32 },
        normalization: "none",
        nativeDigest: input.decision.source.sha256,
        compositeDigest: "3".repeat(64),
        outsidePixels: 960,
        mappedOutsideChangedPixels: 0,
        nativeOutsideChangedPixels: 0,
        compositeOutsideChangedPixels: 0,
    };
    return {
        ...input,
        originalProof: proof,
        decision: {
            ...input.decision,
            delivery: {
                baseline: { ...input.remotePlan.source, sha256: proof.compositeDigest },
                contract: {
                    version: "ecommerce-delivery.v2",
                    scope: "local_edit",
                    baseline: { url: "/api/reference-assets/fixture-scene.png", sha256: proof.sourceDigest, byteLength: 100, width: 32, height: 32, normalizedSha256: "4".repeat(64) },
                    protection: { version: "scene-enhancement.v1", normalization: "srgb-upright-v1", scene: { ...proof, mask: { id: "fixture-mask", dataUrl: "", serverUrl: "/api/reference-assets/fixture-mask.png", width: 32, height: 32 } } },
                },
            },
        },
    } satisfies EnhancementPublicationBindingInput;
}

describe("enhancement immutable publication binding", () => {
    it("keeps ownership epochs and event clocks outside business identity", () => {
        const input = fixture();
        const owned = { ...input, workerId: "fixture-owner-a", leaseToken: "fixture-lease-a", leaseUntil: 100, updatedAt: 1 };
        const successor = { ...input, workerId: "fixture-owner-b", leaseToken: "fixture-lease-b", leaseUntil: 200, updatedAt: 2 };
        const first = createEnhancementPublicationBinding(owned);
        const next = createEnhancementPublicationBinding(successor);
        expect(next.bindingDigest).toBe(first.bindingDigest);
        expect(first).not.toHaveProperty("workerId");
        expect(first).not.toHaveProperty("leaseToken");
        expect(first).not.toHaveProperty("leaseUntil");
        expect(first).not.toHaveProperty("updatedAt");
    });

    it("is stable when database object field order changes", () => {
        const input = fixture();
        const engine = input.remotePlan.engine;
        const reordered = {
            ...input,
            remotePlan: {
                ...input.remotePlan,
                engine: {
                    gpuId: engine.gpuId,
                    tta: engine.tta,
                    tile: engine.tile,
                    nativeScale: engine.nativeScale,
                    modelSha256: engine.modelSha256,
                    modelVersion: engine.modelVersion,
                    binarySha256: engine.binarySha256,
                    binaryVersion: engine.binaryVersion,
                    modelId: engine.modelId,
                },
            },
        };
        expect(createEnhancementPublicationBinding(reordered).bindingDigest).toBe(createEnhancementPublicationBinding(input).bindingDigest);
    });

    const changes: Array<{ name: string; change: (input: EnhancementPublicationBindingInput) => EnhancementPublicationBindingInput }> = [
        { name: "remote attempt", change: (input) => ({ ...input, attempt: 2, remoteKey: "fixture-enhancement:2" }) },
        { name: "remote job", change: (input) => ({ ...input, remoteJobId: "another-remote" }) },
        { name: "remote receipt", change: (input) => ({ ...input, receiptId: "another-receipt" }) },
        { name: "submitted native digest", change: (input) => ({ ...input, remotePlan: { ...input.remotePlan, sourceSha256: "0".repeat(64) } }) },
        { name: "observed AI digest", change: (input) => ({ ...input, remoteResult: { ...input.remoteResult, sha256: "0".repeat(64) } }) },
        { name: "engine TTA", change: (input) => ({ ...input, remotePlan: { ...input.remotePlan, engine: { ...input.remotePlan.engine, tta: true } } }) },
        { name: "local target", change: (input) => ({ ...input, decision: { ...input.decision, target: { width: 63, height: 64 } } }) },
        { name: "frozen delivery budget", change: (input) => ({ ...input, remotePlan: { ...input.remotePlan, budgets: { ...input.remotePlan.budgets, delivery: { maxBytes: 999_999, maxPixels: 1_000_000 } } } }) },
    ];
    it.each(changes)("invalidates a receipt after $name changes", ({ change }) => {
        const input = fixture();
        expect(createEnhancementPublicationBinding(change(input)).bindingDigest).not.toBe(createEnhancementPublicationBinding(input).bindingDigest);
    });

    it("preserves ordered product regions instead of treating a reordered snapshot as the same input", () => {
        const input = productFixture();
        const delivery = input.decision.delivery;
        const contract = delivery.contract;
        const protection = contract.protection;
        const changed = {
            ...input,
            decision: {
                ...input.decision,
                delivery: {
                    ...delivery,
                    contract: {
                        ...contract,
                        protection: {
                            ...protection,
                            product: {
                                ...protection.product,
                                productCore: [
                                    { x: 4, y: 0, width: 4, height: 8 },
                                    { x: 0, y: 0, width: 4, height: 8 },
                                ],
                            },
                        },
                    },
                },
            },
        };
        expect(createEnhancementPublicationBinding(changed).bindingDigest).not.toBe(createEnhancementPublicationBinding(input).bindingDigest);
    });

    it("retains the original product composition proof in the binding", () => {
        const input = productFixture();
        const changed = { ...input, originalProof: { ...input.originalProof, protectedPixels: 511 } };
        expect(createEnhancementPublicationBinding(changed).bindingDigest).not.toBe(createEnhancementPublicationBinding(input).bindingDigest);
    });

    it("retains scene confirmation and mapping while omitting only transport proof URL aliases", () => {
        const input = sceneFixture();
        const aliased = {
            ...input,
            originalProof: { ...input.originalProof, maskUrl: "/api/reference-assets/transport-mask.png", nativeUrl: "/api/generation-log-assets/transport-native.png", compositeUrl: "/api/generation-log-assets/transport-final.png" },
        };
        const changed = { ...input, originalProof: { ...input.originalProof, confirmation: { actorUserId: "another-fixture-owner", confirmedAt: 1 } } };
        expect(createEnhancementPublicationBinding(aliased).bindingDigest).toBe(createEnhancementPublicationBinding(input).bindingDigest);
        expect(createEnhancementPublicationBinding(changed).bindingDigest).not.toBe(createEnhancementPublicationBinding(input).bindingDigest);
    });
});
