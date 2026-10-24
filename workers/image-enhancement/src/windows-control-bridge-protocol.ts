import { constants as bufferConstants } from "node:buffer";
import { win32 } from "node:path";
import { types } from "node:util";

import { createScanner, ScanError, SyntaxKind, visit } from "jsonc-parser";

import {
  validIdentifier,
  type ExecutionSendGuard,
  type ExecutionStopRequest,
  type ExecutionTarget,
  type OwnerDescriptor,
} from "./execution.js";
import type { FrozenWindowsRequest } from "./windows-prepare-payload.js";

export type WindowsControlBridgeLimits = Readonly<{
  maxRequestFrameBytes: number;
  maxResponseFrameBytes: number;
  maxHelperStderrBytes: number;
  maxSessionInputBytes: number;
  maxSessionOutputBytes: number;
  maxQueuedOutputBytes: number;
  maxJsonDepth: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  sessionTimeoutMs: number;
  cleanupTimeoutMs: number;
}>;

export type WindowsControlBridgeOptions = Readonly<{
  executablePath: string;
  helperPath: string;
  recordsRoot: string;
  installationRoot: string;
  expectedManifestSha256: string;
  environment: Readonly<Record<string, string>>;
  limits: WindowsControlBridgeLimits;
}>;

type ObservationProcess = Readonly<{ pid: number; creationFileTime: string }>;
type ObservationToken = Readonly<{ userSid: string; sessionId: number }>;
type ObservationUnknown = Readonly<{
  state: "unknown";
  reason:
    | "unsupported"
    | "unavailable"
    | "permission"
    | "identity"
    | "no-match"
    | "incomplete"
    | "deadline";
}>;
type ObservationDevice = Readonly<{
  nvmlIndex: number;
  name: string;
  uuid: string | null;
  graphics: boolean;
  compute: boolean;
}>;
export type WindowsRuntimeObservation = Readonly<{
  v: 1;
  background:
    | Readonly<{
        state: "observed";
        host: ObservationProcess;
        worker: ObservationProcess & ObservationToken;
      }>
    | ObservationUnknown
    | null;
  engine:
    | Readonly<{
        state: "observed";
        process: ObservationProcess & ObservationToken;
      }>
    | ObservationUnknown
    | null;
  gpu:
    | Readonly<{ state: "not-started" | "pending" }>
    | ObservationUnknown
    | Readonly<{
        state: "observed";
        driverVersion: string;
        devices: readonly ObservationDevice[];
      }>;
}>;
export type WindowsRuntimeObservationReceipt = Readonly<{
  descriptor: OwnerDescriptor;
  observation: WindowsRuntimeObservation;
}>;

export type WindowsControlBridgeSnapshot = Readonly<{
  phase:
    | "unclaimed"
    | "claimed"
    | "preparing"
    | "prepared"
    | "authorizing"
    | "running"
    | "sealed"
    | "unknown"
    | "terminal";
  sealReason:
    | null
    | "stop"
    | "controller_exit"
    | "controller_eof"
    | "control_write_failure"
    | "evidence-unknown"
    | "deadline"
    | "launch-failure"
    | "engine-exit";
  requestFingerprint: string | null;
  descriptor: OwnerDescriptor | null;
  authorizationVerified: boolean;
  resumeState: "not-attempted" | "uncertain" | "succeeded";
  evidenceOutcome: "pending" | "unknown" | "verified";
  completion:
    | null
    | "interrupted"
    | "unauthorized-cleanup"
    | "launch-failure"
    | "stop"
    | "deadline"
    | "engine-exit";
  runtimeObservation?: WindowsRuntimeObservation | null;
}>;

export type WindowsControlBridgeBinding = Readonly<{
  executionId: string;
  bridge: Readonly<{ pid: number; creationFileTime: string }>;
  helper: Readonly<{ pid: number; creationFileTime: string }>;
  state: WindowsControlBridgeSnapshot;
}>;

export type WindowsControlBridgeUnknown = Readonly<{
  kind: "unknown";
  cleanup: "closed" | "unknown";
  prepareDiagnostic?: WindowsPrepareDiagnostic;
}>;
export type WindowsPrepareDiagnostic = Readonly<{
  prepareStage: string;
  nativeStage: string | null;
  nativeErrorCode: number | null;
}>;
export type WindowsControlBridgeOpenResult =
  | Readonly<{ kind: "bound"; binding: WindowsControlBridgeBinding }>
  | WindowsControlBridgeUnknown;
