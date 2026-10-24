import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { isDeepStrictEqual } from "node:util";

import {
  freezeOwnerDescriptor,
  validIdentifier,
  type AuthorizationRecord,
  type CompletionEvidence,
  type ControllerLossRecord,
  type DurableInterruptionRecords,
  type ExecutionTarget,
  type InterruptedTerminalRecord,
  type InterruptionReadScope,
} from "../src/execution.js";

export type RecordRole =
  "prepared" | "authorization" | "controller-loss" | "terminal";
export type OrdinaryCompletion = Exclude<
  CompletionEvidence,
  { kind: "interrupted" }
>;
type PreparedRecord = Readonly<{
  v: 1;
  kind: "prepared";
  scope: InterruptionReadScope;
}>;
export type CompletedRecord = Readonly<{
  v: 1;
  kind: "completed";
  scope: InterruptionReadScope;
  completion: OrdinaryCompletion;
  treeExited: true;
  authorizationsSealed: true;
}>;
type ControlledRecord =
  | PreparedRecord
  | AuthorizationRecord
  | ControllerLossRecord
  | InterruptedTerminalRecord
  | CompletedRecord;
export type ControlledSnapshot = Readonly<{
  scope: InterruptionReadScope;
  authorization: AuthorizationRecord | null;
  controllerLoss: ControllerLossRecord | null;
  terminal: InterruptedTerminalRecord | CompletedRecord | null;
  sealed: boolean;
}>;
export type DurableIoEvent = Readonly<{
  operation:
    | "prepare"
    | "authorize"
    | "loss"
    | "finish"
    | "inspect"
    | "reader"
    | "rewrite"
    | "stop";
  role:
    RecordRole | "sealed" | "ticket-directory" | "adapter-directory" | "tree";
  stage:
    | "queue"
    | "open"
    | "stat"
    | "read"
    | "write"
    | "file-sync"
    | "close"
    | "rename"
    | "mkdir"
    | "directory-sync"
    | "unlink"
    | "start"
    | "tree-exit";
  phase: "before" | "after";
  target: ExecutionTarget;
  bytesRead?: number;
  bytesWritten?: number;
  missing?: true;
  cleanup?: true;
  handleToken?: symbol;
}>;
export type DurableHandleEvent = Readonly<{
  operation: DurableIoEvent["operation"];
  target: ExecutionTarget;
  role: DurableIoEvent["role"];
  handleToken: symbol;
  stage:
    | "opened"
    | "read-returned"
    | "close-issued"
    | "native-close-settled"
    | "completion-delivered"
    | "observer-failed";
  cleanup?: true;
  bytesRead?: number;
  outcome?: "fulfilled" | "rejected";
  error?: unknown;
}>;
export type DurableIoHooks = {
  before?: (event: DurableIoEvent) => Promise<void>;
  after?: (event: DurableIoEvent) => Promise<void>;
  // This observer runs only after an already-issued cleanup close has actually
  // settled. It may delay its receipt, never the native close or its outcome.
  cleanupCloseCompletion?: (event: DurableHandleEvent) => Promise<void>;
};
export type RecordContext = Readonly<{
  operation: DurableIoEvent["operation"];
  target: ExecutionTarget;
  current: () => boolean;
  hooks: DurableIoHooks;
  events: DurableIoEvent[];
  handleEvents: DurableHandleEvent[];
  opened: Map<FileHandle, DurableIoEvent["role"]>;
}>;

const handleTokens = new WeakMap<FileHandle, symbol>();

function handleToken(file: FileHandle): symbol {
  let token = handleTokens.get(file);
  if (!token) {
    token = Symbol("actual-durable-file-handle");
    handleTokens.set(file, token);
  }
  return token;
}

function observeHandle(
  context: RecordContext,
  file: FileHandle,
  role: DurableIoEvent["role"],
  stage: DurableHandleEvent["stage"],
  detail: Partial<DurableHandleEvent> = {},
): DurableHandleEvent {
  const event: DurableHandleEvent = {
    ...detail,
    operation: context.operation,
    target: context.target,
    role,
    stage,
    handleToken: handleToken(file),
  };
  context.handleEvents.push(event);
  return event;
}

