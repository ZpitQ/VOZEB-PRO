import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startWindowsWorker } from "../src/bootstrap.js";
import {
  EnhancementError,
  type EnhancementErrorCode,
} from "../src/contracts.js";
import { revokeCredential } from "../src/credentials.js";
import * as httpModule from "../src/http.js";
import * as storeModule from "../src/store.js";
import type { AuthenticatedClient } from "../src/store.js";
import * as hostModule from "../src/windows-control-bridge-host.js";
import * as journalModule from "../src/windows-journal-launcher.js";
import { configInput } from "./fixtures.js";
import {
  httpFixture,
  transportLimits,
  type HttpResult,
} from "./http-fixtures.js";
import {
  runnerLimits,
  storageFixture,
  submissionLimits,
} from "./storage-fixtures.js";
import { runnerAdapterOptions } from "./windows-execution-adapter-runner-fixtures.js";

const routes = [
  { method: "GET", operation: "query" },
  { method: "POST", operation: "enter" },
] as const;
type Operation = (typeof routes)[number]["operation"];
type Observation = ReturnType<typeof observation>;
type Maintenance = Readonly<{
  enter(principal: AuthenticatedClient): Observation;
  query(principal: AuthenticatedClient): Observation;
}>;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

// Literal owner replies verify transport only; they do not model C4 drainage.
function observation(operation: Operation) {
  const sealed = operation === "enter";
  return Object.freeze({
    bootId: "33333333-3333-4333-8333-333333333333",
    sealed,
    state: sealed ? ("draining" as const) : ("open" as const),
    canStop: false,
    store: Object.freeze({
      queued: 3,
      running: 0,
      slots: 0,
      unreleasedReferences: 0,
    }),
    http: Object.freeze({ sealed, uploads: 1, downloads: 0, receipts: 0 }),
    pending: Object.freeze({
      selfTestAdmission: 0,
      selfTestOutputRead: 0,
      runner: 0,
      adapter: 0,
    }),
    runtime: Object.freeze({
      closing: false,
      startupRecovery: "settled" as const,
      runner: Object.freeze({
        closed: false,
        storeClosed: false,
        recoveryState: "idle" as const,
        recoveryInFlight: false,
        ownedState: "none" as const,
      }),
      adapter: Object.freeze({
        sealed: false,
        activity: "idle" as const,
        close: "not_requested" as const,
      }),
    }),
  });
}

function callbacks() {
  return Object.freeze({
    enter: vi.fn<Maintenance["enter"]>().mockReturnValue(observation("enter")),
    query: vi.fn<Maintenance["query"]>().mockReturnValue(observation("query")),
  });
}

async function fixture(maintenance?: Maintenance) {
  const onJobCommitted = vi.fn();
  const options: NonNullable<Parameters<typeof httpFixture>[0]> = {
    ready: undefined,
    onJobCommitted,
  };
  // Optional future wiring must fail at a real response assertion, not loading.
  if (maintenance) Reflect.set(options, "maintenance", maintenance);
  const f = await httpFixture(options);
  cleanups.push(() => f.cleanup());
  const business = {
    lookup: vi.spyOn(f.storage.store, "findByKey"),
    query: vi.spyOn(f.storage.store, "getOwned"),
    claim: vi.spyOn(f.storage.store, "claimNext"),
    selfTest: vi.spyOn(f.storage.store, "inspectQueuedSelfTest"),
    maintenance: vi.spyOn(f.storage.store, "inspectMaintenance"),
  };
  return Object.assign(f, { onJobCommitted, business });
}
type HttpFixture = Awaited<ReturnType<typeof fixture>>;

function expectSafe(
  result: HttpResult,
  f: HttpFixture,
  privateValues: readonly string[] = [],
) {
  for (const value of [
    f.storage.directory,
    f.storage.initialized.credential.key,
    ...privateValues,
  ])
    expect(
      result.raw.includes(JSON.stringify(value).slice(1, -1)),
      "response excludes private data",
    ).toBe(false);
  expect(
    /"(?:authorization|credential|credentialId|clientId|operatorClientId|key_digest|key|jobId|attemptId|attemptNo|launchTicket|ownerInstanceId|path|binaryPath|modelPath|recordsRoot|installationRoot|windowsIdentity|inputBytes|outputBytes|bytes|stack|cause|ready|stop)"\s*:|Bearer /i.test(
      result.raw,
    ),
    "response retains the safe observation or error fields",
  ).toBe(false);
}

