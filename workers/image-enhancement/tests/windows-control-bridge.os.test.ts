import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

type Value = Record<string, unknown>;
type Receipt = {
  host: {
    scenario: string;
    setupFailure: unknown;
    failure: unknown;
    values: Value;
    cleanup: {
      failures: unknown[];
      originalRegistry: boolean;
      allObservedJoined: boolean;
    };
  } | null;
  outer: {
    primaryFailure: unknown;
    forcedFallback: boolean;
    firstCommandBarrier: boolean;
    host: Value;
    guard: Value;
    guardDiagnostics: Value;
    protocolErrors: unknown[];
  };
};

const fixtureExe = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_SESSION_FIXTURE_EXE;
const bridgeExe = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_EXE;
const ordinaryExe = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_ORDINARY_EXE;
const faultExe = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_FAULT_EXE;
const mode = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_MODE ?? "first";
const requested =
  process.env.ZEB_RUN_WINDOWS_CONTROL_BRIDGE_OS === "1" ||
  fixtureExe !== undefined;
const suite = requested ? describe : describe.skip;

// Explicit fixture observation budgets, never production defaults.
const executionMs = 60_000;
const cleanupMs = 15_000;
const testMs = executionMs + cleanupMs + 5_000;
const maxOuterCaptureBytes = 4 * 1_048_576;
const outputResponseBytes = 512;
const outputEventCount = 64;
const outputUpperBytes = outputResponseBytes * (outputEventCount + 5);
const outputHighBytes = outputUpperBytes + outputResponseBytes;
const outputTranscriptBytes =
  outputResponseBytes * (outputEventCount + 12) * 4 +
  outputEventCount * 1024 +
  32768;
const outputOuterBytes =
  8 * (outputTranscriptBytes + outputHighBytes) + 1_048_576;
const outputScenarios = new Set([
  "output-session-high",
  "output-queue-high",
  "output-session-low",
  "output-queue-low",
  "output-held-close",
]);

function object(value: unknown): Value {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Value;
}

function exact(value: unknown, names: string[]): Value {
  const result = object(value);
  expect(Object.keys(result).sort()).toEqual([...names].sort());
  return result;
}

async function until<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Control bridge fixture observation expired")),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Only this outer human-harness protocol accepts CRLF. Bridge bytes below are
// retained independently by the original native host and are never normalized.
class BridgeFixture {
  private child!: ChildProcessWithoutNullStreams;
  private readonly frames: Value[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly errors: string[] = [];
  private closed!: Promise<void>;
  private pending = "";
  private stderr = "";
  private capturedBytes = 0;
  private stdoutEof = false;
  private stderrEof = false;
  private closeCode: number | null | undefined;
  private closeSignal: NodeJS.Signals | null | undefined;
  private exitCode: number | null | undefined;
  private exitSignal: NodeJS.Signals | null | undefined;
  private stdinClosed = false;
  private final: Receipt | undefined;
  readonly deadline = Date.now() + executionMs;

  constructor(private readonly maximumCaptureBytes = maxOuterCaptureBytes) {}

  launch(directory: string) {
    this.child = spawn(
      fixtureExe!,
      [
        "bridge-outer",
        bridgeExe!,
        ordinaryExe!,
        faultExe!,
        directory,
        String(executionMs),
        String(cleanupMs),
      ],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout = new TextDecoder("utf-8", { fatal: true });
    const stderr = new TextDecoder("utf-8", { fatal: true });
    const fail = (error: unknown) => {
      this.errors.push(error instanceof Error ? error.name : "error");
      this.changed();
    };
    const consume = () => {
      let newline: number;
      while ((newline = this.pending.indexOf("\n")) !== -1) {
        const line = this.pending.slice(0, newline).replace(/\r$/, "");
        this.pending = this.pending.slice(newline + 1);
        const frame = object(JSON.parse(line));
        if (frame.kind === "outer-receipt") {
          if (this.final !== undefined)
            throw new Error("Duplicate outer receipt");
          this.final = frame.value as Receipt;
        }
        this.frames.push(frame);
        this.changed();
      }
    };
    const accept = (bytes: Buffer) => {
      this.capturedBytes += bytes.length;
      if (this.capturedBytes > this.maximumCaptureBytes) {
        if (!this.errors.includes("capture-overflow"))
          this.errors.push("capture-overflow");
        this.changed();
        return false;
      }
      return true;
    };
    this.child.stdout.on("data", (bytes: Buffer) => {
      if (!accept(bytes)) return;
      try {
        this.pending += stdout.decode(bytes, { stream: true });
        consume();
      } catch (error) {
        fail(error);
      }
    });
    this.child.stderr.on("data", (bytes: Buffer) => {
      if (!accept(bytes)) return;
      try {
        this.stderr += stderr.decode(bytes, { stream: true });
      } catch (error) {
        fail(error);
      }
    });
    this.child.stdout.once("end", () => {
      this.stdoutEof = true;
      try {
        this.pending += stdout.decode();
        consume();
        if (this.pending !== "") throw new Error("Outer EOF half-frame");
      } catch (error) {
        fail(error);
      }
      this.changed();
    });
    this.child.stderr.once("end", () => {
      this.stderrEof = true;
      try {
        this.stderr += stderr.decode();
      } catch (error) {
        fail(error);
      }
      this.changed();
    });
    this.child.once("error", fail);
    this.child.stdin.on("error", fail);
    this.child.stdout.on("error", fail);
    this.child.stderr.on("error", fail);
    this.child.stdin.once("close", () => {
      this.stdinClosed = true;
      this.changed();
    });
    this.child.once("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.changed();
    });
    this.closed = new Promise((resolve) =>
      this.child.once("close", (code, signal) => {
        this.closeCode = code;
        this.closeSignal = signal;
        this.changed();
        resolve();
      }),
    );
  }

  private changed() {
    for (const notify of this.waiters) notify();
  }

  private async match(kind: string, deadline = this.deadline) {
    let notify: (() => void) | undefined;
    try {
      return await until(
        new Promise<Value>((resolve, reject) => {
          notify = () => {
            const frame = this.frames.find((value) => value.kind === kind);
            if (frame !== undefined) resolve(frame);
            else if (this.errors.length > 0 || this.closeCode !== undefined)
              reject(
                new Error(
                  `Outer ended before ${kind}: ${this.errors.join(",")}`,
                ),
              );
          };
          this.waiters.add(notify);
          notify();
        }),
        deadline,
      );
    } finally {
      if (notify !== undefined) this.waiters.delete(notify);
    }
  }

  private async send(value: unknown) {
    await until(
      new Promise<void>((resolve, reject) => {
        this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) =>
          error ? reject(error) : resolve(),
        );
      }),
      this.deadline,
    );
  }

  async run(scenario: string) {
    expect(await this.match("outer-ready")).toMatchObject({
      hostMembershipVerified: true,
      guardHandleNonInherited: true,
      outerOutsideJob: true,
      firstCommandBarrier: true,
      host: { actorLaunches: 0, nonInherited: true, sameSid: true },
    });
    await this.send({ scenario });
    expect((await this.match("outer-metadata")).value).toMatchObject({
      scenario,
      bridgeLaunches: 0,
    });
    await this.send({ continue: true });
    // This is actual caller EOF after its two human-harness commands. The
    // native host separately controls the bridge's still-open stdin.
    this.child.stdin.end();
    await this.match("outer-receipt", this.deadline + cleanupMs);
    await until(this.closed, this.deadline + cleanupMs);
    return this.final!;
  }

  evidence() {
    return {
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      closeCode: this.closeCode,
      closeSignal: this.closeSignal,
      stdinClosed: this.stdinClosed,
      stdoutEof: this.stdoutEof,
      stderrEof: this.stderrEof,
      errors: this.errors,
      stderr: this.stderr,
      maximumCaptureBytes: this.maximumCaptureBytes,
      capturedBytes: this.capturedBytes,
      frames: this.frames,
      receipt: this.final,
    };
  }

  // No PID/global cleanup. On failure the original outer still owns its
  // exact Job fallback. This observer never kills it to make a test pass.
  async observeCleanup() {
    if (this.child === undefined) return;
    if (!this.child.stdin.writableEnded) this.child.stdin.end();
    await until(this.closed, this.deadline + cleanupMs);
  }
}

function rawFrames(capture: unknown, ordinaryReadyCrlf = false): Value[] {
  const value = object(capture);
  expect(value).toMatchObject({
    actualEof: true,
    error: null,
    overflow: false,
  });
  expect(Array.isArray(value.framesBase64)).toBe(true);
  const frames = (value.framesBase64 as string[]).map((base64) => {
    const bytes = Buffer.from(base64, "base64");
    expect(bytes.toString("base64")).toBe(base64);
    expect(bytes.at(-1)).toBe(10);
    expect(bytes.subarray(0, -1).includes(10)).toBe(false);
    if (ordinaryReadyCrlf) {
      expect(bytes.at(-2)).toBe(13);
      expect(bytes.subarray(0, -2).includes(13)).toBe(false);
    } else expect(bytes.includes(13)).toBe(false);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
      false,
    );
    return object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, ordinaryReadyCrlf ? -2 : -1),
        ),
      ),
    );
  });
  expect(
    Buffer.concat(
      (value.framesBase64 as string[]).map((item) =>
        Buffer.from(item, "base64"),
      ),
    ).toString("base64"),
  ).toBe(value.capturedBase64);
  return frames;
}

