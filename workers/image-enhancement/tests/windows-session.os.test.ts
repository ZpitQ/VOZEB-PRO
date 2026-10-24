import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  freezeDurableInterruptionRecords,
  freezeExecutionPolicy,
  type ClaimedAttempt,
  type DurableInterruptionRecords,
  type InterruptionReadScope,
  type OwnerDescriptor,
} from "../src/execution.js";
import { interpretWindowsJournalSnapshot } from "../src/windows-journal-reader.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import { runnerLimits } from "./storage-fixtures.js";
import {
  carrier,
  claimedAttempt,
  independentSpec,
  type RequestCarrier,
} from "./windows-prepare-payload-fixtures.js";

type Value = Record<string, unknown>;
type NativeCompletion =
  | { kind: "engine-exit" }
  | { kind: "stop" }
  | { kind: "deadline" }
  | { kind: "launch-failure"; stage: "prepared-state" | "resume" }
  | {
      kind: "unauthorized-cleanup";
      cause: "controller_eof" | "controller_exit" | "control_write_failure";
    };
type PrivateTerminalExpectation = {
  completion: NativeCompletion;
  resumeState: "not-attempted" | "succeeded" | "uncertain";
  prepared: boolean;
  authorization: boolean;
  prepareCalled: boolean;
  originalTree?: { engine: unknown; jobName: unknown };
};
type Metadata = {
  target: { identity: ClaimedAttempt["identity"]; launchTicket: string };
  engine: ClaimedAttempt["job"]["plan"]["engine"];
  inputPath: string;
  outputPath: string;
  workingDirectory: string;
  firstStartedAt: number;
  executionDeadlineAt: number;
};
type Receipt = {
  scenario: string;
  setupFailure: unknown;
  failure: unknown;
  values: Value;
  actors: Value[];
  subjects: Value[];
  engineProcesses: Value[];
  cleanup: {
    failures: unknown[];
    originalRegistry: boolean;
    allObservedJoined: boolean;
  };
};
type Final = {
  host: Receipt | null;
  outer: {
    primaryFailure: unknown;
    forcedFallback: boolean;
    firstCommandBarrier: boolean;
    host: Value;
    guard: {
      activeProcesses: number | null;
      totalProcesses: number;
      registeredOriginalProcesses: number;
      membershipVerified: boolean;
      nonInherited: boolean;
      outerOutsideJob: boolean;
      soleJobHandle: boolean;
      killOnClose: boolean;
      allObservedJoined: boolean;
      failures: unknown[];
      processes: Value[];
    };
  };
};

const exe = process.env.ZEB_WINDOWS_SESSION_FIXTURE_EXE;
const ordinaryExe = process.env.ZEB_WINDOWS_SESSION_ORDINARY_EXE;
const testExe = process.env.ZEB_WINDOWS_SESSION_TEST_EXE;
const ordinaryDll = process.env.ZEB_WINDOWS_SESSION_ORDINARY_DLL;
const mode = process.env.ZEB_WINDOWS_SESSION_MODE ?? "full";
const requested =
  process.env.ZEB_RUN_WINDOWS_SESSION_OS === "1" || exe !== undefined;
const suite =
  requested && mode !== "reader" && mode !== "reader-red"
    ? describe
    : describe.skip;
const readerSuite =
  requested && ["full", "reader", "reader-red"].includes(mode)
    ? describe
    : describe.skip;
const executionMs = runnerLimits.executionTimeoutMs;
const cleanupMs = runnerLimits.cancelGraceMs;
const testMs = executionMs + cleanupMs;
const slots = {
  request: "00000000000000000000000000000001",
  prepared: "00000000000000000000000000000002",
  auth: "00000000000000000000000000000003",
  reserved: "00000000000000000000000000000004",
  loss: "00000000000000000000000000000005",
  terminal: "00000000000000000000000000000006",
} as const;