export class RetiredDurableFacade extends Error {
  constructor() {
    super("durable fixture facade retired");
  }
}
class MissingRecord extends Error {}
class InvalidRecord extends Error {
  constructor() {
    super("durable fixture record invalid");
  }
}
class RecordIoFailure extends Error {
  constructor(role: DurableIoEvent["role"], stage: DurableIoEvent["stage"]) {
    super(`durable fixture ${role} ${stage} failed`);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

export function requireCurrent(context: RecordContext) {
  if (!context.current()) throw new RetiredDurableFacade();
}

export async function notice(
  context: RecordContext,
  role: DurableIoEvent["role"],
  stage: DurableIoEvent["stage"],
  phase: DurableIoEvent["phase"],
  detail: Partial<DurableIoEvent> = {},
) {
  requireCurrent(context);
  const event: DurableIoEvent = {
    ...detail,
    operation: context.operation,
    role,
    stage,
    phase,
    target: context.target,
  };
  context.events.push(event);
  const hook = context.hooks[phase];
  if (hook) {
    try {
      await hook(event);
    } catch {
      requireCurrent(context);
      throw new RecordIoFailure(role, stage);
    }
    requireCurrent(context);
  }
}

export async function perform<T>(
  context: RecordContext,
  role: DurableIoEvent["role"],
  stage: DurableIoEvent["stage"],
  operation: () => Promise<T>,
  detail: (result: T) => Partial<DurableIoEvent> = () => ({}),
): Promise<T> {
  await notice(context, role, stage, "before");
  requireCurrent(context);
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    requireCurrent(context);
    if (hasCode(error, "ENOENT")) {
      await notice(context, role, stage, "after", { missing: true });
      requireCurrent(context);
      throw new MissingRecord();
    }
    throw new RecordIoFailure(role, stage);
  }
  requireCurrent(context);
  await notice(context, role, stage, "after", detail(result));
  requireCurrent(context);
  return result;
}

export async function closeIssuedHandles(context: RecordContext) {
  let failed = false;
  let observerFailure: { error: unknown } | undefined;
  for (const [file, role] of context.opened) {
    // Retirement allows only these already-issued handles to close. Hooks cannot
    // grant fresh I/O. The narrow completion observer sees a real settled close.
    context.events.push({
      operation: context.operation,
      role,
      stage: "close",
      phase: "before",
      target: context.target,
      cleanup: true,
      handleToken: handleToken(file),
    });
    observeHandle(context, file, role, "close-issued", { cleanup: true });
    let nativeOutcome:
      { outcome: "fulfilled" } | { outcome: "rejected"; error: unknown };
    try {
      await file.close();
      nativeOutcome = { outcome: "fulfilled" };
    } catch (error) {
      nativeOutcome = { outcome: "rejected", error };
      failed = true;
    }
    const settled = observeHandle(context, file, role, "native-close-settled", {
      cleanup: true,
      ...nativeOutcome,
    });
    try {
      // A suspended receipt does not imply that the OS close is still running.
      const observer = context.hooks.cleanupCloseCompletion;
      if (observer) await observer(settled);
    } catch (error) {
      observeHandle(context, file, role, "observer-failed", {
        cleanup: true,
        error,
      });
      observerFailure ??= { error };
    } finally {
      observeHandle(context, file, role, "completion-delivered", {
        cleanup: true,
        ...nativeOutcome,
      });
      context.current();
      if (nativeOutcome.outcome === "fulfilled")
        context.events.push({
          operation: context.operation,
          role,
          stage: "close",
          phase: "after",
          target: context.target,
          cleanup: true,
          handleToken: handleToken(file),
        });
      context.opened.delete(file);
    }
  }
  // Instrumentation errors stay separate from the native close's real outcome.
  if (failed) throw new RecordIoFailure("ticket-directory", "close");
  if (observerFailure) throw observerFailure.error;
}

function exact(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) =>
      Object.prototype.propertyIsEnumerable.call(value, field),
    )
  );
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalText(value: unknown): string {
  const text = JSON.stringify(value, function (key, child: unknown) {
    const source = (this as Record<string, unknown>)[key];
    if (source && typeof source === "object") {
      if (
        !Array.isArray(source) &&
        Object.getPrototypeOf(source) !== Object.prototype
      )
        throw new InvalidRecord();
      for (const field of Reflect.ownKeys(source)) {
        if (Array.isArray(source) && field === "length") continue;
        if (
          typeof field !== "string" ||
          !Object.prototype.propertyIsEnumerable.call(source, field)
        )
          throw new InvalidRecord();
      }
    }
    return child;
  });
  if (text === undefined || !isDeepStrictEqual(JSON.parse(text), value))
    throw new InvalidRecord();
  function sorted(child: unknown): unknown {
    if (Array.isArray(child)) return child.map(sorted);
    if (child && typeof child === "object")
      return Object.fromEntries(
        Object.keys(child)
          .sort()
          .map((key) => [key, sorted((child as Record<string, unknown>)[key])]),
      );
    return child;
  }
  return JSON.stringify(sorted(value));
}

