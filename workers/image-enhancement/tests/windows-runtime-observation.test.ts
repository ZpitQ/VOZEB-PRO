import assert from "node:assert/strict";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { freezeExecutionExit, type ClaimedAttempt, type OwnerDescriptor } from "../src/execution.js";
import * as hostModule from "../src/windows-control-bridge-host.js";
import {
  decodeWindowsControlBridgeResponse,
  freezeWindowsControlBridgeDescriptor,
} from "../src/windows-control-bridge-protocol.js";
import { createWindowsExecutionAdapter, type WindowsExecutionAdapter } from "../src/windows-execution-adapter.js";
import * as journalModule from "../src/windows-journal-launcher.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import {
  controlBridgeExecutionDescriptor,
  controlBridgeFixture,
  controlBridgeFrame,
  controlBridgeOptions,
  controlBridgeSnapshot,
  controlBridgeTestLimits,
  syntheticExecutionId,
} from "./windows-control-bridge-host-fixtures.js";
import { adapterBoundary, flushAdapter, sendPermission, type AdapterBoundary } from "./windows-execution-adapter-fixtures.js";
import { claimedAttempt } from "./windows-prepare-payload-fixtures.js";

// Local additive types keep the current modules loadable before F2a exists.
type Proc = { pid: number; creationFileTime: string };
type Token = { userSid: string; sessionId: number };
type Unknown = { state: "unknown"; reason: "unsupported" | "unavailable" | "permission" | "identity" | "no-match" | "incomplete" | "deadline" };
type Observation = {
  v: 1;
  background: { state: "observed"; host: Proc; worker: Proc & Token } | Unknown | null;
  engine: { state: "observed"; process: Proc & Token } | Unknown | null;
  gpu: { state: "not-started" | "pending" } | Unknown | {
    state: "observed";
    driverVersion: string;
    devices: { nvmlIndex: number; name: string; uuid: string | null; graphics: boolean; compute: boolean }[];
  };
};
type Receipt = { descriptor: OwnerDescriptor; observation: Observation };
const sid = "S-1-5-80-1-2-3-4-5";
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
const runs: ReturnType<typeof controlBridgeFixture>[] = [];
const boundaries: AdapterBoundary[] = [];
const adapters: WindowsExecutionAdapter[] = [];

beforeEach(() => {
  spawnMock.mockReset();
});
afterEach(async () => {
  try {
    for (const boundary of boundaries.splice(0)) boundary.release();
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
    for (const run of runs.splice(0)) run.dispose();
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

function observation(owner: OwnerDescriptor) {
  const engine = owner.details.engine as Proc;
  return {
    v: 1 as const,
    background: {
      state: "observed" as const,
      host: { pid: 11_000, creationFileTime: "9007199254740991" },
      worker: { pid: 11_001, creationFileTime: "9007199254740992", userSid: sid, sessionId: 0 },
    },
    engine: { state: "observed" as const, process: { ...engine, userSid: sid, sessionId: 0 } },
    gpu: {
      state: "observed" as const,
      driverVersion: "580.97",
      devices: [
        { nvmlIndex: 0, name: "Fixture GPU", uuid: null as string | null, graphics: true, compute: false },
        { nvmlIndex: 1, name: "Fixture GPU", uuid: "GPU-11111111-1111-1111-1111-111111111111", graphics: false, compute: true },
      ],
    },
  };
}

function deepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) deepFrozen(child);
}

function freezeFixture<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeFixture(child);
    Object.freeze(value);
  }
  return value;
}

