// Matches the packaged Worker's standard HTTP request budget; administrators can override it.
export const DEFAULT_ENHANCEMENT_TIMEOUT_MS = 30_000;

export type EnhancementModel = Readonly<{
    id: string;
    binaryVersion: string;
    binarySha256: string;
    modelVersion: string;
    modelSha256: string;
    nativeScale: 4;
    allowedTiles: readonly number[];
    defaultTile: number;
    tta: boolean;
    ttaModes?: readonly boolean[];
    gpuId: number;
}>;
export function supportsEnhancementTta(model: EnhancementModel | undefined, tta: boolean) {
    return !!model && (model.ttaModes ?? [false]).includes(tta);
}
export type EnhancementSize = Readonly<{ width: number; height: number }>;
export type ImageEnhancementSkip = Readonly<{
    status: "skipped";
    reason: "disabled" | "not_requested" | "protected_contract" | "unsupported_layers";
}>;
export type ImageResultEnhancementInput = { resultId?: unknown; enhancementId?: unknown; nativeSource?: unknown; enhancementSkip?: unknown };
export type PublicImageResultEnhancement = {
    resultId?: string;
    enhancementId?: string;
    nativeSource?: Omit<PublicImageEnhancement["native"], "provenance"> & { hasAlpha: boolean; provenance: "provider_native" | "ai_enhanced" };
    enhancementSkip?: ImageEnhancementSkip;
};

export function publicImageResultEnhancement(input: ImageResultEnhancementInput): PublicImageResultEnhancement {
    const result: PublicImageResultEnhancement = {};
    if (typeof input.resultId === "string" && input.resultId) result.resultId = input.resultId;
    if (typeof input.enhancementId === "string" && input.enhancementId) result.enhancementId = input.enhancementId;
    const native = input.nativeSource && typeof input.nativeSource === "object" ? (input.nativeSource as Record<string, unknown>) : null;
    if (
        native &&
        typeof native.url === "string" &&
        typeof native.sha256 === "string" &&
        typeof native.format === "string" &&
        typeof native.width === "number" &&
        typeof native.height === "number" &&
        typeof native.byteLength === "number" &&
        typeof native.hasAlpha === "boolean" &&
        (native.provenance === "provider_native" || native.provenance === "ai_enhanced")
    ) {
        result.nativeSource = { url: native.url, sha256: native.sha256, width: native.width, height: native.height, byteLength: native.byteLength, format: native.format, hasAlpha: native.hasAlpha, provenance: native.provenance };
    }
    const skip = input.enhancementSkip && typeof input.enhancementSkip === "object" ? (input.enhancementSkip as Record<string, unknown>) : null;
    if (skip?.status === "skipped" && (skip.reason === "disabled" || skip.reason === "not_requested" || skip.reason === "protected_contract" || skip.reason === "unsupported_layers")) result.enhancementSkip = { status: "skipped", reason: skip.reason };
    return result;
}