export type WindowsControlBridgeInspectResult =
  | Readonly<{ kind: "state"; state: WindowsControlBridgeSnapshot }>
  | Readonly<{ kind: "busy" }>
  | WindowsControlBridgeUnknown;
export type WindowsControlBridgeCloseResult =
  | Readonly<{
      kind: "stopped";
      cleanup: "closed";
      runtimeObservation?: WindowsRuntimeObservationReceipt;
    }>
  | WindowsControlBridgeUnknown;
export type WindowsControlBridgeHost = Readonly<{
  open(
    signal: AbortSignal,
    stillCurrent: () => boolean,
  ): Promise<WindowsControlBridgeOpenResult>;
  inspect(
    signal: AbortSignal,
    stillCurrent: () => boolean,
  ): Promise<WindowsControlBridgeInspectResult>;
  prepare(
    request: FrozenWindowsRequest,
    expected: Readonly<{
      target: ExecutionTarget;
      executionPolicyFingerprint: string;
    }>,
    guard: ExecutionSendGuard,
  ): Promise<
    | Readonly<{ kind: "prepared"; descriptor: OwnerDescriptor }>
    | WindowsControlBridgeUnknown
  >;
  authorize(
    target: ExecutionTarget,
    descriptor: OwnerDescriptor,
    requestFingerprint: string,
    guard: ExecutionSendGuard,
  ): Promise<Readonly<{ kind: "authorized" }> | WindowsControlBridgeUnknown>;
  requestStop(
    target: ExecutionTarget,
    descriptor: OwnerDescriptor,
    request: ExecutionStopRequest,
    guard: ExecutionSendGuard,
  ): Promise<
    Readonly<{ kind: "stop-requested" }> | WindowsControlBridgeUnknown
  >;
  whenClosed(): Promise<WindowsControlBridgeCloseResult>;
  close(): Promise<WindowsControlBridgeCloseResult>;
}>;

export type WindowsControlBridgeResponse =
  | Readonly<{ v: 1; kind: "bound" } & WindowsControlBridgeBinding>
  | Readonly<{
      v: 1;
      kind: "permit-request";
      requestId: string;
      op: "prepare" | "authorize" | "request-stop";
      executionId: string;
      requestFingerprint: string;
    }>
  | Readonly<{ v: 1; kind: "ending"; executionId: string }>
  | Readonly<{
      v: 1;
      kind: "state";
      requestId: string | null;
      executionId: string;
      state: WindowsControlBridgeSnapshot;
    }>
  | Readonly<{
      v: 1;
      kind: "unknown";
      requestId: string | null;
      executionId: string | null;
      prepareDiagnostic?: WindowsPrepareDiagnostic;
    }>
  | Readonly<{
      v: 1;
      kind: "closed";
      requestId: string | null;
      executionId: string | null;
      outcome: "stopped" | "unknown";
    }>;

const optionKeys = [
  "executablePath",
  "helperPath",
  "recordsRoot",
  "installationRoot",
  "expectedManifestSha256",
  "environment",
  "limits",
] as const;
const limitKeys = [
  "maxRequestFrameBytes",
  "maxResponseFrameBytes",
  "maxHelperStderrBytes",
  "maxSessionInputBytes",
  "maxSessionOutputBytes",
  "maxQueuedOutputBytes",
  "maxJsonDepth",
  "startupTimeoutMs",
  "requestTimeoutMs",
  "sessionTimeoutMs",
  "cleanupTimeoutMs",
] as const;
const snapshotKeys = [
  "phase",
  "sealReason",
  "requestFingerprint",
  "descriptor",
  "authorizationVerified",
  "resumeState",
  "evidenceOutcome",
  "completion",
] as const;
const sealReasons = [
  "stop",
  "controller_exit",
  "controller_eof",
  "control_write_failure",
  "deadline",
  "launch-failure",
  "engine-exit",
  "evidence-unknown",
];
const isWellFormed = (
  String.prototype as unknown as { isWellFormed(this: string): boolean }
).isWellFormed;

function invalid(): never {
  throw new Error("invalid Windows control bridge data");
}

