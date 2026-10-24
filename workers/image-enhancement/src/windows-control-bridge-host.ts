import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import type {
  ExecutionSendGuard,
  ExecutionStopRequest,
  ExecutionTarget,
  OwnerDescriptor,
} from "./execution.js";
import type { FrozenWindowsRequest } from "./windows-prepare-payload.js";

import {
  decodeWindowsControlBridgeResponse,
  freezeWindowsControlBridgeOptions,
  freezeWindowsControlBridgeTarget,
  freezeWindowsControlBridgeDescriptor,
  freezeWindowsControlBridgeStopRequest,
  type WindowsControlBridgeBinding,
  type WindowsControlBridgeCloseResult,
  type WindowsControlBridgeHost,
  type WindowsControlBridgeInspectResult,
  type WindowsControlBridgeOpenResult,
  type WindowsControlBridgeOptions,
  type WindowsControlBridgeResponse,
  type WindowsControlBridgeSnapshot,
  type WindowsControlBridgeUnknown,
  type WindowsRuntimeObservationReceipt,
  type WindowsPrepareDiagnostic,
} from "./windows-control-bridge-protocol.js";

const unknownClosed: WindowsControlBridgeUnknown = Object.freeze({
  kind: "unknown",
  cleanup: "closed",
});
const unknownOwned: WindowsControlBridgeUnknown = Object.freeze({
  kind: "unknown",
  cleanup: "unknown",
});
const busy = Object.freeze({ kind: "busy" } as const);
const stopped: WindowsControlBridgeCloseResult = Object.freeze({
  kind: "stopped",
  cleanup: "closed",
});

// An unproved original join retains its owner even if the caller drops the host.
// This is neither a process registry nor authority to reopen/replace a process.
const retainedOwners = new Set<() => void>();
type Timer = ReturnType<typeof setTimeout> | undefined;
type Scope = {
  signal: AbortSignal;
  stillCurrent: () => boolean;
  removeAbort: () => void;
};
type Inspect = {
  op: "inspect";
  id: string;
  scope: Scope;
  deadline: number;
  timer: Timer;
  written: boolean;
  response: WindowsControlBridgeSnapshot | undefined;
  responseSeen: boolean;
  resolve: (value: WindowsControlBridgeInspectResult) => void;
};
type ExecutionResult =
  | Readonly<{ kind: "prepared"; descriptor: OwnerDescriptor }>
  | Readonly<{ kind: "authorized" }>
  | Readonly<{ kind: "stop-requested" }>
  | WindowsControlBridgeUnknown;
type Phase = Omit<Inspect, "op" | "resolve"> & {
  op: "prepare" | "authorize" | "request-stop";
  permissionTaken: boolean;
  permissionGranted: boolean;
  permitWritten: boolean;
  takePermission: () => boolean;
  settled: boolean;
  prepareDiagnostic?: WindowsPrepareDiagnostic;
  resolve: (value: ExecutionResult) => void;
};
type Request = Inspect | Phase;
type Stop = Phase & {
  request: ExecutionStopRequest;
  promise: Promise<ExecutionResult>;
};

