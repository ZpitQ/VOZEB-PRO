import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { runnerLimits } from "./storage-fixtures.js";

type Value = Record<string, unknown>;
type Receipt = {
  scenario: string;
  setupFailure: unknown;
  failure: unknown;
  setup: Value;
  values: Value;
  cleanup: {
    failures: unknown[];
    activePins: unknown[];
    allLeasesReleased: boolean;
  };
  conditionalUnexecuted: string[];
};

const fixtureVariable = process.env.ZEB_WINDOWS_INSTALLATION_FIXTURE_EXE;
const ordinaryVariable = process.env.ZEB_WINDOWS_INSTALLATION_ORDINARY_DLL;
const explicitlyRequested =
  fixtureVariable !== undefined ||
  ordinaryVariable !== undefined ||
  process.argv.some((argument) =>
    argument.includes("windows-installation.os.test"),
  );
const windowsSuite =
  process.platform === "win32" || explicitlyRequested
    ? describe
    : describe.skip;
const executionMs = runnerLimits.executionTimeoutMs;
const cleanupMs = runnerLimits.cancelGraceMs;
const testMs = executionMs + cleanupMs;
const pendingRemovals = new Set<Promise<void>>();

async function boundedUntil<T>(promise: Promise<T>, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Windows installation fixture deadline exceeded")),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function object(value: unknown): Value {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Value;
}

function objects(value: unknown) {
  expect(Array.isArray(value)).toBe(true);
  return (value as unknown[]).map(object);
}

function diagnostic(value: unknown) {
  const actual = object(value);
  expect(Object.keys(actual).sort()).toEqual(["nativeError", "stage"]);
  expect(actual.stage).toEqual(expect.stringMatching(/^[a-z][a-z0-9_]*$/));
  expect(
    actual.nativeError === null || Number.isInteger(actual.nativeError),
  ).toBe(true);
}

function security(value: unknown) {
  expect(object(value)).toEqual({
    ownerMatchesCurrentSid: true,
    daclPresent: true,
    protectedDacl: true,
    aceCount: 1,
    aces: [
      {
        type: "AccessAllowed",
        flags: 0,
        accessMask: 0x001f01ff,
        sidMatchesCurrent: true,
      },
    ],
  });
}

function file(value: unknown) {
  const actual = object(value);
  const identity = object(actual.identity);
  expect(identity.fileId).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
  expect(identity.volumeSerial).toEqual(
    expect.stringMatching(/^(0|[1-9]\d*)$/),
  );
  security(actual.security);
  expect(actual).toMatchObject({
    nonInherited: true,
    reparse: false,
    deletePending: false,
  });
  expect(actual.creationTime).toEqual(expect.stringMatching(/^\d+$/));
  expect(actual.lastWriteTime).toEqual(expect.stringMatching(/^\d+$/));
  if (actual.directory === false) {
    expect(actual.links).toBe(1);
    expect(actual.sha256).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
  }
  return actual;
}

function pins(value: unknown) {
  const entries = objects(value);
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry).toMatchObject({
      present: true,
      readData: true,
      nonInherited: true,
      readOnly: true,
    });
    expect(entry.matches).toEqual(expect.any(Number));
    expect(entry.matches as number).toBeGreaterThan(0);
  }
}

function denied(value: unknown) {
  const entries = objects(value);
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    for (const operation of ["write", "delete", "rename"]) {
      const attempt = object(entry[operation]);
      expect(attempt.success).toBe(false);
      expect([5, 32]).toContain(attempt.nativeError);
    }
  }
}

function rejectionCases(value: unknown, names: string[]) {
  const cases = objects(value);
  expect(cases.map((entry) => entry.name)).toEqual(names);
  for (const entry of cases) {
    const message = JSON.stringify(entry);
    expect(entry.mutationProven, message).toBe(true);
    expect(entry.unchanged, message).toBe(true);
    expect(entry.activePins, message).toEqual([]);
    for (const mutable of objects(entry.mutable))
      expect(mutable, message).toMatchObject({
        write: { success: true },
        delete: { success: true },
        rename: { success: true },
      });
    const outcome = object(entry.outcome);
    expect(outcome.opened, message).toBe(false);
    if (entry.argument === true) {
      expect(outcome.exceptionType, message).toBe("ArgumentException");
      expect(outcome.diagnostic).toBeNull();
    } else {
      expect(outcome.exceptionType, message).toBe("InstallationException");
      expect(outcome.message, message).toBe("installation_invalid");
      diagnostic(outcome.diagnostic);
      expect(object(outcome.diagnostic).stage).not.toBe(
        "installation_not_implemented",
      );
    }
  }
  return cases;
}

