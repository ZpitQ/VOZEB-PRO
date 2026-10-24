import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as waitForPhase } from "node:timers/promises";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import {
  localUploadFiles,
  type UploadFiles,
  type UploadTimer,
} from "../src/http.js";
import { localInputFiles } from "../src/jobs.js";
import { configInput, planInput } from "./fixtures.js";
import {
  boundary,
  deferred,
  httpFixture,
  jobOf,
  manualUploadTimer,
  multipart,
  transportLimits,
  uploadParts,
} from "./http-fixtures.js";
import { sha256, sourceImage } from "./storage-fixtures.js";

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

function observedUploadFiles(target = 1) {
  const created = deferred();
  const cleaned = deferred();
  let createCount = 0;
  let cleanCount = 0;
  const files: UploadFiles = {
    ...localUploadFiles,
    async createDirectory(parent) {
      const directory = await localUploadFiles.createDirectory(parent);
      if (++createCount === target) created.resolve();
      return directory;
    },
    async removeDirectory(directory) {
      await localUploadFiles.removeDirectory(directory);
      if (++cleanCount === target) cleaned.resolve();
    },
  };
  return { files, created: created.promise, cleaned: cleaned.promise };
}

describe("HTTP upload resource ownership and single cleanup", () => {
  it("enforces upload concurrency separately from the durable GPU waiting queue", async () => {
    const observed = observedUploadFiles(2);
    const f = await fixture({ uploadFiles: observed.files });
    const held = [
      f.start("POST", "/v1/enhancement-jobs", f.uploadHeaders("held-a")),
      f.start("POST", "/v1/enhancement-jobs", f.uploadHeaders("held-b")),
    ];
    for (const item of held) item.req.flushHeaders();
    await observed.created;
    expect(
      await f.upload(await sourceImage(), "over-upload-capacity"),
    ).toMatchObject({
      status: 429,
      body: { code: "upload_capacity_exceeded" },
    });
    for (const item of held) item.req.destroy();
    await observed.cleaned;
    expect(await f.inputNames()).toEqual([]);
    expect((await f.upload(await sourceImage(), "after-held")).status).toBe(
      202,
    );
  });

  it("maps the explicitly configured upload deadline to 408 and releases its slot", async () => {
    const timer = manualUploadTimer();
    const observed = observedUploadFiles();
    const f = await fixture({
      uploadFiles: observed.files,
      uploadTimer: timer,
    });
    const connection = f.start(
      "POST",
      "/v1/enhancement-jobs",
      f.uploadHeaders(),
    );
    connection.req.flushHeaders();
    await observed.created;
    expect([...timer.pending.values()]).toEqual([
      transportLimits.requestTimeoutMs,
    ]);
    timer.fire();
    expect(await connection.result).toMatchObject({
      status: 408,
      body: { code: "upload_timeout" },
    });
    await observed.cleaned;
    expect(timer.pending.size).toBe(0);
    expect(await f.inputNames()).toEqual([]);
    expect((await f.upload(await sourceImage(), "after-timeout")).status).toBe(
      202,
    );
    expect(timer.pending.size).toBe(0);
  });

  it(
    "keeps the upload deadline JSON contract across the real Node slow-header timeout window",
    async () => {
      const configured = {
        ...transportLimits,
        requestTimeoutMs: transportLimits.requestTimeoutMs / 2,
        maxConcurrentUploads: 1,
      };
      const phases = new AbortController();
      const timerStarted = deferred();
      const clocks: {
        startedAt: number;
        milliseconds: number;
        fired: boolean;
        cancellations: number;
      }[] = [];
      const timer: UploadTimer = {
        start(callback, milliseconds) {
          const clock = {
            startedAt: performance.now(),
            milliseconds,
            fired: false,
            cancellations: 0,
          };
          clocks.push(clock);
          timerStarted.resolve();
          // Observe the same real timer semantics as production; never hold or fire it manually.
          const timeout = setTimeout(() => {
            clock.fired = true;
            callback();
          }, milliseconds);
          timeout.unref();
          return () => {
            clock.cancellations++;
            clearTimeout(timeout);
          };
        },
      };
      const bytes = await sourceImage();
      const body = multipart(uploadParts(bytes));
      const observed = observedUploadFiles();
      const key = "real-slow-header-timeout";
      const f = await fixture({
        transportLimits: configured,
        uploadTimer: timer,
        uploadFiles: observed.files,
      });
      const accept = vi.spyOn(f.storage.store, "acceptQueued");
      let serverMethod: string | undefined;
      f.server.prependListener("request", (request) => {
        if (request.headers["idempotency-key"] === key)
          serverMethod = request.method;
      });
      let connection: ReturnType<typeof f.start> | undefined;
      try {
        // Node22's documented default checker is 30s. Begin at 10s, finish
        // headers 7.5s later: native request expiry is 25s, application expiry 32.5s.
        await waitForPhase(configured.headersTimeoutMs, undefined, {
          signal: phases.signal,
        });
        connection = f.start("OST", "/v1/enhancement-jobs", {
          ...f.uploadHeaders(key),
          "content-length": body.length,
          connection: "close",
        });
        const request = connection.req;
        const responseMetadata = new Promise<{
          status: number | undefined;
          contentType: string | undefined;
          bodyBytes: number;
          receivedAt: number;
        }>((resolve, reject) => {
          request.once("error", reject);
          request.once("response", (response) => {
            let bodyBytes = 0;
            response.on("data", (chunk: Buffer) => {
              bodyBytes += chunk.length;
              if (bodyBytes > configured.maxHeaderBytes) {
                reject(
                  new Error("timeout response exceeded its fixture bound"),
                );
                request.destroy();
              }
            });
            response.once("error", reject);
            response.once("end", () =>
              resolve({
                status: response.statusCode,
                contentType: response.headers["content-type"],
                bodyBytes,
                receivedAt: performance.now(),
              }),
            );
          });
        });
        void responseMetadata.catch(() => {});
        await new Promise<void>((resolve, reject) => {
          request.once("error", reject);
          request.once("socket", (socket) => {
            // The wire receives P + OST: a genuine partial POST method. Keep the
            // normal Node client/JSON fixture responsible for response parsing.
            const prime = () => {
              socket.write("P", (error) => (error ? reject(error) : resolve()));
            };
            if (socket.connecting) socket.once("connect", prime);
            else prime();
          });
        });
        await waitForPhase(configured.requestTimeoutMs / 2, undefined, {
          signal: phases.signal,
        });
        request.flushHeaders();
        request.write(body.subarray(0, body.indexOf(bytes) + 20));
        await timerStarted.promise;
        await observed.created;
        expect(serverMethod).toBe("POST");
        expect(clocks).toHaveLength(1);
        const clock = clocks[0]!;
        expect(clock.milliseconds).toBe(configured.requestTimeoutMs);

        const metadata = await responseMetadata;
        await observed.cleaned;
        expect(accept).not.toHaveBeenCalled();
        expect(await f.inputNames()).toEqual([]);
        expect(clock.cancellations).toBe(1);
        expect((await f.call("GET", "/healthz")).status).toBe(200);
        expect((await f.upload(bytes, "after-real-timeout")).status).toBe(202);

        // On the old implementation this fails as a protocol assertion: native
        // 408 has no JSON Content-Type and arrives before the real application timer.
        expect({
          status: metadata.status,
          contentType: metadata.contentType,
          applicationTimerFired: clock.fired,
          arrivedBeforeApplicationDeadline:
            metadata.receivedAt < clock.startedAt + clock.milliseconds,
        }).toEqual({
          status: 408,
          contentType: "application/json; charset=utf-8",
          applicationTimerFired: true,
          arrivedBeforeApplicationDeadline: false,
        });
        expect(metadata.bodyBytes).toBeGreaterThan(0);
        expect(await connection.result).toMatchObject({
          status: 408,
          body: {
            code: "upload_timeout",
            data: { requestId: expect.any(String) },
          },
        });
      } finally {
        phases.abort();
        connection?.req.destroy();
      }
    },
    transportLimits.requestTimeoutMs + transportLimits.headersTimeoutMs,
  );

  it.each(["headers", "plan", "image", "before-closing-boundary"])(
    "does not accept a client disconnected after %s",
    async (stage) => {
      const observed = observedUploadFiles();
      const f = await fixture({ uploadFiles: observed.files });
      const accept = vi.spyOn(f.storage.store, "acceptQueued");
      const bytes = await sourceImage();
      const parts = uploadParts(bytes);
      const body = multipart(parts);
      const connection = f.start(
        "POST",
        "/v1/enhancement-jobs",
        f.uploadHeaders(),
      );
      if (stage === "headers") connection.req.flushHeaders();
      else if (stage === "plan")
        connection.req.write(multipart(parts.slice(0, 1), false));
      else if (stage === "image")
        connection.req.write(body.subarray(0, body.indexOf(bytes) + 20));
      else
        connection.req.write(
          body.subarray(
            0,
            body.length - Buffer.byteLength(`--${boundary}--\r\n`),
          ),
        );
      await observed.created;
      connection.req.destroy();
      await observed.cleaned;
      expect(accept).not.toHaveBeenCalled();
      expect(await f.inputNames()).toEqual([]);
      expect((await f.call("GET", "/healthz")).status).toBe(200);
    },
  );

  it("rejects a real spool writer error and removes only its own upload directory", async () => {
    const observed = observedUploadFiles();
    const f = await fixture({
      uploadFiles: {
        ...observed.files,
        createImageWriter(path) {
          const writer = localUploadFiles.createImageWriter(path);
          writer.once("open", () =>
            writer.destroy(
              Object.assign(new Error("private-spool-EIO"), { code: "EIO" }),
            ),
          );
          return writer;
        },
      },
    });
    const result = await f.upload(await sourceImage(), "failed-writer");
    expect(result).toMatchObject({
      status: 503,
      body: { code: "internal_error" },
    });
    expect(result.raw).not.toContain("private-spool-EIO");
    await observed.cleaned;
    expect(await f.inputNames()).toEqual([]);
    expect((await f.call("GET", "/healthz")).status).toBe(200);
  });

  it("observes disconnection after the complete body but before invoking the durable service", async () => {
    const observed = observedUploadFiles();
    const read = deferred();
    const release = deferred();
    const disconnected = deferred();
    const f = await fixture({
      uploadFiles: {
        ...observed.files,
        async readImage(path) {
          const bytes = await localUploadFiles.readImage(path);
          read.resolve();
          await release.promise;
          return bytes;
        },
      },
    });
    f.server.prependListener("request", (_req, res) => {
      res.once("close", () => disconnected.resolve());
    });
    const accept = vi.spyOn(f.storage.store, "acceptQueued");
    const connection = f.start(
      "POST",
      "/v1/enhancement-jobs",
      f.uploadHeaders(),
    );
    connection.req.end(multipart(uploadParts(await sourceImage())));
    await read.promise;
    connection.req.destroy();
    await disconnected.promise;
    release.resolve();
    await observed.cleaned;
    expect(accept).not.toHaveBeenCalled();
    expect(await f.inputNames()).toEqual([]);
  });

  it("does not commit when a disconnect is observed while B1 is writing its immutable input", async () => {
    const writing = deferred();
    const release = deferred();
    const disconnected = deferred();
    const removed = deferred();
    const committed = deferred();
    let writes = 0;
    const f = await fixture({
      inputFiles: {
        ...localInputFiles,
        async write(path, bytes) {
          await localInputFiles.write(path, bytes);
          if (++writes === 1) {
            writing.resolve();
            await release.promise;
          }
        },
        async remove(directory) {
          await localInputFiles.remove(directory);
          removed.resolve();
        },
      },
    });
    f.server.prependListener("request", (_req, res) => {
      res.once("close", () => disconnected.resolve());
    });
    const original = f.storage.store.acceptQueued.bind(f.storage.store);
    const accept = vi
      .spyOn(f.storage.store, "acceptQueued")
      .mockImplementation((...args) => {
        const accepted = original(...args);
        committed.resolve();
        return accepted;
      });
    const connection = f.start(
      "POST",
      "/v1/enhancement-jobs",
      f.uploadHeaders(),
    );
    connection.req.end(multipart(uploadParts(await sourceImage())));
    await writing.promise;
    connection.req.destroy();
    await disconnected.promise;
    release.resolve();
    await Promise.race([removed.promise, committed.promise]);
    expect(accept).not.toHaveBeenCalled();
    expect(await f.inputNames()).toEqual([]);
  });
});

