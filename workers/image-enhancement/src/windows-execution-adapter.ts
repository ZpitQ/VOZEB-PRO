import { isDeepStrictEqual } from "node:util";

import { EnhancementError } from "./contracts.js";
import type {
  ClaimedAttempt,
  ExecutionAdapter,
  ExecutionSendGuard,
  ExecutionTarget,
  Inspection,
  OwnerDescriptor,
} from "./execution.js";
import { createWindowsControlBridgeHost } from "./windows-control-bridge-host.js";
import {
  freezeWindowsControlBridgeOptions,
  freezeWindowsControlBridgeTarget,
  freezeWindowsPrepareDiagnostic,
  type WindowsControlBridgeCloseResult,
  type WindowsControlBridgeHost,
  type WindowsControlBridgeOptions,
  type WindowsRuntimeObservationReceipt,
  type WindowsPrepareDiagnostic,
} from "./windows-control-bridge-protocol.js";
import {
  createWindowsJournalLauncher,
  type WindowsJournalLauncher,
  type WindowsJournalReadLimits,
  type WindowsJournalReadResult,
} from "./windows-journal-launcher.js";
import {
  freezeWindowsJournalReadContext,
  type WindowsJournalInterpretation,
  type WindowsJournalReadContext,
  type WindowsJournalScope,
} from "./windows-journal-reader.js";
import {
  freezeWindowsPrepareRequest,
  type FrozenWindowsRequest,
} from "./windows-prepare-payload.js";

export type WindowsExecutionAdapterOptions = Readonly<{
  bridge: WindowsControlBridgeOptions;
  journalLimits: WindowsJournalReadLimits;
}>;

export type WindowsExecutionStatus = Readonly<{
  sealed: boolean;
  activity: "idle" | "busy" | "unknown" | "cleanup_unknown";
  close: "not_requested" | "pending" | "closed" | "unknown";
  runtimeObservation?: WindowsRuntimeObservationReceipt;
  prepareDiagnostic?: WindowsPrepareDiagnostic;
}>;

export type WindowsExecutionAdapter = ExecutionAdapter &
  Readonly<{
    kind: "windows";
    status(): WindowsExecutionStatus;
    pendingWork(): number;
    close(): Promise<"closed" | "unknown">;
    interrupt(): Promise<"closed" | "unknown">;
  }>;

type Cleanup = "closed" | "unknown";
type Terminal = Exclude<
  WindowsJournalInterpretation,
  Readonly<{ kind: "unknown" }>
>;
type Reader = {
  launcher: WindowsJournalLauncher;
  controller: AbortController;
  promise?: Promise<WindowsJournalReadResult>;
  result?: WindowsJournalReadResult;
  uncertain: boolean;
};
type Subscription = {
  active: boolean;
  delivered: boolean;
  listener: (exit: Terminal["exit"]) => void;
};
type Entry = {
  scope: WindowsJournalScope;
  request: FrozenWindowsRequest;
  host: WindowsControlBridgeHost;
  hostController: AbortController;
  reader: Reader;
  subscriptions: Set<Subscription>;
  removeRunnerAbort(): void;
  retired: boolean;
  context?: WindowsJournalReadContext;
  hostResult?: WindowsControlBridgeCloseResult;
  hostCleanupUncertain: boolean;
  prepareDiagnostic?: WindowsPrepareDiagnostic;
  terminal?: Terminal;
};
type Recovery = {
  context: WindowsJournalReadContext;
  reader: Reader;
};

const unknownOwned: WindowsJournalReadResult = Object.freeze({
  kind: "unknown",
  cleanup: "unknown",
});
const unknownClosed: WindowsJournalReadResult = Object.freeze({
  kind: "unknown",
  cleanup: "closed",
});
const unknownHost: WindowsControlBridgeCloseResult = Object.freeze({
  kind: "unknown",
  cleanup: "unknown",
});

function ownData(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object")
    throw new EnhancementError("configuration_invalid");
  const property = Object.getOwnPropertyDescriptor(source, key);
  if (!property || !("value" in property) || !property.enumerable)
    throw new EnhancementError("configuration_invalid");
  return property.value;
}