export function canonicalCopy<T>(value: T): T {
  return freezeTree(JSON.parse(canonicalText(value)) as T);
}

export function checkedScope(
  scope: InterruptionReadScope,
): InterruptionReadScope {
  if (
    !exact(scope, ["target", "descriptor"]) ||
    !exact(scope.target, ["identity", "launchTicket"]) ||
    !exact(scope.target.identity, [
      "jobId",
      "attemptNo",
      "ownerInstanceId",
      "fence",
    ]) ||
    !validIdentifier(scope.target.launchTicket) ||
    !validIdentifier(scope.target.identity.jobId) ||
    !validIdentifier(scope.target.identity.ownerInstanceId) ||
    !Number.isSafeInteger(scope.target.identity.attemptNo) ||
    scope.target.identity.attemptNo <= 0 ||
    !Number.isSafeInteger(scope.target.identity.fence) ||
    scope.target.identity.fence <= 0
  )
    throw new InvalidRecord();
  const descriptor = freezeOwnerDescriptor(
    scope.descriptor,
    scope.target.launchTicket,
  );
  if (!isDeepStrictEqual(descriptor, scope.descriptor))
    throw new InvalidRecord();
  return canonicalCopy(scope);
}

export function checkedCompletion(
  completion: OrdinaryCompletion,
): OrdinaryCompletion {
  if (
    !exact(completion, ["kind", "exitCode", "signal"]) ||
    !(
      (completion.kind === "success" &&
        completion.exitCode === 0 &&
        completion.signal === null) ||
      (completion.kind === "failure" &&
        ((Number.isSafeInteger(completion.exitCode) &&
          completion.exitCode !== 0 &&
          completion.signal === null) ||
          (completion.exitCode === null &&
            validIdentifier(completion.signal) &&
            Buffer.byteLength(completion.signal, "utf8") <= 128)))
    )
  )
    throw new InvalidRecord();
  return canonicalCopy(completion);
}

