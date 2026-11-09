import { describe, expect, it } from "vitest";

import { imageProcessingResourceConfig } from "../.image-processing-runtime/lib/image-processing/resource-config.js";
import { decideImageProcessingAdmission, estimateImageProcessingMemory } from "../.image-processing-runtime/lib/image-processing/resource-model.js";

const MiB = 1024 * 1024;
const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const identity = { inputIndex: 0, assetId: "source", assetVersion: "source-v1", sha256: hash };
const encoded = { ...identity, bytes: 886137, layout: { format: "png", depth: "uchar", channels: 4 } };
const decoded = { ...identity, width: 1000, height: 1000 };
const free = { totalMemoryBytes: 2048 * MiB, availableMemoryBytes: 2048 * MiB, availableSlots: 1 };
const local = { mode: "local_edit", targetRegion: { x: 0, y: 0, width: 0.5, height: 0.5 }, protectedRectangles: [] };
const selection = { mode: "scene_selection", region: { x: 1, y: 1, width: 1, height: 1 }, semantics: ["replace selection"], selectionSource: "user_selection" };
const protectedResults = [{ resultId: "result:1", resultIndex: 1, inputIndex: 2 }];
const protectedInputs = [
    { path: "/controlled/mask", assetId: "mask", assetVersion: "mask-v1", expectedSha256: otherHash },
    { path: "/controlled/native", assetId: "native", assetVersion: "native-v1", expectedSha256: hash },
];
const sceneProtection = {
    version: "scene-edit-protection.v1",
    sourceAssetId: "source",
    sourceSize: { width: 2, height: 2 },
    sourceDigest: hash,
    maskSize: { width: 2, height: 2 },
    maskDigest: otherHash,
    targetRegion: { x: 0, y: 0, width: 1, height: 1 },
    semantics: ["replace selection"],
    selectionSource: "user_selection",
    maskSemantics: "alpha_zero_edit",
    method: "source_pixels_copy",
};
const productProtection = {
    version: "product-enhancement.v2",
    normalization: "srgb-upright-v1",
    maskSha256: otherHash,
    product: {
        compilerVersion: "strict-product.v1",
        state: "ready",
        productAnchorId: "source",
        sourceAssetId: "source",
        sourceSize: { width: 2, height: 2 },
        productCore: [{ x: 0, y: 0, width: 1, height: 1 }],
        fusionHalo: [],
        editableBackground: [{ x: 1, y: 0, width: 1, height: 2 }],
    },
};
const baseline = { width: 2, height: 2, sha256: hash, byteLength: 84, normalizedSha256: otherHash };
const size64 = { width: 8000, height: 8000 };
const source64 = { ...decoded, ...size64 };
const native64 = { inputIndex: 2, assetId: "native", assetVersion: "native-v1", sha256: hash, ...size64 };
const protectedEncoded = [
    { ...encoded, bytes: 8348936, layout: { format: "jpeg", depth: "uchar", channels: 3 } },
    { inputIndex: 1, assetId: "mask", assetVersion: "mask-v1", sha256: otherHash, bytes: 263882, layout: { format: "png", depth: "uchar", channels: 4 } },
    { inputIndex: 2, assetId: "native", assetVersion: "native-v1", sha256: hash, bytes: 8348936, layout: { format: "jpeg", depth: "uchar", channels: 3 } },
];
const sceneTask = request(
    "process_result",
    {
        mode: "scene_protection",
        results: protectedResults,
        sourceInputIndex: 0,
        maskInputIndex: 1,
        protection: { ...sceneProtection, sourceSize: size64, maskSize: size64 },
        baseline: { ...baseline, ...size64, byteLength: 8348936 },
    },
    {},
    protectedInputs,
);
const productTask = request(
    "process_result",
    {
        mode: "product_protection",
        results: protectedResults,
        sourceInputIndex: 0,
        maskInputIndex: 1,
        protection: { ...productProtection, product: { ...productProtection.product, sourceSize: size64 } },
        baseline: { ...baseline, ...size64, byteLength: 8348936 },
    },
    {},
    protectedInputs,
);

function request(operation, options, input = {}, additionalInputs = []) {
    return {
        version: "image-processing.v1",
        jobId: "resource-job",
        executionId: "resource-execution",
        operation,
        options,
        inputs: [{ path: "/controlled/source", assetId: "source", assetVersion: "source-v1", expectedSha256: hash, ...input }, ...additionalInputs],
        outputDirectory: "/controlled/output",
    };
}