function healthy(
  final: Receipt,
  fixture: BridgeFixture,
  scenario: string,
  exitCode = 0,
  ordinaryReadyCrlf = false,
) {
  expect(fixture.evidence()).toMatchObject({
    exitCode: 0,
    exitSignal: null,
    closeCode: 0,
    closeSignal: null,
    stdinClosed: true,
    stdoutEof: true,
    stderrEof: true,
    errors: [],
    stderr: "",
  });
  expect(final.outer).toMatchObject({
    primaryFailure: null,
    forcedFallback: false,
    firstCommandBarrier: true,
    protocolErrors: [],
    host: {
      originalRetained: true,
      originalJoined: true,
      alive: false,
      exitCode: 0,
      stdoutEof: true,
      stderrEof: true,
      stdoutError: null,
      stderrError: null,
      forced: false,
    },
    guard: {
      activeProcesses: 0,
      membershipVerified: true,
      nonInherited: true,
      outerOutsideJob: true,
      soleJobHandle: true,
      killOnClose: true,
      allObservedJoined: true,
      failures: [],
    },
  });
  const guard = object(final.outer.guard);
  expect(guard.totalProcesses).toBe(guard.registeredOriginalProcesses);
  const registrations = final.outer.guardDiagnostics.registrationSources;
  expect(Array.isArray(registrations)).toBe(true);
  for (const registration of registrations as unknown[]) {
    expect(registration).toMatchObject({
      testOnlyExactJobIdentityQuery: true,
      independentCreationPin: false,
    });
  }
  expect(final.host).toMatchObject({
    scenario,
    setupFailure: null,
    failure: null,
    cleanup: { failures: [], originalRegistry: true, allObservedJoined: true },
  });
  const values = final.host!.values;
  expect(values).toMatchObject({
    installationUnchanged: true,
    recordsUnchanged: true,
    prepareOrAuthorizeSent: false,
    engineLaunchedByFixture: false,
  });
  expect(values.afterInstallation).toEqual(values.beforeInstallation);
  expect(values.afterRecords).toEqual(values.beforeRecords);
  const child = object(values.child);
  expect(child).toMatchObject({
    started: true,
    originalRetained: true,
    originalJoined: true,
    alive: false,
    exitCode,
    sameSid: true,
    nonInherited: true,
    forced: false,
    stdinClosedByCaller: true,
  });
  rawFrames(child.stdout, ordinaryReadyCrlf);
  expect(rawFrames(child.stderr)).toEqual([]);
  return { values, child };
}

function state(value: unknown) {
  const found = exact(value, [
    "phase",
    "sealReason",
    "requestFingerprint",
    "descriptor",
    "authorizationVerified",
    "resumeState",
    "evidenceOutcome",
    "completion",
  ]);
  expect(found).toMatchObject({
    requestFingerprint: null,
    descriptor: null,
    authorizationVerified: false,
    resumeState: "not-attempted",
    completion: null,
  });
  expect(["unclaimed", "claimed", "sealed", "unknown"]).toContain(found.phase);
  expect([
    null,
    "stop",
    "deadline",
    "controller_eof",
    "controller_exit",
    "control_write_failure",
    "evidence-unknown",
  ]).toContain(found.sealReason);
  expect(["pending", "unknown"]).toContain(found.evidenceOutcome);
}

function identity(value: unknown) {
  const found = exact(value, ["pid", "creationFileTime"]);
  expect(Number.isInteger(found.pid)).toBe(true);
  expect(found.pid).toBeGreaterThan(0);
  expect(found.pid).toBeLessThanOrEqual(0xffff_ffff);
  expect(found.creationFileTime).toMatch(/^[1-9][0-9]*$/);
  expect(BigInt(found.creationFileTime as string)).toBeLessThanOrEqual(
    0xffff_ffff_ffff_ffffn,
  );
}

// Every observed bridge JSON belongs to its exact public wire union. Native
// response/error/ready frames and any other JSON kind are rejected explicitly.
function bridgeFrames(
  frames: Value[],
  success: boolean,
  inspectLimits: ReadonlyMap<string, number> = new Map(),
) {
  let executionId: unknown;
  let unknownSeen = false;
  const resultCounts = new Map<string, number>();
  for (const frame of frames) {
    expect(frame.v).toBe(1);
    expect(
      success
        ? ["bound", "state", "closed"]
        : ["bound", "state", "unknown", "closed"],
    ).toContain(frame.kind);
    if (frame.kind === "bound") {
      exact(frame, ["v", "kind", "executionId", "bridge", "helper", "state"]);
      expect(frame.executionId).toMatch(/^[0-9a-f]{32}$/);
      identity(frame.bridge);
      identity(frame.helper);
      state(frame.state);
      expect(executionId).toBeUndefined();
      executionId = frame.executionId;
    } else if (frame.kind === "state") {
      exact(frame, ["v", "kind", "requestId", "executionId", "state"]);
      expect(executionId).toBeDefined();
      expect(frame.executionId).toBe(executionId);
      if (frame.requestId !== null) {
        expect(frame.requestId).toMatch(/^[0-9a-f]{32}$/);
        expect(unknownSeen).toBe(false);
        expect(inspectLimits.has(frame.requestId as string)).toBe(true);
        const count = (resultCounts.get(frame.requestId as string) ?? 0) + 1;
        resultCounts.set(frame.requestId as string, count);
        expect(count).toBeLessThanOrEqual(
          inspectLimits.get(frame.requestId as string)!,
        );
      }
      state(frame.state);
    } else if (frame.kind === "unknown" || frame.kind === "closed") {
      exact(
        frame,
        frame.kind === "unknown"
          ? ["v", "kind", "requestId", "executionId"]
          : ["v", "kind", "requestId", "executionId", "outcome"],
      );
      if (frame.requestId !== null)
        expect(frame.requestId).toMatch(/^[0-9a-f]{32}$/);
      if (frame.executionId !== null)
        expect(frame.executionId).toMatch(/^[0-9a-f]{32}$/);
      if (executionId !== undefined)
        expect(frame.executionId).toBe(executionId);
      if (frame.kind === "closed")
        expect(["stopped", "unknown"]).toContain(frame.outcome);
      if (frame.kind === "unknown") unknownSeen = true;
    }
  }
  if (frames.some((frame) => frame.kind === "bound"))
    expect(frames[0]!.kind).toBe("bound");
  expect(
    frames.filter((frame) => frame.kind === "bound").length,
  ).toBeLessThanOrEqual(1);
  expect(
    frames.filter((frame) => frame.kind === "closed").length,
  ).toBeLessThanOrEqual(1);
  if (frames.some((frame) => frame.kind === "closed"))
    expect(frames.at(-1)!.kind).toBe("closed");
  const unknown = frames.findIndex((frame) => frame.kind === "unknown");
  if (unknown >= 0) {
    expect(frames.filter((frame) => frame.kind === "unknown")).toHaveLength(1);
    for (const frame of frames.slice(unknown + 1))
      if (frame.kind === "closed") expect(frame.outcome).toBe("unknown");
  }
}

const preboundFaults = new Set([
  "matrix-eof-before-ready",
  "matrix-no-ready",
  "matrix-invalid-ready",
  "matrix-malformed-ready",
  "matrix-duplicate-ready",
  "matrix-stdout-extra",
  "matrix-stdout-overflow",
  "matrix-stderr-payload",
]);
const nativeResponseFaults = new Set([
  "matrix-wrong-id",
  "matrix-wrong-op",
  "matrix-wrong-execution",
  "matrix-wrong-role",
  "matrix-duplicate-response",
  "matrix-native-crlf",
  "matrix-response-overflow",
]);
type CallerFrame = { value: Value; bytes: Buffer };
function callerFrames(child: Value): CallerFrame[] {
  expect(Array.isArray(child.sentFramesBase64)).toBe(true);
  return (child.sentFramesBase64 as string[]).map((base64) => {
    const bytes = Buffer.from(base64, "base64");
    expect(bytes.toString("base64")).toBe(base64);
    expect(bytes.at(-1)).toBe(10);
    expect(bytes.subarray(0, -1).includes(10)).toBe(false);
    expect(bytes.includes(13)).toBe(false);
    return {
      bytes,
      value: object(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, -1),
          ),
        ),
      ),
    };
  });
}
function allowedInspectResults(name: string, caller: CallerFrame[]) {
  const limits = new Map<string, number>();
  const seen = new Set<string>();
  let bytes = 0;
  for (const request of caller) {
    bytes += request.bytes.length;
    const value = request.value;
    if (typeof value.requestId !== "string" || seen.has(value.requestId))
      continue;
    seen.add(value.requestId);
    if (value.op !== "inspect") continue;
    const successForbidden =
      nativeResponseFaults.has(name) ||
      name === "matrix-pending-close" ||
      [
        "matrix-extra-field",
        "matrix-duplicate-key",
        "matrix-input-overflow",
      ].includes(name);
    limits.set(
      value.requestId,
      successForbidden ||
        (name === "matrix-session-input-overflow" && bytes > 1024)
        ? 0
        : 1,
    );
  }
  return limits;
}
function requireMatrixBound(name: string, frames: Value[]) {
  if (!preboundFaults.has(name)) expect(frames[0]?.kind).toBe("bound");
}

