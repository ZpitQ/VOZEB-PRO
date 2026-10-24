import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient, revokeCredential } from "../src/credentials.js";
import {
  createEnhancementHandler,
  createHttpTransportLimits,
  localUploadFiles,
} from "../src/http.js";
import { httpFixture, jobOf, transportLimits } from "./http-fixtures.js";
import { sourceImage } from "./storage-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(...args: Parameters<typeof httpFixture>) {
  const f = await httpFixture(...args);
  cleanups.push(() => f.cleanup());
  return f;
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

describe("HTTP authentication before body and business access", () => {
  it.each(["missing", "malformed", "wrong", "revoked", "duplicate"] as const)(
    "rejects %s authentication on all seven endpoints with zero upload side effects",
    async (kind) => {
      const directory = vi.fn(localUploadFiles.createDirectory);
      const f = await fixture({
        uploadFiles: { ...localUploadFiles, createDirectory: directory },
      });
      const query = vi.spyOn(f.storage.store, "findByKey");
      const lookup = vi.spyOn(f.storage.store, "getOwned");
      let consumedBytes = 0;
      f.server.prependListener("request", (req) => {
        const read = req.read.bind(req);
        req.read = (size?: number) => {
          const value = read(size);
          if (value !== null) consumedBytes += Buffer.byteLength(value);
          return value;
        };
      });
      if (kind === "revoked")
        revokeCredential(
          f.storage.store,
          f.storage.initialized.credential.credentialId,
        );
      const unknownKey = Buffer.alloc(32, 0xa5).toString("base64url");
      for (const [method, path] of routes) {
        const authorization =
          kind === "malformed"
            ? "Basic fixture-invalid"
            : kind === "wrong"
              ? `Bearer ${unknownKey}`
              : f.auth();
        const headers =
          kind === "missing"
            ? {}
            : kind === "duplicate"
              ? ["Authorization", f.auth(), "authorization", f.auth()]
              : { authorization };
        const result = await f.call(
          method,
          path,
          Buffer.from("sensitive-unconsumed-body"),
          headers,
        );
        expect(result.status).toBe(401);
        expect(result.body).toMatchObject({
          code: "authentication_failed",
          data: { requestId: expect.any(String) },
        });
        expect(result.raw).not.toContain(f.storage.initialized.credential.key);
        expect(result.raw).not.toContain("sensitive-unconsumed-body");
      }
      expect(consumedBytes).toBe(0);
      expect(directory).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
      expect(await f.inputNames()).toEqual([]);
    },
  );

  it("does not send 100 Continue before rejecting unauthenticated Expect requests", async () => {
    const f = await fixture();
    const connection = f.start("POST", "/v1/enhancement-jobs", {
      expect: "100-continue",
      "content-length": 1,
    });
    let continued = 0;
    connection.req.on("continue", () => {
      continued++;
      connection.req.end("x");
    });
    connection.req.flushHeaders();
    const result = await connection.result;
    expect(result.status).toBe(401);
    expect(continued).toBe(0);
    connection.req.destroy();
    expect((await f.call("GET", "/healthz")).status).toBe(200);
  });

  it("rejects an unfinished unauthenticated chunked body without consuming it or creating upload state", async () => {
    const directory = vi.fn(localUploadFiles.createDirectory);
    const f = await fixture({
      uploadFiles: { ...localUploadFiles, createDirectory: directory },
    });
    let consumedBytes = 0;
    f.server.prependListener("request", (req) => {
      const read = req.read.bind(req);
      req.read = (size?: number) => {
        const value = read(size);
        if (value !== null) consumedBytes += Buffer.byteLength(value);
        return value;
      };
    });
    const connection = f.start("POST", "/v1/enhancement-jobs", {
      "transfer-encoding": "chunked",
    });
    connection.req.write(
      Buffer.alloc(transportLimits.maxMultipartOverheadBytes + 1, "x"),
    );
    expect(await connection.result).toMatchObject({
      status: 401,
      body: { code: "authentication_failed" },
    });
    connection.req.destroy();
    expect(consumedBytes).toBe(0);
    expect(directory).not.toHaveBeenCalled();
    expect(await f.inputNames()).toEqual([]);
    expect((await f.call("GET", "/healthz")).status).toBe(200);
  });

  it("authenticates unknown paths and methods before returning fixed 404 and 405 errors", async () => {
    const f = await fixture();
    expect((await f.call("GET", "/not-a-route", undefined, {})).status).toBe(
      401,
    );
    const missing = await f.call("GET", "/not-a-route");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("route_not_found");
    const method = await f.call("PATCH", "/v1/capabilities");
    expect(method.status).toBe(405);
    expect(method.body.code).toBe("method_not_allowed");
  });

  it("reports only white-listed capabilities and stable identity across a real restart", async () => {
    const f = await fixture();
    const health = await f.call("GET", "/healthz");
    expect(health.status).toBe(200);
    expect(health.body.data).toEqual({ alive: true });
    const first = await f.call("GET", "/v1/capabilities");
    expect(first.status).toBe(200);
    expect(Object.keys(first.body.data).sort()).toEqual([
      "budgets",
      "models",
      "normalizationProfile",
      "protocolVersion",
      "ready",
      "reason",
      "serviceId",
    ]);
    expect(first.body.data).toMatchObject({
      serviceId: f.storage.store.identity.serviceId,
      ready: true,
      reason: null,
      budgets: f.config.budgets,
      models: f.config.models,
    });
    for (const sensitive of [
      f.storage.directory,
      f.storage.initialized.credential.key,
      "key_digest",
      "credentialId",
      "binaryPath",
      "modelPath",
    ])
      expect(first.raw).not.toContain(sensitive);
    await f.restart();
    expect(await f.call("GET", "/v1/capabilities")).toMatchObject({
      status: 200,
      body: first.body,
    });
  });

  it("defaults to not-ready without an injected runner source", async () => {
    const f = await fixture({ ready: undefined });
    expect((await f.call("GET", "/healthz")).status).toBe(200);
    expect((await f.call("GET", "/v1/capabilities")).body.data).toMatchObject({
      ready: false,
      reason: "runner_unavailable",
    });
    expect(await f.upload(await sourceImage())).toMatchObject({
      status: 503,
      body: { code: "not_ready" },
    });
    expect(await f.inputNames()).toEqual([]);
  });

  it("keeps owned query, cancellation, result and receipt truthful and hides another client", async () => {
    const f = await fixture();
    const accepted = await f.upload(await sourceImage());
    expect(accepted.status).toBe(202);
    const job = jobOf(accepted);
    const base = `/v1/enhancement-jobs/${job.jobId}`;
    expect(jobOf(await f.call("GET", base))).toEqual(job);
    for (const [method, suffix] of [
      ["GET", "/result"],
      ["POST", "/receipt"],
    ]) {
      expect(await f.call(method!, `${base}${suffix}`)).toMatchObject({
        status: 409,
        body: { code: "result_not_ready" },
      });
    }
    const other = createClient(f.storage.store);
    for (const [method, suffix] of [
      ["GET", ""],
      ["GET", "/result"],
      ["POST", "/receipt"],
      ["DELETE", ""],
    ]) {
      expect(
        await f.call(method!, `${base}${suffix}`, undefined, {
          authorization: `Bearer ${other.key}`,
        }),
      ).toMatchObject({ status: 404, body: { code: "job_not_found" } });
      expect(
        await f.call(method!, `/v1/enhancement-jobs/missing${suffix}`),
      ).toMatchObject({ status: 404, body: { code: "job_not_found" } });
    }
    const cancelled = await f.call("DELETE", base);
    expect(cancelled.status).toBe(200);
    expect(jobOf(cancelled)).toMatchObject({
      status: "cancelled",
      reason: "user_cancel",
    });
    expect(jobOf(await f.call("DELETE", base))).toEqual(jobOf(cancelled));
    expect((await f.call("GET", `${base}/result`)).status).toBe(409);
    expect((await f.call("POST", `${base}/receipt`)).status).toBe(409);
  });
});

