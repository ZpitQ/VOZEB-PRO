import { createHash } from "node:crypto";

import type { ArtifactResult } from "./artifacts.js";
import type { EnhancementBudgets, WorkerConfig } from "./config.js";

export const PROTOCOL_VERSION = "image-enhancement.v1";
export const NORMALIZATION_PROFILE = "srgb-upright-v1";
export const INTERNAL_SELF_TEST_KEY_PREFIX = "vozeb:self-test:v1:";

export function isInternalSelfTestKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === INTERNAL_SELF_TEST_KEY_PREFIX.length + 36 &&
    value.startsWith(INTERNAL_SELF_TEST_KEY_PREFIX) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.slice(INTERNAL_SELF_TEST_KEY_PREFIX.length),
    )
  );
}

const errors = {
  authentication_failed: [401, "增强服务认证失败。"],
  route_not_found: [404, "增强接口不存在。"],
  method_not_allowed: [405, "增强接口不支持此请求方法。"],
  invalid_request: [400, "增强请求格式不正确。"],
  unsupported_media_type: [415, "不支持此图片或请求格式。"],
  invalid_image: [422, "图片无法完整解码。"],
  invalid_plan: [422, "增强计划不符合允许的策略。"],
  budget_exceeded: [413, "图片超过增强资源预算。"],
  idempotency_conflict: [409, "同一增强请求的输入或策略发生冲突。"],
  strategy_mismatch: [409, "增强模型或资源策略已变化，请沿用任务冻结策略。"],
  queue_full: [429, "增强等待队列已满。"],
  upload_capacity_exceeded: [429, "增强上传并发已满。"],
  upload_timeout: [408, "增强上传已超过配置期限。"],
  download_capacity_exceeded: [429, "增强下载并发已满。"],
  download_timeout: [408, "增强下载已超过配置期限。"],
  receipt_capacity_exceeded: [429, "增强接收确认并发已满。"],
  receipt_timeout: [408, "增强接收确认已超过配置期限。"],
  not_ready: [503, "增强执行环境尚未就绪。"],
  configuration_invalid: [503, "增强服务配置无效。"],
  job_not_found: [404, "增强任务不存在。"],
  result_not_ready: [409, "增强结果尚不可用。"],
  result_gone: [410, "增强结果已按保留规则停止提供，无法再次下载。"],
  receipt_conflict: [409, "增强结果接收确认与任务不匹配。"],
  input_digest_mismatch: [422, "原图摘要与增强计划不匹配。"],
  output_digest_mismatch: [422, "增强产物摘要不匹配。"],
  aspect_ratio_mismatch: [422, "目标画幅与原图比例不一致。"],
  unsupported_target: [422, "目标尺寸超出单次原生增强范围。"],
  unsupported_transparency: [422, "当前增强范围尚不支持透明素材。"],
  invalid_output: [422, "增强产物不符合原生倍率或图片契约。"],
  store_not_initialized: [503, "增强服务尚未初始化。"],
  store_already_initialized: [409, "增强服务已经初始化。"],
  store_locked: [503, "增强服务数据已由其他实例独占。"],
  internal_error: [503, "增强服务暂时不可用。"],
} as const;

export type EnhancementErrorCode = keyof typeof errors;

export type FixedSelfTestSnapshot = Readonly<{
  bootId: string;
  assetId: "zeb-enhancement-calibration-v1";
  phase:
    | "not_started"
    | "preparing"
    | "bound"
    | "checking_output"
    | "output_verified"
    | "blocked"
    | "failed"
    | "unknown";
  jobId: string | null;
  reason:
    | EnhancementErrorCode
    | "startup_recovering"
    | "recovery_blocked"
    | "diagnostic_conflict"
    | "device_observation_required"
    | null;
  output: ArtifactResult | null;
  qualification: "unknown" | "qualified";
}>;

export class EnhancementError extends Error {
  readonly status: number;
  readonly code: EnhancementErrorCode;

  constructor(code: EnhancementErrorCode) {
    super(errors[code][1]);
    this.name = "EnhancementError";
    this.status = errors[code][0];
    this.code = code;
  }
}

