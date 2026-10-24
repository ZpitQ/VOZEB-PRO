import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EnhancementError } from "../src/contracts.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import {
  carrier,
  claimedAttempt,
  identifierSourcePaths,
  independentSpec,
  installGetter,
  invalidSourceNumbers,
  jsWhitespace,
  pathSourcePaths,
  renewPolicy,
  selectedObjects,
  selectedSourcePaths,
  setValue,
  sourceArrayVectors,
  sourceNumberPaths,
  sourceShapeVectors,
} from "./windows-prepare-payload-fixtures.js";

function rejected(attempt: ReturnType<typeof claimedAttempt>, name: string) {
  let actual: unknown;
  try {
    freezeWindowsPrepareRequest(attempt);
  } catch (error) {
    actual = error;
  }
  expect(actual, name).toBeInstanceOf(EnhancementError);
  expect(actual, name).toMatchObject({ code: "configuration_invalid" });
  expect((actual as Error).message, name).toBe(
    new EnhancementError("configuration_invalid").message,
  );
}

function exact(attempt: ReturnType<typeof claimedAttempt>) {
  const raw = JSON.stringify(independentSpec(attempt));
  const expected = carrier(raw);
  const actual = freezeWindowsPrepareRequest(attempt);
  expect(actual).toEqual(expected);
  const bytes = Buffer.from(actual.requestUtf8Base64, "base64");
  expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(raw);
  expect(bytes.toString("base64")).toBe(actual.requestUtf8Base64);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    actual.requestFingerprint,
  );
  return actual;
}

