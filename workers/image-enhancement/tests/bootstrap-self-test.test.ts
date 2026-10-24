import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as artifactsModule from "../src/artifacts.js";
import type { ArtifactResult } from "../src/artifacts.js";
import { startWindowsWorker } from "../src/bootstrap.js";
import { createWorkerConfig, type SubmissionLimits } from "../src/config.js";
import {
  EnhancementError,
  INTERNAL_SELF_TEST_KEY_PREFIX,
  NORMALIZATION_PROFILE,
  PROTOCOL_VERSION,
  normalizePlan,
  type EnhancementErrorCode,
  type EnhancementPlanRequest,
} from "../src/contracts.js";
import {
  authenticate,
  createClient,
  revokeCredential,
  rotateCredential,
} from "../src/credentials.js";
import {
  freezeExecutionPolicy,
  type ClaimedAttempt,
} from "../src/execution.js";
import * as httpModule from "../src/http.js";
import * as imageModule from "../src/image-io.js";
import * as jobsModule from "../src/jobs.js";
import * as runnerModule from "../src/runner.js";
import * as storeModule from "../src/store.js";
import type { AuthenticatedClient } from "../src/store.js";
import * as adapterModule from "../src/windows-execution-adapter.js";
import { nativePng, writeActualFile } from "./artifact-fixtures.js";
import { completionExit } from "./completion-fixtures.js";
import { configInput } from "./fixtures.js";
import { deferred, transportLimits } from "./http-fixtures.js";
import { descriptor, snapshot } from "./lifecycle-fixtures.js";
import { recoveryExecutor } from "./recovery-fixtures.js";
import {
  runnerLimits,
  sha256,
  storageFixture,
  submissionLimits,
} from "./storage-fixtures.js";
import { runnerAdapterOptions } from "./windows-execution-adapter-runner-fixtures.js";

// These are local contract types: the unchanged product must still load before
// the new runtime member exists. No controller or future type is imported.
type SelfTestSnapshot = Readonly<{
  bootId: string;
  assetId: "zeb-enhancement-calibration-v1";
  phase:
    | "not_started"
    | "preparing"
    | "bound"
    | "checking_output"
    | "output_verified"
    | "blocked"
    | "failed"
    | "unknown";
  jobId: string | null;
  reason:
    | EnhancementErrorCode
    | "startup_recovering"
    | "recovery_blocked"
    | "diagnostic_conflict"
    | "device_observation_required"
    | null;
  output: ArtifactResult | null;
  qualification: "unknown";
}>;
type SelfTest = Readonly<{
  start(principal: AuthenticatedClient): Promise<SelfTestSnapshot>;
  query(principal: AuthenticatedClient): Promise<SelfTestSnapshot>;
}>;
type Storage = Awaited<ReturnType<typeof storageFixture>>;
type Runtime = Awaited<ReturnType<typeof startWindowsWorker>>;
type ServiceOptions = Parameters<typeof jobsModule.createJobService>[0];
type PublishedRead = Parameters<
  ReturnType<typeof artifactsModule.createArtifacts>["readPublished"]
>;

const assetId = "zeb-enhancement-calibration-v1";
const rawSha256 =
  "ce7faf5322ff9b665ff55896a9acab6fba4963420e88cbb6bb150ec7dc41577f";
const target = Object.freeze({
  width: 5016,
  height: 5016,
  format: "png" as const,
});
const targetPixels = target.width * target.height;
const modelId = "calibration-4x";
const applicationDirectory = fileURLToPath(new URL("..", import.meta.url));
const resourceDirectory = join(
  applicationDirectory,
  "resources",
  "calibration",
  assetId,
);
const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cleanups: (() => void | Promise<void>)[] = [];
let sourceBytesPromise: Promise<Buffer> | undefined;
let nativeOutputPromise: Promise<Buffer> | undefined;

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

function calibrationConfig() {
  const input = configInput();
  return {
    ...input,
    models: [
      input.models[0]!,
      {
        ...input.models[0]!,
        id: modelId,
        binaryVersion: "calibration-contract-binary-v1",
        binarySha256: "d".repeat(64),
        modelVersion: "calibration-contract-model-v1",
        modelSha256: "e".repeat(64),
        defaultTile: 128,
        gpuId: 1,
      },
    ],
    budgets: {
      ...input.budgets,
      // An explicit test administrator budget, approved by Root. The shared
      // fixture and the product's insufficient-budget rejection stay intact.
      delivery: { ...input.budgets.delivery, maxPixels: targetPixels },
    },
  };
}

function configuration(storeDirectory: string, operatorClientId: string) {
  const limits: SubmissionLimits = submissionLimits;
  return {
    storeDirectory,
    port: 0,
    operatorClientId,
    selfTestModelId: modelId,
    workerConfig: calibrationConfig(),
    submissionLimits: { ...limits },
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

function fixedRequest(tile = 128): EnhancementPlanRequest {
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    scope: "full_image",
    sourceSha256: rawSha256,
    target,
    modelId,
    normalizationProfile: NORMALIZATION_PROFILE,
    tile,
  });
}

async function fixedSource() {
  sourceBytesPromise ??= readFile(join(resourceDirectory, "calibration.png"));
  await expect(
    sourceBytesPromise,
    "fixture prerequisite: the imported fixed PNG exists; a missing fixture is not controller RED",
  ).resolves.toBeInstanceOf(Buffer);
  const bytes = await sourceBytesPromise;
  expect(bytes.length, "fixture prerequisite: original PNG byte length").toBe(
    87_100,
  );
  expect(sha256(bytes), "fixture prerequisite: original PNG SHA256").toBe(
    rawSha256,
  );
  return bytes;
}

async function fixedNativeOutput(attempt: ClaimedAttempt) {
  expect(attempt.job.engineInput.width * 4).toBe(5016);
  expect(attempt.job.engineInput.height * 4).toBe(5016);
  // Only this helper creates a large PNG, once for the whole file. It is a
  // controlled Adapter output and carries no inference or GPU qualification.
  nativeOutputPromise ??= nativePng(attempt);
  return nativeOutputPromise;
}

function controller(runtime: object): SelfTest {
  const value: unknown = Reflect.get(runtime, "selfTest");
  expect(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "runtime exposes the real selfTest object",
  ).toBe(true);
  assert.ok(value !== null && typeof value === "object");
  expect(Object.isFrozen(value)).toBe(true);
  expect(
    isDeepStrictEqual(Reflect.ownKeys(value).sort(), ["query", "start"]),
    "selfTest has only the two local operations",
  ).toBe(true);
  expect(typeof Reflect.get(value, "start"), "real selfTest.start").toBe(
    "function",
  );
  expect(typeof Reflect.get(value, "query"), "real selfTest.query").toBe(
    "function",
  );
  return value as SelfTest;
}