type PublicEnhancementArtifact = EnhancementSize & { sha256: string; byteLength: number; format: string };
export type ImageEnhancementTimings = {
    workerQueueMs?: number;
    workerExecutionMs?: number;
    deliveryEncodingMs?: number;
};
export type PublicImageEnhancement = {
    id: string;
    imageTaskId: string;
    resultId: string;
    status: "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
    phase: "prepare" | "submit" | "poll" | "download" | "publish" | "receipt" | "completed";
    reason: string | null;
    attempt: number;
    timings?: ImageEnhancementTimings;
    native: PublicEnhancementArtifact & { url: string; provenance: "provider_native" | "ai_enhanced" | "protected_composite" };
    providerNative?: PublicEnhancementArtifact & { url: string };
    delivery?: {
        version: "ecommerce-delivery.v2";
        scope: "full_image" | "product_background" | "local_edit";
        requestedTarget: EnhancementSize;
        protectedPixels?: number;
        allowedPixels?: number;
        protectedChangedPixels?: 0;
    };
    target: EnhancementSize;
    plannedInference?: EnhancementSize;
    ai?: PublicEnhancementArtifact;
    enhanced?: PublicEnhancementArtifact & { url: string; assetId: string | null };
    model?: { id: string; binaryVersion: string; modelVersion: string; tta: boolean };
    events: { stage: string; at: number; attempt: number; reason?: string }[];
    canRetry: boolean;
    canCancel: boolean;
};
export type EnhancementCheck = Readonly<{
    revision: string;
    state: "pending" | "ready" | "unavailable";
    stage: "configuration" | "connection" | "authentication" | "capabilities" | "engine" | "sample" | "output";
    reason: string;
    checkedAt: string;
    serviceId?: string;
    bootId?: string;
    jobId?: string;
    sample?: Readonly<{ input: EnhancementSize; inference: EnhancementSize; output: EnhancementSize; sha256: string; byteLength: number }>;
}>;
export type ImageEnhancementSettings = Readonly<{
    revision: string;
    enabled: boolean;
    tta: boolean;
    mode: "remote_api";
    endpoint: string;
    trust: "system" | "custom_ca";
    hasCa: boolean;
    hasToken: boolean;
    timeoutMs: number | null;
    modelId: string;
    models: readonly EnhancementModel[];
    ready: boolean;
    check: EnhancementCheck | null;
}>;
export type ImageEnhancementUpdate = {
    revision: string;
    enabled?: boolean;
    tta?: boolean;
    mode?: "remote_api";
    endpoint?: string;
    trust?: "system" | "custom_ca";
    caPem?: string;
    token?: string;
    clearToken?: boolean;
    timeoutMs?: number | null;
    modelId?: string;
};
export type ImageEnhancementCheckRequest = { revision: string; action: "connection" | "sample" };
export const ENHANCEMENT_REASONS: Readonly<Record<string, string>> = {
    not_configured: "请先保存服务地址、访问密钥和请求超时。",
    connection_failed: "无法连接增强服务，请检查地址、网络及服务状态。",
    timeout: "增强服务请求超时，请检查服务状态后重新检查。",
    tls_untrusted: "增强服务的 TLS 证书不受信任或名称不匹配，请检查信任配置。",
    authentication_failed: "增强服务拒绝访问密钥，请替换有效密钥。",
    invalid_response: "增强服务返回的协议或内容无效。",
    service_identity_changed: "服务身份发生变化，请核对服务并保存新的连接地址。",
    engine_unavailable: "增强引擎或 GPU 尚未就绪，请检查 Worker 自检与设备状态。",
    worker_configuration_invalid: "增强服务配置无效，请检查引擎、模型目录及 Worker 配置。",
    model_unavailable: "所选模型不在当前鉴权能力列表中，或原生倍率不受支持。",
    tta_unavailable: "所选模型未声明支持精细增强，请升级 Worker 并重新检查连接后开启 TTA。",
    sample_required: "连接与能力检查通过，请选择模型并执行样图自检。",
    sample_pending: "样图自检尚未完成，请刷新自检状态；不会重复创建推理任务。",
    sample_unqualified: "样图尚未取得当前启动实例的 GPU 资格，请检查 Worker 设备观察。",
    sample_model_mismatch: "样图使用的模型或执行参数与 Worker 注册信息不一致，请核对自检配置。",
    sample_failed: "Worker 样图自检失败或结果未知，请检查原自检记录。",
    sample_changed: "验收期间 Worker 启动实例或样图资格发生变化，请重新检查。",
    output_invalid: "样图摘要、原生尺寸或完整解码检查失败。",
    ready: "样图已完整下载和解码，当前配置检查通过。",
    configuration_changed: "配置已变化，请刷新后重试。",
    invalid_configuration: "增强配置无效，请检查字段。",
    not_ready: "请先完成当前配置的能力与真实样图检查，再开启增强。",
};
