import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { beforeAll, describe, expect, it } from "vitest";

import { runnerLimits } from "./storage-fixtures.js";

type ObjectValue = Record<string, unknown>;
type Identity = { pid: number; createdFileTime: string };
type State = {
  phase: "unclaimed" | "claimed" | "sealed";
  sealReason: null | "owner_eof" | "controller_exit" | "stop";
};
type Response = {
  v: 1;
  kind: "response";
  requestId: string;
  op: "claim" | "inspect" | "watch" | "stop";
  executionId: string;
  role: "owner" | "observer";
  state: State;
};
type Event = {
  v: 1;
  kind: "event";
  event: "state";
  executionId: string;
  state: State;
};
type Target = {
  identity: Identity;
  processHandleNonInherited: boolean;
  sameSid: boolean;
  alive: boolean;
  exitCode: number | null;
  readyLine: string | null;
  ready: unknown;
  stdout: string[];
  stderr: string[];
  stdoutEof: boolean;
  stderrEof: boolean;
  stdoutError: string | null;
  stderrError: string | null;
  handoff: {
    controllerIdentity: Identity;
    controllerRetainsHelperHandle: boolean;
    originalHelperProcessHandleNonInherited: boolean;
    controllerProcessHandleNonInherited: boolean;
  };
};
type Receipt = {
  scenario: string;
  values: Record<string, unknown>;
  targets: Target[];
  agents: {
    identity: Identity;
    alive: boolean;
    exitCode: number | null;
    nonInherited: boolean;
    stdoutEof: boolean;
    stderrEof: boolean;
    stdoutError: string | null;
    stderrError: string | null;
    stdout: string[];
    stderr: string[];
    pipes: Record<string, unknown>;
  }[];
  failure: null | { type: string; message: string; stage: string };
  cleanup: {
    failures: unknown[];
    ownership: {
      membershipVerified: boolean;
      observedOwnedProcessCount: number;
      liveOwnedProcesses: number;
      allObservedJoined: boolean;
      nonInherited: boolean;
      processes: { identity: Identity; alive: boolean }[];
    } | null;
  };
};

const fixtureVariable = process.env.ZEB_WINDOWS_CONTROL_FIXTURE_EXE;
const supervisorVariable = process.env.ZEB_WINDOWS_SUPERVISOR_EXE;
const explicitlyRequested =
  fixtureVariable !== undefined ||
  supervisorVariable !== undefined ||
  process.argv.some((argument) =>
    argument.includes("windows-supervisor.os.test"),
  );
const windowsSuite =
  process.platform === "win32" || explicitlyRequested
    ? describe
    : describe.skip;
const executionMs = runnerLimits.executionTimeoutMs;
const cleanupMs = runnerLimits.cancelGraceMs;
const testMs = executionMs + cleanupMs;
const pipeFullControlMask = 0x001f019f;

async function bounded<T>(promise: Promise<T>, milliseconds = executionMs) {
  const signal = AbortSignal.timeout(milliseconds);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Windows control fixture deadline exceeded")),
        { once: true },
      );
    }),
  ]);
}

function object(value: unknown): ObjectValue {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as ObjectValue;
}