const field = (value: object): unknown => Reflect.get(value, "runtimeObservation");
function ownerFor(attempt = claimedAttempt()) {
  const request = freezeWindowsPrepareRequest(attempt, "boot-v1");
  return freezeWindowsControlBridgeDescriptor(controlBridgeExecutionDescriptor(
    { identity: attempt.identity, launchTicket: attempt.launchTicket },
    attempt.executionPolicy.fingerprint,
    request.requestFingerprint,
  ));
}
function running(owner: OwnerDescriptor) {
  return controlBridgeSnapshot({
    phase: "running",
    requestFingerprint: owner.details.requestFingerprint as string,
    descriptor: owner,
    authorizationVerified: true,
    resumeState: "succeeded",
  });
}
function frame(owner: OwnerDescriptor, value?: Observation | null) {
  const result = {
    v: 1,
    kind: "state",
    requestId: null,
    executionId: owner.executionId,
    state: { ...running(owner), ...(value === undefined ? {} : { runtimeObservation: value }) },
  };
  if (value === undefined) Reflect.deleteProperty(result.state, "runtimeObservation");
  return result;
}
function decodeState(value: unknown) {
  const result = decodeWindowsControlBridgeResponse(controlBridgeFrame(value), 6);
  assert.equal(result.kind, "state");
  assert.ok(result.kind === "state");
  return result.state;
}

describe("runtime observation response shape", () => {
  it.each(["missing", "null"] as const)("normalizes the old %s observation to null", (kind) => {
    const owner = ownerFor();
    let parsed: ReturnType<typeof decodeState> | undefined;
    expect(() => { parsed = decodeState(frame(owner, kind === "null" ? null : undefined)); }).not.toThrow();
    assert.ok(parsed);
    expect(field(parsed)).toBeNull();
  });

  it("accepts and deeply freezes same-identity multi-device facts with a missing UUID", () => {
    const owner = ownerFor();
    const value = observation(owner);
    let parsed: ReturnType<typeof decodeState> | undefined;
    expect(() => { parsed = decodeState(frame(owner, value)); }).not.toThrow();
    assert.ok(parsed);
    expect(field(parsed)).toEqual(value);
    deepFrozen(field(parsed));
    expect(value.gpu.devices.map((device) => device.nvmlIndex)).toEqual([0, 1]);
  });

  it.each(["pending", "unknown"] as const)("keeps independent %s evidence valid", (kind) => {
    const owner = ownerFor();
    const value: Observation = kind === "pending"
      ? { v: 1, background: null, engine: null, gpu: { state: "pending" } }
      : { ...observation(owner), gpu: { state: "unknown", reason: "permission" } };
    let parsed: ReturnType<typeof decodeState> | undefined;
    expect(() => { parsed = decodeState(frame(owner, value)); }).not.toThrow();
    assert.ok(parsed);
    expect(field(parsed)).toEqual(value);
    deepFrozen(field(parsed));
  });

  const invalid: [string, (value: ReturnType<typeof observation>) => void][] = [
    ["extra field", (value) => { Reflect.set(value, "ready", true); }],
    ["wrong engine", (value) => { value.engine.process.pid++; }],
    ["worker session", (value) => { value.background.worker.sessionId = 1; }],
    ["engine session", (value) => { value.engine.process.sessionId = 1; }],
    ["different User SID", (value) => { value.engine.process.userSid = "S-1-5-80-5-4-3-2-1"; }],
    ["invalid SID", (value) => { value.engine.process.userSid = value.background.worker.userSid = "not-a-sid"; }],
    ["uint overflow", (value) => { value.gpu.devices[0]!.nvmlIndex = 4_294_967_296; }],
    ["duplicate device", (value) => { value.gpu.devices[1]!.nvmlIndex = 0; }],
    ["descending devices", (value) => { value.gpu.devices.reverse(); }],
    ["no devices", (value) => { value.gpu.devices.length = 0; }],
    ["neither context", (value) => { value.gpu.devices[0]!.graphics = false; }],
  ];
  it.each(invalid)("rejects observation %s", (_name, change) => {
    const owner = ownerFor();
    const value = observation(owner);
    change(value);
    expect(() => decodeState(frame(owner, value))).toThrow();
  });

  it("rejects noncanonical numeric tokens in the new uint field", () => {
    const owner = ownerFor();
    const raw = controlBridgeFrame(frame(owner, observation(owner))).toString("utf8");
    const altered = raw.replace('"nvmlIndex":0', '"nvmlIndex":0e0');
    expect(altered).not.toBe(raw);
    expect(() => decodeWindowsControlBridgeResponse(Buffer.from(altered), 6)).toThrow();
  });

  it("requires the original descriptor alongside any nonnull observation", () => {
    const owner = ownerFor();
    const value = frame(owner, observation(owner));
    value.state.descriptor = null;
    expect(() => decodeState(value)).toThrow();
  });
});