function matrixCausality(
  name: string,
  frames: Value[],
  caller: CallerFrame[],
  transcript: Value[],
  nativeRequests: Value[],
  values: Value,
) {
  requireMatrixBound(name, frames);
  const bound = frames.find((frame) => frame.kind === "bound");
  for (const request of caller) {
    expect(request.value).toMatchObject({
      v: 1,
      kind: "command",
      executionId: bound?.executionId,
    });
    expect(request.value.requestId).toMatch(/^[0-9a-f]{32}$/);
    exact(
      request.value,
      name === "matrix-extra-field"
        ? ["v", "kind", "requestId", "op", "executionId", "extra"]
        : ["v", "kind", "requestId", "op", "executionId"],
    );
  }
  const ops = caller.map((request) => request.value.op);
  if (
    preboundFaults.has(name) ||
    name === "matrix-eof-after-bound" ||
    name === "matrix-deadline"
  )
    expect(caller).toEqual([]);
  else if (name.startsWith("matrix-forbidden-"))
    expect(ops).toEqual([name.slice("matrix-forbidden-".length)]);
  else if (name === "matrix-duplicate-id") {
    expect(ops).toEqual(["inspect", "inspect"]);
    expect(caller[0]!.bytes).toEqual(caller[1]!.bytes);
    expect(values.firstInspectObservedBeforeDuplicateIdSend).toBe(true);
  } else if (name === "matrix-session-input-overflow") {
    expect(caller.length).toBeGreaterThan(1);
    expect(ops.every((op) => op === "inspect")).toBe(true);
    expect(new Set(caller.map((request) => request.value.requestId)).size).toBe(
      caller.length,
    );
  } else if (
    nativeResponseFaults.has(name) ||
    name === "matrix-duplicate-response-frame" ||
    [
      "matrix-extra-field",
      "matrix-duplicate-key",
      "matrix-input-overflow",
    ].includes(name)
  )
    expect(ops).toEqual(["inspect"]);
  else expect(ops).toEqual(["inspect", "close"]);

  if (!preboundFaults.has(name)) {
    expect(
      nativeRequests.filter((request) => request.op === "claim"),
    ).toHaveLength(1);
    expect(
      nativeRequests.filter((request) => request.op === "watch"),
    ).toHaveLength(1);
  }
  const inspections = nativeRequests.filter(
    (request) => request.op === "inspect",
  );
  if (
    preboundFaults.has(name) ||
    name === "matrix-eof-after-bound" ||
    name === "matrix-deadline" ||
    name.startsWith("matrix-forbidden-") ||
    [
      "matrix-extra-field",
      "matrix-duplicate-key",
      "matrix-input-overflow",
    ].includes(name)
  )
    expect(inspections).toEqual([]);
  else if (name === "matrix-session-input-overflow")
    expect(inspections).toHaveLength(
      [...allowedInspectResults(name, caller).values()].filter(
        (count) => count === 1,
      ).length,
    );
  else expect(inspections).toHaveLength(1);

  if (name === "matrix-extra-field") expect(caller[0]!.value.extra).toBe(true);
  if (name === "matrix-duplicate-key")
    expect(caller[0]!.bytes.toString("utf8")).toContain('"v":1,"\\u0076":1');
  if (name === "matrix-input-overflow") {
    expect(values.inputOverflowSemanticallyLegal).toBe(true);
    expect(caller[0]!.bytes.length).toBeGreaterThan(512);
    expect(caller[0]!.value).toEqual({
      v: 1,
      kind: "command",
      requestId: values.inspectRequestId,
      op: "inspect",
      executionId: bound!.executionId,
    });
  }

  const attempts = transcript.filter(
    (entry) => entry.direction === "send-attempt",
  );
  const written = (entry: Value) =>
    expect(
      transcript.filter(
        (record) =>
          record.direction === "send-write-completed" &&
          record.sequence === entry.sequence &&
          record.channel === entry.channel,
      ),
    ).toHaveLength(1);
  if (name === "matrix-no-ready") {
    expect(
      transcript.filter((entry) => entry.stage === "no-ready-natural-exit"),
    ).toHaveLength(1);
    expect(
      attempts.filter((entry) => entry.channel === "helper-stdout"),
    ).toEqual([]);
    expect(nativeRequests).toEqual([]);
  }
  if (
    [
      "matrix-invalid-ready",
      "matrix-malformed-ready",
      "matrix-duplicate-ready",
    ].includes(name)
  ) {
    const ready = attempts.filter((entry) => entry.channel === "helper-stdout");
    expect(ready).toHaveLength(1);
    written(ready[0]!);
    const text = Buffer.from(
      ready[0]!.bytesBase64 as string,
      "base64",
    ).toString("utf8");
    if (name === "matrix-invalid-ready")
      expect(JSON.parse(text).executionId).toBe("Z".repeat(32));
    else if (name === "matrix-malformed-ready") expect(text).toBe("{]\n");
    else expect(text).toContain('"v":1,"v":1');
    expect(nativeRequests).toEqual([]);
  }
  if (
    [
      "matrix-stdout-extra",
      "matrix-stdout-overflow",
      "matrix-stderr-payload",
    ].includes(name)
  ) {
    const channel =
      name === "matrix-stderr-payload" ? "helper-stderr" : "helper-stdout";
    const payload = attempts
      .filter((entry) => entry.channel === channel)
      .find((entry) => {
        const bytes = Buffer.from(entry.bytesBase64 as string, "base64");
        return name === "matrix-stdout-extra"
          ? bytes.toString("utf8") === "{}\n"
          : bytes.length === (name === "matrix-stdout-overflow" ? 70001 : 9000);
      });
    expect(payload).toBeDefined();
    written(payload!);
  }

  if (
    nativeResponseFaults.has(name) ||
    name === "matrix-duplicate-response-frame"
  ) {
    const selected = transcript.filter(
      (entry) => entry.direction === "inspect-response-selected",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]!.originalRequestId).toBe(inspections[0]!.requestId);
    const bytes = Buffer.from(selected[0]!.bytesBase64 as string, "base64");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const response = exact(JSON.parse(text), [
      "v",
      "kind",
      "requestId",
      "op",
      "executionId",
      "role",
      "state",
    ]);
    expect(response).toMatchObject({ v: 1, kind: "response" });
    state(response.state);
    const selectedAttempts = attempts.filter(
      (entry) =>
        entry.channel === "native-pipe" &&
        entry.bytesBase64 === selected[0]!.bytesBase64,
    );
    expect(selectedAttempts).toHaveLength(
      name === "matrix-duplicate-response-frame" ? 2 : 1,
    );
    // A completed native write proves its local send, never peer consumption.
    // An oversized write can be interrupted by the correct receiver rejection;
    // its legal bytes/actual inspect/selected attempt remain distinct evidence.
    if (name !== "matrix-response-overflow")
      for (const attempt of selectedAttempts) written(attempt);
    if (name === "matrix-wrong-id") {
      expect(response.requestId).toBe("f".repeat(32));
      expect(response.requestId).not.toBe(inspections[0]!.requestId);
    } else expect(response.requestId).toBe(inspections[0]!.requestId);
    if (name === "matrix-wrong-op") expect(response.op).toBe("claim");
    else expect(response.op).toBe("inspect");
    if (name === "matrix-wrong-execution") {
      expect(response.executionId).toBe("f".repeat(32));
      expect(response.executionId).not.toBe(bound!.executionId);
    } else expect(response.executionId).toBe(bound!.executionId);
    expect(response.role).toBe(
      name === "matrix-wrong-role" ? "observer" : "owner",
    );
    if (name === "matrix-duplicate-response")
      expect(text).toContain('"v":1,"v":1');
    if (name === "matrix-native-crlf")
      expect(bytes.subarray(-2)).toEqual(Buffer.from([13, 10]));
    if (name === "matrix-response-overflow") {
      expect(bytes.length).toBeGreaterThan(65536);
      expect(
        transcript.filter(
          (entry) => entry.stage === "response-overflow-semantically-legal",
        ),
      ).toHaveLength(1);
    }
    const results = frames.filter(
      (frame) => frame.kind === "state" && frame.requestId !== null,
    );
    if (name === "matrix-duplicate-response-frame") {
      expect(values.validInspectObservedBeforeDuplicateRelease).toBe(true);
      expect(
        transcript.filter(
          (entry) =>
            entry.stage === "duplicate-response-released-after-host-success",
        ),
      ).toHaveLength(1);
      const duplicate = transcript.filter(
        (entry) => entry.direction === "duplicate-response-selected",
      );
      expect(duplicate).toHaveLength(1);
      expect(duplicate[0]!.bytesBase64).toBe(selected[0]!.bytesBase64);
      const firstWritten = transcript.findIndex(
        (entry) =>
          entry.direction === "send-write-completed" &&
          entry.sequence === selectedAttempts[0]!.sequence,
      );
      const released = transcript.findIndex(
        (entry) =>
          entry.stage === "duplicate-response-released-after-host-success",
      );
      const secondAttempt = transcript.findIndex(
        (entry) =>
          entry.direction === "send-attempt" &&
          entry.sequence === selectedAttempts[1]!.sequence,
      );
      const secondWritten = transcript.findIndex(
        (entry) =>
          entry.direction === "send-write-completed" &&
          entry.sequence === selectedAttempts[1]!.sequence,
      );
      expect(firstWritten).toBeGreaterThanOrEqual(0);
      expect(released).toBeGreaterThan(firstWritten);
      expect(secondAttempt).toBeGreaterThan(released);
      expect(secondWritten).toBeGreaterThan(secondAttempt);
      expect(results).toHaveLength(1);
      expect(results[0]!.requestId).toBe(caller[0]!.value.requestId);
    } else expect(results).toEqual([]);
  }
  if (name === "matrix-held-live" || name === "matrix-one-sided-eof")
    expect(
      transcript.filter((entry) => entry.stage === "stop-held"),
    ).toHaveLength(1);
  if (name === "matrix-one-sided-eof") {
    expect(values).toMatchObject({
      oneSidedInspectObservedBeforeClose: true,
      oneSidedCallerEofBeforeRelease: true,
      oneSidedStageOrderProved: true,
    });
    expect(values.oneSidedStopHeldIdentity).toEqual(bound!.helper);
    expect(values.oneSidedStdoutClosedIdentity).toEqual(bound!.helper);
    expect(
      nativeRequests.filter((request) => request.op === "stop"),
    ).toHaveLength(1);
    expect(
      frames.filter(
        (frame) =>
          frame.kind === "state" &&
          frame.requestId === caller[0]!.value.requestId,
      ),
    ).toHaveLength(1);
    const receivedStop = transcript.findIndex(
      (entry) =>
        entry.direction === "received" &&
        entry.channel === "native-pipe" &&
        JSON.parse(
          Buffer.from(entry.bytesBase64 as string, "base64").toString("utf8"),
        ).op === "stop",
    );
    const held = transcript.findIndex((entry) => entry.stage === "stop-held");
    const released = transcript.findIndex(
      (entry) => entry.stage === "stdout-eof-released",
    );
    const closedIndex = transcript.findIndex(
      (entry) => entry.stage === "actual-stdout-handle-closed",
    );
    expect(receivedStop).toBeGreaterThanOrEqual(0);
    expect(held).toBeGreaterThan(receivedStop);
    expect(released).toBeGreaterThan(held);
    expect(closedIndex).toBeGreaterThan(released);
    expect(transcript[closedIndex]).toMatchObject({
      identity: bound!.helper,
      stderrHandleKeptOpen: true,
    });
    const stageWrites = attempts
      .filter((entry) => entry.channel === "test-barrier")
      .map((entry) => ({
        entry,
        frame: object(
          JSON.parse(
            Buffer.from(entry.bytesBase64 as string, "base64").toString("utf8"),
          ),
        ),
      }));
    for (const stage of ["stop-held", "actual-stdout-closed"]) {
      const selected = stageWrites.filter(
        (value) =>
          value.frame.kind === "fault-stage" && value.frame.stage === stage,
      );
      expect(selected).toHaveLength(1);
      expect(selected[0]!.frame).toMatchObject({
        v: 1,
        identity: bound!.helper,
      });
      written(selected[0]!.entry);
      if (stage === "actual-stdout-closed")
        expect(selected[0]!.frame.stderrHandleKeptOpen).toBe(true);
    }
    const closedStage = stageWrites.find(
      (value) => value.frame.stage === "actual-stdout-closed",
    )!;
    expect(transcript.indexOf(closedStage.entry)).toBeGreaterThan(closedIndex);
  }

  const observations = values.bridgeFrameObservations as Value[];
  expect(observations.map((entry) => entry.kind)).toEqual(
    frames.map((frame) => frame.kind),
  );
  const unknown = observations.find((entry) => entry.kind === "unknown");
  if (unknown !== undefined) {
    expect(Number.isSafeInteger(unknown.observedTick)).toBe(true);
    const sessionBoundary =
      (values.bridgeStartAttemptTick as number) +
      (values.configuredSessionTimeoutMs as number);
    if (name === "matrix-deadline")
      expect(unknown.observedTick).toBeGreaterThanOrEqual(sessionBoundary);
    else expect(unknown.observedTick).toBeLessThan(sessionBoundary);
  }
}

