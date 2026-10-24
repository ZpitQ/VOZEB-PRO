import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { runnerLimits } from "./storage-fixtures.js";

type Value = Record<string, unknown>;
type Result = {
  status: "Created" | "Existing" | "Unknown";
  snapshot: Value | null;
  ownerPresent: boolean;
  diagnostic: { stage: string; nativeError: number | null } | null;
};
type HostReceipt = {
  scenario: string;
  setupFailure: unknown;
  failure: unknown;
  setup: Value;
  values: Record<string, unknown>;
  reservation?: Result;
  actors: Value[];
  cleanup: {
    failures: unknown[];
    liveOwnedProcesses: Value[];
    allObservedJoined: boolean;
    originalRegistry: boolean;
    processes: Value[];
  };
  conditionalUnexecuted: string[];
};
type OuterEvidence = {
  primaryFailure: unknown;
  protocolFailures: unknown[];
  forced: boolean;
  readyForwarded: boolean;
  firstScenarioForwarded: boolean;
  firstCommandBarrier: boolean;
  bootstrapFailure: Value | null;
  heldPhase: Value | null;
  cleanupDeadlineUnixMs: number;
  cleanup: {
    failures: unknown[];
    activeProcesses: number | null;
    liveOwnedProcesses: Value[];
    allObservedJoined: boolean;
    membershipVerified: boolean;
    nonInherited: boolean;
    outerOutsideJob: boolean;
    soleJobHandle: boolean;
    killOnClose: boolean;
    processes: Value[];
  };
  host: {
    identity: Value | null;
    started: boolean;
    originalRetained: boolean;
    originalJoined: boolean;
    exitCode: number | null;
    stdoutEof: boolean;
    stderrEof: boolean;
    stdoutError: string | null;
    stderrError: string | null;
    stderr: string[];
  };
};
type FinalReceipt = {
  control: string;
  host: HostReceipt | null;
  outer: OuterEvidence;
};
type Receipt = HostReceipt & { outer: OuterEvidence };
type LifetimeEvidence = {
  directory: string;
  rmAttempts: number;
  directoryRemoved: boolean;
  closePromiseRetained: boolean;
  final?: FinalReceipt;
};

const fixtureVariable = process.env.ZEB_WINDOWS_JOURNAL_FIXTURE_EXE;
const ordinaryVariable = process.env.ZEB_WINDOWS_JOURNAL_ORDINARY_DLL;
const privateMode = process.env.ZEB_WINDOWS_JOURNAL_PRIVATE_MODE;
const explicitlyRequested =
  fixtureVariable !== undefined ||
  ordinaryVariable !== undefined ||
  process.argv.some((argument) => argument.includes("windows-journal.os.test"));
const windowsSuite =
  process.platform === "win32" || explicitlyRequested
    ? describe
    : describe.skip;
const executionMs = runnerLimits.executionTimeoutMs;
const cleanupMs = runnerLimits.cancelGraceMs;
const testMs = executionMs + cleanupMs;
const fullControl = 0x001f01ff;
const unicode = '商品-\u0085中🙂文"引号\nline\r\t\\';

async function boundedUntil<T>(promise: Promise<T>, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Windows journal fixture deadline exceeded")),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function object(value: unknown): Value {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Value;
}

function objects(value: unknown): Value[] {
  expect(Array.isArray(value)).toBe(true);
  return (value as unknown[]).map(object);
}

function result(value: unknown, status?: Result["status"]): Result {
  const observed = object(value);
  expect(["Created", "Existing", "Unknown"]).toContain(observed.status);
  if (status) expect(observed.status).toBe(status);
  expect(typeof observed.ownerPresent).toBe("boolean");
  if (observed.status === "Unknown") {
    expect(observed.ownerPresent).toBe(false);
    expect(observed.snapshot).toBeNull();
    const diagnostic = object(observed.diagnostic);
    expect(diagnostic.stage).toEqual(expect.any(String));
    expect((diagnostic.stage as string).length).toBeGreaterThan(0);
    expect(diagnostic.stage).not.toMatch(/[\\/:]/);
  } else {
    object(observed.snapshot);
    expect(observed.diagnostic).toBeNull();
    if (observed.status === "Existing")
      expect(observed.ownerPresent).toBe(false);
  }
  return observed as Result;
}

function security(value: unknown) {
  const actual = object(value);
  expect(actual).toMatchObject({
    ownerMatchesCurrentSid: true,
    daclPresent: true,
    protectedDacl: true,
    aceCount: 1,
  });
  expect(actual.aces).toEqual([
    {
      type: "AccessAllowed",
      flags: 0,
      accessMask: fullControl,
      sidMatchesCurrent: true,
    },
  ]);
}

function identity(value: unknown) {
  const actual = object(value);
  expect(Object.keys(actual).sort()).toEqual(["fileId", "volumeSerial"]);
  expect(actual.volumeSerial).toEqual(expect.stringMatching(/^(0|[1-9]\d*)$/));
  expect(actual.fileId).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
  return actual;
}

function file(value: unknown, directory = false) {
  const actual = object(value);
  identity(actual.identity);
  security(actual.security);
  expect(actual).toMatchObject({
    directory,
    deletePending: false,
    nonInherited: true,
    reparse: false,
  });
  if (!directory) expect(actual.links).toBe(1);
  return actual;
}

function encoding(value: unknown) {
  expect(object(value)).toEqual({
    webName: "utf-8",
    codePage: 65001,
    encoderFallback: "EncoderExceptionFallback",
    decoderFallback: "DecoderExceptionFallback",
    preambleBytes: 0,
  });
}

