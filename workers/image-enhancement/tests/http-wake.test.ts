import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deferred,
  httpFixture,
  jobOf,
  multipart,
  uploadParts,
} from "./http-fixtures.js";
import {
  commitFault,
  descriptor,
  snapshot,
  treeExit,
} from "./lifecycle-fixtures.js";
import { sourceImage, submission } from "./storage-fixtures.js";

type HttpFixture = Awaited<ReturnType<typeof httpFixture>>;
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

function committed(f: HttpFixture, key: string) {
  const principal = f.storage.principal();
  return {
    job: f.storage.store.findByKey(principal, key)?.job ?? null,
    // A disk snapshot cannot see an uncommitted change from the Store connection.
    row: snapshot(f.storage, (db) =>
      db
        .prepare(
          "SELECT job_id, status, cancel_requested_at, completed_at FROM jobs WHERE client_id = ? AND idempotency_key = ?",
        )
        .get(principal.clientId, key),
    ),
  };
}

function stopFacts(f: HttpFixture) {
  return snapshot(f.storage, (db) =>
    db
      .prepare(
        "SELECT attempt_no, fence, owner_instance_id, authorized_at, stop_reason, stop_requested_at, terminate_after_at FROM attempts ORDER BY attempt_no",
      )
      .all(),
  );
}

