import assert from "node:assert/strict";

import { afterEach, describe, expect, it } from "vitest";

import type {
  Inspection,
  RecoveryControl,
  RecoverySession,
} from "../src/execution.js";
import {
  commitFault,
  descriptor,
  snapshot,
  treeExit,
} from "./lifecycle-fixtures.js";
import {
  publisherFenceBoundary,
  recoveryFixture,
  target,
  type RecoveryFixture,
} from "./recovery-fixtures.js";
import { runnerLimits } from "./storage-fixtures.js";
import {
  fixtureAuthorizeGuard,
  fixturePrepareGuard,
} from "./execution-send-permission-fixtures.js";

const fixtures: RecoveryFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});
async function fixture() {
  const f = await recoveryFixture();
  fixtures.push(f);
  return f;
}
function begin(f: RecoveryFixture, owner = "recovery-owner") {
  const session = f.storage.store.beginRecovery(owner);
  assert.ok(session, "recovery must discover the durable occupied slot");
  return session;
}
function transfer(
  f: RecoveryFixture,
  session: RecoverySession,
  inspection: Inspection,
) {
  const resolution = f.storage.store.applyRecoveryInspection(
    session.control,
    inspection,
  );
  expect(resolution?.kind).toBe("transferred");
  assert.ok(resolution && resolution.kind === "transferred");
  return resolution;
}
function durable(f: RecoveryFixture) {
  return snapshot(f.storage, (db) => {
    const tables = [
      "jobs",
      "attempts",
      "execution_slot",
      "recovery_controls",
      "recovery_events",
    ];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  });
}
async function sealedStartup(f: RecoveryFixture, at?: number) {
  const attempt = await f.claim();
  await f.reopen();
  if (at !== undefined) f.storage.setNow(at);
  const session = begin(f);
  const inspection = await f.executor.adapter.inspect(
    session.target,
    session.active.ownerDescriptor,
  );
  expect(inspection.kind).toBe("never-authorized");
  const resolution = transfer(f, session, inspection);
  return { attempt, session, ...resolution };
}

