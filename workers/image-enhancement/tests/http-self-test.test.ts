import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startWindowsWorker } from "../src/bootstrap.js";
import {
  EnhancementError,
  type EnhancementErrorCode,
  type FixedSelfTestSnapshot,
} from "../src/contracts.js";
import { revokeCredential } from "../src/credentials.js";
import * as httpModule from "../src/http.js";
import * as storeModule from "../src/store.js";
import type { AuthenticatedClient } from "../src/store.js";
import * as hostModule from "../src/windows-control-bridge-host.js";
import * as journalModule from "../src/windows-journal-launcher.js";
import { configInput } from "./fixtures.js";
import {
  boundary,
  deferred,
  httpFixture,
  multipart,
  transportLimits,
  type HttpResult,
} from "./http-fixtures.js";
import {
  runnerLimits,
  storageFixture,
  submissionLimits,
} from "./storage-fixtures.js";
import { runnerAdapterOptions } from "./windows-execution-adapter-runner-fixtures.js";

type SelfTest = Readonly<{
  start(principal: AuthenticatedClient): Promise<FixedSelfTestSnapshot>;
  query(principal: AuthenticatedClient): Promise<FixedSelfTestSnapshot>;
}>;

const routes = [
  { method: "POST", operation: "start", status: 202 },
  { method: "GET", operation: "query", status: 200 },
] as const;
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function snapshot(
  phase: "bound" | "output_verified" = "bound",
): FixedSelfTestSnapshot {
  return Object.freeze({
    bootId: "11111111-1111-4111-8111-111111111111",
    assetId: "zeb-enhancement-calibration-v1",
    phase,
    jobId: "22222222-2222-4222-8222-222222222222",
    reason: phase === "output_verified" ? "device_observation_required" : null,
    output:
      phase === "output_verified"
        ? Object.freeze({
            format: "png" as const,
            width: 5016,
            height: 5016,
            byteLength: 1234,
            sha256: "a".repeat(64),
          })
        : null,
    qualification: "unknown",
  });
}

function callbacks() {
  return Object.freeze({
    start: vi.fn<SelfTest["start"]>().mockResolvedValue(snapshot()),
    query: vi
      .fn<SelfTest["query"]>()
      .mockResolvedValue(snapshot("output_verified")),
  });
}

