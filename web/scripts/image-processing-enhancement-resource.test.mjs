import { describe, expect, it } from "vitest";
import { decideImageProcessingAdmission, estimateImageProcessingMemory } from "../.image-processing-runtime/lib/image-processing/resource-model.js";

const hash = "a".repeat(64);
const budget = { maxBytes: 1_000_000, maxPixels: 1_000_000 };
const ai = { width: 128, height: 128, format: "png", sha256: hash, byteLength: 1000 };
const source = { width: 32, height: 32, format: "png", sha256: hash, byteLength: 1000 };
const product = {
    version: "product-enhancement.v2",
    normalization: "srgb-upright-v1",
    maskSha256: hash,
    product: {
        compilerVersion: "strict-product.v1",
        state: "ready",
        productAnchorId: "source",
        sourceAssetId: "source",
        sourceSize: { width: 32, height: 32 },
        productCore: [{ x: 0, y: 0, width: 1, height: 1 }],
        fusionHalo: [],
        editableBackground: [{ x: 1, y: 0, width: 31, height: 32 }],
    },
};
const scene = {
    version: "scene-enhancement.v1",
    normalization: "srgb-upright-v1",
    scene: {
        version: "scene-edit-protection.v1",
        sourceAssetId: "source",
        sourceSize: { width: 32, height: 32 },
        sourceDigest: hash,
        maskSize: { width: 32, height: 32 },
        maskDigest: hash,
        targetRegion: { x: 0, y: 0, width: 1, height: 1 },
        semantics: ["replace selection"],
        selectionSource: "user_selection",
        maskSemantics: "alpha_zero_edit",
        method: "source_pixels_copy",
    },
};

function fixture(scope, stageFormat, sourceFormat = "png") {
    const staged = stageFormat !== undefined;
    const roles = [...(scope === "full_image" ? ["ai"] : ["ai", "source", "native", "baseline", "mask"]), ...(staged ? ["staged"] : [])];
    const inputs = roles.map((assetId) => ({ assetId, assetVersion: assetId + "-v1", expectedSha256: hash }));
    const native = { ...source, format: sourceFormat };
    const original = { ...native, normalizedSha256: hash };
    const stage = { ...source, width: scope === "full_image" ? 64 : 32, height: scope === "full_image" ? 64 : 32, format: stageFormat };
    const common = {
        scope,
        bindingDigest: hash,
        resultId: "result:1",
        resultIndex: 1,
        aiInputIndex: 0,
        engineInput: { width: 32, height: 32 },
        expectedAi: ai,
        targetSize: { width: 64, height: 64 },
        budgets: { input: budget, ai: budget, delivery: budget },
    };
    const options =
        scope === "full_image"
            ? { ...common, ...(staged ? { stagedDelivered: { inputIndex: 1, expected: stage } } : {}) }
            : {
                  ...common,
                  targetSize: { width: 32, height: 32 },
                  sourceInputIndex: 1,
                  nativeInputIndex: 2,
                  baselineInputIndex: 3,
                  maskInputIndex: 4,
                  source: original,
                  native,
                  baseline: source,
                  protection: scope === "product_background" ? product : scene,
                  originalProof:
                      scope === "product_background"
                          ? {
                                version: "product-enhancement.v2",
                                normalization: "srgb-upright-v1",
                                productAnchorId: "source",
                                sourceAssetId: "source",
                                sourceSha256: hash,
                                maskSha256: hash,
                                aiSha256: hash,
                                compositeSha256: hash,
                                sourceSize: { width: 32, height: 32 },
                                aiSize: { width: 32, height: 32 },
                                allowedPixels: 1023,
                                protectedPixels: 1,
                                protectedChangedPixels: 0,
                            }
                          : {
                                ...scene.scene,
                                nativeSize: { width: 32, height: 32 },
                                normalization: "none",
                                nativeDigest: hash,
                                compositeDigest: hash,
                                outsidePixels: 1023,
                                mappedOutsideChangedPixels: 0,
                                nativeOutsideChangedPixels: 0,
                                compositeOutsideChangedPixels: 0,
                            },
                  ...(staged ? { stagedDelivered: { inputIndex: 5, expected: stage } } : {}),
              };
    const artifacts = { ai, source: original, native, baseline: source, mask: source, staged: stage };
    const facts = {
        encodedInputs: inputs.map((input, inputIndex) => {
            const artifact = artifacts[roles[inputIndex]];
            return { inputIndex, assetId: input.assetId, assetVersion: input.assetVersion, sha256: hash, bytes: artifact.byteLength, layout: { format: artifact.format, depth: "uchar", channels: artifact.format === "jpeg" ? 3 : 4 } };
        }),
        decodedInputs: inputs.map((input, inputIndex) => {
            const artifact = artifacts[roles[inputIndex]];
            return { inputIndex, assetId: input.assetId, assetVersion: input.assetVersion, sha256: hash, width: artifact.width, height: artifact.height };
        }),
    };
    return { request: { operation: "process_enhancement", options, inputs }, facts };
}

describe("independently calibrated enhancement resource admission", () => {
    it.each([
        { label: "global RGB fresh", scope: "full_image", aiChannels: 3, profile: "enhancement_global_jpeg", requiredMemoryBytes: 1610612736 },
        { label: "global JPEG stage", scope: "full_image", stageFormat: "jpeg", profile: "enhancement_global_jpeg", requiredMemoryBytes: 1610612736 },
        { label: "legacy PNG stage", scope: "full_image", stageFormat: "png", profile: "enhancement_legacy_png", requiredMemoryBytes: 1342177280 },
        { label: "product JPEG fresh", scope: "product_background", sourceFormat: "jpeg", profile: "enhancement_product", requiredMemoryBytes: 1342177280 },
        { label: "product PNG stage", scope: "product_background", stageFormat: "png", profile: "enhancement_product", requiredMemoryBytes: 1342177280 },
        { label: "scene JPEG fresh", scope: "local_edit", sourceFormat: "jpeg", profile: "enhancement_scene", requiredMemoryBytes: 1342177280 },
        { label: "scene PNG stage", scope: "local_edit", stageFormat: "png", profile: "enhancement_scene", requiredMemoryBytes: 1342177280 },
    ])("admits $label at its independently measured reserve", ({ scope, stageFormat, sourceFormat, aiChannels = 4, profile, requiredMemoryBytes }) => {
        const { request, facts } = fixture(scope, stageFormat, sourceFormat);
        facts.encodedInputs[0].layout.channels = aiChannels;
        const estimate = estimateImageProcessingMemory(request, facts);
        expect({ profile: estimate.profile, admission: decideImageProcessingAdmission(estimate, { totalMemoryBytes: 3 * 1024 ** 3, availableMemoryBytes: requiredMemoryBytes, availableSlots: 1 }) }).toEqual({
            profile,
            admission: { status: "admit", requiredMemoryBytes },
        });
    });

    it("keeps an unmeasured 16bit PNG AI unavailable", () => {
        const { request, facts } = fixture("full_image");
        facts.encodedInputs[0].layout.depth = "ushort";
        const estimate = estimateImageProcessingMemory(request, facts);
        expect(decideImageProcessingAdmission(estimate, { totalMemoryBytes: 3 * 1024 ** 3, availableMemoryBytes: 3 * 1024 ** 3, availableSlots: 1 })).toEqual({
            status: "unavailable",
            code: "image_processing_resource_unavailable",
            reason: "profile_uncalibrated",
        });
    });
});
