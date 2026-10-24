import { createHash } from "node:crypto";

import {
  freezeExecutionPolicy,
  validIdentifier,
  type ClaimedAttempt,
} from "./execution.js";
import { EnhancementError } from "./contracts.js";

export type FrozenWindowsRequest = Readonly<{
  requestUtf8Base64: string;
  requestFingerprint: string;
}>;

// Node.js 22 provides this built-in; the shared TypeScript target is ES2022.
const isWellFormed = (
  String.prototype as unknown as { isWellFormed(this: string): boolean }
).isWellFormed;

function invalid(): never {
  throw new EnhancementError("configuration_invalid");
}

function ownData(source: unknown, key: string, enumerable = false): unknown {
  if (!source || typeof source !== "object") invalid();
  const property = Object.getOwnPropertyDescriptor(source, key);
  if (
    !property ||
    !("value" in property) ||
    (enumerable && !property.enumerable)
  )
    invalid();
  return property.value;
}

function exact(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    invalid();
  return Object.fromEntries(
    fields.map((key) => [key, ownData(value, key, true)]),
  );
}

function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum
  )
    invalid();
  return value;
}

function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isWellFormed.call(value)
  )
    invalid();
  return value;
}

function identifier(value: unknown): string {
  const result = text(value);
  if (!validIdentifier(result)) invalid();
  return result;
}

function digest(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value)
  )
    invalid();
  return value;
}

function tile(value: unknown): number {
  const result = integer(value);
  if (result !== 0 && result < 32) invalid();
  return result;
}

function tiles(value: unknown): number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    invalid();
  const length = integer(ownData(value, "length"), 1);
  if (Reflect.ownKeys(value).length !== length + 1) invalid();
  const result: number[] = [];
  for (let index = 0; index < length; index++)
    result.push(tile(ownData(value, String(index), true)));
  if (new Set(result).size !== result.length) invalid();
  return result;
}

function path(value: unknown): string {
  const result = text(value);
  if (result.includes("\u0000")) invalid();
  return result;
}

export function freezeWindowsPrepareRequest(
  attempt: ClaimedAttempt,
  observation?: "boot-v1",
): FrozenWindowsRequest {
  try {
    if (observation !== undefined && observation !== "boot-v1") invalid();
    const sourceIdentity = exact(ownData(attempt, "identity"), [
      "jobId",
      "attemptNo",
      "ownerInstanceId",
      "fence",
    ]);
    const identity = {
      jobId: identifier(sourceIdentity.jobId),
      attemptNo: integer(sourceIdentity.attemptNo, 1),
      ownerInstanceId: identifier(sourceIdentity.ownerInstanceId),
      fence: integer(sourceIdentity.fence, 1),
    };
    const launchTicket = identifier(ownData(attempt, "launchTicket"));
    const job = ownData(attempt, "job");
    if (ownData(job, "jobId") !== identity.jobId) invalid();
    const sourcePolicy = exact(ownData(attempt, "executionPolicy"), [
      "limits",
      "allowedTiles",
      "fingerprint",
    ]);
    const sourceLimits = exact(sourcePolicy.limits, [
      "executionTimeoutMs",
      "cancelGraceMs",
      "leaseDurationMs",
      "heartbeatIntervalMs",
    ]);
    const limits = {
      executionTimeoutMs: integer(sourceLimits.executionTimeoutMs, 1),
      cancelGraceMs: integer(sourceLimits.cancelGraceMs, 1),
      leaseDurationMs: integer(sourceLimits.leaseDurationMs, 1),
      heartbeatIntervalMs: integer(sourceLimits.heartbeatIntervalMs, 1),
    };
    const allowedTiles = tiles(sourcePolicy.allowedTiles);
    const fingerprint = digest(sourcePolicy.fingerprint);
    if (
      limits.heartbeatIntervalMs > limits.leaseDurationMs ||
      freezeExecutionPolicy(limits, allowedTiles).fingerprint !== fingerprint
    )
      invalid();
    const sourceEngine = exact(ownData(ownData(job, "plan"), "engine"), [
      "modelId",
      "binaryVersion",
      "binarySha256",
      "modelVersion",
      "modelSha256",
      "nativeScale",
      "tile",
      "tta",
      "gpuId",
    ]);
    const modelId = identifier(sourceEngine.modelId);
    const nativeScale = integer(sourceEngine.nativeScale);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(modelId) ||
      nativeScale !== 4 ||
      sourceEngine.tta !== false
    )
      invalid();
    const engine = {
      modelId,
      binaryVersion: identifier(sourceEngine.binaryVersion),
      binarySha256: digest(sourceEngine.binarySha256),
      modelVersion: identifier(sourceEngine.modelVersion),
      modelSha256: digest(sourceEngine.modelSha256),
      nativeScale,
      tile: tile(sourceEngine.tile),
      tta: sourceEngine.tta,
      gpuId: integer(sourceEngine.gpuId),
    };
    if (
      integer(ownData(attempt, "tile")) !== engine.tile ||
      !allowedTiles.includes(engine.tile)
    )
      invalid();
    const firstStartedAt = integer(ownData(attempt, "firstStartedAt"));
    const executionDeadlineAt = integer(
      ownData(attempt, "executionDeadlineAt"),
    );
    if (executionDeadlineAt <= firstStartedAt) invalid();
    const spec = {
      v: 1,
      target: { identity, launchTicket },
      executionPolicy: { limits, allowedTiles, fingerprint },
      engine,
      firstStartedAt,
      executionDeadlineAt,
      inputPath: path(ownData(attempt, "inputPath")),
      workingDirectory: path(ownData(attempt, "workingDirectory")),
      outputPath: path(ownData(attempt, "outputPath")),
      ...(observation === "boot-v1" ? { runtimeObservation: observation } : {}),
    };
    const bytes = Buffer.from(JSON.stringify(spec), "utf8");
    return Object.freeze({
      requestUtf8Base64: bytes.toString("base64"),
      requestFingerprint: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch {
    invalid();
  }
}
