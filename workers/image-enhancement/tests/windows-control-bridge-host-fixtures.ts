import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import type { ExecutionTarget, OwnerDescriptor } from "../src/execution.js";

import type {
  WindowsControlBridgeOptions,
  WindowsControlBridgeSnapshot,
} from "../src/windows-control-bridge-protocol.js";

// Test policy only. The production host has no default budgets.
export const controlBridgeTestLimits = {
  maxRequestFrameBytes: 1_024,
  maxResponseFrameBytes: 4_096,
  maxHelperStderrBytes: 128,
  maxSessionInputBytes: 8_192,
  maxSessionOutputBytes: 32_768,
  maxQueuedOutputBytes: 4_096,
  maxJsonDepth: 4,
  startupTimeoutMs: 100,
  requestTimeoutMs: 80,
  sessionTimeoutMs: 1_000,
  cleanupTimeoutMs: 30,
};

export const syntheticExecutionId = "a".repeat(32);

export function controlBridgeOptions(
  overrides: Partial<WindowsControlBridgeOptions> = {},
): WindowsControlBridgeOptions {
  return {
    executablePath: "Z:\\contract-only\\bridge's folder\\bridge.exe",
    helperPath: "Z:\\contract-only\\helper\\helper.exe",
    recordsRoot: "Z:\\contract-only\\records 🪑",
    installationRoot: "Z:\\contract-only\\installation",
    expectedManifestSha256: "b".repeat(64),
    environment: { SYNTHETIC_BRIDGE: "test-only 🪑" },
    limits: { ...controlBridgeTestLimits },
    ...overrides,
  };
}

export function controlBridgeSnapshot(
  overrides: Partial<WindowsControlBridgeSnapshot> = {},
): WindowsControlBridgeSnapshot {
  return {
    phase: "claimed",
    sealReason: null,
    requestFingerprint: null,
    descriptor: null,
    authorizationVerified: false,
    resumeState: "not-attempted",
    evidenceOutcome: "pending",
    completion: null,
    runtimeObservation: null,
    ...overrides,
  };
}

export function controlBridgeBound() {
  return {
    v: 1,
    kind: "bound",
    executionId: syntheticExecutionId,
    bridge: { pid: 12_001, creationFileTime: "9007199254740993" },
    helper: { pid: 12_002, creationFileTime: "18446744073709551615" },
    state: controlBridgeSnapshot(),
  };
}

export function controlBridgeExecutionDescriptor(
  target: ExecutionTarget,
  policy: string,
  requestFingerprint: string,
): OwnerDescriptor {
  return {
    adapterId: "windows-supervisor-v1",
    launchTicket: target.launchTicket,
    executionId: syntheticExecutionId,
    details: {
      v: 1,
      target,
      executionPolicyFingerprint: policy,
      requestFingerprint,
      requestRecordId: "00000000000000000000000000000001",
      preparedRecordId: "00000000000000000000000000000002",
      recipeId: "upscayl-4x-png-v1",
      installationManifestSha256: "b".repeat(64),
      supervisor: controlBridgeBound().helper,
      engine: { pid: 12_003, creationFileTime: "9007199254740995" },
      jobName: "execution-bridge-fixture-job-object",
    },
  };
}