function expectSnapshot(value: SelfTestSnapshot, storage: Storage) {
  expect(value !== null && typeof value === "object").toBe(true);
  expect(Object.isFrozen(value)).toBe(true);
  expect(
    isDeepStrictEqual(Object.keys(value).sort(), [
      "assetId",
      "bootId",
      "jobId",
      "output",
      "phase",
      "qualification",
      "reason",
    ]),
    "exact safe operation snapshot",
  ).toBe(true);
  expect(uuidV4.test(value.bootId), "one UUID v4 identifies this boot").toBe(
    true,
  );
  expect(value.assetId).toBe(assetId);
  expect(value.qualification).toBe("unknown");
  if (value.output) {
    expect(Object.isFrozen(value.output)).toBe(true);
    expect(
      isDeepStrictEqual(Object.keys(value.output).sort(), [
        "byteLength",
        "format",
        "height",
        "sha256",
        "width",
      ]),
      "output is metadata only",
    ).toBe(true);
  }
  const serialized = JSON.stringify(value);
  for (const privateValue of [
    storage.directory,
    storage.initialized.credential.key,
    INTERNAL_SELF_TEST_KEY_PREFIX,
    "launchTicket",
    "ownerInstanceId",
    "credentialId",
    "operatorClientId",
    "selfTestModelId",
    "bytes",
  ])
    expect(
      serialized.includes(JSON.stringify(privateValue).slice(1, -1)),
      "snapshot contains no private value",
    ).toBe(false);
}

