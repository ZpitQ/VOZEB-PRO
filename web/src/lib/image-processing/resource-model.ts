import type { ImageProcessingInput, ImageProcessingOperation, ImageProcessingSize } from "./contracts.ts";

export const IMAGE_PROCESSING_MEMORY_MODEL_VERSION = "image-processing-memory.s8.v1" as const;

export type ImageProcessingResourceRequest = ImageProcessingOperation & {
    inputs: readonly Pick<ImageProcessingInput, "assetId" | "assetVersion" | "expectedSha256">[];
};

type ImageProcessingResourceInputIdentity = {
    inputIndex: number;
    assetId: string;
    assetVersion: string;
    sha256: string;
};

export type EncodedImageProcessingInput = ImageProcessingResourceInputIdentity & { bytes: number } & ({ layout?: { format: string; depth: string; channels: number }; metadataRejected?: never } | { metadataRejected: true; layout?: never });

export type DecodedImageProcessingInput = ImageProcessingResourceInputIdentity & ImageProcessingSize;

export type ImageProcessingResourceFacts = {
    encodedInputs: readonly EncodedImageProcessingInput[];
    decodedInputs: readonly DecodedImageProcessingInput[];
};

export type ImageProcessingMemoryProfile =
    | "prepare_reference"
    | "generation_reference"
    | "prepare_review"
    | "white_protection"
    | "white_protection_qualified"
    | "local_protection"
    | "local_protection_qualified"
    | "scene_selection"
    | "scene_selection_qualified"
    | "ordinary_result"
    | "ordinary_transparent_result"
    | "scene_result"
    | "product_result"
    | "layers_result"
    | "enhancement_global_jpeg"
    | "enhancement_legacy_png"
    | "enhancement_product"
    | "enhancement_scene";

export type ImageProcessingMemoryEstimate = {
    modelVersion: typeof IMAGE_PROCESSING_MEMORY_MODEL_VERSION;
    profile: ImageProcessingMemoryProfile;
} & ({ status: "calibrated"; requiredMemoryBytes: number } | { status: "uncalibrated" });

export type ImageProcessingCapacity = {
    totalMemoryBytes: number;
    availableMemoryBytes: number;
    availableSlots: number;
};

export type ImageProcessingAdmission =
    | { status: "admit" | "pending"; requiredMemoryBytes: number }
    | { status: "unavailable"; code: "image_processing_resource_unavailable"; reason: "profile_uncalibrated" }
    | { status: "unavailable"; code: "image_processing_resource_unavailable"; reason: "exceeds_total_budget"; requiredMemoryBytes: number };

// Coefficients are measured Sharp 0.35.5 engineering reserves, not universal codec bounds.
const MiB = 1024 * 1024;
const REFERENCE_PIXELS = 64_000_000;
const ORDINARY_PIXELS = 40_000_000;
const NATIVE_PIXELS = 0x3fff ** 2;