function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    invalid();
  return value as Record<string, unknown>;
}

function own(source: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(source, key);
  if (!property || !("value" in property) || !property.enumerable) invalid();
  return property.value;
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const source = object(value);
  const actual = Reflect.ownKeys(source);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    invalid();
  for (const key of keys) own(source, key);
  return source;
}

const prepareStages = new Set([
  "deadline", "installation_open", "arguments", "reservation", "request_record",
  "request_publish", "job_prepare", "job_streams", "job_inspect", "descriptor",
  "prepared_publish", "runtime_observation",
]);
const prepareNativeStages = new Set([
  "installation_root", "installation_manifest", "binary_binding", "model_binding",
  "engine_payload", "model_set", "model_payload", "installation_verify",
  "parent_identity", "file_alias", "file_identity", "payload_length", "payload_read",
  "payload_hash", "manifest_hash", "model_set_hash", "manifest_recipe",
  "manifest_version", "manifest_entry", "manifest_model", "model_name", "model_pair",
  "manifest_file", "json_object", "json_keys", "json_type", "json_array", "path_invalid",
  "marker_create", "marker_content", "reservation_history", "marker_identity",
  "temp_create", "publication_identity", "publication_content", "envelope_invalid",
  "envelope_execution", "envelope_identity", "envelope_scope", "json_duplicate",
  "json_invalid", "native_failure", "journal_evidence", "root_path", "current_user",
  "volume_not_fixed", "volume_mapping", "ancestor_identity", "directory_open",
  "file_open", "source_parent", "io_identity", "root_identity", "handle_noninheritance",
  "file_type", "file_ordinary", "file_security", "volume_ntfs_acl", "final_path",
  "file_write_incomplete", "file_read_incomplete", "file_read_changed", "rename_leaf",
  "rename_layout", "rename_wait", "rename_completion", "file_rename", "renamed_identity",
  "CreateJobObjectW", "SetInformationJobObject(limits)", "CreateIoCompletionPort",
  "SetInformationJobObject(completion-port)", "CreatePipe", "CreateProcessW",
  "IsProcessInJob", "GetProcessTimes", "GetProcessId", "QueryInformationJobObject",
  "WaitForSingleObject", "InitializeProcThreadAttributeList(size)",
  "InitializeProcThreadAttributeList", "UpdateProcThreadAttribute",
  "GetHandleInformation", "SetHandleInformation", "file_attributes", "file_flush",
  "file_standard", "file_write", "record_attempt_uncertain", "record_replay_mismatch",
  "volume_information",
]);

export function freezeWindowsPrepareDiagnostic(value: unknown): WindowsPrepareDiagnostic {
  const source = exact(value, ["prepareStage", "nativeStage", "nativeErrorCode"]);
  const prepareStage = own(source, "prepareStage");
  const nativeStage = own(source, "nativeStage");
  const nativeErrorCode = own(source, "nativeErrorCode");
  if (
    typeof prepareStage !== "string" || !prepareStages.has(prepareStage) ||
    (nativeStage !== null && (typeof nativeStage !== "string" || !prepareNativeStages.has(nativeStage))) ||
    (nativeErrorCode !== null && (typeof nativeErrorCode !== "number" ||
      !Number.isInteger(nativeErrorCode) || nativeErrorCode < -2_147_483_648 || nativeErrorCode > 2_147_483_647))
  ) invalid();
  return Object.freeze({ prepareStage, nativeStage, nativeErrorCode });
}

function unicode(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isWellFormed.call(value) ||
    value.includes("\u0000")
  )
    invalid();
  return value;
}

function localPath(value: unknown, executable = false): string {
  const path = unicode(value);
  if (
    !/^[A-Za-z]:[\\/]/.test(path) ||
    !win32.isAbsolute(path) ||
    (executable && win32.extname(path).toLowerCase() !== ".exe")
  )
    invalid();
  return path;
}

function hex(value: unknown, length: number): string {
  const text = unicode(value);
  if (text.length !== length || !/^[a-f0-9]+$/.test(text)) invalid();
  return text;
}

function nullableId(value: unknown): string | null {
  return value === null ? null : hex(value, 32);
}

