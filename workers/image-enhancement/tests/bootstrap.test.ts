import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { join, win32 } from "node:path";

import Database from "better-sqlite3";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { startWindowsWorker } from "../src/bootstrap.js";
import * as clockModule from "../src/clock.js";
import { authenticate } from "../src/credentials.js";
import * as httpModule from "../src/http.js";
import { localInputFiles } from "../src/jobs.js";
import * as runnerModule from "../src/runner.js";
import * as storeModule from "../src/store.js";
import type { createWindowsControlBridgeHost } from "../src/windows-control-bridge-host.js";
import * as adapterModule from "../src/windows-execution-adapter.js";
import {
  freezeWindowsJournalReadLimits,
  type createWindowsJournalLauncher,
  type WindowsJournalLauncher,
  type WindowsJournalReadResult,
} from "../src/windows-journal-launcher.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import { freezeWindowsJournalReadContext } from "../src/windows-journal-reader.js";
import { configInput } from "./fixtures.js";
import {
  boundary,
  deferred,
  multipart,
  transportLimits,
  uploadParts,
} from "./http-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import {
  runnerLimits,
  sourceImage,
  storageFixture,
  submission,
  submissionLimits,
} from "./storage-fixtures.js";
import { controlBridgeExecutionDescriptor } from "./windows-control-bridge-host-fixtures.js";
import {
  runnerAdapterOptions,
  runnerNativePorts,
} from "./windows-execution-adapter-runner-fixtures.js";

const createOriginalRunner = runnerModule.createRunner;

const factories = vi.hoisted(() => ({
  host: vi.fn<typeof createWindowsControlBridgeHost>(),
  journal: vi.fn<typeof createWindowsJournalLauncher>(),
}));
vi.mock("../src/windows-control-bridge-host.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/windows-control-bridge-host.js")
  >()),
  createWindowsControlBridgeHost: factories.host,
}));
vi.mock("../src/windows-journal-launcher.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/windows-journal-launcher.js")
  >()),
  createWindowsJournalLauncher: factories.journal,
}));

type Storage = Awaited<ReturnType<typeof storageFixture>>;

const appDirectory = "Z:\\contract-only\\payload\\app";
const cleanup: (() => void | Promise<void>)[] = [];

function configuration(
  storeDirectory = "Z:\\contract-only\\store",
  operatorClientId = "11111111-1111-4111-8111-111111111111",
) {
  return {
    storeDirectory,
    operatorClientId,
    selfTestModelId: "standard-4x",
    port: 0,
    workerConfig: configInput(),
    submissionLimits: { ...submissionLimits },
    runnerLimits: { ...runnerLimits },
    transportLimits: { ...transportLimits },
    execution: {
      installationRoot: runnerAdapterOptions.bridge.installationRoot,
      recordsRoot: runnerAdapterOptions.bridge.recordsRoot,
      expectedManifestSha256:
        runnerAdapterOptions.bridge.expectedManifestSha256,
      bridgeLimits: { ...runnerAdapterOptions.bridge.limits },
      journalLimits: { ...runnerAdapterOptions.journalLimits },
    },
  };
}

