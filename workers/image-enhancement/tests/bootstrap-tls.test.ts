import assert from "node:assert/strict";
import * as filesModule from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { createSecureContext, type TLSSocket } from "node:tls";
import { isDeepStrictEqual } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startWindowsWorker } from "../src/bootstrap.js";
import { createWorkerConfig } from "../src/config.js";
import {
  EnhancementError,
  type EnhancementErrorCode,
} from "../src/contracts.js";
import { authenticate } from "../src/credentials.js";
import * as httpModule from "../src/http.js";
import type { HttpFileIoOwner } from "../src/http.js";
import * as tlsModule from "../src/https.js";
import * as runnerModule from "../src/runner.js";
import * as storeModule from "../src/store.js";
import type { createWindowsControlBridgeHost } from "../src/windows-control-bridge-host.js";
import * as adapterModule from "../src/windows-execution-adapter.js";
import type { createWindowsJournalLauncher } from "../src/windows-journal-launcher.js";
import { configInput } from "./fixtures.js";
import { tlsTestCertificates } from "./fixtures/tls-certificates.js";
import { deferred, transportLimits } from "./http-fixtures.js";
import {
  runnerLimits,
  sha256,
  storageFixture,
  submissionLimits,
} from "./storage-fixtures.js";
import {
  runnerAdapterOptions,
  runnerNativePorts,
} from "./windows-execution-adapter-runner-fixtures.js";

const factories = vi.hoisted(() => ({
  host: vi.fn<typeof createWindowsControlBridgeHost>(),
  journal: vi.fn<typeof createWindowsJournalLauncher>(),
}));
vi.mock("../src/windows-control-bridge-host.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/windows-control-bridge-host.js")
  >()),
  createWindowsControlBridgeHost: factories.host,
}));
vi.mock("../src/windows-journal-launcher.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/windows-journal-launcher.js")
  >()),
  createWindowsJournalLauncher: factories.journal,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// Public synthetic test material only. Root exported the original localhost
// fixture with EphemeralKeySet; never use this PFX or password in deployment.
const testPassword = "zeb-public-test-only-pfx-password-v1";
const encryptedPkcs12 = Buffer.from(
  "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",
  "base64",
);

type Runtime = Awaited<ReturnType<typeof startWindowsWorker>>;
type Storage = Awaited<ReturnType<typeof storageFixture>>;
const appDirectory = "Z:\\contract-only\\payload\\app";
const originalHttpListen = httpModule.listenEnhancementServer;
const originalTlsListen = tlsModule.listenEnhancementTlsServer;
const originalOpen = storeModule.openStore;
const originalRunner = runnerModule.createRunner;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(filesModule.readFile)
    .mockReset()
    .mockImplementation(actual.readFile);
  factories.host.mockReset();
  factories.journal.mockReset();
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function configuration(storage: Storage) {
  return {
    storeDirectory: storage.directory,
    port: 0,
    operatorClientId: storage.initialized.credential.clientId,
    selfTestModelId: "standard-4x",
    workerConfig: configInput(),
    submissionLimits,
    runnerLimits,
    transportLimits,
    execution: {
      installationRoot: runnerAdapterOptions.bridge.installationRoot,
      recordsRoot: runnerAdapterOptions.bridge.recordsRoot,
      expectedManifestSha256:
        runnerAdapterOptions.bridge.expectedManifestSha256,
      bridgeLimits: runnerAdapterOptions.bridge.limits,
      journalLimits: runnerAdapterOptions.journalLimits,
    },
  };
}

function trackServer(server: Server) {
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error ? reject(new Error("test listener cleanup failed")) : resolve(),
        ),
      );
  });
}

function trackStart(pending: Promise<Runtime>) {
  void pending.then(
    (runtime) => {
      cleanups.push(() => runtime.close());
    },
    () => {},
  );
  return pending;
}

async function started(pending: Promise<Runtime>): Promise<Runtime> {
  const result = await pending.then(
    (runtime) => ({ runtime }),
    () => ({ runtime: null }),
  );
  expect(
    result.runtime !== null,
    "it target accepts the TLS configuration",
  ).toBe(true);
  if (!result.runtime) throw new Error("TLS runtime was not returned");
  return result.runtime;
}

