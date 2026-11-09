export type ImageProcessingInput = {
    path: string;
    assetId: string;
    assetVersion: string;
    expectedSha256?: string;
};

type ImageProcessingRequestBase = {
    version: "image-processing.v1";
    jobId: string;
    executionId: string;
    inputs: ImageProcessingInput[];
    outputDirectory: string;
};

export type ImageProcessingResultInput = { resultId: string; resultIndex: number; inputIndex: number };
export type ImageProcessingGenerationInput = { bounds: ImageProcessingSize; quality: string };
export type ImageProcessingProtectionOptions =
    | { transparentBackground: boolean; sourceFraming?: "visible_extent"; generationInput?: ImageProcessingGenerationInput; freezeEnhancementBaseline?: true }
    | { mode: "local_edit"; targetRegion: ImageProcessingRectangle; protectedRectangles: ImageProcessingRectangle[]; freezeEnhancementBaseline?: { productAnchorId: string; productCore: ImageProcessingRectangle[] } }
    | { mode: "scene_selection"; region: ImageProcessingRectangle; semantics: string[]; selectionSource: "user_selection"; freezeEnhancementBaseline?: true };
export type ImageProcessingResultOptions =
    | { mode: "ordinary"; results: ImageProcessingResultInput[]; targetSize?: ImageProcessingSize; transparentBackground: boolean }
    | { mode: "layers"; results: ImageProcessingResultInput[]; sourceInputIndex: number }
    | { mode: "scene_protection"; results: ImageProcessingResultInput[]; sourceInputIndex: number; maskInputIndex: number; protection: SceneProtectionSnapshot; baseline?: ImageProcessingBaseline }
    | { mode: "product_protection"; results: ImageProcessingResultInput[]; sourceInputIndex: number; maskInputIndex: number; protection: ProductEnhancementDescriptor; baseline: ImageProcessingBaseline };
export type ImageProcessingOperation =
    | { operation: "prepare_reference"; options: { generationInput?: ImageProcessingGenerationInput } }
    | { operation: "prepare_review"; options: { region?: ImageProcessingRectangle } }
    | { operation: "build_protection"; options: ImageProcessingProtectionOptions }
    | { operation: "process_result"; options: ImageProcessingResultOptions }
    | { operation: "process_enhancement"; options: ImageProcessingEnhancementOptions };
export type ImageProcessingRequest = ImageProcessingRequestBase & ImageProcessingOperation;

export type ImageProcessingSize = { width: number; height: number };
export type ImageProcessingRectangle = ImageProcessingSize & { x: number; y: number };
export type SceneProtectionSnapshot = {
    version: "scene-edit-protection.v1";
    sourceAssetId: string;
    sourceSize: ImageProcessingSize;
    sourceDigest: string;
    maskSize: ImageProcessingSize;
    maskDigest: string;
    targetRegion: ImageProcessingRectangle;
    semantics: string[];
    selectionSource: "user_selection";
    confirmation?: { actorUserId: string; confirmedAt: number };
    maskSemantics: "alpha_zero_edit";
    method: "source_pixels_copy";
};
export type ImageProcessingBaseline = ImageProcessingSize & { sha256: string; byteLength: number; normalizedSha256: string };
export type ProductProtectionSnapshot = {
    compilerVersion: "strict-product.v1";
    state: "ready" | "needs_review";
    productAnchorId: string;
    sourceAssetId: string;
    sourceSize: ImageProcessingSize;
    productCore: ImageProcessingRectangle[];
    fusionHalo: ImageProcessingRectangle[];
    editableBackground: ImageProcessingRectangle[];
    maskProvider?: string;
    reason?: string;
};
export type ProductEnhancementDescriptor = { version: "product-enhancement.v2"; normalization: "srgb-upright-v1"; product: ProductProtectionSnapshot; maskSha256: string };
export type ImageProcessingArtifact = ImageProcessingSize & {
    kind: "analysis" | "mask" | "generation_reference" | "generation_mask" | "final";
    path: string;
    sha256: string;
    mimeType: string;
    bytes: number;
    resultId?: string;
    resultIndex?: number;
    layerKind?: "element" | "background";
};

export type SceneProtectionEvidence = SceneProtectionSnapshot & {
    nativeSize: ImageProcessingSize;
    normalization: "none" | "uniform_scale" | "pixel_grid_scale";
    nativeDigest: string;
    compositeDigest: string;
    outsidePixels: number;
    mappedOutsideChangedPixels: number;
    nativeOutsideChangedPixels?: number;
    compositeOutsideChangedPixels: 0;
};
export type ProductEnhancementEvidence = {
    version: "product-enhancement.v2";
    normalization: "srgb-upright-v1";
    productAnchorId: string;
    sourceAssetId: string;
    sourceSha256: string;
    maskSha256: string;
    aiSha256: string;
    compositeSha256: string;
    sourceSize: ImageProcessingSize;
    aiSize: ImageProcessingSize;
    allowedPixels: number;
    protectedPixels: number;
    protectedChangedPixels: 0;
};
export type ImageProcessingFailure = { code: string; message: string };
export type ImageProcessingEnhancementBaseline =
    | { status: "qualified"; scope: "local_edit" | "product_background"; normalization: "srgb-upright-v1"; baseline: ImageProcessingBaseline; hasAlpha: boolean; composition?: ProductEnhancementEvidence }
    | { status: "unsupported"; scope: "local_edit" | "product_background"; error: ImageProcessingFailure };