function object(value: unknown): Value {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Value;
}
function values(value: unknown): Value[] {
  expect(Array.isArray(value)).toBe(true);
  return (value as unknown[]).map(object);
}
function exact(value: unknown, names: readonly string[]) {
  const found = object(value);
  expect(Object.keys(found).sort()).toEqual([...names].sort());
  return found;
}
async function until<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Session fixture absolute deadline exceeded")),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// One original close promise, two actual fatal UTF-8 drains, one absolute
// cleanup budget. An unproved descendant cleanup always retains its directory.
class SessionFixture {
  private child!: ChildProcessWithoutNullStreams;
  private closed!: Promise<void>;
  private readonly frames: Value[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly errors: unknown[] = [];
  private stderr = "";
  private pending = "";
  private stdoutEof = false;
  private stderrEof = false;
  private originalJoined = false;
  private final: Final | undefined;
  private cleanupDeadline: number | undefined;
  private closing: Promise<void> | undefined;
  private forcedFallback = false;
  readonly executionDeadline = Date.now() + executionMs;

  launch(directory: string) {
    this.child = spawn(
      exe!,
      [
        "outer",
        ordinaryExe!,
        testExe ?? ordinaryExe!,
        ordinaryDll!,
        directory,
        String(executionMs),
        String(cleanupMs),
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout = new TextDecoder("utf-8", { fatal: true });
    const stderr = new TextDecoder("utf-8", { fatal: true });
    const fail = (error: unknown) => {
      this.errors.push(error);
      this.changed();
    };
    const consume = () => {
      let index: number;
      while ((index = this.pending.indexOf("\n")) >= 0) {
        const line = this.pending.slice(0, index).replace(/\r$/, "");
        this.pending = this.pending.slice(index + 1);
        const frame = object(JSON.parse(line));
        if (frame.kind === "outer-cleanup-start") {
          expect(Number.isSafeInteger(frame.deadlineUnixMs)).toBe(true);
          this.cleanupDeadline = Math.min(
            this.cleanupDeadline ?? Infinity,
            frame.deadlineUnixMs as number,
            this.executionDeadline + cleanupMs,
          );
        } else if (frame.kind === "outer-receipt") {
          if (this.final !== undefined)
            throw new Error("Repeated final receipt");
          this.final = frame.value as Final;
        }
        this.frames.push(frame);
        this.changed();
      }
    };
    this.child.stdout.on("data", (bytes: Buffer) => {
      try {
        this.pending += stdout.decode(bytes, { stream: true });
        consume();
      } catch (error) {
        fail(error);
      }
    });
    this.child.stderr.on("data", (bytes: Buffer) => {
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
        if (this.pending !== "")
          throw new Error("Outer emitted an EOF half-frame");
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
    this.closed = new Promise((resolve) =>
      this.child.once("close", () => {
        this.originalJoined = true;
        this.changed();
        resolve();
      }),
    );
  }
  private changed() {
    for (const notify of this.waiters) notify();
  }
  private match(
    kind: string,
    deadline = this.executionDeadline,
  ): Promise<Value> {
    const pending = new Promise<Value>((resolve, reject) => {
      const notify = () => {
        const frame = this.frames.find((item) => item.kind === kind);
        if (frame) {
          this.waiters.delete(notify);
          resolve(frame);
        } else if (this.errors.length > 0 || this.originalJoined) {
          this.waiters.delete(notify);
          reject(
            new AggregateError(
              this.errors,
              `Original outer ended before ${kind}`,
            ),
          );
        }
      };
      this.waiters.add(notify);
      notify();
    });
    return until(pending, deadline);
  }
  async send(value: unknown) {
    await until(
      new Promise<void>((resolve, reject) =>
        this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
      this.executionDeadline,
    );
  }
  async loaded() {
    expect(await this.match("outer-ready")).toMatchObject({
      hostMembershipVerified: true,
      guardHandleNonInherited: true,
      outerOutsideJob: true,
      firstCommandBarrier: true,
      host: { actorLaunches: 0, nonInherited: true, sameSid: true },
    });
  }
  async metadata(scenario: string) {
    await this.send({ scenario });
    return (await this.match("outer-metadata")).value as Metadata;
  }
  async completed() {
    await this.match("outer-receipt", this.executionDeadline + cleanupMs);
    console.info(`WINDOWS_SESSION_RECEIPT ${JSON.stringify(this.final)}`);
    if (this.final?.host === null || this.final?.host === undefined)
      throw new Error("Original host produced no receipt");
    return this.final.host;
  }
  get evidence() {
    return this.final;
  }
  get cleanupProven() {
    const final = this.final;
    return (
      this.originalJoined &&
      this.stdoutEof &&
      this.stderrEof &&
      this.errors.length === 0 &&
      final !== undefined &&
      final.host !== null &&
      final.host.cleanup.failures.length === 0 &&
      final.host.cleanup.originalRegistry &&
      final.host.cleanup.allObservedJoined &&
      final.outer.guard.failures.length === 0 &&
      final.outer.guard.activeProcesses === 0 &&
      final.outer.guard.allObservedJoined &&
      final.outer.guard.membershipVerified &&
      final.outer.guard.nonInherited &&
      final.outer.guard.outerOutsideJob &&
      final.outer.guard.soleJobHandle &&
      final.outer.guard.killOnClose
    );
  }
  close() {
    return (this.closing ??= this.closeOriginal());
  }
  private async closeOriginal() {
    const failures: unknown[] = [];
    this.cleanupDeadline ??= Math.min(
      Date.now() + cleanupMs,
      this.executionDeadline + cleanupMs,
    );
    if (!this.originalJoined && !this.child.stdin.destroyed)
      this.child.stdin.end();
    try {
      await until(this.closed, this.cleanupDeadline);
    } catch (error) {
      failures.push(error);
      this.forcedFallback = true;
      this.child.kill();
      try {
        await until(this.closed, this.cleanupDeadline);
      } catch (joinError) {
        failures.push(joinError);
      }
    }
    failures.push(...this.errors);
    if (this.stderr !== "")
      failures.push(new Error(`Outer stderr: ${this.stderr}`));
    if (this.child.exitCode !== 0 || this.child.signalCode !== null)
      failures.push(new Error("Outer original close was not exit0"));
    if (!this.cleanupProven)
      failures.push(new Error("Original descendant cleanup was not proved"));
    if (this.forcedFallback)
      failures.push(
        new Error("Outer forced fallback invalidates healthy fixture evidence"),
      );
    console.info(
      `WINDOWS_SESSION_OUTER_CLOSE ${JSON.stringify({ originalClose: { code: this.child.exitCode, signal: this.child.signalCode }, stdoutEof: this.stdoutEof, stderrEof: this.stderrEof, forcedFallback: this.forcedFallback, errors: failures.map((error) => (error instanceof Error ? error.message : String(error))) })}`,
    );
    if (failures.length)
      throw new AggregateError(failures, "Original outer cleanup failed");
  }
}

function prepareCarrier(meta: Metadata, raw: boolean, scenario: string) {
  const base = claimedAttempt();
  const attempt: ClaimedAttempt = {
    ...base,
    identity: meta.target.identity,
    launchTicket: meta.target.launchTicket,
    executionPolicy: freezeExecutionPolicy(
      scenario === "long-deadline-grace"
        ? {
            ...runnerLimits,
            executionTimeoutMs: 4_294_967_294 + executionMs,
            cancelGraceMs: 4_294_967_295,
          }
        : runnerLimits,
      [0, 32, 64],
    ),
    firstStartedAt: meta.firstStartedAt,
    executionDeadlineAt: meta.executionDeadlineAt,
    leaseExpiresAt: meta.firstStartedAt + runnerLimits.leaseDurationMs,
    inputPath: meta.inputPath,
    workingDirectory: meta.workingDirectory,
    outputPath: meta.outputPath,
    tile: meta.engine.tile,
    job: {
      ...base.job,
      jobId: meta.target.identity.jobId,
      plan: { ...base.job.plan, engine: meta.engine },
    },
  };
  const expected = independentSpec(attempt);
  const fromTs = freezeWindowsPrepareRequest(attempt);
  expect(fromTs).toEqual(carrier(JSON.stringify(expected)));
  if (!raw) return { request: fromTs, expected };
  const { v, ...remaining } = expected;
  const text = JSON.stringify({ ...remaining, v }, null, 2).replace(
    '"v":',
    '"\\u0076":',
  );
  return { request: carrier(text), expected };
}

async function run(
  scenario: string,
  check: (
    receipt: Receipt,
    request: RequestCarrier,
    meta: Metadata,
    expected: ReturnType<typeof independentSpec>,
  ) => void,
  raw = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "zeb-session-"));
  const fixture = new SessionFixture();
  let primary: unknown;
  let cleanupFailure: unknown;
  try {
    fixture.launch(directory);
    await fixture.loaded();
    const meta = await fixture.metadata(scenario);
    const { request, expected } = prepareCarrier(meta, raw, scenario);
    await fixture.send(request);
    const receipt = await fixture.completed();
    healthyFixture(receipt, fixture.evidence!);
    check(receipt, request, meta, expected);
  } catch (error) {
    primary = error;
  }
  try {
    const closing = fixture.close();
    expect(fixture.close()).toBe(closing);
    await closing;
  } catch (error) {
    cleanupFailure = error;
  }
  const preserveDiagnosticEvidence = scenario.startsWith("prepare-diagnostic-");
  if (preserveDiagnosticEvidence) {
    await writeFile(join(directory, "prepare-diagnostic-evidence.json"),
      JSON.stringify(fixture.evidence), { encoding: "utf8", flag: "wx" });
  }
  const removed = fixture.cleanupProven && !preserveDiagnosticEvidence;
  if (removed) await rm(directory, { recursive: true });
  console.info(
    `WINDOWS_SESSION_DIRECTORY ${JSON.stringify({ scenario, directory, removed, cleanupProven: fixture.cleanupProven })}`,
  );
  if (primary !== undefined && cleanupFailure !== undefined)
    throw new AggregateError(
      [primary, cleanupFailure],
      "Behavior and cleanup both failed",
      { cause: primary },
    );
  if (primary !== undefined) throw primary;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

function uint32(value: unknown) {
  expect(Number.isSafeInteger(value)).toBe(true);
  expect(Object.is(value, -0)).toBe(false);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(4_294_967_295);
}
function identifier(value: unknown) {
  expect(typeof value).toBe("string");
  const text = value as string;
  expect(text.length).toBeGreaterThan(0);
  expect(text.trim()).toBe(text);
  expect(/[\u0000-\u001f\u007f]/u.test(text)).toBe(false);
  expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
}
function processFact(value: unknown) {
  const fact = exact(value, ["pid", "creationFileTime"]);
  uint32(fact.pid);
  expect(fact.pid).toBeGreaterThan(0);
  expect(fact.creationFileTime).toEqual(expect.stringMatching(/^[1-9]\d*$/));
  expect(BigInt(fact.creationFileTime as string)).toBeLessThanOrEqual(
    18_446_744_073_709_551_615n,
  );
  return fact;
}
function originalEngine(receipt: Receipt, value: unknown) {
  const fact = processFact(value);
  const found = receipt.engineProcesses.filter((process) => {
    const identity = processFact(process.identity);
    return (
      identity.pid === fact.pid &&
      identity.creationFileTime === fact.creationFileTime
    );
  });
  expect(found).toHaveLength(1);
  const engine = object(found[0]);
  expect(engine.identity).toEqual(fact);
  return engine;
}
function life(value: Value, expectedCode?: number) {
  expect(value).toMatchObject({
    started: true,
    originalRetained: true,
    originalJoined: true,
    stdoutEof: true,
    stderrEof: true,
    stdoutError: null,
    stderrError: null,
    sameSid: true,
    nonInherited: true,
  });
  expect(value.exitCode).toEqual(expect.any(Number));
  if (expectedCode !== undefined) expect(value.exitCode).toBe(expectedCode);
  processFact(value.identity);
}
function healthyFixture(receipt: Receipt, final: Final) {
  expect(receipt.setupFailure, JSON.stringify(final)).toBeNull();
  expect(receipt.failure, JSON.stringify(final)).toBeNull();
  expect(receipt.cleanup).toEqual({
    failures: [],
    originalRegistry: true,
    allObservedJoined: true,
  });
  expect(final.outer.primaryFailure, JSON.stringify(final)).toBeNull();
  expect(final.outer.forcedFallback).toBe(false);
  expect(final.outer.firstCommandBarrier).toBe(true);
  expect(final.outer.guard).toMatchObject({
    activeProcesses: 0,
    membershipVerified: true,
    nonInherited: true,
    outerOutsideJob: true,
    soleJobHandle: true,
    killOnClose: true,
    allObservedJoined: true,
    failures: [],
  });
  expect(final.outer.guard.totalProcesses).toBe(
    final.outer.guard.registeredOriginalProcesses,
  );
  expect(final.outer.guard.registeredOriginalProcesses).toBe(
    final.outer.guard.processes.length,
  );
  life(final.outer.host, 0);
  const readerHelper =
    receipt.values.reader === undefined
      ? undefined
      : object(object(receipt.values.reader).helper);
  for (const actor of receipt.actors) {
    const readerIdentity = readerHelper && processFact(readerHelper.identity);
    const actorIdentity = processFact(actor.identity);
    const isReader =
      readerIdentity !== undefined &&
      readerIdentity.pid === actorIdentity.pid &&
      readerIdentity.creationFileTime === actorIdentity.creationFileTime;
    life(actor, isReader ? undefined : 0);
  }
  for (const subject of receipt.subjects) life(subject);
  for (const process of receipt.engineProcesses)
    expect(process).toMatchObject({
      originalRetained: true,
      originalJoined: true,
      alive: false,
      sameSid: true,
      nonInherited: true,
    });
}
function state(value: unknown) {
  return exact(value, [
    "phase",
    "sealReason",
    "requestFingerprint",
    "descriptor",
    "authorizationVerified",
    "resumeState",
    "evidenceOutcome",
    "completion",
  ]);
}
function response(value: unknown, op: string) {
  const frame = exact(value, [
    "v",
    "kind",
    "requestId",
    "op",
    "executionId",
    "role",
    "state",
  ]);
  expect(frame).toMatchObject({ v: 1, kind: "response", op });
  state(frame.state);
  return frame;
}
function error(value: unknown, code: string) {
  expect(exact(value, ["v", "kind", "requestId", "code"])).toMatchObject({
    v: 1,
    kind: "error",
    code,
  });
}
function records(
  receipt: Receipt,
  request: RequestCarrier,
  expected: ReturnType<typeof independentSpec>,
) {
  const readback = object(receipt.values.readback);
  expect(readback.writerClosed).toBe(true);
  expect(readback.before).toEqual(readback.after);
  const strict = object(readback.strict);
  const rawEnvelopes = new Map<string | null, Value>();
  let reservationIdentity: unknown;
  for (const entry of values(readback.before)) {
    if (entry.present !== true) continue;
    const file = object(entry.file);
    const bytes = Buffer.from(file.bytesBase64 as string, "base64");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    expect(String(bytes.length)).toBe(file.length);
    if ((entry.leaf as string).endsWith(".reserved")) {
      expect(bytes.length).toBe(0);
      reservationIdentity = file.identity;
      continue;
    }
    const raw = exact(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      [
        "v",
        "kind",
        "scope",
        "executionId",
        "recordId",
        "rootIdentity",
        "reservationIdentity",
        "fileIdentity",
        "record",
      ],
    );
    expect(raw.fileIdentity).toEqual(file.identity);
    expect(raw.rootIdentity).toEqual(object(readback.root).identity);
    rawEnvelopes.set(raw.recordId as string | null, raw);
  }
  const reservation = object(strict.reservation);
  expect(reservation).toMatchObject({
    status: "Existing",
    ownerPresent: false,
    diagnostic: null,
  });
  const original = object(reservation.snapshot);
  expect(original).toEqual(rawEnvelopes.get(null));
  expect(original.reservationIdentity).toEqual(reservationIdentity);
  const executionId = original.executionId;
  expect(executionId).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
  const subjects = receipt.subjects.filter(
    (subject) => object(subject.ready).executionId === executionId,
  );
  expect(subjects).toHaveLength(1);
  const subject = object(subjects[0]);
  const scope = {
    target: expected.target,
    executionPolicyFingerprint: expected.executionPolicy.fingerprint,
  };
  expect(original.scope).toEqual(scope);
  const found = object(strict.records);
  const result: Record<string, Value> = {};
  for (const [slot, read] of Object.entries(found)) {
    const value = object(read);
    if (value.status === "Unknown") continue;
    expect(value).toMatchObject({
      status: "Existing",
      ownerPresent: false,
      diagnostic: null,
    });
    const envelope = exact(value.snapshot, [
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
    expect(envelope).toEqual(rawEnvelopes.get(slot));
    expect(envelope.scope).toEqual(scope);
    expect(envelope).toMatchObject({
      v: 1,
      kind: "record",
      scope,
      executionId,
      recordId: slot,
      rootIdentity: original.rootIdentity,
      reservationIdentity: original.reservationIdentity,
    });
    result[slot] = object(envelope.record);
    expect(result[slot].recordId).toBe(slot);
  }
  expect(result[slots.reserved]).toBeUndefined();
  const record = exact(result[slots.request], [
    "v",
    "kind",
    "recordId",
    "requestFingerprint",
    "requestUtf8Base64",
    "resolvedLaunch",
  ]);
  expect(record).toMatchObject({ v: 1, kind: "windows-request", ...request });
  const launch = exact(record.resolvedLaunch, [
    "recipeId",
    "installationManifestSha256",
    "executablePath",
    "argv",
  ]);
  expect(launch.recipeId).toBe("upscayl-4x-png-v1");
  expect(launch.argv).toEqual(receipt.values.expectedArgv);
  expect(launch.installationManifestSha256).toBe(receipt.values.manifestSha256);
  let preparedScope: Value | undefined;
  let descriptor: Value | undefined;
  if (result[slots.prepared]) {
    const prepared = exact(result[slots.prepared], [
      "v",
      "kind",
      "recordId",
      "requestRecordId",
      "requestFingerprint",
      "scope",
    ]);
    expect(prepared).toMatchObject({
      v: 1,
      kind: "windows-prepared",
      requestRecordId: slots.request,
      requestFingerprint: request.requestFingerprint,
    });
    preparedScope = exact(prepared.scope, ["target", "descriptor"]);
    expect(preparedScope.target).toEqual(expected.target);
    descriptor = exact(preparedScope.descriptor, [
      "adapterId",
      "launchTicket",
      "executionId",
      "details",
    ]);
    expect(descriptor).toMatchObject({
      adapterId: "windows-supervisor-v1",
      launchTicket: expected.target.launchTicket,
      executionId,
    });
    const details = exact(descriptor.details, [
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
    expect(details).toMatchObject({
      v: 1,
      target: expected.target,
      executionPolicyFingerprint: expected.executionPolicy.fingerprint,
      requestFingerprint: request.requestFingerprint,
      requestRecordId: slots.request,
      preparedRecordId: slots.prepared,
      recipeId: "upscayl-4x-png-v1",
      installationManifestSha256: receipt.values.manifestSha256,
    });
    expect(details.target).toEqual(expected.target);
    processFact(details.supervisor);
    processFact(details.engine);
    identifier(details.jobName);
    expect(details.supervisor).toEqual(subject.identity);
    originalEngine(receipt, details.engine);
    const prepare = response(receipt.values.prepare, "prepare");
    expect(prepare.executionId).toBe(executionId);
    expect(object(prepare.state).descriptor).toEqual(descriptor);
    expect(prepare.state).toMatchObject({
      phase: "prepared",
      requestFingerprint: request.requestFingerprint,
      authorizationVerified: false,
      resumeState: "not-attempted",
    });
  }
  if (result[slots.auth]) {
    expect(preparedScope).toBeDefined();
    expect(
      exact(result[slots.auth], ["v", "recordId", "scope", "kind"]),
    ).toEqual({
      v: 1,
      recordId: slots.auth,
      scope: preparedScope,
      kind: "authorized",
    });
  }
  return { found: result, scope, preparedScope, descriptor };
}
function terminal(
  receipt: Receipt,
  request: RequestCarrier,
  expected: ReturnType<typeof independentSpec>,
  expectation: PrivateTerminalExpectation,
) {
  const { found, scope, descriptor } = records(receipt, request, expected);
  const { completion, resumeState, prepared, authorization, prepareCalled } =
    expectation;
  const end = exact(found[slots.terminal], [
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
  expect(end).toMatchObject({
    v: 1,
    kind: "windows-terminal",
    scope,
    requestRecordId: slots.request,
    requestFingerprint: request.requestFingerprint,
    resumeState,
    authorizationsSealed: true,
  });
  expect(end.scope).toEqual(scope);
  expect(end.completion).toEqual(completion);
  expect(found[slots.prepared] !== undefined).toBe(prepared);
  expect(found[slots.auth] !== undefined).toBe(authorization);
  if (prepared) {
    expect(prepareCalled).toBe(true);
    expect(end.preparedRecordId).toBe(slots.prepared);
    expect(end.descriptor).toEqual(object(descriptor));
  } else {
    expect(end.preparedRecordId).toBeNull();
    expect(end.descriptor).toBeNull();
  }
  if (authorization) {
    expect(prepared).toBe(true);
    expect(end.authorizationRecordId).toBe(slots.auth);
  } else {
    expect(end.authorizationRecordId).toBeNull();
    expect(resumeState).toBe("not-attempted");
  }
  if (resumeState === "succeeded") expect(authorization).toBe(true);
  if (resumeState === "uncertain") {
    expect(authorization).toBe(true);
    expect(completion).toEqual({ kind: "launch-failure", stage: "resume" });
  }
  switch (completion.kind) {
    case "engine-exit":
      expect(prepared).toBe(true);
      expect(authorization).toBe(true);
      expect(resumeState).toBe("succeeded");
      break;
    case "launch-failure":
      expect(prepareCalled).toBe(true);
      expect(prepared).toBe(completion.stage === "resume");
      expect(authorization).toBe(completion.stage === "resume");
      expect(resumeState).toBe(
        completion.stage === "resume" ? "uncertain" : "not-attempted",
      );
      break;
    case "unauthorized-cleanup":
      expect(authorization).toBe(false);
      break;
  }
  if (prepareCalled) {
    const proof = exact(end.proof, [
      "kind",
      "engine",
      "jobName",
      "exitCode",
      "treeExited",
      "activeProcesses",
      "stdoutEof",
      "stderrEof",
    ]);
    expect(proof).toMatchObject({
      kind: "engine-tree",
      treeExited: true,
      activeProcesses: 0,
      stdoutEof: true,
      stderrEof: true,
    });
    identifier(proof.jobName);
    uint32(proof.exitCode);
    let engine: Value;
    if (prepared) {
      const details = object(object(descriptor).details);
      expect(proof.engine).toEqual(details.engine);
      expect(proof.jobName).toBe(details.jobName);
      engine = originalEngine(receipt, details.engine);
    } else {
      // A returned tree can exist before prepared publication begins.
      // Its facts must come from the fixture's original tree observation.
      const tree = object(expectation.originalTree);
      const identity = processFact(tree.engine);
      identifier(tree.jobName);
      expect(proof.engine).toEqual(identity);
      expect(proof.jobName).toBe(tree.jobName);
      expect(receipt.engineProcesses).toHaveLength(1);
      engine = originalEngine(receipt, identity);
    }
    expect(Number.isInteger(engine.exitCode)).toBe(true);
    expect(engine.exitCode).toBeGreaterThanOrEqual(-2_147_483_648);
    expect(engine.exitCode).toBeLessThanOrEqual(2_147_483_647);
    expect(proof.exitCode).toBe((engine.exitCode as number) >>> 0);
  } else {
    expect(prepared).toBe(false);
    expect(authorization).toBe(false);
    expect(resumeState).toBe("not-attempted");
    expect(["stop", "deadline", "unauthorized-cleanup"]).toContain(
      completion.kind,
    );
    expect(end.proof).toEqual({ kind: "prepare-not-called" });
    expect(receipt.engineProcesses).toEqual([]);
  }
  expect(found[slots.loss]).toBeUndefined();
  return { found, end };
}

const readerSlots = {
  request: slots.request,
  prepared: slots.prepared,
  authorization: slots.auth,
  controllerLoss: slots.loss,
  terminal: slots.terminal,
} as const;

function interpretReadback(
  receipt: Receipt,
  expected: ReturnType<typeof independentSpec>,
  descriptor: Value,
) {
  const strict = object(object(receipt.values.readback).strict);
  const rawRecords = object(strict.records);
  const read = (value: unknown) => {
    const result = object(value);
    expect(["Existing", "Unknown"]).toContain(result.status);
    return {
      status: result.status === "Existing" ? "existing" : "unknown",
      snapshot: result.snapshot,
    };
  };
  return interpretWindowsJournalSnapshot(
    {
      v: 1,
      kind: "windows-journal-snapshot",
      reservation: read(strict.reservation),
      records: Object.fromEntries(
        Object.entries(readerSlots).map(([name, slot]) => [
          name,
          read(rawRecords[slot]),
        ]),
      ),
    },
    {
      target: expected.target,
      executionPolicyFingerprint: expected.executionPolicy.fingerprint,
    },
    descriptor as unknown as OwnerDescriptor,
  );
}

function readerLifecycle(receipt: Receipt) {
  const reader = object(receipt.values.reader);
  const helper = object(reader.helper);
  life(helper);
  expect(helper).toMatchObject({ alive: false, forced: false });
  const registered = receipt.actors.filter((actor) => {
    const identity = processFact(actor.identity);
    const original = processFact(helper.identity);
    return (
      identity.pid === original.pid &&
      identity.creationFileTime === original.creationFileTime
    );
  });
  expect(registered).toEqual([helper]);
  expect(reader.before).toEqual(reader.after);
  const before = exact(reader.before, ["root", "entries"]);
  expect(object(before.root)).toMatchObject({
    directory: true,
    nonInherited: true,
    deletePending: false,
  });
  for (const entry of values(before.entries)) {
    exact(entry, ["leaf", "file"]);
    const file = object(entry.file);
    expect(file).toMatchObject({
      directory: false,
      links: 1,
      nonInherited: true,
      deletePending: false,
    });
    const identity = exact(file.identity, ["volumeSerial", "fileId"]);
    expect(identity.fileId).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
    const bytes = Buffer.from(file.bytesBase64 as string, "base64");
    expect(String(bytes.length)).toBe(file.length);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  }
  const control = object(receipt.values.readerControl);
  expect(control.loadedAssemblySha256).toBe(control.ordinaryAssemblySha256);
  return { reader, helper, control };
}

function readerResponse(receipt: Receipt) {
  const { reader, helper, control } = readerLifecycle(receipt);
  expect(
    helper.exitCode,
    "actual --read-records must exit0 for a legal journal query",
  ).toBe(0);
  expect(reader).toMatchObject({ inputClosed: true, inputWriteFailure: null });
  expect(reader.stderrText).toBe("");
  expect(helper.stderr).toEqual([]);
  expect(typeof reader.stdoutText).toBe("string");
  const text = reader.stdoutText as string;
  expect(text.endsWith("\n")).toBe(true);
  expect(text.includes("\r")).toBe(false);
  expect(text.match(/\n/g)).toHaveLength(1);
  expect(helper.stdout).toEqual([text.slice(0, -1)]);
  const response = exact(JSON.parse(text), [
    "v",
    "kind",
    "reservation",
    "records",
  ]);
  expect(response).toMatchObject({
    v: 1,
    kind: "windows-journal-snapshot",
  });
  const records = exact(response.records, Object.keys(readerSlots));
  for (const result of [response.reservation, ...Object.values(records)]) {
    const value = exact(result, ["status", "snapshot"]);
    expect(["existing", "unknown"]).toContain(value.status);
    if (value.status === "unknown") expect(value.snapshot).toBeNull();
    else
      exact(value.snapshot, [
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
  }
  return { reader, helper, control, response, records };
}

function readerMatchesControl(receipt: Receipt) {
  const result = readerResponse(receipt);
  const expected = (value: unknown) => {
    const source = object(value);
    expect(source.ownerPresent).toBe(false);
    expect(["Existing", "Unknown"]).toContain(source.status);
    return {
      status: (source.status as string).toLowerCase(),
      snapshot: source.snapshot,
    };
  };
  expect(result.response.reservation).toEqual(
    expected(result.control.reservation),
  );
  const direct = exact(result.control.records, Object.values(readerSlots));
  for (const [name, slot] of Object.entries(readerSlots))
    expect(result.records[name]).toEqual(expected(direct[slot]));
  return result;
}

function readerStatuses(
  receipt: Receipt,
  reservation: "existing" | "unknown",
  existing: readonly (keyof typeof readerSlots)[],
) {
  const result = readerMatchesControl(receipt);
  expect(object(result.response.reservation).status).toBe(reservation);
  for (const name of Object.keys(readerSlots) as (keyof typeof readerSlots)[])
    expect(object(result.records[name]).status).toBe(
      existing.includes(name) ? "existing" : "unknown",
    );
  return result;
}

readerSuite("actual Windows journal reader entry", () => {
  beforeAll(async () => {
    expect(process.platform).toBe("win32");
    expect(process.env.ZEB_RUN_WINDOWS_SESSION_OS).toBe("1");
    for (const path of [
      exe,
      ordinaryExe,
      ordinaryDll,
      ...(mode === "reader-red" ? [] : [testExe]),
    ]) {
      expect(typeof path).toBe("string");
      expect(isAbsolute(path!)).toBe(true);
      await access(path!);
    }
  });

  it(
    "closed writer strict health then actual ordinary --read-records exit0 and independent five slots",
    async () => {
      await run("reader-healthy", (receipt, request, _meta, expected) => {
        terminal(receipt, request, expected, {
          completion: { kind: "engine-exit" },
          resumeState: "succeeded",
          prepared: true,
          authorization: true,
          prepareCalled: true,
        });
        expect(receipt.values.readerSource).toMatchObject({
          kind: "ordinary-engine-exit",
          writerClosed: true,
          intentionalCrash: false,
          directStrictHealthy: true,
          noLossSlot: true,
        });
        const { reader, control } = readerLifecycle(receipt);
        expect(control).toMatchObject({
          writerClosed: true,
          originalScope: {
            target: expected.target,
            executionPolicyFingerprint: expected.executionPolicy.fingerprint,
          },
          reservation: { status: "Existing", ownerPresent: false },
        });
        const direct = object(control.records);
        for (const name of [
          "request",
          "prepared",
          "authorization",
          "terminal",
        ] as const)
          expect(direct[readerSlots[name]]).toMatchObject({
            status: "Existing",
            ownerPresent: false,
          });
        expect(direct[slots.loss]).toMatchObject({
          status: "Unknown",
          snapshot: null,
        });
        const key = createHash("sha256")
          .update(expected.target.launchTicket, "utf8")
          .digest("hex");
        const entries = values(object(reader.before).entries);
        expect(entries.map((entry) => entry.leaf).sort()).toEqual(
          [
            `${key}.reserved`,
            `${key}.reservation.json`,
            ...[
              slots.request,
              slots.prepared,
              slots.auth,
              slots.reserved,
              slots.terminal,
            ].map((slot) => `${key}.record-${slot}.json`),
          ].sort(),
        );
        const unused = object(
          entries.find(
            (entry) => entry.leaf === `${key}.record-${slots.reserved}.json`,
          ),
        );
        expect(object(unused.file).bytesBase64).toBe("/w==");
        readerStatuses(receipt, "existing", [
          "request",
          "prepared",
          "authorization",
          "terminal",
        ]);
      });
    },
    testMs,
  );

  if (mode !== "reader-red") {
    it(
      "original interrupted history exposes all five independently existing envelopes",
      async () => {
        await run("reader-interrupted", (receipt, request, _meta, expected) => {
          const { found, preparedScope } = records(receipt, request, expected);
          expect(
            freezeDurableInterruptionRecords(
              {
                authorization: found[slots.auth],
                controllerLoss: found[slots.loss],
                terminal: found[slots.terminal],
              } as unknown as DurableInterruptionRecords,
              object(preparedScope) as unknown as InterruptionReadScope,
            ),
          ).toBeDefined();
          expect(receipt.values).toMatchObject({
            actualLossObservedBeforeRelease: true,
            engineTreeExited: true,
            activeProcesses: 0,
            authorizationVerified: true,
            successAuthorizeAck: false,
          });
          expect(object(receipt.subjects[0]).forced).toBe(false);
          readerStatuses(receipt, "existing", [
            "request",
            "prepared",
            "authorization",
            "controllerLoss",
            "terminal",
          ]);
        });
      },
      testMs,
    );

    for (const [scenario, reservation, existing] of [
      ["reader-empty", "unknown", []],
      ["reader-reservation", "existing", []],
      ["reader-partial-prepared", "existing", ["request", "prepared"]],
      [
        "reader-partial-auth",
        "existing",
        ["request", "prepared", "authorization"],
      ],
      ["reader-live", "unknown", []],
    ] as const) {
      it(
        `${scenario} preserves partial or sharing Unknown without publication or another tree`,
        async () => {
          await run(scenario, (receipt) => {
            readerStatuses(receipt, reservation, existing);
            const source = object(receipt.values.readerSource);
            expect(source.writerClosed).toBe(scenario !== "reader-live");
            if (scenario === "reader-live") {
              expect(source).toMatchObject({
                intentionalCrash: false,
                helperLive: true,
                originalEngineLive: true,
                firstActionAbsent: true,
              });
              expect(receipt.values.readerAfterLive).toEqual({
                helperLive: true,
                originalEngineLive: true,
                firstActionAbsent: true,
              });
              expect(receipt.subjects).toHaveLength(1);
              expect(object(receipt.subjects[0]).forced).toBe(false);
            } else if (scenario.startsWith("reader-partial-")) {
              expect(source).toMatchObject({
                intentionalCrash: true,
                originalEngineJoined: true,
                firstActionAbsent: true,
                terminalAbsent: true,
              });
              expect(receipt.subjects).toHaveLength(1);
              expect(receipt.engineProcesses).toHaveLength(1);
              if (scenario === "reader-partial-auth")
                expect(receipt.values.authorizeAckObservation).toMatchObject({
                  originalOwnerReaderJoined: true,
                  matchingReceivedResponses: [],
                  successAuthorizeAck: false,
                });
            } else {
              expect(receipt.subjects).toEqual([]);
              expect(receipt.engineProcesses).toEqual([]);
            }
          });
        },
        testMs,
      );
    }

    for (const scenario of ["reader-wrong-scope", "reader-wrong-id"] as const) {
      it(
        `${scenario} uses the caller scope and original execution identity without adoption`,
        async () => {
          await run(scenario, (receipt) => {
            expect(receipt.values.readerSource).toMatchObject({
              directStrictHealthy: true,
              writerClosed: true,
            });
            const { control, response, records } = readerResponse(receipt);
            if (scenario === "reader-wrong-scope")
              expect(response.reservation).toEqual({
                status: "unknown",
                snapshot: null,
              });
            else
              expect(response.reservation).toEqual({
                status: "existing",
                snapshot: object(control.reservation).snapshot,
              });
            for (const value of Object.values(records))
              expect(value).toEqual({ status: "unknown", snapshot: null });
          });
        },
        testMs,
      );
    }

    it(
      "physically legal malformed record remains native existing and preserves raw bytes",
      async () => {
        await run("reader-raw-bad-record", (receipt) => {
          expect(receipt.values.readerSourceMutation).toMatchObject({
            sameOriginalFile: true,
          });
          const { records } = readerStatuses(receipt, "existing", [
            "request",
            "prepared",
            "authorization",
            "terminal",
          ]);
          expect(object(object(records.request).snapshot).record).toEqual({
            recordId: slots.request,
            kind: "not-a-session-record",
            unexpected: true,
          });
        });
      },
      testMs,
    );

    for (const variant of [
      "bad-utf8",
      "duplicate",
      "truncated",
      "root-id",
      "marker-id",
      "file-id",
    ] as const) {
      it(
        `record ${variant} independently becomes Unknown while other original slots remain existing`,
        async () => {
          await run(`reader-record-${variant}`, (receipt) => {
            expect(receipt.values.readerSourceMutation).toMatchObject({
              sameOriginalFile: true,
            });
            readerStatuses(receipt, "existing", [
              "prepared",
              "authorization",
              "terminal",
            ]);
          });
        },
        testMs,
      );
    }

    for (const variant of [
      "malformed",
      "truncated",
      "second-json",
      "trailing-text",
      "bad-utf8",
      "duplicate-top",
      "duplicate-scope",
      "duplicate-target",
      "duplicate-identity",
      "extra-top",
      "extra-scope",
      "extra-target",
      "extra-identity",
      "missing-top",
      "missing-scope",
      "missing-target",
      "missing-identity",
      "version-decimal",
      "version-exponent",
      "attempt-zero",
      "attempt-negative",
      "attempt-unsafe",
      "attempt-decimal",
      "attempt-exponent",
      "fence-zero",
      "fence-unsafe",
      "fence-exponent",
      "bad-policy",
      "bad-id",
      "bad-identifier",
      "wrong-kind",
      "lossy-unicode",
      "root-array",
      "relative-root",
      "unc-root",
      "missing-cli-root",
      "extra-cli",
    ] as const) {
      it(
        `strict reader input ${variant} rejects with exit2 and fixed diagnostic shape`,
        async () => {
          await run(`reader-input-${variant}`, (receipt) => {
            expect(receipt.values.readerSource).toMatchObject({
              directStrictHealthy: true,
              writerClosed: true,
            });
            const { reader, helper } = readerLifecycle(receipt);
            if (
              ![
                "relative-root",
                "unc-root",
                "missing-cli-root",
                "extra-cli",
              ].includes(variant)
            )
              expect(reader).toMatchObject({
                inputClosed: true,
                inputWriteFailure: null,
              });
            expect(helper.exitCode).toBe(2);
            expect(helper.stdout).toEqual([]);
            expect(reader.stdoutText).toBe("");
            expect(helper.stderr).toHaveLength(1);
            const line = (helper.stderr as string[])[0];
            if (typeof line !== "string")
              throw new Error("Reader diagnostic must contain one string line");
            const diagnostic = exact(JSON.parse(line), ["code", "stage"]);
            for (const value of Object.values(diagnostic))
              expect(value).toEqual(
                expect.stringMatching(/^[a-z][a-z0-9_-]*$/),
              );
            expect([`${line}\n`, `${line}\r\n`]).toContain(reader.stderrText);
          });
        },
        testMs,
      );
    }
  }
});

suite("actual Windows Program execution session", () => {
  beforeAll(async () => {
    expect(process.platform).toBe("win32");
    expect(process.env.ZEB_RUN_WINDOWS_SESSION_OS).toBe("1");
    expect(["full", "control", "legacy-red"]).toContain(mode);
    for (const path of [
      exe,
      ordinaryExe,
      ordinaryDll,
      ...(mode === "full" ? [testExe] : []),
    ]) {
      expect(typeof path).toBe("string");
      expect(isAbsolute(path!)).toBe(true);
      await access(path!);
    }
  });

  it(
    "C0 installed self-contained harmless engine and transport lifecycle control",
    async () => {
      await run("C0", (receipt) => {
        const control = object(receipt.values.control);
        expect(control).toMatchObject({
          firstActionCreated: true,
          originalEngineJoined: true,
          stdoutEof: true,
          stderrEof: true,
          forced: false,
          exitCode: 0,
          strictUtf8: true,
          recipeExact: true,
          sameSid: true,
          manifestClosureDeclared: true,
        });
        expect(control.stdout).toEqual(["engine-stdout-商品🙂"]);
        expect(control.stderr).toEqual(["engine-stderr-商品🙂"]);
        expect(control.ordinaryTestOnlyTypes).toEqual([]);
        expect(control.ordinaryTestOnlyMembers).toEqual([]);
        expect(values(control.publishFiles).length).toBeGreaterThan(0);
        for (const file of values(control.publishFiles))
          expect(file).toMatchObject({
            sameBytes: true,
            sameSha256: true,
            protectedAcl: true,
          });
        expect(control.bundleBefore).toEqual(control.bundleAfter);
      });
    },
    testMs,
  );

  if (mode === "legacy-red") {
    it(
      "RED legacy ordinary ready claim inspect then exact six-key prepare requires prepared",
      async () => {
        await run("legacy-red", (receipt) => {
          expect(receipt.values).toMatchObject({
            subjectCleanupMode: "legacy-explicit-containment",
            subjectForced: true,
            baselineTransportHealthy: true,
            behavioralRejectionObservedBeforeContainment: true,
          });
          const actual = object(receipt.values.actualPrepare);
          expect(actual).toMatchObject({
            kind: "response",
            op: "prepare",
            state: { phase: "prepared" },
          });
        });
      },
      testMs,
    );
  }

  if (mode === "full") {

    it.each([
      ["installation", "installation_open", "file_open"],
      ["reservation", "reservation", "directory_open"],
    ] as const)("prepare diagnostic actual Native producer %s denial", async (variant, prepareStage, nativeStage) => {
      await run(`prepare-diagnostic-${variant}-denied`, (receipt) => {
        const proof = object(receipt.values.prepareDiagnosticFault);
        expect(proof).toMatchObject({ originalCallerUnimpersonated: true, denyInstalled: true,
          deniedRead: { success: false, nativeError: 5 }, readableControl: { success: true, nativeError: 0 },
          ancestorAclsUnchangedDuring: true, leafAclRestored: true, ancestorAclsUnchangedAfter: true,
          bundlePreserved: true, recordsEmpty: true, bindingPreserved: true });
        if (variant === "installation") expect(proof.selectedFromProductionLaunch).toBe(true);
        else expect(proof.independentReservationRead).toMatchObject({ status: "Unknown", snapshot: null,
          ownerPresent: false, diagnostic: { stage: "directory_open", nativeError: 5 } });
        const actual = object(receipt.values.prepareDiagnosticResponse);
        expect(actual).toMatchObject({ v: 1, kind: "error", code: "unknown",
          requestId: object(receipt.values.prepareDiagnosticRequest).requestId });
        expect(actual.prepareDiagnostic, "the actual RunPrepare failure reaches its original Program error response")
          .toEqual({ prepareStage, nativeStage, nativeErrorCode: 5 });
        exact(actual, ["v", "kind", "requestId", "code", "prepareDiagnostic"]);
        exact(actual.prepareDiagnostic, ["prepareStage", "nativeStage", "nativeErrorCode"]);
        expect(Reflect.has(object(receipt.values.prepareDiagnosticUnknownEvent), "prepareDiagnostic")).toBe(false);
        expect(object(receipt.values.prepareDiagnosticUnknownEvent).state).toMatchObject({
          phase: "unknown", evidenceOutcome: "unknown", completion: null, authorizationVerified: false, resumeState: "not-attempted" });
        expect(receipt.values.prepareDiagnosticContainment).toMatchObject({ originalUnknownObserved: true,
          exactOriginalHelperJoined: true, forcedFaultCleanup: false, helperNaturalExit: true, helperExitCode: 2,
          engineCreated: false, terminalAbsent: true, firstActionAbsent: true, productCleanupQualified: false });
        expect(receipt.engineProcesses).toEqual([]);
      });
    }, testMs);
    for (const [scenario, raw] of [
      ["prepared-ts", false],
      ["prepared-raw", true],
    ] as const) {
      it(
        `${scenario} real suspension raw-byte binding immutable installation lease`,
        async () => {
          await run(
            scenario,
            (receipt, request, _meta, expected) => {
              response(receipt.values.prepare, "prepare");
              expect(object(receipt.values.prepare).state).toMatchObject({
                phase: "prepared",
                authorizationVerified: false,
                resumeState: "not-attempted",
                requestFingerprint: request.requestFingerprint,
              });
              expect(receipt.values.preparedProbe).toMatchObject({
                engineLive: true,
                engineInOriginalJob: true,
                activeProcesses: 1,
                totalProcesses: 1,
                firstActionAbsent: true,
              });
              for (const probe of values(receipt.values.leaseBefore))
                expect(probe).toMatchObject({
                  write: { success: true },
                  delete: { success: true },
                  rename: { success: true },
                });
              for (const probe of values(receipt.values.leaseHeld))
                for (const key of ["write", "delete", "rename"])
                  expect(object(probe[key]).success).toBe(false);
              for (const probe of values(receipt.values.leaseAfter))
                expect(probe).toMatchObject({
                  write: { success: true },
                  delete: { success: true },
                  rename: { success: true },
                });
              expect(receipt.values.bundleBefore).toEqual(
                receipt.values.bundleAfter,
              );
              const { found, end } = terminal(receipt, request, expected, {
                completion: raw
                  ? { kind: "stop" }
                  : { kind: "unauthorized-cleanup", cause: "controller_eof" },
                resumeState: "not-attempted",
                prepared: true,
                authorization: false,
                prepareCalled: true,
              });
              expect(found[slots.auth]).toBeUndefined();
              expect(end.authorizationRecordId).toBeNull();
              if (!raw)
                expect(end.completion).toEqual({
                  kind: "unauthorized-cleanup",
                  cause: "controller_eof",
                });
              for (const subject of receipt.subjects) {
                life(subject, 0);
                expect(subject.forced).toBe(false);
              }
            },
            raw,
          );
        },
        testMs,
      );
    }

    it(
      "ordinary AUTH once replay first action after ACK and natural terminal strict reopen",
      async () => {
        await run("ordinary-once", (receipt, request, _meta, expected) => {
          const authorize = response(receipt.values.authorize, "authorize");
          expect(authorize.state).toMatchObject({
            phase: "running",
            authorizationVerified: true,
            resumeState: "succeeded",
          });
          expect(
            response(receipt.values.authorizeReplay, "authorize").state,
          ).toEqual(authorize.state);
          expect(
            response(receipt.values.prepareReplay, "prepare").state,
          ).toMatchObject({
            descriptor: object(authorize.state).descriptor,
            requestFingerprint: request.requestFingerprint,
          });
          expect(receipt.values.firstAction).toMatchObject({
            markerCreated: true,
            engineInOriginalJob: true,
            helperAcknowledgedBeforeFinish: true,
          });
          const { found, end } = terminal(receipt, request, expected, {
            completion: { kind: "engine-exit" },
            resumeState: "succeeded",
            prepared: true,
            authorization: true,
            prepareCalled: true,
          });
          expect(object(end.proof).exitCode).toBe(0);
          expect(end.authorizationRecordId).toBe(slots.auth);
          expect(
            exact(found[slots.auth], ["v", "recordId", "scope", "kind"]),
          ).toMatchObject({ v: 1, kind: "authorized" });
          for (const subject of receipt.subjects) {
            life(subject, 0);
            expect(subject.forced).toBe(false);
          }
        });
      },
      testMs,
    );

    it(
      "ordinary full scope owner payload descriptor and exact-frame conflicts never add execution",
      async () => {
        await run("conflicts", (receipt) => {
          const observed = values(receipt.values.conflicts);
          const codes = [
            "scope_mismatch",
            "controller_mismatch",
            "owner_already_claimed",
            "not_owner",
            "not_prepared",
            "payload_conflict",
            "authorization_mismatch",
            "invalid_request",
          ];
          for (const code of codes)
            expect(observed.some((entry) => entry.expectedCode === code)).toBe(
              true,
            );
          for (const entry of observed)
            error(entry.actual, entry.expectedCode as string);
          expect(receipt.values).toMatchObject({
            firstActionAbsent: true,
            originalDescriptorUnchanged: true,
            originalRecordsUnchanged: true,
            originalEngineCount: 1,
          });
          expect(
            object(
              response(receipt.values.afterInvalidOwnerInspect, "inspect")
                .state,
            ),
          ).toMatchObject({ phase: "prepared", sealReason: null });
          expect(
            object(
              response(receipt.values.afterInvalidOwnerAuthorize, "authorize")
                .state,
            ),
          ).toMatchObject({
            resumeState: "succeeded",
            authorizationVerified: true,
          });
        });
      },
      testMs,
    );

    for (const slot of ["request", "prepared", "auth"] as const) {
      for (const fault of [
        "WriteReadOnly",
        "FlushReadOnly",
        "RenameCollision",
      ] as const) {
        it(
          `${slot} actual ${fault} preserves unknown without resume or terminal repair`,
          async () => {
            await run(`io-${slot}-${fault}`, (receipt) => {
              expect(receipt.values).toMatchObject({
                unknownObserved: true,
                firstActionAbsent: true,
                terminalAbsent: true,
                replayDidNotChangeEvidence: true,
              });
              if (fault === "RenameCollision") {
                expect(receipt.values.collisionBefore).toEqual(
                  receipt.values.collisionAfter,
                );
                expect(object(receipt.values.collisionBefore).present).toBe(
                  true,
                );
              } else {
                const io = object(receipt.values.ioProbe);
                expect(io).toMatchObject({
                  sameObject: true,
                  originalNonInherited: true,
                  selectedNonInherited: true,
                  originalCanWrite: true,
                  selectedCanWrite: false,
                  independentNativeError: 5,
                  duplicatesClosedBeforeRelease: true,
                });
                expect(io.originalIdentity).toEqual(io.selectedIdentity);
              }
            });
          },
          testMs,
        );
      }
    }

    it.each([
      "business-late-soft",
      "business-force-first",
      "business-rejections",
      "deadline-business-force-wake",
      "deadline-business-soft-wake",
      "deadline-business-later-soft",
      "business-loss-reject",
    ])(
      "native request-stop %s preserves original owner, cause and single cleanup",
      async (scenario) => {
        await run(scenario, (receipt, request, _meta, expected) => {
          const proof = receipt.values.businessStop as Value;
          expect(proof).toMatchObject({
            extraEngineJobHandlesClosed: true,
            originalEngineJoined: true,
          });
          if (scenario === "business-loss-reject") {
            expect(proof.rejected).toMatchObject({
              kind: "error",
              code: "not_owner",
            });
            expect(proof.originalCause).toBe("controller_eof");
            const { found, preparedScope, descriptor } = records(
              receipt,
              request,
              expected,
            );
            const scope = object(preparedScope);
            const interrupted = freezeDurableInterruptionRecords(
              {
                authorization: found[slots.auth],
                controllerLoss: found[slots.loss],
                terminal: found[slots.terminal],
              } as unknown as DurableInterruptionRecords,
              scope as unknown as InterruptionReadScope,
            );
            expect(interrupted.controllerLoss).toEqual({
              v: 1,
              recordId: slots.loss,
              scope,
              kind: "controller-lost",
              authorizationRecordId: slots.auth,
            });
            expect(interrupted.terminal).toEqual({
              v: 1,
              recordId: slots.terminal,
              scope,
              kind: "terminal",
              completion: "interrupted",
              authorizationRecordId: slots.auth,
              controllerLossRecordId: slots.loss,
              treeExited: true,
              authorizationsSealed: true,
            });
            expect(
              interpretReadback(receipt, expected, object(descriptor)),
            ).toEqual({
              kind: "interrupted",
              exit: {
                identity: expected.target.identity,
                descriptor,
                launchTicket: expected.target.launchTicket,
                treeExited: true,
                completion: {
                  kind: "interrupted",
                  authorizationRecordId: slots.auth,
                  controllerLossRecordId: slots.loss,
                  terminalRecordId: slots.terminal,
                },
              },
              records: interrupted,
            });
          } else {
            expect(proof.accepted).toMatchObject({
              kind: "response",
              op: "request-stop",
              role: "owner",
              state: {
                authorizationVerified: true,
                resumeState: "succeeded",
                sealReason: scenario.startsWith("deadline-")
                  ? "deadline"
                  : "stop",
              },
            });
            const kind = scenario.startsWith("deadline-") ? "deadline" : "stop";
            const { end } = terminal(receipt, request, expected, {
              completion: {
                kind,
              },
              resumeState: "succeeded",
              prepared: true,
              authorization: true,
              prepareCalled: true,
            });
            const actual = interpretReadback(
              receipt,
              expected,
              object(end.descriptor),
            );
            expect(actual).toEqual({
              kind,
              exit: {
                identity: expected.target.identity,
                descriptor: end.descriptor,
                launchTicket: expected.target.launchTicket,
                treeExited: true,
              },
            });
            if (actual.kind !== kind)
              throw new Error("qualified original stopped tree required");
            expect(Object.hasOwn(actual.exit, "completion")).toBe(false);
          }
          if (scenario === "business-rejections") {
            expect(proof.rejectedCodes).toEqual([
              "not_authorized",
              "scope_mismatch",
              "authorization_mismatch",
              "not_owner",
              "invalid_stop",
              "early_stop",
              "early_stop",
              "stop_conflict",
            ]);
            expect(proof.compiledParser).toMatchObject({
              source: "original-loaded-ordinary-assembly-parser",
              canonicalZeroAccepted: true,
              invalidTokensRejected: 6,
              equalForceRejected: true,
              pastForceAccepted: true,
            });
          }
          if (scenario === "business-late-soft") {
            expect(proof.beforeOriginalReceiptGrace).toBe(true);
            expect(proof.duplicateAfterT).toMatchObject({
              kind: "response",
              op: "request-stop",
            });
          }
          if (scenario === "business-force-first") {
            expect(proof.duplicateForce).toMatchObject({
              kind: "response",
              op: "request-stop",
            });
            expect(proof.softAfterForce).toMatchObject({
              kind: "response",
              op: "request-stop",
            });
          }
          if (scenario.startsWith("deadline-")) {
            expect(proof.waitRegistration).toMatchObject({
              slot: "terminal",
              stage: "GraceWaiting",
              observation: { sealReason: "deadline" },
            });
            expect(proof.completedBeforeOldGrace).toBe(true);
          }
        });
      },
      testMs,
    );

    for (const scenario of [
      "auth-before-resume-owner-eof",
      "auth-before-resume-controller-exit",
      "auth-writing-owner-eof",
      "running-owner-eof",
    ] as const) {
      it(
        `${scenario} original loss forms exact interrupted chain after real cleanup`,
        async () => {
          await run(scenario, (receipt, request, _meta, expected) => {
            const { found, preparedScope } = records(
              receipt,
              request,
              expected,
            );
            const scope = object(preparedScope);
            object(found[slots.auth]);
            object(found[slots.loss]);
            object(found[slots.terminal]);
            expect(
              freezeDurableInterruptionRecords(
                {
                  authorization: found[slots.auth],
                  controllerLoss: found[slots.loss],
                  terminal: found[slots.terminal],
                } as unknown as DurableInterruptionRecords,
                scope as unknown as InterruptionReadScope,
              ),
            ).toBeDefined();
            expect(
              exact(found[slots.loss], [
                "v",
                "recordId",
                "scope",
                "kind",
                "authorizationRecordId",
              ]),
            ).toMatchObject({
              kind: "controller-lost",
              authorizationRecordId: slots.auth,
            });
            expect(receipt.values).toMatchObject({
              actualLossObservedBeforeRelease: true,
              engineTreeExited: true,
              activeProcesses: 0,
              authorizationVerified: true,
            });
            if (scenario !== "running-owner-eof")
              expect(receipt.values.firstActionAbsent).toBe(true);
            expect(receipt.values.successAuthorizeAck).toBe(
              scenario === "running-owner-eof",
            );
          });
        },
        testMs,
      );
    }

    it(
      "ordinary observer EOF cannot become owner loss",
      async () => {
        await run("observer-eof", (receipt, request, _meta, expected) => {
          expect(receipt.values.afterObserverClose).toMatchObject({
            phase: "running",
            sealReason: null,
            authorizationVerified: true,
          });
          terminal(receipt, request, expected, {
            completion: { kind: "engine-exit" },
            resumeState: "succeeded",
            prepared: true,
            authorization: true,
            prepareCalled: true,
          });
        });
      },
      testMs,
    );

    it(
      "ordinary long absolute deadline and grace exceed documented BCL timer domain without rebasing",
      async () => {
        await run(
          "long-deadline-grace",
          (receipt, request, _meta, expected) => {
            expect(receipt.values.longDeadlineGrace).toMatchObject({
              originalDeadline: expected.executionDeadlineAt,
              originalGrace: 4_294_967_295,
              firstActionAlreadyCreated: true,
            });
            terminal(receipt, request, expected, {
              completion: { kind: "stop" },
              resumeState: "succeeded",
              prepared: true,
              authorization: true,
              prepareCalled: true,
            });
          },
        );
      },
      testMs,
    );

    for (const scenario of [
      "stop-before-prepare",
      "stop-prepared",
      "stop-running",
      "deadline-before-prepare",
      "deadline-before-resume",
    ] as const) {
      it(
        `${scenario} original absolute deadline and first gate cause stay private`,
        async () => {
          await run(scenario, (receipt, request, _meta, expected) => {
            const beforePrepare = scenario.endsWith("before-prepare");
            const { end } = terminal(receipt, request, expected, {
              completion: {
                kind: scenario.startsWith("stop") ? "stop" : "deadline",
              },
              resumeState:
                scenario === "stop-running" ? "succeeded" : "not-attempted",
              prepared: !beforePrepare,
              authorization:
                scenario === "stop-running" ||
                scenario === "deadline-before-resume",
              prepareCalled: !beforePrepare,
            });
            if (beforePrepare) {
              expect(end.proof).toEqual({ kind: "prepare-not-called" });
              const stage = object(receipt.values.stopDeadlineStage);
              expect(stage).toMatchObject({
                slot: "request",
                stage: "RecordVerified",
              });
              expect(object(stage.observation)).toMatchObject({
                engine: null,
                jobName: null,
              });
            }
            if (scenario === "deadline-before-resume")
              expect(object(receipt.values.stopDeadlineStage)).toMatchObject({
                slot: "auth",
                stage: "AuthVerifiedBeforeResumeGate",
              });
            if (scenario.startsWith("deadline"))
              expect(receipt.values.deadlineObservation).toMatchObject({
                originalDeadline: expected.executionDeadlineAt,
                observedAfterOriginalDeadline: true,
                deadlineNotRebased: true,
              });
            if (scenario !== "stop-running")
              expect(receipt.values.firstActionAbsent).toBe(true);
            if (!beforePrepare) {
              const actual = interpretReadback(
                receipt,
                expected,
                object(end.descriptor),
              );
              expect(actual).toEqual(
                scenario === "stop-running"
                  ? {
                      kind: "stop",
                      exit: {
                        identity: expected.target.identity,
                        descriptor: end.descriptor,
                        launchTicket: expected.target.launchTicket,
                        treeExited: true,
                      },
                    }
                  : { kind: "unknown" },
              );
            }
          });
        },
        testMs,
      );
    }

    it(
      "ordinary original parent exits before retained descendant stream writers",
      async () => {
        await run("parent-first", (receipt, request, _meta, expected) => {
          expect(receipt.values.parentFirst).toMatchObject({
            originalParentSignaled: true,
            originalDescendantsLive: true,
            activeProcesses: 2,
            terminalAbsent: true,
            helperStillLive: true,
            stdoutWriterRetained: true,
            stderrWriterRetained: true,
          });
          expect(receipt.engineProcesses).toHaveLength(3);
          terminal(receipt, request, expected, {
            completion: { kind: "engine-exit" },
            resumeState: "succeeded",
            prepared: true,
            authorization: true,
            prepareCalled: true,
          });
        });
      },
      testMs,
    );

    it(
      "ordinary concurrently drains stdout stderr beyond queried OS capacities",
      async () => {
        await run("capacity-drains", (receipt, request, _meta, expected) => {
          const drained = object(receipt.values.capacityDrains);
          expect(drained).toMatchObject({
            stdoutWriteCompleted: true,
            stderrWriteCompleted: true,
            concurrentWrites: true,
            capacitiesQueriedFromActualHandles: true,
          });
          expect(drained.stdoutBytes).toBeGreaterThan(
            drained.stdoutCapacity as number,
          );
          expect(drained.stderrBytes).toBeGreaterThan(
            drained.stderrCapacity as number,
          );
          terminal(receipt, request, expected, {
            completion: { kind: "engine-exit" },
            resumeState: "succeeded",
            prepared: true,
            authorization: true,
            prepareCalled: true,
          });
        });
      },
      testMs,
    );

    it(
      "session actual count2 keeps original resources until tree and drains settle",
      async () => {
        await run("session-count2", (receipt, request, _meta, expected) => {
          expect(receipt.values).toMatchObject({
            firstActionAbsent: true,
            originalEngineCount: 1,
            successAuthorizeAck: false,
            realCount2Bridge: true,
            treeObservedBeforeResourceRelease: true,
          });
          const { end } = terminal(receipt, request, expected, {
            completion: { kind: "launch-failure", stage: "resume" },
            resumeState: "uncertain",
            prepared: true,
            authorization: true,
            prepareCalled: true,
          });
          expect(end.completion).toEqual({
            kind: "launch-failure",
            stage: "resume",
          });
        });
      },
      testMs,
    );

    it(
      "legacy public wrapper independently preserves actual count2 automatic cleanup",
      async () => {
        await run("legacy-count2", (receipt) => {
          expect(receipt.values.legacyCount2).toMatchObject({
            previousSuspendCount: 1,
            actualOriginalThread: true,
            exceptionType: "InvalidOperationException",
            exceptionMessage:
              "Primary thread did not have the expected single prepare suspension.",
            firstActionAbsent: true,
            originalEngineJoined: true,
            activeProcesses: 0,
            publicWrapperDisposed: true,
            independentStdoutEof: true,
            independentStderrEof: true,
            secondResumeAttempted: false,
          });
        });
      },
      testMs,
    );

    for (const scenario of [
      "force-denied",
      "closed-original-job",
      "prepare-no-receipt",
      "prepare-no-receipt-slow-diagnostic",
    ] as const) {
      it(
        `${scenario} Unknown keeps helper pins pending until exact external fault containment`,
        async () => {
          await run(scenario, (receipt) => {
            expect(receipt.values.unknownRetention).toMatchObject({
              unknownObserved: true,
              helperStillLive: true,
              terminalAbsent: true,
              completionPending: true,
              installationPinsHeld: true,
              forcedFaultCleanup: true,
              exactOriginalHelperJoined: true,
            });
            if (!scenario.startsWith("prepare-no-receipt"))
              expect(receipt.values.unknownRetention).toMatchObject({
                exactOriginalJobGuard: true,
                guardObservedActive0: true,
                originalEngineJoined: true,
              });
            if (scenario === "force-denied")
              expect(receipt.values.unknownRetention).toMatchObject({
                faultIsQueryOnlySameOriginalJob: true,
                originalOwningJobRetained: true,
              });
            if (scenario === "closed-original-job")
              expect(receipt.values.unknownRetention).toMatchObject({
                originalOwningJobDeliberatelyClosed: true,
                engineSignalIsNotOriginalJobProof: true,
              });
            if (scenario.startsWith("prepare-no-receipt")) {
              const diagnostic = object(receipt.values.prepareDiagnostic);
              expect(diagnostic.present).toBe(true);
              const record = exact(diagnostic.record, ["v", "kind", "recordId", "prepareStage", "exceptionType", "nativeStage", "nativeErrorCode"]);
              expect(record).toMatchObject({ v: 1, kind: "windows-prepare-diagnostic",
                recordId: "00000000000000000000000000000007", prepareStage: "job_prepare",
                exceptionType: "Zeb.WindowsSupervisor.JobPreparationException", nativeStage: "UpdateProcThreadAttribute" });
              expect(Number.isSafeInteger(record.nativeErrorCode)).toBe(true);
              expect(record.nativeErrorCode).not.toBe(0);
              const wire = exact(receipt.values.prepareFailureResponse, ["v", "kind", "requestId", "code", "prepareDiagnostic"]);
              expect(wire).toMatchObject({ v: 1, kind: "error", code: "prepare_failed" });
              expect(wire.prepareDiagnostic, "real UpdateProcThreadAttribute failure is carried by the original response")
                .toEqual({ prepareStage: "job_prepare", nativeStage: "UpdateProcThreadAttribute",
                  nativeErrorCode: record.nativeErrorCode });
              exact(wire.prepareDiagnostic, ["prepareStage", "nativeStage", "nativeErrorCode"]);
            }
            if (scenario === "prepare-no-receipt-slow-diagnostic") {
              expect(receipt.values.diagnosticPastDeadline).toBe(true);
              const retained = object(receipt.values.unknownRetention);
              const inspected = object(retained.actualInspect);
              expect(object(inspected.state).sealReason).toBe("launch-failure");
            }
          });
        },
        testMs,
      );
    }

    it(
      "explicit drain fault cannot fabricate EOF despite real tree exit",
      async () => {
        await run("drain-failure", (receipt) => {
          expect(receipt.values.drainFailure).toMatchObject({
            explicitlyInjected: true,
            originalEngineJoined: true,
            originalJobActive0: true,
            terminalAbsent: true,
            unknownObserved: true,
            helperResourcesSafelyReleased: true,
          });
        });
      },
      testMs,
    );

    for (const scenario of [
      "crash-auth-before-resume",
      "crash-resume-before-ack",
    ] as const) {
      it(
        `${scenario} crash lacks terminal and second actual Program refuses Existing`,
        async () => {
          await run(scenario, (receipt) => {
            expect(receipt.values.crash).toMatchObject({
              intentionallyTerminatedOriginalHelper: true,
              allExtraJobHandlesClosedBeforeCrash: true,
              originalEngineJoined: true,
              terminalAbsent: true,
              existingRefused: true,
              secondTreeAbsent: true,
              originalRecordsUnchanged: true,
            });
            expect(receipt.values.crash).toMatchObject({
              firstActionCreated: scenario === "crash-resume-before-ack",
              successAuthorizeAck: false,
            });
          });
        },
        testMs,
      );
    }
  }
});
