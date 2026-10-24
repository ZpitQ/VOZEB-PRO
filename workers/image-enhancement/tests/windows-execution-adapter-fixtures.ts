import { vi } from "vitest";

import {
  freezeDurableInterruptionRecords,
  freezeExecutionExit,
  type ClaimedAttempt,
  type ExecutionSendGuard,
} from "../src/execution.js";
import {
  freezeWindowsControlBridgeDescriptor,
  type WindowsControlBridgeHost,
} from "../src/windows-control-bridge-protocol.js";
import type { WindowsExecutionAdapterOptions } from "../src/windows-execution-adapter.js";
import type {
  WindowsJournalLauncher,
  WindowsJournalReadResult,
} from "../src/windows-journal-launcher.js";
import type { WindowsJournalInterpretation } from "../src/windows-journal-reader.js";
import {
  controlBridgeBound,
  controlBridgeExecutionDescriptor,
  controlBridgeOptions,
  controlBridgeSnapshot,
  controlBridgeTestLimits,
} from "./windows-control-bridge-host-fixtures.js";
import {
  carrier,
  claimedAttempt,
  independentSpec,
} from "./windows-prepare-payload-fixtures.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

export async function flushAdapter(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export function sendPermission() {
  const controller = new AbortController();
  let active = true;
  let used = false;
  const guard: ExecutionSendGuard = Object.freeze({
    signal: controller.signal,
    stillCurrent: vi.fn(() => active && !controller.signal.aborted),
    takeSendPermission: vi.fn(() => {
      if (used || !active || controller.signal.aborted) return false;
      used = true;
      return true;
    }),
  });
  return {
    guard,
    seal() {
      active = false;
    },
    abort() {
      controller.abort();
    },
  };
}

let serial = 0;

// Complete factory-boundary doubles: only explicit test replies resolve them.
// They do not implement Adapter admission, observation, caching or cleanup.
export function adapterBoundary(attempt: ClaimedAttempt = claimedAttempt()) {
  const spec = independentSpec(attempt);
  const request = Object.freeze(carrier(JSON.stringify(spec)));
  const scope = {
    target: spec.target,
    executionPolicyFingerprint: spec.executionPolicy.fingerprint,
  };
  const descriptor = freezeWindowsControlBridgeDescriptor({
    ...controlBridgeExecutionDescriptor(
      scope.target,
      scope.executionPolicyFingerprint,
      request.requestFingerprint,
    ),
    executionId: (++serial).toString(16).padStart(32, "0"),
  });
  const { bridge, helper, state } = controlBridgeBound();
  const opened =
    deferred<Awaited<ReturnType<WindowsControlBridgeHost["open"]>>>();
  const prepared =
    deferred<Awaited<ReturnType<WindowsControlBridgeHost["prepare"]>>>();
  const authorized =
    deferred<Awaited<ReturnType<WindowsControlBridgeHost["authorize"]>>>();
  const stopped =
    deferred<Awaited<ReturnType<WindowsControlBridgeHost["requestStop"]>>>();
  const inspected =
    deferred<Awaited<ReturnType<WindowsControlBridgeHost["inspect"]>>>();
  const closed =
    deferred<Awaited<ReturnType<WindowsControlBridgeHost["whenClosed"]>>>();
  const read = deferred<WindowsJournalReadResult>();
  const readerClosed = deferred<"closed" | "unknown">();
  opened.resolve({
    kind: "bound",
    binding: { executionId: descriptor.executionId, bridge, helper, state },
  });

  const host = {
    open: vi.fn<WindowsControlBridgeHost["open"]>(() => opened.promise),
    inspect: vi.fn<WindowsControlBridgeHost["inspect"]>(
      () => inspected.promise,
    ),
    prepare: vi.fn<WindowsControlBridgeHost["prepare"]>(() => prepared.promise),
    authorize: vi.fn<WindowsControlBridgeHost["authorize"]>(
      () => authorized.promise,
    ),
    requestStop: vi.fn<WindowsControlBridgeHost["requestStop"]>(
      () => stopped.promise,
    ),
    whenClosed: vi.fn<WindowsControlBridgeHost["whenClosed"]>(
      () => closed.promise,
    ),
    close: vi.fn<WindowsControlBridgeHost["close"]>(() => closed.promise),
  } satisfies WindowsControlBridgeHost;
  const reader = {
    read: vi.fn<WindowsJournalLauncher["read"]>(() => read.promise),
    close: vi.fn<WindowsJournalLauncher["close"]>(() => readerClosed.promise),
  } satisfies WindowsJournalLauncher;
  const options: WindowsExecutionAdapterOptions = {
    bridge: controlBridgeOptions({
      limits: {
        ...controlBridgeTestLimits,
        maxRequestFrameBytes: 16_384,
        maxResponseFrameBytes: 16_384,
        maxSessionInputBytes: 131_072,
        maxSessionOutputBytes: 131_072,
        maxQueuedOutputBytes: 16_384,
        maxJsonDepth: 6,
        sessionTimeoutMs: 120_000,
      },
    }),
    journalLimits: {
      maxRequestBytes: 16_384,
      maxStdoutBytes: 65_536,
      maxStderrBytes: 128,
      readTimeoutMs: 200,
      cleanupTimeoutMs: 50,
    },
  };

  function terminal(
    kind: "engine-exit" | "stop" | "deadline" | "interrupted" = "engine-exit",
  ): Exclude<WindowsJournalInterpretation, Readonly<{ kind: "unknown" }>> {
    const publicScope = { target: scope.target, descriptor };
    const records = freezeDurableInterruptionRecords(
      {
        authorization: {
          v: 1,
          recordId: "00000000000000000000000000000003",
          kind: "authorized",
          scope: publicScope,
        },
        controllerLoss: {
          v: 1,
          recordId: "00000000000000000000000000000005",
          kind: "controller-lost",
          authorizationRecordId: "00000000000000000000000000000003",
          scope: publicScope,
        },
        terminal: {
          v: 1,
          recordId: "00000000000000000000000000000006",
          kind: "terminal",
          completion: "interrupted",
          authorizationRecordId: "00000000000000000000000000000003",
          controllerLossRecordId: "00000000000000000000000000000005",
          treeExited: true,
          authorizationsSealed: true,
          scope: publicScope,
        },
      },
      publicScope,
    );
    const exit = freezeExecutionExit(
      {
        identity: scope.target.identity,
        descriptor,
        launchTicket: scope.target.launchTicket,
        treeExited: true,
        ...(kind === "engine-exit"
          ? {
              completion: {
                kind: "success" as const,
                exitCode: 0 as const,
                signal: null,
              },
            }
          : kind === "interrupted"
            ? {
                completion: {
                  kind: "interrupted" as const,
                  authorizationRecordId: records.authorization.recordId,
                  controllerLossRecordId: records.controllerLoss.recordId,
                  terminalRecordId: records.terminal.recordId,
                },
              }
            : {}),
      },
      scope.target,
      descriptor,
    );
    if (kind === "interrupted") return Object.freeze({ kind, exit, records });
    if (kind === "engine-exit") return Object.freeze({ kind, exit });
    return Object.freeze({ kind, exit });
  }

  return {
    attempt,
    request,
    scope,
    descriptor,
    options,
    host,
    reader,
    prepared,
    authorized,
    stopped,
    inspected,
    closed,
    read,
    readerClosed,
    terminal,
    running() {
      return controlBridgeSnapshot({
        phase: "running",
        requestFingerprint: request.requestFingerprint,
        descriptor,
        authorizationVerified: true,
        resumeState: "succeeded",
      });
    },
    release() {
      prepared.resolve({ kind: "unknown", cleanup: "closed" });
      authorized.resolve({ kind: "unknown", cleanup: "closed" });
      stopped.resolve({ kind: "unknown", cleanup: "closed" });
      inspected.resolve({ kind: "unknown", cleanup: "closed" });
      closed.resolve({ kind: "stopped", cleanup: "closed" });
      read.resolve({ kind: "unknown", cleanup: "closed" });
      readerClosed.resolve("closed");
    },
  };
}

export type AdapterBoundary = ReturnType<typeof adapterBoundary>;
