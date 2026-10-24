import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { freezeExecutionPolicy, type ClaimedAttempt } from "../src/execution.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import { controlBridgeExecutionDescriptor, controlBridgeSnapshot } from "./windows-control-bridge-host-fixtures.js";
import { claimedAttempt } from "./windows-prepare-payload-fixtures.js";
import { runnerLimits } from "./storage-fixtures.js";

type Value = Record<string, unknown>;
const object = (value: unknown): Value => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
};
const protocolFixture = process.env.ZEB_WINDOWS_RUNTIME_OBSERVATION_PROTOCOL_FIXTURE_EXE;
const bridgeDll = process.env.ZEB_WINDOWS_RUNTIME_OBSERVATION_BRIDGE_DLL;
const sessionFixture = process.env.ZEB_WINDOWS_SESSION_FIXTURE_EXE;
const ordinaryExe = process.env.ZEB_WINDOWS_SESSION_ORDINARY_EXE;
const testExe = process.env.ZEB_WINDOWS_SESSION_TEST_EXE;
const ordinaryDll = process.env.ZEB_WINDOWS_SESSION_ORDINARY_DLL;
const requested = process.env.ZEB_RUN_WINDOWS_RUNTIME_OBSERVATION_OS === "1";
const suite = requested ? describe : describe.skip;
const executionMs = 60_000;
const cleanupMs = 15_000;
const testMs = executionMs + cleanupMs + 5_000;
const sid = "S-1-5-80-1-2-3-4-5";

beforeAll(async () => {
  if (!requested) return;
  expect(process.platform).toBe("win32");
  for (const value of [protocolFixture, bridgeDll, sessionFixture, ordinaryExe, testExe, ordinaryDll]) {
    assert.ok(value && isAbsolute(value), "explicit published native fixture/assembly paths are required");
    await access(value);
  }
});

function nativeState() {
  const target = { identity: { jobId: "observation-job", attemptNo: 1, ownerInstanceId: "observation-owner", fence: 1 }, launchTicket: "observation-ticket" };
  const descriptor = controlBridgeExecutionDescriptor(target, "c".repeat(64), "d".repeat(64));
  return { descriptor, state: controlBridgeSnapshot({ phase: "running", requestFingerprint: "d".repeat(64),
    descriptor, authorizationVerified: true, resumeState: "succeeded" }) };
}

function nativeObservation() {
  const { descriptor } = nativeState();
  return {
    v: 1, background: null,
    engine: { state: "observed", process: { ...object(descriptor.details.engine), userSid: sid, sessionId: 0 } },
    gpu: { state: "observed", driverVersion: "580.97", devices: [
      { nvmlIndex: 0, name: "Controlled graphics context", uuid: null, graphics: true, compute: false },
      { nvmlIndex: 1, name: "Controlled compute context", uuid: "GPU-11111111-1111-1111-1111-111111111111", graphics: false, compute: true },
    ] },
  };
}

function nativeFrame(observation?: unknown): Buffer {
  const { descriptor, state } = nativeState();
  const originalState = { ...object(state) };
  delete originalState.runtimeObservation;
  return Buffer.from(`${JSON.stringify({ v: 1, kind: "response", requestId: "1".repeat(32), op: "inspect",
    executionId: descriptor.executionId, role: "owner", state: { ...originalState,
      ...(observation === undefined ? {} : { runtimeObservation: observation }) } })}\n`);
}

