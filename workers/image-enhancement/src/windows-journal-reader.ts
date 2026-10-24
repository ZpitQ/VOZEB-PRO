import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  freezeDurableInterruptionRecords,
  freezeExecutionExit,
  freezeOwnerDescriptor,
  validIdentifier,
  type DurableInterruptionRecords,
  type ExecutionExit,
  type ExecutionTarget,
  type JsonValue,
  type OwnerDescriptor,
} from "./execution.js";

export type WindowsJournalScope = Readonly<{
  target: ExecutionTarget;
  executionPolicyFingerprint: string;
}>;

export type WindowsJournalInterpretation =
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "engine-exit"; exit: ExecutionExit }>
  | Readonly<{ kind: "stop" | "deadline"; exit: ExecutionExit }>
  | Readonly<{
      kind: "interrupted";
      exit: ExecutionExit;
      records: DurableInterruptionRecords;
    }>;

export type WindowsJournalReadContext = Readonly<{
  scope: WindowsJournalScope;
  descriptor: OwnerDescriptor;
}>;

export function freezeWindowsJournalReadContext(
  expectedScope: WindowsJournalScope,
  originalDescriptor: OwnerDescriptor,
): WindowsJournalReadContext {
  try {
    const scope = journalScope(copyJson(expectedScope));
    const descriptor = windowsDescriptor(copyJson(originalDescriptor), scope);
    Object.freeze(scope.target.identity);
    Object.freeze(scope.target);
    Object.freeze(scope);
    return Object.freeze({ scope, descriptor });
  } catch {
    return invalid();
  }
}

const unknownInterpretation: WindowsJournalInterpretation = Object.freeze({
  kind: "unknown",
});

type JsonObject = Record<string, JsonValue>;
type Slot = keyof typeof slots;

const slots = {
  request: "00000000000000000000000000000001",
  prepared: "00000000000000000000000000000002",
  authorization: "00000000000000000000000000000003",
  controllerLoss: "00000000000000000000000000000005",
  terminal: "00000000000000000000000000000006",
} as const;
const uint32Max = 4_294_967_295;
const uint64Max = "18446744073709551615";
const isWellFormed = (
  String.prototype as unknown as { isWellFormed(this: string): boolean }
).isWellFormed;

function invalid(): never {
  throw new Error("invalid Windows journal snapshot");
}

function ownData(source: object, key: string, enumerable = true): unknown {
  const property = Object.getOwnPropertyDescriptor(source, key);
  if (!property || !("value" in property) || property.enumerable !== enumerable)
    invalid();
  return property.value;
}

// Copy data properties before any serializer, public freezer or field access.
// Accessors/toJSON are not a source of recovered facts.
function copyJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!isWellFormed.call(value)) invalid();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
    return value;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) invalid();
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
      const length = ownData(value, "length", false);
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        keys.length !== length + 1
      )
        invalid();
      const copy: JsonValue[] = [];
      for (let index = 0; index < length; index++)
        copy.push(copyJson(ownData(value, String(index)), ancestors));
      return copy;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
    return Object.fromEntries(
      keys.map((key) => {
        if (typeof key !== "string" || !isWellFormed.call(key)) invalid();
        return [key, copyJson(ownData(value, key), ancestors)];
      }),
    );
  } finally {
    ancestors.delete(value);
  }
}

function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as JsonObject;
}

function exact(
  value: JsonValue | undefined,
  keys: readonly string[],
): JsonObject {
  const result = object(value);
  if (
    Reflect.ownKeys(result).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(result, key))
  )
    invalid();
  return result;
}

function text(value: JsonValue | undefined): string {
  if (typeof value !== "string") invalid();
  return value;
}

function identifier(value: JsonValue | undefined): string {
  const result = text(value);
  if (!validIdentifier(result)) invalid();
  return result;
}

function integer(
  value: JsonValue | undefined,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  )
    invalid();
  return value;
}

function hex(value: JsonValue | undefined, length: number): string {
  const result = text(value);
  if (result.length !== length || !/^[a-f0-9]+$/.test(result)) invalid();
  return result;
}

function decimalUInt64(value: JsonValue | undefined): string {
  const result = text(value);
  if (
    !/^(0|[1-9][0-9]*)$/.test(result) ||
    result.length > uint64Max.length ||
    (result.length === uint64Max.length && result > uint64Max)
  )
    invalid();
  return result;
}

