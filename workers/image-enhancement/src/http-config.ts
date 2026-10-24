import { EnhancementError } from "./contracts.js";

export type HttpTransportLimits = Readonly<{
  maxPlanBytes: number;
  maxMultipartOverheadBytes: number;
  maxConcurrentUploads: number;
  maxConcurrentDownloads: number;
  maxReceiptBytes: number;
  maxConcurrentReceipts: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  maxHeaderBytes: number;
}>;

export function createHttpTransportLimits(value: unknown): HttpTransportLimits {
  const keys: readonly (keyof HttpTransportLimits)[] = [
    "maxPlanBytes",
    "maxMultipartOverheadBytes",
    "maxConcurrentUploads",
    "maxConcurrentDownloads",
    "maxReceiptBytes",
    "maxConcurrentReceipts",
    "headersTimeoutMs",
    "requestTimeoutMs",
    "maxHeaderBytes",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new EnhancementError("configuration_invalid");
  const input = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key)) ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key as keyof HttpTransportLimits),
    ) ||
    keys.some(
      (key) =>
        typeof input[key] !== "number" ||
        !Number.isSafeInteger(input[key]) ||
        (input[key] as number) < 1,
    )
  )
    throw new EnhancementError("configuration_invalid");
  const limits = input as unknown as HttpTransportLimits;
  // Node timers cannot represent intervals above a signed 32-bit millisecond value.
  if (
    limits.headersTimeoutMs > limits.requestTimeoutMs ||
    limits.requestTimeoutMs > 2 ** 31 - 1
  )
    throw new EnhancementError("configuration_invalid");
  return Object.freeze({ ...limits });
}

export function requestByteBudget(
  maxImageBytes: number,
  limits: HttpTransportLimits,
) {
  const total =
    maxImageBytes + limits.maxPlanBytes + limits.maxMultipartOverheadBytes;
  if (
    !Number.isSafeInteger(maxImageBytes) ||
    maxImageBytes < 1 ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(Math.max(maxImageBytes, limits.maxPlanBytes) + 1)
  )
    throw new EnhancementError("configuration_invalid");
  return total;
}
