import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request, type OutgoingHttpHeaders } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as artifactsModule from "../src/artifacts.js";
import { startWindowsWorker } from "../src/bootstrap.js";
import * as clockModule from "../src/clock.js";
import { createWorkerConfig } from "../src/config.js";
import {
  EnhancementError,
  INTERNAL_SELF_TEST_KEY_PREFIX,
  NORMALIZATION_PROFILE,
  PROTOCOL_VERSION,
  type EnhancementPlanRequest,
} from "../src/contracts.js";
import {
  authenticate,
  createClient,
  revokeCredential,
  rotateCredential,
} from "../src/credentials.js";
import type { ClaimedAttempt, ExecutionTarget } from "../src/execution.js";
import * as httpModule from "../src/http.js";
import * as imageModule from "../src/image-io.js";
import * as jobsModule from "../src/jobs.js";
import * as runnerModule from "../src/runner.js";
import * as storeModule from "../src/store.js";
import type { AuthenticatedClient } from "../src/store.js";
import type { createWindowsControlBridgeHost } from "../src/windows-control-bridge-host.js";
import {
  freezeWindowsControlBridgeDescriptor,
  type WindowsRuntimeObservationReceipt,
} from "../src/windows-control-bridge-protocol.js";
import * as adapterModule from "../src/windows-execution-adapter.js";
import type {
  createWindowsJournalLauncher,
  WindowsJournalLauncher,
  WindowsJournalReadResult,
} from "../src/windows-journal-launcher.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import { nativePng, writeActualFile } from "./artifact-fixtures.js";
import { completionExit } from "./completion-fixtures.js";
import { configInput } from "./fixtures.js";
import {
  boundary,
  deferred,
  multipart,
  transportLimits,
  uploadParts,
} from "./http-fixtures.js";
import { descriptor, manualClock, snapshot } from "./lifecycle-fixtures.js";
import {
  runnerLimits,
  sha256,
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

type Runtime = Awaited<ReturnType<typeof startWindowsWorker>>;
type RuntimeStatus = ReturnType<Runtime["status"]>;
type Storage = Awaited<ReturnType<typeof storageFixture>>;
type Counts = Readonly<{
  queued: number;
  running: number;
  slots: number;
  unreleasedReferences: number;
}>;
type Activity = Readonly<{
  sealed: boolean;
  uploads: number;
  downloads: number;
  receipts: number;
}>;
// Local additive contracts let the unchanged bootstrap load. The missing
// maintenance member is asserted in each it, before its new behavior is used.
type MaintenanceSnapshot = Readonly<{
  bootId: string;
  sealed: boolean;
  state: "open" | "draining" | "quiescent" | "unknown";
  canStop: boolean;
  store: Counts | null;
  http: Activity | null;
  pending: Readonly<{
    selfTestAdmission: number;
    selfTestOutputRead: number;
    runner: number;
    adapter: number;
  }> | null;
  runtime: RuntimeStatus | null;
}>;
type Maintenance = Readonly<{
  enter(principal: AuthenticatedClient): MaintenanceSnapshot;
  query(principal: AuthenticatedClient): MaintenanceSnapshot;
}>;
type HttpResult = Readonly<{
  status: number;
  bytes: Buffer;
  body: { code?: string; data?: { ready?: boolean; job?: storeModule.JobDto; replayed?: boolean } };
}>;
type PublishedRead = Parameters<
  ReturnType<typeof artifactsModule.createArtifacts>["readPublished"]
>;

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const assetId = "zeb-enhancement-calibration-v1";
const sourceSha256 =
  "ce7faf5322ff9b665ff55896a9acab6fba4963420e88cbb6bb150ec7dc41577f";
const fixedTarget = Object.freeze({
  width: 5016,
  height: 5016,
  format: "png" as const,
});
const modelId = "calibration-4x";
const retirements: (() => void)[] = [];
const releases: (() => void)[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
const pending: Promise<unknown>[] = [];
const storeConnections = new WeakMap<
  storeModule.EnhancementStore,
  Database.Database
>();
let sourceBytes: Promise<Buffer> | undefined;
let outputBytes: Promise<Buffer> | undefined;

beforeEach(() => {
  factories.host.mockReset().mockImplementation(() => {
    throw new Error("unexpected test Host allocation");
  });
  factories.journal.mockReset().mockImplementation(() => {
    throw new Error("unexpected test journal allocation");
  });
});
afterEach(async () => {
  for (const retire of retirements.splice(0).reverse()) retire();
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function track<T>(promise: Promise<T>) {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

function gate() {
  const entered = deferred();
  const released = deferred();
  releases.push(() => released.resolve());
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    async hold() {
      entered.resolve();
      await released.promise;
    },
  };
}

async function reached(
  boundaryReached: Promise<unknown>,
  original: Promise<unknown>,
) {
  const result = await Promise.race([
    boundaryReached.then(() => "boundary" as const),
    original.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    ),
  ]);
  expect(
    result,
    "the real operation reaches its controlled boundary before returning",
  ).toBe("boundary");
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function maintenance(runtime: Runtime): Maintenance {
  const member: unknown = Reflect.get(runtime, "maintenance");
  expect(
    member !== null && typeof member === "object",
    "runtime exposes its real maintenance owner",
  ).toBe(true);
  assert.ok(member !== null && typeof member === "object");
  expect(Object.isFrozen(member)).toBe(true);
  expect(
    isDeepStrictEqual(Reflect.ownKeys(member).sort(), ["enter", "query"]),
  ).toBe(true);
  expect(
    typeof Reflect.get(member, "enter"),
    "synchronous maintenance.enter",
  ).toBe("function");
  expect(
    typeof Reflect.get(member, "query"),
    "synchronous maintenance.query",
  ).toBe("function");
  return member as Maintenance;
}

function realPending(owner: object): number {
  const method: unknown = Reflect.get(owner, "pendingWork");
  if (typeof method !== "function")
    throw new EnhancementError("internal_error");
  return Reflect.apply(method, owner, []) as number;
}

function exactKeys(value: object, expected: readonly string[]) {
  expect(
    isDeepStrictEqual(Reflect.ownKeys(value).sort(), [...expected].sort()),
    "exact safe data whitelist",
  ).toBe(true);
  expect(Object.isFrozen(value)).toBe(true);
  expect(
    Reflect.ownKeys(value).every((key) =>
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"),
    ),
    "snapshot has data properties only",
  ).toBe(true);
}

function safeSnapshot(value: MaintenanceSnapshot, h: Harness) {
  exactKeys(value, [
    "bootId",
    "sealed",
    "state",
    "canStop",
    "store",
    "http",
    "pending",
    "runtime",
  ]);
  expect(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.bootId,
    ),
  ).toBe(true);
  if (value.store)
    exactKeys(value.store, [
      "queued",
      "running",
      "slots",
      "unreleasedReferences",
    ]);
  if (value.http)
    exactKeys(value.http, ["sealed", "uploads", "downloads", "receipts"]);
  if (value.pending)
    exactKeys(value.pending, [
      "selfTestAdmission",
      "selfTestOutputRead",
      "runner",
      "adapter",
    ]);
  if (value.runtime) {
    exactKeys(value.runtime, [
      "closing",
      "startupRecovery",
      "runner",
      "adapter",
    ]);
    exactKeys(value.runtime.runner, [
      "closed",
      "storeClosed",
      "recoveryState",
      "recoveryInFlight",
      "ownedState",
    ]);
    exactKeys(value.runtime.adapter, ["sealed", "activity", "close"]);
  }
  const rendered = JSON.stringify(value);
  for (const secret of [
    h.storage.directory,
    h.storage.initialized.credential.key,
    "principal",
    "credentialId",
    "operatorClientId",
    "launchTicket",
    "ownerInstanceId",
    "jobId",
    "attemptNo",
    "referenceId",
    "bytes",
    "inputPath",
    "outputPath",
  ])
    expect(
      rendered.includes(JSON.stringify(secret).slice(1, -1)),
      "maintenance returns no private value or identity",
    ).toBe(false);
  expect(Reflect.set(value, "canStop", !value.canStop)).toBe(false);
}

// Keep Vitest's original partial/exact semantics, but never expose the
// received object or the caught matcher error to the final failure reporter.
function expectStructure(actual: unknown, expected: object, exact = false) {
  let matched = false;
  try {
    if (exact) expect(actual).toEqual(expected);
    else expect(actual).toMatchObject(expected);
    matched = true;
  } catch {
    // The original matcher may retain private values in its diagnostic.
  }
  expect(matched, "safe structural comparison").toBe(true);
}

async function expectRejectedCode(promise: Promise<unknown>, code: string) {
  let rejected = false;
  let expectedFailure = false;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    try {
      expectedFailure =
        error instanceof EnhancementError && error.code === code;
    } catch {
      // Do not publish an unexpected error object or a throwing code getter.
    }
  }
  expect(
    rejected,
    "operation rejects without exposing its fulfilled payload",
  ).toBe(true);
  expect(
    expectedFailure,
    "rejection is an EnhancementError with the expected code",
  ).toBe(true);
}

function quiescent(value: MaintenanceSnapshot, queued = 0) {
  expectStructure(value, {
    sealed: true,
    state: "quiescent",
    canStop: true,
    store: { queued, running: 0, slots: 0, unreleasedReferences: 0 },
    http: { sealed: true, uploads: 0, downloads: 0, receipts: 0 },
    pending: {
      selfTestAdmission: 0,
      selfTestOutputRead: 0,
      runner: 0,
      adapter: 0,
    },
    runtime: {
      closing: false,
      startupRecovery: "settled",
      runner: {
        closed: false,
        storeClosed: false,
        recoveryState: "idle",
        recoveryInFlight: false,
        ownedState: "none",
      },
      adapter: { sealed: false, activity: "idle", close: "not_requested" },
    },
  });
}

function safeSyncFailure(action: () => unknown, codes: readonly string[]) {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(
    thrown instanceof EnhancementError,
    "the synchronous request is rejected with a sanitized error",
  ).toBe(true);
  assert.ok(thrown instanceof EnhancementError);
  expect(codes.includes(thrown.code)).toBe(true);
}

function closedObservation(action: () => MaintenanceSnapshot) {
  try {
    const value = action();
    expect(value.canStop).toBe(false);
    expect(value.state).toBe("unknown");
  } catch (error) {
    expect(error instanceof EnhancementError).toBe(true);
    assert.ok(error instanceof EnhancementError);
    expect(
      ["not_ready", "internal_error", "authentication_failed"].includes(
        error.code,
      ),
    ).toBe(true);
  }
}

function facts(storage: Storage) {
  return snapshot(storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
    attempts: db
      .prepare("SELECT * FROM attempts ORDER BY job_id, attempt_no")
      .all(),
    slots: db.prepare("SELECT * FROM execution_slot").all(),
    references: db
      .prepare("SELECT * FROM artifact_references ORDER BY rowid")
      .all(),
    controls: db
      .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
      .all(),
    events: db.prepare("SELECT * FROM recovery_events ORDER BY rowid").all(),
  }));
}

