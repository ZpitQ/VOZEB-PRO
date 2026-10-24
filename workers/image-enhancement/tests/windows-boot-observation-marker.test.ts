import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startWindowsWorker } from "../src/bootstrap.js";
import { createWorkerConfig } from "../src/config.js";
import type { ClaimedAttempt } from "../src/execution.js";
import * as runnerModule from "../src/runner.js";
import * as storeModule from "../src/store.js";
import * as bridgeModule from "../src/windows-control-bridge-host.js";
import { freezeWindowsControlBridgeDescriptor } from "../src/windows-control-bridge-protocol.js";
import * as adapterModule from "../src/windows-execution-adapter.js";
import * as journalModule from "../src/windows-journal-launcher.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import { configInput } from "./fixtures.js";
import { transportLimits } from "./http-fixtures.js";
import { recoveryExecutor } from "./recovery-fixtures.js";
import {
  runnerLimits,
  storageFixture,
  submissionLimits,
} from "./storage-fixtures.js";
import {
  adapterBoundary,
  deferred,
  flushAdapter,
  sendPermission,
} from "./windows-execution-adapter-fixtures.js";
import { runnerAdapterOptions } from "./windows-execution-adapter-runner-fixtures.js";
import {
  carrier,
  claimedAttempt,
  independentSpec,
  typedProjection,
  type RequestCarrier,
} from "./windows-prepare-payload-fixtures.js";

// F1 only. Existing imports must load before the optional arguments exist.
// Reflect.apply supplies the proposed argument without a type/import failure
// becoming RED; assertions below inspect real returned bytes and native Parse.
type Selector = (attempt: ClaimedAttempt) => boolean;
const build = (attempt: ClaimedAttempt, marker?: unknown): RequestCarrier =>
  Reflect.apply(freezeWindowsPrepareRequest, undefined, [attempt, marker]);
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

describe.runIf(process.platform === "win32")("boot observation request marker", () => {
  it("preserves every original nine-key request byte when the marker is omitted", () => {
    const attempt = claimedAttempt();
    const raw = JSON.stringify(independentSpec(attempt));
    expect(Object.keys(JSON.parse(raw))).toHaveLength(9);
    expect(freezeWindowsPrepareRequest(attempt)).toEqual(carrier(raw));
    expect(build(attempt, undefined)).toEqual(carrier(raw));
    expect(Buffer.from(build(attempt).requestUtf8Base64, "base64")).toEqual(
      Buffer.from(raw, "utf8"),
    );
  });

  it("hashes boot-v1 inside the original request bytes", () => {
    const attempt = claimedAttempt();
    const original = carrier(JSON.stringify(independentSpec(attempt)));
    const expected = carrier(
      JSON.stringify({ ...independentSpec(attempt), runtimeObservation: "boot-v1" }),
    );
    const marked = build(attempt, "boot-v1");
    expect(marked).toEqual(expected);
    expect(marked.requestFingerprint).not.toBe(original.requestFingerprint);
    expect(Object.isFrozen(marked)).toBe(true);
  });

  it.each([null, false, "boot-v0", "BOOT-V1", { value: "boot-v1" }])(
    "rejects invalid internal marker %j instead of omitting it",
    (marker) => {
      expect(() => build(claimedAttempt(), marker)).toThrow();
    },
  );
});

function adapter(selector?: Selector) {
  const boundary = adapterBoundary();
  vi.spyOn(bridgeModule, "createWindowsControlBridgeHost").mockReturnValueOnce(
    boundary.host,
  );
  vi.spyOn(journalModule, "createWindowsJournalLauncher").mockReturnValueOnce(
    boundary.reader,
  );
  const actual = Reflect.apply(
    adapterModule.createWindowsExecutionAdapter,
    undefined,
    [boundary.options, selector],
  ) as adapterModule.WindowsExecutionAdapter;
  cleanups.push(async () => {
    boundary.release();
    await actual.close();
  });
  return { boundary, actual };
}

