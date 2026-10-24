import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  localArtifactFiles,
  type ArtifactFile,
  type ArtifactWork,
} from "../src/artifacts.js";
import {
  EnhancementError,
  type EnhancementErrorCode,
  type FixedSelfTestSnapshot,
} from "../src/contracts.js";
import { authenticate, type IssuedCredential } from "../src/credentials.js";
import { localUploadFiles, type UploadTimer } from "../src/http.js";
import { localInputFiles } from "../src/jobs.js";
import {
  deferred,
  httpFixture,
  jobOf,
  manualUploadTimer,
  multipart,
  uploadParts,
  type HttpResult,
} from "./http-fixtures.js";
import {
  requestBinary,
  succeededThroughRunner,
  type BinaryHttpResult,
  type ResultHttpFixture,
} from "./result-http-fixtures.js";
import { sourceImage } from "./storage-fixtures.js";

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
const fileCleanups: (() => Promise<void>)[] = [];
const pending: Promise<unknown>[] = [];

afterEach(async () => {
  for (const retire of retirements.splice(0)) retire();
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  for (const cleanup of fileCleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: Parameters<typeof httpFixture>[0] = {}) {
  const f = await httpFixture(options);
  retirements.push(() => f.server.closeAllConnections());
  cleanups.push(() => f.cleanup());
  return f;
}

function ownerOf(server: Server): FileIoOwner {
  const owner: unknown = Reflect.get(server, "fileIo");
  const usable =
    owner !== null &&
    (typeof owner === "object" || typeof owner === "function");
  expect(usable, "the real Server exposes its original file I/O owner").toBe(
    true,
  );
  if (!usable) return expect.fail("Server.fileIo is absent");
  expect(
    typeof Reflect.get(owner, "sealFileIo") === "function",
    "the original owner exposes sealFileIo",
  ).toBe(true);
  expect(
    typeof Reflect.get(owner, "activity") === "function",
    "the original owner exposes synchronous activity",
  ).toBe(true);
  return owner as FileIoOwner;
}

function expectActivity(owner: FileIoOwner, expected: Activity) {
  const value = owner.activity();
  expect(Object.isFrozen(value), "activity is a frozen snapshot").toBe(true);
  expect(
    isDeepStrictEqual(value, expected),
    "activity contains exactly the four safe fields and real current counts",
  ).toBe(true);
  return value;
}

function expectError(
  result: HttpResult | BinaryHttpResult,
  code: EnhancementErrorCode,
  f: ResultHttpFixture,
  extraKeys: readonly string[] = [],
) {
  const failure = new EnhancementError(code);
  expect(result.status).toBe(failure.status);
  const raw = "raw" in result ? result.raw : result.bytes.toString("utf8");
  for (const value of [
    f.storage.directory,
    f.storage.initialized.credential.key,
    ...extraKeys,
  ])
    expect(
      raw.includes(JSON.stringify(value).slice(1, -1)),
      "error contains no private value",
    ).toBe(false);
  let body: HttpResult["body"];
  if ("body" in result) body = result.body;
  else {
    try {
      body = JSON.parse(raw) as HttpResult["body"];
    } catch {
      return expect.fail(
        "error response must contain the original JSON envelope",
      );
    }
  }
  const requestId: unknown = body?.data?.requestId;
  expect(typeof requestId === "string", "error requestId is a string").toBe(
    true,
  );
  expect(
    isDeepStrictEqual(body, {
      code,
      data: { requestId },
      msg: failure.message,
    }),
    "error retains the original sanitized envelope",
  ).toBe(true);
}

function track<T>(promise: Promise<T>) {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

async function reached<T>(barrier: Promise<T>, result: Promise<unknown>) {
  const outcome = await Promise.race([
    barrier.then((value) => ({ kind: "boundary" as const, value })),
    result.then(
      () => ({ kind: "response" as const }),
      () => ({ kind: "rejection" as const }),
    ),
  ]);
  if (outcome.kind === "boundary") return outcome.value;
  return expect.fail(`real lifecycle boundary was preceded by ${outcome.kind}`);
}

function observeResponse(
  f: ResultHttpFixture,
  path: string,
  intercept?: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const observed = deferred<{
    request: IncomingMessage;
    response: ServerResponse;
    finished: Promise<void>;
    closed: Promise<void>;
  }>();
  let selected = false;
  const observe = (request: IncomingMessage, response: ServerResponse) => {
    if (selected || request.url !== path) return;
    selected = true;
    const finished = deferred();
    const closed = deferred();
    response.once("finish", () => finished.resolve());
    response.once("close", () => closed.resolve());
    intercept?.(request, response);
    observed.resolve({
      request,
      response,
      finished: finished.promise,
      closed: closed.promise,
    });
  };
  f.server.prependListener("request", observe);
  f.server.prependListener("checkContinue", observe);
  f.server.prependListener("checkExpectation", observe);
  return observed.promise;
}

function holdResponseEnd(
  response: ServerResponse,
  held: ReturnType<typeof deferred<() => void>>,
) {
  const nativeEnd = response.end;
  let selected = false;
  vi.spyOn(response, "end").mockImplementation(function (...args) {
    if (!selected && response.statusCode === 200) {
      selected = true;
      let resumed = false;
      const finish = () => {
        if (resumed || response.destroyed || response.writableEnded) return;
        resumed = true;
        Reflect.apply(nativeEnd, response, args);
      };
      releases.push(finish);
      held.resolve(finish);
      return response;
    }
    return Reflect.apply(nativeEnd, response, args);
  });
}

function heldArtifactFiles() {
  const opened = deferred();
  const allowOpen = deferred();
  const closing = deferred();
  const allowClose = deferred();
  let issued: Promise<ArtifactFile> | undefined;
  releases.push(() => {
    allowOpen.resolve();
    allowClose.resolve();
  });
  fileCleanups.push(async () => {
    if (issued) {
      const [outcome] = await Promise.allSettled([issued]);
      if (outcome?.status === "fulfilled") await outcome.value.close();
    }
  });
  return {
    opened: opened.promise,
    closing: closing.promise,
    releaseOpen: () => allowOpen.resolve(),
    releaseClose: () => allowClose.resolve(),
    files: {
      ...localArtifactFiles,
      async open(
        path: string,
        flags: Parameters<typeof localArtifactFiles.open>[1],
        mode?: number,
      ) {
        if (issued) return localArtifactFiles.open(path, flags, mode);
        issued = localArtifactFiles.open(path, flags, mode);
        const original = await issued;
        opened.resolve();
        await allowOpen.promise;
        return {
          stat: () => original.stat(),
          read: (...args: Parameters<ArtifactFile["read"]>) =>
            original.read(...args),
          write: (...args: Parameters<ArtifactFile["write"]>) =>
            original.write(...args),
          sync: () => original.sync(),
          async close() {
            await original.close();
            closing.resolve();
            await allowClose.promise;
          },
        };
      },
    },
  };
}

const succeed = (f: ResultHttpFixture) =>
  succeededThroughRunner(f, (cleanup) => cleanups.push(cleanup));

function receiptBytes(
  f: ResultHttpFixture,
  success: Awaited<ReturnType<typeof succeededThroughRunner>>,
) {
  return Buffer.from(
    JSON.stringify({
      serviceId: f.storage.store.identity.serviceId,
      receiptId: "12345678-9abc-4def-8123-456789abcdef",
      result: success.succeeded.result,
    }),
  );
}

describe("HTTP original file I/O owner maintenance seal", () => {
  it("shares the original callable handler methods, returns frozen read-only activity and seals once without closing", async () => {
    const create = vi.fn(localUploadFiles.createDirectory);
    const open = vi.fn(localArtifactFiles.open);
    const write = vi.fn(localInputFiles.write);
    const f = await fixture({
      uploadFiles: { ...localUploadFiles, createDirectory: create },
      resultFiles: { ...localArtifactFiles, open },
      inputFiles: { ...localInputFiles, write },
    });
    const clock = vi.spyOn(f.storage, "clock");
    await f.restart();
    const owner = ownerOf(f.server);
    const handler = f.server.listeners("request")[0];
    expect(owner.pendingRequests()).toBe(0);
    expect(Reflect.get(owner, "pendingRequests") === Reflect.get(handler!, "pendingRequests")).toBe(true);
    expect(
      typeof handler === "function",
      "the listener is still callable",
    ).toBe(true);
    expect(
      Reflect.get(owner, "sealFileIo") === Reflect.get(handler!, "sealFileIo"),
      "Server and handler share the original seal method",
    ).toBe(true);
    expect(
      Reflect.get(owner, "activity") === Reflect.get(handler!, "activity"),
      "Server and handler share the original activity method",
    ).toBe(true);
    expect(f.server.listeners("checkContinue")[0] === handler).toBe(true);
    expect(f.server.listeners("checkExpectation")[0] === handler).toBe(true);
    const property = Object.getOwnPropertyDescriptor(f.server, "fileIo");
    expect(property?.configurable === false).toBe(true);
    expect(
      Reflect.set(f.server, "fileIo", {}),
      "fileIo cannot be replaced",
    ).toBe(false);
    expect(Object.isFrozen(f.server)).toBe(false);
    const now = vi.spyOn(f.storage.store, "now");
    const principal = vi.spyOn(f.storage.store, "assertPrincipal");
    const lookup = vi.spyOn(f.storage.store, "findByKey");
    const store = f.storage.store as typeof f.storage.store & {
      inspectMaintenance(): unknown;
    };
    const inspection =
      typeof Reflect.get(store, "inspectMaintenance") === "function"
        ? vi.spyOn(store, "inspectMaintenance")
        : undefined;
    clock.mockClear();
    const before = expectActivity(owner, idle);
    expect(Reflect.set(before, "uploads", 999)).toBe(false);
    expect(owner.sealFileIo() === undefined).toBe(true);
    owner.sealFileIo();
    expectActivity(owner, sealedIdle);
    expect(before.sealed).toBe(false);
    expect(f.server.listening).toBe(true);
    expect(f.storage.store.closed).toBe(false);
    for (const calls of [clock, now, principal, lookup, create, open, write])
      expect(calls.mock.calls.length).toBe(0);
    if (inspection) expect(inspection.mock.calls.length).toBe(0);
  });

  it("rejects all new file work including an Expect replay while retaining metadata, credentials, authentication and self-test wiring", async () => {
    const create = vi.fn(localUploadFiles.createDirectory);
    const open = vi.fn(localArtifactFiles.open);
    const write = vi.fn(localInputFiles.write);
    const receiptTimer = manualUploadTimer();
    const diagnostic: FixedSelfTestSnapshot = Object.freeze({
      bootId: "11111111-1111-4111-8111-111111111111",
      assetId: "zeb-enhancement-calibration-v1",
      phase: "not_started",
      jobId: null,
      reason: null,
      output: null,
      qualification: "unknown",
    });
    const selfTest = Object.freeze({
      start: vi.fn(async () => diagnostic),
      query: vi.fn(async () => diagnostic),
    });
    const f = await fixture({
      uploadFiles: { ...localUploadFiles, createDirectory: create },
      resultFiles: { ...localArtifactFiles, open },
      inputFiles: { ...localInputFiles, write },
      receiptTimer,
      selfTest,
    });
    const owner = ownerOf(f.server);
    const success = await succeed(f);
    await success.runner.close();
    const queued = jobOf(await f.upload(success.bytes, "maintenance-metadata"));
    const created = create.mock.calls.length;
    const written = write.mock.calls.length;
    const acquire = vi.spyOn(f.storage.store, "acquireArtifactWork");
    const acknowledge = vi.spyOn(f.storage.store, "acknowledgeResult");
    owner.sealFileIo();
    const body = multipart(uploadParts(success.bytes));
    const replay = f.start("POST", "/v1/enhancement-jobs", {
      ...f.uploadHeaders("artifact-http-first"),
      expect: "100-continue",
      "content-length": body.length,
    });
    let continued = 0;
    replay.req.on("continue", () => {
      continued++;
      replay.req.end(body);
    });
    replay.req.flushHeaders();
    expectError(await replay.result, "not_ready", f);
    replay.req.destroy();
    expect(continued).toBe(0);
    const base = `/v1/enhancement-jobs/${success.succeeded.jobId}`;
    expectError(await requestBinary(f, `${base}/result`), "not_ready", f);
    expectError(
      await f.call("POST", `${base}/receipt`, receiptBytes(f, success), {
        authorization: f.auth(),
        "content-type": "application/json",
      }),
      "not_ready",
      f,
    );
    expect(create.mock.calls.length).toBe(created);
    expect(write.mock.calls.length).toBe(written);
    expect(open.mock.calls.length).toBe(0);
    expect(acquire.mock.calls.length).toBe(0);
    expect(acknowledge.mock.calls.length).toBe(0);
    expect(receiptTimer.pending.size).toBe(0);
    expectActivity(owner, sealedIdle);
    expect((await f.call("GET", "/healthz")).status).toBe(200);
    const capabilities = await f.call("GET", "/v1/capabilities");
    expect(capabilities.body?.data?.ready === false).toBe(true);
    expect(capabilities.body?.data?.reason === "runner_unavailable").toBe(true);
    const metadata = await f.call(
      "GET",
      `/v1/enhancement-jobs/${queued.jobId}`,
    );
    expect(isDeepStrictEqual(metadata.body?.data?.job, queued)).toBe(true);
    const cancelled = await f.call(
      "DELETE",
      `/v1/enhancement-jobs/${queued.jobId}`,
    );
    expect(cancelled.status).toBe(200);
    expect(jobOf(cancelled).status === "cancelled").toBe(true);
    expect(
      f.storage.store.getOwned(f.storage.principal(), success.succeeded.jobId)
        .status === "succeeded",
    ).toBe(true);
    const issued = await f.call("POST", "/v1/credentials");
    expect(issued.status).toBe(200);
    const next = issued.body.data.credential as IssuedCredential;
    expect(typeof next?.key === "string").toBe(true);
    expect(
      authenticate(f.storage.store, `Bearer ${next.key}`).clientId ===
        f.storage.initialized.credential.clientId,
    ).toBe(true);
    const revoked = await f.call(
      "DELETE",
      "/v1/credentials/current",
      undefined,
      {
        authorization: `Bearer ${next.key}`,
      },
    );
    expect(revoked.status).toBe(200);
    expect(isDeepStrictEqual(revoked.body?.data, { revoked: true })).toBe(true);
    expectError(
      await f.call("GET", "/healthz", undefined, {
        authorization: `Bearer ${next.key}`,
      }),
      "authentication_failed",
      f,
      [next.key],
    );
    expectError(
      await requestBinary(f, `${base}/result`, {}),
      "authentication_failed",
      f,
    );
    for (const [method, status] of [
      ["POST", 202],
      ["GET", 200],
    ] as const) {
      const result = await f.call(method, "/v1/self-test");
      expect(result.status).toBe(status);
      expect(isDeepStrictEqual(result.body?.data, diagnostic)).toBe(true);
    }
    expect(selfTest.start.mock.calls.length).toBe(1);
    expect(selfTest.query.mock.calls.length).toBe(1);
    expectActivity(owner, sealedIdle);
  }, 15_000);

  it.each(["download", "receipt"] as const)(
    "rechecks the seal after %s timer.start reenters before actual file or receiver work",
    async (kind) => {
      let owner: FileIoOwner | undefined;
      let reserved: Activity | undefined;
      const manual = manualUploadTimer();
      const timer: UploadTimer = {
        start(callback, milliseconds) {
          const cancel = manual.start(callback, milliseconds);
          reserved = owner!.activity();
          owner!.sealFileIo();
          return cancel;
        },
      };
      const open = vi.fn(localArtifactFiles.open);
      const f = await fixture({
        resultFiles: { ...localArtifactFiles, open },
        ...(kind === "download"
          ? { downloadTimer: timer }
          : { receiptTimer: timer }),
      });
      owner = ownerOf(f.server);
      const success = await succeed(f);
      const suffix = kind === "download" ? "result" : "receipt";
      const path = `/v1/enhancement-jobs/${success.succeeded.jobId}/${suffix}`;
      const acquire = vi.spyOn(f.storage.store, "acquireArtifactWork");
      const acknowledge = vi.spyOn(f.storage.store, "acknowledgeResult");
      let receiverListeners = 0;
      const observed = observeResponse(f, path, (request) => {
        const on = request.on;
        vi.spyOn(request, "on").mockImplementation(function (event, listener) {
          if ((event as string) === "data") receiverListeners++;
          return Reflect.apply(on, request, [event, listener]);
        });
      });
      let continued = 0;
      if (kind === "download") {
        expectError(await track(requestBinary(f, path)), "not_ready", f);
      } else {
        const bytes = receiptBytes(f, success);
        const connection = f.start("POST", path, {
          authorization: f.auth(),
          "content-type": "application/json",
          expect: "100-continue",
          "content-length": bytes.length,
        });
        connection.req.on("continue", () => {
          continued++;
          connection.req.end(bytes);
        });
        connection.req.flushHeaders();
        expectError(await connection.result, "not_ready", f);
        connection.req.destroy();
      }
      await (
        await observed
      ).closed;
      expect(
        isDeepStrictEqual(reserved, {
          ...idle,
          downloads: kind === "download" ? 1 : 0,
          receipts: kind === "receipt" ? 1 : 0,
        }),
        "the original lifecycle was reserved before the timer callback",
      ).toBe(true);
      expect(open.mock.calls.length).toBe(0);
      expect(acquire.mock.calls.length).toBe(0);
      expect(acknowledge.mock.calls.length).toBe(0);
      expect(receiverListeners).toBe(0);
      expect(continued).toBe(0);
      expect(manual.pending.size).toBe(0);
      expectActivity(owner, sealedIdle);
    },
    15_000,
  );

  it("retains an already receiving upload through real spool cleanup and starts no submit after seal", async () => {
    const read = deferred();
    const allowRead = deferred();
    const cleaning = deferred();
    const allowCleanup = deferred();
    releases.push(() => {
      allowRead.resolve();
      allowCleanup.resolve();
    });
    const mkdir = vi.fn(localInputFiles.mkdir);
    const timer = manualUploadTimer();
    const f = await fixture({
      uploadTimer: timer,
      uploadFiles: {
        ...localUploadFiles,
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
    const upload = track(
      f.upload(await sourceImage(), "receiving-before-seal"),
    );
    await reached(read.promise, upload);
    expectActivity(owner, { ...idle, uploads: 1 });
    owner.sealFileIo();
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
    expectError(await upload, "not_ready", f);
    expect(mkdir.mock.calls.length).toBe(0);
    expect(accept.mock.calls.length).toBe(0);
    expect(isDeepStrictEqual(await f.inputNames(), [])).toBe(true);
    expectActivity(owner, sealedIdle);
  }, 15_000);

  it("keeps an issued submit counted until its real input cleanup returns after seal rejects COMMIT", async () => {
    const writing = deferred();
    const allowWrite = deferred();
    const removing = deferred();
    const allowRemove = deferred();
    releases.push(() => {
      allowWrite.resolve();
      allowRemove.resolve();
    });
    let writes = 0;
    const f = await fixture({
      inputFiles: {
        ...localInputFiles,
        async write(path, bytes) {
          await localInputFiles.write(path, bytes);
          if (++writes === 1) {
            writing.resolve();
            await allowWrite.promise;
          }
        },
        async remove(path) {
          await localInputFiles.remove(path);
          removing.resolve();
          await allowRemove.promise;
        },
      },
    });
    const owner = ownerOf(f.server);
    const key = "submit-before-seal";
    const upload = track(f.upload(await sourceImage(), key));
    await reached(writing.promise, upload);
    expectActivity(owner, { ...idle, uploads: 1 });
    owner.sealFileIo();
    expectActivity(owner, { ...sealedIdle, uploads: 1 });
    expect(f.storage.store.closed).toBe(false);
    allowWrite.resolve();
    await reached(removing.promise, upload);
    expectActivity(owner, { ...sealedIdle, uploads: 1 });
    expect(
      f.storage.store.findByKey(f.storage.principal(), key) === undefined,
    ).toBe(true);
    expect(isDeepStrictEqual(await f.inputNames(), [])).toBe(true);
    allowRemove.resolve();
    expectError(await upload, "not_ready", f);
    expectActivity(owner, sealedIdle);
  }, 15_000);

  it("rechecks seal after options.ready synchronously reenters at the original final COMMIT gate", async () => {
    let owner: FileIoOwner | undefined;
    const ready = vi.fn(() => {
      owner?.sealFileIo();
      return true;
    });
    const f = await fixture({ ready });
    owner = ownerOf(f.server);
    const key = "ready-reentrant-seal";
    expectError(await f.upload(await sourceImage(), key), "not_ready", f);
    expect(ready.mock.calls.length).toBe(1);
    expect(
      f.storage.store.findByKey(f.storage.principal(), key) === undefined,
    ).toBe(true);
    expect(isDeepStrictEqual(await f.inputNames(), [])).toBe(true);
    expectActivity(owner, sealedIdle);
    const calls = ready.mock.calls.length;
    const capabilities = await f.call("GET", "/v1/capabilities");
    expect(capabilities.body?.data?.ready === false).toBe(true);
    expect(ready.mock.calls.length).toBe(calls);
  }, 15_000);

  it.each(["late reader", "slow response"] as const)(
    "retains the real download count and reference boundary for a %s after seal",
    async (mode) => {
      const files = heldArtifactFiles();
      const timer = manualUploadTimer();
      const f = await fixture({
        downloadTimer: timer,
        ...(mode === "late reader" ? { resultFiles: files.files } : {}),
      });
      const owner = ownerOf(f.server);
      const success = await succeed(f);
      const acquire = vi.spyOn(f.storage.store, "acquireArtifactWork");
      const release = vi.spyOn(f.storage.store, "releaseArtifactReference");
      const path = `/v1/enhancement-jobs/${success.succeeded.jobId}/result`;
      const endHeld = deferred<() => void>();
      const observed = observeResponse(f, path, (_request, response) => {
        if (mode === "slow response") holdResponseEnd(response, endHeld);
      });
      if (mode === "late reader") {
        const connection = f.start("GET", path, { authorization: f.auth() });
        track(connection.result);
        connection.req.end();
        await reached(files.opened, connection.result);
        const response = await observed;
        const work = acquire.mock.results[0]?.value as ArtifactWork;
        expect(work !== undefined).toBe(true);
        expectActivity(owner, { ...idle, downloads: 1 });
        owner.sealFileIo();
        expect(response.response.destroyed).toBe(false);
        connection.req.destroy();
        await response.closed;
        expectActivity(owner, { ...sealedIdle, downloads: 1 });
        expect(f.storage.store.readArtifactReference(work.key) === "held").toBe(
          true,
        );
        expect(release.mock.calls.length).toBe(0);
        expect(timer.pending.size).toBe(1);
        files.releaseOpen();
        await files.closing;
        expectActivity(owner, { ...sealedIdle, downloads: 1 });
        expect(f.storage.store.readArtifactReference(work.key) === "held").toBe(
          true,
        );
        expect(release.mock.calls.length).toBe(0);
        files.releaseClose();
        await vi.waitFor(() => expectActivity(owner, sealedIdle));
        expect(
          f.storage.store.readArtifactReference(work.key) === "released",
        ).toBe(true);
        expect(release.mock.calls.length).toBe(1);
      } else {
        const reading = track(requestBinary(f, path));
        const finish = await reached(endHeld.promise, reading);
        const response = await observed;
        const work = acquire.mock.results[0]?.value as ArtifactWork;
        expect(work !== undefined).toBe(true);
        expect(
          f.storage.store.readArtifactReference(work.key) === "released",
        ).toBe(true);
        expect(release.mock.calls.length).toBe(1);
        expect(response.response.writableFinished).toBe(false);
        expectActivity(owner, { ...idle, downloads: 1 });
        owner.sealFileIo();
        expectActivity(owner, { ...sealedIdle, downloads: 1 });
        finish();
        const result = await reading;
        expect(result.status).toBe(200);
        expect(result.bytes.equals(success.png)).toBe(true);
        await response.finished;
        expectActivity(owner, sealedIdle);
      }
      expect(timer.pending.size).toBe(0);
      expectActivity(owner, sealedIdle);
    },
    15_000,
  );

  it("lets an accepted partial receipt finish after seal and retains it until the real response ends", async () => {
    const started = deferred();
    const timer = manualUploadTimer();
    const f = await fixture({
      receiptTimer: {
        start(callback, milliseconds) {
          const cancel = timer.start(callback, milliseconds);
          started.resolve();
          return cancel;
        },
      },
    });
    const owner = ownerOf(f.server);
    const success = await succeed(f);
    const acknowledge = vi.spyOn(f.storage.store, "acknowledgeResult");
    const path = `/v1/enhancement-jobs/${success.succeeded.jobId}/receipt`;
    const endHeld = deferred<() => void>();
    const observed = observeResponse(f, path, (_request, response) =>
      holdResponseEnd(response, endHeld),
    );
    const bytes = receiptBytes(f, success);
    const connection = f.start("POST", path, {
      authorization: f.auth(),
      "content-type": "application/json",
      "content-length": bytes.length,
    });
    track(connection.result);
    connection.req.write(bytes.subarray(0, 1));
    await reached(started.promise, connection.result);
    expectActivity(owner, { ...idle, receipts: 1 });
    expect(acknowledge.mock.calls.length).toBe(0);
    owner.sealFileIo();
    expectActivity(owner, { ...sealedIdle, receipts: 1 });
    expect((await observed).response.destroyed).toBe(false);
    connection.req.end(bytes.subarray(1));
    const finish = await reached(endHeld.promise, connection.result);
    expect(acknowledge.mock.calls.length).toBe(1);
    expectActivity(owner, { ...sealedIdle, receipts: 1 });
    expect((await observed).response.writableFinished).toBe(false);
    expect(timer.pending.size).toBe(1);
    finish();
    const result = await connection.result;
    expect(result.status).toBe(200);
    expect(result.body?.data?.applied === true).toBe(true);
    await (
      await observed
    ).finished;
    expect(timer.pending.size).toBe(0);
    expectActivity(owner, sealedIdle);
  }, 15_000);
});
