import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { isIP } from "node:net";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual, types } from "node:util";

import { createArtifacts, type ArtifactResult } from "./artifacts.js";
import { createSystemClock } from "./clock.js";
import {
  createRunnerLimits,
  createSubmissionLimits,
  createWorkerConfig,
} from "./config.js";
import {
  EnhancementError,
  INTERNAL_SELF_TEST_KEY_PREFIX,
  NORMALIZATION_PROFILE,
  PROTOCOL_VERSION,
  isInternalSelfTestKey,
  normalizePlan,
  type EnhancementPlanRequest,
  type FixedSelfTestSnapshot,
} from "./contracts.js";
import { freezeExecutionPolicy, type ActiveAttempt, type ClaimedAttempt } from "./execution.js";
import { createHttpTransportLimits, requestByteBudget } from "./http-config.js";
import {
  listenEnhancementServer,
  type HttpFileIoActivity,
  type HttpFileIoOwner,
} from "./http.js";
import { listenEnhancementTlsServer } from "./https.js";
import { prepareEngineInput } from "./image-io.js";
import { createJobService, localInputFiles } from "./jobs.js";
import { createRunner, type RunnerStatus } from "./runner.js";
import {
  openStore,
  StoreSchemaVersionMismatch,
  type AuthenticatedClient,
  type EnhancementStore,
  type JobDto,
  type StoreMaintenanceCounts,
} from "./store.js";
import {
  freezeWindowsControlBridgeOptions,
  freezeWindowsPrepareDiagnostic,
  type WindowsControlBridgeLimits,
} from "./windows-control-bridge-protocol.js";
import {
  createWindowsExecutionAdapter,
  type WindowsExecutionAdapter,
  type WindowsExecutionStatus,
} from "./windows-execution-adapter.js";
import { createWindowsJournalLauncher, freezeWindowsJournalReadLimits,
  type WindowsJournalLauncher } from "./windows-journal-launcher.js";
import { freezeWindowsJournalReadContext, type WindowsJournalReadContext } from "./windows-journal-reader.js";
import { freezeWindowsPrepareRequest } from "./windows-prepare-payload.js";

export type WindowsWorkerStatus = Readonly<{
  closing: boolean;
  startupRecovery: "pending" | "settled" | "failed";
  runner: RunnerStatus;
  adapter: WindowsExecutionStatus;
}>;

export type StartupObservation = Readonly<{
  phase: "listening" | "listener_bind_failed" | "store_schema_incompatible" | "unknown";
  runnerConstructed: boolean;
  listenerSucceeded: boolean;
  recoveryCalled: boolean;
  claimEntered: boolean;
  prepareEntered: boolean;
  authorizeEntered: boolean;
}>;

export type MaintenanceSnapshot = Readonly<{
  bootId: string;
  sealed: boolean;
  state: "open" | "draining" | "quiescent" | "unknown";
  canStop: boolean;
  store: StoreMaintenanceCounts | null;
  http: HttpFileIoActivity | null;
  pending: Readonly<{
    selfTestAdmission: number;
    selfTestOutputRead: number;
    runner: number;
    adapter: number;
  }> | null;
  runtime: WindowsWorkerStatus | null;
}>;

const fixedAssetId = "zeb-enhancement-calibration-v1";
const fixedSourceSha256 =
  "ce7faf5322ff9b665ff55896a9acab6fba4963420e88cbb6bb150ec7dc41577f";
const fixedSourceByteLength = 87_100;
const fixedSourceSize = 1254;
const fixedTargetSize = 5016;
const isWellFormed = (
  String.prototype as unknown as { isWellFormed(this: string): boolean }
).isWellFormed;

function invalid(): never {
  throw new EnhancementError("configuration_invalid");
}

function safeError(error: unknown): EnhancementError {
  return error instanceof EnhancementError
    ? error
    : new EnhancementError("internal_error");
}

function record(
  value: unknown,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const expectedKeys = [
    ...keys,
    ...optionalKeys.filter((key) => Object.hasOwn(value, key)),
  ];
  if (
    Reflect.ownKeys(value).length !== expectedKeys.length ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  )
    invalid();
  return Object.fromEntries(
    expectedKeys.map((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !("value" in property) || !property.enumerable)
        invalid();
      return [key, property.value];
    }),
  );
}

function runtimeUnknown(
  execution: RunnerStatus,
  native: WindowsExecutionStatus,
): boolean {
  return (
    execution.closed ||
    execution.storeClosed ||
    execution.recoveryState === "unknown" ||
    execution.ownedState === "unknown" ||
    native.sealed ||
    native.close !== "not_requested" ||
    native.activity === "unknown" ||
    native.activity === "cleanup_unknown"
  );
}

function maintenanceCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new EnhancementError("internal_error");
  return value;
}

function unicode(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isWellFormed.call(value) ||
    value.includes("\u0000")
  )
    invalid();
  return value;
}

function localPath(value: unknown): string {
  const path = unicode(value);
  if (!/^[A-Za-z]:[\\/]/.test(path) || !win32.isAbsolute(path)) invalid();
  return path;
}

function runtimeEnvironment(): Readonly<Record<string, string>> {
  const names = ["SystemRoot", "WINDIR", "TEMP", "TMP"] as const;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = names.find(
      (candidate) => candidate.toUpperCase() === key.toUpperCase(),
    );
    if (!name) continue;
    if (Object.hasOwn(environment, name)) invalid();
    environment[name] = unicode(value);
  }
  environment.SystemRoot = localPath(environment.SystemRoot);
  return Object.freeze(environment);
}