function expectError(
  result: HttpResult,
  status: number,
  code: EnhancementErrorCode,
  f: HttpFixture,
  privateValues: readonly string[] = [],
) {
  expectSafe(result, f, privateValues);
  expect(result.status).toBe(status);
  const requestId: unknown = result.body?.data?.requestId;
  expect(typeof requestId === "string").toBe(true);
  expect(
    isDeepStrictEqual(result.body, {
      code,
      data: { requestId },
      msg: new EnhancementError(code).message,
    }),
    "exact sanitized error envelope",
  ).toBe(true);
}

function expectNoCallbacks(maintenance: ReturnType<typeof callbacks>) {
  expect(maintenance.enter.mock.calls.length).toBe(0);
  expect(maintenance.query.mock.calls.length).toBe(0);
}

async function expectNoHttpBusiness(f: HttpFixture) {
  for (const spy of Object.values(f.business))
    expect(spy.mock.calls.length).toBe(0);
  expect(f.onJobCommitted.mock.calls.length).toBe(0);
  expect((await f.inputNames()).length).toBe(0);
  expect(
    isDeepStrictEqual(f.server.fileIo.activity(), {
      sealed: false,
      uploads: 0,
      downloads: 0,
      receipts: 0,
    }),
    "HTTP does not invent maintenance state or file work",
  ).toBe(true);
}

function unreadBytes(f: HttpFixture) {
  let bytes = 0;
  const observe = (request: IncomingMessage) => {
    const original = request.read.bind(request);
    request.read = (size?: number) => {
      const value = original(size);
      if (value !== null) bytes += Buffer.byteLength(value);
      return value;
    };
  };
  f.server.prependListener("request", observe);
  f.server.prependListener("checkContinue", observe);
  f.server.prependListener("checkExpectation", observe);
  return () => bytes;
}

async function requestObservation(
  f: HttpFixture,
  method: string,
  zeroLength = true,
) {
  const connection = f.start(method, "/v1/maintenance", {
    authorization: f.auth(),
    ...(zeroLength ? { "content-length": 0 } : {}),
  });
  let cache: unknown;
  connection.req.once("response", (response) => {
    cache = response.headers["cache-control"];
  });
  connection.req.end();
  return { result: await connection.result, cache };
}