function structuredError(error: unknown): Value {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack ?? null }
    : { name: "non-error", value: String(error) };
}

function outputCausality(name: string, values: Value, child: Value) {
  const low = name.endsWith("-low");
  const paused = !name.startsWith("output-session-");
  const heldClose = name === "output-held-close";
  const frames = rawFrames(child.stdout);
  const caller = callerFrames(child);
  bridgeFrames(frames, !low, allowedInspectResults(name, caller));
  expect(frames[0]!.kind).toBe("bound");
  expect(frames[0]!.bridge).toEqual(child.identity);
  const bound = frames[0]!;
  const snapshot = {
    phase: "claimed",
    sealReason: null,
    requestFingerprint: null,
    descriptor: null,
    authorizationVerified: false,
    resumeState: "not-attempted",
    evidenceOutcome: "pending",
    completion: null,
  };
  expect(bound.state).toEqual(snapshot);
  const probe = {
    v: 1,
    kind: "state",
    requestId: values.inspectRequestId,
    executionId: bound.executionId,
    state: snapshot,
  };
  expect(values.outputPositiveProbe).toEqual(probe);
  expect(frames[1]).toEqual(probe);
  expect(caller.map((item) => item.value.op)).toEqual(
    low ? ["inspect"] : ["inspect", "close"],
  );
  for (const item of caller) {
    exact(item.value, ["v", "kind", "requestId", "op", "executionId"]);
    expect(item.value).toMatchObject({
      v: 1,
      kind: "command",
      executionId: bound.executionId,
    });
    expect(item.bytes.length).toBeLessThanOrEqual(65536);
  }
  expect(caller[0]!.value.requestId).toBe(values.inspectRequestId);
  if (!low) expect(caller[1]!.value.requestId).toBe(values.closeRequestId);
  const stateBytes = Buffer.byteLength(
    `${JSON.stringify({ ...probe, requestId: null })}\n`,
  );
  const limits = object(values.outputLimits);
  expect(limits).toMatchObject({
    responseFrameBytes: outputResponseBytes,
    eventCount: outputEventCount,
    upperOutputBytes: outputUpperBytes,
    highOutputBytes: outputHighBytes,
    sessionOutputBytes:
      name === "output-session-low" ? 3 * outputResponseBytes : outputHighBytes,
    queuedOutputBytes:
      name === "output-queue-low" ? 2 * outputResponseBytes : outputHighBytes,
    rawCaptureBytes: outputHighBytes,
    transcriptBytes: outputTranscriptBytes,
    outerCaptureBytes: outputOuterBytes,
    minimumStateFrameBytes: stateBytes,
    nativeSessionTimeoutMs: executionMs + cleanupMs + 1,
  });
  expect(limits.maximumSchemaFrameBytes).toBeLessThanOrEqual(
    outputResponseBytes,
  );
  expect(values.outputPrefixBytes).toBeLessThan(3 * outputResponseBytes);
  expect(outputEventCount * stateBytes).toBeGreaterThan(
    3 * outputResponseBytes,
  );
  expect(values.outputNativeSessionBoundaryTick).toBeGreaterThan(
    limits.hostCleanupDeadlineTick as number,
  );
  expect(values.outputReadPolicy).toBe(
    paused ? "pause-after-positive-probe" : "continuous",
  );
  const stdoutBytes = Buffer.from(
    object(child.stdout).capturedBase64 as string,
    "base64",
  );
  expect(stdoutBytes.length).toBeLessThanOrEqual(
    limits.sessionOutputBytes as number,
  );
  for (const base64 of object(child.stdout).framesBase64 as string[])
    expect(Buffer.from(base64, "base64").length).toBeLessThanOrEqual(
      outputResponseBytes,
    );
  const barrier = object(values.testHelperBarrier);
  expect(barrier).toMatchObject({
    testOnlyIdentityQuery: true,
    independentCreationPin: false,
    actualEof: true,
    query: {
      identity: bound.helper,
      originalJoined: true,
      alive: false,
      exitCode: 0,
      sameSid: true,
      nonInherited: true,
    },
  });
  const barrierFrames = rawFrames(barrier.capture);
  const transcript = values.helperTranscript as Value[];
  const transcriptBytes = Buffer.from(
    values.helperTranscriptRawBase64 as string,
    "base64",
  );
  expect(transcriptBytes.length).toBeLessThanOrEqual(outputTranscriptBytes);
  expect(
    new TextDecoder("utf-8", { fatal: true })
      .decode(transcriptBytes)
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line)),
  ).toEqual(transcript);
  for (const stage of ["started", "helper-registered-before-fault"])
    expect(transcript.filter((entry) => entry.stage === stage)).toHaveLength(1);
  expect(
    transcript.filter((entry) =>
      ["forbidden-forward", "emitter-error"].includes(
        entry.direction as string,
      ),
    ),
  ).toEqual([]);
  expect(
    transcript.filter((entry) =>
      [
        "native-pipe-error",
        "emitter-error",
        "emitter-control-error",
        "output-helper-error",
      ].includes(entry.stage as string),
    ),
  ).toEqual([]);
  const attempts = transcript.filter(
    (entry) => entry.direction === "send-attempt",
  );
  const sequences = attempts.map((entry) => entry.sequence as number);
  expect(new Set(sequences).size).toBe(attempts.length);
  expect([...sequences].sort((left, right) => left - right)).toEqual(
    Array.from({ length: attempts.length }, (_, index) => index + 1),
  );
  const countCompletion = (entry: Value, direction: string) =>
    transcript.filter(
      (item) =>
        item.direction === direction &&
        item.sequence === entry.sequence &&
        item.channel === entry.channel,
    ).length;
  for (const entry of attempts) {
    const writes = countCompletion(entry, "send-write-completed");
    const completed = countCompletion(entry, "send-completed");
    const failed = countCompletion(entry, "send-failed");
    expect(writes).toBeLessThanOrEqual(1);
    expect(completed).toBeLessThanOrEqual(writes);
    expect(completed + failed).toBe(1);
  }
  const decoded = attempts.map((entry) => {
    const bytes = Buffer.from(entry.bytesBase64 as string, "base64");
    expect(bytes.toString("base64")).toBe(entry.bytesBase64);
    expect(bytes.at(-1)).toBe(10);
    expect(bytes.subarray(0, -1).includes(10)).toBe(false);
    expect(bytes.includes(13)).toBe(false);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
      false,
    );
    return {
      entry,
      bytes,
      frame: object(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, -1),
          ),
        ),
      ),
    };
  });
  const events = decoded.filter(
    (item) =>
      item.entry.channel === "native-pipe" && item.frame.kind === "event",
  );
  expect(events.length).toBeGreaterThan(0);
  expect(events.length).toBeLessThanOrEqual(outputEventCount);
  for (const event of events) {
    expect(event.frame).toEqual({
      v: 1,
      kind: "event",
      event: "state",
      executionId: bound.executionId,
      state: snapshot,
    });
    expect(event.bytes.length).toBeLessThanOrEqual(outputResponseBytes);
    expect(event.bytes.equals(events[0]!.bytes)).toBe(true);
  }
  const eventWrites = events.filter(
    (event) => countCompletion(event.entry, "send-write-completed") === 1,
  );
  const eventCompleted = events.filter(
    (event) => countCompletion(event.entry, "send-completed") === 1,
  );
  const nativeRequests = transcript
    .filter(
      (entry) =>
        entry.direction === "received" && entry.channel === "native-pipe",
    )
    .map((entry) =>
      exact(
        JSON.parse(
          Buffer.from(entry.bytesBase64 as string, "base64").toString("utf8"),
        ),
        ["v", "requestId", "op", "executionId"],
      ),
    );
  for (const request of nativeRequests) {
    expect(request).toMatchObject({ v: 1, executionId: bound.executionId });
    expect(request.requestId).toMatch(/^[0-9a-f]{32}$/);
  }
  for (const response of decoded.filter(
    (item) =>
      item.entry.channel === "native-pipe" && item.frame.kind !== "event",
  )) {
    exact(response.frame, [
      "v",
      "kind",
      "requestId",
      "op",
      "executionId",
      "role",
      "state",
    ]);
    expect(response.frame).toMatchObject({
      v: 1,
      kind: "response",
      executionId: bound.executionId,
      state: snapshot,
    });
    expect(response.bytes.length).toBeLessThanOrEqual(outputResponseBytes);
    expect(
      nativeRequests.filter(
        (request) =>
          request.requestId === response.frame.requestId &&
          request.op === response.frame.op,
      ),
    ).toHaveLength(1);
    expect(response.frame.role).toBe(
      response.frame.op === "watch" ? "observer" : "owner",
    );
  }
  const loadCommands = transcript.filter(
    (entry) =>
      entry.direction === "received" && entry.channel === "test-barrier",
  );
  expect(loadCommands).toHaveLength(1);
  expect(
    JSON.parse(
      Buffer.from(loadCommands[0]!.bytesBase64 as string, "base64").toString(
        "utf8",
      ),
    ),
  ).toEqual({
    v: 1,
    kind: "emit-events",
    batchId: values.outputBatchId,
    count: outputEventCount,
  });
  expect(nativeRequests.map((request) => request.op)).toEqual(
    low ? ["claim", "watch", "inspect"] : ["claim", "watch", "inspect", "stop"],
  );
  const started = object(values.outputBatchStarted);
  expect(started).toEqual({
    v: 1,
    kind: "emitter-stage",
    stage: "batch-started",
    batchId: values.outputBatchId,
    declaredEvents: outputEventCount,
    nativeEventBytes: events[0]!.bytes.length,
  });
  expect(
    barrierFrames.filter((frame) => frame.stage === "batch-started"),
  ).toEqual([started]);
  const settled = object(values.outputTasksSettled);
  expect(settled).toEqual({
    v: 1,
    kind: "emitter-stage",
    stage: "output-tasks-settled",
    batchId: values.outputBatchId,
    eventsAttempted: events.length,
    eventsWritten: eventWrites.length,
    eventsCompleted: eventCompleted.length,
    bytesWritten: eventWrites.reduce(
      (sum, event) => sum + event.bytes.length,
      0,
    ),
    nativeStopCount: low ? 0 : 1,
    controlJoined: true,
    emitterJoined: true,
    connectionsJoined: true,
    outputHelperFailure: false,
  });
  expect(
    barrierFrames.filter((frame) => frame.stage === "output-tasks-settled"),
  ).toEqual([settled]);
  const stages = values.outputStages as Value[];
  const stageIndex = (stage: string) => {
    expect(stages.filter((entry) => entry.stage === stage)).toHaveLength(1);
    return stages.findIndex((entry) => entry.stage === stage);
  };
  for (let index = 1; index < stages.length; index++)
    expect(stages[index]!.observedTick).toBeGreaterThanOrEqual(
      stages[index - 1]!.observedTick as number,
    );
  const before = (left: string, right: string) =>
    expect(stageIndex(left)).toBeLessThan(stageIndex(right));
  before("positive-probe-observed", "finite-load-command-written");
  before("finite-load-command-written", "batch-started");
  before("helper-tasks-settled", "helper-query-and-barrier-joined");
  if (paused) {
    const gate = object(values.stdoutReadGate);
    expect(gate).toMatchObject({
      armedBeforeLaunch: true,
      boundObserved: true,
      probeObserved: true,
      pauseAcknowledged: true,
      releaseCount: 1,
      gateJoined: true,
      pause: {
        pauseSequence: 1,
        rawBytesRead: values.outputPrefixBytes,
        completeFrames: 2,
        pendingFrameBytes: 0,
        originalReadInFlight: false,
        actualEof: false,
        streamLocallyClosed: false,
      },
    });
    expect(gate.pause).toEqual(values.outputPause);
    expect(values.stdoutGateCleanupReleasePerformed).toBe(false);
    expect(values.stdoutGateDefensiveCleanupReleasePerformed).toBe(false);
    expect(gate.releaseReason).toBe(
      low
        ? "scenario-after-autonomous-witness"
        : heldClose
          ? "scenario-after-helper-and-sentinel-join"
          : "scenario-after-high-batch",
    );
    before("original-stdout-paused", "finite-load-command-written");
    expect(object(child.stdout).actualEofTick).toBeGreaterThanOrEqual(
      gate.releaseTick as number,
    );
    expect(child.originalJoinedTick).toBeGreaterThanOrEqual(
      gate.releaseTick as number,
    );
  } else expect(values.stdoutReadGate).toBeUndefined();
  const delivered = frames.filter(
    (frame) => frame.kind === "state" && frame.requestId === null,
  );
  expect(delivered.length).toBeLessThanOrEqual(outputEventCount);
  for (const frame of delivered) expect(frame.state).toEqual(snapshot);
  if (low) {
    const witness = object(values.outputAutonomousWitness);
    expect(witness).toMatchObject({
      v: 1,
      kind: "emitter-stage",
      stage: "autonomous-owner-closure",
      batchId: values.outputBatchId,
      localCancellation: false,
      originalPipeLocallyClosing: false,
      identity: bound.helper,
    });
    if (witness.readOutcome === "zero-read")
      expect(witness.nativeError).toBeNull();
    else {
      expect(witness.readOutcome).toBe("remote-broken-pipe-read");
      expect([109, 232, 233]).toContain(witness.nativeError);
    }
    expect(witness.eventsAttempted).toBeGreaterThan(0);
    expect(witness.eventsAttempted).toBeLessThanOrEqual(events.length);
    expect(
      barrierFrames.filter(
        (frame) => frame.stage === "autonomous-owner-closure",
      ),
    ).toEqual([witness]);
    const witnessedAt =
      stages[stageIndex("autonomous-owner-closure-before-caller-eof")]!;
    expect(witnessedAt).toMatchObject({
      callerInputClosed: false,
      callerSendCount: 1,
    });
    before("batch-started", "autonomous-owner-closure-before-caller-eof");
    before(
      "autonomous-owner-closure-before-caller-eof",
      "helper-tasks-settled",
    );
    before(
      "helper-query-and-barrier-joined",
      "caller-real-eof-after-independent-witness",
    );
    if (paused)
      before(
        "caller-real-eof-after-independent-witness",
        "original-stdout-resumed",
      );
    const attemptedOutput =
      events.length * stateBytes +
      (name === "output-session-low"
        ? (values.outputPrefixBytes as number)
        : 0);
    expect(attemptedOutput).toBeGreaterThan(
      name === "output-session-low"
        ? (limits.sessionOutputBytes as number)
        : (limits.queuedOutputBytes as number),
    );
    // A receiver rejection may interrupt the rejecting native write. Attempts
    // describe its legal stimulus; completed writes remain separate counters.
    for (const terminal of frames.filter((frame) => frame.kind === "closed"))
      expect(terminal.outcome).toBe("unknown");
    // Output quota exhaustion may leave no room for Unknown/closed. Natural
    // original exit2, real dual EOF and exact Job joins come from healthy().
    return;
  }
  expect(events).toHaveLength(outputEventCount);
  expect(eventWrites).toHaveLength(outputEventCount);
  expect(eventCompleted).toHaveLength(outputEventCount);
  expect(values.outputBatchWritten).toMatchObject({
    batchId: values.outputBatchId,
    eventsAttempted: outputEventCount,
    eventsWritten: outputEventCount,
    eventsCompleted: outputEventCount,
  });
  expect(frames.at(-1)).toEqual({
    v: 1,
    kind: "closed",
    requestId: values.closeRequestId,
    executionId: bound.executionId,
    outcome: "stopped",
  });
  expect(frames.filter((frame) => frame.kind === "closed")).toHaveLength(1);
  expect(frames.some((frame) => frame.kind === "unknown")).toBe(false);
  if (!heldClose) {
    expect(delivered).toHaveLength(outputEventCount);
    before("native-batch-written", "all-events-delivered-before-close");
    before("all-events-delivered-before-close", "valid-close-after-all-events");
    before("valid-close-after-all-events", "caller-real-eof-after-all-events");
  } else {
    expect(values.outputNativeStop).toMatchObject({
      batchId: values.outputBatchId,
      executionId: bound.executionId,
      requestId: nativeRequests.at(-1)!.requestId,
      identity: bound.helper,
    });
    expect(values).toMatchObject({
      sentinelReadyBeforeBridgeStart: true,
      sentinelResponsiveBeforeStdoutResume: true,
      sentinelAliveAfterBridgeCleanup: true,
      originalBridgeUnsignaledBeforeStdoutResume: true,
    });
    before("native-batch-written", "valid-close-write-completed-while-paused");
    before(
      "valid-close-write-completed-while-paused",
      "caller-real-eof-while-paused",
    );
    before("caller-real-eof-while-paused", "native-stop-observed");
    before("native-stop-observed", "helper-tasks-settled");
    before(
      "helper-query-and-barrier-joined",
      "sentinel-responsive-before-resume",
    );
    before(
      "sentinel-responsive-before-resume",
      "original-bridge-unsignaled-immediately-before-resume",
    );
    before(
      "original-bridge-unsignaled-immediately-before-resume",
      "original-stdout-resumed",
    );
    const sentinel = object(values.sentinel);
    expect(sentinel).toMatchObject({
      originalJoined: true,
      exitCode: 0,
      alive: false,
      forced: false,
      stdinClosedByCaller: true,
    });
    expect(rawFrames(sentinel.stdout).map((frame) => frame.kind)).toEqual([
      "ready",
      "pong",
    ]);
    expect(rawFrames(sentinel.stderr)).toEqual([]);
    expect(callerFrames(sentinel).map((item) => item.value)).toEqual([
      { v: 1, kind: "ping", requestId: "sentinel-before-stdout-resume" },
    ]);
  }
}