describe("HTTP wake hints follow committed job facts", () => {
  it("notifies once without arguments after acceptance and a legal not-ready replay", async () => {
    const key = "wake-committed-replay";
    let f!: HttpFixture;
    const observations: ReturnType<typeof committed>[] = [];
    const hook = vi.fn(() => {
      observations.push(committed(f, key));
    });
    f = await fixture({ onJobCommitted: hook });
    const beforeResponseEnds: number[] = [];
    f.server.prependListener("request", (_request, response) => {
      response.once("prefinish", () => {
        beforeResponseEnds.push(hook.mock.calls.length);
      });
    });
    const bytes = await sourceImage();
    const first = await f.upload(bytes, key);
    expect(first).toMatchObject({
      status: 202,
      body: { data: { replayed: false } },
    });
    const job = jobOf(first);
    expect(observations).toEqual([
      {
        job,
        row: {
          job_id: job.jobId,
          status: "queued",
          cancel_requested_at: null,
          completed_at: null,
        },
      },
    ]);
    expect(hook.mock.calls).toEqual([[]]);
    expect(await f.original(job)).toEqual(bytes);

    f.setReady(false);
    const replay = await f.upload(bytes, key);
    expect(replay).toMatchObject({
      status: 202,
      body: { data: { replayed: true } },
    });
    expect(jobOf(replay)).toEqual(job);
    expect(observations).toEqual([observations[0], observations[0]]);
    expect(hook.mock.calls).toEqual([[], []]);
    expect(beforeResponseEnds).toEqual([1, 2]);
    expect(await f.inputNames()).toEqual([job.jobId]);
  });

  it("notifies after running cancellation, replay and terminal cancellation without renewing grace or authority", async () => {
    const key = "wake-cancel-facts";
    let f!: HttpFixture;
    const observations: {
      committed: ReturnType<typeof committed>;
      stop: ReturnType<typeof stopFacts>;
    }[] = [];
    const hook = vi.fn(() => {
      observations.push({ committed: committed(f, key), stop: stopFacts(f) });
    });
    f = await fixture({ onJobCommitted: hook });
    const accepted = await f.upload(await sourceImage(), key);
    expect(accepted.status).toBe(202);
    const job = jobOf(accepted);
    const attempt = f.storage.store.claimNext("http-wake-owner")!;
    expect(attempt.identity.jobId).toBe(job.jobId);
    const owner = descriptor(attempt);
    expect(f.storage.store.registerPrepared(attempt.identity, owner)).toBe(
      true,
    );
    expect(f.storage.store.authorizeLaunch(attempt.identity, owner)).toBe(true);
    const authorized = f.storage.store.getActiveAttempt(attempt.identity)!;
    observations.length = 0;
    hook.mockClear();
    const beforeResponseEnds: number[] = [];
    f.server.prependListener("request", (_request, response) => {
      response.once("prefinish", () => {
        beforeResponseEnds.push(hook.mock.calls.length);
      });
    });

    const path = `/v1/enhancement-jobs/${job.jobId}`;
    const first = await f.call("DELETE", path);
    expect(first).toMatchObject({
      status: 202,
      body: { data: { applied: true } },
    });
    const cancelled = jobOf(first);
    const stopped = [
      {
        attempt_no: attempt.identity.attemptNo,
        fence: attempt.identity.fence,
        owner_instance_id: attempt.identity.ownerInstanceId,
        authorized_at: 1_000,
        stop_reason: "user_cancel",
        stop_requested_at: 1_000,
        terminate_after_at: 6_000,
      },
    ];
    expect(observations).toEqual([
      {
        committed: {
          job: cancelled,
          row: {
            job_id: job.jobId,
            status: "running",
            cancel_requested_at: 1_000,
            completed_at: null,
          },
        },
        stop: stopped,
      },
    ]);
    expect(cancelled).toMatchObject({
      status: "running",
      cancelRequested: true,
      completedAt: null,
    });

    f.storage.setNow(2_000);
    const repeat = await f.call("DELETE", path);
    expect(repeat).toMatchObject({
      status: 202,
      body: { data: { applied: false } },
    });
    expect(jobOf(repeat)).toEqual(cancelled);
    expect(observations).toEqual([observations[0], observations[0]]);
    expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
      authorizedAt: authorized.authorizedAt,
      executionDeadlineAt: authorized.executionDeadlineAt,
      leaseExpiresAt: authorized.leaseExpiresAt,
      stopRequestedAt: 1_000,
      terminateAfterAt: 6_000,
    });

    expect(f.storage.store.registerExit(treeExit(attempt))).toBe(true);
    expect(f.storage.store.finishCancelled(attempt.identity)).toBe(true);
    const terminal = await f.call("DELETE", path);
    expect(terminal).toMatchObject({
      status: 200,
      body: { data: { applied: false } },
    });
    expect(observations[2]).toEqual({
      committed: {
        job: jobOf(terminal),
        row: {
          job_id: job.jobId,
          status: "cancelled",
          cancel_requested_at: 1_000,
          completed_at: 2_000,
        },
      },
      stop: stopped,
    });
    expect(hook.mock.calls).toEqual([[], [], []]);
    expect(beforeResponseEnds).toEqual([1, 2, 3]);
    expect(stopFacts(f)).toEqual(stopped);
    expect(
      f.storage.store.claimNext("unrequested-replacement"),
    ).toBeUndefined();
  });

  it.each(["synchronous throw", "asynchronous rejection"])(
    "isolates %s with one fixed redacted diagnostic per committed command",
    async (kind) => {
      const key = "wake-isolated-failure";
      let f!: HttpFixture;
      const observations: ReturnType<typeof committed>[] = [];
      const diagnostic = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const hook = vi.fn(() => {
        observations.push(committed(f, key));
        const error = new Error("fixture-private-path-and-token");
        if (kind === "synchronous throw") throw error;
        return Promise.reject(error);
      });
      f = await fixture({ onJobCommitted: hook });
      const bytes = await sourceImage();
      const accepted = await f.upload(bytes, key);
      expect(accepted.status).toBe(202);
      const job = jobOf(accepted);
      const cancelled = await f.call(
        "DELETE",
        `/v1/enhancement-jobs/${job.jobId}`,
      );
      expect(cancelled).toMatchObject({
        status: 200,
        body: { data: { applied: true } },
      });
      expect(observations).toEqual([
        {
          job,
          row: {
            job_id: job.jobId,
            status: "queued",
            cancel_requested_at: null,
            completed_at: null,
          },
        },
        {
          job: jobOf(cancelled),
          row: {
            job_id: job.jobId,
            status: "cancelled",
            cancel_requested_at: 1_000,
            completed_at: 1_000,
          },
        },
      ]);
      expect(committed(f, key)).toEqual(observations[1]);
      expect(await f.original(job)).toEqual(bytes);
      expect(diagnostic.mock.calls).toEqual([
        ["enhancement_wake_failed"],
        ["enhancement_wake_failed"],
      ]);
      expect(accepted.raw + cancelled.raw).not.toContain(
        "fixture-private-path-and-token",
      );
      expect(hook.mock.calls).toEqual([[], []]);
    },
  );

  it("returns acceptance and enters a later DELETE hook while the first notification stays pending", async () => {
    const key = "wake-independent-hints";
    const held = deferred();
    let f!: HttpFixture;
    const observations: ReturnType<typeof committed>[] = [];
    const hook = vi.fn(() => {
      observations.push(committed(f, key));
      if (observations.length === 1) return held.promise;
    });
    f = await fixture({ onJobCommitted: hook });
    try {
      const accepted = await f.upload(await sourceImage(), key);
      expect(accepted.status).toBe(202);
      const job = jobOf(accepted);
      expect(hook.mock.calls).toEqual([[]]);
      const cancelled = await f.call(
        "DELETE",
        `/v1/enhancement-jobs/${job.jobId}`,
      );
      expect(cancelled).toMatchObject({
        status: 200,
        body: { data: { applied: true } },
      });
      expect(hook.mock.calls).toEqual([[], []]);
      expect(observations).toEqual([
        {
          job,
          row: {
            job_id: job.jobId,
            status: "queued",
            cancel_requested_at: null,
            completed_at: null,
          },
        },
        {
          job: jobOf(cancelled),
          row: {
            job_id: job.jobId,
            status: "cancelled",
            cancel_requested_at: 1_000,
            completed_at: 1_000,
          },
        },
      ]);
      expect(committed(f, key)).toEqual(observations[1]);
    } finally {
      held.resolve();
    }
  });

  it("does not notify for authentication, validation, missing-job failures or read-only routes", async () => {
    const hook = vi.fn();
    const f = await fixture({ onJobCommitted: hook });
    const bytes = await sourceImage();
    const key = "wake-unmodified-seed";
    const seeded = await f.storage
      .service()
      .submit(f.storage.principal(), submission(bytes, key));
    const original = committed(f, key);
    const base = `/v1/enhancement-jobs/${seeded.job.jobId}`;
    expect(
      await f.call(
        "POST",
        "/v1/enhancement-jobs",
        multipart(uploadParts(bytes)),
        {
          ...f.uploadHeaders("wake-unauthenticated"),
          authorization: "Basic invalid",
        },
      ),
    ).toMatchObject({ status: 401, body: { code: "authentication_failed" } });
    expect(
      await f.upload(
        bytes,
        "wake-invalid-upload",
        uploadParts(bytes).slice(0, 1),
      ),
    ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    expect(await f.upload(await sourceImage("blue"), key)).toMatchObject({
      status: 409,
      body: { code: "idempotency_conflict" },
    });
    expect(
      await f.call("DELETE", "/v1/enhancement-jobs/missing"),
    ).toMatchObject({
      status: 404,
      body: { code: "job_not_found" },
    });
    f.setReady(false);
    expect(await f.upload(bytes, "wake-not-ready")).toMatchObject({
      status: 503,
      body: { code: "not_ready" },
    });
    for (const [method, path, status] of [
      ["GET", "/healthz", 200],
      ["GET", "/v1/capabilities", 200],
      ["GET", base, 200],
      ["GET", `${base}/result`, 409],
      ["POST", `${base}/receipt`, 409],
    ] as const)
      expect((await f.call(method, path)).status).toBe(status);
    expect(hook).not.toHaveBeenCalled();
    expect(committed(f, key)).toEqual(original);
    for (const failedKey of [
      "wake-unauthenticated",
      "wake-invalid-upload",
      "wake-not-ready",
    ]) {
      expect(committed(f, failedKey)).toEqual({ job: null, row: undefined });
    }
    expect(await f.inputNames()).toEqual([seeded.job.jobId]);
    expect(await f.original(seeded.job)).toEqual(bytes);
  });

  it("does not notify when the real SQLite acceptance or cancellation COMMIT fails", async () => {
    const hook = vi.fn();
    const f = await fixture({ onJobCommitted: hook });
    const bytes = await sourceImage();
    const key = "wake-preserved-before-commit-fault";
    const seeded = await f.storage
      .service()
      .submit(f.storage.principal(), submission(bytes, key));
    const original = committed(f, key);
    commitFault(
      f.storage,
      `CREATE TRIGGER wake_accept_commit_failure AFTER INSERT ON jobs
       BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;
       CREATE TRIGGER wake_cancel_commit_failure AFTER UPDATE OF cancel_requested_at ON jobs
       BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
    );
    await f.restart();
    expect(await f.upload(bytes, "wake-accept-commit-failure")).toMatchObject({
      status: 503,
      body: { code: "internal_error" },
    });
    expect(
      await f.call("DELETE", `/v1/enhancement-jobs/${seeded.job.jobId}`),
    ).toMatchObject({ status: 503, body: { code: "internal_error" } });
    expect(hook).not.toHaveBeenCalled();
    expect(committed(f, "wake-accept-commit-failure")).toEqual({
      job: null,
      row: undefined,
    });
    expect(committed(f, key)).toEqual(original);
    expect(await f.inputNames()).toEqual([seeded.job.jobId]);
    expect(await f.original(seeded.job)).toEqual(bytes);
  });
});