export function toErrorResponse(error: unknown, requestId: string) {
  const code =
    error instanceof EnhancementError ? error.code : "internal_error";
  return {
    status: errors[code][0],
    body: { code, data: { requestId }, msg: errors[code][1] },
  };
}

export type TargetSize = Readonly<{
  width: number;
  height: number;
  format: "png" | "jpeg";
}>;

export type FrozenEngine = Readonly<{
  modelId: string;
  binaryVersion: string;
  binarySha256: string;
  modelVersion: string;
  modelSha256: string;
  nativeScale: 4;
  tile: number;
  tta: boolean;
  gpuId: number;
}>;

export type FrozenEnhancementPlan = Readonly<{
  protocolVersion: typeof PROTOCOL_VERSION;
  scope: "full_image";
  sourceSha256: string;
  target: TargetSize;
  normalizationProfile: typeof NORMALIZATION_PROFILE;
  engine: FrozenEngine;
  budgets: EnhancementBudgets;
  strategyFingerprint: string;
  planFingerprint: string;
}>;

export type EnhancementPlanRequest = Readonly<{
  protocolVersion: typeof PROTOCOL_VERSION;
  scope: "full_image";
  sourceSha256: string;
  target: TargetSize;
  modelId: string;
  normalizationProfile: typeof NORMALIZATION_PROFILE;
  tile?: number;
  tta?: boolean;
  expectedStrategyFingerprint?: string;
}>;

export type ResultReceiptRequest = Readonly<{
  serviceId: string;
  receiptId: string;
  result: ArtifactResult;
}>;

export function parseReceiptRequest(value: unknown): ResultReceiptRequest {
  const input = record(value);
  exactKeys(input, ["serviceId", "receiptId", "result"]);
  const serviceId = input.serviceId;
  const receiptId = input.receiptId;
  const result = record(input.result);
  exactKeys(result, ["format", "width", "height", "sha256", "byteLength"]);
  const format = result.format;
  const width = result.width;
  const height = result.height;
  const sha256 = result.sha256;
  const byteLength = result.byteLength;
  const uuid =
    /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
  if (
    typeof serviceId !== "string" ||
    serviceId.length !== 36 ||
    !uuid.test(serviceId) ||
    typeof receiptId !== "string" ||
    receiptId.length !== 36 ||
    !uuid.test(receiptId) ||
    format !== "png" ||
    !positiveInteger(width) ||
    !positiveInteger(height) ||
    !positiveInteger(byteLength) ||
    typeof sha256 !== "string" ||
    sha256.length !== 64 ||
    !/^[a-fA-F0-9]{64}$/.test(sha256)
  )
    throw new EnhancementError("invalid_request");
  return Object.freeze({
    serviceId: serviceId.toLowerCase(),
    receiptId: receiptId.toLowerCase(),
    result: Object.freeze({
      format,
      width,
      height,
      sha256: sha256.toLowerCase(),
      byteLength,
    }),
  });
}

