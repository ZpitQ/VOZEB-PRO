import assert from "node:assert/strict";

import { vi } from "vitest";

import type { ExecutionTarget, OwnerDescriptor } from "../src/execution.js";
import type {
  WindowsControlBridgeCloseResult,
  WindowsControlBridgeHost,
} from "../src/windows-control-bridge-protocol.js";
import type { WindowsJournalLauncher } from "../src/windows-journal-launcher.js";
import {
  interpretWindowsJournalSnapshot,
  type WindowsJournalScope,
} from "../src/windows-journal-reader.js";
import type { FrozenWindowsRequest } from "../src/windows-prepare-payload.js";
import {
  controlBridgeBound,
  controlBridgeExecutionDescriptor,
  controlBridgeOptions,
  controlBridgeSnapshot,
} from "./windows-control-bridge-host-fixtures.js";
import { deferred } from "./http-fixtures.js";

export const runnerAdapterOptions = {
  bridge: controlBridgeOptions({
    limits: {
      ...controlBridgeOptions().limits,
      sessionTimeoutMs: 70_000,
    },
  }),
  journalLimits: {
    maxRequestBytes: 8_192,
    maxStdoutBytes: 32_768,
    maxStderrBytes: 128,
    readTimeoutMs: 1_000,
    cleanupTimeoutMs: 100,
  },
};

// These are module-port doubles, not Windows process or GPU evidence. The
// production reader still qualifies every synthetic journal before delivery.
export function runnerNativePorts() {
  const closed = deferred<WindowsControlBridgeCloseResult>();
  const authReply = deferred<void>();
  const authorized = deferred<void>();
  const documentReady = deferred<void>();
  const stopped = { kind: "stopped", cleanup: "closed" } as const;
  let originalRequest: FrozenWindowsRequest | undefined;
  let originalScope: WindowsJournalScope | undefined;
  let originalDescriptor: OwnerDescriptor | undefined;
  let document: unknown;
  let openCurrent: (() => boolean) | undefined;
  let holdAuthorization = false;
  const hooks: {
    prepare?: (target: ExecutionTarget) => void;
    authorize?: (target: ExecutionTarget, descriptor: OwnerDescriptor) => void;
    stop?: (
      ...args: Parameters<WindowsControlBridgeHost["requestStop"]>
    ) => void;
  } = {};
  const host = {
    open: vi.fn<WindowsControlBridgeHost["open"]>(async (signal, current) => {
      assert.equal(signal.aborted, false);
      assert.equal(current(), true);
      openCurrent = current;
      const { executionId, bridge, helper, state } = controlBridgeBound();
      return { kind: "bound", binding: { executionId, bridge, helper, state } };
    }),
    inspect: vi.fn<WindowsControlBridgeHost["inspect"]>(async () => ({
      kind: "state",
      state: controlBridgeSnapshot({
        phase: "running",
        requestFingerprint: originalRequest?.requestFingerprint ?? null,
        descriptor: originalDescriptor ?? null,
        authorizationVerified: true,
        resumeState: "succeeded",
      }),
    })),
    prepare: vi.fn<WindowsControlBridgeHost["prepare"]>(
      async (request, expected, guard) => {
        assert.equal(guard.stillCurrent(), true);
        hooks.prepare?.(expected.target);
        assert.equal(guard.takeSendPermission(), true);
        originalRequest = request;
        originalScope = expected;
        originalDescriptor = controlBridgeExecutionDescriptor(
          expected.target,
          expected.executionPolicyFingerprint,
          request.requestFingerprint,
        );
        return { kind: "prepared", descriptor: originalDescriptor };
      },
    ),
    authorize: vi.fn<WindowsControlBridgeHost["authorize"]>(
      async (target, descriptor, fingerprint, guard) => {
        assert.deepEqual(target, originalScope?.target);
        assert.deepEqual(descriptor, originalDescriptor);
        assert.equal(fingerprint, originalRequest?.requestFingerprint);
        assert.equal(guard.stillCurrent(), true);
        hooks.authorize?.(target, descriptor);
        assert.equal(guard.takeSendPermission(), true);
        authorized.resolve();
        if (holdAuthorization) await authReply.promise;
        return { kind: "authorized" };
      },
    ),
    requestStop: vi.fn<WindowsControlBridgeHost["requestStop"]>(
      async (...args) => {
        const [target, descriptor, , guard] = args;
        assert.deepEqual(target, originalScope?.target);
        assert.deepEqual(descriptor, originalDescriptor);
        assert.equal(guard.stillCurrent(), true);
        hooks.stop?.(...args);
        assert.equal(guard.takeSendPermission(), true);
        return { kind: "stop-requested" };
      },
    ),
    whenClosed: vi.fn<WindowsControlBridgeHost["whenClosed"]>(
      () => closed.promise,
    ),
    close: vi.fn<WindowsControlBridgeHost["close"]>(async () => {
      // Closing the owner must not invalidate its original Host scope first.
      assert.equal(openCurrent?.(), true);
      authReply.resolve();
      closed.resolve(stopped);
      return stopped;
    }),
  } satisfies WindowsControlBridgeHost;

  function journal() {
    let sealed = false;
    const cancelled = deferred<void>();
    const reached = deferred<void>();
    const reader = {
      read: vi.fn<WindowsJournalLauncher["read"]>(
        async (scope, descriptor, signal, current) => {
          assert.equal(sealed, false);
          assert.equal(signal.aborted, false);
          assert.equal(current(), true);
          assert.deepEqual(scope, originalScope);
          assert.deepEqual(descriptor, originalDescriptor);
          reached.resolve();
          const abort = () => cancelled.resolve();
          signal.addEventListener("abort", abort, { once: true });
          try {
            const ready = await Promise.race([
              documentReady.promise.then(() => true),
              cancelled.promise.then(() => false),
            ]);
            if (!ready || sealed || signal.aborted || !current())
              return { kind: "unknown", cleanup: "closed" };
            return {
              kind: "read",
              interpretation: interpretWindowsJournalSnapshot(
                document,
                scope,
                descriptor,
              ),
              cleanup: "closed",
            };
          } finally {
            signal.removeEventListener("abort", abort);
          }
        },
      ),
      close: vi.fn<WindowsJournalLauncher["close"]>(async () => {
        sealed = true;
        cancelled.resolve();
        return "closed";
      }),
    } satisfies WindowsJournalLauncher;
    return { reader, reached: reached.promise };
  }

  function terminal(kind: "engine-exit" | "stop" | "deadline", exitCode = 0) {
    assert.ok(originalRequest && originalScope && originalDescriptor);
    document = terminalDocument(
      originalRequest,
      originalScope,
      originalDescriptor,
      kind,
      exitCode,
    );
    const interpretation = interpretWindowsJournalSnapshot(
      document,
      originalScope,
      originalDescriptor,
    );
    assert.notEqual(interpretation.kind, "unknown");
    assert.equal(interpretation.kind, kind);
    assert.ok("exit" in interpretation);
    documentReady.resolve();
    return interpretation;
  }

  return {
    host,
    hooks,
    journal,
    authorized: authorized.promise,
    get request() {
      assert.ok(originalRequest);
      return originalRequest;
    },
    get scope() {
      assert.ok(originalScope);
      return originalScope;
    },
    get descriptor() {
      assert.ok(originalDescriptor);
      return originalDescriptor;
    },
    holdAuthorization() {
      holdAuthorization = true;
    },
    acknowledgeAuthorization() {
      authReply.resolve();
    },
    terminal,
    finish(kind: "engine-exit" | "stop" | "deadline", exitCode = 0) {
      const result = terminal(kind, exitCode);
      closed.resolve(stopped);
      return result;
    },
    release() {
      authReply.resolve();
      closed.resolve(stopped);
    },
  };
}

