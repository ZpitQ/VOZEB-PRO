import { createHash } from "node:crypto";

import { NORMALIZATION_PROFILE, PROTOCOL_VERSION } from "../src/contracts.js";
import {
  freezeExecutionPolicy,
  type ClaimedAttempt,
} from "../src/execution.js";
import { runnerLimits } from "./storage-fixtures.js";

// A complete typed job is deliberately constructed without a store, image I/O,
// current configuration, or either new payload implementation in the oracle.
export function claimedAttempt(): ClaimedAttempt {
  const engine = {
    modelId: "fixture-model_4x",
    binaryVersion: "binary-1",
    binarySha256: "a".repeat(64),
    modelVersion: "model-1",
    modelSha256: "b".repeat(64),
    nativeScale: 4 as const,
    tile: 32,
    tta: false as const,
    gpuId: 0,
  };
  return {
    identity: {
      jobId: "fixture-job",
      attemptNo: 1,
      ownerInstanceId: "fixture-owner",
      fence: 2,
    },
    launchTicket: "fixture-launch",
    executionPolicy: structuredClone(
      freezeExecutionPolicy(runnerLimits, [0, 32, 64]),
    ),
    firstStartedAt: 1_000,
    executionDeadlineAt: 65_000,
    leaseExpiresAt: 16_000,
    inputPath: "Z:\\contract-only\\输入 🪑\\input.png",
    workingDirectory: "Z:\\contract-only\\work\\..\\work",
    outputPath: "Z:\\contract-only\\work\\output.png",
    tile: 32,
    job: {
      serviceId: "fixture-service",
      jobId: "fixture-job",
      clientId: "fixture-client",
      status: "running",
      reason: null,
      result: null,
      cancelRequested: false,
      createdAt: 500,
      queueDeadlineAt: 30_500,
      completedAt: null,
      source: {
        format: "png",
        width: 4,
        height: 3,
        encodedWidth: 4,
        encodedHeight: 3,
        orientation: 1,
        sha256: "c".repeat(64),
        byteLength: 100,
      },
      engineInput: {
        format: "png",
        width: 4,
        height: 3,
        sha256: "d".repeat(64),
        byteLength: 100,
        normalizationProfile: NORMALIZATION_PROFILE,
      },
      plan: {
        protocolVersion: PROTOCOL_VERSION,
        scope: "full_image",
        sourceSha256: "c".repeat(64),
        target: { width: 16, height: 12, format: "png" },
        normalizationProfile: NORMALIZATION_PROFILE,
        engine,
        budgets: {
          input: { maxBytes: 1000, maxPixels: 1000 },
          ai: { maxBytes: 4000, maxPixels: 4000 },
          delivery: { maxBytes: 4000, maxPixels: 4000 },
        },
        strategyFingerprint: "e".repeat(64),
        planFingerprint: "f".repeat(64),
      },
    },
  };
}

export function independentSpec(attempt = claimedAttempt()) {
  const { identity, launchTicket, executionPolicy } = attempt;
  const engine = attempt.job.plan.engine;
  return {
    v: 1,
    target: {
      identity: {
        jobId: identity.jobId,
        attemptNo: identity.attemptNo,
        ownerInstanceId: identity.ownerInstanceId,
        fence: identity.fence,
      },
      launchTicket,
    },
    executionPolicy: {
      limits: {
        executionTimeoutMs: executionPolicy.limits.executionTimeoutMs,
        cancelGraceMs: executionPolicy.limits.cancelGraceMs,
        leaseDurationMs: executionPolicy.limits.leaseDurationMs,
        heartbeatIntervalMs: executionPolicy.limits.heartbeatIntervalMs,
      },
      allowedTiles: [...executionPolicy.allowedTiles],
      fingerprint: executionPolicy.fingerprint,
    },
    engine: {
      modelId: engine.modelId,
      binaryVersion: engine.binaryVersion,
      binarySha256: engine.binarySha256,
      modelVersion: engine.modelVersion,
      modelSha256: engine.modelSha256,
      nativeScale: engine.nativeScale,
      tile: engine.tile,
      tta: engine.tta,
      gpuId: engine.gpuId,
    },
    firstStartedAt: attempt.firstStartedAt,
    executionDeadlineAt: attempt.executionDeadlineAt,
    inputPath: attempt.inputPath,
    workingDirectory: attempt.workingDirectory,
    outputPath: attempt.outputPath,
  };
}