function target(value: JsonValue | undefined): ExecutionTarget {
  const result = exact(value, ["identity", "launchTicket"]);
  const identity = exact(result.identity, [
    "jobId",
    "attemptNo",
    "ownerInstanceId",
    "fence",
  ]);
  return {
    identity: {
      jobId: identifier(identity.jobId),
      attemptNo: integer(identity.attemptNo, 1),
      ownerInstanceId: identifier(identity.ownerInstanceId),
      fence: integer(identity.fence, 1),
    },
    launchTicket: identifier(result.launchTicket),
  };
}

function journalScope(value: JsonValue | undefined): WindowsJournalScope {
  const result = exact(value, ["target", "executionPolicyFingerprint"]);
  return {
    target: target(result.target),
    executionPolicyFingerprint: hex(result.executionPolicyFingerprint, 64),
  };
}

function processFact(value: JsonValue | undefined): JsonObject {
  const result = exact(value, ["pid", "creationFileTime"]);
  integer(result.pid, 1, uint32Max);
  decimalUInt64(result.creationFileTime);
  return result;
}

function fileIdentity(value: JsonValue | undefined): JsonObject {
  const result = exact(value, ["volumeSerial", "fileId"]);
  decimalUInt64(result.volumeSerial);
  hex(result.fileId, 32);
  return result;
}

function windowsDescriptor(
  value: JsonValue,
  scope: WindowsJournalScope,
): OwnerDescriptor {
  const result = exact(value, [
    "adapterId",
    "launchTicket",
    "executionId",
    "details",
  ]);
  const details = exact(result.details, [
    "v",
    "target",
    "executionPolicyFingerprint",
    "requestFingerprint",
    "requestRecordId",
    "preparedRecordId",
    "recipeId",
    "installationManifestSha256",
    "supervisor",
    "engine",
    "jobName",
  ]);
  if (
    result.adapterId !== "windows-supervisor-v1" ||
    identifier(result.launchTicket) !== scope.target.launchTicket ||
    details.v !== 1 ||
    !isDeepStrictEqual(target(details.target), scope.target) ||
    hex(details.executionPolicyFingerprint, 64) !==
      scope.executionPolicyFingerprint ||
    details.requestRecordId !== slots.request ||
    details.preparedRecordId !== slots.prepared ||
    details.recipeId !== "upscayl-4x-png-v1"
  )
    invalid();
  hex(result.executionId, 32);
  hex(details.requestFingerprint, 64);
  hex(details.installationManifestSha256, 64);
  processFact(details.supervisor);
  processFact(details.engine);
  identifier(details.jobName);
  return freezeOwnerDescriptor(
    value as unknown as OwnerDescriptor,
    scope.target.launchTicket,
  );
}

function publicScope(
  value: JsonValue | undefined,
  scope: WindowsJournalScope,
  descriptor: OwnerDescriptor,
): void {
  const result = exact(value, ["target", "descriptor"]);
  if (
    !isDeepStrictEqual(target(result.target), scope.target) ||
    !isDeepStrictEqual(result.descriptor, descriptor)
  )
    invalid();
}

function readResult(value: JsonValue | undefined): JsonObject | null {
  const result = exact(value, ["status", "snapshot"]);
  if (result.status === "unknown") {
    if (result.snapshot !== null) invalid();
    return null;
  }
  if (result.status !== "existing") invalid();
  return object(result.snapshot);
}

function envelope(
  value: JsonObject,
  scope: WindowsJournalScope,
  descriptor: OwnerDescriptor,
  slot: string | null,
  reservation?: JsonObject,
): JsonObject {
  const result = exact(value, [
    "v",
    "kind",
    "scope",
    "executionId",
    "recordId",
    "rootIdentity",
    "reservationIdentity",
    "fileIdentity",
    "record",
  ]);
  if (
    result.v !== 1 ||
    result.kind !== (slot === null ? "reservation" : "record") ||
    hex(result.executionId, 32) !== descriptor.executionId ||
    !isDeepStrictEqual(journalScope(result.scope), scope) ||
    result.recordId !== slot
  )
    invalid();
  fileIdentity(result.rootIdentity);
  fileIdentity(result.reservationIdentity);
  fileIdentity(result.fileIdentity);
  if (
    reservation &&
    (!isDeepStrictEqual(result.rootIdentity, reservation.rootIdentity) ||
      !isDeepStrictEqual(
        result.reservationIdentity,
        reservation.reservationIdentity,
      ))
  )
    invalid();
  if (slot === null) {
    if (result.record !== null) invalid();
  } else if (object(result.record).recordId !== slot) invalid();
  return result;
}