// Observe only synchronous Store construction, using the existing C1 pattern.
// Every prepare still reaches the real driver; the Store retains this handle.
function captureStoreConnection<T>(directory: string, construct: () => T) {
  const path = join(directory, "worker.sqlite");
  const prepare = Database.prototype.prepare;
  let connection: Database.Database | undefined;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    if (this.name === path) connection = this;
    return prepare.call(this, sql);
  } as typeof prepare;
  try {
    const value = construct();
    assert.ok(connection, "the real Store connection was observed");
    return { value, db: connection };
  } finally {
    Database.prototype.prepare = prepare;
  }
}

function alterRows(storage: Storage, action: (db: Database.Database) => void) {
  const db = storeConnections.get(storage.store);
  assert.ok(db, "fault SQL uses this original Store connection");
  db.transaction(() => action(db)).immediate();
  expect(isDeepStrictEqual(db.pragma("foreign_key_check"), [])).toBe(true);
}

async function fixedSource() {
  sourceBytes ??= readFile(
    join(appDirectory, "resources", "calibration", assetId, "calibration.png"),
  );
  const bytes = await sourceBytes;
  expect(bytes.length, "existing fixed PNG prerequisite").toBe(87_100);
  expect(sha256(bytes)).toBe(sourceSha256);
  return bytes;
}

function fixedRequest(): EnhancementPlanRequest {
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    scope: "full_image",
    sourceSha256,
    target: fixedTarget,
    modelId,
    normalizationProfile: NORMALIZATION_PROFILE,
    tile: 128,
  });
}

