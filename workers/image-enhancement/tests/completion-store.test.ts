import assert from "node:assert/strict";

import { afterEach, describe, expect, it } from "vitest";

import type { CompletionEvidence, ExecutionExit } from "../src/execution.js";
import {
  completionExit,
  completionFixture,
  completions,
  failures,
  type CompletionFixture,
} from "./completion-fixtures.js";
import { commitFault } from "./lifecycle-fixtures.js";
import { runnerLimits } from "./storage-fixtures.js";

const fixtures: CompletionFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});
async function fixture() {
  const f = await completionFixture();
  fixtures.push(f);
  return f;
}
const failure = failures[0]![1];

describe("completion persistence through the two actual exit consumers", () => {
  it("publishes durable authorization-to-observed-exit timing even for a failed terminal", async () => {
    const f = await fixture();
    await f.submit();
    f.storage.setNow(1_400);
    const attempt = await f.claim("prepared");
    const owner = f.storage.store.getActiveAttempt(attempt.identity)!.ownerDescriptor!;
    expect(f.job(attempt.identity.jobId)).toMatchObject({ timings: { workerQueueMs: 400 } });
    expect(f.job(attempt.identity.jobId)).not.toHaveProperty("timings.workerExecutionMs");
    f.storage.setNow(1_600);
    expect(f.storage.store.authorizeLaunch(attempt.identity, owner)).toBe(true);
    f.storage.setNow(2_100);
    expect(f.job(attempt.identity.jobId)).not.toHaveProperty("timings.workerExecutionMs");
    expect(f.storage.store.registerExit(completionExit(attempt, failure))).toBe(true);
    expect(f.job(attempt.identity.jobId)).toMatchObject({ timings: { workerQueueMs: 400, workerExecutionMs: 500 } });
    expect(f.storage.store.finishFailed(attempt.identity)).toBe(true);
    const failed = f.job(attempt.identity.jobId);
    expect(failed).toMatchObject({ status: "failed", timings: { workerQueueMs: 400, workerExecutionMs: 500 } });
    const rows = f.rows();
    f.storage.setNow(3_000);
    expect(f.job(attempt.identity.jobId)).toEqual(failed);
    expect(f.rows()).toEqual(rows);
    await f.reopen();
    expect(f.job(attempt.identity.jobId)).toEqual(failed);
  });

  it.each(["claimed", "prepared", "authorized"] as const)(
    "leaves execution timing absent without observed exit at %s",
    async (phase) => {
      const f = await fixture();
      const attempt = await f.claim(phase);
      f.storage.setNow(2_000);
      expect(f.job(attempt.identity.jobId)).toMatchObject({ timings: { workerQueueMs: 0 } });
      expect(f.job(attempt.identity.jobId)).not.toHaveProperty("timings.workerExecutionMs");
    },
  );

  it("omits an execution interval whose persisted clock facts run backwards", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    f.storage.setNow(900);
    expect(f.storage.store.registerExit(completionExit(attempt, failure))).toBe(true);
    expect(f.job(attempt.identity.jobId)).toMatchObject({ timings: { workerQueueMs: 0 } });
    expect(f.job(attempt.identity.jobId)).not.toHaveProperty("timings.workerExecutionMs");
  });

  it.each(completions)(
    "callback preserves %s across a store reopen",
    async (_name, completion) => {
      const f = await fixture();
      const attempt = await f.claim();
      const exit = completionExit(attempt, completion);
      expect(f.storage.store.registerExit(exit)).toBe(true);
      expect(f.storage.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
        exit,
      );
      await f.reopen();
      expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
        producer: attempt.identity,
        launchTicket: attempt.launchTicket,
        workingDirectory: attempt.workingDirectory,
        exit,
      });
      expect(f.job(attempt.identity.jobId).status).toBe("running");
      expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
    },
  );

  it.each(completions)(
    "inspection preserves original %s while transferring only publisher",
    async (_name, completion) => {
      const f = await fixture();
      const attempt = await f.claim();
      const exit = completionExit(attempt, completion);
      f.executor.emit(exit);
      await f.reopen();
      const session = f.storage.store.beginRecovery("completion-recovery");
      assert.ok(session);
      const inspection = await f.executor.adapter.inspect(
        session.target,
        session.active.ownerDescriptor,
      );
      const resolution = f.storage.store.applyRecoveryInspection(
        session.control,
        inspection,
      );
      assert.ok(resolution?.kind === "transferred");
      expect(resolution.publisher.fence).toBeGreaterThan(
        attempt.identity.fence,
      );
      expect(
        f.storage.store.getActiveAttempt(resolution.publisher),
      ).toMatchObject({
        producer: attempt.identity,
        launchTicket: attempt.launchTicket,
        workingDirectory: attempt.workingDirectory,
        tile: attempt.tile,
        firstStartedAt: attempt.firstStartedAt,
        executionDeadlineAt: attempt.executionDeadlineAt,
        exit,
      });
      await f.reopen();
      expect(
        f.storage.store.getActiveAttempt(resolution.publisher)?.exit,
      ).toEqual(exit);
    },
  );

  it("keeps a classification-free terminal usable for cancellation without inventing failure", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const exit = completionExit(attempt);
    expect(f.storage.store.registerExit(exit)).toBe(true);
    expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
    expect(f.storage.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
      exit,
    );
    expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    expect(f.storage.store.finishCancelled(attempt.identity)).toBe(true);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "cancelled",
      reason: "user_cancel",
    });
  });

  it.each(completions)(
    "only enriches a pure terminal through same-source %s inspection after reopening",
    async (_name, completion) => {
      const f = await fixture();
      const attempt = await f.claim();
      const terminal = completionExit(attempt);
      expect(f.storage.store.registerExit(terminal)).toBe(true);
      const enriched = completionExit(attempt, completion);
      const before = f.rows();
      expect(f.storage.store.registerExit(enriched)).toBe(false);
      expect(f.rows()).toEqual(before);
      expect(f.storage.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
        terminal,
      );
      f.executor.emit(enriched);
      await f.reopen();
      const session = f.storage.store.beginRecovery("completion-recovery");
      assert.ok(session);
      const inspection = await f.executor.adapter.inspect(
        session.target,
        session.active.ownerDescriptor,
      );
      const resolution = f.storage.store.applyRecoveryInspection(
        session.control,
        inspection,
      );
      assert.ok(resolution?.kind === "transferred");
      expect(
        f.storage.store.getActiveAttempt(resolution.publisher),
      ).toMatchObject({
        producer: attempt.identity,
        launchTicket: attempt.launchTicket,
        workingDirectory: attempt.workingDirectory,
        exit: enriched,
      });
      await f.reopen();
      expect(
        f.storage.store.getActiveAttempt(resolution.publisher)?.exit,
      ).toEqual(enriched);
    },
  );

  it.each(["producer", "ticket", "descriptor"] as const)(
    "rejects a foreign %s while enriching a pure terminal without changing recovery authority",
    async (field) => {
      const f = await fixture();
      const attempt = await f.claim();
      const terminal = completionExit(attempt);
      expect(f.storage.store.registerExit(terminal)).toBe(true);
      const enriched = completionExit(attempt, failure);
      const foreign: ExecutionExit = {
        ...enriched,
        ...(field === "producer"
          ? {
              identity: {
                ...attempt.identity,
                ownerInstanceId: "foreign-completion-producer",
              },
            }
          : {}),
        ...(field === "ticket"
          ? { launchTicket: "foreign-completion-ticket" }
          : {}),
        ...(field === "descriptor"
          ? {
              descriptor: {
                ...enriched.descriptor,
                executionId: "foreign-completion-execution",
              },
            }
          : {}),
      };
      await f.reopen();
      const session = f.storage.store.beginRecovery("completion-recovery");
      assert.ok(session);
      const before = f.rows();
      expect(
        f.storage.store.applyRecoveryInspection(session.control, {
          kind: "tree-exited",
          exit: foreign,
        }),
      ).toBeUndefined();
      expect(f.rows()).toEqual(before);
      expect(f.storage.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
        terminal,
      );
      expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
    },
  );

  it.each(completions)(
    "never changes or downgrades persisted %s completion through either consumer",
    async (_name, completion) => {
      const f = await fixture();
      const attempt = await f.claim();
      const original = completionExit(attempt, completion);
      expect(f.storage.store.registerExit(original)).toBe(true);
      const different: readonly (CompletionEvidence | undefined)[] =
        completion.kind === "success"
          ? [failure, undefined]
          : [
              completions[0]![1],
              completion.exitCode === null
                ? { kind: "failure", exitCode: null, signal: "SIGKILL" }
                : {
                    kind: "failure",
                    exitCode: completion.exitCode + 1,
                    signal: null,
                  },
              completion.exitCode === null ? failures[0]![1] : failures[1]![1],
              undefined,
            ];
      const beforeCallback = f.rows();
      expect(f.storage.store.registerExit(original)).toBe(false);
      expect(f.rows()).toEqual(beforeCallback);
      for (const changed of different) {
        expect(
          f.storage.store.registerExit(completionExit(attempt, changed)),
        ).toBe(false);
        expect(f.rows()).toEqual(beforeCallback);
      }
      await f.reopen();
      const session = f.storage.store.beginRecovery("completion-recovery");
      assert.ok(session);
      const before = f.rows();
      for (const changed of different) {
        expect(
          f.storage.store.applyRecoveryInspection(session.control, {
            kind: "tree-exited",
            exit: completionExit(attempt, changed),
          }),
        ).toBeUndefined();
        expect(f.rows()).toEqual(before);
      }
      expect(f.storage.store.getActiveAttempt(attempt.identity)?.exit).toEqual(
        original,
      );
      expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
      f.executor.emit(original);
      const inspection = await f.executor.adapter.inspect(
        session.target,
        session.active.ownerDescriptor,
      );
      const resolution = f.storage.store.applyRecoveryInspection(
        session.control,
        inspection,
      );
      assert.ok(resolution?.kind === "transferred");
      expect(
        f.storage.store.getActiveAttempt(resolution.publisher)?.exit,
      ).toEqual(original);
    },
  );
});

