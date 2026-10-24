import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import type { Readable } from "node:stream";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { OwnerDescriptor } from "../src/execution.js";
import {
  createWindowsJournalLauncher,
  type WindowsJournalLauncher,
  type WindowsJournalReadLimits,
  type WindowsJournalReadResult,
} from "../src/windows-journal-launcher.js";
import { interpretWindowsJournalSnapshot } from "../src/windows-journal-reader.js";
import { journalLauncherFixture } from "./windows-journal-launcher-fixtures.js";

const spawnRecorder = vi.hoisted(() => ({
  observe: undefined as
    undefined | ((child: ChildProcess, parameters: unknown[]) => void),
}));

// This seam calls the real Windows spawn unchanged. Output is observed at emit,
// without adding data listeners, resuming pipes or consuming production bytes.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const observingSpawn = (...parameters: unknown[]) => {
    const child = Reflect.apply(
      actual.spawn,
      actual,
      parameters,
    ) as ChildProcess;
    spawnRecorder.observe?.(child, parameters);
    return child;
  };
  return {
    ...actual,
    spawn: observingSpawn,
    default: { ...actual, spawn: observingSpawn },
  };
});

// Explicit test resource policy. These values are not production defaults.
const testPolicy: WindowsJournalReadLimits = Object.freeze({
  maxRequestBytes: 4 * 1_048_576,
  maxStdoutBytes: 1_048_576,
  maxStderrBytes: 65_536,
  readTimeoutMs: 60_000,
  cleanupTimeoutMs: 5_000,
});
const observerCaptureBytes = 65_536;
const testTimeoutMs =
  testPolicy.readTimeoutMs + 3 * testPolicy.cleanupTimeoutMs;
const explicitlyRequested =
  process.env.ZEB_RUN_WINDOWS_JOURNAL_LAUNCHER_OS === "1" ||
  process.env.ZEB_WINDOWS_JOURNAL_LAUNCHER_ORDINARY_EXE !== undefined ||
  process.env.ZEB_WINDOWS_JOURNAL_LAUNCHER_FAULT_EXE !== undefined ||
  process.argv.some((argument) =>
    argument.includes("windows-journal-launcher.os.test"),
  );
const windowsSuite =
  process.platform === "win32" || explicitlyRequested
    ? describe
    : describe.skip;

type Event = Readonly<{ sequence: number; event: string }>;
type KillReceipt = {
  source: "launcher" | "test-cleanup";
  signal: NodeJS.Signals | number | null;
  returned?: boolean;
  threw?: boolean;
};
type Observation = {
  child: ChildProcess;
  role: "launcher" | "sentinel";
  invocation: {
    executablePath: unknown;
    arguments: unknown;
    options: {
      cwd: unknown;
      shell: unknown;
      windowsHide: unknown;
      windowsVerbatimArguments: unknown;
      detached: unknown;
      stdio: unknown;
      environmentKeys: string[];
    };
  };
  changed: EventEmitter;
  events: Event[];
  spawned: boolean;
  stdinFinish: boolean;
  stdinClose: boolean;
  stdoutEnd: boolean;
  stdoutClose: boolean;
  stderrEnd: boolean;
  stderrClose: boolean;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  close: { code: number | null; signal: NodeJS.Signals | null } | null;
  errors: {
    child: string[];
    stdin: string[];
    stdout: string[];
    stderr: string[];
  };
  stdoutBytes: number;
  stderrBytes: number;
  stdoutCapture: Buffer[];
  stderrCapture: Buffer[];
  kills: KillReceipt[];
  testKill: boolean;
};
type Scenario = {
  directory: string;
  recordsRoot: string;
  observations: Observation[];
  launchers: Set<WindowsJournalLauncher>;
  results: unknown[];
  cleanupFailures: string[];
};

let evidenceRoot: string;
let activeScenario: Scenario | undefined;
let ordinaryExecutable: string;
const artifactCache = new Map<string, Promise<unknown>>();

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "error";
}

async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Windows launcher test observation expired")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function originalClosed(observation: Observation) {
  return (
    observation.exit !== null &&
    observation.close !== null &&
    observation.stdinClose &&
    observation.stdoutClose &&
    observation.stderrClose &&
    observation.stdoutEnd &&
    observation.stderrEnd
  );
}

function errorFree(observation: Observation) {
  return Object.values(observation.errors).every(
    (errors) => errors.length === 0,
  );
}

async function observeUntil(
  observation: Observation,
  predicate: () => boolean,
  milliseconds = testPolicy.cleanupTimeoutMs,
) {
  if (predicate()) return;
  let listener: (() => void) | undefined;
  try {
    await bounded(
      new Promise<void>((resolve) => {
        listener = () => {
          if (predicate()) resolve();
        };
        observation.changed.on("change", listener);
        listener();
      }),
      milliseconds,
    );
  } finally {
    if (listener) observation.changed.off("change", listener);
  }
}

