import assert from "node:assert/strict";
import { mkdir, unlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Inspection } from "../src/execution.js";
import { deferred } from "./http-fixtures.js";
import {
  commitFault,
  descriptor,
  snapshot,
  treeExit,
} from "./lifecycle-fixtures.js";
import {
  observeInspection,
  recoveryFixture,
  target,
  type RecoveryFixture,
} from "./recovery-fixtures.js";
import { runnerLimits } from "./storage-fixtures.js";

const fixtures: RecoveryFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});
async function fixture() {
  const f = await recoveryFixture();
  fixtures.push(f);
  return f;
}
function job(f: RecoveryFixture, jobId: string) {
  return f.storage.store.getOwned(f.storage.principal(), jobId);
}
function currentRows(f: RecoveryFixture) {
  return snapshot(f.storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
    attempts: db
      .prepare("SELECT * FROM attempts ORDER BY job_id, attempt_no")
      .all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
    controls: db
      .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
      .all(),
    events: db.prepare("SELECT * FROM recovery_events ORDER BY rowid").all(),
  }));
}

describe("recovery A: inspection without releasing unknown execution", () => {
  it("recovery refresh: retires an unknown runner after another controller takes authority", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    const waiting = await f.submit("refresh-runner-waiting");
    await f.reopen();
    f.executor.hooks.inspect = async (call) => ({
      kind: "unknown",
      ...call.target,
    });
    const runner = f.runner();
    await runner.recover();
    const previous = f.storage.store.beginRecovery("recovery-owner");
    assert.ok(previous);
    const replacement = f.storage.store.beginRecovery("replacement-controller");
    assert.ok(replacement);
    const before = currentRows(f);
    await runner.wake();
    expect(f.time.pending()).toHaveLength(0);
    f.time.advanceTo(waiting.job.queueDeadlineAt + 1);
    await runner.wake();
    expect(currentRows(f)).toEqual(before);
    expect(f.executor.inspectCalls).toHaveLength(1);
    expect(f.executor.stopCalls).toHaveLength(0);
    expect(f.executor.launchCalls).toHaveLength(1);
    expect(
      f.storage.store.getActiveAttempt(attempt.identity)?.producer,
    ).toEqual(attempt.identity);
    expect(
      f.storage.store.beginRecovery("recovery-owner", previous.control),
    ).toBeUndefined();
    const refreshed = f.storage.store.beginRecovery(
      "replacement-controller",
      replacement.control,
    );
    expect(refreshed?.control).toEqual(replacement.control);
    expect(job(f, waiting.job.jobId).reason).toBe("queue_timeout");
  });

  it("uses the existing wake path when recovery discovers no residual slot", async () => {
    const f = await fixture();
    const accepted = await f.submit();
    await f.reopen();
    const runner = f.runner();
    await runner.recover();
    expect(f.executor.inspectCalls).toHaveLength(0);
    expect(
      f.executor.launchCalls.map((attempt) => attempt.identity.jobId),
    ).toEqual([accepted.job.jobId]);
    expect(job(f, accepted.job.jobId).status).toBe("running");
    expect(runner.readiness().ready).toBe(false);
  });

  it.each(["unknown", "throw", "pending"] as const)(
    "retains the slot and advances queued deadlines during %s inspection",
    async (mode) => {
      const f = await fixture();
      const attempt = await f.claim("authorized");
      const waiting = await f.submit("waiting");
      await f.reopen();
      const gate = deferred<Inspection>();
      f.releaseOnCleanup(() =>
        gate.resolve({ kind: "unknown", ...target(attempt) }),
      );
      f.executor.hooks.inspect = async (call) => {
        if (mode === "throw")
          throw new Error("controlled inspection unavailable");
        if (mode === "pending") return gate.promise;
        return { kind: "unknown", ...call.target };
      };
      const runner = f.runner();
      const recovery = runner.recover();
      void recovery.catch(() => {});
      await observeInspection(f.executor, recovery);
      if (mode !== "pending") await recovery.catch(() => {});
      expect(runner.readiness()).toEqual({
        ready: false,
        recoveryState: mode === "pending" ? "inspecting" : "unknown",
      });
      expect(job(f, attempt.identity.jobId)).toMatchObject({
        status: "running",
        completedAt: null,
      });
      expect(
        f.storage
          .service()
          .cancel(f.storage.principal(), attempt.identity.jobId),
      ).toMatchObject({
        status: 202,
        applied: true,
      });
      await runner.wake();
      expect(f.executor.stopCalls).toHaveLength(0);
      f.time.advanceTo(waiting.job.queueDeadlineAt);
      expect(job(f, waiting.job.jobId).status).toBe("queued");
      f.time.advanceTo(waiting.job.queueDeadlineAt + 1);
      expect(job(f, waiting.job.jobId)).toMatchObject({
        status: "failed",
        reason: "queue_timeout",
      });
      expect(f.executor.launchCalls).toHaveLength(1);
      expect(f.executor.inspectCalls).toHaveLength(1);
      expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
        producer: attempt.identity,
        leaseExpiresAt: attempt.leaseExpiresAt,
        executionDeadlineAt: attempt.executionDeadlineAt,
        exit: null,
      });
      expect(f.storage.store.claimNext("waiting-owner")).toBeUndefined();
      expect(
        f.time.pending().every((event) => event.at > f.storage.clock()),
      ).toBe(true);
      await runner.close();
      if (mode === "pending") {
        gate.resolve({ kind: "unknown", ...target(attempt) });
        await recovery.catch(() => {});
      }
    },
  );

  it("advances the original global timeout while inspect remains pending without polling it", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    await f.reopen();
    const gate = deferred<Inspection>();
    f.releaseOnCleanup(() =>
      gate.resolve({ kind: "unknown", ...target(attempt) }),
    );
    f.executor.hooks.inspect = () => gate.promise;
    const runner = f.runner();
    const recovery = runner.recover();
    void recovery.catch(() => {});
    await observeInspection(f.executor, recovery);
    expect(f.time.pending().map((event) => event.at)).toEqual([
      attempt.executionDeadlineAt + 1,
    ]);
    f.time.advanceTo(attempt.executionDeadlineAt);
    expect(
      f.storage.store.getActiveAttempt(attempt.identity)?.stopReason,
    ).toBeNull();
    f.time.advanceTo(attempt.executionDeadlineAt + 1);
    expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
      stopReason: "execution_timeout",
      stopRequestedAt: attempt.executionDeadlineAt + 1,
      terminateAfterAt:
        attempt.executionDeadlineAt + 1 + runnerLimits.cancelGraceMs,
    });
    expect(f.executor.inspectCalls).toHaveLength(1);
    expect(f.executor.stopCalls).toHaveLength(0);
    expect(runner.readiness()).toEqual({
      ready: false,
      recoveryState: "inspecting",
    });
    await runner.close();
    gate.resolve({ kind: "unknown", ...target(attempt) });
    await recovery.catch(() => {});
  });

  it("recovery reentry: coalesces recover called synchronously from inspect", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    await f.reopen();
    const gate = deferred<Inspection>();
    f.releaseOnCleanup(() =>
      gate.resolve({ kind: "unknown", ...target(attempt) }),
    );
    const runner = f.runner();
    let reentered = false;
    let nested: Promise<void> | undefined;
    f.executor.hooks.inspect = () => {
      if (!reentered) {
        reentered = true;
        nested = runner.recover();
        void nested.catch(() => {});
      }
      return gate.promise;
    };
    const first = runner.recover();
    void first.catch(() => {});
    await observeInspection(f.executor, first);
    assert.ok(nested);
    gate.resolve({ kind: "unknown", ...target(attempt) });
    await Promise.all([first, nested]);
    expect({
      samePromise: nested === first,
      inspections: f.executor.inspectCalls.length,
    }).toEqual({ samePromise: true, inspections: 1 });
    expect(f.executor.inspectCalls[0]).toEqual({
      target: target(attempt),
      descriptor: descriptor(attempt),
    });
    expect(f.executor.launchCalls).toHaveLength(1);
    expect(f.executor.stopCalls).toHaveLength(0);
    expect(job(f, attempt.identity.jobId).status).toBe("running");
    expect(runner.readiness()).toEqual({
      ready: false,
      recoveryState: "unknown",
    });
  });

  it("coalesces concurrent recover calls into one inspection of one original target", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    await f.reopen();
    const gate = deferred<Inspection>();
    f.releaseOnCleanup(() =>
      gate.resolve({ kind: "unknown", ...target(attempt) }),
    );
    f.executor.hooks.inspect = () => gate.promise;
    const runner = f.runner();
    const first = runner.recover();
    void first.catch(() => {});
    await observeInspection(f.executor, first);
    const second = runner.recover();
    const third = runner.recover();
    void second.catch(() => {});
    void third.catch(() => {});
    expect(f.executor.inspectCalls).toEqual([
      { target: target(attempt), descriptor: descriptor(attempt) },
    ]);
    gate.resolve({
      kind: "owned-alive",
      ...target(attempt),
      descriptor: descriptor(attempt),
    });
    await Promise.all([first, second, third]);
    expect(runner.readiness()).toEqual({
      ready: false,
      recoveryState: "owned-alive",
    });
    expect(f.executor.prepareCalls).toHaveLength(1);
    expect(f.executor.launchCalls).toHaveLength(1);
  });

  it.each(["owned-alive", "tree-exited", "never-authorized"] as const)(
    "closes without waiting for inspect and ignores a late %s result",
    async (kind) => {
      const f = await fixture();
      const attempt = await f.claim(
        kind === "never-authorized" ? "claimed" : "authorized",
      );
      if (kind !== "never-authorized")
        f.storage
          .service()
          .cancel(f.storage.principal(), attempt.identity.jobId);
      await f.submit("waiting");
      await f.reopen();
      const gate = deferred<Inspection>();
      f.releaseOnCleanup(() =>
        gate.resolve({ kind: "unknown", ...target(attempt) }),
      );
      f.executor.hooks.inspect = () => gate.promise;
      const runner = f.runner();
      const recovery = runner.recover();
      void recovery.catch(() => {});
      await observeInspection(f.executor, recovery);
      expect(
        await Promise.race([
          runner.close().then(() => "closed"),
          recovery.then(() => "inspection-settled"),
        ]),
      ).toBe("closed");
      const before = currentRows(f);
      if (kind === "tree-exited")
        gate.resolve({ kind, exit: treeExit(attempt) });
      else if (kind === "owned-alive")
        gate.resolve({
          kind,
          ...target(attempt),
          descriptor: descriptor(attempt),
        });
      else gate.resolve({ kind, ...target(attempt) });
      await recovery.catch(() => {});
      expect(currentRows(f)).toEqual(before);
      expect(f.executor.stopCalls).toHaveLength(0);
      expect(f.executor.prepareCalls).toHaveLength(
        kind === "never-authorized" ? 0 : 1,
      );
      expect(
        f.executor.observers.every((observer) => !observer.subscribed),
      ).toBe(true);
      expect(f.time.pending()).toHaveLength(0);
      await expect(runner.recover()).rejects.toMatchObject({
        code: "not_ready",
      });
    },
  );

  it("seals a claim while its old prepare is suspended and never starts that late capability", async () => {
    const f = await fixture();
    const accepted = await f.submit();
    const gate = deferred();
    f.releaseOnCleanup(() => gate.resolve());
    f.executor.hooks.prepare = async (_attempt, owner) => {
      await gate.promise;
      return owner;
    };
    const oldRunner = f.runner("producer-owner");
    const wake = oldRunner.wake();
    void wake.catch(() => {});
    await Promise.race([
      f.executor.prepared.promise,
      wake.then(() => {
        throw new Error("old runner did not reach prepare");
      }),
    ]);
    const original = f.executor.prepareCalls[0]!;
    await f.reopen();
    f.executor.hooks.prepare = undefined;
    const recoveryRunner = f.runner();
    await recoveryRunner.recover();
    gate.resolve();
    await expect(wake).rejects.toMatchObject({ code: "not_ready" });
    expect(f.executor.isSealed(original.launchTicket)).toBe(true);
    expect(f.executor.launchCalls).toHaveLength(1);
    expect(f.executor.launchCalls[0]!.identity).toMatchObject({
      jobId: accepted.job.jobId,
      attemptNo: original.identity.attemptNo + 1,
    });
    expect(
      f.executor.authorizeCalls.some(
        (attempt) => attempt.launchTicket === original.launchTicket,
      ),
    ).toBe(false);
  });
});

