import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { createRunnerLimits, type RunnerLimits } from "./config.js";
import { EnhancementError } from "./contracts.js";
import type { JobDto } from "./store.js";

export type AttemptIdentity = Readonly<{
  jobId: string;
  attemptNo: number;
  ownerInstanceId: string;
  fence: number;
}>;

export type ExecutionTarget = Readonly<{
  identity: AttemptIdentity;
  launchTicket: string;
}>;

export type ExecutionPolicy = Readonly<{
  limits: RunnerLimits;
  allowedTiles: readonly number[];
  fingerprint: string;
}>;

export type ClaimedAttempt = Readonly<{
  identity: AttemptIdentity;
  job: JobDto;
  executionPolicy: ExecutionPolicy;
  firstStartedAt: number;
  executionDeadlineAt: number;
  leaseExpiresAt: number;
  launchTicket: string;
  inputPath: string;
  workingDirectory: string;
  outputPath: string;
  tile: number;
}>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type OwnerDescriptor = Readonly<{
  adapterId: string;
  launchTicket: string;
  executionId: string;
  details: Readonly<Record<string, JsonValue>>;
}>;

export type InterruptionReadScope = Readonly<{
  target: ExecutionTarget;
  descriptor: OwnerDescriptor;
}>;

type InterruptionRecordBase = Readonly<{
  v: 1;
  recordId: string;
  scope: InterruptionReadScope;
}>;

export type AuthorizationRecord = InterruptionRecordBase &
  Readonly<{ kind: "authorized" }>;

export type ControllerLossRecord = InterruptionRecordBase &
  Readonly<{
    kind: "controller-lost";
    authorizationRecordId: string;
  }>;

export type InterruptedTerminalRecord = InterruptionRecordBase &
  Readonly<{
    kind: "terminal";
    completion: "interrupted";
    authorizationRecordId: string;
    controllerLossRecordId: string;
    treeExited: true;
    authorizationsSealed: true;
  }>;

export type DurableInterruptionRecords = Readonly<{
  authorization: AuthorizationRecord;
  controllerLoss: ControllerLossRecord;
  terminal: InterruptedTerminalRecord;
}>;

export type InterruptionEvidenceReader = (
  scope: InterruptionReadScope,
  stillCurrent: () => boolean,
) => Promise<DurableInterruptionRecords | undefined>;

export type StopReason = "user_cancel" | "execution_timeout";

export type InterruptedCompletion = Readonly<{
  kind: "interrupted";
  authorizationRecordId: string;
  controllerLossRecordId: string;
  terminalRecordId: string;
}>;

export type CompletionEvidence =
  | Readonly<{ kind: "success"; exitCode: 0; signal: null }>
  | Readonly<{
      kind: "failure";
      exitCode: number | null;
      signal: string | null;
    }>
  | Readonly<{
      kind: "oom";
      exitCode: number | null;
      signal: string | null;
    }>
  | InterruptedCompletion;

export type ExecutionExit = Readonly<{
  identity: AttemptIdentity;
  descriptor: OwnerDescriptor;
  launchTicket: string;
  // Terminal proof seals every issued authorize for this identity/descriptor/ticket:
  // no delayed authorization can create another tree after this event.
  treeExited: true;
  completion?: CompletionEvidence;
}>;

export type ActiveAttempt = ClaimedAttempt &
  Readonly<{
    producer: AttemptIdentity;
    ownerDescriptor: OwnerDescriptor | null;
    preparedAt: number | null;
    authorizedAt: number | null;
    stopReason: StopReason | null;
    stopRequestedAt: number | null;
    terminateAfterAt: number | null;
    exit: ExecutionExit | null;
  }>;

export type RecoveryControl = Readonly<{
  recoveryId: string;
  ownerInstanceId: string;
  source: AttemptIdentity;
  publisher: AttemptIdentity;
  launchTicket: string;
}>;

export type RecoverySession = Readonly<{
  control: RecoveryControl;
  active: ActiveAttempt;
  target: ExecutionTarget;
  nextQueueDeadlineAt: number | null;
}>;

export type Inspection =
  | (ExecutionTarget &
      Readonly<{ kind: "owned-alive"; descriptor: OwnerDescriptor }>)
  | Readonly<{ kind: "tree-exited"; exit: ExecutionExit }>
  | (ExecutionTarget & Readonly<{ kind: "never-authorized" }>)
  | (ExecutionTarget & Readonly<{ kind: "unknown" }>);

export type RecoveryResolution =
  | Readonly<{ kind: "unknown" | "owned-alive"; session: RecoverySession }>
  | Readonly<{
      kind: "transferred";
      publisher: AttemptIdentity;
      startupEventId: string | null;
    }>;

export type ExecutionStopRequest = Readonly<{
  mode: "soft" | "force";
  stopRequestedAt: number;
  terminateAfterAt: number;
}>;

export type RecoveryStop = ExecutionStopRequest &
  Readonly<{
    target: ExecutionTarget;
    descriptor: OwnerDescriptor;
  }>;

