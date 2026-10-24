import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { runnerLimits } from "./storage-fixtures.js";

type Identity = { pid: number; createdFileTime: string };
type Observation = {
  identity: Identity;
  alive: boolean;
  inOriginalJob: boolean;
};
type JobSecurity = {
  ownerMatchesCurrentUser: boolean;
  daclPresent: boolean;
  daclProtected: boolean;
  aceCount: number;
  plainAllow: boolean;
  aceSidMatchesCurrentUser: boolean;
  aceFlags: number;
  aceMask: number;
  isCallback: boolean;
  opaqueLength: number;
  additionalWorldQueryAce: boolean;
};
type JobEvidence = {
  activeProcesses: number;
  totalProcesses: number;
  inOriginalJob: boolean;
  security: JobSecurity;
  queryHandleFlags: number;
};
type SecurityControl = {
  evidence: JobEvidence;
  creatorHandleFlags: number;
  creatorHandleClosed: boolean;
  queryHandlesClosed: boolean;
};
type Prepared = {
  engine: Observation;
  jobName: string;
  activeProcesses: number;
  totalProcesses: number;
  rawInOriginalJob: boolean;
  security: JobSecurity;
  queryHandleFlags: number;
  queryHandlesClosed: boolean;
  ownerHandleFlags: { jobHandleFlags: number; processHandleFlags: number };
  isPrepared: boolean;
  isSealed: boolean;
  markerExists: boolean;
};
type NativeObservation = {
  engineIdentity: Identity;
  processSignaled: boolean;
  inOriginalJob: boolean;
  activeProcesses: number;
  totalProcesses: number;
  jobHandleFlags: number;
  processHandleFlags: number;
  authorized: boolean;
  sealed: boolean;
};
type NativeInspection = {
  observation: NativeObservation;
  independent: Prepared;
};
type Tree = {
  parent: Observation;
  child: Observation;
  grandchild: Observation;
  activeProcesses: number;
  argv: string[];
  sentinelSignaled: boolean;
};
type Terminal = {
  treeExit: { engineExitCode: number; activeProcesses: number };
  activeProcesses: number;
  processes: Observation[];
  stdoutEof: boolean;
  stderrEof: boolean;
  stdout: string[];
  stderr: string[];
  markers: string[];
  isSealed: boolean;
};
type Reply = {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: {
    type: string;
    stage: string;
    message: string;
    nativeErrorCode?: number;
  };
};
type Ownership = {
  membershipVerified: boolean;
  observedOwnedProcessCount: number;
  liveOwnedProcesses: number;
  noLiveOwnedProcesses: boolean;
  allObservedJoined: boolean;
};
type ChildClose = { code: number | null; signal: NodeJS.Signals | null };

const fixtureExe = process.env.ZEB_WINDOWS_FIXTURE_EXE;
const requested =
  process.env.ZEB_RUN_WINDOWS_JOB_OS === "1" || fixtureExe !== undefined;
const windowsSuite =
  process.platform === "win32" || requested ? describe : describe.skip;
const executionMs = runnerLimits.executionTimeoutMs;
const cleanupMs = runnerLimits.cancelGraceMs;
const testMs = executionMs + cleanupMs;

async function bounded<T>(
  promise: Promise<T>,
  milliseconds = executionMs,
): Promise<T> {
  const signal = AbortSignal.timeout(milliseconds);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Fixture deadline exceeded")),
        { once: true },
      );
    }),
  ]);
}

class NativeFixture {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private sequence = 0;
  private readonly closed: Promise<ChildClose>;
  private readonly ready: Promise<{ coreAssembly: string; testBuild: boolean }>;
  private stderr = "";
  private stdoutBuffer = "";
  private stdoutEof = false;
  private stderrEof = false;
  private originalClose: ChildClose | null = null;
  private readonly readFailures: Error[] = [];
  private nativeGuardCleanup: { joined: boolean; ownership: Ownership } | null =
    null;
  private engineEof: { stdoutEof: boolean; stderrEof: boolean } | null = null;

