import { X509Certificate } from "node:crypto";
import { readdir } from "node:fs/promises";
import type {
  ClientRequest,
  IncomingMessage,
  OutgoingHttpHeaders,
} from "node:http";
import { request, type RequestOptions, type Server } from "node:https";
import { Server as NetServer } from "node:net";
import type { Duplex } from "node:stream";
import { createSecureContext, type TLSSocket } from "node:tls";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import {
  localUploadFiles,
  type EnhancementHttpOptions,
  type UploadFiles,
} from "../src/http.js";
import { listenEnhancementTlsServer } from "../src/https.js";
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function storage() {
  const f = await storageFixture();
  cleanups.push(() => f.cleanup());
  const config = createWorkerConfig(configInput());
  const configReads = vi.fn(() => config);
  const ready = vi.fn(() => true);
  const options: EnhancementHttpOptions = {
    store: f.store,
    config: configReads,
    ready,
    submissionLimits,
    runnerLimits,
    transportLimits,
  };
  return { ...f, config, configReads, ready, options };
}

async function listen(
  options: EnhancementHttpOptions,
  port = 0,
  transport: Readonly<{ host: string; pfx: Buffer }> = {
    host: "127.0.0.1",
    pfx: tlsTestCertificates.localhost.pfx,
  },
  requests = new Set<ClientRequest>(),
) {
  const server = await listenEnhancementTlsServer(options, port, transport);
  return trackServer(server, requests);
}

function trackServer(server: Server, requests = new Set<ClientRequest>()) {
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  cleanups.push(async () => {
    for (const req of requests) req.destroy();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  return server;
}

type TlsResponse = Readonly<{
  status: number;
  body: unknown;
  raw: string;
  authorized: boolean;
}>;
type ClientTrust = Pick<RequestOptions, "ca" | "servername">;

async function fixture(
  overrides: Partial<Omit<EnhancementHttpOptions, "store" | "config">> = {},
  certificate = tlsTestCertificates.localhost,
  host = "127.0.0.1",
) {
  const f = await storage();
  const options = { ...f.options, ...overrides };
  const requests = new Set<ClientRequest>();
  const pending = listen(options, 0, { host, pfx: certificate.pfx }, requests);
  await expect(pending).resolves.toMatchObject({ listening: true });
  const server = await pending;
  const port = () => {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("TLS fixture did not bind TCP");
    return address.port;
  };
  const auth = () => `Bearer ${f.initialized.credential.key}`;
  function start(
    method: string,
    path: string,
    headers: OutgoingHttpHeaders = {},
    trust: ClientTrust = {},
  ) {
    const req = request({
      hostname: host,
      port: port(),
      method,
      path,
      headers,
      agent: false,
      ca: certificate.ca,
      servername: "localhost",
      ...trust,
      rejectUnauthorized: true,
    });
    requests.add(req);
    req.once("close", () => requests.delete(req));
    const result = new Promise<TlsResponse>((resolve, reject) => {
      req.once("error", reject);
      req.once("response", (res) => {
        const chunks: Buffer[] = [];
        const authorized = (res.socket as TLSSocket).authorized;
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("error", reject);
        res.once("aborted", () => reject(new Error("TLS response aborted")));
        res.once("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: res.statusCode!,
              body: raw ? JSON.parse(raw) : undefined,
              raw,
              authorized,
            });
          } catch {
            reject(new Error("TLS fixture expected a JSON response"));
          }
        });
      });
    });
    // A TLS rejection can arrive before the test awaits its result.
    void result.catch(() => {});
    return { req, result };
  }
  async function call(
    method: string,
    path: string,
    body?: Buffer,
    headers: OutgoingHttpHeaders = { authorization: auth() },
    trust: ClientTrust = {},
  ) {
    const connection = start(
      method,
      path,
      body ? { ...headers, "content-length": body.length } : headers,
      trust,
    );
    connection.req.end(body);
    return connection.result;
  }
  const uploadHeaders = (key: string) => ({
    authorization: auth(),
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "idempotency-key": key,
  });
  return {
    ...f,
    options,
    server,
    port,
    auth,
    start,
    call,
    uploadHeaders,
    inputNames: () => readdir(f.store.inputDirectory),
  };
}

function observeBodyReads(server: Server) {
  let bytes = 0;
  const observe = (req: IncomingMessage) => {
    const read = req.read.bind(req);
    req.read = (size?: number) => {
      const value = read(size);
      if (value !== null) bytes += Buffer.byteLength(value);
      return value;
    };
  };
  server.prependListener("request", observe);
  server.prependListener("checkContinue", observe);
  server.prependListener("checkExpectation", observe);
  return () => bytes;
}