async function harness() {
  const initialize = storeModule.initializeStore;
  const initialization = vi
    .spyOn(storeModule, "initializeStore")
    .mockImplementation((options) => {
      const captured = captureStoreConnection(options.directory, () =>
        initialize(options),
      );
      storeConnections.set(captured.value.store, captured.db);
      return captured.value;
    });
  let storage: Storage;
  try {
    storage = await storageFixture();
  } finally {
    initialization.mockRestore();
  }
  const time = manualClock(storage);
  const now = vi.fn(storage.clock);
  vi.spyOn(clockModule, "createSystemClock").mockReturnValue({
    ...time.clock,
    now,
  });
  const baseConfig = configInput();
  const workerConfig = {
    ...baseConfig,
    models: [
      baseConfig.models[0]!,
      { ...baseConfig.models[0]!, id: modelId, defaultTile: 128, gpuId: 1 },
    ],
    budgets: {
      ...baseConfig.budgets,
      delivery: { ...baseConfig.budgets.delivery, maxPixels: 5016 * 5016 },
    },
  };
  storage.setConfig(createWorkerConfig(workerConfig));
  const input = {
    storeDirectory: storage.directory,
    port: 0,
    operatorClientId: storage.initialized.credential.clientId,
    selfTestModelId: modelId,
    workerConfig,
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
  const hooks: {
    bootObservation?: boolean;
    beforePrepare?: () => void;
    afterPrepare?: () => Promise<void>;
    inputWrite?: (path: string, internal: boolean) => Promise<void>;
    inputRemove?: (path: string, internal: boolean) => Promise<void>;
    beforeReady?: (internal: boolean) => void;
    beforeWake?: () => void;
    runnerStatus?: () => void;
    runnerStatusResult?: (
      value: runnerModule.RunnerStatus,
    ) => runnerModule.RunnerStatus;
    adapterStatus?: () => void;
    runnerPending?: (value: number) => number;
    adapterPending?: (value: number) => number;
    afterInspect?: () => void;
    inspectResult?: (value: Counts) => Counts;
    adapterStatusResult?: (
      value: adapterModule.WindowsExecutionStatus,
    ) => adapterModule.WindowsExecutionStatus;
    publishedFile?: (stage: "read" | "close") => Promise<void>;
    beforePublished?: () => void;
    afterPublished?: () => Promise<void>;
    afterArtifactSettle?: () => Promise<void>;
    uploadRead?: () => Promise<void>;
    uploadRemove?: () => Promise<void>;
    failRecovery?: boolean;
  } = {};
  const calls = {
    recover: 0,
    wake: 0,
    prepare: 0,
    internalSubmit: 0,
    httpSubmit: 0,
    publishedRead: 0,
    uploadCreate: 0,
  };
  const claims: ClaimedAttempt[] = [];
  const observationSelections: {
    attempt: ClaimedAttempt;
    selected: boolean;
  }[] = [];
  const recoveries: Promise<void>[] = [];
  let runner: ReturnType<typeof runnerModule.createRunner> | undefined;
  let adapter: adapterModule.WindowsExecutionAdapter | undefined;
  let listener: httpModule.EnhancementHttpOptions | undefined;
  let selection: runnerModule.RunnerOptions["claimSelection"];

  const createAdapter = adapterModule.createWindowsExecutionAdapter;
  vi.spyOn(adapterModule, "createWindowsExecutionAdapter").mockImplementation(
    (options, observeBootAttempt) => {
      const actual = createAdapter(
        options,
        hooks.bootObservation
          ? (attempt) => {
              const selected = observeBootAttempt?.(attempt) === true;
              observationSelections.push({ attempt, selected });
              return selected;
            }
          : undefined,
      );
      const observed = Object.freeze({
        ...actual,
        status() {
          hooks.adapterStatus?.();
          const value = actual.status();
          return hooks.adapterStatusResult
            ? hooks.adapterStatusResult(value)
            : value;
        },
        pendingWork() {
          const value = realPending(actual);
          return hooks.adapterPending ? hooks.adapterPending(value) : value;
        },
      });
      adapter = observed;
      return observed;
    },
  );
  const open = storeModule.openStore;
  vi.spyOn(storeModule, "openStore").mockImplementation((options) => {
    const captured = captureStoreConnection(options.directory, () =>
      open(options),
    );
    const opened = captured.value;
    storeConnections.set(opened, captured.db);
    storage.setStore(opened);
    const claim = opened.claimNext.bind(opened);
    vi.spyOn(opened, "claimNext").mockImplementation((...args) => {
      const claimed = claim(...args);
      if (claimed) claims.push(claimed);
      return claimed;
    });
    const inspect = opened.inspectMaintenance.bind(opened);
    vi.spyOn(opened, "inspectMaintenance").mockImplementation(() => {
      const value = inspect();
      hooks.afterInspect?.();
      return hooks.inspectResult ? hooks.inspectResult(value) : value;
    });
    if (hooks.failRecovery)
      vi.spyOn(opened, "beginRecovery").mockImplementationOnce(() => {
        throw new Error("private recovery read fault");
      });
    return opened;
  });
  const createRunner = runnerModule.createRunner;
  vi.spyOn(runnerModule, "createRunner").mockImplementation((options) => {
    selection = options.claimSelection;
    const actual = createRunner(options);
    runner = Object.freeze({
      ...actual,
      recover() {
        calls.recover++;
        const result = actual.recover();
        recoveries.push(result);
        return result;
      },
      wake() {
        calls.wake++;
        hooks.beforeWake?.();
        const promise = actual.wake();
        return hooks.bootObservation ? track(promise) : promise;
      },
      status() {
        hooks.runnerStatus?.();
        const value = actual.status();
        return hooks.runnerStatusResult
          ? hooks.runnerStatusResult(value)
          : value;
      },
      pendingWork() {
        const value = actual.pendingWork();
        return hooks.runnerPending ? hooks.runnerPending(value) : value;
      },
    });
    return runner;
  });
  const prepare = imageModule.prepareEngineInput;
  vi.spyOn(imageModule, "prepareEngineInput").mockImplementation(
    async (...args) => {
      calls.prepare++;
      hooks.beforePrepare?.();
      const result = await prepare(...args);
      await hooks.afterPrepare?.();
      return result;
    },
  );
  const createService = jobsModule.createJobService;
  vi.spyOn(jobsModule, "createJobService").mockImplementation((options) => {
    const internal = options.internalIdempotencyKey !== undefined;
    const originalFiles = options.files ?? jobsModule.localInputFiles;
    const actual = createService({
      ...options,
      ready() {
        hooks.beforeReady?.(internal);
        return options.ready();
      },
      files: {
        ...originalFiles,
        async write(path, bytes) {
          await originalFiles.write(path, bytes);
          await hooks.inputWrite?.(path, internal);
        },
        async remove(path) {
          await originalFiles.remove(path);
          await hooks.inputRemove?.(path, internal);
        },
      },
    });
    return Object.freeze({
      ...actual,
      submit(...args: Parameters<typeof actual.submit>) {
        if (internal) calls.internalSubmit++;
        else calls.httpSubmit++;
        return actual.submit(...args);
      },
    });
  });
  const createArtifacts = artifactsModule.createArtifacts;
  vi.spyOn(artifactsModule, "createArtifacts").mockImplementation((options) => {
    const originalFiles = options.files ?? artifactsModule.localArtifactFiles;
    let reading = 0;
    const actual = createArtifacts({
      ...options,
      files: {
        ...originalFiles,
        async open(path, flags, mode) {
          const original = await originalFiles.open(path, flags, mode);
          return {
            stat: () => original.stat(),
            async read(...args: Parameters<typeof original.read>) {
              const result = await original.read(...args);
              if (reading && basename(path) === "artifact.png")
                await hooks.publishedFile?.("read");
              return result;
            },
            write: (...args: Parameters<typeof original.write>) =>
              original.write(...args),
            sync: () => original.sync(),
            async close() {
              await original.close();
              if (reading && basename(path) === "artifact.png")
                await hooks.publishedFile?.("close");
            },
          };
        },
      },
    });
    return Object.freeze({
      ...actual,
      async settle(...args: Parameters<typeof actual.settle>) {
        const result = await actual.settle(...args);
        await hooks.afterArtifactSettle?.();
        return result;
      },
      async readPublished(...args: PublishedRead) {
        calls.publishedRead++;
        hooks.beforePublished?.();
        reading++;
        try {
          const result = await actual.readPublished(...args);
          await hooks.afterPublished?.();
          return result;
        } finally {
          reading--;
        }
      },
    });
  });
  const listen = httpModule.listenEnhancementServer;
  vi.spyOn(httpModule, "listenEnhancementServer").mockImplementation(
    (options, port) => {
      listener = options;
      return listen(
        {
          ...options,
          uploadFiles: {
            ...httpModule.localUploadFiles,
            async createDirectory(
              ...args: Parameters<
                typeof httpModule.localUploadFiles.createDirectory
              >
            ) {
              calls.uploadCreate++;
              return httpModule.localUploadFiles.createDirectory(...args);
            },
            async readImage(path) {
              const bytes = await httpModule.localUploadFiles.readImage(path);
              await hooks.uploadRead?.();
              return bytes;
            },
            async removeDirectory(path) {
              await httpModule.localUploadFiles.removeDirectory(path);
              await hooks.uploadRemove?.();
            },
          },
        },
        port,
      );
    },
  );
  cleanups.push(() => storage.store.close());
  return {
    storage,
    time,
    now,
    input,
    hooks,
    calls,
    claims,
    observationSelections,
    runner: () => {
      assert.ok(runner);
      return runner;
    },
    adapter: () => {
      assert.ok(adapter);
      return adapter;
    },
    listener: () => {
      assert.ok(listener);
      return listener;
    },
    selection: () => {
      assert.ok(selection);
      return selection();
    },
    async settledRecovery() {
      await Promise.allSettled(recoveries);
      await flush();
    },
    native() {
      const ports = runnerNativePorts();
      factories.host.mockReturnValue(ports.host);
      factories.journal.mockImplementation(() => ports.journal().reader);
      releases.push(() => ports.release());
      return ports;
    },
    async start(signal: AbortSignal = new AbortController().signal) {
      storage.store.close();
      const runtime = await startWindowsWorker(input, {
        appDirectory,
        signal,
      });
      retirements.push(() => runtime.close());
      return runtime;
    },
    async seed(key: string, principal = storage.principal()) {
      const internal = key.startsWith(INTERNAL_SELF_TEST_KEY_PREFIX);
      const config = createWorkerConfig(input.workerConfig);
      const service = jobsModule.createJobService({
        store: storage.store,
        config: () => config,
        ready: () => true,
        runnerLimits,
        limits: {
          ...submissionLimits,
          maxWaitingJobs: internal
            ? submissionLimits.maxWaitingJobs + 1
            : submissionLimits.maxWaitingJobs,
        },
        ...(internal ? { internalIdempotencyKey: key } : {}),
      });
      return service.submit(
        principal,
        internal
          ? {
              idempotencyKey: key,
              sourceBytes: await fixedSource(),
              plan: fixedRequest(),
            }
          : submission(await sourceImage(), key),
      );
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

function connection(
  runtime: Runtime,
  principal: string,
  method: string,
  path: string,
  headers: OutgoingHttpHeaders = {},
) {
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  const req = request({
    host: "127.0.0.1",
    port: address.port,
    method,
    path,
    agent: false,
    headers: { authorization: `Bearer ${principal}`, ...headers },
  });
  retirements.push(() => req.destroy());
  const result = track(
    new Promise<HttpResult>((resolve, reject) => {
      req.once("error", () => reject(new Error("local test request failed")));
      req.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", () =>
          reject(new Error("local test response failed")),
        );
        response.once("end", () => {
          const bytes = Buffer.concat(chunks);
          let body: HttpResult["body"] = {};
          try {
            body = JSON.parse(bytes.toString("utf8")) as HttpResult["body"];
          } catch {
            /* Binary result. */
          }
          resolve({ status: response.statusCode!, bytes, body });
        });
      });
    }),
  );
  return { req, result };
}

async function capabilities(runtime: Runtime, h: Harness) {
  const call = connection(
    runtime,
    h.storage.initialized.credential.key,
    "GET",
    "/v1/capabilities",
  );
  call.req.end();
  expect((await call.result).body.data?.ready).toBe(false);
}

async function publish(
  h: Harness,
  runtime: Runtime,
  ports: ReturnType<typeof runnerNativePorts>,
) {
  const operation = await runtime.selfTest.start(h.storage.principal());
  assert.ok(operation.jobId);
  await ports.authorized;
  const attempt = h.claims.find(
    (value) => value.identity.jobId === operation.jobId,
  );
  assert.ok(attempt);
  expect(attempt.job.engineInput.width * 4).toBe(5016);
  expect(attempt.job.engineInput.height * 4).toBe(5016);
  outputBytes ??= nativePng(attempt);
  const png = await outputBytes;
  await writeActualFile(attempt.outputPath, png);
  ports.finish("engine-exit");
  await vi.waitFor(() =>
    expect(
      h.storage.store.getOwned(h.storage.principal(), operation.jobId!).status,
    ).toBe("succeeded"),
  );
  await vi.waitFor(() => expect(h.runner().status().ownedState).toBe("none"));
  await vi.waitFor(() => expect(realPending(h.runner())).toBe(0));
  await vi.waitFor(() => expect(realPending(h.adapter())).toBe(0));
  expect(h.calls.publishedRead).toBe(0);
  return { operation, attempt, png };
}

describe.skipIf(process.platform !== "win32")(
  "bootstrap original maintenance seal and drain observation",
  () => {
    it("keeps zero-activity maintenance quiescent with a private runtime observation and rejects other extra status fields", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const principal = h.storage.principal();
      const receipt = Object.freeze({
        descriptor: freezeWindowsControlBridgeDescriptor(
          controlBridgeExecutionDescriptor(
            {
              identity: {
                jobId: "maintenance-observation-job",
                attemptNo: 1,
                ownerInstanceId: "maintenance-observation-owner",
                fence: 1,
              },
              launchTicket: "maintenance-observation-ticket",
            },
            "c".repeat(64),
            "d".repeat(64),
          ),
        ),
        observation: Object.freeze({
          v: 1 as const,
          background: null,
          engine: null,
          gpu: Object.freeze({ state: "not-started" as const }),
        }),
      });
      h.hooks.adapterStatusResult = (value) =>
        Object.freeze({ ...value, runtimeObservation: receipt });
      for (const value of [m.enter(principal), m.query(principal)]) {
        quiescent(value);
        safeSnapshot(value, h);
        expect(JSON.stringify(value).includes("runtimeObservation")).toBe(false);
      }
      h.hooks.adapterStatusResult = (value) =>
        Object.freeze({
          ...value,
          runtimeObservation: receipt,
          unexpectedObservation: true,
        });
      expectStructure(m.query(principal), {
        state: "unknown",
        canStop: false,
        runtime: null,
      });
      h.hooks.adapterStatusResult = undefined;
      quiescent(m.query(principal));
    }, 15_000);

    it("keeps ordinary and expired diagnostic queued facts unchanged while the same open boot becomes quiescent", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const principal = h.storage.principal();
      const boot = (await runtime.selfTest.query(principal)).bootId;
      await h.seed("maintenance-ordinary");
      await h.seed(INTERNAL_SELF_TEST_KEY_PREFIX + randomUUID());
      h.storage.setNow(h.storage.clock() + submissionLimits.queueTimeoutMs + 1);
      const before = facts(h.storage);
      const originalStatus = runtime.status();
      const calls = { ...h.calls };
      const timers = h.time.entries.length;
      h.now.mockClear();
      const open = m.query(principal);
      expectStructure(open, {
        bootId: boot,
        sealed: false,
        state: "open",
        canStop: false,
        store: { queued: 2 },
      });
      safeSnapshot(open, h);
      const sealed = m.enter(principal);
      safeSnapshot(sealed, h);
      quiescent(sealed, 2);
      expect(sealed.bootId).toBe(boot);
      quiescent(m.enter(principal), 2);
      quiescent(m.query(principal), 2);
      expect(isDeepStrictEqual(runtime.status(), originalStatus)).toBe(true);
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
      expect(isDeepStrictEqual(h.calls, calls)).toBe(true);
      expect(h.now.mock.calls.length).toBe(0);
      expect(h.time.entries.length).toBe(timers);
      expect(h.selection()).toBe("none");
      expect(runtime.server.listening).toBe(true);
      expect(h.storage.store.closed).toBe(false);
      expect((await runtime.selfTest.query(principal)).phase).toBe(
        "not_started",
      );
      await expectRejectedCode(runtime.selfTest.start(principal), "not_ready");
      await capabilities(runtime, h);
      expect(factories.host.mock.calls.length).toBe(0);
      expect(factories.journal.mock.calls.length).toBe(0);
    }, 15_000);

    it.each(["running", "slot"] as const)(
      "independently blocks the global %s even with no local Runner or Adapter work",
      async (kind) => {
        const h = await harness();
        const runtime = await h.start();
        const m = maintenance(runtime);
        await h.settledRecovery();
        const accepted = await h.seed("independent-" + kind);
        const attempt = h.storage.store.claimNext(
          "previous-external-owner",
          accepted.job.jobId,
        );
        assert.ok(attempt);
        alterRows(h.storage, (db) => {
          if (kind === "running")
            db.prepare("DELETE FROM execution_slot").run();
          else
            db.prepare(
              "UPDATE jobs SET status = 'failed', reason = 'execution_failed', completed_at = 1000 WHERE job_id = ?",
            ).run(accepted.job.jobId);
        });
        h.storage.setNow(200_000);
        const before = facts(h.storage);
        const observed = m.enter(h.storage.principal());
        expectStructure(observed, {
          state: "draining",
          canStop: false,
          store: {
            queued: 0,
            running: kind === "running" ? 1 : 0,
            slots: kind === "slot" ? 1 : 0,
            unreleasedReferences: 0,
          },
          pending: {
            runner: 0,
            adapter: 0,
            selfTestAdmission: 0,
            selfTestOutputRead: 0,
          },
          runtime: {
            runner: { ownedState: "none", recoveryState: "idle" },
            adapter: { activity: "idle" },
          },
        });
        expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
        expect(factories.host.mock.calls.length).toBe(0);
        expect(h.calls.recover).toBe(1);
      },
      15_000,
    );

    it("blocks other-client historical run and recovery references independently of running rows, slots and local holders", async () => {
      const h = await harness();
      const other = createClient(h.storage.store);
      const principal = authenticate(h.storage.store, `Bearer ${other.key}`);
      const accepted = await h.seed("historical-reference-owner", principal);
      const attempt = h.storage.store.claimNext(
        "historical-reference-producer",
        accepted.job.jobId,
      );
      assert.ok(attempt);
      expect(
        h.storage.store.registerPrepared(attempt.identity, descriptor(attempt)),
      ).toBe(true);
      expect(
        h.storage.store.authorizeLaunch(attempt.identity, descriptor(attempt)),
      ).toBe(true);
      expect(
        h.storage.store.registerExit(
          completionExit(attempt, {
            kind: "success",
            exitCode: 0,
            signal: null,
          }),
        ),
      ).toBe(true);
      const run = h.storage.store.acquireArtifactWork(attempt.identity, "run");
      const recovery = h.storage.store.acquireArtifactWork(
        attempt.identity,
        "recovery",
      );
      assert.ok(run && recovery);
      alterRows(h.storage, (db) => {
        db.prepare("DELETE FROM execution_slot").run();
        db.prepare(
          "UPDATE jobs SET status = 'failed', reason = 'execution_failed', completed_at = 1000 WHERE job_id = ?",
        ).run(accepted.job.jobId);
      });
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const refs = snapshot(h.storage, (db) =>
        db
          .prepare(
            "SELECT incarnation_id, purpose, candidate_id, released_at FROM artifact_references ORDER BY rowid",
          )
          .all(),
      ) as {
        incarnation_id: string;
        purpose: string;
        candidate_id: string | null;
        released_at: number | null;
      }[];
      expect(refs.length).toBe(2);
      expect(
        refs.every(
          (ref) => ref.candidate_id === null && ref.released_at === null,
        ),
      ).toBe(true);
      expect(new Set(refs.map((ref) => ref.purpose)).size).toBe(2);
      const incarnation = snapshot(h.storage, (db) =>
        db
          .prepare(
            "SELECT incarnation_id FROM store_incarnations ORDER BY rowid DESC LIMIT 1",
          )
          .get(),
      ) as { incarnation_id: string };
      expect(
        refs.every((ref) => ref.incarnation_id !== incarnation.incarnation_id),
        "the real held references belong to the predecessor incarnation",
      ).toBe(true);
      const before = facts(h.storage);
      expectStructure(m.enter(h.storage.principal()), {
        state: "draining",
        canStop: false,
        store: { queued: 0, running: 0, slots: 0, unreleasedReferences: 2 },
        pending: {
          runner: 0,
          adapter: 0,
          selfTestAdmission: 0,
          selfTestOutputRead: 0,
        },
        runtime: {
          runner: { ownedState: "none", recoveryState: "idle" },
          adapter: { activity: "idle" },
        },
      });
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
    }, 15_000);

    it("authenticates before sealing or reading and accepts only real same-client credential rotation", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const operator = h.storage.principal();
      const foreign = await storageFixture();
      cleanups.push(() => foreign.store.close());
      const wrong = createClient(h.storage.store);
      const wrongPrincipal = authenticate(
        h.storage.store,
        `Bearer ${wrong.key}`,
      );
      const inspect = vi.spyOn(h.storage.store, "inspectMaintenance");
      const before = facts(h.storage);
      for (const invalid of [
        wrongPrincipal,
        Object.freeze({ ...operator }),
        foreign.principal(),
      ]) {
        safeSyncFailure(() => m.enter(invalid), ["authentication_failed"]);
        safeSyncFailure(() => m.query(invalid), ["authentication_failed"]);
      }
      expect(inspect.mock.calls.length).toBe(0);
      expect(Reflect.get(runtime.server, "fileIo").activity().sealed).toBe(
        false,
      );
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
      const next = rotateCredential(
        h.storage.store,
        { clientId: operator.clientId },
        operator,
      );
      const current = authenticate(h.storage.store, `Bearer ${next.key}`);
      revokeCredential(h.storage.store, operator.credentialId, operator);
      inspect.mockClear();
      safeSyncFailure(() => m.enter(operator), ["authentication_failed"]);
      safeSyncFailure(() => m.query(operator), ["authentication_failed"]);
      expect(inspect.mock.calls.length).toBe(0);
      const open = m.query(current);
      const sealed = m.enter(current);
      expect(sealed.bootId).toBe(open.bootId);
      quiescent(sealed);
      quiescent(m.query(current));
      h.hooks.afterInspect = () => {
        h.hooks.afterInspect = undefined;
        revokeCredential(h.storage.store, current.credentialId, current);
      };
      safeSyncFailure(() => m.query(current), ["authentication_failed"]);
      expect(Reflect.get(runtime.server, "fileIo").activity().sealed).toBe(
        true,
      );
      expect(h.calls.recover).toBe(1);
      expect(h.calls.wake).toBe(0);
    }, 15_000);

    it("rejects new Expect upload, download and receipt through the original HTTP owner without starting file work", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const ports = h.native();
      const success = await publish(h, runtime, ports);
      const principal = h.storage.principal();
      quiescent(m.enter(principal));
      const before = facts(h.storage);
      const reads = h.calls.publishedRead;
      const creates = h.calls.uploadCreate;
      const body = multipart(uploadParts(await sourceImage()));
      const upload = connection(
        runtime,
        h.storage.initialized.credential.key,
        "POST",
        "/v1/enhancement-jobs",
        {
          "idempotency-key": "sealed-new-upload",
          expect: "100-continue",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": body.length,
        },
      );
      let continued = 0;
      upload.req.on("continue", () => {
        continued++;
        upload.req.end(body);
      });
      upload.req.flushHeaders();
      expect((await upload.result).body.code).toBe("not_ready");
      expect(continued).toBe(0);
      upload.req.destroy();
      const path = `/v1/enhancement-jobs/${success.operation.jobId}`;
      const download = connection(
        runtime,
        h.storage.initialized.credential.key,
        "GET",
        `${path}/result`,
      );
      download.req.end();
      expect((await download.result).body.code).toBe("not_ready");
      const receipt = connection(
        runtime,
        h.storage.initialized.credential.key,
        "POST",
        `${path}/receipt`,
        { "content-type": "application/json" },
      );
      receipt.req.end(
        JSON.stringify({
          serviceId: h.storage.store.identity.serviceId,
          receiptId: randomUUID(),
          result: h.storage.store.getOwned(principal, success.operation.jobId!)
            .result,
        }),
      );
      expect((await receipt.result).body.code).toBe("not_ready");
      expect(h.calls.uploadCreate).toBe(creates);
      expect(h.calls.publishedRead).toBe(reads);
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
      quiescent(m.query(principal));
      await capabilities(runtime, h);
    }, 25_000);

    it("retains an already receiving HTTP upload until real spool cleanup returns and starts no new submit after enter", async () => {
      const h = await harness();
      const reading = gate();
      const cleaning = gate();
      h.hooks.uploadRead = () => reading.hold();
      h.hooks.uploadRemove = () => cleaning.hold();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const baselineSubmits = h.calls.httpSubmit;
      const bytes = multipart(uploadParts(await sourceImage()));
      const upload = connection(
        runtime,
        h.storage.initialized.credential.key,
        "POST",
        "/v1/enhancement-jobs",
        {
          "idempotency-key": "receiving-at-enter",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": bytes.length,
        },
      );
      upload.req.end(bytes);
      await reached(reading.entered, upload.result);
      expectStructure(m.enter(h.storage.principal()), {
        state: "draining",
        canStop: false,
        http: { sealed: true, uploads: 1 },
      });
      reading.release();
      await reached(cleaning.entered, upload.result);
      expectStructure(m.query(h.storage.principal()), {
        canStop: false,
        http: { uploads: 1 },
      });
      expect(h.calls.httpSubmit).toBe(baselineSubmits);
      cleaning.release();
      expect((await upload.result).body.code).toBe("not_ready");
      quiescent(m.query(h.storage.principal()));
      expect(facts(h.storage).jobs.length).toBe(0);
    }, 15_000);

    it.each(["download", "receipt"] as const)(
      "includes the real in-flight HTTP %s without counting it as self-test output work",
      async (kind) => {
        const h = await harness();
        const runtime = await h.start();
        const m = maintenance(runtime);
        await h.settledRecovery();
        const success = await publish(h, runtime, h.native());
        const principal = h.storage.principal();
        const path = `/v1/enhancement-jobs/${success.operation.jobId}/${kind === "download" ? "result" : "receipt"}`;
        if (kind === "download") {
          const reading = gate();
          let held = false;
          h.hooks.publishedFile = async (stage) => {
            if (stage !== "read" || held) return;
            held = true;
            await reading.hold();
          };
          const call = connection(
            runtime,
            h.storage.initialized.credential.key,
            "GET",
            path,
          );
          call.req.end();
          await reached(reading.entered, call.result);
          expectStructure(m.enter(principal), {
            state: "draining",
            canStop: false,
            http: { downloads: 1, receipts: 0 },
            pending: { selfTestOutputRead: 0, runner: 0, adapter: 0 },
            store: { unreleasedReferences: 1 },
          });
          reading.release();
          const result = await call.result;
          expect(result.status).toBe(200);
          expect(result.bytes.equals(success.png)).toBe(true);
        } else {
          const bytes = Buffer.from(
            JSON.stringify({
              serviceId: h.storage.store.identity.serviceId,
              receiptId: randomUUID(),
              result: h.storage.store.getOwned(
                principal,
                success.operation.jobId!,
              ).result,
            }),
          );
          const call = connection(
            runtime,
            h.storage.initialized.credential.key,
            "POST",
            path,
            {
              "content-type": "application/json",
              "content-length": bytes.length,
            },
          );
          call.req.write(bytes.subarray(0, 1));
          await vi.waitFor(() =>
            expect(m.query(principal).http?.receipts).toBe(1),
          );
          expectStructure(m.enter(principal), {
            state: "draining",
            canStop: false,
            http: { downloads: 0, receipts: 1 },
            pending: { selfTestOutputRead: 0, runner: 0, adapter: 0 },
            store: { unreleasedReferences: 0 },
          });
          call.req.end(bytes.subarray(1));
          expect((await call.result).status).toBe(200);
        }
        await vi.waitFor(() => quiescent(m.query(principal)));
        expect(h.calls.internalSubmit).toBe(1);
        expect(h.selection()).toBe("none");
      },
      25_000,
    );

    it.each(["prepare", "submit"] as const)(
      "counts the one real self-test admission through its %s return and original cleanup",
      async (stage) => {
        const h = await harness();
        const runtime = await h.start();
        const m = maintenance(runtime);
        await h.settledRecovery();
        const principal = h.storage.principal();
        const held = gate();
        const cleanup = gate();
        let selected = false;
        let reserved: MaintenanceSnapshot | undefined;
        h.hooks.beforePrepare = () => {
          reserved ??= m.query(principal);
        };
        if (stage === "prepare")
          h.hooks.afterPrepare = async () => {
            if (selected) return;
            selected = true;
            await held.hold();
          };
        else {
          h.hooks.inputWrite = async (_path, internal) => {
            if (!internal || selected) return;
            selected = true;
            await held.hold();
          };
          h.hooks.inputRemove = async (_path, internal) => {
            if (internal) await cleanup.hold();
          };
        }
        const first = track(runtime.selfTest.start(principal));
        const concurrent = track(runtime.selfTest.start(principal));
        await reached(held.entered, first);
        expect(
          reserved?.pending?.selfTestAdmission,
          "reserve before the reentrant real preparation call",
        ).toBe(1);
        expectStructure(m.enter(principal), {
          state: "draining",
          canStop: false,
          pending: { selfTestAdmission: 1, selfTestOutputRead: 0 },
        });
        expect(m.query(principal).pending?.selfTestAdmission).toBe(1);
        await expectRejectedCode(
          runtime.selfTest.start(principal),
          "not_ready",
        );
        held.release();
        if (stage === "submit") {
          await reached(cleanup.entered, first);
          expectStructure(m.query(principal), {
            canStop: false,
            pending: { selfTestAdmission: 1 },
            store: { queued: 0, running: 0, slots: 0 },
          });
          cleanup.release();
        }
        await expectRejectedCode(first, "not_ready");
        await expectRejectedCode(concurrent, "not_ready");
        quiescent(m.query(principal));
        expect(facts(h.storage).jobs.length).toBe(0);
        expect(factories.host.mock.calls.length).toBe(0);
        expect(h.calls.internalSubmit).toBe(stage === "submit" ? 1 : 0);
      },
      25_000,
    );

    it("rechecks a seal reentered from Adapter.status at the real private submit final ready gate", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const principal = h.storage.principal();
      let entered: MaintenanceSnapshot | undefined;
      h.hooks.beforeReady = (internal) => {
        if (!internal || entered) return;
        h.hooks.adapterStatus = () => {
          h.hooks.adapterStatus = undefined;
          entered = m.enter(principal);
        };
      };
      await expectRejectedCode(runtime.selfTest.start(principal), "not_ready");
      expect(entered?.pending?.selfTestAdmission).toBe(1);
      expect(entered?.sealed).toBe(true);
      expect(facts(h.storage).jobs.length).toBe(0);
      expect(h.calls.internalSubmit).toBe(1);
      expect(factories.host.mock.calls.length).toBe(0);
      quiescent(m.query(principal));
    }, 25_000);

    it("preserves an accepted bound queued self-test when selector admission synchronously reenters maintenance", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      await h.seed("older-ordinary-kept");
      const principal = h.storage.principal();
      let entered: MaintenanceSnapshot | undefined;
      h.hooks.beforeWake = () => {
        h.hooks.beforeWake = undefined;
        h.hooks.adapterStatus = () => {
          h.hooks.adapterStatus = undefined;
          entered = m.enter(principal);
        };
      };
      const operation = await runtime.selfTest.start(principal);
      expect(entered?.sealed).toBe(true);
      assert.ok(operation.jobId);
      expect(h.storage.store.getOwned(principal, operation.jobId).status).toBe(
        "queued",
      );
      expect(h.selection()).toBe("none");
      const before = facts(h.storage);
      await h.runner().wake();
      await expectRejectedCode(runtime.selfTest.start(principal), "not_ready");
      const query = await runtime.selfTest.query(principal);
      expect(query.jobId).toBe(operation.jobId);
      expect(query.output === null).toBe(true);
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
      expect(h.claims.length).toBe(0);
      expect(h.calls.internalSubmit).toBe(1);
      quiescent(m.query(principal), 2);
      expect(factories.host.mock.calls.length).toBe(0);
    }, 25_000);

    it("blocks late launch and Adapter AUTH Promises after real terminal publication retires their holder, then accepts their true settlement", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      await h.seed("ordinary-after-real-drain");
      const ports = h.native();
      ports.holdAuthorization();
      const principal = h.storage.principal();
      const operation = await runtime.selfTest.start(principal);
      await ports.authorized;
      const attempt = h.claims.find(
        (value) => value.identity.jobId === operation.jobId,
      );
      assert.ok(attempt);
      expectStructure(m.enter(principal), {
        canStop: false,
        state: "draining",
        store: { queued: 1, running: 1, slots: 1 },
      });
      outputBytes ??= nativePng(attempt);
      await writeActualFile(attempt.outputPath, await outputBytes);
      ports.finish("engine-exit");
      await vi.waitFor(() =>
        expect(
          h.storage.store.getOwned(principal, operation.jobId!).status,
        ).toBe("succeeded"),
      );
      await vi.waitFor(() =>
        expect(runtime.status().runner.ownedState).toBe("none"),
      );
      await vi.waitFor(() =>
        expect(runtime.status().adapter.activity).toBe("idle"),
      );
      const late = m.query(principal);
      expectStructure(late, {
        state: "draining",
        canStop: false,
        store: { queued: 1, running: 0, slots: 0, unreleasedReferences: 0 },
        runtime: {
          runner: { ownedState: "none" },
          adapter: { activity: "idle" },
        },
      });
      expect(late.pending!.runner).toBeGreaterThan(0);
      expect(late.pending!.adapter).toBeGreaterThan(0);
      ports.acknowledgeAuthorization();
      await vi.waitFor(() => quiescent(m.query(principal), 1));
      await h.runner().wake();
      quiescent(m.query(principal), 1);
      expect(h.claims.length).toBe(1);
      expect(h.selection()).toBe("none");
      await capabilities(runtime, h);
    }, 25_000);

    it("independently blocks a real Adapter inspect Promise while its current entry and Runner status are already idle", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const ports = h.native();
      const operation = await runtime.selfTest.start(h.storage.principal());
      await ports.authorized;
      const attempt = h.claims.find(
        (value) => value.identity.jobId === operation.jobId,
      );
      assert.ok(attempt);
      const held = gate();
      const inspect = ports.host.inspect.getMockImplementation();
      assert.ok(inspect);
      ports.host.inspect.mockImplementationOnce(async (...args) => {
        const result = await inspect(...args);
        await held.hold();
        return result;
      });
      const inspecting = track(h.adapter().inspect(attempt, ports.descriptor));
      await reached(held.entered, inspecting);
      outputBytes ??= nativePng(attempt);
      await writeActualFile(attempt.outputPath, await outputBytes);
      ports.finish("engine-exit");
      await vi.waitFor(() =>
        expect(runtime.status().adapter.activity).toBe("idle"),
      );
      await vi.waitFor(() =>
        expect(runtime.status().runner.ownedState).toBe("none"),
      );
      await vi.waitFor(() => expect(realPending(h.runner())).toBe(0));
      const observed = m.enter(h.storage.principal());
      expectStructure(observed, {
        state: "draining",
        canStop: false,
        store: { running: 0, slots: 0, unreleasedReferences: 0 },
        pending: { runner: 0, selfTestAdmission: 0, selfTestOutputRead: 0 },
        runtime: { adapter: { activity: "idle" } },
      });
      expect(observed.pending!.adapter).toBeGreaterThan(0);
      held.release();
      expect((await inspecting).kind).toBe("tree-exited");
      await vi.waitFor(() => quiescent(m.query(h.storage.principal())));
    }, 25_000);

    it("independently blocks the original Runner artifact Promise after real publication and a wake retire its holder", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const ports = h.native();
      const operation = await runtime.selfTest.start(h.storage.principal());
      await ports.authorized;
      const attempt = h.claims.find(
        (value) => value.identity.jobId === operation.jobId,
      );
      assert.ok(attempt);
      const returning = gate();
      h.hooks.afterArtifactSettle = () => returning.hold();
      outputBytes ??= nativePng(attempt);
      await writeActualFile(attempt.outputPath, await outputBytes);
      ports.finish("engine-exit");
      await returning.entered;
      expect(
        h.storage.store.getOwned(h.storage.principal(), operation.jobId!)
          .status,
      ).toBe("succeeded");
      await h.runner().wake();
      await vi.waitFor(() => expect(realPending(h.adapter())).toBe(0));
      expect(runtime.status().runner.ownedState).toBe("none");
      const observed = m.enter(h.storage.principal());
      expectStructure(observed, {
        state: "draining",
        canStop: false,
        store: { running: 0, slots: 0, unreleasedReferences: 0 },
        pending: { adapter: 0, selfTestAdmission: 0, selfTestOutputRead: 0 },
        runtime: {
          runner: { ownedState: "none", recoveryState: "idle" },
          adapter: { activity: "idle" },
        },
      });
      expect(observed.pending!.runner).toBeGreaterThan(0);
      returning.release();
      await vi.waitFor(() => quiescent(m.query(h.storage.principal())));
      expect(h.claims.length).toBe(1);
      expect(h.calls.internalSubmit).toBe(1);
    }, 25_000);

    it("does not start a first output read from succeeded metadata after maintenance", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const success = await publish(h, runtime, h.native());
      const principal = h.storage.principal();
      quiescent(m.enter(principal));
      const before = facts(h.storage);
      for (let index = 0; index < 2; index++) {
        const queried = await runtime.selfTest.query(principal);
        expect(queried.jobId).toBe(success.operation.jobId);
        expect(queried.phase === "output_verified").toBe(false);
        expect(queried.output === null).toBe(true);
        expect(queried.qualification).toBe("unknown");
      }
      expect(h.calls.publishedRead).toBe(0);
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
      quiescent(m.query(principal));
      await expectRejectedCode(runtime.selfTest.start(principal), "not_ready");
      await capabilities(runtime, h);
    }, 25_000);

    it("keeps the issued full output read single flight through file close, real reference release and validation tail after enter", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const success = await publish(h, runtime, h.native());
      const principal = h.storage.principal();
      const reading = gate();
      const closing = gate();
      const returning = gate();
      let readHeld = false;
      let closeHeld = false;
      let reserved: MaintenanceSnapshot | undefined;
      h.hooks.beforePublished = () => {
        reserved = m.query(principal);
      };
      h.hooks.publishedFile = async (stage) => {
        if (stage === "read" && !readHeld) {
          readHeld = true;
          await reading.hold();
        }
        if (stage === "close" && !closeHeld) {
          closeHeld = true;
          await closing.hold();
        }
      };
      h.hooks.afterPublished = () => returning.hold();
      const first = track(runtime.selfTest.query(principal));
      const concurrent = track(runtime.selfTest.query(principal));
      await reached(reading.entered, first);
      expect(
        reserved?.pending?.selfTestOutputRead,
        "reserve before reentrant readPublished",
      ).toBe(1);
      const atSeal = m.enter(principal);
      expectStructure(atSeal, {
        state: "draining",
        canStop: false,
        pending: { selfTestAdmission: 0, selfTestOutputRead: 1 },
        store: { unreleasedReferences: 1 },
      });
      const joinedAfterSeal = track(runtime.selfTest.query(principal));
      expect(h.calls.publishedRead).toBe(1);
      reading.release();
      await reached(closing.entered, first);
      expectStructure(m.query(principal), {
        canStop: false,
        pending: { selfTestOutputRead: 1 },
        store: { unreleasedReferences: 1 },
      });
      closing.release();
      await reached(returning.entered, first);
      expectStructure(m.query(principal), {
        state: "draining",
        canStop: false,
        pending: {
          selfTestAdmission: 0,
          selfTestOutputRead: 1,
          runner: 0,
          adapter: 0,
        },
        store: { running: 0, slots: 0, unreleasedReferences: 0 },
      });
      returning.release();
      for (const result of await Promise.all([
        first,
        concurrent,
        joinedAfterSeal,
      ])) {
        expect(result.phase).toBe("output_verified");
        expect(result.qualification).toBe("unknown");
        expectStructure(
          result.output,
          {
            format: "png",
            width: 5016,
            height: 5016,
            sha256: sha256(success.png),
            byteLength: success.png.length,
          },
          true,
        );
      }
      quiescent(m.query(principal));
      expect((await runtime.selfTest.query(principal)).phase).toBe(
        "output_verified",
      );
      expect(h.calls.publishedRead).toBe(1);
      quiescent(m.query(principal));
      await capabilities(runtime, h);
    }, 25_000);

    it("keeps startup inspection pending and a real unknown result unavailable without starting a second recovery", async () => {
      const h = await harness();
      const accepted = await h.seed("startup-original-identity");
      const attempt = h.storage.store.claimNext(
        "startup-original-owner",
        accepted.job.jobId,
      );
      assert.ok(attempt);
      const prepared = freezeWindowsPrepareRequest(attempt);
      const owner = controlBridgeExecutionDescriptor(
        { identity: attempt.identity, launchTicket: attempt.launchTicket },
        attempt.executionPolicy.fingerprint,
        prepared.requestFingerprint,
      );
      expect(h.storage.store.registerPrepared(attempt.identity, owner)).toBe(
        true,
      );
      expect(h.storage.store.authorizeLaunch(attempt.identity, owner)).toBe(
        true,
      );
      const result = deferred<WindowsJournalReadResult>();
      const cleanup = deferred<"closed" | "unknown">();
      releases.push(() => {
        result.resolve({ kind: "unknown", cleanup: "closed" });
        cleanup.resolve("closed");
      });
      const reader = {
        read: vi.fn<WindowsJournalLauncher["read"]>(() => result.promise),
        close: vi.fn<WindowsJournalLauncher["close"]>(() => cleanup.promise),
      } satisfies WindowsJournalLauncher;
      factories.journal.mockReturnValue(reader);
      const runtime = await h.start();
      const m = maintenance(runtime);
      await vi.waitFor(() => expect(reader.read.mock.calls.length).toBe(1));
      const principal = h.storage.principal();
      const inspecting = m.enter(principal);
      expectStructure(inspecting, {
        state: "unknown",
        canStop: false,
        runtime: {
          startupRecovery: "pending",
          runner: { recoveryInFlight: true },
        },
      });
      expect(inspecting.pending!.runner).toBeGreaterThan(0);
      expect(inspecting.pending!.adapter).toBeGreaterThan(0);
      result.resolve({ kind: "unknown", cleanup: "closed" });
      await h.settledRecovery();
      expectStructure(m.query(principal), {
        state: "unknown",
        canStop: false,
        runtime: {
          startupRecovery: "settled",
          runner: { recoveryState: "unknown" },
          adapter: { activity: "unknown" },
        },
      });
      const before = facts(h.storage);
      for (let index = 0; index < 2; index++)
        expect(m.query(principal).canStop).toBe(false);
      expect(h.calls.recover).toBe(1);
      expect(reader.read.mock.calls.length).toBe(1);
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
      runtime.close();
      expect(runtime.status().adapter.close).toBe("pending");
      expect(realPending(h.adapter())).toBeGreaterThan(0);
      closedObservation(() => m.query(principal));
      cleanup.resolve("closed");
      await flush();
      closedObservation(() => m.query(principal));
    }, 15_000);

    it("does not turn a real startup recovery failure or closed cleared references into an empty quiescent instance", async () => {
      const h = await harness();
      h.hooks.failRecovery = true;
      vi.spyOn(console, "error").mockImplementation(() => {});
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const principal = h.storage.principal();
      expectStructure(m.enter(principal), {
        state: "unknown",
        canStop: false,
        runtime: {
          startupRecovery: "failed",
          runner: { recoveryState: "idle", ownedState: "none" },
          adapter: { activity: "idle" },
        },
      });
      expect(h.calls.recover).toBe(1);
      runtime.close();
      closedObservation(() => m.query(principal));
      closedObservation(() => m.enter(principal));
      expect(h.calls.recover).toBe(1);
    }, 15_000);

    it("keeps seals after a real count read throws and rejects invalid or throwing original pending observations as unknown", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const principal = h.storage.principal();
      const before = facts(h.storage);
      const inspect = vi.spyOn(h.storage.store, "inspectMaintenance");
      inspect.mockImplementationOnce(() => {
        throw new Error("private maintenance count detail");
      });
      const failed = m.enter(principal);
      expectStructure(failed, {
        sealed: true,
        state: "unknown",
        canStop: false,
        store: null,
      });
      safeSnapshot(failed, h);
      expect(
        JSON.stringify(failed).includes("private maintenance count detail"),
      ).toBe(false);
      expect(Reflect.get(runtime.server, "fileIo").activity().sealed).toBe(
        true,
      );
      await expectRejectedCode(runtime.selfTest.start(principal), "not_ready");
      quiescent(m.query(principal));
      h.hooks.inspectResult = (value) => Object.freeze({ ...value, slots: 2 });
      expectStructure(m.query(principal), {
        state: "unknown",
        canStop: false,
        store: null,
      });
      h.hooks.inspectResult = (value) =>
        Object.freeze({ queued: value.queued }) as Counts;
      expectStructure(m.query(principal), {
        state: "unknown",
        canStop: false,
        store: null,
      });
      h.hooks.inspectResult = undefined;
      for (const invalid of [NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        h.hooks.runnerPending = () => invalid;
        expectStructure(m.query(principal), {
          state: "unknown",
          canStop: false,
          pending: null,
        });
      }
      h.hooks.runnerPending = undefined;
      h.hooks.adapterPending = () => {
        throw new Error("private Adapter pending detail");
      };
      const unknown = m.query(principal);
      expectStructure(unknown, {
        state: "unknown",
        canStop: false,
        pending: null,
      });
      safeSnapshot(unknown, h);
      h.hooks.adapterPending = undefined;
      h.hooks.adapterStatusResult = (value) =>
        Object.freeze({
          ...value,
          activity: "invalid-observation",
        }) as unknown as adapterModule.WindowsExecutionStatus;
      expectStructure(m.query(principal), {
        state: "unknown",
        canStop: false,
        runtime: null,
      });
      h.hooks.adapterStatusResult = undefined;
      quiescent(m.query(principal));
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
    }, 15_000);

    it("detects a maintenance seal or close synchronously reentered while reading original runtime owners", async () => {
      const h = await harness();
      const runtime = await h.start();
      const m = maintenance(runtime);
      await h.settledRecovery();
      const principal = h.storage.principal();
      let nested: MaintenanceSnapshot | undefined;
      h.hooks.runnerStatus = () => {
        h.hooks.runnerStatus = undefined;
        nested = m.enter(principal);
      };
      const outer = m.query(principal);
      expect(nested?.canStop).toBe(true);
      expectStructure(outer, { state: "unknown", canStop: false });
      quiescent(m.query(principal));
      h.hooks.adapterStatus = () => {
        h.hooks.adapterStatus = undefined;
        runtime.close();
      };
      closedObservation(() => m.query(principal));
      expect(runtime.status().closing).toBe(true);
      expect(Reflect.get(runtime.server, "fileIo").activity().sealed).toBe(
        true,
      );
      expect(h.calls.recover).toBe(1);
      expect(h.calls.wake).toBe(0);
    }, 15_000);
  },
);