function recordChild(
  child: ChildProcess,
  parameters: unknown[],
  role: Observation["role"],
): Observation {
  const options = (parameters[2] ?? {}) as SpawnOptions;
  const observation: Observation = {
    child,
    role,
    invocation: {
      executablePath: parameters[0],
      arguments: parameters[1],
      options: {
        cwd: options.cwd,
        shell: options.shell,
        windowsHide: options.windowsHide,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
        detached: options.detached,
        stdio: options.stdio,
        environmentKeys: Object.keys(options.env ?? {}).sort(),
      },
    },
    changed: new EventEmitter(),
    events: [],
    spawned: false,
    stdinFinish: false,
    stdinClose: false,
    stdoutEnd: false,
    stdoutClose: false,
    stderrEnd: false,
    stderrClose: false,
    exit: null,
    close: null,
    errors: { child: [], stdin: [], stdout: [], stderr: [] },
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutCapture: [],
    stderrCapture: [],
    kills: [],
    testKill: false,
  };
  const note = (event: string) => {
    observation.events.push({ sequence: observation.events.length + 1, event });
    observation.changed.emit("change");
  };
  child.on("spawn", () => {
    observation.spawned = true;
    note("child:spawn");
  });
  child.on("error", (error) => {
    observation.errors.child.push(errorCode(error));
    note("child:error");
  });
  child.on("exit", (code, signal) => {
    observation.exit = { code, signal };
    note("child:exit");
  });
  child.on("close", (code, signal) => {
    observation.close = { code, signal };
    note("child:close");
  });
  child.stdin?.on("finish", () => {
    observation.stdinFinish = true;
    note("stdin:finish");
  });
  child.stdin?.on("close", () => {
    observation.stdinClose = true;
    note("stdin:close");
  });
  child.stdin?.on("error", (error) => {
    observation.errors.stdin.push(errorCode(error));
    note("stdin:error");
  });
  const observeOutput = (
    stream: Readable | null,
    which: "stdout" | "stderr",
  ) => {
    if (!stream) return;
    const emit = stream.emit;
    stream.emit = function (event: string | symbol, ...arguments_: unknown[]) {
      if (event === "data") {
        const bytes = arguments_[0];
        if (Buffer.isBuffer(bytes)) {
          const previous = observation[`${which}Bytes`];
          observation[`${which}Bytes`] += bytes.length;
          const available = Math.max(0, observerCaptureBytes - previous);
          if (available > 0)
            observation[`${which}Capture`].push(
              Buffer.from(bytes.subarray(0, available)),
            );
          note(`${which}:data`);
        } else {
          observation.errors[which].push("non-buffer-data");
          note(`${which}:non-buffer-data`);
        }
      }
      return Reflect.apply(emit, this, [event, ...arguments_]) as boolean;
    };
    stream.on("end", () => {
      observation[`${which}End`] = true;
      note(`${which}:end`);
    });
    stream.on("close", () => {
      observation[`${which}Close`] = true;
      note(`${which}:close`);
    });
    stream.on("error", (error) => {
      observation.errors[which].push(errorCode(error));
      note(`${which}:error`);
    });
  };
  observeOutput(child.stdout, "stdout");
  observeOutput(child.stderr, "stderr");
  const kill = child.kill;
  child.kill = function (signal?: NodeJS.Signals | number) {
    const receipt: KillReceipt = {
      source: observation.testKill ? "test-cleanup" : "launcher",
      signal: signal ?? null,
    };
    observation.kills.push(receipt);
    try {
      receipt.returned = Reflect.apply(kill, this, [signal]) as boolean;
      return receipt.returned;
    } catch (error) {
      receipt.threw = true;
      throw error;
    } finally {
      note("child:kill-call");
    }
  };
  return observation;
}

function testEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { DOTNET_EnableDiagnostics: "0" };
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "TEMP", "TMP"]) {
    const value = Object.entries(process.env).find(
      ([name]) => name.toLowerCase() === key.toLowerCase(),
    )?.[1];
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
}

function localExecutable(variable: string): string {
  const path = process.env[variable];
  expect(
    path,
    `${variable} is required for this actual Windows case`,
  ).toBeTruthy();
  expect(path).toMatch(/^[A-Za-z]:[\\/]/);
  expect(win32.isAbsolute(path!)).toBe(true);
  expect(path!.toLowerCase().endsWith(".exe")).toBe(true);
  return path!;
}

