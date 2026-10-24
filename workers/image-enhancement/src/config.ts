import {
  EnhancementError,
  NORMALIZATION_PROFILE,
  PROTOCOL_VERSION,
} from "./contracts.js";

export type ResourceLimits = Readonly<{ maxBytes: number; maxPixels: number }>;
export type EnhancementBudgets = Readonly<{
  input: ResourceLimits;
  ai: ResourceLimits;
  delivery: ResourceLimits;
}>;

export type EnhancementModel = Readonly<{
  id: string;
  binaryVersion: string;
  binarySha256: string;
  modelVersion: string;
  modelSha256: string;
  nativeScale: 4;
  allowedTiles: readonly number[];
  defaultTile: number;
  tta: false;
  gpuId: number;
}>;

export type WorkerConfig = Readonly<{
  protocolVersion: typeof PROTOCOL_VERSION;
  normalizationProfile: typeof NORMALIZATION_PROFILE;
  models: readonly EnhancementModel[];
  budgets: EnhancementBudgets;
}>;

export type SubmissionLimits = Readonly<{
  maxWaitingJobs: number;
  queueTimeoutMs: number;
  maxIdempotencyKeyLength: number;
}>;

export type RunnerLimits = Readonly<{
  executionTimeoutMs: number;
  cancelGraceMs: number;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
}>;

export function createRunnerLimits(value: unknown): RunnerLimits {
  const input = record(value, [
    "executionTimeoutMs",
    "cancelGraceMs",
    "leaseDurationMs",
    "heartbeatIntervalMs",
  ]);
  if (
    !integer(input.executionTimeoutMs, 1) ||
    !integer(input.cancelGraceMs, 1) ||
    !integer(input.leaseDurationMs, 1) ||
    !integer(input.heartbeatIntervalMs, 1) ||
    input.heartbeatIntervalMs > input.leaseDurationMs
  )
    invalid();
  return Object.freeze({
    executionTimeoutMs: input.executionTimeoutMs,
    cancelGraceMs: input.cancelGraceMs,
    leaseDurationMs: input.leaseDurationMs,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
  });
}

function invalid(): never {
  throw new EnhancementError("configuration_invalid");
}

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const result = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(result).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    ) ||
    keys.some((key) => !Object.hasOwn(result, key))
  )
    invalid();
  return result;
}

function integer(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

function version(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);
}

function limits(value: unknown): ResourceLimits {
  const input = record(value, ["maxBytes", "maxPixels"]);
  if (!integer(input.maxBytes, 1) || !integer(input.maxPixels, 1)) invalid();
  return Object.freeze({
    maxBytes: input.maxBytes,
    maxPixels: input.maxPixels,
  });
}

export function createSubmissionLimits(value: unknown): SubmissionLimits {
  const input = record(value, [
    "maxWaitingJobs",
    "queueTimeoutMs",
    "maxIdempotencyKeyLength",
  ]);
  if (
    !integer(input.maxWaitingJobs, 1) ||
    !integer(input.queueTimeoutMs, 1) ||
    !integer(input.maxIdempotencyKeyLength, 1)
  )
    invalid();
  return Object.freeze({
    maxWaitingJobs: input.maxWaitingJobs,
    queueTimeoutMs: input.queueTimeoutMs,
    maxIdempotencyKeyLength: input.maxIdempotencyKeyLength,
  });
}

export function createWorkerConfig(value: unknown): WorkerConfig {
  const input = record(value, [
    "protocolVersion",
    "normalizationProfile",
    "models",
    "budgets",
  ]);
  if (
    input.protocolVersion !== PROTOCOL_VERSION ||
    input.normalizationProfile !== NORMALIZATION_PROFILE ||
    !Array.isArray(input.models) ||
    input.models.length === 0
  )
    invalid();
  const seen = new Set<string>();
  const models: EnhancementModel[] = input.models.map((value: unknown) => {
    const model = record(value, [
      "id",
      "binaryVersion",
      "binarySha256",
      "modelVersion",
      "modelSha256",
      "nativeScale",
      "allowedTiles",
      "defaultTile",
      "tta",
      "gpuId",
    ]);
    if (
      typeof model.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model.id) ||
      seen.has(model.id) ||
      !version(model.binaryVersion) ||
      !sha256(model.binarySha256) ||
      !version(model.modelVersion) ||
      !sha256(model.modelSha256) ||
      model.nativeScale !== 4 ||
      model.tta !== false ||
      !integer(model.gpuId, 0) ||
      !Array.isArray(model.allowedTiles) ||
      model.allowedTiles.length === 0 ||
      !model.allowedTiles.every(
        (tile: unknown) => integer(tile, 0) && (tile === 0 || tile >= 32),
      ) ||
      new Set(model.allowedTiles).size !== model.allowedTiles.length ||
      !integer(model.defaultTile, 0) ||
      !model.allowedTiles.includes(model.defaultTile)
    )
      invalid();
    seen.add(model.id);
    return Object.freeze({
      id: model.id,
      binaryVersion: model.binaryVersion,
      binarySha256: model.binarySha256.toLowerCase(),
      modelVersion: model.modelVersion,
      modelSha256: model.modelSha256.toLowerCase(),
      nativeScale: 4 as const,
      allowedTiles: Object.freeze([...model.allowedTiles] as number[]),
      defaultTile: model.defaultTile,
      tta: false as const,
      gpuId: model.gpuId,
    });
  });
  const budgets = record(input.budgets, ["input", "ai", "delivery"]);
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    normalizationProfile: NORMALIZATION_PROFILE,
    models: Object.freeze(models),
    budgets: Object.freeze({
      input: limits(budgets.input),
      ai: limits(budgets.ai),
      delivery: limits(budgets.delivery),
    }),
  });
}