async function fixture(selfTest?: SelfTest) {
  const onJobCommitted = vi.fn();
  const options: NonNullable<Parameters<typeof httpFixture>[0]> = {
    ready: undefined,
    onJobCommitted,
  };
  // The current handler must load before the optional HTTP member exists.
  if (selfTest) Reflect.set(options, "selfTest", selfTest);
  const f = await httpFixture(options);
  cleanups.push(() => f.cleanup());
  const business = {
    lookup: vi.spyOn(f.storage.store, "findByKey"),
    query: vi.spyOn(f.storage.store, "getOwned"),
    claim: vi.spyOn(f.storage.store, "claimNext"),
    inspection: vi.spyOn(f.storage.store, "inspectQueuedSelfTest"),
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
      "response contains no private value",
    ).toBe(false);
  expect(
    /"(?:authorization|credential|credentialId|key_digest|key|launchTicket|attemptId|attemptNo|ownerInstanceId|operatorClientId|selfTestModelId|binaryPath|modelPath|recordsRoot|installationRoot|windowsIdentity|inputBytes|outputBytes|bytes|stack|ready)"\s*:|Bearer /i.test(
      result.raw,
    ),
    "response contains only the public operation or error shape",
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
  expect(
    typeof requestId === "string",
    "error requestId has the expected type",
  ).toBe(true);
  expect(
    isDeepStrictEqual(result.body, {
      code,
      data: { requestId },
      msg: new EnhancementError(code).message,
    }),
    "error retains the exact sanitized envelope",
  ).toBe(true);
}

async function expectNoHttpBusiness(f: HttpFixture) {
  for (const spy of Object.values(f.business))
    expect(spy.mock.calls.length).toBe(0);
  expect(f.onJobCommitted.mock.calls.length).toBe(0);
  expect(await f.inputNames()).toEqual([]);
}

function unreadBytes(f: HttpFixture) {
  let bytes = 0;
  const read = (req: IncomingMessage) => {
    const original = req.read.bind(req);
    req.read = (size?: number) => {
      const value = original(size);
      if (value !== null) bytes += Buffer.byteLength(value);
      return value;
    };
  };
  f.server.prependListener("request", read);
  f.server.prependListener("checkContinue", read);
  f.server.prependListener("checkExpectation", read);
  return () => bytes;
}

async function enteredBeforeResponse<T>(
  entered: Promise<T>,
  response: Promise<HttpResult>,
) {
  const outcome = await Promise.race([
    entered.then((value) => ({ entered: true as const, value })),
    response.then((result) => ({
      entered: false as const,
      status: result.status,
    })),
  ]);
  if (outcome.entered) return outcome.value;
  return expect.fail(
    `self-test route returned ${outcome.status} before entering its selected callback`,
  );
}

describe("fixed self-test HTTP thin wiring", () => {
  it.each(
    routes.flatMap((route) =>
      [false, true].map((zeroLength) => ({ ...route, zeroLength })),
    ),
  )(
    "$method awaits only $operation with zeroLength=$zeroLength and returns the exact safe snapshot",
    async ({ method, operation, status, zeroLength }) => {
      const selfTest = callbacks();
      const entered = deferred<AuthenticatedClient>();
      const returned = deferred<FixedSelfTestSnapshot>();
      const expected = snapshot(
        operation === "query" ? "output_verified" : "bound",
      );
      selfTest[operation].mockImplementation((principal) => {
        entered.resolve(principal);
        return returned.promise;
      });
      const f = await fixture(selfTest);
      cleanups.push(() => returned.resolve(expected));
      const authentication = vi.spyOn(f.storage.store, "authenticateDigest");
      const assertion = vi.spyOn(f.storage.store, "assertPrincipal");
      const connection = f.start(method, "/v1/self-test", {
        authorization: f.auth(),
        ...(zeroLength ? { "content-length": 0 } : {}),
      });
      let responded = false;
      let cache: unknown;
      connection.req.once("response", (response) => {
        responded = true;
        cache = response.headers["cache-control"];
      });
      connection.req.end();
      const principal = await enteredBeforeResponse(
        entered.promise,
        connection.result,
      );
      expect(authentication).toHaveBeenCalledTimes(1);
      expect(
        principal === authentication.mock.results[0]!.value,
        "callback receives the original authenticated principal",
      ).toBe(true);
      expect(
        isDeepStrictEqual(selfTest[operation].mock.calls, [[principal]]),
        "selected callback receives only the principal",
      ).toBe(true);
      expect(responded).toBe(false);
      const checksBeforeReturn = assertion.mock.calls.length;
      returned.resolve(expected);
      const result = await connection.result;
      expect(result.status).toBe(status);
      expectSafe(result, f);
      expect(
        isDeepStrictEqual(result.body, {
          code: "ok",
          data: expected,
          msg: "成功。",
        }),
        "success retains the exact safe snapshot envelope",
      ).toBe(true);
      expect(cache === "no-store", "response disables caching").toBe(true);
      expect(assertion.mock.calls.length).toBeGreaterThan(checksBeforeReturn);
      expect(
        isDeepStrictEqual(assertion.mock.calls.at(-1), [principal]),
        "the final Store assertion receives the same principal",
      ).toBe(true);
      expect(
        selfTest[operation === "start" ? "query" : "start"].mock.calls.length,
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
        "ordinary capabilities stay unavailable",
      ).toBe(true);
      await expectNoHttpBusiness(f);
    },
  );

  it.each(routes)(
    "keeps $method inaccessible when callbacks were not installed",
    async ({ method }) => {
      const f = await fixture();
      expectError(
        await f.call(method, "/v1/self-test", undefined, {}),
        401,
        "authentication_failed",
        f,
      );
      expectError(
        await f.call(method, "/v1/self-test"),
        404,
        "route_not_found",
        f,
      );
      await expectNoHttpBusiness(f);
    },
  );

  it.each(["missing", "malformed", "wrong", "revoked", "duplicate"] as const)(
    "rejects %s authentication before route, method, body and callbacks",
    async (kind) => {
      const selfTest = callbacks();
      const f = await fixture(selfTest);
      const consumed = unreadBytes(f);
      if (kind === "revoked")
        revokeCredential(
          f.storage.store,
          f.storage.initialized.credential.credentialId,
        );
      const wrong = Buffer.alloc(32, 0xa5).toString("base64url");
      const headers =
        kind === "missing"
          ? {}
          : kind === "duplicate"
            ? ["Authorization", f.auth(), "authorization", f.auth()]
            : {
                authorization:
                  kind === "malformed"
                    ? "Basic synthetic-invalid"
                    : kind === "wrong"
                      ? `Bearer ${wrong}`
                      : f.auth(),
              };
      for (const [method, path] of [
        ["POST", "/v1/self-test"],
        ["GET", "/v1/self-test"],
        ["PATCH", "/v1/self-test?ready=true"],
        ["GET", "/v1/self-test/unknown"],
      ])
        expectError(
          await f.call(
            method!,
            path!,
            Buffer.from("synthetic-private-unread-body"),
            headers,
          ),
          401,
          "authentication_failed",
          f,
          [wrong, "synthetic-private-unread-body"],
        );
      expect(selfTest.start.mock.calls.length).toBe(0);
      expect(selfTest.query.mock.calls.length).toBe(0);
      expect(consumed()).toBe(0);
      await expectNoHttpBusiness(f);
    },
  );

  it.each(["PATCH", "PUT", "DELETE", "OPTIONS"])(
    "rejects authenticated %s with the existing method error and no callback",
    async (method) => {
      const selfTest = callbacks();
      const f = await fixture(selfTest);
      expectError(
        await f.call(method, "/v1/self-test"),
        405,
        "method_not_allowed",
        f,
      );
      expect(selfTest.start.mock.calls.length).toBe(0);
      expect(selfTest.query.mock.calls.length).toBe(0);
      await expectNoHttpBusiness(f);
    },
  );

  it.each([
    "query selectors",
    "empty query",
    "JSON body",
    "multipart body",
    "chunked",
    "unfinished length",
  ] as const)(
    "rejects %s on both operations without consuming input or invoking callbacks",
    async (kind) => {
      const selfTest = callbacks();
      const f = await fixture(selfTest);
      const consumed = unreadBytes(f);
      const selectors = JSON.stringify({
        path: "C:\\synthetic-private\\image.png",
        material: "synthetic-private-material",
        modelId: "caller-model",
        gpuId: 7,
        tile: 128,
        jobId: "caller-job",
        key: "caller-key",
        ready: true,
        qualification: "qualified",
      });
      for (const { method } of routes) {
        const path =
          "/v1/self-test" +
          (kind === "query selectors"
            ? "?path=C%3A%5Csynthetic-private%5Cimage.png&material=synthetic-private-material&modelId=caller-model&gpuId=7&tile=128&jobId=caller-job&key=caller-key&ready=true&qualification=qualified"
            : kind === "empty query"
              ? "?"
              : "");
        let result: HttpResult;
        if (kind === "unfinished length") {
          const connection = f.start(method, path, {
            authorization: f.auth(),
            "content-length": 1,
          });
          connection.req.flushHeaders();
          result = await connection.result;
          connection.req.destroy();
        } else {
          const body =
            kind === "JSON body"
              ? Buffer.from(selectors)
              : kind === "multipart body"
                ? multipart([
                    { name: "plan", bytes: Buffer.from(selectors) },
                    {
                      name: "image",
                      filename: "image.png",
                      bytes: Buffer.from("synthetic-private-material"),
                    },
                  ])
                : undefined;
          result = await f.call(method, path, body, {
            authorization: f.auth(),
            ...(kind === "JSON body"
              ? { "content-type": "application/json" }
              : kind === "multipart body"
                ? {
                    "content-type": `multipart/form-data; boundary=${boundary}`,
                  }
                : {}),
            ...(kind === "chunked" ? { "transfer-encoding": "chunked" } : {}),
          });
        }
        expectError(result, 400, "invalid_request", f, [
          "synthetic-private-material",
          "C:\\synthetic-private\\image.png",
          "caller-key",
        ]);
      }
      expect(selfTest.start.mock.calls.length).toBe(0);
      expect(selfTest.query.mock.calls.length).toBe(0);
      expect(consumed()).toBe(0);
      await expectNoHttpBusiness(f);
    },
  );

  it.each([false, true])(
    "rejects Expect bodies with authenticated=%s before 100 Continue on both operations",
    async (authenticated) => {
      const selfTest = callbacks();
      const f = await fixture(selfTest);
      const consumed = unreadBytes(f);
      for (const { method } of routes) {
        const connection = f.start(method, "/v1/self-test", {
          ...(authenticated ? { authorization: f.auth() } : {}),
          expect: "100-continue",
          "content-length": 1,
        });
        let continued = 0;
        let close: unknown;
        connection.req.on("continue", () => {
          continued++;
          connection.req.end("x");
        });
        connection.req.once("response", (response) => {
          close = response.headers.connection;
        });
        connection.req.flushHeaders();
        const result = await connection.result;
        connection.req.destroy();
        expectError(
          result,
          authenticated ? 400 : 401,
          authenticated ? "invalid_request" : "authentication_failed",
          f,
        );
        expect(continued).toBe(0);
        expect(close === "close", "unread input closes the connection").toBe(
          true,
        );
      }
      expect(selfTest.start.mock.calls.length).toBe(0);
      expect(selfTest.query.mock.calls.length).toBe(0);
      expect(consumed()).toBe(0);
      await expectNoHttpBusiness(f);
    },
  );

  it.each(
    routes.flatMap((route) =>
      ["known", "unknown"].map((kind) => ({ ...route, kind })),
    ),
  )(
    "sanitizes a $kind callback failure from $method without exposing its message",
    async ({ method, operation, kind }) => {
      const selfTest = callbacks();
      const f = await fixture(selfTest);
      const privateMessage =
        `synthetic-private-callback C:\\private\\ticket attempt WindowsIdentity ` +
        f.storage.initialized.credential.key;
      const failure =
        kind === "known"
          ? new EnhancementError("invalid_output")
          : new Error(privateMessage);
      failure.message = privateMessage;
      selfTest[operation].mockRejectedValue(failure);
      const connection = f.start(method, "/v1/self-test", {
        authorization: f.auth(),
        "content-length": 0,
      });
      let cache: unknown;
      connection.req.once("response", (response) => {
        cache = response.headers["cache-control"];
      });
      connection.req.end();
      const result = await connection.result;
      expectError(
        result,
        kind === "known" ? 422 : 503,
        kind === "known" ? "invalid_output" : "internal_error",
        f,
        [privateMessage, "synthetic-private-callback", "C:\\private\\ticket"],
      );
      expect(selfTest[operation]).toHaveBeenCalledTimes(1);
      expect(cache === "no-store", "response disables caching").toBe(true);
      expect(
        selfTest[operation === "start" ? "query" : "start"].mock.calls.length,
      ).toBe(0);
      await expectNoHttpBusiness(f);
    },
  );

  it.each(
    routes.flatMap((route) =>
      ["revoke", "close"].map((fault) => ({ ...route, fault })),
    ),
  )(
    "$method rechecks the real Store after await when $fault invalidates the caller",
    async ({ method, operation, fault }) => {
      const selfTest = callbacks();
      const entered = deferred<AuthenticatedClient>();
      const returned = deferred<FixedSelfTestSnapshot>();
      const late = snapshot("output_verified");
      selfTest[operation].mockImplementation((principal) => {
        entered.resolve(principal);
        return returned.promise;
      });
      const f = await fixture(selfTest);
      cleanups.push(() => returned.resolve(late));
      const connection = f.start(method, "/v1/self-test", {
        authorization: f.auth(),
        "content-length": 0,
      });
      let cache: unknown;
      connection.req.once("response", (response) => {
        cache = response.headers["cache-control"];
      });
      connection.req.end();
      await enteredBeforeResponse(entered.promise, connection.result);
      if (fault === "revoke")
        revokeCredential(
          f.storage.store,
          f.storage.initialized.credential.credentialId,
        );
      else f.storage.store.close();
      returned.resolve(late);
      const result = await connection.result;
      expectError(
        result,
        fault === "revoke" ? 401 : 503,
        fault === "revoke" ? "authentication_failed" : "internal_error",
        f,
        [late.bootId, late.jobId!, late.output!.sha256],
      );
      expect(selfTest[operation]).toHaveBeenCalledTimes(1);
      expect(cache === "no-store", "response disables caching").toBe(true);
      await expectNoHttpBusiness(f);
    },
  );

  it("leaves an accepted callback alive after disconnect and forwards explicit joins and retries without new HTTP work", async () => {
    const selfTest = callbacks();
    const entered = [
      deferred<AuthenticatedClient>(),
      deferred<AuthenticatedClient>(),
    ];
    const returned = deferred<FixedSelfTestSnapshot>();
    const originalFinished = deferred();
    const expected = snapshot();
    let completed = 0;
    let calls = 0;
    selfTest.start.mockImplementation(async (principal) => {
      const call = calls++;
      entered[call]?.resolve(principal);
      const value = await returned.promise;
      completed++;
      if (call === 0) originalFinished.resolve();
      return value;
    });
    const f = await fixture(selfTest);
    cleanups.push(() => returned.resolve(expected));
    const first = f.start("POST", "/v1/self-test", {
      authorization: f.auth(),
      "content-length": 0,
    });
    first.req.end();
    await enteredBeforeResponse(entered[0]!.promise, first.result);
    const disconnected = new Promise<void>((resolve) =>
      first.req.once("close", resolve),
    );
    first.req.destroy();
    await disconnected;
    const joined = f.start("POST", "/v1/self-test", {
      authorization: f.auth(),
      "content-length": 0,
    });
    joined.req.end();
    await enteredBeforeResponse(entered[1]!.promise, joined.result);
    expect(selfTest.start).toHaveBeenCalledTimes(2);
    expect(completed).toBe(0);
    returned.resolve(expected);
    const result = await joined.result;
    await originalFinished.promise;
    expect(result.status).toBe(202);
    expectSafe(result, f);
    expect(
      isDeepStrictEqual(result.body?.data, expected),
      "the joined request returns the same safe operation snapshot",
    ).toBe(true);
    expect(completed).toBe(2);
    const retried = await f.call("POST", "/v1/self-test");
    expect(retried.status).toBe(202);
    expectSafe(retried, f);
    expect(
      isDeepStrictEqual(retried.body?.data, expected),
      "the explicit retry returns the same safe operation snapshot",
    ).toBe(true);
    expect(selfTest.start).toHaveBeenCalledTimes(3);
    for (const args of selfTest.start.mock.calls) {
      expect(args.length).toBe(1);
      expect(() => f.storage.store.assertPrincipal(args[0])).not.toThrow();
    }
    expect(selfTest.query.mock.calls.length).toBe(0);
    await expectNoHttpBusiness(f);
  });
});

it.skipIf(process.platform !== "win32")(
  "bootstrap gives its existing listener the very same selfTest object returned by the runtime",
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
    expect(opened).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    const options = listener.mock.calls[0]![0];
    const original: unknown = Reflect.get(runtime, "selfTest");
    expect(original !== null && typeof original === "object").toBe(true);
    expect(Reflect.get(options, "selfTest")).toBe(original);
    expect(options.store).toBe(storage.store);
    expect(options.ready?.()).toBe(false);
    expect(host).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();
  },
  15_000,
);
