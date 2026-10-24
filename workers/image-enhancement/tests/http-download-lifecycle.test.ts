import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  localArtifactFiles,
  type ArtifactFile,
  type ArtifactFiles,
  type ArtifactWork,
} from "../src/artifacts.js";
import { createClient, revokeCredential } from "../src/credentials.js";
import { localUploadFiles, type UploadTimer } from "../src/http.js";
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
  type BinaryHttpResult,
  type ResultHttpFixture,
} from "./result-http-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
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
  const f = await httpFixture({
    ...options,
    transportLimits: {
      ...transportLimits,
      maxConcurrentUploads: 1,
      maxConcurrentDownloads: 1,
      ...options?.transportLimits,
    },
  });
  retirements.push(() => f.server.closeAllConnections());
  cleanups.push(() => f.cleanup());
  return f;
}

const succeed = (f: ResultHttpFixture) =>
  succeededThroughRunner(f, (cleanup) => cleanups.push(cleanup));

function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => undefined);
  return promise;
}

function reached<T>(barrier: Promise<T>, result: Promise<unknown>) {
  return Promise.race([
    barrier,
    result.then(
      () => {
        throw new Error("download settled before its required real boundary");
      },
      (cause: unknown) => {
        throw new Error("download rejected before its required real boundary", {
          cause,
        });
      },
    ),
  ]);
}

function downloadClock() {
  const manual = manualUploadTimer();
  const firstCancelled = deferred();
  const clocks: { milliseconds: number; cancellations: number }[] = [];
  const timer: UploadTimer = {
    start(callback, milliseconds) {
      const clock = { milliseconds, cancellations: 0 };
      clocks.push(clock);
      const cancel = manual.start(callback, milliseconds);
      return () => {
        clock.cancellations++;
        cancel();
        if (clock === clocks[0]) firstCancelled.resolve();
      };
    },
  };
  return { ...manual, timer, clocks, firstCancelled: firstCancelled.promise };
}

function heldFirstOpen() {
  const opening = deferred();
  const returnOpen = deferred();
  const closing = deferred<ArtifactFile>();
  const returnClose = deferred();
  const closed = deferred();
  const events: string[] = [];
  let issued: Promise<ArtifactFile> | undefined;
  const files: ArtifactFiles = {
    ...localArtifactFiles,
    async open(path, flags, mode) {
      if (issued) return localArtifactFiles.open(path, flags, mode);
      events.push("open-issued");
      issued = localArtifactFiles.open(path, flags, mode);
      void issued.catch(() => undefined);
      opening.resolve();
      await returnOpen.promise;
      const original = await issued;
      events.push("open-returned");
      return {
        stat() {
          events.push("stat");
          return original.stat();
        },
        read(...args) {
          events.push("read");
          return original.read(...args);
        },
        write: (...args) => original.write(...args),
        sync: () => original.sync(),
        async close() {
          events.push("close-issued");
          closing.resolve(original);
          await returnClose.promise;
          await original.close();
          events.push("close-completed");
          closed.resolve();
        },
      };
    },
  };
  releases.push(() => {
    returnOpen.resolve();
    returnClose.resolve();
  });
  // Failed assertions must not leave the fixture's exact real descriptor open.
  fileCleanups.push(async () => {
    if (issued) {
      const [result] = await Promise.allSettled([issued]);
      if (result?.status === "fulfilled") await result.value.close();
    }
  });
  return {
    files,
    events,
    opening: opening.promise,
    closing: closing.promise,
    closed: closed.promise,
    returnOpen: () => returnOpen.resolve(),
    returnClose: () => returnClose.resolve(),
  };
}

function nextResponse(
  f: ResultHttpFixture,
  path: string,
  intercept?: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const seen = deferred<{
    request: IncomingMessage;
    response: ServerResponse;
    heads: MockInstance<ServerResponse["writeHead"]>;
    finished: Promise<void>;
    closed: Promise<void>;
  }>();
  let selected = false;
  f.server.prependListener("request", (request, response) => {
    if (selected || request.url !== path) return;
    selected = true;
    const finished = deferred();
    const closed = deferred();
    response.once("finish", () => finished.resolve());
    response.once("close", () => closed.resolve());
    const heads = vi.spyOn(response, "writeHead");
    intercept?.(request, response);
    seen.resolve({
      request,
      response,
      heads,
      finished: finished.promise,
      closed: closed.promise,
    });
  });
  return seen.promise;
}