async function hostCase(marked = true) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const run = controlBridgeFixture();
  runs.push(run);
  spawnMock.mockReturnValueOnce(run.child);
  const options = controlBridgeOptions({ limits: {
    ...controlBridgeTestLimits,
    maxRequestFrameBytes: controlBridgeTestLimits.maxResponseFrameBytes,
    maxJsonDepth: 6,
  } });
  const host = hostModule.createWindowsControlBridgeHost(options);
  const opening = host.open(new AbortController().signal, () => true);
  run.spawn();
  run.output(run.bound());
  expect((await opening).kind).toBe("bound");
  const attempt = claimedAttempt();
  const request = freezeWindowsPrepareRequest(attempt, marked ? "boot-v1" : undefined);
  const expected = {
    target: { identity: attempt.identity, launchTicket: attempt.launchTicket },
    executionPolicyFingerprint: attempt.executionPolicy.fingerprint,
  };
  const owner = freezeWindowsControlBridgeDescriptor(controlBridgeExecutionDescriptor(
    expected.target, expected.executionPolicyFingerprint, request.requestFingerprint,
  ));
  async function reply(op: "prepare" | "authorize", pending: Promise<unknown>) {
    const command = run.command();
    expect(command.op).toBe(op);
    run.output({ v: 1, kind: "permit-request", requestId: command.requestId, op,
      executionId: syntheticExecutionId, requestFingerprint: request.requestFingerprint });
    run.output({ v: 1, kind: "state", requestId: command.requestId,
      executionId: syntheticExecutionId, state: op === "authorize" ? running(owner) : controlBridgeSnapshot({
        phase: "prepared", requestFingerprint: request.requestFingerprint, descriptor: owner,
      }) });
    expect(await pending).toMatchObject({ kind: op === "prepare" ? "prepared" : "authorized" });
  }
  await reply("prepare", host.prepare(request, expected, sendPermission().guard));
  await reply("authorize", host.authorize(expected.target, owner, request.requestFingerprint, sendPermission().guard));
  return {
    run, host, owner,
    event(value: Observation) { run.output(frame(owner, value)); },
    async finish(outcome: "stopped" | "unknown" = "stopped", late?: Observation) {
      const pending = host.whenClosed();
      run.output({ v: 1, kind: "ending", executionId: syntheticExecutionId });
      if (late) run.output(frame(owner, late));
      run.output({ v: 1, kind: "closed", requestId: null, executionId: syntheticExecutionId, outcome });
      await run.naturalFullJoin();
      return pending;
    },
    async closeWithLate(value: Observation) {
      const pending = host.close();
      const command = run.command();
      expect(command.op).toBe("close");
      run.output(frame(owner, value));
      run.output({ v: 1, kind: "closed", requestId: command.requestId,
        executionId: syntheticExecutionId, outcome: "stopped" });
      await run.naturalFullJoin();
      return pending;
    },
  };
}