describe("HTTP durable response and immutable replay", () => {
  it("does not return 202 when real SQLite COMMIT fails", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const accepted = await f.upload(bytes, "preserved-job");
    expect(accepted.status).toBe(202);
    const preserved = jobOf(accepted);
    f.storage.store.close();
    const db = new Database(join(f.storage.directory, "worker.sqlite"));
    db.pragma("foreign_keys = ON");
    db.exec(
      "CREATE TABLE http_commit_fault (client_id TEXT REFERENCES clients(client_id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER http_commit_failure AFTER INSERT ON jobs BEGIN INSERT INTO http_commit_fault VALUES ('nonexistent-client'); END",
    );
    db.close();
    await f.restart();
    const failed = await f.upload(bytes, "commit-failure");
    expect(failed).toMatchObject({
      status: 503,
      body: { code: "internal_error" },
    });
    expect(await f.inputNames()).toEqual([preserved.jobId]);
    expect(await f.original(preserved)).toEqual(bytes);
    expect((await f.upload(bytes, "preserved-job")).status).toBe(202);
  });

  it("keeps a committed task after the real client loses its response and finds it after restart", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const committed =
      deferred<ReturnType<typeof f.storage.store.acceptQueued>>();
    const original = f.storage.store.acceptQueued.bind(f.storage.store);
    const connection = f.start(
      "POST",
      "/v1/enhancement-jobs",
      f.uploadHeaders("lost-response"),
    );
    vi.spyOn(f.storage.store, "acceptQueued").mockImplementation((...args) => {
      const accepted = original(...args);
      connection.req.destroy();
      committed.resolve(accepted);
      return accepted;
    });
    connection.req.end(multipart(uploadParts(bytes)));
    const first = await committed.promise;
    await expect(connection.result).rejects.toBeInstanceOf(Error);
    expect(await f.original(first.job)).toEqual(bytes);
    vi.restoreAllMocks();
    await f.restart();
    const found = await f.upload(bytes, "lost-response");
    expect(found.status).toBe(202);
    expect(found.body.data.replayed).toBe(true);
    expect(jobOf(found)).toEqual(first.job);
    expect(await f.inputNames()).toEqual([first.job.jobId]);
  });

  it("coalesces simultaneous matching TCP submissions into one registered task and one input set", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const [a, b] = await Promise.all([
      f.upload(bytes, "concurrent-key"),
      f.upload(bytes, "concurrent-key"),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(jobOf(a)).toEqual(jobOf(b));
    expect([a.body.data.replayed, b.body.data.replayed].sort()).toEqual([
      false,
      true,
    ]);
    expect(await f.inputNames()).toEqual([jobOf(a).jobId]);
  });

  it("receives replays with the old frozen budget despite current shrink, full queue, not-ready and cancellation", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const first = await f.upload(bytes, "frozen-http");
    expect(first.status).toBe(202);
    expect((await f.upload(bytes, "full-queue")).status).toBe(202);
    expect(await f.upload(bytes, "queue-reject")).toMatchObject({
      status: 429,
      body: { code: "queue_full" },
    });
    const next = configInput();
    next.budgets.input.maxBytes = 1;
    next.budgets.input.maxPixels = 1;
    next.models[0]!.binarySha256 = "e".repeat(64);
    next.models[0]!.defaultTile = 128;
    f.setConfig(createWorkerConfig(next));
    f.setReady(false);
    const replay = await f.upload(bytes, "frozen-http");
    expect(replay.status).toBe(202);
    expect(jobOf(replay)).toEqual(jobOf(first));
    const cancelled = await f.call(
      "DELETE",
      `/v1/enhancement-jobs/${jobOf(first).jobId}`,
    );
    expect(cancelled.status).toBe(200);
    expect(jobOf(await f.upload(bytes, "frozen-http"))).toEqual(
      jobOf(cancelled),
    );
    f.setConfig(createWorkerConfig(configInput()));
    expect(await f.upload(bytes, "not-ready-new-key")).toMatchObject({
      status: 503,
      body: { code: "not_ready" },
    });
    expect(await f.inputNames()).toEqual(
      [
        jobOf(first).jobId,
        jobOf(await f.upload(bytes, "full-queue")).jobId,
      ].sort(),
    );
  });

  it.each(["source", "target", "model", "tile"])(
    "rejects same-key changed %s with 409 without changing accepted state",
    async (kind) => {
      const f = await fixture();
      const source = await sourceImage();
      const first = await f.upload(source, "immutable-key");
      expect(first.status).toBe(202);
      const changed = kind === "source" ? await sourceImage("blue") : source;
      const plan = planInput(sha256(changed));
      if (kind === "target")
        plan.target = { width: 16, height: 12, format: "png" };
      if (kind === "model") plan.modelId = "another-model";
      if (kind === "tile") plan.tile = 128;
      expect(
        await f.upload(
          changed,
          "immutable-key",
          uploadParts(changed, {}, plan),
        ),
      ).toMatchObject({ status: 409, body: { code: "idempotency_conflict" } });
      expect(
        jobOf(
          await f.call("GET", `/v1/enhancement-jobs/${jobOf(first).jobId}`),
        ),
      ).toEqual(jobOf(first));
      expect(await f.original(jobOf(first))).toEqual(source);
    },
  );

  it("still validates actual bytes and complete legal plan on an accepted key", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    expect((await f.upload(bytes, "strict-replay")).status).toBe(202);
    f.setReady(false);
    const different = await sourceImage("blue");
    expect(
      await f.upload(
        different,
        "strict-replay",
        uploadParts(different, {}, planInput(sha256(bytes))),
      ),
    ).toMatchObject({ status: 422, body: { code: "input_digest_mismatch" } });
    expect(
      await f.upload(
        bytes,
        "strict-replay",
        uploadParts(bytes, {}, { ...planInput(sha256(bytes)), nativeScale: 8 }),
      ),
    ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    expect(
      await f.upload(
        bytes,
        "strict-replay",
        uploadParts(
          bytes,
          {},
          { ...planInput(sha256(bytes)), scope: "masked" },
        ),
      ),
    ).toMatchObject({ status: 422, body: { code: "invalid_plan" } });
    expect(await f.inputNames()).toHaveLength(1);
  });
});
