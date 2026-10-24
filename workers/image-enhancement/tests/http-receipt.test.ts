import assert from "node:assert/strict";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClient,
  revokeCredential,
  rotateCredential,
} from "../src/credentials.js";
import type { HttpTransportLimits } from "../src/http-config.js";
import type { UploadTimer } from "../src/http.js";
import {
  deferred,
  httpFixture,
  jobOf,
  manualUploadTimer,
  transportLimits,
} from "./http-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import {
  requestBinary,
  succeededThroughRunner,
  type ResultHttpFixture,
} from "./result-http-fixtures.js";

const receiptId = "12345678-9abc-4def-8123-456789abcdef";
const anotherReceiptId = "23456789-abcd-4efa-8234-56789abcdef0";
const receiptLimits: HttpTransportLimits = {
  ...transportLimits,
  maxReceiptBytes: 1024,
  maxConcurrentReceipts: 1,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: Parameters<typeof httpFixture>[0] = {}) {
  const f = await httpFixture({
    ...options,
    transportLimits: options.transportLimits ?? receiptLimits,
  });
  cleanups.push(() => f.cleanup());
  return f;
}
const succeed = (f: ResultHttpFixture) =>
  succeededThroughRunner(f, (cleanup) => cleanups.push(cleanup));

function requestBody(
  f: ResultHttpFixture,
  success: Awaited<ReturnType<typeof succeededThroughRunner>>,
) {
  assert.ok(success.succeeded.result);
  return {
    serviceId: f.storage.store.identity.serviceId,
    receiptId,
    result: success.succeeded.result,
  };
}
const receiptPath = (jobId: string) => `/v1/enhancement-jobs/${jobId}/receipt`;
const headersFor = (f: ResultHttpFixture) => ({
  authorization: f.auth(),
  "content-type": "application/json",
});
function send(
  f: ResultHttpFixture,
  path: string,
  value: unknown,
  headers: OutgoingHttpHeaders | readonly string[] = headersFor(f),
  chunks = false,
) {
  return f.call(
    "POST",
    path,
    Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
    headers,
    chunks,
  );
}
function receipts(f: ResultHttpFixture) {
  return snapshot(f.storage, (db) =>
    db.prepare("SELECT * FROM result_receipts ORDER BY job_id").all(),
  );
}
function facts(f: ResultHttpFixture) {
  return snapshot(f.storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
    attempts: db
      .prepare("SELECT * FROM attempts ORDER BY job_id, attempt_no")
      .all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
    candidates: db
      .prepare("SELECT * FROM artifact_candidates ORDER BY rowid")
      .all(),
    references: db
      .prepare("SELECT * FROM artifact_references ORDER BY rowid")
      .all(),
    observations: db
      .prepare("SELECT * FROM artifact_observations ORDER BY rowid")
      .all(),
  }));
}
function reached<T>(barrier: Promise<T>, result: Promise<unknown>) {
  return Promise.race([
    barrier,
    result.then(
      () => {
        throw new Error("receipt response ended before the required boundary");
      },
      (cause: unknown) => {
        throw new Error(
          "receipt response failed before the required boundary",
          { cause },
        );
      },
    ),
  ]);
}
function receiptClock() {
  const manual = manualUploadTimer();
  const started = deferred();
  const cancelled = deferred();
  const deadlines: number[] = [];
  let cancellations = 0;
  const timer: UploadTimer = {
    start(callback, milliseconds) {
      deadlines.push(milliseconds);
      const cancel = manual.start(callback, milliseconds);
      started.resolve();
      return () => {
        cancellations++;
        cancel();
        cancelled.resolve();
      };
    },
  };
  return {
    ...manual,
    timer,
    deadlines,
    started: started.promise,
    cancelled: cancelled.promise,
    cancellations: () => cancellations,
  };
}

