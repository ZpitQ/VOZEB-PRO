import { afterEach, describe, expect, it } from "vitest";

import { createClient } from "../src/credentials.js";
import type { ActiveAttempt, ClaimedAttempt } from "../src/execution.js";
import { createRunner } from "../src/runner.js";
import { deferred, httpFixture, jobOf } from "./http-fixtures.js";
import {
  commitFault,
  controlledExecutor,
  manualClock,
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
async function harness(configure?: (storage: StorageFixture) => void) {
  const storage = await storageFixture();
  configure?.(storage);
  const time = manualClock(storage);
  const executor = controlledExecutor();
  const runner = createRunner({
    store: storage.store,
    clock: time.clock,
    executor: executor.adapter,
    ownerInstanceId: "lifecycle-runner-owner",
  });
  cleanups.push(async () => {
    await runner.close();
    await storage.cleanup();
  });
  const bytes = await sourceImage();
  return {
    storage,
    time,
    executor,
    runner,
    submit: (key = "first") =>
      storage.service().submit(storage.principal(), submission(bytes, key)),
    cancel: (jobId: string) =>
      storage.service().cancel(storage.principal(), jobId),
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function start(h: Harness) {
  const accepted = await h.submit();
  await h.runner.wake();
  expect(h.executor.authorizeCalls).toHaveLength(1);
  return { accepted, attempt: h.executor.authorizeCalls[0]! };
}
function current(h: Harness, jobId: string) {
  return h.storage.store.getOwned(h.storage.principal(), jobId);
}
function stopFacts(h: Harness) {
  return snapshot(h.storage, (db) =>
    db
      .prepare(
        "SELECT stop_reason, stop_requested_at, terminate_after_at FROM attempts",
      )
      .get(),
  );
}

describe("events scheduled from durable lifecycle facts", () => {
  it("renews every frozen heartbeat and never extends the first execution deadline", async () => {
    const h = await harness();
    const { attempt } = await start(h);
    h.storage.setRunnerLimits({
      ...runnerLimits,
      heartbeatIntervalMs: 1_000,
      leaseDurationMs: 3_000,
    });
    expect(h.time.pending().map((entry) => entry.at)).toEqual([6_000]);
    for (const now of [6_000, 11_000, 16_000]) {
      h.time.advanceTo(now);
      await h.runner.wake();
      expect(h.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
        leaseExpiresAt: now + 15_000,
        executionDeadlineAt: 61_000,
        executionPolicy: { limits: runnerLimits },
      });
      expect(h.time.pending().map((entry) => entry.at)).toEqual([now + 5_000]);
    }
    expect(h.executor.prepareCalls).toHaveLength(1);
  });

  it.each([-1, 0, 1])(
    "starts timeout stopping only beyond the original execution deadline at offset %i",
    async (offset) => {
      const h = await harness();
      const { attempt } = await start(h);
      h.time.advanceTo(attempt.executionDeadlineAt + offset);
      await h.runner.wake();
      expect(current(h, attempt.identity.jobId)).toMatchObject({
        status: "running",
        reason: null,
        completedAt: null,
      });
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual(
        offset > 0 ? ["soft"] : [],
      );
      expect(h.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
        executionDeadlineAt: attempt.executionDeadlineAt,
        stopReason: offset > 0 ? "execution_timeout" : null,
      });
      if (offset > 0) {
        expect(stopFacts(h)).toEqual({
          stop_reason: "execution_timeout",
          stop_requested_at: 61_001,
          terminate_after_at: 66_001,
        });
        h.executor.emit(treeExit(attempt));
        await h.runner.wake();
        expect(current(h, attempt.identity.jobId)).toMatchObject({
          status: "cancelled",
          reason: "execution_timeout",
          completedAt: 61_001,
        });
      }
    },
  );

  it("keeps the original cause and grace when user cancellation precedes the execution deadline", async () => {
    const h = await harness();
    const { attempt } = await start(h);
    h.time.advanceTo(59_000);
    h.cancel(attempt.identity.jobId);
    await h.runner.wake();
    const original = stopFacts(h);
    h.time.advanceTo(61_001);
    await h.runner.wake();
    expect(stopFacts(h)).toEqual(original);
    expect(
      h.storage.store.getActiveAttempt(attempt.identity)?.executionDeadlineAt,
    ).toBe(61_000);
    h.executor.emit(treeExit(attempt));
    await h.runner.wake();
    expect(current(h, attempt.identity.jobId)).toMatchObject({
      status: "cancelled",
      reason: "user_cancel",
    });
  });

  it("does not renew or send stop when an old scheduled event arrives after the lease expired", async () => {
    const h = await harness();
    const { attempt } = await start(h);
    expect(h.time.pending()).toHaveLength(1);
    const callback = h.time.pending()[0]!.callback;
    h.storage.setNow(attempt.leaseExpiresAt + 1);
    h.cancel(attempt.identity.jobId);
    callback();
    await h.runner.wake();
    expect(
      h.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
    ).toBe(attempt.leaseExpiresAt);
    expect(h.executor.stopCalls).toHaveLength(0);
    h.executor.emit(treeExit(attempt));
    expect(current(h, attempt.identity.jobId).status).toBe("running");
    expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
  });
});

describe("fresh stop facts after synchronous soft stop", () => {
  function expectOriginalSlot(
    h: Harness,
    attempt: ClaimedAttempt,
    waitingJobId: string,
  ) {
    expect(current(h, attempt.identity.jobId)).toMatchObject({
      status: "running",
      reason: null,
      cancelRequested: true,
      completedAt: null,
    });
    expect(h.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
      identity: attempt.identity,
      launchTicket: attempt.launchTicket,
      executionDeadlineAt: attempt.executionDeadlineAt,
      ownerDescriptor: treeExit(attempt).descriptor,
      authorizedAt: attempt.firstStartedAt,
      exit: null,
    });
    expect(
      snapshot(h.storage, (db) =>
        db
          .prepare("SELECT job_id, attempt_no, fence FROM execution_slot")
          .get(),
      ),
    ).toEqual({
      job_id: attempt.identity.jobId,
      attempt_no: attempt.identity.attemptNo,
      fence: attempt.identity.fence,
    });
    expect(current(h, waitingJobId).status).toBe("queued");
    expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
    expect(h.executor.prepareCalls).toHaveLength(1);
    expect(h.executor.authorizeCalls).toHaveLength(1);
    for (const call of h.executor.stopCalls)
      expect(call).toMatchObject({
        attempt: {
          identity: attempt.identity,
          launchTicket: attempt.launchTicket,
        },
        descriptor: treeExit(attempt).descriptor,
      });
  }

  it.each([-1, 0, 1])(
    "checks the refreshed lease boundary before force at offset %i",
    async (offset) => {
      const h = await harness();
      const { attempt } = await start(h);
      const waiting = await h.submit("waiting-after-soft-clock");
      const cancelledAt = h.storage.clock();
      expect(h.cancel(attempt.identity.jobId)).toMatchObject({
        status: 202,
        applied: true,
      });
      const cancelled = h.storage.store.getActiveAttempt(attempt.identity)!;
      const limits = cancelled.executionPolicy.limits;
      const originalStop = {
        stop_reason: "user_cancel",
        stop_requested_at: cancelledAt,
        terminate_after_at: cancelledAt + limits.cancelGraceMs,
      };
      expect(stopFacts(h)).toEqual(originalStop);
      const dispatchAt = cancelled.terminateAfterAt! + 1;
      // Skip the earlier heartbeat so this wake renews the original valid lease
      // before its first soft dispatch. The hook advances that same clock.
      h.storage.setNow(dispatchAt);
      let softFacts: ActiveAttempt | undefined;
      let forceFacts: ActiveAttempt | undefined;
      let forceAt: number | undefined;
      h.executor.hooks.stop = async (call) => {
        const active = h.storage.store.getActiveAttempt(call.attempt.identity);
        if (call.mode === "soft") {
          softFacts = active;
          if (active) h.storage.setNow(active.leaseExpiresAt + offset);
        } else {
          forceFacts = active;
          forceAt = h.storage.clock();
        }
      };
      const timerCount = h.time.entries.length;
      const wakeError = await h.runner.wake().then(
        () => undefined,
        (error: unknown) => error,
      );
      const leaseAtSoft = dispatchAt + limits.leaseDurationMs;
      const afterSoftAt = leaseAtSoft + offset;
      expect(softFacts).toMatchObject({
        identity: attempt.identity,
        launchTicket: attempt.launchTicket,
        leaseExpiresAt: leaseAtSoft,
        stopReason: "user_cancel",
        stopRequestedAt: cancelledAt,
        terminateAfterAt: originalStop.terminate_after_at,
        exit: null,
      });
      expect(h.storage.clock()).toBe(afterSoftAt);
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual(
        offset > 0 ? ["soft"] : ["soft", "force"],
      );
      expect(
        h.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
      ).toBe(offset > 0 ? leaseAtSoft : afterSoftAt + limits.leaseDurationMs);
      if (offset > 0) {
        expect(h.time.entries).toHaveLength(timerCount);
        expect(h.time.pending()).toHaveLength(0);
      } else {
        expect(forceAt).toBe(afterSoftAt);
        expect(forceFacts?.leaseExpiresAt).toBeGreaterThanOrEqual(afterSoftAt);
        expect(forceFacts).toMatchObject({
          identity: attempt.identity,
          launchTicket: attempt.launchTicket,
          ownerDescriptor: treeExit(attempt).descriptor,
          authorizedAt: attempt.firstStartedAt,
          stopReason: "user_cancel",
          terminateAfterAt: originalStop.terminate_after_at,
          exit: null,
        });
        expect(h.time.pending().map((entry) => entry.at)).toEqual([
          afterSoftAt + limits.heartbeatIntervalMs,
        ]);
        expect(
          h.time.entries
            .slice(timerCount)
            .every((entry) => entry.at > h.storage.clock()),
        ).toBe(true);
      }
      expectOriginalSlot(h, attempt, waiting.job.jobId);
      expect(stopFacts(h)).toEqual(originalStop);
      expect(wakeError).toBeUndefined();
      await h.runner.wake();
      await h.runner.wake();
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual(
        offset > 0 ? ["soft"] : ["soft", "force"],
      );
      expectOriginalSlot(h, attempt, waiting.job.jobId);
      expect(stopFacts(h)).toEqual(originalStop);
      if (offset > 0) {
        expect(h.time.entries).toHaveLength(timerCount);
        expect(h.time.pending()).toHaveLength(0);
        expect(
          h.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
        ).toBe(leaseAtSoft);
      } else
        expect(h.time.pending().map((entry) => entry.at)).toEqual([
          afterSoftAt + limits.heartbeatIntervalMs,
        ]);
    },
  );

  it("uses the new grace and due heartbeat when soft crosses the original grace", async () => {
    const h = await harness();
    const { attempt } = await start(h);
    const waiting = await h.submit("waiting-after-soft-grace");
    h.cancel(attempt.identity.jobId);
    const cancelled = h.storage.store.getActiveAttempt(attempt.identity)!;
    const limits = cancelled.executionPolicy.limits;
    const originalStop = stopFacts(h);
    const afterSoftAt = cancelled.terminateAfterAt! + 1;
    expect(afterSoftAt).toBeLessThan(attempt.leaseExpiresAt);
    let softFacts: ActiveAttempt | undefined;
    h.executor.hooks.stop = async (call) => {
      if (call.mode === "soft") {
        softFacts = h.storage.store.getActiveAttempt(call.attempt.identity);
        h.storage.setNow(afterSoftAt);
      }
    };
    const timerCount = h.time.entries.length;
    const wakeError = await h.runner.wake().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(softFacts).toMatchObject({
      leaseExpiresAt: attempt.leaseExpiresAt,
      stopReason: "user_cancel",
      stopRequestedAt: attempt.firstStartedAt,
      terminateAfterAt: attempt.firstStartedAt + limits.cancelGraceMs,
    });
    expect(h.storage.clock()).toBe(afterSoftAt);
    expect(h.executor.stopCalls.map((call) => call.mode)).toEqual([
      "soft",
      "force",
    ]);
    expect(
      h.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
    ).toBe(afterSoftAt + limits.leaseDurationMs);
    expect(h.time.pending().map((entry) => entry.at)).toEqual([
      afterSoftAt + limits.heartbeatIntervalMs,
    ]);
    expect(
      h.time.entries
        .slice(timerCount)
        .every((entry) => entry.at > h.storage.clock()),
    ).toBe(true);
    expectOriginalSlot(h, attempt, waiting.job.jobId);
    expect(stopFacts(h)).toEqual(originalStop);
    expect(wakeError).toBeUndefined();
    await h.runner.wake();
    await h.runner.wake();
    expect(h.executor.stopCalls.map((call) => call.mode)).toEqual([
      "soft",
      "force",
    ]);
    expect(h.time.pending().map((entry) => entry.at)).toEqual([
      afterSoftAt + limits.heartbeatIntervalMs,
    ]);
    expectOriginalSlot(h, attempt, waiting.job.jobId);
    expect(stopFacts(h)).toEqual(originalStop);
  });
});

