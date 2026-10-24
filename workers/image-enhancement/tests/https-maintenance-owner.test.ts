import { readdir } from "node:fs/promises";
import type {
  ClientRequest,
  IncomingMessage,
  OutgoingHttpHeaders,
} from "node:http";
import { request } from "node:https";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import { EnhancementError } from "../src/contracts.js";
import { localUploadFiles, type EnhancementHttpOptions } from "../src/http.js";
import { listenEnhancementTlsServer } from "../src/https.js";
import { localInputFiles } from "../src/jobs.js";
import { configInput } from "./fixtures.js";
import { tlsTestCertificates } from "./fixtures/tls-certificates.js";
import {
  boundary,
  deferred,
  manualUploadTimer,
  multipart,
  transportLimits,
  uploadParts,
} from "./http-fixtures.js";
import {
  runnerLimits,
  sourceImage,
  storageFixture,
  submissionLimits,
} from "./storage-fixtures.js";

type Activity = Readonly<{
  sealed: boolean;
  uploads: number;
  downloads: number;
  receipts: number;
}>;
type FileIoOwner = Readonly<{
  sealFileIo(): void;
  pendingRequests(): number;
  activity(): Activity;
}>;
type TlsResult = Readonly<{
  status: number;
  body: unknown;
  raw: string;
  authorized: boolean;
}>;

const idle: Activity = Object.freeze({
  sealed: false,
  uploads: 0,
  downloads: 0,
  receipts: 0,
});
const sealedIdle: Activity = Object.freeze({ ...idle, sealed: true });
const cleanups: (() => void | Promise<void>)[] = [];
const retirements: (() => void)[] = [];
const releases: (() => void)[] = [];
const pending: Promise<unknown>[] = [];

