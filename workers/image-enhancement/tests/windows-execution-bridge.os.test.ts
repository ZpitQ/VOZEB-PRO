import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { freezeExecutionPolicy } from "../src/execution.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import { runnerLimits, submissionLimits } from "./storage-fixtures.js";
import { configInput } from "./fixtures.js";
import { transportLimits } from "./http-fixtures.js";
import { interpretWindowsJournalSnapshot } from "../src/windows-journal-reader.js";
import type { OwnerDescriptor } from "../src/execution.js";
import { claimedAttempt } from "./windows-prepare-payload-fixtures.js";

type Value = Record<string, unknown>;
type Metadata = Pick<
  ReturnType<typeof claimedAttempt>,
  | "firstStartedAt"
  | "executionDeadlineAt"
  | "inputPath"
  | "outputPath"
  | "workingDirectory"
> & {
  target: Pick<ReturnType<typeof claimedAttempt>, "identity" | "launchTicket">;
  engine: ReturnType<typeof claimedAttempt>["job"]["plan"]["engine"];
};
const fixtureExe = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_SESSION_FIXTURE_EXE;
const bridgeExe = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_EXE;
const ordinaryExe = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_ORDINARY_EXE;
const faultExe =
  process.env.ZEB_WINDOWS_EXECUTION_SUPERVISOR_TEST_EXE ?? ordinaryExe;
const requested =
  process.env.ZEB_RUN_WINDOWS_CONTROL_BRIDGE_OS === "1" ||
  fixtureExe !== undefined;
const suite = requested ? describe : describe.skip;
// Existing explicit outer-fixture observation policy, never product defaults.
const executionMs = 60_000;
const cleanupMs = 15_000;
const testMs = executionMs + cleanupMs + 5_000;
const captureLimit = 4 * 1_048_576;
let evidenceRoot: string;

async function identities(workerDiagnostic = false) {
  return Promise.all(
    [
      fixtureExe!,
      bridgeExe!,
      ordinaryExe!,
      faultExe!,
      join(dirname(faultExe!), "WindowsSupervisor.dll"),
      join(dirname(fixtureExe!), "WindowsSessionFixture.dll"),
      join(dirname(bridgeExe!), "WindowsControlBridge.dll"),
      join(dirname(ordinaryExe!), "WindowsSupervisor.dll"),
      ...(workerDiagnostic ? [resolve(import.meta.dirname, "fixtures/windows-worker-prepare-diagnostic.mjs"),
        ...["bootstrap", "windows-execution-adapter", "windows-control-bridge-host", "windows-control-bridge-protocol",
          "runner", "store", "http", "credentials", "config", "contracts", "jobs", "image-io", "artifacts"]
          .map((name) => resolve(import.meta.dirname, "../dist", name + ".js"))] : []),
    ].map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    })),
  );
}

async function exercise(
  directory: string,
  scenario = "execution-prepare",
  adapterMode = false,
) {
  const workerDiagnostic = scenario === "execution-node-worker-prepare-installation-denied";
  const artifactsBefore = await identities(workerDiagnostic);
  const child = spawn(
    fixtureExe!,
    [
      "bridge-outer",
      bridgeExe!,
      ordinaryExe!,
      faultExe!,
      directory,
      String(executionMs),
      String(cleanupMs),
    ],
    {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ZEB_WINDOWS_EXECUTION_ADAPTER_READER_PIN: adapterMode ? "1" : "0",
        ZEB_WINDOWS_EXECUTION_NODE_EXE: process.execPath,
        ZEB_WINDOWS_EXECUTION_NODE_RUNNER: resolve(
          import.meta.dirname,
          adapterMode
            ? "fixtures/windows-execution-adapter-runner.mjs"
            : "fixtures/windows-execution-bridge-runner.mjs",
        ),
        ZEB_WINDOWS_EXECUTION_HOST_MODULE: resolve(
          import.meta.dirname,
          "../dist/windows-control-bridge-host.js",
        ),
      },
    },
  );
  const frames: Value[] = [];
  const failures: string[] = [];
  const events: string[] = [];
  const output: Buffer[] = [];
  const errorOutput: Buffer[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let captureBytes = 0;
  let stdoutEof = false;
  let stderrEof = false;
  let readySeen = false;
  let metadataSeen = false;
  let receipt: Value | undefined;
  let request: ReturnType<typeof freezeWindowsPrepareRequest> | undefined;
  let adapterAttempt: ReturnType<typeof claimedAttempt> | undefined;
  let attemptSidecar:
    { path: string; sha256: string; bytesBase64: string } | undefined;
  let outerExit:
    { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const fail = (error: unknown) =>
    failures.push(error instanceof Error ? error.message : "unknown-error");
  const sent = (error?: Error | null) => {
    if (error) fail(error);
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);
  child.stdin.on("finish", () => events.push("stdin-finish"));
  child.stdin.on("close", () => events.push("stdin-close"));
  child.stdout.on("close", () => events.push("stdout-close"));
  child.stderr.on("close", () => events.push("stderr-close"));
  child.on("spawn", () => events.push("spawn"));
  child.on("exit", (code, signal) => {
    outerExit = { code, signal };
    events.push("exit");
  });
  child.stdout.on("data", (bytes: Buffer) => {
    try {
      captureBytes += bytes.length;
      if (captureBytes > captureLimit)
        throw new Error("execution-outer-capture-overflow");
      output.push(Buffer.from(bytes));
      pending += decoder.decode(bytes, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const frame = JSON.parse(
          pending.slice(0, newline).replace(/\r$/, ""),
        ) as Value;
        pending = pending.slice(newline + 1);
        frames.push(frame);
        if (frame.kind === "outer-ready") {
          if (readySeen) throw new Error("duplicate-outer-ready");
          readySeen = true;
          child.stdin.write(`${JSON.stringify({ scenario })}\n`, sent);
        } else if (frame.kind === "outer-metadata") {
          if (!readySeen || metadataSeen)
            throw new Error("unexpected-outer-metadata");
          metadataSeen = true;
          const metadata = frame.value as Metadata;
          const base = claimedAttempt();
          const attempt = {
            ...base,
            ...metadata.target,
            executionPolicy: freezeExecutionPolicy(runnerLimits, [32]),
            firstStartedAt: metadata.firstStartedAt,
            executionDeadlineAt: metadata.executionDeadlineAt,
            inputPath: metadata.inputPath,
            workingDirectory: metadata.workingDirectory,
            outputPath: metadata.outputPath,
            tile: metadata.engine.tile,
            job: {
              ...base.job,
              jobId: metadata.target.identity.jobId,
              plan: { ...base.job.plan, engine: metadata.engine },
            },
          };
          request = freezeWindowsPrepareRequest(attempt);
          if (scenario === "execution-node-worker-prepare-installation-denied") {
            const original = configInput();
            const workerConfig = { ...original, models: [{ ...metadata.engine, id: metadata.engine.modelId,
              allowedTiles: [32], defaultTile: 32 }], budgets: { ...original.budgets,
                delivery: { ...original.budgets.delivery, maxPixels: 5016 * 5016 } } };
            // Copy only model contract fields; the native selected engine also contains per-attempt tile.
            const model = workerConfig.models[0]!;
            const { modelId: _modelId, tile: _tile, ...configuredModel } = model;
            writeFileSync(join(directory, "worker-diagnostic-input.json"), JSON.stringify({
              workerConfig: { ...workerConfig, models: [configuredModel] }, runnerLimits, submissionLimits, transportLimits,
              calibrationRoot: resolve(import.meta.dirname, "../resources/calibration"),
            }), { flag: "wx" });
          }
          if (adapterMode) {
            adapterAttempt = attempt;
            const bytes = Buffer.from(`${JSON.stringify(attempt)}\n`, "utf8");
            const path = join(directory, "node-adapter-attempt.json");
            // Keep this exact complete attempt before the original carrier is sent.
            writeFileSync(path, bytes, { flag: "wx" });
            attemptSidecar = {
              path,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              bytesBase64: bytes.toString("base64"),
            };
          }
          // This closes only the outer caller input after its exact two frames.
          child.stdin.end(`${JSON.stringify(request)}\n`, sent);
        } else if (frame.kind === "outer-receipt") {
          if (receipt !== undefined) throw new Error("duplicate-outer-receipt");
          receipt = frame.value as Value;
        }
      }
    } catch (error) {
      fail(error);
    }
  });
  child.stdout.on("end", () => {
    try {
      pending += decoder.decode();
      if (pending.length !== 0) throw new Error("outer-partial-eof");
      stdoutEof = true;
      events.push("stdout-eof");
    } catch (error) {
      fail(error);
    }
  });
  child.stderr.on("data", (bytes: Buffer) => {
    captureBytes += bytes.length;
    if (captureBytes <= captureLimit) errorOutput.push(Buffer.from(bytes));
    else fail(new Error("execution-outer-capture-overflow"));
  });
  child.stderr.on("end", () => {
    stderrEof = true;
    events.push("stderr-eof");
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outerClose:
    { code: number | null; signal: NodeJS.Signals | null } | undefined;
  try {
    outerClose = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("execution-outer-observation-expired")),
        executionMs + cleanupMs,
      );
      child.once("close", (code, signal) => {
        events.push("child-close");
        resolve({ code, signal });
      });
    });
  } catch (error) {
    fail(error);
  } finally {
    clearTimeout(timer);
    if (!child.stdin.writableEnded) child.stdin.end();
  }
  const evidence = {
    node: process.version,
    libuv: process.versions.uv,
    artifactsBefore,
    artifactsAfter: await identities(workerDiagnostic),
    request,
    ...(adapterMode ? { adapterAttempt, attemptSidecar } : {}),
    receipt,
    frames,
    outerExit,
    outerClose,
    stdoutEof,
    stderrEof,
    events,
    failures,
    outerStdoutBase64: Buffer.concat(output).toString("base64"),
    outerStderrBase64: Buffer.concat(errorOutput).toString("base64"),
    captureLimit,
    captureBytes,
    scenario,
  };
  await writeFile(
    join(directory, "execution-bridge-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: "wx" },
  );
  return evidence;
}

