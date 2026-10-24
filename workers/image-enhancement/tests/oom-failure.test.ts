import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AttemptIdentity,
  ClaimedAttempt,
  CompletionEvidence,
  ExecutionExit,
} from "../src/execution.js";
import { inspectImage } from "../src/image-io.js";
import {
  completionExit,
  completionFixture,
  type CompletionFixture,
} from "./completion-fixtures.js";
import { runnerLimits } from "./storage-fixtures.js";

const oom = {
  kind: "oom",
  exitCode: 7,
  signal: null,
} as const satisfies CompletionEvidence;
const fixtures: CompletionFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});

async function fixture() {
  const f = await completionFixture();
  fixtures.push(f);
  return f;
}

async function start(f: CompletionFixture) {
  const accepted = await f.submit();
  const runner = f.runner();
  await runner.wake();
  const attempt = f.executor.launchCalls[0];
  assert.ok(attempt);
  expect(attempt.identity.jobId).toBe(accepted.job.jobId);
  return { attempt, runner };
}

async function completePng(f: CompletionFixture, attempt: ClaimedAttempt) {
  const png = await f.residualPng(attempt);
  expect(await inspectImage(png, attempt.job.plan.budgets.ai)).toMatchObject({
    format: "png",
    width: attempt.job.engineInput.width * attempt.job.plan.engine.nativeScale,
    height:
      attempt.job.engineInput.height * attempt.job.plan.engine.nativeScale,
    orientation: 1,
  });
  return png;
}

function expectOriginalExit(
  f: CompletionFixture,
  attempt: ClaimedAttempt,
  exit: ExecutionExit,
  publisher: AttemptIdentity = attempt.identity,
) {
  expect(attempt.identity.attemptNo).toBe(1);
  expect(f.rows().attempts).toContainEqual(
    expect.objectContaining({
      job_id: attempt.identity.jobId,
      attempt_no: 1,
      owner_instance_id: publisher.ownerInstanceId,
      fence: publisher.fence,
      producer_identity_json: JSON.stringify(attempt.identity),
      launch_ticket: attempt.launchTicket,
      tile: attempt.tile,
      exit_json: JSON.stringify(exit),
    }),
  );
  expect(f.rows().events).toEqual([]);
  expect(f.rows().candidates).toEqual([]);
  expect(f.rows().references).toEqual([]);
}

function expectNextRunning(
  f: CompletionFixture,
  attempt: ClaimedAttempt,
  nextJobId: string,
) {
  const next = f.executor.launchCalls[1];
  assert.ok(next);
  expect(next.identity.jobId).toBe(nextJobId);
  expect(next.identity.attemptNo).toBe(1);
  expect(f.job(nextJobId).status).toBe("running");
  expect(f.rows().attempts).toHaveLength(2);
  expect(f.rows().slot).toEqual([
    {
      singleton: 1,
      job_id: nextJobId,
      attempt_no: 1,
      fence: next.identity.fence,
    },
  ]);
  expect(f.executor.launchCalls.map((item) => item.identity.jobId)).toEqual([
    attempt.identity.jobId,
    nextJobId,
  ]);
  expect(f.executor.activeCount()).toBe(1);
}