function array(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

function keys(value: ObjectValue, expected: string[]) {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

function identity(value: unknown): Identity {
  const result = object(value);
  keys(result, ["pid", "createdFileTime"]);
  expect(result.pid).toEqual(expect.any(Number));
  expect(Number.isInteger(result.pid)).toBe(true);
  expect(result.pid).toBeGreaterThan(0);
  expect(result.createdFileTime).toEqual(expect.stringMatching(/^\d+$/));
  expect(BigInt(result.createdFileTime as string)).toBeGreaterThan(0n);
  return result as Identity;
}

function state(value: unknown): State {
  const result = object(value);
  keys(result, ["phase", "sealReason"]);
  expect(["unclaimed", "claimed", "sealed"]).toContain(result.phase);
  if (result.phase === "sealed") {
    expect(["owner_eof", "controller_exit", "stop"]).toContain(
      result.sealReason,
    );
  } else expect(result.sealReason).toBeNull();
  return result as State;
}

function response(
  value: unknown,
  phase: State["phase"],
  role?: Response["role"],
  reason: State["sealReason"] = null,
): Response {
  const result = object(value);
  keys(result, [
    "v",
    "kind",
    "requestId",
    "op",
    "executionId",
    "role",
    "state",
  ]);
  expect(result.v).toBe(1);
  expect(result.kind).toBe("response");
  expect(result.requestId).toEqual(expect.any(String));
  expect((result.requestId as string).length).toBeGreaterThan(0);
  expect(["claim", "inspect", "watch", "stop"]).toContain(result.op);
  expect(result.executionId).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
  expect(["owner", "observer"]).toContain(result.role);
  if (role) expect(result.role).toBe(role);
  expect(state(result.state)).toEqual({ phase, sealReason: reason });
  return result as Response;
}

function error(value: unknown, code: string) {
  const result = object(value);
  keys(result, ["v", "kind", "requestId", "code"]);
  expect(result).toMatchObject({ v: 1, kind: "error", code });
  expect(
    result.requestId === null ||
      (typeof result.requestId === "string" && result.requestId.length > 0),
  ).toBe(true);
  return result;
}

function event(
  value: unknown,
  phase: State["phase"],
  reason: State["sealReason"] = null,
): Event {
  const result = object(value);
  keys(result, ["v", "kind", "event", "executionId", "state"]);
  expect(result).toMatchObject({ v: 1, kind: "event", event: "state" });
  expect(result.executionId).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
  expect(state(result.state)).toEqual({ phase, sealReason: reason });
  return result as Event;
}

function security(value: unknown) {
  const result = object(value);
  expect(result).toMatchObject({
    ownerMatchesCurrentSid: true,
    daclPresent: true,
    protectedDacl: true,
    aceCount: 1,
  });
  expect(result.aces).toEqual([
    {
      qualifier: "AccessAllowed",
      flags: 0,
      accessMask: pipeFullControlMask,
      sidMatchesCurrent: true,
    },
  ]);
}

function pipe(value: unknown) {
  const result = object(value);
  const server = identity(result.serverIdentity);
  const client = identity(result.clientIdentity);
  expect(client.pid).not.toBe(server.pid);
  expect(result).toMatchObject({
    serverMatchesTrustedHandle: true,
    serverSameSid: true,
    serverProcessHandleNonInherited: true,
    clientProcessHandleNonInherited: true,
    pipeHandleNonInherited: true,
  });
  security(result.security);
  return { server, client };
}

function frames(value: unknown): ObjectValue[] {
  const snapshot = object(value);
  keys(snapshot, [
    "serverIdentity",
    "expectedExecutionId",
    "sentRequests",
    "writtenBase64",
    "rawFrames",
    "frames",
    "readerEnded",
    "readerError",
  ]);
  identity(snapshot.serverIdentity);
  expect(snapshot.expectedExecutionId).toEqual(
    expect.stringMatching(/^[0-9a-f]{32}$/),
  );
  expect(typeof snapshot.readerEnded).toBe("boolean");
  expect(snapshot.readerError, JSON.stringify(snapshot)).toBeNull();
  for (const bytes of array(snapshot.writtenBase64))
    expect(bytes).toEqual(expect.any(String));
  const requests = array(snapshot.sentRequests).map((value) => {
    const request = object(value);
    keys(request, ["v", "requestId", "op", "executionId"]);
    expect(request.v).toBe(1);
    expect(request.requestId).toEqual(expect.any(String));
    expect((request.requestId as string).length).toBeGreaterThan(0);
    expect(["claim", "inspect", "watch", "stop"]).toContain(request.op);
    expect(request.executionId).toEqual(expect.any(String));
    return request;
  });
  const received = array(snapshot.frames).map(object);
  const raw = array(snapshot.rawFrames);
  expect(raw).toHaveLength(received.length);
  for (const [index, text] of raw.entries()) {
    expect(text).toEqual(expect.any(String));
    expect(JSON.parse(text as string)).toEqual(received[index]);
  }
  for (const frame of received) {
    switch (frame.kind) {
      case "response": {
        const current = state(frame.state);
        const actual = response(
          frame,
          current.phase,
          undefined,
          current.sealReason,
        );
        const request = [...requests]
          .reverse()
          .find((request) => request.requestId === actual.requestId);
        expect(request, JSON.stringify(snapshot)).toBeDefined();
        expect(actual.op).toBe(request!.op);
        expect(actual.executionId).toBe(request!.executionId);
        expect(actual.executionId).toBe(snapshot.expectedExecutionId);
        break;
      }
      case "event": {
        const current = state(frame.state);
        const actual = event(frame, current.phase, current.sealReason);
        expect(actual.executionId).toBe(snapshot.expectedExecutionId);
        break;
      }
      case "error":
        expect([
          "invalid_request",
          "scope_mismatch",
          "controller_mismatch",
          "owner_already_claimed",
          "sealed",
        ]).toContain(frame.code);
        error(frame, frame.code as string);
        if (frame.code !== "invalid_request")
          expect(
            requests.some((request) => request.requestId === frame.requestId),
            JSON.stringify(snapshot),
          ).toBe(true);
        break;
      default:
        throw new Error(
          `Unexpected Windows control pipe frame: ${JSON.stringify(frame)}`,
        );
    }
  }
  return received;
}

function events(value: unknown, phase?: State["phase"]) {
  return frames(value).filter(
    (frame) =>
      frame.kind === "event" && (!phase || object(frame.state).phase === phase),
  );
}

function closedInvalid(value: unknown, before?: unknown) {
  const snapshot = object(value);
  expect(snapshot.readerEnded).toBe(true);
  const received = frames(snapshot);
  const prefix = before === undefined ? [] : frames(before);
  expect(received.slice(0, prefix.length)).toEqual(prefix);
  for (const frame of received.slice(prefix.length))
    error(frame, "invalid_request");
}

function validateProtocolFrames(value: unknown, targets: Target[]): void {
  if (Array.isArray(value)) {
    for (const child of value) validateProtocolFrames(child, targets);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const result = value as ObjectValue;
  // Only actual pipe snapshots get the exhaustive protocol kind whitelist;
  // ordinary private receipt objects have their own unrelated kinds/fields.
  if (
    Object.prototype.hasOwnProperty.call(result, "frames") &&
    Object.prototype.hasOwnProperty.call(result, "readerEnded") &&
    Object.prototype.hasOwnProperty.call(result, "readerError")
  ) {
    frames(result);
    const server = identity(result.serverIdentity);
    const target = targets.find(
      (target) =>
        target.identity.pid === server.pid &&
        target.identity.createdFileTime === server.createdFileTime,
    );
    expect(target, JSON.stringify(result)).toBeDefined();
    const ready = object(target!.ready);
    keys(ready, ["v", "kind", "executionId"]);
    expect(ready).toMatchObject({
      v: 1,
      kind: "ready",
      executionId: result.expectedExecutionId,
    });
    return;
  }
  if (["response", "event", "error"].includes(result.kind as string)) {
    if (result.kind === "response") {
      const current = state(result.state);
      response(result, current.phase, undefined, current.sealReason);
    } else if (result.kind === "event") {
      const current = state(result.state);
      event(result, current.phase, current.sealReason);
    } else if (result.kind === "error") {
      expect([
        "invalid_request",
        "scope_mismatch",
        "controller_mismatch",
        "owner_already_claimed",
        "sealed",
      ]).toContain(result.code);
      error(result, result.code as string);
    }
  }
  for (const child of Object.values(result))
    validateProtocolFrames(child, targets);
}

function cleanup(receipt: Receipt) {
  expect(receipt.cleanup.failures).toEqual([]);
  const owned = receipt.cleanup.ownership;
  expect(owned).not.toBeNull();
  expect(owned).toMatchObject({
    membershipVerified: true,
    liveOwnedProcesses: 0,
    allObservedJoined: true,
    nonInherited: true,
  });
  expect(owned!.observedOwnedProcessCount).toBeGreaterThan(0);
  expect(owned!.processes.every((process) => !process.alive)).toBe(true);
  for (const target of receipt.targets) {
    identity(target.identity);
    expect(target).toMatchObject({
      alive: false,
      processHandleNonInherited: true,
      sameSid: true,
      stdoutEof: true,
      stderrEof: true,
      stdoutError: null,
      stderrError: null,
    });
    expect(target.exitCode).not.toBeNull();
    expect(target.handoff).toMatchObject({
      controllerRetainsHelperHandle: true,
      originalHelperProcessHandleNonInherited: true,
      controllerProcessHandleNonInherited: true,
    });
  }
  for (const agent of receipt.agents) {
    identity(agent.identity);
    expect(agent).toMatchObject({
      alive: false,
      nonInherited: true,
      stdoutEof: true,
      stderrEof: true,
      stdoutError: null,
      stderrError: null,
    });
    expect(agent.exitCode).not.toBeNull();
    expect(agent.stderr).toEqual([]);
  }
}

class ControlFixture {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ready: Promise<ObjectValue>;
  private readonly closed: Promise<void>;
  private readonly pending = new Map<
    number,
    { resolve(receipt: Receipt): void; reject(error: Error): void }
  >();
  private sequence = 0;
  private stdout = "";
  private stderr = "";
  private outputFailure: Error | undefined;

  constructor(executable: string, supervisor: string, directory: string) {
    this.child = spawn(
      executable,
      [
        "harness",
        supervisor,
        directory,
        String(executionMs),
        String(cleanupMs),
      ],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.stdout += chunk;
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.closed = new Promise((resolveClosed) => {
      this.child.once("close", () => {
        for (const pending of this.pending.values())
          pending.reject(
            new Error(`Harness closed: ${this.stdout}\n${this.stderr}`),
          );
        this.pending.clear();
        resolveClosed();
      });
    });
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.child.once("error", rejectReady);
      this.child.once("close", () =>
        rejectReady(
          new Error(
            `Harness closed before ready: ${this.stdout}\n${this.stderr}`,
          ),
        ),
      );
      const lines = createInterface({ input: this.child.stdout });
      lines.on("line", (line) => {
        try {
          const frame = JSON.parse(line) as ObjectValue;
          if (frame.kind === "harness-ready") {
            resolveReady(frame);
            return;
          }
          const pending = this.pending.get(frame.id as number);
          if (!pending) throw new Error("Uncorrelated fixture reply");
          this.pending.delete(frame.id as number);
          // A scenario failure still returns its complete real observation and
          // cleanup evidence; assertions never lose those fields to setup errors.
          pending.resolve(frame.value as Receipt);
        } catch (caught) {
          const failure = new Error(`Malformed fixture output: ${line}`, {
            cause: caught,
          });
          this.outputFailure = failure;
          rejectReady(failure);
          for (const pending of this.pending.values()) pending.reject(failure);
          this.pending.clear();
        }
      });
    });
  }

  async loaded() {
    const ready = await bounded(this.ready);
    expect(ready.kind).toBe("harness-ready");
    identity(ready.identity);
    expect(ready).toMatchObject({
      selfProcessHandleNonInherited: true,
      guardHandleNonInherited: true,
      sameSid: true,
      productionAssemblyReferenced: false,
    });
  }

  async run(scenario: string) {
    const id = ++this.sequence;
    const result = new Promise<Receipt>((resolveReceipt, reject) => {
      this.pending.set(id, { resolve: resolveReceipt, reject });
      this.child.stdin.write(
        `${JSON.stringify({ id, scenario })}\n`,
        (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
    const receipt = await bounded(result, testMs);
    console.info(`WINDOWS_CONTROL_RECEIPT ${JSON.stringify(receipt)}`);
    return receipt;
  }

  async close() {
    this.child.stdin.end();
    await bounded(this.closed, cleanupMs);
    expect(this.child.exitCode, `${this.stdout}\n${this.stderr}`).toBe(0);
    expect(this.stderr).toBe("");
    expect(this.outputFailure).toBeUndefined();
  }
}

windowsSuite.sequential("Windows supervisor control B4-1B1a", () => {
  let executable: string;
  let supervisor: string;

  beforeAll(async () => {
    if (process.platform !== "win32")
      throw new Error(
        "Windows control OS file was requested on a non-Windows host",
      );
    if (!fixtureVariable || !supervisorVariable)
      throw new Error(
        "ZEB_WINDOWS_CONTROL_FIXTURE_EXE and ZEB_WINDOWS_SUPERVISOR_EXE must name the fixed published self-contained EXEs",
      );
    if (!isAbsolute(fixtureVariable) || !isAbsolute(supervisorVariable))
      throw new Error("Published EXE paths must be absolute");
    executable = resolve(fixtureVariable);
    supervisor = resolve(supervisorVariable);
    await Promise.all([access(executable), access(supervisor)]);
  }, testMs);

  async function withFixture(
    scenario: string,
    run: (receipt: Receipt) => void,
  ) {
    const directory = await mkdtemp(join(tmpdir(), "zeb-control-fixture-"));
    const fixture = new ControlFixture(executable, supervisor, directory);
    const failures: unknown[] = [];
    try {
      await fixture.loaded();
      const receipt = await fixture.run(scenario);
      expect(receipt.scenario).toBe(scenario);
      expect(receipt.failure, JSON.stringify(receipt)).toBeNull();
      cleanup(receipt);
      validateProtocolFrames(receipt.values, receipt.targets);
      for (const agent of receipt.agents) {
        validateProtocolFrames(agent.pipes, receipt.targets);
        // Preserve and validate earlier snapshots too, including those in a
        // controller's intentional-exit envelope rather than a live RPC.
        for (const line of agent.stdout) {
          const envelope = object(JSON.parse(line));
          if (Object.prototype.hasOwnProperty.call(envelope, "pipes"))
            validateProtocolFrames(envelope.pipes, receipt.targets);
        }
      }
      const executionIds = receipt.targets
        .map((target) => target.ready)
        .filter((ready) => ready !== null && object(ready).kind === "ready")
        .map((ready) => object(ready).executionId);
      expect(new Set(executionIds).size).toBe(executionIds.length);
      run(receipt);
    } catch (error) {
      failures.push(error);
    }
    try {
      await fixture.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Windows control execution and cleanup failed",
      );
  }

  it(
    "private harness positive control proves independent pipe identity, ACL, duplicated streams and exact Job cleanup",
    async () => {
      await withFixture("positive", (receipt) => {
        const loopback = object(receipt.values.loopback);
        expect(identity(loopback.serverIdentity)).toEqual(
          identity(loopback.trustedIdentity),
        );
        expect(identity(loopback.clientIdentity)).toEqual(
          identity(loopback.trustedIdentity),
        );
        expect(loopback).toMatchObject({
          sameSid: true,
          serverHandleNonInherited: true,
          clientHandleNonInherited: true,
          received: "private-loopback-中文",
        });
        security(loopback.security);
        const start = object(receipt.values.positiveTargetStartup);
        expect(start).toMatchObject({
          alive: true,
          processHandleNonInherited: true,
          sameSid: true,
        });
        const first = object(start.ready);
        expect(first.kind).toBe("fixture-positive");
        expect(identity(first.identity)).toEqual(identity(start.identity));
        expect(first.nonInherited).toBe(true);
        expect(receipt.values.positiveTargetStderr).toBe(
          "fixture-positive-stderr",
        );
        const rpcText = 'private-rpc-中文"引号\nline\r\t\\';
        expect(receipt.values.positiveRpcExpected).toBe(rpcText);
        const echoed = object(receipt.values.positiveRpc);
        expect(echoed.text).toBe(rpcText);
        expect(echoed.utf8Base64).toBe(
          Buffer.from(rpcText, "utf8").toString("base64"),
        );
        const encodings = object(receipt.values.positiveRpcEncodings);
        const expectedEncoding = {
          webName: "utf-8",
          codePage: 65001,
          encoderFallback: "EncoderExceptionFallback",
          decoderFallback: "DecoderExceptionFallback",
          preambleBytes: 0,
        };
        expect(encodings.expected).toEqual(expectedEncoding);
        const parentEncodings = object(encodings.parent);
        const childEncodings = object(echoed.consoleEncodings);
        keys(parentEncodings, ["stdin", "stdout", "stderr"]);
        keys(childEncodings, ["stdin", "stdout", "stderr"]);
        for (const stream of ["stdin", "stdout", "stderr"]) {
          expect(parentEncodings[stream]).toEqual(expectedEncoding);
          expect(childEncodings[stream]).toEqual(expectedEncoding);
        }
        expect(receipt.values.positiveTargetAliveBeforeCleanup).toBe(true);
        expect(receipt.targets).toHaveLength(1);
        expect(receipt.targets[0]!.stdout).toHaveLength(1);
        expect(receipt.targets[0]!.stderr).toEqual(["fixture-positive-stderr"]);
        expect(
          receipt.cleanup.ownership!.observedOwnedProcessCount,
        ).toBeGreaterThanOrEqual(2);
      });
    },
    testMs,
  );

  it(
    "C1 loaded supervisor supplies the exact ready/control contract and real unclaimed pipe inspection",
    async () => {
      await withFixture("C1", (receipt) => {
        const start = object(receipt.values.subjectStartup);
        identity(start.identity);
        expect(
          start.ready,
          `Loaded supervisor observation: ${JSON.stringify(start)}`,
        ).toEqual({
          v: 1,
          kind: "ready",
          executionId: expect.stringMatching(/^[0-9a-f]{32}$/),
        });
        expect(start).toMatchObject({
          alive: true,
          exitCode: null,
          processHandleNonInherited: true,
          sameSid: true,
        });
        const actual = pipe(receipt.values.subjectPipe);
        expect(actual.server).toEqual(start.identity);
        const inspected = response(
          receipt.values.inspect,
          "unclaimed",
          "observer",
        );
        expect(inspected.op).toBe("inspect");
        expect(inspected.executionId).toBe(object(start.ready).executionId);
        expect(receipt.values.helperAliveAfterInspect).toBe(true);
        expect(receipt.values.controllerAliveAfterInspect).toBe(true);
        expect(receipt.targets).toHaveLength(1);
        expect(receipt.targets[0]!.stdout).toEqual([start.readyLine]);
      });
    },
    testMs,
  );

  it(
    "C2 invalid bootstrap and a preoccupied first-instance pipe reject without ready or takeover",
    async () => {
      await withFixture("C2", (receipt) => {
        const invalid = array(receipt.values.invalidBootstrap).map(object);
        expect(invalid.length).toBeGreaterThan(0);
        expect(invalid.map((item) => item.label)).toContain(
          "signaled-controller-object",
        );
        for (const item of invalid) {
          const startup = object(item.startup);
          expect(startup.ready).toBeNull();
          expect(startup.readyLine).toBeNull();
          expect(startup.alive).toBe(false);
          expect(startup.exitCode).toEqual(expect.any(Number));
          expect(startup.exitCode).not.toBe(0);
          expect(startup.stdout).toEqual([]);
          expect(startup.stdoutEof).toBe(true);
          expect(startup.stderrEof).toBe(true);
        }
        const collision = object(receipt.values.collisionStartup);
        expect(collision.ready).toBeNull();
        expect(collision.alive).toBe(false);
        expect(collision.exitCode).not.toBe(0);
        expect(collision.stdout).toEqual([]);
        security(receipt.values.occupiedSecurity);
        const occupied = object(receipt.values.occupiedAfterCollision);
        expect(identity(occupied.serverIdentity)).toEqual(
          identity(occupied.trustedIdentity),
        );
        expect(occupied.received).toBe("occupied-original-owner");
        expect(occupied.handleNonInherited).toBe(true);
      });
    },
    testMs,
  );

  it(
    "C3 actual controller identity grants claim while another real same-SID process remains an observer",
    async () => {
      await withFixture("C3", (receipt) => {
        const values = receipt.values;
        response(values.observerInspect, "unclaimed", "observer");
        response(values.observerWatch, "unclaimed", "observer");
        error(values.observerClaim, "controller_mismatch");
        closedInvalid(values.forgedClosed);
        response(values.afterForged, "unclaimed", "observer");
        response(values.ownerClaim, "claimed", "owner");
        event(values.claimedEvent, "claimed");
        response(values.observerStop, "sealed", "observer", "stop");
        event(values.sealedEvent, "sealed", "stop");
        expect(events(values.finalWatchFrames, "claimed")).toHaveLength(1);
        expect(events(values.finalWatchFrames, "sealed")).toHaveLength(1);
        const start = object(values.subjectStartup);
        const actual = pipe(values.subjectPipe);
        expect(actual.client.pid).not.toBe(
          object(object(start.handoff).controllerIdentity).pid,
        );
      });
    },
    testMs,
  );

  it(
    "C4 two connections in the pinned controller race for exactly one owner and only that connection repeats claim",
    async () => {
      await withFixture("C4", (receipt) => {
        const values = receipt.values;
        const claims = array(values.claims).map(object);
        const successes = claims.filter((item) => item.kind === "response");
        const denied = claims.filter((item) => item.kind === "error");
        expect(successes).toHaveLength(1);
        expect(denied).toHaveLength(1);
        response(successes[0], "claimed", "owner");
        error(denied[0], "owner_already_claimed");
        response(values.winnerRepeat, "claimed", "owner");
        response(values.winnerInspect, "claimed", "owner");
        const a = pipe(values.ownerA);
        const b = pipe(values.ownerB);
        expect(a.client).toEqual(b.client);
        expect(a.client).toEqual(identity(values.controllerIdentity));
        expect(events(values.watchFrames, "claimed")).toHaveLength(1);
        expect(events(values.watchFrames, "sealed")).toEqual([]);
      });
    },
    testMs,
  );

  it(
    "C5 watch ACK and real transitions never lose registration, duplicate subscriptions or invent late sealed events",
    async () => {
      await withFixture("C5", (receipt) => {
        const values = receipt.values;
        response(values.initialWatch, "unclaimed", "observer");
        response(values.repeatInitialWatch, "unclaimed", "observer");
        response(values.orderedClaim, "claimed", "owner");
        response(values.repeatClaim, "claimed", "owner");
        event(values.orderedClaimedEvent, "claimed");
        expect(events(values.orderedFrames, "claimed")).toHaveLength(1);
        response(values.lateWatch, "sealed", "observer", "stop");
        response(values.lateInspect, "sealed", "observer", "stop");
        expect(events(values.lateFrames)).toEqual([]);
        response(values.concurrentClaim, "claimed", "owner");
        const watch = object(values.concurrentWatch);
        const observed = state(watch.state);
        expect(["unclaimed", "claimed"]).toContain(observed.phase);
        response(watch, observed.phase, "observer");
        if (observed.phase === "unclaimed")
          event(values.concurrentEvent, "claimed");
        expect(events(values.concurrentFrames, "claimed")).toHaveLength(
          observed.phase === "claimed" ? 0 : 1,
        );
      });
    },
    testMs,
  );

  it(
    "C6 owner EOF seals authority while the pinned controller, helper and independent watcher remain live",
    async () => {
      await withFixture("C6", (receipt) => {
        const values = receipt.values;
        response(values.claim, "claimed", "owner");
        expect(object(values.ownerClosed).readerEnded).toBe(true);
        event(values.sealedEvent, "sealed", "owner_eof");
        expect(values.controllerAliveAtSeal).toBe(true);
        expect(values.helperAliveAtSeal).toBe(true);
        error(values.reclaim, "sealed");
        response(values.finalBarrier, "sealed", "observer", "owner_eof");
        expect(events(values.finalFrames, "sealed")).toHaveLength(1);
      });
    },
    testMs,
  );

  it(
    "C7 controller process signal seals an unclaimed session that never had an owner pipe",
    async () => {
      await withFixture("C7", (receipt) => {
        const values = receipt.values;
        response(values.watch, "unclaimed", "observer");
        expect(object(values.controllerBeforeExit).connectionKeys).toEqual([]);
        expect(object(values.controllerBeforeExit).helperCount).toBe(1);
        expect(values.controllerSignaled).toBe(true);
        expect(values.controllerExitCode).toBe(0);
        event(values.sealedEvent, "sealed", "controller_exit");
        expect(values.helperAliveAtSeal).toBe(true);
        expect(values.observerAliveAtSeal).toBe(true);
        error(values.lateClaim, "sealed");
        response(values.finalBarrier, "sealed", "observer", "controller_exit");
        expect(events(values.finalFrames, "claimed")).toEqual([]);
        expect(events(values.finalFrames, "sealed")).toHaveLength(1);
      });
    },
    testMs,
  );

  it(
    "C8 claimed controller exit preserves the first actual EOF/process-signal seal and sends no second conversion",
    async () => {
      await withFixture("C8", (receipt) => {
        const values = receipt.values;
        response(values.claim, "claimed", "owner");
        expect(values.controllerSignaled).toBe(true);
        expect(values.helperAliveAtSeal).toBe(true);
        expect(values.observerAliveAtSeal).toBe(true);
        const sealed = state(object(values.sealedEvent).state);
        expect(["owner_eof", "controller_exit"]).toContain(sealed.sealReason);
        event(values.sealedEvent, "sealed", sealed.sealReason);
        response(
          values.afterExitInspect,
          "sealed",
          "observer",
          sealed.sealReason,
        );
        response(values.afterExitStop, "sealed", "observer", sealed.sealReason);
        response(values.finalBarrier, "sealed", "observer", sealed.sealReason);
        expect(events(values.finalFrames, "sealed")).toHaveLength(1);
      });
    },
    testMs,
  );

  it(
    "C9 exact stop seals unclaimed and claimed sessions once while wrong scope preserves owner and helper lifetime",
    async () => {
      await withFixture("C9", (receipt) => {
        for (const name of ["unclaimed", "claimed"] as const) {
          const values = object(receipt.values[name]);
          response(values.watch, "unclaimed", "observer");
          error(values.wrongScopeStop, "scope_mismatch");
          response(values.afterWrongScope, name, "observer");
          if (name === "claimed") {
            response(values.claim, "claimed", "owner");
            response(values.ownerAfterWrongScope, "claimed", "owner");
          }
          const ack = response(values.stop, "sealed", "observer", "stop");
          event(values.sealedEvent, "sealed", "stop");
          response(values.repeatStop, "sealed", "observer", "stop");
          error(values.lateClaim, "sealed");
          expect(values.helperAliveAfterStop).toBe(true);
          const trace = frames(values.frames);
          const ackIndex = trace.findIndex(
            (frame) =>
              frame.kind === "response" && frame.requestId === ack.requestId,
          );
          const eventIndex = trace.findIndex(
            (frame) =>
              frame.kind === "event" && object(frame.state).phase === "sealed",
          );
          expect(ackIndex).toBeGreaterThanOrEqual(0);
          expect(eventIndex).toBeGreaterThan(ackIndex);
          expect(events(values.frames, "sealed")).toHaveLength(1);
        }
      });
    },
    testMs,
  );

  it(
    "C10 real UTF-8 byte fragments, escaped Unicode, merged frames and CRLF retain request IDs and wait for LF",
    async () => {
      await withFixture("C10", (receipt) => {
        const values = receipt.values;
        const unicode = response(
          values.unicodeResponse,
          "unclaimed",
          "observer",
        );
        expect(unicode.requestId).toBe(values.unicodeExpected);
        expect(unicode.requestId).toContain("中文");
        expect(object(values.unicodeWritten).writtenBytes).toBeGreaterThan(
          unicode.requestId.length,
        );
        expect(
          response(values.mergedOne, "unclaimed", "observer").requestId,
        ).toBe("merged-one");
        expect(
          response(values.mergedTwo, "unclaimed", "observer").requestId,
        ).toBe("merged-two");
        response(values.independentBarrier, "unclaimed", "observer");
        expect(frames(values.partialBeforeNewline)).toEqual([]);
        expect(object(values.partialBeforeNewline).readerEnded).toBe(false);
        expect(
          response(values.partialResponse, "unclaimed", "observer").requestId,
        ).toBe("partial-no-newline");
        expect(
          frames(values.frames).filter((frame) => frame.kind === "response"),
        ).toHaveLength(4);
        expect(values.helperAliveAfterLiteralData).toBe(true);
      });
    },
    testMs,
  );

  it(
    "C11 invalid UTF-8/JSON/property/type/op and EOF half-frames reject, with owner violations sealing only the original authority",
    async () => {
      await withFixture("C11", (receipt) => {
        const values = receipt.values;
        response(values.claim, "claimed", "owner");
        const invalid = array(values.invalidObservers).map(object);
        expect(invalid.map((item) => item.label)).toEqual([
          "invalid-utf8",
          "duplicate-property",
          "unknown-property",
          "unknown-op",
          "wrong-version-type",
          "wrong-id-type",
          "non-object",
          "invalid-json",
          "missing-field",
        ]);
        for (const rejected of invalid) {
          pipe(rejected.pipe);
          closedInvalid(rejected.closed);
          response(rejected.ownerInspect, "claimed", "owner");
        }
        expect(frames(values.halfBeforeClose)).toEqual([]);
        closedInvalid(values.halfClosed);
        response(values.ownerAfterHalfEof, "claimed", "owner");
        expect(object(values.ownerBeforeViolation).readerEnded).toBe(false);
        closedInvalid(values.invalidOwnerClosed, values.ownerBeforeViolation);
        event(values.sealedEvent, "sealed", "owner_eof");
        response(values.finalBarrier, "sealed", "observer", "owner_eof");
        expect(events(values.finalFrames, "sealed")).toHaveLength(1);
        for (const target of receipt.targets)
          expect(target.stderr.join("\n")).not.toContain(
            "private-invalid-body-sentinel",
          );
      });
    },
    testMs,
  );

  it(
    "C11-first malformed input closes the first actual observer peer with EOF and a fresh client still inspects unclaimed",
    async () => {
      await withFixture("C11-first", (receipt) => {
        const values = receipt.values;
        const firstPipe = pipe(values.firstPipe);
        expect(firstPipe.server).toEqual(
          identity(object(values.firstStartup).identity),
        );
        expect(firstPipe.client).not.toEqual(
          identity(receipt.targets[0]!.handoff.controllerIdentity),
        );
        const first = response(values.firstInspect, "unclaimed", "observer");
        const before = object(values.firstBeforeInvalid);
        expect(before.readerEnded).toBe(false);
        expect(frames(before)).toEqual([first]);
        expect(object(values.firstInvalidWritten).writtenBytes).toBeGreaterThan(
          0,
        );
        expect(frames(values.firstAfterInvalidBeforeEof).slice(0, 1)).toEqual([
          first,
        ]);
        expect(values.helperAliveBeforeEof).toBe(true);
        expect(values.controllerAliveBeforeEof).toBe(true);
        closedInvalid(values.firstClosed, before);
        expect(values.firstPendingOperation).toBeNull();
        const freshPipe = pipe(values.freshPipe);
        expect(freshPipe.server).toEqual(firstPipe.server);
        expect(freshPipe.client).toEqual(firstPipe.client);
        const fresh = response(values.freshInspect, "unclaimed", "observer");
        expect(fresh.executionId).toBe(first.executionId);
        expect(values.helperAliveAfterFreshInspect).toBe(true);
        expect(values.controllerAliveAfterFreshInspect).toBe(true);
      });
    },
    testMs,
  );

  it(
    "C12 wrong scope cannot subscribe or take authority, and confirmed seals plus real claim/stop races never reopen",
    async () => {
      await withFixture("C12", (receipt) => {
        const values = receipt.values;
        const mismatches = array(values.wrongScopeResponses);
        expect(mismatches).toHaveLength(4);
        for (const denied of mismatches) error(denied, "scope_mismatch");
        response(values.afterWrongScopes, "unclaimed", "observer");
        response(values.scopeClaim, "claimed", "owner");
        response(values.wrongScopeBarrier, "claimed", "observer");
        expect(events(values.wrongScopeFrames)).toEqual([]);
        event(values.stopEvent, "sealed", "stop");
        for (const name of [
          "lateOriginalClaim",
          "lateReplacementClaim",
          "lateObserverClaim",
        ])
          error(values[name], "sealed");
        expect(events(values.stopFrames, "sealed")).toHaveLength(1);
        event(values.eofEvent, "sealed", "owner_eof");
        error(values.lateEofClaim, "sealed");
        expect(events(values.eofFrames, "sealed")).toHaveLength(1);
        const raceClaim = object(values.raceClaim);
        const raceTrace = frames(values.raceFrames);
        const claimedEvents = events(values.raceFrames, "claimed");
        if (raceClaim.kind === "response") {
          response(raceClaim, "claimed", "owner");
          expect(claimedEvents).toHaveLength(1);
          const claimedIndex = raceTrace.findIndex(
            (frame) =>
              frame.kind === "event" && object(frame.state).phase === "claimed",
          );
          const sealedIndex = raceTrace.findIndex(
            (frame) =>
              frame.kind === "event" && object(frame.state).phase === "sealed",
          );
          expect(claimedIndex).toBeGreaterThanOrEqual(0);
          expect(sealedIndex).toBeGreaterThan(claimedIndex);
        } else {
          error(raceClaim, "sealed");
          expect(claimedEvents).toEqual([]);
        }
        response(values.raceStop, "sealed", "observer", "stop");
        event(values.raceEvent, "sealed", "stop");
        error(values.raceLateClaim, "sealed");
        response(values.raceFinalBarrier, "sealed", "observer", "stop");
        expect(events(values.raceFrames, "sealed")).toHaveLength(1);
      });
    },
    testMs,
  );
});