describe("explicit HTTP transport resource contract", () => {
  it(
    "accepts and freezes fixture limits, binds loopback and enforces the configured header budget",
    async () => {
      const limits = createHttpTransportLimits(transportLimits);
      expect(limits).toEqual(transportLimits);
      expect(Object.isFrozen(limits)).toBe(true);
      const configured = {
        ...limits,
        maxHeaderBytes: limits.maxHeaderBytes / 2,
      };
      const f = await fixture({ transportLimits: configured });
      const address = f.server.address();
      expect(address).toMatchObject({ address: "127.0.0.1" });
      if (!address || typeof address === "string")
        throw new Error("fixture did not bind TCP");
      expect(f.server.headersTimeout).toBe(transportLimits.headersTimeoutMs);
      expect(f.server.requestTimeout).toBe(0);
      const headers = [
        "Host",
        `127.0.0.1:${address.port}`,
        "Connection",
        "close",
        "Authorization",
        f.auth(),
        "X-Budget",
        "",
      ];
      const frame = (values: readonly string[]) =>
        Buffer.from(
          [
            "GET /healthz HTTP/1.1",
            ...values.flatMap((value, index) =>
              index % 2 === 0 ? [`${value}: ${values[index + 1]!}`] : [],
            ),
            "",
            "",
          ].join("\r\n"),
        );
      // Count the complete explicit HTTP frame, including every delimiter.
      headers[headers.length - 1] = "x".repeat(
        configured.maxHeaderBytes - frame(headers).length,
      );
      expect(frame(headers).length).toBe(configured.maxHeaderBytes);
      expect(await f.call("GET", "/healthz", undefined, headers)).toMatchObject(
        { status: 200, body: { code: "ok", data: { alive: true } } },
      );

      // A single field value exceeds the configured budget, but the whole frame
      // remains below the original fixture limit, proving the override is used.
      headers[headers.length - 1] = "x".repeat(configured.maxHeaderBytes + 1);
      const oversized = frame(headers);
      expect(oversized.length).toBeLessThan(transportLimits.maxHeaderBytes);
      const status = await new Promise<number>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: address.port });
        let line = "";
        let settled = false;
        const finish = (result: number | Error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        socket.setTimeout(configured.headersTimeoutMs, () =>
          finish(new Error("raw HTTP fixture timed out before a status line")),
        );
        socket.once("connect", () => {
          socket.write(oversized);
        });
        socket.once("error", () =>
          finish(new Error("raw HTTP fixture connection failed")),
        );
        socket.once("close", () =>
          finish(new Error("raw HTTP fixture closed before a status line")),
        );
        socket.on("data", (chunk: Buffer) => {
          const remaining = configured.maxHeaderBytes - line.length;
          const candidate =
            line + chunk.subarray(0, remaining).toString("latin1");
          const end = candidate.indexOf("\r\n");
          if (end >= 0) {
            const match = /^HTTP\/1\.1 ([0-9]{3}) [^\r\n]*$/.exec(
              candidate.slice(0, end),
            );
            finish(
              match
                ? Number(match[1])
                : new Error("raw HTTP fixture received an invalid status line"),
            );
            return;
          }
          line = candidate;
          if (chunk.length >= remaining)
            finish(
              new Error("raw HTTP fixture status line exceeded its bound"),
            );
        });
      });
      expect(status).toBe(431);
    },
    transportLimits.requestTimeoutMs,
  );

  it.each([
    {},
    { ...transportLimits, maxPlanBytes: 0 },
    { ...transportLimits, maxMultipartOverheadBytes: 1.5 },
    { ...transportLimits, maxConcurrentUploads: -1 },
    { ...transportLimits, requestTimeoutMs: Number.POSITIVE_INFINITY },
    { ...transportLimits, maxHeaderBytes: "1024" },
    { ...transportLimits, headersTimeoutMs: 30_001 },
    { ...transportLimits, extra: true },
  ])(
    "rejects missing, ambiguous and unsafe limit configuration %#",
    (input) => {
      expect(() => createHttpTransportLimits(input)).toThrowError(
        expect.objectContaining({ code: "configuration_invalid" }),
      );
    },
  );

  it("rejects safe-integer overflow in a request budget before opening a listener", async () => {
    const f = await fixture();
    const config = {
      ...f.config,
      budgets: {
        ...f.config.budgets,
        input: { ...f.config.budgets.input, maxBytes: Number.MAX_SAFE_INTEGER },
      },
    };
    expect(() =>
      createEnhancementHandler({ ...f.options(), config: () => config }),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
  });
});
