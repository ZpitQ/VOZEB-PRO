import { createHash } from "node:crypto";

import type { OwnerDescriptor } from "../src/execution.js";
import type { WindowsJournalScope } from "../src/windows-journal-reader.js";

const slots = {
  request: "00000000000000000000000000000001",
  prepared: "00000000000000000000000000000002",
  authorization: "00000000000000000000000000000003",
  terminal: "00000000000000000000000000000006",
} as const;

// Contract data only: no helper, engine, Job or operating-system observation
// produced these identifiers or facts. Each call returns independent mutable input.
export function journalLauncherFixture(): {
  scope: WindowsJournalScope;
  descriptor: OwnerDescriptor;
  snapshot: unknown;
} {
  const executionId = "0123456789abcdef0123456789abcdef";
  const manifestSha256 = "b".repeat(64);
  const limits = {
    executionTimeoutMs: 60_000,
    cancelGraceMs: 5_000,
    leaseDurationMs: 15_000,
    heartbeatIntervalMs: 5_000,
  };
  const scope: WindowsJournalScope = {
    target: {
      identity: {
        jobId: "launcher-synthetic-job",
        attemptNo: 2,
        ownerInstanceId: "launcher-synthetic-original-producer",
        fence: 7,
      },
      launchTicket: "launcher-synthetic-original-launch",
    },
    executionPolicyFingerprint: createHash("sha256")
      .update(JSON.stringify({ limits, allowedTiles: [0, 32, 64] }))
      .digest("hex"),
  };
  const originalSpec = {
    v: 1,
    target: structuredClone(scope.target),
    executionPolicy: {
      limits,
      allowedTiles: [0, 32, 64],
      fingerprint: scope.executionPolicyFingerprint,
    },
    engine: {
      modelId: "launcher-synthetic_4x",
      binaryVersion: "synthetic-binary-1",
      binarySha256: "c".repeat(64),
      modelVersion: "synthetic-model-1",
      modelSha256: "d".repeat(64),
      nativeScale: 4,
      tile: 32,
      tta: false,
      gpuId: 0,
    },
    firstStartedAt: 1_000,
    executionDeadlineAt: 61_000,
    inputPath: "Z:\\contract-only\\输入 🪑\\input.png",
    workingDirectory: "Z:\\contract-only\\work",
    outputPath: "Z:\\contract-only\\work\\output.png",
  };
  const originalRequest = Buffer.from(JSON.stringify(originalSpec), "utf8");
  const requestFingerprint = createHash("sha256")
    .update(originalRequest)
    .digest("hex");
  const descriptor: OwnerDescriptor = {
    adapterId: "windows-supervisor-v1",
    launchTicket: scope.target.launchTicket,
    executionId,
    details: {
      v: 1,
      target: structuredClone(scope.target),
      executionPolicyFingerprint: scope.executionPolicyFingerprint,
      requestFingerprint,
      requestRecordId: slots.request,
      preparedRecordId: slots.prepared,
      recipeId: "upscayl-4x-png-v1",
      installationManifestSha256: manifestSha256,
      supervisor: { pid: 7_001, creationFileTime: "9007199254740993" },
      engine: { pid: 7_002, creationFileTime: "9007199254740994" },
      jobName: "launcher-synthetic-original-job",
    },
  };
  const publicScope = {
    target: structuredClone(scope.target),
    descriptor: structuredClone(descriptor),
  };
  const request = {
    v: 1,
    kind: "windows-request",
    recordId: slots.request,
    requestFingerprint,
    requestUtf8Base64: originalRequest.toString("base64"),
    resolvedLaunch: {
      recipeId: "upscayl-4x-png-v1",
      installationManifestSha256: manifestSha256,
      executablePath: "Z:\\contract-only\\install\\upscayl.exe",
      argv: [
        "-i",
        originalSpec.inputPath,
        "-o",
        originalSpec.outputPath,
        "-n",
        originalSpec.engine.modelId,
        "-s",
        "4",
        "-t",
        "32",
        "-g",
        "0",
        "-m",
        "Z:\\contract-only\\install\\models",
        "-f",
        "png",
      ],
    },
  };
  const prepared = {
    v: 1,
    kind: "windows-prepared",
    recordId: slots.prepared,
    requestRecordId: slots.request,
    requestFingerprint,
    scope: structuredClone(publicScope),
  };
  const authorization = {
    v: 1,
    recordId: slots.authorization,
    scope: structuredClone(publicScope),
    kind: "authorized",
  };
  const terminal = {
    v: 1,
    kind: "windows-terminal",
    recordId: slots.terminal,
    scope: structuredClone(scope),
    requestRecordId: slots.request,
    requestFingerprint,
    preparedRecordId: slots.prepared,
    descriptor: structuredClone(descriptor),
    authorizationRecordId: slots.authorization,
    resumeState: "succeeded",
    completion: { kind: "engine-exit" },
    proof: {
      kind: "engine-tree",
      engine: structuredClone(descriptor.details.engine),
      jobName: descriptor.details.jobName,
      exitCode: 0,
      treeExited: true,
      activeProcesses: 0,
      stdoutEof: true,
      stderrEof: true,
    },
    authorizationsSealed: true,
  };
  const envelope = (
    recordId: string | null,
    record: unknown,
    digit: string,
  ) => ({
    v: 1,
    kind: recordId === null ? "reservation" : "record",
    scope: structuredClone(scope),
    executionId,
    recordId,
    rootIdentity: { volumeSerial: "17", fileId: "1".repeat(32) },
    reservationIdentity: { volumeSerial: "17", fileId: "2".repeat(32) },
    fileIdentity: { volumeSerial: "17", fileId: digit.repeat(32) },
    record: structuredClone(record),
  });
  const existing = (snapshot: unknown) => ({ status: "existing", snapshot });
  return {
    scope,
    descriptor,
    snapshot: {
      v: 1,
      kind: "windows-journal-snapshot",
      reservation: existing(envelope(null, null, "3")),
      records: {
        request: existing(envelope(slots.request, request, "4")),
        prepared: existing(envelope(slots.prepared, prepared, "5")),
        authorization: existing(
          envelope(slots.authorization, authorization, "6"),
        ),
        controllerLoss: { status: "unknown", snapshot: null },
        terminal: existing(envelope(slots.terminal, terminal, "8")),
      },
    },
  };
}