describe("HTTP persists only authenticated succeeded result receipts", () => {
  it("keeps the first exact receipt across replay, rotation and restart without treating download finish as receipt", async () => {
    let wakes = 0;
    const f = await fixture({
      onJobCommitted: () => {
        wakes++;
      },
    });
    const success = await succeed(f);
    const body = requestBody(f, success);
    const path = receiptPath(success.succeeded.jobId);
    const downloaded = await requestBinary(
      f,
      path.replace(/\/receipt$/, "/result"),
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.bytes).toEqual(success.png);
    expect(receipts(f)).toEqual([]);
    const before = facts(f);
    f.setReady(false);
    const expected = {
      serviceId: body.serviceId,
      jobId: success.succeeded.jobId,
      clientId: success.succeeded.clientId,
      receiptId,
      result: body.result,
      receivedAt: f.storage.clock(),
    };
    const first = await send(f, path, {
      ...body,
      serviceId: body.serviceId.toUpperCase(),
      receiptId: receiptId.toUpperCase(),
      result: { ...body.result, sha256: body.result.sha256.toUpperCase() },
    });
    expect(first.body).toEqual({
      code: "ok",
      data: { receipt: expected, applied: true },
      msg: "成功。",
    });
    expect(first.status).toBe(200);
    f.storage.setNow(2_000);
    const replay = await send(f, path, body);
    expect(replay).toMatchObject({
      status: 200,
      body: { code: "ok", data: { receipt: expected, applied: false } },
    });
    const rotated = rotateCredential(f.storage.store, {
      clientId: success.succeeded.clientId,
    });
    expect(
      await send(f, path, body, {
        ...headersFor(f),
        authorization: `Bearer ${rotated.key}`,
      }),
    ).toMatchObject({
      status: 200,
      body: { data: { receipt: expected, applied: false } },
    });
    expect(facts(f)).toEqual(before);
    expect(receipts(f)).toHaveLength(1);
    expect(wakes).toBe(1);
    expect(success.executor.prepareCalls).toHaveLength(1);
    expect(success.executor.authorizeCalls).toHaveLength(1);
    expect(success.executor.launchCalls).toHaveLength(1);
    for (const privateValue of [
      f.storage.directory,
      f.storage.initialized.credential.key,
      success.attempt.launchTicket,
      success.facts.candidates[0]!.candidate_id,
      success.facts.references[0]!.reference_id,
    ])
      expect(first.raw).not.toContain(privateValue);
    await success.runner.close();
    await f.restart();
    expect(await send(f, path, body)).toMatchObject({
      status: 200,
      body: { data: { receipt: expected, applied: false } },
    });
    expect(jobOf(await f.call("GET", path.replace(/\/receipt$/, "")))).toEqual(
      success.succeeded,
    );
    expect(receipts(f)).toHaveLength(1);
    expect(wakes).toBe(1);
  });

  it("rejects another receipt id, service or each result mismatch without overwriting the first row", async () => {
    const f = await fixture();
    const success = await succeed(f);
    const body = requestBody(f, success);
    const path = receiptPath(success.succeeded.jobId);
    expect((await send(f, path, body)).status).toBe(200);
    const before = receipts(f);
    const mismatches = [
      { ...body, receiptId: anotherReceiptId },
      { ...body, serviceId: anotherReceiptId },
      { ...body, result: { ...body.result, width: body.result.width + 1 } },
      { ...body, result: { ...body.result, height: body.result.height + 1 } },
      {
        ...body,
        result: { ...body.result, byteLength: body.result.byteLength + 1 },
      },
      {
        ...body,
        result: {
          ...body.result,
          sha256: body.result.sha256.replace(
            /^./,
            body.result.sha256.startsWith("0") ? "1" : "0",
          ),
        },
      },
    ];
    for (const value of mismatches) {
      expect(await send(f, path, value)).toMatchObject({
        status: 409,
        body: {
          code: "receipt_conflict",
          data: { requestId: expect.any(String) },
        },
      });
      expect(receipts(f)).toEqual(before);
    }
  });

  it("checks credentials, ownership and real success before consuming any receipt body", async () => {
    let timers = 0;
    const f = await fixture({
      receiptTimer: {
        start() {
          timers++;
          return () => {};
        },
      },
    });
    const success = await succeed(f);
    const path = receiptPath(success.succeeded.jobId);
    const waiting = jobOf(await f.upload(success.bytes, "receipt-waiting"));
    const other = createClient(f.storage.store);
    let consumedBytes = 0;
    f.server.prependListener("request", (request) => {
      if (!request.url?.endsWith("/receipt")) return;
      const read = request.read.bind(request);
      request.read = (size?: number) => {
        const value = read(size);
        if (value !== null) consumedBytes += Buffer.byteLength(value);
        return value;
      };
    });
    const cases: {
      path: string;
      headers: OutgoingHttpHeaders | readonly string[];
      status: number;
      code: string;
    }[] = [
      { path, headers: {}, status: 401, code: "authentication_failed" },
      {
        path,
        headers: ["Authorization", f.auth(), "authorization", f.auth()],
        status: 401,
        code: "authentication_failed",
      },
      {
        path,
        headers: { authorization: `Bearer ${other.key}` },
        status: 404,
        code: "job_not_found",
      },
      {
        path: receiptPath("missing"),
        headers: headersFor(f),
        status: 404,
        code: "job_not_found",
      },
      {
        path: receiptPath(waiting.jobId),
        headers: headersFor(f),
        status: 409,
        code: "result_not_ready",
      },
    ];
    for (const item of cases) {
      const response = await send(
        f,
        item.path,
        Buffer.from("unconsumed-private-body"),
        item.headers,
      );
      expect(response).toMatchObject({
        status: item.status,
        body: { code: item.code },
      });
      expect(response.raw).not.toContain("unconsumed-private-body");
    }
    await f.call("DELETE", `/v1/enhancement-jobs/${waiting.jobId}`);
    expect(
      await send(f, receiptPath(waiting.jobId), Buffer.from("ignored")),
    ).toMatchObject({
      status: 409,
      body: { code: "result_not_ready" },
    });
    expect(consumedBytes).toBe(0);
    expect(timers).toBe(0);
    expect(receipts(f)).toEqual([]);
  });

  it("rejects malformed JSON, UTF-8 and exact-body violations, then accepts fragmented valid JSON", async () => {
    const f = await fixture();
    const success = await succeed(f);
    const body = requestBody(f, success);
    const path = receiptPath(success.succeeded.jobId);
    for (const value of [
      null,
      [],
      {},
      { receiptId, result: body.result },
      { ...body, clientId: success.succeeded.clientId },
      { ...body, result: { ...body.result, width: 0 } },
      { ...body, result: { ...body.result, format: "jpeg" } },
      { ...body, result: { ...body.result, sha256: "invalid" } },
      Buffer.from("{"),
      Buffer.concat([
        Buffer.from('{"receiptId":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from(`",${JSON.stringify(body).slice(1)}`),
      ]),
      Buffer.from(`${JSON.stringify(body)} trailing-private-data`),
    ]) {
      const response = await send(f, path, value, headersFor(f), true);
      expect(response).toMatchObject({
        status: 400,
        body: { code: "invalid_request" },
      });
      expect(response.raw).not.toContain("trailing-private-data");
      expect(receipts(f)).toEqual([]);
    }
    const fragmented = Buffer.from(
      `{"receiptId":"家居产品",${JSON.stringify(body).slice(1)}`,
    );
    expect(
      await send(
        f,
        path,
        fragmented,
        {
          ...headersFor(f),
          "content-type": "Application/JSON; Charset=UTF-8",
          "content-encoding": "identity",
        },
        true,
      ),
    ).toMatchObject({ status: 200, body: { data: { applied: true } } });
  });

  it("requires unique JSON media headers and rejects compressed or unsupported forms", async () => {
    const f = await fixture();
    const success = await succeed(f);
    const body = requestBody(f, success);
    const path = receiptPath(success.succeeded.jobId);
    const cases: {
      headers: OutgoingHttpHeaders | readonly string[];
      status: number;
      code: string;
    }[] = [
      {
        headers: { authorization: f.auth() },
        status: 400,
        code: "invalid_request",
      },
      {
        headers: [
          "Authorization",
          f.auth(),
          "Content-Type",
          "application/json",
          "content-type",
          "application/json",
        ],
        status: 400,
        code: "invalid_request",
      },
      ...[
        "text/plain",
        "application/json; charset=utf-16",
        "application/json; version=1",
        "application/json; charset=utf-8; charset=utf-8",
      ].map((type) => ({
        headers: { ...headersFor(f), "content-type": type },
        status: 415,
        code: "unsupported_media_type",
      })),
      {
        headers: { ...headersFor(f), "content-encoding": "gzip" },
        status: 415,
        code: "unsupported_media_type",
      },
    ];
    for (const item of cases)
      expect(await send(f, path, body, item.headers)).toMatchObject({
        status: item.status,
        body: { code: item.code },
      });
    expect(receipts(f)).toEqual([]);
  });

  it("prechecks declared size before Continue and counts raw chunked bytes at the exact configured boundary", async () => {
    const f = await fixture();
    const success = await succeed(f);
    const body = requestBody(f, success);
    const path = receiptPath(success.succeeded.jobId);
    const declared = f.start("POST", path, {
      ...headersFor(f),
      expect: "100-continue",
      "content-length": receiptLimits.maxReceiptBytes + 1,
    });
    let continued = 0;
    declared.req.on("continue", () => {
      continued++;
    });
    declared.req.flushHeaders();
    expect(await declared.result).toMatchObject({
      status: 413,
      body: { code: "budget_exceeded" },
    });
    declared.req.destroy();
    expect(continued).toBe(0);
    expect(receipts(f)).toEqual([]);
    for (const difference of [-1, 0, 1]) {
      const bytes = Buffer.from(
        JSON.stringify(body).padEnd(
          receiptLimits.maxReceiptBytes + difference,
          " ",
        ),
      );
      expect(bytes.length).toBe(receiptLimits.maxReceiptBytes + difference);
      const response = await send(f, path, bytes, headersFor(f), true);
      expect(response).toMatchObject(
        difference > 0
          ? { status: 413, body: { code: "budget_exceeded" } }
          : {
              status: 200,
              body: { code: "ok", data: { applied: difference === -1 } },
            },
      );
      expect(receipts(f)).toHaveLength(1);
    }
  });

  it("sends Continue only after authenticated receipt prechecks pass", async () => {
    const f = await fixture();
    const success = await succeed(f);
    const body = Buffer.from(JSON.stringify(requestBody(f, success)));
    const path = receiptPath(success.succeeded.jobId);
    for (const accepted of [false, true]) {
      const connection = f.start("POST", path, {
        ...(accepted ? headersFor(f) : { "content-type": "application/json" }),
        expect: "100-continue",
        "content-length": body.length,
      });
      let continued = 0;
      connection.req.on("continue", () => {
        continued++;
        connection.req.end(body);
      });
      connection.req.flushHeaders();
      expect(await connection.result).toMatchObject({
        status: accepted ? 200 : 401,
      });
      expect(continued).toBe(accepted ? 1 : 0);
      connection.req.destroy();
    }
    expect(receipts(f)).toHaveLength(1);
  });
});

describe("HTTP receipt lifecycle ends before commit unless already durable", () => {
  it("keeps receipt capacity independent from upload and result download and releases it after response closure", async () => {
    const clock = receiptClock();
    const f = await fixture({ receiptTimer: clock.timer });
    const success = await succeed(f);
    const body = requestBody(f, success);
    const path = receiptPath(success.succeeded.jobId);
    const bytes = Buffer.from(JSON.stringify(body));
    const held = f.start("POST", path, {
      ...headersFor(f),
      "content-length": bytes.length,
    });
    held.req.flushHeaders();
    await reached(clock.started, held.result);
    expect(clock.deadlines).toEqual([receiptLimits.requestTimeoutMs]);
    expect(await send(f, path, body)).toMatchObject({
      status: 429,
      body: { code: "receipt_capacity_exceeded" },
    });
    expect(clock.pending.size).toBe(1);
    expect(
      (await f.upload(success.bytes, "receipt-held-independent-upload")).status,
    ).toBe(202);
    const download = await requestBinary(
      f,
      path.replace(/\/receipt$/, "/result"),
    );
    expect(download.status).toBe(200);
    expect(download.bytes).toEqual(success.png);
    expect(receipts(f)).toEqual([]);
    held.req.end(bytes);
    expect(await held.result).toMatchObject({
      status: 200,
      body: { data: { applied: true } },
    });
    await clock.cancelled;
    expect(clock.pending.size).toBe(0);
    expect(await send(f, path, body)).toMatchObject({
      status: 200,
      body: { data: { applied: false } },
    });
  });

  it.each(["timeout", "disconnect"] as const)(
    "never commits a partial body after %s and frees its exact receiver slot",
    async (mode) => {
      const clock = receiptClock();
      const f = await fixture({ receiptTimer: clock.timer });
      const success = await succeed(f);
      const body = requestBody(f, success);
      const path = receiptPath(success.succeeded.jobId);
      const bytes = Buffer.from(JSON.stringify(body));
      const connection = f.start("POST", path, {
        ...headersFor(f),
        "content-length": bytes.length,
      });
      connection.req.write(bytes.subarray(0, 1));
      await reached(clock.started, connection.result);
      if (mode === "timeout") {
        clock.fire();
        connection.req.end(bytes.subarray(1));
        expect(await connection.result).toMatchObject({
          status: 408,
          body: {
            code: "receipt_timeout",
            data: { requestId: expect.any(String) },
          },
        });
      } else {
        connection.req.destroy();
        await expect(connection.result).rejects.toBeDefined();
      }
      await clock.cancelled;
      expect(clock.cancellations()).toBe(1);
      expect(clock.pending.size).toBe(0);
      expect(receipts(f)).toEqual([]);
      expect(await send(f, path, body)).toMatchObject({
        status: 200,
        body: { data: { applied: true } },
      });
      expect(receipts(f)).toHaveLength(1);
    },
  );

  it.each(["finish", "timeout"] as const)(
    "retains a committed receipt's slot and total deadline until slow response %s",
    async (mode) => {
      const clock = receiptClock();
      const f = await fixture({ receiptTimer: clock.timer });
      const success = await succeed(f);
      const body = requestBody(f, success);
      const path = receiptPath(success.succeeded.jobId);
      const endHeld = deferred<() => void>();
      let selected = false;
      let response: ServerResponse | undefined;
      const statuses: number[] = [];
      f.server.prependListener("request", (request, outgoing) => {
        if (selected || request.url !== path) return;
        selected = true;
        response = outgoing;
        const nativeWriteHead = outgoing.writeHead;
        vi.spyOn(outgoing, "writeHead").mockImplementation(function (...args) {
          statuses.push(args[0]);
          return Reflect.apply(nativeWriteHead, outgoing, args);
        });
        const nativeEnd = outgoing.end;
        let held = false;
        vi.spyOn(outgoing, "end").mockImplementation(function (...args) {
          if (!held && outgoing.statusCode === 200) {
            held = true;
            let resumed = false;
            endHeld.resolve(() => {
              if (resumed || outgoing.destroyed || outgoing.writableEnded)
                return;
              resumed = true;
              Reflect.apply(nativeEnd, outgoing, args);
            });
            return outgoing;
          }
          return Reflect.apply(nativeEnd, outgoing, args);
        });
      });
      const pending = send(f, path, body);
      const finish = await reached(endHeld.promise, pending);
      assert.ok(response);
      expect(response.writableFinished).toBe(false);
      expect(receipts(f)).toHaveLength(1);
      expect(clock.pending.size).toBe(1);
      expect([...clock.pending.values()]).toEqual([
        receiptLimits.requestTimeoutMs,
      ]);
      expect(await send(f, path, body)).toMatchObject({
        status: 429,
        body: { code: "receipt_capacity_exceeded" },
      });
      if (mode === "finish") {
        finish();
        expect(await pending).toMatchObject({
          status: 200,
          body: { data: { applied: true } },
        });
      } else {
        clock.fire();
        await expect(pending).rejects.toBeDefined();
      }
      await clock.cancelled;
      expect(statuses).toEqual([200]);
      expect(clock.cancellations()).toBe(1);
      expect(clock.pending.size).toBe(0);
      expect(receipts(f)).toHaveLength(1);
      expect(await send(f, path, body)).toMatchObject({
        status: 200,
        body: { data: { applied: false } },
      });
    },
  );

  it.each(["credential", "store"] as const)(
    "rechecks %s after a synchronous receiver pause before calling the durable command",
    async (mode) => {
      const clock = receiptClock();
      const f = await fixture({ receiptTimer: clock.timer });
      const success = await succeed(f);
      const body = requestBody(f, success);
      const path = receiptPath(success.succeeded.jobId);
      const principal = f.storage.principal();
      const acknowledge = vi.spyOn(f.storage.store, "acknowledgeResult");
      let retirements = 0;
      f.server.prependListener("request", (request) => {
        if (request.url !== path) return;
        request.once("pause", () => {
          retirements++;
          if (mode === "credential")
            revokeCredential(f.storage.store, principal.credentialId);
          else f.storage.store.close();
        });
      });
      expect(await send(f, path, body)).toMatchObject({
        status: mode === "credential" ? 401 : 503,
        body: {
          code:
            mode === "credential" ? "authentication_failed" : "internal_error",
        },
      });
      expect(clock.deadlines).toEqual([receiptLimits.requestTimeoutMs]);
      expect(retirements).toBe(1);
      expect(acknowledge).not.toHaveBeenCalled();
      expect(receipts(f)).toEqual([]);
      expect(clock.pending.size).toBe(0);
    },
  );

  it("returns a complete 408 when timer.start fires synchronously without reading or acknowledging the body", async () => {
    const deadlines: number[] = [];
    let cancellations = 0;
    const f = await fixture({
      receiptTimer: {
        start(callback, milliseconds) {
          deadlines.push(milliseconds);
          callback();
          return () => {
            cancellations++;
          };
        },
      },
    });
    const success = await succeed(f);
    const body = requestBody(f, success);
    const path = receiptPath(success.succeeded.jobId);
    const acknowledge = vi.spyOn(f.storage.store, "acknowledgeResult");
    let consumedBytes = 0;
    f.server.prependListener("request", (request) => {
      if (request.url !== path) return;
      const read = request.read.bind(request);
      request.read = (size?: number) => {
        const value = read(size);
        if (value !== null) consumedBytes += Buffer.byteLength(value);
        return value;
      };
    });
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await send(f, path, body)).toMatchObject({
        status: 408,
        body: {
          code: "receipt_timeout",
          data: { requestId: expect.any(String) },
        },
      });
    expect(deadlines).toEqual([
      receiptLimits.requestTimeoutMs,
      receiptLimits.requestTimeoutMs,
    ]);
    expect(cancellations).toBe(2);
    expect(consumedBytes).toBe(0);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(receipts(f)).toEqual([]);
  });

  it("recovers an already committed receipt after its real TCP response is lost", async () => {
    const f = await fixture();
    const success = await succeed(f);
    const body = requestBody(f, success);
    const path = receiptPath(success.succeeded.jobId);
    const original = f.storage.store.acknowledgeResult.bind(f.storage.store);
    const committed = deferred<ReturnType<typeof original>>();
    let response: ServerResponse | undefined;
    f.server.prependListener("request", (request, outgoing) => {
      if (request.url === path) response = outgoing;
    });
    const acknowledge = vi
      .spyOn(f.storage.store, "acknowledgeResult")
      .mockImplementation((principal, jobId, value, signal) => {
        const outcome = original(principal, jobId, value, signal);
        assert.ok(response);
        response.destroy();
        committed.resolve(outcome);
        return outcome;
      });
    const pending = send(f, path, body);
    const outcome = await reached(committed.promise, pending);
    expect(outcome.applied).toBe(true);
    await expect(pending).rejects.toBeDefined();
    expect(receipts(f)).toHaveLength(1);
    acknowledge.mockRestore();
    expect(await send(f, path, body)).toMatchObject({
      status: 200,
      body: { data: { receipt: outcome.receipt, applied: false } },
    });
    expect(receipts(f)).toHaveLength(1);
    expect(success.executor.launchCalls).toHaveLength(1);
  });
});