function configuration(value: unknown, appDirectory: string) {
  try {
    const source = record(
      value,
      [
        "storeDirectory",
        "port",
        "operatorClientId",
        "selfTestModelId",
        "workerConfig",
        "submissionLimits",
        "runnerLimits",
        "transportLimits",
        "execution",
      ],
      ["tls", "host"],
    );
    const hasTls = Object.hasOwn(source, "tls");
    const hasHost = Object.hasOwn(source, "host");
    if (hasTls && hasHost) invalid();
    const host = hasHost ? unicode(source.host) : undefined;
    if (host !== undefined && !isIP(host)) invalid();
    let tls: Readonly<{ host: string; pfxPath: string }> | undefined;
    if (hasTls) {
      const transport = record(source.tls, ["host", "pfxPath"]);
      const host = unicode(transport.host);
      if (!isIP(host)) invalid();
      tls = Object.freeze({ host, pfxPath: localPath(transport.pfxPath) });
    }
    const execution = record(source.execution, [
      "installationRoot",
      "recordsRoot",
      "expectedManifestSha256",
      "bridgeLimits",
      "journalLimits",
    ]);
    const storeDirectory = localPath(source.storeDirectory);
    const port = source.port;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65_535
    )
      invalid();
    const operatorClientId = unicode(source.operatorClientId);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        operatorClientId,
      )
    )
      invalid();
    const workerConfig = createWorkerConfig(source.workerConfig);
    const selfTestModelId = unicode(source.selfTestModelId);
    const selfTestModel = workerConfig.models.find(
      (model) => model.id === selfTestModelId,
    );
    if (!selfTestModel) invalid();
    const submissionLimits = createSubmissionLimits(source.submissionLimits);
    const runnerLimits = createRunnerLimits(source.runnerLimits);
    const transportLimits = createHttpTransportLimits(source.transportLimits);
    requestByteBudget(workerConfig.budgets.input.maxBytes, transportLimits);
    const applicationRoot = localPath(appDirectory);
    const payloadRoot = win32.dirname(applicationRoot);
    const journalLimits = freezeWindowsJournalReadLimits(
      execution.journalLimits,
    );
    const bridge = freezeWindowsControlBridgeOptions({
      executablePath: win32.join(
        payloadRoot,
        "native",
        "bridge",
        "WindowsControlBridge.exe",
      ),
      helperPath: win32.join(
        payloadRoot,
        "native",
        "supervisor",
        "WindowsSupervisor.exe",
      ),
      installationRoot: localPath(execution.installationRoot),
      recordsRoot: localPath(execution.recordsRoot),
      expectedManifestSha256: execution.expectedManifestSha256 as string,
      environment: runtimeEnvironment(),
      limits: execution.bridgeLimits as WindowsControlBridgeLimits,
    });
    return Object.freeze({
      storeDirectory,
      port,
      host,
      tls,
      operatorClientId,
      selfTestModel,
      workerConfig,
      submissionLimits,
      runnerLimits,
      transportLimits,
      bridge,
      journalLimits,
      calibrationDirectory: win32.join(
        applicationRoot,
        "resources",
        "calibration",
        fixedAssetId,
      ),
    });
  } catch {
    return invalid();
  }
}

export function validateWindowsWorkerInstallConfiguration(
  value: unknown,
  appDirectory: string,
): void {
  const config = configuration(value, appDirectory);
  if (
    (config.tls === undefined && config.host === undefined) ||
    config.port === 0
  )
    invalid();
}

function validateCalibrationManifest(bytes: Buffer): void {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    invalid();
  }
  const manifest = record(value, [
    "assetId",
    "origin",
    "sourceSvgSha256",
    "source",
    "expectedNative",
    "renderer",
    "fullSourceDecodeVerified",
    "actualInferenceVerified",
    "gpuVerified",
  ]);
  const source = record(manifest.source, [
    "format",
    "width",
    "height",
    "byteLength",
    "sha256",
  ]);
  const native = record(manifest.expectedNative, [
    "format",
    "width",
    "height",
    "scale",
  ]);
  if (
    manifest.assetId !== fixedAssetId ||
    source.format !== "png" ||
    source.width !== fixedSourceSize ||
    source.height !== fixedSourceSize ||
    source.byteLength !== fixedSourceByteLength ||
    source.sha256 !== fixedSourceSha256 ||
    native.format !== "png" ||
    native.width !== fixedTargetSize ||
    native.height !== fixedTargetSize ||
    native.scale !== 4 ||
    manifest.fullSourceDecodeVerified !== true ||
    manifest.actualInferenceVerified !== false ||
    manifest.gpuVerified !== false
  )
    invalid();
}

export async function startWindowsWorker(
  value: unknown,
  options: Readonly<{
    appDirectory: string;
    signal: AbortSignal;
    onStartupObservation?: (observation: StartupObservation) => void | Promise<void>;
  }>,
): Promise<
  Readonly<{
    server: Server;
    status(): WindowsWorkerStatus;
    close(): void;
    shutdown(requestedDeadlineAt?: number): Promise<"closed" | "unknown">;
    maintenance: Readonly<{
      enter(principal: AuthenticatedClient): MaintenanceSnapshot;
      query(principal: AuthenticatedClient): MaintenanceSnapshot;
    }>;
    selfTest: Readonly<{
      start(principal: AuthenticatedClient): Promise<FixedSelfTestSnapshot>;
      query(principal: AuthenticatedClient): Promise<FixedSelfTestSnapshot>;
    }>;
  }>
