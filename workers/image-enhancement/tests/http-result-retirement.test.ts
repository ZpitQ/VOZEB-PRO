import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createArtifacts,
  localArtifactFiles,
  type ArtifactFile,
  type ArtifactFiles,
} from "../src/artifacts.js";
import { createClient } from "../src/credentials.js";
import type { UploadTimer } from "../src/http.js";
import { nativePng, writeActualFile } from "./artifact-fixtures.js";
import { completionExit } from "./completion-fixtures.js";
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

const retentionMs = 60_000;
const cleanups: (() => Promise<void>)[] = [];
const disconnects: (() => void)[] = [];
const releases: (() => void)[] = [];
const pending: Promise<unknown>[] = [];

afterEach(async () => {
  for (const disconnect of disconnects.splice(0)) disconnect();
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: Parameters<typeof httpFixture>[0] = {}) {
  const f = await httpFixture(options);
  disconnects.push(() => f.server.closeAllConnections());
  cleanups.push(() => f.cleanup());
  return f;
}

function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => undefined);
  return promise;
}

async function publishedResult(f: ResultHttpFixture) {
  const success = await succeededThroughRunner(f, (cleanup) =>
    cleanups.push(cleanup),
  );
  assert.ok(success.succeeded.result);
  const jobId = success.succeeded.jobId;
  const request = {
    serviceId: f.storage.store.identity.serviceId,
    receiptId: randomUUID(),
    result: success.succeeded.result,
  };
  const receipt = await f.call(
    "POST",
    `/v1/enhancement-jobs/${jobId}/receipt`,
    Buffer.from(JSON.stringify(request)),
    { authorization: f.auth(), "content-type": "application/json" },
  );
  expect(receipt).toMatchObject({
    status: 200,
    body: { data: { applied: true } },
  });
  assert.notEqual(success.succeeded.completedAt, null);
  const deadline = success.succeeded.completedAt! + retentionMs;
  f.storage.setNow(deadline);
  const directory = join(
    f.storage.directory,
    "attempts",
    success.facts.candidates[0]!.directory,
  );
  return {
    success,
    request,
    receipt,
    jobId,
    deadline,
    directory,
    base: `/v1/enhancement-jobs/${jobId}`,
  };
}

function ledger(f: ResultHttpFixture) {
  return snapshot(f.storage, (db) => ({
    references: db
      .prepare("SELECT * FROM artifact_references ORDER BY rowid")
      .all(),
    observations: db
      .prepare("SELECT * FROM artifact_observations ORDER BY rowid")
      .all(),
  }));
}

function preservedFacts(f: ResultHttpFixture) {
  return snapshot(f.storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY rowid").all(),
    attempts: db.prepare("SELECT * FROM attempts ORDER BY rowid").all(),
    candidates: db
      .prepare("SELECT * FROM artifact_candidates ORDER BY rowid")
      .all(),
    receipts: db.prepare("SELECT * FROM result_receipts ORDER BY rowid").all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
    controls: db
      .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
      .all(),
    history: db.prepare("SELECT * FROM recovery_events ORDER BY rowid").all(),
  }));
}

function expectError(
  f: ResultHttpFixture,
  response: BinaryHttpResult,
  status: number,
  code: string,
) {
  expect(response.status).toBe(status);
  expect(response.headers["content-type"]).toBe(
    "application/json; charset=utf-8",
  );
  const text = response.bytes.toString("utf8");
  const body = JSON.parse(text);
  expect(body.code).toBe(code);
  expect(body.data).toEqual({ requestId: expect.any(String) });
  if (code === "result_gone")
    expect(body.msg).toBe("增强结果已按保留规则停止提供，无法再次下载。");
  expect(text).not.toContain(f.storage.directory);
  expect(text).not.toContain(f.storage.initialized.credential.key);
}

function reached<T>(barrier: Promise<T>, result: Promise<unknown>) {
  return Promise.race([
    barrier,
    result.then(
      () => {
        throw new Error(
          "HTTP result settled before its required real boundary",
        );
      },
      (cause: unknown) => {
        throw new Error(
          "HTTP result rejected before its required real boundary",
          { cause },
        );
      },
    ),
  ]);
}