export type IndependentSpec = ReturnType<typeof independentSpec>;
export type RequestCarrier = {
  requestUtf8Base64: string;
  requestFingerprint: string;
};
export function carrier(raw: string | Uint8Array): RequestCarrier {
  const bytes =
    typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
  return {
    requestUtf8Base64: bytes.toString("base64"),
    requestFingerprint: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function typedProjection(
  spec: IndependentSpec,
  request: RequestCarrier,
) {
  return {
    scope: {
      target: spec.target,
      executionPolicyFingerprint: spec.executionPolicy.fingerprint,
    },
    engine: spec.engine,
    limits: spec.executionPolicy.limits,
    allowedTiles: spec.executionPolicy.allowedTiles,
    firstStartedAt: spec.firstStartedAt,
    executionDeadlineAt: spec.executionDeadlineAt,
    inputPath: spec.inputPath,
    workingDirectory: spec.workingDirectory,
    outputPath: spec.outputPath,
    requestUtf8Base64: request.requestUtf8Base64,
    requestFingerprint: request.requestFingerprint,
  };
}

type Path = readonly string[];
function objectAt(root: unknown, path: Path): Record<string, unknown> {
  let value = root;
  for (const key of path) value = (value as Record<string, unknown>)[key];
  return value as Record<string, unknown>;
}
export function setValue(root: unknown, path: Path, value: unknown) {
  const key = path.at(-1)!;
  Object.defineProperty(objectAt(root, path.slice(0, -1)), key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
export function renewPolicy(attempt: ClaimedAttempt, tiles: readonly number[]) {
  setValue(
    attempt,
    ["executionPolicy"],
    structuredClone(
      freezeExecutionPolicy(attempt.executionPolicy.limits, tiles),
    ),
  );
}

export const selectedObjects = [
  {
    path: ["identity"],
    keys: ["jobId", "attemptNo", "ownerInstanceId", "fence"],
  },
  {
    path: ["executionPolicy"],
    keys: ["limits", "allowedTiles", "fingerprint"],
  },
  {
    path: ["executionPolicy", "limits"],
    keys: [
      "executionTimeoutMs",
      "cancelGraceMs",
      "leaseDurationMs",
      "heartbeatIntervalMs",
    ],
  },
  {
    path: ["job", "plan", "engine"],
    keys: [
      "modelId",
      "binaryVersion",
      "binarySha256",
      "modelVersion",
      "modelSha256",
      "nativeScale",
      "tile",
      "tta",
      "gpuId",
    ],
  },
] as const;

export type SourceVector = {
  name: string;
  apply(attempt: ClaimedAttempt): void;
};
export function sourceShapeVectors(): SourceVector[] {
  return selectedObjects.flatMap(({ path, keys }) => [
    ...keys.flatMap((key) => [
      {
        name: `${path.join(".")}.${key} missing`,
        apply: (a: ClaimedAttempt) => {
          Reflect.deleteProperty(objectAt(a, path), key);
        },
      },
      {
        name: `${path.join(".")}.${key} nonenumerable`,
        apply: (a: ClaimedAttempt) => {
          Object.defineProperty(objectAt(a, path), key, { enumerable: false });
        },
      },
    ]),
    {
      name: `${path.join(".")} extra`,
      apply: (a: ClaimedAttempt) => {
        setValue(a, [...path, "extra"], true);
      },
    },
    {
      name: `${path.join(".")} symbol`,
      apply: (a: ClaimedAttempt) => {
        Object.defineProperty(objectAt(a, path), Symbol("extra"), {
          value: true,
        });
      },
    },
    {
      name: `${path.join(".")} hidden extra`,
      apply: (a: ClaimedAttempt) => {
        Object.defineProperty(objectAt(a, path), "hidden", { value: true });
      },
    },
    {
      name: `${path.join(".")} null prototype`,
      apply: (a: ClaimedAttempt) => {
        Object.setPrototypeOf(objectAt(a, path), null);
      },
    },
    {
      name: `${path.join(".")} custom prototype`,
      apply: (a: ClaimedAttempt) => {
        Object.setPrototypeOf(objectAt(a, path), { inherited: true });
      },
    },
    {
      name: `${path.join(".")} array`,
      apply: (a: ClaimedAttempt) => {
        setValue(a, path, []);
      },
    },
    {
      name: `${path.join(".")} null`,
      apply: (a: ClaimedAttempt) => {
        setValue(a, path, null);
      },
    },
  ]);
}

export const selectedSourcePaths: Path[] = [
  ...[
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
  ].map((key) => [key]),
  ["job", "jobId"],
  ["job", "plan"],
  ["job", "plan", "engine"],
  ...selectedObjects.flatMap(({ path, keys }) =>
    keys.map((key) => [...path, key]),
  ),
];
export function installGetter(root: unknown, path: Path, get: () => unknown) {
  Object.defineProperty(objectAt(root, path.slice(0, -1)), path.at(-1)!, {
    get,
    enumerable: true,
    configurable: true,
  });
}

export const sourceNumberPaths: Path[] = [
  ["identity", "attemptNo"],
  ["identity", "fence"],
  ...[
    "executionTimeoutMs",
    "cancelGraceMs",
    "leaseDurationMs",
    "heartbeatIntervalMs",
  ].map((key) => ["executionPolicy", "limits", key]),
  ["job", "plan", "engine", "nativeScale"],
  ["job", "plan", "engine", "tile"],
  ["job", "plan", "engine", "gpuId"],
  ["tile"],
  ["firstStartedAt"],
  ["executionDeadlineAt"],
  ["executionPolicy", "allowedTiles", "0"],
];
export const invalidSourceNumbers: readonly unknown[] = [
  -0,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  NaN,
  Infinity,
  "32",
  null,
];

export const identifierSourcePaths: Path[] = [
  ["identity", "jobId"],
  ["identity", "ownerInstanceId"],
  ["launchTicket"],
  ["job", "plan", "engine", "binaryVersion"],
  ["job", "plan", "engine", "modelVersion"],
];
export const pathSourcePaths = [
  ["inputPath"],
  ["workingDirectory"],
  ["outputPath"],
] as const;
export const jsWhitespace = [
  "\u0009",
  "\u000a",
  "\u000b",
  "\u000c",
  "\u000d",
  "\u0020",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
] as const;

export function sourceArrayVectors(): SourceVector[] {
  return [
    {
      name: "empty",
      apply: (a) => setValue(a, ["executionPolicy", "allowedTiles"], []),
    },
    {
      name: "nonarray",
      apply: (a) =>
        setValue(a, ["executionPolicy", "allowedTiles"], { 0: 32, length: 1 }),
    },
    {
      name: "hole",
      apply: (a) => {
        Reflect.deleteProperty(a.executionPolicy.allowedTiles, "0");
      },
    },
    {
      name: "extra",
      apply: (a) =>
        setValue(a, ["executionPolicy", "allowedTiles", "extra"], true),
    },
    {
      name: "symbol",
      apply: (a) => {
        Object.defineProperty(a.executionPolicy.allowedTiles, Symbol("extra"), {
          value: true,
        });
      },
    },
    {
      name: "hidden extra",
      apply: (a) => {
        Object.defineProperty(a.executionPolicy.allowedTiles, "hidden", {
          value: true,
        });
      },
    },
    {
      name: "hidden index",
      apply: (a) => {
        Object.defineProperty(a.executionPolicy.allowedTiles, "0", {
          enumerable: false,
        });
      },
    },
    {
      name: "custom prototype",
      apply: (a) => {
        Object.setPrototypeOf(
          a.executionPolicy.allowedTiles,
          Object.create(Array.prototype),
        );
      },
    },
    { name: "duplicate", apply: (a) => renewPolicy(a, [32, 32]) },
    { name: "small tile", apply: (a) => renewPolicy(a, [0, 31, 32]) },
  ];
}

export type RawVector = { name: string; request: RequestCarrier };
export function changedRaw(
  name: string,
  edit: (spec: IndependentSpec) => void,
): RawVector {
  const spec = independentSpec();
  edit(spec);
  return { name, request: carrier(JSON.stringify(spec)) };
}

export function nativeShapeVectors(): RawVector[] {
  const raw = JSON.stringify(independentSpec());
  const objects = [
    {
      path: [],
      keys: [
        "v",
        "target",
        "executionPolicy",
        "engine",
        "firstStartedAt",
        "executionDeadlineAt",
        "inputPath",
        "workingDirectory",
        "outputPath",
      ],
    },
    { path: ["target"], keys: ["identity", "launchTicket"] },
    {
      path: ["target", "identity"],
      keys: ["jobId", "attemptNo", "ownerInstanceId", "fence"],
    },
    {
      path: ["executionPolicy"],
      keys: ["limits", "allowedTiles", "fingerprint"],
    },
    {
      path: ["executionPolicy", "limits"],
      keys: [
        "executionTimeoutMs",
        "cancelGraceMs",
        "leaseDurationMs",
        "heartbeatIntervalMs",
      ],
    },
    {
      path: ["engine"],
      keys: [
        "modelId",
        "binaryVersion",
        "binarySha256",
        "modelVersion",
        "modelSha256",
        "nativeScale",
        "tile",
        "tta",
        "gpuId",
      ],
    },
  ];
  return objects.flatMap(({ path, keys }) => {
    const firstKey = keys[0]!;
    const firstValue = JSON.stringify(
      objectAt(independentSpec(), path)[firstKey],
    );
    const token = `${JSON.stringify(firstKey)}:${firstValue}`;
    const offset =
      path.length === 0
        ? 0
        : raw.indexOf(`${JSON.stringify(path.at(-1))}:{`) +
          JSON.stringify(path.at(-1)).length +
          1;
    const prefix = raw.slice(0, offset);
    const objectRaw = raw.slice(offset);
    const duplicate = `${token},${token}`;
    const escapedName = `"\\u${firstKey.charCodeAt(0).toString(16).padStart(4, "0")}${firstKey.slice(1)}":${firstValue}`;
    return [
      ...keys.map((key) =>
        changedRaw(`${path.join(".") || "root"}.${key} missing`, (s) => {
          Reflect.deleteProperty(objectAt(s, path), key);
        }),
      ),
      {
        name: `${path.join(".") || "root"} duplicate`,
        request: carrier(prefix + objectRaw.replace(token, duplicate)),
      },
      {
        name: `${path.join(".") || "root"} escaped duplicate`,
        request: carrier(
          prefix + objectRaw.replace(token, `${token},${escapedName}`),
        ),
      },
      changedRaw(`${path.join(".") || "root"} unknown`, (s) =>
        setValue(s, [...path, "extra"], true),
      ),
      changedRaw(`${path.join(".") || "root"} case wrong`, (s) => {
        const obj = objectAt(s, path);
        obj[firstKey.toUpperCase()] = obj[firstKey];
        Reflect.deleteProperty(obj, firstKey);
      }),
      ...(path.length > 0
        ? [
            changedRaw(`${path.join(".")} wrong object type`, (s) =>
              setValue(s, path, []),
            ),
          ]
        : []),
    ];
  });
}

export function nativeNumberVectors(): RawVector[] {
  const raw = JSON.stringify(independentSpec());
  const tokens = [
    ["v", "1"],
    ["attemptNo", "1"],
    ["fence", "2"],
    ["executionTimeoutMs", "60000"],
    ["cancelGraceMs", "5000"],
    ["leaseDurationMs", "15000"],
    ["heartbeatIntervalMs", "5000"],
    ["nativeScale", "4"],
    ["tile", "32"],
    ["gpuId", "0"],
    ["firstStartedAt", "1000"],
    ["executionDeadlineAt", "65000"],
  ] as const;
  return tokens
    .flatMap(([key, value]) =>
      ["-0", "-1", "1.0", "1e0", "9007199254740992", "null", '"1"'].map(
        (invalid) => ({
          name: `${key} token ${invalid}`,
          request: carrier(
            raw.replace(`"${key}":${value}`, `"${key}":${invalid}`),
          ),
        }),
      ),
    )
    .concat(
      ["-0", "-1", "32.0", "3.2e1", "9007199254740992", "null", '"32"'].map(
        (invalid) => ({
          name: `allowed tile token ${invalid}`,
          request: carrier(
            raw.replace(
              '"allowedTiles":[0,32,64]',
              `"allowedTiles":[${invalid},32,64]`,
            ),
          ),
        }),
      ),
    );
}

export function nativeSemanticVectors(): RawVector[] {
  const vectors: RawVector[] = [];
  for (const key of ["attemptNo", "fence"])
    vectors.push(
      changedRaw(`${key} zero`, (s) =>
        setValue(s, ["target", "identity", key], 0),
      ),
    );
  for (const key of [
    "executionTimeoutMs",
    "cancelGraceMs",
    "leaseDurationMs",
    "heartbeatIntervalMs",
  ])
    vectors.push(
      changedRaw(`${key} zero`, (s) =>
        setValue(s, ["executionPolicy", "limits", key], 0),
      ),
    );
  vectors.push(
    changedRaw("version unsupported", (s) => setValue(s, ["v"], 2)),
    changedRaw("native scale unsupported", (s) =>
      setValue(s, ["engine", "nativeScale"], 2),
    ),
    changedRaw("tta true", (s) => setValue(s, ["engine", "tta"], true)),
    changedRaw("tta wrong type", (s) =>
      setValue(s, ["engine", "tta"], "false"),
    ),
    changedRaw("heartbeat exceeds lease", (s) =>
      setValue(s, ["executionPolicy", "limits", "heartbeatIntervalMs"], 15001),
    ),
    changedRaw("tile outside allowed", (s) =>
      setValue(s, ["engine", "tile"], 96),
    ),
    changedRaw("tile too small", (s) => setValue(s, ["engine", "tile"], 31)),
    changedRaw("tiles duplicate", (s) =>
      setValue(s, ["executionPolicy", "allowedTiles"], [32, 32]),
    ),
    changedRaw("tiles too small", (s) =>
      setValue(s, ["executionPolicy", "allowedTiles"], [0, 31, 32]),
    ),
    changedRaw("tiles empty", (s) =>
      setValue(s, ["executionPolicy", "allowedTiles"], []),
    ),
    changedRaw("tiles not array", (s) =>
      setValue(s, ["executionPolicy", "allowedTiles"], {}),
    ),
    changedRaw("deadline equals start", (s) =>
      setValue(s, ["executionDeadlineAt"], s.firstStartedAt),
    ),
    changedRaw("deadline before start", (s) =>
      setValue(s, ["executionDeadlineAt"], 999),
    ),
    ...[
      ["engine", "binarySha256"],
      ["engine", "modelSha256"],
      ["executionPolicy", "fingerprint"],
    ].flatMap((path) =>
      ["A".repeat(64), "a".repeat(63), "g".repeat(64), null].map((value) =>
        changedRaw(
          `${path.join(".")} invalid ${String(value).slice(0, 1)}`,
          (s) => setValue(s, path, value),
        ),
      ),
    ),
    ...["", "-bad", "bad/model", "模型"].map((value) =>
      changedRaw(`model id invalid ${value}`, (s) =>
        setValue(s, ["engine", "modelId"], value),
      ),
    ),
    ...["executable", "argv", "shell", "modelDirectory"].map((key) =>
      changedRaw(`forbidden engine ${key}`, (s) =>
        setValue(s, ["engine", key], "forbidden"),
      ),
    ),
  );
  return vectors;
}

export function nativeUnicodeVectors(): RawVector[] {
  const vectors: RawVector[] = [];
  const paths = [
    ["target", "identity", "jobId"],
    ["target", "identity", "ownerInstanceId"],
    ["target", "launchTicket"],
    ["engine", "binaryVersion"],
    ["engine", "modelVersion"],
  ];
  for (const path of paths)
    for (const value of [
      "",
      "bad\u0001",
      "bad\u007f",
      "\ud800",
      "\udfff",
      null,
    ])
      vectors.push(
        changedRaw(`${path.join(".")} invalid string`, (s) =>
          setValue(s, path, value),
        ),
      );
  for (const whitespace of jsWhitespace)
    for (const value of [`${whitespace}name`, `name${whitespace}`])
      vectors.push(
        changedRaw(
          `JS boundary U+${whitespace.charCodeAt(0).toString(16)}`,
          (s) => setValue(s, ["engine", "binaryVersion"], value),
        ),
      );
  for (const path of pathSourcePaths)
    for (const value of ["", "bad\u0000path", "\ud800", "\udfff", null])
      vectors.push(
        changedRaw(`${path.join(".")} invalid path`, (s) =>
          setValue(s, path, value),
        ),
      );
  return vectors;
}

export function nativeGrammarVectors(): RawVector[] {
  const raw = JSON.stringify(independentSpec());
  const invalid = [
    ["BOM", `\ufeff${raw}`],
    ["leading whitespace", ` ${raw}`],
    ["trailing whitespace", `${raw}\n`],
    ["comment", raw.replace('{"v":1,', '{/*x*/"v":1,')],
    ["trailing comma", `${raw.slice(0, -1)},}`],
    ["second object", `${raw}{}`],
    ["root array", `[${raw}]`],
    ["root null", "null"],
    ["truncated", raw.slice(0, -1)],
    ["leading zero", raw.replace('"attemptNo":1', '"attemptNo":01')],
    ["lone escaped property surrogate", raw.replace('"v":', '"\\ud800":')],
  ];
  return invalid
    .map(([name, text]) => ({ name: name!, request: carrier(text!) }))
    .concat([
      {
        name: "invalid raw UTF8",
        request: carrier(
          Buffer.concat([
            Buffer.from(raw.slice(0, -1)),
            Buffer.from([0xc0, 0xaf]),
            Buffer.from("}"),
          ]),
        ),
      },
    ]);
}

export function nativeCarrierVectors(): RawVector[] {
  const raw = JSON.stringify(independentSpec());
  const base = carrier(raw);
  const bytes = Buffer.from(base.requestUtf8Base64, "base64");
  const differentBytes = carrier(`${raw} `);
  // Supply a valid internally spaced JSON whose Base64 actually needs padding.
  const padded = carrier(bytes.length % 3 === 0 ? `{ ${raw.slice(1)}` : raw);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padStart = padded.requestUtf8Base64.indexOf("=");
  const finalIndex = padStart - 1;
  const finalCharacter = padded.requestUtf8Base64[finalIndex]!;
  const noncanonical =
    padded.requestUtf8Base64.slice(0, finalIndex) +
    alphabet[alphabet.indexOf(finalCharacter) + 1]! +
    padded.requestUtf8Base64.slice(padStart);
  return [
    {
      name: "SHA mismatch",
      request: { ...base, requestFingerprint: "0".repeat(64) },
    },
    {
      name: "uppercase SHA",
      request: {
        ...base,
        requestFingerprint: base.requestFingerprint.toUpperCase(),
      },
    },
    {
      name: "short SHA",
      request: {
        ...base,
        requestFingerprint: base.requestFingerprint.slice(1),
      },
    },
    {
      name: "nonhex SHA",
      request: { ...base, requestFingerprint: "g".repeat(64) },
    },
    {
      name: "Base64 whitespace",
      request: { ...base, requestUtf8Base64: `${base.requestUtf8Base64}\n` },
    },
    {
      name: "Base64 invalid alphabet",
      request: { ...base, requestUtf8Base64: "%%%=" },
    },
    {
      name: "Base64 missing padding",
      request: {
        ...padded,
        requestUtf8Base64: padded.requestUtf8Base64.replace(/=+$/, ""),
      },
    },
    {
      name: "Base64 nonzero unused pad bits",
      request: { ...padded, requestUtf8Base64: noncanonical },
    },
    {
      name: "Base64 extra padding",
      request: { ...padded, requestUtf8Base64: `${padded.requestUtf8Base64}=` },
    },
    { name: "empty Base64", request: carrier("") },
    {
      name: "hash of Base64 text",
      request: {
        ...base,
        requestFingerprint: createHash("sha256")
          .update(base.requestUtf8Base64)
          .digest("hex"),
      },
    },
    {
      name: "different original bytes",
      request: {
        ...differentBytes,
        requestFingerprint: base.requestFingerprint,
      },
    },
  ];
}