> {
  const configured = configuration(value, options.appDirectory);
  if (options.signal.aborted) throw new EnhancementError("not_ready");
  const bootId = randomUUID();
  type Expected = Parameters<EnhancementStore["inspectQueuedSelfTest"]>[1];
  type Material = Readonly<{ bytes: Buffer; expected: Expected }>;
  type Operation = {
    phase: FixedSelfTestSnapshot["phase"];
    reason: FixedSelfTestSnapshot["reason"];
    boundJobId: string | null;
    blockedJobId: string | null;
    output: ArtifactResult | null;
    controller: AbortController;
    admission?: Promise<void>;
    outputRead?: Promise<void>;
    material?: Material;
    submitIssued: boolean;
    claimObserved: boolean;
    bootAttempt?: Readonly<{
      target: Readonly<{
        identity: ClaimedAttempt["identity"];
        launchTicket: string;
      }>;
      requestFingerprint: string;
      executionPolicyFingerprint: string;
    }>;
    qualified: boolean;
    qualificationRevoked: boolean;
  };
  let operation: Operation | undefined;
  let closing = false;
  let maintenanceSealed = false;
  let selfTestAdmission = 0;
  let selfTestOutputRead = 0;
  let startupRecovery: WindowsWorkerStatus["startupRecovery"] = "pending";
  let adapter: WindowsExecutionAdapter | undefined;
  let store: EnhancementStore | undefined;
  let runner: ReturnType<typeof createRunner> | undefined;
  let server: Server | undefined;
  const startupObserver = options.onStartupObservation;
  let startupObserved = false, runnerConstructed = false;
  let listenerSucceeded = false, recoveryCalled = false, listenerBindFailed = false;
  async function observeStartup(phase: StartupObservation["phase"]): Promise<void> {
    if (!startupObserver || startupObserved || recoveryCalled) return;
    startupObserved = true;
    // This one-shot cut precedes recover and HTTP admission, hence no launch path.
    await startupObserver(Object.freeze({
      phase, runnerConstructed, listenerSucceeded, recoveryCalled,
      claimEntered: false, prepareEntered: false, authorizeEntered: false,
    }));
  }
  let shutdownPromise: Promise<"closed" | "unknown"> | undefined;
  let lastPrepared: Readonly<{
    identity: ClaimedAttempt["identity"];
    launchTicket: string;
    executionPolicyFingerprint: string;
  }> | undefined;

  function closeFailed(): void {
    try {
      console.error("enhancement_worker_close_failed");
    } catch {
      // Losing the diagnostic sink must not skip the remaining seals.
    }
  }

  function cleanup(action: () => unknown): void {
    try {
      void Promise.resolve(action()).catch(closeFailed);
    } catch {
      closeFailed();
    }
  }

  function revokeQualification(current = operation): void {
    if (!current) return;
    current.qualified = false;
    current.qualificationRevoked = true;
  }

  function close(): void {
    closing = true;
    revokeQualification();
    cleanup(() => operation?.controller.abort());
    // Take each reference before closing: a late listener is still owned once.
    const ownedRunner = runner;
    runner = undefined;
    const ownedAdapter = adapter;
    adapter = undefined;
    const ownedServer = server;
    server = undefined;
    const ownedStore = store;
    store = undefined;
    cleanup(() => options.signal.removeEventListener("abort", close));
    if (ownedRunner) cleanup(() => ownedRunner.close());
    if (ownedAdapter) cleanup(() => ownedAdapter.close());
    if (ownedServer) {
      cleanup(() => ownedServer.close());
      cleanup(() => ownedServer.closeAllConnections());
    }
    if (ownedStore) cleanup(() => ownedStore.close());
  }

  function ensureOpen(): void {
    if (closing || options.signal.aborted)
      throw new EnhancementError("not_ready");
  }

  function canAdmit(allowBusy = false): boolean {
    const currentStore = store;
    const currentRunner = runner;
    const currentAdapter = adapter;
    if (
      maintenanceSealed ||
      closing ||
      options.signal.aborted ||
      startupRecovery !== "settled" ||
      !currentStore ||
      currentStore.closed ||
      !currentRunner ||
      !currentAdapter
    ) {
      revokeQualification();
      return false;
    }
    const execution = currentRunner.status();
    const native = currentAdapter.status();
    if (runtimeUnknown(execution, native)) revokeQualification();
    return (
      !maintenanceSealed &&
      !closing &&
      !options.signal.aborted &&
      startupRecovery === "settled" &&
      store === currentStore &&
      !currentStore.closed &&
      runner === currentRunner &&
      adapter === currentAdapter &&
      !execution.closed &&
      !execution.storeClosed &&
      !execution.recoveryInFlight &&
      execution.recoveryState === "idle" &&
      (execution.ownedState === "none" ||
        (allowBusy && execution.ownedState === "busy")) &&
      !native.sealed &&
      native.close === "not_requested" &&
      (native.activity === "idle" ||
        (allowBusy && native.activity === "busy"))
    );
  }

  options.signal.addEventListener("abort", close, { once: true });
  try {
    ensureOpen();
    const transport = configured.tls
      ? {
          host: configured.tls.host,
          pfx: await readFile(configured.tls.pfxPath, {
            signal: options.signal,
          }),
        }
      : undefined;
    ensureOpen();
    const clock = createSystemClock();
    const executor = (adapter = createWindowsExecutionAdapter(
      {
        bridge: configured.bridge,
        journalLimits: configured.journalLimits,
      },
      (attempt) => {
        if (!closing && !maintenanceSealed)
          lastPrepared = Object.freeze({
            identity: Object.freeze({ ...attempt.identity }),
            launchTicket: attempt.launchTicket,
            executionPolicyFingerprint: attempt.executionPolicy.fingerprint,
          });
        return observeBootAttempt(attempt);
      },
    ));
    ensureOpen();
    const opened = (store = openStore({
      directory: configured.storeDirectory,
      clock: clock.now,
      interruptionEvidenceReader: executor.readInterruptionEvidence,
    }));
    ensureOpen();
    const activeRunner = (runner = createRunner({
      store: opened,
      clock,
      executor,
      ownerInstanceId: randomUUID(),
      claimSelection: () => {
        if (canRunOrdinary()) return "ordinary";
        const current = operation;
        if (
          maintenanceSealed ||
          !current ||
          current.qualificationRevoked ||
          !current.boundJobId ||
          current.claimObserved ||
          current.phase !== "bound" ||
          current.controller.signal.aborted
        )
          return "none";
        try {
          if (!canAdmit()) return "none";
          if (
            maintenanceSealed ||
            closing ||
            options.signal.aborted ||
            operation !== current ||
            current.qualificationRevoked ||
            !current.boundJobId ||
            current.claimObserved ||
            current.phase !== "bound" ||
            current.controller.signal.aborted
          )
            return "none";
          return Object.freeze({ onlyJobId: current.boundJobId });
        } catch {
          return "none";
        }
      },
    }));
    runnerConstructed = true;
    ensureOpen();
    const published = createArtifacts({ store: opened });

    function assertRequest(principal: AuthenticatedClient): void {
      opened.assertPrincipal(principal);
      if (principal.clientId !== configured.operatorClientId)
        throw new EnhancementError("authentication_failed");
      ensureOpen();
      if (opened.closed || store !== opened)
        throw new EnhancementError("not_ready");
    }

    function assertCurrent(
      principal: AuthenticatedClient,
      current: Operation,
    ): void {
      assertRequest(principal);
      if (operation !== current || current.controller.signal.aborted)
        throw new EnhancementError("not_ready");
    }

    function assertAdmission(
      principal: AuthenticatedClient,
      current: Operation,
    ): void {
      assertCurrent(principal, current);
      if (maintenanceSealed) throw new EnhancementError("not_ready");
    }

    function requestError(principal: AuthenticatedClient, error: unknown) {
      try {
        assertRequest(principal);
      } catch (failure) {
        return safeError(failure);
      }
      return safeError(error);
    }

    function snapshot(current = operation): FixedSelfTestSnapshot {
      const qualified = isBootQualified(current);
      return Object.freeze({
        bootId,
        assetId: fixedAssetId,
        phase: current?.phase ?? "not_started",
        jobId: current?.boundJobId ?? current?.blockedJobId ?? null,
        reason: qualified
          ? null
          : current?.phase === "output_verified"
            ? "device_observation_required"
            : current?.reason ?? null,
        output: current?.output ?? null,
        qualification: qualified ? "qualified" : "unknown",
      });
    }

    function sealFailure(current: Operation, error: unknown): EnhancementError {
      const failure = safeError(error);
      if (operation === current) {
        revokeQualification(current);
        // Failure only removes authority; a revoked or closed caller can never
        // publish a new binding or output through this cleanup path.
        current.phase =
          current.submitIssued ||
          current.boundJobId ||
          closing ||
          failure.code === "authentication_failed"
            ? "unknown"
            : "failed";
        current.reason = failure.code;
        current.output = null;
        current.material = undefined;
      }
      return failure;
    }

    function executionUnknown(): boolean {
      try {
        const execution = activeRunner.status();
        const native = executor.status();
        const unknown = runtimeUnknown(execution, native);
        if (unknown) revokeQualification();
        return unknown;
      } catch (error) {
        revokeQualification();
        throw error;
      }
    }

    function isBootQualified(current = operation): boolean {
      if (!current || current.qualificationRevoked) return false;
      const ownsCurrent = () =>
        operation === current &&
        !maintenanceSealed &&
        !closing &&
        !options.signal.aborted &&
        !current.controller.signal.aborted &&
        startupRecovery === "settled" &&
        store === opened &&
        !opened.closed &&
        runner === activeRunner &&
        adapter === executor;
      try {
        if (!ownsCurrent()) {
          revokeQualification(current);
          return false;
        }
        const execution = activeRunner.status();
        const native = executor.status();
        if (!ownsCurrent() || runtimeUnknown(execution, native)) {
          revokeQualification(current);
          return false;
        }
        const original = current.bootAttempt;
        const receipt = native.runtimeObservation;
        if (
          receipt &&
          (!original ||
            receipt.descriptor.launchTicket !== original.target.launchTicket ||
            !isDeepStrictEqual(
              receipt.descriptor.details.target,
              original.target,
            ) ||
            receipt.descriptor.details.requestFingerprint !==
              original.requestFingerprint ||
            receipt.descriptor.details.executionPolicyFingerprint !==
              original.executionPolicyFingerprint ||
            receipt.descriptor.details.installationManifestSha256 !==
              configured.bridge.expectedManifestSha256)
        ) {
          revokeQualification(current);
          return false;
        }
        // The original verified facts survive a normal ordinary Entry replacement.
        if (current.qualified) return true;
        if (
          !original ||
          !receipt ||
          current.phase !== "output_verified" ||
          !current.output ||
          execution.recoveryInFlight ||
          execution.recoveryState !== "idle" ||
          execution.ownedState !== "none" ||
          native.activity !== "idle"
        )
          return false;
        const { background, engine, gpu } = receipt.observation;
        if (
          background?.state !== "observed" ||
          engine?.state !== "observed" ||
          background.worker.sessionId !== 0 ||
          engine.process.sessionId !== 0 ||
          background.worker.userSid !== engine.process.userSid ||
          gpu.state !== "observed" ||
          gpu.devices.length === 0
        )
          return false;
        if (!ownsCurrent() || current.qualificationRevoked) {
          revokeQualification(current);
          return false;
        }
        current.qualified = true;
        return true;
      } catch {
        revokeQualification(current);
        return false;
      }
    }

    function canRunOrdinary(allowBusy = false): boolean {
      const current = operation;
      try {
        if (!isBootQualified(current)) return false;
        const available = canAdmit(allowBusy);
        return isBootQualified(current) && available;
      } catch {
        revokeQualification(current);
        return false;
      }
    }

    function observeBootAttempt(attempt: ClaimedAttempt): boolean {
      const current = operation;
      const currentBound = () =>
        !maintenanceSealed &&
        !closing &&
        !options.signal.aborted &&
        startupRecovery === "settled" &&
        current !== undefined &&
        operation === current &&
        !current.qualificationRevoked &&
        !current.bootAttempt &&
        current.phase === "bound" &&
        !current.controller.signal.aborted &&
        current.boundJobId === attempt.identity.jobId &&
        current.boundJobId === attempt.job.jobId &&
        store === opened &&
        !opened.closed;
      try {
        if (!current || !currentBound() || executionUnknown()) return false;
        const active = opened.getActiveAttempt(attempt.identity);
        const eligible =
          active !== undefined &&
          active.launchTicket === attempt.launchTicket &&
          isDeepStrictEqual(active.identity, attempt.identity) &&
          isDeepStrictEqual(active.job, attempt.job) &&
          isDeepStrictEqual(active.executionPolicy, attempt.executionPolicy) &&
          active.job.status === "running" &&
          active.job.source.format === "png" &&
          active.job.source.sha256 === fixedSourceSha256 &&
          active.job.source.byteLength === fixedSourceByteLength &&
          active.job.source.width === fixedSourceSize &&
          active.job.source.height === fixedSourceSize &&
          active.job.plan.engine.modelId === configured.selfTestModel.id &&
          !executionUnknown() &&
          currentBound();
        if (!eligible) return false;
        const request = freezeWindowsPrepareRequest(attempt, "boot-v1");
        if (!currentBound() || executionUnknown() || !currentBound()) return false;
        current.bootAttempt = Object.freeze({
          target: Object.freeze({
            identity: Object.freeze({ ...attempt.identity }),
            launchTicket: attempt.launchTicket,
          }),
          requestFingerprint: request.requestFingerprint,
          executionPolicyFingerprint: attempt.executionPolicy.fingerprint,
        });
        return true;
      } catch {
        revokeQualification(current);
        return false;
      }
    }

    function terminal(current: Operation, job: JobDto): void {
      revokeQualification(current);
      current.phase = "failed";
      current.reason =
        job.reason === "invalid_output"
          ? "invalid_output"
          : job.status === "cancelled"
            ? "not_ready"
            : "internal_error";
      current.output = null;
    }

    function refresh(
      principal: AuthenticatedClient,
      current: Operation,
    ): JobDto | undefined {
      if (!current.boundJobId) return;
      const job = opened.getOwned(principal, current.boundJobId);
      assertCurrent(principal, current);
      if (current.outputRead) return job;
      if (job.status === "failed" || job.status === "cancelled") {
        terminal(current, job);
      } else if (executionUnknown()) {
        current.phase = "unknown";
        current.reason = "recovery_blocked";
      } else if (current.phase === "unknown" && job.status !== "succeeded") {
        return job;
      } else {
        current.phase = "bound";
        current.reason = null;
      }
      return job;
    }

    function rememberClaim(current = operation): void {
      if (!current || operation !== current || !current.boundJobId) return;
      try {
        const execution = activeRunner.status();
        if (execution.ownedState !== "none") current.claimObserved = true;
        if (runtimeUnknown(execution, executor.status()))
          revokeQualification(current);
      } catch (error) {
        revokeQualification(current);
        throw error;
      }
    }

    function wakeBound(
      principal: AuthenticatedClient,
      current: Operation,
    ): void {
      const pending = activeRunner.wake();
      void pending.catch((error: unknown) => {
        sealFailure(current, error);
      });
      rememberClaim(current);
      if (!current.claimObserved) {
        const job = refresh(principal, current);
        if (job && job.status !== "failed" && job.status !== "cancelled") {
          // A claim without observed ownership grants no authority to replay.
          current.phase = "unknown";
          current.reason = "not_ready";
        }
      }
    }

    async function material(
      principal: AuthenticatedClient,
      current: Operation,
    ): Promise<Material> {
      assertAdmission(principal, current);
      const request: EnhancementPlanRequest = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        scope: "full_image",
        sourceSha256: fixedSourceSha256,
        target: Object.freeze({
          width: fixedTargetSize,
          height: fixedTargetSize,
          format: "png",
        }),
        modelId: configured.selfTestModel.id,
        normalizationProfile: NORMALIZATION_PROFILE,
        tile: configured.selfTestModel.defaultTile,
      });
      // A valid administrator budget can be insufficient for this operation.
      // Preserve normalizePlan/prepareEngineInput errors at start, not boot.
      const plan = normalizePlan(request, configured.workerConfig);
      const executionPolicy = freezeExecutionPolicy(
        configured.runnerLimits,
        configured.selfTestModel.allowedTiles,
      );
      const signal = current.controller.signal;
      const manifest = await readFile(
        win32.join(configured.calibrationDirectory, "manifest.json"),
        { signal },
      );
      assertAdmission(principal, current);
      validateCalibrationManifest(manifest);
      const bytes = await readFile(
        win32.join(configured.calibrationDirectory, "calibration.png"),
        { signal },
      );
      assertAdmission(principal, current);
      if (
        bytes.length !== fixedSourceByteLength ||
        createHash("sha256").update(bytes).digest("hex") !== fixedSourceSha256
      )
        throw new EnhancementError("input_digest_mismatch");
      const prepared = await prepareEngineInput(bytes, plan);
      assertAdmission(principal, current);
      const { bytes: originalBytes, ...source } = prepared.source;
      if (
        source.format !== "png" ||
        source.width !== fixedSourceSize ||
        source.height !== fixedSourceSize ||
        source.encodedWidth !== fixedSourceSize ||
        source.encodedHeight !== fixedSourceSize ||
        source.orientation !== 1 ||
        source.sha256 !== fixedSourceSha256 ||
        source.byteLength !== fixedSourceByteLength ||
        prepared.predictedAiSize.width !== fixedTargetSize ||
        prepared.predictedAiSize.height !== fixedTargetSize ||
        prepared.predictedAiSize.pixels !== fixedTargetSize * fixedTargetSize
      )
        throw new EnhancementError("invalid_image");
      return Object.freeze({
        bytes: originalBytes,
        expected: Object.freeze({
          request,
          plan,
          executionPolicy,
          source: Object.freeze(source),
        }),
      });
    }

    async function admit(
      principal: AuthenticatedClient,
      current: Operation,
    ): Promise<void> {
      assertAdmission(principal, current);
      if (!canAdmit()) throw new EnhancementError("not_ready");
      const key = INTERNAL_SELF_TEST_KEY_PREFIX + bootId;
      const maxWaitingJobs = configured.submissionLimits.maxWaitingJobs + 1;
      if (
        !Number.isSafeInteger(maxWaitingJobs) ||
        !isInternalSelfTestKey(key) ||
        key.length > configured.submissionLimits.maxIdempotencyKeyLength
      )
        invalid();
      const fixed = current.material ?? (await material(principal, current));
      assertAdmission(principal, current);
      if (!canAdmit()) throw new EnhancementError("not_ready");
      current.material = fixed;
      const inspected = opened.inspectQueuedSelfTest(principal, fixed.expected);
      assertAdmission(principal, current);
      if (inspected.kind === "blocked") {
        current.blockedJobId = inspected.jobId;
        current.phase = "blocked";
        current.reason = "diagnostic_conflict";
        return;
      }
      if (inspected.kind === "reusable") {
        if (!canAdmit()) throw new EnhancementError("not_ready");
        current.boundJobId = inspected.job.jobId;
        current.blockedJobId = null;
        current.phase = "bound";
        current.reason = null;
        current.material = undefined;
        wakeBound(principal, current);
        return;
      }
      if (!canAdmit()) throw new EnhancementError("not_ready");
      const collision = opened.findByKey(principal, key);
      assertAdmission(principal, current);
      if (collision) {
        current.blockedJobId = collision.job.jobId;
        current.phase = "blocked";
        current.reason = "diagnostic_conflict";
        return;
      }

      const guard = () => {
        assertAdmission(principal, current);
        const allowed = canAdmit();
        assertAdmission(principal, current);
        if (!allowed || current.phase !== "preparing" || current.boundJobId)
          throw new EnhancementError("not_ready");
      };
      async function guarded<T>(action: () => Promise<T>): Promise<T> {
        guard();
        const result = await action();
        guard();
        return result;
      }
      let cleaning = false;
      const privateService = createJobService({
        store: opened,
        config: () => configured.workerConfig,
        runnerLimits: configured.runnerLimits,
        limits: { ...configured.submissionLimits, maxWaitingJobs },
        internalIdempotencyKey: key,
        ready: () => {
          guard();
          return true;
        },
        files: {
          mkdir: (path) => guarded(() => localInputFiles.mkdir(path)),
          write: (path, bytes) =>
            guarded(() => localInputFiles.write(path, bytes)),
          rename: (from, to) => guarded(() => localInputFiles.rename(from, to)),
          syncDirectory: (path) =>
            cleaning
              ? localInputFiles.syncDirectory(path)
              : guarded(() => localInputFiles.syncDirectory(path)),
          remove(path) {
            // Only the original submit algorithm decides that an unregistered
            // directory is safe to remove; sealing must not invent cleanup.
            cleaning = true;
            return localInputFiles.remove(path);
          },
        },
      });
      guard();
      current.submitIssued = true;
      const accepted = await privateService.submit(
        principal,
        {
          idempotencyKey: key,
          sourceBytes: fixed.bytes,
          plan: fixed.expected.request,
        },
        current.controller.signal,
      );
      assertCurrent(principal, current);
      if (accepted.replayed) throw new EnhancementError("idempotency_conflict");
      current.boundJobId = accepted.job.jobId;
      current.blockedJobId = null;
      current.phase = "bound";
      current.reason = null;
      current.material = undefined;
      wakeBound(principal, current);
    }

    function startAdmission(
      principal: AuthenticatedClient,
      current: Operation,
    ): Promise<void> {
      if (maintenanceSealed || selfTestAdmission !== 0)
        throw new EnhancementError("not_ready");
      current.phase = "preparing";
      current.reason = null;
      current.blockedJobId = null;
      selfTestAdmission++;
      const pending = Promise.resolve()
        .then(() => admit(principal, current))
        .catch((error: unknown) => {
          throw sealFailure(current, error);
        })
        .finally(() => {
          if (current.admission === pending) current.admission = undefined;
        });
      // No I/O, image preparation or submit can run before this publication.
      current.admission = pending;
      void pending.then(
        () => {
          selfTestAdmission--;
        },
        () => {
          selfTestAdmission--;
        },
      );
      return pending;
    }

    function startOutputRead(
      principal: AuthenticatedClient,
      current: Operation,
    ): Promise<void> {
      const jobId = current.boundJobId;
      if (!jobId) throw new EnhancementError("not_ready");
      assertAdmission(principal, current);
      if (selfTestOutputRead !== 0) throw new EnhancementError("not_ready");
      selfTestOutputRead++;
      const pending = Promise.resolve()
        .then(async () => {
          assertAdmission(principal, current);
          const artifact = await published.readPublished(
            principal,
            jobId,
            current.controller.signal,
          );
          assertCurrent(principal, current);
          if (current.boundJobId !== jobId || executionUnknown())
            throw new EnhancementError("not_ready");
          if (
            artifact.format !== "png" ||
            artifact.width !== fixedTargetSize ||
            artifact.height !== fixedTargetSize
          )
            throw new EnhancementError("invalid_output");
          current.output = Object.freeze({
            format: artifact.format,
            width: artifact.width,
            height: artifact.height,
            sha256: artifact.sha256,
            byteLength: artifact.byteLength,
          });
          current.phase = "output_verified";
          current.reason = "device_observation_required";
          // Restored ordinary jobs have no new HTTP commit to wake the runner.
          if (canRunOrdinary())
            void activeRunner.wake().catch(() => revokeQualification(current));
        })
        .catch((error: unknown) => {
          throw sealFailure(current, error);
        });
      current.phase = "checking_output";
      current.outputRead = pending;
      void pending.then(
        () => {
          selfTestOutputRead--;
        },
        () => {
          selfTestOutputRead--;
        },
      );
      // Retain this one core even on failure; query never retries uncertain I/O.
      void pending.catch(() => {});
      return pending;
    }

    const selfTest = Object.freeze({
      async start(
        principal: AuthenticatedClient,
      ): Promise<FixedSelfTestSnapshot> {
        try {
          assertRequest(principal);
          if (maintenanceSealed) throw new EnhancementError("not_ready");
          let current = operation;
          if (!current) {
            if (!canAdmit()) throw new EnhancementError("not_ready");
            current = {
              phase: "preparing",
              reason: null,
              boundJobId: null,
              blockedJobId: null,
              output: null,
              controller: new AbortController(),
              submitIssued: false,
              claimObserved: false,
              qualified: false,
              qualificationRevoked: false,
            };
            operation = current;
            startAdmission(principal, current);
          } else if (
            current.phase === "blocked" &&
            !current.admission &&
            !current.submitIssued &&
            !current.boundJobId &&
            !current.claimObserved
          ) {
            if (!canAdmit()) throw new EnhancementError("not_ready");
            startAdmission(principal, current);
          }
          const admission = current.admission;
          if (admission) await admission;
          assertCurrent(principal, current);
          refresh(principal, current);
          assertCurrent(principal, current);
          return snapshot(current);
        } catch (error) {
          throw requestError(principal, error);
        }
      },
      async query(
        principal: AuthenticatedClient,
      ): Promise<FixedSelfTestSnapshot> {
        try {
          assertRequest(principal);
          const current = operation;
          if (!current) {
            assertRequest(principal);
            return snapshot();
          }
          const job = refresh(principal, current);
          if (
            job?.status === "succeeded" &&
            !current.outputRead &&
            current.phase === "bound"
          ) {
            if (maintenanceSealed) current.reason = "not_ready";
            else startOutputRead(principal, current);
          }
          if (current.phase === "checking_output" && current.outputRead)
            await current.outputRead;
          assertCurrent(principal, current);
          return snapshot(current);
        } catch (error) {
          throw requestError(principal, error);
        }
      },
    });

    const maintenance = Object.freeze({
      enter(principal: AuthenticatedClient): MaintenanceSnapshot {
        try {
          assertRequest(principal);
          maintenanceSealed = true;
          revokeQualification();
          let sealFailed = false;
          try {
            fileIo.sealFileIo();
          } catch {
            sealFailed = true;
          }
          return readMaintenance(principal, sealFailed);
        } catch (error) {
          throw requestError(principal, error);
        }
      },
      query(principal: AuthenticatedClient): MaintenanceSnapshot {
        try {
          return readMaintenance(principal);
        } catch (error) {
          throw requestError(principal, error);
        }
      },
    });

    const listenerOptions = {
      store: opened,
      config: () => configured.workerConfig,
      submissionLimits: configured.submissionLimits,
      runnerLimits: configured.runnerLimits,
      transportLimits: configured.transportLimits,
      selfTest,
      maintenance,
      // Bounded admission can queue behind a known busy execution slot.
      ready: () => canRunOrdinary(true),
      onJobCommitted: () => {
        if (!closing) {
          const pending = activeRunner.wake();
          rememberClaim();
          return pending;
        }
      },
    };
    let listeningServer: Awaited<ReturnType<typeof listenEnhancementServer>>;
    try {
      listeningServer = await (transport
        ? listenEnhancementTlsServer(listenerOptions, configured.port, transport)
        : listenEnhancementServer(
            listenerOptions,
            configured.port,
            configured.host,
          ));
    } catch (error) {
      listenerBindFailed = !!error && typeof error === "object" &&
        "code" in error && error.code === "EADDRINUSE";
      throw error;
    }
    server = listeningServer;
    listenerSucceeded = true;
    ensureOpen();
    const fileIo: HttpFileIoOwner = listeningServer.fileIo;
    if (startupObserver) {
      await observeStartup("listening");
      ensureOpen();
    }

    function shutdown(requestedDeadlineAt?: number): Promise<"closed" | "unknown"> {
      if (shutdownPromise) return shutdownPromise;
      if (closing) return (shutdownPromise = Promise.resolve("unknown"));
      let resolve!: (value: "closed" | "unknown") => void;
      shutdownPromise = new Promise((done) => { resolve = done; });
      const result = shutdownPromise;
      const startedAt = performance.now();
      const validCutoff = requestedDeadlineAt === undefined ||
        (typeof requestedDeadlineAt === "number" && Number.isFinite(requestedDeadlineAt));
      // Main can spend part of this same window waiting for the one original runtime.
      const deadlineAt = !validCutoff ? startedAt :
        Math.min(startedAt + 25_000, requestedDeadlineAt ?? startedAt + 25_000);
      const deadline = new AbortController();
      let expire!: () => void;
      const expired = new Promise<never>((_, reject) => {
        expire = () => reject(new EnhancementError("not_ready"));
      });
      // A single clock covers resource joins, pending work and the independent reader.
      const timer = setTimeout(() => { deadline.abort(); expire(); }, Math.max(0, deadlineAt - startedAt));
      void expired.catch(() => {});
      const within = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, expired]);
      const ownsOriginal = () => !options.signal.aborted &&
        store === opened && !opened.closed && runner === activeRunner &&
        adapter === executor && server === listeningServer && listeningServer.fileIo === fileIo;
      let failed = !validCutoff || deadlineAt <= startedAt;
      let active: ActiveAttempt | undefined;
      let context: WindowsJournalReadContext | undefined;
      let idle = false;
      try {
        const counts = opened.inspectMaintenance();
        const execution = activeRunner.status();
        const native = executor.status();
        if (!ownsOriginal() || startupRecovery !== "settled" || execution.closed || execution.storeClosed ||
          execution.recoveryInFlight || execution.recoveryState !== "idle" || native.sealed || native.close !== "not_requested")
          throw new EnhancementError("not_ready");
        idle = counts.slots === 0 && counts.running === 0 && execution.ownedState === "none" && native.activity === "idle";
        if (!idle && counts.slots === 1 && counts.running === 1 && lastPrepared) {
          active = opened.getActiveAttempt(lastPrepared.identity);
          if (!active || active.launchTicket !== lastPrepared.launchTicket ||
            active.executionPolicy.fingerprint !== lastPrepared.executionPolicyFingerprint ||
            !isDeepStrictEqual(active.producer, lastPrepared.identity) ||
            active.preparedAt === null || active.authorizedAt === null || !active.ownerDescriptor)
            throw new EnhancementError("not_ready");
          context = freezeWindowsJournalReadContext({
            target: { identity: active.producer, launchTicket: active.launchTicket },
            executionPolicyFingerprint: active.executionPolicy.fingerprint,
          }, active.ownerDescriptor);
        }
        if (!idle && !context) throw new EnhancementError("not_ready");
      } catch { failed = true; }
      closing = true;
      maintenanceSealed = true;
      revokeQualification();
      try { fileIo.sealFileIo(); } catch { failed = true; }
      // This call fixes controller-loss synchronously before Runner abort can choose ordinary close.
      let interruption: Promise<"closed" | "unknown">;
      try { interruption = executor.interrupt(); }
      catch { failed = true; interruption = Promise.resolve("unknown"); }
      let runnerClosed: Promise<void>;
      try { runnerClosed = activeRunner.close(); }
      catch { failed = true; runnerClosed = Promise.resolve(); }
      try { operation?.controller.abort(); } catch { failed = true; }
      const listenerClosed = new Promise<void>((done, reject) => {
        try { listeningServer.close((error) => error ? reject(error) : done()); }
        catch (error) { reject(error); }
      });
      try { listeningServer.closeAllConnections(); } catch { failed = true; }
      function drained(): boolean {
        if (!ownsOriginal() || startupRecovery !== "settled") return false;
        const http = fileIo.activity();
        const counts = opened.inspectMaintenance();
        const execution = activeRunner.status();
        const native = executor.status();
        return http.sealed && http.uploads === 0 && http.downloads === 0 && http.receipts === 0 &&
          maintenanceCount(fileIo.pendingRequests()) === 0 &&
          counts.unreleasedReferences === 0 && selfTestAdmission === 0 && selfTestOutputRead === 0 &&
          maintenanceCount(activeRunner.pendingWork()) === 0 && maintenanceCount(executor.pendingWork()) === 0 &&
          execution.closed && !execution.storeClosed && !execution.recoveryInFlight &&
          execution.recoveryState === "idle" && native.sealed && native.close === "closed";
      }
      function unchangedScope(): boolean {
        if (!ownsOriginal() || deadline.signal.aborted || performance.now() >= deadlineAt) return false;
        const counts = opened.inspectMaintenance();
        return active ? counts.slots === 1 && counts.running === 1 &&
          isDeepStrictEqual(opened.getActiveAttempt(active.identity), active) :
          idle && counts.slots === 0 && counts.running === 0;
      }
      async function finish(): Promise<"closed" | "unknown"> {
        let reader: WindowsJournalLauncher | undefined;
        let readerClosed = true;
        try {
          const [cleanup] = await within(Promise.all([interruption, runnerClosed, listenerClosed]));
          if (cleanup !== "closed" || failed) return "unknown";
          while (!drained()) {
            if (!ownsOriginal()) return "unknown";
            await within(delay(10, undefined, { signal: deadline.signal }));
          }
          if (!unchangedScope()) return "unknown";
          if (context) {
            const remaining = Math.floor(deadlineAt - performance.now());
            if (remaining < 2) return "unknown";
            const cleanupTimeoutMs = Math.min(configured.journalLimits.cleanupTimeoutMs, Math.floor(remaining / 2));
            reader = createWindowsJournalLauncher({
              executablePath: configured.bridge.helperPath,
              recordsRoot: configured.bridge.recordsRoot,
              environment: configured.bridge.environment,
              limits: { ...configured.journalLimits, cleanupTimeoutMs,
                readTimeoutMs: Math.min(configured.journalLimits.readTimeoutMs, remaining - cleanupTimeoutMs) },
            });
            let verified = false;
            try {
              const proof = await within(reader.read(context.scope, context.descriptor, deadline.signal, unchangedScope));
              if (proof.kind === "read" && proof.cleanup === "closed" && proof.interpretation.kind !== "unknown") {
                const exit = proof.interpretation.exit;
                verified = exit.treeExited === true && isDeepStrictEqual(exit.identity, context.scope.target.identity) &&
                  exit.launchTicket === context.scope.target.launchTicket && isDeepStrictEqual(exit.descriptor, context.descriptor);
              }
            } finally {
              readerClosed = await within(reader.close()) === "closed";
            }
            if (!verified || !readerClosed) return "unknown";
          }
          if (!drained() || !unchangedScope()) return "unknown";
          opened.close();
          if (!opened.closed) return "unknown";
          options.signal.removeEventListener("abort", close);
          store = undefined;
          runner = undefined;
          adapter = undefined;
          server = undefined;
          return "closed";
        } catch { return "unknown"; }
        finally { clearTimeout(timer); }
      }
      void finish().then(resolve, () => resolve("unknown"));
      return result;
    }

    function readMaintenance(
      principal: AuthenticatedClient,
      sealFailed = false,
    ): MaintenanceSnapshot {
      assertRequest(principal);
      const sealedBefore = maintenanceSealed;
      const recoveryBefore = startupRecovery;
      const admissionBefore = selfTestAdmission;
      const outputBefore = selfTestOutputRead;
      let unreliable = sealFailed;
      const take = <T>(read: () => T): T | null => {
        try {
          return read();
        } catch {
          unreliable = true;
          return null;
        }
      };
      const ownsOriginal = () => {
        try {
          return (
            !closing &&
            !options.signal.aborted &&
            store === opened &&
            !opened.closed &&
            runner === activeRunner &&
            adapter === executor &&
            server === listeningServer &&
            listeningServer.fileIo === fileIo
          );
        } catch {
          return false;
        }
      };
      if (!ownsOriginal()) unreliable = true;
      const readHttp = (): HttpFileIoActivity => {
        const value = record(fileIo.activity(), [
          "sealed",
          "uploads",
          "downloads",
          "receipts",
        ]);
        if (typeof value.sealed !== "boolean")
          throw new EnhancementError("internal_error");
        return Object.freeze({
          sealed: value.sealed,
          uploads: maintenanceCount(value.uploads),
          downloads: maintenanceCount(value.downloads),
          receipts: maintenanceCount(value.receipts),
        });
      };
      const httpBefore = take(readHttp);
      const counts = take((): StoreMaintenanceCounts => {
        const value = record(opened.inspectMaintenance(), [
          "queued",
          "running",
          "slots",
          "unreleasedReferences",
        ]);
        const result = Object.freeze({
          queued: maintenanceCount(value.queued),
          running: maintenanceCount(value.running),
          slots: maintenanceCount(value.slots),
          unreleasedReferences: maintenanceCount(value.unreleasedReferences),
        });
        if (result.slots > 1) throw new EnhancementError("internal_error");
        return result;
      });
      let pending = take(() => {
        const admission = maintenanceCount(selfTestAdmission);
        const outputRead = maintenanceCount(selfTestOutputRead);
        if (admission > 1 || outputRead > 1)
          throw new EnhancementError("internal_error");
        return Object.freeze({
          selfTestAdmission: admission,
          selfTestOutputRead: outputRead,
          runner: maintenanceCount(activeRunner.pendingWork()),
          adapter: maintenanceCount(executor.pendingWork()),
        });
      });
      const runtime = take((): WindowsWorkerStatus => {
        const execution = record(activeRunner.status(), [
          "closed",
          "storeClosed",
          "recoveryState",
          "recoveryInFlight",
          "ownedState",
        ]);
        const native = record(
          executor.status(),
          ["sealed", "activity", "close"],
          ["runtimeObservation", "prepareDiagnostic"],
        );
        if (
          typeof execution.closed !== "boolean" ||
          typeof execution.storeClosed !== "boolean" ||
          typeof execution.recoveryInFlight !== "boolean" ||
          ![
            "idle",
            "inspecting",
            "owned-alive",
            "unknown",
            "awaiting-artifacts",
          ].includes(execution.recoveryState as string) ||
          !["none", "busy", "unknown"].includes(
            execution.ownedState as string,
          ) ||
          typeof native.sealed !== "boolean" ||
          !["idle", "busy", "unknown", "cleanup_unknown"].includes(
            native.activity as string,
          ) ||
          !["not_requested", "pending", "closed", "unknown"].includes(
            native.close as string,
          )
        )
          throw new EnhancementError("internal_error");
        return Object.freeze({
          closing,
          startupRecovery,
          runner: Object.freeze({
            closed: execution.closed,
            storeClosed: execution.storeClosed,
            recoveryState:
              execution.recoveryState as RunnerStatus["recoveryState"],
            recoveryInFlight: execution.recoveryInFlight,
            ownedState: execution.ownedState as RunnerStatus["ownedState"],
          }),
          adapter: Object.freeze({
            sealed: native.sealed,
            activity: native.activity as WindowsExecutionStatus["activity"],
            close: native.close as WindowsExecutionStatus["close"],
            ...(Object.hasOwn(native, "prepareDiagnostic")
              ? { prepareDiagnostic: freezeWindowsPrepareDiagnostic(native.prepareDiagnostic) }
              : {}),
          }),
        });
      });
      const httpAfter = take(readHttp);
      let http = httpBefore;
      if (
        !httpBefore ||
        !httpAfter ||
        httpBefore.sealed !== httpAfter.sealed ||
        httpBefore.uploads !== httpAfter.uploads ||
        httpBefore.downloads !== httpAfter.downloads ||
        httpBefore.receipts !== httpAfter.receipts
      ) {
        unreliable = true;
        http = null;
      }
      // Authorization and the original owners must still hold after every
      // external read. A nested enter/close cannot publish a stale stop verdict.
      assertRequest(principal);
      const runnerAfter = take(() =>
        maintenanceCount(activeRunner.pendingWork()),
      );
      const adapterAfter = take(() => maintenanceCount(executor.pendingWork()));
      if (
        !pending ||
        runnerAfter !== pending.runner ||
        adapterAfter !== pending.adapter
      ) {
        unreliable = true;
        pending = null;
      }
      assertRequest(principal);
      if (
        !ownsOriginal() ||
        maintenanceSealed !== sealedBefore ||
        startupRecovery !== recoveryBefore ||
        selfTestAdmission !== admissionBefore ||
        selfTestOutputRead !== outputBefore ||
        http?.sealed !== maintenanceSealed
      )
        unreliable = true;
      const unknown =
        unreliable ||
        !counts ||
        !http ||
        !pending ||
        !runtime ||
        runtime.closing ||
        runtime.startupRecovery !== "settled" ||
        runtime.runner.closed ||
        runtime.runner.storeClosed ||
        runtime.runner.recoveryState === "unknown" ||
        runtime.runner.ownedState === "unknown" ||
        runtime.adapter.sealed ||
        runtime.adapter.close !== "not_requested" ||
        runtime.adapter.activity === "unknown" ||
        runtime.adapter.activity === "cleanup_unknown";
      if (unknown) revokeQualification();
      const canStop = !!(
        !unknown &&
        maintenanceSealed &&
        http?.sealed &&
        runtime?.runner.recoveryState === "idle" &&
        !runtime.runner.recoveryInFlight &&
        runtime.runner.ownedState === "none" &&
        runtime.adapter.activity === "idle" &&
        counts?.running === 0 &&
        counts.slots === 0 &&
        counts.unreleasedReferences === 0 &&
        http.uploads === 0 &&
        http.downloads === 0 &&
        http.receipts === 0 &&
        pending?.selfTestAdmission === 0 &&
        pending.selfTestOutputRead === 0 &&
        pending.runner === 0 &&
        pending.adapter === 0
      );
      return Object.freeze({
        bootId,
        sealed: maintenanceSealed,
        state: unknown
          ? "unknown"
          : !maintenanceSealed
            ? "open"
            : canStop
              ? "quiescent"
              : "draining",
        canStop,
        store: counts,
        http,
        pending,
        runtime,
      });
    }

    try {
      recoveryCalled = true;
      void activeRunner.recover().then(
        () => {
          startupRecovery = "settled";
        },
        () => {
          startupRecovery = "failed";
          console.error("enhancement_recovery_failed");
        },
      );
    } catch {
      startupRecovery = "failed";
      console.error("enhancement_recovery_failed");
    }
    ensureOpen();
    return Object.freeze({
      server,
      status(): WindowsWorkerStatus {
        try {
          const execution = activeRunner.status();
          const native = executor.status();
          if (runtimeUnknown(execution, native)) revokeQualification();
          return Object.freeze({
            closing,
            startupRecovery,
            runner: execution,
            adapter: native,
          });
        } catch (error) {
          revokeQualification();
          throw error;
        }
      },
      close,
      shutdown,
      selfTest,
      maintenance,
    });
  } catch (error) {
    close();
    if (startupObserver) {
      const phase = error instanceof StoreSchemaVersionMismatch &&
          !runnerConstructed && !listenerSucceeded && !recoveryCalled
        ? "store_schema_incompatible"
        : listenerBindFailed && !listenerSucceeded && !recoveryCalled
          ? "listener_bind_failed"
          : "unknown";
      try { await observeStartup(phase); } catch {}
    }
    throw safeError(error);
  }
}
