import { readFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRunnerLimits, createWorkerConfig } from "../src/config.js";
import type { ClaimedAttempt, OwnerDescriptor } from "../src/execution.js";
import { createJobService } from "../src/jobs.js";
import { openStore, type EnhancementStore } from "../src/store.js";
import { configInput } from "./fixtures.js";
import {
  runnerLimits,
  sourceImage,
  storageFixture,
  submission,
  submissionLimits,
} from "./storage-fixtures.js";

type Fixture = Awaited<ReturnType<typeof storageFixture>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const f = await storageFixture();
  cleanups.push(() => f.cleanup());
  return f;
}

function snapshot<T>(f: Fixture, read: (db: Database.Database) => T): T {
  const db = new Database(readFileSync(join(f.directory, "worker.sqlite")));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function descriptor(attempt: ClaimedAttempt): OwnerDescriptor {
  return {
    adapterId: "controlled-fixture",
    launchTicket: attempt.launchTicket,
    executionId: `execution-${attempt.identity.jobId}`,
    details: { boundary: "prepared", generations: [1, true, null] },
  };
}

async function submit(f: Fixture, key = "first") {
  return f
    .service()
    .submit(f.principal(), submission(await sourceImage(), key));
}

describe("explicit runner limits", () => {
  it("accepts and freezes a complete administrator contract without defaults", () => {
    const parsed = createRunnerLimits({ ...runnerLimits });
    expect(parsed).toEqual(runnerLimits);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    undefined,
    {},
    { ...runnerLimits, executionTimeoutMs: 0 },
    { ...runnerLimits, leaseDurationMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...runnerLimits, cancelGraceMs: -1 },
    { ...runnerLimits, heartbeatIntervalMs: 1.5 },
    { ...runnerLimits, heartbeatIntervalMs: "5000" },
    { ...runnerLimits, extra: true },
    {
      ...runnerLimits,
      heartbeatIntervalMs: runnerLimits.leaseDurationMs + 1,
    },
  ])("rejects an incomplete or unsafe runner contract %#", (value) => {
    expect(() => createRunnerLimits(value)).toThrowError(
      expect.objectContaining({ code: "configuration_invalid" }),
    );
  });
});

describe("durable single-slot claims", () => {
  it("publishes only the fixed receive-to-first-claim queue interval across reads and reopen", async () => {
    const f = await fixture();
    const accepted = await submit(f);
    f.setNow(1_400);
    expect(f.service().get(f.principal(), accepted.job.jobId)).not.toHaveProperty(
      "timings.workerQueueMs",
    );
    const attempt = f.store.claimNext("timing-owner");
    expect(attempt?.job).toMatchObject({ timings: { workerQueueMs: 400 } });
    const claimed = f.service().get(f.principal(), accepted.job.jobId);
    expect(claimed).toMatchObject({ timings: { workerQueueMs: 400 } });
    expect(claimed).not.toHaveProperty("timings.workerExecutionMs");
    const facts = snapshot(f, (db) =>
      db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(accepted.job.jobId),
    );
    f.setNow(2_500);
    expect(f.service().get(f.principal(), accepted.job.jobId)).toEqual(claimed);
    expect(snapshot(f, (db) =>
      db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(accepted.job.jobId),
    )).toEqual(facts);
    f.store.close();
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.service().get(f.principal(), accepted.job.jobId)).toEqual(claimed);
  });

  it("does not replace an unclaimed queue timeout with a fabricated zero duration", async () => {
    const f = await fixture();
    const accepted = await submit(f);
    f.setNow(accepted.job.queueDeadlineAt + 1);
    expect(f.store.claimNext("expired-timing-owner")).toBeUndefined();
    const failed = f.service().get(f.principal(), accepted.job.jobId);
    expect(failed).toMatchObject({ status: "failed", reason: "queue_timeout" });
    expect(failed).not.toHaveProperty("timings.workerQueueMs");
    expect(failed).not.toHaveProperty("timings.workerExecutionMs");
  });

  it("creates schema version 7 and reopens its identity, job and accepted input", async () => {
    const f = await fixture();
    const accepted = await submit(f);
    const identity = f.store.identity;
    const inputDirectory = join(f.store.inputDirectory, accepted.job.jobId);
    const originalPath = join(inputDirectory, "original.jpeg");
    const enginePath = join(inputDirectory, "engine.png");
    const original = readFileSync(originalPath);
    const engine = readFileSync(enginePath);
    f.store.close();
    expect(
      snapshot(f, (check) => check.pragma("user_version", { simple: true })),
    ).toBe(7);
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.store.identity).toEqual(identity);
    expect(f.service().get(f.principal(), accepted.job.jobId)).toEqual(
      accepted.job,
    );
    expect(readFileSync(originalPath)).toEqual(original);
    expect(readFileSync(enginePath)).toEqual(engine);
  });

  it.each(
    [1, 4, 5, 6, 8].flatMap((version) =>
      ["DELETE", "WAL"].map((journalMode) => ({ version, journalMode })),
    ),
  )(
    "rejects mismatched schema version $version in $journalMode mode without changing database bytes or removing accepted input",
    async ({ version, journalMode }) => {
      const f = await fixture();
      const accepted = await submit(f);
      const inputDirectory = join(f.store.inputDirectory, accepted.job.jobId);
      const originalPath = join(inputDirectory, "original.jpeg");
      const enginePath = join(inputDirectory, "engine.png");
      const original = readFileSync(originalPath);
      const engine = readFileSync(enginePath);
      f.store.close();
      const before = snapshot(f, (check) => ({
        version: check.pragma("user_version", { simple: true }),
        identity: check
          .prepare("SELECT * FROM service_identity ORDER BY singleton")
          .all(),
        jobs: check.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
        incarnations: check
          .prepare("SELECT * FROM store_incarnations ORDER BY incarnation_id")
          .all(),
      }));
      expect(before.version).toBe(7);
      const databasePath = join(f.directory, "worker.sqlite");
      const db = new Database(databasePath);
      try {
        expect(
          db.pragma(`journal_mode = ${journalMode}`, { simple: true }),
        ).toBe(journalMode.toLowerCase());
        db.pragma(`user_version = ${version}`);
      } finally {
        db.close();
      }
      const databaseBefore = readFileSync(databasePath);
      // Confirm the closed database header retained the requested journal mode.
      expect([...databaseBefore.subarray(18, 20)]).toEqual(
        journalMode === "WAL" ? [2, 2] : [1, 1],
      );
      let reopened: EnhancementStore | undefined;
      try {
        expect(() => {
          reopened = openStore({ directory: f.directory, clock: f.clock });
        }).toThrowError(
          expect.objectContaining({ code: "configuration_invalid" }),
        );
      } finally {
        reopened?.close();
      }
      expect(readFileSync(databasePath)).toEqual(databaseBefore);
      const probe = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
        timeout: 0,
      });
      try {
        expect(probe.pragma("user_version", { simple: true })).toBe(version);
        expect(
          probe
            .prepare("SELECT * FROM service_identity ORDER BY singleton")
            .all(),
        ).toEqual(before.identity);
        expect(
          probe.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
        ).toEqual(before.jobs);
        expect(
          probe
            .prepare("SELECT * FROM store_incarnations ORDER BY incarnation_id")
            .all(),
        ).toEqual(before.incarnations);
        expect(probe.prepare("SELECT job_id, status FROM jobs").all()).toEqual([
          { job_id: accepted.job.jobId, status: "queued" },
        ]);
      } finally {
        probe.close();
      }
      expect(readFileSync(originalPath)).toEqual(original);
      expect(readFileSync(enginePath)).toEqual(engine);
    },
  );

  it("commits running, a launch ticket, frozen deadlines and the exclusive slot together", async () => {
    const f = await fixture();
    const accepted = await submit(f);
    const claimed = f.store.claimNext("owner-first");
    expect(claimed).toMatchObject({
      identity: {
        jobId: accepted.job.jobId,
        attemptNo: 1,
        fence: 1,
        ownerInstanceId: "owner-first",
      },
      job: { status: "running", reason: null },
      firstStartedAt: 1_000,
      executionDeadlineAt: 61_000,
      leaseExpiresAt: 16_000,
      executionPolicy: { limits: runnerLimits, allowedTiles: [0, 128, 256] },
      tile: 256,
      inputPath: join(f.store.inputDirectory, accepted.job.jobId, "engine.png"),
    });
    expect(claimed!.launchTicket).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(claimed!.workingDirectory).toContain(accepted.job.jobId);
    expect(claimed!.outputPath.startsWith(claimed!.workingDirectory)).toBe(
      true,
    );
    expect(Object.isFrozen(claimed!.executionPolicy.limits)).toBe(true);
    expect(
      snapshot(f, (db) => ({
        slot: db
          .prepare("SELECT job_id, attempt_no, fence FROM execution_slot")
          .get(),
        attempts: db
          .prepare("SELECT launch_ticket, authorized_at FROM attempts")
          .all(),
        job: db
          .prepare(
            "SELECT status, first_started_at, execution_deadline_at FROM jobs",
          )
          .get(),
      })),
    ).toEqual({
      slot: { job_id: accepted.job.jobId, attempt_no: 1, fence: 1 },
      attempts: [{ launch_ticket: claimed!.launchTicket, authorized_at: null }],
      job: {
        status: "running",
        first_started_at: 1_000,
        execution_deadline_at: 61_000,
      },
    });
    const publicJob = f.service().get(f.principal(), accepted.job.jobId);
    expect(publicJob.status).toBe("running");
    const serialized = JSON.stringify(publicJob);
    for (const privateValue of [
      f.directory,
      claimed!.launchTicket,
      "executionPolicy",
      "ownerInstanceId",
      "ownerDescriptor",
    ])
      expect(serialized).not.toContain(privateValue);
  });

  it("enforces the single slot and its attempt relation in SQLite", async () => {
    const f = await fixture();
    await submit(f);
    f.store.claimNext("owner-first");
    f.store.close();
    const db = new Database(join(f.directory, "worker.sqlite"));
    try {
      db.pragma("foreign_keys = ON");
      expect(() =>
        db.exec("INSERT INTO execution_slot SELECT * FROM execution_slot"),
      ).toThrow();
      expect(() =>
        db.exec("UPDATE execution_slot SET singleton = 2"),
      ).toThrow();
      expect(() =>
        db.exec("UPDATE execution_slot SET fence = fence + 1"),
      ).toThrow();
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM execution_slot").get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it.each([-1, 0, 1])(
    "uses the original queue deadline at offset %i",
    async (offset) => {
      const f = await fixture();
      const accepted = await submit(f);
      f.setNow(accepted.job.queueDeadlineAt + offset);
      const claimed = f.store.claimNext("queue-boundary-owner");
      const persisted = f.service().get(f.principal(), accepted.job.jobId);
      expect(persisted.queueDeadlineAt).toBe(accepted.job.queueDeadlineAt);
      if (offset <= 0) {
        expect(claimed?.identity.jobId).toBe(accepted.job.jobId);
        expect(persisted.status).toBe("running");
      } else {
        expect(claimed).toBeUndefined();
        expect(persisted).toMatchObject({
          status: "failed",
          reason: "queue_timeout",
          completedAt: accepted.job.queueDeadlineAt + offset,
        });
        expect(
          snapshot(f, (db) =>
            db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
          ),
        ).toEqual({ count: 0 });
        expect(
          snapshot(f, (db) =>
            db.prepare("SELECT COUNT(*) AS count FROM execution_slot").get(),
          ),
        ).toEqual({ count: 0 });
      }
    },
  );

  it("converges expired queued tasks before measuring new waiting capacity", async () => {
    const f = await fixture();
    const first = await submit(f, "expired-first");
    const second = await submit(f, "expired-second");
    f.setNow(first.job.queueDeadlineAt + 1);
    const fresh = await submit(f, "fresh");
    expect(fresh.job.status).toBe("queued");
    for (const old of [first, second]) {
      expect(f.service().get(f.principal(), old.job.jobId)).toMatchObject({
        status: "failed",
        reason: "queue_timeout",
        queueDeadlineAt: old.job.queueDeadlineAt,
      });
    }
    expect(
      snapshot(f, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
      ),
    ).toEqual({ count: 0 });
    await submit(f, "fresh-second");
    await expect(submit(f, "overflow")).rejects.toMatchObject({
      code: "queue_full",
      status: 429,
    });
  });

  it("retains unique insertion order for identical creation times", async () => {
    const f = await fixture();
    const removed = await submit(f, "removed");
    const second = await submit(f, "second");
    f.store.requestCancel(f.principal(), removed.job.jobId);
    const third = await submit(f, "third");
    expect(second.job.createdAt).toBe(third.job.createdAt);
    expect(f.store.claimNext("stable-owner")?.identity.jobId).toBe(
      second.job.jobId,
    );
    const sequence = snapshot(f, (db) =>
      db
        .prepare("SELECT queue_sequence FROM jobs ORDER BY queue_sequence")
        .all(),
    ) as { queue_sequence: number }[];
    expect(sequence.map((row) => row.queue_sequence)).toEqual([1, 2, 3]);
  });

  it("orders by accepted creation time before the stable tie breaker", async () => {
    const f = await fixture();
    await submit(f, "created-later");
    f.setNow(0);
    const earlier = await submit(f, "created-earlier");
    expect(f.store.claimNext("time-order-owner")?.identity.jobId).toBe(
      earlier.job.jobId,
    );
  });

  it("allows only one claim across concurrent callers", async () => {
    const f = await fixture();
    const first = await submit(f, "first");
    await submit(f, "second");
    const claims = await Promise.all([
      Promise.resolve().then(() => f.store.claimNext("owner-a")),
      Promise.resolve().then(() => f.store.claimNext("owner-b")),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.identity.jobId).toBe(first.job.jobId);
    expect(
      snapshot(f, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
      ),
    ).toEqual({ count: 1 });
  });

  it.each(["cancel-first", "claim-first"])(
    "resolves queued cancel and claim atomically: %s",
    async (order) => {
      const f = await fixture();
      const accepted = await submit(f);
      if (order === "cancel-first") {
        expect(
          f.store.requestCancel(f.principal(), accepted.job.jobId).job.status,
        ).toBe("cancelled");
        expect(f.store.claimNext("racing-owner")).toBeUndefined();
      } else {
        expect(f.store.claimNext("racing-owner")?.identity.jobId).toBe(
          accepted.job.jobId,
        );
        expect(
          f.service().cancel(f.principal(), accepted.job.jobId),
        ).toMatchObject({
          status: 202,
          applied: true,
          job: { status: "running", cancelRequested: true },
        });
        expect(
          f.service().get(f.principal(), accepted.job.jobId),
        ).toMatchObject({ status: "running", reason: null, completedAt: null });
      }
    },
  );

  it("replays a running job before readiness, full waiting capacity and changed configuration", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const request = submission(bytes, "running-replay");
    const accepted = await f.service().submit(f.principal(), request);
    f.store.claimNext("replay-owner");
    await submit(f, "waiting-a");
    await submit(f, "waiting-b");
    f.setReady(false);
    const config = configInput();
    config.models[0]!.id = "different-model";
    f.setConfig(createWorkerConfig(config));
    const replayed = await f.service().submit(f.principal(), request);
    expect(replayed).toMatchObject({
      replayed: true,
      job: { jobId: accepted.job.jobId, status: "running" },
    });
    expect(replayed.job.plan).toEqual(accepted.job.plan);
    expect(
      snapshot(f, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
      ),
    ).toEqual({ count: 3 });
  });

  it.each(["cancelled", "failed"])(
    "replays the original %s terminal record without requeueing",
    async (status) => {
      const f = await fixture();
      const request = submission(await sourceImage(), "terminal-replay");
      const accepted = await f.service().submit(f.principal(), request);
      if (status === "cancelled")
        f.store.requestCancel(f.principal(), accepted.job.jobId);
      else {
        f.setNow(accepted.job.queueDeadlineAt + 1);
        expect(f.store.claimNext("terminal-owner")).toBeUndefined();
      }
      const terminal = f.service().get(f.principal(), accepted.job.jobId);
      f.setReady(false);
      expect(await f.service().submit(f.principal(), request)).toEqual({
        job: terminal,
        replayed: true,
      });
      expect(terminal.status).toBe(status);
      expect(
        snapshot(f, (db) =>
          db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
        ),
      ).toEqual({ count: 0 });
    },
  );

  it("freezes independent execution policy and replays it unchanged after configuration changes", async () => {
    const f = await fixture();
    const request = submission(await sourceImage(), "frozen-policy");
    await f.service().submit(f.principal(), request);
    const before = f.store.findByKey(f.principal(), request.idempotencyKey)!;
    expect(before.executionPolicy).toMatchObject({
      limits: runnerLimits,
      allowedTiles: [0, 128, 256],
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(before.executionPolicy?.limits)).toBe(true);
    expect(Object.isFrozen(before.executionPolicy?.allowedTiles)).toBe(true);
    const next = configInput();
    next.models[0]!.allowedTiles = [128, 256];
    f.setConfig(createWorkerConfig(next));
    f.setRunnerLimits({
      ...runnerLimits,
      executionTimeoutMs: runnerLimits.executionTimeoutMs * 2,
    });
    expect((await f.service().submit(f.principal(), request)).replayed).toBe(
      true,
    );
    expect(
      f.store.findByKey(f.principal(), request.idempotencyKey)?.executionPolicy,
    ).toEqual(before.executionPolicy);
    const fresh = await f
      .service()
      .submit(f.principal(), { ...request, idempotencyKey: "fresh-policy" });
    const after = f.store.findByKey(f.principal(), "fresh-policy")!;
    expect(after.executionPolicy).toMatchObject({
      limits: {
        ...runnerLimits,
        executionTimeoutMs: runnerLimits.executionTimeoutMs * 2,
      },
      allowedTiles: [128, 256],
    });
    expect(after.executionPolicy?.fingerprint).not.toBe(
      before.executionPolicy?.fingerprint,
    );
    expect(fresh.job.plan.planFingerprint).toBe(
      before.job.plan.planFingerprint,
    );
    f.store.close();
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(
      f.store.findByKey(f.principal(), request.idempotencyKey)?.executionPolicy,
    ).toEqual(before.executionPolicy);
  });

  it("takes plan and allowed tiles from exactly one controlled configuration snapshot", async () => {
    const f = await fixture();
    const config = vi.fn(() => createWorkerConfig(configInput()));
    const service = createJobService({
      store: f.store,
      config,
      ready: () => true,
      limits: submissionLimits,
      runnerLimits,
    });
    const request = submission(await sourceImage(), "one-snapshot");
    const first = await service.submit(f.principal(), request);
    expect(config).toHaveBeenCalledTimes(1);
    expect(
      f.store.findByKey(f.principal(), request.idempotencyKey)?.executionPolicy
        ?.allowedTiles,
    ).toEqual([0, 128, 256]);
    expect((await service.submit(f.principal(), request)).job).toEqual(
      first.job,
    );
    expect(config).toHaveBeenCalledTimes(1);
  });

  it("rolls back a claim whose derived global deadline exceeds safe integer time", async () => {
    const f = await fixture();
    f.setNow(Number.MAX_SAFE_INTEGER - submissionLimits.queueTimeoutMs - 1);
    const accepted = await submit(f);
    expect(() => f.store.claimNext("overflow-owner")).toThrowError(
      expect.objectContaining({ code: "configuration_invalid" }),
    );
    expect(f.service().get(f.principal(), accepted.job.jobId).status).toBe(
      "queued",
    );
    expect(
      snapshot(f, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM execution_slot").get(),
      ),
    ).toEqual({ count: 0 });
    expect(
      snapshot(f, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
      ),
    ).toEqual({ count: 0 });
  });
});

describe("persistent prepare and authorize barriers", () => {
  it("requires a matching prepared descriptor and persists authorization only once", async () => {
    const f = await fixture();
    await submit(f);
    const attempt = f.store.claimNext("barrier-owner")!;
    const owner = descriptor(attempt);
    expect(f.store.authorizeLaunch(attempt.identity, owner)).toBe(false);
    expect(f.store.registerPrepared(attempt.identity, owner)).toBe(true);
    expect(
      snapshot(f, (db) =>
        db
          .prepare(
            "SELECT owner_descriptor_json, prepared_at, authorized_at FROM attempts",
          )
          .get(),
      ),
    ).toEqual({
      owner_descriptor_json: JSON.stringify(owner),
      prepared_at: 1_000,
      authorized_at: null,
    });
    expect(f.store.registerPrepared(attempt.identity, owner)).toBe(false);
    expect(
      f.store.authorizeLaunch(attempt.identity, {
        ...owner,
        executionId: "different-execution",
      }),
    ).toBe(false);
    expect(f.store.authorizeLaunch(attempt.identity, owner)).toBe(true);
    f.setNow(1_001);
    expect(f.store.authorizeLaunch(attempt.identity, owner)).toBe(false);
    expect(
      snapshot(f, (db) =>
        db.prepare("SELECT authorized_at FROM attempts").get(),
      ),
    ).toEqual({ authorized_at: 1_000 });
  });

  it("rejects old owner or fence without changing current attempt or slot", async () => {
    const f = await fixture();
    await submit(f);
    const attempt = f.store.claimNext("current-owner")!;
    const owner = descriptor(attempt);
    for (const identity of [
      { ...attempt.identity, ownerInstanceId: "old-owner" },
      { ...attempt.identity, fence: attempt.identity.fence + 1 },
      { ...attempt.identity, attemptNo: attempt.identity.attemptNo + 1 },
    ]) {
      expect(f.store.registerPrepared(identity, owner)).toBe(false);
      expect(f.store.authorizeLaunch(identity, owner)).toBe(false);
    }
    expect(
      snapshot(f, (db) =>
        db
          .prepare("SELECT owner_descriptor_json, authorized_at FROM attempts")
          .get(),
      ),
    ).toEqual({ owner_descriptor_json: null, authorized_at: null });
    expect(f.store.claimNext("replacement-owner")).toBeUndefined();
  });

  it.each([
    "wrong-ticket",
    "undefined-json",
    "nonfinite-json",
    "cyclic-json",
    "non-enumerable-ticket",
    "non-enumerable-detail",
  ])("never persists an invalid owner descriptor: %s", async (kind) => {
    const f = await fixture();
    await submit(f);
    const attempt = f.store.claimNext("descriptor-owner")!;
    const owner: Record<string, unknown> = { ...descriptor(attempt) };
    if (kind === "wrong-ticket") owner.launchTicket = "different-ticket";
    if (kind === "undefined-json") owner.details = { hidden: undefined };
    if (kind === "nonfinite-json")
      owner.details = { hidden: Number.POSITIVE_INFINITY };
    if (kind === "cyclic-json") {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      owner.details = cyclic;
    }
    if (kind === "non-enumerable-ticket") {
      Object.defineProperty(owner, "launchTicket", {
        value: attempt.launchTicket,
        enumerable: false,
      });
    }
    if (kind === "non-enumerable-detail") {
      const details = { controlled: true };
      Object.defineProperty(details, "hidden", {
        value: "unpersisted-fixture-fact",
        enumerable: false,
      });
      owner.details = details;
    }
    expect(() =>
      f.store.registerPrepared(
        attempt.identity,
        owner as unknown as OwnerDescriptor,
      ),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
    expect(
      snapshot(f, (db) =>
        db
          .prepare("SELECT owner_descriptor_json, authorized_at FROM attempts")
          .get(),
      ),
    ).toEqual({ owner_descriptor_json: null, authorized_at: null });
    expect(f.store.claimNext("replacement-owner")).toBeUndefined();
  });

  it.each(
    (["prepare", "authorize"] as const).flatMap((phase) =>
      (["lease", "execution"] as const).flatMap((deadline) =>
        [-1, 0, 1].map((offset) => ({ phase, deadline, offset })),
      ),
    ),
  )(
    "checks $phase at the $deadline boundary offset $offset",
    async ({ phase, deadline, offset }) => {
      const f = await fixture();
      if (deadline === "execution")
        f.setRunnerLimits({
          ...runnerLimits,
          executionTimeoutMs: runnerLimits.heartbeatIntervalMs,
        });
      await submit(f);
      const attempt = f.store.claimNext("deadline-owner")!;
      const owner = descriptor(attempt);
      if (phase === "authorize")
        expect(f.store.registerPrepared(attempt.identity, owner)).toBe(true);
      f.setNow(
        (deadline === "lease"
          ? attempt.leaseExpiresAt
          : attempt.executionDeadlineAt) + offset,
      );
      const changed =
        phase === "prepare"
          ? f.store.registerPrepared(attempt.identity, owner)
          : f.store.authorizeLaunch(attempt.identity, owner);
      expect(changed).toBe(offset <= 0);
      expect(
        f.store.getOwned(f.principal(), attempt.identity.jobId).status,
      ).toBe("running");
      expect(f.store.claimNext("replacement-owner")).toBeUndefined();
    },
  );
});