export function parsePlanJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EnhancementError("invalid_request");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new EnhancementError("invalid_request");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const allowed = new Set([...required, ...optional]);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.has(key),
    ) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new EnhancementError("invalid_request");
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parsePlanRequest(value: unknown): EnhancementPlanRequest {
  const input = record(value);
  exactKeys(
    input,
    [
      "protocolVersion",
      "scope",
      "sourceSha256",
      "target",
      "modelId",
      "normalizationProfile",
    ],
    ["tile", "tta", "expectedStrategyFingerprint"],
  );
  const targetInput = record(input.target);
  exactKeys(targetInput, ["width", "height", "format"]);
  if (
    input.protocolVersion !== PROTOCOL_VERSION ||
    input.scope !== "full_image" ||
    input.normalizationProfile !== NORMALIZATION_PROFILE ||
    typeof input.sourceSha256 !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(input.sourceSha256) ||
    typeof input.modelId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.modelId) ||
    (Object.hasOwn(input, "expectedStrategyFingerprint") &&
      (typeof input.expectedStrategyFingerprint !== "string" ||
        !/^[a-fA-F0-9]{64}$/.test(input.expectedStrategyFingerprint))) ||
    (Object.hasOwn(input, "tile") &&
      (typeof input.tile !== "number" ||
        !Number.isSafeInteger(input.tile) ||
        (input.tile !== 0 && input.tile < 32))) ||
    (Object.hasOwn(input, "tta") && typeof input.tta !== "boolean") ||
    !positiveInteger(targetInput.width) ||
    !positiveInteger(targetInput.height) ||
    (targetInput.format !== "png" && targetInput.format !== "jpeg")
  ) {
    throw new EnhancementError("invalid_plan");
  }
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    scope: "full_image" as const,
    sourceSha256: input.sourceSha256.toLowerCase(),
    target: Object.freeze({
      width: targetInput.width,
      height: targetInput.height,
      format: targetInput.format,
    }),
    modelId: input.modelId,
    normalizationProfile: NORMALIZATION_PROFILE,
    ...(Object.hasOwn(input, "tile") ? { tile: input.tile as number } : {}),
    ...(typeof input.tta === "boolean" ? { tta: input.tta } : {}),
    ...(typeof input.expectedStrategyFingerprint === "string"
      ? { expectedStrategyFingerprint: input.expectedStrategyFingerprint.toLowerCase() }
      : {}),
  });
}

export function requestFingerprint(
  request: EnhancementPlanRequest,
  frozenDefaultTile: number,
) {
  return hash({
    protocolVersion: request.protocolVersion,
    scope: request.scope,
    sourceSha256: request.sourceSha256,
    target: request.target,
    modelId: request.modelId,
    normalizationProfile: request.normalizationProfile,
    tile: request.tile ?? frozenDefaultTile,
    ...(request.tta !== undefined ? { tta: request.tta } : {}),
    ...(request.expectedStrategyFingerprint
      ? { expectedStrategyFingerprint: request.expectedStrategyFingerprint }
      : {}),
  });
}

export function normalizePlan(
  value: unknown,
  config: WorkerConfig,
): FrozenEnhancementPlan {
  const input = parsePlanRequest(value);
  const targetInput = input.target;
  const model = config.models.find((item) => item.id === input.modelId);
  const tile = input.tile ?? model?.defaultTile;
  if (!model || tile === undefined || !model.allowedTiles.includes(tile))
    throw new EnhancementError("invalid_plan");
  if (
    BigInt(targetInput.width) * BigInt(targetInput.height) >
    BigInt(config.budgets.delivery.maxPixels)
  ) {
    throw new EnhancementError("budget_exceeded");
  }

  const target: TargetSize = Object.freeze({
    width: targetInput.width,
    height: targetInput.height,
    format: targetInput.format,
  });
  const engine: FrozenEngine = Object.freeze({
    modelId: model.id,
    binaryVersion: model.binaryVersion,
    binarySha256: model.binarySha256,
    modelVersion: model.modelVersion,
    modelSha256: model.modelSha256,
    nativeScale: model.nativeScale,
    tile,
    tta: input.tta ?? model.tta,
    gpuId: model.gpuId,
  });
  const budgets: EnhancementBudgets = Object.freeze({
    input: Object.freeze({ ...config.budgets.input }),
    ai: Object.freeze({ ...config.budgets.ai }),
    delivery: Object.freeze({ ...config.budgets.delivery }),
  });
  const strategy = {
    protocolVersion: PROTOCOL_VERSION,
    scope: "full_image" as const,
    target,
    normalizationProfile: NORMALIZATION_PROFILE,
    engine,
    budgets,
  } as const;
  const sourceSha256 = input.sourceSha256.toLowerCase();
  const strategyFingerprint = hash(strategy);
  if (input.expectedStrategyFingerprint && input.expectedStrategyFingerprint !== strategyFingerprint)
    throw new EnhancementError("strategy_mismatch");
  return Object.freeze({
    ...strategy,
    sourceSha256,
    strategyFingerprint,
    planFingerprint: hash({ sourceSha256, ...strategy }),
  });
}