const routes = [
  ["GET", "/healthz"],
  ["GET", "/v1/capabilities"],
  ["POST", "/v1/enhancement-jobs"],
  ["GET", "/v1/enhancement-jobs/missing"],
  ["GET", "/v1/enhancement-jobs/missing/result"],
  ["POST", "/v1/enhancement-jobs/missing/receipt"],
  ["DELETE", "/v1/enhancement-jobs/missing"],
] as const;

describe("synthetic TLS fixture preconditions", () => {
  it("provides loadable PFX with the intended names and validity windows", () => {
    for (const certificate of Object.values(tlsTestCertificates))
      expect(() => createSecureContext({ pfx: certificate.pfx })).not.toThrow();
    const valid = new X509Certificate(tlsTestCertificates.localhost.ca);
    expect(valid.checkHost("localhost")).toBe("localhost");
    expect(valid.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(Date.parse(valid.validFrom)).toBeLessThan(Date.now());
    expect(Date.parse(valid.validTo)).toBeGreaterThan(Date.now());
    const wrong = new X509Certificate(tlsTestCertificates.wrongName.ca);
    expect(wrong.checkHost("wrong.invalid")).toBe("wrong.invalid");
    expect(wrong.checkHost("localhost")).toBeUndefined();
    const expired = new X509Certificate(tlsTestCertificates.expired.ca);
    expect(expired.checkHost("localhost")).toBe("localhost");
    expect(Date.parse(expired.validTo)).toBeLessThan(Date.now());
  });
});

describe("HTTPS trust and authenticated Worker contract", () => {
  it("serves verified DNS health and the actual Store capability identity", async () => {
    const f = await fixture();
    expect(f.server.address()).toMatchObject({ address: "127.0.0.1" });
    expect(await f.call("GET", "/healthz")).toMatchObject({
      status: 200,
      authorized: true,
      body: { code: "ok", data: { alive: true } },
    });
    const capabilities = await f.call("GET", "/v1/capabilities");
    expect(capabilities.status).toBe(200);
    expect(capabilities.authorized).toBe(true);
    const body = capabilities.body;
    expect(
      typeof body === "object" &&
        body !== null &&
        "msg" in body &&
        typeof body.msg === "string" &&
        isDeepStrictEqual(body, {
          code: "ok",
          data: {
            serviceId: f.store.identity.serviceId,
            protocolVersion: f.config.protocolVersion,
            normalizationProfile: f.config.normalizationProfile,
            models: f.config.models,
            budgets: f.config.budgets,
            ready: true,
            reason: null,
          },
          msg: body.msg,
        }),
    ).toBe(true);
    for (const sensitive of [
      f.directory,
      f.initialized.credential.key,
      "key_digest",
      "credentialId",
      "pfx",
      "BEGIN CERTIFICATE",
      tlsTestCertificates.localhost.pfx.toString("base64"),
    ])
      expect(capabilities.raw.includes(sensitive)).toBe(false);
  });

  it("verifies the IPv4 SAN without a DNS server name", async () => {
    const f = await fixture();
    expect(
      await f.call("GET", "/healthz", undefined, undefined, { servername: "" }),
    ).toMatchObject({ status: 200, authorized: true });
  });

  it("accepts an explicit IPv6 address with verified localhost identity", async () => {
    const f = await fixture({}, tlsTestCertificates.localhost, "::1");
    expect(f.server.address()).toMatchObject({
      address: "::1",
      family: "IPv6",
    });
    expect(await f.call("GET", "/healthz")).toMatchObject({
      status: 200,
      authorized: true,
    });
  });

  it("preserves runner-unavailable readiness when only TLS is available", async () => {
    const f = await fixture({ ready: undefined });
    expect(await f.call("GET", "/v1/capabilities")).toMatchObject({
      status: 200,
      body: { data: { ready: false, reason: "runner_unavailable" } },
    });
  });

  it.each(["missing", "wrong"] as const)(
    "rejects %s authentication on all seven endpoints before body or business access",
    async (kind) => {
      const directory = vi.fn(localUploadFiles.createDirectory);
      const f = await fixture({
        uploadFiles: { ...localUploadFiles, createDirectory: directory },
      });
      const find = vi.spyOn(f.store, "findByKey");
      const owned = vi.spyOn(f.store, "getOwned");
      const receipt = vi.spyOn(f.store, "acknowledgeResult");
      const bytes = observeBodyReads(f.server);
      f.configReads.mockClear();
      f.ready.mockClear();
      const headers =
        kind === "missing"
          ? {}
          : {
              authorization: `Bearer ${Buffer.alloc(32, 0xa5).toString("base64url")}`,
            };
      for (const [method, path] of routes)
        expect(
          await f.call(
            method,
            path,
            Buffer.from("unconsumed-test-body"),
            headers,
          ),
        ).toMatchObject({
          status: 401,
          authorized: true,
          body: { code: "authentication_failed" },
        });
      expect(bytes()).toBe(0);
      expect(f.configReads).not.toHaveBeenCalled();
      expect(f.ready).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
      expect(owned).not.toHaveBeenCalled();
      expect(receipt).not.toHaveBeenCalled();
      expect(directory).not.toHaveBeenCalled();
      expect(await f.inputNames()).toEqual([]);
    },
  );

  it.each(["100-continue", "fixture-expectation"])(
    "authenticates Expect %s before continue, body reads or business access",
    async (expectation) => {
      const f = await fixture();
      const find = vi.spyOn(f.store, "findByKey");
      const owned = vi.spyOn(f.store, "getOwned");
      const bytes = observeBodyReads(f.server);
      f.configReads.mockClear();
      const connection = f.start("POST", "/v1/enhancement-jobs", {
        expect: expectation,
        "content-length": 1,
      });
      let continued = 0;
      connection.req.on("continue", () => {
        continued++;
        connection.req.end("x");
      });
      connection.req.flushHeaders();
      expect(await connection.result).toMatchObject({
        status: 401,
        body: { code: "authentication_failed" },
      });
      connection.req.destroy();
      expect(continued).toBe(0);
      expect(bytes()).toBe(0);
      expect(f.configReads).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
      expect(owned).not.toHaveBeenCalled();
      expect(await f.inputNames()).toEqual([]);
      expect((await f.call("GET", "/healthz")).status).toBe(200);
    },
  );

  it("passes authenticated checkExpectation through the health handler", async () => {
    const f = await fixture();
    expect(
      await f.call("GET", "/healthz", undefined, {
        authorization: f.auth(),
        expect: "fixture-expectation",
      }),
    ).toMatchObject({ status: 200, body: { data: { alive: true } } });
  });

  it("accepts an authenticated Expect upload into the actual Store", async () => {
    const f = await fixture();
    const body = multipart(uploadParts(await sourceImage()));
    const connection = f.start("POST", "/v1/enhancement-jobs", {
      ...f.uploadHeaders("tls-continue-job"),
      expect: "100-continue",
      "content-length": body.length,
    });
    let continued = 0;
    connection.req.once("continue", () => {
      continued++;
      connection.req.end(body);
    });
    connection.req.flushHeaders();
    expect(await connection.result).toMatchObject({
      status: 202,
      body: { code: "ok", data: { job: { jobId: expect.any(String) } } },
    });
    expect(continued).toBe(1);
    expect(f.store.findByKey(f.principal(), "tls-continue-job")).toBeDefined();
  });

  it("keeps the application body deadline and releases timed-out upload state", async () => {
    const timer = manualUploadTimer();
    const created = deferred();
    const cleaned = deferred();
    const files: UploadFiles = {
      ...localUploadFiles,
      async createDirectory(parent) {
        const directory = await localUploadFiles.createDirectory(parent);
        created.resolve();
        return directory;
      },
      async removeDirectory(directory) {
        await localUploadFiles.removeDirectory(directory);
        cleaned.resolve();
      },
    };
    const f = await fixture({ uploadFiles: files, uploadTimer: timer });
    const connection = f.start(
      "POST",
      "/v1/enhancement-jobs",
      f.uploadHeaders("tls-body-timeout"),
    );
    connection.req.flushHeaders();
    await created.promise;
    expect([...timer.pending.values()]).toEqual([
      transportLimits.requestTimeoutMs,
    ]);
    timer.fire();
    expect(await connection.result).toMatchObject({
      status: 408,
      body: { code: "upload_timeout" },
    });
    await cleaned.promise;
    connection.req.destroy();
    expect(timer.pending.size).toBe(0);
    expect(await f.inputNames()).toEqual([]);
    expect(
      await f.call(
        "POST",
        "/v1/enhancement-jobs",
        multipart(uploadParts(await sourceImage())),
        f.uploadHeaders("tls-after-timeout"),
      ),
    ).toMatchObject({ status: 202 });
    expect(timer.pending.size).toBe(0);
  });

  it.each([
    ["no trusted certificate", []],
    ["an unrelated trusted certificate", [tlsTestCertificates.wrongName.ca]],
  ] as const)("rejects %s", async (_name, ca) => {
    const f = await fixture();
    await expect(
      f.call("GET", "/healthz", undefined, undefined, { ca: [...ca] }),
    ).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect((await f.call("GET", "/healthz")).status).toBe(200);
  });

  it("rejects the wrong server name even with the correct trusted certificate", async () => {
    const f = await fixture();
    await expect(
      f.call("GET", "/healthz", undefined, undefined, {
        servername: "wrong.invalid",
      }),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("rejects a trusted wrong-name server certificate for localhost", async () => {
    const f = await fixture({}, tlsTestCertificates.wrongName);
    await expect(f.call("GET", "/healthz")).rejects.toMatchObject({
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
  });

  it("rejects an expired certificate even when explicitly trusted", async () => {
    const f = await fixture({}, tlsTestCertificates.expired);
    await expect(f.call("GET", "/healthz")).rejects.toMatchObject({
      code: "CERT_HAS_EXPIRED",
    });
  });
});

describe("HTTPS listener configuration and lifecycle", () => {
  it("uses the configured header limits while the application owns body timeouts", async () => {
    const limits = {
      ...transportLimits,
      maxHeaderBytes: transportLimits.maxHeaderBytes / 2,
    };
    const f = await fixture({ transportLimits: limits });
    expect(f.server.headersTimeout).toBe(limits.headersTimeoutMs);
    expect(f.server.requestTimeout).toBe(0);
    expect(Reflect.get(f.server, "maxHeaderSize")).toBe(limits.maxHeaderBytes);
    expect((await f.call("GET", "/healthz")).status).toBe(200);
    expect(
      await f.call("GET", "/healthz", undefined, {
        authorization: f.auth(),
        "x-budget": "x".repeat(limits.maxHeaderBytes + 1),
      }),
    ).toMatchObject({ status: 431, authorized: true });
    expect((await f.call("GET", "/healthz")).status).toBe(200);
  });

  it.each([
    { name: "negative port", port: -1 },
    { name: "port overflow", port: 65_536 },
    { name: "fractional port", port: 0.5 },
    { name: "NaN port", port: Number.NaN },
    { name: "infinite port", port: Number.POSITIVE_INFINITY },
    { name: "string port", port: "0" },
    { name: "missing transport", transport: undefined },
    { name: "null transport", transport: null },
    {
      name: "missing host",
      transport: { pfx: tlsTestCertificates.localhost.pfx },
    },
    { name: "empty host", host: "" },
    { name: "DNS host", host: "localhost" },
    { name: "host with port", host: "127.0.0.1:443" },
    { name: "URL host", host: "https://127.0.0.1" },
    { name: "bracketed IPv6 host", host: "[::1]" },
    { name: "non-IP host", host: "999.0.0.1" },
    { name: "non-string host", host: 127 },
    { name: "missing PFX", transport: { host: "127.0.0.1" } },
    { name: "empty PFX", pfx: Buffer.alloc(0) },
    { name: "non-Buffer PFX", pfx: "test-only-invalid-pfx" },
    { name: "malformed PFX", pfx: Buffer.from("test-only-invalid-pfx") },
  ])("rejects $name before any listen call", async (input) => {
    const f = await storage();
    const bound = vi.spyOn(NetServer.prototype, "listen");
    const port = "port" in input ? input.port : 0;
    const transport =
      "transport" in input
        ? input.transport
        : {
            host: "host" in input ? input.host : "127.0.0.1",
            pfx: "pfx" in input ? input.pfx : tlsTestCertificates.localhost.pfx,
          };
    await expect(
      listenEnhancementTlsServer(
        f.options,
        port as number,
        transport as Readonly<{ host: string; pfx: Buffer }>,
      ).then((server) => trackServer(server)),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(bound).not.toHaveBeenCalled();
  });

  it("rejects invalid transport limits before any listen call", async () => {
    const f = await storage();
    const bound = vi.spyOn(NetServer.prototype, "listen");
    await expect(
      listen({
        ...f.options,
        transportLimits: { ...transportLimits, maxHeaderBytes: 0 },
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(bound).not.toHaveBeenCalled();
  });

  it("preserves the port conflict error and the original TLS listener", async () => {
    const f = await fixture();
    await expect(listen(f.options, f.port())).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    expect(f.server.listening).toBe(true);
    expect(await f.call("GET", "/healthz")).toMatchObject({
      status: 200,
      authorized: true,
    });
  });

  it("releases the listener when the caller awaits close", async () => {
    const f = await fixture();
    const port = f.port();
    expect((await f.call("GET", "/healthz")).status).toBe(200);
    await new Promise<void>((resolve, reject) =>
      f.server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(f.server.listening).toBe(false);
    expect(f.server.address()).toBeNull();
    const replacement = await listen(f.options, port);
    expect(replacement.address()).toMatchObject({ address: "127.0.0.1", port });
  });
});
