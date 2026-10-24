import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { createWindowsControlBridgeHost } from "../src/windows-control-bridge-host.js";
import type { WindowsControlBridgeLimits } from "../src/windows-control-bridge-protocol.js";

type Observation = {
  child: ChildProcess;
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  spawn: number;
  exit: { code: number | null; signal: NodeJS.Signals | null }[];
  close: { code: number | null; signal: NodeJS.Signals | null }[];
  stdinFinish: number;
  stdinClose: number;
  stdoutEnd: number;
  stdoutClose: number;
  stderrEnd: number;
  stderrClose: number;
  errors: string[];
  stdout: Buffer[];
  stderrBytes: number;
  stdin: Buffer[];
  writeCalls: number;
  writeOrigins: boolean[];
  writeCallbacks: number;
  writeErrors: number;
  endFrames: Buffer[];
  endCalls: number;
  endCallbacks: number;
  endErrors: number;
  events: string[];
  kill: ReturnType<typeof vi.spyOn>;
};

const observed = vi.hoisted(() => ({ children: [] as Observation[] }));
// Calls the original OS spawn. This seam only records the original child and
// stream events; it neither substitutes the child nor synthesizes lifecycle facts.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      const child = actual.spawn(command, args, options);
      const value: Observation = {
        child,
        command,
        args,
        options,
        spawn: 0,
        exit: [],
        close: [],
        stdinFinish: 0,
        stdinClose: 0,
        stdoutEnd: 0,
        stdoutClose: 0,
        stderrEnd: 0,
        stderrClose: 0,
        errors: [],
        stdout: [],
        stderrBytes: 0,
        stdin: [],
        writeCalls: 0,
        writeOrigins: [],
        writeCallbacks: 0,
        writeErrors: 0,
        endFrames: [],
        endCalls: 0,
        endCallbacks: 0,
        endErrors: 0,
        events: [],
        kill: vi.spyOn(child, "kill"),
      };
      observed.children.push(value);
      child.on("spawn", () => {
        value.events.push("spawn");
        value.spawn++;
      });
      child.on("exit", (code, signal) => {
        value.events.push("exit");
        value.exit.push({ code, signal });
      });
      child.on("close", (code, signal) => {
        value.events.push("child-close");
        value.close.push({ code, signal });
      });
      child.on("error", () => value.errors.push("child"));
      child.stdin?.on("finish", () => {
        value.events.push("stdin-finish");
        value.stdinFinish++;
      });
      child.stdin?.on("close", () => {
        value.events.push("stdin-close");
        value.stdinClose++;
      });
      child.stdin?.on("error", () => value.errors.push("stdin"));
      child.stdout?.on("end", () => {
        value.events.push("stdout-end");
        value.stdoutEnd++;
      });
      child.stdout?.on("close", () => {
        value.events.push("stdout-close");
        value.stdoutClose++;
      });
      child.stdout?.on("error", () => value.errors.push("stdout"));
      child.stderr?.on("end", () => {
        value.events.push("stderr-end");
        value.stderrEnd++;
      });
      child.stderr?.on("close", () => {
        value.events.push("stderr-close");
        value.stderrClose++;
      });
      child.stderr?.on("error", () => value.errors.push("stderr"));
      child.stdout?.on("data", (bytes: Buffer) => {
        // This independent evidence capture has the same explicit per-case
        // session byte budget as the production host. Overflow is a failure.
        const size = value.stdout.reduce(
          (total, item) => total + item.length,
          0,
        );
        if (size + bytes.length > limits.maxSessionOutputBytes) {
          value.errors.push("evidence-overflow");
          return;
        }
        value.stdout.push(Buffer.from(bytes));
      });
      child.stderr?.on("data", (bytes: Buffer) => {
        value.stderrBytes += bytes.length;
      });
      if (child.stdin) {
        const stdin = child.stdin;
        const originalWrite = stdin.write.bind(stdin);
        const originalEnd = stdin.end.bind(stdin);
        let withinEnd = false;
        vi.spyOn(stdin, "write").mockImplementation(function (
          ...writeArgs: unknown[]
        ) {
          value.writeCalls++;
          const internal = withinEnd;
          const bytes = wireBytes(writeArgs);
          if (bytes) {
            value.stdin.push(bytes);
            value.writeOrigins.push(internal);
          } else value.errors.push("unobserved-write-shape");
          if (!internal) {
            let callbackIndex = -1;
            for (let index = 0; index < writeArgs.length; index++)
              if (typeof writeArgs[index] === "function") callbackIndex = index;
            if (callbackIndex !== -1) {
              const callback = writeArgs[callbackIndex] as (
                ...args: unknown[]
              ) => unknown;
              writeArgs[callbackIndex] = function (
                this: unknown,
                ...args: unknown[]
              ) {
                value.events.push("stdin-write-callback");
                value.writeCallbacks++;
                if (args[0] != null) value.writeErrors++;
                return Reflect.apply(callback, this, args);
              };
            }
          }
          return Reflect.apply(originalWrite, stdin, writeArgs);
        });
        vi.spyOn(stdin, "end").mockImplementation(function (
          ...endArgs: unknown[]
        ) {
          value.endCalls++;
          value.events.push("stdin-end-call");
          const bytes = wireBytes(endArgs);
          if (bytes) value.endFrames.push(bytes);
          let callbackIndex = -1;
          for (let index = 0; index < endArgs.length; index++)
            if (typeof endArgs[index] === "function") callbackIndex = index;
          if (callbackIndex !== -1) {
            const callback = endArgs[callbackIndex] as (
              ...args: unknown[]
            ) => unknown;
            endArgs[callbackIndex] = function (
              this: unknown,
              ...args: unknown[]
            ) {
              value.events.push("stdin-end-callback");
              value.endCallbacks++;
              if (args[0] != null) value.endErrors++;
              return Reflect.apply(callback, this, args);
            };
          }
          withinEnd = true;
          try {
            return Reflect.apply(originalEnd, stdin, endArgs);
          } finally {
            withinEnd = false;
          }
        });
      }
      return child;
    },
  };
});

