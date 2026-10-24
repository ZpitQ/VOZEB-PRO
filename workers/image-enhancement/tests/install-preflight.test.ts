import { mkdtemp, readdir } from "node:fs/promises";
import * as filesModule from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as bootstrapModule from "../src/bootstrap.js";
import * as clockModule from "../src/clock.js";
import { EnhancementError } from "../src/contracts.js";
import * as credentialsModule from "../src/credentials.js";
import * as httpModule from "../src/http.js";
import * as tlsModule from "../src/https.js";
import * as managementModule from "../src/offline-management.js";
import * as runnerModule from "../src/runner.js";
import * as storeModule from "../src/store.js";
import * as hostModule from "../src/windows-control-bridge-host.js";
import * as adapterModule from "../src/windows-execution-adapter.js";
import * as journalModule from "../src/windows-journal-launcher.js";
import { configInput } from "./fixtures.js";
import { transportLimits } from "./http-fixtures.js";
import { runnerLimits, submissionLimits } from "./storage-fixtures.js";
import { runnerAdapterOptions } from "./windows-execution-adapter-runner-fixtures.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

type Validator = (value: unknown, appDirectory: string) => void;

beforeEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(filesModule.readFile)
    .mockReset()
    .mockImplementation(actual.readFile);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function validator(): Validator {
  const candidate = Reflect.get(
    bootstrapModule,
    "validateWindowsWorkerInstallConfiguration",
  );
  expect(
    typeof candidate === "function",
    "it exposes the real install preflight",
  ).toBe(true);
  return candidate as Validator;
}

async function fixture() {
  // Preserve the unique empty tree as evidence; this fixture creates no Store.
  const root = await mkdtemp(join(tmpdir(), "enhancement-install-preflight-"));
  const appDirectory = join(root, "payload", "app");
  const configuration = {
    storeDirectory: join(root, "absent-store"),
    port: 32_001,
    tls: {
      host: "127.0.0.1",
      pfxPath: join(root, "absent-tls", "private.pfx"),
    },
    // Format-only fixture identity; no client, credential or pairing is created.
    operatorClientId: "11111111-1111-4111-8111-111111111111",
    selfTestModelId: "standard-4x",
    workerConfig: configInput(),
    submissionLimits,
    runnerLimits,
    transportLimits,
    execution: {
      installationRoot: join(root, "absent-engine"),
      recordsRoot: join(root, "absent-records"),
      expectedManifestSha256:
        runnerAdapterOptions.bridge.expectedManifestSha256,
      bridgeLimits: runnerAdapterOptions.bridge.limits,
      journalLimits: runnerAdapterOptions.journalLimits,
    },
  };
  return { root, appDirectory, configuration };
}

function observeResources() {
  const observations = [
    vi.mocked(filesModule.readFile),
    vi.spyOn(storeModule, "openStore"),
    vi.spyOn(storeModule, "initializeStore"),
    vi.spyOn(credentialsModule, "rotateCredential"),
    vi.spyOn(managementModule, "runOfflineCredentialCommand"),
    vi.spyOn(clockModule, "createSystemClock"),
    vi.spyOn(adapterModule, "createWindowsExecutionAdapter"),
    vi.spyOn(runnerModule, "createRunner"),
    vi.spyOn(hostModule, "createWindowsControlBridgeHost"),
    vi.spyOn(journalModule, "createWindowsJournalLauncher"),
    vi.spyOn(httpModule, "listenEnhancementServer"),
    vi.spyOn(tlsModule, "listenEnhancementTlsServer"),
    vi.spyOn(globalThis, "setTimeout"),
    vi.spyOn(globalThis, "setInterval"),
  ];
  // Read immediately after the target; reporter/file assertions are outside it.
  return () => observations.map((observation) => observation.mock.calls.length);
}

function noResources(counts: readonly number[]) {
  expect(
    counts.every((count) => count === 0),
    "no I/O, identity or runtime work",
  ).toBe(true);
}

function rejected(action: () => unknown, counts: () => readonly number[]) {
  let failure: unknown;
  try {
    const result = action();
    if (result instanceof Promise) void result.catch(() => {});
  } catch (error) {
    failure = error;
  }
  const observed = counts();
  noResources(observed);
  expect(
    failure instanceof EnhancementError,
    "synchronous safe rejection",
  ).toBe(true);
  if (!(failure instanceof EnhancementError)) return;
  const expected = new EnhancementError("configuration_invalid");
  expect(
    failure.code === expected.code &&
      failure.status === expected.status &&
      failure.message === expected.message &&
      isDeepStrictEqual(
        Reflect.ownKeys(failure).sort(),
        Reflect.ownKeys(expected).sort(),
      ),
    "configuration_invalid without private attached data",
  ).toBe(true);
}

function environment() {
  return Object.fromEntries(
    ["SystemRoot", "WINDIR", "TEMP", "TMP"].map((name) => [
      name,
      process.env[name],
    ]),
  );
}