function cleanup(receipt: Receipt) {
  expect(receipt.setupFailure, JSON.stringify(receipt)).toBeNull();
  expect(receipt.cleanup.failures, JSON.stringify(receipt)).toEqual([]);
  expect(receipt.cleanup.liveOwnedProcesses).toEqual([]);
  expect(receipt.cleanup).toMatchObject({
    allObservedJoined: true,
    originalRegistry: true,
  });
  for (const process of receipt.cleanup.processes) {
    expect(process).toMatchObject({
      alive: false,
      originalJoined: true,
      nonInherited: true,
      sameSid: true,
    });
    const pinned = object(process.identity);
    expect(pinned.pid).toEqual(expect.any(Number));
    expect(pinned.createdFileTime).toEqual(expect.stringMatching(/^\d+$/));
  }
  for (const actor of receipt.actors) {
    expect(actor).toMatchObject({
      alive: false,
      started: true,
      originalRetained: true,
      originalJoined: true,
      stdoutEof: true,
      stderrEof: true,
      stdoutError: null,
      stderrError: null,
    });
    expect(actor.exitCode).not.toBeNull();
  }
  expect(receipt.conditionalUnexecuted).toEqual([
    "independent-wrong-SID",
    "remote-filesystem",
    "non-NTFS-volume",
    "other-volume",
  ]);
  independentCleanup(receipt.outer);
}

function independentCleanup(outer: OuterEvidence) {
  expect(outer.cleanup.failures, JSON.stringify(outer)).toEqual([]);
  expect(outer.cleanup.liveOwnedProcesses).toEqual([]);
  expect(outer.cleanup).toMatchObject({
    activeProcesses: 0,
    allObservedJoined: true,
    membershipVerified: true,
    nonInherited: true,
    outerOutsideJob: true,
    soleJobHandle: true,
    killOnClose: true,
  });
  expect(outer.host).toMatchObject({
    started: true,
    originalRetained: true,
    originalJoined: true,
    stdoutEof: true,
    stderrEof: true,
    stdoutError: null,
    stderrError: null,
    stderr: [],
  });
  expect(outer.host.exitCode).not.toBeNull();
  expect(outer.firstCommandBarrier).toBe(true);
  for (const process of outer.cleanup.processes) {
    expect(process).toMatchObject({
      alive: false,
      joined: true,
      nonInherited: true,
      sameSid: true,
    });
    const pinned = object(process.identity);
    expect(pinned.pid).toEqual(expect.any(Number));
    expect(pinned.createdFileTime).toEqual(expect.stringMatching(/^\d+$/));
  }
}

class JournalFixture {
  private child!: ChildProcessWithoutNullStreams;
  private spawnReturned = false;
  private readonly executionDeadline = Date.now() + executionMs;
  private readonly ready: Promise<Value>;
  private readonly final: Promise<FinalReceipt>;
  private readonly held: Promise<Value>;
  private closed!: Promise<void>;
  private resolveReady: ((value: Value) => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private resolveFinal: ((value: FinalReceipt) => void) | undefined;
  private rejectFinal: ((error: Error) => void) | undefined;
  private resolveHeld: ((value: Value) => void) | undefined;
  private rejectHeld: ((error: Error) => void) | undefined;
  private stdout = "";
  private lineBuffer = "";
  private stderr = "";
  private outputFailure: Error | undefined;
  private readonly inputErrors: Error[] = [];
  private closeCompletion: Promise<void> | undefined;
  private cleanupDeadline: number | undefined;
  private stdoutEof = false;
  private stderrEof = false;
  private outerJoined = false;
  private readyReceived = false;
  private scenarioSent = false;
  private finalReceipt: FinalReceipt | undefined;

  constructor() {
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    this.final = new Promise((resolveFinal, rejectFinal) => {
      this.resolveFinal = resolveFinal;
      this.rejectFinal = rejectFinal;
    });
    this.held = new Promise((resolveHeld, rejectHeld) => {
      this.resolveHeld = resolveHeld;
      this.rejectHeld = rejectHeld;
    });
    // Some private controls intentionally never produce ready or held. Keep
    // their original rejection available without an unhandled rejection.
    void this.ready.catch(() => undefined);
    void this.final.catch(() => undefined);
    void this.held.catch(() => undefined);
  }

  launch(
    executable: string,
    ordinary: string,
    directory: string,
    control: string,
  ) {
    if (this.spawnReturned)
      throw new Error("Private outer was already launched");
    this.child = spawn(
      executable,
      [
        "outer",
        ordinary,
        directory,
        String(executionMs),
        String(cleanupMs),
        control,
      ],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.spawnReturned = true;
    const stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
    const stderrDecoder = new TextDecoder("utf-8", { fatal: true });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        const decoded = stdoutDecoder.decode(chunk, { stream: true });
        this.stdout += decoded;
        this.lineBuffer += decoded;
        this.consumeLines();
      } catch (caught) {
        this.failOutput(
          new Error("Malformed outer fixture UTF8/output", { cause: caught }),
        );
      }
    });
    this.child.stdout.once("end", () => {
      this.stdoutEof = true;
      try {
        const tail = stdoutDecoder.decode();
        this.stdout += tail;
        this.lineBuffer += tail;
        this.consumeLines();
        if (this.lineBuffer.length !== 0)
          throw new Error("Incomplete outer fixture frame");
      } catch (caught) {
        this.failOutput(
          new Error("Malformed outer fixture EOF", { cause: caught }),
        );
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      try {
        this.stderr += stderrDecoder.decode(chunk, { stream: true });
      } catch (caught) {
        this.failOutput(
          new Error("Malformed outer fixture stderr UTF8", { cause: caught }),
        );
      }
    });
    this.child.stderr.once("end", () => {
      this.stderrEof = true;
      try {
        this.stderr += stderrDecoder.decode();
      } catch (caught) {
        this.failOutput(
          new Error("Malformed outer fixture stderr EOF", { cause: caught }),
        );
      }
    });
    this.closed = new Promise((resolveClosed) => {
      this.child.once("close", () => {
        this.outerJoined = true;
        const error = new Error(
          `Outer closed before expected frame: ${this.stdout}\n${this.stderr}`,
        );
        this.rejectReady?.(error);
        this.rejectFinal?.(error);
        this.rejectHeld?.(error);
        resolveClosed();
      });
    });
    this.child.once("error", (error) => this.failOutput(error));
    this.child.stdin.on("error", (error) => {
      // A real pipe error belongs to the lifetime and cannot replace an
      // already saved behavioral error in withFixture below.
      this.inputErrors.push(error);
      if (this.finalReceipt === undefined) {
        this.rejectReady?.(error);
        this.rejectFinal?.(error);
        this.rejectHeld?.(error);
      }
    });
  }