function normalizeRecord(
  value: unknown,
  scope: InterruptionReadScope,
  role: RecordRole,
): ControlledRecord {
  const base = ["v", "kind", "scope"];
  const fields =
    role === "prepared"
      ? base
      : role === "authorization"
        ? [...base, "recordId"]
        : role === "controller-loss"
          ? [...base, "recordId", "authorizationRecordId"]
          : !!value &&
              typeof value === "object" &&
              "kind" in value &&
              value.kind === "completed"
            ? [...base, "completion", "treeExited", "authorizationsSealed"]
            : [
                ...base,
                "recordId",
                "completion",
                "authorizationRecordId",
                "controllerLossRecordId",
                "treeExited",
                "authorizationsSealed",
              ];
  if (
    !exact(value, fields) ||
    value.v !== 1 ||
    !isDeepStrictEqual(
      checkedScope(value.scope as InterruptionReadScope),
      scope,
    )
  )
    throw new InvalidRecord();
  if (role === "prepared") {
    if (value.kind !== "prepared") throw new InvalidRecord();
  } else if (role === "authorization") {
    if (value.kind !== "authorized" || !validIdentifier(value.recordId))
      throw new InvalidRecord();
  } else if (role === "controller-loss") {
    if (
      value.kind !== "controller-lost" ||
      !validIdentifier(value.recordId) ||
      !validIdentifier(value.authorizationRecordId)
    )
      throw new InvalidRecord();
  } else {
    if (value.treeExited !== true || value.authorizationsSealed !== true)
      throw new InvalidRecord();
    if (value.kind === "completed")
      checkedCompletion(value.completion as OrdinaryCompletion);
    else if (
      value.kind !== "terminal" ||
      value.completion !== "interrupted" ||
      !validIdentifier(value.recordId) ||
      !validIdentifier(value.authorizationRecordId) ||
      !validIdentifier(value.controllerLossRecordId)
    )
      throw new InvalidRecord();
  }
  return canonicalCopy(value) as ControlledRecord;
}

function byteBound(scope: InterruptionReadScope, role: RecordRole): number {
  const id = "00000000-0000-4000-8000-000000000000";
  const base = { v: 1, scope };
  const candidates: unknown[] =
    role === "prepared"
      ? [{ ...base, kind: "prepared" }]
      : role === "authorization"
        ? [{ ...base, kind: "authorized", recordId: id }]
        : role === "controller-loss"
          ? [
              {
                ...base,
                kind: "controller-lost",
                recordId: id,
                authorizationRecordId: id,
              },
            ]
          : [
              {
                ...base,
                kind: "terminal",
                recordId: id,
                completion: "interrupted",
                authorizationRecordId: id,
                controllerLossRecordId: id,
                treeExited: true,
                authorizationsSealed: true,
              },
              {
                ...base,
                kind: "completed",
                completion: {
                  kind: "failure",
                  exitCode: -Number.MAX_SAFE_INTEGER,
                  signal: null,
                },
                treeExited: true,
                authorizationsSealed: true,
              },
              {
                ...base,
                kind: "completed",
                completion: {
                  kind: "failure",
                  exitCode: null,
                  signal: "\\".repeat(128),
                },
                treeExited: true,
                authorizationsSealed: true,
              },
            ];
  return Math.max(
    ...candidates.map((candidate) =>
      Buffer.byteLength(canonicalText(candidate), "utf8"),
    ),
  );
}

export function ticketKey(target: ExecutionTarget): string {
  return createHash("sha256")
    .update(canonicalText(target), "utf8")
    .digest("hex");
}

