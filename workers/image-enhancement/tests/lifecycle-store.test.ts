import { afterEach, describe, expect, it } from "vitest";

import { openStore } from "../src/store.js";
import {
  commitFault,
  descriptor,
  snapshot,
  treeExit,
  type StorageFixture,
} from "./lifecycle-fixtures.js";
import {
  runnerLimits,
  sourceImage,
  storageFixture,
  submission,
} from "./storage-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const f = await storageFixture();
  cleanups.push(() => f.cleanup());
  return f;
}
async function claim(f: StorageFixture, key = "lifecycle-first") {
  await f.service().submit(f.principal(), submission(await sourceImage(), key));
  return f.store.claimNext("lifecycle-owner")!;
}
async function authorized(f: StorageFixture) {
  const attempt = await claim(f);
  const owner = descriptor(attempt);
  expect(f.store.registerPrepared(attempt.identity, owner)).toBe(true);
  expect(f.store.authorizeLaunch(attempt.identity, owner)).toBe(true);
  return attempt;
}
function stops(f: StorageFixture) {
  return snapshot(f, (db) =>
    db
      .prepare(
        "SELECT stop_reason, stop_requested_at, terminate_after_at FROM attempts",
      )
      .get(),
  );
}

describe("durable lease and stop compare-and-swap", () => {
  it("reads frozen active facts by the captured identity without accepting a different tuple", async () => {
    const f = await fixture();
    const attempt = await authorized(f);
    const active = f.store.getActiveAttempt(attempt.identity)!;
    expect(active).toMatchObject({
      ...attempt,
      ownerDescriptor: descriptor(attempt),
      preparedAt: 1_000,
      authorizedAt: 1_000,
      stopReason: null,
      stopRequestedAt: null,
      terminateAfterAt: null,
      exit: null,
    });
    expect(Object.isFrozen(active)).toBe(true);
    for (const identity of [
      { ...attempt.identity, ownerInstanceId: "wrong-owner" },
      { ...attempt.identity, attemptNo: 2 },
      { ...attempt.identity, fence: 2 },
    ])
      expect(f.store.getActiveAttempt(identity)).toBeUndefined();
    f.setNow(attempt.leaseExpiresAt + 1);
    expect(f.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt).toBe(
      attempt.leaseExpiresAt,
    );
  });

  it.each([-1, 0, 1])(
    "renews only while the original lease is valid at offset %i",
    async (offset) => {
      const f = await fixture();
      const attempt = await authorized(f);
      f.setNow(attempt.leaseExpiresAt + offset);
      expect(f.store.renewLease(attempt.identity)).toBe(offset <= 0);
      expect(f.store.getActiveAttempt(attempt.identity)).toMatchObject({
        leaseExpiresAt:
          offset <= 0
            ? f.clock() + runnerLimits.leaseDurationMs
            : attempt.leaseExpiresAt,
        executionDeadlineAt: attempt.executionDeadlineAt,
        firstStartedAt: attempt.firstStartedAt,
      });
      expect(f.store.claimNext("replacement-owner")).toBeUndefined();
    },
  );

  it("rejects wrong owner, attempt and fence for every lifecycle write", async () => {
    const f = await fixture();
    const attempt = await authorized(f);
    for (const identity of [
      { ...attempt.identity, ownerInstanceId: "old-owner" },
      { ...attempt.identity, attemptNo: 2 },
      { ...attempt.identity, fence: 2 },
    ]) {
      expect(f.store.renewLease(identity)).toBe(false);
      expect(f.store.requestStop(identity, "user_cancel")).toBe(false);
      expect(f.store.registerExit({ ...treeExit(attempt), identity })).toBe(
        false,
      );
      expect(f.store.finishCancelled(identity)).toBe(false);
    }
    expect(stops(f)).toEqual({
      stop_reason: null,
      stop_requested_at: null,
      terminate_after_at: null,
    });
    expect(f.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt).toBe(
      attempt.leaseExpiresAt,
    );
  });

  it("persists first running cancellation once and keeps its grace across reopen and timeout", async () => {
    const f = await fixture();
    const attempt = await authorized(f);
    const first = f.service().cancel(f.principal(), attempt.identity.jobId);
    expect(first).toMatchObject({
      status: 202,
      applied: true,
      job: {
        status: "running",
        reason: null,
        cancelRequested: true,
        completedAt: null,
      },
    });
    const saved = stops(f);
    expect(saved).toEqual({
      stop_reason: "user_cancel",
      stop_requested_at: 1_000,
      terminate_after_at: 6_000,
    });
    f.setNow(2_000);
    expect(
      f.service().cancel(f.principal(), attempt.identity.jobId),
    ).toMatchObject({ status: 202, applied: false });
    expect(f.store.requestStop(attempt.identity, "execution_timeout")).toBe(
      false,
    );
    f.store.close();
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(
      f.service().cancel(f.principal(), attempt.identity.jobId),
    ).toMatchObject({ status: 202, applied: false });
    expect(stops(f)).toEqual(saved);
  });

  it("records a first user cancellation after timeout without replacing its older stop facts", async () => {
    const f = await fixture();
    f.setRunnerLimits({ ...runnerLimits, executionTimeoutMs: 5_000 });
    const attempt = await authorized(f);
    f.setNow(6_001);
    expect(f.store.requestStop(attempt.identity, "execution_timeout")).toBe(
      true,
    );
    f.setNow(7_000);
    expect(
      f.service().cancel(f.principal(), attempt.identity.jobId),
    ).toMatchObject({
      status: 202,
      applied: true,
      job: { status: "running", reason: null, cancelRequested: true },
    });
    expect(stops(f)).toEqual({
      stop_reason: "execution_timeout",
      stop_requested_at: 6_001,
      terminate_after_at: 11_001,
    });
  });

  it("accepts a principal cancellation after lease expiry but refuses all old owner actions", async () => {
    const f = await fixture();
    const attempt = await authorized(f);
    f.setNow(attempt.leaseExpiresAt + 1);
    expect(
      f.service().cancel(f.principal(), attempt.identity.jobId),
    ).toMatchObject({ status: 202, applied: true });
    expect(f.store.renewLease(attempt.identity)).toBe(false);
    expect(f.store.requestStop(attempt.identity, "execution_timeout")).toBe(
      false,
    );
    expect(f.store.registerExit(treeExit(attempt))).toBe(false);
    expect(f.store.finishCancelled(attempt.identity)).toBe(false);
    expect(f.store.claimNext("replacement-owner")).toBeUndefined();
  });

  it("renews a known authorized stop after the global deadline without extending that deadline", async () => {
    const f = await fixture();
    f.setRunnerLimits({ ...runnerLimits, executionTimeoutMs: 5_000 });
    const attempt = await authorized(f);
    f.setNow(attempt.executionDeadlineAt + 1);
    expect(f.store.renewLease(attempt.identity)).toBe(false);
    expect(f.store.requestStop(attempt.identity, "execution_timeout")).toBe(
      true,
    );
    expect(f.store.renewLease(attempt.identity)).toBe(true);
    expect(
      f.store.getActiveAttempt(attempt.identity)?.executionDeadlineAt,
    ).toBe(attempt.executionDeadlineAt);
    expect(f.store.registerExit(treeExit(attempt))).toBe(true);
    expect(f.store.finishCancelled(attempt.identity)).toBe(true);
    expect(
      f.store.getOwned(f.principal(), attempt.identity.jobId),
    ).toMatchObject({
      status: "cancelled",
      reason: "execution_timeout",
      cancelRequested: false,
      completedAt: attempt.executionDeadlineAt + 1,
    });
  });

  it("preserves the claim and original lease when renewal addition would overflow", async () => {
    const f = await fixture();
    f.setRunnerLimits({
      executionTimeoutMs: 3,
      leaseDurationMs: 3,
      heartbeatIntervalMs: 1,
      cancelGraceMs: 1,
    });
    f.setNow(Number.MAX_SAFE_INTEGER - 30_001);
    await f.service().submit(f.principal(), submission(await sourceImage()));
    f.setNow(Number.MAX_SAFE_INTEGER - 3);
    const attempt = f.store.claimNext("overflow-owner")!;
    f.setNow(Number.MAX_SAFE_INTEGER - 1);
    expect(() => f.store.renewLease(attempt.identity)).toThrowError(
      expect.objectContaining({ code: "configuration_invalid" }),
    );
    expect(f.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(f.store.claimNext("replacement-owner")).toBeUndefined();
  });
});

describe("controlled whole-tree exit evidence", () => {
  it.each(["owner", "attempt", "fence", "descriptor", "ticket", "not-tree"])(
    "refuses a nonmatching %s event without releasing the slot",
    async (kind) => {
      const f = await fixture();
      const attempt = await authorized(f);
      f.service().cancel(f.principal(), attempt.identity.jobId);
      const event = structuredClone(treeExit(attempt));
      if (kind === "owner")
        (event.identity as { ownerInstanceId: string }).ownerInstanceId =
          "old-owner";
      if (kind === "attempt")
        (event.identity as { attemptNo: number }).attemptNo++;
      if (kind === "fence") (event.identity as { fence: number }).fence++;
      if (kind === "descriptor")
        (event.descriptor as { executionId: string }).executionId =
          "other-execution";
      if (kind === "ticket")
        (event as { launchTicket: string }).launchTicket = "other-ticket";
      if (kind === "not-tree")
        (event as unknown as { treeExited: boolean }).treeExited = false;
      expect(f.store.registerExit(event)).toBe(false);
      expect(f.store.finishCancelled(attempt.identity)).toBe(false);
      expect(
        f.store.getOwned(f.principal(), attempt.identity.jobId).status,
      ).toBe("running");
      expect(f.store.claimNext("replacement-owner")).toBeUndefined();
    },
  );

  it("keeps a non-stopping precise exit as evidence and only frees its slot after cancelled COMMIT", async () => {
    const f = await fixture();
    const attempt = await authorized(f);
    await f
      .service()
      .submit(f.principal(), submission(await sourceImage(), "waiting"));
    expect(f.store.registerExit(treeExit(attempt))).toBe(true);
    expect(f.store.registerExit(treeExit(attempt))).toBe(false);
    expect(f.store.finishCancelled(attempt.identity)).toBe(false);
    expect(f.store.claimNext("replacement-owner")).toBeUndefined();
    f.service().cancel(f.principal(), attempt.identity.jobId);
    expect(f.store.finishCancelled(attempt.identity)).toBe(true);
    expect(f.store.finishCancelled(attempt.identity)).toBe(false);
    expect(f.store.registerExit(treeExit(attempt))).toBe(false);
    expect(
      f.service().cancel(f.principal(), attempt.identity.jobId),
    ).toMatchObject({
      status: 200,
      applied: false,
      job: {
        status: "cancelled",
        reason: "user_cancel",
        cancelRequested: true,
      },
    });
    const next = f.store.claimNext("next-owner")!;
    expect(next.identity.jobId).not.toBe(attempt.identity.jobId);
    expect(f.store.registerExit(treeExit(attempt))).toBe(false);
    expect(f.store.getActiveAttempt(next.identity)?.identity).toEqual(
      next.identity,
    );
    for (const value of [
      f.directory,
      attempt.launchTicket,
      "ownerDescriptor",
      "executionPolicy",
      "stopRequestedAt",
    ])
      expect(
        JSON.stringify(f.store.getOwned(f.principal(), attempt.identity.jobId)),
      ).not.toContain(value);
  });

  it("rolls back cancelled and slot release together when real SQLite COMMIT fails", async () => {
    const f = await fixture();
    const attempt = await authorized(f);
    f.service().cancel(f.principal(), attempt.identity.jobId);
    expect(f.store.registerExit(treeExit(attempt))).toBe(true);
    commitFault(
      f,
      `CREATE TRIGGER lifecycle_cancel_commit AFTER UPDATE OF status ON jobs
      WHEN OLD.status = 'running' AND NEW.status = 'cancelled'
      BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
    );
    expect(() => f.store.finishCancelled(attempt.identity)).toThrowError(
      expect.objectContaining({ code: "internal_error" }),
    );
    expect(
      f.store.getOwned(f.principal(), attempt.identity.jobId),
    ).toMatchObject({ status: "running", completedAt: null });
    expect(f.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
      treeExit(attempt),
    );
    expect(f.store.claimNext("replacement-owner")).toBeUndefined();
  });
});