type QualificationPorts = ReturnType<Harness["native"]>;
type QualificationReceipt = WindowsRuntimeObservationReceipt;
const qualificationSid = "S-1-5-80-1-2-3-4-5";

// Factory-port facts exercise F3's consumer. Original execution/engine pins
// remain the F2a contract; these fixtures are not native or GPU evidence.
function qualificationReceipt(ports: QualificationPorts): QualificationReceipt {
  const owner = freezeWindowsControlBridgeDescriptor(ports.descriptor);
  const engine = owner.details.engine as { pid: number; creationFileTime: string };
  return Object.freeze({
    descriptor: owner,
    observation: Object.freeze({
      v: 1,
      background: Object.freeze({
        state: "observed",
        host: Object.freeze({ pid: 30_011, creationFileTime: "9007199254740991" }),
        worker: Object.freeze({
          pid: 30_012,
          creationFileTime: "9007199254740992",
          userSid: qualificationSid,
          sessionId: 0,
        }),
      }),
      engine: Object.freeze({
        state: "observed",
        process: Object.freeze({ ...engine, userSid: qualificationSid, sessionId: 0 }),
      }),
      gpu: Object.freeze({
        state: "observed",
        driverVersion: "580.97",
        devices: Object.freeze([
          Object.freeze({ nvmlIndex: 0, name: "Qualification fixture GPU", uuid: null, graphics: true, compute: false }),
        ]),
      }),
    }),
  });
}