export function estimateImageProcessingMemory(request: ImageProcessingResourceRequest, facts: ImageProcessingResourceFacts): ImageProcessingMemoryEstimate {
    const profile = operationProfile(request);
    const uncalibrated: ImageProcessingMemoryEstimate = { modelVersion: IMAGE_PROCESSING_MEMORY_MODEL_VERSION, profile, status: "uncalibrated" };
    const encoded = request.inputs.map((input, inputIndex) => facts.encodedInputs.find((fact) => sameIdentity(input, inputIndex, fact)));
    if (!encoded.every((input) => input !== undefined)) return uncalibrated;
    if (request.operation === "process_enhancement") {
        const options = request.options;
        const staged = options.stagedDelivered;
        const roles = [options.aiInputIndex, ...(staged ? [staged.inputIndex] : []), ...(options.scope === "full_image" ? [] : [options.sourceInputIndex, options.nativeInputIndex, options.baselineInputIndex, options.maskInputIndex])];
        if (roles.length !== encoded.length || new Set(roles).size !== encoded.length) return uncalibrated;
        const coveredInput = (inputIndex: number, maxBytes: number, format: "png" | "jpeg" | undefined) => {
            const input = encoded[inputIndex];
            if (!input) return undefined;
            const layout = input.layout;
            if (!layout || nativeCoefficient(input) !== 4 || (format !== undefined && layout.format !== format)) return undefined;
            if (layout.format === "png" ? layout.channels !== 3 && layout.channels !== 4 : layout.format !== "jpeg" || layout.channels !== 3) return undefined;
            const decoded = facts.decodedInputs.find((fact) => sameIdentity(request.inputs[inputIndex], inputIndex, fact));
            return decoded && decoded.width * decoded.height <= ORDINARY_PIXELS && input.bytes <= maxBytes ? decoded : undefined;
        };
        const ai = coveredInput(options.aiInputIndex, 160 * MiB, "png");
        if (!ai || !sameSize(ai, options.expectedAi) || ai.width !== options.engineInput.width * 4 || ai.height !== options.engineInput.height * 4) return uncalibrated;
        const delivery = staged ? coveredInput(staged.inputIndex, 96 * MiB, staged.expected.format) : undefined;
        if (staged && (!delivery || !sameSize(delivery, staged.expected))) return uncalibrated;
        // Each reserve covers only its own measured producer path and the B0 encoded/pixel domain.
        if (options.scope === "full_image") {
            const fit = Math.min(options.targetSize.width / ai.width, options.targetSize.height / ai.height);
            if (fit > 1) return uncalibrated;
            const scale = Math.min(1, fit);
            if (delivery && (delivery.width !== Math.round(ai.width * scale) || delivery.height !== Math.round(ai.height * scale))) return uncalibrated;
            return calibrated(profile, (profile === "enhancement_legacy_png" ? 1280 : 1536) * MiB);
        }
        if (staged && staged.expected.format !== "png") return uncalibrated;
        const source = coveredInput(options.sourceInputIndex, 20 * MiB, undefined);
        const native = coveredInput(options.nativeInputIndex, 20 * MiB, options.native.format);
        const baseline = coveredInput(options.baselineInputIndex, 96 * MiB, "png");
        const mask = coveredInput(options.maskInputIndex, 20 * MiB, "png");
        if (!source || !native || !baseline || !mask || !sameSize(native, options.native)) return uncalibrated;
        const context = options.engineInput;
        if (![source, baseline, mask, options.source, options.baseline, options.targetSize].every((size) => sameSize(size, context)) || (delivery && !sameSize(delivery, context))) return uncalibrated;
        if (options.scope === "product_background") {
            if (!sameSize(native, context)) return uncalibrated;
        } else {
            // Scene native pixels are independent of context; its existing pixel-grid mapping must fit.
            const cross = BigInt(native.width) * BigInt(context.height) - BigInt(native.height) * BigInt(context.width);
            if (BigInt(2) * (cross < BigInt(0) ? -cross : cross) >= BigInt(context.width) + BigInt(context.height)) return uncalibrated;
        }
        return calibrated(profile, 1280 * MiB);
    }

    if (request.operation === "prepare_review") {
        const layout = encoded[0].layout;
        if (!layout) return uncalibrated;
        const measured =
            (layout.format === "png" && layout.depth === "uchar" && (layout.channels === 3 || layout.channels === 4)) ||
            (layout.format === "png" && layout.depth === "ushort" && layout.channels === 4) ||
            (layout.format === "jpeg" && layout.depth === "uchar" && layout.channels === 3) ||
            (layout.format === "tiff" && layout.depth === "float" && layout.channels === 3);
        // Measured 64MP full/crop review paths keep one reserve, independent of decoded checkpoints.
        return measured ? calibrated(profile, 1024 * MiB) : uncalibrated;
    }
    if (request.operation === "prepare_reference") {
        if (request.options.generationInput) {
            if (nativeCoefficient(encoded[0]) !== 4) return uncalibrated;
            return calibrated(profile, 140 * MiB + 13 * decodedPixels(request, facts, 0, REFERENCE_PIXELS));
        }
        const coefficient = nativeCoefficient(encoded[0]);
        if (coefficient === undefined) return uncalibrated;
        return calibrated(profile, 140 * MiB + coefficient * REFERENCE_PIXELS + 4 * MiB + 4 * 2048 ** 2);
    }
    if (request.operation === "build_protection") {
        if (nativeCoefficient(encoded[0]) !== 4) return uncalibrated;
        const options = request.options;
        let coefficient: number;
        if ("mode" in options) coefficient = options.mode === "scene_selection" ? (options.freezeEnhancementBaseline ? 20 : 12) : options.freezeEnhancementBaseline ? 29 : 12;
        else coefficient = options.freezeEnhancementBaseline ? 29 : 13;
        return calibrated(profile, 140 * MiB + coefficient * decodedPixels(request, facts, 0, REFERENCE_PIXELS));
    }

    const options = request.options;
    const natives = options.results.map((slot) => ({ inputIndex: slot.inputIndex, encoded: encoded[slot.inputIndex] }));
    if (natives.some((input) => !input.encoded.metadataRejected && nativeCoefficient(input.encoded) !== 4)) return uncalibrated;
    // Sequential slots retain encoded Buffers in the measured batch; raw work belongs to one active slot.
    const nativeBytes = natives.reduce((sum, input) => sum + input.encoded.bytes, 0);
    const readable = natives.filter((input) => !input.encoded.metadataRejected);
    if (options.mode === "ordinary") {
        const pixels = readable.map((input) => decodedPixels(request, facts, input.inputIndex, ORDINARY_PIXELS));
        const outputPixels = pixels.reduce((sum, count) => sum + count, 0);
        const activePixels = Math.max(0, ...pixels);
        return calibrated(profile, 120 * MiB + nativeBytes + 4 * outputPixels + (options.transparentBackground ? 8 : 4) * activePixels);
    }

    const source = encoded[options.sourceInputIndex];
    if (nativeCoefficient(source) !== 4) return uncalibrated;
    const sourcePixels = decodedPixels(request, facts, options.sourceInputIndex, NATIVE_PIXELS);
    if (options.mode === "layers") return calibrated(profile, 120 * MiB + source.bytes + nativeBytes + (readable.length ? 20 : 12) * sourcePixels);

    const mask = encoded[options.maskInputIndex];
    if (nativeCoefficient(mask) !== 4) return uncalibrated;
    const encodedBytes = source.bytes + mask.bytes + nativeBytes;
    const encodedOutputs = 4 * sourcePixels * readable.length;
    if (options.mode === "product_protection") return calibrated(profile, 120 * MiB + encodedBytes + (readable.length ? 17 : 12) * sourcePixels + encodedOutputs);

    const nativePixels = Math.max(0, ...readable.map((input) => decodedPixels(request, facts, input.inputIndex, NATIVE_PIXELS)));
    const rawBytes = readable.length ? Math.max(8 * sourcePixels + 4 * nativePixels, 12 * sourcePixels) : 8 * sourcePixels;
    return calibrated(profile, 120 * MiB + encodedBytes + rawBytes + encodedOutputs + 4 * Math.max(sourcePixels, nativePixels));
}