async function rejected(
  pending: Promise<Runtime>,
  code: EnhancementErrorCode,
  privatePath?: string,
) {
  const result = await pending.then(
    () => ({ failed: false as const }),
    (error: unknown) => ({ failed: true as const, error }),
  );
  expect(result.failed, "target rejects without returning a runtime").toBe(
    true,
  );
  if (!result.failed) return;
  const expected = new EnhancementError(code);
  expect(result.error instanceof EnhancementError, "sanitized error type").toBe(
    true,
  );
  if (!(result.error instanceof EnhancementError)) return;
  expect(
    isDeepStrictEqual(
      Reflect.ownKeys(result.error).sort(),
      Reflect.ownKeys(expected).sort(),
    ),
    "no attached private exception or configuration fields",
  ).toBe(true);
  expect(
    result.error.code === code &&
      result.error.status === expected.status &&
      result.error.message === expected.message,
    "exact safe code, status and message",
  ).toBe(true);
  const stack = String(result.error.stack ?? "");
  expect(
    stack.split("\n", 1)[0] === expected.stack?.split("\n", 1)[0] &&
      !stack.includes(testPassword) &&
      !stack.includes("synthetic-private-read") &&
      (!privatePath || !stack.includes(privatePath)),
    "safe error stack without the original material fault",
  ).toBe(true);
}

async function reached(
  boundary: Promise<unknown>,
  pending: Promise<Runtime>,
  label: string,
) {
  const actual = await Promise.race([
    boundary.then(() => true),
    pending.then(
      () => false,
      () => false,
    ),
  ]);
  expect(actual, label).toBe(true);
}

function portOf(server: Server) {
  const address = server.address();
  assert.ok(address && typeof address !== "string", "listener has a TCP port");
  return address.port;
}

function get(server: Server, authorization: string, secure = true) {
  const send = secure ? httpsRequest : httpRequest;
  return new Promise<{
    status: number;
    raw: string;
    body: unknown;
    authorized: boolean;
  }>((resolve, reject) => {
    const req = send(
      {
        hostname: "127.0.0.1",
        port: portOf(server),
        path: "/v1/capabilities",
        method: "GET",
        headers: { authorization },
        agent: false,
        ...(secure
          ? {
              ca: tlsTestCertificates.localhost.ca,
              servername: "localhost",
              rejectUnauthorized: true,
            }
          : {}),
      },
      (response) => {
        const authorized = (response.socket as TLSSocket).authorized === true;
        const chunks: Buffer[] = [];
        response.on("data", (bytes: Buffer) => chunks.push(bytes));
        response.once("error", () => reject(new Error("test response failed")));
        response.once("aborted", () =>
          reject(new Error("test response aborted")),
        );
        response.once("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: response.statusCode!,
              raw,
              body: JSON.parse(raw) as unknown,
              authorized,
            });
          } catch {
            reject(new Error("test response is not JSON"));
          }
        });
      },
    );
    req.once("error", () => reject(new Error("test transport request failed")));
    req.end();
  });
}