async function prepared(
  setup: ReturnType<typeof adapter>,
): Promise<RequestCarrier> {
  const { boundary: b, actual } = setup;
  const permission = sendPermission();
  const pending = actual.prepare(b.attempt, permission.guard);
  void pending.catch(() => {});
  await flushAdapter();
  const call = b.host.prepare.mock.calls[0];
  expect(call, "the original host receives the actual Adapter request").toBeDefined();
  assert.ok(call);
  expect(call[2]).toBe(permission.guard);
  expect(call[2].takeSendPermission()).toBe(true);
  const owner = freezeWindowsControlBridgeDescriptor({
    ...b.descriptor,
    details: { ...b.descriptor.details, requestFingerprint: call[0].requestFingerprint },
  });
  b.prepared.resolve({ kind: "prepared", descriptor: owner });
  await expect(pending).resolves.toEqual(owner);
  permission.seal();
  return call[0];
}

describe.runIf(process.platform === "win32")("Adapter selects one original Entry", () => {
  it("evaluates the predicate once and keeps the original marked request on a rejected replay", async () => {
    const choose = vi.fn<Selector>(() => true);
    const setup = adapter(choose);
    const sent = await prepared(setup);
    const expected = carrier(
      JSON.stringify({
        ...independentSpec(setup.boundary.attempt),
        runtimeObservation: "boot-v1",
      }),
    );
    expect(sent).toEqual(expected);
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith(setup.boundary.attempt);
    choose.mockReturnValue(false);
    const replayPermission = sendPermission();
    await expect(
      setup.actual.prepare(setup.boundary.attempt, replayPermission.guard),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(choose).toHaveBeenCalledTimes(1);
    expect(setup.boundary.host.prepare).toHaveBeenCalledTimes(1);
    expect(setup.boundary.host.prepare.mock.calls[0]?.[0]).toEqual(expected);
    expect(replayPermission.guard.takeSendPermission).not.toHaveBeenCalled();
  });

  it.each(["absent", "false"] as const)(
    "keeps the old request when the internal predicate is %s",
    async (kind) => {
      const choose = kind === "false" ? vi.fn<Selector>(() => false) : undefined;
      const setup = adapter(choose);
      expect(await prepared(setup)).toEqual(setup.boundary.request);
      if (choose) {
        expect(choose).toHaveBeenCalledTimes(1);
        expect(choose).toHaveBeenCalledWith(setup.boundary.attempt);
      }
    },
  );

  it("rejects a throwing selector before any host prepare or send permission", async () => {
    const choose = vi.fn<Selector>(() => {
      throw new Error("controlled selector failure");
    });
    const setup = adapter(choose);
    const permission = sendPermission();
    const pending = setup.actual.prepare(setup.boundary.attempt, permission.guard);
    void pending.catch(() => {});
    await flushAdapter();
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith(setup.boundary.attempt);
    expect(setup.boundary.host.prepare).not.toHaveBeenCalled();
    expect(setup.boundary.host.authorize).not.toHaveBeenCalled();
    expect(permission.guard.takeSendPermission).not.toHaveBeenCalled();
    await expect(pending).rejects.toMatchObject({ code: "not_ready" });
  });
});

async function boot() {
  const storage = await storageFixture();
  storage.setNow(Date.now());
  const workerConfig = configInput();
  workerConfig.budgets.delivery.maxPixels = 5016 * 5016;
  storage.setConfig(createWorkerConfig(workerConfig));
  const executor = recoveryExecutor();
  const entered = deferred<ClaimedAttempt>();
  const release = deferred<void>();
  executor.hooks.prepare = async (attempt, owner) => {
    entered.resolve(attempt);
    await release.promise;
    return owner;
  };
  let selector: Selector | undefined;
  let sealed = false;
  vi.spyOn(adapterModule, "createWindowsExecutionAdapter").mockImplementation(
    (...args: unknown[]) => {
      selector = typeof args[1] === "function" ? (args[1] as Selector) : undefined;
      const controlled: adapterModule.WindowsExecutionAdapter = {
        ...executor.adapter,
        kind: "windows",
        pendingWork: () => 0,
        status: () => ({
          sealed,
          activity: executor.activeCount() === 0 ? "idle" : "busy",
          close: sealed ? "closed" : "not_requested",
        }),
        close: async () => {
          sealed = true;
          return "closed";
        },
        interrupt: () => controlled.close(),
      };
      return controlled;
    },
  );
  const originalOpen = storeModule.openStore;
  vi.spyOn(storeModule, "openStore").mockImplementation((options) => {
    const opened = originalOpen(options);
    storage.setStore(opened);
    return opened;
  });
  const originalRunner = runnerModule.createRunner;
  let runner: ReturnType<typeof originalRunner> | undefined;
  let recovery: Promise<void> | undefined;
  const wakePromises: Promise<void>[] = [];
  vi.spyOn(runnerModule, "createRunner").mockImplementation((options) => {
    runner = originalRunner(options);
    const owned = runner;
    return {
      ...owned,
      recover() {
        recovery = owned.recover();
        return recovery;
      },
      wake() {
        const pending = owned.wake();
        wakePromises.push(pending);
        return pending;
      },
    };
  });
  let runtime: Awaited<ReturnType<typeof startWindowsWorker>> | undefined;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    release.resolve(undefined);
    const ended = runtime?.server.listening ? once(runtime.server, "close") : undefined;
    runtime?.close();
    await Promise.allSettled(wakePromises);
    await ended;
    storage.store.close();
  }
  cleanups.push(close);
  storage.store.close();
  runtime = await startWindowsWorker(
    {
      storeDirectory: storage.directory,
      port: 0,
      operatorClientId: storage.initialized.credential.clientId,
      selfTestModelId: workerConfig.models[0]!.id,
      workerConfig,
      submissionLimits: { ...submissionLimits },
      runnerLimits: { ...runnerLimits },
      transportLimits: { ...transportLimits },
      execution: {
        installationRoot: runnerAdapterOptions.bridge.installationRoot,
        recordsRoot: runnerAdapterOptions.bridge.recordsRoot,
        expectedManifestSha256: runnerAdapterOptions.bridge.expectedManifestSha256,
        bridgeLimits: { ...runnerAdapterOptions.bridge.limits },
        journalLimits: { ...runnerAdapterOptions.journalLimits },
      },
    },
    {
      appDirectory: fileURLToPath(new URL("..", import.meta.url)),
      signal: new AbortController().signal,
    },
  );
  await recovery;
  await flushAdapter();
  return {
    storage,
    runtime,
    executor,
    entered: entered.promise,
    runner: () => runner!,
    select: (attempt: ClaimedAttempt) => selector?.(attempt) === true,
    close,
  };
}

