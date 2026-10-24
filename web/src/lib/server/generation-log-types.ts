import type { GenerationLogRequestSnapshot } from "@/lib/generation-log-snapshot";
import type { EcommerceGenerationTrace } from "@/lib/server/ecommerce-generation-trace";
import { ENHANCEMENT_REASONS, type PublicImageEnhancement, type PublicImageResultEnhancement } from "@/lib/image-enhancement-contract";

export type GenerationLogKind = "image" | "video";
export type GenerationLogSource = "agent" | "image-workbench" | "video-workbench" | "canvas" | "drama" | "unknown";
export type GenerationLogStatus = "pending" | "success" | "failed";

export type GenerationLogAsset = PublicImageResultEnhancement & {
    type: GenerationLogKind;
    url: string;
    remoteUrl?: string;
    serverUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
    enhancement?: PublicImageEnhancement;
};

export const generationLogEnhancementStageLabels: Readonly<Record<string, string>> = {
    prepare: "准备任务",
    submit: "提交 Worker",
    poll: "查询 Worker",
    download: "取得完整 AI 输出",
    publish: "保存交付结果",
    receipt: "确认接收",
    completed: "已结束",
    queued: "已排队",
    skipped: "已跳过",
    prepared: "准备完成",
    worker_queued: "Worker 排队中",
    worker_running: "Worker 执行中",
    worker_succeeded: "Worker 输出已就绪",
    worker_failed: "Worker 执行失败",
    worker_cancelled: "Worker 已取消",
    storage_verified: "产物保存已校验",
    published: "交付已保存",
    receipt_confirmed: "接收已确认",
    receipt_deferred: "接收确认待恢复",
    retry_requested: "已请求重试",
    cancel_requested: "已请求取消",
    cancelled: "已取消",
    failed: "增强失败",
};

export const generationLogEnhancementReasonLabels: Readonly<Record<string, string>> = {
    ...ENHANCEMENT_REASONS,
    disabled: "未启用AI增强",
    not_requested: "本次未请求AI增强",
    protected_contract: "保护编辑契约不执行增强",
    unsupported_layers: "分层结果不执行增强",
    provider_unavailable: "增强服务暂不可用",
    native_sufficient: "原生尺寸已满足目标",
    already_enhanced: "原结果已经过 AI 增强",
    unsupported_transparency: "透明图片不执行增强",
    unsupported_media_type: "图片格式不支持增强",
    aspect_ratio_mismatch: "原图与目标比例不一致",
    unsupported_target: "增强输出无法满足目标尺寸",
    native_invalid: "原生图片校验未通过",
    native_identity_changed: "原结果身份已变化",
    invalid_enhancement_plan: "增强计划无效",
    input_digest_mismatch: "原图校验值不匹配",
    output_storage_invalid: "增强结果保存校验未通过",
    output_unavailable: "增强结果暂未取得",
    native_asset_unavailable: "原图素材暂未取得",
    asset_registration_failed: "增强素材登记失败",
    output_invalid: "增强产物完整性或尺寸校验失败",
    engine_failed: "增强引擎执行失败",
    lease_lost: "增强执行权已变化",
    cancelled: "增强已取消",
    cancelled_before_submission: "任务提交前已取消",
    cancel_requested: "已请求取消增强",
};

export type StoredGenerationLog = {
    id: string;
    userId: string;
    accountId?: string;
    conversationId?: string;
    username: string;
    displayName: string;
    kind: GenerationLogKind;
    source: GenerationLogSource;
    status: GenerationLogStatus;
    title: string;
    prompt: string;
    model: string;
    summary: string;
    durationMs: number;
    count: number;
    successCount: number;
    failCount: number;
    assets: GenerationLogAsset[];
    requestSnapshot?: GenerationLogRequestSnapshot;
    ecommerceTrace?: EcommerceGenerationTrace;
    taskId?: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
};

export type GenerationLogInput = Partial<Pick<StoredGenerationLog, "id" | "taskId" | "title" | "summary" | "error" | "requestSnapshot">> & {
    userId: string;
    username: string;
    displayName: string;
    conversationId?: string;
    kind: GenerationLogKind;
    source?: GenerationLogSource;
    status: GenerationLogStatus;
    prompt?: string;
    model?: string;
    durationMs?: number;
    count?: number;
    successCount?: number;
    failCount?: number;
    assets?: Array<Partial<GenerationLogAsset> & { url?: string; targetSize?: string }>;
    createdAt?: string | number;
    completedAt?: string | number;
};

export type GenerationTaskLogResultInput = {
    logId?: string;
    slotId?: string;
    clientRequestId?: string;
    taskId: string;
    userId: string;
    username: string;
    displayName: string;
    kind: GenerationLogKind;
    source: GenerationLogSource;
    status: "success" | "failed";
    title: string;
    prompt: string;
    model: string;
    summary: string;
    durationMs: number;
    asset?: Partial<GenerationLogAsset> & { url?: string; targetSize?: string };
    assets?: Array<Partial<GenerationLogAsset> & { url?: string; targetSize?: string }>;
    error?: string;
    canRetry?: boolean;
    taskKind?: "generation" | "edit";
    taskProvider?: "openai" | "seedance" | "generation";
    taskPollPath?: string;
    serverTaskId?: string;
    createdAt: string | number;
};

export type GenerationLogListOptions = {
    page?: number;
    pageSize?: number;
    keyword?: string;
    kind?: string;
    source?: string;
    status?: string;
    userId?: string;
    start?: string;
    end?: string;
    includeEcommerceTrace?: boolean;
    includeImageEnhancement?: boolean;
};

export type GenerationAssetStats = {
    totalFiles: number;
    totalBytes: number;
    referencedFiles: number;
    referencedBytes: number;
    unreferencedFiles: number;
    unreferencedBytes: number;
    missingReferences: number;
};

export type GenerationLogDatabase = {
    version: 1;
    logs: StoredGenerationLog[];
};
