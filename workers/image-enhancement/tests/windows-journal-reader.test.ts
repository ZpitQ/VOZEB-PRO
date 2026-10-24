import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  freezeDurableInterruptionRecords,
  freezeExecutionExit,
  freezeOwnerDescriptor,
  type OwnerDescriptor,
} from "../src/execution.js";
import {
  interpretWindowsJournalSnapshot,
  type WindowsJournalScope,
} from "../src/windows-journal-reader.js";

type ObjectValue = Record<string, unknown>;
type Path = readonly string[];
type Slot =
  "request" | "prepared" | "authorization" | "controllerLoss" | "terminal";
type Fixture = {
  snapshot: ObjectValue;
  expectedScope: WindowsJournalScope;
  originalDescriptor: OwnerDescriptor;
};

const slots: Record<Slot, string> = {
  request: "00000000000000000000000000000001",
  prepared: "00000000000000000000000000000002",
  authorization: "00000000000000000000000000000003",
  controllerLoss: "00000000000000000000000000000005",
  terminal: "00000000000000000000000000000006",
};
const executionId = "0123456789abcdef0123456789abcdef";
const manifestSha256 = "b".repeat(64);
const volumeSerial = "18446744073709551615";

function hash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectAt(root: unknown, path: Path): ObjectValue {
  let value = root;
  for (const key of path) value = (value as ObjectValue)[key];
  return value as ObjectValue;
}