async function claimedSelfTest(h: Awaited<ReturnType<typeof boot>>) {
  const operation = await h.runtime.selfTest.start(h.storage.principal());
  const attempt = await h.entered;
  await flushAdapter(); // wakeBound/rememberClaim have returned while prepare is held.
  expect(operation.phase).toBe("bound");
  expect(operation.assetId).toBe("zeb-enhancement-calibration-v1");
  expect(attempt.identity.jobId).toBe(operation.jobId);
  expect(attempt.job.jobId).toBe(operation.jobId);
  expect(attempt.job.status).toBe("running");
  expect(h.runner().status().ownedState).not.toBe("none");
  return attempt;
}

describe.runIf(process.platform === "win32")("bootstrap selects its already claimed F01", () => {
  it("marks the actual claimed F01 while rejecting an ordinary job using the same image", async () => {
    const h = await boot();
    const attempt = await claimedSelfTest(h);
    expect(h.select(attempt), "already claimed F01 must survive claimObserved/owned-state changes").toBe(true);
    const ordinary: ClaimedAttempt = {
      ...attempt,
      identity: { ...attempt.identity, jobId: "ordinary-same-calibration" },
      launchTicket: "ordinary-same-image-ticket",
      job: { ...attempt.job, jobId: "ordinary-same-calibration" },
    };
    expect(h.select(ordinary)).toBe(false);
    expect(
      h.select({
        ...attempt,
        identity: { ...attempt.identity, jobId: "different-identity-job" },
      }),
    ).toBe(false);
    expect(
      h.select({
        ...attempt,
        job: {
          ...attempt.job,
          source: { ...attempt.job.source, sha256: "0".repeat(64) },
        },
      }),
    ).toBe(false);
    expect(h.executor.prepareCalls).toHaveLength(1);
    expect(h.executor.authorizeCalls).toHaveLength(0);
  });

  it.each(["maintenance", "closed-operation"] as const)(
    "rejects the previously selected attempt after %s",
    async (mode) => {
      const h = await boot();
      const attempt = await claimedSelfTest(h);
      expect(h.select(attempt)).toBe(true);
      if (mode === "maintenance") {
        expect(h.runtime.maintenance.enter(h.storage.principal()).sealed).toBe(true);
      } else {
        await h.close();
      }
      expect(h.select(attempt), "retained selector cannot mark the old operation").toBe(false);
    },
  );
});

