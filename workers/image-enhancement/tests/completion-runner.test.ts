import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ClaimedAttempt } from "../src/execution.js";
import { inspectImage } from "../src/image-io.js";
import type { createRunner } from "../src/runner.js";
import {
  completionExit,
  completionFixture,
  completions,
  failures,
  type CompletionFixture,
} from "./completion-fixtures.js";
import { runnerLimits, sha256 } from "./storage-fixtures.js";

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

describe("runner consumes ordinary completion through durable exit facts", () => {
  it.each(failures)(
    "finishes live %s despite a complete PNG and advances only the next durable slot",
    async (_name, completion) => {
      const f = await fixture();
      const { attempt, runner } = await start(f);
      const png = await f.residualPng(attempt);
      const actual = await inspectImage(png, attempt.job.plan.budgets.ai);
      expect(actual).toMatchObject({
        format: "png",
        width: attempt.job.engineInput.width * 4,
        height: attempt.job.engineInput.height * 4,
        orientation: 1,
      });
      const waiting = await f.submit("completion-waiting");
      f.executor.emit(completionExit(attempt, completion));
      await runner.wake();
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "failed",
        reason: "execution_failed",
        completedAt: 1_000,
      });
      expect(f.job(waiting.job.jobId).status).toBe("running");
      expect(f.rows().slot).toEqual([
        expect.objectContaining({ job_id: waiting.job.jobId }),
      ]);
      expect(f.rows().events).toEqual([]);
      expect(f.executor.launchCalls.map((item) => item.identity.jobId)).toEqual(
        [attempt.identity.jobId, waiting.job.jobId],
      );
      expect(f.executor.activeCount()).toBe(1);
      expect(await readFile(attempt.outputPath)).toEqual(png);
      const before = f.rows();
      f.executor.emit(completionExit(attempt, completion));
      await runner.wake();
      expect(f.rows()).toEqual(before);
    },
  );

  it.each(failures)(
    "recovers original %s without computing that job again",
    async (_name, completion) => {
      const f = await fixture();
      const attempt = await f.claim();
      const png = await f.residualPng(attempt);
      const waiting = await f.submit("completion-waiting");
      f.executor.emit(completionExit(attempt, completion));
      await f.reopen();
      const runner = f.runner("completion-recovery");
      await runner.recover();
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "failed",
        reason: "execution_failed",
      });
      expect(f.rows().slot).toEqual([
        expect.objectContaining({ job_id: waiting.job.jobId }),
      ]);
      expect(f.rows().events).toEqual([]);
      expect(
        f.executor.launchCalls.filter(
          (item) => item.identity.jobId === attempt.identity.jobId,
        ),
      ).toHaveLength(1);
      expect(f.executor.activeCount()).toBe(1);
      expect(await readFile(attempt.outputPath)).toEqual(png);
      expect(runner.readiness().ready).toBe(false);
    },
  );

  it("recovers an already persisted failure through an identical classification", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const exit = completionExit(attempt, failures[0]![1]);
    expect(f.storage.store.registerExit(exit)).toBe(true);
    f.executor.emit(exit);
    await f.reopen();
    const runner = f.runner("completion-recovery");
    await runner.recover();
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "failed",
      reason: "execution_failed",
    });
    expect(f.rows().slot).toEqual([]);
    expect(f.rows().events).toEqual([]);
    expect(f.executor.launchCalls).toHaveLength(1);
  });

  it.each(["live", "recovered"] as const)(
    "retains an unclassified %s terminal until cancellation can converge",
    async (mode) => {
      const f = await fixture();
      let attempt: ClaimedAttempt;
      let runner: ReturnType<typeof createRunner>;
      if (mode === "live") {
        ({ attempt, runner } = await start(f));
        f.executor.emit(completionExit(attempt));
        await runner.wake();
      } else {
        attempt = await f.claim();
        f.executor.emit(completionExit(attempt));
        await f.reopen();
        runner = f.runner("completion-recovery");
        await runner.recover();
      }
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "running",
        reason: null,
      });
      expect(f.rows().slot).toHaveLength(1);
      expect(f.rows().events).toEqual([]);
      expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
      f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
      await runner.wake();
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "cancelled",
        reason: "user_cancel",
      });
      expect(f.rows().slot).toEqual([]);
      expect(f.executor.launchCalls).toHaveLength(1);
    },
  );

  it("does not classify an ambiguous authorization rejection as ordinary execution failure", async () => {
    const f = await fixture();
    const accepted = await f.submit();
    f.executor.hooks.authorize = async () => {
      throw new Error("controlled authorization acknowledgement unavailable");
    };
    const runner = f.runner();
    await expect(runner.wake()).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(f.job(accepted.job.jobId)).toMatchObject({
      status: "running",
      reason: null,
    });
    expect(f.rows().slot).toHaveLength(1);
    expect(f.rows().events).toEqual([]);
    expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
    expect(f.executor.launchCalls).toHaveLength(0);
    await runner.wake();
    expect(f.executor.authorizeCalls).toHaveLength(1);
  });

  it("publishes a qualified success through the real artifact chain", async () => {
    const f = await fixture();
    const { attempt, runner } = await start(f);
    const png = await f.residualPng(attempt);
    const exit = completionExit(attempt, completions[0]![1]);
    f.executor.emit(exit);
    await runner.wake();
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "succeeded",
      reason: null,
      completedAt: 1_000,
      result: {
        format: "png",
        width:
          attempt.job.engineInput.width * attempt.job.plan.engine.nativeScale,
        height:
          attempt.job.engineInput.height * attempt.job.plan.engine.nativeScale,
        sha256: sha256(png),
        byteLength: png.length,
      },
    });
    const rows = f.rows();
    expect(rows.slot).toEqual([]);
    expect(f.storage.store.getActiveAttempt(attempt.identity)).toBeUndefined();
    expect(rows.attempts).toHaveLength(1);
    expect(rows.attempts[0]).toMatchObject({
      producer_identity_json: JSON.stringify(attempt.identity),
      launch_ticket: attempt.launchTicket,
      exit_json: JSON.stringify(exit),
    });
    expect(rows.candidates).toHaveLength(1);
    const candidate = rows.candidates[0]!;
    expect(candidate).toMatchObject({ state: "durable", durable_at: 1_000 });
    const directory = join(
      f.storage.directory,
      "attempts",
      candidate.directory,
    );
    expect(await readFile(join(directory, "artifact.png"))).toEqual(png);
    const manifest = await readFile(join(directory, "manifest.json"));
    expect(manifest.toString("utf8")).toBe(candidate.manifest_json);
    expect(manifest.length).toBe(candidate.manifest_byte_length);
    expect(sha256(manifest)).toBe(candidate.manifest_sha256);
    expect(JSON.parse(candidate.manifest_json)).toEqual({
      producer: {
        identity: attempt.identity,
        launchTicket: attempt.launchTicket,
      },
      planFingerprint: attempt.job.plan.planFingerprint,
      engineInputSha256: attempt.job.engineInput.sha256,
      executionPolicyFingerprint: attempt.executionPolicy.fingerprint,
      tile: attempt.tile,
      png: f.job(attempt.identity.jobId).result,
    });
    expect(rows.references).toEqual([
      expect.objectContaining({
        candidate_id: candidate.candidate_id,
        purpose: "run",
        released_at: 1_000,
      }),
    ]);
    expect(rows.events).toEqual([]);
    expect(f.executor.launchCalls).toHaveLength(1);
  });

  it("ignores a mismatched failure source without poisoning the current job", async () => {
    const f = await fixture();
    const { attempt, runner } = await start(f);
    const before = f.rows();
    const bad = completionExit(attempt, failures[0]![1]);
    f.executor.emit({
      ...bad,
      identity: { ...attempt.identity, fence: attempt.identity.fence + 1 },
    });
    await runner.wake();
    expect(f.rows()).toEqual(before);
    expect(f.job(attempt.identity.jobId).status).toBe("running");
    expect(f.executor.activeCount()).toBe(1);
  });

  it("rejects an otherwise valid failure callback after its original lease expired", async () => {
    const f = await fixture();
    const { attempt, runner } = await start(f);
    const before = f.rows();
    f.storage.setNow(attempt.leaseExpiresAt + 1);
    f.executor.emit(completionExit(attempt, failures[0]![1]));
    await runner.wake();
    expect(f.rows()).toEqual(before);
    expect(f.job(attempt.identity.jobId).status).toBe("running");
    expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
  });

  it("a failure callback queued before close cannot perform late database writes", async () => {
    const f = await fixture();
    const { attempt, runner } = await start(f);
    const observer = f.executor.observers[0];
    assert.ok(observer);
    const before = f.rows();
    await runner.close();
    observer.listener(completionExit(attempt, failures[0]![1]));
    expect(f.rows()).toEqual(before);
    expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
  });

  it.each(["user_cancel", "execution_timeout"] as const)(
    "ordinary failure never replaces the earlier %s convergence",
    async (reason) => {
      const f = await fixture();
      f.storage.setRunnerLimits({ ...runnerLimits, executionTimeoutMs: 5_000 });
      const { attempt, runner } = await start(f);
      if (reason === "user_cancel")
        f.storage
          .service()
          .cancel(f.storage.principal(), attempt.identity.jobId);
      else f.time.advanceTo(attempt.executionDeadlineAt + 1);
      await runner.wake();
      expect(f.job(attempt.identity.jobId).status).toBe("running");
      f.executor.emit(completionExit(attempt, failures[0]![1]));
      await runner.wake();
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "cancelled",
        reason,
      });
      expect(f.rows().slot).toEqual([]);
      expect(f.rows().events).toEqual([]);
    },
  );
});