describe("OOM settles as failure without another inference", () => {
  it("commits failed and releases only its slot while retaining the original OOM", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const png = await completePng(f, attempt);
    const waiting = await f.submit("oom-waiting");
    const exit = completionExit(attempt, oom);
    expect(f.storage.store.registerExit(exit)).toBe(true);
    f.executor.emit(exit);

    expect(f.storage.store.finishFailed(attempt.identity)).toBe(true);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "failed",
      reason: "execution_failed",
      completedAt: 1_000,
      result: null,
    });
    expect(f.rows().slot).toEqual([]);
    expect(f.rows().attempts).toHaveLength(1);
    expectOriginalExit(f, attempt, exit);
    expect(f.executor.launchCalls).toHaveLength(1);
    expect(f.executor.activeCount()).toBe(0);
    await f.reopen();
    f.storage.setReady(false);
    const beforeReplay = f.rows();
    expect(await f.submit()).toMatchObject({
      replayed: true,
      job: {
        jobId: attempt.identity.jobId,
        status: "failed",
        reason: "execution_failed",
      },
    });
    expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
    expect(f.storage.store.registerExit(exit)).toBe(false);
    expect(f.rows()).toEqual(beforeReplay);
    const next = f.storage.store.claimNext("oom-next-publisher");
    assert.ok(next);
    expect(next.identity.jobId).toBe(waiting.job.jobId);
    expect(f.rows().slot).toEqual([
      {
        singleton: 1,
        job_id: waiting.job.jobId,
        attempt_no: 1,
        fence: next.identity.fence,
      },
    ]);
    const beforeLateExit = f.rows();
    expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
    expect(f.storage.store.registerExit(exit)).toBe(false);
    expect(f.rows()).toEqual(beforeLateExit);
    expect(f.executor.launchCalls).toHaveLength(1);
    expect(await readFile(attempt.outputPath)).toEqual(png);
  });

  it("finishes a live OOM despite a complete PNG and starts only the next queued job", async () => {
    const f = await fixture();
    const { attempt, runner } = await start(f);
    const png = await completePng(f, attempt);
    const waiting = await f.submit("oom-waiting");
    const exit = completionExit(attempt, oom);
    f.executor.emit(exit);
    await runner.wake();

    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "failed",
      reason: "execution_failed",
      completedAt: 1_000,
      result: null,
    });
    expectOriginalExit(f, attempt, exit);
    expectNextRunning(f, attempt, waiting.job.jobId);
    expect(f.executor.stopCalls).toEqual([]);
    expect(await readFile(attempt.outputPath)).toEqual(png);
    const beforeReplay = f.rows();
    f.executor.emit(exit);
    await runner.wake();
    expect(f.rows()).toEqual(beforeReplay);
    expect(f.executor.launchCalls).toHaveLength(2);
  });

  it("recovers a persisted OOM without rewriting its producer or rerunning that job", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const png = await completePng(f, attempt);
    const waiting = await f.submit("oom-waiting");
    const exit = completionExit(attempt, oom);
    expect(f.storage.store.registerExit(exit)).toBe(true);
    f.executor.emit(exit);
    await f.reopen();
    const runner = f.runner("oom-recovered-publisher");
    await runner.recover();

    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "failed",
      reason: "execution_failed",
      completedAt: 1_000,
      result: null,
    });
    expectOriginalExit(f, attempt, exit, {
      ...attempt.identity,
      ownerInstanceId: "oom-recovered-publisher",
      fence: attempt.identity.fence + 1,
    });
    expect(f.rows().controls).toEqual([
      expect.objectContaining({
        state: "consumed",
        classification: "tree-exited",
      }),
    ]);
    expectNextRunning(f, attempt, waiting.job.jobId);
    expect(f.executor.stopCalls).toEqual([]);
    expect(await readFile(attempt.outputPath)).toEqual(png);
    expect(runner.readiness().ready).toBe(false);
    const beforeReplay = f.rows();
    f.executor.emit(exit);
    await runner.wake();
    expect(f.rows()).toEqual(beforeReplay);
    expect(f.executor.launchCalls).toHaveLength(2);
  });

  it("keeps recovery-control and stale-publisher guards before the current publisher settles OOM", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    await f.submit("oom-waiting");
    const exit = completionExit(attempt, oom);
    expect(f.storage.store.registerExit(exit)).toBe(true);
    f.executor.emit(exit);
    const session = f.storage.store.beginRecovery("oom-inspection-controller");
    assert.ok(session);
    const beforeInspection = f.rows();
    expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
    expect(
      f.storage.store.claimNext("oom-unrelated-publisher"),
    ).toBeUndefined();
    expect(f.rows()).toEqual(beforeInspection);
    const inspection = await f.executor.adapter.inspect(
      session.target,
      session.active.ownerDescriptor,
    );
    const resolution = f.storage.store.applyRecoveryInspection(
      session.control,
      inspection,
    );
    assert.ok(resolution?.kind === "transferred");
    const afterTransfer = f.rows();
    expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
    expect(f.rows()).toEqual(afterTransfer);
    expect(f.storage.store.finishFailed(resolution.publisher)).toBe(true);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "failed",
      reason: "execution_failed",
      result: null,
    });
    expect(f.rows().slot).toEqual([]);
    expect(f.rows().attempts).toHaveLength(1);
    expectOriginalExit(f, attempt, exit, resolution.publisher);
    expect(f.executor.launchCalls).toHaveLength(1);
  });

  it("cannot settle an OOM through an expired original lease", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    await f.submit("oom-waiting");
    const exit = completionExit(attempt, oom);
    expect(f.storage.store.registerExit(exit)).toBe(true);
    f.executor.emit(exit);
    f.storage.setNow(attempt.leaseExpiresAt + 1);
    const before = f.rows();

    expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
    expect(
      f.storage.store.claimNext("oom-unrelated-publisher"),
    ).toBeUndefined();
    expect(f.rows()).toEqual(before);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "running",
      reason: null,
      result: null,
    });
    expect(f.rows().slot).toHaveLength(1);
    expect(f.rows().attempts).toHaveLength(1);
    expectOriginalExit(f, attempt, exit);
    expect(f.executor.launchCalls).toHaveLength(1);
  });

  it("retains the execution deadline before converging through the original timeout path", async () => {
    const f = await fixture();
    f.storage.setRunnerLimits({ ...runnerLimits, executionTimeoutMs: 5_000 });
    const attempt = await f.claim();
    await f.submit("oom-waiting");
    const exit = completionExit(attempt, oom);
    expect(f.storage.store.registerExit(exit)).toBe(true);
    f.executor.emit(exit);
    f.storage.setNow(attempt.executionDeadlineAt + 1);
    const before = f.rows();

    expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
    expect(
      f.storage.store.claimNext("oom-unrelated-publisher"),
    ).toBeUndefined();
    expect(f.rows()).toEqual(before);
    expect(
      f.storage.store.requestStop(attempt.identity, "execution_timeout"),
    ).toBe(true);
    expect(f.storage.store.finishFailed(attempt.identity)).toBe(false);
    expect(f.storage.store.finishCancelled(attempt.identity)).toBe(true);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "cancelled",
      reason: "execution_timeout",
      result: null,
    });
    expect(f.rows().slot).toEqual([]);
    expect(f.rows().attempts).toHaveLength(1);
    expectOriginalExit(f, attempt, exit);
    expect(f.executor.launchCalls).toHaveLength(1);
  });

  it.each(["user_cancel", "execution_timeout"] as const)(
    "runner keeps the earlier %s reason when OOM proves the tree exited",
    async (reason) => {
      const f = await fixture();
      f.storage.setRunnerLimits({ ...runnerLimits, executionTimeoutMs: 5_000 });
      const { attempt, runner } = await start(f);
      const waiting = await f.submit("oom-waiting");
      if (reason === "user_cancel")
        f.storage
          .service()
          .cancel(f.storage.principal(), attempt.identity.jobId);
      else f.time.advanceTo(attempt.executionDeadlineAt + 1);
      await runner.wake();
      expect(f.job(attempt.identity.jobId).status).toBe("running");
      expect(f.storage.store.getActiveAttempt(attempt.identity)).toMatchObject({
        stopReason: reason,
        exit: null,
      });
      const exit = completionExit(attempt, {
        kind: "oom",
        exitCode: null,
        signal: "SIGKILL",
      });
      f.executor.emit(exit);
      await runner.wake();

      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "cancelled",
        reason,
        completedAt: f.storage.clock(),
        result: null,
      });
      expectOriginalExit(f, attempt, exit);
      expectNextRunning(f, attempt, waiting.job.jobId);
      const beforeReplay = f.rows();
      f.executor.emit(exit);
      await runner.wake();
      expect(f.rows()).toEqual(beforeReplay);
      expect(f.executor.launchCalls).toHaveLength(2);
    },
  );
});