async function qualificationCase(
  receive: (value: QualificationReceipt) => QualificationReceipt | undefined = (value) => value,
  unknownClose = false,
) {
  const h = await harness();
  h.hooks.bootObservation = true;
  const abort = new AbortController();
  const runtime = await h.start(abort.signal);
  await h.settledRecovery();
  const ports = h.native();
  const whenClosed = ports.host.whenClosed.getMockImplementation();
  assert.ok(whenClosed);
  ports.host.whenClosed.mockImplementation(() => whenClosed().then((result) => {
    if (unknownClose) return Object.freeze({ kind: "unknown", cleanup: "unknown" });
    if (result.kind !== "stopped" || result.cleanup !== "closed") return result;
    const receipt = receive(qualificationReceipt(ports));
    return receipt ? Object.freeze({ ...result, runtimeObservation: receipt }) : result;
  }));
  return { h, runtime, ports, abort };
}

function qualificationReady(h: Harness): boolean {
  const ready = h.listener().ready;
  assert.ok(ready, "bootstrap installs its readiness predicate");
  return ready();
}

async function qualificationCapability(setup: Awaited<ReturnType<typeof qualificationCase>>) {
  const call = connection(
    setup.runtime,
    setup.h.storage.initialized.credential.key,
    "GET",
    "/v1/capabilities",
  );
  call.req.end();
  return call.result;
}

