import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import { runnerLimits } from "./storage-fixtures.js";
import {
  carrier,
  claimedAttempt,
  independentSpec,
  nativeCarrierVectors,
  nativeGrammarVectors,
  nativeNumberVectors,
  nativeSemanticVectors,
  nativeShapeVectors,
  nativeUnicodeVectors,
  setValue,
  typedProjection,
  type IndependentSpec,
  type RawVector,
  type RequestCarrier,
} from "./windows-prepare-payload-fixtures.js";

type Reply = {
  accepted: boolean;
  mode: "control" | "parse";
  loadedCore: {
    name: string;
    hasPrepareForTest: boolean;
    hasFailureEnum: boolean;
  };
  value?: ReturnType<typeof typedProjection>;
  immutable?: {
    publicPropertyCount: number;
    gettersOnly: boolean;
    noPublicConstructor: boolean;
    readOnlyTiles: boolean;
    mutationRejected: boolean;
    tilesUnchanged: boolean;
  };
  rawSha256?: string;
  fingerprintMatches?: boolean;
  canonicalBase64?: boolean;
  utf8RoundTrip?: boolean;
  byteLength?: number;
  errorType?: string;
  message?: string;
  parameterName?: string | null;
  hasInnerException?: boolean;
};
type ChildClose = { code: number | null; signal: NodeJS.Signals | null };

const fixtureExe = process.env.ZEB_WINDOWS_CONTRACT_FIXTURE_EXE;
const requested =
  process.env.ZEB_RUN_WINDOWS_CONTRACT_OS === "1" || fixtureExe !== undefined;
const windowsSuite = requested ? describe : describe.skip;
const executionMs = runnerLimits.executionTimeoutMs;
const cleanupMs = runnerLimits.cancelGraceMs;
const testMs = executionMs + cleanupMs;