describe("persistent cancellation without assuming stop means exit", () => {
  it.each(["return", "reject"])(
    "keeps running after a soft stop %s and does not send it twice",
    async (mode) => {
      const h = await harness();
      const { attempt } = await start(h);
      if (mode === "reject")
        h.executor.hooks.stop = async () => {
          throw new Error("private-stop-failure");
        };
      h.cancel(attempt.identity.jobId);
      await h.runner.wake();
      await h.runner.wake();
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
      expect(h.executor.stopCalls[0]).toMatchObject({
        attempt: { identity: attempt.identity },
        descriptor: treeExit(attempt).descriptor,
      });
      expect(current(h, attempt.identity.jobId)).toMatchObject({
        status: "running",
        cancelRequested: true,
        reason: null,
      });
      expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
    },
  );

  it.each([-1, 0, 1])(
    "sends force only strictly after the frozen grace at offset %i",
    async (offset) => {
      const h = await harness();
      const { attempt } = await start(h);
      h.cancel(attempt.identity.jobId);
      await h.runner.wake();
      h.time.advanceTo(6_000 + offset);
      await h.runner.wake();
      await h.runner.wake();
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual(
        offset > 0 ? ["soft", "force"] : ["soft"],
      );
      expect(current(h, attempt.identity.jobId).status).toBe("running");
      expect(stopFacts(h)).toEqual({
        stop_reason: "user_cancel",
        stop_requested_at: 1_000,
        terminate_after_at: 6_000,
      });
    },
  );

  it("continues heartbeat and force while a single soft stop Promise stays pending", async () => {
    const h = await harness();
    const { attempt } = await start(h);
    const gate = deferred();
    h.executor.hooks.stop = async () => {
      await gate.promise;
    };
    try {
      h.cancel(attempt.identity.jobId);
      const first = h.runner.wake();
      const repeated = h.runner.wake();
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
      h.time.advanceTo(6_001);
      const forced = h.runner.wake();
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual([
        "soft",
        "force",
      ]);
      expect(
        h.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
      ).toBe(21_000);
      h.executor.emit(treeExit(attempt));
      expect(current(h, attempt.identity.jobId).status).toBe("cancelled");
      gate.resolve();
      await Promise.all([first, repeated, forced]);
    } finally {
      gate.resolve();
    }
  });

  it("does not let pending authorize confirmation block cancellation, force or matching exit", async () => {
    const h = await harness();
    const accepted = await h.submit();
    const gate = deferred();
    h.executor.hooks.authorize = async () => {
      await gate.promise;
    };
    const launching = h.runner.wake();
    void launching.catch(() => {});
    try {
      const attempt = await h.executor.authorized.promise;
      expect(
        h.storage.store.getActiveAttempt(attempt.identity)?.authorizedAt,
      ).toBe(1_000);
      h.cancel(accepted.job.jobId);
      const cancelling = h.runner.wake();
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
      h.time.advanceTo(6_001);
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual([
        "soft",
        "force",
      ]);
      expect(
        h.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
      ).toBe(21_000);
      h.executor.emit(treeExit(attempt));
      expect(current(h, accepted.job.jobId).status).toBe("cancelled");
      gate.resolve();
      // The hook precedes the controlled send; its final permission is denied
      // after cancellation, including after exact terminal cleanup.
      await expect(launching).rejects.toMatchObject({ code: "not_ready" });
      await cancelling;
      expect(h.executor.authorizeCalls).toHaveLength(1);
    } finally {
      gate.resolve();
    }
  });

  it("persists a cancellation during prepare and refuses its late descriptor without guessing ownership", async () => {
    const h = await harness();
    const accepted = await h.submit();
    const gate = deferred();
    h.executor.hooks.prepare = async (_attempt, owner) => {
      await gate.promise;
      return owner;
    };
    const launching = h.runner.wake();
    void launching.catch(() => {});
    try {
      const attempt = await h.executor.prepared.promise;
      h.cancel(accepted.job.jobId);
      const cancelling = h.runner.wake();
      expect(h.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
        ownerDescriptor: null,
        authorizedAt: null,
        stopReason: "user_cancel",
      });
      expect(h.executor.stopCalls).toHaveLength(0);
      gate.resolve();
      await expect(launching).rejects.toMatchObject({ code: "not_ready" });
      await cancelling;
      expect(h.executor.authorizeCalls).toHaveLength(0);
      expect(current(h, accepted.job.jobId).status).toBe("running");
      expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
    } finally {
      gate.resolve();
    }
  });

  it("seals a suspended authorization before freeing its ticket and never starts it after terminal tree exit", async () => {
    const h = await harness();
    const accepted = await h.submit();
    const gate = deferred();
    h.executor.hooks.authorize = async (attempt) => {
      if (attempt.identity.jobId === accepted.job.jobId) await gate.promise;
    };
    const launching = h.runner.wake();
    void launching.catch(() => {});
    try {
      const attempt = await h.executor.authorized.promise;
      expect(h.executor.launchCalls).toHaveLength(0);
      h.cancel(accepted.job.jobId);
      const cancelling = h.runner.wake();
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
      h.time.advanceTo(6_001);
      expect(h.executor.stopCalls.map((call) => call.mode)).toEqual([
        "soft",
        "force",
      ]);
      const waiting = await h.submit("after-sealed-ticket");
      h.executor.emit(treeExit(attempt));
      await h.runner.wake();
      expect(current(h, accepted.job.jobId).status).toBe("cancelled");
      expect(current(h, waiting.job.jobId).status).toBe("running");
      expect(h.executor.activeCount()).toBe(1);
      gate.resolve();
      await expect(launching).rejects.toMatchObject({ code: "not_ready" });
      await cancelling;
      expect(h.executor.launchCalls.map((call) => call.identity.jobId)).toEqual(
        [waiting.job.jobId],
      );
      expect(h.executor.activeCount()).toBe(1);
      expect(h.executor.authorizeCalls).toHaveLength(2);
    } finally {
      gate.resolve();
    }
  });

  it("subscribes before actual authorize so a synchronous whole-tree exit is persisted and still owns its slot", async () => {
    const h = await harness();
    h.executor.hooks.authorize = async (attempt, owner) => {
      expect(
        h.executor.observers.filter((observer) => observer.subscribed),
      ).toHaveLength(1);
      h.executor.emit(treeExit(attempt, owner));
    };
    // This hook emits before the designated start. Its terminal is observed,
    // then the later controlled send is denied rather than fabricated.
    await h.submit();
    await expect(h.runner.wake()).rejects.toMatchObject({ code: "not_ready" });
    const attempt = h.executor.authorizeCalls[0]!;
    expect(h.storage.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
      treeExit(attempt),
    );
    expect(current(h, attempt.identity.jobId).status).toBe("running");
    expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
    h.cancel(attempt.identity.jobId);
    await h.runner.wake();
    expect(current(h, attempt.identity.jobId).status).toBe("cancelled");
    expect(h.executor.stopCalls).toHaveLength(0);
  });

  it("handles a synchronous tree exit inside soft stop even when the stop later rejects", async () => {
    const h = await harness();
    const { attempt } = await start(h);
    h.executor.hooks.stop = async () => {
      h.executor.emit(treeExit(attempt));
      throw new Error("private-stop-acknowledgement-lost");
    };
    h.cancel(attempt.identity.jobId);
    await h.runner.wake();
    expect(current(h, attempt.identity.jobId)).toMatchObject({
      status: "cancelled",
      reason: "user_cancel",
    });
    expect(h.executor.stopCalls).toHaveLength(1);
    expect(h.time.pending()).toHaveLength(0);
  });

  it("keeps waiting jobs blocked until matching exit, then ignores the old event for the new slot", async () => {
    const h = await harness();
    const { attempt } = await start(h);
    const waiting = await h.submit("waiting");
    h.cancel(attempt.identity.jobId);
    await h.runner.wake();
    const oldObserver = h.executor.observers[0]!;
    const oldTimer = h.time.entries[0]!;
    h.executor.emit({ ...treeExit(attempt), launchTicket: "wrong-ticket" });
    await h.runner.wake();
    expect(h.executor.prepareCalls).toHaveLength(1);
    expect(current(h, waiting.job.jobId).status).toBe("queued");
    h.executor.emit(treeExit(attempt));
    await h.runner.wake();
    expect(current(h, waiting.job.jobId).status).toBe("running");
    const next = h.executor.authorizeCalls[1]!;
    oldObserver.listener(treeExit(attempt));
    oldTimer.callback();
    await h.runner.wake();
    expect(h.storage.store.getActiveAttempt(next.identity)?.identity).toEqual(
      next.identity,
    );
    expect(current(h, waiting.job.jobId).status).toBe("running");
    expect(h.executor.prepareCalls).toHaveLength(2);
  });

  it("cancels subscriptions and timers on close and rejects their late events without clearing the unknown slot", async () => {
    const h = await harness();
    const { attempt } = await start(h);
    h.cancel(attempt.identity.jobId);
    await h.runner.wake();
    const observer = h.executor.observers[0]!;
    const callbacks = h.time.entries.map((entry) => entry.callback);
    await h.runner.close();
    await h.runner.close();
    expect(h.time.pending()).toHaveLength(0);
    expect(observer.subscribed).toBe(false);
    h.storage.setNow(6_001);
    for (const callback of callbacks) callback();
    observer.listener(treeExit(attempt));
    expect(h.executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
    expect(current(h, attempt.identity.jobId).status).toBe("running");
    expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
    await expect(h.runner.wake()).rejects.toMatchObject({ code: "not_ready" });
  });

  it("does not force or reschedule after close inside synchronous soft stop", async () => {
    const h = await harness();
    const { attempt } = await start(h);
    const waiting = await h.submit("waiting-at-close");
    h.cancel(attempt.identity.jobId);
    // Do not deliver the earlier heartbeat: this is the first stop dispatch,
    // already beyond the original grace, with the original lease still valid.
    h.storage.setNow(6_001);
    let closing: Promise<void> | undefined;
    h.executor.hooks.stop = async (call) => {
      if (call.mode === "soft") closing = h.runner.close();
    };
    await h.runner.wake();
    await closing;
    expect(current(h, attempt.identity.jobId)).toMatchObject({
      status: "running",
      reason: null,
      cancelRequested: true,
      completedAt: null,
    });
    expect(h.storage.store.getActiveAttempt(attempt.identity)?.exit).toBeNull();
    expect(
      snapshot(h.storage, (db) =>
        db
          .prepare("SELECT job_id, attempt_no, fence FROM execution_slot")
          .get(),
      ),
    ).toEqual({
      job_id: attempt.identity.jobId,
      attempt_no: attempt.identity.attemptNo,
      fence: attempt.identity.fence,
    });
    expect(current(h, waiting.job.jobId).status).toBe("queued");
    expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
    expect(h.executor.prepareCalls).toHaveLength(1);
    expect(h.time.pending()).toHaveLength(0);
    expect(h.executor.observers.every((observer) => !observer.subscribed)).toBe(
      true,
    );
    expect(h.executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
    await expect(h.runner.wake()).rejects.toMatchObject({ code: "not_ready" });
  });
});

describe("real durable stop commit barrier", () => {
  it("does not call an adapter when stop facts fail at real SQLite COMMIT", async () => {
    const h = await harness((storage) => {
      storage.setRunnerLimits({ ...runnerLimits, executionTimeoutMs: 5_000 });
      commitFault(
        storage,
        `CREATE TRIGGER lifecycle_stop_commit AFTER UPDATE OF stop_reason ON attempts
        BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
      );
    });
    const { attempt } = await start(h);
    // Deliver the strict timeout event explicitly to observe the returned command error.
    h.storage.setNow(attempt.executionDeadlineAt + 1);
    await expect(h.runner.wake()).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(h.executor.stopCalls).toHaveLength(0);
    expect(stopFacts(h)).toEqual({
      stop_reason: null,
      stop_requested_at: null,
      terminate_after_at: null,
    });
    expect(current(h, attempt.identity.jobId).status).toBe("running");
    expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
  });
});

describe("running cancel over real TCP remains a persistent command", () => {
  it("returns first/repeated 202 without waiting for authorize or stop and requires caller wake", async () => {
    const f = await httpFixture();
    const time = manualClock(f.storage);
    const executor = controlledExecutor();
    const gate = deferred();
    executor.hooks.authorize = async () => {
      await gate.promise;
    };
    const runner = createRunner({
      store: f.storage.store,
      clock: time.clock,
      executor: executor.adapter,
      ownerInstanceId: "http-lifecycle-owner",
    });
    cleanups.push(async () => {
      gate.resolve();
      await runner.close();
      await f.cleanup();
    });
    const accepted = await f.upload(await sourceImage(), "running-http");
    const job = jobOf(accepted);
    expect(executor.prepareCalls).toHaveLength(0);
    const launching = runner.wake();
    void launching.catch(() => {});
    const attempt = await executor.authorized.promise;
    const first = await f.call("DELETE", `/v1/enhancement-jobs/${job.jobId}`);
    const repeated = await f.call(
      "DELETE",
      `/v1/enhancement-jobs/${job.jobId}`,
    );
    expect(first).toMatchObject({
      status: 202,
      body: { code: "ok", data: { applied: true } },
    });
    expect(repeated).toMatchObject({
      status: 202,
      body: { code: "ok", data: { applied: false } },
    });
    expect(jobOf(first)).toMatchObject({
      status: "running",
      reason: null,
      cancelRequested: true,
    });
    expect(executor.stopCalls).toHaveLength(0);
    const foreign = createClient(f.storage.store);
    const hidden = await f.call(
      "DELETE",
      `/v1/enhancement-jobs/${job.jobId}`,
      undefined,
      { authorization: `Bearer ${foreign.key}` },
    );
    expect(hidden).toMatchObject({
      status: 404,
      body: { code: "job_not_found" },
    });
    for (const privateFact of [
      f.storage.directory,
      attempt.launchTicket,
      "ownerDescriptor",
      "executionPolicy",
      "terminateAfterAt",
    ])
      expect(first.raw).not.toContain(privateFact);
    const cancelling = runner.wake();
    expect(executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
    executor.emit(treeExit(attempt));
    expect(
      jobOf(await f.call("GET", `/v1/enhancement-jobs/${job.jobId}`)),
    ).toMatchObject({ status: "cancelled", reason: "user_cancel" });
    expect(
      await f.call("DELETE", `/v1/enhancement-jobs/${job.jobId}`),
    ).toMatchObject({
      status: 200,
      body: { data: { applied: false } },
    });
    gate.resolve();
    await expect(launching).rejects.toMatchObject({ code: "not_ready" });
    await cancelling;
  });
});