function privateQualification(value: unknown) {
  const rendered = JSON.stringify(value);
  assert.ok(typeof rendered === "string");
  for (const key of ["runtimeObservation", "userSid", "creationFileTime", "nvmlIndex", "requestFingerprint", "launchTicket", qualificationSid])
    expect(rendered.includes(key), "public facts do not contain the private observation receipt").toBe(false);
}

function incompleteQualification(value: QualificationReceipt, missing: string): QualificationReceipt | undefined {
  const observation = value.observation;
  if (missing === "artifact-only") return undefined;
  if (missing === "background") return Object.freeze({ ...value, observation: Object.freeze({ ...observation, background: null }) });
  if (missing === "engine") return Object.freeze({ ...value, observation: Object.freeze({ ...observation, engine: null }) });
  if (missing === "gpu-pending") return Object.freeze({ ...value, observation: Object.freeze({ ...observation, gpu: Object.freeze({ state: "pending" }) }) });
  if (missing === "gpu-unknown") return Object.freeze({ ...value, observation: Object.freeze({ ...observation, gpu: Object.freeze({ state: "unknown", reason: "permission" }) }) });
  assert.equal(observation.gpu.state, "observed");
  assert.ok(observation.gpu.state === "observed");
  return Object.freeze({ ...value, observation: Object.freeze({ ...observation, gpu: Object.freeze({ ...observation.gpu, devices: Object.freeze([]) }) }) });
}

function foreignQualification(value: QualificationReceipt, key: string): QualificationReceipt {
  const owner = value.descriptor;
  const target = owner.details.target as ExecutionTarget;
  let changed = owner;
  if (["jobId", "attemptNo", "ownerInstanceId", "fence"].includes(key)) {
    const identity = { ...target.identity,
      [key]: key === "attemptNo" || key === "fence"
        ? target.identity[key] + 1
        : key === "jobId" ? "same-image-other-job" : "other-boot-owner" };
    changed = { ...owner, details: { ...owner.details, target: { ...target, identity } } };
  } else if (key === "launchTicket") {
    changed = { ...owner, launchTicket: "other-launch-ticket", details: {
      ...owner.details, target: { ...target, launchTicket: "other-launch-ticket" },
    } };
  } else changed = { ...owner, details: { ...owner.details, [key]: "f".repeat(64) } };
  return Object.freeze({ ...value, descriptor: freezeWindowsControlBridgeDescriptor(changed) });
}