async function runFixture(scenario: string): Promise<Receipt> {
  const executionDeadline = Date.now() + executionMs;
  const directory = await mkdtemp(join(tmpdir(), "zeb-installation-"));
  const lifetime: Value = {
    directory,
    spawnReturned: false,
    closed: false,
    stdoutEof: false,
    stderrEof: false,
    forced: false,
    rmAttempts: 0,
    directoryRemoved: false,
    removalOutcome: "not-started",
    removalPromiseRetained: false,
  };
  let receipt: Receipt | undefined;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  const errors: unknown[] = [];
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  const child = spawn(
    fixtureVariable!,
    [directory, scenario, ordinaryVariable!],
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  lifetime.spawnReturned = true;
  const closed = new Promise<void>((resolveClosed) => {
    child.once("close", (code, observedSignal) => {
      lifetime.closed = true;
      exitCode = code;
      signal = observedSignal;
      resolveClosed();
    });
  });
  child.once("error", (error) => errors.push(error));
  for (const [name, stream] of [
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ] as const) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const append = (text: string) => {
      if (name === "stdout") stdout += text;
      else stderr += text;
    };
    stream.on("data", (bytes: Buffer) => {
      try {
        append(decoder.decode(bytes, { stream: true }));
      } catch (error) {
        errors.push(error);
      }
    });
    stream.once("error", (error) => errors.push(error));
    stream.once("end", () => {
      lifetime[`${name}Eof`] = true;
      try {
        append(decoder.decode());
      } catch (error) {
        errors.push(error);
      }
    });
  }
  child.stdin.on("error", (error) => errors.push(error));
  child.stdin.end();
  try {
    await boundedUntil(closed, executionDeadline);
    expect(errors).toEqual([]);
    expect(lifetime).toMatchObject({
      closed: true,
      stdoutEof: true,
      stderrEof: true,
      forced: false,
    });
    expect({ exitCode, signal, stderr }).toEqual({
      exitCode: 0,
      signal: null,
      stderr: "",
    });
    const lines = stdout.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe("");
    const frame = object(JSON.parse(lines[0]!.replace(/\r$/, "")));
    expect(frame.kind).toBe("installation-receipt");
    receipt = frame.value as Receipt;
    console.info(`WINDOWS_INSTALLATION_RECEIPT ${JSON.stringify(receipt)}`);
    expect(receipt.scenario).toBe(scenario);
    expect(receipt.setupFailure, JSON.stringify(receipt)).toBeNull();
    expect(receipt.cleanup, JSON.stringify(receipt)).toEqual({
      failures: [],
      activePins: [],
      allLeasesReleased: true,
    });
    expect(receipt.failure, JSON.stringify(receipt)).toBeNull();
    expect(receipt.conditionalUnexecuted).toEqual([
      "independent-wrong-SID",
      "remote-filesystem",
      "non-NTFS-volume",
      "other-volume",
    ]);
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanupDeadline = Math.min(
      executionDeadline + cleanupMs,
      Date.now() + cleanupMs,
    );
    lifetime.cleanupDeadlineUnixMs = cleanupDeadline;
    if (lifetime.closed !== true) {
      lifetime.forced = true;
      try {
        child.kill();
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await boundedUntil(closed, cleanupDeadline);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const nativeCleanup = receipt?.cleanup;
    const cleanupProven =
      lifetime.closed === true &&
      lifetime.stdoutEof === true &&
      lifetime.stderrEof === true &&
      errors.length === 0 &&
      nativeCleanup?.allLeasesReleased === true &&
      Array.isArray(nativeCleanup.failures) &&
      nativeCleanup.failures.length === 0 &&
      Array.isArray(nativeCleanup.activePins) &&
      nativeCleanup.activePins.length === 0;
    const exactTemporaryDirectory =
      isAbsolute(directory) &&
      dirname(resolve(directory)) === resolve(tmpdir()) &&
      /^zeb-installation-[^\\/]+$/.test(basename(directory));
    if (
      cleanupProven &&
      exactTemporaryDirectory &&
      Date.now() < cleanupDeadline
    ) {
      lifetime.rmAttempts = 1;
      lifetime.directoryRemoved = null;
      lifetime.removalOutcome = "pending";
      const removal = rm(directory, {
        recursive: true,
        force: false,
        maxRetries: 0,
      });
      pendingRemovals.add(removal);
      lifetime.removalPromiseRetained = true;
      let removalWaitExpired = false;
      void removal.then(
        () => {
          lifetime.directoryRemoved = true;
          lifetime.removalOutcome = "removed";
          pendingRemovals.delete(removal);
          if (removalWaitExpired)
            console.info(
              `WINDOWS_INSTALLATION_REMOVAL ${JSON.stringify({ directory, outcome: "removed", directoryRemoved: true })}`,
            );
        },
        () => {
          lifetime.removalOutcome = "failed";
          pendingRemovals.delete(removal);
          if (removalWaitExpired)
            console.info(
              `WINDOWS_INSTALLATION_REMOVAL ${JSON.stringify({ directory, outcome: "failed", directoryRemoved: null })}`,
            );
        },
      );
      try {
        await boundedUntil(removal, cleanupDeadline);
      } catch (error) {
        cleanupFailures.push(error);
        if (lifetime.removalOutcome === "pending") {
          removalWaitExpired = true;
          lifetime.removalOutcome = "unknown";
        }
      }
    } else
      cleanupFailures.push(
        new Error(
          cleanupProven && exactTemporaryDirectory
            ? "Installation cleanup budget expired; removal was not started"
            : "Installation fixture cleanup unproven; removal was not started",
        ),
      );
    lifetime.final = receipt ?? null;
    lifetime.exitCode = exitCode;
    lifetime.signal = signal;
    lifetime.errors = errors.map((error) =>
      error instanceof Error ? error.name : typeof error,
    );
    console.info(`WINDOWS_INSTALLATION_LIFETIME ${JSON.stringify(lifetime)}`);
  }
  if (primaryFailure !== undefined && cleanupFailures.length !== 0)
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      "Installation behavior and cleanup failed",
    );
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailures.length !== 0)
    throw new AggregateError(
      cleanupFailures,
      "Installation fixture cleanup failed",
    );
  return receipt!;
}