describe.runIf(process.platform === "win32")("Host retains only permitted original observation facts", () => {
  it("preserves the exact old stopped-close shape without observations", async () => {
    const h = await hostCase(false);
    const result = await h.finish();
    expect(result).toEqual({ kind: "stopped", cleanup: "closed" });
    expect(Reflect.ownKeys(result).sort()).toEqual(["cleanup", "kind"]);
  });

  it("retains a same-scope unsolicited event through the original known close", async () => {
    const h = await hostCase();
    const value = observation(h.owner);
    h.event(value);
    const result = await h.finish();
    expect(result).toMatchObject({ kind: "stopped", cleanup: "closed" });
    expect(field(result)).toEqual({ descriptor: h.owner, observation: value });
    deepFrozen(field(result));
  });

  it("rejects observation facts on an unmarked nine-key request", async () => {
    const h = await hostCase(false);
    h.event(observation(h.owner));
    const result = await h.finish();
    expect(result.kind).toBe("unknown");
    expect(Reflect.has(result, "runtimeObservation")).toBe(false);
  });

  it("never appends a receipt to an Unknown close", async () => {
    const h = await hostCase();
    h.event(observation(h.owner));
    const result = await h.finish("unknown");
    expect(result.kind).toBe("unknown");
    expect(Reflect.ownKeys(result).sort()).toEqual(["cleanup", "kind"]);
  });

  it.each(["seal", "ending"] as const)("does not add new facts after %s", async (when) => {
    const h = await hostCase();
    const result = when === "ending"
      ? await h.finish("stopped", observation(h.owner))
      : await h.closeWithLate(observation(h.owner));
    expect(Reflect.has(result, "runtimeObservation")).toBe(false);
  });

  it("does not upgrade an already Unknown GPU observation to observed", async () => {
    const h = await hostCase();
    h.event({ ...observation(h.owner), gpu: { state: "unknown", reason: "no-match" } });
    h.event(observation(h.owner));
    const result = await h.finish();
    const receipt = field(result) as Receipt | undefined;
    expect(receipt?.observation.gpu.state).not.toBe("observed");
  });
});

function ports(attempt: ClaimedAttempt = claimedAttempt()) {
  const b = adapterBoundary(attempt);
  boundaries.push(b);
  const request = freezeWindowsPrepareRequest(attempt, "boot-v1");
  const owner = freezeWindowsControlBridgeDescriptor({
    ...b.descriptor, details: { ...b.descriptor.details, requestFingerprint: request.requestFingerprint },
  });
  return { b, request, owner };
}
type Ports = ReturnType<typeof ports>;
function setupAdapter() {
  const first = ports();
  const host = vi.spyOn(hostModule, "createWindowsControlBridgeHost").mockReturnValueOnce(first.b.host);
  const reader = vi.spyOn(journalModule, "createWindowsJournalLauncher").mockReturnValueOnce(first.b.reader);
  const adapter = createWindowsExecutionAdapter(first.b.options, () => true);
  adapters.push(adapter);
  return { first, adapter, enqueue(next: Ports) {
    host.mockReturnValueOnce(next.b.host);
    reader.mockReturnValueOnce(next.b.reader);
  } };
}
async function prepareAdapter(adapter: WindowsExecutionAdapter, p: Ports) {
  const permission = sendPermission();
  const pending = adapter.prepare(p.b.attempt, permission.guard);
  void pending.catch(() => {});
  await flushAdapter();
  expect(p.b.host.prepare.mock.calls[0]?.[0]).toEqual(p.request);
  expect(p.b.host.prepare.mock.calls[0]?.[2].takeSendPermission()).toBe(true);
  p.b.prepared.resolve({ kind: "prepared", descriptor: p.owner });
  await expect(pending).resolves.toEqual(p.owner);
  const auth = sendPermission();
  const authorized = adapter.authorize(p.b.attempt, p.owner, auth.guard);
  void authorized.catch(() => {});
  await flushAdapter();
  expect(p.b.host.authorize.mock.calls[0]?.[3].takeSendPermission()).toBe(true);
  p.b.authorized.resolve({ kind: "authorized" });
  await authorized;
}
function receipt(p: Ports, owner = p.owner): Receipt {
  return freezeFixture({ descriptor: owner, observation: observation(owner) });
}
function knownClose(value?: Receipt) {
  return freezeFixture({ kind: "stopped" as const, cleanup: "closed" as const,
    ...(value === undefined ? {} : { runtimeObservation: value }) });
}
async function finishAdapter(p: Ports, value?: Receipt) {
  p.b.closed.resolve(knownClose(value));
  await flushAdapter();
  expect(p.b.reader.read).toHaveBeenCalledTimes(1);
  const exit = freezeExecutionExit({ ...p.b.terminal().exit, descriptor: p.owner }, p.b.scope.target, p.owner);
  p.b.read.resolve({ kind: "read", cleanup: "closed", interpretation: { kind: "engine-exit", exit } });
  await flushAdapter();
}