describe("synchronous maintenance HTTP thin wiring", () => {
  it.each(
    routes.flatMap((route) =>
      [false, true].map((zeroLength) => ({ ...route, zeroLength })),
    ),
  )(
    "$method calls only $operation synchronously and returns 200 with zeroLength=$zeroLength",
    async ({ method, operation, zeroLength }) => {
      const maintenance = callbacks();
      const expected = observation(operation);
      const f = await fixture(maintenance);
      const authenticated = vi.spyOn(f.storage.store, "authenticateDigest");
      const originalAssert = f.storage.store.assertPrincipal.bind(
        f.storage.store,
      );
      const order: string[] = [];
      let callbackReturned = false;
      const assertion = vi
        .spyOn(f.storage.store, "assertPrincipal")
        .mockImplementation((principal) => {
          if (callbackReturned) order.push("final assertion");
          return originalAssert(principal);
        });
      maintenance[operation].mockImplementation(() => {
        order.push("callback");
        queueMicrotask(() => order.push("microtask"));
        callbackReturned = true;
        return expected;
      });
      const { result, cache } = await requestObservation(f, method, zeroLength);
      expect(result.status).toBe(200);
      expectSafe(result, f);
      expect(
        isDeepStrictEqual(result.body, {
          code: "ok",
          data: expected,
          msg: "成功。",
        }),
        "exact owner observation envelope",
      ).toBe(true);
      expect(cache === "no-store").toBe(true);
      expect(authenticated.mock.calls.length).toBe(1);
      expect(maintenance[operation].mock.calls.length).toBe(1);
      const principal = maintenance[operation].mock.calls[0]?.[0];
      expect(
        principal !== undefined &&
          principal === authenticated.mock.results[0]?.value,
        "callback receives the original authenticated principal",
      ).toBe(true);
      expect(
        isDeepStrictEqual(maintenance[operation].mock.calls, [[principal]]),
        "callback receives only the original principal",
      ).toBe(true);
      expect(
        isDeepStrictEqual(assertion.mock.calls.at(-1), [principal]),
        "final authorization uses the original principal",
      ).toBe(true);
      expect(
        order.indexOf("final assertion") > order.indexOf("callback") &&
          order.indexOf("final assertion") < order.indexOf("microtask"),
        "no await is inserted before final authorization",
      ).toBe(true);
      expect(
        maintenance[operation === "enter" ? "query" : "enter"].mock.calls
          .length,
      ).toBe(0);
      const capabilities = await f.call("GET", "/v1/capabilities");
      expect(
        isDeepStrictEqual(
          {
            ready: capabilities.body?.data?.ready,
            reason: capabilities.body?.data?.reason,
          },
          { ready: false, reason: "runner_unavailable" },
        ),
        "ordinary readiness remains unavailable",
      ).toBe(true);
      await expectNoHttpBusiness(f);
    },
  );

  it("keeps both routes authenticated and not found when callbacks are absent", async () => {
    const f = await fixture();
    for (const { method } of routes) {
      expectError(
        await f.call(method, "/v1/maintenance", undefined, {}),
        401,
        "authentication_failed",
        f,
      );
      expectError(
        await f.call(method, "/v1/maintenance"),
        404,
        "route_not_found",
        f,
      );
    }
    await expectNoHttpBusiness(f);
  });

  it.each(["missing", "revoked"] as const)(
    "rejects %s authentication before route validation and callbacks",
    async (kind) => {
      const maintenance = callbacks();
      const f = await fixture(maintenance);
      const consumed = unreadBytes(f);
      if (kind === "revoked")
        revokeCredential(
          f.storage.store,
          f.storage.initialized.credential.credentialId,
        );
      const headers = kind === "missing" ? {} : { authorization: f.auth() };
      for (const method of ["GET", "POST", "PATCH"])
        expectError(
          await f.call(
            method,
            "/v1/maintenance?canStop=true&ready=true",
            Buffer.from("private-unread-maintenance-body"),
            headers,
          ),
          401,
          "authentication_failed",
          f,
          ["private-unread-maintenance-body"],
        );
      expectNoCallbacks(maintenance);
      expect(consumed()).toBe(0);
      await expectNoHttpBusiness(f);
    },
  );

  it("rejects unsupported methods with no owner or business work", async () => {
    const maintenance = callbacks();
    const f = await fixture(maintenance);
    for (const method of ["PATCH", "DELETE"])
      expectError(
        await f.call(method, "/v1/maintenance"),
        405,
        "method_not_allowed",
        f,
      );
    expectNoCallbacks(maintenance);
    await expectNoHttpBusiness(f);
  });

  it.each([
    "query selectors",
    "empty query",
    "body",
    "transfer encoding",
    "nonzero length",
    "ambiguous length",
  ] as const)(
    "rejects %s on both operations before consuming input or calling the owner",
    async (kind) => {
      const maintenance = callbacks();
      const f = await fixture(maintenance);
      const consumed = unreadBytes(f);
      const privatePath = "C:\\private-wiring\\source.png";
      const selectors = JSON.stringify({
        path: privatePath,
        jobId: "private-wiring-job",
        owner: "private-wiring-owner",
        seal: true,
        canStop: true,
        ready: true,
        stop: "force",
      });
      for (const { method } of routes) {
        const path =
          "/v1/maintenance" +
          (kind === "query selectors"
            ? "?path=C%3A%5Cprivate-wiring%5Csource.png&jobId=private-wiring-job&owner=private-wiring-owner&seal=true&canStop=true&ready=true&stop=force"
            : kind === "empty query"
              ? "?"
              : "");
        if (kind === "ambiguous length") {
          const connection = f.start(method, path, [
            "Authorization",
            f.auth(),
            "Content-Length",
            "0",
            "Content-Length",
            "1",
          ]);
          // Node rejects this framing before the application can return JSON.
          const status = new Promise<number>((resolve, reject) => {
            connection.req.once("error", () =>
              reject(new Error("framing connection failed")),
            );
            connection.req.once("response", (response) => {
              response.once("error", () =>
                reject(new Error("framing response failed")),
              );
              response.once("end", () => resolve(response.statusCode ?? 0));
              response.resume();
            });
          });
          connection.req.end();
          expect(await status).toBe(400);
          continue;
        }
        let result: HttpResult;
        if (kind === "nonzero length") {
          const connection = f.start(method, path, {
            authorization: f.auth(),
            "content-length": 1,
          });
          connection.req.flushHeaders();
          result = await connection.result;
          connection.req.destroy();
        } else {
          result = await f.call(
            method,
            path,
            kind === "body" ? Buffer.from(selectors) : undefined,
            {
              authorization: f.auth(),
              ...(kind === "body"
                ? { "content-type": "application/json" }
                : {}),
              ...(kind === "transfer encoding"
                ? { "transfer-encoding": "chunked" }
                : {}),
            },
          );
        }
        expectError(result, 400, "invalid_request", f, [
          privatePath,
          "private-wiring-job",
          "private-wiring-owner",
        ]);
      }
      expectNoCallbacks(maintenance);
      expect(consumed()).toBe(0);
      await expectNoHttpBusiness(f);
    },
  );

  it.each(
    routes.flatMap((route) =>
      ["known", "unknown"].map((kind) => ({ ...route, kind })),
    ),
  )(
    "sanitizes a $kind synchronous $operation failure from $method",
    async ({ method, operation, kind }) => {
      const maintenance = callbacks();
      const f = await fixture(maintenance);
      const privateMessage =
        "private-maintenance-failure C:\\private-wiring\\ticket " +
        f.storage.initialized.credential.key;
      const failure =
        kind === "known"
          ? new EnhancementError("invalid_output")
          : new Error(privateMessage);
      failure.message = privateMessage;
      maintenance[operation].mockImplementation(() => {
        throw failure;
      });
      const { result, cache } = await requestObservation(f, method);
      expectError(
        result,
        kind === "known" ? 422 : 503,
        kind === "known" ? "invalid_output" : "internal_error",
        f,
        [
          privateMessage,
          "private-maintenance-failure",
          "C:\\private-wiring\\ticket",
        ],
      );
      expect(cache === "no-store").toBe(true);
      expect(maintenance[operation].mock.calls.length).toBe(1);
      expect(
        maintenance[operation === "enter" ? "query" : "enter"].mock.calls
          .length,
      ).toBe(0);
      await expectNoHttpBusiness(f);
    },
  );

  it.each(
    routes.flatMap((route) =>
      ["revoke", "close"].map((fault) => ({ ...route, fault })),
    ),
  )(
    "$method rejects a late $operation observation after synchronous $fault",
    async ({ method, operation, fault }) => {
      const maintenance = callbacks();
      const f = await fixture(maintenance);
      const late = observation(operation);
      maintenance[operation].mockImplementation(() => {
        if (fault === "revoke")
          revokeCredential(
            f.storage.store,
            f.storage.initialized.credential.credentialId,
          );
        else f.storage.store.close();
        return late;
      });
      const { result, cache } = await requestObservation(f, method);
      expectError(
        result,
        fault === "revoke" ? 401 : 503,
        fault === "revoke" ? "authentication_failed" : "internal_error",
        f,
        [late.bootId],
      );
      expect(cache === "no-store").toBe(true);
      expect(maintenance[operation].mock.calls.length).toBe(1);
      expect(
        maintenance[operation === "enter" ? "query" : "enter"].mock.calls
          .length,
      ).toBe(0);
      await expectNoHttpBusiness(f);
    },
  );
});