const malformed: readonly (readonly [string, unknown])[] = [
  ["success with nonzero code", { kind: "success", exitCode: 1, signal: null }],
  ["success with signal", { kind: "success", exitCode: 0, signal: "SIGTERM" }],
  ["failure with zero code", { kind: "failure", exitCode: 0, signal: null }],
  [
    "failure without code or signal",
    { kind: "failure", exitCode: null, signal: null },
  ],
  [
    "failure with both code and signal",
    { kind: "failure", exitCode: 1, signal: "SIGTERM" },
  ],
  [
    "unsafe exit code",
    { kind: "failure", exitCode: Number.MAX_SAFE_INTEGER + 1, signal: null },
  ],
  [
    "unknown completion",
    { kind: "generic-failure", exitCode: 1, signal: null },
  ],
  [
    "extra dropped completion field",
    { kind: "failure", exitCode: 1, signal: null, ignored: undefined },
  ],
];

describe.each(["callback", "inspection"] as const)(
  "%s rejects contradictory completion",
  (consumer) => {
    it.each(malformed)(
      "rejects %s without poisoning the occupied job",
      async (_name, completion) => {
        const f = await fixture();
        const attempt = await f.claim();
        const bad = { ...completionExit(attempt), completion } as ExecutionExit;
        if (consumer === "callback") {
          const before = f.rows();
          expect(f.storage.store.registerExit(bad)).toBe(false);
          expect(f.rows()).toEqual(before);
        } else {
          await f.reopen();
          const session = f.storage.store.beginRecovery("completion-recovery");
          assert.ok(session);
          const before = f.rows();
          expect(
            f.storage.store.applyRecoveryInspection(session.control, {
              kind: "tree-exited",
              exit: bad,
            }),
          ).toBeUndefined();
          expect(f.rows()).toEqual(before);
        }
        expect(f.job(attempt.identity.jobId)).toMatchObject({
          status: "running",
          reason: null,
        });
        expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
      },
    );
  },
);

