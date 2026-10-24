import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaimedAttempt } from "../src/execution.js";
import { openStore } from "../src/store.js";
import { commitFault, snapshot } from "./lifecycle-fixtures.js";
import { recoveryFixture, type RecoveryFixture } from "./recovery-fixtures.js";
import {
  sourceImage,
  storageFixture,
  submission,
  submissionLimits,
} from "./storage-fixtures.js";

type Storage = Awaited<ReturnType<typeof storageFixture>>;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture() {
  const storage = await storageFixture();
  cleanups.push(() => storage.cleanup());
  return storage;
}

async function submit(storage: Storage, key: string) {
  return storage
    .service()
    .submit(storage.principal(), submission(await sourceImage(), key));
}

function exact(storage: Storage, jobId: unknown) {
  return Reflect.apply(storage.store.claimNext, storage.store, [
    "selection-owner",
    jobId,
  ]) as ClaimedAttempt | undefined;
}

function rows(storage: Storage) {
  return snapshot(storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
    attempts: db.prepare("SELECT * FROM attempts ORDER BY rowid").all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
    controls: db
      .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
      .all(),
    events: db.prepare("SELECT * FROM recovery_events ORDER BY rowid").all(),
  }));
}

function expectUnchanged(storage: Storage, before: ReturnType<typeof rows>) {
  expect(isDeepStrictEqual(rows(storage), before), "durable claim facts").toBe(
    true,
  );
}