// The actual Windows environment and absolute filesystem paths are used here;
// the two environment failures below are scoped test substitutions only.
describe.skipIf(process.platform !== "win32")(
  "install configuration preflight",
  () => {
    it("returns synchronous void without changing input, environment or an empty tree with absent resources", async () => {
      const f = await fixture();
      const before = structuredClone(f.configuration);
      const envBefore = environment();
      const treeBefore = await readdir(f.root);
      const validate = validator();
      const counts = observeResources();
      let result: unknown;
      let threw = false;
      try {
        result = validate(f.configuration, f.appDirectory);
      } catch {
        threw = true;
      }
      if (result instanceof Promise) void result.catch(() => {});
      const observed = counts();
      expect(threw, "no raw unexpected error reaches the reporter").toBe(false);
      expect(
        result === undefined,
        "synchronous void, no normalized configuration",
      ).toBe(true);
      noResources(observed);
      expect(
        isDeepStrictEqual(f.configuration, before),
        "all input unchanged",
      ).toBe(true);
      expect(
        isDeepStrictEqual(environment(), envBefore),
        "no environment mutation",
      ).toBe(true);
      expect(
        isDeepStrictEqual(await readdir(f.root), treeBefore),
        "no resource paths created",
      ).toBe(true);
    });

    it.each(["127.0.0.1", "127.0.0.2"])(
      "accepts internal HTTP on explicit %s without PFX or resource work",
      async (host) => {
        const f = await fixture();
        const input: Record<string, unknown> = { ...f.configuration, host };
        delete input.tls;
        const counts = observeResources();
        expect(() => validator()(input, f.appDirectory)).not.toThrow();
        noResources(counts());
        expect(await readdir(f.root)).toEqual([]);
      },
    );

    it.each(["both-transports", "http-null", "http-name", "http-port-zero"] as const)(
      "rejects internal HTTP %s without resource work",
      async (mode) => {
        const f = await fixture();
        const input: Record<string, unknown> = { ...f.configuration, host: "127.0.0.1" };
        if (mode !== "both-transports") delete input.tls;
        if (mode === "http-null") input.host = null;
        if (mode === "http-name") input.host = "localhost";
        if (mode === "http-port-zero") input.port = 0;
        const counts = observeResources();
        rejected(() => validator()(input, f.appDirectory), counts);
        expect(await readdir(f.root)).toEqual([]);
      },
    );

    it.each(["missing-tls", "null-tls", "undefined-tls", "port-zero"] as const)(
      "rejects formal %s while keeping the programmatic compatibility separate",
      async (mode) => {
        const f = await fixture();
        const input: Record<string, unknown> = { ...f.configuration };
        if (mode === "missing-tls") delete input.tls;
        else if (mode === "null-tls") input.tls = null;
        else if (mode === "undefined-tls") input.tls = undefined;
        else input.port = 0;
        const validate = validator();
        const counts = observeResources();
        rejected(() => validate(input, f.appDirectory), counts);
        expect(isDeepStrictEqual(await readdir(f.root), [])).toBe(true);
      },
    );

    it.each([
      "operator",
      "model",
      "budget",
      "extra-field",
      "getter",
      "proxy",
      "app-directory",
    ] as const)(
      "reuses the original %s configuration boundary without resource work",
      async (mode) => {
        const f = await fixture();
        let input: unknown = f.configuration;
        let appDirectory = f.appDirectory;
        const callback = vi.fn();
        if (mode === "operator")
          input = {
            ...f.configuration,
            operatorClientId: "invalid-private-operator",
          };
        else if (mode === "model")
          input = { ...f.configuration, selfTestModelId: "unconfigured-model" };
        else if (mode === "budget")
          input = {
            ...f.configuration,
            workerConfig: {
              ...f.configuration.workerConfig,
              budgets: {
                ...f.configuration.workerConfig.budgets,
                input: { maxBytes: 0, maxPixels: 1 },
              },
            },
          };
        else if (mode === "extra-field")
          input = { ...f.configuration, ready: true };
        else if (mode === "getter")
          Object.defineProperty(f.configuration, "operatorClientId", {
            enumerable: true,
            get() {
              callback();
              return "private-value-must-not-be-read";
            },
          });
        else if (mode === "proxy")
          input = new Proxy(f.configuration, {
            get() {
              callback();
              return undefined;
            },
            getPrototypeOf() {
              callback();
              return Object.prototype;
            },
            ownKeys() {
              callback();
              return [];
            },
          });
        else appDirectory = "relative-private-app";
        const validate = validator();
        const counts = observeResources();
        rejected(() => validate(input, appDirectory), counts);
        expect(callback.mock.calls.length).toBe(0);
        expect(isDeepStrictEqual(await readdir(f.root), [])).toBe(true);
      },
    );

    it.each(["missing", "relative"] as const)(
      "keeps the original necessary SystemRoot %s rejection",
      async (mode) => {
        const f = await fixture();
        vi.stubEnv(
          "SystemRoot",
          mode === "missing" ? undefined : "relative-private-system",
        );
        const envBefore = environment();
        const validate = validator();
        const counts = observeResources();
        rejected(() => validate(f.configuration, f.appDirectory), counts);
        expect(
          isDeepStrictEqual(environment(), envBefore),
          "validator does not repair environment",
        ).toBe(true);
        expect(isDeepStrictEqual(await readdir(f.root), [])).toBe(true);
      },
    );
  },
);