describe("frozen Windows prepare request", () => {
  it("encodes the frozen claimed attempt as exactly two immutable original-byte strings", () => {
    const result = exact(claimedAttempt());
    expect(Reflect.ownKeys(result)).toEqual([
      "requestUtf8Base64",
      "requestFingerprint",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    for (const key of Reflect.ownKeys(result)) {
      const descriptor = Object.getOwnPropertyDescriptor(result, key)!;
      expect(descriptor).toMatchObject({
        enumerable: true,
        configurable: false,
        writable: false,
      });
      expect(typeof descriptor.value).toBe("string");
      expect(descriptor.get).toBeUndefined();
      expect(descriptor.set).toBeUndefined();
    }
  });

  it("retains cached bytes after source mutation and ignores lease and wider metadata", () => {
    const attempt = claimedAttempt();
    const expected = carrier(JSON.stringify(independentSpec(attempt)));
    const actual = freezeWindowsPrepareRequest(attempt);
    setValue(attempt, ["identity", "ownerInstanceId"], "later-owner");
    setValue(attempt, ["job", "plan", "engine", "modelVersion"], "later-model");
    setValue(attempt, ["executionPolicy", "allowedTiles", "0"], 128);
    setValue(attempt, ["inputPath"], "later-input");
    expect(actual).toEqual(expected);
    expect(Reflect.set(actual, "requestUtf8Base64", "later")).toBe(false);
    const wider = claimedAttempt();
    let getters = 0;
    for (const path of [
      ["leaseExpiresAt"],
      ["unrelated"],
      ["job", "unrelated"],
      ["job", "source"],
      ["job", "plan", "budgets"],
    ])
      installGetter(wider, path, () => {
        getters++;
        throw new Error("Unrelated data was read");
      });
    expect(freezeWindowsPrepareRequest(wider)).toEqual(expected);
    expect(getters).toBe(0);
  });

  it("rejects every selected exact-object shape violation", () => {
    for (const vector of sourceShapeVectors()) {
      const attempt = claimedAttempt();
      vector.apply(attempt);
      rejected(attempt, vector.name);
    }
  });

  it("rejects selected accessors without invoking them or inherited source references", () => {
    for (const path of selectedSourcePaths) {
      const attempt = claimedAttempt();
      let reads = 0;
      installGetter(attempt, path, () => {
        reads++;
        throw new Error("Selected getter ran");
      });
      rejected(attempt, path.join("."));
      expect(reads, path.join(".")).toBe(0);
    }
    for (const key of [
      "identity",
      "job",
      "executionPolicy",
      "launchTicket",
      "firstStartedAt",
      "executionDeadlineAt",
      "inputPath",
      "workingDirectory",
      "outputPath",
      "tile",
    ]) {
      const attempt = claimedAttempt();
      const value = (attempt as unknown as Record<string, unknown>)[key];
      Reflect.deleteProperty(attempt, key);
      Object.setPrototypeOf(attempt, { [key]: value });
      rejected(attempt, `inherited ${key}`);
    }
  });

  it("rejects malformed dense tiles and tile getters without evaluating them", () => {
    for (const vector of sourceArrayVectors()) {
      const attempt = claimedAttempt();
      vector.apply(attempt);
      rejected(attempt, vector.name);
    }
    const attempt = claimedAttempt();
    let reads = 0;
    installGetter(attempt, ["executionPolicy", "allowedTiles", "0"], () => {
      reads++;
      return 0;
    });
    rejected(attempt, "tile accessor");
    expect(reads).toBe(0);
  });

  it("rejects frozen identity policy tile and deadline conflicts without defaults", () => {
    const vectors = [
      ["job mismatch", ["job", "jobId"], "another-job"],
      ["attempt tile mismatch", ["tile"], 64],
      ["engine tile outside policy", ["job", "plan", "engine", "tile"], 96],
      ["policy mismatch", ["executionPolicy", "fingerprint"], "0".repeat(64)],
      ["policy uppercase", ["executionPolicy", "fingerprint"], "A".repeat(64)],
      [
        "heartbeat exceeds lease",
        ["executionPolicy", "limits", "heartbeatIntervalMs"],
        15_001,
      ],
      ["deadline equals start", ["executionDeadlineAt"], 1_000],
      ["deadline before start", ["executionDeadlineAt"], 999],
      ["native scale", ["job", "plan", "engine", "nativeScale"], 2],
      ["tta", ["job", "plan", "engine", "tta"], true],
    ] as const;
    for (const [name, path, value] of vectors) {
      const attempt = claimedAttempt();
      setValue(attempt, path, value);
      rejected(attempt, name);
    }
    for (const path of [
      ["tile"],
      ["job", "plan", "engine", "tile"],
      ["launchTicket"],
      ["inputPath"],
    ]) {
      const attempt = claimedAttempt();
      setValue(attempt, path, undefined);
      rejected(attempt, `undefined ${path.join(".")}`);
    }
    const order = claimedAttempt();
    renewPolicy(order, [64, 32, 0]);
    exact(order);
    const stale = claimedAttempt();
    setValue(stale, ["executionPolicy", "allowedTiles"], [64, 32, 0]);
    rejected(stale, "tile order changes policy fingerprint");
  });

  it("rejects unsafe negative fractional signed-zero and nonnumeric source scalars", () => {
    for (const path of sourceNumberPaths)
      for (const value of invalidSourceNumbers) {
        const attempt = claimedAttempt();
        setValue(attempt, path, value);
        rejected(attempt, `${path.join(".")} ${String(value)}`);
      }
    for (const path of [
      ["identity", "attemptNo"],
      ["identity", "fence"],
      ...[
        "executionTimeoutMs",
        "cancelGraceMs",
        "leaseDurationMs",
        "heartbeatIntervalMs",
      ].map((key) => ["executionPolicy", "limits", key]),
    ]) {
      const attempt = claimedAttempt();
      setValue(attempt, path, 0);
      rejected(attempt, `positive ${path.join(".")}`);
    }
  });

  it("preserves valid zero minimum maximum and original nonrenewed times", () => {
    const zero = claimedAttempt();
    setValue(zero, ["tile"], 0);
    setValue(zero, ["job", "plan", "engine", "tile"], 0);
    setValue(zero, ["firstStartedAt"], 0);
    setValue(zero, ["executionDeadlineAt"], 1);
    exact(zero);
    const maximum = claimedAttempt();
    for (const path of [
      ["identity", "attemptNo"],
      ["identity", "fence"],
      ["job", "plan", "engine", "gpuId"],
      ["job", "plan", "engine", "tile"],
      ["tile"],
      ["executionDeadlineAt"],
    ])
      setValue(maximum, path, Number.MAX_SAFE_INTEGER);
    for (const key of [
      "executionTimeoutMs",
      "cancelGraceMs",
      "leaseDurationMs",
      "heartbeatIntervalMs",
    ])
      setValue(
        maximum,
        ["executionPolicy", "limits", key],
        Number.MAX_SAFE_INTEGER,
      );
    setValue(maximum, ["firstStartedAt"], Number.MAX_SAFE_INTEGER - 1);
    renewPolicy(maximum, [Number.MAX_SAFE_INTEGER, 32, 0]);
    exact(maximum);
    const preserved = claimedAttempt();
    setValue(preserved, ["executionDeadlineAt"], 1_001);
    setValue(preserved, ["leaseExpiresAt"], Number.MAX_SAFE_INTEGER);
    exact(preserved);
    const reordered = claimedAttempt();
    for (const { path, keys } of selectedObjects) {
      const spec = path.reduce<unknown>(
        (value, key) => (value as Record<string, unknown>)[key],
        reordered,
      ) as Record<string, unknown>;
      setValue(
        reordered,
        path,
        Object.fromEntries([...keys].reverse().map((key) => [key, spec[key]])),
      );
    }
    exact(reordered);
  });

  it("uses JavaScript boundary whitespace and rejects controls and lone surrogates", () => {
    for (const path of identifierSourcePaths)
      for (const value of [
        "",
        "bad\u0001",
        "bad\u007f",
        "\ud800",
        "\udfff",
        1,
        null,
      ]) {
        const attempt = claimedAttempt();
        setValue(attempt, path, value);
        if (path.join(".") === "identity.jobId")
          setValue(attempt, ["job", "jobId"], value);
        rejected(attempt, `identifier ${path.join(".")}`);
      }
    for (const whitespace of jsWhitespace)
      for (const value of [`${whitespace}version`, `version${whitespace}`]) {
        const attempt = claimedAttempt();
        setValue(attempt, ["job", "plan", "engine", "binaryVersion"], value);
        rejected(
          attempt,
          `boundary U+${whitespace.charCodeAt(0).toString(16)}`,
        );
      }
  });

  it("preserves astral text U+0085 internal whitespace BOM and Windows separators", () => {
    const attempt = claimedAttempt();
    const identifier = "\u0085主体 🪑\ufeff 中间\u0085";
    for (const path of identifierSourcePaths)
      setValue(attempt, path, identifier);
    setValue(attempt, ["job", "jobId"], identifier);
    for (const path of pathSourcePaths)
      setValue(attempt, path, " .\\家具 🪑\\..\\x\ufeff\u0085\n ");
    exact(attempt);
  });

  it("rejects malformed paths without resolving or repairing them", () => {
    for (const path of pathSourcePaths)
      for (const value of ["", "bad\u0000path", "\ud800", "\udfff", 1, null]) {
        const attempt = claimedAttempt();
        setValue(attempt, path, value);
        rejected(attempt, `path ${path.join(".")}`);
      }
  });

  it("requires the exact model ASCII grammar and lowercase hashes", () => {
    for (const value of [
      "",
      "-bad",
      "bad/model",
      "模型",
      "bad ",
      "\ud800",
      null,
    ]) {
      const attempt = claimedAttempt();
      setValue(attempt, ["job", "plan", "engine", "modelId"], value);
      rejected(attempt, "modelId");
    }
    for (const key of ["binarySha256", "modelSha256"])
      for (const value of [
        "A".repeat(64),
        "a".repeat(63),
        "g".repeat(64),
        null,
      ]) {
        const attempt = claimedAttempt();
        setValue(attempt, ["job", "plan", "engine", key], value);
        rejected(attempt, key);
      }
  });
});