function facts(decodedInputs = [], encodedInputs = [encoded]) {
    return { decodedInputs, encodedInputs };
}

function calibrated(profile, requiredMemoryBytes) {
    return { modelVersion: "image-processing-memory.s8.v1", profile, status: "calibrated", requiredMemoryBytes };
}

function uncalibrated(profile) {
    return { modelVersion: "image-processing-memory.s8.v1", profile, status: "uncalibrated" };
}

const sourceLayoutBudgets = [
    { label: "RGBA8 PNG", layout: { format: "png", depth: "uchar", channels: 4 }, requiredMemoryBytes: 424673280 },
    { label: "RGB8 JPEG", layout: { format: "jpeg", depth: "uchar", channels: 3 }, requiredMemoryBytes: 424673280 },
    { label: "RGBA16 PNG", layout: { format: "png", depth: "ushort", channels: 4 }, requiredMemoryBytes: 680525824 },
    { label: "RGB float TIFF", layout: { format: "tiff", depth: "float", channels: 3 }, requiredMemoryBytes: 936378368 },
];

describe("hash-bound source layout budgets", () => {
    it.each(sourceLayoutBudgets)("reserves the independent 64MP prepare workspace for $label despite a smaller complete checkpoint", ({ layout, requiredMemoryBytes }) => {
        expect(estimateImageProcessingMemory(request("prepare_reference", {}), facts([decoded], [{ ...encoded, layout }]))).toEqual(calibrated("prepare_reference", requiredMemoryBytes));
    });

    it("never treats the former layout-free 405MiB candidate as calibrated", () => {
        const estimate = estimateImageProcessingMemory(request("prepare_reference", {}), facts([], []));
        expect(estimate).toEqual(uncalibrated("prepare_reference"));
        expect(decideImageProcessingAdmission(estimate, free)).toEqual({ status: "unavailable", code: "image_processing_resource_unavailable", reason: "profile_uncalibrated" });
    });

    it.each([
        { label: "missing header layout", inputs: [{ ...identity, bytes: 886137 }] },
        { label: "unestablished double TIFF layout", inputs: [{ ...encoded, layout: { format: "tiff", depth: "double", channels: 3 } }] },
    ])("does not borrow an 8bit budget for $label", ({ inputs }) => {
        expect(estimateImageProcessingMemory(request("prepare_reference", {}), facts([], inputs))).toEqual(uncalibrated("prepare_reference"));
    });

    it.each([
        { label: "asset", fact: { ...encoded, assetId: "other" }, input: {} },
        { label: "version", fact: { ...encoded, assetVersion: "source-v2" }, input: {} },
        { label: "hash", fact: { ...encoded, sha256: otherHash }, input: {} },
        { label: "index", fact: { ...encoded, inputIndex: 1 }, input: {} },
        { label: "unfrozen input", fact: encoded, input: { expectedSha256: undefined } },
    ])("does not price layout/bytes bound to a mismatched $label", ({ fact, input }) => {
        const estimate = estimateImageProcessingMemory(request("prepare_reference", {}, input), facts([], [fact]));
        expect(estimate).toEqual(uncalibrated("prepare_reference"));
        expect(decideImageProcessingAdmission(estimate, free).status).toBe("unavailable");
    });
});

describe("generation reference admission", () => {
    it.each([
        { label: "64MP PNG", layout: { format: "png", depth: "uchar", channels: 4 }, expected: calibrated("generation_reference", 979369984) },
        { label: "64MP JPEG", layout: { format: "jpeg", depth: "uchar", channels: 3 }, expected: calibrated("generation_reference", 979369984) },
        { label: "uncalibrated 16bit PNG", layout: { format: "png", depth: "ushort", channels: 4 }, expected: uncalibrated("generation_reference") },
    ])("accounts for generation output instead of borrowing the analysis reserve for $label", ({ layout, expected }) => {
        expect(estimateImageProcessingMemory(request("prepare_reference", { generationInput: { bounds: { width: 8000, height: 8000 }, quality: "high" } }), facts([source64], [{ ...encoded, layout }]))).toEqual(expected);
    });
});