describe("recovery B: exact stopping with fresh durable authority", () => {
  it.each(["cancel", "timeout"] as const)(
    "resends a committed %s stop to the producer after reopening before signal dispatch",
    async (reason) => {
      const f = await fixture();
      if (reason === "timeout")
        f.storage.setRunnerLimits({
          ...runnerLimits,
          executionTimeoutMs: runnerLimits.heartbeatIntervalMs,
        });
      const attempt = await f.claim("authorized");
      if (reason === "cancel")
        f.storage
          .service()
          .cancel(f.storage.principal(), attempt.identity.jobId);
      else {
        f.storage.setNow(attempt.executionDeadlineAt + 1);
        expect(
          f.storage.store.requestStop(attempt.identity, "execution_timeout"),
        ).toBe(true);
      }
      const stopped = f.storage.store.getActiveAttempt(attempt.identity)!;
      expect(f.executor.stopCalls).toHaveLength(0);
      await f.reopen();
      const runner = f.runner();
      await runner.recover();
      expect(f.executor.stopCalls).toEqual([
        {
          target: target(attempt),
          descriptor: descriptor(attempt),
          mode: "soft",
        },
      ]);
      f.time.advanceTo(stopped.terminateAfterAt!);
      await runner.wake();
      expect(f.executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
      f.time.advanceTo(stopped.terminateAfterAt! + 1);
      await runner.wake();
      await runner.wake();
      expect(f.executor.stopCalls.map((call) => call.mode)).toEqual([
        "soft",
        "force",
      ]);
      expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
        producer: attempt.identity,
        identity: attempt.identity,
        launchTicket: attempt.launchTicket,
        workingDirectory: attempt.workingDirectory,
        leaseExpiresAt: attempt.leaseExpiresAt,
        terminateAfterAt: stopped.terminateAfterAt,
        executionDeadlineAt: attempt.executionDeadlineAt,
      });
      expect(job(f, attempt.identity.jobId).status).toBe("running");
    },
  );

  it.each(["return", "throw", "pending"] as const)(
    "keeps the slot after a recovery stop %s and sends each mode only once per control",
    async (acknowledgement) => {
      const f = await fixture();
      const attempt = await f.claim("authorized");
      f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
      await f.reopen();
      const gate = deferred();
      f.releaseOnCleanup(() => gate.resolve());
      f.executor.hooks.stop = async () => {
        if (acknowledgement === "throw")
          throw new Error("controlled stop acknowledgement lost");
        if (acknowledgement === "pending") await gate.promise;
      };
      const runner = f.runner();
      await runner.recover();
      await runner.wake();
      f.time.advanceTo(1_000 + runnerLimits.cancelGraceMs + 1);
      await runner.wake();
      await runner.wake();
      expect(f.executor.stopCalls.map((call) => call.mode)).toEqual([
        "soft",
        "force",
      ]);
      expect(job(f, attempt.identity.jobId)).toMatchObject({
        status: "running",
        completedAt: null,
      });
      expect(f.storage.store.claimNext("waiting-owner")).toBeUndefined();
      expect(f.executor.activeCount()).toBe(1);
      gate.resolve();
    },
  );

  it("can resend the original stop in a new recovery instance after the owner lease expires", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    await f.reopen();
    await f.runner().recover();
    await f.reopen();
    f.storage.setNow(attempt.leaseExpiresAt + 1);
    const runner = f.runner("next-recovery-owner");
    await runner.recover();
    expect(f.executor.stopCalls.map((call) => call.mode)).toEqual([
      "soft",
      "soft",
      "force",
    ]);
    expect(
      f.executor.stopCalls.every(
        (call) =>
          JSON.stringify(call.target) === JSON.stringify(target(attempt)),
      ),
    ).toBe(true);
    expect(
      f.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
    ).toBe(attempt.leaseExpiresAt);
    expect(job(f, attempt.identity.jobId).status).toBe("running");
  });

  it("uses the original producer exit in recovery CAS and never forces a replacement after synchronous soft exit", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    const waiting = await f.submit("waiting");
    await f.reopen();
    f.storage.setNow(1_000 + runnerLimits.cancelGraceMs + 1);
    const runner = f.runner();
    const recoveryExits = vi.spyOn(f.storage.store, "applyRecoveryInspection");
    const ordinaryExits = vi.spyOn(f.storage.store, "registerExit");
    f.executor.hooks.stop = async (call) => {
      if (call.mode === "soft") {
        f.executor.emit(treeExit(attempt));
        throw new Error("controlled stop response lost after synchronous exit");
      }
    };
    await runner.recover();
    await runner.wake();
    expect(
      recoveryExits.mock.calls.some(
        ([, inspection]) =>
          inspection.kind === "tree-exited" &&
          JSON.stringify(inspection.exit.identity) ===
            JSON.stringify(attempt.identity),
      ),
    ).toBe(true);
    expect(ordinaryExits).not.toHaveBeenCalled();
    expect(job(f, attempt.identity.jobId)).toMatchObject({
      status: "cancelled",
      reason: "user_cancel",
    });
    expect(f.executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
    expect(f.executor.launchCalls.at(-1)?.identity.jobId).toBe(
      waiting.job.jobId,
    );
    const originalObserver = f.executor.observers.find(
      (observer) => observer.target.launchTicket === attempt.launchTicket,
    )!;
    originalObserver.listener(treeExit(attempt));
    await runner.wake();
    expect(f.executor.stopCalls).toHaveLength(1);
    expect(job(f, waiting.job.jobId).status).toBe("running");
  });

  it.each([-1, 0, 1])(
    "rechecks the current clock after soft before force at grace offset %i",
    async (offset) => {
      const f = await fixture();
      const attempt = await f.claim("authorized");
      f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
      const stopped = f.storage.store.getActiveAttempt(attempt.identity)!;
      await f.reopen();
      f.storage.setNow(stopped.terminateAfterAt! - 1);
      f.executor.hooks.stop = async (call) => {
        if (call.mode === "soft")
          f.storage.setNow(stopped.terminateAfterAt! + offset);
      };
      await f.runner().recover();
      expect(f.executor.stopCalls.map((call) => call.mode)).toEqual(
        offset > 0 ? ["soft", "force"] : ["soft"],
      );
      expect(
        f.storage.store.getActiveAttempt(attempt.identity)?.terminateAfterAt,
      ).toBe(stopped.terminateAfterAt);
    },
  );

  it("rechecks the control generation after synchronous soft and refuses force from a replaced controller", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    await f.reopen();
    f.storage.setNow(1_000 + runnerLimits.cancelGraceMs + 1);
    f.executor.hooks.stop = async () => {
      f.storage.store.beginRecovery("replacement-controller");
    };
    await f.runner().recover();
    expect(f.executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
    expect(
      f.storage.store.getActiveAttempt(attempt.identity)?.producer,
    ).toEqual(attempt.identity);
  });

  it("does not force, write late exits or reschedule after close inside synchronous soft", async () => {
    const f = await fixture();
    const attempt = await f.claim("authorized");
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    await f.reopen();
    f.storage.setNow(1_000 + runnerLimits.cancelGraceMs + 1);
    const runner = f.runner();
    f.executor.hooks.stop = async () => {
      await runner.close();
    };
    await runner.recover();
    expect(f.executor.stopCalls.map((call) => call.mode)).toEqual(["soft"]);
    expect(f.time.pending()).toHaveLength(0);
    const before = currentRows(f);
    for (const observer of f.executor.observers)
      observer.listener(treeExit(attempt));
    expect(currentRows(f)).toEqual(before);
    expect(f.executor.observers.every((observer) => !observer.subscribed)).toBe(
      true,
    );
  });

  it("does not issue a stop when recovery ownership observation fails at real COMMIT", async () => {
    const f = await fixture();
    expect(
      f.storage.store.beginRecovery("empty-slot-preflight"),
    ).toBeUndefined();
    const attempt = await f.claim("authorized");
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    commitFault(
      f.storage,
      `CREATE TRIGGER recovery_observation_commit AFTER UPDATE OF observed_at ON recovery_controls
      BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
    );
    const runner = f.runner();
    await expect(runner.recover()).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(f.executor.inspectCalls).toHaveLength(1);
    expect(f.executor.stopCalls).toHaveLength(0);
    expect(job(f, attempt.identity.jobId).status).toBe("running");
    expect(f.storage.store.claimNext("waiting-owner")).toBeUndefined();
  });
});

describe("recovery C: created startup attempts and awaiting artifacts", () => {
  it("prepares and authorizes only the created replacement with the frozen original cutoff", async () => {
    const f = await fixture();
    const original = await f.claim();
    await f.reopen();
    const runner = f.runner();
    await runner.recover();
    expect(f.executor.inspectCalls).toEqual([
      { target: target(original), descriptor: null },
    ]);
    expect(f.executor.launchCalls).toHaveLength(1);
    const replacement = f.executor.launchCalls[0]!;
    expect(replacement).toMatchObject({
      identity: {
        jobId: original.identity.jobId,
        attemptNo: original.identity.attemptNo + 1,
      },
      job: original.job,
      executionPolicy: original.executionPolicy,
      firstStartedAt: original.firstStartedAt,
      executionDeadlineAt: original.executionDeadlineAt,
      inputPath: original.inputPath,
      tile: original.tile,
    });
    expect(replacement.launchTicket).not.toBe(original.launchTicket);
    expect(replacement.workingDirectory).not.toBe(original.workingDirectory);
    await runner.wake();
    expect(f.executor.prepareCalls).toHaveLength(1);
    expect(f.executor.authorizeCalls).toHaveLength(1);
  });

  it("does not attach a launch chain to the real already-applied event outcome", async () => {
    const f = await fixture();
    const original = await f.claim();
    await f.reopen();
    const restart = f.storage.store.restartSealedAttempt.bind(f.storage.store);
    vi.spyOn(f.storage.store, "restartSealedAttempt").mockImplementation(
      (publisher, eventId) => {
        // A competing consumer commits first. Both calls use the real SQLite API;
        // the runner receives the actual deduplicated result, never a forged row.
        const committed = restart(publisher, eventId);
        assert.ok(committed && committed.kind === "created");
        return restart(publisher, eventId);
      },
    );
    const runner = f.runner();
    await runner.recover();
    expect(f.executor.prepareCalls).toHaveLength(0);
    expect(f.executor.authorizeCalls).toHaveLength(0);
    expect(f.executor.launchCalls).toHaveLength(0);
    expect(job(f, original.identity.jobId).status).toBe("running");
    expect(
      snapshot(f.storage, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
      ),
    ).toEqual({ count: 2 });
    await runner.wake();
    expect(f.executor.prepareCalls).toHaveLength(0);
  });

  it("does not start a replacement when cancellation commits before sealed inspection returns", async () => {
    const f = await fixture();
    const original = await f.claim();
    await f.reopen();
    const inspect = f.executor.adapter.inspect;
    f.executor.hooks.inspect = async (call) => {
      f.executor.hooks.inspect = undefined;
      const sealed = await inspect(call.target, call.descriptor);
      f.storage
        .service()
        .cancel(f.storage.principal(), original.identity.jobId);
      return sealed;
    };
    await f.runner().recover();
    expect(f.executor.prepareCalls).toHaveLength(0);
    expect(f.executor.launchCalls).toHaveLength(0);
    expect(job(f, original.identity.jobId)).toMatchObject({
      status: "cancelled",
      reason: "user_cancel",
    });
  });

  it("does not launch after event consumption and replacement creation fail at COMMIT", async () => {
    const f = await fixture();
    const original = await f.claim();
    commitFault(
      f.storage,
      `CREATE TRIGGER recovery_startup_commit AFTER INSERT ON attempts
      WHEN NEW.attempt_no > 1
      BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
    );
    const runner = f.runner();
    await expect(runner.recover()).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(f.executor.prepareCalls).toHaveLength(0);
    expect(f.executor.launchCalls).toHaveLength(0);
    expect(job(f, original.identity.jobId).status).toBe("running");
    expect(
      snapshot(f.storage, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
      ),
    ).toEqual({ count: 1 });
  });

  it.each(["present", "missing"] as const)(
    "leaves authorized terminal execution awaiting artifacts when output is %s",
    async (presence) => {
      const f = await fixture();
      const original = await f.claim("authorized");
      await f.submit("waiting");
      if (presence === "present") {
        await mkdir(original.workingDirectory, { recursive: true });
        await writeFile(
          original.outputPath,
          "controlled candidate bytes are not a verdict",
        );
      }
      f.executor.emit(treeExit(original));
      await f.reopen();
      const runner = f.runner();
      await runner.recover();
      expect(runner.readiness()).toEqual({
        ready: false,
        recoveryState: "awaiting-artifacts",
      });
      expect(job(f, original.identity.jobId)).toMatchObject({
        status: "running",
        reason: null,
        completedAt: null,
      });
      if (presence === "present") await unlink(original.outputPath);
      else {
        await mkdir(original.workingDirectory, { recursive: true });
        await writeFile(
          original.outputPath,
          "late candidate bytes are not a verdict",
        );
      }
      await runner.wake();
      expect(runner.readiness()).toEqual({
        ready: false,
        recoveryState: "awaiting-artifacts",
      });
      expect(f.executor.prepareCalls).toHaveLength(1);
      expect(f.executor.launchCalls).toHaveLength(1);
      expect(job(f, original.identity.jobId).status).toBe("running");
      expect(f.storage.store.claimNext("waiting-owner")).toBeUndefined();
      expect(
        snapshot(f.storage, (db) =>
          db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
        ),
      ).toEqual({ count: 1 });
    },
  );
});