  private failOutput(error: Error) {
    this.outputFailure ??= error;
    this.rejectReady?.(error);
    this.rejectFinal?.(error);
    this.rejectHeld?.(error);
  }

  private consumeLines() {
    let newline: number;
    while ((newline = this.lineBuffer.indexOf("\n")) !== -1) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      const frame = JSON.parse(line) as Value;
      if (frame.kind === "outer-ready" && !this.readyReceived) {
        this.readyReceived = true;
        this.resolveReady?.(frame);
        this.rejectReady = undefined;
      } else if (frame.kind === "outer-cleanup-start") {
        if (
          typeof frame.deadlineUnixMs !== "number" ||
          !Number.isSafeInteger(frame.deadlineUnixMs)
        )
          throw new Error("Invalid absolute cleanup deadline");
        this.cleanupDeadline = Math.min(
          this.cleanupDeadline ?? Infinity,
          frame.deadlineUnixMs,
          this.executionDeadline + cleanupMs,
        );
      } else if (
        frame.kind === "outer-held" &&
        this.resolveHeld !== undefined
      ) {
        this.resolveHeld?.(frame.value as Value);
        this.resolveHeld = undefined;
        this.rejectHeld = undefined;
      } else if (
        frame.kind === "outer-receipt" &&
        this.finalReceipt === undefined
      ) {
        this.finalReceipt = frame.value as FinalReceipt;
        this.resolveFinal?.(this.finalReceipt);
        this.resolveFinal = undefined;
        this.rejectFinal = undefined;
        if (!this.readyReceived)
          this.rejectReady?.(
            new Error("Original host failed before ready", {
              cause: this.finalReceipt.outer.primaryFailure,
            }),
          );
      } else throw new Error("Uncorrelated outer journal fixture frame");
    }
  }

  async loaded() {
    const ready = await boundedUntil(this.ready, this.executionDeadline);
    expect(ready).toMatchObject({
      kind: "outer-ready",
      hostMembershipVerified: true,
      guardHandleNonInherited: true,
      outerOutsideJob: true,
      host: {
        kind: "harness-ready",
        selfHandleNonInherited: true,
        sameSid: true,
        actorLaunches: 0,
      },
    });
  }

  async start(scenario: string) {
    if (!this.readyReceived || this.scenarioSent)
      throw new Error("Scenario preceded ready or was repeated");
    this.scenarioSent = true;
    await new Promise<void>((resolveWrite, reject) => {
      this.child.stdin.write(`${JSON.stringify({ scenario })}\n`, (error) => {
        if (error) reject(error);
        else resolveWrite();
      });
    });
  }

  async completed() {
    const receipt = await boundedUntil(
      this.final,
      this.executionDeadline + cleanupMs,
    );
    console.info(`WINDOWS_JOURNAL_OUTER_RECEIPT ${JSON.stringify(receipt)}`);
    return receipt;
  }

  async heldPhase() {
    return await boundedUntil(this.held, this.executionDeadline);
  }

  async run(scenario: string) {
    await this.start(scenario);
    const final = await this.completed();
    if (final.host === null)
      throw new Error("Original host did not produce its scenario receipt", {
        cause: final.outer.primaryFailure,
      });
    const receipt: Receipt = { ...final.host, outer: final.outer };
    console.info(`WINDOWS_JOURNAL_RECEIPT ${JSON.stringify(receipt)}`);
    return receipt;
  }

  get finalEvidence() {
    return this.finalReceipt;
  }

  get cleanupProven() {
    try {
      if (!this.spawnReturned) return true;
      const outer = this.finalReceipt?.outer;
      const local = this.finalReceipt?.host;
      const localProven =
        local === null ||
        (local !== undefined &&
          local.cleanup.failures.length === 0 &&
          local.cleanup.allObservedJoined &&
          local.cleanup.liveOwnedProcesses.length === 0);
      return (
        localProven &&
        this.outerJoined &&
        this.stdoutEof &&
        this.stderrEof &&
        this.outputFailure === undefined &&
        outer !== undefined &&
        outer.cleanup.failures.length === 0 &&
        outer.cleanup.activeProcesses === 0 &&
        outer.cleanup.allObservedJoined &&
        outer.cleanup.liveOwnedProcesses.length === 0 &&
        outer.cleanup.membershipVerified &&
        outer.cleanup.nonInherited &&
        outer.cleanup.outerOutsideJob &&
        outer.cleanup.soleJobHandle &&
        outer.cleanup.killOnClose &&
        outer.host.originalRetained &&
        outer.host.originalJoined &&
        outer.host.stdoutEof &&
        outer.host.stderrEof &&
        outer.host.stdoutError === null &&
        outer.host.stderrError === null
      );
    } catch {
      return false;
    }
  }

  close() {
    return (this.closeCompletion ??= this.closeOwned());
  }

  private async closeOwned() {
    if (!this.spawnReturned) return;
    const errors: unknown[] = [];
    this.cleanupDeadline ??= Math.min(
      Date.now() + cleanupMs,
      this.executionDeadline + cleanupMs,
    );
    try {
      if (!this.outerJoined && !this.child.stdin.destroyed) {
        if (this.finalReceipt === undefined)
          this.child.stdin.write(
            `${JSON.stringify({ close: true, cleanupDeadlineUnixMs: this.cleanupDeadline })}\n`,
          );
        this.child.stdin.end();
      }
    } catch (error) {
      errors.push(error);
    }
    if (this.outputFailure !== undefined && !this.outerJoined) {
      // Only the retained ChildProcess may be killed. Without an independent
      // final receipt this can never establish descendant cleanup.
      try {
        this.child.kill();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await boundedUntil(this.closed, this.cleanupDeadline);
    } catch (error) {
      errors.push(error);
      try {
        this.child.kill();
      } catch (killError) {
        errors.push(killError);
      }
      try {
        await boundedUntil(this.closed, this.cleanupDeadline);
      } catch (joinError) {
        errors.push(joinError);
      }
    }
    if (this.child.exitCode !== 0)
      errors.push(
        new Error(
          `Outer fixture exited with code ${this.child.exitCode}, signal ${this.child.signalCode}`,
        ),
      );
    if (this.stderr !== "")
      errors.push(new Error(`Outer fixture stderr: ${this.stderr}`));
    errors.push(...this.inputErrors);
    if (this.outputFailure !== undefined) errors.push(this.outputFailure);
    if (!this.cleanupProven)
      errors.push(
        new Error("Independent descendant cleanup is unknown or failed"),
      );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Outer fixture cleanup failed", {
        cause: errors[0],
      });
  }
}