export type StartupRecoveryOutcome =
  | Readonly<{ kind: "created"; attempt: ClaimedAttempt }>
  | Readonly<{ kind: "already-applied"; replacementAttemptNo: number }>;

export type Clock = Readonly<{
  now(): number;
  scheduleAt(at: number, callback: () => void): () => void;
}>;

export type ExecutionSendGuard = Readonly<{
  // Runner closure only; this signal is not a stop or terminal receipt.
  signal: AbortSignal;
  stillCurrent(): boolean;
  takeSendPermission(): boolean;
}>;

export type ExecutionAdapter = Readonly<{
  kind: "test" | "windows";
  readInterruptionEvidence?: InterruptionEvidenceReader;
  prepare(
    attempt: ClaimedAttempt,
    guard: ExecutionSendGuard,
  ): Promise<OwnerDescriptor>;
  authorize(
    attempt: ClaimedAttempt,
    descriptor: OwnerDescriptor,
    guard: ExecutionSendGuard,
  ): Promise<void>;
  inspect(
    target: ExecutionTarget,
    descriptor: OwnerDescriptor | null,
  ): Promise<Inspection>;
  requestStop(
    target: ExecutionTarget,
    descriptor: OwnerDescriptor,
    request: ExecutionStopRequest,
    guard: ExecutionSendGuard,
  ): Promise<void>;
  observeExit(
    target: ExecutionTarget,
    descriptor: OwnerDescriptor,
    listener: (exit: ExecutionExit) => void,
  ): () => void;
}>;

export function freezeExecutionPolicy(
  limits: RunnerLimits,
  allowedTiles: readonly number[],
): ExecutionPolicy {
  const controlled = {
    limits: createRunnerLimits(limits),
    allowedTiles: Object.freeze([...allowedTiles]),
  };
  return Object.freeze({
    ...controlled,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(controlled))
      .digest("hex"),
  });
}

export function freezeOwnerDescriptor(
  descriptor: OwnerDescriptor,
  launchTicket: string,
): OwnerDescriptor {
  try {
    if (
      !descriptor ||
      Object.getPrototypeOf(descriptor) !== Object.prototype ||
      Reflect.ownKeys(descriptor).length !== 4 ||
      !["adapterId", "launchTicket", "executionId", "details"].every((key) =>
        Object.hasOwn(descriptor, key),
      ) ||
      descriptor.launchTicket !== launchTicket ||
      !validIdentifier(descriptor.adapterId) ||
      !validIdentifier(descriptor.executionId) ||
      !descriptor.details ||
      Object.getPrototypeOf(descriptor.details) !== Object.prototype
    )
      throw new Error("invalid descriptor");
    const text = JSON.stringify(descriptor, function (key, value: unknown) {
      const source = (this as Record<string, unknown>)[key];
      if (source && typeof source === "object") {
        for (const field of Reflect.ownKeys(source)) {
          if (Array.isArray(source) && field === "length") continue;
          if (
            typeof field !== "string" ||
            !Object.prototype.propertyIsEnumerable.call(source, field)
          )
            throw new Error("unpersistable descriptor property");
        }
      }
      return value;
    });
    const copy = JSON.parse(text) as OwnerDescriptor;
    // JSON must preserve every reported fact rather than drop unsupported values.
    if (!isDeepStrictEqual(descriptor, copy))
      throw new Error("lossy descriptor");
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(copy);
    return copy;
  } catch {
    throw new EnhancementError("configuration_invalid");
  }
}

export function freezeExecutionExit(
  exit: ExecutionExit,
  target: ExecutionTarget,
  descriptor: OwnerDescriptor,
): ExecutionExit {
  try {
    const fields = ["identity", "descriptor", "launchTicket", "treeExited"];
    if (
      !exit ||
      Object.getPrototypeOf(exit) !== Object.prototype ||
      Reflect.ownKeys(exit).length !==
        fields.length + (Object.hasOwn(exit, "completion") ? 1 : 0) ||
      !fields.every((key) => Object.hasOwn(exit, key)) ||
      exit.treeExited !== true ||
      exit.launchTicket !== target.launchTicket ||
      !isDeepStrictEqual(exit.identity, target.identity) ||
      !isDeepStrictEqual(
        freezeOwnerDescriptor(exit.descriptor, target.launchTicket),
        descriptor,
      )
    )
      throw new Error("invalid execution exit");
    if (Object.hasOwn(exit, "completion")) {
      const completion = exit.completion;
      if (!completion || Object.getPrototypeOf(completion) !== Object.prototype)
        throw new Error("invalid execution completion");
      if (completion.kind === "interrupted") {
        const fields = [
          "kind",
          "authorizationRecordId",
          "controllerLossRecordId",
          "terminalRecordId",
        ];
        if (
          Reflect.ownKeys(completion).length !== fields.length ||
          !fields.every((key) => Object.hasOwn(completion, key)) ||
          !validIdentifier(completion.authorizationRecordId) ||
          !validIdentifier(completion.controllerLossRecordId) ||
          !validIdentifier(completion.terminalRecordId)
        )
          throw new Error("invalid execution completion");
      } else if (
        Reflect.ownKeys(completion).length !== 3 ||
        !["kind", "exitCode", "signal"].every((key) =>
          Object.hasOwn(completion, key),
        ) ||
        !(
          (completion.kind === "success" &&
            completion.exitCode === 0 &&
            completion.signal === null) ||
          ((completion.kind === "failure" || completion.kind === "oom") &&
            ((Number.isSafeInteger(completion.exitCode) &&
              completion.exitCode !== 0 &&
              completion.signal === null) ||
              (completion.exitCode === null &&
                validIdentifier(completion.signal))))
        )
      )
        throw new Error("invalid execution completion");
    }
    const text = JSON.stringify(exit, function (key, value: unknown) {
      const source = (this as Record<string, unknown>)[key];
      if (source && typeof source === "object") {
        for (const field of Reflect.ownKeys(source)) {
          if (Array.isArray(source) && field === "length") continue;
          if (
            typeof field !== "string" ||
            !Object.prototype.propertyIsEnumerable.call(source, field)
          )
            throw new Error("unpersistable execution property");
        }
      }
      return value;
    });
    const copy = JSON.parse(text) as ExecutionExit;
    if (!isDeepStrictEqual(exit, copy)) throw new Error("lossy execution exit");
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(copy);
    return copy;
  } catch {
    throw new EnhancementError("configuration_invalid");
  }
}