it.skipIf(process.platform !== "win32")(
  "bootstrap forwards the exact frozen runtime maintenance object to its original listener",
  async () => {
    const storage = await storageFixture();
    cleanups.push(() => storage.cleanup());
    storage.store.close();
    const opened = vi.spyOn(storeModule, "openStore");
    const listener = vi.spyOn(httpModule, "listenEnhancementServer");
    const host = vi.spyOn(hostModule, "createWindowsControlBridgeHost");
    const journal = vi.spyOn(journalModule, "createWindowsJournalLauncher");
    const runtime = await startWindowsWorker(
      {
        storeDirectory: storage.directory,
        operatorClientId: storage.initialized.credential.clientId,
        selfTestModelId: "standard-4x",
        port: 0,
        workerConfig: configInput(),
        submissionLimits: { ...submissionLimits },
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
      },
      {
        appDirectory: fileURLToPath(new URL("..", import.meta.url)),
        signal: new AbortController().signal,
      },
    );
    storage.setStore(opened.mock.results[0]!.value);
    cleanups.push(async () => {
      const closed = new Promise<void>((resolve) =>
        runtime.server.once("close", resolve),
      );
      runtime.close();
      await closed;
    });
    await vi.waitFor(() =>
      expect(runtime.status().startupRecovery).toBe("settled"),
    );
    expect(opened.mock.calls.length).toBe(1);
    expect(listener.mock.calls.length).toBe(1);
    const options = listener.mock.calls[0]![0];
    const original: unknown = Reflect.get(runtime, "maintenance");
    expect(original !== null && typeof original === "object").toBe(true);
    expect(Object.isFrozen(original)).toBe(true);
    expect(
      Reflect.get(options, "maintenance") === original,
      "listener receives the original runtime maintenance owner",
    ).toBe(true);
    expect(options.store === storage.store).toBe(true);
    expect(options.ready?.() === false).toBe(true);
    expect(host.mock.calls.length).toBe(0);
    expect(journal.mock.calls.length).toBe(0);
  },
  15_000,
);