describe("recovery A: atomic sealing and unknown ownership", () => {
  it("discovers no slot without fabricating a recovery session", async () => {
    const f = await fixture();
    expect(f.storage.store.beginRecovery("recovery-owner")).toBeUndefined();
    expect(
      snapshot(f.storage, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
      ),
    ).toEqual({ count: 0 });
  });

  it.each(["claimed", "prepared"] as const)(
    "seals the original %s ticket across store incarnations without inventing an exit",
    async (phase) => {
      const f = await fixture();
      const attempt = await f.claim(phase);
      await f.reopen();
      const session = begin(f);
      expect(session.target).toEqual(target(attempt));
      expect(session.control).toMatchObject({
        source: attempt.identity,
        publisher: attempt.identity,
        launchTicket: attempt.launchTicket,
        ownerInstanceId: "recovery-owner",
      });
      expect(Object.isFrozen(session.control.source)).toBe(true);
      const inspection = await f.executor.adapter.inspect(
        session.target,
        session.active.ownerDescriptor,
      );
      expect(inspection).toEqual({
        kind: "never-authorized",
        ...target(attempt),
      });
      expect(f.executor.isSealed(attempt.launchTicket)).toBe(true);
      const resolution = transfer(f, session, inspection);
      expect(resolution.publisher).toEqual({
        ...attempt.identity,
        ownerInstanceId: "recovery-owner",
        fence: attempt.identity.fence + 1,
      });
      expect(typeof resolution.startupEventId).toBe("string");
      const active = f.storage.store.getActiveAttempt(resolution.publisher)!;
      expect(active).toMatchObject({
        producer: attempt.identity,
        launchTicket: attempt.launchTicket,
        workingDirectory: attempt.workingDirectory,
        outputPath: attempt.outputPath,
        authorizedAt: null,
        exit: null,
        ownerDescriptor: phase === "claimed" ? null : descriptor(attempt),
      });
      expect(
        f.storage.store.registerPrepared(attempt.identity, descriptor(attempt)),
      ).toBe(false);
      expect(
        f.storage.store.authorizeLaunch(attempt.identity, descriptor(attempt)),
      ).toBe(false);
      await expect(
        f.executor.adapter.prepare(
          attempt,
          fixturePrepareGuard(f.storage.store, attempt),
        ),
      ).rejects.toMatchObject({ code: "not_ready" });
      await expect(
        f.executor.adapter.authorize(
          attempt,
          descriptor(attempt),
          fixtureAuthorizeGuard(f.storage.store, attempt, descriptor(attempt)),
        ),
      ).rejects.toMatchObject({ code: "not_ready" });
      expect(f.executor.launchCalls).toHaveLength(0);
      expect(f.storage.store.claimNext("waiting-owner")).toBeUndefined();
    },
  );

  it("refuses never-authorized for a durably authorized launch", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    await f.reopen();
    const session = begin(f);
    const before = durable(f);
    expect(
      f.storage.store.applyRecoveryInspection(session.control, {
        kind: "never-authorized",
        ...target(attempt),
      }),
    ).toBeUndefined();
    expect(durable(f)).toEqual(before);
    expect(f.storage.store.getActiveAttempt(attempt.identity)?.exit).toBeNull();
    expect(f.executor.activeCount()).toBe(1);
  });

  it.each(
    (["claimed", "prepared"] as const).flatMap((phase) =>
      (["owned-alive", "tree-exited"] as const).map((kind) => ({
        phase,
        kind,
      })),
    ),
  )(
    "refuses invented $kind authorization for an originally $phase ticket",
    async ({ phase, kind }) => {
      const f = await fixture();
      const attempt = await f.claim(phase);
      await f.reopen();
      const session = begin(f);
      const inspection: Inspection =
        kind === "tree-exited"
          ? { kind, exit: treeExit(attempt) }
          : { kind, ...session.target, descriptor: descriptor(attempt) };
      const before = durable(f);
      expect(
        f.storage.store.applyRecoveryInspection(session.control, inspection),
      ).toBeUndefined();
      expect(durable(f)).toEqual(before);
      expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
        authorizedAt: null,
        exit: null,
      });
    },
  );

  it.each([
    "job",
    "attempt",
    "owner",
    "fence",
    "ticket",
    "descriptor",
    "not-tree",
  ] as const)(
    "refuses a terminal proof with mismatched producer %s",
    async (field) => {
      const f = await fixture();
      const attempt = await f.claim("authorized");
      await f.reopen();
      const session = begin(f);
      const event = treeExit(attempt);
      const inspection: Inspection = {
        kind: "tree-exited",
        exit: {
          ...event,
          identity: {
            ...event.identity,
            ...(field === "job" ? { jobId: "other-job" } : {}),
            ...(field === "attempt"
              ? { attemptNo: event.identity.attemptNo + 1 }
              : {}),
            ...(field === "owner" ? { ownerInstanceId: "other-producer" } : {}),
            ...(field === "fence" ? { fence: event.identity.fence + 1 } : {}),
          },
          ...(field === "ticket" ? { launchTicket: "other-ticket" } : {}),
          ...(field === "descriptor"
            ? { descriptor: { ...event.descriptor, executionId: "other-tree" } }
            : {}),
        },
      };
      if (field === "not-tree")
        (inspection.exit as unknown as { treeExited: boolean }).treeExited =
          false;
      const before = durable(f);
      expect(
        f.storage.store.applyRecoveryInspection(session.control, inspection),
      ).toBeUndefined();
      expect(durable(f)).toEqual(before);
      expect(f.storage.store.claimNext("replacement-owner")).toBeUndefined();
    },
  );

  it.each(["owned-alive", "never-authorized", "unknown"] as const)(
    "binds %s inspection to the original target and descriptor",
    async (kind) => {
      const f = await fixture();
      const attempt = await f.claim(
        kind === "never-authorized" ? "prepared" : "authorized",
      );
      await f.reopen();
      const session = begin(f);
      for (const execution of [
        {
          ...target(attempt),
          identity: { ...attempt.identity, jobId: "other-job" },
        },
        {
          ...target(attempt),
          identity: {
            ...attempt.identity,
            attemptNo: attempt.identity.attemptNo + 1,
          },
        },
        {
          ...target(attempt),
          identity: { ...attempt.identity, ownerInstanceId: "other-producer" },
        },
        {
          ...target(attempt),
          identity: { ...attempt.identity, fence: attempt.identity.fence + 1 },
        },
        { ...target(attempt), launchTicket: "other-ticket" },
      ]) {
        const inspection: Inspection =
          kind === "owned-alive"
            ? { kind, ...execution, descriptor: descriptor(attempt) }
            : { kind, ...execution };
        expect(
          f.storage.store.applyRecoveryInspection(session.control, inspection),
        ).toBeUndefined();
      }
      if (kind === "owned-alive")
        expect(
          f.storage.store.applyRecoveryInspection(session.control, {
            kind,
            ...target(attempt),
            descriptor: { ...descriptor(attempt), executionId: "other-tree" },
          }),
        ).toBeUndefined();
      expect(
        f.storage.store.getActiveAttempt(attempt.identity)?.identity,
      ).toEqual(attempt.identity);
    },
  );

  it("persists unknown observation while preserving the original lease, producer and slot", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    await f.reopen();
    const session = begin(f);
    expect(
      f.storage.store.applyRecoveryInspection(session.control, {
        kind: "unknown",
        ...session.target,
      }),
    ).toMatchObject({ kind: "unknown" });
    expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
      producer: attempt.identity,
      leaseExpiresAt: attempt.leaseExpiresAt,
      executionDeadlineAt: attempt.executionDeadlineAt,
      exit: null,
    });
    expect(f.storage.store.claimNext("replacement-owner")).toBeUndefined();
    await f.reopen();
    const next = begin(f);
    expect(next.control.recoveryId).not.toBe(session.control.recoveryId);
    expect(next.active.identity).toEqual(attempt.identity);
  });

  it("uses the same store clock for durable inspection observations", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    await f.reopen();
    const session = begin(f);
    f.storage.setNow(attempt.firstStartedAt + 1);
    const inspection = { kind: "unknown" as const, ...session.target };
    expect(
      f.storage.store.applyRecoveryInspection(session.control, inspection)
        ?.kind,
    ).toBe("unknown");
    expect(
      snapshot(f.storage, (db) =>
        db
          .prepare(
            "SELECT observed_at FROM recovery_controls WHERE recovery_id = ?",
          )
          .get(session.control.recoveryId),
      ),
    ).toEqual({ observed_at: f.storage.clock() });
  });
});