async function packageIdentity(executablePath: string) {
  let identity = artifactCache.get(executablePath);
  if (!identity) {
    identity = (async () => {
      const directory = dirname(executablePath);
      const entries = await readdir(directory, { withFileTypes: true });
      const paths = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            /(?:\.exe|\.dll|\.deps\.json|\.runtimeconfig\.json)$/i.test(
              entry.name,
            ),
        )
        .map((entry) => entry.name)
        .sort();
      return {
        executablePath,
        node: {
          executablePath: process.execPath,
          sha256: sha256(await readFile(process.execPath)),
          version: process.version,
          uv: process.versions.uv,
          architecture: process.arch,
          platform: process.platform,
        },
        artifacts: await Promise.all(
          paths.map(async (name) => {
            const bytes = await readFile(join(directory, name));
            return { name, bytes: bytes.length, sha256: sha256(bytes) };
          }),
        ),
        deploymentAuthenticatedByThisTest: false,
        independentNativeHandleDisposalReceipt: false,
      };
    })();
    artifactCache.set(executablePath, identity);
  }
  return identity;
}

function launcher(
  scenario: Scenario,
  executablePath: string,
  limits = testPolicy,
) {
  const instance = createWindowsJournalLauncher({
    executablePath,
    recordsRoot: scenario.recordsRoot,
    environment: testEnvironment(),
    limits,
  });
  scenario.launchers.add(instance);
  return instance;
}

function receipt(observation: Observation) {
  const { child, changed, stdoutCapture, stderrCapture, testKill, ...facts } =
    observation;
  return {
    ...facts,
    originalChildObjectRetained: true,
    pidAsDiagnosticOnly: child.pid ?? null,
    neverCreatedProven: false,
    originalLifecycleGate: originalClosed(observation),
    stdoutCapture: {
      bytes: Buffer.concat(stdoutCapture).length,
      sha256: sha256(Buffer.concat(stdoutCapture)),
    },
    stderrCapture: {
      bytes: Buffer.concat(stderrCapture).length,
      sha256: sha256(Buffer.concat(stderrCapture)),
    },
  };
}