describe("ordinary failure terminal compare-and-swap", () => {
  it.each(failures)(
    "commits %s and slot release together and replays the same failed job",
    async (_name, completion) => {
      const f = await fixture();
      const attempt = await f.claim();
      const waiting = await f.submit("completion-waiting");
      expect(
        f.storage.store.registerExit(completionExit(attempt, completion)),
      ).toBe(true);
      expect(f.storage.store.finishFailed(attempt.identity)).toBe(true);
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "failed",
        reason: "execution_failed",
        completedAt: 1_000,
      });
      expect(f.rows().slot).toEqual([]);
      await f.reopen();
      f.storage.setReady(false);
      const replay = await f.submit();
      expect(replay).toMatchObject({
        replayed: true,
        job: {
          jobId: attempt.identity.jobId,
          status: "failed",
          reason: "execution_failed",
        },
      });
      expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
      const next = f.storage.store.claimNext("completion-next");
      assert.ok(next);
      expect(next.identity.jobId).toBe(waiting.job.jobId);
      const before = f.rows();
      expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
      expect(
        f.storage.store.registerExit(completionExit(attempt, completion)),
      ).toBe(false);
      expect(f.rows()).toEqual(before);
    },
  );

  it.each([
    "claimed",
    "prepared",
    "authorized-no-exit",
    "terminal-only",
    "success",
  ] as const)("does not infer ordinary failure from %s", async (phase) => {
    const f = await fixture();
    const attempt = await f.claim(
      phase === "claimed" || phase === "prepared" ? phase : "authorized",
    );
    if (phase === "terminal-only" || phase === "success")
      expect(
        f.storage.store.registerExit(
          completionExit(
            attempt,
            phase === "success" ? completions[0]![1] : undefined,
          ),
        ),
      ).toBe(true);
    const before = f.rows();
    expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
    expect(f.rows()).toEqual(before);
    expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
  });

  it.each(["owner", "attempt", "fence", "job"] as const)(
    "rejects a stale %s failure publisher",
    async (field) => {
      const f = await fixture();
      const attempt = await f.claim();
      expect(
        f.storage.store.registerExit(completionExit(attempt, failure)),
      ).toBe(true);
      const wrong = {
        ...attempt.identity,
        ...(field === "owner" ? { ownerInstanceId: "foreign-owner" } : {}),
        ...(field === "attempt"
          ? { attemptNo: attempt.identity.attemptNo + 1 }
          : {}),
        ...(field === "fence" ? { fence: attempt.identity.fence + 1 } : {}),
        ...(field === "job" ? { jobId: "foreign-job" } : {}),
      };
      const before = f.rows();
      expect(f.storage.store.finishFailed(wrong)).toBe(false);
      expect(f.rows()).toEqual(before);
    },
  );

  it.each([-1, 0, 1])(
    "honors the original lease at ordinary failure offset %i",
    async (offset) => {
      const f = await fixture();
      const attempt = await f.claim();
      expect(
        f.storage.store.registerExit(completionExit(attempt, failure)),
      ).toBe(true);
      f.storage.setNow(attempt.leaseExpiresAt + offset);
      expect(f.storage.store.finishFailed(attempt.identity)).toBe(offset <= 0);
      expect(f.job(attempt.identity.jobId).status).toBe(
        offset <= 0 ? "failed" : "running",
      );
      expect(f.rows().slot).toHaveLength(offset <= 0 ? 0 : 1);
    },
  );

  it.each([-1, 0, 1])(
    "honors the first execution deadline at ordinary failure offset %i",
    async (offset) => {
      const f = await fixture();
      f.storage.setRunnerLimits({ ...runnerLimits, executionTimeoutMs: 5_000 });
      const attempt = await f.claim();
      expect(
        f.storage.store.registerExit(completionExit(attempt, failure)),
      ).toBe(true);
      f.storage.setNow(attempt.executionDeadlineAt + offset);
      expect(f.storage.store.finishFailed(attempt.identity)).toBe(offset <= 0);
      expect(f.job(attempt.identity.jobId).status).toBe(
        offset <= 0 ? "failed" : "running",
      );
      expect(f.rows().slot).toHaveLength(offset <= 0 ? 0 : 1);
      if (offset > 0)
        expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
    },
  );

  it.each(["user_cancel", "execution_timeout"] as const)(
    "preserves the earlier %s instead of ordinary failure",
    async (reason) => {
      const f = await fixture();
      f.storage.setRunnerLimits({ ...runnerLimits, executionTimeoutMs: 5_000 });
      const attempt = await f.claim();
      if (reason === "execution_timeout")
        f.storage.setNow(attempt.executionDeadlineAt + 1);
      expect(f.storage.store.requestStop(attempt.identity, reason)).toBe(true);
      expect(
        f.storage.store.registerExit(completionExit(attempt, failure)),
      ).toBe(true);
      expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
      expect(f.storage.store.finishCancelled(attempt.identity)).toBe(true);
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "cancelled",
        reason,
      });
      expect(f.rows().slot).toEqual([]);
    },
  );

  it("does not accept a captured publisher while a recovery control owns inspection", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    expect(f.storage.store.registerExit(completionExit(attempt, failure))).toBe(
      true,
    );
    const control = f.storage.store.beginRecovery("inspection-controller");
    assert.ok(control);
    const before = f.rows();
    expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
    expect(f.rows()).toEqual(before);
  });

  it.each(["job status", "slot delete"] as const)(
    "rolls the failed terminal and slot back on a real COMMIT fault at %s then commits without that fault",
    async (point) => {
      const f = await fixture();
      const attempt = await f.claim();
      expect(
        f.storage.store.registerExit(completionExit(attempt, failure)),
      ).toBe(true);
      commitFault(
        f.storage,
        point === "job status"
          ? `CREATE TRIGGER completion_job_commit AFTER UPDATE OF status ON jobs
         WHEN OLD.status = 'running' AND NEW.status = 'failed'
         BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`
          : `CREATE TRIGGER completion_slot_commit AFTER DELETE ON execution_slot
         BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
      );
      const before = f.rows();
      expect(() => f.storage.store.finishFailed(attempt.identity)).toThrowError(
        expect.objectContaining({ code: "internal_error" }),
      );
      expect(f.rows()).toEqual(before);
      await f.reopen();
      expect(f.rows()).toEqual(before);
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "running",
        completedAt: null,
      });
      expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
      f.removeCommitFault(point);
      expect(f.rows()).toEqual(before);
      expect(f.storage.store.finishFailed(attempt.identity)).toBe(true);
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "failed",
        reason: "execution_failed",
        completedAt: 1_000,
      });
      expect(f.rows().slot).toEqual([]);
      await f.reopen();
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "failed",
        reason: "execution_failed",
      });
      expect(f.rows().slot).toEqual([]);
    },
  );
});