function acquired(
  observed: MockInstance<
    ResultHttpFixture["storage"]["store"]["acquireArtifactWork"]
  >,
  index = 0,
): ArtifactWork {
  const result = observed.mock.results[index];
  assert.ok(result?.type === "return" && result.value);
  return result.value;
}

describe("HTTP result download resource ownership", () => {
  it("keeps upload and download capacity separate and checks guards before acquiring any extra ref", async () => {
    const gate = heldFirstOpen();
    const timer = downloadClock();
    const uploadCreated = deferred();
    const uploadCleaned = deferred();
    let observeUpload = false;
    const f = await fixture({
      resultFiles: gate.files,
      downloadTimer: timer.timer,
      uploadFiles: {
        ...localUploadFiles,
        async createDirectory(parent) {
          const directory = await localUploadFiles.createDirectory(parent);
          if (observeUpload) uploadCreated.resolve();
          return directory;
        },
        async removeDirectory(directory) {
          await localUploadFiles.removeDirectory(directory);
          if (observeUpload) uploadCleaned.resolve();
        },
      },
    });
    const success = await succeed(f);
    const acceptedQueued = await f.upload(
      success.bytes,
      "download-preflight-queued",
    );
    expect(acceptedQueued.status).toBe(202);
    const queued = jobOf(acceptedQueued);
    expect(queued.status).toBe("queued");
    const foreign = createClient(f.storage.store);
    const acquire = vi.spyOn(f.storage.store, "acquireArtifactWork");
    const referencesBefore = snapshot(f.storage, (db) =>
      db.prepare("SELECT * FROM artifact_references ORDER BY rowid").all(),
    );
    const path = `/v1/enhancement-jobs/${success.succeeded.jobId}/result`;

    observeUpload = true;
    const upload = f.start(
      "POST",
      "/v1/enhancement-jobs",
      f.uploadHeaders("held-upload"),
    );
    upload.req.flushHeaders();
    await reached(uploadCreated.promise, upload.result);
    const observed = nextResponse(f, path);
    const download = f.start("GET", path, { authorization: f.auth() });
    download.req.end();
    await reached(gate.opening, download.result);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(await f.upload(success.bytes, "upload-over-capacity")).toMatchObject(
      {
        status: 429,
        body: { code: "upload_capacity_exceeded" },
      },
    );
    const overCapacity = await requestBinary(f, path);
    expect(overCapacity.status).toBe(429);
    expect(JSON.parse(overCapacity.bytes.toString("utf8"))).toMatchObject({
      code: "download_capacity_exceeded",
    });

    for (const [target, headers, status, code] of [
      [path, {}, 401, "authentication_failed"],
      [path, { authorization: `Bearer ${foreign.key}` }, 404, "job_not_found"],
      [
        "/v1/enhancement-jobs/missing/result",
        { authorization: f.auth() },
        404,
        "job_not_found",
      ],
      [
        `/v1/enhancement-jobs/${queued.jobId}/result`,
        { authorization: f.auth() },
        409,
        "result_not_ready",
      ],
    ] as const) {
      const result = await requestBinary(f, target, headers);
      expect(result.status).toBe(status);
      expect(JSON.parse(result.bytes.toString("utf8"))).toMatchObject({ code });
    }
    expect(acquire).toHaveBeenCalledTimes(1);
    const references = snapshot(f.storage, (db) =>
      db.prepare("SELECT * FROM artifact_references ORDER BY rowid").all(),
    );
    expect(references).toHaveLength(referencesBefore.length + 1);
    expect(references.slice(0, referencesBefore.length)).toEqual(
      referencesBefore,
    );
    expect(timer.clocks).toEqual([
      {
        milliseconds: transportLimits.requestTimeoutMs,
        cancellations: 0,
      },
    ]);
    expect(gate.events).toEqual(["open-issued"]);

    upload.req.destroy();
    await uploadCleaned.promise;
    expect(
      (await f.upload(success.bytes, "upload-while-downloading")).status,
    ).toBe(202);
    expect((await requestBinary(f, path)).status).toBe(429);
    download.req.destroy();
    await (
      await observed
    ).closed;
    gate.returnOpen();
    await gate.closing;
    gate.returnClose();
    await gate.closed;
    await timer.firstCancelled;
    expect((await requestBinary(f, path)).bytes).toEqual(success.png);
    expect(timer.clocks.map(({ cancellations }) => cancellations)).toEqual([
      1, 1,
    ]);
    expect(timer.pending.size).toBe(0);
  });

  it.each(["disconnect", "timeout"] as const)(
    "seals a %s before a late open returns and retains the slot through real close and ref cleanup",
    async (mode) => {
      const gate = heldFirstOpen();
      const timer = downloadClock();
      const f = await fixture({
        resultFiles: gate.files,
        downloadTimer: timer.timer,
      });
      const success = await succeed(f);
      const acquire = vi.spyOn(f.storage.store, "acquireArtifactWork");
      const release = vi.spyOn(f.storage.store, "releaseArtifactReference");
      const path = `/v1/enhancement-jobs/${success.succeeded.jobId}/result`;
      const observed = nextResponse(f, path);
      const connection = f.start("GET", path, { authorization: f.auth() });
      connection.req.end();
      await reached(gate.opening, connection.result);
      const response = await observed;
      const work = acquired(acquire);
      expect(f.storage.store.readArtifactReference(work.key)).toBe("held");
      expect([...timer.pending.values()]).toEqual([
        transportLimits.requestTimeoutMs,
      ]);

      if (mode === "disconnect") {
        connection.req.destroy();
        await expect(connection.result).rejects.toBeInstanceOf(Error);
      } else {
        timer.fire();
        expect(await connection.result).toMatchObject({
          status: 408,
          body: { code: "download_timeout" },
        });
      }
      await response.closed;
      expect(response.heads.mock.calls.map(([status]) => status)).toEqual(
        mode === "timeout" ? [408] : [],
      );
      expect(release).not.toHaveBeenCalled();
      expect(timer.pending.size).toBe(1);
      expect((await requestBinary(f, path)).status).toBe(429);
      expect(acquire).toHaveBeenCalledTimes(1);

      gate.returnOpen();
      const original = await gate.closing;
      expect((await original.stat()).isFile()).toBe(true);
      expect(gate.events).toEqual([
        "open-issued",
        "open-returned",
        "close-issued",
      ]);
      expect(release).not.toHaveBeenCalled();
      expect((await requestBinary(f, path)).status).toBe(429);
      expect(timer.pending.size).toBe(1);
      expect(f.storage.store.readArtifactReference(work.key)).toBe("held");
      gate.returnClose();
      await gate.closed;
      await timer.firstCancelled;
      await expect(original.stat()).rejects.toMatchObject({ code: "EBADF" });
      expect(gate.events).toEqual([
        "open-issued",
        "open-returned",
        "close-issued",
        "close-completed",
      ]);
      expect(release).toHaveBeenCalledExactlyOnceWith(work.key);
      expect(f.storage.store.readArtifactReference(work.key)).toBe("released");
      expect(timer.pending.size).toBe(0);
      expect(timer.clocks[0]).toEqual({
        milliseconds: transportLimits.requestTimeoutMs,
        cancellations: 1,
      });
      const later = await requestBinary(f, path);
      expect(later.status).toBe(200);
      expect(later.bytes).toEqual(success.png);
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(timer.pending.size).toBe(0);
    },
  );

  it.each(["finish", "timeout"] as const)(
    "retains a completed reader's slot and total deadline until slow response %s",
    async (mode) => {
      const timer = downloadClock();
      const f = await fixture({ downloadTimer: timer.timer });
      const success = await succeed(f);
      const acquire = vi.spyOn(f.storage.store, "acquireArtifactWork");
      const release = vi.spyOn(f.storage.store, "releaseArtifactReference");
      const endHeld = deferred<() => void>();
      let end: MockInstance<ServerResponse["end"]> | undefined;
      const path = `/v1/enhancement-jobs/${success.succeeded.jobId}/result`;
      const observed = nextResponse(f, path, (_request, response) => {
        const nativeEnd = response.end;
        let held = false;
        end = vi.spyOn(response, "end").mockImplementation(function (...args) {
          if (
            !held &&
            response.statusCode === 200 &&
            Buffer.isBuffer(args[0])
          ) {
            held = true;
            let resumed = false;
            const resume = () => {
              if (resumed || response.destroyed || response.writableEnded)
                return;
              resumed = true;
              Reflect.apply(nativeEnd, response, args);
            };
            releases.push(resume);
            endHeld.resolve(resume);
            return response;
          }
          return Reflect.apply(nativeEnd, response, args);
        });
      });
      const reading = track(requestBinary(f, path));
      const finish = await reached(endHeld.promise, reading);
      const response = await observed;
      const work = acquired(acquire);
      expect(release).toHaveBeenCalledExactlyOnceWith(work.key);
      expect(f.storage.store.readArtifactReference(work.key)).toBe("released");
      expect(response.response.writableFinished).toBe(false);
      expect(response.response.destroyed).toBe(false);
      expect(timer.pending.size).toBe(1);
      expect([...timer.pending.values()]).toEqual([
        transportLimits.requestTimeoutMs,
      ]);
      expect((await requestBinary(f, path)).status).toBe(429);
      expect(acquire).toHaveBeenCalledTimes(1);
      if (mode === "finish") {
        finish();
        expect((await reading).bytes).toEqual(success.png);
        await response.finished;
      } else {
        timer.fire();
        await expect(reading).rejects.toBeInstanceOf(Error);
        await response.closed;
      }
      await timer.firstCancelled;
      expect(response.heads.mock.calls.map(([status]) => status)).toEqual([
        200,
      ]);
      expect(end).toHaveBeenCalledTimes(1);
      expect(timer.clocks[0]?.cancellations).toBe(1);
      expect(timer.pending.size).toBe(0);
      expect((await requestBinary(f, path)).bytes).toEqual(success.png);
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(timer.pending.size).toBe(0);
    },
  );

  it.each(["credential", "store"] as const)(
    "does not deliver PNG after %s retirement while containing the late original handle",
    async (mode) => {
      const gate = heldFirstOpen();
      const timer = downloadClock();
      const f = await fixture({
        resultFiles: gate.files,
        downloadTimer: timer.timer,
      });
      const success = await succeed(f);
      const principal = f.storage.principal();
      const acquire = vi.spyOn(f.storage.store, "acquireArtifactWork");
      const release = vi.spyOn(f.storage.store, "releaseArtifactReference");
      const authorize = vi.spyOn(f.storage.store, "assertPrincipal");
      const readWork = vi.spyOn(f.storage.store, "readArtifactWork");
      const path = `/v1/enhancement-jobs/${success.succeeded.jobId}/result`;
      const observed = nextResponse(f, path);
      const connection = f.start("GET", path, { authorization: f.auth() });
      connection.req.end();
      await reached(gate.opening, connection.result);
      const work = acquired(acquire);
      if (mode === "credential")
        revokeCredential(f.storage.store, principal.credentialId);
      else f.storage.store.close();
      const callsAtClose = [
        authorize.mock.calls.length,
        readWork.mock.calls.length,
      ];
      gate.returnOpen();
      const original = await gate.closing;
      gate.returnClose();
      expect(await connection.result).toMatchObject({
        status: 503,
        body: { code: "internal_error" },
      });
      await gate.closed;
      await timer.firstCancelled;
      await expect(original.stat()).rejects.toMatchObject({ code: "EBADF" });
      expect(
        (await observed).heads.mock.calls.map(([status]) => status),
      ).toEqual([503]);
      expect(gate.events).toEqual([
        "open-issued",
        "open-returned",
        "close-issued",
        "close-completed",
      ]);
      if (mode === "credential") {
        expect(release).toHaveBeenCalledExactlyOnceWith(work.key);
      } else {
        expect(release).not.toHaveBeenCalled();
        expect([
          authorize.mock.calls.length,
          readWork.mock.calls.length,
        ]).toEqual(callsAtClose);
      }
      const reference = snapshot(f.storage, (db) =>
        db
          .prepare(
            "SELECT released_at FROM artifact_references WHERE reference_id = ?",
          )
          .get(work.key.referenceId),
      );
      expect(reference).toEqual({
        released_at: mode === "store" ? null : f.storage.clock(),
      });
      expect(timer.clocks[0]?.cancellations).toBe(1);
      expect(timer.pending.size).toBe(0);
    },
  );

  it("only closes after a real binary write fails after headers and never appends a second JSON response", async () => {
    const timer = downloadClock();
    const f = await fixture({ downloadTimer: timer.timer });
    const success = await succeed(f);
    const path = `/v1/enhancement-jobs/${success.succeeded.jobId}/result`;
    let end: MockInstance<ServerResponse["end"]> | undefined;
    let write: MockInstance<ServerResponse["write"]> | undefined;
    const observed = nextResponse(f, path, (_request, response) => {
      const nativeEnd = response.end;
      write = vi.spyOn(response, "write");
      let faulted = false;
      end = vi.spyOn(response, "end").mockImplementation(function (...args) {
        if (
          !faulted &&
          response.statusCode === 200 &&
          Buffer.isBuffer(args[0])
        ) {
          faulted = true;
          response.write(args[0].subarray(0, 8));
          response.flushHeaders();
          throw new Error("controlled post-header binary output failure");
        }
        return Reflect.apply(nativeEnd, response, args);
      });
    });
    const reading = track(requestBinary(f, path));
    await expect(reading).rejects.toBeInstanceOf(Error);
    const response = await observed;
    await response.closed;
    await timer.firstCancelled;
    expect(response.heads.mock.calls.map(([status]) => status)).toEqual([200]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(write?.mock.calls.map(([chunk]) => chunk)).toEqual([
      success.png.subarray(0, 8),
    ]);
    expect(timer.pending.size).toBe(0);
    expect(timer.clocks[0]?.cancellations).toBe(1);
    expect((await requestBinary(f, path)).bytes).toEqual(success.png);
  });

  it("returns a complete PNG with zero consumption of a real unfinished GET body", async () => {
    const timer = downloadClock();
    const f = await fixture({ downloadTimer: timer.timer });
    const success = await succeed(f);
    const path = `/v1/enhancement-jobs/${success.succeeded.jobId}/result`;
    let consumedBytes = 0;
    const observed = nextResponse(f, path, (request) => {
      const read = request.read.bind(request);
      request.read = (size?: number) => {
        const value = read(size);
        if (value !== null) consumedBytes += Buffer.byteLength(value);
        return value;
      };
    });
    const connection = f.start("GET", path, {
      authorization: f.auth(),
      "transfer-encoding": "chunked",
    });
    // This request intentionally has no end; the ordinary helper always ends GET.
    const received = track(
      new Promise<BinaryHttpResult>((resolve, reject) => {
        connection.req.once("error", reject);
        connection.req.once("response", (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("aborted", () =>
            reject(new Error("binary response aborted")),
          );
          response.once("end", () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              bytes: Buffer.concat(chunks),
            }),
          );
        });
      }),
    );
    connection.req.write(
      Buffer.alloc(transportLimits.maxMultipartOverheadBytes + 1, "x"),
    );
    const result = await received;
    expect(result.status).toBe(200);
    expect(result.bytes).toEqual(success.png);
    const response = await observed;
    await response.closed;
    await timer.firstCancelled;
    expect(result.headers.connection).toBe("close");
    expect(response.request.complete).toBe(false);
    expect(consumedBytes).toBe(0);
    expect(timer.pending.size).toBe(0);
    expect(timer.clocks[0]?.cancellations).toBe(1);
  });
});