export type ImageProcessingSourceIdentity = { assetId: string; assetVersion: string; sha256: string; bytes: number } & (
    (ImageProcessingSize & { mimeType: string; nativeImage?: { format: string; hasAlpha: boolean }; decodeError?: never }) | { decodeError: ImageProcessingFailure; width?: never; height?: never; mimeType?: never; nativeImage?: never }
);
export type ImageProcessingResultBinding = { resultId: string; resultIndex: number; nativeInputIndex: number } & (
    | { finalArtifactIndex: number; error?: never; finalImage?: { format: string; hasAlpha: boolean }; baselineValidated?: boolean; sceneProtectionEvidence?: SceneProtectionEvidence; productEnhancementEvidence?: ProductEnhancementEvidence }
    | { error: ImageProcessingFailure & { failureStage: "decode" | "validation" }; finalArtifactIndex?: never }
);

export type ImageProcessingEnhancementArtifact = ImageProcessingSize & { format: "png" | "jpeg"; sha256: string; byteLength: number };
export type SceneEnhancementDescriptor = { version: "scene-enhancement.v1"; normalization: "srgb-upright-v1"; scene: SceneProtectionSnapshot };
export type SceneEnhancementEvidence = {
    version: "scene-enhancement.v1";
    normalization: "srgb-upright-v1";
    sourceAssetId: string;
    sourceSha256: string;
    maskSha256: string;
    aiSha256: string;
    compositeSha256: string;
    sourceSize: ImageProcessingSize;
    aiSize: ImageProcessingSize;
    allowedPixels: number;
    protectedPixels: number;
    protectedChangedPixels: 0;
    mapping: { context: { x: 0; y: 0; width: number; height: number }; targetRegion: ImageProcessingRectangle };
};
type EnhancementBudget = { maxBytes: number; maxPixels: number };
type EnhancementOptionsBase = {
    bindingDigest: string;
    resultId: string;
    resultIndex: number;
    aiInputIndex: number;
    engineInput: ImageProcessingSize;
    expectedAi: ImageProcessingEnhancementArtifact & { format: "png" };
    targetSize: ImageProcessingSize;
    budgets: { input: EnhancementBudget; ai: EnhancementBudget; delivery: EnhancementBudget };
    stagedDelivered?: { inputIndex: number; expected: ImageProcessingEnhancementArtifact };
};
type EnhancementProtectedInputs = {
    sourceInputIndex: number;
    nativeInputIndex: number;
    baselineInputIndex: number;
    maskInputIndex: number;
    source: ImageProcessingBaseline;
    native: ImageProcessingEnhancementArtifact;
    baseline: ImageProcessingEnhancementArtifact & { format: "png" };
};
export type ImageProcessingEnhancementOptions = EnhancementOptionsBase &
    (
        | { scope: "full_image" }
        | (EnhancementProtectedInputs & { scope: "product_background"; protection: ProductEnhancementDescriptor; originalProof: ProductEnhancementEvidence })
        | (EnhancementProtectedInputs & { scope: "local_edit"; protection: SceneEnhancementDescriptor; originalProof: SceneProtectionEvidence })
    );
export type ImageProcessingEnhancementResult = {
    version: "enhancement-processing-result.v1";
    bindingDigest: string;
    scope: ImageProcessingEnhancementOptions["scope"];
    aiInputIndex: number;
    ai: ImageProcessingEnhancementArtifact & { format: "png" };
    deliveredArtifactIndex: number;
    deliveryEncodingMs?: number;
    protection?: ProductEnhancementEvidence | SceneEnhancementEvidence;
};

export type ImageProcessingResult = {
    jobId: string;
    executionId: string;
    sourceIdentities: ImageProcessingSourceIdentity[];
    artifacts: ImageProcessingArtifact[];
    results?: ImageProcessingResultBinding[];
    enhancement?: ImageProcessingEnhancementResult;
    geometry: { sourceSize?: ImageProcessingSize; productBounds?: ImageProcessingRectangle; haloBounds?: ImageProcessingRectangle; sceneProtection?: SceneProtectionSnapshot; enhancementBaseline?: ImageProcessingEnhancementBaseline };
    metrics: { pid: number; peakRssBytes: number; peakHeapUsedBytes: number; peakExternalBytes: number; elapsedMs: number };
};

export type ImageProcessingChildReply = { status: "completed"; result: ImageProcessingResult } | { status: "rejected"; jobId: string; executionId: string; error: { code: string; message: string } };

type ImageProcessingExit = { jobId: string; executionId: string; pid: number | null; exitCode: number | null; signal: string | null; stderr: string };
export type ImageProcessingOutcome = ImageProcessingExit &
    (
        | { status: "completed"; result: ImageProcessingResult }
        | { status: "rejected"; error: { code: string; message: string } }
        | { status: "aborted" }
        | { status: "resource_failure"; reason: "v8_heap_oom" }
        | { status: "crashed"; error: { code: string; message: string } }
    );