afterEach(async () => {
  for (const retire of retirements.splice(0)) retire();
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture(
  overrides: Partial<Omit<EnhancementHttpOptions, "store" | "config">> = {},
) {
  const storage = await storageFixture();
  cleanups.push(() => storage.cleanup());
  const config = createWorkerConfig(configInput());
  const onJobCommitted = vi.fn();
  const options: EnhancementHttpOptions = {
    store: storage.store,
    config: () => config,
    ready: () => true,
    submissionLimits,
    runnerLimits,
    transportLimits,
    onJobCommitted,
    ...overrides,
  };
  const server = await listenEnhancementTlsServer(options, 0, {
    host: "127.0.0.1",
    pfx: tlsTestCertificates.localhost.pfx,
  });
  const requests = new Set<ClientRequest>();
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const retire = () => {
    for (const req of requests) req.destroy();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
  };
  retirements.push(retire);
  cleanups.push(async () => {
    retire();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("TLS fixture did not bind TCP");
  const port = address.port;
  const auth = () => `Bearer ${storage.initialized.credential.key}`;
  function start(
    method: string,
    path: string,
    headers: OutgoingHttpHeaders = {},
  ) {
    const req = request({
      hostname: "127.0.0.1",
      port,
      servername: "localhost",
      ca: tlsTestCertificates.localhost.ca,
      rejectUnauthorized: true,
      agent: false,
      method,
      path,
      headers,
    });
    requests.add(req);
    req.once("close", () => requests.delete(req));
    const result = new Promise<TlsResult>((resolve, reject) => {
      req.once("error", reject);
      req.once("response", (response) => {
        const chunks: Buffer[] = [];
        const authorized = (response.socket as TLSSocket).authorized;
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("aborted", () =>
          reject(new Error("TLS response aborted")),
        );
        response.once("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: response.statusCode!,
              body: JSON.parse(raw),
              raw,
              authorized,
            });
          } catch {
            reject(new Error("TLS fixture expected JSON"));
          }
        });
      });
    });
    void result.catch(() => {});
    return { req, result };
  }
  async function call(
    method: string,
    path: string,
    body?: Buffer,
    headers: OutgoingHttpHeaders = { authorization: auth() },
  ) {
    const connection = start(
      method,
      path,
      body ? { ...headers, "content-length": body.length } : headers,
    );
    connection.req.end(body);
    return connection.result;
  }
  return {
    storage,
    server,
    auth,
    start,
    call,
    onJobCommitted,
    uploadHeaders: (key: string) => ({
      authorization: auth(),
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "idempotency-key": key,
    }),
    inputNames: () => readdir(storage.store.inputDirectory),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function ownerOf(server: object): FileIoOwner {
  const value: unknown = Reflect.get(server, "fileIo");
  const present = value !== null && typeof value === "object";
  expect(present, "TLS Server exposes its original handler fileIo owner").toBe(
    true,
  );
  if (!present) return expect.fail("TLS Server.fileIo is absent");
  expect(typeof Reflect.get(value, "sealFileIo") === "function").toBe(true);
  expect(typeof Reflect.get(value, "activity") === "function").toBe(true);
  return value as FileIoOwner;
}

function expectActivity(owner: FileIoOwner, expected: Activity) {
  const value = owner.activity();
  expect(Object.isFrozen(value)).toBe(true);
  expect(
    isDeepStrictEqual(value, expected),
    "exact original file activity",
  ).toBe(true);
  return value;
}

function expectSafe(result: TlsResult, f: Fixture) {
  for (const privateValue of [
    f.storage.directory,
    f.storage.initialized.credential.key,
    tlsTestCertificates.localhost.pfx.toString("base64"),
  ])
    expect(result.raw.includes(JSON.stringify(privateValue).slice(1, -1))).toBe(
      false,
    );
  expect(
    /"(?:credential|credentialId|key|key_digest|path|stack|cause|pfx)"\s*:|Bearer |BEGIN CERTIFICATE/i.test(
      result.raw,
    ),
  ).toBe(false);
  expect(result.authorized).toBe(true);
}

function expectNotReady(result: TlsResult, f: Fixture) {
  expectSafe(result, f);
  const error = new EnhancementError("not_ready");
  expect(result.status).toBe(error.status);
  const body = result.body as { data?: { requestId?: unknown } } | undefined;
  const requestId: unknown = body?.data?.requestId;
  expect(typeof requestId === "string").toBe(true);
  expect(
    isDeepStrictEqual(result.body, {
      code: "not_ready",
      data: { requestId },
      msg: error.message,
    }),
    "exact sanitized not_ready envelope",
  ).toBe(true);
}

function track<T>(promise: Promise<T>) {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

async function reached(barrier: Promise<void>, result: Promise<unknown>) {
  const boundary = await Promise.race([
    barrier.then(() => true),
    result.then(
      () => false,
      () => false,
    ),
  ]);
  expect(boundary, "original file boundary precedes the response").toBe(true);
}

function observeBodyReads(f: Fixture) {
  let bytes = 0;
  const observe = (req: IncomingMessage) => {
    const read = req.read.bind(req);
    req.read = (size?: number) => {
      const value = read(size);
      if (value !== null) bytes += Buffer.byteLength(value);
      return value;
    };
  };
  f.server.prependListener("request", observe);
  f.server.prependListener("checkContinue", observe);
  return () => bytes;
}

describe("TLS listener original file I/O owner", () => {
  it("exposes the same frozen handler methods through a fixed property on the original mutable TLS Server", async () => {
    const f = await fixture();
    const owner = ownerOf(f.server);
    const handler = f.server.listeners("request")[0];
    expect(owner.pendingRequests()).toBe(0);
    expect(Reflect.get(owner, "pendingRequests") === Reflect.get(handler!, "pendingRequests")).toBe(true);
    expect(typeof handler === "function").toBe(true);
    expect(
      Reflect.get(owner, "sealFileIo") === Reflect.get(handler!, "sealFileIo"),
    ).toBe(true);
    expect(
      Reflect.get(owner, "activity") === Reflect.get(handler!, "activity"),
    ).toBe(true);
    expect(f.server.listeners("checkContinue")[0] === handler).toBe(true);
    expect(f.server.listeners("checkExpectation")[0] === handler).toBe(true);
    expect(Object.isFrozen(owner)).toBe(true);
    expect(
      isDeepStrictEqual(Object.keys(owner).sort(), ["activity", "pendingRequests", "sealFileIo"]),
    ).toBe(true);
    const property = Object.getOwnPropertyDescriptor(f.server, "fileIo");
    expect(property?.value === owner).toBe(true);
    expect(property?.writable === false).toBe(true);
    expect(property?.configurable === false).toBe(true);
    expect(Reflect.set(f.server, "fileIo", {})).toBe(false);
    expect(Reflect.deleteProperty(f.server, "fileIo")).toBe(false);
    expect(Object.isFrozen(f.server)).toBe(false);
    const before = expectActivity(owner, idle);
    owner.sealFileIo();
    owner.sealFileIo();
    expectActivity(owner, sealedIdle);
    expect(before.sealed).toBe(false);
    expect(f.server.listening).toBe(true);
    expect(f.storage.store.closed).toBe(false);
    const health = await f.call("GET", "/healthz");
    expectSafe(health, f);
    expect(health.status).toBe(200);
    expect(
      isDeepStrictEqual(health.body, {
        code: "ok",
        data: { alive: true },
        msg: "成功。",
      }),
    ).toBe(true);
    expectActivity(owner, sealedIdle);
  });

  it("retains one real upload across seal and cleanup while refusing a new Expect body", async () => {
    const read = deferred();
    const allowRead = deferred();
    const cleaning = deferred();
    const allowCleanup = deferred();
    releases.push(() => {
      allowRead.resolve();
      allowCleanup.resolve();
    });
    const createDirectory = vi.fn(localUploadFiles.createDirectory);
    const mkdir = vi.fn(localInputFiles.mkdir);
    const timer = manualUploadTimer();
    const f = await fixture({
      uploadTimer: timer,
      uploadFiles: {
        ...localUploadFiles,
        createDirectory,
        async readImage(path) {
          const bytes = await localUploadFiles.readImage(path);
          read.resolve();
          await allowRead.promise;
          return bytes;
        },
        async removeDirectory(path) {
          await localUploadFiles.removeDirectory(path);
          cleaning.resolve();
          await allowCleanup.promise;
        },
      },
      inputFiles: { ...localInputFiles, mkdir },
    });
    const owner = ownerOf(f.server);
    const accept = vi.spyOn(f.storage.store, "acceptQueued");
    const body = multipart(uploadParts(await sourceImage()));
    const upload = track(
      f.call(
        "POST",
        "/v1/enhancement-jobs",
        body,
        f.uploadHeaders("tls-before-seal"),
      ),
    );
    await reached(read.promise, upload);
    expectActivity(owner, { ...idle, uploads: 1 });
    owner.sealFileIo();
    expectActivity(owner, { ...sealedIdle, uploads: 1 });
    const consumed = observeBodyReads(f);
    const rejected = f.start("POST", "/v1/enhancement-jobs", {
      ...f.uploadHeaders("tls-after-seal"),
      expect: "100-continue",
      "content-length": 1,
    });
    let continued = 0;
    rejected.req.once("continue", () => {
      continued += 1;
      rejected.req.end("x");
    });
    rejected.req.flushHeaders();
    expectNotReady(await rejected.result, f);
    rejected.req.destroy();
    expect(continued).toBe(0);
    expect(consumed()).toBe(0);
    expect(createDirectory.mock.calls.length).toBe(1);
    expectActivity(owner, { ...sealedIdle, uploads: 1 });
    allowRead.resolve();
    await reached(cleaning.promise, upload);
    expect(timer.pending.size).toBe(0);
    expectActivity(owner, { ...sealedIdle, uploads: 1 });
    expect(mkdir.mock.calls.length).toBe(0);
    expect(accept.mock.calls.length).toBe(0);
    owner.sealFileIo();
    expectActivity(owner, { ...sealedIdle, uploads: 1 });
    allowCleanup.resolve();
    expectNotReady(await upload, f);
    expectActivity(owner, sealedIdle);
    expect((await f.inputNames()).length).toBe(0);
    expect(mkdir.mock.calls.length).toBe(0);
    expect(accept.mock.calls.length).toBe(0);
    expect(f.onJobCommitted.mock.calls.length).toBe(0);
    expect(f.server.listening).toBe(true);
    expect(f.storage.store.closed).toBe(false);
  }, 15_000);

  it("passes synchronous ready reentry to the same handler seal and preserves its final COMMIT refusal", async () => {
    let owner: FileIoOwner | undefined;
    const ready = vi.fn(() => {
      owner?.sealFileIo();
      return true;
    });
    const f = await fixture({ ready });
    owner = ownerOf(f.server);
    const body = multipart(uploadParts(await sourceImage()));
    const result = await f.call(
      "POST",
      "/v1/enhancement-jobs",
      body,
      f.uploadHeaders("tls-ready-reentry"),
    );
    expectNotReady(result, f);
    expect(ready.mock.calls.length).toBe(1);
    expect(
      f.storage.store.findByKey(f.storage.principal(), "tls-ready-reentry") ===
        undefined,
    ).toBe(true);
    expect((await f.inputNames()).length).toBe(0);
    expectActivity(owner, sealedIdle);
    const calls = ready.mock.calls.length;
    const capabilities = await f.call("GET", "/v1/capabilities");
    expectSafe(capabilities, f);
    expect(capabilities.status).toBe(200);
    const data = (
      capabilities.body as { data?: { ready?: unknown; reason?: unknown } }
    ).data;
    expect(
      isDeepStrictEqual(
        { ready: data?.ready, reason: data?.reason },
        { ready: false, reason: "runner_unavailable" },
      ),
    ).toBe(true);
    expect(ready.mock.calls.length).toBe(calls);
    expect(f.onJobCommitted.mock.calls.length).toBe(0);
    expectActivity(owner, sealedIdle);
  }, 15_000);
});