describe("Store exact queued selection", () => {
  it("claims only the later target with its original policy, ticket and exclusive slot", async () => {
    const storage = await fixture();
    const ordinary = await submit(storage, "ordinary-earlier");
    storage.setNow(storage.clock() + 1);
    const selected = await submit(storage, "selected-later");
    const stored = storage.store.findByKey(
      storage.principal(),
      "selected-later",
    );
    expect(stored !== undefined).toBe(true);
    storage.setRunnerLimits({
      ...stored!.executionPolicy.limits,
      executionTimeoutMs: stored!.executionPolicy.limits.executionTimeoutMs + 1,
    });

    const attempt = exact(storage, selected.job.jobId);
    expect(attempt !== undefined, "selected queued job is claimed").toBe(true);
    expect(attempt!.identity.jobId === selected.job.jobId).toBe(true);
    expect(attempt!.identity.attemptNo).toBe(1);
    expect(attempt!.identity.fence).toBe(1);
    expect(attempt!.identity.ownerInstanceId).toBe("selection-owner");
    expect(attempt!.firstStartedAt).toBe(storage.clock());
    expect(attempt!.executionDeadlineAt).toBe(
      storage.clock() + stored!.executionPolicy.limits.executionTimeoutMs,
    );
    expect(attempt!.leaseExpiresAt).toBe(
      storage.clock() + stored!.executionPolicy.limits.leaseDurationMs,
    );
    expect(
      isDeepStrictEqual(attempt!.executionPolicy, stored!.executionPolicy),
      "original frozen policy",
    ).toBe(true);
    expect(Object.isFrozen(attempt!.executionPolicy.limits)).toBe(true);
    expect(attempt!.outputPath.startsWith(attempt!.workingDirectory)).toBe(
      true,
    );
    expect(
      attempt!.inputPath ===
        join(storage.store.inputDirectory, selected.job.jobId, "engine.png"),
    ).toBe(true);
    expect(
      snapshot(storage, (db) => {
        const slot = db
          .prepare("SELECT job_id, attempt_no, fence FROM execution_slot")
          .all() as { job_id: string; attempt_no: number; fence: number }[];
        const attempts = db
          .prepare("SELECT job_id, launch_ticket, authorized_at FROM attempts")
          .all() as {
          job_id: string;
          launch_ticket: string;
          authorized_at: number | null;
        }[];
        return (
          slot.length === 1 &&
          slot[0]!.job_id === selected.job.jobId &&
          slot[0]!.attempt_no === 1 &&
          slot[0]!.fence === 1 &&
          attempts.length === 1 &&
          attempts[0]!.job_id === selected.job.jobId &&
          attempts[0]!.launch_ticket === attempt!.launchTicket &&
          attempts[0]!.authorized_at === null
        );
      }),
      "one committed target attempt and slot",
    ).toBe(true);
    expect(
      storage.service().get(storage.principal(), ordinary.job.jobId).status,
    ).toBe("queued");
    expect(exact(storage, ordinary.job.jobId) === undefined).toBe(true);
  });

  it("keeps the original FIFO order when the optional target is omitted", async () => {
    const storage = await fixture();
    const first = await submit(storage, "fifo-first");
    const second = await submit(storage, "fifo-second");
    const attempt = storage.store.claimNext("fifo-owner");
    expect(attempt?.identity.jobId === first.job.jobId).toBe(true);
    expect(
      storage.service().get(storage.principal(), second.job.jobId).status,
    ).toBe("queued");
    expect(storage.store.claimNext("another-owner") === undefined).toBe(true);
  });

  it.each(["missing", "cancelled", "failed", "expired"] as const)(
    "does not fall back to a live ordinary job when the exact target is %s",
    async (state) => {
      const storage = await fixture();
      let jobId = "missing-selected-job";
      if (state !== "missing") {
        const selected = await submit(storage, "unavailable-selected");
        jobId = selected.job.jobId;
        if (state === "cancelled")
          storage.store.requestCancel(storage.principal(), jobId);
        if (state === "failed") {
          storage.setNow(selected.job.queueDeadlineAt + 1);
          expect(storage.store.claimNext("expiry-owner") === undefined).toBe(
            true,
          );
        }
        if (state === "expired") storage.setNow(storage.clock() + 1);
      }
      const ordinary = await submit(storage, "live-ordinary");
      if (state === "expired")
        storage.setNow(1_000 + submissionLimits.queueTimeoutMs + 1);

      expect(exact(storage, jobId) === undefined).toBe(true);
      expect(
        storage.service().get(storage.principal(), ordinary.job.jobId).status,
      ).toBe("queued");
      const durable = rows(storage);
      expect(durable.attempts.length).toBe(0);
      expect(durable.slot.length).toBe(0);
      if (state !== "missing") {
        const target = storage.service().get(storage.principal(), jobId);
        expect(target.status).toBe(
          state === "cancelled" ? "cancelled" : "failed",
        );
        if (state !== "cancelled") expect(target.reason).toBe("queue_timeout");
      }
    },
  );

  it("still expires an unrelated old queue row when the exact target is live", async () => {
    const storage = await fixture();
    const old = await submit(storage, "expired-ordinary");
    storage.setNow(storage.clock() + 1);
    const selected = await submit(storage, "live-selected");
    storage.setNow(old.job.queueDeadlineAt + 1);
    const attempt = exact(storage, selected.job.jobId);
    expect(attempt?.identity.jobId === selected.job.jobId).toBe(true);
    const expired = storage.service().get(storage.principal(), old.job.jobId);
    expect(expired.status).toBe("failed");
    expect(expired.reason).toBe("queue_timeout");
    expect(rows(storage).attempts.length).toBe(1);
  });

  it.each(["", " leading", "trailing ", "bad\u0000id", null, 7, {}])(
    "rejects invalid exact input %# before clock reads or expiry writes",
    async (jobId) => {
      const storage = await fixture();
      const old = await submit(storage, "expiry-must-not-run");
      storage.setNow(storage.clock() + 1);
      await submit(storage, "ordinary-must-not-run");
      storage.setNow(old.job.queueDeadlineAt + 1);
      storage.store.close();
      const clock = vi.fn(storage.clock);
      storage.setStore(openStore({ directory: storage.directory, clock }));
      clock.mockClear();
      const before = rows(storage);

      expect(() => exact(storage, jobId)).toThrowError(
        expect.objectContaining({ code: "configuration_invalid" }),
      );
      expect(clock).not.toHaveBeenCalled();
      expectUnchanged(storage, before);
    },
  );

  it.each(["held", "expired-lease", "unknown-recovery"] as const)(
    "cannot take a second slot from an existing %s attempt",
    async (state) => {
      const f: RecoveryFixture = await recoveryFixture();
      cleanups.push(() => f.cleanup());
      const original = await f.claim("authorized");
      const waiting = await f.submit("exact-waiting");
      f.storage.store.requestCancel(
        f.storage.principal(),
        original.identity.jobId,
      );
      if (state !== "held") f.storage.setNow(original.leaseExpiresAt + 1);
      if (state === "unknown-recovery") {
        await f.reopen();
        const session = f.storage.store.beginRecovery("unknown-controller");
        expect(session !== undefined).toBe(true);
        const outcome = f.storage.store.applyRecoveryInspection(
          session!.control,
          {
            kind: "unknown",
            ...session!.target,
          },
        );
        expect(outcome?.kind).toBe("unknown");
      }
      const before = rows(f.storage);
      expect(exact(f.storage, waiting.job.jobId) === undefined).toBe(true);
      expectUnchanged(f.storage, before);
      expect(f.executor.launchCalls.length).toBe(1);
      expect(
        f.storage.service().get(f.storage.principal(), waiting.job.jobId)
          .status,
      ).toBe("queued");
    },
  );

  it("rolls back target selection, attempts and slot together when the real claim COMMIT fails", async () => {
    const storage = await fixture();
    await submit(storage, "rollback-ordinary");
    const selected = await submit(storage, "rollback-selected");
    commitFault(
      storage,
      `CREATE TRIGGER selected_claim_commit AFTER INSERT ON attempts
       BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
    );
    const before = rows(storage);
    expect(() => exact(storage, selected.job.jobId)).toThrowError(
      expect.objectContaining({ code: "internal_error" }),
    );
    expectUnchanged(storage, before);
    expect(rows(storage).attempts.length).toBe(0);
  });
});