function unavailable(): never {
  throw new EnhancementError("not_ready");
}

function callerCurrent(predicate: () => boolean): boolean {
  try {
    return predicate() === true;
  } catch {
    return false;
  }
}

export function createWindowsExecutionAdapter(
  options: WindowsExecutionAdapterOptions,
  observeBootAttempt?: (attempt: ClaimedAttempt) => boolean,
): WindowsExecutionAdapter {
  let bridge: WindowsControlBridgeOptions;
  let journalLimits: WindowsJournalReadLimits;
  try {
    bridge = freezeWindowsControlBridgeOptions(
      ownData(options, "bridge") as WindowsControlBridgeOptions,
    );
    const source = ownData(options, "journalLimits");
    const keys = [
      "maxRequestBytes",
      "maxStdoutBytes",
      "maxStderrBytes",
      "readTimeoutMs",
      "cleanupTimeoutMs",
    ];
    if (
      !source ||
      typeof source !== "object" ||
      Reflect.ownKeys(source).length !== keys.length
    )
      throw new EnhancementError("configuration_invalid");
    journalLimits = Object.freeze(
      Object.fromEntries(keys.map((key) => [key, ownData(source, key)])),
    ) as WindowsJournalReadLimits;
  } catch {
    throw new EnhancementError("configuration_invalid");
  }

  let sealed = false;
  let current: Entry | undefined;
  let recovery: Recovery | undefined;
  let closePromise: Promise<Cleanup> | undefined;
  let closeResult: Cleanup | undefined;
  let pendingCount = 0;

  function reserve(): () => void {
    pendingCount += 1;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      pendingCount -= 1;
    };
  }

  function track<T>(start: () => Promise<T>): Promise<T> {
    const settle = reserve();
    try {
      const promise = start();
      void promise.then(settle, settle);
      return promise;
    } catch (error) {
      settle();
      throw error;
    }
  }

  function createReader(launcher?: WindowsJournalLauncher): Reader {
    return {
      launcher:
        launcher ??
        createWindowsJournalLauncher({
          executablePath: bridge.helperPath,
          recordsRoot: bridge.recordsRoot,
          environment: bridge.environment,
          limits: journalLimits,
        }),
      controller: new AbortController(),
      uncertain: false,
    };
  }

  function knownCleanup(reader: Reader): boolean {
    return !reader.uncertain && reader.result?.cleanup === "closed";
  }

  function unknownRead(reader: Reader | undefined): boolean {
    const result = reader?.result;
    return (
      result?.kind === "unknown" ||
      (result?.kind === "read" && result.interpretation.kind === "unknown")
    );
  }

  function qualified(entry: Entry): boolean {
    return (
      entry.hostResult?.kind === "stopped" &&
      entry.hostResult.cleanup === "closed" &&
      !entry.hostCleanupUncertain &&
      knownCleanup(entry.reader) &&
      !!entry.terminal
    );
  }

  function admissionAvailable(): boolean {
    return (
      !sealed &&
      (!current || qualified(current)) &&
      (!recovery || knownCleanup(recovery.reader))
    );
  }

  function canSend(guard: ExecutionSendGuard): boolean {
    try {
      return (
        !sealed &&
        !guard.signal.aborted &&
        guard.stillCurrent() === true &&
        !sealed &&
        !guard.signal.aborted
      );
    } catch {
      return false;
    }
  }

  function hostCurrent(entry: Entry): boolean {
    // The original join still checks this scope after Adapter publication seals.
    return current === entry && !entry.retired;
  }

  function deactivate(entry: Entry): void {
    for (const subscription of entry.subscriptions) subscription.active = false;
    entry.subscriptions.clear();
  }

  function matches(entry: Entry, context: WindowsJournalReadContext): boolean {
    return !!entry.context && isDeepStrictEqual(entry.context, context);
  }

  function contextFor(
    target: ExecutionTarget,
    descriptor: OwnerDescriptor,
  ): WindowsJournalReadContext {
    return freezeWindowsJournalReadContext(
      {
        target: freezeWindowsControlBridgeTarget({
          identity: target.identity,
          launchTicket: target.launchTicket,
        }),
        executionPolicyFingerprint: descriptor.details
          .executionPolicyFingerprint as string,
      },
      descriptor,
    );
  }

  function notify(entry: Entry, subscription: Subscription): void {
    if (
      sealed ||
      !hostCurrent(entry) ||
      !entry.terminal ||
      !subscription.active ||
      subscription.delivered
    )
      return;
    subscription.delivered = true;
    entry.subscriptions.delete(subscription);
    const settle = reserve();
    try {
      subscription.listener(entry.terminal.exit);
    } catch {
      // One observer cannot revoke the strict cache or other subscriptions.
    } finally {
      settle();
    }
  }

  function readJournal(
    reader: Reader,
    context: WindowsJournalReadContext,
    stillCurrent: () => boolean,
  ): Promise<WindowsJournalReadResult> {
    if (reader.promise) return reader.promise;
    const pending = track(() =>
      Promise.resolve()
        .then(() => {
          if (!callerCurrent(stillCurrent) || reader.controller.signal.aborted)
            return unknownClosed;
          return reader.launcher.read(
            context.scope,
            context.descriptor,
            reader.controller.signal,
            stillCurrent,
          );
        })
        .catch(() => unknownOwned)
        .then((result) => {
          reader.result = result;
          if (result.cleanup === "unknown") reader.uncertain = true;
          return result;
        }),
    );
    reader.promise = pending;
    return pending;
  }

  function observe(
    entry: Entry,
  ): Promise<WindowsJournalReadResult> | undefined {
    if (
      sealed ||
      !hostCurrent(entry) ||
      !entry.context ||
      entry.hostResult?.kind !== "stopped" ||
      entry.hostResult.cleanup !== "closed" ||
      entry.hostCleanupUncertain
    )
      return undefined;
    if (entry.reader.promise) return entry.reader.promise;
    const stillCurrent = () =>
      !sealed && hostCurrent(entry) && !entry.reader.controller.signal.aborted;
    const pending = readJournal(entry.reader, entry.context, stillCurrent);
    void track(() =>
      pending.then((result) => {
        if (
          !stillCurrent() ||
          result.kind !== "read" ||
          result.cleanup !== "closed" ||
          entry.reader.uncertain ||
          result.interpretation.kind === "unknown" ||
          entry.terminal
        )
          return;
        entry.terminal = result.interpretation;
        for (const subscription of [...entry.subscriptions])
          notify(entry, subscription);
      }),
    );
    return pending;
  }

  function hostResult(
    entry: Entry,
    result: WindowsControlBridgeCloseResult,
  ): void {
    if (!entry.hostResult) entry.hostResult = result;
    if (result.cleanup === "unknown") entry.hostCleanupUncertain = true;
    void observe(entry);
  }

  function closeHost(entry: Entry): Promise<WindowsControlBridgeCloseResult> {
    return track(() => {
      try {
        return entry.host.close().then(
          (result) => {
            hostResult(entry, result);
            return result;
          },
          () => {
            hostResult(entry, unknownHost);
            return unknownHost;
          },
        );
      } catch {
        hostResult(entry, unknownHost);
        return Promise.resolve(unknownHost);
      }
    });
  }

  async function readContext(
    context: WindowsJournalReadContext,
  ): Promise<Terminal | undefined> {
    if (sealed) return undefined;
    const entry = current;
    if (entry && matches(entry, context)) {
      if (!entry.terminal) {
        const pending = observe(entry);
        if (pending) await pending;
      }
      return !sealed && hostCurrent(entry) ? entry.terminal : undefined;
    }
    if (entry && !qualified(entry)) return undefined;
    let slot = recovery;
    if (slot) {
      const same = isDeepStrictEqual(slot.context, context);
      if (
        same &&
        slot.reader.result?.kind === "read" &&
        slot.reader.result.interpretation.kind !== "unknown" &&
        knownCleanup(slot.reader)
      )
        return slot.reader.result.interpretation;
      if (!slot.reader.result) {
        if (!same) return undefined;
      } else {
        if (!knownCleanup(slot.reader)) return undefined;
        slot = { context, reader: createReader(slot.reader.launcher) };
        recovery = slot;
      }
    } else {
      slot = { context, reader: createReader() };
      recovery = slot;
    }
    const original = slot;
    const stillCurrent = () =>
      !sealed &&
      recovery === original &&
      !original.reader.controller.signal.aborted;
    const result = await readJournal(
      original.reader,
      original.context,
      stillCurrent,
    );
    if (
      !stillCurrent() ||
      !knownCleanup(original.reader) ||
      result.kind !== "read" ||
      result.interpretation.kind === "unknown"
    )
      return undefined;
    return result.interpretation;
  }

  function close(interrupt = false): Promise<Cleanup> {
    if (closePromise) return closePromise;
    const settle = reserve();
    sealed = true;
    let resolveClose!: (value: Cleanup) => void;
    closePromise = new Promise<Cleanup>((resolve) => {
      resolveClose = resolve;
    });
    void closePromise.then(settle, settle);
    const entry = current;
    const readers = [entry?.reader, recovery?.reader].filter(
      (reader): reader is Reader => !!reader,
    );
    if (entry) {
      deactivate(entry);
      entry.removeRunnerAbort();
      if (interrupt) entry.hostController.abort();
    }
    const results: Promise<Cleanup>[] = readers.map((reader) => {
      reader.controller.abort();
      try {
        return reader.launcher.close().catch(() => "unknown" as const);
      } catch {
        return Promise.resolve<Cleanup>("unknown");
      }
    });
    if (entry) results.push(closeHost(entry).then((result) => result.cleanup));
    void Promise.all(results).then(
      (cleanup) => {
        closeResult =
          cleanup.every((value) => value === "closed") &&
          !entry?.hostCleanupUncertain &&
          readers.every((reader) => !reader.uncertain)
            ? "closed"
            : "unknown";
        resolveClose(closeResult);
      },
      () => {
        closeResult = "unknown";
        resolveClose(closeResult);
      },
    );
    return closePromise;
  }

  const adapter: WindowsExecutionAdapter = {
    kind: "windows",
    pendingWork() {
      return pendingCount;
    },
    status(): WindowsExecutionStatus {
      let activity: WindowsExecutionStatus["activity"] = "idle";
      if (
        current?.hostCleanupUncertain ||
        current?.reader.uncertain ||
        recovery?.reader.uncertain ||
        closeResult === "unknown"
      )
        activity = "cleanup_unknown";
      else if (
        current?.hostResult?.kind === "unknown" ||
        unknownRead(current?.reader) ||
        unknownRead(recovery?.reader) ||
        (current?.hostResult?.kind === "stopped" && !current.context)
      )
        activity = "unknown";
      else if (
        (current && !qualified(current)) ||
        (recovery && !knownCleanup(recovery.reader))
      )
        activity = "busy";
      const receipt =
        current?.hostResult?.kind === "stopped"
          ? current.hostResult.runtimeObservation
          : undefined;
      const runtimeObservation =
        activity === "idle" &&
        current &&
        hostCurrent(current) &&
        qualified(current) &&
        receipt &&
        isDeepStrictEqual(receipt.descriptor, current.context?.descriptor)
          ? receipt
          : undefined;
      return Object.freeze({
        sealed,
        activity,
        close: closeResult ?? (closePromise ? "pending" : "not_requested"),
        ...(runtimeObservation ? { runtimeObservation } : {}),
        ...(current?.prepareDiagnostic ? { prepareDiagnostic: current.prepareDiagnostic } : {}),
      });
    },
    prepare(attempt, guard) {
      return track(async () => {
        let owned: Entry | undefined;
        try {
          if (!admissionAvailable()) unavailable();
          let request = freezeWindowsPrepareRequest(attempt);
          const spec = JSON.parse(
            Buffer.from(request.requestUtf8Base64, "base64").toString("utf8"),
          ) as {
            target: ExecutionTarget;
            executionPolicy: {
              fingerprint: string;
              limits: { executionTimeoutMs: number; cancelGraceMs: number };
            };
          };
          const scope = Object.freeze({
            target: freezeWindowsControlBridgeTarget(spec.target),
            executionPolicyFingerprint: spec.executionPolicy.fingerprint,
          });
          const cleanupTimeoutMs =
            spec.executionPolicy.limits.cancelGraceMs +
            bridge.limits.cleanupTimeoutMs;
          const required =
            spec.executionPolicy.limits.executionTimeoutMs + cleanupTimeoutMs;
          if (
            !Number.isSafeInteger(required) ||
            required > bridge.limits.sessionTimeoutMs
          )
            throw new EnhancementError("configuration_invalid");
          if (!canSend(guard) || !admissionAvailable()) unavailable();
          if (observeBootAttempt !== undefined) {
            let selected: boolean;
            try {
              selected = observeBootAttempt(attempt) === true;
            } catch {
              unavailable();
            }
            if (selected)
              request = freezeWindowsPrepareRequest(attempt, "boot-v1");
            if (!canSend(guard) || !admissionAvailable()) unavailable();
          }
          const host = createWindowsControlBridgeHost({
            ...bridge,
            limits: { ...bridge.limits, cleanupTimeoutMs },
          });
          const reader = createReader();
          const entry: Entry = {
            scope,
            request,
            host,
            reader,
            hostController: new AbortController(),
            subscriptions: new Set(),
            removeRunnerAbort() {},
            retired: false,
            hostCleanupUncertain: false,
          };
          if (current) {
            current.retired = true;
            current.removeRunnerAbort();
            deactivate(current);
          }
          current = owned = entry;
          const runnerSignal = guard.signal;
          const onRunnerClose = () => {
            if (hostCurrent(entry)) void close();
          };
          runnerSignal.addEventListener("abort", onRunnerClose, { once: true });
          entry.removeRunnerAbort = () => {
            try {
              runnerSignal.removeEventListener("abort", onRunnerClose);
            } catch {
              /* Retired callbacks remain inert. */
            }
          };
          void track(() =>
            host.whenClosed().then(
              (result) => hostResult(entry, result),
              () => hostResult(entry, unknownHost),
            ),
          );
          if (!canSend(guard) || !hostCurrent(entry)) unavailable();
          const opened = await host.open(entry.hostController.signal, () =>
            hostCurrent(entry),
          );
          if (opened.kind !== "bound" || !canSend(guard) || !hostCurrent(entry))
            unavailable();
          const prepared = await host.prepare(request, scope, guard);
          if (prepared.kind !== "prepared") {
            if (
              prepared.prepareDiagnostic && hostCurrent(entry) &&
              canSend(guard) && hostCurrent(entry)
            ) entry.prepareDiagnostic = freezeWindowsPrepareDiagnostic(prepared.prepareDiagnostic);
            unavailable();
          }
          const context = freezeWindowsJournalReadContext(
            scope,
            prepared.descriptor,
          );
          if (
            context.descriptor.executionId !== opened.binding.executionId ||
            context.descriptor.details.requestFingerprint !==
              request.requestFingerprint ||
            context.descriptor.details.installationManifestSha256 !==
              bridge.expectedManifestSha256 ||
            !isDeepStrictEqual(
              context.descriptor.details.supervisor,
              opened.binding.helper,
            )
          )
            unavailable();
          entry.context = context;
          if (sealed || !hostCurrent(entry)) unavailable();
          void observe(entry);
          return context.descriptor;
        } catch (error) {
          if (owned) void closeHost(owned);
          if (
            error instanceof EnhancementError &&
            error.code === "configuration_invalid"
          )
            throw error;
          return unavailable();
        }
      });
    },
    authorize(attempt, descriptor, guard) {
      return track(async () => {
        try {
          const entry = current;
          const context = contextFor(attempt, descriptor);
          if (
            sealed ||
            !entry ||
            !matches(entry, context) ||
            entry.hostResult ||
            attempt.executionPolicy.fingerprint !==
              entry.scope.executionPolicyFingerprint ||
            !canSend(guard)
          )
            unavailable();
          const result = await entry.host.authorize(
            entry.scope.target,
            entry.context!.descriptor,
            entry.request.requestFingerprint,
            guard,
          );
          if (result.kind !== "authorized" || sealed || !hostCurrent(entry))
            unavailable();
        } catch {
          unavailable();
        }
      });
    },
    inspect(target, descriptor) {
      return track(async () => {
        let original: ExecutionTarget;
        try {
          original = freezeWindowsControlBridgeTarget({
            identity: target.identity,
            launchTicket: target.launchTicket,
          });
        } catch {
          return unavailable();
        }
        const unknown: Inspection = Object.freeze({
          kind: "unknown",
          ...original,
        });
        try {
          if (sealed || !descriptor) return unknown;
          const context = contextFor(original, descriptor);
          const entry = current;
          if (
            entry &&
            matches(entry, context) &&
            !entry.terminal &&
            !entry.hostResult
          ) {
            const result = await entry.host.inspect(
              entry.hostController.signal,
              () => hostCurrent(entry),
            );
            if (sealed || !hostCurrent(entry)) return unknown;
            const cached = current?.terminal;
            if (cached)
              return Object.freeze({ kind: "tree-exited", exit: cached.exit });
            if (
              !entry.hostResult &&
              result.kind === "state" &&
              result.state.phase === "running" &&
              result.state.sealReason === null &&
              result.state.evidenceOutcome === "pending" &&
              result.state.completion === null &&
              result.state.authorizationVerified &&
              result.state.resumeState === "succeeded" &&
              result.state.requestFingerprint ===
                entry.request.requestFingerprint &&
              isDeepStrictEqual(
                result.state.descriptor,
                entry.context!.descriptor,
              )
            )
              return Object.freeze({
                kind: "owned-alive",
                ...original,
                descriptor: entry.context!.descriptor,
              });
            if (!entry.hostResult) return unknown;
          }
          const terminal = await readContext(context);
          return !sealed && terminal
            ? Object.freeze({ kind: "tree-exited", exit: terminal.exit })
            : unknown;
        } catch {
          return unknown;
        }
      });
    },
    requestStop(target, descriptor, request, guard) {
      return track(async () => {
        try {
          const entry = current;
          const context = contextFor(target, descriptor);
          if (
            sealed ||
            !entry ||
            !matches(entry, context) ||
            entry.hostResult ||
            !canSend(guard)
          )
            unavailable();
          const result = await entry.host.requestStop(
            entry.scope.target,
            entry.context!.descriptor,
            request,
            guard,
          );
          if (result.kind !== "stop-requested" || sealed || !hostCurrent(entry))
            unavailable();
        } catch {
          unavailable();
        }
      });
    },
    observeExit(target, descriptor, listener) {
      const entry = current;
      try {
        if (sealed || !entry || !matches(entry, contextFor(target, descriptor)))
          return () => {};
      } catch {
        return () => {};
      }
      const subscription: Subscription = {
        active: true,
        delivered: false,
        listener,
      };
      entry.subscriptions.add(subscription);
      notify(entry, subscription);
      return () => {
        subscription.active = false;
        entry.subscriptions.delete(subscription);
      };
    },
    readInterruptionEvidence(scope, stillCurrent) {
      return track(async () => {
        try {
          if (sealed || !callerCurrent(stillCurrent)) return undefined;
          const terminal = await readContext(
            contextFor(scope.target, scope.descriptor),
          );
          return !sealed &&
            callerCurrent(stillCurrent) &&
            terminal?.kind === "interrupted"
            ? terminal.records
            : undefined;
        } catch {
          return undefined;
        }
      });
    },
    close,
    // Resource closure alone does not prove a recoverable journal terminal.
    interrupt() {
      return close(true);
    },
  };
  return Object.freeze(adapter);
}