function wireBytes(args: readonly unknown[]): Buffer | undefined {
  if (Buffer.isBuffer(args[0])) return Buffer.from(args[0]);
  if (typeof args[0] !== "string") return undefined;
  const encoding = args[1];
  if (typeof encoding === "string" && !Buffer.isEncoding(encoding))
    return undefined;
  return Buffer.from(
    args[0],
    typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
  );
}

const bridgeExe = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_HOST_BRIDGE_EXE;
const helperExe = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_HOST_ORDINARY_EXE;
const requested = process.env.ZEB_RUN_WINDOWS_CONTROL_BRIDGE_HOST_OS === "1";
const suite = requested ? describe : describe.skip;

// Explicit test observation policy, never deployment defaults. These reuse the
// existing native bridge ordinary-case policy and do not run an image engine.
const limits: WindowsControlBridgeLimits = {
  maxRequestFrameBytes: 65_536,
  maxResponseFrameBytes: 65_536,
  maxHelperStderrBytes: 8_192,
  maxSessionInputBytes: 262_144,
  maxSessionOutputBytes: 1_048_576,
  maxQueuedOutputBytes: 262_144,
  maxJsonDepth: 16,
  startupTimeoutMs: 8_000,
  requestTimeoutMs: 5_000,
  sessionTimeoutMs: 45_000,
  cleanupTimeoutMs: 5_000,
};
const testTimeoutMs = limits.sessionTimeoutMs + 2 * limits.cleanupTimeoutMs;
let evidenceRoot: string;

function helperEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ["SystemRoot", "WINDIR", "TEMP", "TMP"]
      .map((key) => [key, process.env[key]] as const)
      .filter(
        (item): item is readonly [string, string] => item[1] !== undefined,
      ),
  );
}