export function freezeWindowsControlBridgeOptions(
  options: WindowsControlBridgeOptions,
): WindowsControlBridgeOptions {
  try {
    if (process.platform !== "win32") invalid();
    const source = exact(options, optionKeys);
    const rawLimits = exact(own(source, "limits"), limitKeys);
    const limits = Object.fromEntries(
      limitKeys.map((key) => {
        const value = own(rawLimits, key);
        const maximum = key.endsWith("Bytes")
          ? Math.min(bufferConstants.MAX_LENGTH, 0x7fffffc7)
          : 0x7fffffff;
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value <= 0 ||
          value > maximum
        )
          invalid();
        return [key, value];
      }),
    ) as WindowsControlBridgeLimits;
    if (
      limits.maxJsonDepth < 2 ||
      limits.maxRequestFrameBytes > limits.maxSessionInputBytes ||
      limits.maxResponseFrameBytes > limits.maxSessionOutputBytes ||
      limits.maxResponseFrameBytes > limits.maxQueuedOutputBytes
    )
      invalid();
    const rawEnvironment = object(own(source, "environment"));
    const names = new Set<string>();
    const environment = Object.fromEntries(
      Reflect.ownKeys(rawEnvironment).map((key) => {
        const name = unicode(key);
        if (!name || name.includes("=") || names.has(name.toUpperCase()))
          invalid();
        names.add(name.toUpperCase());
        return [name, unicode(own(rawEnvironment, name))];
      }),
    );
    return Object.freeze({
      executablePath: localPath(own(source, "executablePath"), true),
      helperPath: localPath(own(source, "helperPath"), true),
      recordsRoot: localPath(own(source, "recordsRoot")),
      installationRoot: localPath(own(source, "installationRoot")),
      expectedManifestSha256: hex(own(source, "expectedManifestSha256"), 64),
      environment: Object.freeze(environment),
      limits: Object.freeze(limits),
    });
  } catch {
    throw new Error("invalid Windows control bridge configuration");
  }
}

// The library's iterative scanner bounds depth before its recursive visitor.
// Malformed strings/comments cannot hide nesting from a separate hand lexer.
function checkDepth(document: string, maximum: number): void {
  const scanner = createScanner(document);
  let depth = 0;
  for (
    let token = scanner.scan();
    token !== SyntaxKind.EOF;
    token = scanner.scan()
  ) {
    if (
      scanner.getTokenError() !== ScanError.None ||
      token === SyntaxKind.Unknown ||
      token === SyntaxKind.LineCommentTrivia ||
      token === SyntaxKind.BlockCommentTrivia
    )
      invalid();
    if (
      token === SyntaxKind.OpenBraceToken ||
      token === SyntaxKind.OpenBracketToken
    ) {
      if (++depth > maximum) invalid();
    } else if (
      token === SyntaxKind.CloseBraceToken ||
      token === SyntaxKind.CloseBracketToken
    ) {
      if (--depth < 0) invalid();
    }
  }
  if (depth !== 0 || scanner.getTokenError() !== ScanError.None) invalid();
}

function identifier(value: unknown): string {
  const text = unicode(value);
  if (!validIdentifier(text)) invalid();
  return text;
}

type Scalars = Map<string, string>;
function positive(
  value: unknown,
  path: readonly string[],
  scalars?: Scalars,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum ||
    (scalars && !/^[1-9][0-9]*$/.test(scalars.get(JSON.stringify(path)) ?? ""))
  )
    invalid();
  return value;
}

function target(
  value: unknown,
  path: readonly string[] = [],
  scalars?: Scalars,
): ExecutionTarget {
  const source = exact(value, ["identity", "launchTicket"]);
  const identity = exact(source.identity, [
    "jobId",
    "attemptNo",
    "ownerInstanceId",
    "fence",
  ]);
  return Object.freeze({
    identity: Object.freeze({
      jobId: identifier(identity.jobId),
      attemptNo: positive(
        identity.attemptNo,
        [...path, "identity", "attemptNo"],
        scalars,
      ),
      ownerInstanceId: identifier(identity.ownerInstanceId),
      fence: positive(identity.fence, [...path, "identity", "fence"], scalars),
    }),
    launchTicket: identifier(source.launchTicket),
  });
}

export function freezeWindowsControlBridgeTarget(
  value: ExecutionTarget,
): ExecutionTarget {
  return target(value);
}