async function scenario(
  name: string,
  run: (current: Scenario) => Promise<void>,
) {
  const directory = await mkdtemp(join(evidenceRoot, `${name}-`));
  const current: Scenario = {
    directory,
    recordsRoot: join(directory, "records"),
    observations: [],
    launchers: new Set(),
    results: [],
    cleanupFailures: [],
  };
  await mkdir(current.recordsRoot);
  activeScenario = current;
  spawnRecorder.observe = (child, parameters) => {
    if (!activeScenario)
      throw new Error("Windows launcher spawn has no test owner");
    activeScenario.observations.push(
      recordChild(child, parameters, "launcher"),
    );
  };
  let failed = false;
  try {
    await run(current);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    for (const instance of current.launchers) {
      try {
        current.results.push({
          finalClose: await bounded(
            instance.close(),
            testPolicy.cleanupTimeoutMs + 1_000,
          ),
        });
      } catch {
        current.cleanupFailures.push("launcher-close-unobserved");
      }
    }
    for (const observation of current.observations) {
      // A failed creation remains unresolved. No PID/name reopen or absence claim.
      if (!observation.exit && observation.errors.child.length === 0) {
        observation.testKill = true;
        try {
          observation.child.kill();
        } catch {
          current.cleanupFailures.push("original-child-test-kill-failed");
        } finally {
          observation.testKill = false;
        }
      }
      if (observation.spawned) {
        try {
          await observeUntil(observation, () => originalClosed(observation));
        } catch {
          current.cleanupFailures.push("original-child-lifecycle-incomplete");
        }
      }
    }
    spawnRecorder.observe = undefined;
    activeScenario = undefined;
    await writeFile(
      join(directory, "receipt.json"),
      `${JSON.stringify(
        {
          scenario: name,
          assertionFailed: failed,
          policy: testPolicy,
          results: current.results,
          cleanupFailures: current.cleanupFailures,
          observations: current.observations.map(receipt),
          evidenceDirectoryRetained: true,
          noEngineRun: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    if (!failed) expect(current.cleanupFailures).toEqual([]);
  }
}

function normalTransport(observation: Observation) {
  expect(observation.spawned).toBe(true);
  expect(observation.stdinFinish).toBe(true);
  expect(originalClosed(observation)).toBe(true);
  expect(errorFree(observation)).toBe(true);
  expect(observation.exit).toEqual({ code: 0, signal: null });
  expect(observation.close).toEqual({ code: 0, signal: null });
  expect(observation.stderrBytes).toBe(0);
  expect(observation.kills).toEqual([]);
}

type FaultMode =
  | "respond"
  | "respond-live"
  | "eof-live"
  | "hold"
  | "flood"
  | "stdout-flood"
  | "stderr-flood"
  | "stdin-close"
  | "sentinel";
type JournalFixture = ReturnType<typeof journalLauncherFixture>;

async function publishFile(directory: string, name: string, bytes: Buffer) {
  const temporary = join(directory, `${name}.tmp`);
  await writeFile(temporary, bytes);
  await rename(temporary, join(directory, name));
}

async function fileBarrier(
  directory: string,
  name: string,
  milliseconds = testPolicy.readTimeoutMs,
): Promise<Buffer> {
  let resolveFile!: (bytes: Buffer) => void;
  let rejectFile!: (error: Error) => void;
  const found = new Promise<Buffer>((resolve, reject) => {
    resolveFile = resolve;
    rejectFile = reject;
  });
  const inspect = () => {
    void readFile(join(directory, name)).then(resolveFile, (error: unknown) => {
      if (errorCode(error) !== "ENOENT")
        rejectFile(new Error("Windows launcher test file barrier failed"));
    });
  };
  // Register before the initial inspection; all later inspections follow actual
  // filesystem events. Atomic final-name publication prevents partial markers.
  const watcher = watch(directory, inspect);
  watcher.on("error", () => {
    rejectFile(new Error("Windows launcher test watcher failed"));
  });
  inspect();
  try {
    return await bounded(found, milliseconds);
  } finally {
    watcher.close();
  }
}

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function requestBytes(fixture: Pick<JournalFixture, "scope" | "descriptor">) {
  return Buffer.from(
    `${JSON.stringify({
      v: 1,
      kind: "read-windows-journal",
      scope: fixture.scope,
      executionId: fixture.descriptor.executionId,
    })}\n`,
    "utf8",
  );
}

function contextWithJobId(fixture: JournalFixture, jobId: string) {
  const scope = {
    ...fixture.scope,
    target: {
      ...fixture.scope.target,
      identity: { ...fixture.scope.target.identity, jobId },
    },
  };
  const descriptor = {
    ...fixture.descriptor,
    details: {
      ...(fixture.descriptor.details as Record<string, unknown>),
      target: scope.target,
    },
  } as unknown as OwnerDescriptor;
  return { scope, descriptor };
}

async function configureFault(
  directory: string,
  mode: FaultMode,
  response: Buffer,
  options: { exitCode?: number; stderr?: Buffer; floodBytes?: number } = {},
) {
  await publishFile(
    directory,
    "control.json",
    Buffer.from(
      JSON.stringify({
        v: 1,
        mode,
        // This is a release-wait budget, not a whole-process native watchdog.
        lifetimeMs: testTimeoutMs,
        maxRequestBytes: testPolicy.maxRequestBytes,
        maxResponseBytes: testPolicy.maxStdoutBytes,
        maxStderrBytes: testPolicy.maxStderrBytes,
        floodBytes: options.floodBytes ?? 0,
        exitCode: options.exitCode ?? 0,
      }),
      "utf8",
    ),
  );
  await publishFile(directory, "response.bin", response);
  if (options.stderr !== undefined)
    await publishFile(directory, "stderr.bin", options.stderr);
}

async function faultSetup(
  current: Scenario,
  mode: FaultMode,
  options: {
    executablePath?: string;
    exitCode?: number;
    stderr?: Buffer;
    floodBytes?: number;
  } = {},
) {
  const executablePath =
    options.executablePath ??
    localExecutable("ZEB_WINDOWS_JOURNAL_LAUNCHER_FAULT_EXE");
  await access(executablePath);
  const fixture = journalLauncherFixture();
  const response = Buffer.from(`${JSON.stringify(fixture.snapshot)}\n`, "utf8");
  await configureFault(current.recordsRoot, mode, response, options);
  current.results.push({
    fixtureMode: mode,
    syntheticSnapshot: true,
    artifactIdentity: await packageIdentity(executablePath),
  });
  return { executablePath, fixture, response };
}

function oneLauncherChild(current: Scenario) {
  const originals = current.observations.filter(
    (item) => item.role === "launcher",
  );
  expect(originals).toHaveLength(1);
  return originals[0]!;
}

function trackRead(
  current: Scenario,
  pending: Promise<WindowsJournalReadResult>,
) {
  const tracked = {
    settlements: 0,
    promise: undefined as unknown as Promise<WindowsJournalReadResult>,
  };
  tracked.promise = pending.then(
    (result) => {
      tracked.settlements++;
      current.results.push(result);
      return result;
    },
    (error: unknown) => {
      tracked.settlements++;
      current.results.push({ unexpectedReadRejection: errorCode(error) });
      throw error;
    },
  );
  // A barrier may be awaited before the result. Keep any unexpected rejection
  // handled until its original promise is awaited and fails the actual case.
  void tracked.promise.catch(() => {});
  return tracked;
}

async function actualRequest(
  current: Scenario,
  context: Pick<JournalFixture, "scope" | "descriptor">,
) {
  const marker = JSON.parse(
    (await fileBarrier(current.recordsRoot, "input-eof")).toString("utf8"),
  ) as {
    bytes: number;
    sha256: string;
  };
  const bytes = await readFile(join(current.recordsRoot, "request.bin"));
  const expected = requestBytes(context);
  expect(bytes).toEqual(expected);
  expect(marker).toEqual({ bytes: expected.length, sha256: sha256(expected) });
  expect(bytes[bytes.length - 1]).toBe(10);
  current.results.push({
    actualInputEof: true,
    bytes: marker.bytes,
    sha256: marker.sha256,
  });
}

function expectUnknown(
  result: WindowsJournalReadResult,
  cleanup: "closed" | "unknown",
) {
  expect(result).toEqual({ kind: "unknown", cleanup });
  expect(Object.isFrozen(result)).toBe(true);
}

function cancelledOriginal(observation: Observation) {
  expect(observation.spawned).toBe(true);
  expect(observation.stdinFinish).toBe(true);
  expect(originalClosed(observation)).toBe(true);
  expect(errorFree(observation)).toBe(true);
  expect(observation.kills).toHaveLength(1);
  expect(observation.kills[0]!.source).toBe("launcher");
}

async function unrelatedSentinel(current: Scenario, executablePath: string) {
  const root = join(current.directory, "unrelated-sentinel");
  await mkdir(root);
  await configureFault(root, "sentinel", Buffer.alloc(0));
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const arguments_ = ["--read-records", root];
  const options: SpawnOptions = {
    cwd: win32.dirname(executablePath),
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: false,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...testEnvironment() },
  };
  const child = actual.spawn(executablePath, arguments_, options);
  const original = recordChild(
    child,
    [executablePath, arguments_, options],
    "sentinel",
  );
  current.observations.push(original);
  // This test owns the sentinel's pipes, independently of the launcher's child.
  child.stdout?.resume();
  child.stderr?.resume();
  child.stdin?.end();
  await fileBarrier(root, "ready");
  let releasing: Promise<void> | undefined;
  return {
    original,
    async responsiveAfterReaderCancellation() {
      const nonce = Buffer.from(randomUUID(), "utf8");
      await publishFile(root, "probe", nonce);
      expect(await fileBarrier(root, "alive")).toEqual(nonce);
      expect(original.exit).toBeNull();
      expect(original.kills).toEqual([]);
      current.results.push({
        unrelatedSentinelAnsweredAfterReaderCancellation: true,
      });
    },
    release() {
      if (!releasing)
        releasing = (async () => {
          await publishFile(root, "release", Buffer.alloc(0));
          await observeUntil(original, () => originalClosed(original));
          normalTransport(original);
        })();
      return releasing;
    },
  };
}

windowsSuite("Windows journal launcher actual ordinary and fault pipes", () => {
  beforeAll(async () => {
    expect(process.platform).toBe("win32");
    expect(process.version).toMatch(/^v22\./);
    ordinaryExecutable = localExecutable(
      "ZEB_WINDOWS_JOURNAL_LAUNCHER_ORDINARY_EXE",
    );
    await access(ordinaryExecutable);
    const requestedEvidence =
      process.env.ZEB_WINDOWS_JOURNAL_LAUNCHER_EVIDENCE_ROOT;
    if (requestedEvidence !== undefined) {
      expect(requestedEvidence).toMatch(/^[A-Za-z]:[\\/]/);
      evidenceRoot = requestedEvidence;
      await mkdir(evidenceRoot, { recursive: true });
    } else {
      evidenceRoot = await mkdtemp(
        join(tmpdir(), "windows-journal-launcher-evidence-"),
      );
    }
  });

  it(
    "ordinary helper completes the original pipes and returns read with legitimate unknown",
    async () => {
      await scenario("ordinary-positive", async (current) => {
        // Existing ordinary package, new empty root, synthetic original context.
        // This proves reader transport only; it never runs the original engine.
        current.results.push({
          artifactIdentity: await packageIdentity(ordinaryExecutable),
        });
        const fixture = journalLauncherFixture();
        const instance = launcher(current, ordinaryExecutable);
        const result = await instance.read(
          fixture.scope,
          fixture.descriptor,
          new AbortController().signal,
          () => true,
        );
        current.results.push(result);
        // First behavioral assertion is intentional: Unknown-only scaffold must
        // fail by expected read / received unknown, not by fixture/import errors.
        expect(result.kind).toBe("read");
        expect(result).toEqual({
          kind: "read",
          interpretation: { kind: "unknown" },
          cleanup: "closed",
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(current.observations).toHaveLength(1);
        const original = current.observations[0]!;
        normalTransport(original);
        expect(original.invocation).toMatchObject({
          executablePath: ordinaryExecutable,
          arguments: ["--read-records", current.recordsRoot],
          options: {
            cwd: win32.dirname(ordinaryExecutable),
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: false,
            detached: true,
          },
        });
        expect(
          original.invocation.options.stdio === "pipe" ||
            JSON.stringify(original.invocation.options.stdio) ===
              '["pipe","pipe","pipe"]',
        ).toBe(true);
        expect(await instance.close()).toBe("closed");
      });
    },
    testTimeoutMs,
  );

  it(
    "passes the original context to a fully qualified synthetic snapshot after actual transport closes",
    async () => {
      await scenario("synthetic-positive", async (current) => {
        const { executablePath, fixture } = await faultSetup(
          current,
          "respond",
        );
        const instance = launcher(current, executablePath);
        const result = await instance.read(
          fixture.scope,
          fixture.descriptor,
          new AbortController().signal,
          () => true,
        );
        current.results.push(result);
        expect(result.kind).toBe("read");
        if (result.kind !== "read")
          throw new Error("Expected completed synthetic reader transport");
        expect(result.cleanup).toBe("closed");
        expect(result.interpretation.kind).toBe("engine-exit");
        expect(result.interpretation).toEqual(
          interpretWindowsJournalSnapshot(
            fixture.snapshot,
            fixture.scope,
            fixture.descriptor,
          ),
        );
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.interpretation)).toBe(true);
        await actualRequest(current, fixture);
        normalTransport(oneLauncherChild(current));
        expect(await instance.close()).toBe("closed");
      });
    },
    testTimeoutMs,
  );

  it.each(["respond-live", "eof-live"] as const)(
    "%s cannot return read while the original child remains live",
    async (mode) => {
      await scenario(mode, async (current) => {
        const { executablePath, fixture, response } = await faultSetup(
          current,
          mode,
        );
        const controller = new AbortController();
        const instance = launcher(current, executablePath);
        const tracked = trackRead(
          current,
          instance.read(
            fixture.scope,
            fixture.descriptor,
            controller.signal,
            () => true,
          ),
        );
        await fileBarrier(current.recordsRoot, "response-written");
        const original = oneLauncherChild(current);
        await observeUntil(
          original,
          () => original.stdoutBytes === response.length,
        );
        await actualRequest(current, fixture);
        if (mode === "eof-live") {
          await fileBarrier(current.recordsRoot, "outputs-closed");
          // The native marker is not EOF. Both original Node end events are required.
          await observeUntil(
            original,
            () => original.stdoutEnd && original.stderrEnd,
          );
          expect(original.stdoutEnd).toBe(true);
          expect(original.stderrEnd).toBe(true);
        }
        await nextTurn();
        expect(original.exit).toBeNull();
        expect(original.child.exitCode).toBeNull();
        expect(tracked.settlements).toBe(0);
        controller.abort();
        expectUnknown(await tracked.promise, "closed");
        cancelledOriginal(original);
        await nextTurn();
        expect(tracked.settlements).toBe(1);
      });
    },
    testTimeoutMs,
  );

  it.each(["abort", "deadline", "close"] as const)(
    "%s cancels only the original reader and leaves an unrelated sentinel responsive",
    async (reason) => {
      await scenario(`cancel-${reason}`, async (current) => {
        const { executablePath, fixture } = await faultSetup(current, "hold");
        const sentinel = await unrelatedSentinel(current, executablePath);
        try {
          const controller = new AbortController();
          const limits =
            reason === "deadline"
              ? Object.freeze({ ...testPolicy, readTimeoutMs: 5_000 })
              : testPolicy;
          const instance = launcher(current, executablePath, limits);
          const tracked = trackRead(
            current,
            instance.read(
              fixture.scope,
              fixture.descriptor,
              controller.signal,
              () => true,
            ),
          );
          await actualRequest(current, fixture);
          const original = oneLauncherChild(current);
          expect(original.exit).toBeNull();
          expect(tracked.settlements).toBe(0);
          const busy = await instance.read(
            fixture.scope,
            fixture.descriptor,
            new AbortController().signal,
            () => true,
          );
          current.results.push({ rejectedBusyRead: busy });
          expectUnknown(busy, "unknown");
          oneLauncherChild(current);
          let closing: Promise<"closed" | "unknown"> | undefined;
          if (reason === "abort") controller.abort();
          if (reason === "close") {
            closing = instance.close();
            expect(instance.close()).toBe(closing);
          }
          const result = await tracked.promise;
          expectUnknown(result, "closed");
          cancelledOriginal(original);
          if (!closing) closing = instance.close();
          expect(instance.close()).toBe(closing);
          expect(await closing).toBe("closed");
          const sealed = await instance.read(
            fixture.scope,
            fixture.descriptor,
            new AbortController().signal,
            () => true,
          );
          current.results.push({ rejectedSealedRead: sealed });
          expectUnknown(sealed, "closed");
          oneLauncherChild(current);
          await sentinel.responsiveAfterReaderCancellation();
          await nextTurn();
          expect(tracked.settlements).toBe(1);
        } finally {
          await sentinel.release();
        }
      });
    },
    testTimeoutMs,
  );

  it.each(["stdout-flood", "stderr-flood", "flood"] as const)(
    "%s remains bounded and joins the exact child with actual dual EOF",
    async (mode) => {
      await scenario(mode, async (current) => {
        const floodBytes = 2 * 1_048_576;
        const { executablePath, fixture } = await faultSetup(current, mode, {
          floodBytes,
        });
        const limits = Object.freeze({
          ...testPolicy,
          maxStdoutBytes: 4_096,
          maxStderrBytes: mode === "stderr-flood" ? 1 : 4_096,
        });
        const instance = launcher(current, executablePath, limits);
        const tracked = trackRead(
          current,
          instance.read(
            fixture.scope,
            fixture.descriptor,
            new AbortController().signal,
            () => true,
          ),
        );
        await fileBarrier(current.recordsRoot, "flood-started");
        const original = oneLauncherChild(current);
        expectUnknown(await tracked.promise, "closed");
        cancelledOriginal(original);
        await actualRequest(current, fixture);
        if (mode === "stdout-flood") {
          expect(original.stdoutBytes).toBeGreaterThan(limits.maxStdoutBytes);
          expect(original.stderrBytes).toBe(0);
        } else if (mode === "stderr-flood") {
          expect(original.stderrBytes).toBeGreaterThan(limits.maxStderrBytes);
          expect(original.stdoutBytes).toBe(0);
        } else {
          // A correct launcher may cancel on the first stderr/overflow before
          // the other pending write is delivered. Do not require a race order.
          expect(original.stdoutBytes + original.stderrBytes).toBeGreaterThan(
            0,
          );
        }
        expect(
          Buffer.concat(original.stdoutCapture).length,
        ).toBeLessThanOrEqual(observerCaptureBytes);
        expect(
          Buffer.concat(original.stderrCapture).length,
        ).toBeLessThanOrEqual(observerCaptureBytes);
        current.results.push({
          requestedFloodBytesPerSelectedStream: floodBytes,
          limits,
          observedStdoutOverflow: original.stdoutBytes > limits.maxStdoutBytes,
          observedStderrOverflow: original.stderrBytes > limits.maxStderrBytes,
        });
        await nextTurn();
        expect(tracked.settlements).toBe(1);
      });
    },
    testTimeoutMs,
  );

  it(
    "rejects a real early stdin closure and retains the stream-error owner",
    async () => {
      await scenario("early-stdin-close", async (current) => {
        const { executablePath, fixture } = await faultSetup(
          current,
          "stdin-close",
        );
        // Keep a legal multi-MiB write pending while the fixture closes its unread
        // pipe. Actual stdin error and missing finish are required below; the
        // fixture's ready marker by itself is not a write-failure receipt.
        const context = contextWithJobId(
          fixture,
          `large-request-${"x".repeat(2 * 1_048_576)}`,
        );
        const bytes = requestBytes(context);
        expect(bytes.length).toBeGreaterThan(1_048_576);
        expect(bytes.length).toBeLessThan(testPolicy.maxRequestBytes);
        const instance = launcher(current, executablePath);
        const tracked = trackRead(
          current,
          instance.read(
            context.scope,
            context.descriptor,
            new AbortController().signal,
            () => true,
          ),
        );
        const result = await tracked.promise;
        const original = oneLauncherChild(current);
        expectUnknown(result, "unknown");
        await observeUntil(original, () => originalClosed(original));
        expect(original.spawned).toBe(true);
        expect(original.stdinFinish).toBe(false);
        expect(original.errors.stdin.length).toBeGreaterThan(0);
        expect(original.stdoutEnd).toBe(true);
        expect(original.stderrEnd).toBe(true);
        expect(original.kills).toHaveLength(1);
        expect(original.kills[0]!.source).toBe("launcher");
        const blocked = await instance.read(
          fixture.scope,
          fixture.descriptor,
          new AbortController().signal,
          () => true,
        );
        current.results.push({
          requestedInputBytes: bytes.length,
          rejectedPoisonedRead: blocked,
        });
        expectUnknown(blocked, "unknown");
        oneLauncherChild(current);
        const closing = instance.close();
        expect(instance.close()).toBe(closing);
        expect(await closing).toBe("unknown");
        await nextTurn();
        expect(tracked.settlements).toBe(1);
      });
    },
    testTimeoutMs,
  );

  it.each(["stderr", "nonzero"] as const)(
    "a valid synthetic response with %s is a failed actual transport",
    async (failure) => {
      await scenario(`valid-response-${failure}`, async (current) => {
        const stderr = Buffer.from("fixture-only stderr\n", "utf8");
        const { executablePath, fixture } = await faultSetup(
          current,
          "respond",
          {
            ...(failure === "stderr" ? { stderr } : { exitCode: 9 }),
          },
        );
        const instance = launcher(current, executablePath);
        const tracked = trackRead(
          current,
          instance.read(
            fixture.scope,
            fixture.descriptor,
            new AbortController().signal,
            () => true,
          ),
        );
        expectUnknown(await tracked.promise, "closed");
        const original = oneLauncherChild(current);
        expect(originalClosed(original)).toBe(true);
        expect(errorFree(original)).toBe(true);
        expect(original.stdinFinish).toBe(true);
        await actualRequest(current, fixture);
        if (failure === "stderr") {
          expect(Buffer.concat(original.stderrCapture)).toEqual(stderr);
        } else {
          expect(original.stderrBytes).toBe(0);
          expect(original.exit).toEqual({ code: 9, signal: null });
        }
        await nextTurn();
        expect(tracked.settlements).toBe(1);
      });
    },
    testTimeoutMs,
  );

  it(
    "preserves exact Unicode, spaces and apostrophes in executable, root and UTF8 request",
    async () => {
      await scenario("quoted-unicode-paths", async (current) => {
        const sourceExecutable = localExecutable(
          "ZEB_WINDOWS_JOURNAL_LAUNCHER_FAULT_EXE",
        );
        const copiedPackage = join(
          current.directory,
          "helper 商品🙂 space 'apostrophe'",
        );
        await cp(dirname(sourceExecutable), copiedPackage, {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
        const executablePath = join(copiedPackage, basename(sourceExecutable));
        current.recordsRoot = join(
          current.directory,
          "records 商品🙂 space 'apostrophe'",
        );
        await mkdir(current.recordsRoot);
        const { fixture } = await faultSetup(current, "respond", {
          executablePath,
        });
        const context = contextWithJobId(
          fixture,
          '商品🙂 O\'Brien space "quote" \\slash',
        );
        const instance = launcher(current, executablePath);
        const result = await instance.read(
          context.scope,
          context.descriptor,
          new AbortController().signal,
          () => true,
        );
        current.results.push(result);
        // The intentionally changed synthetic context has no matching snapshot;
        // a completed valid writer response remains a legal read/Unknown.
        expect(result).toEqual({
          kind: "read",
          interpretation: { kind: "unknown" },
          cleanup: "closed",
        });
        expect(Object.isFrozen(result)).toBe(true);
        const original = oneLauncherChild(current);
        normalTransport(original);
        expect(original.invocation).toMatchObject({
          executablePath,
          arguments: ["--read-records", current.recordsRoot],
          options: {
            cwd: win32.dirname(executablePath),
            shell: false,
            windowsVerbatimArguments: false,
          },
        });
        const ready = JSON.parse(
          (await fileBarrier(current.recordsRoot, "ready")).toString("utf8"),
        ) as {
          args: string[];
          cwd: string;
        };
        expect(ready.args).toEqual(["--read-records", current.recordsRoot]);
        expect(win32.normalize(ready.cwd).toLowerCase()).toBe(
          win32.dirname(executablePath).toLowerCase(),
        );
        await actualRequest(current, context);
        expect(await instance.close()).toBe("closed");
      });
    },
    testTimeoutMs,
  );

  it(
    "keeps a real missing-exe spawn error unresolved and blocks another child",
    async () => {
      await scenario("missing-exe", async (current) => {
        current.results.push({
          runtimeAndKnownOrdinaryPackage:
            await packageIdentity(ordinaryExecutable),
        });
        const missingExecutable = join(
          dirname(ordinaryExecutable),
          `missing-reader-${randomUUID()}.exe`,
        );
        const fixture = journalLauncherFixture();
        const instance = launcher(current, missingExecutable);
        const tracked = trackRead(
          current,
          instance.read(
            fixture.scope,
            fixture.descriptor,
            new AbortController().signal,
            () => true,
          ),
        );
        expectUnknown(await tracked.promise, "unknown");
        const original = oneLauncherChild(current);
        expect(original.errors.child).toContain("ENOENT");
        expect(original.spawned).toBe(false);
        expect(original.child.pid).toBeUndefined();
        expect(original.exit).toBeNull();
        expect(originalClosed(original)).toBe(false);
        // These observations do not prove that the OS never created a process.
        current.results.push({ attemptedSpawnNeverCreatedProven: false });
        const blocked = await instance.read(
          fixture.scope,
          fixture.descriptor,
          new AbortController().signal,
          () => true,
        );
        current.results.push({ rejectedUnresolvedCreationRead: blocked });
        expectUnknown(blocked, "unknown");
        oneLauncherChild(current);
        const closing = instance.close();
        expect(instance.close()).toBe(closing);
        expect(await closing).toBe("unknown");
        await nextTurn();
        expect(tracked.settlements).toBe(1);
      });
    },
    testTimeoutMs,
  );
});