function requestRecord(
  value: JsonValue | undefined,
  descriptor: OwnerDescriptor,
): string {
  const result = exact(value, [
    "v",
    "kind",
    "recordId",
    "requestFingerprint",
    "requestUtf8Base64",
    "resolvedLaunch",
  ]);
  const fingerprint = hex(result.requestFingerprint, 64);
  if (
    result.v !== 1 ||
    result.kind !== "windows-request" ||
    result.recordId !== slots.request ||
    fingerprint !== descriptor.details.requestFingerprint
  )
    invalid();
  const base64 = text(result.requestUtf8Base64);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== base64) invalid();
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (createHash("sha256").update(bytes).digest("hex") !== fingerprint)
    invalid();
  const launch = exact(result.resolvedLaunch, [
    "recipeId",
    "installationManifestSha256",
    "executablePath",
    "argv",
  ]);
  if (
    launch.recipeId !== descriptor.details.recipeId ||
    hex(launch.installationManifestSha256, 64) !==
      descriptor.details.installationManifestSha256
  )
    invalid();
  const executable = text(launch.executablePath);
  if (
    !executable ||
    executable.includes("\u0000") ||
    !Array.isArray(launch.argv)
  )
    invalid();
  for (const arg of launch.argv) if (text(arg).includes("\u0000")) invalid();
  return fingerprint;
}

function preparedRecord(
  value: JsonValue | undefined,
  scope: WindowsJournalScope,
  descriptor: OwnerDescriptor,
  fingerprint: string,
): void {
  const result = exact(value, [
    "v",
    "kind",
    "recordId",
    "requestRecordId",
    "requestFingerprint",
    "scope",
  ]);
  if (
    result.v !== 1 ||
    result.kind !== "windows-prepared" ||
    result.recordId !== slots.prepared ||
    result.requestRecordId !== slots.request ||
    result.requestFingerprint !== fingerprint
  )
    invalid();
  publicScope(result.scope, scope, descriptor);
}

function authorizationRecord(
  value: JsonValue | undefined,
  scope: WindowsJournalScope,
  descriptor: OwnerDescriptor,
): JsonObject {
  const result = exact(value, ["v", "recordId", "scope", "kind"]);
  if (
    result.v !== 1 ||
    result.recordId !== slots.authorization ||
    result.kind !== "authorized"
  )
    invalid();
  publicScope(result.scope, scope, descriptor);
  return result;
}

function controllerLossRecord(
  value: JsonValue | undefined,
  scope: WindowsJournalScope,
  descriptor: OwnerDescriptor,
): JsonObject {
  const result = exact(value, [
    "v",
    "recordId",
    "scope",
    "kind",
    "authorizationRecordId",
  ]);
  if (
    result.v !== 1 ||
    result.recordId !== slots.controllerLoss ||
    result.kind !== "controller-lost" ||
    result.authorizationRecordId !== slots.authorization
  )
    invalid();
  publicScope(result.scope, scope, descriptor);
  return result;
}

function privateTerminal(
  value: JsonObject,
  scope: WindowsJournalScope,
  descriptor: OwnerDescriptor,
  fingerprint: string,
): WindowsJournalInterpretation {
  const result = exact(value, [
    "v",
    "kind",
    "recordId",
    "scope",
    "requestRecordId",
    "requestFingerprint",
    "preparedRecordId",
    "descriptor",
    "authorizationRecordId",
    "resumeState",
    "completion",
    "proof",
    "authorizationsSealed",
  ]);
  const kind = exact(result.completion, ["kind"]).kind;
  if (
    result.v !== 1 ||
    result.kind !== "windows-terminal" ||
    result.recordId !== slots.terminal ||
    !isDeepStrictEqual(journalScope(result.scope), scope) ||
    result.requestRecordId !== slots.request ||
    result.requestFingerprint !== fingerprint ||
    result.preparedRecordId !== slots.prepared ||
    !isDeepStrictEqual(result.descriptor, descriptor) ||
    result.authorizationRecordId !== slots.authorization ||
    result.resumeState !== "succeeded" ||
    result.authorizationsSealed !== true ||
    (kind !== "engine-exit" && kind !== "stop" && kind !== "deadline")
  )
    invalid();
  const proof = exact(result.proof, [
    "kind",
    "engine",
    "jobName",
    "exitCode",
    "treeExited",
    "activeProcesses",
    "stdoutEof",
    "stderrEof",
  ]);
  if (
    proof.kind !== "engine-tree" ||
    !isDeepStrictEqual(processFact(proof.engine), descriptor.details.engine) ||
    identifier(proof.jobName) !== descriptor.details.jobName ||
    proof.treeExited !== true ||
    integer(proof.activeProcesses, 0, 0) !== 0 ||
    proof.stdoutEof !== true ||
    proof.stderrEof !== true
  )
    invalid();
  const exitCode = integer(proof.exitCode, 0, uint32Max);
  const exit = freezeExecutionExit(
    {
      identity: scope.target.identity,
      descriptor,
      launchTicket: scope.target.launchTicket,
      treeExited: true,
      ...(kind === "engine-exit"
        ? {
            completion:
              exitCode === 0
                ? { kind: "success", exitCode: 0, signal: null }
                : { kind: "failure", exitCode, signal: null },
          }
        : {}),
    },
    scope.target,
    descriptor,
  );
  return Object.freeze({ kind, exit });
}