it.each(["credential", "store"] as const)(
  "rejects %s retired synchronously by timer.start before consuming the receipt",
  async (mode) => {
    let retire = () => {};
    let starts = 0;
    let cancellations = 0;
    const f = await fixture({
      receiptTimer: {
        start() {
          starts++;
          retire();
          return () => {
            cancellations++;
          };
        },
      },
    });
    const success = await succeed(f);
    const body = requestBody(f, success);
    const path = receiptPath(success.succeeded.jobId);
    const principal = f.storage.principal();
    retire = () => {
      if (mode === "credential")
        revokeCredential(f.storage.store, principal.credentialId);
      else f.storage.store.close();
    };
    const acknowledge = vi.spyOn(f.storage.store, "acknowledgeResult");
    let consumedBytes = 0;
    f.server.prependListener("request", (request) => {
      if (request.url !== path) return;
      const read = request.read.bind(request);
      request.read = (size?: number) => {
        const value = read(size);
        if (value !== null) consumedBytes += Buffer.byteLength(value);
        return value;
      };
    });
    expect(await send(f, path, body)).toMatchObject({
      status: mode === "credential" ? 401 : 503,
      body: {
        code:
          mode === "credential" ? "authentication_failed" : "internal_error",
      },
    });
    expect(starts).toBe(1);
    expect(cancellations).toBe(1);
    expect(consumedBytes).toBe(0);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(receipts(f)).toEqual([]);
  },
);