describe.skipIf(process.platform !== "win32")("current boot qualification and ordinary admission", () => {
  it("accepts a bounded ordinary queue while busy and runs it in order with one execution slot", async () => {
    const s = await qualificationCase();
    const { h, runtime } = s;
    await publish(h, runtime, s.ports);
    const principal = h.storage.principal();
    expect((await runtime.selfTest.query(principal)).qualification).toBe("qualified");
    const bytes = await sourceImage();
    const body = multipart(uploadParts(bytes));
    async function submit(key: string) {
      const call = connection(runtime, h.storage.initialized.credential.key, "POST", "/v1/enhancement-jobs", {
        "idempotency-key": key,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": body.length,
      });
      call.req.end(body);
      return call.result;
    }
    let ports = h.native();
    const first = await submit("queue-running-first");
    expect(first.status).toBe(202);
    assert.ok(first.body.data?.job);
    await ports.authorized;
    const jobs = [first.body.data.job];
    expect(runtime.status().runner.ownedState).toBe("busy");
    for (let index = 0; index < h.input.submissionLimits.maxWaitingJobs; index++) {
      const queued = await submit(`queue-waiting-${index}`);
      expect(queued.status).toBe(202);
      assert.ok(queued.body.data?.job);
      expect(queued.body.data.job.status).toBe("queued");
      jobs.push(queued.body.data.job);
    }
    expect(qualificationReady(h), "busy is ready for bounded queue admission").toBe(true);
    expect(h.selection(), "busy still grants no second execution slot").toBe("none");
    const replay = await submit("queue-waiting-0");
    expect(replay.status).toBe(202);
    expect(replay.body.data?.replayed).toBe(true);
    expect(replay.body.data?.job?.jobId).toBe(jobs[1]!.jobId);
    expect((await submit("queue-overflow")).body.code).toBe("queue_full");
    expect(h.claims).toHaveLength(2); // Calibration and the first ordinary job.
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index]!;
      const attempt = h.claims.at(-1)!;
      expect(attempt.identity.jobId).toBe(job.jobId);
      expect(h.storage.store.inspectMaintenance()).toMatchObject({ running: 1, slots: 1, queued: jobs.length - index - 1 });
      const next = index + 1 < jobs.length ? h.native() : undefined;
      await writeActualFile(attempt.outputPath, await nativePng(attempt));
      ports.finish("engine-exit");
      await vi.waitFor(() => expect(h.storage.store.getOwned(principal, job.jobId).status).toBe("succeeded"));
      if (next) {
        await next.authorized;
        ports = next;
      }
    }
    await vi.waitFor(() => expect(realPending(h.runner())).toBe(0));
    await vi.waitFor(() => expect(realPending(h.adapter())).toBe(0));
    expect(h.claims).toHaveLength(jobs.length + 1);
    expect(h.storage.store.inspectMaintenance()).toMatchObject({ queued: 0, running: 0, slots: 0, unreleasedReferences: 0 });
    expect(h.calls.internalSubmit).toBe(1);
  }, 25_000);

  it("wakes a persisted ordinary queue after boot qualification without another submission or manual wake", async () => {
    const s = await qualificationCase();
    const { h, runtime } = s;
    const queued = await h.seed("persisted-before-qualification");
    const calibration = await publish(h, runtime, s.ports);
    expect(h.storage.store.getOwned(h.storage.principal(), queued.job.jobId).status).toBe("queued");
    expect(h.claims.map((attempt) => attempt.identity.jobId)).toEqual([calibration.operation.jobId]);
    const ordinary = h.native();
    const verified = await runtime.selfTest.query(h.storage.principal());
    expect(verified.qualification).toBe("qualified");
    await vi.waitFor(() => expect(h.claims).toHaveLength(2));
    await ordinary.authorized;
    const attempt = h.claims[1]!;
    expect(attempt.identity.jobId).toBe(queued.job.jobId);
    expect(attempt.job.plan).toEqual(queued.job.plan);
    await writeActualFile(attempt.outputPath, await nativePng(attempt));
    ordinary.finish("engine-exit");
    await vi.waitFor(() => expect(h.storage.store.getOwned(h.storage.principal(), queued.job.jobId).status).toBe("succeeded"));
    await vi.waitFor(() => expect(realPending(h.runner())).toBe(0));
    await vi.waitFor(() => expect(realPending(h.adapter())).toBe(0));
    await runtime.selfTest.query(h.storage.principal());
    expect(h.claims).toHaveLength(2);
    expect(h.calls.internalSubmit).toBe(1);
  }, 25_000);

  it("joins the original output and receipt for ready, ordinary submit and claim, then retains the verified boot across a normal Entry replacement", async () => {
    const s = await qualificationCase();
    const { h, runtime, ports } = s;
    const first = await publish(h, runtime, ports);
    const principal = h.storage.principal();
    expect(qualificationReady(h)).toBe(false);
    expect(h.selection()).toBe("none");
    expect(h.calls.publishedRead).toBe(0);
    const verified = await runtime.selfTest.query(principal);
    expect(verified.phase).toBe("output_verified");
    expect(Reflect.get(verified, "qualification"), "the original output plus same-Entry observation qualify this boot").toBe("qualified");
    expect(verified.reason).toBeNull();
    const other = createClient(h.storage.store);
    const unauthorized = authenticate(h.storage.store, `Bearer ${other.key}`);
    await expectRejectedCode(runtime.selfTest.query(unauthorized), "authentication_failed");
    expect(qualificationReady(h)).toBe(true);
    expect(h.selection()).toBe("ordinary");
    const capability = await qualificationCapability(s);
    expect(capability.body.data?.ready).toBe(true);
    privateQualification(capability.body);
    privateQualification(verified);
    const ordinary = h.native();
    const body = multipart(uploadParts(await sourceImage()));
    const submit = connection(runtime, h.storage.initialized.credential.key, "POST", "/v1/enhancement-jobs", {
      "idempotency-key": "qualified-ordinary-entry",
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": body.length,
    });
    submit.req.end(body);
    expect((await submit.result).status).toBe(202);
    await ordinary.authorized;
    const attempt = h.claims.find((value) => value.identity.jobId !== first.operation.jobId);
    assert.ok(attempt);
    expect(Reflect.has(h.adapter().status(), "runtimeObservation")).toBe(false);
    qualificationReady(h); // A normal busy read must not revoke the cached boot.
    expect(Reflect.get(await runtime.selfTest.query(principal), "qualification")).toBe("qualified");
    await writeActualFile(attempt.outputPath, await nativePng(attempt));
    ordinary.finish("engine-exit");
    await vi.waitFor(() => expect(h.storage.store.getOwned(principal, attempt.identity.jobId).status).toBe("succeeded"));
    await vi.waitFor(() => expect(realPending(h.runner())).toBe(0));
    await vi.waitFor(() => expect(realPending(h.adapter())).toBe(0));
    expect(qualificationReady(h)).toBe(true);
    expect(h.selection()).toBe("ordinary");
    expect(Reflect.get(await runtime.selfTest.start(principal), "qualification")).toBe("qualified");
    expect(h.calls.internalSubmit).toBe(1);
    expect(h.calls.publishedRead).toBe(1);
    expect(h.observationSelections.filter((value) => value.selected).length).toBe(1);
    expect(h.observationSelections.length).toBe(2);
    expect(JSON.parse(Buffer.from(ports.request.requestUtf8Base64, "base64").toString("utf8")).runtimeObservation).toBe("boot-v1");
    expect(Object.hasOwn(JSON.parse(Buffer.from(ordinary.request.requestUtf8Base64, "base64").toString("utf8")), "runtimeObservation")).toBe(false);
  }, 25_000);

  it.each(["artifact-only", "background", "engine", "gpu-pending", "gpu-unknown", "gpu-empty"])("does not qualify with %s evidence", async (missing) => {
    const s = await qualificationCase((value) => incompleteQualification(value, missing));
    await publish(s.h, s.runtime, s.ports);
    const value = await s.runtime.selfTest.query(s.h.storage.principal());
    expect(value.phase).toBe("output_verified");
    expect(Reflect.get(value, "qualification")).toBe("unknown");
    expect(value.reason).toBe("device_observation_required");
    expect(qualificationReady(s.h)).toBe(false);
    expect(s.h.selection()).toBe("none");
    expect((await qualificationCapability(s)).body.data?.ready).toBe(false);
    if (missing === "artifact-only") {
      const body = multipart(uploadParts(await sourceImage()));
      const submit = connection(s.runtime, s.h.storage.initialized.credential.key, "POST", "/v1/enhancement-jobs", {
        "idempotency-key": "unqualified-ordinary-submit",
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": body.length,
      });
      submit.req.end(body);
      expect((await submit.result).body.code).toBe("not_ready");
      expect(s.h.claims.length).toBe(1);
    }
    privateQualification(value);
  }, 25_000);

  it.each(["jobId", "attemptNo", "ownerInstanceId", "fence", "launchTicket", "requestFingerprint", "executionPolicyFingerprint", "installationManifestSha256"])("rejects a known receipt with a different original %s", async (key) => {
    const s = await qualificationCase();
    await publish(s.h, s.runtime, s.ports);
    const foreign = foreignQualification(qualificationReceipt(s.ports), key);
    s.h.hooks.adapterStatusResult = (value) => Object.freeze({ ...value, runtimeObservation: foreign });
    const value = await s.runtime.selfTest.query(s.h.storage.principal());
    expect(value.phase).toBe("output_verified");
    expect(Reflect.get(value, "qualification")).toBe("unknown");
    expect(qualificationReady(s.h)).toBe(false);
    expect(s.h.selection()).toBe("none");
    expect(s.h.calls.publishedRead).toBe(1);
  }, 25_000);

  it("keeps a legacy null receipt and an Unknown original close unavailable", async () => {
    const s = await qualificationCase();
    await publish(s.h, s.runtime, s.ports);
    s.h.hooks.adapterStatusResult = (value) => Object.freeze({ ...value, runtimeObservation: null }) as unknown as adapterModule.WindowsExecutionStatus;
    expect(Reflect.get(await s.runtime.selfTest.query(s.h.storage.principal()), "qualification")).toBe("unknown");
    expect(qualificationReady(s.h)).toBe(false);
    s.h.hooks.adapterStatusResult = (value) => Object.freeze({ ...value, activity: "cleanup_unknown" });
    expect(qualificationReady(s.h)).toBe(false);
    s.h.hooks.adapterStatusResult = undefined;
    expect(Reflect.get(await s.runtime.selfTest.query(s.h.storage.principal()), "qualification")).toBe("unknown");
  }, 25_000);

  it("does not read or qualify the original output after an Unknown Host close", async () => {
    const s = await qualificationCase((value) => value, true);
    await s.runtime.selfTest.start(s.h.storage.principal());
    await s.ports.authorized;
    s.ports.finish("engine-exit");
    await flush();
    await flush();
    expect(Reflect.get(await s.runtime.selfTest.query(s.h.storage.principal()), "qualification")).toBe("unknown");
    expect(qualificationReady(s.h)).toBe(false);
    expect(s.h.calls.publishedRead).toBe(0);
  }, 15_000);

  it("does not retry an Unknown output read or accept its later receipt", async () => {
    const s = await qualificationCase();
    await publish(s.h, s.runtime, s.ports);
    s.h.hooks.publishedFile = async () => { throw new Error("qualification fixture output read failure"); };
    await expectRejectedCode(s.runtime.selfTest.query(s.h.storage.principal()), "internal_error");
    s.h.hooks.publishedFile = undefined;
    expect(Reflect.get(await s.runtime.selfTest.query(s.h.storage.principal()), "qualification")).toBe("unknown");
    expect(qualificationReady(s.h)).toBe(false);
    expect(s.h.calls.publishedRead).toBe(1);
  }, 25_000);

  it.each(["unknown", "cleanup_unknown", "runner-unknown", "maintenance"] as const)("permanently revokes a qualified boot after %s and rejects later facts", async (fault) => {
    const s = await qualificationCase();
    await publish(s.h, s.runtime, s.ports);
    const principal = s.h.storage.principal();
    expect(Reflect.get(await s.runtime.selfTest.query(principal), "qualification")).toBe("qualified");
    if (fault === "maintenance") {
      const sealed = maintenance(s.runtime).enter(principal);
      safeSnapshot(sealed, s.h);
    } else if (fault === "runner-unknown") {
      s.h.hooks.runnerStatusResult = (value) => Object.freeze({ ...value, ownedState: "unknown" });
    } else s.h.hooks.adapterStatusResult = (value) => Object.freeze({ ...value, activity: fault });
    expect(qualificationReady(s.h)).toBe(false);
    s.h.hooks.adapterStatusResult = undefined;
    s.h.hooks.runnerStatusResult = undefined;
    expect(Reflect.get(await s.runtime.selfTest.query(principal), "qualification")).toBe("unknown");
    expect(qualificationReady(s.h)).toBe(false);
    expect(s.h.selection()).toBe("none");
    expect(s.h.calls.internalSubmit).toBe(1);
    expect(s.h.calls.publishedRead).toBe(1);
    expect(s.h.observationSelections.filter((value) => value.selected).length).toBe(1);
  }, 25_000);

  it("does not publish qualification from an output read that returns after maintenance", async () => {
    const s = await qualificationCase();
    await publish(s.h, s.runtime, s.ports);
    const held = gate();
    s.h.hooks.afterPublished = () => held.hold();
    const principal = s.h.storage.principal();
    const reading = track(s.runtime.selfTest.query(principal));
    await reached(held.entered, reading);
    maintenance(s.runtime).enter(principal);
    held.release();
    const [result] = await Promise.allSettled([reading]);
    if (result!.status === "fulfilled") expect(Reflect.get(result!.value, "qualification")).toBe("unknown");
    else expect(result!.reason instanceof EnhancementError, "late read rejects with a sanitized worker error").toBe(true);
    expect(qualificationReady(s.h)).toBe(false);
    expect(s.h.calls.publishedRead).toBe(1);
    expect(s.h.calls.internalSubmit).toBe(1);
  }, 25_000);

  it("does not borrow a published same-image receipt from the previous boot or automatically rerun F01", async () => {
    const s = await qualificationCase();
    await publish(s.h, s.runtime, s.ports);
    const old = await s.runtime.selfTest.query(s.h.storage.principal());
    expect(Reflect.get(old, "qualification")).toBe("qualified");
    const receipt = qualificationReceipt(s.ports);
    s.runtime.close();
    await flush();
    const next = await s.h.start();
    await s.h.settledRecovery();
    s.h.hooks.adapterStatusResult = (value) => Object.freeze({ ...value, runtimeObservation: receipt });
    const current = await next.selfTest.query(s.h.storage.principal());
    expect(current.bootId).not.toBe(old.bootId);
    expect(current.phase).toBe("not_started");
    expect(Reflect.get(current, "qualification")).toBe("unknown");
    expect(qualificationReady(s.h)).toBe(false);
    expect(s.h.selection()).toBe("none");
    expect(s.h.calls.internalSubmit).toBe(1);
    expect(s.h.calls.publishedRead).toBe(1);
    expect(s.h.claims.length).toBe(1);
  }, 25_000);

  it.each(["close", "abort", "store-closed"])("revokes the cached boot when its original owner is %s", async (fault) => {
    const s = await qualificationCase();
    await publish(s.h, s.runtime, s.ports);
    expect(Reflect.get(await s.runtime.selfTest.query(s.h.storage.principal()), "qualification")).toBe("qualified");
    const principal = s.h.storage.principal();
    if (fault === "close") s.runtime.close();
    else if (fault === "abort") s.abort.abort();
    else s.h.storage.store.close();
    expect(qualificationReady(s.h)).toBe(false);
    const [result] = await Promise.allSettled([s.runtime.selfTest.query(principal)]);
    if (result!.status === "fulfilled") expect(Reflect.get(result!.value, "qualification")).toBe("unknown");
    else expect(result!.reason instanceof EnhancementError, "closed owner rejects with a sanitized worker error").toBe(true);
    expect(s.h.calls.internalSubmit).toBe(1);
  }, 25_000);
});