async function withFixture(
  executable: string,
  ordinary: string,
  operation: (fixture: JournalFixture) => Promise<void>,
  control = "none",
  observation?: LifetimeEvidence,
) {
  const directory = await mkdtemp(join(tmpdir(), "zeb-journal-"));
  const evidence = observation ?? {
    directory,
    rmAttempts: 0,
    directoryRemoved: false,
    closePromiseRetained: false,
  };
  evidence.directory = directory;
  let fixture: JournalFixture | undefined;
  let primary: unknown;
  let primaryFailed = false;
  const cleanupErrors: unknown[] = [];
  try {
    fixture = new JournalFixture();
    fixture.launch(executable, ordinary, directory, control);
    await operation(fixture);
  } catch (error) {
    primary = error;
    primaryFailed = true;
  }
  if (fixture !== undefined) {
    try {
      const closing = fixture.close();
      evidence.closePromiseRetained = closing === fixture.close();
      await closing;
    } catch (error) {
      cleanupErrors.push(error);
    }
    evidence.final = fixture.finalEvidence;
  }
  if (fixture === undefined || fixture.cleanupProven) {
    try {
      evidence.rmAttempts += 1;
      await rm(directory, { recursive: true, force: true });
      try {
        await access(directory);
        throw new Error("Exact fixture directory remains after rm");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        evidence.directoryRemoved = true;
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  } else
    cleanupErrors.push(
      new Error(
        `Exact fixture directory retained because process cleanup is unproven: ${directory}`,
      ),
    );
  console.info(`WINDOWS_JOURNAL_LIFETIME ${JSON.stringify(evidence)}`);
  if (primaryFailed && cleanupErrors.length === 0) throw primary;
  if (primaryFailed)
    throw new AggregateError(
      [primary, ...cleanupErrors],
      "Journal primary and cleanup failures",
      { cause: primary },
    );
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1)
    throw new AggregateError(cleanupErrors, "Journal cleanup failures", {
      cause: cleanupErrors[0],
    });
}

windowsSuite.sequential("Windows protected journal B4-1B1b", () => {
  let executable: string;
  let ordinary: string;

  beforeAll(async () => {
    expect(
      privateMode === undefined || privateMode === "cleanup-controls",
      "Unknown ZEB_WINDOWS_JOURNAL_PRIVATE_MODE",
    ).toBe(true);
    expect(
      process.platform,
      "Explicit Windows journal tests require real Windows",
    ).toBe("win32");
    expect(
      fixtureVariable,
      "ZEB_WINDOWS_JOURNAL_FIXTURE_EXE is required",
    ).toBeDefined();
    expect(
      ordinaryVariable,
      "ZEB_WINDOWS_JOURNAL_ORDINARY_DLL is required",
    ).toBeDefined();
    executable = resolve(fixtureVariable!);
    ordinary = resolve(ordinaryVariable!);
    expect(isAbsolute(fixtureVariable!)).toBe(true);
    expect(isAbsolute(ordinaryVariable!)).toBe(true);
    await Promise.all([access(executable), access(ordinary)]);
  });

  async function run(scenario: string, check: (receipt: Receipt) => void) {
    await withFixture(executable, ordinary, async (fixture) => {
      await fixture.loaded();
      const receipt = await fixture.run(scenario);
      cleanup(receipt);
      expect(receipt.outer.primaryFailure).toBeNull();
      expect(receipt.outer.protocolFailures).toEqual([]);
      expect(receipt.outer.forced).toBe(false);
      check(receipt);
    });
  }

  async function privateCleanupControls() {
    const controls: Value[] = [];
    const primary = new Error("private_primary_before_real_close_failure");
    const originalStack = primary.stack;
    const primaryLife: LifetimeEvidence = {
      directory: "",
      rmAttempts: 0,
      directoryRemoved: false,
      closePromiseRetained: false,
    };
    let combined: unknown;
    try {
      await withFixture(
        executable,
        ordinary,
        async (fixture) => {
          await fixture.loaded();
          const receipt = await fixture.run("private-guarded");
          cleanup(receipt);
          expect(receipt.failure).toBeNull();
          expect(receipt.outer.primaryFailure).toBeNull();
          throw primary;
        },
        "close-nonzero",
        primaryLife,
      );
    } catch (error) {
      combined = error;
    }
    expect(combined).toBeInstanceOf(AggregateError);
    const aggregate = combined as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBe(primary);
    expect(aggregate.cause).toBe(primary);
    expect(primary.stack).toBe(originalStack);
    expect(aggregate.errors[1]).toBeInstanceOf(Error);
    const closeFailures: unknown[] =
      aggregate.errors[1] instanceof AggregateError
        ? aggregate.errors[1].errors
        : [aggregate.errors[1]];
    const actualCloseError = closeFailures.find(
      (error) =>
        error instanceof Error &&
        /Outer fixture exited with code 1/.test(error.message),
    ) as Error | undefined;
    expect(actualCloseError).toBeDefined();
    expect(primaryLife).toMatchObject({
      rmAttempts: 1,
      directoryRemoved: true,
      closePromiseRetained: true,
    });
    expect(primaryLife.final?.control).toBe("close-nonzero");
    independentCleanup(primaryLife.final!.outer);
    controls.push({
      control: "primary-plus-real-close-failure",
      primaryObjectPreserved: aggregate.errors[0] === primary,
      primaryCausePreserved: aggregate.cause === primary,
      primaryStackPreserved: primary.stack === originalStack,
      actualCloseError: actualCloseError!.message,
      rmAttempts: primaryLife.rmAttempts,
      directoryRemoved: primaryLife.directoryRemoved,
      closePromiseRetained: primaryLife.closePromiseRetained,
    });

    let retention: Receipt | undefined;
    await withFixture(executable, ordinary, async (fixture) => {
      await fixture.loaded();
      retention = await fixture.run("private-actor-retain");
      cleanup(retention);
      expect(retention.failure).toMatchObject({
        type: "InvalidDataException",
        message: "private_actor_retention_before_pin",
      });
      expect(retention.outer.primaryFailure).toBeNull();
      expect(retention.outer.protocolFailures).toEqual([]);
      expect(retention.actors).toHaveLength(1);
      expect(retention.actors[0]).toMatchObject({
        started: true,
        originalRetained: true,
        originalJoined: true,
        pinRetained: false,
        terminationRequested: true,
        stdoutEof: true,
        stderrEof: true,
        startupFailure: retention.failure,
      });
    });
    controls.push({
      control: "actor-retention-before-pin",
      failure: retention!.failure,
      actor: retention!.actors[0],
      outerActiveProcesses: retention!.outer.cleanup.activeProcesses,
    });

    let bootstrap: FinalReceipt | undefined;
    await withFixture(
      executable,
      ordinary,
      async (fixture) => {
        bootstrap = await fixture.completed();
        expect(bootstrap.host).toBeNull();
        independentCleanup(bootstrap.outer);
        expect(bootstrap.outer).toMatchObject({
          forced: true,
          readyForwarded: false,
          firstScenarioForwarded: false,
          protocolFailures: [],
          primaryFailure: {
            type: "InvalidDataException",
            message: "private_host_before_ready",
          },
          bootstrapFailure: {
            kind: "host-bootstrap-failure",
            actorLaunches: 0,
          },
          host: { exitCode: 1 },
        });
        expect(bootstrap.outer.cleanup.processes).toHaveLength(1);
      },
      "host-before-ready",
    );
    controls.push({
      control: "host-before-ready",
      failure: bootstrap!.outer.primaryFailure,
      firstScenarioForwarded: bootstrap!.outer.firstScenarioForwarded,
      actorLaunches: bootstrap!.outer.bootstrapFailure!.actorLaunches,
      originalHostJoined: bootstrap!.outer.host.originalJoined,
      outerActiveProcesses: bootstrap!.outer.cleanup.activeProcesses,
    });

    let held: FinalReceipt | undefined;
    let phase: Value | undefined;
    const heldLife: LifetimeEvidence = {
      directory: "",
      rmAttempts: 0,
      directoryRemoved: false,
      closePromiseRetained: false,
    };
    await withFixture(
      executable,
      ordinary,
      async (fixture) => {
        await fixture.loaded();
        await fixture.start("private-held");
        phase = await fixture.heldPhase();
        expect(phase).toMatchObject({
          kind: "host-held",
          phase: "registered-actor-loaded",
          registered: true,
          actor: {
            alive: true,
            started: true,
            originalRetained: true,
            pinRetained: true,
            originalJoined: false,
          },
        });
        const closing = fixture.close();
        expect(fixture.close()).toBe(closing);
        await closing;
        held = await fixture.completed();
        expect(held.host).toBeNull();
        independentCleanup(held.outer);
        expect(held.outer).toMatchObject({
          forced: true,
          readyForwarded: true,
          firstScenarioForwarded: true,
          protocolFailures: [],
          primaryFailure: {
            type: "InvalidDataException",
            message: "private_host_explicit_close",
          },
        });
        expect(held.outer.heldPhase).toEqual(phase);
        expect(held.outer.cleanup.processes).toHaveLength(2);
        expect(
          held.outer.cleanup.processes.some(
            (process) =>
              JSON.stringify(process.identity) ===
              JSON.stringify(object(phase!.actor).identity),
          ),
        ).toBe(true);
      },
      "none",
      heldLife,
    );
    expect(heldLife).toMatchObject({
      rmAttempts: 1,
      directoryRemoved: true,
      closePromiseRetained: true,
    });
    controls.push({
      control: "explicit-close-held-host-with-live-actor",
      heldPhase: phase,
      failure: held!.outer.primaryFailure,
      originalHostJoined: held!.outer.host.originalJoined,
      outerActiveProcesses: held!.outer.cleanup.activeProcesses,
      processes: held!.outer.cleanup.processes,
      executionTimerExpired: false,
      rmAttempts: heldLife.rmAttempts,
      directoryRemoved: heldLife.directoryRemoved,
    });
    expect(controls).toHaveLength(4);
    console.info(
      `WINDOWS_JOURNAL_PRIVATE_CONTROLS_RECEIPT ${JSON.stringify({ mode: privateMode ?? "full-positive", controls, ordinaryFileOracleExecuted: false })}`,
    );
  }

  it(
    "private harness verifies NTFS primitives and ordinary surface",
    async () => {
      await privateCleanupControls();
      if (privateMode === "cleanup-controls") return;
      await run("positive", (receipt) => {
        expect(receipt.failure).toBeNull();
        const value = object(receipt.values.positive);
        expect(value).toMatchObject({
          createNewCollisionError: 80,
          writeSucceeded: true,
          flushSucceeded: true,
          renameSucceeded: true,
          bytesEqual: true,
        });
        expect(value.beforeIdentity).toEqual(value.afterIdentity);
        const renamed = object(value.rename);
        expect(renamed).toMatchObject({
          finalNameMatches: true,
          finalParentBound: true,
          finalSameObject: true,
          finalBytesEqual: true,
        });
        const layout = object(renamed.layout);
        expect(layout).toMatchObject({
          pointerBytes: 8,
          informationClass: 10,
          headerBytes: 24,
          replaceIfExists: 0,
          rootDirectoryOffset: 8,
          rootDirectoryNull: true,
          rootHandleNonInherited: true,
          fileNameLengthOffset: 16,
          fileNameOffset: 20,
          nulTerminatorPresent: true,
          leafIsRelative: true,
          sourceParentBound: true,
          ioBytes: 16,
          ioInformationOffset: 8,
          returnedNtStatus: "00000000",
          ntStatus: "00000000",
        });
        expect(layout.parentIdentity).toEqual(layout.rootIdentity);
        identity(layout.parentIdentity);
        expect(layout.actualFileNameBytes).toBe(layout.fileNameBytes);
        expect(layout.bufferBytes).toBe(24 + (layout.fileNameBytes as number));
        const wrongRoot = object(value.wrongRoot);
        expect(wrongRoot.failure).toMatchObject({
          type: "InvalidDataException",
          stage: "independent_source_parent_binding",
          nativeError: null,
          probe: { renameAttempted: false },
        });
        const wrongProbe = object(object(wrongRoot.failure).probe);
        expect(wrongProbe.parentIdentity).not.toEqual(wrongProbe.rootIdentity);
        expect(wrongRoot.after).toEqual(wrongRoot.before);
        expect(wrongRoot.otherAfter).toEqual(wrongRoot.otherBefore);
        const renameCollision = object(value.renameCollision);
        expect(renameCollision.failure).toMatchObject({
          type: "Win32Exception",
          stage: "independent_no_replace_rename",
          nativeError: 183,
          probe: {
            informationClass: 10,
            replaceIfExists: 0,
            rootDirectoryNull: true,
            sourceParentBound: true,
            returnedNtStatus: "c0000035",
            ntStatus: "c0000035",
          },
        });
        expect(renameCollision.targetAfter).toEqual(
          renameCollision.targetBefore,
        );
        expect(renameCollision.sourceAfter).toEqual(
          renameCollision.sourceBefore,
        );
        expect(renameCollision.sourceTempRetained).toBe(true);
        expect(value.rootDeleteIntent).toEqual({
          success: false,
          nativeError: 32,
        });
        file(value.file);
        file(value.root, true);
        expect(object(value.volume)).toMatchObject({
          filesystem: "NTFS",
          driveType: 3,
          persistentAcls: true,
          guidMapped: true,
        });
        expect(value.ordinaryHasJournalApi).toBe(true);
        expect(value.ordinaryTestOnlyTypes).toEqual([]);
        expect(value.unicode).toBe(unicode);
        expect(
          Buffer.from(value.unicodeBase64 as string, "base64").toString("utf8"),
        ).toBe(unicode);
        const streams = object(value.encodings);
        for (const current of Object.values(streams)) encoding(current);
        expect(Object.keys(streams)).toHaveLength(6);
        expect(value.childStderr).toEqual([unicode]);
      });
      console.info(
        `WINDOWS_JOURNAL_ORDINARY_POSITIVE_RECEIPT ${JSON.stringify({ mode: "full-positive", ordinaryFileOracleExecuted: true })}`,
      );
    },
    testMs,
  );

  it(
    "J1 protected reservation and Unicode publication reopen",
    async () => {
      await run("J1", (receipt) => {
        // The stub's deliberate RED is this behavioral assertion. Setup and
        // exact-process cleanup have already been checked independently above.
        expect(receipt.reservation?.status).toBe("Created");
        expect(receipt.failure).toBeNull();
        const reserved = result(receipt.reservation, "Created");
        expect(reserved.ownerPresent).toBe(true);
        const value = object(receipt.values.J1);
        file(value.root, true);
        file(value.marker);
        file(value.reservationFile);
        file(value.recordFile);
        expect(object(value.marker).length).toBe(0);
        expect(value.reservationRenameIdentity).toEqual(
          object(value.reservationFile).identity,
        );
        expect(value.recordRenameIdentity).toEqual(
          object(value.recordFile).identity,
        );
        const publication = result(value.publication, "Created");
        expect(publication.ownerPresent).toBe(false);
        expect(object(publication.snapshot!.record).label).toBe(unicode);
        expect(result(value.reopened, "Existing").snapshot).toEqual(
          reserved.snapshot,
        );
        expect(result(value.read, "Existing").snapshot).toEqual(
          publication.snapshot,
        );
      });
    },
    testMs,
  );

  it(
    "J2 atomic reservation and full scope identity",
    async () => {
      await run("J2", (receipt) => {
        expect(receipt.failure).toBeNull();
        const value = object(receipt.values.J2);
        const racers = objects(value.racers).map((entry) => result(entry));
        expect(
          racers.filter((entry) => entry.status === "Created"),
        ).toHaveLength(1);
        expect(racers.filter((entry) => entry.ownerPresent)).toHaveLength(1);
        for (const loser of racers.filter(
          (entry) => entry.status !== "Created",
        ))
          expect(loser.ownerPresent).toBe(false);
        const duplicate = result(value.duplicate, "Existing");
        expect(duplicate.ownerPresent).toBe(false);
        expect(duplicate.snapshot!.executionId).toBe(value.winnerExecutionId);
        expect(duplicate.snapshot!.executionId).not.toBe(
          value.duplicateExecutionId,
        );
        expect(objects(value.scopeMismatches)).toHaveLength(5);
        for (const entry of objects(value.scopeMismatches))
          result(entry.result, "Unknown");
        expect(result(value.independentTicket, "Created").ownerPresent).toBe(
          true,
        );
        for (const entry of objects(value.invalidArguments))
          expect(entry.errorType).toBe("ArgumentException");
        expect(objects(value.invalidArguments).length).toBeGreaterThanOrEqual(
          10,
        );
        expect(result(value.jsNonWhitespace, "Created").ownerPresent).toBe(
          true,
        );
        expect(
          objects(value.inconsistentHistory).map((entry) => entry.name),
        ).toEqual(["orphan-final", "orphan-temp"]);
        for (const entry of objects(value.inconsistentHistory)) {
          result(entry.result, "Unknown");
          expect(entry.beforeOriginal).toEqual(entry.afterOriginal);
          expect(entry.markerRetained).toBe(true);
          expect(entry.fileCount).toBe(2);
        }
        const missing = object(value.missingRoot);
        result(missing.result, "Unknown");
        expect(missing.directoryCreated).toBe(false);
      });
    },
    testMs,
  );

  it(
    "J3 same record replay and real no-overwrite collision",
    async () => {
      await run("J3", (receipt) => {
        expect(receipt.failure).toBeNull();
        const value = object(receipt.values.J3);
        const first = result(value.first, "Created");
        expect(first.ownerPresent).toBe(false);
        expect(result(value.replay, "Existing").snapshot).toEqual(
          first.snapshot,
        );
        result(value.changed, "Unknown");
        const collision = result(value.collision, "Unknown");
        expect(collision.diagnostic!.nativeError).toBe(183);
        expect(value.before).toEqual(value.after);
        expect(objects(value.retainedTemps)).not.toHaveLength(0);
        expect(value.pausedStage).toBe("RecordFlushed");
      });
    },
    testMs,
  );

  it(
    "J4 strict reopen rejects malformed and replaced evidence",
    async () => {
      await run("J4", (receipt) => {
        expect(receipt.failure).toBeNull();
        const variants = objects(receipt.values.J4);
        expect(variants.map((entry) => entry.name)).toEqual([
          "invalid-utf8",
          "partial-json",
          "trailing-json",
          "duplicate-key",
          "nested-duplicate-key",
          "unknown-key",
          "wrong-version",
          "wrong-type",
          "wrong-scope",
          "root-identity",
          "marker-identity",
          "final-identity",
          "replaced-final",
          "replaced-marker",
          "replaced-root",
          "hardlink",
          "extra-ace",
          "reparse-root",
          "nonordinary-final",
        ]);
        for (const entry of variants) {
          result(entry.result, "Unknown");
          expect(entry.before, String(entry.name)).toEqual(entry.after);
          expect(entry.freshLeaf).toBe(true);
        }
        const reservations = objects(receipt.values.J4Reservation);
        expect(reservations.map((entry) => entry.name)).toEqual([
          "invalid-utf8",
          "partial-json",
          "trailing-json",
          "duplicate-key",
          "unknown-key",
          "wrong-version",
          "wrong-type",
          "wrong-scope",
          "root-identity",
          "marker-identity",
          "final-identity",
          "wrong-kind",
        ]);
        for (const entry of reservations) {
          result(entry.result, "Unknown");
          result(entry.duplicate, "Unknown");
          expect(entry.before, String(entry.name)).toEqual(entry.after);
          expect(entry.freshLeaf).toBe(true);
        }
      });
    },
    testMs,
  );

  it(
    "J5 pre-publication crash preserves unknown reservation",
    async () => {
      await run("J5", (receipt) => {
        expect(receipt.failure).toBeNull();
        const variants = objects(receipt.values.J5);
        expect(variants.map((entry) => entry.stage)).toEqual([
          "MarkerCreated",
          "ReservationWritten",
          "ReservationFlushed",
        ]);
        for (const entry of variants) {
          expect(entry.replyBeforeKill).toBe(false);
          expect(entry.originalProcessJoined).toBe(true);
          result(entry.inspected, "Unknown");
          result(entry.duplicate, "Unknown");
          expect(entry.before).toEqual(entry.after);
          expect(entry.markerRetained).toBe(true);
          expect(entry.finalPresent).toBe(false);
          expect(entry.tempCount).toBe(entry.stage === "MarkerCreated" ? 0 : 1);
        }
      });
    },
    testMs,
  );

  it(
    "J6 post-publication crash reopens original record",
    async () => {
      await run("J6", (receipt) => {
        expect(receipt.failure).toBeNull();
        const variants = objects(receipt.values.J6);
        expect(variants.map((entry) => entry.stage)).toEqual([
          "ReservationRenamed",
          "ReservationVerified",
          "RecordRenamed",
          "RecordVerified",
        ]);
        for (const entry of variants) {
          expect(entry.replyBeforeKill).toBe(false);
          expect(entry.originalProcessJoined).toBe(true);
          const inspected = result(entry.inspected, "Existing");
          expect(inspected.snapshot!.executionId).toBe(entry.executionId);
          expect(result(entry.duplicate, "Existing").ownerPresent).toBe(false);
          if (String(entry.stage).startsWith("Record"))
            expect(result(entry.read, "Existing").snapshot!.record).toEqual(
              entry.record,
            );
          expect(entry.before).toEqual(entry.after);
        }
      });
    },
    testMs,
  );

  it(
    "J7 real write and flush failures never publish success",
    async () => {
      await run("J7", (receipt) => {
        expect(receipt.failure).toBeNull();
        const variants = objects(receipt.values.J7);
        expect(variants.map((entry) => entry.name)).toEqual([
          "reservation-WriteReadOnly",
          "reservation-FlushReadOnly",
          "record-WriteReadOnly",
          "record-FlushReadOnly",
        ]);
        for (const entry of variants) {
          const failed = result(entry.result, "Unknown");
          const io = object(entry.io);
          expect(io.originalIdentity).toEqual(io.selectedIdentity);
          expect(io.originalNonInherited).toBe(true);
          expect(io.selectedNonInherited).toBe(true);
          expect((io.selectedGrantedAccess as number) & 2).toBe(0);
          expect(io.independentFailureError).toBe(5);
          expect(failed.diagnostic!.nativeError).toBe(
            io.independentFailureError,
          );
          expect(entry.finalPresent).toBe(false);
          expect(entry.tempCount).toBe(1);
          expect(entry.ioBoundaryCount).toBe(1);
          if (String(entry.name).startsWith("record-")) {
            const replay = object(entry.uncertainReplay);
            const repeated = result(replay.result, "Unknown");
            expect(repeated.diagnostic).toEqual(failed.diagnostic);
            expect(replay.before).toEqual(replay.after);
            expect(replay.newStages).toEqual([]);
          } else expect(entry.uncertainReplay).toBeNull();
        }
      });
    },
    testMs,
  );

  it(
    "J8 live pin and read-only inspect preserve evidence",
    async () => {
      await run("J8", (receipt) => {
        expect(receipt.failure).toBeNull();
        const value = object(receipt.values.J8);
        const attempts = objects(value.attempts);
        expect(attempts).toHaveLength(10);
        for (const attempt of attempts) {
          expect(attempt.success).toBe(false);
          if (attempt.leaf === "records-root")
            expect([5, 32]).toContain(attempt.nativeError);
          else expect(attempt.nativeError).toBe(32);
        }
        for (const observed of objects(value.liveInspections)) {
          expect(["Unknown", "Existing"]).toContain(
            result(observed.inspect).status,
          );
          expect(["Unknown", "Existing"]).toContain(
            result(observed.read).status,
          );
        }
        expect(value.before).toEqual(value.after);
        expect(result(value.afterDispose, "Existing").ownerPresent).toBe(false);
        expect(value.disposedPublishError).toBe("ObjectDisposedException");
        expect(value.doubleDisposeSucceeded).toBe(true);
        const empty = object(value.emptyReadOnly);
        expect(empty.before).toEqual([]);
        expect(empty.after).toEqual([]);
        result(empty.inspect, "Unknown");
        result(empty.read, "Unknown");
      });
    },
    testMs,
  );
});