describe("WebP source admission", () => {
    it.each([
        { label: "RGB analysis", channels: 3, operation: "prepare_reference", options: {}, profile: "prepare_reference", checkpoints: [], requiredMemoryBytes: 680525824 },
        { label: "RGBA analysis", channels: 4, operation: "prepare_reference", options: {}, profile: "prepare_reference", checkpoints: [], requiredMemoryBytes: 680525824 },
        { label: "RGB full review", channels: 3, operation: "prepare_review", options: {}, profile: "prepare_review", checkpoints: [decoded], requiredMemoryBytes: 1073741824 },
        { label: "RGBA full review", channels: 4, operation: "prepare_review", options: {}, profile: "prepare_review", checkpoints: [decoded], requiredMemoryBytes: 1073741824 },
        { label: "RGB crop review", channels: 3, operation: "prepare_review", options: { region: { x: 1, y: 1, width: 999, height: 999 } }, profile: "prepare_review", checkpoints: [decoded], requiredMemoryBytes: 1073741824 },
        { label: "RGBA crop review", channels: 4, operation: "prepare_review", options: { region: { x: 1, y: 1, width: 999, height: 999 } }, profile: "prepare_review", checkpoints: [decoded], requiredMemoryBytes: 1073741824 },
        {
            label: "RGB generation reference",
            channels: 3,
            operation: "prepare_reference",
            options: { generationInput: { bounds: { width: 8000, height: 8000 }, quality: "high" } },
            profile: "generation_reference",
            checkpoints: [],
            requiredMemoryBytes: 979369984,
        },
        {
            label: "RGBA generation reference",
            channels: 4,
            operation: "prepare_reference",
            options: { generationInput: { bounds: { width: 8000, height: 8000 }, quality: "high" } },
            profile: "generation_reference",
            checkpoints: [],
            requiredMemoryBytes: 979369984,
        },
        { label: "RGB white protection", channels: 3, operation: "build_protection", options: { transparentBackground: false }, profile: "white_protection", checkpoints: [], requiredMemoryBytes: 979369984 },
        { label: "RGBA white protection", channels: 4, operation: "build_protection", options: { transparentBackground: true }, profile: "white_protection", checkpoints: [], requiredMemoryBytes: 979369984 },
        { label: "RGB local protection", channels: 3, operation: "build_protection", options: local, profile: "local_protection", checkpoints: [], requiredMemoryBytes: 915406848 },
        { label: "RGBA local protection", channels: 4, operation: "build_protection", options: local, profile: "local_protection", checkpoints: [], requiredMemoryBytes: 915406848 },
        { label: "RGB scene selection", channels: 3, operation: "build_protection", options: selection, profile: "scene_selection", checkpoints: [], requiredMemoryBytes: 915406848 },
        { label: "RGBA scene selection", channels: 4, operation: "build_protection", options: selection, profile: "scene_selection", checkpoints: [], requiredMemoryBytes: 915406848 },
        { label: "RGB white protection with a complete checkpoint", channels: 3, operation: "build_protection", options: { transparentBackground: false }, profile: "white_protection", checkpoints: [decoded], requiredMemoryBytes: 160432128 },
        { label: "RGBA white protection with a complete checkpoint", channels: 4, operation: "build_protection", options: { transparentBackground: true }, profile: "white_protection", checkpoints: [decoded], requiredMemoryBytes: 160432128 },
    ])("prices $label within its source role", ({ channels, operation, options, profile, checkpoints, requiredMemoryBytes }) => {
        expect(estimateImageProcessingMemory(request(operation, options), facts(checkpoints, [{ ...encoded, layout: { format: "webp", depth: "uchar", channels } }]))).toEqual(calibrated(profile, requiredMemoryBytes));
    });

    it.each([3, 4])("prices a %i-channel WebP scene source with its complete 64MP checkpoint", (channels) => {
        const encodedInputs = [{ ...protectedEncoded[0], layout: { format: "webp", depth: "uchar", channels } }, protectedEncoded[1], protectedEncoded[2]];
        expect(estimateImageProcessingMemory(sceneTask, facts([source64, native64], encodedInputs))).toEqual(calibrated("scene_result", 1422917632));
    });

    it.each([3, 4])("keeps an unmeasured %i-channel WebP provider result unavailable", (channels) => {
        const task = request("process_result", { mode: "ordinary", results: [{ resultId: "result:1", resultIndex: 1, inputIndex: 0 }], transparentBackground: false });
        const estimate = estimateImageProcessingMemory(task, facts([], [{ ...encoded, layout: { format: "webp", depth: "uchar", channels } }]));
        expect(estimate).toEqual(uncalibrated("ordinary_result"));
        expect(decideImageProcessingAdmission(estimate, free)).toEqual({ status: "unavailable", code: "image_processing_resource_unavailable", reason: "profile_uncalibrated" });
    });
});