export function freezeWindowsControlBridgeStopRequest(
  value: ExecutionStopRequest,
): ExecutionStopRequest {
  const source = exact(value, ["mode", "stopRequestedAt", "terminateAfterAt"]);
  const mode = own(source, "mode"),
    stopRequestedAt = own(source, "stopRequestedAt"),
    terminateAfterAt = own(source, "terminateAfterAt");
  if (
    (mode !== "soft" && mode !== "force") ||
    typeof stopRequestedAt !== "number" ||
    typeof terminateAfterAt !== "number" ||
    !Number.isSafeInteger(stopRequestedAt) ||
    Object.is(stopRequestedAt, -0) ||
    stopRequestedAt < 0 ||
    !Number.isSafeInteger(terminateAfterAt) ||
    Object.is(terminateAfterAt, -0) ||
    terminateAfterAt <= stopRequestedAt
  )
    invalid();
  return Object.freeze({ mode, stopRequestedAt, terminateAfterAt });
}

function processIdentity(
  value: unknown,
  path: readonly string[],
  scalars?: Scalars,
) {
  const source = exact(value, ["pid", "creationFileTime"]);
  const time = unicode(source.creationFileTime);
  if (!/^[1-9][0-9]*$/.test(time) || BigInt(time) > 0xffffffffffffffffn)
    invalid();
  return Object.freeze({
    pid: positive(source.pid, [...path, "pid"], scalars, 0xffffffff),
    creationFileTime: time,
  });
}