async function parseNative(bytes: Buffer) {
  const child = spawn(protocolFixture!, ["--runtime-observation-protocol", bridgeDll!], {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const failures: unknown[] = [];
  let stdoutEof = false, stderrEof = false;
  child.stdout.on("data", (data: Buffer) => stdout.push(data));
  child.stderr.on("data", (data: Buffer) => stderr.push(data));
  child.stdout.once("end", () => { stdoutEof = true; });
  child.stderr.once("end", () => { stderrEof = true; });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", (error) => failures.push(error));
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(bytes);
  const joined = await close;
  expect(joined, "a parser/loader/bootstrap error is fixture failure, not missing observation behavior").toEqual({ code: 0, signal: null });
  expect({ stdoutEof, stderrEof, failures }).toEqual({ stdoutEof: true, stderrEof: true, failures: [] });
  expect(Buffer.concat(stderr).length).toBe(0);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
  const value = object(JSON.parse(text));
  expect(value).toMatchObject({ kind: "runtime-observation-protocol", parser: "Zeb.WindowsControlBridge.BridgeProtocol.Native", depth: 6 });
  expect(value.assemblySha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  return value;
}

suite("C# runtime observation native-frame contract", () => {
  it.each(["missing", "null"] as const)("accepts old %s observations through the actual C# parser", async (mode) => {
    const parsed = await parseNative(nativeFrame(mode === "null" ? null : undefined));
    expect(parsed.accepted, "C# optional runtime observation compatibility has not been implemented").toBe(true);
    expect(object(parsed.state).runtimeObservation ?? null).toBeNull();
  }, 15_000);

  it("accepts the helper's same-engine multi-device facts with graphics-only, compute-only and UUID null", async () => {
    const observation = nativeObservation();
    const parsed = await parseNative(nativeFrame(observation));
    expect(parsed.accepted, "C# native snapshot observation behavior has not been implemented").toBe(true);
    expect(object(parsed.state).runtimeObservation).toEqual(observation);
    expect(Object.keys(observation.gpu.devices[0]!).sort()).toEqual(["compute", "graphics", "name", "nvmlIndex", "uuid"]);
  }, 15_000);

  it.each(["not-started", "pending", "unknown"] as const)("accepts independent %s state without inventing engine/background facts", async (state) => {
    const observation = { v: 1, background: null, engine: null,
      gpu: state === "unknown" ? { state, reason: "permission" } : { state } };
    const parsed = await parseNative(nativeFrame(observation));
    expect(parsed.accepted, "C# native snapshot observation behavior has not been implemented").toBe(true);
    expect(object(parsed.state).runtimeObservation).toEqual(observation);
  }, 15_000);

  const malformed: [string, (value: ReturnType<typeof nativeObservation>) => void][] = [
    ["extra field", (value) => { Reflect.set(value, "ready", true); }],
    ["nonzero engine session", (value) => { value.engine.process.sessionId = 1; }],
    ["malformed SID", (value) => { value.engine.process.userSid = "not-a-sid"; }],
    ["different original engine", (value) => { Reflect.set(value.engine.process, "pid", 12004); }],
    ["different original engine creation", (value) => { Reflect.set(value.engine.process, "creationFileTime", "9007199254740996"); }],
    ["duplicate device", (value) => { value.gpu.devices[1]!.nvmlIndex = 0; }],
    ["unsorted devices", (value) => { value.gpu.devices.reverse(); }],
    ["neither context", (value) => { value.gpu.devices[0]!.graphics = false; }],
    ["helper self-reported background", (value) => { Reflect.set(value, "background", { state: "unknown", reason: "identity" }); }],
  ];
  it.each(malformed)("rejects %s in the original raw C# native frame", async (_name, change) => {
    const value = nativeObservation();
    change(value);
    expect((await parseNative(nativeFrame(value))).accepted).toBe(false);
  }, 15_000);

  it("rejects a noncanonical new uint token without increasing the original depth budget", async () => {
    const original = nativeFrame(nativeObservation()).toString("utf8");
    const changed = original.replace('"nvmlIndex":0', '"nvmlIndex":0e0');
    expect(changed).not.toBe(original);
    expect((await parseNative(Buffer.from(changed))).accepted).toBe(false);
  }, 15_000);
});

type Metadata = {
  target: { identity: ClaimedAttempt["identity"]; launchTicket: string };
  engine: ClaimedAttempt["job"]["plan"]["engine"];
  inputPath: string; outputPath: string; workingDirectory: string;
  firstStartedAt: number; executionDeadlineAt: number;
};
type Receipt = {
  scenario: string; setupFailure: unknown; failure: unknown; values: Value;
  actors: Value[]; subjects: Value[]; engineProcesses: Value[];
  cleanup: { failures: unknown[]; originalRegistry: boolean; allObservedJoined: boolean };
};
type Final = { host: Receipt | null; outer: Value };

async function until<T>(pending: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Original observation fixture deadline exceeded")), Math.max(0, deadline - Date.now()));
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

// This is the original outer/host/guard protocol, without registering the old test matrix.
// The fallback is failure containment; it can never produce healthy observation evidence.
class ObservationOuter {
  private child!: ChildProcessWithoutNullStreams;
  private closed!: Promise<void>;
  private readonly frames: Value[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly errors: unknown[] = [];
  private pending = "";
  private stderr = "";
  private stdoutEof = false;
  private stderrEof = false;
  private joined = false;
  private cleanupDeadline: number | undefined;
  private final: Final | undefined;
  private forcedFallback = false;
  readonly executionDeadline = Date.now() + executionMs;

  launch(directory: string) {
    this.child = spawn(sessionFixture!, ["outer", ordinaryExe!, testExe!, ordinaryDll!, directory,
      String(executionMs), String(cleanupMs)], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const output = new TextDecoder("utf-8", { fatal: true });
    const error = new TextDecoder("utf-8", { fatal: true });
    const fail = (failure: unknown) => { this.errors.push(failure); this.changed(); };
    const consume = () => {
      let newline: number;
      while ((newline = this.pending.indexOf("\n")) >= 0) {
        const line = this.pending.slice(0, newline).replace(/\r$/, "");
        this.pending = this.pending.slice(newline + 1);
        const frame = object(JSON.parse(line));
        if (frame.kind === "outer-cleanup-start") {
          assert.ok(Number.isSafeInteger(frame.deadlineUnixMs));
          this.cleanupDeadline = Math.min(this.cleanupDeadline ?? Infinity,
            frame.deadlineUnixMs as number, this.executionDeadline + cleanupMs);
        } else if (frame.kind === "outer-receipt") {
          assert.equal(this.final, undefined, "one original outer receipt");
          this.final = frame.value as Final;
        }
        this.frames.push(frame);
        this.changed();
      }
    };
    this.child.stdout.on("data", (bytes: Buffer) => {
      try { this.pending += output.decode(bytes, { stream: true }); consume(); } catch (failure) { fail(failure); }
    });
    this.child.stderr.on("data", (bytes: Buffer) => {
      try { this.stderr += error.decode(bytes, { stream: true }); } catch (failure) { fail(failure); }
    });
    this.child.stdout.once("end", () => {
      this.stdoutEof = true;
      try {
        this.pending += output.decode(); consume();
        assert.equal(this.pending, "", "outer EOF must not retain a half frame");
      } catch (failure) { fail(failure); }
      this.changed();
    });
    this.child.stderr.once("end", () => {
      this.stderrEof = true;
      try { this.stderr += error.decode(); } catch (failure) { fail(failure); }
      this.changed();
    });
    this.child.once("error", fail);
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream.on("error", fail);
    this.closed = new Promise((resolve) => this.child.once("close", () => {
      this.joined = true; this.changed(); resolve();
    }));
  }
  private changed() { for (const notify of this.waiters) notify(); }
  private async match(kind: string, deadline = this.executionDeadline) {
    let notify!: () => void;
    const pending = new Promise<Value>((resolve, reject) => {
      notify = () => {
        const found = this.frames.find((frame) => frame.kind === kind);
        if (found !== undefined) resolve(found);
        else if (this.errors.length || this.joined)
          reject(new AggregateError(this.errors, `Original outer ended before ${kind}`));
      };
      this.waiters.add(notify); notify();
    });
    try { return await until(pending, deadline); } finally { this.waiters.delete(notify); }
  }
  async send(value: unknown) {
    await until(new Promise<void>((resolve, reject) => this.child.stdin.write(`${JSON.stringify(value)}\n`,
      (failure) => failure ? reject(failure) : resolve())), this.executionDeadline);
  }
  async metadata(scenario: string) {
    expect(await this.match("outer-ready")).toMatchObject({ hostMembershipVerified: true,
      guardHandleNonInherited: true, outerOutsideJob: true, firstCommandBarrier: true,
      host: { actorLaunches: 0, nonInherited: true, sameSid: true } });
    await this.send({ scenario });
    return (await this.match("outer-metadata")).value as Metadata;
  }
  async completed() {
    await this.match("outer-receipt", this.executionDeadline + cleanupMs);
    assert.ok(this.final?.host, "original host must produce its own receipt");
    return this.final;
  }
  async close() {
    const failures: unknown[] = [];
    this.cleanupDeadline ??= Math.min(Date.now() + cleanupMs, this.executionDeadline + cleanupMs);
    if (!this.joined && !this.child.stdin.destroyed) this.child.stdin.end();
    try { await until(this.closed, this.cleanupDeadline); }
    catch (failure) {
      failures.push(failure); this.forcedFallback = true;
      this.child.kill();
      try { await until(this.closed, this.cleanupDeadline); } catch (joinFailure) { failures.push(joinFailure); }
    }
    failures.push(...this.errors);
    if (this.stderr !== "") failures.push(new Error(`Original outer stderr: ${this.stderr}`));
    if (!this.joined || this.child.exitCode !== 0 || this.child.signalCode !== null ||
        !this.stdoutEof || !this.stderrEof || this.forcedFallback)
      failures.push(new Error("Original outer exit0, dual EOF and natural join were not proved"));
    console.info(`WINDOWS_RUNTIME_OBSERVATION_OUTER_CLOSE ${JSON.stringify({ code: this.child.exitCode,
      signal: this.child.signalCode, stdoutEof: this.stdoutEof, stderrEof: this.stderrEof,
      forcedFallback: this.forcedFallback, failures: failures.map(String) })}`);
    if (failures.length) throw new AggregateError(failures, "Original observation outer cleanup failed");
  }
}

function healthy(final: Final) {
  assert.ok(final.host);
  const receipt = final.host;
  expect(receipt.setupFailure, JSON.stringify(final)).toBeNull();
  expect(receipt.failure, JSON.stringify(final)).toBeNull();
  expect(receipt.cleanup).toEqual({ failures: [], originalRegistry: true, allObservedJoined: true });
  expect(final.outer).toMatchObject({ primaryFailure: null, forcedFallback: false, firstCommandBarrier: true });
  const guard = object(final.outer.guard);
  expect(guard).toMatchObject({ activeProcesses: 0, membershipVerified: true, nonInherited: true,
    outerOutsideJob: true, soleJobHandle: true, killOnClose: true, allObservedJoined: true, failures: [] });
  assert.ok(Array.isArray(guard.processes));
  expect(guard.totalProcesses).toBe(guard.registeredOriginalProcesses);
  expect(guard.registeredOriginalProcesses).toBe(guard.processes.length);
  for (const child of [object(final.outer.host), ...receipt.actors, ...receipt.subjects]) {
    expect(child).toMatchObject({ started: true, originalRetained: true, originalJoined: true,
      stdoutEof: true, stderrEof: true, stdoutError: null, stderrError: null, exitCode: 0,
      sameSid: true, nonInherited: true, forced: false });
  }
  for (const engine of receipt.engineProcesses) expect(engine).toMatchObject({ originalRetained: true,
    originalJoined: true, alive: false, sameSid: true, nonInherited: true });
  return receipt;
}

function prepareObservation(meta: Metadata, variant: string) {
  const base = claimedAttempt();
  const payloadMs = variant === "deadline" ? 15_000 : executionMs;
  const attempt: ClaimedAttempt = { ...base, identity: meta.target.identity, launchTicket: meta.target.launchTicket,
    executionPolicy: freezeExecutionPolicy({ ...runnerLimits, executionTimeoutMs: payloadMs, cancelGraceMs: 10_000 }, [0, 32, 64]),
    firstStartedAt: meta.firstStartedAt, executionDeadlineAt: meta.firstStartedAt + payloadMs,
    leaseExpiresAt: meta.firstStartedAt + runnerLimits.leaseDurationMs,
    inputPath: meta.inputPath, workingDirectory: meta.workingDirectory, outputPath: meta.outputPath, tile: meta.engine.tile,
    job: { ...base.job, jobId: meta.target.identity.jobId, plan: { ...base.job.plan, engine: meta.engine } } };
  // The deadline case shortens the existing payload deadline, not an observation-specific timer.
  return freezeWindowsPrepareRequest(attempt, variant === "unmarked" ? undefined : "boot-v1");
}

async function runObservation(variant: string) {
  const scenario = `runtime-observation-${variant}`;
  const directory = await mkdtemp(join(tmpdir(), "zeb-runtime-observation-"));
  const outer = new ObservationOuter();
  let result: Final | undefined, primary: unknown, cleanupFailure: unknown;
  try {
    outer.launch(directory);
    const meta = await outer.metadata(scenario);
    await outer.send(prepareObservation(meta, variant));
    result = await outer.completed();
  } catch (failure) { primary = failure; }
  try { await outer.close(); } catch (failure) { cleanupFailure = failure; }
  console.info(`WINDOWS_RUNTIME_OBSERVATION_DIRECTORY ${JSON.stringify({ scenario, directory, retained: true })}`);
  if (primary !== undefined && cleanupFailure !== undefined)
    throw new AggregateError([primary, cleanupFailure], "Behavior and original cleanup failed", { cause: primary });
  if (primary !== undefined) throw primary;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  assert.ok(result);
  const receipt = healthy(result);
  const trace = object(receipt.values.runtimeObservation);
  // This assertion runs only after the original host/guard, natural close and both EOFs are healthy.
  expect(trace.available, "native runtime observation behavior has not been implemented; baseline capability is absent").toBe(true);
  console.info(`WINDOWS_RUNTIME_OBSERVATION_RECEIPT ${JSON.stringify(result)}`);
  return { trace, receipt };
}

function helperObservation(state: unknown) {
  const value = object(object(state).runtimeObservation);
  expect(Object.keys(value).sort()).toEqual(["background", "engine", "gpu", "v"]);
  expect(value.v).toBe(1);
  expect(value.background, "an interactive helper cannot self-report SCM/Node facts").toBeNull();
  return value;
}
function engineObservation(observation: Value, trace: Value) {
  const actual = object(trace.originalEngine);
  const original = object(object(object(trace.descriptor).details).engine);
  expect({ pid: actual.pid, creationFileTime: actual.creationFileTime }).toEqual(original);
  expect(actual.userSid).toEqual(expect.stringMatching(/^S-1-(?:\d+-)*\d+$/));
  assert.ok(Number.isSafeInteger(actual.sessionId) && (actual.sessionId as number) >= 0);
  if (actual.sessionId === 0) expect(observation.engine).toEqual({ state: "observed", process: actual });
  else expect(observation.engine).toEqual({ state: "unknown", reason: "identity" });
}
function diagnostics(frame: unknown) {
  const value = object(object(object(frame).observation).runtimeObservationTest);
  expect(Object.keys(value).sort()).toEqual(["computeCountCalls", "computeFillCalls", "graphicsCountCalls", "graphicsFillCalls",
    "initCalls", "nativeCallsInFlight", "processInfoSize", "resourcesAcquired", "resourcesFreed", "shutdownCalls", "unavailableMemorySeen"].sort());
  for (const [key, counter] of Object.entries(value)) if (key !== "unavailableMemorySeen") {
    assert.ok(Number.isSafeInteger(counter) && (counter as number) >= 0, key);
  }
  expect(typeof value.unavailableMemorySeen).toBe("boolean");
  expect(value.processInfoSize).toBe(24);
  return value;
}

suite("native runtime observation along the original Windows session", () => {
  it.each(["unmarked", "noise"])("does not sample %s original stderr", async (variant) => {
    const { trace } = await runObservation(variant);
    expect(trace.barrierReached).toBe(false);
    const before = object(trace.beforeProgress);
    if (variant === "unmarked") {
      expect(before.runtimeObservation ?? null).toBeNull();
      for (const state of trace.states as unknown[]) expect(object(state).runtimeObservation ?? null).toBeNull();
    } else {
      expect(helperObservation(before)).toEqual({ v: 1, background: null, engine: null, gpu: { state: "not-started" } });
      for (const state of trace.states as unknown[]) {
        const value = object(state).runtimeObservation;
        if (value !== null && value !== undefined) expect(helperObservation(state)).toEqual({
          v: 1, background: null, engine: null, gpu: { state: "not-started" } });
      }
    }
  }, testMs);

  it.each(["fragments", "compute", "multi", "permission", "no-match", "incomplete", "engine-exit", "deadline"])(
    "samples %s once, drains both streams and joins the original native return", async (variant) => {
      const { trace } = await runObservation(variant);
      expect(trace.barrierReached).toBe(true);
      expect(helperObservation(trace.beforeProgress)).toEqual({ v: 1, background: null, engine: null, gpu: { state: "not-started" } });
      expect(helperObservation(trace.afterHalf)).toEqual({ v: 1, background: null, engine: null, gpu: { state: "not-started" } });
      const during = helperObservation(trace.duringNative);
      engineObservation(during, trace);
      expect(during.gpu).toEqual({ state: "pending" });
      const held = diagnostics(trace.nativeHeld), settled = diagnostics(trace.settled);
      expect(held).toMatchObject({ initCalls: 1, shutdownCalls: 0, nativeCallsInFlight: 1 });
      expect(settled).toMatchObject({ initCalls: 1, shutdownCalls: 1, nativeCallsInFlight: 0 });
      expect(settled.resourcesFreed).toBe(settled.resourcesAcquired);
      expect(held.resourcesFreed as number).toBeLessThanOrEqual(held.resourcesAcquired as number);
      expect(trace.testPipeEof, "the settled diagnostic cannot replace actual original pipe EOF").toBe(true);
      const drains = object(trace.drainsDuringNative);
      expect(drains).toMatchObject({ stdoutWriteCompleted: true, stderrWriteCompleted: true,
        concurrentWrites: true, capacitiesQueriedFromActualHandles: true });
      expect(drains.stdoutBytes as number).toBeGreaterThan(drains.stdoutCapacity as number);
      expect(drains.stderrBytes as number).toBeGreaterThan(drains.stderrCapacity as number);
      assert.ok(Array.isArray(trace.states) && trace.states.length > 0);
      const lastState = object(trace.states.at(-1));
      expect(lastState.phase).toBe("terminal");
      const final = helperObservation(lastState), gpu = object(final.gpu);
      const late = variant === "engine-exit" || variant === "deadline";
      if (late) {
        expect(trace.heldAfterEngineExit).toEqual({ engineJoined: true, helperAlive: true, activeProcesses: 0,
          terminalPresent: false, settledReceived: false });
        const beforeRelease = object(trace.beforeRelease);
        expect(beforeRelease.phase).not.toBe("terminal");
        expect(helperObservation(beforeRelease).gpu).toEqual({ state: "unknown", reason: variant === "deadline" ? "deadline" : "identity" });
        expect(gpu).toEqual({ state: "unknown", reason: variant === "deadline" ? "deadline" : "identity" });
        for (const state of trace.states) {
          const value = object(state).runtimeObservation;
          if (value !== null && value !== undefined) expect(object(helperObservation(state).gpu).state).not.toBe("observed");
        }
      } else if (["permission", "no-match", "incomplete"].includes(variant)) {
        expect(gpu).toEqual({ state: "unknown", reason: variant });
        expect(helperObservation(trace.afterResult).gpu).toEqual(gpu);
        if (variant === "permission") {
          expect(settled.graphicsCountCalls).toBe(1);
          expect(settled.graphicsFillCalls).toBe(0);
        } else {
          expect(settled.graphicsCountCalls).toBe(1);
          expect(settled.graphicsFillCalls).toBe(1);
        }
      } else {
        engineObservation(final, trace);
        expect(helperObservation(trace.afterResult).gpu).toEqual(gpu);
        expect(gpu).toMatchObject({ state: "observed", driverVersion: "580.97" });
        assert.ok(Array.isArray(gpu.devices));
        const expected = variant === "multi" ? [
          { nvmlIndex: 0, name: "Controlled graphics context", uuid: null, graphics: true, compute: false },
          { nvmlIndex: 2, name: "Controlled compute context", uuid: "GPU-22222222-2222-2222-2222-222222222222", graphics: false, compute: true },
        ] : [{ nvmlIndex: 0, name: variant === "compute" ? "Controlled compute context" : "Controlled graphics context",
          uuid: null, graphics: variant !== "compute", compute: variant === "compute" }];
        expect(gpu.devices).toEqual(expected);
        for (const device of gpu.devices) expect(Object.keys(object(device)).sort()).toEqual(["compute", "graphics", "name", "nvmlIndex", "uuid"]);
        expect(settled.unavailableMemorySeen, "the controlled raw N/A memory value must not erase a matching PID").toBe(true);
        for (const key of ["graphicsCountCalls", "graphicsFillCalls", "computeCountCalls", "computeFillCalls"])
          expect(settled[key], "duplicate progress cannot start another count/fill sweep").toBe(variant === "multi" ? 3 : 1);
      }
    }, testMs);
});