windowsSuite("ordinary Windows installation binding", () => {
  beforeAll(async () => {
    expect(process.platform).toBe("win32");
    expect(
      fixtureVariable,
      "Set ZEB_WINDOWS_INSTALLATION_FIXTURE_EXE to the published ordinary fixture executable",
    ).toEqual(expect.any(String));
    expect(
      ordinaryVariable,
      "Set ZEB_WINDOWS_INSTALLATION_ORDINARY_DLL to the ordinary supervisor DLL",
    ).toEqual(expect.any(String));
    expect(isAbsolute(fixtureVariable!)).toBe(true);
    expect(isAbsolute(ordinaryVariable!)).toBe(true);
    await Promise.all([access(fixtureVariable!), access(ordinaryVariable!)]);
  });

  it(
    "T0 independent protected bundle, strict UTF8, raw hashes, FileIds, shares and ordinary surface",
    async () => {
      const { setup, values } = await runFixture("T0");
      expect(setup).toMatchObject({
        ordinary: { approvedBytesMatch: true, testHooksAbsent: true },
        utf8: {
          webName: "utf-8",
          codePage: 65001,
          encoderFallback: "EncoderExceptionFallback",
          decoderFallback: "DecoderExceptionFallback",
          preambleBytes: 0,
        },
        utf8Echo: "installation 測試 🙂 with spaces",
      });
      expect(values).toMatchObject({
        productionOpenCalls: 0,
        hashesMatch: true,
        strictJsonUtf8: true,
        bytesAndTimesUnchanged: true,
        decoderRejectsMalformed: true,
        volume: {
          filesystem: "NTFS",
          driveType: 3,
          persistentAcls: true,
          guidMapped: true,
        },
        binding: {
          sameVolume: true,
          distinctObjectIdentities: true,
          actualParentPathsBound: true,
        },
      });
      const files = objects(values.files);
      expect(files.length).toBe(10);
      for (const entry of files) file(entry);
      pins(values.pins);
      denied(values.denied);
      for (const entry of objects(values.released))
        expect(entry).toMatchObject({
          write: { success: true },
          delete: { success: true },
          rename: { success: true },
        });
    },
    testMs,
  );

  it(
    "T1 valid selected CLI and model keep actual pins and exact frozen Unicode recipe",
    async () => {
      const { values } = await runFixture("T1");
      const outcome = object(values.outcome);
      expect(outcome.opened, JSON.stringify(outcome)).toBe(true);
      expect(outcome.diagnostic).toBeNull();
      expect(values).toMatchObject({
        recipeMatches: true,
        argumentsReadOnly: true,
        hashesMatch: true,
        bytesAndTimesUnchanged: true,
        launchPathsBound: true,
        binding: {
          sameVolume: true,
          distinctObjectIdentities: true,
          actualParentPathsBound: true,
        },
      });
      pins(values.pins);
      denied(values.denied);
      expect(values.arguments).toEqual(values.expectedArguments);
      expect(object(values.launch).modelDirectory).toMatch(/^[A-Za-z]:\\/);
      const argumentRejections = objects(values.argumentRejections);
      expect(argumentRejections.map((entry) => entry.name)).toEqual([
        "input-null",
        "output-null",
        "input-empty",
        "output-empty",
        "input-relative",
        "output-relative",
        "input-drive-relative",
        "output-drive-relative",
        "input-nul",
        "output-nul",
        "input-unc",
        "output-unc",
        "input-device",
        "output-device",
      ]);
      for (const entry of argumentRejections) expect(entry.rejected).toBe(true);
      expect(objects(values.files).length).toBe(10);
      for (const entry of objects(values.files)) file(entry);
    },
    testMs,
  );

  it(
    "TTA appends exactly one native -x only for the frozen enabled engine",
    async () => {
      const { values } = await runFixture("TTA");
      const cases = objects(values.cases);
      expect(cases.map((entry) => entry.tta)).toEqual([false, true]);
      for (const entry of cases) {
        expect(entry).toMatchObject({
          outcome: { opened: true, diagnostic: null },
          snapshotFrozen: true,
          argumentsReadOnly: true,
          bytesAndTimesUnchanged: true,
        });
        expect(entry.arguments).toEqual(entry.expectedArguments);
        expect((entry.arguments as string[]).filter((value) => value === "-x")).toHaveLength(entry.tta ? 1 : 0);
      }
    },
    testMs,
  );

  it(
    "T2 rejects manifest parsing, external digest, duplicate fields and noncanonical declarations",
    async () => {
      const { values } = await runFixture("T2");
      rejectionCases(values.cases, [
        "external-digest",
        "manifest-utf8",
        "manifest-json",
        "manifest-trailing",
        "manifest-partial",
        "manifest-array",
        "root-duplicate",
        "root-unknown",
        "root-missing",
        "root-type",
        "manifest-version",
        "manifest-platform",
        "manifest-recipe",
        "files-empty",
        "entry-undeclared",
        "file-duplicate",
        "file-unknown",
        "file-missing",
        "file-type",
        "file-case-collision",
        "length-noncanonical",
        "digest-uppercase",
        "model-duplicate",
        "model-unknown",
        "model-missing",
        "model-type",
        "catalog-digest-uppercase",
        "catalog-id-duplicate",
        "catalog-path-collision",
      ]);
    },
    testMs,
  );

  it(
    "T3 rejects frozen selection mismatch and actual CLI, dependency, model-set and model pair corruption",
    async () => {
      const { values } = await runFixture("T3");
      rejectionCases(values.cases, [
        "binary-version",
        "binary-digest",
        "model-version",
        "model-digest",
        "model-id",
        "native-scale",
        "tile-small",
        "tile-unsafe",
        "gpu-negative",
        "gpu-unsafe",
        "binary-changed",
        "binary-missing",
        "binary-truncated",
        "dependency-changed",
        "dependency-missing",
        "dependency-truncated",
        "model-set-changed",
        "model-set-missing",
        "model-set-truncated",
        "model-bin-changed",
        "model-bin-missing",
        "model-bin-truncated",
        "model-param-changed",
        "model-param-missing",
        "model-param-truncated",
        "model-name",
        "model-pair-name",
        "model-pair-duplicate",
        "model-pair-missing",
        "model-set-unknown",
        "model-set-duplicate",
        "model-file-unknown",
        "model-file-duplicate",
        "model-file-length",
        "model-set-utf8",
        "model-set-json",
        "model-set-trailing",
        "model-set-array",
        "model-set-type",
        "model-set-missing-field",
        "model-file-missing-field",
        "model-file-type",
        "model-file-digest",
      ]);
    },
    testMs,
  );

  it(
    "T4 rejects actual ACL, directory, hardlink, junction and path alias evidence",
    async () => {
      const { values } = await runFixture("T4");
      const cases = rejectionCases(values.cases, [
        "root-extra-ace",
        "binary-parent-extra-ace",
        "models-chain-extra-ace",
        "model-parent-extra-ace",
        "file-extra-ace",
        "manifest-extra-ace",
        "dependency-extra-ace",
        "model-set-extra-ace",
        "model-bin-extra-ace",
        "model-param-extra-ace",
        "file-directory",
        "file-hardlink",
        "root-junction",
        "parent-junction",
        "path-dotdot",
        "path-dot",
        "path-empty",
        "path-backslash",
        "path-ads",
        "path-device",
        "path-device-extension",
        "path-absolute",
        "path-unc",
        "path-trailing-dot",
        "path-trailing-space",
        "path-invalid-character",
        "model-stem-separator",
        "model-stem-whitespace",
      ]);
      expect(
        object(cases.find((entry) => entry.name === "file-hardlink")!.proof)
          .links,
      ).toBe(2);
      for (const name of ["root-junction", "parent-junction"])
        expect(
          object(cases.find((entry) => entry.name === name)!.proof).reparse,
        ).toBe(true);
    },
    testMs,
  );

  it(
    "T5 holds selected bytes and directories until idempotent Dispose, then permits own write",
    async () => {
      const { values } = await runFixture("T5");
      expect(object(values.outcome).opened).toBe(true);
      pins(values.pins);
      denied(values.denied);
      expect(values).toMatchObject({
        bytesAndTimesUnchanged: true,
        disposeTwiceSucceeded: true,
        disposedArgumentsRejected: true,
        afterDisposeWriteSucceeded: true,
        afterDisposeHashChanged: true,
        activePinsAfterDispose: [],
      });
      for (const entry of objects(values.released))
        expect(entry).toMatchObject({
          write: { success: true },
          delete: { success: true },
          rename: { success: true },
        });
    },
    testMs,
  );

  it(
    "T6 selects only declared requested model, freezes caller values and preserves raw JSON byte order",
    async () => {
      const { values } = await runFixture("T6");
      for (const entry of objects(values.positives)) {
        expect(object(entry.outcome).opened, JSON.stringify(entry)).toBe(true);
        expect(entry).toMatchObject({
          unselectedBytesAbsent: true,
          snapshotFrozen: true,
          rawManifestHashMatches: true,
          rawModelHashMatches: true,
          bytesAndTimesUnchanged: true,
        });
        pins(entry.pins);
      }
      expect(objects(values.positives).map((entry) => entry.name)).toEqual([
        "catalog-selected",
        "raw-json-order",
        "path-case-spelling",
      ]);
      const caseSpelling = object(objects(values.positives)[2]);
      expect(object(caseSpelling.outcome).diagnostic).toBeNull();
      expect(caseSpelling).toMatchObject({
        declaredEntryPoint: "BIN/upscayl-bin.exe",
        declaredBinaryPath: "BIN/upscayl-bin.exe",
        declaredFiles: 2,
        payloadHashesMatch: true,
        argumentsReadOnly: true,
        launchPathsBound: true,
        binding: {
          sameVolume: true,
          distinctObjectIdentities: true,
          actualParentPathsBound: true,
        },
        activePinsAfterDispose: [],
      });
      denied(caseSpelling.denied);
      expect(caseSpelling.arguments).toEqual(caseSpelling.expectedArguments);
      expect(objects(caseSpelling.files).length).toBe(10);
      for (const actual of objects(caseSpelling.files)) file(actual);
      expect(objects(caseSpelling.released).length).toBe(10);
      for (const released of objects(caseSpelling.released))
        expect(released).toMatchObject({
          write: { success: true },
          delete: { success: true },
          rename: { success: true },
        });
      rejectionCases(values.cases, [
        "unselected-requested",
        "unknown-requested",
        "catalog-selected-version",
        "catalog-selected-digest",
      ]);
    },
    testMs,
  );

  it(
    "T7 late model failure releases every acquired pin and invalid API values precede missing evidence",
    async () => {
      const { values } = await runFixture("T7");
      rejectionCases(values.cases, ["late-selected-param-hash"]);
      const late = objects(values.cases)[0]!;
      expect(late).toMatchObject({
        earlierPayloadHashesMatch: true,
        latePairHashMismatch: true,
        latePairLengthMatches: true,
        neverReturnedLease: true,
      });
      for (const entry of objects(values.arguments)) {
        expect(entry).toMatchObject({
          rootAbsentBefore: true,
          rootAbsentAfter: true,
          treeUnchanged: true,
          outcome: {
            opened: false,
            exceptionType: "ArgumentException",
            diagnostic: null,
          },
        });
      }
      expect(objects(values.arguments).map((entry) => entry.name)).toEqual([
        "root-null",
        "root-empty",
        "root-relative",
        "root-nul",
        "root-unc",
        "root-device",
        "manifest-null",
        "manifest-empty",
        "manifest-uppercase",
        "manifest-nonhex",
        "engine-null",
        "id-empty",
        "id-invalid",
        "version-empty",
        "version-whitespace",
        "version-control",
        "model-version-empty",
        "binary-hash-invalid",
        "model-hash-invalid",
        "scale-invalid",
        "tile-negative",
        "tile-invalid",
        "tile-unsafe",
        "gpu-negative",
        "gpu-unsafe",
      ]);
      expect(values).toMatchObject({
        correctedIndependentOpen: { opened: true },
        correctionWasOwnWrite: true,
        correctedBundleReleased: true,
      });
      expect(object(values.correctedFirstFailure).opened).toBe(false);
      diagnostic(object(values.correctedFirstFailure).diagnostic);
    },
    testMs,
  );

  it(
    "D07-MP rejects the production-selected model for caller FILE_READ_DATA denial and reopens after exact ACL restoration",
    async () => {
      const { values } = await runFixture("D07MP");
      expect(values, JSON.stringify(values)).toEqual({
        selectedOutcome: { opened: true, exceptionType: null, message: null, diagnostic: null },
        deniedOutcome: {
          opened: false,
          exceptionType: "InstallationException",
          message: "installation_invalid",
          diagnostic: { stage: "file_open", nativeError: 5 },
        },
        reopenedOutcome: { opened: true, exceptionType: null, message: null, diagnostic: null },
        selectedFromProductionLaunch: true,
        denyReadDataInstalled: true,
        controlRead: { openError: 0, readError: 0, bytesRead: 1, handleClosed: true },
        selectedRead: { openError: 5, readError: null, bytesRead: 0, handleClosed: true },
        activeOtherPinsAfterDeniedOpen: [],
        callerBytesPreserved: true,
        leafAclRestored: true,
        leafPreserved: true,
        controlPreserved: true,
        ancestorAclsUnchangedDuring: true,
        ancestorAclsUnchangedAfter: true,
        bundlePreserved: true,
        bindingPreserved: true,
        activePinsAfterProbe: [],
        productReadDenialExercised: true,
        workflowDiagnosticExercised: false,
        scmIdentityExercised: false,
      });
    },
    testMs,
  );
});