function descriptor(
  value: unknown,
  path: readonly string[] = [],
  scalars?: Scalars,
): OwnerDescriptor {
  const source = exact(value, [
    "adapterId",
    "launchTicket",
    "executionId",
    "details",
  ]);
  const details = exact(source.details, [
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
  const scope = target(details.target, [...path, "details", "target"], scalars);
  if (
    source.adapterId !== "windows-supervisor-v1" ||
    source.launchTicket !== scope.launchTicket ||
    details.v !== 1 ||
    (scalars &&
      scalars.get(JSON.stringify([...path, "details", "v"])) !== "1") ||
    details.requestRecordId !== "00000000000000000000000000000001" ||
    details.preparedRecordId !== "00000000000000000000000000000002" ||
    details.recipeId !== "upscayl-4x-png-v1"
  )
    invalid();
  return Object.freeze({
    adapterId: "windows-supervisor-v1",
    launchTicket: scope.launchTicket,
    executionId: hex(source.executionId, 32),
    details: Object.freeze({
      v: 1,
      target: scope,
      executionPolicyFingerprint: hex(details.executionPolicyFingerprint, 64),
      requestFingerprint: hex(details.requestFingerprint, 64),
      requestRecordId: details.requestRecordId,
      preparedRecordId: details.preparedRecordId,
      recipeId: details.recipeId,
      installationManifestSha256: hex(details.installationManifestSha256, 64),
      supervisor: processIdentity(
        details.supervisor,
        [...path, "details", "supervisor"],
        scalars,
      ),
      engine: processIdentity(
        details.engine,
        [...path, "details", "engine"],
        scalars,
      ),
      jobName: identifier(details.jobName),
    }),
  });
}

export function freezeWindowsControlBridgeDescriptor(
  value: OwnerDescriptor,
): OwnerDescriptor {
  return descriptor(value);
}

function unsigned(
  value: unknown,
  path: readonly (string | number)[],
  scalars: Scalars,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0 ||
    value > 0xffffffff ||
    !/^(0|[1-9][0-9]*)$/.test(scalars.get(JSON.stringify(path)) ?? "")
  )
    invalid();
  return value;
}

function userSid(value: unknown): string {
  const text = unicode(value);
  const parts = text.split("-");
  if (
    parts[0] !== "S" ||
    parts[1] !== "1" ||
    parts.length < 3 ||
    parts.length > 18 || // SID revision 1 has at most 15 subauthorities.
    parts.slice(2).some((part) => !/^(0|[1-9][0-9]*)$/.test(part)) ||
    BigInt(parts[2]!) > 0xffffffffffffn ||
    parts.slice(3).some((part) => BigInt(part) > 0xffffffffn)
  )
    invalid();
  return text;
}

function observationProcess(
  value: unknown,
  path: readonly string[],
  scalars: Scalars,
): ObservationProcess & ObservationToken {
  const source = exact(value, [
    "pid",
    "creationFileTime",
    "userSid",
    "sessionId",
  ]);
  const sessionId = unsigned(source.sessionId, [...path, "sessionId"], scalars);
  if (sessionId !== 0) invalid();
  return Object.freeze({
    ...processIdentity(
      { pid: source.pid, creationFileTime: source.creationFileTime },
      path,
      scalars,
    ),
    userSid: userSid(source.userSid),
    sessionId,
  });
}

function observationUnknown(value: unknown): ObservationUnknown {
  const source = exact(value, ["state", "reason"]);
  const reason = unicode(source.reason);
  if (
    source.state !== "unknown" ||
    ![
      "unsupported",
      "unavailable",
      "permission",
      "identity",
      "no-match",
      "incomplete",
      "deadline",
    ].includes(reason)
  )
    invalid();
  return Object.freeze({
    state: "unknown",
    reason: reason as ObservationUnknown["reason"],
  });
}

function backgroundObservation(
  value: unknown,
  scalars: Scalars,
): WindowsRuntimeObservation["background"] {
  if (value === null) return null;
  const source = object(value);
  if (own(source, "state") === "unknown") return observationUnknown(source);
  exact(source, ["state", "host", "worker"]);
  if (source.state !== "observed") invalid();
  return Object.freeze({
    state: "observed",
    host: processIdentity(
      source.host,
      ["state", "runtimeObservation", "background", "host"],
      scalars,
    ),
    worker: observationProcess(
      source.worker,
      ["state", "runtimeObservation", "background", "worker"],
      scalars,
    ),
  });
}

function engineObservation(
  value: unknown,
  owner: OwnerDescriptor,
  scalars: Scalars,
): WindowsRuntimeObservation["engine"] {
  if (value === null) return null;
  const source = object(value);
  if (own(source, "state") === "unknown") return observationUnknown(source);
  exact(source, ["state", "process"]);
  if (source.state !== "observed") invalid();
  const process = observationProcess(
    source.process,
    ["state", "runtimeObservation", "engine", "process"],
    scalars,
  );
  const original = owner.details.engine as ObservationProcess;
  if (
    process.pid !== original.pid ||
    process.creationFileTime !== original.creationFileTime
  )
    invalid();
  return Object.freeze({ state: "observed", process });
}

function gpuObservation(
  value: unknown,
  scalars: Scalars,
): WindowsRuntimeObservation["gpu"] {
  const source = object(value);
  const state = own(source, "state");
  if (state === "unknown") return observationUnknown(source);
  if (state === "not-started" || state === "pending") {
    exact(source, ["state"]);
    return Object.freeze({ state });
  }
  exact(source, ["state", "driverVersion", "devices"]);
  if (
    state !== "observed" ||
    !Array.isArray(source.devices) ||
    !source.devices.length
  )
    invalid();
  let previous = -1;
  const devices = source.devices.map((value, index): ObservationDevice => {
    const device = exact(value, [
      "nvmlIndex",
      "name",
      "uuid",
      "graphics",
      "compute",
    ]);
    const nvmlIndex = unsigned(
      device.nvmlIndex,
      ["state", "runtimeObservation", "gpu", "devices", index, "nvmlIndex"],
      scalars,
    );
    if (
      nvmlIndex <= previous ||
      typeof device.graphics !== "boolean" ||
      typeof device.compute !== "boolean" ||
      (!device.graphics && !device.compute)
    )
      invalid();
    previous = nvmlIndex;
    return Object.freeze({
      nvmlIndex,
      name: unicode(device.name),
      uuid: device.uuid === null ? null : unicode(device.uuid),
      graphics: device.graphics,
      compute: device.compute,
    });
  });
  return Object.freeze({
    state: "observed",
    driverVersion: unicode(source.driverVersion),
    devices: Object.freeze(devices),
  });
}

function runtimeObservation(
  value: unknown,
  owner: OwnerDescriptor,
  scalars: Scalars,
): WindowsRuntimeObservation {
  const source = exact(value, ["v", "background", "engine", "gpu"]);
  if (
    source.v !== 1 ||
    scalars.get('["state","runtimeObservation","v"]') !== "1"
  )
    invalid();
  const background = backgroundObservation(source.background, scalars);
  const engine = engineObservation(source.engine, owner, scalars);
  if (
    background?.state === "observed" &&
    engine?.state === "observed" &&
    background.worker.userSid !== engine.process.userSid
  )
    invalid();
  return Object.freeze({
    v: 1,
    background,
    engine,
    gpu: gpuObservation(source.gpu, scalars),
  });
}

function snapshot(
  value: unknown,
  scalars: Scalars,
  executionId: string,
): WindowsControlBridgeSnapshot {
  const hasObservation = Object.hasOwn(object(value), "runtimeObservation");
  const state = exact(
    value,
    hasObservation ? [...snapshotKeys, "runtimeObservation"] : snapshotKeys,
  );
  const phase = unicode(state.phase);
  const evidence = unicode(state.evidenceOutcome);
  const reason = state.sealReason === null ? null : unicode(state.sealReason);
  const fingerprint =
    state.requestFingerprint === null
      ? null
      : hex(state.requestFingerprint, 64);
  const owner =
    state.descriptor === null
      ? null
      : descriptor(state.descriptor, ["state", "descriptor"], scalars);
  const authorized = state.authorizationVerified;
  const resume = unicode(state.resumeState);
  const completion =
    state.completion === null ? null : unicode(state.completion);
  if (
    typeof authorized !== "boolean" ||
    !["not-attempted", "uncertain", "succeeded"].includes(resume) ||
    (owner &&
      (owner.executionId !== executionId ||
        owner.details.requestFingerprint !== fingerprint)) ||
    ((authorized || resume !== "not-attempted") && (!owner || !fingerprint)) ||
    (resume !== "not-attempted" && !authorized)
  )
    invalid();
  if (
    (reason === "engine-exit" && (!authorized || resume !== "succeeded")) ||
    ((reason === "deadline" || reason === "launch-failure") && !fingerprint)
  )
    invalid();
  const initial =
    (phase === "claimed" || phase === "unclaimed") &&
    reason === null &&
    evidence === "pending" &&
    fingerprint === null &&
    owner === null &&
    !authorized &&
    resume === "not-attempted" &&
    completion === null;
  const preparing =
    phase === "preparing" &&
    !!fingerprint &&
    !authorized &&
    resume === "not-attempted";
  const prepared =
    phase === "prepared" &&
    !!owner &&
    !authorized &&
    resume === "not-attempted";
  const authorizing =
    phase === "authorizing" && !!owner && resume === "not-attempted";
  const running =
    phase === "running" && !!owner && authorized && resume === "succeeded";
  const active =
    (preparing || prepared || authorizing || running) &&
    reason === null &&
    evidence === "pending" &&
    completion === null;
  const sealed =
    phase === "sealed" &&
    reason !== null &&
    sealReasons.includes(reason) &&
    reason !== "evidence-unknown" &&
    evidence === "pending" &&
    completion === null;
  const unknown =
    phase === "unknown" &&
    reason !== null &&
    sealReasons.includes(reason) &&
    evidence === "unknown" &&
    completion === null;
  const loss = [
    "controller_exit",
    "controller_eof",
    "control_write_failure",
  ].includes(reason ?? "");
  const terminal =
    phase === "terminal" &&
    !!fingerprint &&
    evidence === "verified" &&
    ((completion === "engine-exit" &&
      reason === "engine-exit" &&
      authorized &&
      resume === "succeeded") ||
      (completion === "interrupted" && loss && authorized) ||
      (completion === "unauthorized-cleanup" &&
        loss &&
        !authorized &&
        resume === "not-attempted") ||
      (completion === "launch-failure" && reason === "launch-failure") ||
      ((completion === "stop" || completion === "deadline") &&
        reason === completion));
  if (!initial && !active && !sealed && !unknown && !terminal) invalid();
  let observation: WindowsRuntimeObservation | null = null;
  if (hasObservation && state.runtimeObservation !== null) {
    if (!owner || !fingerprint) invalid();
    observation = runtimeObservation(state.runtimeObservation, owner, scalars);
  }
  return Object.freeze({
    ...state,
    descriptor: owner,
    runtimeObservation: observation,
  }) as WindowsControlBridgeSnapshot;
}

export function decodeWindowsControlBridgeResponse(
  bytes: Buffer,
  maxDepth: number,
): WindowsControlBridgeResponse {
  try {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length < 3 ||
      bytes[bytes.length - 1] !== 0x0a ||
      bytes.indexOf(0x0a) !== bytes.length - 1 ||
      bytes.includes(0x0d) ||
      (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
      !Number.isSafeInteger(maxDepth) ||
      maxDepth < 2 ||
      maxDepth > 0x7fffffff
    )
      invalid();
    const document = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes.subarray(0, -1));
    checkDepth(document, maxDepth);
    const containers: (Set<string> | null)[] = [];
    const scalars = new Map<string, string>();
    let failed = false;
    visit(
      document,
      {
        onObjectBegin() {
          containers.push(new Set());
        },
        onArrayBegin() {
          containers.push(null);
        },
        onObjectProperty(property) {
          unicode(property);
          const keys = containers[containers.length - 1];
          if (!keys || keys.has(property)) failed = true;
          keys?.add(property);
        },
        onObjectEnd() {
          containers.pop();
        },
        onArrayEnd() {
          containers.pop();
        },
        onLiteralValue(value, offset, length, _line, _column, path) {
          if (typeof value === "string") unicode(value);
          scalars.set(
            JSON.stringify(path()),
            document.slice(offset, offset + length),
          );
        },
        onError() {
          failed = true;
        },
      },
      {
        disallowComments: true,
        allowTrailingComma: false,
        allowEmptyContent: false,
      },
    );
    if (failed || containers.length) invalid();
    const value = object(JSON.parse(document) as unknown);
    if (scalars.get('["v"]') !== "1") invalid();
    const kind = unicode(value.kind);
    if (kind === "bound") {
      exact(value, ["v", "kind", "executionId", "bridge", "helper", "state"]);
      hex(value.executionId, 32);
      for (const role of ["bridge", "helper"] as const) {
        const identity = exact(value[role], ["pid", "creationFileTime"]);
        const rawPid = scalars.get(JSON.stringify([role, "pid"]));
        const time = unicode(identity.creationFileTime);
        if (
          !rawPid ||
          !/^[1-9][0-9]*$/.test(rawPid) ||
          typeof identity.pid !== "number" ||
          !Number.isInteger(identity.pid) ||
          identity.pid > 0xffffffff ||
          !/^[1-9][0-9]*$/.test(time) ||
          BigInt(time) > 0xffffffffffffffffn
        )
          invalid();
        Object.freeze(identity);
      }
      const state = snapshot(value.state, scalars, value.executionId as string);
      if (state.phase !== "claimed") invalid();
      value.state = state;
    } else if (kind === "state") {
      exact(value, ["v", "kind", "requestId", "executionId", "state"]);
      nullableId(value.requestId);
      hex(value.executionId, 32);
      value.state = snapshot(value.state, scalars, value.executionId as string);
    } else if (kind === "permit-request") {
      exact(value, [
        "v",
        "kind",
        "requestId",
        "op",
        "executionId",
        "requestFingerprint",
      ]);
      hex(value.requestId, 32);
      hex(value.executionId, 32);
      hex(value.requestFingerprint, 64);
      if (
        value.op !== "prepare" &&
        value.op !== "authorize" &&
        value.op !== "request-stop"
      )
        invalid();
    } else if (kind === "ending") {
      exact(value, ["v", "kind", "executionId"]);
      hex(value.executionId, 32);
    } else if (kind === "unknown" || kind === "closed") {
      const hasDiagnostic = kind === "unknown" && Object.hasOwn(value, "prepareDiagnostic");
      exact(
        value,
        kind === "unknown"
          ? ["v", "kind", "requestId", "executionId", ...(hasDiagnostic ? ["prepareDiagnostic"] : [])]
          : ["v", "kind", "requestId", "executionId", "outcome"],
      );
      nullableId(value.requestId);
      nullableId(value.executionId);
      if (hasDiagnostic) value.prepareDiagnostic = freezeWindowsPrepareDiagnostic(value.prepareDiagnostic);
      if (
        kind === "closed" &&
        value.outcome !== "stopped" &&
        value.outcome !== "unknown"
      )
        invalid();
    } else invalid();
    return Object.freeze(value) as WindowsControlBridgeResponse;
  } catch {
    throw new Error("invalid Windows control bridge response");
  }
}