  constructor(executable: string, directory: string) {
    this.child = spawn(
      executable,
      ["harness", directory, String(executionMs), String(cleanupMs)],
      {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.closed = new Promise<ChildClose>((resolveClosed) => {
      this.child.once("close", (code, signal) => {
        this.originalClose = { code, signal };
        for (const pending of this.pending.values())
          pending.reject(new Error(`Fixture closed: ${this.stderr}`));
        this.pending.clear();
        resolveClosed(this.originalClose);
      });
    });
    this.ready = new Promise((resolveReady, rejectReady) => {
      const fail = (error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.readFailures.push(failure);
        rejectReady(failure);
        for (const pending of this.pending.values()) pending.reject(failure);
        this.pending.clear();
      };
      this.child.once("error", fail);
      this.child.stdin.once("error", fail);
      this.child.stdout.once("error", fail);
      this.child.stderr.once("error", fail);
      this.child.once("close", () =>
        rejectReady(new Error(`Fixture closed before ready: ${this.stderr}`)),
      );
      const receive = (line: string) => {
        let frame: Reply & {
          event?: string;
          coreAssembly: string;
          testBuild: boolean;
        };
        try {
          frame = JSON.parse(line) as typeof frame;
        } catch {
          fail(new Error("Invalid JSON fixture stdout."));
          return;
        }
        if (frame.event === "harness-ready") {
          resolveReady(frame);
          return;
        }
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.value);
        else {
          process.stdout.write(
            `[B4-JOB-ERROR] ${JSON.stringify(frame.error)}\n`,
          );
          pending.reject(
            new Error(
              `${frame.error?.type} at ${frame.error?.stage}: ${frame.error?.message}`,
            ),
          );
        }
      };
      const stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
      const stderrDecoder = new TextDecoder("utf-8", { fatal: true });
      const consume = (text: string) => {
        this.stdoutBuffer += text;
        let newline: number;
        while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
          const line = this.stdoutBuffer.slice(0, newline);
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          receive(line);
        }
      };
      this.child.stdout.on("data", (chunk: Uint8Array) => {
        try {
          consume(stdoutDecoder.decode(chunk, { stream: true }));
        } catch (error) {
          fail(error);
        }
      });
      this.child.stderr.on("data", (chunk: Uint8Array) => {
        try {
          this.stderr += stderrDecoder.decode(chunk, { stream: true });
        } catch (error) {
          fail(error);
        }
      });
      this.child.stdout.once("end", () => {
        this.stdoutEof = true;
        try {
          consume(stdoutDecoder.decode());
          if (this.stdoutBuffer.length > 0) receive(this.stdoutBuffer);
          this.stdoutBuffer = "";
        } catch (error) {
          fail(error);
        }
      });
      this.child.stderr.once("end", () => {
        this.stderrEof = true;
        try {
          this.stderr += stderrDecoder.decode();
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  async loaded() {
    const ready = await bounded(this.ready);
    expect(ready.coreAssembly).toContain("WindowsSupervisor");
    expect(ready.testBuild).toBe(true);
  }

  async command<T>(
    op: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const id = ++this.sequence;
    const result = new Promise<unknown>((resolveResult, reject) => {
      this.pending.set(id, { resolve: resolveResult, reject });
      this.child.stdin.write(
        `${JSON.stringify({ id, op, ...payload })}\n`,
        (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
    const value = (await bounded(result)) as T;
    if (
      [
        "prepare",
        "inspect-native",
        "tamper-job-security",
        "join",
        "dispose",
        "prepare-failure",
        "guard-control",
      ].includes(op)
    )
      process.stdout.write(
        `[B4-JOB-RECEIPT] ${JSON.stringify({ op, value })}\n`,
      );
    if (op === "join") {
      const terminal = value as Terminal;
      this.engineEof = {
        stdoutEof: terminal.stdoutEof,
        stderrEof: terminal.stderrEof,
      };
    }
    return value;
  }

  lifecycleEvidence() {
    return {
      nativeGuardCleanup: this.nativeGuardCleanup,
      harness: {
        originalClose: this.originalClose,
        stdoutEof: this.stdoutEof,
        stderrEof: this.stderrEof,
        strictUtf8: this.readFailures.length === 0,
        errors: this.readFailures.map((error) => error.message),
        forcedFallback: false,
      },
      engineEof: this.engineEof,
    };
  }

  async close() {
    const failures: unknown[] = [];
    try {
      const cleanup = await this.command<{
        joined: boolean;
        ownership: Ownership;
      }>("cleanup");
      this.nativeGuardCleanup = cleanup;
      expect(cleanup.joined).toBe(true);
      expectNoOwnedProcesses(cleanup.ownership);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        this.child.stdin.end();
      } catch (error) {
        failures.push(error);
      }
      try {
        await bounded(this.closed, testMs);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      expect(this.originalClose, this.stderr).toEqual({
        code: 0,
        signal: null,
      });
      expect(this.stdoutEof, "Harness stdout must reach actual EOF").toBe(true);
      expect(this.stderrEof, "Harness stderr must reach actual EOF").toBe(true);
      expect(
        this.readFailures,
        "Harness streams must decode as strict UTF-8",
      ).toEqual([]);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Fixture cleanup and harness close failed",
      );
  }
}

async function ownedTempTarget(directory: string, prefix: string) {
  const target = resolve(directory);
  const canonical = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  if (
    canonical(dirname(target)) !== canonical(resolve(tmpdir())) ||
    !basename(target).startsWith(prefix)
  )
    throw new Error(
      "Fixture cleanup target is not its newly owned temp directory.",
    );
  const metadata = await lstat(target);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    canonical(await realpath(target)) !== canonical(target)
  )
    throw new Error(
      "Fixture cleanup target is not an ordinary owned directory.",
    );
  return target;
}

function expectJobSecurity(security: JobSecurity) {
  expect(security).toEqual({
    ownerMatchesCurrentUser: true,
    daclPresent: true,
    daclProtected: true,
    aceCount: 1,
    plainAllow: true,
    aceSidMatchesCurrentUser: true,
    aceFlags: 0,
    aceMask: 0x001f003f,
    isCallback: false,
    opaqueLength: 0,
    additionalWorldQueryAce: false,
  });
}

function expectSecurityControl(control: SecurityControl) {
  expectJobSecurity(control.evidence.security);
  expect(control.evidence).toMatchObject({
    activeProcesses: 0,
    totalProcesses: 0,
    inOriginalJob: false,
  });
  expect(control.evidence.queryHandleFlags & 1).toBe(0);
  expect(control.creatorHandleFlags & 1).toBe(0);
  expect(control.creatorHandleClosed).toBe(true);
  expect(control.queryHandlesClosed).toBe(true);
}

function expectIndependent(prepared: Prepared) {
  expectJobSecurity(prepared.security);
  expect(prepared.queryHandleFlags & 1).toBe(0);
  expect(prepared.queryHandlesClosed).toBe(true);
  expect(prepared.ownerHandleFlags.jobHandleFlags & 1).toBe(0);
  expect(prepared.ownerHandleFlags.processHandleFlags & 1).toBe(0);
}

function expectNative(
  inspection: NativeInspection,
  original: Prepared,
  state: Partial<NativeObservation>,
) {
  const { observation, independent } = inspection;
  expectIndependent(independent);
  expect(independent.jobName).toBe(original.jobName);
  expect(independent.engine.identity).toEqual(original.engine.identity);
  expect(observation.engineIdentity).toEqual(original.engine.identity);
  expect(observation.processSignaled).toBe(!independent.engine.alive);
  expect(observation.inOriginalJob).toBe(independent.rawInOriginalJob);
  expect(observation.activeProcesses).toBe(independent.activeProcesses);
  expect(observation.totalProcesses).toBe(independent.totalProcesses);
  expect(observation.jobHandleFlags).toBe(
    independent.ownerHandleFlags.jobHandleFlags,
  );
  expect(observation.processHandleFlags).toBe(
    independent.ownerHandleFlags.processHandleFlags,
  );
  expect(observation).toMatchObject(state);
}

function expectLive(observation: Observation, expectedMembership = true) {
  expect(observation.identity.pid).toBeGreaterThan(0);
  expect(observation.identity.createdFileTime).toMatch(/^\d+$/);
  expect(BigInt(observation.identity.createdFileTime)).toBeGreaterThan(0n);
  expect(observation.alive).toBe(true);
  expect(observation.inOriginalJob).toBe(expectedMembership);
}

function expectTerminal(terminal: Terminal) {
  expect(terminal.treeExit.activeProcesses).toBe(0);
  expect(terminal.activeProcesses).toBe(0);
  expect(terminal.processes.length).toBeGreaterThan(0);
  expect(terminal.processes.every((process) => !process.alive)).toBe(true);
  expect(terminal.stdoutEof).toBe(true);
  expect(terminal.stderrEof).toBe(true);
  expect(terminal.isSealed).toBe(true);
}

function expectNoOwnedProcesses(ownership: Ownership) {
  expect(ownership).toMatchObject({
    membershipVerified: true,
    liveOwnedProcesses: 0,
    noLiveOwnedProcesses: true,
    allObservedJoined: true,
  });
}

windowsSuite.sequential("Windows Job primitive B4-1A", () => {
  let executable: string;
  let directReceipt: {
    identity: Identity;
    handle: string;
    handleValid: boolean;
    securityControl: SecurityControl;
    stdout: string;
    stderr: string;
  };

  beforeAll(async () => {
    if (process.platform !== "win32")
      throw new Error(
        "Windows OS execution was requested on a non-Windows host",
      );
    if (!fixtureExe)
      throw new Error(
        "ZEB_WINDOWS_FIXTURE_EXE must name the built self-contained Windows fixture",
      );
    executable = resolve(fixtureExe);
    await access(executable);
    const directory = await mkdtemp(join(tmpdir(), "zeb-direct-control-"));
    const marker = join(directory, "first-action.marker");
    const child = spawn(executable, ["direct", marker], {
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stdoutEof = false;
    let stderrEof = false;
    const lifetime: { originalClose: ChildClose | null } = {
      originalClose: null,
    };
    let forcedFallback = false;
    const readFailures: unknown[] = [];
    const failures: unknown[] = [];
    const stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
    const stderrDecoder = new TextDecoder("utf-8", { fatal: true });
    const closed = new Promise<ChildClose>((resolveClosed) => {
      child.once("close", (code, signal) => {
        lifetime.originalClose = { code, signal };
        resolveClosed(lifetime.originalClose);
      });
    });
    child.once("error", (error) => readFailures.push(error));
    child.stdout.once("error", (error) => readFailures.push(error));
    child.stderr.once("error", (error) => readFailures.push(error));
    child.stdout.on("data", (chunk: Uint8Array) => {
      try {
        stdout += stdoutDecoder.decode(chunk, { stream: true });
      } catch (error) {
        readFailures.push(error);
      }
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      try {
        stderr += stderrDecoder.decode(chunk, { stream: true });
      } catch (error) {
        readFailures.push(error);
      }
    });
    child.stdout.once("end", () => {
      stdoutEof = true;
      try {
        stdout += stdoutDecoder.decode();
      } catch (error) {
        readFailures.push(error);
      }
    });
    child.stderr.once("end", () => {
      stderrEof = true;
      try {
        stderr += stderrDecoder.decode();
      } catch (error) {
        readFailures.push(error);
      }
    });
    try {
      expect(await bounded(closed), stderr).toEqual({ code: 0, signal: null });
      expect(stdoutEof).toBe(true);
      expect(stderrEof).toBe(true);
      expect(readFailures).toEqual([]);
      const ready = JSON.parse(stdout.trim()) as Omit<
        typeof directReceipt,
        "stdout" | "stderr"
      >;
      expect(await readFile(marker, "utf8")).toBe("direct-first-action");
      expect(ready.handleValid).toBe(true);
      expect(BigInt(ready.handle)).toBeGreaterThan(0n);
      expectSecurityControl(ready.securityControl);
      directReceipt = { ...ready, stdout, stderr };
      process.stdout.write(
        `[B4-JOB-SECURITY-CONTROL] ${JSON.stringify(ready.securityControl)}\n`,
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      if (child.exitCode === null && child.signalCode === null) {
        forcedFallback = true;
        if (!child.kill())
          throw new Error(
            "Original direct child emergency termination was not accepted.",
          );
        await bounded(closed, cleanupMs);
      }
    } catch (error) {
      failures.push(error);
    }
    let removal: "retained" | "completed" | "failed" = "retained";
    let rmAttempted = false;
    if (
      lifetime.originalClose?.code === 0 &&
      lifetime.originalClose.signal === null &&
      stdoutEof &&
      stderrEof &&
      readFailures.length === 0 &&
      !forcedFallback
    ) {
      try {
        const target = await ownedTempTarget(directory, "zeb-direct-control-");
        rmAttempted = true;
        await rm(target, { recursive: true });
        removal = "completed";
      } catch (error) {
        removal = rmAttempted ? "failed" : "retained";
        failures.push(error);
      }
    }
    process.stdout.write(
      `[B4-JOB-LIFETIME] ${JSON.stringify({ stage: "direct", nativeGuardCleanup: null, harness: { originalClose: lifetime.originalClose, stdoutEof, stderrEof, strictUtf8: readFailures.length === 0, forcedFallback, errors: readFailures.map((error) => (error instanceof Error ? error.message : String(error))) }, engineEof: null, temp: { directory, removal, rmAttempted } })}\n`,
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Direct fixture and lifecycle failed");
  }, testMs);

  async function withFixture(run: (fixture: NativeFixture) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "zeb-job-fixture-"));
    const fixture = new NativeFixture(executable, directory);
    const failures: unknown[] = [];
    try {
      await fixture.loaded();
      await run(fixture);
    } catch (error) {
      failures.push(error);
    }
    let cleanupHealthy = false;
    try {
      await fixture.close();
      cleanupHealthy = true;
    } catch (error) {
      failures.push(error);
    }
    let removal: "retained" | "completed" | "failed" = "retained";
    let rmAttempted = false;
    if (cleanupHealthy) {
      try {
        const target = await ownedTempTarget(directory, "zeb-job-fixture-");
        rmAttempted = true;
        await rm(target, { recursive: true });
        removal = "completed";
      } catch (error) {
        removal = rmAttempted ? "failed" : "retained";
        failures.push(error);
      }
    }
    process.stdout.write(
      `[B4-JOB-LIFETIME] ${JSON.stringify({ stage: "harness", ...fixture.lifecycleEvidence(), cleanupHealthy, temp: { directory, removal, rmAttempted } })}\n`,
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Fixture execution and reclamation failed",
      );
  }

  async function authorizeTree(fixture: NativeFixture, argv: string[] = []) {
    const prepared = await fixture.command<Prepared>("prepare", { argv });
    expectIndependent(prepared);
    expectLive(prepared.engine);
    expect(prepared).toMatchObject({
      activeProcesses: 1,
      totalProcesses: 1,
      rawInOriginalJob: true,
    });
    expect(await fixture.command("authorize")).toMatchObject({
      started: true,
      isSealed: false,
    });
    const tree = await fixture.command<Tree>("ready-tree");
    expectLive(tree.parent);
    expectLive(tree.child);
    expectLive(tree.grandchild);
    expect(tree.activeProcesses).toBe(3);
    return { prepared, tree };
  }

  it("direct fixture positive control writes a real first-action marker and opens a process handle", () => {
    expect(directReceipt.identity.pid).toBeGreaterThan(0);
    expect(directReceipt.identity.createdFileTime).toMatch(/^\d+$/);
    expect(directReceipt.handleValid).toBe(true);
    expect(directReceipt.stderr).toContain("direct-stderr");
  });

  it("B4-B2 independent protected Job security control validates the current SID owner and sole noninherited all-access ACE", () => {
    expectSecurityControl(directReceipt.securityControl);
  });

  it(
    "independent ownership guard detects and joins a harmless suspended child before its first action",
    async () => {
      await withFixture(async (fixture) => {
        const control = await fixture.command<{
          detected: boolean;
          process: Observation;
          markerBeforeReclaim: boolean;
          markerAfterReclaim: boolean;
          ownership: Ownership;
        }>("guard-control");
        expect(control.detected).toBe(true);
        expectLive(control.process, false);
        expect(control.markerBeforeReclaim).toBe(false);
        expect(control.markerAfterReclaim).toBe(false);
        expect(control.ownership.observedOwnedProcessCount).toBe(1);
        expectNoOwnedProcesses(control.ownership);
      });
    },
    testMs,
  );

  it(
    "B4-1A prepared suspended engine is live in the original Job before its first action",
    async () => {
      await withFixture(async (fixture) => {
        const prepared = await fixture.command<Prepared>("prepare");
        // This independent security assertion is deliberately before production Inspect.
        expectIndependent(prepared);
        expectLive(prepared.engine);
        expect(prepared.jobName).toMatch(/^Local\\Zeb-/);
        expect(prepared).toMatchObject({
          activeProcesses: 1,
          totalProcesses: 1,
          rawInOriginalJob: true,
          isPrepared: true,
          isSealed: false,
          markerExists: false,
        });
        const barrier = await fixture.command<Prepared>("inspect");
        expectLive(barrier.engine);
        expect(barrier.markerExists).toBe(false);
        expectNative(
          await fixture.command<NativeInspection>("inspect-native"),
          prepared,
          {
            authorized: false,
            sealed: false,
            processSignaled: false,
            inOriginalJob: true,
            activeProcesses: 1,
            totalProcesses: 1,
          },
        );
        await fixture.command("seal");
        const sealed =
          await fixture.command<NativeInspection>("inspect-native");
        expectNative(sealed, prepared, {
          authorized: false,
          sealed: true,
          processSignaled: false,
          inOriginalJob: true,
          activeProcesses: 1,
          totalProcesses: 1,
        });
        expect(sealed.independent.isPrepared).toBe(false);
        expect(sealed.independent.markerExists).toBe(false);
        await fixture.command("force");
        expect(await fixture.command("authorize")).toMatchObject({
          started: false,
          isSealed: true,
        });
        const terminal = await fixture.command<Terminal>("join");
        expectTerminal(terminal);
        expect(terminal.markers).toEqual([]);
        expectNative(
          await fixture.command<NativeInspection>("inspect-native"),
          prepared,
          {
            authorized: false,
            sealed: true,
            processSignaled: true,
            activeProcesses: 0,
            totalProcesses: 1,
          },
        );
        const tampered = await fixture.command<{
          evidence: JobEvidence;
          mutationHandleClosed: boolean;
          queryHandlesClosed: boolean;
        }>("tamper-job-security");
        expect(tampered).toMatchObject({
          evidence: {
            activeProcesses: 0,
            totalProcesses: 1,
            security: {
              ownerMatchesCurrentUser: true,
              daclPresent: true,
              daclProtected: true,
              aceCount: 2,
              plainAllow: true,
              aceSidMatchesCurrentUser: true,
              aceFlags: 0,
              aceMask: 0x001f003f,
              isCallback: false,
              opaqueLength: 0,
              additionalWorldQueryAce: true,
            },
          },
          mutationHandleClosed: true,
          queryHandlesClosed: true,
        });
        await expect(fixture.command("inspect-native")).rejects.toThrow(
          "InvalidOperationException at inspect-native: Original Job security is inconsistent.",
        );
      });
    },
    testMs,
  );

  it(
    "authorize once starts an exactly contained parent, child and grandchild without another resume",
    async () => {
      await withFixture(async (fixture) => {
        const { prepared, tree: original } = await authorizeTree(fixture);
        expectNative(
          await fixture.command<NativeInspection>("inspect-native"),
          prepared,
          {
            authorized: true,
            sealed: false,
            processSignaled: false,
            inOriginalJob: true,
            activeProcesses: 3,
            totalProcesses: 3,
          },
        );
        expect(await fixture.command("authorize")).toMatchObject({
          started: false,
          isSealed: false,
        });
        const repeated = await fixture.command<Tree>("observe-tree");
        expect(repeated).toEqual(original);
        expectNative(
          await fixture.command<NativeInspection>("inspect-native"),
          prepared,
          {
            authorized: true,
            sealed: false,
            processSignaled: false,
            inOriginalJob: true,
            activeProcesses: 3,
            totalProcesses: 3,
          },
        );
        await fixture.command("release", { role: "all" });
        const terminal = await fixture.command<Terminal>("join");
        expectTerminal(terminal);
        expect(terminal.treeExit.engineExitCode).toBe(0);
        expectNative(
          await fixture.command<NativeInspection>("inspect-native"),
          prepared,
          {
            authorized: true,
            sealed: true,
            processSignaled: true,
            activeProcesses: 0,
            totalProcesses: 3,
          },
        );
        expect(terminal.markers.sort()).toEqual([
          "child",
          "grandchild",
          "parent",
        ]);
      });
    },
    testMs,
  );

  it(
    "parent exit cannot finish an all-tree wait while descendants remain live and responsive",
    async () => {
      await withFixture(async (fixture) => {
        const { prepared } = await authorizeTree(fixture);
        await fixture.command("begin-wait");
        await fixture.command("release", { role: "parent" });
        const pending = await fixture.command<{
          pending: boolean;
          activeProcesses: number;
          child: Observation;
          grandchild: Observation;
        }>("assert-wait-pending");
        expect(pending.pending).toBe(true);
        expect(pending.activeProcesses).toBe(2);
        expectLive(pending.child);
        expectLive(pending.grandchild);
        expectNative(
          await fixture.command<NativeInspection>("inspect-native"),
          prepared,
          {
            authorized: true,
            sealed: false,
            processSignaled: true,
            activeProcesses: 2,
            totalProcesses: 3,
          },
        );
        await fixture.command("release", { role: "descendants" });
        const terminal = await fixture.command<Terminal>("join");
        expectTerminal(terminal);
        expect(terminal.stdout).toEqual(
          expect.arrayContaining([
            "stdout:parent",
            "stdout:child",
            "stdout:grandchild",
          ]),
        );
        expect(terminal.stderr).toEqual(
          expect.arrayContaining([
            "stderr:parent",
            "stderr:child",
            "stderr:grandchild",
          ]),
        );
      });
    },
    testMs,
  );

  it(
    "force joins the exact tree while a same-name unrelated control remains responsive",
    async () => {
      await withFixture(async (fixture) => {
        await authorizeTree(fixture);
        expectLive(await fixture.command<Observation>("control-start"), false);
        expect(await fixture.command("force")).toMatchObject({
          accepted: true,
          isSealed: true,
        });
        const terminal = await fixture.command<Terminal>("join");
        expectTerminal(terminal);
        expect(terminal.processes).toHaveLength(3);
        expectLive(await fixture.command<Observation>("ping-control"), false);
      });
    },
    testMs,
  );

  it(
    "literal argv survives Windows serialization and the explicit handle list excludes an inheritable sentinel",
    async () => {
      await withFixture(async (fixture) => {
        const argv = [
          "",
          "two words",
          "中文参数",
          'embedded"quote',
          "trailing\\",
          "&|<>^%$(echo)",
        ];
        const { tree } = await authorizeTree(fixture, argv);
        expect(tree.argv).toEqual(argv);
        expect(tree.sentinelSignaled).toBe(false);
        await fixture.command("force");
        expectTerminal(await fixture.command<Terminal>("join"));
      });
    },
    testMs,
  );

  it(
    "closing the last owning Job handle kills an independently pinned child without an inherited controlling handle",
    async () => {
      await withFixture(async (fixture) => {
        await authorizeTree(fixture);
        const disposed = await fixture.command<{
          allExited: boolean;
          processes: Observation[];
          queryHandlesClosed: boolean;
        }>("dispose");
        expect(disposed.queryHandlesClosed).toBe(true);
        expect(disposed.allExited).toBe(true);
        expect(disposed.processes).toHaveLength(3);
        expect(disposed.processes.every((process) => !process.alive)).toBe(
          true,
        );
        await expect(fixture.command("inspect-native")).rejects.toThrow(
          "ObjectDisposedException at inspect-native:",
        );
      });
    },
    testMs,
  );

  it.each(["InvalidJobHandle", "AttributeSetup", "MissingExecutable"])(
    "real native prepare failure %s never executes an engine or falls back to assignment",
    async (fault) => {
      await withFixture(async (fixture) => {
        const failure = await fixture.command<{
          failed: boolean;
          stage: string;
          nativeErrorCode: number;
          markerExists: boolean;
          returnedProcess: boolean;
          liveBeforeReclaim: number;
          ownership: Ownership;
        }>("prepare-failure", { fault });
        expect(failure.failed).toBe(true);
        expect(failure.stage).toMatch(
          /^(UpdateProcThreadAttribute|CreateProcessW)$/,
        );
        expect(failure.nativeErrorCode).toBeGreaterThan(0);
        expect(failure.markerExists).toBe(false);
        expect(failure.returnedProcess).toBe(false);
        expect(failure.liveBeforeReclaim).toBe(0);
        expect(failure.ownership.observedOwnedProcessCount).toBe(0);
        expectNoOwnedProcesses(failure.ownership);
      });
    },
    testMs,
  );
});