describe("prepare_review admission budgets", () => {
    const capacity = { totalMemoryBytes: 1073741824, availableMemoryBytes: 1073741824, availableSlots: 1 };

    it.each([...sourceLayoutBudgets.map(({ label, layout }) => [label, layout]), ["RGB8 PNG", { format: "png", depth: "uchar", channels: 3 }]])(
        "admits full and crop %s at the fixed 1GiB boundary despite a smaller decoded checkpoint",
        (_label, layout) => {
            const sourceFacts = facts([decoded], [{ ...encoded, layout }]);
            const full = estimateImageProcessingMemory(request("prepare_review", {}), sourceFacts);
            const crop = estimateImageProcessingMemory(request("prepare_review", { region: { x: 1, y: 1, width: 999, height: 999 } }), sourceFacts);
            expect(decideImageProcessingAdmission(full, capacity)).toEqual({ status: "admit", requiredMemoryBytes: 1073741824 });
            expect(decideImageProcessingAdmission(crop, capacity)).toEqual({ status: "admit", requiredMemoryBytes: 1073741824 });
        },
    );

    it("keeps review pending when another task leaves less than the fixed reserve available", () => {
        const estimate = estimateImageProcessingMemory(request("prepare_review", {}), facts([decoded]));
        expect(decideImageProcessingAdmission(estimate, { ...capacity, availableMemoryBytes: 1073741823 })).toEqual({ status: "pending", requiredMemoryBytes: 1073741824 });
    });

    it("reports a review reserve above the total budget before temporary capacity", () => {
        const estimate = estimateImageProcessingMemory(request("prepare_review", {}), facts([decoded]));
        expect(decideImageProcessingAdmission(estimate, { totalMemoryBytes: 1073741823, availableMemoryBytes: 0, availableSlots: 0 })).toEqual({
            status: "unavailable",
            code: "image_processing_resource_unavailable",
            reason: "exceeds_total_budget",
            requiredMemoryBytes: 1073741824,
        });
    });

    it.each([
        ["unmeasured double TIFF layout", { ...encoded, layout: { format: "tiff", depth: "double", channels: 3 } }],
        ["mismatched source hash", { ...encoded, sha256: otherHash }],
    ])("keeps %s review uncalibrated", (_label, input) => {
        const estimate = estimateImageProcessingMemory(request("prepare_review", {}), facts([decoded], [input]));
        expect(decideImageProcessingAdmission(estimate, free)).toEqual({ status: "unavailable", code: "image_processing_resource_unavailable", reason: "profile_uncalibrated" });
    });
});

describe("independent build workspaces", () => {
    it.each([
        { profile: "white_protection", options: { transparentBackground: false }, requiredMemoryBytes: 979369984 },
        { profile: "local_protection", options: local, requiredMemoryBytes: 915406848 },
        { profile: "scene_selection", options: selection, requiredMemoryBytes: 915406848 },
        { profile: "white_protection_qualified", options: { transparentBackground: false, freezeEnhancementBaseline: true }, requiredMemoryBytes: 2003828736 },
        { profile: "local_protection_qualified", options: { ...local, freezeEnhancementBaseline: { productAnchorId: "source", productCore: [{ x: 1, y: 1, width: 1, height: 1 }] } }, requiredMemoryBytes: 2003828736 },
        { profile: "scene_selection_qualified", options: { ...selection, freezeEnhancementBaseline: true }, requiredMemoryBytes: 1427111936 },
    ])("prices $profile including its own encoded/raw workspaces", ({ profile, options, requiredMemoryBytes }) => {
        expect(estimateImageProcessingMemory(request("build_protection", options), facts())).toEqual(calibrated(profile, requiredMemoryBytes));
    });

    it("lowers only a later source budget using a completely matching decoded checkpoint", () => {
        expect(estimateImageProcessingMemory(request("build_protection", { transparentBackground: false }), facts([decoded]))).toEqual(calibrated("white_protection", 160432128));
    });

    it.each([
        { label: "asset", checkpoint: { ...decoded, assetId: "other" } },
        { label: "version", checkpoint: { ...decoded, assetVersion: "source-v2" } },
        { label: "hash", checkpoint: { ...decoded, sha256: otherHash } },
        { label: "index", checkpoint: { ...decoded, inputIndex: 1 } },
    ])("keeps 64MP when only the decoded checkpoint $label mismatches", ({ checkpoint }) => {
        expect(estimateImageProcessingMemory(request("build_protection", { transparentBackground: false }), facts([checkpoint]))).toEqual(calibrated("white_protection", 979369984));
    });

    it("reports full 64MP product qualification demand above a 1536MiB total instead of waiting", () => {
        const estimate = estimateImageProcessingMemory(request("build_protection", { transparentBackground: false, freezeEnhancementBaseline: true }), facts());
        expect(decideImageProcessingAdmission(estimate, { totalMemoryBytes: 1536 * MiB, availableMemoryBytes: 0, availableSlots: 0 })).toEqual({
            status: "unavailable",
            code: "image_processing_resource_unavailable",
            reason: "exceeds_total_budget",
            requiredMemoryBytes: 2003828736,
        });
    });
});