async function sourceIdentity(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function atReturn(child: Observation | undefined) {
  if (!child) return null;
  return Object.freeze({
    spawnEvents: child.spawn,
    exit: Object.freeze(child.exit.map((item) => Object.freeze({ ...item }))),
    close: Object.freeze(child.close.map((item) => Object.freeze({ ...item }))),
    stdinFinish: child.stdinFinish,
    stdinClose: child.stdinClose,
    stdoutEnd: child.stdoutEnd,
    stdoutClose: child.stdoutClose,
    stderrEnd: child.stderrEnd,
    stderrClose: child.stderrClose,
    stderrBytes: child.stderrBytes,
    errors: Object.freeze([...child.errors]),
    endCalls: child.endCalls,
    endCallbacks: child.endCallbacks,
    endErrors: child.endErrors,
    writeCallbacks: child.writeCallbacks,
    writeErrors: child.writeErrors,
    writeCalls: child.writeCalls,
    events: Object.freeze([...child.events, "close-promise-returned"]),
    writes: Object.freeze(
      child.stdin.map((bytes, index) =>
        Object.freeze({
          hex: bytes.toString("hex"),
          insideEnd: child.writeOrigins[index] === true,
        }),
      ),
    ),
    endFrames: Object.freeze(
      child.endFrames.map((bytes) => bytes.toString("hex")),
    ),
    stdoutHex: Buffer.concat(child.stdout).toString("hex"),
    killCalls: child.kill.mock.calls.length,
  });
}

async function artifacts() {
  const paths = [
    bridgeExe!,
    helperExe!,
    join(dirname(bridgeExe!), "WindowsControlBridge.dll"),
    join(dirname(helperExe!), "WindowsSupervisor.dll"),
  ];
  return Promise.all(
    paths.map(async (path) => ({
      file: path,
      sha256: await sourceIdentity(path),
    })),
  );
}

async function exercise(name: string, preempt: boolean): Promise<void> {
  const directory = await mkdtemp(join(evidenceRoot, `${name}-`));
  const recordsRoot = join(directory, "records");
  const installationRoot = join(directory, "installation");
  await mkdir(recordsRoot);
  await mkdir(installationRoot);
  const firstChild = observed.children.length;
  const options = {
    executablePath: bridgeExe!,
    helperPath: helperExe!,
    recordsRoot,
    installationRoot,
    expectedManifestSha256: "a".repeat(64),
    environment: helperEnvironment(),
    limits,
  };
  const artifactsBefore = await artifacts();
  let host: ReturnType<typeof createWindowsControlBridgeHost> | undefined;
  let opened: Awaited<ReturnType<NonNullable<typeof host>["open"]>> | undefined;
  let inspected:
    Awaited<ReturnType<NonNullable<typeof host>["inspect"]>> | undefined;
  let result:
    Awaited<ReturnType<NonNullable<typeof host>["close"]>> | undefined;
  let closePromise: ReturnType<NonNullable<typeof host>["close"]> | undefined;
  let facts: ReturnType<typeof atReturn> = null;
  const failures: string[] = [];
  try {
    host = createWindowsControlBridgeHost(options);
    const signal = new AbortController().signal;
    opened = await host.open(signal, () => true);
    if (opened.kind === "bound") {
      const inspecting = host.inspect(signal, () => true);
      if (preempt) closePromise = host.close();
      inspected = await inspecting;
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.name : "unknown-error");
  } finally {
    // Even a failed open/inspect retains its original host. No assertion can
    // bypass this one bounded close or discard the observed Unknown evidence.
    if (host) {
      try {
        closePromise ??= host.close();
        result = await closePromise;
        // FIRST synchronous work after await: late file I/O cannot fill this gate.
        facts = atReturn(observed.children[firstChild]);
      } catch (error) {
        facts = atReturn(observed.children[firstChild]);
        failures.push(error instanceof Error ? error.name : "unknown-error");
      }
    } else facts = atReturn(observed.children[firstChild]);
  }
  const children = observed.children.slice(firstChild);
  const rawOutput = Buffer.from(facts?.stdoutHex ?? "", "hex");
  await writeFile(
    join(directory, "facts-at-return.json"),
    `${JSON.stringify(
      {
        opened,
        inspected,
        result,
        failures,
        factsAtReturn: facts,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  await writeFile(join(directory, "stdout.bin"), rawOutput, { flag: "wx" });
  const artifactsAfter = await artifacts();
  const receipt = {
    name,
    node: process.version,
    libuv: process.versions.uv,
    artifactsBefore,
    artifactsAfter,
    limits,
    evidenceScope:
      "original-node-child-and-stream-events; helper-identity-is-trusted-bridge-statement",
    opened,
    inspected,
    result,
    failures,
    factsAtReturn: facts,
    spawnCount: children.length,
    stdoutSha256: createHash("sha256").update(rawOutput).digest("hex"),
    stdoutBytes: rawOutput.length,
    records: await readdir(recordsRoot),
    installation: await readdir(installationRoot),
  };
  await writeFile(
    join(directory, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  expect(failures).toEqual([]);
  expect(children).toHaveLength(1);
  const child = children[0]!;
  expect(facts).not.toBeNull();
  if (!facts) throw new Error("Original child facts missing");
  expect(opened?.kind).toBe("bound");
  if (opened?.kind !== "bound") throw new Error("Original binding missing");
  if (preempt) expect(inspected?.kind).toBe("unknown");
  else {
    expect(inspected?.kind).toBe("state");
    if (inspected?.kind === "state") {
      expect(inspected.state.phase).toBe("claimed");
      expect(inspected.state.authorizationVerified).toBe(false);
      expect(inspected.state.descriptor).toBeNull();
    }
  }
  expect(host!.close()).toBe(closePromise);
  expect(artifactsAfter).toEqual(artifactsBefore);
  expect(result).toEqual({ kind: "stopped", cleanup: "closed" });
  expect(facts.spawnEvents).toBe(1);
  expect(facts.exit).toEqual([{ code: 0, signal: null }]);
  expect(facts.close).toEqual([{ code: 0, signal: null }]);
  for (const count of [
    facts.stdinFinish,
    facts.stdinClose,
    facts.stdoutEnd,
    facts.stdoutClose,
    facts.stderrEnd,
    facts.stderrClose,
  ])
    expect(count).toBe(1);
  expect(facts.errors).toEqual([]);
  expect(facts.stderrBytes).toBe(0);
  expect(facts.killCalls).toBe(0);
  expect(facts.endCalls).toBe(1);
  expect(facts.endCallbacks).toBe(1);
  expect(facts.endErrors).toBe(0);
  expect(facts.writeCallbacks).toBe(1);
  expect(facts.writeErrors).toBe(0);
  expect(facts.writeCalls).toBe(facts.writes.length);
  expect(child.command).toBe(bridgeExe);
  expect(child.args[0]).toBe("--control-bridge");
  expect(child.args).toHaveLength(2);
  expect(child.options.shell).toBe(false);
  expect(child.options.env).toEqual(options.environment);
  expect(opened.binding.bridge.pid).toBe(child.child.pid);
  expect(receipt.records).toEqual([]);
  expect(receipt.installation).toEqual([]);
  const frames = rawOutput
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(frames[0]?.kind).toBe("bound");
  expect(frames.at(-1)?.kind).toBe("closed");
  expect(frames.at(-1)?.outcome).toBe("stopped");
  expect(rawOutput.includes(0x0d)).toBe(false);
  expect(rawOutput.at(-1)).toBe(0x0a);
  expect(facts.endFrames).toHaveLength(1);
  const closeBytes = Buffer.from(facts.endFrames[0]!, "hex");
  expect(closeBytes.at(-1)).toBe(0x0a);
  expect(closeBytes.indexOf(0x0a)).toBe(closeBytes.length - 1);
  expect(closeBytes.includes(0x0d)).toBe(false);
  const closeCommand = JSON.parse(closeBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  expect(Object.keys(closeCommand).sort()).toEqual(
    ["v", "kind", "requestId", "op", "executionId"].sort(),
  );
  expect(closeCommand).toMatchObject({
    v: 1,
    kind: "command",
    op: "close",
    executionId: opened.binding.executionId,
  });
  expect(frames.at(-1)?.requestId).toBe(closeCommand.requestId);
  expect(frames.at(-1)?.executionId).toBe(opened.binding.executionId);
  // Only an actual nested write during the original end invocation is internal.
  // A separate duplicate close write remains visible and fails the count below.
  const internalWrites = facts.writes.filter((item) => item.insideEnd);
  expect(internalWrites.length).toBeLessThanOrEqual(1);
  for (const item of internalWrites)
    expect(Buffer.from(item.hex, "hex").equals(closeBytes)).toBe(true);
  const inspectBytes = facts.writes
    .filter((item) => !item.insideEnd)
    .map((item) => Buffer.from(item.hex, "hex"));
  expect(inspectBytes).toHaveLength(1);
  expect(inspectBytes[0]!.at(-1)).toBe(0x0a);
  expect(inspectBytes[0]!.indexOf(0x0a)).toBe(inspectBytes[0]!.length - 1);
  expect(inspectBytes[0]!.includes(0x0d)).toBe(false);
  const inspectCommand = JSON.parse(
    inspectBytes[0]!.toString("utf8"),
  ) as Record<string, unknown>;
  expect(Object.keys(inspectCommand).sort()).toEqual(
    ["v", "kind", "requestId", "op", "executionId"].sort(),
  );
  expect(inspectCommand).toMatchObject({
    v: 1,
    kind: "command",
    op: "inspect",
    executionId: opened.binding.executionId,
  });
  expect(inspectCommand.requestId).not.toBe(closeCommand.requestId);
  if (!preempt)
    expect(
      frames.some(
        (frame) =>
          frame.kind === "state" &&
          frame.requestId === inspectCommand.requestId,
      ),
    ).toBe(true);
}

suite("Windows TS control-bridge host actual interop", () => {
  beforeAll(async () => {
    expect(process.platform).toBe("win32");
    for (const path of [bridgeExe, helperExe]) {
      expect(path && isAbsolute(path)).toBe(true);
      await access(path!);
    }
    const configuredRoot =
      process.env.ZEB_WINDOWS_CONTROL_BRIDGE_HOST_EVIDENCE_ROOT;
    if (configuredRoot) {
      expect(isAbsolute(configuredRoot)).toBe(true);
      await mkdir(configuredRoot, { recursive: true });
      evidenceRoot = configuredRoot;
    } else evidenceRoot = await mkdtemp(join(tmpdir(), "zeb-ts-control-host-"));
  });

  it(
    "binds, inspects and joins the original bridge with real dual EOF",
    () => exercise("ordinary", false),
    testTimeoutMs,
  );
  it(
    "preempts inspect with one close and joins the same original bridge",
    () => exercise("close-preempts-inspect", true),
    testTimeoutMs,
  );
});