let evidenceRoot: string;

suite("restricted native control bridge actual Windows", () => {
  beforeAll(async () => {
    expect(process.platform).toBe("win32");
    expect([
      "first",
      "health",
      "red",
      "full",
      "ordinary",
      "lifecycle",
      "protocol",
      "limits",
    ]).toContain(mode);
    for (const path of [fixtureExe, bridgeExe, ordinaryExe, faultExe]) {
      expect(typeof path).toBe("string");
      expect(isAbsolute(path!)).toBe(true);
      expect(path!.toLowerCase().endsWith(".exe")).toBe(true);
      await access(path!);
    }
    evidenceRoot =
      process.env.ZEB_WINDOWS_CONTROL_BRIDGE_EVIDENCE_ROOT ??
      (await mkdtemp(join(tmpdir(), "zeb-control-bridge-evidence-")));
    expect(isAbsolute(evidenceRoot)).toBe(true);
    await mkdir(evidenceRoot, { recursive: true });
  });

  async function scenario(name: string) {
    const directory = await mkdtemp(join(evidenceRoot, `${name}-商品's 🙂-`));
    const fixture = new BridgeFixture(
      outputScenarios.has(name) ? outputOuterBytes : maxOuterCaptureBytes,
    );
    let observed: Receipt | undefined;
    const cleanupErrors: Value[] = [];
    let primaryError: unknown;
    let primaryFailed = false;
    try {
      fixture.launch(directory);
      observed = await fixture.run(name);
      return { fixture, observed };
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
      throw error;
    } finally {
      try {
        await fixture.observeCleanup();
      } catch (error) {
        cleanupErrors.push(structuredError(error));
      }
      // Preserve both failed and successful rounds. Unknown cleanup never
      // permits deleting a directory or losing the original failing receipt.
      try {
        await writeFile(
          join(directory, "control-bridge-evidence.json"),
          `${JSON.stringify({ scenario: name, primaryFailure: primaryFailed ? structuredError(primaryError) : null, observation: fixture.evidence(), cleanupErrors }, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      } catch (error) {
        cleanupErrors.push({
          phase: "evidence-write",
          ...structuredError(error),
        });
      }
      console.info(
        `WINDOWS_CONTROL_BRIDGE_EVIDENCE ${JSON.stringify({ scenario: name, directory, cleanupErrors })}`,
      );
      // The original rejected object remains primary even if cleanup or wx
      // evidence writing also fails. Cleanup-only failures still fail the test.
      if (!primaryFailed && cleanupErrors.length > 0)
        throw new AggregateError(
          cleanupErrors,
          "Control bridge cleanup/evidence failed",
        );
    }
  }

  it.skipIf(!["first", "health", "full"].includes(mode))(
    "guard-health proves birth containment, original child exit0 and real dual EOF",
    async () => {
      const { fixture, observed } = await scenario("guard-health");
      const { values, child } = healthy(observed, fixture, "guard-health");
      expect(values).toMatchObject({
        helperEvidence: "direct-original-test-fixture-creation-pin",
        bridgeLaunches: 0,
      });
      const frames = rawFrames(child.stdout);
      expect(child.sentFramesBase64).toEqual([]);
      expect(frames).toHaveLength(1);
      expect(exact(frames[0], ["v", "kind", "executionId"])).toMatchObject({
        v: 1,
        kind: "ready",
      });
      expect(frames[0]!.executionId).toMatch(/^[a-f0-9]{32}$/);
    },
    testMs,
  );

  it.skipIf(!["first", "red", "ordinary", "full"].includes(mode))(
    "ordinary helper binds once, correlates inspect and closes naturally after caller EOF",
    async () => {
      const { fixture, observed } = await scenario("ordinary");
      const { values, child } = healthy(observed, fixture, "ordinary");
      const frames = rawFrames(child.stdout);
      const inspectLimits = allowedInspectResults(
        "ordinary",
        callerFrames(child),
      );
      bridgeFrames(frames, false, inspectLimits);
      expect(frames.length).toBeGreaterThan(0);
      // Required behavioral RED: valid Unknown-only scaffold, healthy cleanup,
      // then AssertionError: expected 'unknown' to be 'bound'.
      expect(frames[0]!.kind).toBe("bound");
      bridgeFrames(frames, true, inspectLimits);
      const bound = exact(frames[0], [
        "v",
        "kind",
        "executionId",
        "bridge",
        "helper",
        "state",
      ]);
      expect(bound.v).toBe(1);
      expect(bound.executionId).toMatch(/^[a-f0-9]{32}$/);
      expect(bound.bridge).toEqual(child.identity);
      for (const identity of [bound.bridge, bound.helper]) {
        const found = exact(identity, ["pid", "creationFileTime"]);
        expect(Number.isInteger(found.pid)).toBe(true);
        expect(found.pid).toBeGreaterThan(0);
        expect(found.pid).toBeLessThanOrEqual(0xffff_ffff);
        expect(found.creationFileTime).toMatch(/^[1-9][0-9]*$/);
        expect(BigInt(found.creationFileTime as string)).toBeLessThanOrEqual(
          0xffff_ffff_ffff_ffffn,
        );
      }
      state(bound.state);
      expect(frames.filter((frame) => frame.kind === "bound")).toHaveLength(1);
      expect(values).toMatchObject({
        bridgeLaunches: 1,
        helperEvidence: "trusted-bridge-statement-plus-exact-job-query",
        inspectRequestId: "00000000000000000000000000000001",
        closeRequestId: "00000000000000000000000000000002",
      });
      expect(
        (observed.outer.guardDiagnostics.registrationSources as Value[]).map(
          (value) => value.source,
        ),
      ).toEqual([
        "original-bridge-created-in-host",
        "trusted-bridge-helper-query",
      ]);
      expect(Array.isArray(child.sentFramesBase64)).toBe(true);
      const sent = (child.sentFramesBase64 as string[]).map((base64) => {
        const bytes = Buffer.from(base64, "base64");
        expect(bytes.at(-1)).toBe(10);
        expect(bytes.includes(13)).toBe(false);
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, -1),
          ),
        ) as Value;
      });
      expect(sent).toEqual([
        {
          v: 1,
          kind: "command",
          requestId: values.inspectRequestId,
          op: "inspect",
          executionId: bound.executionId,
        },
        {
          v: 1,
          kind: "command",
          requestId: values.closeRequestId,
          op: "close",
          executionId: bound.executionId,
        },
      ]);
      const inspect = frames.find(
        (frame) =>
          frame.kind === "state" && frame.requestId === values.inspectRequestId,
      );
      expect(inspect).toBeDefined();
      expect(
        exact(inspect, ["v", "kind", "requestId", "executionId", "state"]),
      ).toMatchObject({ v: 1, executionId: bound.executionId });
      state(inspect!.state);
      for (const event of frames.filter((frame) => frame.kind === "state")) {
        exact(event, ["v", "kind", "requestId", "executionId", "state"]);
        expect(event).toMatchObject({ v: 1, executionId: bound.executionId });
        if (event.requestId !== null)
          expect(event.requestId).toBe(values.inspectRequestId);
        state(event.state);
      }
      const terminal = exact(frames.at(-1), [
        "v",
        "kind",
        "requestId",
        "executionId",
        "outcome",
      ]);
      expect(terminal).toEqual({
        v: 1,
        kind: "closed",
        requestId: values.closeRequestId,
        executionId: bound.executionId,
        outcome: "stopped",
      });
      expect(frames.filter((frame) => frame.kind === "closed")).toHaveLength(1);
      expect(frames.some((frame) => frame.kind === "unknown")).toBe(false);
      // No ACK/final observer event is required: the ordinary helper may exit
      // before their delivery. Helper exit/EOF are trusted bridge statements,
      // not independent helper creation-handle or stream receipts from this host.
    },
    testMs,
  );
  it.skipIf(!["ordinary", "full"].includes(mode))(
    "ordinary ten-argument ready is actual CRLF and native pipe traffic is actual LF",
    async () => {
      const { fixture, observed } = await scenario("ordinary-ready");
      const { values, child } = healthy(
        observed,
        fixture,
        "ordinary-ready",
        0,
        true,
      );
      expect(values).toMatchObject({
        bridgeLaunches: 0,
        helperEvidence: "direct-original-ordinary-creation-pin",
      });
      const ready = rawFrames(child.stdout, true);
      expect(ready).toHaveLength(1);
      expect(exact(ready[0], ["v", "kind", "executionId"])).toMatchObject({
        v: 1,
        kind: "ready",
      });
      const native = object(values.nativePipe);
      expect(native).toMatchObject({
        server: child.identity,
        originalCreationPinVerified: true,
        stopAckRequired: false,
      });
      const received = rawFrames(native.capture);
      expect(
        received.filter(
          (frame) => frame.kind === "response" && frame.op === "claim",
        ),
      ).toHaveLength(1);
      expect(
        received.filter(
          (frame) => frame.kind === "response" && frame.op === "inspect",
        ),
      ).toHaveLength(1);
      for (const frame of received) {
        exact(frame, [
          "v",
          "kind",
          "requestId",
          "op",
          "executionId",
          "role",
          "state",
        ]);
        expect(frame).toMatchObject({
          v: 1,
          kind: "response",
          executionId: ready[0]!.executionId,
          role: "owner",
        });
        state(frame.state);
      }
      expect(
        (native.sentFramesBase64 as string[]).map((base64) => {
          const bytes = Buffer.from(base64, "base64");
          expect(bytes.at(-1)).toBe(10);
          expect(bytes.includes(13)).toBe(false);
          return object(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                bytes.subarray(0, -1),
              ),
            ),
          ).op;
        }),
      ).toEqual(["claim", "inspect", "stop"]);
    },
    testMs,
  );

  const matrixCases = [
    ["matrix-controlled", "lifecycle", true],
    ["matrix-eof-before-ready", "lifecycle", false],
    ["matrix-eof-after-bound", "lifecycle", false],
    ["matrix-pending-close", "lifecycle", true],
    ["matrix-withheld-eof", "lifecycle", false],
    ["matrix-deadline", "lifecycle", false],
    ["matrix-held-live", "lifecycle", false],
    ["matrix-one-sided-eof", "lifecycle", false],
    ["matrix-forbidden-prepare", "protocol", false],
    ["matrix-forbidden-authorize", "protocol", false],
    ["matrix-forbidden-raw", "protocol", false],
    ["matrix-extra-field", "protocol", false],
    ["matrix-duplicate-key", "protocol", false],
    ["matrix-duplicate-id", "protocol", false],
    ["matrix-no-ready", "protocol", false],
    ["matrix-invalid-ready", "protocol", false],
    ["matrix-malformed-ready", "protocol", false],
    ["matrix-duplicate-ready", "protocol", false],
    ["matrix-wrong-id", "protocol", false],
    ["matrix-wrong-op", "protocol", false],
    ["matrix-wrong-execution", "protocol", false],
    ["matrix-wrong-role", "protocol", false],
    ["matrix-duplicate-response", "protocol", false],
    ["matrix-duplicate-response-frame", "protocol", false],
    ["matrix-native-crlf", "protocol", false],
    ["matrix-input-overflow", "limits", false],
    ["matrix-session-input-overflow", "limits", false],
    ["matrix-stdout-extra", "limits", false],
    ["matrix-stdout-overflow", "limits", false],
    ["matrix-stderr-payload", "limits", false],
    ["matrix-response-overflow", "limits", false],
  ] as const;

  for (const [name, group, success] of matrixCases) {
    it.skipIf(!["full", group].includes(mode))(
      `${name}: real controlled helper, exact Job cleanup and ${success ? "stopped" : "sticky Unknown"}`,
      async () => {
        const { fixture, observed } = await scenario(name);
        const { values, child } = healthy(
          observed,
          fixture,
          name,
          success ? 0 : 2,
        );
        const frames = rawFrames(child.stdout);
        const caller = callerFrames(child);
        requireMatrixBound(name, frames);
        bridgeFrames(frames, success, allowedInspectResults(name, caller));
        expect(frames.length).toBeGreaterThan(0);
        const closed = frames.at(-1)!;
        expect(closed).toMatchObject({
          v: 1,
          kind: "closed",
          outcome: success ? "stopped" : "unknown",
        });
        expect(frames.filter((frame) => frame.kind === "closed")).toHaveLength(
          1,
        );
        if (success)
          expect(frames.some((frame) => frame.kind === "unknown")).toBe(false);
        else
          expect(
            frames.filter((frame) => frame.kind === "unknown"),
          ).toHaveLength(1);
        const barrier = object(values.testHelperBarrier);
        expect(barrier).toMatchObject({
          testOnlyIdentityQuery: true,
          independentCreationPin: false,
          actualEof: true,
          query: {
            originalJoined: true,
            alive: false,
            sameSid: true,
            nonInherited: true,
          },
        });
        expect(
          (
            observed.outer.guardDiagnostics.registrationSources as Value[]
          ).filter((value) => value.source === "test-barrier-helper-query"),
        ).toHaveLength(1);
        const transcript = values.helperTranscript as Value[];
        expect(Array.isArray(transcript)).toBe(true);
        expect(
          transcript.filter((value) => value.stage === "started"),
        ).toHaveLength(1);
        expect(
          transcript.filter(
            (value) => value.stage === "helper-registered-before-fault",
          ),
        ).toHaveLength(1);
        expect(
          transcript.filter((value) => value.direction === "forbidden-forward"),
        ).toEqual([]);
        const nativeRequests = transcript
          .filter(
            (value) =>
              value.direction === "received" && value.channel === "native-pipe",
          )
          .map((value) => {
            const bytes = Buffer.from(value.bytesBase64 as string, "base64");
            expect(bytes.at(-1)).toBe(10);
            expect(bytes.includes(13)).toBe(false);
            const request = exact(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  bytes.subarray(0, -1),
                ),
              ),
              ["v", "requestId", "op", "executionId"],
            );
            expect(request.v).toBe(1);
            expect(["claim", "watch", "inspect", "stop"]).toContain(request.op);
            return request;
          });
        matrixCausality(
          name,
          frames,
          caller,
          transcript,
          nativeRequests,
          values,
        );
        expect(
          nativeRequests.filter((value) => value.op === "stop").length,
        ).toBeLessThanOrEqual(1);
        if (name === "matrix-eof-before-ready") {
          expect(values.callerEofBeforeReadyRelease).toBe(true);
          expect(frames.some((value) => value.kind === "bound")).toBe(false);
          expect(nativeRequests).toEqual([]);
        }
        if (
          [
            "matrix-no-ready",
            "matrix-invalid-ready",
            "matrix-malformed-ready",
            "matrix-duplicate-ready",
          ].includes(name)
        )
          expect(frames.some((value) => value.kind === "bound")).toBe(false);
        if (
          name.startsWith("matrix-forbidden-") ||
          [
            "matrix-extra-field",
            "matrix-duplicate-key",
            "matrix-input-overflow",
          ].includes(name)
        )
          expect(
            nativeRequests.filter((value) => value.op === "inspect"),
          ).toEqual([]);
        if (name === "matrix-duplicate-id")
          expect(
            nativeRequests.filter((value) => value.op === "inspect"),
          ).toHaveLength(1);
        if (name === "matrix-controlled") {
          expect(frames[0]!.kind).toBe("bound");
          expect(
            frames.filter(
              (frame) => frame.kind === "state" && frame.requestId === null,
            ).length,
          ).toBeGreaterThan(0);
          // Controlled helper, not the ordinary helper, guarantees this event.
          const sent = transcript.filter(
            (value) =>
              value.direction === "send-attempt" &&
              value.channel === "native-pipe",
          );
          expect(
            sent.some(
              (value) =>
                JSON.parse(
                  Buffer.from(value.bytesBase64 as string, "base64").toString(
                    "utf8",
                  ),
                ).kind === "event",
            ),
          ).toBe(true);
          expect(object(barrier.query).exitCode).toBe(0);
        }
        if (name === "matrix-pending-close") {
          expect(values.actualInspectHeldBeforeClose).toBe(true);
          expect(
            nativeRequests.filter((value) => value.op === "inspect"),
          ).toHaveLength(1);
          expect(
            frames.filter(
              (frame) =>
                frame.kind === "state" &&
                frame.requestId === values.inspectRequestId,
            ),
          ).toEqual([]);
        }
        if (name === "matrix-withheld-eof" || name === "matrix-deadline")
          expect(values.bridgeRetainedAtUnknown).toBe(true);
        if (name === "matrix-withheld-eof") {
          expect(values.callerEofWithheldUntilUnknown).toBe(true);
          expect(object(barrier.query).exitCode).toBe(0);
        }
        if (name === "matrix-input-overflow")
          expect(
            Buffer.from((child.sentFramesBase64 as string[])[0]!, "base64")
              .length,
          ).toBeGreaterThan(512);
        if (name === "matrix-session-input-overflow") {
          const sizes = (child.sentFramesBase64 as string[]).map(
            (value) => Buffer.from(value, "base64").length,
          );
          expect(sizes.every((value) => value <= 512)).toBe(true);
          expect(sizes.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(
            1024,
          );
        }
        if (name === "matrix-held-live" || name === "matrix-one-sided-eof") {
          expect(values).toMatchObject({
            sentinelReadyBeforeBridgeStart: true,
            sentinelResponsiveAfterBridgeCleanup: true,
          });
          const sentinel = object(values.sentinel);
          expect(sentinel).toMatchObject({
            originalJoined: true,
            alive: false,
            exitCode: 0,
            forced: false,
            stdinClosedByCaller: true,
          });
          expect(rawFrames(sentinel.stdout).map((frame) => frame.kind)).toEqual(
            ["ready", "pong"],
          );
          expect(rawFrames(sentinel.stderr)).toEqual([]);
          expect(object(barrier.query).exitCode).not.toBe(0);
        }
        if (name === "matrix-one-sided-eof")
          expect(
            transcript.filter(
              (value) =>
                value.stage === "actual-stdout-handle-closed" &&
                value.stderrHandleKeptOpen === true,
            ),
          ).toHaveLength(1);
      },
      testMs,
    );
  }

  for (const name of outputScenarios) {
    it.skipIf(!["full", "limits"].includes(mode))(
      `${name}: finite legal output, isolated quota/read policy and natural original joins`,
      async () => {
        const { fixture, observed } = await scenario(name);
        const { values, child } = healthy(
          observed,
          fixture,
          name,
          name.endsWith("-low") ? 2 : 0,
        );
        expect(fixture.evidence().maximumCaptureBytes).toBe(outputOuterBytes);
        expect(fixture.evidence().capturedBytes).toBeLessThanOrEqual(
          outputOuterBytes,
        );
        expect(values).toMatchObject({
          bridgeLaunches: 1,
          helperEvidence: "trusted-bridge-statement-plus-exact-job-query",
        });
        expect(
          (
            observed.outer.guardDiagnostics.registrationSources as Value[]
          ).filter((item) => item.source === "test-barrier-helper-query"),
        ).toHaveLength(1);
        outputCausality(name, values, child);
      },
      testMs,
    );
  }

  it.skipIf(!["full", "protocol"].includes(mode))(
    "oracle-only: native response JSON cannot pass the bridge success union",
    () => {
      const snapshot = {
        phase: "claimed",
        sealReason: null,
        requestFingerprint: null,
        descriptor: null,
        authorizationVerified: false,
        resumeState: "not-attempted",
        evidenceOutcome: "pending",
        completion: null,
      };
      const executionId = "a".repeat(32);
      const bound = {
        v: 1,
        kind: "bound",
        executionId,
        bridge: { pid: 1, creationFileTime: "1" },
        helper: { pid: 2, creationFileTime: "2" },
        state: snapshot,
      };
      const closed = {
        v: 1,
        kind: "closed",
        requestId: null,
        executionId,
        outcome: "stopped",
      };
      expect(() =>
        bridgeFrames([bound, { v: 1, kind: "response" }, closed], true),
      ).toThrow();
      const requestId = "1".repeat(32);
      const result = {
        v: 1,
        kind: "state",
        requestId,
        executionId,
        state: snapshot,
      };
      const unknown = { v: 1, kind: "unknown", requestId: null, executionId };
      const unknownClosed = { ...closed, outcome: "unknown" };
      const permitted = new Map([[requestId, 1]]);
      expect(() =>
        requireMatrixBound("matrix-forbidden-prepare", [
          unknown,
          unknownClosed,
        ]),
      ).toThrow();
      expect(() =>
        bridgeFrames(
          [
            bound,
            { ...result, requestId: "2".repeat(32) },
            unknown,
            unknownClosed,
          ],
          false,
          permitted,
        ),
      ).toThrow();
      expect(() =>
        bridgeFrames([bound, unknown, result, unknownClosed], false, permitted),
      ).toThrow();
      expect(() =>
        bridgeFrames(
          [bound, result, result, unknown, unknownClosed],
          false,
          permitted,
        ),
      ).toThrow();
      expect(() =>
        bridgeFrames(
          [bound, result, unknown, unknownClosed],
          false,
          new Map([[requestId, 0]]),
        ),
      ).toThrow();
      // A duplicate-frame fault permits its one earlier valid correlated
      // response; the duplicate never creates another success or upgrades Unknown.
      expect(() =>
        bridgeFrames([bound, result, unknown, unknownClosed], false, permitted),
      ).not.toThrow();
      // Injected oracle validation only; this is not an OS helper fault result.
    },
  );
});