describe("result operations missing their own facts", () => {
    it.each([
        { profile: "ordinary_result", task: request("process_result", { mode: "ordinary", results: [{ resultId: "result:1", resultIndex: 1, inputIndex: 0 }], transparentBackground: false }) },
        { profile: "ordinary_transparent_result", task: request("process_result", { mode: "ordinary", results: [{ resultId: "result:1", resultIndex: 1, inputIndex: 0 }], transparentBackground: true }) },
        { profile: "scene_result", task: request("process_result", { mode: "scene_protection", results: protectedResults, sourceInputIndex: 0, maskInputIndex: 1, protection: sceneProtection }, {}, protectedInputs) },
        { profile: "product_result", task: request("process_result", { mode: "product_protection", results: protectedResults, sourceInputIndex: 0, maskInputIndex: 1, protection: productProtection, baseline }, {}, protectedInputs) },
        {
            profile: "layers_result",
            task: request(
                "process_result",
                {
                    mode: "layers",
                    results: [
                        { resultId: "result:1", resultIndex: 1, inputIndex: 1 },
                        { resultId: "result:2", resultIndex: 2, inputIndex: 2 },
                    ],
                    sourceInputIndex: 0,
                },
                {},
                protectedInputs,
            ),
        },
    ])("does not claim $profile without its actual encoded facts", ({ profile, task }) => {
        const estimate = estimateImageProcessingMemory(task, facts([decoded], []));
        expect(estimate).toEqual(uncalibrated(profile));
        expect(decideImageProcessingAdmission(estimate, free)).toEqual({ status: "unavailable", code: "image_processing_resource_unavailable", reason: "profile_uncalibrated" });
    });
});