describe.skipIf(process.platform !== "win32")("current boot qualification after a direct status read failure", () => {
  it("permanently revokes qualification when the original runtime.status getter throws once", async () => {
    const s = await qualificationCase();
    await publish(s.h, s.runtime, s.ports);
    const principal = s.h.storage.principal();
    expect(Reflect.get(await s.runtime.selfTest.query(principal), "qualification")).toBe("qualified");
    let statusReads = 0;
    let statusFailed = false;
    s.h.hooks.runnerStatus = () => {
      statusReads++;
      if (statusReads === 1)
        throw new Error("qualification fixture direct status read failure");
    };
    try {
      s.runtime.status();
    } catch {
      statusFailed = true;
    } finally {
      s.h.hooks.runnerStatus = undefined;
    }
    expect(statusFailed, "the direct runtime.status call observes the original getter failure").toBe(true);
    expect(statusReads).toBe(1);
    expect(qualificationReady(s.h)).toBe(false);
    expect(Reflect.get(await s.runtime.selfTest.query(principal), "qualification")).toBe("unknown");
    expect(s.h.selection()).toBe("none");
    expect(s.h.calls.internalSubmit).toBe(1);
    expect(s.h.calls.publishedRead).toBe(1);
  }, 25_000);
});

describe.skipIf(process.platform !== "win32")("prepare diagnostic authenticated maintenance consumer", () => {
  it("carries the current prepare unknown through the real Adapter and GET without releasing its slot", async () => {
    const h = await harness();
    const ports = h.native();
    const diagnostic = Object.freeze({ prepareStage: "installation_open", nativeStage: "file_open", nativeErrorCode: 5 });
    // This is only the already-attributed Host result boundary; Host/wire are tested separately.
    ports.host.prepare.mockImplementationOnce(async (_request, _scope, guard) => {
      expect(guard.stillCurrent()).toBe(true);
      expect(guard.takeSendPermission()).toBe(true);
      return Object.freeze({ kind: "unknown" as const, cleanup: "unknown" as const, prepareDiagnostic: diagnostic });
    });
    const runtime = await h.start();
    await h.settledRecovery();
    const principal = h.storage.principal();
    await runtime.selfTest.start(principal);
    await vi.waitFor(() => expect(ports.host.prepare).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.runner().status().ownedState).toBe("unknown"));
    expect(h.storage.store.inspectMaintenance()).toMatchObject({ running: 1, slots: 1 });
    expect(ports.host.authorize).not.toHaveBeenCalled();
    const native = h.adapter().status();
    const projected = Reflect.get(native, "prepareDiagnostic");
    expect(projected, "the real Adapter keeps the attributed three-field diagnostic").toEqual(diagnostic);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.keys(projected as object).sort()).toEqual(["nativeErrorCode", "nativeStage", "prepareStage"]);
    const before = facts(h.storage);
    const denied = connection(runtime, "INERT_INVALID_CREDENTIAL", "GET", "/v1/maintenance");
    denied.req.end();
    expect((await denied.result).status).toBe(401);
    const call = connection(runtime, h.storage.initialized.credential.key, "GET", "/v1/maintenance");
    call.req.end();
    const response = await call.result;
    expect(response.status).toBe(200);
    const data = (response.body as unknown as { data: {
      sealed: boolean; canStop: boolean;
      runtime: { adapter: { activity: string; prepareDiagnostic?: unknown } } | null;
    } }).data;
    expect(data.sealed, "GET does not seal or enter maintenance").toBe(false);
    expect(data.canStop, "diagnostic is not cleanup or recovery authority").toBe(false);
    expect(data.runtime?.adapter.prepareDiagnostic, "authenticated GET consumes the real Adapter field").toEqual(diagnostic);
    expect(["unknown", "cleanup_unknown"]).toContain(data.runtime?.adapter.activity);
    expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
    expect(h.storage.store.inspectMaintenance()).toMatchObject({ running: 1, slots: 1 });
    for (const secret of [h.storage.directory, h.storage.initialized.credential.key, "requestId", "executionId",
      "ownerInstanceId", "launchTicket", "exceptionType", "message", "path", "tokenUserSid"]) {
      expect(response.bytes.includes(Buffer.from(secret)), "GET contains no diagnostic identity or sensitive field").toBe(false);
    }
    await capabilities(runtime, h);
    expect(ports.host.prepare).toHaveBeenCalledTimes(1);
  }, 25_000);

  it.each([
    { prepareStage: "installation_open", nativeStage: "file_open", nativeErrorCode: 5, message: "PRIVATE_MESSAGE" },
    { prepareStage: "C:\\PRIVATE_STAGE", nativeStage: "file_open", nativeErrorCode: 5 },
    { prepareStage: "installation_open", nativeStage: "file_open", nativeErrorCode: 2_147_483_648 },
  ])("fails closed on invalid Adapter diagnostic at the real GET projection %#", async (prepareDiagnostic) => {
    const h = await harness();
    const runtime = await h.start();
    await h.settledRecovery();
    h.hooks.adapterStatusResult = (value) => Object.freeze({ ...value, prepareDiagnostic: Object.freeze(prepareDiagnostic) });
    const before = facts(h.storage);
    const call = connection(runtime, h.storage.initialized.credential.key, "GET", "/v1/maintenance");
    call.req.end();
    const response = await call.result;
    expect(response.status).toBe(200);
    const data = (response.body as unknown as { data: { state: string; canStop: boolean; runtime: unknown } }).data;
    expect(data.state).toBe("unknown");
    expect(data.canStop).toBe(false);
    expect(data.runtime).toBeNull();
    expect(response.bytes.includes(Buffer.from("prepareDiagnostic"))).toBe(false);
    expect(response.bytes.includes(Buffer.from("PRIVATE"))).toBe(false);
    expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
    h.hooks.adapterStatusResult = undefined;
  }, 15_000);
});

describe.skipIf(process.platform !== "win32")("current boot qualification after rememberClaim observation failure", () => {
  it.each(["unknown", "throw"] as const)("permanently revokes after the original rememberClaim status read is %s", async (fault) => {
    const s = await qualificationCase();
    await publish(s.h, s.runtime, s.ports);
    const principal = s.h.storage.principal();
    expect(Reflect.get(await s.runtime.selfTest.query(principal), "qualification")).toBe("qualified");
    const ordinary = s.h.native();
    await s.h.seed(`ordinary-during-remember-claim-${fault}`);
    const committed = s.h.listener().onJobCommitted;
    assert.ok(committed, "bootstrap installs its original job-commit wake callback");
    void committed();
    await ordinary.authorized;
    expect(s.runtime.status().runner.ownedState).toBe("busy");
    expect(Reflect.get(await s.runtime.selfTest.query(principal), "qualification")).toBe("qualified");
    let statusReads = 0;
    let injected = false;
    s.h.hooks.runnerStatus = () => {
      statusReads++;
      if (fault === "throw" && statusReads === 1) {
        injected = true;
        throw new Error("qualification fixture rememberClaim status read failure");
      }
    };
    s.h.hooks.runnerStatusResult = (value) => {
      if (fault === "unknown" && statusReads === 1) {
        injected = true;
        return Object.freeze({ ...value, ownedState: "unknown" });
      }
      return value;
    };
    try {
      // The existing ordinary owner keeps wake in its normal busy path; the
      // original rememberClaim call makes the one hooked status observation.
      void committed();
    } catch {
      // The existing HTTP caller contains a synchronous callback failure too.
    } finally {
      s.h.hooks.runnerStatus = undefined;
      s.h.hooks.runnerStatusResult = undefined;
    }
    expect(injected, "the original rememberClaim getter receives the selected fault").toBe(true);
    expect(statusReads).toBe(1);
    expect(Reflect.get(await s.runtime.selfTest.query(principal), "qualification")).toBe("unknown");
    expect(qualificationReady(s.h)).toBe(false);
    expect(s.h.selection()).toBe("none");
    expect(s.h.calls.internalSubmit).toBe(1);
    expect(s.h.calls.publishedRead).toBe(1);
  }, 25_000);
});