export function createWindowsControlBridgeHost(
  options: WindowsControlBridgeOptions,
): WindowsControlBridgeHost {
  const configured = freezeWindowsControlBridgeOptions(options);
  const { limits } = configured;
  const configuration = JSON.stringify({
    v: 1,
    helperPath: configured.helperPath,
    recordsRoot: configured.recordsRoot,
    installationRoot: configured.installationRoot,
    expectedManifestSha256: configured.expectedManifestSha256,
    environment: configured.environment,
    limits,
  });
  let admitted = false;
  let attempted = false;
  let sealed = false;
  let failed = false;
  let released = false;
  let closeStarted = false;
  let original: ChildProcess | undefined;
  let originalPid: number | undefined;
  let stdin: Writable | null = null;
  let stdout: Readable | null = null;
  let stderr: Readable | null = null;
  let spawned = false;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let childClosed = false;
  let closeCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;
  let stdinEnded = false;
  let stdinFinished = false;
  let stdinClosed = false;
  let stdoutEnded = false;
  let stdoutClosed = false;
  let stderrEnded = false;
  let stderrClosed = false;
  let pendingWrites = 0;
  let closeWritten = false;
  let inputBytes = 0;
  let outputBytes = 0;
  let stderrBytes = 0;
  let capturedBytes = 0;
  const capture: Buffer[] = [];
  const usedIds = new Set<string>();
  let binding: WindowsControlBridgeBinding | undefined;
  let seenSealedState = false;
  let terminalSeen = false;
  let endingSeen = false;
  let closeId: string | undefined;
  let openScope: Scope | undefined;
  let startupDeadline: number | undefined;
  let sessionDeadline: number | undefined;
  let cleanupDeadline: number | undefined;
  let startupTimer: Timer;
  let sessionTimer: Timer;
  let cleanupTimer: Timer;
  let resolveOpen:
    ((value: WindowsControlBridgeOpenResult) => void) | undefined;
  let inspectRequest: Request | undefined;
  let preemptedInspect: Inspect | undefined;
  let prepareRequest: Phase | undefined;
  let authorizeRequest: Phase | undefined;
  let softRequest: Stop | undefined, forceRequest: Stop | undefined;
  let authorizeSucceeded = false;
  let executionContext:
    | Readonly<{
        request: FrozenWindowsRequest;
        target: ExecutionTarget;
        policy: string;
      }>
    | undefined;
  let preparedDescriptor: OwnerDescriptor | undefined;
  let runtimeObservation: WindowsRuntimeObservationReceipt | undefined;
  let observationSealed = false;
  let prepareTaken = false;
  let authorizeTaken = false;
  let closePromise: Promise<WindowsControlBridgeCloseResult> | undefined;
  let resolveClose:
    ((value: WindowsControlBridgeCloseResult) => void) | undefined;
  let closeSettled = false;

  function ensureClose(): Promise<WindowsControlBridgeCloseResult> {
    if (!closePromise)
      closePromise = new Promise((resolve) => {
        resolveClose = resolve;
      });
    return closePromise;
  }

  function finishOpen(value: WindowsControlBridgeOpenResult): void {
    if (!resolveOpen) return;
    const resolve = resolveOpen;
    resolveOpen = undefined;
    clearTimeout(startupTimer);
    startupTimer = undefined;
    startupDeadline = undefined;
    resolve(value);
  }

  function finishInspect(value: WindowsControlBridgeInspectResult): void {
    if (!inspectRequest || inspectRequest.op !== "inspect") return;
    const request = inspectRequest;
    inspectRequest = undefined;
    clearTimeout(request.timer);
    request.scope.removeAbort();
    request.resolve(value);
  }

  function finishPhase(value: ExecutionResult): void {
    if (!inspectRequest || inspectRequest.op === "inspect") return;
    const request = inspectRequest;
    inspectRequest = undefined;
    settlePhase(request, value);
  }

  function settlePhase(request: Phase, value: ExecutionResult): void {
    if (request.settled) return;
    const diagnostic = request.prepareDiagnostic;
    if (
      value.kind === "unknown" && diagnostic && request.op === "prepare" &&
      request === prepareRequest && request.written && request.permitWritten &&
      request.permissionTaken && request.permissionGranted && openScope &&
      current(openScope) && current(request.scope) && !request.scope.signal.aborted &&
      !openScope.signal.aborted && !request.settled
    ) value = Object.freeze({ ...value, prepareDiagnostic: diagnostic });
    if (request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    request.scope.removeAbort();
    request.resolve(value);
  }

  function finishBusiness(value: WindowsControlBridgeUnknown): void {
    for (const request of [softRequest, forceRequest])
      if (request) settlePhase(request, value);
  }

  function pendingPhase(request: Phase): boolean {
    return (
      !request.settled &&
      (request.op === "request-stop"
        ? request === softRequest || request === forceRequest
        : request === inspectRequest)
    );
  }

  function finishClose(value: WindowsControlBridgeCloseResult): void {
    if (closeSettled) return;
    closeSettled = true;
    clearTimeout(cleanupTimer);
    cleanupTimer = undefined;
    resolveClose?.(value);
  }

  function unknown(cleanup: "closed" | "unknown"): void {
    const value = cleanup === "closed" ? unknownClosed : unknownOwned;
    finishOpen(value);
    finishInspect(value);
    finishPhase(value);
    finishBusiness(value);
    finishClose(value);
  }

  function scope(signal: AbortSignal, stillCurrent: () => boolean): Scope {
    const result: Scope = { signal, stillCurrent, removeAbort() {} };
    try {
      signal.addEventListener("abort", fault, { once: true });
      result.removeAbort = () => {
        try {
          signal.removeEventListener("abort", fault);
        } catch {
          /* Sanitized caller boundary. */
        }
      };
    } catch {
      fault();
    }
    return result;
  }

  function current(value: Scope): boolean {
    try {
      if (value.signal.aborted || !value.stillCurrent() || value.signal.aborted)
        return false;
      return true;
    } catch {
      return false;
    }
  }

  function admissionCurrent(request?: Request): boolean {
    if (failed || sealed) return false;
    const expired = () => {
      const now = performance.now();
      return (
        (startupDeadline !== undefined && now >= startupDeadline) ||
        (sessionDeadline !== undefined && now >= sessionDeadline) ||
        !!(request && now >= request.deadline) ||
        !!(inspectRequest && now >= inspectRequest.deadline) ||
        [softRequest, forceRequest].some(
          (value) => !!value && !value.settled && now >= value.deadline,
        )
      );
    };
    if (
      expired() ||
      !openScope ||
      !current(openScope) ||
      (request && !current(request.scope))
    ) {
      fault();
      return false;
    }
    // Scope callbacks may synchronously request close.
    if (sealed || failed) return false;
    if (expired()) {
      fault();
      return false;
    }
    return true;
  }

  function endInput(frame?: Buffer): void {
    if (!stdin || stdinEnded) return;
    stdinEnded = true;
    pendingWrites++;
    try {
      const finished = (error?: Error | null) => {
        pendingWrites--;
        if (error) fault();
        else if (frame) closeWritten = true;
        observe();
      };
      if (frame) stdin.end(frame, finished);
      else stdin.end(finished);
    } catch {
      // A thrown write does not manufacture the missing original callback.
      fault();
    }
  }

  function seal(): void {
    if (sealed) return;
    sealed = true;
    finishBusiness(unknownOwned);
    clearTimeout(startupTimer);
    clearTimeout(sessionTimer);
    startupTimer = sessionTimer = undefined;
    startupDeadline = sessionDeadline = undefined;
    ensureClose();
    if (!attempted) {
      released = true;
      openScope?.removeAbort();
      unknown("closed");
      return;
    }
    cleanupDeadline = performance.now() + limits.cleanupTimeoutMs;
    cleanupTimer = setTimeout(expireCleanup, limits.cleanupTimeoutMs);
  }

  function expireCleanup(): void {
    failed = true;
    capture.length = 0;
    capturedBytes = 0;
    unknown("unknown");
  }

  function fault(): void {
    if (released) return;
    failed = true;
    capture.length = 0;
    capturedBytes = 0;
    seal();
    endInput();
    observe();
  }

  function resourceJoin(): boolean {
    return (
      !!original &&
      originalPid !== undefined &&
      spawned &&
      exited &&
      stdoutEnded &&
      stderrEnded &&
      stdinClosed &&
      stdoutClosed &&
      stderrClosed &&
      childClosed &&
      pendingWrites === 0
    );
  }

  function observe(): void {
    if (released || !sealed) return;
    if (cleanupDeadline !== undefined && performance.now() >= cleanupDeadline)
      expireCleanup();
    if (!resourceJoin()) return;
    if (!failed) {
      const scopeCurrent = !!openScope && current(openScope);
      if (released) return;
      // Caller code itself can cross the deadline while the timer is blocked.
      if (cleanupDeadline !== undefined && performance.now() >= cleanupDeadline)
        expireCleanup();
      if (
        cleanupDeadline === undefined ||
        !scopeCurrent ||
        !terminalSeen ||
        (!closeWritten && !endingSeen) ||
        !stdinFinished ||
        exitCode !== 0 ||
        exitSignal !== null ||
        closeCode !== exitCode ||
        closeSignal !== exitSignal ||
        stderrBytes !== 0
      )
        failed = true;
    }
    released = true;
    retainedOwners.delete(observe);
    openScope?.removeAbort();
    clearTimeout(startupTimer);
    clearTimeout(sessionTimer);
    clearTimeout(cleanupTimer);
    if (failed) unknown("closed");
    else {
      finishOpen(unknownClosed);
      finishInspect(unknownClosed);
      finishPhase(unknownClosed);
      finishBusiness(unknownClosed);
      const receipt =
        runtimeObservation &&
        (!preparedDescriptor ||
          isDeepStrictEqual(runtimeObservation.descriptor, preparedDescriptor))
          ? runtimeObservation
          : undefined;
      finishClose(
        receipt
          ? Object.freeze({ ...stopped, runtimeObservation: receipt })
          : stopped,
      );
    }
  }

  function command(
    op: "inspect" | "close" | "prepare" | "authorize" | "request-stop",
    fields: Readonly<Record<string, unknown>> = {},
  ): { id: string; frame: Buffer } | undefined {
    try {
      const id = randomBytes(16).toString("hex");
      if (!/^[a-f0-9]{32}$/.test(id) || usedIds.has(id) || !binding) {
        fault();
        return;
      }
      const frame = Buffer.from(
        `${JSON.stringify({ v: 1, kind: "command", requestId: id, op, executionId: binding.executionId, ...fields })}\n`,
        "utf8",
      );
      if (
        frame.length > limits.maxRequestFrameBytes ||
        inputBytes > limits.maxSessionInputBytes - frame.length
      ) {
        inputBytes = Math.min(
          limits.maxSessionInputBytes + 1,
          inputBytes + frame.length,
        );
        fault();
        return;
      }
      inputBytes += frame.length;
      usedIds.add(id);
      return { id, frame };
    } catch {
      fault();
      return;
    }
  }

  function publishInspect(request: Inspect): void {
    if (
      inspectRequest !== request ||
      !request.response ||
      !request.written ||
      sealed ||
      failed
    )
      return;
    if (!admissionCurrent(request)) return;
    finishInspect(Object.freeze({ kind: "state", state: request.response }));
  }

  function matchesState(state: WindowsControlBridgeSnapshot): boolean {
    if (state.runtimeObservation != null) {
      if (!executionContext) return false;
      try {
        const payload: unknown = JSON.parse(
          Buffer.from(
            executionContext.request.requestUtf8Base64,
            "base64",
          ).toString("utf8"),
        );
        if (
          !payload ||
          typeof payload !== "object" ||
          Object.getOwnPropertyDescriptor(payload, "runtimeObservation")
            ?.value !== "boot-v1"
        )
          return false;
      } catch {
        return false;
      }
    }
    if (!executionContext || !prepareRequest?.id)
      return (
        state.requestFingerprint === null &&
        state.descriptor === null &&
        !state.authorizationVerified
      );
    if (
      state.requestFingerprint !== null &&
      state.requestFingerprint !== executionContext.request.requestFingerprint
    )
      return false;
    const owner = state.descriptor;
    if (!owner) return true; // Observer delivery may precede its newer owner ACK.
    return (
      !!binding &&
      owner.executionId === binding.executionId &&
      isDeepStrictEqual(owner.details.target, executionContext.target) &&
      owner.launchTicket === executionContext.target.launchTicket &&
      owner.details.executionPolicyFingerprint === executionContext.policy &&
      owner.details.requestFingerprint ===
        executionContext.request.requestFingerprint &&
      owner.details.installationManifestSha256 ===
        configured.expectedManifestSha256 &&
      isDeepStrictEqual(owner.details.supervisor, binding.helper) &&
      (!preparedDescriptor || isDeepStrictEqual(owner, preparedDescriptor))
    );
  }

  function rememberObservation(state: WindowsControlBridgeSnapshot): void {
    if (sealed || failed || endingSeen || observationSealed) return;
    const observation = state.runtimeObservation;
    const previous = runtimeObservation?.observation;
    if (
      observation &&
      state.descriptor &&
      (previous?.background?.state !== "unknown" ||
        observation.background?.state === "unknown") &&
      (previous?.engine?.state !== "unknown" ||
        observation.engine?.state === "unknown") &&
      (previous?.gpu.state !== "unknown" ||
        observation.gpu.state === "unknown")
    ) {
      if (!admissionCurrent()) return;
      runtimeObservation = Object.freeze({
        descriptor: state.descriptor,
        observation,
      });
    }
    if (
      state.phase === "sealed" ||
      state.phase === "unknown" ||
      state.phase === "terminal"
    )
      observationSealed = true;
  }

  function publishPhase(request: Phase): void {
    if (
      !pendingPhase(request) ||
      !request.written ||
      !request.permitWritten ||
      !request.permissionGranted ||
      !request.response ||
      sealed ||
      failed ||
      !admissionCurrent(request)
    )
      return;
    const state = request.response;
    if (!matchesState(state) || !state.descriptor) {
      fault();
      return;
    }
    if (request.op === "prepare") {
      if (
        state.phase !== "prepared" ||
        state.authorizationVerified ||
        state.resumeState !== "not-attempted"
      ) {
        fault();
        return;
      }
      preparedDescriptor = state.descriptor;
      finishPhase(
        Object.freeze({ kind: "prepared", descriptor: preparedDescriptor }),
      );
    } else {
      if (!state.authorizationVerified || state.resumeState !== "succeeded") {
        fault();
        return;
      }
      if (request.op === "request-stop") {
        if (
          state.phase !== "sealed" ||
          !state.sealReason ||
          ![
            "stop",
            "deadline",
            "controller_exit",
            "controller_eof",
            "control_write_failure",
          ].includes(state.sealReason)
        ) {
          fault();
          return;
        }
        settlePhase(request, Object.freeze({ kind: "stop-requested" }));
      } else {
        authorizeSucceeded = true;
        finishPhase(Object.freeze({ kind: "authorized" }));
      }
    }
  }

  function permit(
    value: Extract<WindowsControlBridgeResponse, { kind: "permit-request" }>,
  ): void {
    const request =
      softRequest?.id === value.requestId
        ? softRequest
        : forceRequest?.id === value.requestId
          ? forceRequest
          : inspectRequest;
    if (
      !request ||
      request.op === "inspect" ||
      request.id !== value.requestId ||
      request.op !== value.op ||
      request.permissionTaken ||
      !executionContext ||
      value.requestFingerprint !==
        executionContext.request.requestFingerprint ||
      !stdin ||
      sealed ||
      failed
    ) {
      fault();
      return;
    }
    request.permissionTaken = true;
    const frame = (allow: boolean) =>
      Buffer.from(
        `${JSON.stringify({ ...value, kind: "permit", allow })}\n`,
        "utf8",
      );
    const allowedFrame = frame(true),
      deniedFrame = frame(false);
    if (
      Math.max(allowedFrame.length, deniedFrame.length) >
        limits.maxRequestFrameBytes ||
      inputBytes >
        limits.maxSessionInputBytes -
          Math.max(allowedFrame.length, deniedFrame.length)
    ) {
      fault();
      return;
    }
    if (!admissionCurrent(request) || !pendingPhase(request) || request.settled)
      return;
    let allowed = false;
    try {
      allowed = request.takePermission() === true;
    } catch {
      allowed = false;
    }
    if (!admissionCurrent(request) || !pendingPhase(request) || request.settled)
      return;
    // All caller callbacks have finished; only internal bookkeeping precedes the original write.
    const bytes = allowed ? allowedFrame : deniedFrame;
    request.permissionGranted = allowed;
    inputBytes += bytes.length;
    pendingWrites++;
    try {
      stdin.write(bytes, (error?: Error | null) => {
        pendingWrites--;
        if (error) fault();
        else {
          request.permitWritten = true;
          publishPhase(request);
        }
        observe();
      });
    } catch {
      fault();
    }
    if (!allowed) {
      settlePhase(request, unknownOwned);
      fault();
    }
  }

  function response(value: WindowsControlBridgeResponse): void {
    if (terminalSeen) {
      fault();
      return;
    }
    if (value.kind === "unknown") {
      const request = prepareRequest;
      if (
        value.prepareDiagnostic && binding && value.executionId === binding.executionId &&
        request && request === inspectRequest && request.id === value.requestId &&
        !request.settled && !request.responseSeen && request.permissionTaken &&
        request.permissionGranted && admissionCurrent(request)
      ) request.prepareDiagnostic = value.prepareDiagnostic;
      fault();
      return;
    }
    if (value.kind === "bound") {
      if (binding || sealed || !spawned || value.bridge.pid !== originalPid) {
        fault();
        return;
      }
      binding = Object.freeze({
        executionId: value.executionId,
        bridge: value.bridge,
        helper: value.helper,
        state: value.state,
      });
      if (!admissionCurrent()) return;
      finishOpen(Object.freeze({ kind: "bound", binding }));
      return;
    }
    if (!binding || value.executionId !== binding.executionId) {
      fault();
      return;
    }
    if (value.kind === "permit-request") {
      permit(value);
      return;
    }
    if (value.kind === "ending") {
      if (!prepareRequest || endingSeen) {
        fault();
        return;
      }
      endingSeen = true;
      seal();
      finishInspect(unknownOwned);
      finishPhase(unknownOwned);
      endInput();
      observe();
      return;
    }
    if (value.kind === "closed") {
      if (
        !sealed ||
        (closeId
          ? value.requestId !== closeId
          : !endingSeen || value.requestId !== null) ||
        value.outcome !== "stopped"
      ) {
        fault();
        return;
      }
      terminalSeen = true;
      observe();
      return;
    }
    const state = value.state;
    if (!matchesState(state)) {
      fault();
      return;
    }
    if (
      !executionContext &&
      (state.phase === "unclaimed" ||
        state.phase === "unknown" ||
        (seenSealedState && state.phase === "claimed"))
    ) {
      fault();
      return;
    }
    rememberObservation(state);
    if (state.phase === "sealed") seenSealedState = true;
    if (value.requestId === null) return;
    const request: Request | undefined =
      inspectRequest?.id === value.requestId
        ? inspectRequest
        : preemptedInspect?.id === value.requestId
          ? preemptedInspect
          : prepareRequest?.id === value.requestId
            ? prepareRequest
            : authorizeRequest?.id === value.requestId
              ? authorizeRequest
              : softRequest?.id === value.requestId
                ? softRequest
                : forceRequest?.id === value.requestId
                  ? forceRequest
                  : undefined;
    if (!request || request.responseSeen) {
      fault();
      return;
    }
    request.responseSeen = true;
    request.response = state;
    if (request.op === "inspect") publishInspect(request);
    else if (!request.settled) publishPhase(request);
  }

  function output(chunk: unknown): void {
    if (!Buffer.isBuffer(chunk)) {
      fault();
      return;
    }
    outputBytes = Math.min(
      limits.maxSessionOutputBytes + 1,
      outputBytes + chunk.length,
    );
    if (failed) return;
    if (outputBytes > limits.maxSessionOutputBytes) {
      fault();
      return;
    }
    let offset = 0;
    while (offset < chunk.length && !failed) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline + 1;
      const length = end - offset;
      if (
        length > limits.maxResponseFrameBytes - capturedBytes ||
        length > limits.maxQueuedOutputBytes - capturedBytes
      ) {
        fault();
        return;
      }
      capture.push(Buffer.from(chunk.subarray(offset, end)));
      capturedBytes += length;
      offset = end;
      if (newline !== -1) {
        const bytes = Buffer.concat(capture, capturedBytes);
        capture.length = 0;
        capturedBytes = 0;
        try {
          response(
            decodeWindowsControlBridgeResponse(bytes, limits.maxJsonDepth),
          );
        } catch {
          fault();
        }
      }
    }
  }

  function attach(): void {
    if (!original) return;
    original.on("error", fault);
    original.on("spawn", () => {
      if (spawned) fault();
      spawned = true;
      if (!sealed) admissionCurrent();
      observe();
    });
    original.on("exit", (code, signal) => {
      if (exited) fault();
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (!sealed || code !== 0 || signal !== null) fault();
      observe();
    });
    original.on("close", (code, signal) => {
      if (childClosed) fault();
      childClosed = true;
      closeCode = code;
      closeSignal = signal;
      if (!exited || code !== exitCode || signal !== exitSignal) fault();
      observe();
    });
    stdin = original.stdin;
    stdout = original.stdout;
    stderr = original.stderr;
    if (stdin) {
      stdin.on("error", fault);
      stdin.on("finish", () => {
        stdinFinished = true;
        if (!sealed) fault();
        observe();
      });
      stdin.on("close", () => {
        stdinClosed = true;
        if (!stdinFinished) fault();
        observe();
      });
    }
    if (stdout) {
      stdout.on("error", fault);
      stdout.on("data", output);
      stdout.on("end", () => {
        stdoutEnded = true;
        if (capturedBytes || !sealed) fault();
        observe();
      });
      stdout.on("close", () => {
        stdoutClosed = true;
        if (!stdoutEnded) fault();
        observe();
      });
    }
    if (stderr) {
      stderr.on("error", fault);
      stderr.on("data", (chunk: unknown) => {
        if (Buffer.isBuffer(chunk))
          stderrBytes = Math.min(
            limits.maxHelperStderrBytes + 1,
            stderrBytes + chunk.length,
          );
        fault();
      });
      stderr.on("end", () => {
        stderrEnded = true;
        if (!sealed) fault();
        observe();
      });
      stderr.on("close", () => {
        stderrClosed = true;
        if (!stderrEnded) fault();
        observe();
      });
    }
    if (!stdin || !stdout || !stderr || originalPid === undefined) fault();
    if (sealed) endInput();
  }

  function open(
    signal: AbortSignal,
    stillCurrent: () => boolean,
  ): Promise<WindowsControlBridgeOpenResult> {
    if (admitted || sealed)
      return Promise.resolve(
        released || !attempted ? unknownClosed : unknownOwned,
      );
    admitted = true;
    const promise = new Promise<WindowsControlBridgeOpenResult>((resolve) => {
      resolveOpen = resolve;
    });
    const anchor = performance.now();
    startupDeadline = anchor + limits.startupTimeoutMs;
    sessionDeadline = anchor + limits.sessionTimeoutMs;
    startupTimer = setTimeout(fault, limits.startupTimeoutMs);
    sessionTimer = setTimeout(fault, limits.sessionTimeoutMs);
    openScope = scope(signal, stillCurrent);
    if (!admissionCurrent()) return promise;
    // Set ownership before spawn: a throw/ENOENT is not proof of no creation.
    attempted = true;
    retainedOwners.add(observe);
    try {
      original = spawn(
        configured.executablePath,
        ["--control-bridge", configuration],
        {
          cwd: win32.dirname(configured.executablePath),
          env: configured.environment,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: false,
          // Native cleanup owns caller loss; retain the original child and pipes.
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const pid = original.pid;
      if (
        typeof pid === "number" &&
        Number.isInteger(pid) &&
        pid > 0 &&
        pid <= 0xffffffff
      )
        originalPid = pid;
      attach();
    } catch {
      fault();
    }
    return promise;
  }

  function inspect(
    signal: AbortSignal,
    stillCurrent: () => boolean,
  ): Promise<WindowsControlBridgeInspectResult> {
    if (sealed || !binding)
      return Promise.resolve(
        released || !attempted ? unknownClosed : unknownOwned,
      );
    if (inspectRequest) return Promise.resolve(busy);
    let resolve!: (value: WindowsControlBridgeInspectResult) => void;
    const promise = new Promise<WindowsControlBridgeInspectResult>((finish) => {
      resolve = finish;
    });
    const anchor = performance.now();
    const request: Inspect = {
      op: "inspect",
      id: "",
      scope: scope(signal, stillCurrent),
      deadline: anchor + limits.requestTimeoutMs,
      timer: undefined,
      written: false,
      response: undefined,
      responseSeen: false,
      resolve,
    };
    inspectRequest = request;
    request.timer = setTimeout(fault, limits.requestTimeoutMs);
    if (!admissionCurrent(request)) return promise;
    const outgoing = command("inspect");
    if (!outgoing || !stdin || !admissionCurrent(request)) return promise;
    request.id = outgoing.id;
    pendingWrites++;
    try {
      stdin.write(outgoing.frame, (error?: Error | null) => {
        pendingWrites--;
        if (error) fault();
        else {
          request.written = true;
          publishInspect(request);
        }
        observe();
      });
    } catch {
      fault();
    }
    return promise;
  }

  function close(): Promise<WindowsControlBridgeCloseResult> {
    const promise = ensureClose();
    if (closeStarted || sealed) return promise;
    closeStarted = true;
    if (!attempted) {
      seal();
      return promise;
    }
    if (!binding || !admissionCurrent(inspectRequest)) {
      fault();
      return promise;
    }
    const outgoing = command("close");
    if (!outgoing || !admissionCurrent(inspectRequest)) return promise;
    closeId = outgoing.id;
    if (inspectRequest) {
      if (inspectRequest.op === "inspect") {
        preemptedInspect = inspectRequest;
        finishInspect(unknownOwned);
      } else finishPhase(unknownOwned);
    }
    seal();
    if (
      !failed &&
      cleanupDeadline !== undefined &&
      performance.now() < cleanupDeadline
    )
      endInput(outgoing.frame);
    else fault();
    observe();
    return promise;
  }

  function phase(
    op: "prepare" | "authorize",
    fields: Readonly<Record<string, unknown>>,
    guard: ExecutionSendGuard,
  ): Promise<ExecutionResult> {
    if (
      !binding ||
      sealed ||
      failed ||
      inspectRequest ||
      limits.maxJsonDepth < 6
    )
      return Promise.resolve(
        released || !attempted ? unknownClosed : unknownOwned,
      );
    let resolve!: (value: ExecutionResult) => void;
    const promise = new Promise<ExecutionResult>((finish) => {
      resolve = finish;
    });
    const anchor = performance.now();
    let signal: AbortSignal,
      stillCurrent: () => boolean,
      takePermission: () => boolean;
    try {
      signal = guard.signal;
      stillCurrent = guard.stillCurrent.bind(guard);
      takePermission = guard.takeSendPermission.bind(guard);
    } catch {
      fault();
      return Promise.resolve(unknownOwned);
    }
    const request: Phase = {
      op,
      id: "",
      scope: scope(signal, stillCurrent),
      deadline: anchor + limits.requestTimeoutMs,
      timer: undefined,
      written: false,
      response: undefined,
      responseSeen: false,
      permissionTaken: false,
      permissionGranted: false,
      permitWritten: false,
      takePermission,
      settled: false,
      resolve,
    };
    inspectRequest = request;
    if (op === "prepare") prepareRequest = request;
    else authorizeRequest = request;
    request.timer = setTimeout(fault, limits.requestTimeoutMs);
    if (!admissionCurrent(request)) {
      finishPhase(unknownOwned);
      return promise;
    }
    const outgoing = command(op, fields);
    if (!outgoing || !stdin || !admissionCurrent(request)) return promise;
    request.id = outgoing.id;
    pendingWrites++;
    try {
      stdin.write(outgoing.frame, (error?: Error | null) => {
        pendingWrites--;
        if (error) fault();
        else {
          request.written = true;
          publishPhase(request);
        }
        observe();
      });
    } catch {
      fault();
    }
    return promise;
  }

  function prepare(
    request: FrozenWindowsRequest,
    expected: Readonly<{
      target: ExecutionTarget;
      executionPolicyFingerprint: string;
    }>,
    guard: ExecutionSendGuard,
  ) {
    if (prepareTaken) return Promise.resolve(unknownOwned);
    prepareTaken = true;
    try {
      const keys = Reflect.ownKeys(request);
      if (
        keys.length !== 2 ||
        !keys.includes("requestUtf8Base64") ||
        !keys.includes("requestFingerprint")
      )
        throw new Error();
      const raw = Object.getOwnPropertyDescriptor(request, "requestUtf8Base64");
      const digest = Object.getOwnPropertyDescriptor(
        request,
        "requestFingerprint",
      );
      if (
        !raw ||
        !("value" in raw) ||
        !raw.enumerable ||
        !digest ||
        !("value" in digest) ||
        !digest.enumerable ||
        typeof raw.value !== "string" ||
        raw.value.length === 0 ||
        raw.value.length > limits.maxRequestFrameBytes ||
        typeof digest.value !== "string" ||
        !/^[a-f0-9]{64}$/.test(digest.value)
      )
        throw new Error();
      const bytes = Buffer.from(raw.value, "base64");
      if (
        bytes.toString("base64") !== raw.value ||
        createHash("sha256").update(bytes).digest("hex") !== digest.value
      )
        throw new Error();
      const frozen = Object.freeze({
        requestUtf8Base64: raw.value as string,
        requestFingerprint: digest.value as string,
      });
      if (Reflect.ownKeys(expected).length !== 2) throw new Error();
      const originalTarget = Object.getOwnPropertyDescriptor(
        expected,
        "target",
      );
      const originalPolicy = Object.getOwnPropertyDescriptor(
        expected,
        "executionPolicyFingerprint",
      );
      if (
        !originalTarget ||
        !("value" in originalTarget) ||
        !originalTarget.enumerable ||
        !originalPolicy ||
        !("value" in originalPolicy) ||
        !originalPolicy.enumerable
      )
        throw new Error();
      const target = freezeWindowsControlBridgeTarget(
        originalTarget.value as ExecutionTarget,
      );
      const policy: unknown = originalPolicy.value;
      if (typeof policy !== "string" || !/^[a-f0-9]{64}$/.test(policy))
        throw new Error();
      executionContext = Object.freeze({ request: frozen, target, policy });
      return phase("prepare", frozen, guard) as Promise<
        | Readonly<{ kind: "prepared"; descriptor: OwnerDescriptor }>
        | WindowsControlBridgeUnknown
      >;
    } catch {
      fault();
      return Promise.resolve(unknownOwned);
    }
  }

  function authorize(
    target: ExecutionTarget,
    descriptor: OwnerDescriptor,
    requestFingerprint: string,
    guard: ExecutionSendGuard,
  ) {
    if (authorizeTaken) return Promise.resolve(unknownOwned);
    authorizeTaken = true;
    try {
      const originalTarget = freezeWindowsControlBridgeTarget(target);
      const originalDescriptor =
        freezeWindowsControlBridgeDescriptor(descriptor);
      if (
        !executionContext ||
        !preparedDescriptor ||
        !isDeepStrictEqual(originalTarget, executionContext.target) ||
        !isDeepStrictEqual(originalDescriptor, preparedDescriptor) ||
        requestFingerprint !== executionContext.request.requestFingerprint
      )
        throw new Error();
      return phase(
        "authorize",
        {
          target: originalTarget,
          descriptor: originalDescriptor,
          requestFingerprint,
        },
        guard,
      ) as Promise<
        Readonly<{ kind: "authorized" }> | WindowsControlBridgeUnknown
      >;
    } catch {
      fault();
      return Promise.resolve(unknownOwned);
    }
  }

  function requestStop(
    target: ExecutionTarget,
    descriptor: OwnerDescriptor,
    request: ExecutionStopRequest,
    guard: ExecutionSendGuard,
  ) {
    let operation: Stop | undefined;
    try {
      const originalTarget = freezeWindowsControlBridgeTarget(target),
        originalDescriptor = freezeWindowsControlBridgeDescriptor(descriptor),
        originalRequest = freezeWindowsControlBridgeStopRequest(request);
      if (
        !executionContext ||
        !preparedDescriptor ||
        !isDeepStrictEqual(originalTarget, executionContext.target) ||
        !isDeepStrictEqual(originalDescriptor, preparedDescriptor)
      )
        throw new Error();
      const first = softRequest ?? forceRequest;
      if (
        first &&
        (first.request.stopRequestedAt !== originalRequest.stopRequestedAt ||
          first.request.terminateAfterAt !== originalRequest.terminateAfterAt)
      )
        throw new Error();
      const previous =
        originalRequest.mode === "soft" ? softRequest : forceRequest;
      if (previous)
        return previous.promise as Promise<
          Readonly<{ kind: "stop-requested" }> | WindowsControlBridgeUnknown
        >;
      if (
        !authorizeSucceeded ||
        sealed ||
        failed ||
        !binding ||
        limits.maxJsonDepth < 6
      )
        return Promise.resolve(
          released || !attempted ? unknownClosed : unknownOwned,
        );
      let resolve!: (value: ExecutionResult) => void;
      const promise = new Promise<ExecutionResult>((finish) => {
        resolve = finish;
      });
      operation = {
        op: "request-stop",
        request: originalRequest,
        promise,
        id: "",
        scope: {
          signal: openScope!.signal,
          stillCurrent: () => true,
          removeAbort() {},
        },
        deadline: Infinity,
        timer: undefined,
        written: false,
        response: undefined,
        responseSeen: false,
        permissionTaken: false,
        permissionGranted: false,
        permitWritten: false,
        takePermission: () => false,
        settled: false,
        resolve,
      };
      if (originalRequest.mode === "soft") softRequest = operation;
      else forceRequest = operation;
      operation.deadline = performance.now() + limits.requestTimeoutMs;
      const signalValue = Object.getOwnPropertyDescriptor(guard, "signal"),
        currentValue = Object.getOwnPropertyDescriptor(guard, "stillCurrent"),
        permissionValue = Object.getOwnPropertyDescriptor(
          guard,
          "takeSendPermission",
        );
      if (
        !signalValue ||
        !("value" in signalValue) ||
        !currentValue ||
        !("value" in currentValue) ||
        typeof currentValue.value !== "function" ||
        !permissionValue ||
        !("value" in permissionValue) ||
        typeof permissionValue.value !== "function"
      )
        throw new Error();
      operation.takePermission = permissionValue.value.bind(guard);
      operation.scope = scope(
        signalValue.value as AbortSignal,
        currentValue.value.bind(guard),
      );
      if (operation.settled || sealed || failed) {
        operation.scope.removeAbort();
        return promise as Promise<
          Readonly<{ kind: "stop-requested" }> | WindowsControlBridgeUnknown
        >;
      }
      const remaining = Math.max(0, operation.deadline - performance.now());
      if (operation.settled || sealed || failed)
        return promise as Promise<
          Readonly<{ kind: "stop-requested" }> | WindowsControlBridgeUnknown
        >;
      operation.timer = setTimeout(fault, remaining);
      if (!admissionCurrent(operation) || !pendingPhase(operation))
        return promise as Promise<
          Readonly<{ kind: "stop-requested" }> | WindowsControlBridgeUnknown
        >;
      const outgoing = command("request-stop", {
        target: originalTarget,
        descriptor: originalDescriptor,
        requestFingerprint: executionContext.request.requestFingerprint,
        ...originalRequest,
      });
      if (
        !outgoing ||
        !stdin ||
        !admissionCurrent(operation) ||
        !pendingPhase(operation)
      )
        return promise as Promise<
          Readonly<{ kind: "stop-requested" }> | WindowsControlBridgeUnknown
        >;
      operation.id = outgoing.id;
      const originalOperation = operation;
      pendingWrites++;
      try {
        stdin.write(outgoing.frame, (error?: Error | null) => {
          pendingWrites--;
          if (error) fault();
          else {
            originalOperation.written = true;
            publishPhase(originalOperation);
          }
          observe();
        });
      } catch {
        fault();
      }
      return promise as Promise<
        Readonly<{ kind: "stop-requested" }> | WindowsControlBridgeUnknown
      >;
    } catch {
      fault();
      return operation
        ? (operation.promise as Promise<
            Readonly<{ kind: "stop-requested" }> | WindowsControlBridgeUnknown
          >)
        : Promise.resolve(unknownOwned);
    }
  }

  return Object.freeze({
    open,
    inspect,
    prepare,
    authorize,
    requestStop,
    whenClosed: ensureClose,
    close,
  });
}