export function freezeDurableInterruptionRecords(
  records: DurableInterruptionRecords,
  scope: InterruptionReadScope,
): DurableInterruptionRecords {
  try {
    const exact = (value: unknown, fields: readonly string[]): boolean =>
      !!value &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).length === fields.length &&
      fields.every((field) => {
        const property = Object.getOwnPropertyDescriptor(value, field);
        return (
          !!property && property.enumerable === true && "value" in property
        );
      });
    const validScope = (value: InterruptionReadScope): boolean => {
      if (
        !exact(value, ["target", "descriptor"]) ||
        !exact(value.target, ["identity", "launchTicket"]) ||
        !exact(value.target.identity, [
          "jobId",
          "attemptNo",
          "ownerInstanceId",
          "fence",
        ])
      )
        return false;
      const { identity, launchTicket } = value.target;
      return (
        validIdentifier(launchTicket) &&
        validIdentifier(identity.jobId) &&
        validIdentifier(identity.ownerInstanceId) &&
        Number.isSafeInteger(identity.attemptNo) &&
        identity.attemptNo > 0 &&
        Number.isSafeInteger(identity.fence) &&
        identity.fence > 0 &&
        isDeepStrictEqual(
          freezeOwnerDescriptor(value.descriptor, launchTicket),
          value.descriptor,
        )
      );
    };
    if (
      !validScope(scope) ||
      !exact(records, ["authorization", "controllerLoss", "terminal"]) ||
      !exact(records.authorization, ["v", "recordId", "scope", "kind"]) ||
      !exact(records.controllerLoss, [
        "v",
        "recordId",
        "scope",
        "kind",
        "authorizationRecordId",
      ]) ||
      !exact(records.terminal, [
        "v",
        "recordId",
        "scope",
        "kind",
        "completion",
        "authorizationRecordId",
        "controllerLossRecordId",
        "treeExited",
        "authorizationsSealed",
      ])
    )
      throw new Error("invalid interruption records");
    const { authorization, controllerLoss, terminal } = records;
    for (const record of [authorization, controllerLoss, terminal]) {
      if (
        record.v !== 1 ||
        !validIdentifier(record.recordId) ||
        !validScope(record.scope) ||
        !isDeepStrictEqual(record.scope, scope)
      )
        throw new Error("invalid interruption scope");
    }
    if (
      authorization.kind !== "authorized" ||
      controllerLoss.kind !== "controller-lost" ||
      terminal.kind !== "terminal" ||
      terminal.completion !== "interrupted" ||
      terminal.treeExited !== true ||
      terminal.authorizationsSealed !== true ||
      controllerLoss.authorizationRecordId !== authorization.recordId ||
      terminal.authorizationRecordId !== authorization.recordId ||
      terminal.controllerLossRecordId !== controllerLoss.recordId ||
      new Set([
        authorization.recordId,
        controllerLoss.recordId,
        terminal.recordId,
      ]).size !== 3
    )
      throw new Error("invalid interruption chain");
    const text = JSON.stringify(records, function (key, value: unknown) {
      const source = (this as Record<string, unknown>)[key];
      if (source && typeof source === "object") {
        for (const field of Reflect.ownKeys(source)) {
          if (Array.isArray(source) && field === "length") continue;
          const property = Object.getOwnPropertyDescriptor(source, field);
          if (
            typeof field !== "string" ||
            !property ||
            property.enumerable !== true ||
            !("value" in property)
          )
            throw new Error("unpersistable interruption property");
        }
      }
      return value;
    });
    const copy = JSON.parse(text) as DurableInterruptionRecords;
    if (!isDeepStrictEqual(records, copy))
      throw new Error("lossy interruption records");
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(copy);
    return copy;
  } catch {
    throw new EnhancementError("configuration_invalid");
  }
}

export function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