function setAt(root: unknown, path: Path, value: unknown): void {
  Object.defineProperty(objectAt(root, path.slice(0, -1)), path.at(-1)!, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function recordPath(slot: Slot, ...tail: string[]): string[] {
  return ["snapshot", "records", slot, "snapshot", "record", ...tail];
}

function envelopePath(slot: Slot, ...tail: string[]): string[] {
  return ["snapshot", "records", slot, "snapshot", ...tail];
}

function unknownResult(): ObjectValue {
  return { status: "unknown", snapshot: null };
}

function existing(snapshot: ObjectValue): ObjectValue {
  return { status: "existing", snapshot };
}

function scope(): WindowsJournalScope {
  const limits = {
    executionTimeoutMs: 60_000,
    cancelGraceMs: 5_000,
    leaseDurationMs: 15_000,
    heartbeatIntervalMs: 5_000,
  };
  return {
    target: {
      identity: {
        jobId: "reader-fixture-job",
        attemptNo: 2,
        ownerInstanceId: "reader-original-producer",
        fence: 7,
      },
      launchTicket: "reader-original-launch",
    },
    executionPolicyFingerprint: hash(
      JSON.stringify({ limits, allowedTiles: [0, 32, 64] }),
    ),
  };
}

// This is a complete synthetic original PrepareSpec, not a recovery parser.
function originalSpec(expectedScope: WindowsJournalScope) {
  return {
    v: 1,
    target: structuredClone(expectedScope.target),
    executionPolicy: {
      limits: {
        executionTimeoutMs: 60_000,
        cancelGraceMs: 5_000,
        leaseDurationMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
      allowedTiles: [0, 32, 64],
      fingerprint: expectedScope.executionPolicyFingerprint,
    },
    engine: {
      modelId: "reader-fixture_4x",
      binaryVersion: "fixture-binary-1",
      binarySha256: "c".repeat(64),
      modelVersion: "fixture-model-1",
      modelSha256: "d".repeat(64),
      nativeScale: 4,
      tile: 32,
      tta: false,
      gpuId: 0,
    },
    firstStartedAt: 1_000,
    executionDeadlineAt: 61_000,
    inputPath: "Z:\\contract-only\\\u8f93\u5165 \ud83e\ude91\\input.png",
    workingDirectory: "Z:\\contract-only\\work",
    outputPath: "Z:\\contract-only\\work\\output.png",
  };
}

function envelope(
  expectedScope: WindowsJournalScope,
  recordId: string | null,
  record: unknown,
  fileDigit: string,
): ObjectValue {
  return {
    v: 1,
    kind: recordId === null ? "reservation" : "record",
    scope: structuredClone(expectedScope),
    executionId,
    recordId,
    rootIdentity: { volumeSerial, fileId: "1".repeat(32) },
    reservationIdentity: { volumeSerial, fileId: "2".repeat(32) },
    fileIdentity: { volumeSerial, fileId: fileDigit.repeat(32) },
    record: structuredClone(record),
  };
}

function engineFixture(
  exitCode = 0,
  pretty = false,
  expectedScope = scope(),
): Fixture {
  const spec = originalSpec(expectedScope);
  const bytes = Buffer.from(
    JSON.stringify(spec, null, pretty ? 2 : undefined),
    "utf8",
  );
  const requestFingerprint = hash(bytes);
  const originalDescriptor: OwnerDescriptor = {
    adapterId: "windows-supervisor-v1",
    launchTicket: expectedScope.target.launchTicket,
    executionId,
    details: {
      v: 1,
      target: structuredClone(expectedScope.target),
      executionPolicyFingerprint: expectedScope.executionPolicyFingerprint,
      requestFingerprint,
      requestRecordId: slots.request,
      preparedRecordId: slots.prepared,
      recipeId: "upscayl-4x-png-v1",
      installationManifestSha256: manifestSha256,
      supervisor: { pid: 7_001, creationFileTime: "9007199254740993" },
      engine: { pid: 4_294_967_295, creationFileTime: "18446744073709551615" },
      jobName: "reader-original-job",
    },
  };
  const recordScope = {
    target: structuredClone(expectedScope.target),
    descriptor: structuredClone(originalDescriptor),
  };
  const request = {
    v: 1,
    kind: "windows-request",
    recordId: slots.request,
    requestFingerprint,
    requestUtf8Base64: bytes.toString("base64"),
    resolvedLaunch: {
      recipeId: "upscayl-4x-png-v1",
      installationManifestSha256: manifestSha256,
      executablePath: "Z:\\contract-only\\install\\upscayl.exe",
      argv: [
        "-i",
        spec.inputPath,
        "-o",
        spec.outputPath,
        "-n",
        spec.engine.modelId,
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
    scope: structuredClone(recordScope),
  };
  const authorization = {
    v: 1,
    recordId: slots.authorization,
    scope: structuredClone(recordScope),
    kind: "authorized",
  };
  const terminal = {
    v: 1,
    kind: "windows-terminal",
    recordId: slots.terminal,
    scope: structuredClone(expectedScope),
    requestRecordId: slots.request,
    requestFingerprint,
    preparedRecordId: slots.prepared,
    descriptor: structuredClone(originalDescriptor),
    authorizationRecordId: slots.authorization,
    resumeState: "succeeded",
    completion: { kind: "engine-exit" },
    proof: {
      kind: "engine-tree",
      engine: structuredClone(originalDescriptor.details.engine),
      jobName: originalDescriptor.details.jobName,
      exitCode,
      treeExited: true,
      activeProcesses: 0,
      stdoutEof: true,
      stderrEof: true,
    },
    authorizationsSealed: true,
  };
  return {
    expectedScope: structuredClone(expectedScope),
    originalDescriptor,
    snapshot: {
      v: 1,
      kind: "windows-journal-snapshot",
      reservation: existing(envelope(expectedScope, null, null, "3")),
      records: {
        request: existing(envelope(expectedScope, slots.request, request, "4")),
        prepared: existing(
          envelope(expectedScope, slots.prepared, prepared, "5"),
        ),
        authorization: existing(
          envelope(expectedScope, slots.authorization, authorization, "6"),
        ),
        controllerLoss: unknownResult(),
        terminal: existing(
          envelope(expectedScope, slots.terminal, terminal, "8"),
        ),
      },
    },
  };
}

function interruptionScope(fixture: Fixture) {
  return {
    target: structuredClone(fixture.expectedScope.target),
    descriptor: structuredClone(fixture.originalDescriptor),
  };
}

function lossRecord(fixture: Fixture) {
  return {
    v: 1,
    recordId: slots.controllerLoss,
    scope: interruptionScope(fixture),
    kind: "controller-lost",
    authorizationRecordId: slots.authorization,
  };
}

function interruptedFixture(): Fixture {
  const fixture = engineFixture();
  setAt(
    fixture,
    ["snapshot", "records", "controllerLoss"],
    existing(
      envelope(
        fixture.expectedScope,
        slots.controllerLoss,
        lossRecord(fixture),
        "7",
      ),
    ),
  );
  const terminal = {
    v: 1,
    recordId: slots.terminal,
    scope: interruptionScope(fixture),
    kind: "terminal",
    completion: "interrupted",
    authorizationRecordId: slots.authorization,
    controllerLossRecordId: slots.controllerLoss,
    treeExited: true,
    authorizationsSealed: true,
  };
  setAt(
    fixture,
    ["snapshot", "records", "terminal"],
    existing(envelope(fixture.expectedScope, slots.terminal, terminal, "8")),
  );
  return fixture;
}

function interpret(fixture: Fixture) {
  return interpretWindowsJournalSnapshot(
    fixture.snapshot,
    fixture.expectedScope,
    fixture.originalDescriptor,
  );
}

function expectUnknown(fixture: Fixture): void {
  const actual = interpret(fixture);
  expect(actual).toEqual({ kind: "unknown" });
  expect(Object.isFrozen(actual)).toBe(true);
}

function expectFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectFrozen(child);
}

function exitBase(fixture: Fixture) {
  return {
    identity: structuredClone(fixture.expectedScope.target.identity),
    descriptor: structuredClone(fixture.originalDescriptor),
    launchTicket: fixture.expectedScope.target.launchTicket,
    treeExited: true,
  };
}

function bindDescriptor(fixture: Fixture, descriptor: OwnerDescriptor): void {
  fixture.originalDescriptor = structuredClone(descriptor);
  for (const slot of [
    "prepared",
    "authorization",
    "controllerLoss",
    "terminal",
  ] as const) {
    const result = objectAt(fixture, ["snapshot", "records", slot]);
    if (result.status !== "existing") continue;
    const record = objectAt(fixture, recordPath(slot));
    if (record.kind === "windows-terminal")
      record.descriptor = structuredClone(descriptor);
    else setAt(record, ["scope", "descriptor"], structuredClone(descriptor));
  }
}

function bindRequestBytes(fixture: Fixture, bytes: Uint8Array): void {
  const requestFingerprint = hash(bytes);
  setAt(
    fixture,
    recordPath("request", "requestUtf8Base64"),
    Buffer.from(bytes).toString("base64"),
  );
  for (const slot of ["request", "prepared", "terminal"] as const)
    setAt(fixture, recordPath(slot, "requestFingerprint"), requestFingerprint);
  const descriptor = structuredClone(fixture.originalDescriptor);
  setAt(descriptor, ["details", "requestFingerprint"], requestFingerprint);
  bindDescriptor(fixture, descriptor);
}

describe("Windows journal snapshot interpretation", () => {
  it("qualifies original engine exit0 when controllerLoss is unknown", () => {
    const fixture = engineFixture();
    const actual = interpret(fixture);
    expect(actual.kind).toBe("engine-exit");
    expect(actual).toEqual({
      kind: "engine-exit",
      exit: {
        ...exitBase(fixture),
        completion: { kind: "success", exitCode: 0, signal: null },
      },
    });
    if (actual.kind !== "engine-exit")
      throw new Error("qualified exit required");
    expect(
      freezeExecutionExit(
        actual.exit,
        fixture.expectedScope.target,
        fixture.originalDescriptor,
      ),
    ).toEqual(actual.exit);
    expect(
      freezeOwnerDescriptor(
        actual.exit.descriptor,
        fixture.expectedScope.target.launchTicket,
      ),
    ).toEqual(fixture.originalDescriptor);
  });

  it("retains a high UInt32 engine exit as failure with no inferred OOM", () => {
    const fixture = engineFixture(0xffff_ffff);
    expect(interpret(fixture)).toEqual({
      kind: "engine-exit",
      exit: {
        ...exitBase(fixture),
        completion: { kind: "failure", exitCode: 4_294_967_295, signal: null },
      },
    });
  });

  it.each(
    (["stop", "deadline"] as const).flatMap((kind) =>
      [0, 1, 0xffff_ffff].map((exitCode) => ({ kind, exitCode })),
    ),
  )(
    "qualifies resumed $kind without business completion at UInt32 $exitCode",
    ({ kind, exitCode }) => {
      const fixture = engineFixture(exitCode);
      setAt(fixture, recordPath("terminal", "completion"), { kind });
      const before = structuredClone(fixture);
      const actual = interpret(fixture);
      expect(actual).toEqual({ kind, exit: exitBase(fixture) });
      if (actual.kind !== kind)
        throw new Error("qualified stopped tree required");
      expect(Object.hasOwn(actual.exit, "completion")).toBe(false);
      expect(
        freezeExecutionExit(
          actual.exit,
          fixture.expectedScope.target,
          fixture.originalDescriptor,
        ),
      ).toEqual(actual.exit);
      expectFrozen(actual);
      expect(fixture).toEqual(before);
    },
  );

  it("binds valid Unicode and original JSON whitespace to the original byte SHA", () => {
    const fixture = engineFixture(0, true);
    const request = objectAt(fixture, recordPath("request"));
    const bytes = Buffer.from(request.requestUtf8Base64 as string, "base64");
    expect(hash(bytes)).not.toBe(
      hash(JSON.stringify(originalSpec(fixture.expectedScope))),
    );
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toContain(
      "\u8f93\u5165 \ud83e\ude91",
    );
    const actual = interpret(fixture);
    expect(actual.kind).toBe("engine-exit");
    if (actual.kind !== "engine-exit")
      throw new Error("qualified exit required");
    expect(actual.exit.descriptor.details.requestFingerprint).toBe(hash(bytes));
  });

  it("compares complete descriptor objects independently of object key order", () => {
    const fixture = engineFixture();
    const details = objectAt(
      fixture,
      recordPath("prepared", "scope", "descriptor", "details"),
    );
    setAt(
      fixture,
      recordPath("prepared", "scope", "descriptor", "details"),
      Object.fromEntries(Object.entries(details).reverse()),
    );
    expect(interpret(fixture).kind).toBe("engine-exit");
  });

  it("qualifies the complete public interrupted chain without inventing exitCode or signal", () => {
    const fixture = interruptedFixture();
    const expectedRecords = {
      authorization: structuredClone(
        objectAt(fixture, recordPath("authorization")),
      ),
      controllerLoss: structuredClone(
        objectAt(fixture, recordPath("controllerLoss")),
      ),
      terminal: structuredClone(objectAt(fixture, recordPath("terminal"))),
    };
    const actual = interpret(fixture);
    expect(actual.kind).toBe("interrupted");
    expect(actual).toEqual({
      kind: "interrupted",
      exit: {
        ...exitBase(fixture),
        completion: {
          kind: "interrupted",
          authorizationRecordId: slots.authorization,
          controllerLossRecordId: slots.controllerLoss,
          terminalRecordId: slots.terminal,
        },
      },
      records: expectedRecords,
    });
    if (actual.kind !== "interrupted")
      throw new Error("interrupted chain required");
    expect(
      freezeDurableInterruptionRecords(
        actual.records,
        interruptionScope(fixture),
      ),
    ).toEqual(expectedRecords);
    expect(
      freezeExecutionExit(
        actual.exit,
        fixture.expectedScope.target,
        fixture.originalDescriptor,
      ),
    ).toEqual(actual.exit);
  });

  it.each(["engine-exit", "interrupted", "stop", "deadline"] as const)(
    "copies and recursively freezes the qualified %s result",
    (kind) => {
      const fixture =
        kind === "interrupted" ? interruptedFixture() : engineFixture();
      if (kind === "stop" || kind === "deadline")
        setAt(fixture, recordPath("terminal", "completion"), { kind });
      const actual = interpret(fixture);
      expect(actual.kind).toBe(kind);
      if (actual.kind === "unknown")
        throw new Error("qualified result required");
      const before = structuredClone(actual);
      expectFrozen(actual);
      expect(actual.exit.identity).not.toBe(
        fixture.expectedScope.target.identity,
      );
      expect(actual.exit.descriptor).not.toBe(fixture.originalDescriptor);
      expect(actual.exit.descriptor.details).not.toBe(
        fixture.originalDescriptor.details,
      );
      if (actual.kind === "interrupted") {
        expect(actual.records.authorization).not.toBe(
          objectAt(fixture, recordPath("authorization")),
        );
        expect(actual.records.terminal.scope.descriptor.details).not.toBe(
          objectAt(
            fixture,
            recordPath("terminal", "scope", "descriptor", "details"),
          ),
        );
      }
      expect(Object.isFrozen(fixture.expectedScope.target.identity)).toBe(
        false,
      );
      expect(Object.isFrozen(fixture.originalDescriptor.details)).toBe(false);
      setAt(
        fixture.expectedScope,
        ["target", "identity", "jobId"],
        "later-publisher-job",
      );
      setAt(fixture.originalDescriptor, ["details", "engine", "pid"], 99);
      setAt(
        fixture,
        recordPath(
          "authorization",
          "scope",
          "descriptor",
          "details",
          "jobName",
        ),
        "later-job",
      );
      setAt(fixture, recordPath("terminal", "completion"), { kind: "stop" });
      expect(actual).toEqual(before);
    },
  );

  it.each([null, undefined, [], "snapshot", 1, false])(
    "returns frozen unknown for a non-response %j",
    (snapshot) => {
      const fixture = engineFixture();
      setAt(fixture, ["snapshot"], snapshot);
      expectUnknown(fixture);
    },
  );

  const exactObjects: Array<[string, Path, string]> = [
    ["response", ["snapshot"], "v"],
    ["records", ["snapshot", "records"], "request"],
    ["reservation result", ["snapshot", "reservation"], "status"],
    [
      "reservation envelope",
      ["snapshot", "reservation", "snapshot"],
      "fileIdentity",
    ],
    [
      "journal scope",
      ["snapshot", "reservation", "snapshot", "scope"],
      "target",
    ],
    ["expected scope", ["expectedScope"], "executionPolicyFingerprint"],
    ["target", ["expectedScope", "target"], "identity"],
    ["identity", ["expectedScope", "target", "identity"], "fence"],
    [
      "root file identity",
      ["snapshot", "reservation", "snapshot", "rootIdentity"],
      "volumeSerial",
    ],
    [
      "marker file identity",
      ["snapshot", "reservation", "snapshot", "reservationIdentity"],
      "fileId",
    ],
    ["record file identity", envelopePath("request", "fileIdentity"), "fileId"],
    ["existing slot result", ["snapshot", "records", "request"], "snapshot"],
    [
      "unknown slot result",
      ["snapshot", "records", "controllerLoss"],
      "snapshot",
    ],
    ["record envelope", envelopePath("request"), "recordId"],
    ["request", recordPath("request"), "requestUtf8Base64"],
    ["resolved launch", recordPath("request", "resolvedLaunch"), "argv"],
    ["prepared", recordPath("prepared"), "requestRecordId"],
    ["prepared scope", recordPath("prepared", "scope"), "descriptor"],
    ["original descriptor", ["originalDescriptor"], "executionId"],
    ["Windows details", ["originalDescriptor", "details"], "supervisor"],
    [
      "supervisor fact",
      ["originalDescriptor", "details", "supervisor"],
      "creationFileTime",
    ],
    ["engine fact", ["originalDescriptor", "details", "engine"], "pid"],
    ["AUTH", recordPath("authorization"), "scope"],
    ["AUTH scope", recordPath("authorization", "scope"), "target"],
    ["private terminal", recordPath("terminal"), "resumeState"],
    ["private completion", recordPath("terminal", "completion"), "kind"],
    ["private proof", recordPath("terminal", "proof"), "stdoutEof"],
    [
      "proof process fact",
      recordPath("terminal", "proof", "engine"),
      "creationFileTime",
    ],
  ];
  it.each(exactObjects)("rejects an extra key in %s", (_name, path) => {
    const fixture = engineFixture();
    setAt(fixture, [...path, "unexpected"], true);
    expectUnknown(fixture);
  });
  it.each(exactObjects)(
    "requires the complete shape of %s",
    (_name, path, key) => {
      const fixture = engineFixture();
      Reflect.deleteProperty(objectAt(fixture, path), key);
      expectUnknown(fixture);
    },
  );

  const readResultChanges: Array<[string, Path, unknown]> = [
    ["reservation unknown", ["snapshot", "reservation"], unknownResult()],
    ...(["request", "prepared", "authorization", "terminal"] as const).map(
      (slot): [string, Path, unknown] => [
        `${slot} unknown`,
        ["snapshot", "records", slot],
        unknownResult(),
      ],
    ),
    [
      "unknown with a snapshot",
      ["snapshot", "records", "controllerLoss", "snapshot"],
      {},
    ],
    ["existing with null", envelopePath("authorization"), null],
    [
      "unsupported status",
      ["snapshot", "records", "terminal", "status"],
      "created",
    ],
    ["raw owner leakage", ["snapshot", "records", "request", "owner"], {}],
  ];
  it.each(readResultChanges)("keeps %s unqualified", (_name, path, value) => {
    const fixture = engineFixture();
    setAt(fixture, path, structuredClone(value));
    expectUnknown(fixture);
  });

  const physicalChanges: Array<[string, Path, unknown]> = [
    ["response version", ["snapshot", "v"], 2],
    ["response kind", ["snapshot", "kind"], "session-state"],
    [
      "reservation kind",
      ["snapshot", "reservation", "snapshot", "kind"],
      "record",
    ],
    [
      "reservation recordId",
      ["snapshot", "reservation", "snapshot", "recordId"],
      slots.request,
    ],
    [
      "reservation payload",
      ["snapshot", "reservation", "snapshot", "record"],
      {},
    ],
    ["record version", envelopePath("prepared", "v"), 2],
    ["record kind", envelopePath("prepared", "kind"), "reservation"],
    ["record payload object", envelopePath("prepared", "record"), []],
    [
      "original executionId",
      envelopePath("prepared", "executionId"),
      "e".repeat(32),
    ],
    [
      "original record scope",
      envelopePath("prepared", "scope", "target", "identity", "fence"),
      8,
    ],
    [
      "root directory replacement",
      envelopePath("prepared", "rootIdentity", "fileId"),
      "e".repeat(32),
    ],
    [
      "reservation marker replacement",
      envelopePath("authorization", "reservationIdentity", "fileId"),
      "e".repeat(32),
    ],
    [
      "fixed envelope slot",
      envelopePath("terminal", "recordId"),
      slots.prepared,
    ],
    ["payload slot binding", recordPath("prepared", "recordId"), slots.request],
    [
      "uppercase executionId",
      ["snapshot", "reservation", "snapshot", "executionId"],
      executionId.toUpperCase(),
    ],
    [
      "uppercase fileId",
      envelopePath("request", "fileIdentity", "fileId"),
      "A".repeat(32),
    ],
    [
      "short fileId",
      envelopePath("request", "fileIdentity", "fileId"),
      "a".repeat(31),
    ],
  ];
  it.each(physicalChanges)(
    "rejects a broken physical boundary: %s",
    (_name, path, value) => {
      const fixture = engineFixture();
      setAt(fixture, path, structuredClone(value));
      expectUnknown(fixture);
    },
  );

  it("cannot exchange verified request and prepared slot envelopes", () => {
    const fixture = engineFixture();
    const records = objectAt(fixture.snapshot, ["records"]);
    [records.request, records.prepared] = [records.prepared, records.request];
    expectUnknown(fixture);
  });

  it.each(["00", "01", "+1", "-1", "1.0", "1e0", "18446744073709551616", 1])(
    "requires canonical UInt64 volumeSerial %j",
    (value) => {
      const fixture = engineFixture();
      setAt(
        fixture,
        envelopePath("request", "fileIdentity", "volumeSerial"),
        value,
      );
      expectUnknown(fixture);
    },
  );

  const bindingChanges: Array<[string, Path, unknown]> = [
    [
      "expected original job",
      ["expectedScope", "target", "identity", "jobId"],
      "other-job",
    ],
    [
      "expected original attempt",
      ["expectedScope", "target", "identity", "attemptNo"],
      3,
    ],
    [
      "original producer",
      ["expectedScope", "target", "identity", "ownerInstanceId"],
      "recovery-publisher",
    ],
    ["original fence", ["expectedScope", "target", "identity", "fence"], 8],
    [
      "original launch ticket",
      ["expectedScope", "target", "launchTicket"],
      "new-launch",
    ],
    [
      "frozen policy",
      ["expectedScope", "executionPolicyFingerprint"],
      "a".repeat(64),
    ],
    ["original adapter", ["originalDescriptor", "adapterId"], "test"],
    [
      "original execution",
      ["originalDescriptor", "executionId"],
      "f".repeat(32),
    ],
    [
      "descriptor ticket",
      ["originalDescriptor", "launchTicket"],
      "other-launch",
    ],
    [
      "descriptor target",
      ["originalDescriptor", "details", "target", "identity", "fence"],
      8,
    ],
    [
      "descriptor policy",
      ["originalDescriptor", "details", "executionPolicyFingerprint"],
      "e".repeat(64),
    ],
    [
      "prepared full descriptor",
      recordPath(
        "prepared",
        "scope",
        "descriptor",
        "details",
        "supervisor",
        "creationFileTime",
      ),
      "9007199254740994",
    ],
    [
      "AUTH full descriptor",
      recordPath("authorization", "scope", "descriptor", "details", "jobName"),
      "replacement-job",
    ],
    [
      "terminal full descriptor",
      recordPath(
        "terminal",
        "descriptor",
        "details",
        "engine",
        "creationFileTime",
      ),
      "18446744073709551614",
    ],
    ["request record kind", recordPath("request", "kind"), "request"],
    ["prepared record kind", recordPath("prepared", "kind"), "prepared"],
    ["AUTH kind", recordPath("authorization", "kind"), "resumed"],
    [
      "prepared request reference",
      recordPath("prepared", "requestRecordId"),
      slots.prepared,
    ],
    [
      "prepared original SHA",
      recordPath("prepared", "requestFingerprint"),
      "0".repeat(64),
    ],
    [
      "terminal original SHA",
      recordPath("terminal", "requestFingerprint"),
      "0".repeat(64),
    ],
    [
      "terminal request reference",
      recordPath("terminal", "requestRecordId"),
      slots.prepared,
    ],
    [
      "terminal prepared reference",
      recordPath("terminal", "preparedRecordId"),
      slots.request,
    ],
    [
      "terminal AUTH reference",
      recordPath("terminal", "authorizationRecordId"),
      slots.controllerLoss,
    ],
    [
      "resolved original recipe",
      recordPath("request", "resolvedLaunch", "recipeId"),
      "another-recipe",
    ],
    [
      "resolved original manifest",
      recordPath("request", "resolvedLaunch", "installationManifestSha256"),
      "e".repeat(64),
    ],
    [
      "proof original process",
      recordPath("terminal", "proof", "engine", "creationFileTime"),
      "18446744073709551614",
    ],
    [
      "proof original Job",
      recordPath("terminal", "proof", "jobName"),
      "replacement-job",
    ],
    [
      "private JournalScope",
      recordPath("terminal", "scope"),
      { target: scope().target, descriptor: {} },
    ],
  ];
  it.each(bindingChanges)(
    "binds %s to the caller's original context",
    (_name, path, value) => {
      const fixture = engineFixture();
      setAt(fixture, path, structuredClone(value));
      expectUnknown(fixture);
    },
  );

  it.each(["attemptNo", "fence"])(
    "validates coherent original %s as a positive safe integer",
    (field) => {
      for (const invalid of [
        -0,
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        NaN,
        Infinity,
        "2",
      ]) {
        const expectedScope = scope();
        setAt(expectedScope, ["target", "identity", field], invalid);
        expectUnknown(engineFixture(0, false, expectedScope));
      }
    },
  );

  it.each([
    ["jobId", ""],
    ["jobId", " padded"],
    ["jobId", "bad\u0001"],
    ["ownerInstanceId", "bad\u007f"],
    ["ownerInstanceId", "\ud800"],
  ])(
    "rejects noncanonical original identity %s=%j even when all records agree",
    (field, value) => {
      const expectedScope = scope();
      setAt(expectedScope, ["target", "identity", field!], value);
      expectUnknown(engineFixture(0, false, expectedScope));
    },
  );

  it.each(["A".repeat(64), "g".repeat(64), "a".repeat(63)])(
    "rejects a coherent noncanonical policy SHA %s",
    (value) => {
      const expectedScope = scope();
      setAt(expectedScope, ["executionPolicyFingerprint"], value);
      expectUnknown(engineFixture(0, false, expectedScope));
    },
  );

  it.each(["", " padded", "bad\u0000", "\ud800"])(
    "rejects a coherent invalid launch ticket %j",
    (value) => {
      const expectedScope = scope();
      setAt(expectedScope, ["target", "launchTicket"], value);
      expectUnknown(engineFixture(0, false, expectedScope));
    },
  );

  it.each([executionId.toUpperCase(), "a".repeat(31), "g".repeat(32)])(
    "requires canonical executionId even when every envelope agrees: %s",
    (value) => {
      const fixture = engineFixture();
      const descriptor = structuredClone(fixture.originalDescriptor);
      setAt(descriptor, ["executionId"], value);
      bindDescriptor(fixture, descriptor);
      setAt(
        fixture,
        ["snapshot", "reservation", "snapshot", "executionId"],
        value,
      );
      for (const slot of [
        "request",
        "prepared",
        "authorization",
        "terminal",
      ] as const)
        setAt(fixture, envelopePath(slot, "executionId"), value);
      expectUnknown(fixture);
    },
  );

  it.each([
    ["v", 2],
    ["recipeId", "another-recipe"],
    ["requestRecordId", slots.prepared],
    ["preparedRecordId", slots.request],
    ["installationManifestSha256", "B".repeat(64)],
    ["jobName", "\ud800"],
  ])(
    "rejects coherent malformed Windows descriptor details %s",
    (field, value) => {
      const fixture = engineFixture();
      const descriptor = structuredClone(fixture.originalDescriptor);
      setAt(descriptor, ["details", field as string], value);
      bindDescriptor(fixture, descriptor);
      expectUnknown(fixture);
    },
  );

  it("requires canonical manifest SHA even when resolved launch and original descriptor agree", () => {
    const fixture = engineFixture();
    const descriptor = structuredClone(fixture.originalDescriptor);
    setAt(
      descriptor,
      ["details", "installationManifestSha256"],
      manifestSha256.toUpperCase(),
    );
    bindDescriptor(fixture, descriptor);
    setAt(
      fixture,
      recordPath("request", "resolvedLaunch", "installationManifestSha256"),
      manifestSha256.toUpperCase(),
    );
    expectUnknown(fixture);
  });

  it("validates the original supervisor FILETIME without converting it to a JS number", () => {
    const fixture = engineFixture();
    const descriptor = structuredClone(fixture.originalDescriptor);
    setAt(
      descriptor,
      ["details", "supervisor", "creationFileTime"],
      9_007_199_254_740_992,
    );
    bindDescriptor(fixture, descriptor);
    expectUnknown(fixture);
  });

  it.each([
    "00",
    "01",
    "+1",
    "-1",
    "1.0",
    "1e0",
    "18446744073709551616",
    9_007_199_254_740_992,
  ])(
    "requires canonical string FILETIME %j with the same process everywhere",
    (value) => {
      const fixture = engineFixture();
      const descriptor = structuredClone(fixture.originalDescriptor);
      setAt(descriptor, ["details", "engine", "creationFileTime"], value);
      bindDescriptor(fixture, descriptor);
      setAt(
        fixture,
        recordPath("terminal", "proof", "engine", "creationFileTime"),
        value,
      );
      expectUnknown(fixture);
    },
  );

  it.each([-0, 0, -1, 1.5, 4_294_967_296, NaN, Infinity, "7001"])(
    "requires positive UInt32 pid %j even when descriptor and proof agree",
    (value) => {
      const fixture = engineFixture();
      const descriptor = structuredClone(fixture.originalDescriptor);
      setAt(descriptor, ["details", "engine", "pid"], value);
      bindDescriptor(fixture, descriptor);
      setAt(fixture, recordPath("terminal", "proof", "engine", "pid"), value);
      expectUnknown(fixture);
    },
  );

  it("rejects original SHA substitution with a hash of reserialized JSON", () => {
    const fixture = engineFixture(0, true);
    const fingerprint = hash(
      JSON.stringify(originalSpec(fixture.expectedScope)),
    );
    for (const slot of ["request", "prepared", "terminal"] as const)
      setAt(fixture, recordPath(slot, "requestFingerprint"), fingerprint);
    const descriptor = structuredClone(fixture.originalDescriptor);
    setAt(descriptor, ["details", "requestFingerprint"], fingerprint);
    bindDescriptor(fixture, descriptor);
    expectUnknown(fixture);
  });

  it("requires the request SHA to equal the caller's original descriptor SHA", () => {
    const fixture = engineFixture();
    const descriptor = structuredClone(fixture.originalDescriptor);
    setAt(descriptor, ["details", "requestFingerprint"], "0".repeat(64));
    bindDescriptor(fixture, descriptor);
    expectUnknown(fixture);
  });

  it.each(["%%%=", "", "e30=\n", "e30", "e30==", "e31="])(
    "rejects noncanonical or empty original Base64 %j",
    (value) => {
      const fixture = engineFixture();
      // Update every SHA so this is not merely a mismatched fingerprint test.
      bindRequestBytes(fixture, Buffer.from(value, "base64"));
      setAt(fixture, recordPath("request", "requestUtf8Base64"), value);
      expectUnknown(fixture);
    },
  );

  it.each([
    ["overlong UTF-8", [0xc0, 0xaf]],
    ["truncated UTF-8", [0xe2, 0x82]],
    ["encoded surrogate", [0xed, 0xa0, 0x80]],
    ["out of Unicode range", [0xf4, 0x90, 0x80, 0x80]],
  ] as const)(
    "requires fatal UTF-8 decoding for opaque original bytes: %s",
    (_name, invalidBytes) => {
      const fixture = engineFixture();
      const request = objectAt(fixture, recordPath("request"));
      const bytes = Buffer.from(request.requestUtf8Base64 as string, "base64");
      const marker = Buffer.from("reader-fixture-job", "utf8");
      const offset = bytes.indexOf(marker);
      expect(offset).toBeGreaterThan(0);
      bindRequestBytes(
        fixture,
        Buffer.concat([
          bytes.subarray(0, offset),
          Buffer.from(invalidBytes),
          bytes.subarray(offset + marker.length),
        ]),
      );
      expectUnknown(fixture);
    },
  );

  it.each([
    ["empty executable", ["executablePath"], ""],
    ["NUL executable", ["executablePath"], "bad\u0000path"],
    ["lossy executable", ["executablePath"], "\ud800"],
    ["argv non-array", ["argv"], { 0: "-i", length: 1 }],
    ["argv non-string", ["argv", "0"], 1],
    ["argv lossy string", ["argv", "0"], "\ud800"],
  ] as Array<[string, string[], unknown]>)(
    "requires JSON string/argv facts: %s",
    (_name, path, value) => {
      const fixture = engineFixture();
      setAt(fixture, recordPath("request", "resolvedLaunch", ...path), value);
      expectUnknown(fixture);
    },
  );

  const proofChanges: Array<[string, Path, unknown]> = [
    [
      "resume not attempted",
      recordPath("terminal", "resumeState"),
      "not-attempted",
    ],
    ["resume uncertain", recordPath("terminal", "resumeState"), "uncertain"],
    ["seal missing", recordPath("terminal", "authorizationsSealed"), false],
    ["tree not exited", recordPath("terminal", "proof", "treeExited"), false],
    [
      "active descendants",
      recordPath("terminal", "proof", "activeProcesses"),
      1,
    ],
    [
      "negative-zero active count",
      recordPath("terminal", "proof", "activeProcesses"),
      -0,
    ],
    ["stdout still open", recordPath("terminal", "proof", "stdoutEof"), false],
    ["stderr still open", recordPath("terminal", "proof", "stderrEof"), false],
    [
      "reader EOF cannot replace engine stdout EOF",
      recordPath("terminal", "proof", "stdoutEof"),
      "reader-eof",
    ],
    ["no original descriptor", recordPath("terminal", "descriptor"), null],
    ["no prepared receipt", recordPath("terminal", "preparedRecordId"), null],
    ["no AUTH receipt", recordPath("terminal", "authorizationRecordId"), null],
    [
      "no original tree proof",
      recordPath("terminal", "proof"),
      { kind: "prepare-not-called" },
    ],
  ];
  it.each(proofChanges)(
    "does not complete engine-exit from %s",
    (_name, path, value) => {
      const fixture = engineFixture();
      setAt(fixture, path, structuredClone(value));
      expectUnknown(fixture);
    },
  );

  describe.each(["stop", "deadline"] as const)(
    "resumed private %s boundaries",
    (kind) => {
      it.each([
        ...readResultChanges,
        ...bindingChanges,
        ...proofChanges,
        [
          "request original SHA",
          recordPath("request", "requestFingerprint"),
          "0".repeat(64),
        ],
        [
          "extra completion field",
          recordPath("terminal", "completion", "exitCode"),
          0,
        ],
      ] as Array<[string, Path, unknown]>)(
        "keeps %s unknown",
        (_name, path, value) => {
          const fixture = engineFixture();
          setAt(fixture, recordPath("terminal", "completion"), { kind });
          setAt(fixture, path, structuredClone(value));
          expectUnknown(fixture);
        },
      );

      it.each([-0, -1, 0.5, 4_294_967_296, NaN, Infinity, "0", null])(
        "still requires a canonical UInt32 proof exitCode %j",
        (exitCode) => {
          const fixture = engineFixture();
          setAt(fixture, recordPath("terminal", "completion"), { kind });
          setAt(fixture, recordPath("terminal", "proof", "exitCode"), exitCode);
          expectUnknown(fixture);
        },
      );

      it.each([false, true])(
        "rejects an existing controller loss with malformed reference=%s",
        (malformed) => {
          const fixture = engineFixture();
          const loss = lossRecord(fixture);
          if (malformed) loss.authorizationRecordId = slots.prepared;
          setAt(fixture, recordPath("terminal", "completion"), { kind });
          setAt(
            fixture,
            ["snapshot", "records", "controllerLoss"],
            existing(
              envelope(fixture.expectedScope, slots.controllerLoss, loss, "7"),
            ),
          );
          expectUnknown(fixture);
        },
      );
    },
  );

  it.each([-0, -1, 0.5, 4_294_967_296, NaN, Infinity, "0", null])(
    "requires an actual UInt32 engine exitCode %j",
    (exitCode) => {
      const fixture = engineFixture();
      setAt(fixture, recordPath("terminal", "proof", "exitCode"), exitCode);
      expectUnknown(fixture);
    },
  );

  it("rejects a complete controller-lost history beside private engine-exit", () => {
    const fixture = engineFixture();
    setAt(
      fixture,
      ["snapshot", "records", "controllerLoss"],
      existing(
        envelope(
          fixture.expectedScope,
          slots.controllerLoss,
          lossRecord(fixture),
          "7",
        ),
      ),
    );
    expectUnknown(fixture);
  });

  it.each([
    ["unrecognized kind", ["kind"], "other-history"],
    ["extra reason", ["reason"], "controller_eof"],
    ["wrong reference", ["authorizationRecordId"], slots.prepared],
    ["wrong original scope", ["scope", "target", "identity", "fence"], 8],
    ["wrong payload slot", ["recordId"], slots.authorization],
  ] as Array<[string, string[], unknown]>)(
    "does not downgrade malformed Existing loss into Unknown: %s",
    (_name, path, value) => {
      const fixture = engineFixture();
      const loss = lossRecord(fixture);
      setAt(loss, path, value);
      setAt(
        fixture,
        ["snapshot", "records", "controllerLoss"],
        existing(
          envelope(fixture.expectedScope, slots.controllerLoss, loss, "7"),
        ),
      );
      expectUnknown(fixture);
    },
  );

  it.each([
    ["null envelope", [], null],
    ["wrong envelope kind", ["kind"], "reservation"],
    ["replaced root", ["rootIdentity", "fileId"], "e".repeat(32)],
    ["wrong payload type", ["record"], []],
  ] as Array<[string, string[], unknown]>)(
    "does not ignore malformed Existing loss envelope: %s",
    (_name, path, value) => {
      const fixture = engineFixture();
      setAt(
        fixture,
        ["snapshot", "records", "controllerLoss"],
        existing(
          envelope(
            fixture.expectedScope,
            slots.controllerLoss,
            lossRecord(fixture),
            "7",
          ),
        ),
      );
      setAt(fixture, envelopePath("controllerLoss", ...path), value);
      expectUnknown(fixture);
    },
  );

  const interruptionChanges: Array<[string, Path, unknown]> = [
    [
      "loss unknown",
      ["snapshot", "records", "controllerLoss"],
      unknownResult(),
    ],
    ["AUTH unknown", ["snapshot", "records", "authorization"], unknownResult()],
    [
      "loss references another AUTH",
      recordPath("controllerLoss", "authorizationRecordId"),
      slots.prepared,
    ],
    [
      "terminal references another AUTH",
      recordPath("terminal", "authorizationRecordId"),
      slots.prepared,
    ],
    [
      "terminal references another loss",
      recordPath("terminal", "controllerLossRecordId"),
      slots.authorization,
    ],
    [
      "loss has another producer",
      recordPath(
        "controllerLoss",
        "scope",
        "target",
        "identity",
        "ownerInstanceId",
      ),
      "new-publisher",
    ],
    [
      "terminal descriptor is replaced",
      recordPath(
        "terminal",
        "scope",
        "descriptor",
        "details",
        "engine",
        "creationFileTime",
      ),
      "0",
    ],
    [
      "loss has reason",
      recordPath("controllerLoss", "reason"),
      "controller_eof",
    ],
    ["terminal has exitCode", recordPath("terminal", "exitCode"), 0],
    [
      "terminal has no seal",
      recordPath("terminal", "authorizationsSealed"),
      false,
    ],
    ["terminal has no tree exit", recordPath("terminal", "treeExited"), false],
    [
      "terminal completion is not interrupted",
      recordPath("terminal", "completion"),
      "success",
    ],
    [
      "AUTH payload uses the loss slot",
      recordPath("authorization", "recordId"),
      slots.controllerLoss,
    ],
    [
      "loss payload uses the AUTH slot",
      recordPath("controllerLoss", "recordId"),
      slots.authorization,
    ],
    [
      "terminal payload uses the reserved seal slot",
      recordPath("terminal", "recordId"),
      "00000000000000000000000000000004",
    ],
  ];
  it.each(interruptionChanges)(
    "requires the full public interruption chain: %s",
    (_name, path, value) => {
      const fixture = interruptedFixture();
      setAt(fixture, path, structuredClone(value));
      expectUnknown(fixture);
    },
  );

  it.each([
    ["loss", "controllerLoss", "authorizationRecordId"],
    ["terminal", "terminal", "controllerLossRecordId"],
  ] as const)(
    "requires exact complete public %s records",
    (_name, slot, key) => {
      const fixture = interruptedFixture();
      Reflect.deleteProperty(objectAt(fixture, recordPath(slot)), key);
      expectUnknown(fixture);
    },
  );

  it.each([
    { kind: "launch-failure", stage: "prepared-state" },
    { kind: "launch-failure", stage: "resume" },
    { kind: "unauthorized-cleanup", cause: "controller_eof" },
    { kind: "unauthorized-cleanup", cause: "controller_exit" },
    { kind: "unauthorized-cleanup", cause: "control_write_failure" },
  ])("leaves deferred private completion %j unknown", (completion) => {
    const fixture = engineFixture();
    setAt(fixture, recordPath("terminal", "completion"), completion);
    if (completion.kind === "launch-failure" && completion.stage === "resume")
      setAt(fixture, recordPath("terminal", "resumeState"), "uncertain");
    if (
      completion.kind === "launch-failure" &&
      completion.stage === "prepared-state"
    ) {
      for (const slot of ["prepared", "authorization"] as const)
        setAt(fixture, ["snapshot", "records", slot], unknownResult());
      for (const field of [
        "preparedRecordId",
        "descriptor",
        "authorizationRecordId",
      ])
        setAt(fixture, recordPath("terminal", field), null);
      setAt(fixture, recordPath("terminal", "resumeState"), "not-attempted");
    }
    if (completion.kind === "unauthorized-cleanup") {
      setAt(fixture, ["snapshot", "records", "authorization"], unknownResult());
      setAt(fixture, recordPath("terminal", "authorizationRecordId"), null);
      setAt(fixture, recordPath("terminal", "resumeState"), "not-attempted");
    }
    expectUnknown(fixture);
  });

  it.each([
    { kind: "stop" },
    { kind: "deadline" },
    { kind: "unauthorized-cleanup", cause: "controller_eof" },
  ])(
    "does not fabricate a descriptor for prepare-not-called %j",
    (completion) => {
      const fixture = engineFixture();
      for (const slot of ["prepared", "authorization"] as const)
        setAt(fixture, ["snapshot", "records", slot], unknownResult());
      for (const field of [
        "preparedRecordId",
        "descriptor",
        "authorizationRecordId",
      ])
        setAt(fixture, recordPath("terminal", field), null);
      setAt(fixture, recordPath("terminal", "resumeState"), "not-attempted");
      setAt(fixture, recordPath("terminal", "completion"), completion);
      setAt(fixture, recordPath("terminal", "proof"), {
        kind: "prepare-not-called",
      });
      expectUnknown(fixture);
    },
  );

  it.each([
    ["response", ["snapshot", "v"]],
    ["slot result", ["snapshot", "records", "request", "status"]],
    ["expected scope", ["expectedScope", "target"]],
    ["original descriptor", ["originalDescriptor", "details"]],
    ["nested process fact", recordPath("terminal", "proof", "engine", "pid")],
    ["argv item", recordPath("request", "resolvedLaunch", "argv", "0")],
  ] as Array<[string, Path]>)(
    "rejects own getters before invoking them: %s",
    (_name, path) => {
      const fixture = engineFixture();
      const parent = objectAt(fixture, path.slice(0, -1));
      const key = path.at(-1)!;
      const value = parent[key];
      let calls = 0;
      Object.defineProperty(parent, key, {
        enumerable: true,
        configurable: true,
        get() {
          calls++;
          return value;
        },
      });
      expectUnknown(fixture);
      expect(calls).toBe(0);
    },
  );

  it.each([
    ["response", ["snapshot"]],
    ["descriptor details", ["originalDescriptor", "details"]],
    ["argv", recordPath("request", "resolvedLaunch", "argv")],
  ] as Array<[string, Path]>)("does not invoke toJSON on %s", (_name, path) => {
    const fixture = engineFixture();
    let calls = 0;
    Object.defineProperty(objectAt(fixture, path), "toJSON", {
      value() {
        calls++;
        return {};
      },
      configurable: true,
    });
    expectUnknown(fixture);
    expect(calls).toBe(0);
  });

  it.each([
    "symbol",
    "hidden",
    "custom prototype",
    "null prototype",
    "undefined argv",
    "sparse argv",
    "array extra",
  ])("rejects non-JSON facts without a partial result: %s", (kind) => {
    const fixture = engineFixture();
    const request = objectAt(fixture, recordPath("request"));
    const argv = objectAt(
      fixture,
      recordPath("request", "resolvedLaunch", "argv"),
    );
    if (kind === "symbol")
      Object.defineProperty(request, Symbol("hidden fact"), { value: true });
    if (kind === "hidden")
      Object.defineProperty(request, "hidden", { value: true });
    if (kind === "custom prototype")
      Object.setPrototypeOf(request, { inherited: true });
    if (kind === "null prototype") Object.setPrototypeOf(request, null);
    if (kind === "undefined argv") setAt(argv, ["0"], undefined);
    if (kind === "sparse argv") Reflect.deleteProperty(argv, "0");
    if (kind === "array extra") setAt(argv, ["extra"], true);
    expectUnknown(fixture);
  });
});