describe.runIf(process.platform === "win32")("Adapter forwards current Entry known-close receipts", () => {
  it("preserves the original three status fields with no receipt", async () => {
    const h = setupAdapter();
    await prepareAdapter(h.adapter, h.first);
    await finishAdapter(h.first);
    expect(h.adapter.status()).toEqual({ sealed: false, activity: "idle", close: "not_requested" });
    expect(Reflect.ownKeys(h.adapter.status()).sort()).toEqual(["activity", "close", "sealed"]);
  });

  it("forwards the same Entry receipt only after the actual Host close result", async () => {
    const h = setupAdapter();
    await prepareAdapter(h.adapter, h.first);
    expect(Reflect.has(h.adapter.status(), "runtimeObservation")).toBe(false);
    const value = receipt(h.first);
    await finishAdapter(h.first, value);
    const status = h.adapter.status();
    expect(status).toMatchObject({ sealed: false, activity: "idle", close: "not_requested" });
    expect(field(status)).toEqual(value);
    deepFrozen(field(status));
  });

  it.each(["executionId", "requestFingerprint", "executionPolicyFingerprint", "installationManifestSha256"] as const)(
    "does not borrow a receipt with a different %s",
    async (key) => {
      const h = setupAdapter();
      await prepareAdapter(h.adapter, h.first);
      const original = h.first.owner;
      const owner = freezeWindowsControlBridgeDescriptor(key === "executionId"
        ? { ...original, executionId: "f".repeat(32) }
        : { ...original, details: { ...original.details, [key]: "f".repeat(64) } });
      await finishAdapter(h.first, receipt(h.first, owner));
      expect(Reflect.has(h.adapter.status(), "runtimeObservation")).toBe(false);
    },
  );

  it("does not carry a known receipt into a replacement Entry", async () => {
    const h = setupAdapter();
    await prepareAdapter(h.adapter, h.first);
    await finishAdapter(h.first, receipt(h.first));
    const original = claimedAttempt();
    const next = ports({ ...original,
      identity: { ...original.identity, jobId: "next-observation-job", fence: original.identity.fence + 1 },
      launchTicket: "next-observation-ticket", job: { ...original.job, jobId: "next-observation-job" } });
    h.enqueue(next);
    await prepareAdapter(h.adapter, next);
    expect(Reflect.has(h.adapter.status(), "runtimeObservation")).toBe(false);
  });

  it.each(["host", "reader"] as const)("removes receipt authority when %s cleanup is Unknown", async (where) => {
    const h = setupAdapter();
    await prepareAdapter(h.adapter, h.first);
    const value = receipt(h.first);
    if (where === "host") {
      const result = { kind: "unknown" as const, cleanup: "unknown" as const, runtimeObservation: value };
      h.first.b.closed.resolve(result);
      await flushAdapter();
    } else {
      h.first.b.closed.resolve(knownClose(value));
      await flushAdapter();
      h.first.b.read.resolve({ kind: "unknown", cleanup: "unknown" });
      await flushAdapter();
    }
    expect(h.adapter.status().activity).toBe("cleanup_unknown");
    expect(Reflect.has(h.adapter.status(), "runtimeObservation")).toBe(false);
  });
});