function sameIdentity(input: ImageProcessingResourceRequest["inputs"][number], inputIndex: number, fact: ImageProcessingResourceInputIdentity) {
    return fact.inputIndex === inputIndex && fact.assetId === input.assetId && fact.assetVersion === input.assetVersion && fact.sha256 === input.expectedSha256;
}

function decodedPixels(request: ImageProcessingResourceRequest, facts: ImageProcessingResourceFacts, inputIndex: number, limit: number) {
    const decoded = facts.decodedInputs.find((fact) => sameIdentity(request.inputs[inputIndex], inputIndex, fact));
    return decoded ? Math.min(decoded.width * decoded.height, limit) : limit;
}

function sameSize(value: ImageProcessingSize, expected: ImageProcessingSize) {
    return value.width === expected.width && value.height === expected.height;
}

function nativeCoefficient(input: EncodedImageProcessingInput) {
    const layout = input.layout;
    if (!layout) return undefined;
    if (layout.depth === "uchar" && ((layout.format === "png" && layout.channels <= 4) || (layout.format === "jpeg" && layout.channels <= 3))) return 4;
    if (layout.format === "png" && layout.depth === "ushort" && layout.channels <= 4) return 8;
    if (layout.format === "tiff" && layout.depth === "float" && layout.channels === 3) return 12;
    return undefined;
}

function calibrated(profile: ImageProcessingMemoryProfile, bytes: number): ImageProcessingMemoryEstimate {
    return { modelVersion: IMAGE_PROCESSING_MEMORY_MODEL_VERSION, profile, status: "calibrated", requiredMemoryBytes: Math.ceil(bytes / MiB) * MiB };
}

export function decideImageProcessingAdmission(estimate: ImageProcessingMemoryEstimate, capacity: ImageProcessingCapacity): ImageProcessingAdmission {
    if (estimate.status === "uncalibrated") return { status: "unavailable", code: "image_processing_resource_unavailable", reason: "profile_uncalibrated" };
    const { requiredMemoryBytes } = estimate;
    if (requiredMemoryBytes > capacity.totalMemoryBytes) return { status: "unavailable", code: "image_processing_resource_unavailable", reason: "exceeds_total_budget", requiredMemoryBytes };
    return { status: capacity.availableSlots > 0 && requiredMemoryBytes <= capacity.availableMemoryBytes ? "admit" : "pending", requiredMemoryBytes };
}

function operationProfile(request: ImageProcessingResourceRequest): ImageProcessingMemoryProfile {
    if (request.operation === "process_enhancement") {
        if (request.options.scope === "full_image") return request.options.stagedDelivered?.expected.format === "png" ? "enhancement_legacy_png" : "enhancement_global_jpeg";
        if (request.options.scope === "product_background") return "enhancement_product";
        return "enhancement_scene";
    }
    if (request.operation === "prepare_reference") return request.options.generationInput ? "generation_reference" : "prepare_reference";
    if (request.operation === "prepare_review") return "prepare_review";
    if (request.operation === "build_protection") {
        const protection = request.options;
        if ("mode" in protection) {
            if (protection.mode === "local_edit") return protection.freezeEnhancementBaseline ? "local_protection_qualified" : "local_protection";
            return protection.freezeEnhancementBaseline ? "scene_selection_qualified" : "scene_selection";
        }
        return protection.freezeEnhancementBaseline ? "white_protection_qualified" : "white_protection";
    }
    const options = request.options;
    if (options.mode === "ordinary") return options.transparentBackground ? "ordinary_transparent_result" : "ordinary_result";
    if (options.mode === "scene_protection") return "scene_result";
    if (options.mode === "product_protection") return "product_result";
    return "layers_result";
}