function terminalDocument(
  request: FrozenWindowsRequest,
  scope: WindowsJournalScope,
  descriptor: OwnerDescriptor,
  kind: "engine-exit" | "stop" | "deadline",
  exitCode: number,
) {
  const spec = JSON.parse(
    Buffer.from(request.requestUtf8Base64, "base64").toString("utf8"),
  ) as {
    inputPath: string;
    outputPath: string;
    engine: { modelId: string; tile: number; gpuId: number };
  };
  const requestId = "00000000000000000000000000000001";
  const preparedId = "00000000000000000000000000000002";
  const authorizationId = "00000000000000000000000000000003";
  const terminalId = "00000000000000000000000000000006";
  const publicScope = { target: scope.target, descriptor };
  const envelope = (
    recordId: string | null,
    record: unknown,
    digit: string,
  ) => ({
    status: "existing",
    snapshot: {
      v: 1,
      kind: recordId === null ? "reservation" : "record",
      scope,
      executionId: descriptor.executionId,
      recordId,
      rootIdentity: { volumeSerial: "17", fileId: "1".repeat(32) },
      reservationIdentity: { volumeSerial: "17", fileId: "2".repeat(32) },
      fileIdentity: { volumeSerial: "17", fileId: digit.repeat(32) },
      record,
    },
  });
  return {
    v: 1,
    kind: "windows-journal-snapshot",
    reservation: envelope(null, null, "3"),
    records: {
      request: envelope(
        requestId,
        {
          v: 1,
          kind: "windows-request",
          recordId: requestId,
          ...request,
          resolvedLaunch: {
            recipeId: descriptor.details.recipeId,
            installationManifestSha256:
              descriptor.details.installationManifestSha256,
            executablePath: "Z:\\contract-only\\installation\\upscayl.exe",
            argv: [
              "-i",
              spec.inputPath,
              "-o",
              spec.outputPath,
              "-n",
              spec.engine.modelId,
              "-s",
              "4",
              "-t",
              String(spec.engine.tile),
              "-g",
              String(spec.engine.gpuId),
              "-m",
              "Z:\\contract-only\\installation\\models",
              "-f",
              "png",
            ],
          },
        },
        "4",
      ),
      prepared: envelope(
        preparedId,
        {
          v: 1,
          kind: "windows-prepared",
          recordId: preparedId,
          requestRecordId: requestId,
          requestFingerprint: request.requestFingerprint,
          scope: publicScope,
        },
        "5",
      ),
      authorization: envelope(
        authorizationId,
        {
          v: 1,
          kind: "authorized",
          recordId: authorizationId,
          scope: publicScope,
        },
        "6",
      ),
      controllerLoss: { status: "unknown", snapshot: null },
      terminal: envelope(
        terminalId,
        {
          v: 1,
          kind: "windows-terminal",
          recordId: terminalId,
          scope,
          requestRecordId: requestId,
          requestFingerprint: request.requestFingerprint,
          preparedRecordId: preparedId,
          descriptor,
          authorizationRecordId: authorizationId,
          resumeState: "succeeded",
          completion: { kind },
          proof: {
            kind: "engine-tree",
            engine: descriptor.details.engine,
            jobName: descriptor.details.jobName,
            exitCode,
            treeExited: true,
            activeProcesses: 0,
            stdoutEof: true,
            stderrEof: true,
          },
          authorizationsSealed: true,
        },
        "8",
      ),
    },
  };
}