async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Contract fixture deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function invoke(
  mode: "control" | "parse",
  request: RequestCarrier,
): Promise<Reply> {
  if (!fixtureExe)
    throw new Error("Explicit contract fixture executable is required");
  const child = spawn(fixtureExe, [mode], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
  const stderrDecoder = new TextDecoder("utf-8", { fatal: true });
  let stdout = "";
  let stderr = "";
  let stdoutEof = false;
  let stderrEof = false;
  let originalClose: ChildClose | null = null;
  let forcedFallback = false;
  let timedOut = false;
  const errors: string[] = [];
  const failure = (error: unknown) =>
    errors.push(error instanceof Error ? error.name : "UnknownError");
  child.on("error", failure);
  child.stdin.on("error", failure);
  child.stdout.on("error", failure);
  child.stderr.on("error", failure);
  child.stdout.on("data", (bytes: Uint8Array) => {
    try {
      stdout += stdoutDecoder.decode(bytes, { stream: true });
    } catch (error) {
      failure(error);
    }
  });
  child.stderr.on("data", (bytes: Uint8Array) => {
    try {
      stderr += stderrDecoder.decode(bytes, { stream: true });
    } catch (error) {
      failure(error);
    }
  });
  child.stdout.once("end", () => {
    stdoutEof = true;
    try {
      stdout += stdoutDecoder.decode();
    } catch (error) {
      failure(error);
    }
  });
  child.stderr.once("end", () => {
    stderrEof = true;
    try {
      stderr += stderrDecoder.decode();
    } catch (error) {
      failure(error);
    }
  });
  const close = new Promise<ChildClose>((resolve) =>
    child.once("close", (code, signal) => {
      originalClose = { code, signal };
      resolve(originalClose);
    }),
  );
  child.stdin.end(Buffer.from(JSON.stringify(request), "utf8"));
  try {
    await bounded(close, executionMs);
  } catch {
    timedOut = true;
    if (originalClose === null) {
      forcedFallback = true;
      child.kill();
      try {
        await bounded(close, cleanupMs);
      } catch {
        errors.push("OriginalChildCloseUnconfirmed");
      }
    }
  }
  const lifecycle = {
    mode,
    requestFingerprint: request.requestFingerprint,
    originalClose,
    stdoutEof,
    stderrEof,
    strictUtf8: errors.length === 0,
    forcedFallback,
    timedOut,
    errors,
    stderrEmpty: stderr.length === 0,
  };
  process.stdout.write(`[B4-PREPARE-CHILD] ${JSON.stringify(lifecycle)}\n`);
  expect(lifecycle).toMatchObject({
    originalClose: { code: 0, signal: null },
    stdoutEof: true,
    stderrEof: true,
    strictUtf8: true,
    forcedFallback: false,
    timedOut: false,
    errors: [],
    stderrEmpty: true,
  });
  const reply = JSON.parse(stdout) as Reply;
  expect(reply.mode).toBe(mode);
  expect(reply.loadedCore).toEqual({
    name: "WindowsSupervisor",
    hasPrepareForTest: false,
    hasFailureEnum: false,
  });
  return reply;
}

function accepted(
  reply: Reply,
  spec: IndependentSpec,
  request: RequestCarrier,
) {
  expect(reply.accepted).toBe(true);
  expect(reply.value).toEqual(typedProjection(spec, request));
  expect(reply.immutable).toEqual({
    publicPropertyCount: 11,
    gettersOnly: true,
    noPublicConstructor: true,
    readOnlyTiles: true,
    mutationRejected: true,
    tilesUnchanged: true,
  });
}

async function rejectedVectors(vectors: RawVector[], matchingDigest = true) {
  for (const vector of vectors) {
    if (matchingDigest)
      expect(
        createHash("sha256")
          .update(Buffer.from(vector.request.requestUtf8Base64, "base64"))
          .digest("hex"),
        vector.name,
      ).toBe(vector.request.requestFingerprint);
    const reply = await invoke("parse", vector.request);
    expect(reply, vector.name).toMatchObject({
      accepted: false,
      errorType: "ArgumentException",
      message: "Invalid native prepare payload.",
      parameterName: null,
      hasInnerException: false,
    });
    expect(reply.value, vector.name).toBeUndefined();
  }
}

windowsSuite("ordinary native Windows prepare payload contract", () => {
  let control: Reply;
  beforeAll(async () => {
    expect(process.platform).toBe("win32");
    expect(process.env.ZEB_RUN_WINDOWS_CONTRACT_OS).toBe("1");
    expect(typeof fixtureExe).toBe("string");
    expect(isAbsolute(fixtureExe!)).toBe(true);
    const request = carrier(JSON.stringify(independentSpec()));
    control = await invoke("control", request);
    expect(control).toMatchObject({
      accepted: true,
      rawSha256: request.requestFingerprint,
      fingerprintMatches: true,
      canonicalBase64: true,
      utf8RoundTrip: true,
      byteLength: Buffer.from(request.requestUtf8Base64, "base64").length,
    });
  }, testMs);

  it("independent transport control proves the original child and ordinary core without production Parse", () => {
    expect(control.accepted).toBe(true);
    expect(control.mode).toBe("control");
    expect(control.value).toBeUndefined();
  });

  it.each([false, true])(
    "preserves actual TTA %s through native parsing of TS-produced and independent carriers",
    async (tta) => {
      const attempt = claimedAttempt();
      setValue(attempt, ["job", "plan", "engine", "tta"], tta);
      const spec = independentSpec(attempt);
      const independent = carrier(JSON.stringify(spec));
      accepted(await invoke("parse", independent), spec, independent);
      const produced = freezeWindowsPrepareRequest(attempt);
      expect(produced).toEqual(independent);
      accepted(await invoke("parse", produced), spec, produced);
    },
    testMs,
  );

  it(
    "accepts an independent valid payload and projects every immutable typed field",
    async () => {
      const spec = independentSpec();
      const request = carrier(JSON.stringify(spec));
      accepted(await invoke("parse", request), spec, request);
    },
    testMs,
  );

  it(
    "accepts the actual TS-produced payload using an independent expected oracle",
    async () => {
      const attempt = claimedAttempt();
      const spec = independentSpec(attempt);
      const request = freezeWindowsPrepareRequest(attempt);
      expect(request).toEqual(carrier(JSON.stringify(spec)));
      accepted(await invoke("parse", request), spec, request);
    },
    testMs,
  );

  it(
    "preserves legal alternative raw order whitespace and escapes with distinct original hashes",
    async () => {
      const spec = independentSpec();
      const original = carrier(JSON.stringify(spec));
      const { v, ...rest } = spec;
      const raw = JSON.stringify({ ...rest, v }, null, 2)
        .replace('"v":', '"\\u0076":')
        .replace("fixture-launch", "fixture-\\u006caunch");
      const alternative = carrier(raw);
      expect(alternative.requestFingerprint).not.toBe(
        original.requestFingerprint,
      );
      expect(alternative.requestUtf8Base64).not.toBe(
        original.requestUtf8Base64,
      );
      accepted(await invoke("parse", alternative), spec, alternative);
      const opaque = independentSpec();
      opaque.executionPolicy.fingerprint = "1".repeat(64);
      const opaqueRequest = carrier(JSON.stringify(opaque));
      accepted(await invoke("parse", opaqueRequest), opaque, opaqueRequest);
    },
    testMs,
  );

  it(
    "accepts scalar boundaries as data without clock path or GPU probes",
    async () => {
      const zero = independentSpec();
      zero.engine.tile = 0;
      zero.firstStartedAt = 0;
      zero.executionDeadlineAt = 1;
      const maximum = independentSpec();
      maximum.target.identity.attemptNo = Number.MAX_SAFE_INTEGER;
      maximum.target.identity.fence = Number.MAX_SAFE_INTEGER;
      maximum.engine.tile = Number.MAX_SAFE_INTEGER;
      maximum.engine.gpuId = Number.MAX_SAFE_INTEGER;
      maximum.executionPolicy.allowedTiles = [Number.MAX_SAFE_INTEGER, 32, 0];
      for (const key of Object.keys(
        maximum.executionPolicy.limits,
      ) as (keyof typeof maximum.executionPolicy.limits)[])
        maximum.executionPolicy.limits[key] = Number.MAX_SAFE_INTEGER;
      maximum.firstStartedAt = Number.MAX_SAFE_INTEGER - 1;
      maximum.executionDeadlineAt = Number.MAX_SAFE_INTEGER;
      for (const spec of [zero, maximum]) {
        const request = carrier(JSON.stringify(spec));
        accepted(await invoke("parse", request), spec, request);
      }
    },
    testMs,
  );

  it(
    "preserves JS-allowed U+0085 astral internal BOM whitespace and path characters",
    async () => {
      const spec = independentSpec();
      const text = "\u0085家具 🪑\ufeff 内部\u0085";
      spec.target.identity.jobId = text;
      spec.target.identity.ownerInstanceId = text;
      spec.target.launchTicket = text;
      spec.engine.binaryVersion = text;
      spec.engine.modelVersion = text;
      spec.inputPath = " .\\家具 🪑\\..\\input\n\ufeff\u0085 ";
      spec.workingDirectory = spec.inputPath;
      spec.outputPath = spec.inputPath;
      const request = carrier(JSON.stringify(spec));
      accepted(await invoke("parse", request), spec, request);
    },
    testMs,
  );

  it(
    "rejects each exact object duplicate escaped duplicate missing extra and type violation",
    async () => {
      await rejectedVectors(nativeShapeVectors());
    },
    testMs,
  );

  it(
    "rejects noncanonical numeric tokens with matching raw byte hashes",
    async () => {
      await rejectedVectors(nativeNumberVectors());
    },
    testMs,
  );

  it(
    "rejects invalid scalar relations policy shape hashes and arbitrary engine fields",
    async () => {
      await rejectedVectors(nativeSemanticVectors());
    },
    testMs,
  );

  it(
    "rejects malformed Unicode JS-boundary identifiers and NUL paths",
    async () => {
      await rejectedVectors(nativeUnicodeVectors());
    },
    testMs,
  );

  it(
    "rejects raw UTF8 BOM outer whitespace JSON grammar and escaped name violations",
    async () => {
      await rejectedVectors(nativeGrammarVectors());
    },
    testMs,
  );

  it(
    "rejects invalid Base64 fingerprints and differing original bytes",
    async () => {
      await rejectedVectors(nativeCarrierVectors(), false);
      // Semantic vectors use fresh byte digests; this group alone injects bad ones.
      const request = carrier(JSON.stringify(independentSpec()));
      const bytes = Buffer.from(request.requestUtf8Base64, "base64");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        request.requestFingerprint,
      );
    },
    testMs,
  );
});