describe("measured result workspaces", () => {
    it.each([
        { profile: "ordinary_result", transparentBackground: false, bytes: 73914625, requiredMemoryBytes: 520093696 },
        { profile: "ordinary_transparent_result", transparentBackground: true, bytes: 55600984, requiredMemoryBytes: 661651456 },
    ])("prices $profile using actual encoded bytes and its independent 40MP workspace", ({ profile, transparentBackground, bytes, requiredMemoryBytes }) => {
        const task = request("process_result", { mode: "ordinary", results: [{ resultId: "result:1", resultIndex: 1, inputIndex: 0 }], targetSize: { width: 7999, height: 4999 }, transparentBackground });
        expect(estimateImageProcessingMemory(task, facts([], [{ ...encoded, bytes }]))).toEqual(calibrated(profile, requiredMemoryBytes));
    });

    it("retains per-slot encoded inputs and outputs while decoding only one ordinary slot at a time", () => {
        const task = request(
            "process_result",
            {
                mode: "ordinary",
                results: [
                    { resultId: "result:1", resultIndex: 1, inputIndex: 0 },
                    { resultId: "result:2", resultIndex: 2, inputIndex: 1 },
                ],
                targetSize: { width: 7999, height: 4999 },
                transparentBackground: false,
            },
            {},
            [protectedInputs[1]],
        );
        const encodedInputs = [
            { ...encoded, bytes: 73914625 },
            { inputIndex: 1, assetId: "native", assetVersion: "native-v1", sha256: hash, bytes: 73914625, layout: encoded.layout },
        ];
        expect(estimateImageProcessingMemory(task, facts([], encodedInputs))).toEqual(calibrated("ordinary_result", 753926144));
    });

    it.each([
        { profile: "scene_result", task: sceneTask, requiredMemoryBytes: 1422917632 },
        { profile: "product_result", task: productTask, requiredMemoryBytes: 1486880768 },
    ])("prices $profile from the measured single active raw stage and actual encoded bytes", ({ profile, task, requiredMemoryBytes }) => {
        expect(estimateImageProcessingMemory(task, facts([source64, native64], protectedEncoded))).toEqual(calibrated(profile, requiredMemoryBytes));
    });

    it("reserves the full Sharp native boundary when only the scene source has a complete checkpoint", () => {
        const estimate = estimateImageProcessingMemory(sceneTask, facts([source64], protectedEncoded));
        expect(estimate).toEqual(calibrated("scene_result", 3058696192));
        expect(decideImageProcessingAdmission(estimate, { totalMemoryBytes: 1536 * MiB, availableMemoryBytes: 1536 * MiB, availableSlots: 1 })).toEqual({
            status: "unavailable",
            code: "image_processing_resource_unavailable",
            reason: "exceeds_total_budget",
            requiredMemoryBytes: 3058696192,
        });
    });

    it("does not use frozen protection dimensions as a completed source checkpoint", () => {
        expect(estimateImageProcessingMemory(sceneTask, facts([], protectedEncoded))).toEqual(calibrated("scene_result", 5511315456));
    });

    it("prices full-size valid layers using a complete source checkpoint and all actual encoded natives", () => {
        const task = request(
            "process_result",
            {
                mode: "layers",
                results: [
                    { resultId: "result:1", resultIndex: 1, inputIndex: 1 },
                    { resultId: "result:2", resultIndex: 2, inputIndex: 2 },
                ],
                sourceInputIndex: 0,
            },
            {},
            protectedInputs,
        );
        const encodedInputs = [
            { ...encoded, bytes: 8348936, layout: { format: "jpeg", depth: "uchar", channels: 3 } },
            { inputIndex: 1, assetId: "mask", assetVersion: "mask-v1", sha256: otherHash, bytes: 123341675, layout: { format: "png", depth: "uchar", channels: 4 } },
            { inputIndex: 2, assetId: "native", assetVersion: "native-v1", sha256: hash, bytes: 12108693, layout: { format: "png", depth: "uchar", channels: 4 } },
        ];
        expect(estimateImageProcessingMemory(task, facts([source64], encodedInputs))).toEqual(calibrated("layers_result", 1549795328));
    });

    it("reserves encoded bytes without raw work for a native whose actual metadata was rejected", () => {
        const task = request("process_result", { mode: "ordinary", results: [{ resultId: "result:1", resultIndex: 1, inputIndex: 0 }], transparentBackground: false });
        expect(estimateImageProcessingMemory(task, facts([], [{ ...identity, bytes: 12, metadataRejected: true }]))).toEqual(calibrated("ordinary_result", 126877696));
    });
});

describe("image budget admission", () => {
    it("admits a calibrated task at the exact remaining boundary", () => {
        expect(decideImageProcessingAdmission(calibrated("white_protection", 979369984), { ...free, availableMemoryBytes: 979369984 })).toEqual({ status: "admit", requiredMemoryBytes: 979369984 });
    });

    it.each([
        { label: "memory reserved by another task", capacity: { ...free, availableMemoryBytes: 979369983 } },
        { label: "occupied slot", capacity: { ...free, availableSlots: 0 } },
    ])("keeps a task pending for temporary $label", ({ capacity }) => {
        expect(decideImageProcessingAdmission(calibrated("white_protection", 979369984), capacity)).toEqual({ status: "pending", requiredMemoryBytes: 979369984 });
    });

    it("checks permanently oversized demand before temporary capacity", () => {
        expect(decideImageProcessingAdmission(calibrated("white_protection", 979369984), { totalMemoryBytes: 512 * MiB, availableMemoryBytes: 0, availableSlots: 0 })).toEqual({
            status: "unavailable",
            code: "image_processing_resource_unavailable",
            reason: "exceeds_total_budget",
            requiredMemoryBytes: 979369984,
        });
    });
});

it("rejects an explicitly configured zero Worker CPU quota", () => {
    expect(() =>
        imageProcessingResourceConfig({
            VOZEB_PRO_GENERATION_WORKER_MEMORY_MB: "1536",
            VOZEB_PRO_GENERATION_WORKER_HEAP_MB: "64",
            VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB: "1024",
            VOZEB_PRO_IMAGE_PROCESS_HEAP_MB: "384",
            VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY: "1",
            VOZEB_PRO_GENERATION_WORKER_CPUS: "0",
        }),
    ).toThrow(/VOZEB_PRO_GENERATION_WORKER_CPUS/);
});