function facts(storage: Storage) {
  return snapshot(storage, (db) => ({
    jobs: db
      .prepare(
        "SELECT job_id, idempotency_key, status, created_at, queue_deadline_at, source_json, plan_json, execution_policy_json FROM jobs ORDER BY queue_sequence",
      )
      .all() as {
      job_id: string;
      idempotency_key: string;
      status: string;
      created_at: number;
      queue_deadline_at: number;
      source_json: string;
      plan_json: string;
      execution_policy_json: string;
    }[],
    attempts: db
      .prepare("SELECT * FROM attempts ORDER BY job_id, attempt_no")
      .all(),
    slots: db.prepare("SELECT * FROM execution_slot").all(),
    references: db
      .prepare(
        "SELECT reference_id, job_id, released_at FROM artifact_references ORDER BY rowid",
      )
      .all() as {
      reference_id: string;
      job_id: string;
      released_at: number | null;
    }[],
    candidates: db
      .prepare("SELECT directory FROM artifact_candidates ORDER BY rowid")
      .all() as { directory: string }[],
  }));
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function tracked<T>(promise: Promise<T>) {
  void promise.catch(() => {});
  return promise;
}

async function rejected(
  promise: Promise<unknown>,
  codes?: readonly EnhancementErrorCode[],
) {
  const [outcome] = await Promise.allSettled([promise]);
  expect(outcome!.status, "explicit sanitized operation rejection").toBe(
    "rejected",
  );
  if (outcome!.status !== "rejected") return;
  expect(outcome!.reason instanceof EnhancementError).toBe(true);
  const error = outcome!.reason as EnhancementError;
  if (codes)
    expect(codes.includes(error.code), "allowed safe error code").toBe(true);
}

function expectNoVerified(
  outcome: PromiseSettledResult<SelfTestSnapshot>,
  storage: Storage,
) {
  if (outcome.status === "rejected") {
    expect(outcome.reason instanceof EnhancementError).toBe(true);
    return;
  }
  expectSnapshot(outcome.value, storage);
  expect(outcome.value.phase === "output_verified").toBe(false);
  expect(outcome.value.output).toBeNull();
}

async function harness() {
  const storage = await storageFixture();
  storage.setNow(Date.now());
  const input = configuration(
    storage.directory,
    storage.initialized.credential.clientId,
  );
  storage.setConfig(createWorkerConfig(input.workerConfig));
  const executor = recoveryExecutor();
  const releases: (() => void)[] = [];
  const runtimes: Runtime[] = [];
  const recoveries: Promise<void>[] = [];
  const services: ServiceOptions[] = [];
  const submissions: { internalKey: string | undefined }[] = [];
  const inspections: Parameters<
    storeModule.EnhancementStore["inspectQueuedSelfTest"]
  >[] = [];
  const claims: Parameters<storeModule.EnhancementStore["claimNext"]>[] = [];
  const preparations: {
    bytes: Buffer;
    plan: Parameters<typeof imageModule.prepareEngineInput>[1];
    prepared?: Awaited<ReturnType<typeof imageModule.prepareEngineInput>>;
  }[] = [];
  const publishedReads: {
    store: storeModule.EnhancementStore;
    args: PublishedRead;
  }[] = [];
  const artifactStores: storeModule.EnhancementStore[] = [];
  const listeners: Parameters<typeof httpModule.listenEnhancementServer>[0][] =
    [];
  const selections: NonNullable<
    runnerModule.RunnerOptions["claimSelection"]
  >[] = [];
  const runners: ReturnType<typeof runnerModule.createRunner>[] = [];
  const hooks: {
    prepare?: (
      bytes: Buffer,
      plan: Parameters<typeof imageModule.prepareEngineInput>[1],
    ) => Promise<void> | void;
    inputWrite?: (path: string) => Promise<void>;
    publishedFile?: (stage: "read" | "close", path: string) => Promise<void>;
    releaseReference?: () => void;
    recoveryGate?: Promise<void>;
  } = {};
  let recoverCalls = 0;
  let wakeCalls = 0;
  let inputWrites = 0;
  let publishedFileReads = 0;

  cleanups.push(() => {
    for (const runtime of runtimes) runtime.close();
    for (const release of releases) release();
    storage.store.close();
    // Keep the test-owned Store and altered resource directories as evidence,
    // matching the existing bootstrap suites.
  });

  vi.spyOn(adapterModule, "createWindowsExecutionAdapter").mockImplementation(
    () => {
      let sealed = false;
      const adapter: adapterModule.WindowsExecutionAdapter = {
        ...executor.adapter,
        kind: "windows",
        pendingWork() {
          throw new Error("legacy fixture cannot observe pending work");
        },
        status: () =>
          Object.freeze({
            sealed,
            activity: executor.activeCount() === 0 ? "idle" : "busy",
            close: sealed ? "closed" : "not_requested",
          }),
        close: async () => {
          sealed = true;
          return "closed";
        },
        interrupt: () => adapter.close(),
      };
      return adapter;
    },
  );

  const open = storeModule.openStore;
  vi.spyOn(storeModule, "openStore").mockImplementation((options) => {
    const opened = open(options);
    storage.setStore(opened);
    const inspect = opened.inspectQueuedSelfTest.bind(opened);
    vi.spyOn(opened, "inspectQueuedSelfTest").mockImplementation((...args) => {
      inspections.push(args);
      return inspect(...args);
    });
    const claim = opened.claimNext.bind(opened);
    vi.spyOn(opened, "claimNext").mockImplementation((...args) => {
      claims.push(args);
      return claim(...args);
    });
    const release = opened.releaseArtifactReference.bind(opened);
    vi.spyOn(opened, "releaseArtifactReference").mockImplementation(
      (...args) => {
        hooks.releaseReference?.();
        return release(...args);
      },
    );
    return opened;
  });

  const prepare = imageModule.prepareEngineInput;
  vi.spyOn(imageModule, "prepareEngineInput").mockImplementation(
    async (bytes, plan) => {
      const call: (typeof preparations)[number] = {
        bytes: Buffer.from(bytes),
        plan,
      };
      preparations.push(call);
      await hooks.prepare?.(bytes, plan);
      call.prepared = await prepare(bytes, plan);
      return call.prepared;
    },
  );

  const createService = jobsModule.createJobService;
  vi.spyOn(jobsModule, "createJobService").mockImplementation((options) => {
    services.push(options);
    const originalFiles = options.files ?? jobsModule.localInputFiles;
    const actual = createService({
      ...options,
      files: {
        ...originalFiles,
        async write(path, bytes) {
          await originalFiles.write(path, bytes);
          inputWrites++;
          await hooks.inputWrite?.(path);
        },
      },
    });
    return Object.freeze({
      ...actual,
      submit(...args: Parameters<typeof actual.submit>) {
        submissions.push({ internalKey: options.internalIdempotencyKey });
        return actual.submit(...args);
      },
    });
  });

  const createArtifacts = artifactsModule.createArtifacts;
  vi.spyOn(artifactsModule, "createArtifacts").mockImplementation((options) => {
    artifactStores.push(options.store);
    let reading = 0;
    const originalFiles = options.files ?? artifactsModule.localArtifactFiles;
    const actual = createArtifacts({
      ...options,
      files: {
        ...originalFiles,
        async open(path, flags, mode) {
          const file = await originalFiles.open(path, flags, mode);
          return {
            stat: () => file.stat(),
            async read(buffer, offset, length, position) {
              if (reading > 0 && basename(path) === "artifact.png") {
                publishedFileReads++;
                await hooks.publishedFile?.("read", path);
              }
              return file.read(buffer, offset, length, position);
            },
            write: (buffer, offset, length, position) =>
              file.write(buffer, offset, length, position),
            sync: () => file.sync(),
            async close() {
              if (reading > 0 && basename(path) === "artifact.png")
                await hooks.publishedFile?.("close", path);
              return file.close();
            },
          };
        },
      },
    });
    return Object.freeze({
      ...actual,
      async readPublished(...args: PublishedRead) {
        publishedReads.push({ store: options.store, args });
        reading++;
        try {
          return await actual.readPublished(...args);
        } finally {
          reading--;
        }
      },
    });
  });

  const createRunner = runnerModule.createRunner;
  vi.spyOn(runnerModule, "createRunner").mockImplementation((options) => {
    assert.ok(options.claimSelection, "production supplies a selection gate");
    selections.push(options.claimSelection);
    const actual = createRunner(options);
    const runner = Object.freeze({
      ...actual,
      recover() {
        recoverCalls++;
        const pending = hooks.recoveryGate
          ? hooks.recoveryGate.then(() => actual.recover())
          : actual.recover();
        recoveries.push(pending);
        return pending;
      },
      wake() {
        wakeCalls++;
        return actual.wake();
      },
    });
    runners.push(runner);
    return runner;
  });

  const listen = httpModule.listenEnhancementServer;
  vi.spyOn(httpModule, "listenEnhancementServer").mockImplementation(
    (...args) => {
      listeners.push(args[0]);
      return listen(...args);
    },
  );

  return {
    storage,
    input,
    hooks,
    executor,
    services,
    submissions,
    inspections,
    claims,
    preparations,
    publishedReads,
    artifactStores,
    releaseOnCleanup(release: () => void) {
      releases.push(release);
    },
    recoverCalls: () => recoverCalls,
    wakeCalls: () => wakeCalls,
    inputWrites: () => inputWrites,
    publishedFileReads: () => publishedFileReads,
    selection: () => selections.at(-1)!(),
    runner: () => runners.at(-1)!,
    listener: () => listeners.at(-1)!,
    async recovered() {
      await recoveries.at(-1);
      await flush();
    },
    start(appDirectory = applicationDirectory) {
      storage.store.close();
      const pending = startWindowsWorker(input, {
        appDirectory,
        signal: new AbortController().signal,
      });
      void pending.then(
        (runtime) => runtimes.push(runtime),
        () => {},
      );
      return pending;
    },
    async seed(key: string, tile = 128) {
      const fixed = createWorkerConfig(input.workerConfig);
      const service = jobsModule.createJobService({
        store: storage.store,
        config: () => fixed,
        ready: () => true,
        limits: {
          ...submissionLimits,
          maxWaitingJobs: key.startsWith(INTERNAL_SELF_TEST_KEY_PREFIX)
            ? submissionLimits.maxWaitingJobs + 1
            : submissionLimits.maxWaitingJobs,
        },
        runnerLimits,
        ...(key.startsWith(INTERNAL_SELF_TEST_KEY_PREFIX)
          ? { internalIdempotencyKey: key }
          : {}),
      });
      return service.submit(storage.principal(), {
        idempotencyKey: key,
        sourceBytes: await fixedSource(),
        plan: fixedRequest(tile),
      });
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function publish(h: Harness, self: SelfTest) {
  const operation = await self.start(h.storage.principal());
  expectSnapshot(operation, h.storage);
  expect(operation.phase).toBe("bound");
  assert.ok(operation.jobId, "the accepted diagnostic is bound before wake");
  await vi.waitFor(() => expect(h.executor.launchCalls.length).toBe(1));
  const attempt = h.executor.launchCalls[0]!;
  expect(attempt.identity.jobId === operation.jobId).toBe(true);
  const png = await fixedNativeOutput(attempt);
  await writeActualFile(attempt.outputPath, png);
  h.executor.emit(
    completionExit(attempt, { kind: "success", exitCode: 0, signal: null }),
  );
  await vi.waitFor(() =>
    expect(
      h.storage.store.getOwned(h.storage.principal(), operation.jobId!).status,
    ).toBe("succeeded"),
  );
  await vi.waitFor(() =>
    expect(
      facts(h.storage).references.filter((ref) => ref.released_at === null)
        .length,
    ).toBe(0),
  );
  expect(h.publishedReads.length).toBe(0);
  return { operation, attempt, png };
}

describe("fixed self-test protected bootstrap configuration", () => {
  it("accepts the two required fields before the explicit abort gate, without opening components", async () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const open = vi.spyOn(storeModule, "openStore");
    const adapter = vi.spyOn(adapterModule, "createWindowsExecutionAdapter");
    const listen = vi.spyOn(httpModule, "listenEnhancementServer");
    const abort = new AbortController();
    abort.abort();
    const pending = startWindowsWorker(
      configuration("Z:\\contract-only\\store", randomUUID()),
      { appDirectory: "Z:\\contract-only\\payload\\app", signal: abort.signal },
    );
    // The old exact schema returns configuration_invalid here. Observe that
    // missing behavior in this assertion, never as a beforeEach/startup error.
    await expect(pending).rejects.toMatchObject({ code: "not_ready" });
    expect(open.mock.calls.length).toBe(0);
    expect(adapter.mock.calls.length).toBe(0);
    expect(listen.mock.calls.length).toBe(0);
  });

  it("requires an operator and an existing model, preserving the exact configuration boundary", async () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const open = vi.spyOn(storeModule, "openStore");
    const adapter = vi.spyOn(adapterModule, "createWindowsExecutionAdapter");
    const listen = vi.spyOn(httpModule, "listenEnhancementServer");
    const valid = configuration("Z:\\contract-only\\store", randomUUID());
    const legacy: Record<string, unknown> = { ...valid };
    delete legacy.operatorClientId;
    delete legacy.selfTestModelId;
    const noOperator: Record<string, unknown> = { ...valid };
    delete noOperator.operatorClientId;
    const noModel: Record<string, unknown> = { ...valid };
    delete noModel.selfTestModelId;
    const abort = new AbortController();
    abort.abort();
    for (const value of [
      legacy,
      noOperator,
      noModel,
      { ...valid, operatorClientId: "" },
      { ...valid, selfTestModelId: "missing-model" },
      { ...valid, ready: true },
    ])
      await expect(
        startWindowsWorker(value, {
          appDirectory: "Z:\\contract-only\\payload\\app",
          signal: abort.signal,
        }),
      ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(open.mock.calls.length).toBe(0);
    expect(adapter.mock.calls.length).toBe(0);
    expect(listen.mock.calls.length).toBe(0);
  });
});

describe("fixed self-test canonical operator UUID", () => {
  it("rejects an operator UUID with a trailing LF before the abort gate or component allocation", async () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const open = vi.spyOn(storeModule, "openStore");
    const adapter = vi.spyOn(adapterModule, "createWindowsExecutionAdapter");
    const listen = vi.spyOn(httpModule, "listenEnhancementServer");
    const abort = new AbortController();
    abort.abort();
    await expect(
      startWindowsWorker(
        configuration("Z:\\contract-only\\store", randomUUID() + "\n"),
        {
          appDirectory: "Z:\\contract-only\\payload\\app",
          signal: abort.signal,
        },
      ),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(open.mock.calls.length).toBe(0);
    expect(adapter.mock.calls.length).toBe(0);
    expect(listen.mock.calls.length).toBe(0);
  });
});

describe.skipIf(process.platform !== "win32")(
  "bootstrap fixed local self-test owner using the real Store and artifacts",
  () => {
    it("queries not_started without starting work and authenticates each current operator principal", async () => {
      const h = await harness();
      const foreign = await storageFixture();
      cleanups.push(() => foreign.store.close());
      const starting = h.start();
      await expect(
        starting,
        "new protected configuration is accepted",
      ).resolves.toBeDefined();
      const runtime = await starting;
      const self = controller(runtime);
      await h.recovered();
      const operator = h.storage.principal();
      const before = facts(h.storage);
      const wakes = h.wakeCalls();
      const initial = await self.query(operator);
      expectSnapshot(initial, h.storage);
      expect(initial).toMatchObject({
        phase: "not_started",
        jobId: null,
        output: null,
        reason: null,
      });
      expect(
        isDeepStrictEqual(Object.keys(runtime.status()).sort(), [
          "adapter",
          "closing",
          "runner",
          "startupRecovery",
        ]),
        "the original status projection remains exact",
      ).toBe(true);
      const wrongCredential = createClient(h.storage.store);
      const wrongOperator = authenticate(
        h.storage.store,
        `Bearer ${wrongCredential.key}`,
      );
      const counterfeit = Object.freeze({ ...operator });
      for (const principal of [
        wrongOperator,
        counterfeit,
        foreign.principal(),
      ]) {
        await rejected(self.start(principal), ["authentication_failed"]);
        await rejected(self.query(principal), ["authentication_failed"]);
      }
      const rotated = rotateCredential(
        h.storage.store,
        {
          clientId: operator.clientId,
        },
        operator,
      );
      revokeCredential(h.storage.store, operator.credentialId, operator);
      const current = authenticate(h.storage.store, `Bearer ${rotated.key}`);
      await rejected(self.query(operator), ["authentication_failed"]);
      await rejected(self.start(operator), ["authentication_failed"]);
      const later = await self.query(current);
      expectSnapshot(later, h.storage);
      expect(later.bootId === initial.bootId).toBe(true);
      expect(later.phase).toBe("not_started");
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
      expect(h.preparations.length).toBe(0);
      expect(h.inspections.length).toBe(0);
      expect(h.submissions.length).toBe(0);
      expect(h.publishedReads.length).toBe(0);
      expect(h.wakeCalls()).toBe(wakes);
      expect(h.recoverCalls()).toBe(1);
      expect(h.listener().ready?.()).toBe(false);
    }, 15_000);

    it("publishes one admission before preparation reentry, reserves only N+1 and claims only its bound job", async () => {
      const h = await harness();
      await h.seed("older-ordinary-1");
      await h.seed("older-ordinary-2");
      const frozenConfig = createWorkerConfig(h.input.workerConfig);
      const starting = h.start();
      await expect(
        starting,
        "new protected configuration is accepted",
      ).resolves.toBeDefined();
      const self = controller(await starting);
      await h.recovered();
      const principal = h.storage.principal();
      const baseSubmits = h.submissions.length;
      const basePrepares = h.preparations.length;
      const baseServices = h.services.length;
      const preparing = deferred();
      const prepareRelease = deferred();
      const authEntered = deferred();
      const authRelease = deferred();
      h.releaseOnCleanup(() => prepareRelease.resolve());
      h.releaseOnCleanup(() => authRelease.resolve());
      let reentrant: Promise<SelfTestSnapshot> | undefined;
      let first = true;
      h.hooks.prepare = () => {
        if (!first) return;
        first = false;
        reentrant = tracked(self.start(principal));
        preparing.resolve();
        return prepareRelease.promise;
      };
      h.executor.hooks.authorize = async () => {
        authEntered.resolve();
        await authRelease.promise;
      };
      // Mutating the administrator input after boot cannot choose a new tile,
      // model, device or budget for the already frozen operation.
      h.input.workerConfig.models[1]!.defaultTile = 256;
      h.input.workerConfig.models[1]!.gpuId = 8;
      const firstStart = tracked(self.start(principal));
      const concurrent = tracked(self.start(principal));
      await preparing.promise;
      expect(h.preparations.length).toBe(basePrepares + 1);
      expect(h.inspections.length).toBe(0);
      expect(h.selection()).toBe("none");
      const rotated = rotateCredential(
        h.storage.store,
        {
          clientId: principal.clientId,
        },
        principal,
      );
      const current = authenticate(h.storage.store, `Bearer ${rotated.key}`);
      const rotatedJoin = tracked(self.start(current));
      await h.runner().wake();
      expect(h.claims.length).toBe(0);
      expect(h.executor.prepareCalls.length).toBe(0);
      let returned = false;
      void firstStart.then(
        () => {
          returned = true;
        },
        () => {},
      );
      prepareRelease.resolve();
      await authEntered.promise;
      await flush();
      expect(
        returned,
        "start returns its binding without waiting for Adapter AUTH",
      ).toBe(true);
      assert.ok(
        reentrant,
        "the real prepare entry synchronously reentered start",
      );
      const operations = await Promise.all([
        firstStart,
        concurrent,
        reentrant,
        rotatedJoin,
      ]);
      const operation = operations[0]!;
      for (const result of operations) {
        expectSnapshot(result, h.storage);
        expect(result.phase).toBe("bound");
        expect(result.jobId === operation.jobId).toBe(true);
        expect(result.bootId === operation.bootId).toBe(true);
      }
      assert.ok(operation.jobId);
      expect(h.inspections.length).toBe(1);
      expect(h.submissions.length).toBe(baseSubmits + 1);
      expect(h.preparations.length).toBe(basePrepares + 2);
      const privateOptions = h.services
        .slice(baseServices)
        .filter((options) => options.internalIdempotencyKey !== undefined);
      expect(privateOptions.length).toBe(1);
      expect(
        privateOptions[0]!.internalIdempotencyKey ===
          INTERNAL_SELF_TEST_KEY_PREFIX + operation.bootId,
      ).toBe(true);
      expect(privateOptions[0]!.limits.maxWaitingJobs).toBe(
        submissionLimits.maxWaitingJobs + 1,
      );
      expect(h.listener().submissionLimits.maxWaitingJobs).toBe(
        submissionLimits.maxWaitingJobs,
      );
      expect(h.listener().ready?.()).toBe(false);
      const prepared = h.preparations[basePrepares]!.prepared;
      assert.ok(
        prepared,
        "expected source came from the real complete preparation",
      );
      const { bytes: _bytes, ...source } = prepared.source;
      const expectedPlan = normalizePlan(fixedRequest(), frozenConfig);
      const expectedPolicy = freezeExecutionPolicy(
        runnerLimits,
        frozenConfig.models[1]!.allowedTiles,
      );
      expect(
        isDeepStrictEqual(h.inspections[0]![1], {
          request: fixedRequest(),
          plan: expectedPlan,
          executionPolicy: expectedPolicy,
          source,
        }),
        "B1 receives the complete real source and the selected frozen policy",
      ).toBe(true);
      expect(
        isDeepStrictEqual(prepared.predictedAiSize, {
          width: 5016,
          height: 5016,
          pixels: targetPixels,
        }),
      ).toBe(true);
      expect(source.encodedWidth).toBe(1254);
      expect(source.encodedHeight).toBe(1254);
      expect(Object.hasOwn(source, "orientation")).toBe(true);
      expect(sha256(h.preparations[basePrepares]!.bytes)).toBe(rawSha256);
      expect(expectedPlan.engine.modelId).toBe(modelId);
      expect(expectedPlan.engine.tile).toBe(128);
      expect(expectedPlan.engine.gpuId).toBe(1);
      expect(facts(h.storage).jobs.length).toBe(3);
      expect(h.executor.prepareCalls.length).toBe(1);
      expect(h.executor.authorizeCalls.length).toBe(1);
      expect(h.claims.every((call) => call[1] === operation.jobId)).toBe(true);
      expect(h.selection()).toBe("none");
      authRelease.resolve();
      await vi.waitFor(() => expect(h.executor.launchCalls.length).toBe(1));
      const retry = await self.start(current);
      expect(retry.jobId === operation.jobId).toBe(true);
      expect(h.submissions.length).toBe(baseSubmits + 1);
      expect(h.inspections.length).toBe(1);
      expect(h.recoverCalls()).toBe(1);
    }, 20_000);

    it("reuses one matching queued diagnostic across boots and never claims older ordinary jobs after failure", async () => {
      const h = await harness();
      await h.seed("older-ordinary-1");
      await h.seed("older-ordinary-2");
      const oldKey = INTERNAL_SELF_TEST_KEY_PREFIX + randomUUID();
      const accepted = await h.seed(oldKey);
      const persisted = facts(h.storage).jobs.find(
        (job) => job.job_id === accepted.job.jobId,
      )!;
      const submits = h.submissions.length;
      const writes = h.inputWrites();
      const starting = h.start();
      await expect(
        starting,
        "new protected configuration is accepted",
      ).resolves.toBeDefined();
      const self = controller(await starting);
      await h.recovered();
      const operation = await self.start(h.storage.principal());
      expectSnapshot(operation, h.storage);
      expect(operation.phase).toBe("bound");
      expect(operation.jobId === accepted.job.jobId).toBe(true);
      expect(
        operation.bootId === oldKey.slice(INTERNAL_SELF_TEST_KEY_PREFIX.length),
      ).toBe(false);
      expect(h.submissions.length).toBe(submits);
      expect(h.inputWrites()).toBe(writes);
      const after = facts(h.storage).jobs.find(
        (job) => job.job_id === accepted.job.jobId,
      )!;
      expect(after.idempotency_key === persisted.idempotency_key).toBe(true);
      expect(after.created_at).toBe(persisted.created_at);
      expect(after.queue_deadline_at).toBe(persisted.queue_deadline_at);
      expect(after.source_json === persisted.source_json).toBe(true);
      expect(after.plan_json === persisted.plan_json).toBe(true);
      expect(
        after.execution_policy_json === persisted.execution_policy_json,
      ).toBe(true);
      await vi.waitFor(() => expect(h.executor.launchCalls.length).toBe(1));
      h.executor.emit(
        completionExit(h.executor.launchCalls[0]!, {
          kind: "failure",
          exitCode: 7,
          signal: null,
        }),
      );
      await vi.waitFor(() =>
        expect(
          h.storage.store.getOwned(h.storage.principal(), accepted.job.jobId)
            .status,
        ).toBe("failed"),
      );
      const failed = await self.query(h.storage.principal());
      expectSnapshot(failed, h.storage);
      expect(failed.phase).toBe("failed");
      expect(failed.output).toBeNull();
      const retry = await self.start(h.storage.principal());
      expect(retry.jobId === accepted.job.jobId).toBe(true);
      await h.runner().wake();
      expect(h.selection()).toBe("none");
      expect(h.claims.every((call) => call[1] === accepted.job.jobId)).toBe(
        true,
      );
      expect(
        facts(h.storage).jobs.filter((job) => job.status === "queued").length,
      ).toBe(2);
      expect(h.submissions.length).toBe(submits);
      expect(h.executor.authorizeCalls.length).toBe(1);
      expect(h.inspections.length).toBe(1);
      expect(h.publishedReads.length).toBe(0);
      expect(h.listener().ready?.()).toBe(false);
    }, 20_000);

    it.each(["mismatch", "multiple", "expired"] as const)(
      "keeps a %s queued diagnostic blocked without using its hint as claim authority",
      async (mode) => {
        let now = Date.now();
        if (mode === "expired")
          vi.spyOn(Date, "now").mockImplementation(() => now);
        const h = await harness();
        const first = await h.seed(
          INTERNAL_SELF_TEST_KEY_PREFIX + randomUUID(),
          mode === "mismatch" ? 256 : 128,
        );
        if (mode === "multiple")
          await h.seed(INTERNAL_SELF_TEST_KEY_PREFIX + randomUUID());
        h.storage.setNow(Date.now());
        const before = facts(h.storage);
        const submissions = h.submissions.length;
        const writes = h.inputWrites();
        const starting = h.start();
        await expect(
          starting,
          "new protected configuration is accepted",
        ).resolves.toBeDefined();
        const self = controller(await starting);
        await h.recovered();
        // Startup recovery legitimately expires queued rows. Advance only
        // after it has settled so B1 inspects an expired, still queued row.
        if (mode === "expired") now += submissionLimits.queueTimeoutMs + 1;
        const blocked = await self.start(h.storage.principal());
        expectSnapshot(blocked, h.storage);
        expect(blocked).toMatchObject({
          phase: "blocked",
          reason: "diagnostic_conflict",
          output: null,
        });
        expect(blocked.jobId === first.job.jobId).toBe(true);
        expect(h.selection()).toBe("none");
        await h.runner().wake();
        const again = await self.start(h.storage.principal());
        expect(again.jobId === blocked.jobId).toBe(true);
        expect(again.bootId === blocked.bootId).toBe(true);
        expect(h.inspections.length).toBe(2);
        expect(h.claims.length).toBe(0);
        expect(h.executor.prepareCalls.length).toBe(0);
        expect(h.submissions.length).toBe(submissions);
        expect(h.inputWrites()).toBe(writes);
        expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
        if (mode === "mismatch") {
          h.storage.service().cancel(h.storage.principal(), first.job.jobId);
          const allowed = await self.start(h.storage.principal());
          expect(allowed.phase).toBe("bound");
          expect(allowed.bootId === blocked.bootId).toBe(true);
          expect(allowed.jobId === blocked.jobId).toBe(false);
          expect(h.submissions.length).toBe(submissions + 1);
          expect(h.claims.every((call) => call[1] === allowed.jobId)).toBe(
            true,
          );
        }
      },
      20_000,
    );

    it("blocks a current-boot key already used by a terminal row instead of borrowing its identity", async () => {
      const h = await harness();
      const starting = h.start();
      await expect(
        starting,
        "new protected configuration is accepted",
      ).resolves.toBeDefined();
      const self = controller(await starting);
      await h.recovered();
      const initial = await self.query(h.storage.principal());
      const key = INTERNAL_SELF_TEST_KEY_PREFIX + initial.bootId;
      const existing = await h.seed(key);
      h.storage.service().cancel(h.storage.principal(), existing.job.jobId);
      const before = facts(h.storage);
      const submissions = h.submissions.length;
      const operation = await self.start(h.storage.principal());
      expectSnapshot(operation, h.storage);
      expect(operation.phase).toBe("blocked");
      expect(operation.reason).toBe("diagnostic_conflict");
      expect(operation.output).toBeNull();
      expect(h.inspections.length).toBe(1);
      expect(h.selection()).toBe("none");
      expect(h.submissions.length).toBe(submissions);
      expect(h.claims.length).toBe(0);
      expect(h.executor.authorizeCalls.length).toBe(0);
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
    }, 15_000);

    it.each(["waiting_overflow", "key_too_short"] as const)(
      "rejects %s before preparing fixed material or allocating a private queue slot",
      async (mode) => {
        const h = await harness();
        if (mode === "waiting_overflow")
          h.input.submissionLimits.maxWaitingJobs = Number.MAX_SAFE_INTEGER;
        else
          h.input.submissionLimits.maxIdempotencyKeyLength =
            INTERNAL_SELF_TEST_KEY_PREFIX.length + 36 - 1;
        const starting = h.start();
        const [boot] = await Promise.allSettled([starting]);
        // Rejecting an impossible private limit at configuration time is also
        // safe. This negative case does not establish the positive schema gate.
        if (boot!.status === "rejected") {
          expect(boot!.reason instanceof EnhancementError).toBe(true);
          expect((boot!.reason as EnhancementError).code).toBe(
            "configuration_invalid",
          );
        } else {
          const self = controller(boot!.value);
          await h.recovered();
          await rejected(self.start(h.storage.principal()), [
            "configuration_invalid",
          ]);
          expect(h.selection()).toBe("none");
        }
        expect(h.preparations.length).toBe(0);
        expect(h.inspections.length).toBe(0);
        expect(h.submissions.length).toBe(0);
        expect(facts(h.storage).jobs.length).toBe(0);
        expect(h.executor.authorizeCalls.length).toBe(0);
      },
      15_000,
    );

    it("rejects pending startup without extra recovery or preparation and permits a later explicit start", async () => {
      const h = await harness();
      const recovery = deferred();
      h.releaseOnCleanup(() => recovery.resolve());
      h.hooks.recoveryGate = recovery.promise;
      const starting = h.start();
      await expect(
        starting,
        "new protected configuration is accepted",
      ).resolves.toBeDefined();
      const runtime = await starting;
      const self = controller(runtime);
      expect(runtime.status().startupRecovery).toBe("pending");
      await rejected(self.start(h.storage.principal()), ["not_ready"]);
      expect((await self.query(h.storage.principal())).phase).toBe(
        "not_started",
      );
      expect(h.preparations.length).toBe(0);
      expect(h.inspections.length).toBe(0);
      expect(h.submissions.length).toBe(0);
      expect(h.recoverCalls()).toBe(1);
      expect(h.selection()).toBe("none");
      recovery.resolve();
      await h.recovered();
      const operation = await self.start(h.storage.principal());
      expect(operation.phase).toBe("bound");
      expect(h.recoverCalls()).toBe(1);
    }, 15_000);

    it("preserves a real old authorized Unknown slot and never uses recovery settlement as permission", async () => {
      const h = await harness();
      const old = await h.seed("old-owned-ordinary");
      const attempt = h.storage.store.claimNext("selftest-previous-owner");
      assert.ok(attempt);
      const owner = descriptor(attempt);
      expect(h.storage.store.registerPrepared(attempt.identity, owner)).toBe(
        true,
      );
      expect(h.storage.store.authorizeLaunch(attempt.identity, owner)).toBe(
        true,
      );
      h.executor.hooks.inspect = async ({ target }) => ({
        kind: "unknown",
        ...target,
      });
      const before = facts(h.storage);
      const prepares = h.preparations.length;
      const submits = h.submissions.length;
      const starting = h.start();
      await expect(
        starting,
        "new protected configuration is accepted",
      ).resolves.toBeDefined();
      const runtime = await starting;
      const self = controller(runtime);
      await h.recovered();
      expect(runtime.status().startupRecovery).toBe("settled");
      expect(runtime.status().runner.recoveryState).toBe("unknown");
      await rejected(self.start(h.storage.principal()), ["not_ready"]);
      const state = await self.query(h.storage.principal());
      expect(state.phase).toBe("not_started");
      expect(
        h.storage.store.getOwned(h.storage.principal(), old.job.jobId).status,
      ).toBe("running");
      expect(isDeepStrictEqual(facts(h.storage).slots, before.slots)).toBe(
        true,
      );
      expect(h.preparations.length).toBe(prepares);
      expect(h.submissions.length).toBe(submits);
      expect(h.inspections.length).toBe(0);
      expect(h.executor.prepareCalls.length).toBe(0);
      expect(h.executor.authorizeCalls.length).toBe(0);
      expect(h.executor.inspectCalls.length).toBe(1);
      expect(h.recoverCalls()).toBe(1);
      expect(h.selection()).toBe("none");
    }, 15_000);

    it.each(["missing", "tampered"] as const)(
      "rejects %s fixed material without selecting another asset or submitting a job",
      async (mode) => {
        const h = await harness();
        const appDirectory = await mkdtemp(
          join(tmpdir(), "enhancement-selftest-app-"),
        );
        const resources = join(
          appDirectory,
          "resources",
          "calibration",
          assetId,
        );
        await mkdir(resources, { recursive: true });
        await copyFile(
          join(resourceDirectory, "manifest.json"),
          join(resources, "manifest.json"),
        );
        if (mode === "tampered") {
          const bytes = Buffer.from(await fixedSource());
          bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
          await writeActualFile(join(resources, "calibration.png"), bytes);
        }
        const starting = h.start(appDirectory);
        await expect(
          starting,
          "new protected configuration is accepted",
        ).resolves.toBeDefined();
        const self = controller(await starting);
        await h.recovered();
        await rejected(self.start(h.storage.principal()));
        expect(h.inspections.length).toBe(0);
        expect(h.submissions.length).toBe(0);
        expect(facts(h.storage).jobs.length).toBe(0);
        expect(h.executor.authorizeCalls.length).toBe(0);
        expect(h.selection()).toBe("none");
      },
      15_000,
    );

    it.each(["delivery", "ai"] as const)(
      "keeps an insufficient %s budget as a rejection instead of lowering the fixed target",
      async (budget) => {
        const h = await harness();
        if (budget === "delivery")
          h.input.workerConfig.budgets.delivery.maxPixels =
            configInput().budgets.delivery.maxPixels;
        else h.input.workerConfig.budgets.ai.maxPixels = targetPixels - 1;
        const starting = h.start();
        await expect(
          starting,
          "a valid administrator budget is accepted as configured",
        ).resolves.toBeDefined();
        const self = controller(await starting);
        await h.recovered();
        await rejected(self.start(h.storage.principal()), ["budget_exceeded"]);
        expect(h.inspections.length).toBe(0);
        expect(h.submissions.length).toBe(0);
        expect(facts(h.storage).jobs.length).toBe(0);
        expect(h.executor.authorizeCalls.length).toBe(0);
        for (const call of h.preparations)
          expect(isDeepStrictEqual(call.plan.target, target)).toBe(true);
        expect(h.listener().ready?.()).toBe(false);
      },
      15_000,
    );

    it.each([
      ["prepare", "close"],
      ["prepare", "revoke"],
      ["submit", "close"],
      ["submit", "revoke"],
    ] as const)(
      "seals a late %s return after %s without a committed job or replacement admission",
      async (stage, seal) => {
        const h = await harness();
        const starting = h.start();
        await expect(
          starting,
          "new protected configuration is accepted",
        ).resolves.toBeDefined();
        const runtime = await starting;
        const self = controller(runtime);
        await h.recovered();
        const principal = h.storage.principal();
        const reached = deferred();
        const release = deferred();
        h.releaseOnCleanup(() => release.resolve());
        let held = false;
        if (stage === "prepare")
          h.hooks.prepare = async () => {
            if (held) return;
            held = true;
            reached.resolve();
            await release.promise;
          };
        else
          h.hooks.inputWrite = async (path) => {
            if (held || basename(path) !== "engine.png") return;
            held = true;
            reached.resolve();
            await release.promise;
          };
        const pending = tracked(self.start(principal));
        await reached.promise;
        expect(h.selection()).toBe("none");
        let current = principal;
        if (seal === "close") {
          expect(runtime.close()).toBeUndefined();
          expect(h.storage.store.closed).toBe(true);
          expect(runtime.status().closing).toBe(true);
        } else {
          const rotated = rotateCredential(
            h.storage.store,
            {
              clientId: principal.clientId,
            },
            principal,
          );
          revokeCredential(h.storage.store, principal.credentialId, principal);
          current = authenticate(h.storage.store, `Bearer ${rotated.key}`);
        }
        release.resolve();
        await rejected(pending);
        expect(facts(h.storage).jobs.length).toBe(0);
        expect(facts(h.storage).attempts.length).toBe(0);
        expect(facts(h.storage).slots.length).toBe(0);
        expect(h.executor.authorizeCalls.length).toBe(0);
        expect(h.selection()).toBe("none");
        const submits = h.submissions.length;
        const prepares = h.preparations.length;
        if (seal === "close") {
          await rejected(self.start(current));
          await rejected(self.query(current));
        } else {
          await rejected(self.query(principal), ["authentication_failed"]);
          const queried = await self.query(current);
          expectSnapshot(queried, h.storage);
          expect(queried.output).toBeNull();
          expect(queried.phase === "output_verified").toBe(false);
          const retry = await Promise.allSettled([self.start(current)]);
          expectNoVerified(retry[0]!, h.storage);
        }
        expect(h.submissions.length).toBe(submits);
        expect(h.preparations.length).toBe(prepares);
      },
      20_000,
    );

    it("keeps an ambiguous AUTH on its original slot and never repeats submit or AUTH on another start", async () => {
      const h = await harness();
      h.executor.hooks.authorize = async () => {
        throw new Error("private-controlled-AUTH-reply-lost");
      };
      const starting = h.start();
      await expect(
        starting,
        "new protected configuration is accepted",
      ).resolves.toBeDefined();
      const runtime = await starting;
      const self = controller(runtime);
      await h.recovered();
      const operation = await self.start(h.storage.principal());
      await vi.waitFor(() =>
        expect(runtime.status().runner.ownedState).toBe("unknown"),
      );
      const before = facts(h.storage);
      const retry = await self.start(h.storage.principal());
      expect(retry.jobId === operation.jobId).toBe(true);
      const queried = await self.query(h.storage.principal());
      expectSnapshot(queried, h.storage);
      expect(queried.phase).toBe("unknown");
      expect(queried.output).toBeNull();
      expect(h.submissions.length).toBe(1);
      expect(h.executor.authorizeCalls.length).toBe(1);
      expect(h.executor.launchCalls.length).toBe(0);
      expect(h.inspections.length).toBe(1);
      expect(h.selection()).toBe("none");
      expect(before.slots.length).toBe(1);
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
      expect(h.publishedReads.length).toBe(0);
    }, 15_000);

    it("verifies one complete published PNG only after read and reference cleanup, without qualifying hardware or the next boot", async () => {
      const h = await harness();
      await h.seed("older-ordinary-1");
      await h.seed("older-ordinary-2");
      const starting = h.start();
      await expect(
        starting,
        "new protected configuration is accepted",
      ).resolves.toBeDefined();
      const runtime = await starting;
      const self = controller(runtime);
      await h.recovered();
      const published = await publish(h, self);
      const readReached = deferred();
      const readRelease = deferred();
      const closeReached = deferred();
      const closeRelease = deferred();
      h.releaseOnCleanup(() => readRelease.resolve());
      h.releaseOnCleanup(() => closeRelease.resolve());
      let readHeld = false;
      let closeHeld = false;
      h.hooks.publishedFile = async (stage) => {
        if (stage === "read" && !readHeld) {
          readHeld = true;
          readReached.resolve();
          await readRelease.promise;
        }
        if (stage === "close" && !closeHeld) {
          closeHeld = true;
          closeReached.resolve();
          await closeRelease.promise;
        }
      };
      const wakes = h.wakeCalls();
      const first = tracked(self.query(h.storage.principal()));
      const concurrent = tracked(self.query(h.storage.principal()));
      let finished = 0;
      void first.then(
        () => {
          finished++;
        },
        () => {
          finished++;
        },
      );
      void concurrent.then(
        () => {
          finished++;
        },
        () => {
          finished++;
        },
      );
      await readReached.promise;
      expect(h.publishedReads.length).toBe(1);
      expect(h.publishedReads[0]!.store === h.storage.store).toBe(true);
      expect(h.artifactStores.every((store) => store === h.storage.store)).toBe(
        true,
      );
      expect(h.publishedReads[0]!.args[1] === published.operation.jobId).toBe(
        true,
      );
      expect(h.publishedReads[0]!.args[2].aborted).toBe(false);
      expect(finished).toBe(0);
      expect(
        facts(h.storage).references.filter((ref) => ref.released_at === null)
          .length,
      ).toBe(1);
      expect(h.selection()).toBe("none");
      readRelease.resolve();
      await closeReached.promise;
      expect(finished).toBe(0);
      expect(
        facts(h.storage).references.filter((ref) => ref.released_at === null)
          .length,
      ).toBe(1);
      closeRelease.resolve();
      const results = await Promise.all([first, concurrent]);
      for (const result of results) {
        expectSnapshot(result, h.storage);
        expect(result.phase).toBe("output_verified");
        expect(result.reason).toBe("device_observation_required");
        expect(result.bootId === published.operation.bootId).toBe(true);
        expect(result.jobId === published.operation.jobId).toBe(true);
        expect(result.output).toEqual({
          format: "png",
          width: 5016,
          height: 5016,
          sha256: sha256(published.png),
          byteLength: published.png.length,
        });
      }
      expect(h.publishedFileReads()).toBeGreaterThan(0);
      expect(
        facts(h.storage).references.filter((ref) => ref.released_at === null)
          .length,
      ).toBe(0);
      await self.query(h.storage.principal());
      expect(h.publishedReads.length).toBe(1);
      expect(h.wakeCalls()).toBe(wakes);
      await h.runner().wake();
      expect(
        h.claims.every((call) => call[1] === published.operation.jobId),
      ).toBe(true);
      expect(
        facts(h.storage).jobs.filter((job) => job.status === "queued").length,
      ).toBe(2);
      expect(h.listener().ready?.()).toBe(false);
      expect(runtime.status().runner.ownedState).toBe("none");
      runtime.close();
      const secondStarting = h.start();
      await expect(
        secondStarting,
        "a new boot accepts the same protected configuration",
      ).resolves.toBeDefined();
      const second = controller(await secondStarting);
      await h.recovered();
      const fresh = await second.query(h.storage.principal());
      expectSnapshot(fresh, h.storage);
      expect(fresh.bootId === published.operation.bootId).toBe(false);
      expect(fresh).toMatchObject({
        phase: "not_started",
        jobId: null,
        output: null,
      });
      expect(h.publishedReads.length).toBe(1);
      const newOperation = await second.start(h.storage.principal());
      expect(newOperation.phase).toBe("bound");
      expect(newOperation.jobId === published.operation.jobId).toBe(false);
      expect(newOperation.bootId === fresh.bootId).toBe(true);
      expect(newOperation.output).toBeNull();
      expect(
        h.submissions.filter((call) => call.internalKey !== undefined).length,
      ).toBe(2);
      expect(h.publishedReads.length).toBe(1);
      expect(h.listener().ready?.()).toBe(false);
    }, 30_000);

    it.each(["close", "revoke", "invalid_png", "release_unknown"] as const)(
      "keeps a published read %s outcome from becoming late output_verified or a replacement job",
      async (mode) => {
        const h = await harness();
        const starting = h.start();
        await expect(
          starting,
          "new protected configuration is accepted",
        ).resolves.toBeDefined();
        const runtime = await starting;
        const self = controller(runtime);
        await h.recovered();
        const published = await publish(h, self);
        const principal = h.storage.principal();
        if (mode === "invalid_png") {
          const candidate = facts(h.storage).candidates[0]!;
          await writeActualFile(
            join(
              h.storage.directory,
              "attempts",
              candidate.directory,
              "artifact.png",
            ),
            await fixedSource(),
            false,
          );
        }
        if (mode === "release_unknown")
          h.hooks.releaseReference = () => {
            throw new Error("private-controlled-reference-COMMIT-unknown");
          };
        const reached = deferred();
        const release = deferred();
        h.releaseOnCleanup(() => release.resolve());
        let held = false;
        h.hooks.publishedFile = async (stage) => {
          if (held || stage !== "read") return;
          held = true;
          reached.resolve();
          await release.promise;
        };
        const first = tracked(self.query(principal));
        const concurrent = tracked(self.query(principal));
        if (mode === "close" || mode === "revoke") {
          await reached.promise;
          expect(
            facts(h.storage).references.filter(
              (ref) => ref.released_at === null,
            ).length,
          ).toBe(1);
        }
        let current = principal;
        if (mode === "close") {
          expect(runtime.close()).toBeUndefined();
          expect(h.storage.store.closed).toBe(true);
          expect(h.publishedReads[0]!.args[2].aborted).toBe(true);
          expect(h.selection()).toBe("none");
        } else if (mode === "revoke") {
          const rotated = rotateCredential(
            h.storage.store,
            {
              clientId: principal.clientId,
            },
            principal,
          );
          revokeCredential(h.storage.store, principal.credentialId, principal);
          current = authenticate(h.storage.store, `Bearer ${rotated.key}`);
        }
        release.resolve();
        const outcomes = await Promise.allSettled([first, concurrent]);
        for (const outcome of outcomes) expectNoVerified(outcome, h.storage);
        expect(h.publishedReads.length).toBe(1);
        if (mode === "release_unknown")
          expect(
            facts(h.storage).references.filter(
              (ref) => ref.released_at === null,
            ).length,
          ).toBe(1);
        expect(h.submissions.length).toBe(1);
        expect(h.executor.authorizeCalls.length).toBe(1);
        expect(h.selection()).toBe("none");
        const submits = h.submissions.length;
        const reads = h.publishedReads.length;
        if (mode === "close") {
          await rejected(self.query(current));
          await rejected(self.start(current));
        } else {
          if (mode === "revoke")
            await rejected(self.query(principal), ["authentication_failed"]);
          const later = await Promise.allSettled([
            self.query(current),
            self.start(current),
          ]);
          for (const outcome of later) expectNoVerified(outcome, h.storage);
          expect(
            h.storage.store.getOwned(current, published.operation.jobId!)
              .status,
          ).toBe("succeeded");
        }
        expect(h.submissions.length).toBe(submits);
        expect(h.publishedReads.length).toBe(reads);
        expect(h.executor.authorizeCalls.length).toBe(1);
        expect(h.listener().ready?.()).toBe(false);
      },
      30_000,
    );
  },
);