type NativeReply = {
  accepted: boolean;
  mode: "control" | "parse";
  loadedCore: { name: string; hasPrepareForTest: boolean; hasFailureEnum: boolean };
  value?: ReturnType<typeof typedProjection>;
  fingerprintMatches?: boolean;
  errorType?: string;
};
const nativeExe = process.env.ZEB_WINDOWS_CONTRACT_FIXTURE_EXE;
const nativeRequested = process.env.ZEB_RUN_WINDOWS_CONTRACT_OS === "1" || nativeExe !== undefined;
const nativeSuite = nativeRequested ? describe : describe.skip;
const runFile = promisify(execFile);

async function native(mode: "control" | "parse", request: RequestCarrier) {
  assert.ok(nativeExe, "fixture prerequisite: explicit native executable; absence is not F1 RED");
  const pending = runFile(nativeExe, [mode], {
    windowsHide: true,
    encoding: "utf8",
    timeout: runnerLimits.executionTimeoutMs,
    maxBuffer: runnerAdapterOptions.journalLimits.maxStdoutBytes,
  });
  assert.ok(pending.child.stdin, "fixture prerequisite: original child stdin");
  pending.child.stdin.end(JSON.stringify(request));
  const { stdout, stderr } = await pending;
  expect(stderr, "fixture prerequisite: ordinary native child exits cleanly").toBe("");
  const reply = JSON.parse(stdout) as NativeReply;
  expect(reply.mode).toBe(mode);
  expect(reply.loadedCore).toEqual({ name: "WindowsSupervisor", hasPrepareForTest: false, hasFailureEnum: false });
  return reply;
}

nativeSuite("actual ordinary native parser accepts only the optional boot-v1 marker", () => {
  beforeAll(async () => {
    expect(process.platform, "fixture prerequisite, not feature RED").toBe("win32");
    expect(process.env.ZEB_RUN_WINDOWS_CONTRACT_OS).toBe("1");
    expect(typeof nativeExe).toBe("string");
    expect(isAbsolute(nativeExe!)).toBe(true);
    // This control bypasses production Parse and catches setup/SDK/import failures.
    expect(await native("control", carrier(JSON.stringify(independentSpec())))).toMatchObject({
      accepted: true,
      fingerprintMatches: true,
    });
  }, runnerLimits.executionTimeoutMs + runnerLimits.cancelGraceMs);

  it("accepts the unchanged nine-key payload through real PreparePayload.Parse", async () => {
    const spec = independentSpec();
    const request = carrier(JSON.stringify(spec));
    const reply = await native("parse", request);
    expect(reply.accepted).toBe(true);
    expect(reply.value).toEqual(typedProjection(spec, request));
  }, runnerLimits.executionTimeoutMs + runnerLimits.cancelGraceMs);

  it("accepts independently authored boot-v1 bytes through real PreparePayload.Parse", async () => {
    const spec = independentSpec();
    const request = carrier(JSON.stringify({ ...spec, runtimeObservation: "boot-v1" }));
    const reply = await native("parse", request);
    expect(reply.accepted, "native rejects the new valid tenth key on the unchanged baseline").toBe(true);
    expect(reply.value).toEqual(typedProjection(spec, request));
  }, runnerLimits.executionTimeoutMs + runnerLimits.cancelGraceMs);

  it.each([null, true, "boot-v0", "BOOT-V1", { value: "boot-v1" }])(
    "rejects a correctly hashed but invalid native marker %j",
    async (runtimeObservation) => {
      const request = carrier(JSON.stringify({ ...independentSpec(), runtimeObservation }));
      expect(await native("parse", request)).toMatchObject({ accepted: false, errorType: "ArgumentException" });
    },
    runnerLimits.executionTimeoutMs + runnerLimits.cancelGraceMs,
  );

  it("rejects a marked payload carrying the original nine-key fingerprint", async () => {
    const spec = independentSpec();
    const old = carrier(JSON.stringify(spec));
    const marked = carrier(JSON.stringify({ ...spec, runtimeObservation: "boot-v1" }));
    expect(await native("parse", { ...marked, requestFingerprint: old.requestFingerprint })).toMatchObject({
      accepted: false,
      errorType: "ArgumentException",
    });
  }, runnerLimits.executionTimeoutMs + runnerLimits.cancelGraceMs);
});