export function controlBridgeFrame(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export function controlBridgePaddedFrame(
  value: unknown,
  length: number,
): Buffer {
  const bytes = controlBridgeFrame(value);
  if (length < bytes.length) throw new Error("invalid synthetic frame length");
  return Buffer.concat([
    bytes.subarray(0, -1),
    Buffer.alloc(length - bytes.length, 0x20),
    bytes.subarray(-1),
  ]);
}

export async function controlBridgeFlush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type SyntheticChild = EventEmitter & {
  pid: number | undefined;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  stdio: [Writable, PassThrough, PassThrough];
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(): boolean;
};

// Only spawn and child event order are injected. These are real Node streams,
// but no event or identity below is independent operating-system evidence.
export function controlBridgeFixture(
  scenario: {
    holdWrites?: boolean;
    holdFinal?: boolean;
    holdChildClose?: boolean;
  } = {},
) {
  const child = new EventEmitter() as SyntheticChild;
  const input: Buffer[] = [];
  const writes: ((error?: Error | null) => void)[] = [];
  const streamCloses = new Set<string>();
  let final: (() => void) | undefined;
  let exited = false;
  let childClosed = false;
  let killCount = 0;
  let destroyCount = 0;
  const closeChild = () => {
    if (
      !childClosed &&
      exited &&
      streamCloses.size === 3 &&
      !scenario.holdChildClose
    ) {
      childClosed = true;
      child.emit("close", child.exitCode, child.signalCode);
    }
  };
  child.pid = 12_001;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    killCount++;
    return true;
  };
  child.stdin = new Writable({
    autoDestroy: true,
    write(chunk: Buffer, _encoding, callback) {
      input.push(Buffer.from(chunk));
      if (scenario.holdWrites) writes.push(callback);
      else callback();
    },
    final(callback) {
      if (scenario.holdFinal) final = callback;
      else callback();
    },
  });
  child.stdout = new PassThrough({ autoDestroy: true });
  child.stderr = new PassThrough({ autoDestroy: true });
  child.stdio = [child.stdin, child.stdout, child.stderr];
  const originalStreams = [...child.stdio];
  for (const [name, stream] of [
    ["stdin", child.stdin],
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ] as const) {
    stream.on("error", () => undefined);
    stream.on("close", () => {
      streamCloses.add(name);
      closeChild();
    });
    const destroy = stream.destroy.bind(stream);
    stream.destroy = (error?: Error) => {
      destroyCount++;
      return destroy(error);
    };
  }
  const run = {
    child: child as unknown as ChildProcess,
    streams: child,
    input,
    options: controlBridgeOptions(),
    get killCount() {
      return killCount;
    },
    get destroyCount() {
      return destroyCount;
    },
    spawn() {
      child.emit("spawn");
    },
    output(value: unknown) {
      child.stdout.write(controlBridgeFrame(value));
    },
    bytes(bytes: Buffer) {
      child.stdout.write(bytes);
    },
    stderr(bytes: Buffer) {
      child.stderr.write(bytes);
    },
    bound: controlBridgeBound,
    command(index = input.length - 1): Record<string, unknown> {
      return JSON.parse(input[index]!.toString("utf8")) as Record<
        string,
        unknown
      >;
    },
    stateForLastCommand(state = controlBridgeSnapshot()) {
      const command = run.command();
      return {
        v: 1,
        kind: "state",
        requestId: command.requestId,
        executionId: syntheticExecutionId,
        state,
      };
    },
    closedForLastCommand(outcome: "stopped" | "unknown" = "stopped") {
      const command = run.command();
      return {
        v: 1,
        kind: "closed",
        requestId: command.requestId,
        executionId: syntheticExecutionId,
        outcome,
      };
    },
    settleWrite(error?: Error) {
      writes.shift()?.(error);
    },
    holdWrites() {
      scenario.holdWrites = true;
    },
    settleFinal() {
      final?.();
      final = undefined;
    },
    exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      exited = true;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
      closeChild();
    },
    endStdout() {
      child.stdout.end();
    },
    endStderr() {
      child.stderr.end();
    },
    async joinAllCloses() {
      await controlBridgeFlush();
    },
    async naturalFullJoin(
      code: number | null = 0,
      signal: NodeJS.Signals | null = null,
    ) {
      if (!child.stdin.writableEnded) child.stdin.end();
      child.stdout.end();
      child.stderr.end();
      run.exit(code, signal);
      await controlBridgeFlush();
    },
    dispose() {
      // Test teardown only, never asserted as natural lifecycle evidence.
      for (const stream of originalStreams) stream.destroy();
    },
  };
  return run;
}