describe("recovery B: durable control and publisher fencing", () => {
  it("recovery refresh: advances two different queued cutoffs while retaining the same control", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    const first = await f.submit("refresh-waiting-first");
    f.storage.setNow(f.storage.clock() + 1);
    const second = await f.submit("refresh-waiting-second");
    await f.reopen();
    const session = begin(f);
    expect(session.nextQueueDeadlineAt).toBe(first.job.queueDeadlineAt);
    f.storage.setNow(first.job.queueDeadlineAt + 1);
    const refreshed = f.storage.store.beginRecovery(
      "recovery-owner",
      session.control,
    );
    expect(refreshed?.control).toEqual(session.control);
    expect(refreshed?.nextQueueDeadlineAt).toBe(second.job.queueDeadlineAt);
    expect(
      f.storage.store.getOwned(f.storage.principal(), first.job.jobId).reason,
    ).toBe("queue_timeout");
    expect(
      f.storage.store.getOwned(f.storage.principal(), second.job.jobId).status,
    ).toBe("queued");
    f.storage.setNow(second.job.queueDeadlineAt + 1);
    const last = f.storage.store.beginRecovery(
      "recovery-owner",
      session.control,
    );
    expect(last?.control).toEqual(session.control);
    expect(last?.nextQueueDeadlineAt).toBeNull();
    expect(
      f.storage.store.getOwned(f.storage.principal(), second.job.jobId).reason,
    ).toBe("queue_timeout");
    expect(last?.active).toMatchObject({
      producer: attempt.identity,
      leaseExpiresAt: attempt.leaseExpiresAt,
    });
  });

  it("recovery refresh: cannot reclaim authority after another controller replaces its control", async () => {
    const f = await fixture();
    await f.claim("authorized");
    await f.reopen();
    const previous = begin(f);
    const replacement = begin(f, "replacement-controller");
    const before = durable(f);
    expect(
      f.storage.store.beginRecovery("recovery-owner", previous.control),
    ).toBeUndefined();
    expect(durable(f)).toEqual(before);
    expect(
      f.storage.store.beginRecovery(
        "replacement-controller",
        replacement.control,
      )?.control,
    ).toEqual(replacement.control);
  });

  it("recovery refresh: rejects a wrong expected binding before any queue, control or observation write", async () => {
    const f = await fixture();
    await f.claim("authorized");
    const waiting = await f.submit("refresh-waiting");
    await f.reopen();
    const session = begin(f);
    f.storage.setNow(waiting.job.queueDeadlineAt + 1);
    const before = durable(f);
    for (const expected of [
      { ...session.control, recoveryId: "wrong-refresh-control" },
      { ...session.control, launchTicket: "wrong-refresh-ticket" },
      {
        ...session.control,
        source: {
          ...session.control.source,
          fence: session.control.source.fence + 1,
        },
      },
      {
        ...session.control,
        publisher: {
          ...session.control.publisher,
          ownerInstanceId: "wrong-publisher",
        },
      },
    ])
      expect(
        f.storage.store.beginRecovery("recovery-owner", expected),
      ).toBeUndefined();
    expect(
      f.storage.store.beginRecovery("wrong-controller", session.control),
    ).toBeUndefined();
    expect(durable(f)).toEqual(before);
    expect(
      f.storage.store.getOwned(f.storage.principal(), waiting.job.jobId).status,
    ).toBe("queued");
  });

  it.each(
    (["claimed", "prepared", "authorized", "stopped-exited"] as const).flatMap(
      (phase) => [-1, 0, 1].map((offset) => ({ phase, offset })),
    ),
  )(
    "revokes old writes for $phase even at lease offset $offset",
    async ({ phase, offset }) => {
      const f = await fixture();
      const attempt = await f.claim(
        phase === "stopped-exited" ? "authorized" : phase,
      );
      if (phase === "stopped-exited") {
        f.storage
          .service()
          .cancel(f.storage.principal(), attempt.identity.jobId);
        expect(f.storage.store.registerExit(treeExit(attempt))).toBe(true);
      }
      await f.reopen();
      f.storage.setNow(attempt.leaseExpiresAt + offset);
      begin(f);
      const before = durable(f);
      expect(f.storage.store.renewLease(attempt.identity)).toBe(false);
      expect(
        f.storage.store.registerPrepared(attempt.identity, descriptor(attempt)),
      ).toBe(false);
      expect(
        f.storage.store.authorizeLaunch(attempt.identity, descriptor(attempt)),
      ).toBe(false);
      expect(f.storage.store.registerExit(treeExit(attempt))).toBe(false);
      expect(f.storage.store.requestStop(attempt.identity, "user_cancel")).toBe(
        false,
      );
      expect(f.storage.store.finishCancelled(attempt.identity)).toBe(false);
      expect(durable(f)).toEqual(before);
      expect(
        f.storage.service().get(f.storage.principal(), attempt.identity.jobId)
          .status,
      ).toBe("running");
      expect(
        f.storage
          .service()
          .cancel(f.storage.principal(), attempt.identity.jobId).status,
      ).toBe(202);
    },
  );

  it("reuses one control for one owner and invalidates every previous generation", async () => {
    const f = await fixture();
    await f.claim("authorized");
    await f.reopen();
    const first = begin(f);
    expect(begin(f).control).toEqual(first.control);
    const second = begin(f, "other-recovery-owner");
    expect(second.control.recoveryId).not.toBe(first.control.recoveryId);
    expect(
      f.storage.store.applyRecoveryInspection(first.control, {
        kind: "unknown",
        ...first.target,
      }),
    ).toBeUndefined();
    expect(
      f.storage.store.prepareRecoveryStop(first.control, "soft"),
    ).toBeUndefined();
    await f.reopen();
    const third = begin(f, "other-recovery-owner");
    expect(third.control.recoveryId).not.toBe(second.control.recoveryId);
    expect(
      f.storage.store.applyRecoveryInspection(second.control, {
        kind: "unknown",
        ...second.target,
      }),
    ).toBeUndefined();
  });

  it("checks every control binding before observation or exact stop", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    await f.reopen();
    const session = begin(f);
    expect(
      f.storage.store.applyRecoveryInspection(session.control, {
        kind: "owned-alive",
        ...session.target,
        descriptor: descriptor(attempt),
      })?.kind,
    ).toBe("owned-alive");
    f.storage.setNow(session.active.terminateAfterAt! + 1);
    expect(
      f.storage.store.prepareRecoveryStop(session.control, "soft"),
    ).toMatchObject({ target: target(attempt) });
    expect(
      f.storage.store.prepareRecoveryStop(session.control, "force"),
    ).toMatchObject({ target: target(attempt) });
    const badControls: RecoveryControl[] = [
      { ...session.control, recoveryId: "other-control" },
      { ...session.control, ownerInstanceId: "other-controller" },
      { ...session.control, launchTicket: "other-ticket" },
      ...(["source", "publisher"] as const).flatMap((part) => [
        {
          ...session.control,
          [part]: { ...session.control[part], jobId: "other-job" },
        },
        {
          ...session.control,
          [part]: { ...session.control[part], attemptNo: 2 },
        },
        {
          ...session.control,
          [part]: { ...session.control[part], ownerInstanceId: "other-owner" },
        },
        { ...session.control, [part]: { ...session.control[part], fence: 2 } },
      ]),
    ];
    const before = durable(f);
    for (const control of badControls) {
      expect(
        f.storage.store.applyRecoveryInspection(control, {
          kind: "tree-exited",
          exit: treeExit(attempt),
        }),
      ).toBeUndefined();
      expect(
        f.storage.store.prepareRecoveryStop(control, "soft"),
      ).toBeUndefined();
      expect(
        f.storage.store.prepareRecoveryStop(control, "force"),
      ).toBeUndefined();
    }
    expect(durable(f)).toEqual(before);
  });

  it.each([-1, 0, 1])(
    "keeps original cancellation grace for recovery force at offset %i",
    async (offset) => {
      const f = await fixture();
      const attempt = await f.claim("authorized");
      f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
      const stopped = f.storage.store.getActiveAttempt(attempt.identity)!;
      await f.reopen();
      const session = begin(f);
      expect(
        f.storage.store.prepareRecoveryStop(session.control, "soft"),
      ).toBeUndefined();
      const alive = await f.executor.adapter.inspect(
        session.target,
        session.active.ownerDescriptor,
      );
      expect(
        f.storage.store.applyRecoveryInspection(session.control, alive)?.kind,
      ).toBe("owned-alive");
      f.storage.setNow(stopped.terminateAfterAt! + offset);
      expect(
        f.storage.store.prepareRecoveryStop(session.control, "soft"),
      ).toEqual({
        target: target(attempt),
        descriptor: descriptor(attempt),
        mode: "soft",
        stopRequestedAt: stopped.stopRequestedAt,
        terminateAfterAt: stopped.terminateAfterAt,
      });
      const force = f.storage.store.prepareRecoveryStop(
        session.control,
        "force",
      );
      if (offset > 0)
        expect(force).toMatchObject({ target: target(attempt), mode: "force" });
      else expect(force).toBeUndefined();
      expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
        leaseExpiresAt: attempt.leaseExpiresAt,
        stopRequestedAt: stopped.stopRequestedAt,
        terminateAfterAt: stopped.terminateAfterAt,
        producer: attempt.identity,
      });
    },
  );

  it("records global timeout without renewing an expired owner and stops only proved ownership", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    await f.reopen();
    f.storage.setNow(attempt.executionDeadlineAt + 1);
    const session = begin(f);
    expect(session.active).toMatchObject({
      stopReason: "execution_timeout",
      stopRequestedAt: attempt.executionDeadlineAt + 1,
      terminateAfterAt:
        attempt.executionDeadlineAt + 1 + runnerLimits.cancelGraceMs,
      leaseExpiresAt: attempt.leaseExpiresAt,
    });
    expect(
      f.storage.store.prepareRecoveryStop(session.control, "soft"),
    ).toBeUndefined();
    const alive = await f.executor.adapter.inspect(
      session.target,
      session.active.ownerDescriptor,
    );
    f.storage.store.applyRecoveryInspection(session.control, alive);
    expect(
      f.storage.store.prepareRecoveryStop(session.control, "soft"),
    ).toMatchObject({ target: target(attempt) });
    expect(f.storage.store.renewLease(attempt.identity)).toBe(false);
  });

  it.each(["tree-exited", "never-authorized"] as const)(
    "transfers only after %s and lets the new publisher finish using the original proof",
    async (kind) => {
      const f = await fixture();
      const attempt = await f.claim(
        kind === "tree-exited" ? "authorized" : "claimed",
      );
      f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
      await f.reopen();
      const session = begin(f);
      const inspection: Inspection =
        kind === "tree-exited"
          ? { kind, exit: treeExit(attempt) }
          : await f.executor.adapter.inspect(
              session.target,
              session.active.ownerDescriptor,
            );
      const resolution = transfer(f, session, inspection);
      expect(resolution.startupEventId).toBeNull();
      const active = f.storage.store.getActiveAttempt(resolution.publisher)!;
      expect(active).toMatchObject({
        producer: attempt.identity,
        launchTicket: attempt.launchTicket,
        workingDirectory: attempt.workingDirectory,
        outputPath: attempt.outputPath,
        executionDeadlineAt: attempt.executionDeadlineAt,
        exit: kind === "tree-exited" ? treeExit(attempt) : null,
      });
      expect(
        f.storage.store.prepareRecoveryStop(session.control, "force"),
      ).toBeUndefined();
      expect(
        f.storage.store.prepareRecoveryStop(session.control, "soft"),
      ).toBeUndefined();
      expect(
        f.storage.store.applyRecoveryInspection(session.control, inspection),
      ).toBeUndefined();
      expect(f.storage.store.registerExit(treeExit(attempt))).toBe(false);
      expect(f.storage.store.finishCancelled(attempt.identity)).toBe(false);
      expect(f.storage.store.finishCancelled(resolution.publisher)).toBe(true);
      expect(
        f.storage.store.getOwned(f.storage.principal(), attempt.identity.jobId),
      ).toMatchObject({
        status: "cancelled",
        reason: "user_cancel",
        completedAt: f.storage.clock(),
      });
      expect(
        snapshot(f.storage, (db) =>
          db.prepare("SELECT COUNT(*) AS count FROM execution_slot").get(),
        ),
      ).toEqual({ count: 0 });
    },
  );

  it.each([-1, 0, 1])(
    "checks the new publisher lease again before cancelled COMMIT at offset %i",
    async (offset) => {
      const f = await fixture();
      const attempt = await f.claim("authorized");
      f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
      await f.reopen();
      const session = begin(f);
      const resolution = transfer(f, session, {
        kind: "tree-exited",
        exit: treeExit(attempt),
      });
      const active = f.storage.store.getActiveAttempt(resolution.publisher)!;
      f.storage.setNow(active.leaseExpiresAt + offset);
      expect(f.storage.store.finishCancelled(resolution.publisher)).toBe(
        offset <= 0,
      );
      expect(
        f.storage.store.getOwned(f.storage.principal(), attempt.identity.jobId)
          .status,
      ).toBe(offset <= 0 ? "cancelled" : "running");
      if (offset > 0)
        expect(f.storage.store.claimNext("waiting-owner")).toBeUndefined();
    },
  );

  it("cascades the slot fence with foreign keys enabled in the same publisher transfer", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    await f.reopen();
    const session = begin(f);
    const resolution = transfer(f, session, {
      kind: "tree-exited",
      exit: treeExit(attempt),
    });
    expect(
      snapshot(f.storage, (db) =>
        db.pragma("foreign_key_list(execution_slot)"),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "fence", on_update: "CASCADE" }),
      ]),
    );
    expect(
      snapshot(f.storage, (db) => ({
        slot: db
          .prepare("SELECT job_id, attempt_no, fence FROM execution_slot")
          .get(),
        job: db
          .prepare(
            "SELECT active_attempt_no, current_fence FROM jobs WHERE job_id = ?",
          )
          .get(attempt.identity.jobId),
        violations: db.pragma("foreign_key_check"),
      })),
    ).toEqual({
      slot: {
        job_id: attempt.identity.jobId,
        attempt_no: attempt.identity.attemptNo,
        fence: resolution.publisher.fence,
      },
      job: {
        active_attempt_no: attempt.identity.attemptNo,
        current_fence: resolution.publisher.fence,
      },
      violations: [],
    });
  });

  it("rolls back control creation at a real SQLite COMMIT fault", async () => {
    const f = await fixture();
    expect(
      f.storage.store.beginRecovery("empty-slot-preflight"),
    ).toBeUndefined();
    const attempt = await f.claim();
    commitFault(
      f.storage,
      `CREATE TRIGGER recovery_control_commit AFTER INSERT ON recovery_controls
      BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
    );
    const before = durable(f);
    expect(() => f.storage.store.beginRecovery("recovery-owner")).toThrowError(
      expect.objectContaining({ code: "internal_error" }),
    );
    expect(durable(f)).toEqual(before);
    await f.reopen();
    expect(durable(f)).toEqual(before);
    expect(
      f.storage.store.getActiveAttempt(attempt.identity)?.identity,
    ).toEqual(attempt.identity);
  });

  it.each([
    {
      label: "observation",
      table: "recovery_controls",
      update: " OF observed_at",
    },
    { label: "attempt fence", table: "attempts", update: " OF fence" },
    { label: "slot cascade", table: "execution_slot", update: " OF fence" },
    { label: "jobs fence", table: "jobs", update: " OF current_fence" },
  ])(
    "rolls back $label together with terminal proof and publisher authority",
    async ({ table, update }) => {
      const f = await fixture();
      expect(
        f.storage.store.beginRecovery("empty-slot-preflight"),
      ).toBeUndefined();
      const attempt = await f.claim("authorized");
      commitFault(
        f.storage,
        `CREATE TRIGGER recovery_transfer_commit AFTER UPDATE${update} ON ${table}
      BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
      );
      // Installing the fault reopened the store; obtain this incarnation's token afterwards.
      const session = begin(f);
      const before = durable(f);
      expect(() =>
        f.storage.store.applyRecoveryInspection(session.control, {
          kind: "tree-exited",
          exit: treeExit(attempt),
        }),
      ).toThrowError(expect.objectContaining({ code: "internal_error" }));
      expect(durable(f)).toEqual(before);
      await f.reopen();
      expect(durable(f)).toEqual(before);
      expect(
        f.storage.store.getActiveAttempt(attempt.identity)?.exit,
      ).toBeNull();
    },
  );

  it("rolls back recovered cancellation and slot release at COMMIT", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    await f.reopen();
    const session = begin(f);
    const resolution = transfer(f, session, {
      kind: "tree-exited",
      exit: treeExit(attempt),
    });
    commitFault(
      f.storage,
      `CREATE TRIGGER recovery_cancel_commit AFTER UPDATE OF status ON jobs
      WHEN NEW.status = 'cancelled'
      BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
    );
    const before = durable(f);
    expect(() =>
      f.storage.store.finishCancelled(resolution.publisher),
    ).toThrowError(expect.objectContaining({ code: "internal_error" }));
    expect(durable(f)).toEqual(before);
    await f.reopen();
    expect(durable(f)).toEqual(before);
  });

  it("atomically refuses a controlled publisher fence increment beyond the safe integer bound", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    await f.reopen();
    const original = begin(f);
    transfer(f, original, { kind: "tree-exited", exit: treeExit(attempt) });
    await publisherFenceBoundary(f);
    const session = begin(f);
    expect(session.control.publisher.fence).toBe(Number.MAX_SAFE_INTEGER);
    expect(session.active.producer).toEqual(attempt.identity);
    const before = durable(f);
    expect(() =>
      f.storage.store.applyRecoveryInspection(session.control, {
        kind: "tree-exited",
        exit: treeExit(attempt),
      }),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
    expect(durable(f)).toEqual(before);
    await f.reopen();
    expect(durable(f)).toEqual(before);
  });
});

describe("recovery C: finite startup recovery and event consumption", () => {
  it.each([
    "same-open-owner-change",
    "expired-lease",
    "ordinary-prepare-error",
  ] as const)(
    "does not create startup eligibility for %s without a new store incarnation",
    async (condition) => {
      const f = await fixture();
      const attempt = await f.claim();
      if (condition === "expired-lease")
        f.storage.setNow(attempt.leaseExpiresAt + 1);
      if (condition === "ordinary-prepare-error") {
        f.executor.hooks.prepare = async () => {
          throw new Error("controlled ordinary preparation error");
        };
        await expect(
          f.executor.adapter.prepare(
            attempt,
            fixturePrepareGuard(f.storage.store, attempt),
          ),
        ).rejects.toThrow("ordinary preparation error");
      }
      const session = begin(f, "different-owner-string");
      const inspection = await f.executor.adapter.inspect(
        session.target,
        session.active.ownerDescriptor,
      );
      const resolution = transfer(f, session, inspection);
      expect(resolution.startupEventId).toBeNull();
      expect(
        f.storage.store.restartSealedAttempt(
          resolution.publisher,
          "caller-reported-interrupted",
        ),
      ).toBeUndefined();
      expect(
        snapshot(f.storage, (db) =>
          db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
        ),
      ).toEqual({ count: 1 });
    },
  );

  it("uses store incarnation even when the owner string is reused across an exclusive reopen", async () => {
    const f = await fixture();
    const attempt = await f.claim("claimed", "same-owner-string");
    await f.reopen();
    const session = begin(f, "same-owner-string");
    const inspection = await f.executor.adapter.inspect(session.target, null);
    const resolution = transfer(f, session, inspection);
    expect(resolution.startupEventId).toEqual(expect.any(String));
    expect(resolution.publisher.ownerInstanceId).toBe(
      attempt.identity.ownerInstanceId,
    );
    expect(resolution.publisher.fence).toBe(attempt.identity.fence + 1);
  });

  it("reuses one startup event for the same sealed producer and ticket across another exclusive reopen", async () => {
    const f = await fixture();
    const sealed = await sealedStartup(f);
    assert.ok(sealed.startupEventId);
    await f.reopen();
    const session = begin(f, "next-recovery-owner");
    expect(session.target).toEqual(target(sealed.attempt));
    const inspection = await f.executor.adapter.inspect(
      session.target,
      session.active.ownerDescriptor,
    );
    const resolution = transfer(f, session, inspection);
    expect(resolution.startupEventId).toBe(sealed.startupEventId);
    expect(
      snapshot(f.storage, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM recovery_events").get(),
      ),
    ).toEqual({ count: 1 });
    expect(
      f.storage.store.restartSealedAttempt(
        resolution.publisher,
        sealed.startupEventId,
      )?.kind,
    ).toBe("created");
  });

  it("creates one fresh calculation with the original frozen job, policy, tile and global deadline", async () => {
    const f = await fixture();
    const sealed = await sealedStartup(f);
    assert.ok(sealed.startupEventId);
    await f.submit("waiting-a");
    await f.submit("waiting-b");
    f.storage.setRunnerLimits({
      ...runnerLimits,
      executionTimeoutMs: runnerLimits.leaseDurationMs,
    });
    const outcome = f.storage.store.restartSealedAttempt(
      sealed.publisher,
      sealed.startupEventId,
    );
    expect(outcome?.kind).toBe("created");
    assert.ok(outcome && outcome.kind === "created");
    expect(outcome.attempt).toMatchObject({
      job: sealed.attempt.job,
      executionPolicy: sealed.attempt.executionPolicy,
      firstStartedAt: sealed.attempt.firstStartedAt,
      executionDeadlineAt: sealed.attempt.executionDeadlineAt,
      inputPath: sealed.attempt.inputPath,
      tile: sealed.attempt.tile,
      identity: {
        jobId: sealed.attempt.identity.jobId,
        attemptNo: sealed.attempt.identity.attemptNo + 1,
        fence: sealed.publisher.fence + 1,
      },
    });
    expect(outcome.attempt.launchTicket).not.toBe(sealed.attempt.launchTicket);
    expect(outcome.attempt.workingDirectory).not.toBe(
      sealed.attempt.workingDirectory,
    );
    expect(outcome.attempt.outputPath).not.toBe(sealed.attempt.outputPath);
    expect(
      f.storage.store.getActiveAttempt(outcome.attempt.identity)?.producer,
    ).toEqual(outcome.attempt.identity);
    expect(
      snapshot(f.storage, (db) => ({
        slot: db
          .prepare("SELECT job_id, attempt_no, fence FROM execution_slot")
          .get(),
        waiting: db
          .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'")
          .get(),
      })),
    ).toEqual({
      slot: {
        job_id: outcome.attempt.identity.jobId,
        attempt_no: outcome.attempt.identity.attemptNo,
        fence: outcome.attempt.identity.fence,
      },
      waiting: { count: 2 },
    });
    expect(
      f.storage.store.registerPrepared(
        sealed.publisher,
        descriptor(sealed.attempt),
      ),
    ).toBe(false);
    expect(f.storage.store.claimNext("waiting-owner")).toBeUndefined();
  });

  it("returns only an existing replacement number for concurrent and restarted event replays", async () => {
    const f = await fixture();
    const sealed = await sealedStartup(f);
    assert.ok(sealed.startupEventId);
    const outcomes = await Promise.all(
      [0, 1].map(async () =>
        f.storage.store.restartSealedAttempt(
          sealed.publisher,
          sealed.startupEventId!,
        ),
      ),
    );
    expect(outcomes.map((outcome) => outcome?.kind)).toEqual([
      "created",
      "already-applied",
    ]);
    const created = outcomes[0];
    assert.ok(created && created.kind === "created");
    expect(outcomes[1]).toEqual({
      kind: "already-applied",
      replacementAttemptNo: created.attempt.identity.attemptNo,
    });
    // Treat the committed response as lost, reopen, then use the original consuming publisher.
    await f.reopen();
    expect(
      f.storage.store.restartSealedAttempt(
        sealed.publisher,
        sealed.startupEventId,
      ),
    ).toEqual({
      kind: "already-applied",
      replacementAttemptNo: created.attempt.identity.attemptNo,
    });
    expect(
      f.storage.store.restartSealedAttempt(
        created.attempt.identity,
        sealed.startupEventId,
      ),
    ).toBeUndefined();
    expect(
      snapshot(f.storage, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
      ),
    ).toEqual({ count: 2 });
  });

  it("rejects unknown events and every different consuming publisher without consuming the valid event", async () => {
    const f = await fixture();
    const sealed = await sealedStartup(f);
    assert.ok(sealed.startupEventId);
    const before = durable(f);
    expect(
      f.storage.store.restartSealedAttempt(sealed.publisher, "unknown-event"),
    ).toBeUndefined();
    for (const publisher of [
      { ...sealed.publisher, jobId: "other-job" },
      { ...sealed.publisher, attemptNo: sealed.publisher.attemptNo + 1 },
      { ...sealed.publisher, ownerInstanceId: "other-owner" },
      { ...sealed.publisher, fence: sealed.publisher.fence + 1 },
      sealed.attempt.identity,
    ])
      expect(
        f.storage.store.restartSealedAttempt(publisher, sealed.startupEventId),
      ).toBeUndefined();
    expect(durable(f)).toEqual(before);
    expect(
      f.storage.store.restartSealedAttempt(
        sealed.publisher,
        sealed.startupEventId,
      )?.kind,
    ).toBe("created");
  });

  it.each([-1, 0, 1])(
    "uses the first execution cutoff at offset %i for a sealed startup",
    async (offset) => {
      const f = await fixture();
      const sealed = await sealedStartup(
        f,
        1_000 + runnerLimits.executionTimeoutMs + offset,
      );
      const outcome = f.storage.store.restartSealedAttempt(
        sealed.publisher,
        sealed.startupEventId ?? "no-qualified-event",
      );
      if (offset <= 0) {
        expect(outcome?.kind).toBe("created");
        assert.ok(outcome && outcome.kind === "created");
        expect(outcome.attempt.executionDeadlineAt).toBe(
          sealed.attempt.executionDeadlineAt,
        );
      } else {
        expect(outcome).toBeUndefined();
        expect(
          f.storage.store.getActiveAttempt(sealed.publisher)?.stopReason,
        ).toBe("execution_timeout");
      }
    },
  );

  it.each(["cancel", "expired-publisher-lease"] as const)(
    "does not consume a sealed event after %s",
    async (condition) => {
      const f = await fixture();
      const sealed = await sealedStartup(f);
      assert.ok(sealed.startupEventId);
      if (condition === "cancel")
        f.storage
          .service()
          .cancel(f.storage.principal(), sealed.attempt.identity.jobId);
      else
        f.storage.setNow(
          f.storage.store.getActiveAttempt(sealed.publisher)!.leaseExpiresAt +
            1,
        );
      const before = durable(f);
      expect(
        f.storage.store.restartSealedAttempt(
          sealed.publisher,
          sealed.startupEventId,
        ),
      ).toBeUndefined();
      expect(durable(f)).toEqual(before);
    },
  );

  it.each([
    {
      label: "event consumption",
      operation: "UPDATE",
      table: "recovery_events",
    },
    { label: "replacement attempt", operation: "INSERT", table: "attempts" },
    { label: "slot transfer", operation: "UPDATE", table: "execution_slot" },
    {
      label: "job attempt",
      operation: "UPDATE OF active_attempt_no",
      table: "jobs",
    },
  ])(
    "rolls back $label with the replacement and every original qualification fact",
    async ({ operation, table }) => {
      const f = await fixture();
      const sealed = await sealedStartup(f);
      assert.ok(sealed.startupEventId);
      commitFault(
        f.storage,
        `CREATE TRIGGER recovery_restart_commit AFTER ${operation} ON ${table}
      BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
      );
      const before = durable(f);
      expect(() =>
        f.storage.store.restartSealedAttempt(
          sealed.publisher,
          sealed.startupEventId!,
        ),
      ).toThrowError(expect.objectContaining({ code: "internal_error" }));
      expect(durable(f)).toEqual(before);
      await f.reopen();
      expect(durable(f)).toEqual(before);
      expect(f.storage.store.getActiveAttempt(sealed.publisher)).toMatchObject({
        producer: sealed.attempt.identity,
        authorizedAt: null,
        exit: null,
      });
    },
  );

  it("rolls back persisted sealing and startup event registration with publisher transfer", async () => {
    const f = await fixture();
    expect(
      f.storage.store.beginRecovery("empty-slot-preflight"),
    ).toBeUndefined();
    const attempt = await f.claim("prepared");
    commitFault(
      f.storage,
      `CREATE TRIGGER recovery_event_commit AFTER INSERT ON recovery_events
      BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
    );
    const session = begin(f);
    const inspection = await f.executor.adapter.inspect(
      session.target,
      session.active.ownerDescriptor,
    );
    expect(inspection.kind).toBe("never-authorized");
    const before = durable(f);
    expect(() =>
      f.storage.store.applyRecoveryInspection(session.control, inspection),
    ).toThrowError(expect.objectContaining({ code: "internal_error" }));
    expect(durable(f)).toEqual(before);
    // An external atomic ticket barrier stays sealed even if the SQL proof rolls back.
    expect(f.executor.isSealed(attempt.launchTicket)).toBe(true);
    await f.reopen();
    expect(durable(f)).toEqual(before);
    expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
      authorizedAt: null,
      exit: null,
    });
  });

  it("does not grant startup recovery for an ordinary authorized terminal exit", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    await f.reopen();
    const session = begin(f);
    const resolution = transfer(f, session, {
      kind: "tree-exited",
      exit: treeExit(attempt),
    });
    expect(resolution.startupEventId).toBeNull();
    expect(
      f.storage.store.restartSealedAttempt(
        resolution.publisher,
        "ordinary-nonzero-exit",
      ),
    ).toBeUndefined();
    expect(
      f.storage.store.getOwned(f.storage.principal(), attempt.identity.jobId),
    ).toMatchObject({
      status: "running",
      reason: null,
      completedAt: null,
    });
    expect(f.storage.store.claimNext("waiting-owner")).toBeUndefined();
  });
});