export function createCanonicalRecordIo(directory: string) {
  const tickets = join(directory, "tickets");
  const ticketDirectory = (scope: InterruptionReadScope) =>
    join(tickets, ticketKey(scope.target));
  const pathFor = (scope: InterruptionReadScope, role: RecordRole) =>
    join(ticketDirectory(scope), `${role}.json`);

  async function openHandle(
    context: RecordContext,
    role: DurableIoEvent["role"],
    path: string,
    flags: string,
  ) {
    return perform(
      context,
      role,
      "open",
      async () => {
        const file = await open(path, flags, flags === "r" ? undefined : 0o600);
        // Register before the dynamic post-open check, including a late open.
        context.opened.set(file, role);
        observeHandle(context, file, role, "opened");
        requireCurrent(context);
        return file;
      },
      (file) => ({ handleToken: handleToken(file) }),
    );
  }
  async function closeHandle(
    context: RecordContext,
    role: DurableIoEvent["role"],
    file: FileHandle,
  ) {
    await perform(
      context,
      role,
      "close",
      async () => {
        observeHandle(context, file, role, "close-issued");
        try {
          await file.close();
        } catch (error) {
          observeHandle(context, file, role, "native-close-settled", {
            outcome: "rejected",
            error,
          });
          throw error;
        }
        observeHandle(context, file, role, "native-close-settled", {
          outcome: "fulfilled",
        });
        observeHandle(context, file, role, "completion-delivered", {
          outcome: "fulfilled",
        });
        context.opened.delete(file);
        requireCurrent(context);
      },
      () => ({ handleToken: handleToken(file) }),
    );
    requireCurrent(context);
  }
  async function syncDirectory(
    context: RecordContext,
    path: string,
    role: DurableIoEvent["role"],
  ) {
    const file = await openHandle(
      context,
      role,
      path,
      process.platform === "win32" ? "r+" : "r",
    );
    requireCurrent(context);
    const stat = await perform(context, role, "stat", () => file.stat());
    requireCurrent(context);
    if (!stat.isDirectory()) throw new InvalidRecord();
    await perform(context, role, "directory-sync", () => file.sync());
    requireCurrent(context);
    await closeHandle(context, role, file);
    requireCurrent(context);
  }
  async function syncParents(
    context: RecordContext,
    scope: InterruptionReadScope,
  ) {
    for (const path of [
      ticketDirectory(scope),
      tickets,
      directory,
      dirname(directory),
    ]) {
      await syncDirectory(
        context,
        path,
        path === ticketDirectory(scope)
          ? "ticket-directory"
          : "adapter-directory",
      );
      requireCurrent(context);
    }
  }
  async function mkdirIfAbsent(
    context: RecordContext,
    path: string,
    role: DurableIoEvent["role"],
  ) {
    await perform(context, role, "mkdir", async () => {
      try {
        await mkdir(path, { mode: 0o700 });
        requireCurrent(context);
      } catch (error) {
        requireCurrent(context);
        if (!hasCode(error, "EEXIST")) throw error;
      }
    });
    requireCurrent(context);
  }
  async function readBytes(
    context: RecordContext,
    scope: InterruptionReadScope,
    role: RecordRole,
    validate?: (bytes: Buffer) => void,
  ): Promise<Buffer | undefined> {
    let file: FileHandle;
    try {
      file = await openHandle(
        context,
        role,
        pathFor(scope, role),
        process.platform === "win32" ? "r+" : "r",
      );
      requireCurrent(context);
    } catch (error) {
      requireCurrent(context);
      if (error instanceof MissingRecord) return undefined;
      throw error;
    }
    const stat = await perform(context, role, "stat", () => file.stat());
    requireCurrent(context);
    const bound = byteBound(scope, role);
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(stat.size) ||
      stat.size <= 0 ||
      stat.size > bound
    )
      throw new InvalidRecord();
    const buffer = Buffer.alloc(bound + 1);
    let position = 0;
    while (position < buffer.length) {
      const remaining = buffer.length - position;
      const result = await perform(
        context,
        role,
        "read",
        async () => {
          const result = await file.read(buffer, position, remaining, position);
          observeHandle(context, file, role, "read-returned", {
            bytesRead: result.bytesRead,
          });
          return result;
        },
        ({ bytesRead }) => ({ bytesRead, handleToken: handleToken(file) }),
      );
      requireCurrent(context);
      if (
        !Number.isSafeInteger(result.bytesRead) ||
        result.bytesRead < 0 ||
        result.bytesRead > remaining
      )
        throw new InvalidRecord();
      if (result.bytesRead === 0) break;
      position += result.bytesRead;
      if (position > bound) throw new InvalidRecord();
    }
    if (position !== stat.size) throw new InvalidRecord();
    const bytes = Buffer.from(buffer.subarray(0, position));
    // Strict decoding/shape/canonical checks happen on these exact handle bytes
    // before their successful resync/close can yield a reliable record.
    validate?.(bytes);
    requireCurrent(context);
    await perform(context, role, "file-sync", () => file.sync());
    requireCurrent(context);
    await closeHandle(context, role, file);
    requireCurrent(context);
    await syncParents(context, scope);
    requireCurrent(context);
    return bytes;
  }
  async function readCanonicalRecord(
    context: RecordContext,
    scope: InterruptionReadScope,
    role: RecordRole,
  ) {
    let normalized: ControlledRecord | undefined;
    const bytes = await readBytes(context, scope, role, (actualBytes) => {
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(actualBytes),
        );
      } catch {
        throw new InvalidRecord();
      }
      normalized = normalizeRecord(value, scope, role);
      if (!actualBytes.equals(Buffer.from(canonicalText(normalized), "utf8")))
        throw new InvalidRecord();
    });
    requireCurrent(context);
    if (!bytes) return undefined;
    if (!normalized) throw new InvalidRecord();
    return normalized;
  }
  async function writeBytes(
    context: RecordContext,
    role: RecordRole,
    file: FileHandle,
    bytes: Buffer,
  ) {
    let position = 0;
    while (position < bytes.length) {
      const remaining = bytes.length - position;
      const result = await perform(
        context,
        role,
        "write",
        () => file.write(bytes, position, remaining, position),
        ({ bytesWritten }) => ({ bytesWritten }),
      );
      requireCurrent(context);
      if (
        !Number.isSafeInteger(result.bytesWritten) ||
        result.bytesWritten <= 0 ||
        result.bytesWritten > remaining
      )
        throw new InvalidRecord();
      position += result.bytesWritten;
    }
    await perform(context, role, "file-sync", () => file.sync());
    requireCurrent(context);
    await closeHandle(context, role, file);
    requireCurrent(context);
  }
  async function writeCanonicalRecord(
    context: RecordContext,
    scope: InterruptionReadScope,
    role: RecordRole,
    record: ControlledRecord,
  ) {
    const normalized = normalizeRecord(record, scope, role);
    const bytes = Buffer.from(canonicalText(normalized), "utf8");
    if (bytes.length > byteBound(scope, role)) throw new InvalidRecord();
    const existing = await readCanonicalRecord(context, scope, role);
    requireCurrent(context);
    if (existing) {
      if (!isDeepStrictEqual(existing, normalized)) throw new InvalidRecord();
      return;
    }
    const part = join(ticketDirectory(scope), `.${role}-${randomUUID()}.part`);
    const file = await openHandle(context, role, part, "wx");
    requireCurrent(context);
    await writeBytes(context, role, file, bytes);
    requireCurrent(context);
    // The shared ticket channel and the private single writer prevent clobber;
    // rename alone is not treated as a no-clobber primitive.
    await perform(context, role, "rename", () =>
      rename(part, pathFor(scope, role)),
    );
    requireCurrent(context);
    await syncParents(context, scope);
    requireCurrent(context);
  }
  async function prepare(context: RecordContext, scope: InterruptionReadScope) {
    await mkdirIfAbsent(context, directory, "adapter-directory");
    requireCurrent(context);
    await mkdirIfAbsent(context, tickets, "adapter-directory");
    requireCurrent(context);
    let created = false;
    await perform(context, "ticket-directory", "mkdir", async () => {
      try {
        await mkdir(ticketDirectory(scope), { mode: 0o700 });
        requireCurrent(context);
        created = true;
      } catch (error) {
        requireCurrent(context);
        if (!hasCode(error, "EEXIST")) throw error;
      }
    });
    requireCurrent(context);
    if (!created) {
      const existing = await readCanonicalRecord(context, scope, "prepared");
      requireCurrent(context);
      if (!existing) throw new InvalidRecord();
      return;
    }
    await writeCanonicalRecord(context, scope, "prepared", {
      v: 1,
      kind: "prepared",
      scope,
    });
    requireCurrent(context);
  }
  async function readSeal(
    context: RecordContext,
    scope: InterruptionReadScope,
  ) {
    try {
      await syncDirectory(
        context,
        join(ticketDirectory(scope), "sealed"),
        "sealed",
      );
      requireCurrent(context);
    } catch (error) {
      requireCurrent(context);
      if (error instanceof MissingRecord) return false;
      throw error;
    }
    await syncParents(context, scope);
    requireCurrent(context);
    return true;
  }
  async function seal(context: RecordContext, scope: InterruptionReadScope) {
    await mkdirIfAbsent(
      context,
      join(ticketDirectory(scope), "sealed"),
      "sealed",
    );
    requireCurrent(context);
    const sealed = await readSeal(context, scope);
    requireCurrent(context);
    if (!sealed) throw new InvalidRecord();
  }
  async function readControlledSnapshot(
    context: RecordContext,
    scope: InterruptionReadScope,
  ): Promise<ControlledSnapshot | undefined> {
    const prepared = await readCanonicalRecord(context, scope, "prepared");
    requireCurrent(context);
    if (!prepared) return undefined;
    const authorization = (await readCanonicalRecord(
      context,
      scope,
      "authorization",
    )) as AuthorizationRecord | undefined;
    requireCurrent(context);
    const controllerLoss = (await readCanonicalRecord(
      context,
      scope,
      "controller-loss",
    )) as ControllerLossRecord | undefined;
    requireCurrent(context);
    const sealed = await readSeal(context, scope);
    requireCurrent(context);
    const terminal = (await readCanonicalRecord(context, scope, "terminal")) as
      InterruptedTerminalRecord | CompletedRecord | undefined;
    requireCurrent(context);
    if (
      controllerLoss &&
      (!authorization ||
        !sealed ||
        controllerLoss.authorizationRecordId !== authorization.recordId ||
        controllerLoss.recordId === authorization.recordId)
    )
      throw new InvalidRecord();
    if (terminal) {
      if (!authorization || !sealed) throw new InvalidRecord();
      if (terminal.kind === "completed") {
        if (controllerLoss) throw new InvalidRecord();
      } else if (
        !controllerLoss ||
        terminal.authorizationRecordId !== authorization.recordId ||
        terminal.controllerLossRecordId !== controllerLoss.recordId ||
        terminal.recordId === authorization.recordId ||
        terminal.recordId === controllerLoss.recordId
      )
        throw new InvalidRecord();
    }
    return canonicalCopy({
      scope,
      authorization: authorization ?? null,
      controllerLoss: controllerLoss ?? null,
      terminal: terminal ?? null,
      sealed,
    });
  }
  async function readInterruptionRecords(
    context: RecordContext,
    scope: InterruptionReadScope,
  ): Promise<DurableInterruptionRecords | undefined> {
    const snapshot = await readControlledSnapshot(context, scope);
    requireCurrent(context);
    if (
      !snapshot?.authorization ||
      !snapshot.controllerLoss ||
      snapshot.terminal?.kind !== "terminal"
    )
      return undefined;
    return canonicalCopy({
      authorization: snapshot.authorization,
      controllerLoss: snapshot.controllerLoss,
      terminal: snapshot.terminal,
    });
  }
  async function rewriteRecordBytes(
    context: RecordContext,
    scope: InterruptionReadScope,
    role: Exclude<RecordRole, "prepared">,
    rewrite: (bytes: Buffer) => Buffer | undefined,
  ) {
    const bytes = await readBytes(context, scope, role);
    requireCurrent(context);
    if (!bytes) throw new InvalidRecord();
    const replacement = rewrite(Buffer.from(bytes));
    requireCurrent(context);
    if (replacement === undefined) {
      await perform(context, role, "unlink", () =>
        unlink(pathFor(scope, role)),
      );
      requireCurrent(context);
    } else if (!replacement.equals(bytes)) {
      const file = await openHandle(context, role, pathFor(scope, role), "w");
      requireCurrent(context);
      await writeBytes(context, role, file, replacement);
      requireCurrent(context);
    }
    await syncParents(context, scope);
    requireCurrent(context);
  }
  return {
    prepare,
    seal,
    readCanonicalRecord,
    readControlledSnapshot,
    readInterruptionRecords,
    writeCanonicalRecord,
    rewriteRecordBytes,
    readBytes,
  };
}