suite("real original product bridge execution", () => {
  beforeAll(async () => {
    if (process.platform !== "win32")
      throw new Error("Explicit Windows execution fixture required");
    for (const path of [fixtureExe, bridgeExe, ordinaryExe, faultExe]) {
      if (!path || !isAbsolute(path))
        throw new Error("Explicit fixed native artifact required");
      await access(path);
    }
    evidenceRoot =
      process.env.ZEB_WINDOWS_CONTROL_BRIDGE_EVIDENCE_DIR ??
      (await mkdtemp(join(tmpdir(), "zeb-execution-bridge-")));
    await mkdir(evidenceRoot, { recursive: true });
  });

  it.each(["natural", "stop-soft"])(
    "runs the actual Windows ExecutionAdapter through original native %s",
    async (name) => {
      const directory = await mkdtemp(
        join(evidenceRoot, `adapter-${name}-商品's 🙂-`),
      );
      const evidence = await exercise(
        directory,
        `execution-node-${name}`,
        true,
      );
      expect(evidence.failures).toEqual([]);
      expect(evidence.outerExit).toEqual({ code: 0, signal: null });
      expect(evidence.outerClose).toEqual(evidence.outerExit);
      expect(evidence.stdoutEof && evidence.stderrEof).toBe(true);
      expect(evidence.outerStderrBase64).toBe("");
      expect(evidence.artifactsAfter).toEqual(evidence.artifactsBefore);
      const outer = evidence.receipt!.outer as Value;
      const host = evidence.receipt!.host as Value;
      expect(outer).toMatchObject({
        primaryFailure: null,
        forcedFallback: false,
        protocolErrors: [],
        guard: {
          activeProcesses: 0,
          allObservedJoined: true,
          membershipVerified: true,
        },
      });
      expect(host).toMatchObject({
        setupFailure: null,
        failure: null,
        cleanup: { failures: [], allObservedJoined: true },
      });
      const values = host.values as Value;
      const result = values.nodeResult as Value;
      const bound = values.bound as Value;
      const descriptor = values.descriptor as OwnerDescriptor;
      const details = descriptor.details as Value;
      expect(values).toMatchObject({
        bridgeLaunches: 1,
        fixtureHelperLaunches: 0,
        markerPresent: true,
        helper: { identity: bound.helper, exitCode: 0, originalJoined: true },
        bridge: { identity: bound.bridge, exitCode: 0, originalJoined: true },
        child: {
          originalRetained: true,
          originalJoined: true,
          alive: false,
          forced: false,
          exitCode: 0,
          stdout: { actualEof: true, error: null, overflow: false },
          stderr: { actualEof: true, error: null, overflow: false },
        },
      });
      expect(result).toMatchObject({
        adapter: true,
        prepareResult: { kind: "prepared", descriptor },
        authorizationResult: { kind: "authorized" },
        preparePermits: 1,
        authPermits: 1,
        markerAfterPrepare: false,
        closeResult: "closed",
        allChildSpawnCount: 2,
        callbackCount: 1,
        observerErrors: [],
        factsScope: "original-node-child-and-stream-events",
      });
      expect(Object.hasOwn(result, "failure")).toBe(false);
      expect(values.carrier).toEqual(evidence.request);
      expect(freezeWindowsPrepareRequest(evidence.adapterAttempt!)).toEqual(
        evidence.request,
      );
      const attemptBytes = await readFile(evidence.attemptSidecar!.path);
      expect(attemptBytes.toString("base64")).toBe(
        evidence.attemptSidecar!.bytesBase64,
      );
      expect(createHash("sha256").update(attemptBytes).digest("hex")).toBe(
        evidence.attemptSidecar!.sha256,
      );
      expect(JSON.parse(attemptBytes.toString("utf8"))).toEqual(
        evidence.adapterAttempt,
      );
      const originalSpec = JSON.parse(
        Buffer.from(evidence.request!.requestUtf8Base64, "base64").toString(
          "utf8",
        ),
      ) as {
        target: Parameters<typeof interpretWindowsJournalSnapshot>[1]["target"];
        executionPolicy: {
          fingerprint: string;
          limits: { executionTimeoutMs: number; cancelGraceMs: number };
        };
        firstStartedAt: number;
        executionDeadlineAt: number;
      };
      const scope = {
        target: originalSpec.target,
        executionPolicyFingerprint: originalSpec.executionPolicy.fingerprint,
      };
      const configPath = join(directory, "node-host.json");
      const configBytes = await readFile(configPath);
      const config = JSON.parse(configBytes.toString("utf8")) as Value;
      const suppliedBridge = config.options as Value;
      const suppliedLimits = suppliedBridge.limits as Value;
      const proof = result.inputProof as Value;
      expect(proof).toMatchObject({
        attemptPath: evidence.attemptSidecar!.path,
        attemptSha256: evidence.attemptSidecar!.sha256,
        attemptBytesBase64: evidence.attemptSidecar!.bytesBase64,
        configPath,
        configSha256: createHash("sha256").update(configBytes).digest("hex"),
        carrier: evidence.request,
        originalPolicy: originalSpec.executionPolicy,
        firstStartedAt: originalSpec.firstStartedAt,
        executionDeadlineAt: originalSpec.executionDeadlineAt,
      });
      expect(config.request).toEqual(evidence.request);
      expect(config.expected).toEqual(scope);
      expect(proof.moduleArtifacts).toEqual(
        await Promise.all(
          ["windows-execution-adapter.js", "windows-prepare-payload.js"].map(
            async (file) => {
              const path = resolve(import.meta.dirname, "../dist", file);
              return {
                path,
                sha256: createHash("sha256")
                  .update(await readFile(path))
                  .digest("hex"),
              };
            },
          ),
        ),
      );
      const transport = result.transport as Value;
      const effectiveBridge = transport.effectiveBridge as Value;
      expect(transport).toEqual({
        source: "explicit-test-only-transport-configuration",
        receivedBridge: suppliedBridge,
        effectiveBridge: {
          ...suppliedBridge,
          limits: { ...suppliedLimits, sessionTimeoutMs: 70_000 },
        },
        journalLimits: {
          maxRequestBytes: 4 * 1_048_576,
          maxStdoutBytes: 1_048_576,
          maxStderrBytes: 65_536,
          readTimeoutMs: 60_000,
          cleanupTimeoutMs: 5_000,
        },
        requiredSessionTimeoutMs: 70_000,
      });
      expect(suppliedLimits.sessionTimeoutMs).toBe(45_000);
      expect(originalSpec.executionPolicy.limits).toMatchObject({
        executionTimeoutMs: 60_000,
        cancelGraceMs: 5_000,
      });
      expect(suppliedLimits.cleanupTimeoutMs).toBe(5_000);
      expect([executionMs, cleanupMs, testMs]).toEqual([
        60_000, 15_000, 80_000,
      ]);
      const facts = result.factsAtReturn as Value;
      const journalFacts = result.journalFacts as Value;
      const reader = values.reader as Value;
      const gate = result.readerInputGate as Value;
      expect(reader).toEqual({
        role: "journal-reader",
        identity: gate.identity,
        originalJoined: true,
        alive: false,
        exitCode: 0,
        nonInherited: true,
        sameSid: true,
        adopted: true,
        registrationSource: "original-reader-job-notification",
        originalNotificationRetained: true,
        independentCreationPin: false,
      });
      expect((reader.identity as Value).pid).toBe(journalFacts.originalPid);
      expect(gate).toEqual({
        candidatePid: journalFacts.originalPid,
        heldCount: 1,
        releaseCount: 1,
        originalEndInvocations: 1,
        state: "released",
        savedThisIsOriginalStdin: true,
        savedArgumentCount: 2,
        bufferReferencePreserved: true,
        callbackReferencePreserved: true,
        observedEndReturnIsOriginalStdin: true,
        identity: reader.identity,
      });
      const readerStages = values.readerStages as Value[];
      expect(readerStages.map((row) => row.sequence)).toEqual([0, 1, 2, 3]);
      expect(readerStages.map((row) => row.stage)).toEqual([
        "held-observed",
        "original-handle-adopted",
        "release-send-started",
        "release-send-completed",
      ]);
      for (const row of readerStages.slice(1))
        expect(row.identity).toEqual(reader.identity);
      const heldFrames = (values.frames as Value[]).filter(
        (frame) => frame.kind === "node-reader-input-held",
      );
      expect(heldFrames).toEqual([
        {
          kind: "node-reader-input-held",
          candidatePid: journalFacts.originalPid,
          executionId: descriptor.executionId,
          requestFingerprint: evidence.request!.requestFingerprint,
        },
      ]);
      const sentControls = (
        (values.child as Value).sentFramesBase64 as string[]
      ).map(
        (bytes) =>
          JSON.parse(Buffer.from(bytes, "base64").toString("utf8")) as Value,
      );
      expect(
        sentControls.filter((row) => row.command === "release-reader-input"),
      ).toEqual([
        {
          command: "release-reader-input",
          identity: reader.identity,
          executionId: descriptor.executionId,
          requestFingerprint: evidence.request!.requestFingerprint,
        },
      ]);
      const callbacks = result.callbacks as Value[];
      expect(callbacks).toHaveLength(1);
      const callback = callbacks[0]!;
      expect(callback).toMatchObject({
        frozen: true,
        identityFrozen: true,
        descriptorFrozen: true,
        prepareCurrent: false,
        authorizeCurrent: false,
        completionOwn: name === "natural",
      });
      for (const observed of [
        facts,
        journalFacts,
        callback.factsAtCallback as Value,
        callback.journalFactsAtCallback as Value,
      ]) {
        expect(observed).toMatchObject({
          spawnCount: 1,
          originalObjectRetained: true,
          exit: { code: 0, signal: null },
          close: { code: 0, signal: null },
          stdoutEof: true,
          stderrEof: true,
          stdinClose: true,
          stdoutClose: true,
          stderrClose: true,
          stdinFinish: true,
          endCalls: 1,
          endCallbacks: 1,
          stderrBytes: 0,
          stderrBase64: "",
          writeErrors: 0,
          killCalls: 0,
          errors: [],
        });
        expect(observed.writeCallbacks).toBe(observed.writeCalls);
      }
      expect(facts.detachedRequested).toBe(true);
      expect(facts.originalPid).toBe((bound.bridge as Value).pid);
      expect(journalFacts.detachedRequested).toBe(true);
      expect(journalFacts.originalPid).not.toBe(facts.originalPid);
      const bridgeInvocation = facts.invocation as Value;
      const journalInvocation = journalFacts.invocation as Value;
      const bridgeArgs = bridgeInvocation.arguments as string[];
      expect(bridgeInvocation.executablePath).toBe(bridgeExe);
      expect(bridgeArgs).toHaveLength(2);
      expect(bridgeArgs[0]).toBe("--control-bridge");
      expect(JSON.parse(bridgeArgs[1]!)).toEqual({
        v: 1,
        helperPath: effectiveBridge.helperPath,
        recordsRoot: effectiveBridge.recordsRoot,
        installationRoot: effectiveBridge.installationRoot,
        expectedManifestSha256: effectiveBridge.expectedManifestSha256,
        environment: effectiveBridge.environment,
        limits: effectiveBridge.limits,
      });
      expect(effectiveBridge.helperPath).toBe(ordinaryExe);
      expect(journalInvocation.executablePath).toBe(effectiveBridge.helperPath);
      expect(journalInvocation.arguments).toEqual([
        "--read-records",
        effectiveBridge.recordsRoot,
      ]);
      for (const invocation of [bridgeInvocation, journalInvocation])
        expect(invocation.options).toMatchObject({
          cwd: dirname(invocation.executablePath as string),
          env: effectiveBridge.environment,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      const input = (facts.input as string[]).map((base64) => {
        const bytes = Buffer.from(base64, "base64");
        expect(bytes.at(-1)).toBe(10);
        expect(bytes.includes(13)).toBe(false);
        return JSON.parse(bytes.toString("utf8")) as Value;
      });
      const operations =
        name === "natural"
          ? ["prepare", "authorize"]
          : ["prepare", "authorize", "request-stop"];
      const commands = input.filter((frame) => frame.kind === "command");
      expect(commands.map((frame) => frame.op)).toEqual(operations);
      expect(commands[0]).toMatchObject(evidence.request!);
      for (const command of commands) {
        expect(command.executionId).toBe(descriptor.executionId);
        expect(
          input.filter(
            (frame) =>
              frame.kind === "permit" &&
              frame.requestId === command.requestId &&
              frame.op === command.op &&
              frame.allow === true,
          ),
        ).toHaveLength(1);
      }
      expect(input).toHaveLength(operations.length * 2);
      const frames = facts.frames as { rawBase64: string; frame: Value }[];
      for (const row of frames) {
        const raw = Buffer.from(row.rawBase64, "base64");
        expect(raw.at(-1)).toBe(10);
        expect(raw.includes(13)).toBe(false);
        expect(JSON.parse(raw.toString("utf8"))).toEqual(row.frame);
      }
      expect(
        Buffer.concat(
          frames.map((row) => Buffer.from(row.rawBase64, "base64")),
        ).toString("base64"),
      ).toBe(facts.stdoutBase64);
      expect(
        frames
          .filter((row) => row.frame.kind === "bound")
          .map((row) => row.frame),
      ).toEqual([{ v: 1, kind: "bound", ...bound }]);
      expect(
        frames
          .filter((row) => row.frame.kind === "permit-request")
          .map((row) => row.frame.op),
      ).toEqual(operations);
      expect(frames.filter((row) => row.frame.kind === "ending")).toHaveLength(
        1,
      );
      expect(
        frames
          .filter((row) => row.frame.kind === "closed")
          .map((row) => row.frame),
      ).toEqual([
        expect.objectContaining({ outcome: "stopped", requestId: null }),
      ]);
      expect(frames.some((row) => row.frame.kind === "unknown")).toBe(false);
      const journalInput = Buffer.concat(
        (journalFacts.input as string[]).map((base64) =>
          Buffer.from(base64, "base64"),
        ),
      );
      expect(journalInput.at(-1)).toBe(10);
      expect(JSON.parse(journalInput.toString("utf8"))).toEqual({
        v: 1,
        kind: "read-windows-journal",
        scope,
        executionId: descriptor.executionId,
      });
      expect(journalFacts.frames).toEqual([]);
      const rawJournalSnapshot = JSON.parse(
        Buffer.from(journalFacts.stdoutBase64 as string, "base64").toString(
          "utf8",
        ),
      ) as Value;
      expect(result.rawJournalSnapshot).toEqual(rawJournalSnapshot);
      expect(rawJournalSnapshot).toEqual(values.strictSnapshot);
      expect(descriptor.executionId).toBe(bound.executionId);
      expect(details).toMatchObject({
        target: scope.target,
        executionPolicyFingerprint: scope.executionPolicyFingerprint,
        requestFingerprint: evidence.request!.requestFingerprint,
        installationManifestSha256: values.manifestSha256,
        supervisor: bound.helper,
      });
      const processes = (outer.guard as Value).processes as Value[];
      for (const identity of [
        bound.bridge,
        bound.helper,
        details.engine,
        reader.identity,
        (values.child as Value).identity,
      ])
        expect(processes).toContainEqual(
          expect.objectContaining({
            identity,
            originalJoined: true,
            alive: false,
          }),
        );
      const guard = outer.guard as Value;
      expect(guard.totalProcesses).toBe(guard.registeredOriginalProcesses);
      expect(guard.registeredOriginalProcesses).toBe(
        (guard.expectedRegisteredProcesses as number) +
          (guard.observedOsConsoleProcesses as number),
      );
      expect(processes).toHaveLength(
        guard.registeredOriginalProcesses as number,
      );
      const diagnostics = outer.guardDiagnostics as Value;
      const readerRegistrations = (
        diagnostics.registrationSources as Value[]
      ).filter((row) => row.role === "journal-reader");
      expect(readerRegistrations).toHaveLength(1);
      expect(readerRegistrations[0]).toMatchObject({
        identity: reader.identity,
        source: "original-reader-job-notification",
        candidatePid: journalFacts.originalPid,
        notificationSource: "original-job-new-process-notification",
        originalNotificationRetained: true,
        independentCreationPin: false,
      });
      const retainedCandidates = (diagnostics.processes as Value[]).filter(
        (row) =>
          (row.identity as Value | null)?.pid === journalFacts.originalPid,
      );
      expect(retainedCandidates).toHaveLength(1);
      expect(retainedCandidates[0]).toMatchObject({
        identity: reader.identity,
        bindingVerified: true,
        qualifiedReaderCandidate: true,
        originalNotificationRetained: true,
        independentCreationPin: false,
        imageIdentity: readerRegistrations[0]!.imageIdentity,
      });
      expect(diagnostics.readerTransfer).toMatchObject({
        identity: reader.identity,
        originalHost: (outer.host as Value).identity,
        state: "host-adopted",
      });
      const records = rawJournalSnapshot.records as Value;
      expect(records.authorization).toMatchObject({
        status: "existing",
        snapshot: {
          executionId: descriptor.executionId,
          scope,
          record: {
            kind: "authorized",
            scope: { target: scope.target, descriptor },
          },
        },
      });
      expect(records.terminal).toMatchObject({
        status: "existing",
        snapshot: {
          executionId: descriptor.executionId,
          scope,
          record: {
            kind: "windows-terminal",
            descriptor,
            scope,
            requestFingerprint: evidence.request!.requestFingerprint,
            requestRecordId: details.requestRecordId,
            preparedRecordId: details.preparedRecordId,
            resumeState: "succeeded",
            authorizationsSealed: true,
            proof: {
              kind: "engine-tree",
              engine: details.engine,
              jobName: details.jobName,
              treeExited: true,
              activeProcesses: 0,
              stdoutEof: true,
              stderrEof: true,
            },
          },
        },
      });
      const interpreted = interpretWindowsJournalSnapshot(
        values.strictSnapshot,
        scope,
        descriptor,
      );
      expect(interpreted.kind).toBe(
        name === "natural" ? "engine-exit" : "stop",
      );
      if (interpreted.kind !== "engine-exit" && interpreted.kind !== "stop")
        throw new Error("Independent original terminal evidence required");
      expect(callback.exit).toEqual(interpreted.exit);
      if (name === "natural") {
        expect(interpreted.exit.completion).toEqual({
          kind: "success",
          exitCode: 0,
          signal: null,
        });
        expect(Object.hasOwn(result, "stopProof")).toBe(false);
      } else {
        expect(Object.hasOwn(interpreted.exit, "completion")).toBe(false);
        expect(Object.hasOwn(callback.exit as Value, "completion")).toBe(false);
        const stop = result.stopProof as Value;
        const pair = stop.pair as {
          stopRequestedAt: number;
          terminateAfterAt: number;
        };
        expect(stop).toMatchObject({
          pairFrozen: true,
          softPermits: 1,
          softResult: { kind: "stop-requested" },
        });
        expect(pair.terminateAfterAt - pair.stopRequestedAt).toBe(
          originalSpec.executionPolicy.limits.cancelGraceMs,
        );
        expect(commands[2]).toMatchObject({
          op: "request-stop",
          mode: "soft",
          ...pair,
          descriptor,
          target: scope.target,
          requestFingerprint: evidence.request!.requestFingerprint,
        });
        expect((values.nodeStopSent as Value).pair).toEqual(pair);
      }
      const sequence = result.sequence as {
        sequence: number;
        role: string;
        event: string;
      }[];
      expect(sequence.map((row) => row.sequence)).toEqual(
        sequence.map((_, index) => index),
      );
      const at = (role: string, event: string) => {
        const index = sequence.findIndex(
          (row) => row.role === role && row.event === event,
        );
        expect(index, `${role}:${event}`).toBeGreaterThanOrEqual(0);
        return index;
      };
      expect(at("adapter", "authorize-call")).toBeGreaterThan(
        at("adapter", "observer-installed"),
      );
      expect(at("bridge", "input:command:authorize")).toBeGreaterThan(
        at("adapter", "observer-installed"),
      );
      expect(at("adapter", "exit-callback")).toBeGreaterThan(
        at("adapter", "prepare-guard-sealed"),
      );
      expect(at("adapter", "exit-callback")).toBeGreaterThan(
        at("adapter", "authorize-guard-sealed"),
      );
      expect(at("journal", "reader-input-released")).toBeGreaterThan(
        at("journal", "reader-input-held"),
      );
      expect(at("journal", "stdin-end-call")).toBeGreaterThan(
        at("journal", "reader-input-released"),
      );
      for (const event of ["stdout-eof", "stderr-eof", "exit", "child-close"])
        expect(at("journal", event)).toBeGreaterThan(
          at("journal", "stdin-end-call"),
        );
      for (const event of [
        "exit",
        "child-close",
        "stdout-eof",
        "stderr-eof",
        "stdin-close",
        "stdout-close",
        "stderr-close",
        "stdin-finish",
      ]) {
        expect(at("journal", "spawn-call")).toBeGreaterThan(
          at("bridge", event),
        );
        expect(at("adapter", "exit-callback")).toBeGreaterThan(
          at("journal", event),
        );
      }
      expect(at("adapter", "close-call-after-exit")).toBeGreaterThan(
        at("adapter", "exit-callback"),
      );
      const ordinaryAssembly = evidence.artifactsBefore.find(
        (row) =>
          row.path === join(dirname(ordinaryExe!), "WindowsSupervisor.dll"),
      );
      expect(values.readerOrdinaryAssemblySha256).toBe(
        ordinaryAssembly!.sha256,
      );
    },
    testMs,
  );

  it.each(["before-input", "after-input"])(
    "joins the original Windows Adapter journal reader after Node loss at %s",
    async (stage) => {
      const directory = await mkdtemp(
        join(evidenceRoot, `adapter-reader-loss-${stage}-商品's 🙂-`),
      );
      const evidence = await exercise(
        directory,
        `execution-node-reader-loss-${stage}`,
        true,
      );
      expect(evidence.failures).toEqual([]);
      expect(evidence.outerExit).toEqual({ code: 0, signal: null });
      expect(evidence.outerClose).toEqual(evidence.outerExit);
      expect(evidence.stdoutEof && evidence.stderrEof).toBe(true);
      expect(evidence.outerStderrBase64).toBe("");
      expect(evidence.artifactsAfter).toEqual(evidence.artifactsBefore);
      const outer = evidence.receipt!.outer as Value;
      const host = evidence.receipt!.host as Value;
      expect(outer).toMatchObject({
        primaryFailure: null,
        forcedFallback: false,
        protocolErrors: [],
        guard: {
          activeProcesses: 0,
          allObservedJoined: true,
          membershipVerified: true,
        },
      });
      expect(host).toMatchObject({
        setupFailure: null,
        failure: null,
        cleanup: { failures: [], allObservedJoined: true },
      });
      const values = host.values as Value;
      const bound = values.bound as Value;
      const descriptor = values.descriptor as OwnerDescriptor;
      const details = descriptor.details as Value;
      const reader = values.reader as Value;
      const node = values.child as Value;
      const before = values.readerLossBefore as Value;
      const after = values.readerLossAfter as Value;
      expect(values).toMatchObject({
        bridgeLaunches: 1,
        fixtureHelperLaunches: 0,
        markerPresent: true,
        helper: { identity: bound.helper, exitCode: 0, originalJoined: true },
        bridge: { identity: bound.bridge, exitCode: 0, originalJoined: true },
        readerLossResultFilePresent: false,
        authAckBeforeFinish: {
          kind: "node-authorize-result",
          result: { kind: "authorized" },
        },
      });
      expect(values.nodeResult).toBeUndefined();
      await expect(
        access(join(directory, "node-adapter-return.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(values.carrier).toEqual(evidence.request);
      expect(freezeWindowsPrepareRequest(evidence.adapterAttempt!)).toEqual(
        evidence.request,
      );
      const attemptBytes = await readFile(evidence.attemptSidecar!.path);
      expect(attemptBytes.toString("base64")).toBe(
        evidence.attemptSidecar!.bytesBase64,
      );
      expect(createHash("sha256").update(attemptBytes).digest("hex")).toBe(
        evidence.attemptSidecar!.sha256,
      );
      expect(JSON.parse(attemptBytes.toString("utf8"))).toEqual(
        evidence.adapterAttempt,
      );
      const config = JSON.parse(
        (await readFile(join(directory, "node-host.json"))).toString("utf8"),
      ) as Value;
      expect(config.request).toEqual(evidence.request);
      expect(config.scenario).toBe(`execution-node-reader-loss-${stage}`);
      expect(details).toMatchObject({
        target: (config.expected as Value).target,
        executionPolicyFingerprint: (config.expected as Value)
          .executionPolicyFingerprint,
        requestFingerprint: evidence.request!.requestFingerprint,
        installationManifestSha256: values.manifestSha256,
        supervisor: bound.helper,
      });
      expect(reader).toMatchObject({
        role: "journal-reader",
        originalJoined: true,
        alive: false,
        nonInherited: true,
        sameSid: true,
        adopted: true,
        registrationSource: "original-reader-job-notification",
        originalNotificationRetained: true,
        independentCreationPin: false,
      });
      expect(stage === "before-input" ? [2] : [0, 2]).toContain(
        reader.exitCode,
      );
      expect(before).toEqual({
        stage,
        originalNode: node.identity,
        originalReader: reader.identity,
        originalBridge: bound.bridge,
        originalHelper: bound.helper,
        originalEngine: details.engine,
        nodeAliveAtCheck: true,
        readerAliveAtCheck: true,
        readerAdopted: true,
        originalNodeRegistrationAcknowledged: true,
        originalReaderRegistrationAcknowledged: true,
        originalHelperJoined: true,
        helperExitCode: 0,
        originalBridgeJoined: true,
        bridgeExitCode: 0,
        originalEngineJoined: true,
        engineExitCode: 0,
        extraEngineJobHandlesClosed: true,
        executionId: descriptor.executionId,
        requestFingerprint: evidence.request!.requestFingerprint,
      });
      expect(values.readerLossInjection).toEqual({
        stage,
        injectionPerformed: true,
        originalNode: node.identity,
        originalReader: reader.identity,
        nodeAliveAtCheck: true,
        readerAliveAtCheck: true,
        intentionalOriginalNodeTermination: true,
        originalNodeJoined: true,
        exitCode: 1,
        otherOriginalProcessTerminatedByFixture: false,
      });
      expect(node).toMatchObject({
        originalRetained: true,
        originalJoined: true,
        alive: false,
        forced: true,
        exitCode: 1,
        sameSid: true,
        nonInherited: true,
        stdout: { actualEof: true, error: null, overflow: false },
        stderr: {
          actualEof: true,
          error: null,
          overflow: false,
          capturedBase64: "",
        },
      });
      expect(after).toMatchObject({
        node: {
          identity: node.identity,
          originalJoined: true,
          exitCode: 1,
          forced: true,
          stdoutEof: true,
          stderrEof: true,
        },
        reader: {
          identity: reader.identity,
          originalRetained: true,
          originalJoined: true,
          alive: false,
          exitCode: reader.exitCode,
        },
        helper: {
          identity: bound.helper,
          originalJoined: true,
          alive: false,
          exitCode: 0,
        },
        bridge: {
          identity: bound.bridge,
          originalJoined: true,
          alive: false,
          exitCode: 0,
        },
        originalAdapterResultObserved: false,
      });
      expect(after.engines).toEqual([
        expect.objectContaining({
          identity: details.engine,
          originalRetained: true,
          originalJoined: true,
          alive: false,
          exitCode: 0,
        }),
      ]);
      const readerStages = values.readerStages as Value[];
      expect(readerStages.map((row) => row.sequence)).toEqual(
        readerStages.map((_, index) => index),
      );
      expect(readerStages.map((row) => row.stage)).toEqual([
        "held-observed",
        "original-handle-adopted",
        "originals-joined-before-injection",
        ...(stage === "after-input"
          ? [
              "release-send-started",
              "release-send-completed",
              "input-delivered-observed",
            ]
          : []),
        "injection-live-check",
      ]);
      for (const row of readerStages.slice(1))
        expect(row.identity).toEqual(reader.identity);
      const frames = values.frames as Value[];
      expect(frames.map((frame) => frame.kind)).toEqual([
        "node-bound",
        "node-prepared",
        "node-authorize-result",
        "node-reader-input-held",
        ...(stage === "after-input" ? ["node-reader-input-delivered"] : []),
      ]);
      expect(
        frames.filter((frame) => frame.kind === "node-reader-input-held"),
      ).toEqual([
        {
          kind: "node-reader-input-held",
          candidatePid: (reader.identity as Value).pid,
          executionId: descriptor.executionId,
          requestFingerprint: evidence.request!.requestFingerprint,
        },
      ]);
      expect(
        frames.filter((frame) => frame.kind === "node-reader-input-delivered"),
      ).toEqual(
        stage === "after-input"
          ? [
              {
                kind: "node-reader-input-delivered",
                candidatePid: (reader.identity as Value).pid,
                executionId: descriptor.executionId,
                requestFingerprint: evidence.request!.requestFingerprint,
                endCalls: 1,
                endCallbacks: 1,
                stdinFinish: true,
                endCallbackSucceeded: true,
              },
            ]
          : [],
      );
      const controls = (node.sentFramesBase64 as string[]).map(
        (bytes) =>
          JSON.parse(Buffer.from(bytes, "base64").toString("utf8")) as Value,
      );
      expect(controls).toEqual(
        stage === "after-input"
          ? [
              {
                command: "release-reader-input",
                identity: reader.identity,
                executionId: descriptor.executionId,
                requestFingerprint: evidence.request!.requestFingerprint,
              },
            ]
          : [],
      );
      const guard = outer.guard as Value;
      const processes = guard.processes as Value[];
      for (const identity of [
        node.identity,
        reader.identity,
        bound.bridge,
        bound.helper,
        details.engine,
      ])
        expect(processes).toContainEqual(
          expect.objectContaining({
            identity,
            originalJoined: true,
            alive: false,
          }),
        );
      expect(guard.totalProcesses).toBe(guard.registeredOriginalProcesses);
      expect(guard.registeredOriginalProcesses).toBe(
        (guard.expectedRegisteredProcesses as number) +
          (guard.observedOsConsoleProcesses as number),
      );
      expect(processes).toHaveLength(
        guard.registeredOriginalProcesses as number,
      );
      const diagnostics = outer.guardDiagnostics as Value;
      const registrations = (diagnostics.registrationSources as Value[]).filter(
        (row) => row.role === "journal-reader",
      );
      expect(registrations).toEqual([
        expect.objectContaining({
          identity: reader.identity,
          source: "original-reader-job-notification",
          candidatePid: (reader.identity as Value).pid,
          notificationSource: "original-job-new-process-notification",
          originalNotificationRetained: true,
          independentCreationPin: false,
        }),
      ]);
      const retained = (diagnostics.processes as Value[]).filter(
        (row) =>
          (row.identity as Value | null)?.pid ===
          (reader.identity as Value).pid,
      );
      expect(retained).toEqual([
        expect.objectContaining({
          identity: reader.identity,
          bindingVerified: true,
          qualifiedReaderCandidate: true,
          originalNotificationRetained: true,
          independentCreationPin: false,
          imageIdentity: registrations[0]!.imageIdentity,
        }),
      ]);
      expect(diagnostics.readerTransfer).toMatchObject({
        identity: reader.identity,
        originalHost: (outer.host as Value).identity,
        state: "host-adopted",
      });
      const ordinaryAssembly = evidence.artifactsBefore.find(
        (row) =>
          row.path === join(dirname(ordinaryExe!), "WindowsSupervisor.dll"),
      );
      expect(values.readerOrdinaryAssemblySha256).toBe(
        ordinaryAssembly!.sha256,
      );
    },
    testMs,
  );

  it("carries a real Native model denial through actual Worker Adapter and authenticated maintenance GET", async () => {
    const directory = await mkdtemp(join(evidenceRoot, "worker-diagnostic-商品's 🙂-"));
    const evidence = await exercise(directory, "execution-node-worker-prepare-installation-denied");
    expect(evidence.failures).toEqual([]);
    expect(evidence.outerExit).toEqual({ code: 0, signal: null });
    expect(evidence.outerClose).toEqual(evidence.outerExit);
    expect(evidence.stdoutEof && evidence.stderrEof).toBe(true);
    expect(evidence.outerStderrBase64).toBe("");
    expect(evidence.artifactsAfter).toEqual(evidence.artifactsBefore);
    const receipt = evidence.receipt!;
    expect(receipt.outer).toMatchObject({ primaryFailure: null, forcedFallback: false, protocolErrors: [],
      guard: { activeProcesses: 0, allObservedJoined: true } });
    expect(receipt.host).toMatchObject({ setupFailure: null, failure: null, cleanup: { failures: [], allObservedJoined: true } });
    const values = (receipt.host as Value).values as Value;
    const result = (values.nodeResult as Value).workerDiagnostic as Value;
    expect(result).toMatchObject({ unauthorizedStatus: 401, selfTestPosts: 1,
      inputPreserved: true, calibrationPreserved: true, sensitiveDataAbsent: true, sameJob: true,
      workerClosedAfterContainment: true, serviceQualification: false, gpuInference: false });
    const maintenance = result.maintenance as { status: number; body: { data: Value } };
    expect(maintenance.status).toBe(200);
    expect(maintenance.body.data).toMatchObject({ sealed: false, canStop: false,
      store: { running: 1, slots: 1 }, runtime: { runner: { ownedState: "unknown" },
        adapter: { prepareDiagnostic: { prepareStage: "installation_open", nativeStage: "file_open", nativeErrorCode: 5 } } } });
    expect(values.prepareDiagnosticBeforeContainment).toMatchObject({ helperNaturalExitCode: 2,
      originalBridgeRetainedLive: true, engineCreated: false, productCleanupQualified: false });
    expect(values.prepareDiagnosticSendBarrier).toMatchObject({ originalBridgeRegistered: true,
      originalHelperRegistered: true, originalHelperLive: true });
    expect(result.nativeFilesAfter).toEqual(result.nativeFiles);
    expect(values.prepareDiagnosticFault).toMatchObject({ leafAclRestored: true, ancestorAclsUnchangedAfter: true,
      bundlePreserved: true, recordsEmpty: true });
  }, testMs);

  it("returns real Native model-denial diagnostics through the original bridge and Node Host", async () => {
    const directory = await mkdtemp(join(evidenceRoot, "prepare-diagnostic-商品's 🙂-"));
    const evidence = await exercise(directory, "execution-node-prepare-installation-denied");
    expect(evidence.failures).toEqual([]);
    expect(evidence.outerExit).toEqual({ code: 0, signal: null });
    expect(evidence.outerClose).toEqual(evidence.outerExit);
    expect(evidence.stdoutEof && evidence.stderrEof).toBe(true);
    expect(evidence.outerStderrBase64).toBe("");
    expect(evidence.artifactsAfter).toEqual(evidence.artifactsBefore);
    const receipt = evidence.receipt!;
    expect(receipt.outer).toMatchObject({ primaryFailure: null, forcedFallback: false, protocolErrors: [],
      guard: { activeProcesses: 0, allObservedJoined: true } });
    const host = receipt.host as Value;
    expect(host).toMatchObject({ setupFailure: null, failure: null, cleanup: { failures: [], allObservedJoined: true } });
    const values = host.values as Value;
    expect(values.prepareDiagnosticFault).toMatchObject({ selectedFromProductionLaunch: true, denyInstalled: true,
      deniedRead: { success: false, nativeError: 5 }, readableControl: { success: true, nativeError: 0 },
      leafAclRestored: true, ancestorAclsUnchangedAfter: true, bundlePreserved: true, recordsEmpty: true });
    const diagnostic = { kind: "unknown", cleanup: "unknown", prepareDiagnostic: {
      prepareStage: "installation_open", nativeStage: "file_open", nativeErrorCode: 5 } };
    expect((values.nodePrepared as Value).result).toEqual(diagnostic);
    expect(values.prepareDiagnosticBeforeContainment).toMatchObject({ resultObservedBeforeContainment: true,
      helperNaturalExitCode: 2, helperJoined: true, originalBridgeRetainedLive: true,
      engineCreated: false, recordsEmpty: true, productCleanupQualified: false });
    expect(values.explicitOriginalBridgeContainment).toBe(true);
    expect(values.nodeResult).toMatchObject({ prepareResult: diagnostic, closeResult: { kind: "unknown", cleanup: "unknown" },
      preparePermits: 1, authPermits: 0, markerAfterPrepare: false,
      factsAtReturn: { spawnCount: 1, killCalls: 0, stderrBytes: 0, stdoutEof: true, stderrEof: true } });
    expect(values.markerPresent).toBe(false);
  }, testMs);

  it(
    "prepares through one real original-helper permit using the canonical carrier",
    async () => {
      const directory = await mkdtemp(join(evidenceRoot, "prepare-商品's 🙂-"));
      const evidence = await exercise(directory);
      expect(evidence.failures).toEqual([]);
      expect(evidence.outerExit).toEqual({ code: 0, signal: null });
      expect(evidence.outerClose).toEqual(evidence.outerExit);
      expect(evidence.stdoutEof && evidence.stderrEof).toBe(true);
      expect(evidence.outerStderrBase64).toBe("");
      expect(evidence.artifactsAfter).toEqual(evidence.artifactsBefore);
      const receipt = evidence.receipt!;
      const outer = receipt.outer as Value;
      expect(outer.primaryFailure).toBeNull();
      expect(outer.forcedFallback).toBe(false);
      expect(outer.protocolErrors).toEqual([]);
      expect(outer.guard).toMatchObject({ allObservedJoined: true });
      const host = receipt.host as Value;
      expect(host.setupFailure).toBeNull();
      expect(host.failure).toBeNull();
      expect(host.cleanup).toMatchObject({
        failures: [],
        allObservedJoined: true,
      });
      const values = host.values as Value;
      expect(values).toMatchObject({
        bridgeLaunches: 1,
        fixtureHelperLaunches: 0,
        markerPresent: false,
      });
      expect(values.carrier).toEqual(evidence.request);
      const bound = values.bound as Value;
      expect(bound.kind).toBe("bound");
      // Baseline returns an actual Unknown here; API absence is not this RED.
      expect(values.firstPrepareResponse).toMatchObject({
        kind: "permit-request",
        op: "prepare",
      });
      expect(values.prepareResponse).toMatchObject({
        kind: "state",
        state: { phase: "prepared" },
      });
      const descriptor = values.descriptor as Value;
      expect(descriptor.executionId).toBe(bound.executionId);
      const details = descriptor.details as Value;
      expect(values.rawPreparedEngine).toEqual(details.engine);
      expect(details.requestFingerprint).toBe(
        evidence.request!.requestFingerprint,
      );
      expect(details.installationManifestSha256).toBe(values.manifestSha256);
      expect(details.supervisor).toEqual(bound.helper);
      const originalSpec = JSON.parse(
        Buffer.from(evidence.request!.requestUtf8Base64, "base64").toString(
          "utf8",
        ),
      ) as Value;
      expect(details.target).toEqual(originalSpec.target);
      const actualFrames = values.frames as Value[];
      expect(
        actualFrames.filter((frame) => frame.kind === "permit-request"),
      ).toHaveLength(1);
    },
    testMs,
  );

  it(
    "accepts the complete request-stop wire through the original running owner permit",
    async () => {
      const directory = await mkdtemp(
        join(evidenceRoot, "raw-stop-wire-商品's 🙂-"),
      );
      const evidence = await exercise(directory, "execution-stop-wire");
      expect(evidence.failures).toEqual([]);
      expect(evidence.outerExit).toEqual({ code: 0, signal: null });
      expect(evidence.outerClose).toEqual(evidence.outerExit);
      expect(evidence.stdoutEof && evidence.stderrEof).toBe(true);
      expect(evidence.outerStderrBase64).toBe("");
      expect(evidence.artifactsAfter).toEqual(evidence.artifactsBefore);
      const receipt = evidence.receipt!;
      expect(receipt.outer).toMatchObject({
        primaryFailure: null,
        forcedFallback: false,
        protocolErrors: [],
        guard: {
          activeProcesses: 0,
          allObservedJoined: true,
          membershipVerified: true,
        },
      });
      const host = receipt.host as Value;
      expect(host).toMatchObject({
        setupFailure: null,
        failure: null,
        cleanup: { failures: [], allObservedJoined: true },
      });
      const values = host.values as Value;
      const bound = values.bound as Value;
      const descriptor = values.descriptor as OwnerDescriptor;
      const details = descriptor.details as Value;
      const spec = JSON.parse(
        Buffer.from(evidence.request!.requestUtf8Base64, "base64").toString(
          "utf8",
        ),
      ) as {
        target: Value;
        executionPolicy: { limits: { cancelGraceMs: number } };
      };
      expect(values).toMatchObject({
        bridgeLaunches: 1,
        fixtureHelperLaunches: 0,
        markerPresent: true,
        helper: { identity: bound.helper, exitCode: 0, originalJoined: true },
        child: {
          identity: bound.bridge,
          originalJoined: true,
          alive: false,
          forced: false,
          stdout: { actualEof: true, error: null, overflow: false },
          stderr: { actualEof: true, error: null, overflow: false },
        },
        rawAfter: { authorizationRecordAbsent: false },
      });
      expect(values.carrier).toEqual(evidence.request);
      const authorizeId = "00000000000000000000000000000009";
      const stopId = "0000000000000000000000000000000a";
      expect(values.rawAuthResponse).toMatchObject({
        v: 1,
        kind: "state",
        requestId: authorizeId,
        executionId: bound.executionId,
        state: {
          descriptor,
          authorizationVerified: true,
          resumeState: "succeeded",
        },
      });
      expect(values.rawStopBeforeRequest).toEqual({
        originalBridge: bound.bridge,
        originalHelper: bound.helper,
        originalEngine: details.engine,
        peer: details.engine,
        markerIdentity: details.engine,
        originalEngineLive: true,
        authorizationRecordPresent: true,
        callerInputOpen: true,
        completedInputFrames: 4,
        extraEngineJobHandlesClosed: true,
      });
      const command = values.rawStopCommand as Value;
      const stopRequestedAt = command.stopRequestedAt as number;
      const terminateAfterAt = command.terminateAfterAt as number;
      expect(
        Number.isSafeInteger(stopRequestedAt) && stopRequestedAt >= 0,
      ).toBe(true);
      expect(Number.isSafeInteger(terminateAfterAt)).toBe(true);
      expect(terminateAfterAt).toBeGreaterThan(stopRequestedAt);
      expect(terminateAfterAt - stopRequestedAt).toBe(
        spec.executionPolicy.limits.cancelGraceMs,
      );
      expect(command).toEqual({
        v: 1,
        kind: "command",
        requestId: stopId,
        op: "request-stop",
        executionId: bound.executionId,
        target: spec.target,
        descriptor,
        requestFingerprint: evidence.request!.requestFingerprint,
        mode: "soft",
        stopRequestedAt,
        terminateAfterAt,
      });
      const input = (values.child as Value).sentFramesBase64 as string[];
      expect(
        JSON.parse(Buffer.from(input[4]!, "base64").toString("utf8")),
      ).toEqual(command);
      const actualFrames = values.frames as Value[];
      expect(actualFrames).toContainEqual(values.firstStopResponse);
      // Keep any baseline Unknown as protocol data before asserting the new wire.
      expect(values.firstStopResponse).toEqual({
        v: 1,
        kind: "permit-request",
        requestId: stopId,
        op: "request-stop",
        executionId: bound.executionId,
        requestFingerprint: evidence.request!.requestFingerprint,
      });
      expect(values.rawStopResponse).toMatchObject({
        v: 1,
        kind: "state",
        requestId: stopId,
        executionId: bound.executionId,
        state: {
          descriptor,
          authorizationVerified: true,
          resumeState: "succeeded",
          sealReason: "stop",
        },
      });
      expect(values.rawStopAfterResponse).toEqual({
        callerInputOpen: true,
        completedInputFrames: 6,
      });
    },
    testMs,
  );

  it.each(["soft", "held", "missing-ack"])(
    "runs original native business stop %s with bounded independent acknowledgements",
    async (name) => {
      const directory = await mkdtemp(
        join(evidenceRoot, `node-stop-${name}-商品's 🙂-`),
      );
      const evidence = await exercise(directory, `execution-node-stop-${name}`);
      expect(evidence.failures).toEqual([]);
      expect(evidence.outerExit).toEqual({ code: 0, signal: null });
      expect(evidence.outerClose).toEqual(evidence.outerExit);
      expect(evidence.stdoutEof && evidence.stderrEof).toBe(true);
      expect(evidence.outerStderrBase64).toBe("");
      expect(evidence.artifactsAfter).toEqual(evidence.artifactsBefore);
      expect(evidence.receipt!.outer).toMatchObject({
        primaryFailure: null,
        forcedFallback: false,
        protocolErrors: [],
        guard: {
          activeProcesses: 0,
          allObservedJoined: true,
          membershipVerified: true,
        },
      });
      const host = evidence.receipt!.host as Value;
      expect(host).toMatchObject({
        setupFailure: null,
        failure: null,
        cleanup: { failures: [], allObservedJoined: true },
      });
      const values = host.values as Value,
        result = values.nodeResult as Value,
        proof = result.stopProof as Value;
      expect(proof).toMatchObject({
        softPermits: 1,
        forcePermits: name === "soft" ? 0 : 1,
        originalSoftPromiseRetained: true,
      });
      expect(proof.softResult).toEqual(
        name === "missing-ack"
          ? { kind: "unknown", cleanup: "unknown" }
          : { kind: "stop-requested" },
      );
      expect(result.closeResult).toEqual({
        kind: "stopped",
        cleanup: "closed",
      });
      const facts = result.factsAtReturn as Value,
        closeFacts = result.factsAtCloseReturn as Value;
      expect(result.factsScope).toBe("original-node-child-and-stream-events");
      for (const observed of [closeFacts, facts]) {
        expect(observed).toMatchObject({
          spawnCount: 1,
          killCalls: 0,
          exit: { code: 0, signal: null },
          close: { code: 0, signal: null },
          stdoutEof: true,
          stderrEof: true,
          stdinClose: true,
          stdoutClose: true,
          stderrClose: true,
          stdinFinish: true,
          endCalls: 1,
          endCallbacks: 1,
          stderrBytes: 0,
          errors: [],
          writeErrors: 0,
        });
        expect(observed.writeCallbacks).toBe(observed.writeCalls);
      }
      expect(values.child).toMatchObject({ exitCode: 0, originalJoined: true });
      expect(values.bridge).toMatchObject({
        identity: (values.bound as Value).bridge,
        exitCode: 0,
        originalJoined: true,
      });
      const input = (facts.input as string[]).map(
        (bytes) =>
          JSON.parse(Buffer.from(bytes, "base64").toString("utf8")) as Value,
      );
      const stops = input.filter(
        (frame) => frame.kind === "command" && frame.op === "request-stop",
      );
      expect(stops.map((frame) => frame.mode)).toEqual(
        name === "soft" ? ["soft"] : ["soft", "force"],
      );
      expect(new Set(stops.map((frame) => frame.requestId)).size).toBe(
        stops.length,
      );
      for (const command of stops) {
        expect(
          input.filter(
            (frame) =>
              frame.kind === "permit" &&
              frame.requestId === command.requestId &&
              frame.op === "request-stop" &&
              frame.allow === true,
          ),
        ).toHaveLength(1);
        expect(command.descriptor).toEqual(values.descriptor);
        expect(command.requestFingerprint).toBe(
          evidence.request!.requestFingerprint,
        );
      }
      const descriptor = values.descriptor as Value,
        details = descriptor.details as Value;
      expect((result.prepareResult as Value).descriptor).toEqual(descriptor);
      const spec = JSON.parse(
        Buffer.from(evidence.request!.requestUtf8Base64, "base64").toString(
          "utf8",
        ),
      ) as {
        target: Parameters<typeof interpretWindowsJournalSnapshot>[1]["target"];
        executionPolicy: { fingerprint: string };
      };
      const scope = {
        target: spec.target,
        executionPolicyFingerprint: spec.executionPolicy.fingerprint,
      };
      expect(details.target).toEqual(scope.target);
      expect(details.executionPolicyFingerprint).toBe(
        scope.executionPolicyFingerprint,
      );
      const strict = values.strictSnapshot as Value,
        records = strict.records as Value,
        authorization = records.authorization as Value;
      expect(authorization).toMatchObject({
        status: "existing",
        snapshot: {
          kind: "record",
          executionId: descriptor.executionId,
          scope,
          record: {
            kind: "authorized",
            scope: { target: details.target, descriptor },
          },
        },
      });
      const authorizationEnvelope = authorization.snapshot as Value,
        authorizationRecord = authorizationEnvelope.record as Value;
      expect(authorizationEnvelope.recordId).toBe(authorizationRecord.recordId);
      expect(records.terminal).toMatchObject({
        status: "existing",
        snapshot: {
          kind: "record",
          executionId: descriptor.executionId,
          scope,
          rootIdentity: authorizationEnvelope.rootIdentity,
          reservationIdentity: authorizationEnvelope.reservationIdentity,
          record: {
            kind: "windows-terminal",
            scope,
            requestRecordId: details.requestRecordId,
            requestFingerprint: evidence.request!.requestFingerprint,
            preparedRecordId: details.preparedRecordId,
            authorizationRecordId: authorizationRecord.recordId,
            resumeState: "succeeded",
            authorizationsSealed: true,
            proof: {
              kind: "engine-tree",
              engine: details.engine,
              jobName: details.jobName,
              treeExited: true,
              activeProcesses: 0,
              stdoutEof: true,
              stderrEof: true,
            },
          },
        },
      });
      const nativeTerminal = ((records.terminal as Value).snapshot as Value)
        .record as Value;
      expect(nativeTerminal.descriptor).toEqual(descriptor);
      expect(nativeTerminal.completion).toEqual({ kind: "stop" });
      expect(records.controllerLoss).toEqual({
        status: "unknown",
        snapshot: null,
      });
      const interpreted = interpretWindowsJournalSnapshot(
        strict,
        scope,
        descriptor as unknown as OwnerDescriptor,
      );
      expect(interpreted).toEqual({
        kind: "stop",
        exit: {
          identity: scope.target.identity,
          descriptor,
          launchTicket: scope.target.launchTicket,
          treeExited: true,
        },
      });
      if (interpreted.kind !== "stop")
        throw new Error("qualified original native stop required");
      expect(Object.hasOwn(interpreted.exit, "completion")).toBe(false);
      if (name !== "soft") {
        expect(proof.forceResult).toEqual({ kind: "stop-requested" });
        expect(values.forceAckWithSoftHeld).toMatchObject({
          result: { kind: "stop-requested" },
          softPending: true,
          softPermits: 1,
          forcePermits: 1,
        });
        const held = values.stopHeldBeforeForce as Value;
        expect(
          held.originalEngineLive &&
            held.originalHelperLive &&
            held.originalBridgeLive &&
            held.extraEngineJobHandlesClosed,
        ).toBe(true);
        expect(held.observedAt as number).toBeGreaterThan(
          held.terminateAfterAt as number,
        );
        expect(values.stopTestGateBudget).toMatchObject({
          source: "original-outer-fixture-execution-deadline",
        });
      }
    },
    testMs,
  );

  it.each(["permit-close", "permit-eof", "permit-replay", "natural-close-id"])(
    "closes the original native raw %s interleaving with independent journal proof",
    async (name) => {
      const directory = await mkdtemp(
        join(evidenceRoot, `raw-${name}-商品's 🙂-`),
      );
      const evidence = await exercise(directory, `execution-${name}`);
      expect(evidence.failures).toEqual([]);
      expect(evidence.outerExit).toEqual({ code: 0, signal: null });
      expect(evidence.outerClose).toEqual(evidence.outerExit);
      expect(evidence.stdoutEof && evidence.stderrEof).toBe(true);
      expect(evidence.outerStderrBase64).toBe("");
      expect(evidence.artifactsAfter).toEqual(evidence.artifactsBefore);
      const receipt = evidence.receipt!;
      const outer = receipt.outer as Value,
        host = receipt.host as Value;
      expect(outer).toMatchObject({
        primaryFailure: null,
        forcedFallback: false,
        protocolErrors: [],
        guard: {
          activeProcesses: 0,
          allObservedJoined: true,
          membershipVerified: true,
        },
      });
      expect(host).toMatchObject({
        setupFailure: null,
        failure: null,
        cleanup: { failures: [], allObservedJoined: true },
      });
      const values = host.values as Value;
      const natural = name === "natural-close-id",
        replay = name === "permit-replay";
      expect(values).toMatchObject({
        bridgeLaunches: 1,
        fixtureHelperLaunches: 0,
        markerPresent: natural,
        helper: { exitCode: 0, originalJoined: true },
      });
      expect(values.carrier).toEqual(evidence.request);
      const bound = values.bound as Value;
      const descriptor = values.descriptor as OwnerDescriptor;
      const details = descriptor.details as Value;
      const spec = JSON.parse(
        Buffer.from(evidence.request!.requestUtf8Base64, "base64").toString(
          "utf8",
        ),
      ) as {
        target: Parameters<typeof interpretWindowsJournalSnapshot>[1]["target"];
        executionPolicy: { fingerprint: string };
      };
      expect(descriptor.executionId).toBe(bound.executionId);
      expect(details).toMatchObject({
        target: spec.target,
        requestFingerprint: evidence.request!.requestFingerprint,
        executionPolicyFingerprint: spec.executionPolicy.fingerprint,
        installationManifestSha256: values.manifestSha256,
        supervisor: bound.helper,
        engine: values.rawPreparedEngine,
      });
      const before = values.rawBeforeInterleaving as Value;
      expect(before).toMatchObject({
        originalBridge: bound.bridge,
        originalHelper: bound.helper,
        originalEngine: details.engine,
        authorizationRecordAbsent: true,
        extraEngineJobHandlesClosed: true,
        membershipEvidenceSource:
          "original-external-job-registration-ack-after-identity-and-injob",
        preparedProbe: {
          engine: details.engine,
          engineLive: true,
          engineInOriginalJob: true,
          activeProcesses: 1,
          totalProcesses: 1,
          firstActionAbsent: true,
        },
      });
      const registrations = before.registrationAcknowledgements as Value[];
      expect(registrations).toEqual([
        bound.bridge,
        bound.helper,
        details.engine,
      ]);
      const guardProcesses = (outer.guard as Value).processes as Value[];
      for (const identity of registrations)
        expect(guardProcesses).toContainEqual(
          expect.objectContaining({
            identity,
            originalJoined: true,
            alive: false,
          }),
        );
      const original = values.child as Value;
      expect(original).toMatchObject({
        identity: bound.bridge,
        started: true,
        originalRetained: true,
        originalJoined: true,
        alive: false,
        forced: false,
        stdinClosedByCaller: true,
        stdout: { actualEof: true, error: null, overflow: false },
        stderr: {
          actualEof: true,
          error: null,
          overflow: false,
          capturedBase64: "",
        },
      });
      expect((values.helper as Value).identity).toEqual(bound.helper);
      const actualFrames = values.frames as Value[];
      const rawOutput = (original.stdout as Value).framesBase64 as string[];
      const decodedOutput = rawOutput.map((base64) => {
        const bytes = Buffer.from(base64, "base64");
        expect(bytes.at(-1)).toBe(10);
        expect(bytes.includes(13)).toBe(false);
        return JSON.parse(bytes.toString("utf8")) as Value;
      });
      expect(decodedOutput).toEqual(actualFrames);
      expect(
        Buffer.concat(
          rawOutput.map((base64) => Buffer.from(base64, "base64")),
        ).toString("base64"),
      ).toBe((original.stdout as Value).capturedBase64);
      expect(actualFrames.filter((frame) => frame.kind === "bound")).toEqual([
        bound,
      ]);
      for (const frame of actualFrames)
        expect(frame.executionId).toBe(bound.executionId);
      const prepareId = "00000000000000000000000000000007";
      const closeId = "00000000000000000000000000000008";
      const authorizeId = "00000000000000000000000000000009";
      const permitRequests = actualFrames.filter(
        (frame) => frame.kind === "permit-request",
      );
      const preparePermit = {
        v: 1,
        kind: "permit-request",
        requestId: prepareId,
        op: "prepare",
        executionId: bound.executionId,
        requestFingerprint: evidence.request!.requestFingerprint,
      };
      const authPermit = {
        ...preparePermit,
        requestId: authorizeId,
        op: "authorize",
      };
      expect(permitRequests).toEqual(
        replay ? [preparePermit] : [preparePermit, authPermit],
      );
      expect(values.firstPrepareResponse).toEqual(preparePermit);
      expect(values.prepareResponse).toMatchObject({
        v: 1,
        kind: "state",
        requestId: prepareId,
        executionId: bound.executionId,
        state: {
          phase: "prepared",
          descriptor,
          authorizationVerified: false,
          resumeState: "not-attempted",
        },
      });
      expect(
        actualFrames.filter(
          (frame) => frame.kind === "state" && frame.requestId === prepareId,
        ),
      ).toEqual([values.prepareResponse]);
      const input = original.sentFramesBase64 as string[];
      const commands = input.map(
        (bytes) =>
          JSON.parse(Buffer.from(bytes, "base64").toString("utf8")) as Value,
      );
      expect(commands).toHaveLength(
        replay || name === "permit-eof" ? 3 : natural ? 5 : 4,
      );
      expect(commands[0]).toEqual({
        v: 1,
        kind: "command",
        requestId: prepareId,
        op: "prepare",
        executionId: bound.executionId,
        requestUtf8Base64: evidence.request!.requestUtf8Base64,
        requestFingerprint: evidence.request!.requestFingerprint,
      });
      const permits = commands.filter((frame) => frame.kind === "permit");
      const suppliedPrepare = { ...preparePermit, kind: "permit", allow: true };
      expect(permits).toEqual(
        replay
          ? [suppliedPrepare, suppliedPrepare]
          : natural
            ? [suppliedPrepare, { ...authPermit, kind: "permit", allow: true }]
            : [suppliedPrepare],
      );
      expect(
        commands
          .filter((frame) => frame.kind === "command")
          .map((frame) => frame.op),
      ).toEqual(
        replay
          ? ["prepare"]
          : name === "permit-eof"
            ? ["prepare", "authorize"]
            : ["prepare", "authorize", "close"],
      );
      if (replay) {
        expect(input[2]).toBe(input[1]);
        expect(values.rawAuthPermitRequest).toBeUndefined();
      } else {
        expect(values.rawAuthPermitRequest).toEqual(authPermit);
        expect(commands[2]).toEqual({
          v: 1,
          kind: "command",
          requestId: authorizeId,
          op: "authorize",
          executionId: bound.executionId,
          target: spec.target,
          descriptor,
          requestFingerprint: evidence.request!.requestFingerprint,
        });
        expect(
          actualFrames.findIndex(
            (frame) =>
              frame.kind === "permit-request" &&
              frame.requestId === authorizeId,
          ),
        ).toBeGreaterThan(
          actualFrames.findIndex(
            (frame) => frame.kind === "state" && frame.requestId === prepareId,
          ),
        );
      }
      const closes = commands.filter((frame) => frame.op === "close");
      expect(closes).toEqual(
        name === "permit-close" || natural
          ? [
              {
                v: 1,
                kind: "command",
                requestId: closeId,
                op: "close",
                executionId: bound.executionId,
              },
            ]
          : [],
      );
      expect(values.rawBeforeInputEof).toEqual({
        callerInputOpen: true,
        completedInputFrames: input.length,
      });
      const ending = { v: 1, kind: "ending", executionId: bound.executionId };
      expect(actualFrames.filter((frame) => frame.kind === "ending")).toEqual([
        ending,
      ]);
      const closed = actualFrames.filter((frame) => frame.kind === "closed");
      expect(closed).toHaveLength(1);
      const outcome = closed[0]!.outcome;
      expect(
        name === "permit-close"
          ? ["stopped", "unknown"]
          : [natural ? "stopped" : "unknown"],
      ).toContain(outcome);
      expect(closed[0]).toEqual({
        v: 1,
        kind: "closed",
        requestId: name === "permit-close" || natural ? closeId : null,
        executionId: bound.executionId,
        outcome,
      });
      expect(actualFrames.at(-1)).toEqual(closed[0]);
      expect(original.exitCode).toBe(outcome === "stopped" ? 0 : 2);
      const unknown = actualFrames.filter((frame) => frame.kind === "unknown");
      if (outcome === "unknown") {
        if (name === "permit-close")
          expect(unknown.length).toBeLessThanOrEqual(1);
        else expect(unknown).toHaveLength(1);
        for (const fault of unknown) {
          expect(fault).toMatchObject({
            v: 1,
            kind: "unknown",
            executionId: bound.executionId,
          });
          expect(
            replay
              ? [null]
              : name === "permit-close"
                ? [authorizeId, closeId, null]
                : [authorizeId, null],
          ).toContain(fault.requestId);
          expect(
            actualFrames
              .slice(actualFrames.indexOf(fault) + 1)
              .some((frame) => frame.kind === "state"),
          ).toBe(false);
        }
      } else expect(unknown).toEqual([]);
      const after = values.rawAfter as Value;
      expect(after.authorizationRecordAbsent).toBe(!natural);
      const engines = after.engines as Value[];
      expect(engines).toHaveLength(1);
      expect(engines[0]).toMatchObject({
        identity: details.engine,
        originalJoined: true,
        alive: false,
      });
      expect(engines[0]!.exitCode).not.toBeNull();
      const strict = values.strictSnapshot as Value;
      const records = strict.records as Value;
      expect(strict.reservation).toMatchObject({ status: "existing" });
      expect(records.request).toMatchObject({ status: "existing" });
      expect(records.prepared).toMatchObject({ status: "existing" });
      const interpreted = interpretWindowsJournalSnapshot(
        strict,
        {
          target: spec.target,
          executionPolicyFingerprint: spec.executionPolicy.fingerprint,
        },
        descriptor,
      );
      if (natural) {
        expect(values.rawNaturalBeforeClose).toEqual({
          finishReleaseCompleted: true,
          ending,
          callerInputOpen: true,
          completedInputFrames: 4,
          originalEngine: details.engine,
          extraEngineJobHandlesClosed: true,
        });
        expect(interpreted.kind).toBe("engine-exit");
        if (interpreted.kind !== "engine-exit")
          throw new Error("Independent original engine terminal proof missing");
        expect(interpreted.exit.completion).toEqual({
          kind: "success",
          exitCode: 0,
          signal: null,
        });
      } else {
        const states = actualFrames.filter((frame) => frame.kind === "state");
        expect(states.filter((frame) => frame.requestId !== null)).toEqual([
          values.prepareResponse,
        ]);
        for (const frame of states)
          expect(frame.state).toMatchObject({
            authorizationVerified: false,
            resumeState: "not-attempted",
          });
        expect(records.authorization).toEqual({
          status: "unknown",
          snapshot: null,
        });
        expect(interpreted.kind).toBe("unknown");
        expect(values.rawNaturalBeforeClose).toBeUndefined();
      }
      const ordinaryAssembly = evidence.artifactsBefore.find(
        (entry) =>
          entry.path === join(dirname(ordinaryExe!), "WindowsSupervisor.dll"),
      );
      expect(values.readerOrdinaryAssemblySha256).toBe(
        ordinaryAssembly!.sha256,
      );
    },
    testMs,
  );

  it.each([
    "natural",
    "fast",
    "nonzero",
    "deny-auth",
    "missing-ack",
    "held-drain",
  ])(
    "runs the real production Node host through the original native %s path",
    async (name) => {
      if (
        (name === "missing-ack" || name === "held-drain") &&
        !process.env.ZEB_WINDOWS_EXECUTION_SUPERVISOR_TEST_EXE
      )
        throw new Error(
          "Separately published test-native supervisor is required",
        );
      const directory = await mkdtemp(join(evidenceRoot, `${name}-商品's 🙂-`));
      const evidence = await exercise(directory, `execution-node-${name}`);
      expect(evidence.failures).toEqual([]);
      expect(evidence.outerExit).toEqual({ code: 0, signal: null });
      expect(evidence.outerClose).toEqual(evidence.outerExit);
      expect(evidence.stdoutEof && evidence.stderrEof).toBe(true);
      expect(evidence.outerStderrBase64).toBe("");
      expect(evidence.artifactsAfter).toEqual(evidence.artifactsBefore);
      const receipt = evidence.receipt!;
      const outer = receipt.outer as Value,
        host = receipt.host as Value;
      expect(outer).toMatchObject({
        primaryFailure: null,
        forcedFallback: false,
        protocolErrors: [],
        guard: { allObservedJoined: true },
      });
      expect(host).toMatchObject({
        setupFailure: null,
        failure: null,
        cleanup: { failures: [], allObservedJoined: true },
      });
      const values = host.values as Value;
      expect(values).toMatchObject({
        bridgeLaunches: 1,
        fixtureHelperLaunches: 0,
        helper: { exitCode: 0, originalJoined: true },
      });
      const result = values.nodeResult as Value;
      expect(result).toMatchObject({
        prepareResult: { kind: "prepared" },
        preparePermits: 1,
        authPermits: 1,
        markerAfterPrepare: false,
      });
      const facts = result.factsAtReturn as Value;
      expect(facts).toMatchObject({
        spawnCount: 1,
        detachedRequested: true,
        stderrBytes: 0,
        stdoutEof: true,
        stderrEof: true,
        stdinClose: true,
        stdoutClose: true,
        stderrClose: true,
        stdinFinish: true,
        writeErrors: 0,
        endCalls: 1,
        endCallbacks: 1,
        errors: [],
        killCalls: 0,
      });
      expect(facts.writeCallbacks).toBe(facts.writeCalls);
      expect(facts.exit).toEqual({
        code: name === "deny-auth" || name === "missing-ack" ? 2 : 0,
        signal: null,
      });
      expect(facts.close).toEqual(facts.exit);
      const closeFacts = result.factsAtCloseReturn as Value;
      const closeResult = result.closeResult as Value;
      if (closeResult.cleanup === "closed") {
        expect(closeFacts.close).not.toBeNull();
        expect(closeFacts).toMatchObject({
          stdoutEof: true,
          stderrEof: true,
          stdinClose: true,
          stdoutClose: true,
          stderrClose: true,
          stdinFinish: true,
          endCalls: 1,
          endCallbacks: 1,
        });
        expect(closeFacts.exit).toEqual(facts.exit);
        expect(closeFacts.close).toEqual(closeFacts.exit);
        expect(closeFacts.writeCallbacks).toBe(closeFacts.writeCalls);
      } else
        expect(closeResult).toEqual({ kind: "unknown", cleanup: "unknown" });
      if (closeResult.kind === "stopped") {
        expect(closeResult).toEqual({ kind: "stopped", cleanup: "closed" });
        expect(closeFacts).toMatchObject({
          exit: { code: 0, signal: null },
          stderrBytes: 0,
          writeErrors: 0,
          errors: [],
        });
        const closeWire = (closeFacts.frames as { frame: Value }[]).map(
          (entry) => entry.frame,
        );
        const terminal = closeWire.filter((frame) => frame.kind === "closed");
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({
          outcome: "stopped",
          requestId: null,
        });
        expect(
          closeWire.filter((frame) => frame.kind === "ending"),
        ).toHaveLength(1);
        expect(closeWire.some((frame) => frame.kind === "unknown")).toBe(false);
      } else expect(closeResult.kind).toBe("unknown");
      if (name === "natural" || name === "nonzero")
        expect(closeResult).toEqual({ kind: "stopped", cleanup: "closed" });
      const bound = values.bound as Value;
      expect(facts.originalPid).toBe((bound.bridge as Value).pid);
      const frames = (
        facts.frames as { frame: Value; rawBase64: string }[]
      ).map((entry) => entry.frame);
      expect(
        frames
          .filter((frame) => frame.kind === "permit-request")
          .map((frame) => frame.op),
      ).toEqual(["prepare", "authorize"]);
      expect(frames.filter((frame) => frame.kind === "ending")).toHaveLength(1);
      expect(frames.filter((frame) => frame.kind === "closed")).toHaveLength(1);
      const commands = (facts.input as string[]).map(
        (bytes) =>
          JSON.parse(Buffer.from(bytes, "base64").toString("utf8")) as Value,
      );
      expect(
        commands
          .filter((frame) => frame.kind === "command")
          .map((frame) => frame.op),
      ).toEqual(["prepare", "authorize"]);
      if (name === "natural") {
        expect(result.passiveWaitAtStart).toEqual({
          endingObserved: false,
          originalChildClosed: false,
          stdinEnded: false,
          endCalls: 0,
        });
        const sequence = closeFacts.events as string[];
        expect(
          sequence.filter((event) => event === "passive-wait-started"),
        ).toHaveLength(1);
        const started = sequence.indexOf("passive-wait-started");
        expect(sequence.indexOf("ending-observed")).toBeGreaterThan(started);
        expect(sequence.indexOf("child-close")).toBeGreaterThan(started);
      }
      expect(
        commands
          .filter((frame) => frame.kind === "permit")
          .map((frame) => frame.allow),
      ).toEqual([true, name !== "deny-auth"]);
      expect((commands[0] as Value).requestUtf8Base64).toBe(
        evidence.request!.requestUtf8Base64,
      );
      const spec = JSON.parse(
        Buffer.from(evidence.request!.requestUtf8Base64, "base64").toString(
          "utf8",
        ),
      ) as {
        target: Parameters<typeof interpretWindowsJournalSnapshot>[1]["target"];
        executionPolicy: { fingerprint: string };
      };
      const descriptor = (
        result.prepareResult as { descriptor: OwnerDescriptor }
      ).descriptor;
      const interpreted = interpretWindowsJournalSnapshot(
        values.strictSnapshot,
        {
          target: spec.target,
          executionPolicyFingerprint: spec.executionPolicy.fingerprint,
        },
        descriptor,
      );
      if (name === "deny-auth") {
        expect(result.authorizationResult).toMatchObject({ kind: "unknown" });
        expect(values.markerPresent).toBe(false);
        expect(interpreted.kind).toBe("unknown");
      } else {
        expect(values.markerPresent).toBe(true);
        expect(interpreted.kind).toBe("engine-exit");
        if (interpreted.kind !== "engine-exit")
          throw new Error("Independent engine terminal proof missing");
        expect(interpreted.exit.completion).toEqual({
          kind: name === "nonzero" ? "failure" : "success",
          exitCode: name === "nonzero" ? 2_147_483_649 : 0,
          signal: null,
        });
        if (name === "missing-ack") {
          expect(result.authorizationResult).toMatchObject({ kind: "unknown" });
        } else {
          if (name === "fast")
            expect(["authorized", "unknown"]).toContain(
              (result.authorizationResult as Value).kind,
            );
          else
            expect(result.authorizationResult).toMatchObject({
              kind: "authorized",
            });
        }
      }
      if (name === "held-drain" || name === "missing-ack") {
        expect(values.beforeBarrierRelease).toMatchObject({
          helperLive: true,
          bridgeLive: true,
          originalEngineJoined: true,
          terminalAbsent: true,
          snapshot: {
            originalBridgeAlive: true,
            facts: { stdoutEof: false, stderrEof: false },
          },
        });
        const snapshot = (values.beforeBarrierRelease as Value)
          .snapshot as Value;
        if (snapshot.closeSettled) {
          expect(snapshot.closeResult).toEqual({
            kind: "unknown",
            cleanup: "unknown",
          });
          expect(result.closeResult).toEqual(snapshot.closeResult);
        } else expect(snapshot.closeResult).toBeUndefined();
        expect(values.barrierReleasedAfterIncompleteObservation).toBe(true);
      }
      if (name === "fast")
        expect(values.finishSentBeforeAuthAckWait).toBe(true);
      const ordinaryAssembly = evidence.artifactsBefore.find(
        (entry) =>
          entry.path === join(dirname(ordinaryExe!), "WindowsSupervisor.dll"),
      );
      expect(values.readerOrdinaryAssemblySha256).toBe(
        ordinaryAssembly!.sha256,
      );
    },
    testMs,
  );

  it.each(["never-prepare", "prepared", "running"])(
    "recovers the original native tree after original Node caller death at %s",
    async (stage) => {
      const directory = await mkdtemp(
        join(evidenceRoot, `caller-death-${stage}-商品's 🙂-`),
      );
      const evidence = await exercise(
        directory,
        `execution-node-caller-death-${stage}`,
      );
      expect(evidence.failures).toEqual([]);
      expect(evidence.outerExit).toEqual({ code: 0, signal: null });
      expect(evidence.outerClose).toEqual(evidence.outerExit);
      expect(evidence.stdoutEof && evidence.stderrEof).toBe(true);
      expect(evidence.outerStderrBase64).toBe("");
      expect(evidence.artifactsAfter).toEqual(evidence.artifactsBefore);
      const receipt = evidence.receipt!;
      const outer = receipt.outer as Value,
        host = receipt.host as Value;
      expect(outer).toMatchObject({
        primaryFailure: null,
        forcedFallback: false,
        protocolErrors: [],
        guard: {
          activeProcesses: 0,
          allObservedJoined: true,
          membershipVerified: true,
        },
      });
      expect(host).toMatchObject({
        setupFailure: null,
        failure: null,
        cleanup: { failures: [], allObservedJoined: true },
      });
      const values = host.values as Value;
      expect(values).toMatchObject({
        bridgeLaunches: 1,
        fixtureHelperLaunches: 0,
        markerPresent: stage === "running",
        bridge: { originalJoined: true, exitCode: 2 },
        helper: { originalJoined: true, exitCode: 0 },
      });
      expect(values.nodeResult).toBeUndefined();
      const before = values.callerDeathBefore as Value;
      const ready = before.ready as Value;
      const facts = ready.facts as Value;
      const bound = values.bound as Value;
      expect(before).toMatchObject({
        stage,
        extraEngineJobHandlesClosed: true,
        membershipEvidenceSource:
          "original-external-job-registration-ack-after-identity-and-injob",
        originalBridge: bound.bridge,
        originalHelper: bound.helper,
        authorizationRecordAbsent: stage !== "running",
      });
      expect(ready).toMatchObject({
        stage,
        binding: bound,
        preparePermits: stage === "never-prepare" ? 0 : 1,
        authPermits: stage === "running" ? 1 : 0,
      });
      expect(facts).toMatchObject({
        spawnCount: 1,
        detachedRequested: true,
        originalPid: (bound.bridge as Value).pid,
        exit: null,
        close: null,
        endCalls: 0,
        endCallbacks: 0,
        killCalls: 0,
        errors: [],
        writeErrors: 0,
      });
      expect(facts.writeCallbacks).toBe(facts.writeCalls);
      const commands = (facts.input as string[]).map(
        (bytes) =>
          JSON.parse(Buffer.from(bytes, "base64").toString("utf8")) as Value,
      );
      expect(
        commands
          .filter((frame) => frame.kind === "command")
          .map((frame) => frame.op),
      ).toEqual(
        stage === "never-prepare"
          ? []
          : stage === "prepared"
            ? ["prepare"]
            : ["prepare", "authorize"],
      );
      expect(
        commands
          .filter((frame) => frame.kind === "permit")
          .map((frame) => frame.allow),
      ).toEqual(
        stage === "never-prepare"
          ? []
          : stage === "prepared"
            ? [true]
            : [true, true],
      );
      const registrations = before.registrationAcknowledgements as Value[];
      expect(registrations).toEqual([
        before.originalNode,
        before.originalBridge,
        before.originalHelper,
        ...(stage === "never-prepare" ? [] : [before.originalEngine]),
      ]);
      const guardProcesses = (outer.guard as Value).processes as Value[];
      for (const identity of registrations)
        expect(guardProcesses).toContainEqual(
          expect.objectContaining({
            identity,
            originalJoined: true,
            alive: false,
          }),
        );
      expect(values.callerDeathInjection).toMatchObject({
        originalNode: before.originalNode,
        intentionalOriginalNodeTermination: true,
        originalNodeJoined: true,
        exitCode: 1,
        helperOrEngineTerminatedByFixture: false,
      });
      const after = values.callerDeathAfter as Value;
      expect(after).toMatchObject({
        node: {
          identity: before.originalNode,
          originalJoined: true,
          exitCode: 1,
          forced: true,
          stdout: { actualEof: true, error: null, overflow: false },
          stderr: { actualEof: true, error: null, overflow: false },
        },
        bridge: {
          identity: before.originalBridge,
          originalJoined: true,
          alive: false,
          exitCode: 2,
        },
        helper: {
          identity: before.originalHelper,
          originalJoined: true,
          alive: false,
          exitCode: 0,
        },
        authorizationRecordAbsent: stage !== "running",
      });
      const engines = after.engines as Value[];
      expect(engines).toHaveLength(stage === "never-prepare" ? 0 : 1);
      expect(
        (values.frames as Value[]).filter(
          (frame) => frame.kind === "node-death-ready",
        ),
      ).toHaveLength(1);
      if (stage === "never-prepare") {
        expect(before.originalEngine).toBeNull();
        expect(values.descriptor).toBeUndefined();
        expect(ready.descriptor).toBeNull();
        expect(ready.markerPresent).toBe(false);
        expect(before).toMatchObject({
          requestRecordAbsent: true,
          preparedRecordAbsent: true,
        });
        expect(after).toMatchObject({
          requestRecordAbsent: true,
          preparedRecordAbsent: true,
        });
      } else {
        const descriptor = values.descriptor as OwnerDescriptor;
        expect(ready.descriptor).toEqual(descriptor);
        expect(before.originalEngine).toEqual(
          (descriptor.details as Value).engine,
        );
        expect(engines[0]).toMatchObject({
          identity: before.originalEngine,
          originalJoined: true,
          alive: false,
        });
        expect(engines[0]!.exitCode).not.toBeNull();
        const spec = JSON.parse(
          Buffer.from(evidence.request!.requestUtf8Base64, "base64").toString(
            "utf8",
          ),
        ) as {
          target: Parameters<
            typeof interpretWindowsJournalSnapshot
          >[1]["target"];
          executionPolicy: { fingerprint: string };
        };
        const interpreted = interpretWindowsJournalSnapshot(
          values.strictSnapshot,
          {
            target: spec.target,
            executionPolicyFingerprint: spec.executionPolicy.fingerprint,
          },
          descriptor,
        );
        if (stage === "prepared") {
          expect(values.preparedBeforeCallerDeath).toMatchObject({
            engine: before.originalEngine,
            engineLive: true,
            engineInOriginalJob: true,
            activeProcesses: 1,
            totalProcesses: 1,
            firstActionAbsent: true,
          });
          expect(ready.markerPresent).toBe(false);
          expect(interpreted.kind).toBe("unknown");
        } else {
          expect(values.authAckBeforeCallerDeath).toMatchObject({
            result: { kind: "authorized" },
          });
          expect(values.runningBeforeCallerDeath).toEqual({
            engine: before.originalEngine,
            peer: before.originalEngine,
            markerIdentity: before.originalEngine,
            originalEngineLive: true,
          });
          expect(interpreted.kind).toBe("interrupted");
        }
      }
      const ordinaryAssembly = evidence.artifactsBefore.find(
        (entry) =>
          entry.path === join(dirname(ordinaryExe!), "WindowsSupervisor.dll"),
      );
      expect(values.readerOrdinaryAssemblySha256).toBe(
        ordinaryAssembly!.sha256,
      );
    },
    testMs,
  );
});