function facts(storage: Storage) {
  return snapshot(storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
    attempts: db.prepare("SELECT * FROM attempts ORDER BY rowid").all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
    controls: db
      .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
      .all(),
    events: db.prepare("SELECT * FROM recovery_events ORDER BY rowid").all(),
    candidates: db
      .prepare("SELECT * FROM artifact_candidates ORDER BY rowid")
      .all(),
    references: db
      .prepare("SELECT * FROM artifact_references ORDER BY rowid")
      .all(),
  }));
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function call(
  server: Server,
  authorization: string,
  method: string,
  path: string,
  body?: Buffer,
  headers: Readonly<Record<string, string>> = {},
) {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return new Promise<{ status: number; body: { code: string; data: any } }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          method,
          path,
          agent: false,
          headers: {
            authorization,
            ...(body ? { "content-length": body.length } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.once("error", reject);
          res.once("end", () => {
            try {
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.once("error", reject);
      req.end(body);
    },
  );
}

beforeEach(() => {
  factories.host.mockReset().mockImplementation(() => {
    throw new Error("unexpected test Host allocation");
  });
  factories.journal.mockReset().mockImplementation(() => {
    throw new Error("unexpected test journal allocation");
  });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Windows journal read limits pure boundary", () => {
  it("copies and freezes valid limits without allocating a reader or requiring Windows", () => {
    const input = { ...runnerAdapterOptions.journalLimits };
    const result = freezeWindowsJournalReadLimits(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    input.readTimeoutMs++;
    expect(result.readTimeoutMs).toBe(
      runnerAdapterOptions.journalLimits.readTimeoutMs,
    );
    expect(factories.journal).not.toHaveBeenCalled();
    expect(
      freezeWindowsJournalReadLimits({
        maxRequestBytes: bufferConstants.MAX_LENGTH,
        maxStdoutBytes: bufferConstants.MAX_LENGTH,
        maxStderrBytes: bufferConstants.MAX_LENGTH,
        readTimeoutMs: 2_147_483_647,
        cleanupTimeoutMs: 2_147_483_647,
      }).cleanupTimeoutMs,
    ).toBe(2_147_483_647);
  });

  it.each(Object.keys(runnerAdapterOptions.journalLimits))(
    "rejects missing, nonpositive, fractional and overflowing %s",
    (key) => {
      const valid = { ...runnerAdapterOptions.journalLimits } as Record<
        string,
        unknown
      >;
      const absent = { ...valid };
      delete absent[key];
      expect(() => freezeWindowsJournalReadLimits(absent)).toThrow();
      const maximum = key.endsWith("Bytes")
        ? bufferConstants.MAX_LENGTH
        : 2_147_483_647;
      for (const value of [0, -1, 0.5, NaN, Infinity, "1", maximum + 1])
        expect(() =>
          freezeWindowsJournalReadLimits({ ...valid, [key]: value }),
        ).toThrow();
    },
  );

  it("rejects additional fields and accessors without invoking the getter", () => {
    const getter = vi.fn(() => 1);
    const input = { ...runnerAdapterOptions.journalLimits };
    Object.defineProperty(input, "readTimeoutMs", {
      enumerable: true,
      get: getter,
    });
    expect(() => freezeWindowsJournalReadLimits(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      freezeWindowsJournalReadLimits({
        ...runnerAdapterOptions.journalLimits,
        extra: 1,
      }),
    ).toThrow();
  });
});

// This suite does not spoof Windows: Store flushes and loopback traffic use the
// actual test account. Only the native Host/Journal module ports are doubles.
describe.skipIf(process.platform !== "win32")(
  "Windows worker bootstrap",
  () => {
    function observeFactories() {
      const originalOpen = storeModule.openStore;
      const recoveries: MockInstance<
        storeModule.EnhancementStore["beginRecovery"]
      >[] = [];
      const claims: MockInstance<storeModule.EnhancementStore["claimNext"]>[] = [];
      const open = vi
        .spyOn(storeModule, "openStore")
        .mockImplementation((options) => {
          const store = originalOpen(options);
          cleanup.push(() => store.close());
          recoveries.push(vi.spyOn(store, "beginRecovery"));
          claims.push(vi.spyOn(store, "claimNext"));
          return store;
        });
      return {
        open,
        recoveries,
        claims,
        clock: vi.spyOn(clockModule, "createSystemClock"),
        adapter: vi.spyOn(adapterModule, "createWindowsExecutionAdapter"),
        runner: vi.spyOn(runnerModule, "createRunner"),
        listen: vi.spyOn(httpModule, "listenEnhancementServer"),
      };
    }

    function selectAcceptedJob(
      runner: MockInstance<typeof runnerModule.createRunner>,
      onlyJobId: string,
    ) {
      runner.mockImplementation((options) => {
        expect(
          options.claimSelection?.() === "none",
          "production bootstrap selects none",
        ).toBe(true);
        return createOriginalRunner({
          ...options,
          claimSelection: () => ({ onlyJobId }),
        });
      });
    }

    async function storage() {
      const result = await storageFixture();
      result.setNow(Date.now());
      // Keep the owned directory as evidence; close handles even after a failure.
      cleanup.push(() => result.store.close());
      return result;
    }

    function nativePorts() {
      const native = runnerNativePorts();
      factories.host.mockReturnValue(native.host);
      factories.journal.mockImplementation(() => native.journal().reader);
      cleanup.push(() => native.release());
      return native;
    }

    async function start(
      storage: Storage,
      signal = new AbortController().signal,
    ) {
      storage.store.close();
      const runtime = await startWindowsWorker(
        configuration(
          storage.directory,
          storage.initialized.credential.clientId,
        ),
        {
          appDirectory,
          signal,
        },
      );
      cleanup.push(() => runtime.close());
      return runtime;
    }

    it("rejects strict configuration before opening a Store or starting a listener", async () => {
      const observed = observeFactories();
      const bad: unknown[] = [
        null,
        [],
        { ...configuration(), key: "forbidden" },
        { ...configuration(), ready: true },
        { ...configuration(), storeDirectory: "relative" },
        { ...configuration(), storeDirectory: "\\\\server\\store" },
        { ...configuration(), storeDirectory: "Z:\\bad\u0000path" },
        { ...configuration(), port: -1 },
        { ...configuration(), port: 65_536 },
        { ...configuration(), port: 1.5 },
        { ...configuration(), workerConfig: { ...configInput(), ready: true } },
        {
          ...configuration(),
          submissionLimits: { ...submissionLimits, maxWaitingJobs: 0 },
        },
        {
          ...configuration(),
          runnerLimits: {
            ...runnerLimits,
            heartbeatIntervalMs: runnerLimits.leaseDurationMs + 1,
          },
        },
        {
          ...configuration(),
          transportLimits: {
            ...transportLimits,
            requestTimeoutMs: 2_147_483_648,
          },
        },
        {
          ...configuration(),
          workerConfig: {
            ...configInput(),
            budgets: {
              ...configInput().budgets,
              input: { maxBytes: Number.MAX_SAFE_INTEGER, maxPixels: 1 },
            },
          },
        },
        {
          ...configuration(),
          execution: {
            ...configuration().execution,
            executablePath: "Z:\\bad.exe",
          },
        },
        {
          ...configuration(),
          execution: {
            ...configuration().execution,
            expectedManifestSha256: "not-a-manifest",
          },
        },
        {
          ...configuration(),
          execution: {
            ...configuration().execution,
            bridgeLimits: {
              ...runnerAdapterOptions.bridge.limits,
              startupTimeoutMs: 0,
            },
          },
        },
        ...Object.keys(runnerAdapterOptions.journalLimits).map((key) => ({
          ...configuration(),
          execution: {
            ...configuration().execution,
            journalLimits: { ...runnerAdapterOptions.journalLimits, [key]: 0 },
          },
        })),
      ];
      const getter = vi.fn(() => "Z:\\should-not-be-read");
      const accessor = configuration();
      Object.defineProperty(accessor, "storeDirectory", {
        enumerable: true,
        get: getter,
      });
      const executionAccessor = configuration();
      Object.defineProperty(executionAccessor.execution, "journalLimits", {
        enumerable: true,
        get: getter,
      });
      bad.push(
        accessor,
        executionAccessor,
        Object.assign(Object.create({ inherited: true }), configuration()),
      );
      for (const input of bad)
        await expect(
          startWindowsWorker(input, {
            appDirectory,
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: "configuration_invalid" });
      expect(getter).not.toHaveBeenCalled();
      expect(observed.open).not.toHaveBeenCalled();
      expect(observed.listen).not.toHaveBeenCalled();
      expect(factories.host).not.toHaveBeenCalled();
      expect(factories.journal).not.toHaveBeenCalled();
    });

    it("rejects an invalid app directory and an already-aborted start without Store/listen side effects", async () => {
      const observed = observeFactories();
      await expect(
        startWindowsWorker(configuration(), {
          appDirectory: "relative/app",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "configuration_invalid" });
      const abort = new AbortController();
      abort.abort();
      await expect(
        startWindowsWorker(configuration(), {
          appDirectory,
          signal: abort.signal,
        }),
      ).rejects.toThrow();
      expect(observed.open).not.toHaveBeenCalled();
      expect(observed.listen).not.toHaveBeenCalled();
    });

    it("rejects an invalid required system runtime path before opening Store or listening", async () => {
      const observed = observeFactories();
      vi.stubEnv("SystemRoot", "relative-runtime");
      await expect(
        startWindowsWorker(configuration(), {
          appDirectory,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "configuration_invalid" });
      expect(observed.open).not.toHaveBeenCalled();
      expect(observed.listen).not.toHaveBeenCalled();
    });

    it("never initializes or rekeys an absent or exclusively owned Store after open failure", async () => {
      const f = await storage();
      const before = facts(f);
      const principal = f.principal();
      const initialized = vi.spyOn(storeModule, "initializeStore");
      const observed = observeFactories();
      for (const directory of [
        f.directory,
        join(f.directory, "not-initialized"),
      ])
        await expect(
          startWindowsWorker(
            configuration(directory, f.initialized.credential.clientId),
            {
              appDirectory,
              signal: new AbortController().signal,
            },
          ),
        ).rejects.toThrow();
      expect(observed.open).toHaveBeenCalledTimes(2);
      expect(initialized).not.toHaveBeenCalled();
      expect(observed.listen).not.toHaveBeenCalled();
      expect(
        authenticate(f.store, `Bearer ${f.initialized.credential.key}`),
      ).toEqual(principal);
      expect(facts(f)).toEqual(before);
    }, 15_000);

    it("opens the existing identity and credentials with one epoch Clock, Adapter and Runner, and a fresh owner per start", async () => {
      const f = await storage();
      const identity = f.store.identity.serviceId;
      const principal = f.principal();
      const observed = observeFactories();
      vi.stubEnv(
        "ZEB_BOOTSTRAP_PRIVATE_TEST",
        "never-forward-this-fixture-value",
      );
      const first = await start(f);
      const originalStore = observed.open.mock.results[0]!
        .value as storeModule.EnhancementStore;
      const clock = observed.clock.mock.results[0]!.value as ReturnType<
        typeof clockModule.createSystemClock
      >;
      const adapter = observed.adapter.mock.results[0]!
        .value as adapterModule.WindowsExecutionAdapter;
      f.setStore(originalStore);
      expect(observed.open.mock.calls[0]![0].clock).toBe(clock.now);
      expect(observed.open.mock.calls[0]![0].interruptionEvidenceReader).toBe(
        adapter.readInterruptionEvidence,
      );
      expect(observed.runner.mock.calls[0]![0]).toMatchObject({
        store: originalStore,
        clock,
        executor: adapter,
      });
      expect(originalStore.identity.serviceId).toBe(identity);
      expect(originalStore.now()).toBeGreaterThan(1_000_000_000_000);
      expect(
        authenticate(originalStore, `Bearer ${f.initialized.credential.key}`),
      ).toEqual(principal);
      const bridge = observed.adapter.mock.calls[0]![0].bridge;
      expect(bridge.executablePath).toBe(
        win32.join(
          win32.dirname(appDirectory),
          "native",
          "bridge",
          "WindowsControlBridge.exe",
        ),
      );
      expect(bridge.helperPath).toBe(
        win32.join(
          win32.dirname(appDirectory),
          "native",
          "supervisor",
          "WindowsSupervisor.exe",
        ),
      );
      expect(
        Object.keys(bridge.environment).every((key) =>
          ["SystemRoot", "WINDIR", "TEMP", "TMP"].includes(key),
        ),
      ).toBe(true);
      expect(bridge.environment.SystemRoot).toMatch(/^[A-Za-z]:[\\/]/);
      expect(Object.values(bridge.environment)).not.toContain(
        "never-forward-this-fixture-value",
      );
      expect(
        (
          await call(
            first.server,
            `Bearer ${f.initialized.credential.key}`,
            "GET",
            "/v1/capabilities",
          )
        ).body.data,
      ).toMatchObject({
        serviceId: identity,
        ready: false,
        reason: "runner_unavailable",
      });
      await flush();
      expect(observed.recoveries[0]).toHaveBeenCalledTimes(1);
      expect(facts(f).jobs).toEqual([]);
      const owner1 = observed.runner.mock.calls[0]![0].ownerInstanceId;
      expect(owner1).not.toBe(identity);
      first.close();
      expect(originalStore.closed).toBe(true);
      const second = await start(f);
      const nextStore = observed.open.mock.results[1]!
        .value as storeModule.EnhancementStore;
      f.setStore(nextStore);
      expect(
        authenticate(nextStore, `Bearer ${f.initialized.credential.key}`),
      ).toEqual(principal);
      expect(observed.runner.mock.calls[1]![0].ownerInstanceId).not.toBe(
        owner1,
      );
      expect(observed.clock).toHaveBeenCalledTimes(2);
      expect(observed.adapter).toHaveBeenCalledTimes(2);
      expect(observed.runner).toHaveBeenCalledTimes(2);
      expect(
        (
          await call(
            second.server,
            `Bearer ${f.initialized.credential.key}`,
            "GET",
            "/healthz",
          )
        ).status,
      ).toBe(200);
    }, 15_000);

    it("listens before one recover; pending AUTH does not block health, replay or later DELETE wake", async () => {
      const f = await storage();
      const bytes = await sourceImage();
      const accepted = await f
        .service()
        .submit(f.principal(), submission(bytes, "bootstrap-replay"));
      const native = nativePorts();
      native.holdAuthorization();
      const observed = observeFactories();
      selectAcceptedJob(observed.runner, accepted.job.jobId);
      let listening: Server | undefined;
      // Keep the real listener; delay only its ownership handoff when requested.
      observed.listen.mockRestore();
      const listen = httpModule.listenEnhancementServer;
      vi.spyOn(httpModule, "listenEnhancementServer").mockImplementation(
        async (...args) => {
          const actual = await listen(...args);
          listening = actual;
          return actual;
        },
      );
      native.hooks.prepare = () => expect(listening?.listening).toBe(true);
      const runtime = await start(f);
      f.setStore(observed.open.mock.results[0]!.value);
      await native.authorized;
      const auth = `Bearer ${f.initialized.credential.key}`;
      expect((await call(runtime.server, auth, "GET", "/healthz")).status).toBe(
        200,
      );
      expect(observed.recoveries[0]).toHaveBeenCalledTimes(1);
      const replay = await call(
        runtime.server,
        auth,
        "POST",
        "/v1/enhancement-jobs",
        multipart(uploadParts(bytes)),
        {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "idempotency-key": "bootstrap-replay",
        },
      );
      expect(replay).toMatchObject({
        status: 202,
        body: { data: { replayed: true, job: { jobId: accepted.job.jobId } } },
      });
      const first = await call(
        runtime.server,
        auth,
        "DELETE",
        `/v1/enhancement-jobs/${accepted.job.jobId}`,
      );
      expect(first).toMatchObject({
        status: 202,
        body: { data: { applied: true, job: { cancelRequested: true } } },
      });
      await vi.waitFor(() =>
        expect(native.host.requestStop).toHaveBeenCalledTimes(1),
      );
      const before = facts(f);
      const again = await call(
        runtime.server,
        auth,
        "DELETE",
        `/v1/enhancement-jobs/${accepted.job.jobId}`,
      );
      expect(again).toMatchObject({
        status: 202,
        body: { data: { applied: false } },
      });
      expect(facts(f)).toEqual(before);
      expect(native.host.authorize).toHaveBeenCalledTimes(1);
      expect(native.host.requestStop).toHaveBeenCalledTimes(1);
      const fresh = await call(
        runtime.server,
        auth,
        "POST",
        "/v1/enhancement-jobs",
        multipart(uploadParts(bytes)),
        {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "idempotency-key": "new-not-ready",
        },
      );
      expect(fresh.body.code).toBe("not_ready");
      expect(facts(f).attempts).toHaveLength(1);
      expect(facts(f).slot).toHaveLength(1);
    }, 15_000);

    it("seals synchronously while prepare is pending; late prepare, exit and notifications cannot change durable facts", async () => {
      const f = await storage();
      const accepted = await f
        .service()
        .submit(f.principal(), submission(await sourceImage()));
      const native = nativePorts();
      const prepared = deferred();
      const release = deferred();
      const originalPrepare = native.host.prepare.getMockImplementation()!;
      native.host.prepare.mockImplementation(async (...args) => {
        const value = await originalPrepare(...args);
        prepared.resolve();
        await release.promise;
        return value;
      });
      cleanup.push(() => release.resolve());
      const observed = observeFactories();
      selectAcceptedJob(observed.runner, accepted.job.jobId);
      const runtime = await start(f);
      const store = observed.open.mock.results[0]!
        .value as storeModule.EnhancementStore;
      f.setStore(store);
      await prepared.promise;
      const before = facts(f);
      const notification = observed.listen.mock.calls[0]![0].onJobCommitted;
      expect(runtime.close()).toBeUndefined();
      expect(store.closed).toBe(true);
      expect(runtime.server.listening).toBe(false);
      expect(runtime.close()).toBeUndefined();
      expect(notification?.()).toBeUndefined();
      release.resolve();
      native.finish("stop");
      await flush();
      expect(facts(f)).toEqual(before);
      expect(native.host.prepare).toHaveBeenCalledTimes(1);
      expect(native.host.authorize).not.toHaveBeenCalled();
      expect(native.host.requestStop).not.toHaveBeenCalled();
    }, 15_000);

    it("shutdown shares one promise, interrupts before Runner.close and retains Store until every drain gate closes", async () => {
      const f = await storage();
      const realAdapter = adapterModule.createWindowsExecutionAdapter;
      const realListen = httpModule.listenEnhancementServer;
      const observed = observeFactories();
      const order: string[] = [];
      const released = deferred<"closed">();
      const writing = deferred();
      const releaseWrite = deferred();
      cleanup.push(() => released.resolve("closed"));
      cleanup.push(() => releaseWrite.resolve());
      const interrupt = vi.fn(async (actual: adapterModule.WindowsExecutionAdapter) => {
        order.push("interrupt");
        expect(await actual.interrupt()).toBe("closed");
        return released.promise;
      });
      let runnerPending = 1, adapterPending = 1, references = 1;
      observed.adapter.mockImplementation((options, observe) => {
        const actual = realAdapter(options, observe);
        return Object.freeze({ ...actual, interrupt: () => interrupt(actual),
          pendingWork: () => actual.pendingWork() + adapterPending });
      });
      observed.runner.mockImplementation((options) => {
        const actual = createOriginalRunner(options);
        return Object.freeze({ ...actual,
          pendingWork: () => actual.pendingWork() + runnerPending,
          close() { order.push("runner"); return actual.close(); } });
      });
      observed.listen.mockImplementation((options, ...address) => realListen({
        ...options, ready: () => true, // Fixture-only admission; no boot qualification claim.
        inputFiles: { ...localInputFiles, async write(...args) {
          writing.resolve();
          await releaseWrite.promise;
          return localInputFiles.write(...args);
        } },
      }, ...address));
      const runtime = await start(f);
      f.setStore(observed.open.mock.results[0]!.value);
      await flush();
      const originalCounts = f.store.inspectMaintenance.bind(f.store);
      vi.spyOn(f.store, "inspectMaintenance").mockImplementation(() => ({
        ...originalCounts(), unreleasedReferences: references,
      }));
      const owner = (runtime.server as httpModule.EnhancementServer).fileIo;
      const body = multipart(uploadParts(await sourceImage()));
      const upload = call(runtime.server, `Bearer ${f.initialized.credential.key}`, "POST", "/v1/enhancement-jobs", body, {
        "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": "shutdown-upload",
      }).catch(() => undefined);
      await writing.promise;
      expect(owner.activity().uploads).toBe(1);
      const pending = runtime.shutdown();
      expect(runtime.shutdown()).toBe(pending);
      expect(order).toEqual(["interrupt", "runner"]);
      expect(runtime.status().closing).toBe(true);
      expect(owner.activity().sealed).toBe(true);
      expect(f.store.closed).toBe(false);
      expect(observed.listen.mock.calls[0]![0].onJobCommitted?.()).toBeUndefined();
      released.resolve("closed");
      await flush();
      expect(f.store.closed).toBe(false);
      runnerPending = 0;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.store.closed).toBe(false);
      adapterPending = 0;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.store.closed).toBe(false);
      references = 0;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.store.closed).toBe(false);
      expect(owner.activity().uploads).toBe(1);
      releaseWrite.resolve();
      expect(await pending).toBe("closed");
      await upload;
      expect(runtime.server.listening).toBe(false);
      expect(f.store.closed).toBe(true);
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(factories.journal).not.toHaveBeenCalled();
      expect(runtime.close()).toBeUndefined();
      expect(owner.activity()).toMatchObject({ sealed: true, uploads: 0, downloads: 0, receipts: 0 });
    }, 15_000);

    it.each(["drain", "timeout"] as const)("shutdown waits for the complete HTTP handler after its socket has closed: %s", async (mode) => {
      const f = await storage();
      const realListen = httpModule.listenEnhancementServer;
      const observed = observeFactories();
      const entered = deferred(), release = deferred();
      cleanup.push(() => release.resolve());
      observed.listen.mockImplementation((options, ...address) => realListen({
        ...options,
        selfTest: { ...options.selfTest!, async start(principal) {
          entered.resolve();
          await release.promise;
          expect(f.store.closed).toBe(false);
          return options.selfTest!.query(principal);
        } },
      }, ...address));
      const runtime = await start(f);
      f.setStore(observed.open.mock.results[0]!.value);
      await flush();
      const request = call(runtime.server, `Bearer ${f.initialized.credential.key}`, "POST", "/v1/self-test")
        .catch(() => undefined);
      await entered.promise;
      const owner = (runtime.server as httpModule.EnhancementServer).fileIo;
      expect(owner.pendingRequests()).toBe(1);
      if (mode === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      try {
        const pending = runtime.shutdown();
        await request;
        if (mode === "timeout") await vi.advanceTimersByTimeAsync(25_001);
        else await new Promise((resolve) => setTimeout(resolve, 20));
        expect(runtime.server.listening).toBe(false);
        expect(owner.activity()).toMatchObject({ uploads: 0, downloads: 0, receipts: 0 });
        expect(owner.pendingRequests()).toBe(1);
        expect(f.store.closed).toBe(false);
        if (mode === "timeout") expect(await pending).toBe("unknown");
        release.resolve();
        await flush();
        expect(await pending).toBe(mode === "drain" ? "closed" : "unknown");
        expect(owner.pendingRequests()).toBe(0);
        expect(f.store.closed).toBe(mode === "drain");
      } finally { if (mode === "timeout") vi.useRealTimers(); }
    }, 15_000);

    it.each(["proved", "unknown", "reader_cleanup_unknown", "reader_timeout"] as const)(
      "shutdown uses a fresh scope-bound ordinary reader and preserves the original occupied slot: %s", async (proof) => {
        const f = await storage();
        const bytes = await sourceImage();
        const a = await f.service().submit(f.principal(), submission(bytes, "shutdown-a"));
        const b = await f.service().submit(f.principal(), submission(bytes, "shutdown-b"));
        const native = nativePorts();
        const observed = observeFactories();
        selectAcceptedJob(observed.runner, a.job.jobId);
        const runtime = await start(f);
        f.setStore(observed.open.mock.results[0]!.value);
        await native.authorized;
        await flush();
        const current = native.scope;
        const original = f.store.getActiveAttempt(current.target.identity)!;
        expect(original.authorizedAt).not.toBeNull();
        // A legal natural terminal races with the requested interrupt. This is a module-port test, not OS proof.
        const terminal = native.terminal("engine-exit", 0);
        const lateRead = deferred<WindowsJournalReadResult>();
        cleanup.push(() => lateRead.resolve({ kind: "unknown", cleanup: "closed" }));
        const strict = {
          read: vi.fn<WindowsJournalLauncher["read"]>(async (scope, descriptor, signal, stillCurrent) => {
            expect(scope).toEqual(current);
            expect(descriptor).toEqual(original.ownerDescriptor);
            expect(signal.aborted).toBe(false);
            expect(stillCurrent()).toBe(true);
            expect(f.store.closed).toBe(false);
            expect(observed.runner.mock.results[0]!.value.status().closed).toBe(true);
            expect(factories.host).toHaveBeenCalledTimes(1);
            if (proof === "reader_timeout") return lateRead.promise;
            return proof === "unknown" ? { kind: "unknown", cleanup: "closed" } :
              { kind: "read", interpretation: terminal, cleanup: "closed" };
          }),
          close: vi.fn<WindowsJournalLauncher["close"]>(async () =>
            proof === "reader_cleanup_unknown" ? "unknown" : "closed"),
        } satisfies WindowsJournalLauncher;
        factories.journal.mockReturnValue(strict);
        const before = facts(f);
        if (proof === "reader_timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        try {
        const pending = runtime.shutdown();
        expect(runtime.shutdown()).toBe(pending);
        if (proof === "reader_timeout") await vi.advanceTimersByTimeAsync(25_001);
        expect(await pending).toBe(proof === "proved" ? "closed" : "unknown");
        if (proof === "reader_timeout") {
          lateRead.resolve({ kind: "read", interpretation: terminal, cleanup: "closed" });
          await vi.advanceTimersByTimeAsync(1);
          expect(await pending).toBe("unknown");
        }
        expect(f.store.closed).toBe(proof === "proved");
        expect(facts(f)).toEqual(before);
        expect(facts(f).slot).toHaveLength(1);
        expect(facts(f).attempts).toHaveLength(1);
        const jobs = facts(f).jobs as { job_id: string; status: string }[];
        expect(jobs.find((job) => job.job_id === b.job.jobId)?.status).toBe("queued");
        expect(strict.read).toHaveBeenCalledTimes(1);
        expect(strict.close).toHaveBeenCalledTimes(1);
        expect(native.host.prepare).toHaveBeenCalledTimes(1);
        expect(native.host.authorize).toHaveBeenCalledTimes(1);
        expect(native.host.requestStop).not.toHaveBeenCalled();
        expect(factories.journal).toHaveBeenCalledTimes(2);
        } finally { if (proof === "reader_timeout") vi.useRealTimers(); }
      }, 15_000);

    it("shutdown never renews its single deadline and leaves Store open when interruption does not settle", async () => {
      const f = await storage();
      const realAdapter = adapterModule.createWindowsExecutionAdapter;
      const observed = observeFactories();
      const release = deferred<"closed">();
      cleanup.push(() => release.resolve("closed"));
      const interrupt = vi.fn(() => release.promise);
      observed.adapter.mockImplementation((options, observe) => {
        const actual = realAdapter(options, observe);
        return Object.freeze({ ...actual, interrupt() { void actual.interrupt(); return interrupt(); } });
      });
      const runtime = await start(f);
      f.setStore(observed.open.mock.results[0]!.value);
      await flush();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      try {
        const pending = runtime.shutdown();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(runtime.shutdown()).toBe(pending);
        await vi.advanceTimersByTimeAsync(10_001);
        expect(await pending).toBe("unknown");
        expect(runtime.shutdown()).toBe(pending);
        expect(f.store.closed).toBe(false);
        expect(interrupt).toHaveBeenCalledTimes(1);
        release.resolve("closed");
        await vi.advanceTimersByTimeAsync(1);
        expect(f.store.closed).toBe(false);
      } finally { vi.useRealTimers(); }
    }, 15_000);

    it("shutdown honors the first shorter absolute cutoff without renewal or a late Store close", async () => {
      const f = await storage();
      const realAdapter = adapterModule.createWindowsExecutionAdapter;
      const observed = observeFactories();
      const release = deferred<"closed">();
      cleanup.push(() => release.resolve("closed"));
      observed.adapter.mockImplementation((options, observe) => {
        const actual = realAdapter(options, observe);
        return Object.freeze({ ...actual, interrupt() { void actual.interrupt(); return release.promise; } });
      });
      const runtime = await start(f);
      f.setStore(observed.open.mock.results[0]!.value);
      await flush();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      try {
        let outcome: "closed" | "unknown" | undefined;
        const anchor = performance.now();
        const pending = runtime.shutdown(anchor + 75);
        void pending.then((value) => { outcome = value; });
        await vi.advanceTimersByTimeAsync(50);
        expect(runtime.shutdown(anchor + 25_000)).toBe(pending);
        await vi.advanceTimersByTimeAsync(26);
        expect(outcome).toBe("unknown");
        expect(f.store.closed).toBe(false);
        release.resolve("closed");
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toBe("unknown");
        expect(f.store.closed).toBe(false);
      } finally { vi.useRealTimers(); }
    }, 15_000);

    it.each(["expired", "invalid"] as const)("shutdown only seals on an %s absolute cutoff", async (mode) => {
      const f = await storage();
      const observed = observeFactories();
      const runtime = await start(f);
      f.setStore(observed.open.mock.results[0]!.value);
      await flush();
      const pending = runtime.shutdown(mode === "expired" ? performance.now() - 1 : NaN);
      expect(runtime.status()).toMatchObject({ closing: true, runner: { closed: true }, adapter: { sealed: true } });
      expect(await pending).toBe("unknown");
      expect(f.store.closed).toBe(false);
      expect(runtime.shutdown()).toBe(pending);
      expect(factories.host).not.toHaveBeenCalled();
      expect(factories.journal).not.toHaveBeenCalled();
    }, 15_000);

    it("shutdown refuses an active slot without an observed current prepare scope", async () => {
      const f = await storage();
      await f.service().submit(f.principal(), submission(await sourceImage()));
      f.store.claimNext("previous-shutdown-owner");
      const observed = observeFactories();
      observed.runner.mockImplementation((options) => {
        const actual = createOriginalRunner(options);
        return Object.freeze({ ...actual, recover: async () => {} });
      });
      const runtime = await start(f);
      f.setStore(observed.open.mock.results[0]!.value);
      await flush();
      const before = facts(f);
      expect(await runtime.shutdown()).toBe("unknown");
      expect(f.store.closed).toBe(false);
      expect(facts(f)).toEqual(before);
      expect(factories.host).not.toHaveBeenCalled();
      expect(factories.journal).not.toHaveBeenCalled();
    }, 15_000);

    it("does not await pending Adapter cleanup before closing Store and preserves an authorized unknown slot", async () => {
      const f = await storage();
      const accepted = await f
        .service()
        .submit(f.principal(), submission(await sourceImage()));
      const native = nativePorts();
      native.holdAuthorization();
      const closeResult =
        deferred<Awaited<ReturnType<typeof native.host.close>>>();
      native.host.close.mockImplementation(() => closeResult.promise);
      cleanup.push(() =>
        closeResult.resolve({ kind: "stopped", cleanup: "closed" }),
      );
      const observed = observeFactories();
      selectAcceptedJob(observed.runner, accepted.job.jobId);
      const runtime = await start(f);
      const store = observed.open.mock.results[0]!
        .value as storeModule.EnhancementStore;
      f.setStore(store);
      await native.authorized;
      const before = facts(f);
      runtime.close();
      expect(store.closed).toBe(true);
      expect(native.host.close).toHaveBeenCalledTimes(1);
      native.acknowledgeAuthorization();
      native.finish("engine-exit", 0);
      await flush();
      expect(facts(f)).toEqual(before);
      expect(facts(f).slot).toHaveLength(1);
      expect(native.host.requestStop).not.toHaveBeenCalled();
    }, 15_000);

    it("keeps a pending recovery reader reachable by HTTP and seals late inspection without changing its slot", async () => {
      const f = await storage();
      const accepted = await f
        .service()
        .submit(f.principal(), submission(await sourceImage()));
      const attempt = f.store.claimNext("bootstrap-previous-owner");
      assert.ok(attempt);
      const request = freezeWindowsPrepareRequest(attempt);
      const descriptor = controlBridgeExecutionDescriptor(
        { identity: attempt.identity, launchTicket: attempt.launchTicket },
        attempt.executionPolicy.fingerprint,
        request.requestFingerprint,
      );
      freezeWindowsJournalReadContext(
        {
          target: {
            identity: attempt.identity,
            launchTicket: attempt.launchTicket,
          },
          executionPolicyFingerprint: attempt.executionPolicy.fingerprint,
        },
        descriptor,
      );
      expect(f.store.registerPrepared(attempt.identity, descriptor)).toBe(true);
      expect(f.store.authorizeLaunch(attempt.identity, descriptor)).toBe(true);
      const reached = deferred();
      const read = deferred<WindowsJournalReadResult>();
      const reader = {
        read: vi.fn<WindowsJournalLauncher["read"]>((scope, owner) => {
          expect(scope.target).toEqual({
            identity: attempt.identity,
            launchTicket: attempt.launchTicket,
          });
          expect(owner).toEqual(descriptor);
          reached.resolve();
          return read.promise;
        }),
        close: vi.fn(async () => "closed" as const),
      };
      factories.journal.mockReturnValue(reader);
      cleanup.push(() => read.resolve({ kind: "unknown", cleanup: "closed" }));
      const observed = observeFactories();
      const runtime = await start(f);
      f.setStore(observed.open.mock.results[0]!.value);
      await reached.promise;
      const auth = `Bearer ${f.initialized.credential.key}`;
      expect((await call(runtime.server, auth, "GET", "/healthz")).status).toBe(
        200,
      );
      expect(
        (
          await call(
            runtime.server,
            auth,
            "DELETE",
            `/v1/enhancement-jobs/${accepted.job.jobId}`,
          )
        ).body.data.job.cancelRequested,
      ).toBe(true);
      const before = facts(f);
      runtime.close();
      expect(f.store.closed).toBe(true);
      expect(reader.close).toHaveBeenCalledTimes(1);
      read.resolve({ kind: "unknown", cleanup: "closed" });
      await flush();
      expect(facts(f)).toEqual(before);
      expect(facts(f).slot).toHaveLength(1);
      expect(factories.host).not.toHaveBeenCalled();
    }, 15_000);

    it("aborts pending listen immediately and closes the late Server without recover or usable runtime", async () => {
      const f = await storage();
      const observed = observeFactories();
      observed.listen.mockRestore();
      const listen = httpModule.listenEnhancementServer;
      const reached = deferred<Server>();
      const release = deferred();
      vi.spyOn(httpModule, "listenEnhancementServer").mockImplementation(
        async (...args) => {
          const server = await listen(...args);
          cleanup.push(() => {
            server.closeAllConnections();
            server.close();
          });
          reached.resolve(server);
          await release.promise;
          return server;
        },
      );
      cleanup.push(() => release.resolve());
      const abort = new AbortController();
      f.store.close();
      const pending = startWindowsWorker(
        configuration(f.directory, f.initialized.credential.clientId),
        {
          appDirectory,
          signal: abort.signal,
        },
      );
      void pending.catch(() => {});
      const late = await Promise.race([
        reached.promise,
        pending.then(() => {
          throw new Error(
            "listen fixture unexpectedly returned without its release",
          );
        }),
      ]);
      const opened = observed.open.mock.results[0]!
        .value as storeModule.EnhancementStore;
      f.setStore(opened);
      abort.abort();
      expect(opened.closed).toBe(true);
      release.resolve();
      await expect(pending).rejects.toThrow();
      expect(late.listening).toBe(false);
      expect(observed.recoveries[0]).not.toHaveBeenCalled();
      expect(facts(f).attempts).toEqual([]);
    }, 15_000);

    it("can close after recover is queued but before its microtask writes anything", async () => {
      const f = await storage();
      await f.service().submit(f.principal(), submission(await sourceImage()));
      const before = facts(f);
      const abort = new AbortController();
      const originalOpen = storeModule.openStore;
      vi.spyOn(storeModule, "openStore").mockImplementation((options) => {
        const store = originalOpen(options);
        cleanup.push(() => store.close());
        return store;
      });
      const create = runnerModule.createRunner;
      let recoverEntered = false;
      vi.spyOn(runnerModule, "createRunner").mockImplementation((options) => {
        const runner = create(options);
        return Object.freeze({
          ...runner,
          recover() {
            recoverEntered = true;
            const pending = runner.recover();
            abort.abort();
            return pending;
          },
        });
      });
      f.store.close();
      const runtime = await startWindowsWorker(
        configuration(f.directory, f.initialized.credential.clientId),
        {
          appDirectory,
          signal: abort.signal,
        },
      ).catch(() => undefined);
      runtime?.close();
      expect(recoverEntered).toBe(true);
      await flush();
      expect(facts(f)).toEqual(before);
      expect(factories.host).not.toHaveBeenCalled();
    }, 15_000);

    it("isolates synchronous cleanup faults so Runner and Adapter sealing cannot skip Store.close", async () => {
      const f = await storage();
      const createRunner = runnerModule.createRunner;
      const createAdapter = adapterModule.createWindowsExecutionAdapter;
      vi.spyOn(runnerModule, "createRunner").mockImplementation((options) => {
        const runner = createRunner(options);
        return Object.freeze({
          ...runner,
          close() {
            void runner.close();
            throw new Error("synthetic runner close fault");
          },
        });
      });
      vi.spyOn(
        adapterModule,
        "createWindowsExecutionAdapter",
      ).mockImplementation((options) => {
        const adapter = createAdapter(options);
        return Object.freeze({
          ...adapter,
          close() {
            void adapter.close();
            throw new Error("synthetic Adapter close fault");
          },
        });
      });
      const open = vi.spyOn(storeModule, "openStore");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const runtime = await start(f);
      const opened = open.mock.results[0]!
        .value as storeModule.EnhancementStore;
      f.setStore(opened);
      expect(() => runtime.close()).not.toThrow();
      expect(opened.closed).toBe(true);
      expect(runtime.server.listening).toBe(false);
      await flush();
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic");
    }, 15_000);

    it("closes an active upload connection before any acceptance while preserving durable facts", async () => {
      const f = await storage();
      const observed = observeFactories();
      const runtime = await start(f);
      f.setStore(observed.open.mock.results[0]!.value);
      const before = facts(f);
      const body = multipart(uploadParts(await sourceImage()));
      const address = runtime.server.address();
      assert.ok(address && typeof address !== "string");
      const requestArrived = once(runtime.server, "request");
      const req = request({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/v1/enhancement-jobs",
        agent: false,
        headers: {
          authorization: `Bearer ${f.initialized.credential.key}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": body.length,
          "idempotency-key": "closing-upload",
        },
      });
      const disconnected = new Promise<void>((resolve) =>
        req.once("error", () => resolve()),
      );
      cleanup.push(() => {
        req.destroy();
      });
      req.write(body.subarray(0, Math.floor(body.length / 2)));
      await requestArrived;
      runtime.close();
      expect(f.store.closed).toBe(true);
      await disconnected;
      await flush();
      expect(facts(f)).toEqual(before);
      expect(facts(f).jobs).toEqual([]);
    }, 15_000);

    it("observes a recovery rejection with only a fixed diagnostic while keeping the listener reachable", async () => {
      const f = await storage();
      const observed = observeFactories();
      const originalOpen = observed.open.getMockImplementation()!;
      observed.open.mockImplementation((options) => {
        const store = originalOpen(options);
        vi.mocked(store.beginRecovery).mockImplementationOnce(() => {
          throw new Error("synthetic-private-recovery-error");
        });
        return store;
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const runtime = await start(f);
      f.setStore(observed.open.mock.results[0]!.value);
      await flush();
      expect(log.mock.calls).toHaveLength(1);
      expect(log.mock.calls[0]).toHaveLength(1);
      expect(log.mock.calls[0]![0]).toMatch(/^enhancement_[a-z_]+$/);
      expect(observed.recoveries[0]).toHaveBeenCalledTimes(1);
      expect(
        (
          await call(
            runtime.server,
            `Bearer ${f.initialized.credential.key}`,
            "GET",
            "/healthz",
          )
        ).status,
      ).toBe(200);
      expect(facts(f).attempts).toEqual([]);
    }, 15_000);

    it.each(["bind", "schema"] as const)(
      "reports the real %s startup cut and actual untouched claim/prepare/authorize seams",
      async (mode) => {
        const f = await storage();
        await f.service().submit(f.principal(), submission(await sourceImage(), "startup-observation-queued"));
        f.store.close();
        if (mode === "schema") {
          const db = new Database(join(f.directory, "worker.sqlite"), { fileMustExist: true });
          try { db.pragma("user_version = 8"); } finally { db.close(); }
        }
        const before = facts(f);
        const originalAdapter = adapterModule.createWindowsExecutionAdapter;
        const observed = observeFactories();
        const recover = vi.fn<ReturnType<typeof runnerModule.createRunner>["recover"]>();
        const prepare = vi.fn<ReturnType<typeof adapterModule.createWindowsExecutionAdapter>["prepare"]>();
        const authorize = vi.fn<ReturnType<typeof adapterModule.createWindowsExecutionAdapter>["authorize"]>();
        observed.runner.mockImplementation((options) => {
          const actual = createOriginalRunner(options);
          recover.mockImplementation(actual.recover);
          return Object.freeze({ ...actual, recover });
        });
        observed.adapter.mockImplementation((...args) => {
          const actual = originalAdapter(...args);
          prepare.mockImplementation(actual.prepare);
          authorize.mockImplementation(actual.authorize);
          return Object.freeze({ ...actual, prepare, authorize });
        });
        const blocker = createServer();
        await new Promise<void>((resolve, reject) => {
          blocker.once("error", reject);
          blocker.listen(0, "127.0.0.1", resolve);
        });
        cleanup.push(() => new Promise<void>((resolve, reject) =>
          blocker.close((error) => error ? reject(error) : resolve())));
        const address = blocker.address();
        assert.ok(address && typeof address !== "string");
        const phases: unknown[] = [];
        const options = {
          appDirectory, signal: new AbortController().signal,
          onStartupObservation: (phase: unknown) => { phases.push(phase); },
        };
        await expect(startWindowsWorker({
          ...configuration(f.directory, f.initialized.credential.clientId),
          host: "127.0.0.1", port: address.port,
        }, options)).rejects.toMatchObject({
          code: mode === "schema" ? "configuration_invalid" : "internal_error",
        });
        expect(phases).toEqual([{
          phase: mode === "schema" ? "store_schema_incompatible" : "listener_bind_failed",
          runnerConstructed: mode === "bind", listenerSucceeded: false,
          recoveryCalled: false, claimEntered: false, prepareEntered: false, authorizeEntered: false,
        }]);
        expect(observed.runner).toHaveBeenCalledTimes(mode === "bind" ? 1 : 0);
        expect(observed.listen).toHaveBeenCalledTimes(mode === "bind" ? 1 : 0);
        if (mode === "bind") {
          await expect(observed.listen.mock.results[0]!.value).rejects.toMatchObject({ code: "EADDRINUSE" });
          expect(observed.claims).toHaveLength(1);
          expect(observed.recoveries).toHaveLength(1);
        }
        for (const claim of observed.claims) expect(claim).not.toHaveBeenCalled();
        for (const recovery of observed.recoveries) expect(recovery).not.toHaveBeenCalled();
        expect(recover).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(authorize).not.toHaveBeenCalled();
        expect(factories.host).not.toHaveBeenCalled();
        expect(factories.journal).not.toHaveBeenCalled();
        expect(facts(f)).toEqual(before);
      }, 15_000,
    );

    it.each(["observed", "ordinary"] as const)(
      "keeps actual maintenance GET/POST/file-I/O seals consistent through %s startup publication",
      async (mode) => {
        const f = await storage();
        f.store.close();
        const observed = observeFactories();
        const reached = deferred(), release = deferred();
        const observations: unknown[] = [];
        const options = {
          appDirectory, signal: new AbortController().signal,
          ...(mode === "observed" ? {
            onStartupObservation: (phase: unknown) => {
              observations.push(phase);
              reached.resolve();
              return release.promise;
            },
          } : {}),
        };
        const starting = startWindowsWorker(
          configuration(f.directory, f.initialized.credential.clientId), options,
        );
        let published = false;
        void starting.then(() => { published = true; }, () => { published = true; });
        cleanup.push(async () => {
          release.resolve();
          try { (await starting).close(); } catch {}
        });
        if (mode === "observed") await reached.promise;
        else {
          const runtime = await starting;
          await vi.waitFor(() => expect(runtime.status().startupRecovery).toBe("settled"));
        }
        const listening = await observed.listen.mock.results[0]!.value as httpModule.EnhancementServer;
        expect(listening.listening).toBe(true);
        const auth = "Bearer " + f.initialized.credential.key;
        const health = await call(listening, auth, "GET", "/healthz");
        const before = await call(listening, auth, "GET", "/v1/maintenance");
        const entered = await call(listening, auth, "POST", "/v1/maintenance");
        const during = await call(listening, auth, "GET", "/v1/maintenance");
        const heldHttp = listening.fileIo.activity();
        const heldPublication = published;
        // Observe the first post-release GET before any later POST can repair a
        // previously missed file-I/O seal.
        release.resolve();
        const runtime = await starting;
        await vi.waitFor(() => expect(runtime.status().startupRecovery).toBe("settled"));
        const resumed = await call(listening, auth, "GET", "/v1/maintenance");
        expect(health).toMatchObject({ status: 200, body: { code: "ok", data: { alive: true } } });
        expect(before).toMatchObject({
          status: 200, body: { code: "ok", data: {
            sealed: false, canStop: false, http: { sealed: false },
            state: mode === "observed" ? "unknown" : "open",
            runtime: { startupRecovery: mode === "observed" ? "pending" : "settled" },
          } },
        });
        for (const response of [entered, during]) {
          expect(response).toMatchObject({
            status: 200, body: { code: "ok", data: {
              sealed: true, http: { sealed: true },
              state: mode === "observed" ? "unknown" : "quiescent",
              canStop: mode === "ordinary",
            } },
          });
        }
        expect(heldHttp.sealed).toBe(true);
        expect(heldPublication).toBe(mode === "ordinary");
        expect(resumed).toMatchObject({
          status: 200, body: { code: "ok", data: {
            sealed: true, http: { sealed: true }, state: "quiescent", canStop: true,
            runtime: { startupRecovery: "settled" },
          } },
        });
        expect(observations).toHaveLength(mode === "observed" ? 1 : 0);
        expect(factories.host).not.toHaveBeenCalled();
        expect(factories.journal).not.toHaveBeenCalled();
      }, 15_000,
    );

    it("cannot relabel an error carrying EADDRINUSE after real listening as an early bind failure", async () => {
      const f = await storage();
      f.store.close();
      const observed = observeFactories();
      const phases: unknown[] = [];
      const options = {
        appDirectory, signal: new AbortController().signal,
        onStartupObservation: (phase: unknown) => {
          phases.push(phase);
          expect(observed.listen).toHaveBeenCalledTimes(1);
          throw Object.assign(new Error("synthetic-private-after-listen"), { code: "EADDRINUSE" });
        },
      };
      let returned: Awaited<ReturnType<typeof startWindowsWorker>> | undefined;
      let failure: unknown;
      try {
        returned = await startWindowsWorker(configuration(f.directory, f.initialized.credential.clientId), options);
      } catch (error) { failure = error; }
      finally { returned?.close(); }
      expect(failure).toMatchObject({ code: "internal_error" });
      expect(phases).toEqual([{
        phase: "listening", runnerConstructed: true, listenerSucceeded: true,
        recoveryCalled: false, claimEntered: false, prepareEntered: false, authorizeEntered: false,
      }]);
      for (const recovery of observed.recoveries) expect(recovery).not.toHaveBeenCalled();
      expect(factories.host).not.toHaveBeenCalled();
    }, 15_000);

    it("a listener failure closes obtained components without retrying or initializing another Store", async () => {
      const f = await storage();
      const observed = observeFactories();
      const initialized = vi.spyOn(storeModule, "initializeStore");
      observed.listen.mockRejectedValueOnce(new Error("synthetic bind fault"));
      f.store.close();
      await expect(
        startWindowsWorker(
          configuration(f.directory, f.initialized.credential.clientId),
          {
            appDirectory,
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toThrow();
      const opened = observed.open.mock.results[0]!
        .value as storeModule.EnhancementStore;
      f.setStore(opened);
      expect(opened.closed).toBe(true);
      expect(observed.open).toHaveBeenCalledTimes(1);
      expect(observed.listen).toHaveBeenCalledTimes(1);
      expect(observed.recoveries[0]).not.toHaveBeenCalled();
      expect(initialized).not.toHaveBeenCalled();
      expect(factories.host).not.toHaveBeenCalled();
    }, 15_000);
  },
);