describe("the existing TCP result route after durable retirement", () => {
  it("keeps 401, foreign/missing 404 and queued 409 ahead of retired-result 410 without new refs or opens", async () => {
    const opened: string[] = [];
    const files: ArtifactFiles = {
      ...localArtifactFiles,
      open(path, flags, mode) {
        opened.push(path);
        return localArtifactFiles.open(path, flags, mode);
      },
    };
    const f = await fixture({ resultFiles: files });
    const r = await publishedResult(f);
    const retired = f.storage.store.retireResult(
      f.storage.principal(),
      r.jobId,
      retentionMs,
    );
    assert.ok(retired.kind === "retired" && retired.work);
    const other = createClient(f.storage.store);
    const queuedResponse = await f.upload(
      r.success.bytes,
      "retirement-queued-control",
    );
    expect(queuedResponse.status).toBe(202);
    const queued = jobOf(queuedResponse);
    expect(queued.status).toBe("queued");
    const before = ledger(f);
    const facts = preservedFacts(f);
    expectError(
      f,
      await requestBinary(f, `${r.base}/result`, {}),
      401,
      "authentication_failed",
    );
    expectError(
      f,
      await requestBinary(f, `${r.base}/result`, {
        authorization: `Bearer ${other.key}`,
      }),
      404,
      "job_not_found",
    );
    expectError(
      f,
      await requestBinary(f, "/v1/enhancement-jobs/missing/result"),
      404,
      "job_not_found",
    );
    expectError(
      f,
      await requestBinary(f, `/v1/enhancement-jobs/${queued.jobId}/result`),
      409,
      "result_not_ready",
    );
    expectError(
      f,
      await requestBinary(f, `${r.base}/result`),
      410,
      "result_gone",
    );
    expect(opened).toEqual([]);
    expect(ledger(f)).toEqual(before);
    expect(preservedFacts(f)).toEqual(facts);
    expect(await readFile(join(r.directory, "artifact.png"))).toEqual(
      r.success.png,
    );
    expect((await stat(join(r.directory, "manifest.json"))).isFile()).toBe(
      true,
    );
  });

  it("keeps GET job, the original submission and receipt replay successful after cleanup and HTTP reopen", async () => {
    const f = await fixture();
    const r = await publishedResult(f);
    const before = preservedFacts(f);
    const original = await f.original(r.success.succeeded);
    const artifacts = createArtifacts({ store: f.storage.store });
    expect(
      await artifacts.cleanupAcknowledgedResult(
        f.storage.principal(),
        r.jobId,
        retentionMs,
      ),
    ).toEqual({ state: "complete" });
    for (const name of ["artifact.png", "manifest.json"])
      await expect(stat(join(r.directory, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect((await stat(r.directory)).isDirectory()).toBe(true);
    const beforeDownload = ledger(f);
    expectError(
      f,
      await requestBinary(f, `${r.base}/result`),
      410,
      "result_gone",
    );
    expect(ledger(f)).toEqual(beforeDownload);
    expect(jobOf(await f.call("GET", r.base))).toEqual(r.success.succeeded);
    const replay = await f.upload(r.success.bytes, "artifact-http-first");
    expect(replay.status).toBe(202);
    expect(replay.body.data.replayed).toBe(true);
    expect(jobOf(replay)).toEqual(r.success.succeeded);
    const receipt = await f.call(
      "POST",
      `${r.base}/receipt`,
      Buffer.from(JSON.stringify(r.request)),
      { authorization: f.auth(), "content-type": "application/json" },
    );
    expect(receipt).toMatchObject({
      status: 200,
      body: { data: { receipt: r.receipt.body.data.receipt, applied: false } },
    });
    expect(await f.original(r.success.succeeded)).toEqual(original);
    expect(preservedFacts(f)).toEqual(before);
    await r.success.runner.close();
    await f.restart();
    f.setReady(false);
    expectError(
      f,
      await requestBinary(f, `${r.base}/result`),
      410,
      "result_gone",
    );
    expect(jobOf(await f.call("GET", r.base))).toEqual(r.success.succeeded);
    expect(ledger(f)).toEqual(beforeDownload);
    expect(preservedFacts(f)).toEqual(before);
  });

  it("cleans after a Buffer reader released its ref while preserving that old 200 and its slot through finish", async () => {
    const manual = manualUploadTimer();
    const firstCancelled = deferred();
    let timerNo = 0;
    const downloadTimer: UploadTimer = {
      start(callback, milliseconds) {
        const number = timerNo++;
        const cancel = manual.start(callback, milliseconds);
        return () => {
          cancel();
          if (number === 0) firstCancelled.resolve();
        };
      },
    };
    const peerOpened = deferred<ArtifactFile>();
    const releasePeer = deferred();
    const handles: ArtifactFile[] = [];
    let peerDirectory: string | undefined;
    let peerHeld = false;
    const files: ArtifactFiles = {
      ...localArtifactFiles,
      async open(path, flags, mode) {
        const file = await localArtifactFiles.open(path, flags, mode);
        handles.push(file);
        if (
          !peerHeld &&
          peerDirectory &&
          path.startsWith(peerDirectory) &&
          path.endsWith("artifact.png")
        ) {
          peerHeld = true;
          peerOpened.resolve(file);
          await releasePeer.promise;
        }
        return file;
      },
    };
    releases.push(() => releasePeer.resolve());
    const f = await fixture({
      resultFiles: files,
      downloadTimer,
      transportLimits: { ...transportLimits, maxConcurrentDownloads: 2 },
    });
    const r = await publishedResult(f);
    // A second real successful job can occupy the remaining slot without a fake reader.
    const peerAccepted = await f.upload(
      r.success.bytes,
      "retirement-slot-peer",
    );
    expect(peerAccepted.status).toBe(202);
    const peer = jobOf(peerAccepted);
    await r.success.runner.wake();
    const peerAttempt = r.success.executor.launchCalls.find(
      (attempt) => attempt.identity.jobId === peer.jobId,
    );
    assert.ok(peerAttempt);
    const peerPng = await nativePng(peerAttempt);
    await writeActualFile(peerAttempt.outputPath, peerPng);
    r.success.executor.emit(
      completionExit(peerAttempt, {
        kind: "success",
        exitCode: 0,
        signal: null,
      }),
    );
    await r.success.runner.wake();
    expect(
      f.storage.store.getOwned(f.storage.principal(), peer.jobId).status,
    ).toBe("succeeded");
    peerDirectory = dirname(peerAttempt.outputPath);

    const endHeld = deferred<() => void>();
    const responseSeen = deferred<{
      response: ServerResponse;
      finished: Promise<void>;
    }>();
    const path = `${r.base}/result`;
    let selected = false;
    f.server.prependListener("request", (request, response) => {
      if (selected || request.url !== path) return;
      selected = true;
      const finished = deferred();
      response.once("finish", () => finished.resolve());
      const nativeEnd = response.end;
      let held = false;
      vi.spyOn(response, "end").mockImplementation(function (...args) {
        if (!held && response.statusCode === 200 && Buffer.isBuffer(args[0])) {
          held = true;
          let resumed = false;
          const resume = () => {
            if (resumed || response.destroyed || response.writableEnded) return;
            resumed = true;
            Reflect.apply(nativeEnd, response, args);
          };
          releases.push(resume);
          endHeld.resolve(resume);
          return response;
        }
        return Reflect.apply(nativeEnd, response, args);
      });
      responseSeen.resolve({ response, finished: finished.promise });
    });
    const reading = track(requestBinary(f, path));
    const finish = await reached(endHeld.promise, reading);
    const response = await responseSeen.promise;
    expect(response.response.writableFinished).toBe(false);
    expect(response.response.destroyed).toBe(false);
    const references = snapshot(f.storage, (db) =>
      db
        .prepare(
          "SELECT purpose, released_at FROM artifact_references WHERE job_id = ? ORDER BY rowid",
        )
        .all(r.jobId),
    );
    expect(references).toEqual([
      expect.objectContaining({ purpose: "run", released_at: 1_000 }),
      expect.objectContaining({ purpose: "recovery", released_at: r.deadline }),
    ]);
    for (const file of handles)
      await expect(file.stat()).rejects.toMatchObject({ code: "EBADF" });
    const before = preservedFacts(f);
    expect(
      await createArtifacts({
        store: f.storage.store,
      }).cleanupAcknowledgedResult(f.storage.principal(), r.jobId, retentionMs),
    ).toEqual({ state: "complete" });
    for (const name of ["artifact.png", "manifest.json"])
      await expect(stat(join(r.directory, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expectError(f, await requestBinary(f, path), 410, "result_gone");
    expect(manual.pending.size).toBe(1);

    const peerReading = track(
      requestBinary(f, `/v1/enhancement-jobs/${peer.jobId}/result`),
    );
    const peerHandle = await reached(peerOpened.promise, peerReading);
    expect((await peerHandle.stat()).isFile()).toBe(true);
    expect(manual.pending.size).toBe(2);
    expectError(
      f,
      await requestBinary(f, path),
      429,
      "download_capacity_exceeded",
    );
    finish();
    const delivered = await reading;
    expect(delivered.status).toBe(200);
    expect(delivered.bytes).toEqual(r.success.png);
    expect(delivered.headers["content-type"]).toBe("image/png");
    expect(delivered.headers["content-length"]).toBe(
      String(r.success.png.length),
    );
    await response.finished;
    await firstCancelled.promise;
    expect(manual.pending.size).toBe(1);
    // The peer is still held: this 410 proves the original response's slot was freed.
    expectError(f, await requestBinary(f, path), 410, "result_gone");
    expect(manual.pending.size).toBe(1);
    releasePeer.resolve();
    const peerDelivered = await peerReading;
    expect(peerDelivered.status).toBe(200);
    expect(peerDelivered.bytes).toEqual(peerPng);
    expect(manual.pending.size).toBe(0);
    for (const file of handles)
      await expect(file.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(preservedFacts(f)).toEqual(before);
    expect(jobOf(await f.call("GET", r.base))).toEqual(r.success.succeeded);
  });
});