async function harness(
  bytes: Buffer | null = tlsTestCertificates.localhost.pfx,
) {
  const storage = await storageFixture();
  storage.setNow(Date.now());
  const serviceId = storage.store.identity.serviceId;
  // Preserve each unique Store and its synthetic PFX as evidence; close handles.
  cleanups.push(() => storage.store.close());
  const pfxPath = join(storage.directory, "synthetic-bootstrap-test-only.pfx");
  if (bytes !== null)
    await filesModule.writeFile(pfxPath, bytes, { flag: "wx" });
  storage.store.close();
  const actualFiles =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const native = runnerNativePorts();
  factories.host.mockReturnValue(native.host);
  factories.journal.mockImplementation(() => native.journal().reader);
  cleanups.push(() => native.release());
  const hooks: {
    rejectRead?: Error;
    afterRead?: () => void | Promise<void>;
    afterListen?: (server: Server) => void | Promise<void>;
  } = {};
  const readSignals: unknown[] = [];
  const read = vi.mocked(filesModule.readFile);
  read.mockImplementation(async (...args) => {
    if (args[0] === pfxPath) {
      const options = args[1];
      readSignals.push(
        options && typeof options === "object" ? options.signal : undefined,
      );
      if (hooks.rejectRead) throw hooks.rejectRead;
      const result = await actualFiles.readFile(...args);
      await hooks.afterRead?.();
      return result;
    }
    return actualFiles.readFile(...args);
  });
  const open = vi
    .spyOn(storeModule, "openStore")
    .mockImplementation((options) => {
      const opened = originalOpen(options);
      storage.setStore(opened);
      return opened;
    });
  const initialize = vi.spyOn(storeModule, "initializeStore");
  const adapter = vi.spyOn(adapterModule, "createWindowsExecutionAdapter");
  const recoveries: Promise<void>[] = [];
  const wake = vi.fn();
  const runner = vi
    .spyOn(runnerModule, "createRunner")
    .mockImplementation((options) => {
      const actual = originalRunner(options);
      return Object.freeze({
        ...actual,
        recover() {
          const pending = actual.recover();
          recoveries.push(pending);
          return pending;
        },
        wake() {
          wake();
          return actual.wake();
        },
      });
    });
  const http = vi
    .spyOn(httpModule, "listenEnhancementServer")
    .mockImplementation(async (...args) => {
      const actual = await originalHttpListen(...args);
      trackServer(actual);
      return actual;
    });
  const tlsServers: Server[] = [];
  const tlsOwners: unknown[] = [];
  const tls = vi
    .spyOn(tlsModule, "listenEnhancementTlsServer")
    .mockImplementation(async (...args) => {
      const actual = await originalTlsListen(...args);
      trackServer(actual);
      tlsServers.push(actual);
      tlsOwners.push(Reflect.get(actual, "fileIo"));
      await hooks.afterListen?.(actual);
      return actual;
    });
  const diagnostics: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args) =>
    diagnostics.push(args),
  );
  return {
    storage,
    serviceId,
    pfxPath,
    actualFiles,
    hooks,
    read,
    readSignals,
    open,
    initialize,
    adapter,
    runner,
    recoveries,
    wake,
    http,
    tls,
    tlsServers,
    tlsOwners,
    diagnostics,
    base: () => configuration(storage),
    configured: () => ({
      ...configuration(storage),
      tls: { host: "127.0.0.1", pfxPath },
    }),
    options: (signal = new AbortController().signal) => ({
      appDirectory,
      signal,
    }),
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

function noResources(h: Harness) {
  expect(h.read.mock.calls.length).toBe(0);
  expect(h.open.mock.calls.length).toBe(0);
  expect(h.adapter.mock.calls.length).toBe(0);
  expect(h.runner.mock.calls.length).toBe(0);
  expect(h.http.mock.calls.length).toBe(0);
  expect(h.tls.mock.calls.length).toBe(0);
  expect(h.initialize.mock.calls.length).toBe(0);
  expect(factories.host.mock.calls.length).toBe(0);
  expect(factories.journal.mock.calls.length).toBe(0);
  expect(h.diagnostics.length).toBe(0);
}

function safePublic(text: string, h: Harness) {
  const forbidden = [
    h.storage.directory,
    h.pfxPath,
    h.storage.initialized.credential.key,
    tlsTestCertificates.localhost.pfx.toString("base64"),
    encryptedPkcs12.toString("base64"),
    testPassword,
  ];
  expect(
    forbidden.some((value) => text.includes(value)),
    "no private material",
  ).toBe(false);
}

function preserved(h: Harness) {
  const reopened = originalOpen({
    directory: h.storage.directory,
    clock: Date.now,
  });
  try {
    const principal = authenticate(
      reopened,
      `Bearer ${h.storage.initialized.credential.key}`,
    );
    expect(reopened.identity.serviceId === h.serviceId).toBe(true);
    expect(
      principal.clientId === h.storage.initialized.credential.clientId,
    ).toBe(true);
    expect(
      isDeepStrictEqual(reopened.inspectMaintenance(), {
        queued: 0,
        running: 0,
        slots: 0,
        unreleasedReferences: 0,
      }),
      "original empty Store facts remain",
    ).toBe(true);
  } finally {
    reopened.close();
  }
}

async function independentListener() {
  const storage = await storageFixture();
  cleanups.push(() => storage.store.close());
  const config = createWorkerConfig(configInput());
  const server = await originalTlsListen(
    {
      store: storage.store,
      config: () => config,
      ready: () => false,
      submissionLimits,
      runnerLimits,
      transportLimits,
    },
    0,
    { host: "127.0.0.1", pfx: tlsTestCertificates.localhost.pfx },
  );
  trackServer(server);
  return {
    server,
    authorization: `Bearer ${storage.initialized.credential.key}`,
  };
}

// Use the actual Windows test account, filesystem and TCP stack. Only the
// existing Host/Journal module ports and explicit fault/barrier seams are held.
describe.skipIf(process.platform !== "win32")("bootstrap TLS assembly", () => {
  it("rejects strict TLS shapes, hosts and paths before any resource or getter", async () => {
    const h = await harness();
    const getter = vi.fn(() => ({ host: "127.0.0.1", pfxPath: h.pfxPath }));
    const proxyTrap = vi.fn();
    const proxy = new Proxy(
      { host: "127.0.0.1", pfxPath: h.pfxPath },
      {
        get() {
          proxyTrap();
          return undefined;
        },
        getPrototypeOf() {
          proxyTrap();
          return Object.prototype;
        },
        ownKeys() {
          proxyTrap();
          return [];
        },
        getOwnPropertyDescriptor() {
          proxyTrap();
          return undefined;
        },
      },
    );
    const bad: unknown[] = [
      undefined,
      null,
      false,
      [],
      proxy,
      Object.assign(Object.create({ inherited: true }), h.configured().tls),
      { pfxPath: h.pfxPath },
      { host: "127.0.0.1" },
      { ...h.configured().tls, passphrase: testPassword },
      { ...h.configured().tls, pfx: tlsTestCertificates.localhost.pfx },
      { ...h.configured().tls, ca: tlsTestCertificates.localhost.ca },
      ...[
        "",
        "localhost",
        "https://127.0.0.1",
        "127.0.0.1:443",
        "[::1]",
        127,
      ].map((host) => ({ host, pfxPath: h.pfxPath })),
      ...[
        "relative.pfx",
        "C:relative.pfx",
        "\\\\server\\share\\test.pfx",
        "C:\\bad\u0000.pfx",
        "C:\\bad\ud800.pfx",
        1,
      ].map((pfxPath) => ({ host: "127.0.0.1", pfxPath })),
    ];
    for (const key of ["host", "pfxPath"]) {
      const value = { ...h.configured().tls };
      Object.defineProperty(value, key, { enumerable: true, get: getter });
      bad.push(value);
    }
    const inputs: unknown[] = bad.map((tls) => ({ ...h.base(), tls }));
    const topAccessor = h.base();
    Object.defineProperty(topAccessor, "tls", {
      enumerable: true,
      get: getter,
    });
    inputs.push(topAccessor);
    for (const input of inputs)
      await rejected(
        trackStart(startWindowsWorker(input, h.options())),
        "configuration_invalid",
      );
    expect(getter.mock.calls.length).toBe(0);
    expect(proxyTrap.mock.calls.length).toBe(0);
    noResources(h);
  });

  it("keeps omitted TLS on the original loopback-only programmatic path", async () => {
    const h = await harness();
    const runtime = await started(
      trackStart(startWindowsWorker(h.base(), h.options())),
    );
    const response = await get(
      runtime.server,
      `Bearer ${h.storage.initialized.credential.key}`,
      false,
    );
    expect(response.status).toBe(200);
    expect(
      runtime.server.address() &&
        typeof runtime.server.address() === "object" &&
        (runtime.server.address() as { address: string }).address ===
          "127.0.0.1",
    ).toBe(true);
    expect(h.http.mock.calls.length).toBe(1);
    expect(h.tls.mock.calls.length).toBe(0);
    expect(h.read.mock.calls.length).toBe(0);
    safePublic(response.raw, h);
  }, 15_000);

  it("starts one trusted TLS listener with the original Store, owner and maintenance closure", async () => {
    const h = await harness();
    const before = h.configured();
    const saved = JSON.stringify(before);
    // This future configuration is first consumed by the target inside this it.
    const runtime = await started(
      trackStart(startWindowsWorker(before, h.options())),
    );
    expect(h.read.mock.calls.length).toBe(1);
    expect(h.tls.mock.calls.length).toBe(1);
    expect(h.http.mock.calls.length).toBe(0);
    expect(h.open.mock.calls.length).toBe(1);
    expect(h.adapter.mock.calls.length).toBe(1);
    expect(h.runner.mock.calls.length).toBe(1);
    expect(h.initialize.mock.calls.length).toBe(0);
    expect(runtime.server === h.tlsServers[0]).toBe(true);
    expect(h.recoveries.length).toBe(1);
    await h.recoveries[0];
    const options = h.tls.mock.calls[0]![0];
    expect(
      options.store === h.storage.store &&
        options.selfTest === runtime.selfTest,
    ).toBe(true);
    expect(options.ready?.() === false).toBe(true);
    const transport = h.tls.mock.calls[0]![2];
    expect(
      transport.host === before.tls.host &&
        transport.pfx.equals(tlsTestCertificates.localhost.pfx),
    ).toBe(true);
    const response = await get(
      runtime.server,
      `Bearer ${h.storage.initialized.credential.key}`,
    );
    expect(response.status === 200 && response.authorized).toBe(true);
    const expected = {
      serviceId: h.serviceId,
      protocolVersion: h.base().workerConfig.protocolVersion,
      normalizationProfile: h.base().workerConfig.normalizationProfile,
      models: createWorkerConfig(configInput()).models,
      budgets: createWorkerConfig(configInput()).budgets,
      ready: false,
      reason: "runner_unavailable",
    };
    expect(response.body !== null && typeof response.body === "object").toBe(
      true,
    );
    expect(
      isDeepStrictEqual(Reflect.get(response.body as object, "data"), expected),
      "exact safe capability data",
    ).toBe(true);
    expect(
      isDeepStrictEqual(Reflect.ownKeys(runtime).sort(), [
        "close",
        "maintenance",
        "selfTest",
        "server",
        "shutdown",
        "status",
      ]),
    ).toBe(true);
    const owner = Reflect.get(runtime.server, "fileIo") as HttpFileIoOwner;
    expect(
      owner === h.tlsOwners[0] && typeof owner?.activity === "function",
    ).toBe(true);
    expect(owner.activity().sealed === false).toBe(true);
    const observation = runtime.maintenance.enter(h.storage.principal());
    expect(
      observation.sealed &&
        observation.state === "quiescent" &&
        observation.canStop,
    ).toBe(true);
    expect(owner.activity().sealed === true).toBe(true);
    expect(h.wake.mock.calls.length).toBe(0);
    expect(factories.host.mock.calls.length).toBe(0);
    expect(factories.journal.mock.calls.length).toBe(0);
    expect(JSON.stringify(before) === saved).toBe(true);
    const status = runtime.status();
    expect(
      isDeepStrictEqual(
        [
          Reflect.ownKeys(status).sort(),
          Reflect.ownKeys(status.runner).sort(),
          Reflect.ownKeys(status.adapter).sort(),
        ],
        [
          ["adapter", "closing", "runner", "startupRecovery"],
          [
            "closed",
            "ownedState",
            "recoveryInFlight",
            "recoveryState",
            "storeClosed",
          ],
          ["activity", "close", "sealed"],
        ],
      ),
      "original exact status shapes",
    ).toBe(true);
    safePublic(response.raw, h);
    safePublic(JSON.stringify(status), h);
    safePublic(JSON.stringify(observation), h);
    safePublic(JSON.stringify(h.diagnostics), h);
  }, 15_000);

  it.each(["missing", "controlled-EACCES"] as const)(
    "sanitizes %s PFX read without opening resources or downgrading",
    async (mode) => {
      const h = await harness(mode === "missing" ? null : undefined);
      if (mode === "controlled-EACCES")
        h.hooks.rejectRead = Object.assign(
          new Error(`synthetic-private-read ${h.pfxPath} ${testPassword}`),
          { code: "EACCES" },
        );
      await rejected(
        trackStart(startWindowsWorker(h.configured(), h.options())),
        "internal_error",
        h.pfxPath,
      );
      expect(h.read.mock.calls.length).toBe(1);
      expect(h.open.mock.calls.length).toBe(0);
      expect(h.adapter.mock.calls.length).toBe(0);
      expect(h.runner.mock.calls.length).toBe(0);
      expect(h.http.mock.calls.length).toBe(0);
      expect(h.tls.mock.calls.length).toBe(0);
      expect(h.initialize.mock.calls.length).toBe(0);
      expect(h.recoveries.length).toBe(0);
      expect(h.diagnostics.length).toBe(0);
      safePublic(JSON.stringify(h.diagnostics), h);
      preserved(h);
    },
    15_000,
  );

  it.each(["empty", "malformed", "password-protected"] as const)(
    "sanitizes %s PFX factory rejection and closes obtained owners",
    async (mode) => {
      const bytes =
        mode === "empty"
          ? Buffer.alloc(0)
          : mode === "malformed"
            ? Buffer.from("synthetic-test-only-invalid-pfx")
            : encryptedPkcs12;
      if (mode === "password-protected") {
        expect(
          sha256(bytes) ===
            "a3542e09ff0393d4f7ed2e8df351930dc9ddec16820321b20fe1f32245cc20b8",
          "fixed test-only PFX bytes",
        ).toBe(true);
        let refused = false;
        let accepted = false;
        try {
          createSecureContext({ pfx: bytes });
        } catch {
          refused = true;
        }
        try {
          createSecureContext({ pfx: bytes, passphrase: testPassword });
          accepted = true;
        } catch {}
        expect(
          refused && accepted,
          "fixture requires its public test-only password",
        ).toBe(true);
      }
      const h = await harness(bytes);
      await rejected(
        trackStart(startWindowsWorker(h.configured(), h.options())),
        "configuration_invalid",
        h.pfxPath,
      );
      expect(h.read.mock.calls.length).toBe(1);
      expect(h.tls.mock.calls.length).toBe(1);
      expect(h.http.mock.calls.length).toBe(0);
      expect(h.open.mock.calls.length).toBe(1);
      expect(h.storage.store.closed).toBe(true);
      expect(h.recoveries.length).toBe(0);
      expect(h.initialize.mock.calls.length).toBe(0);
      expect(factories.host.mock.calls.length).toBe(0);
      expect(h.diagnostics.length).toBe(0);
      safePublic(JSON.stringify(h.diagnostics), h);
      preserved(h);
    },
    15_000,
  );

  it("rejects an already aborted TLS start before PFX, Store or listeners", async () => {
    const h = await harness();
    const controller = new AbortController();
    controller.abort();
    await rejected(
      trackStart(
        startWindowsWorker(h.configured(), h.options(controller.signal)),
      ),
      "not_ready",
    );
    noResources(h);
  });

  it("passes the original signal to the real PFX read and stops after an abort while its return is held", async () => {
    const h = await harness();
    const returned = deferred();
    const release = deferred();
    const controller = new AbortController();
    h.hooks.afterRead = async () => {
      returned.resolve();
      await release.promise;
    };
    const pending = trackStart(
      startWindowsWorker(h.configured(), h.options(controller.signal)),
    );
    try {
      await reached(
        returned.promise,
        pending,
        "it reaches the original successful PFX read",
      );
      expect(h.read.mock.calls.length).toBe(1);
      expect(h.readSignals[0] === controller.signal).toBe(true);
      expect(h.open.mock.calls.length).toBe(0);
      expect(h.adapter.mock.calls.length).toBe(0);
      expect(h.runner.mock.calls.length).toBe(0);
      controller.abort();
      release.resolve();
      await rejected(pending, "not_ready");
      expect(h.open.mock.calls.length).toBe(0);
      expect(h.adapter.mock.calls.length).toBe(0);
      expect(h.http.mock.calls.length).toBe(0);
      expect(h.tls.mock.calls.length).toBe(0);
      expect(h.recoveries.length).toBe(0);
      preserved(h);
    } finally {
      controller.abort();
      release.resolve();
      await pending.catch(() => {});
    }
  }, 15_000);

  it("closes the real late TLS listener after abort without recovering or returning a runtime", async () => {
    const h = await harness();
    const returned = deferred<Server>();
    const release = deferred();
    const controller = new AbortController();
    h.hooks.afterListen = async (server) => {
      returned.resolve(server);
      await release.promise;
    };
    const pending = trackStart(
      startWindowsWorker(h.configured(), h.options(controller.signal)),
    );
    try {
      await reached(
        returned.promise,
        pending,
        "it reaches the actual bound TLS listener",
      );
      const late = await returned.promise;
      expect(late.listening).toBe(true);
      const closed = new Promise<void>((resolve) =>
        late.once("close", () => resolve()),
      );
      controller.abort();
      expect(h.storage.store.closed).toBe(true);
      release.resolve();
      await rejected(pending, "not_ready");
      await closed;
      expect(!late.listening && late.address() === null).toBe(true);
      expect(h.tls.mock.calls.length).toBe(1);
      expect(h.http.mock.calls.length).toBe(0);
      expect(h.recoveries.length).toBe(0);
      expect(h.initialize.mock.calls.length).toBe(0);
      preserved(h);
    } finally {
      controller.abort();
      release.resolve();
      await pending.catch(() => {});
    }
  }, 15_000);

  it("keeps the real occupied TLS endpoint and closes only its own failed startup", async () => {
    const occupied = await independentListener();
    const h = await harness();
    const input = { ...h.configured(), port: portOf(occupied.server) };
    await rejected(
      trackStart(startWindowsWorker(input, h.options())),
      "internal_error",
    );
    expect(h.tls.mock.calls.length).toBe(1);
    expect(h.http.mock.calls.length).toBe(0);
    expect(h.read.mock.calls.length).toBe(1);
    expect(h.open.mock.calls.length).toBe(1);
    expect(h.storage.store.closed).toBe(true);
    expect(h.recoveries.length).toBe(0);
    expect(h.initialize.mock.calls.length).toBe(0);
    expect(occupied.server.listening).toBe(true);
    const response = await get(occupied.server, occupied.authorization);
    expect(response.status === 200 && response.authorized).toBe(true);
    expect(h.diagnostics.length).toBe(0);
    safePublic(JSON.stringify(h.diagnostics), h);
    preserved(h);
  }, 15_000);

  it("normal close retains identity and PFX bytes while another real TLS instance stays available", async () => {
    const other = await independentListener();
    const h = await harness();
    const runtime = await started(
      trackStart(startWindowsWorker(h.configured(), h.options())),
    );
    expect(h.recoveries.length).toBe(1);
    await h.recoveries[0];
    const closed = new Promise<void>((resolve) =>
      runtime.server.once("close", () => resolve()),
    );
    expect(runtime.close() === undefined).toBe(true);
    await closed;
    expect(runtime.close() === undefined).toBe(true);
    expect(runtime.status().closing && h.storage.store.closed).toBe(true);
    expect(!runtime.server.listening && runtime.server.address() === null).toBe(
      true,
    );
    expect(other.server.listening).toBe(true);
    const response = await get(other.server, other.authorization);
    expect(response.status === 200 && response.authorized).toBe(true);
    expect(
      (await h.actualFiles.readFile(h.pfxPath)).equals(
        tlsTestCertificates.localhost.pfx,
      ),
    ).toBe(true);
    expect(h.read.mock.calls.length).toBe(1);
    expect(h.tls.mock.calls.length).toBe(1);
    expect(h.http.mock.calls.length).toBe(0);
    expect(h.initialize.mock.calls.length).toBe(0);
    preserved(h);
  }, 15_000);
});