function interrupted(
  value: JsonObject,
  authorization: JsonObject,
  loss: JsonObject,
  scope: WindowsJournalScope,
  descriptor: OwnerDescriptor,
): WindowsJournalInterpretation {
  const terminal = exact(value, [
    "v",
    "recordId",
    "scope",
    "kind",
    "completion",
    "authorizationRecordId",
    "controllerLossRecordId",
    "treeExited",
    "authorizationsSealed",
  ]);
  publicScope(terminal.scope, scope, descriptor);
  const records = freezeDurableInterruptionRecords(
    {
      authorization,
      controllerLoss: loss,
      terminal,
    } as unknown as DurableInterruptionRecords,
    { target: scope.target, descriptor },
  );
  const exit = freezeExecutionExit(
    {
      identity: scope.target.identity,
      descriptor,
      launchTicket: scope.target.launchTicket,
      treeExited: true,
      completion: {
        kind: "interrupted",
        authorizationRecordId: records.authorization.recordId,
        controllerLossRecordId: records.controllerLoss.recordId,
        terminalRecordId: records.terminal.recordId,
      },
    },
    scope.target,
    descriptor,
  );
  return Object.freeze({ kind: "interrupted", exit, records });
}

export function interpretWindowsJournalSnapshot(
  snapshot: unknown,
  expectedScope: WindowsJournalScope,
  originalDescriptor: OwnerDescriptor,
): WindowsJournalInterpretation {
  try {
    const scope = journalScope(copyJson(expectedScope));
    const descriptor = windowsDescriptor(copyJson(originalDescriptor), scope);
    const response = exact(copyJson(snapshot), [
      "v",
      "kind",
      "reservation",
      "records",
    ]);
    if (response.v !== 1 || response.kind !== "windows-journal-snapshot")
      invalid();
    const raw = exact(response.records, [
      "request",
      "prepared",
      "authorization",
      "controllerLoss",
      "terminal",
    ]);
    const reserved = readResult(response.reservation);
    if (!reserved) return unknownInterpretation;
    const reservation = envelope(reserved, scope, descriptor, null);
    const records = {} as Record<Slot, JsonObject | null>;
    for (const slot of Object.keys(slots) as Slot[]) {
      const read = readResult(raw[slot]);
      records[slot] = read
        ? envelope(read, scope, descriptor, slots[slot], reservation)
        : null;
    }
    const { request, prepared, authorization, controllerLoss, terminal } =
      records;
    if (!request || !prepared || !authorization || !terminal)
      return unknownInterpretation;
    const fingerprint = requestRecord(request.record, descriptor);
    preparedRecord(prepared.record, scope, descriptor, fingerprint);
    const auth = authorizationRecord(authorization.record, scope, descriptor);
    // Existing malformed loss is an invalid history, not an optional missing slot.
    const loss = controllerLoss
      ? controllerLossRecord(controllerLoss.record, scope, descriptor)
      : null;
    const last = object(terminal.record);
    if (last.kind === "windows-terminal") {
      if (loss) return unknownInterpretation;
      return privateTerminal(last, scope, descriptor, fingerprint);
    }
    if (last.kind !== "terminal" || !loss) return unknownInterpretation;
    return interrupted(last, auth, loss, scope, descriptor);
  } catch {
    return unknownInterpretation;
  }
}
