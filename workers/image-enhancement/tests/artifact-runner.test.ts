import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nativePng, writeActualFile } from "./artifact-fixtures.js";
import {
  artifactRunnerFixture,
  nativeResult,
  reachedBeforeRunnerSettled,
  sealedFiles,
  type ArtifactRunnerFixture,
} from "./artifact-runner-fixtures.js";
import { recursiveFiles, runnerLimits, sha256 } from "./storage-fixtures.js";

const fixtures: ArtifactRunnerFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});
async function fixture() {
  const f = await artifactRunnerFixture();
  fixtures.push(f);
  return f;
}
function lastDirectoryGate(f: ArtifactRunnerFixture) {
  return f.gate(
    (event) =>
      event.stage === "directory_sync" && event.path === f.storage.directory,
  );
}
function artifactFacts(f: ArtifactRunnerFixture) {
  const rows = f.rows();
  return {
    candidates: rows.candidates,
    references: rows.references,
    observations: rows.observations,
  };
}

describe("real runner artifact consumers", () => {
  it("publishes a live native PNG with the original completion and consumes its result reference", async () => {
    const f = await fixture();
    const { attempt, runner } = await f.start();
    const gate = lastDirectoryGate(f);
    const { png, exit } = await f.emitSuccess(attempt);
    const pending = f.track(runner.wake());
    await reachedBeforeRunnerSettled(gate, pending);
    const before = f.rows();
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "running",
      result: null,
    });
    expect(before.candidates).toHaveLength(1);
    expect(before.candidates[0]).toMatchObject({
      state: "intent",
      durable_at: null,
    });
    expect(before.references).toHaveLength(1);
    expect(before.references[0]!.released_at).toBeNull();
    const candidate = before.candidates[0]!;
    const sealed = await sealedFiles(f.storage.directory, candidate);
    expect(sealed.png).toEqual(png);
    expect(sealed.manifest.toString("utf8")).toBe(candidate.manifest_json);
    gate.release();
    await pending;
    const result = nativeResult(attempt, png);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "succeeded",
      reason: null,
      completedAt: 1_000,
      result,
      source: attempt.job.source,
      engineInput: attempt.job.engineInput,
      plan: attempt.job.plan,
    });
    expect(f.job(attempt.identity.jobId).result).toEqual(result);
    const after = f.rows();
    expect(after.slot).toEqual([]);
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]).toMatchObject({
      producer_identity_json: JSON.stringify(attempt.identity),
      launch_ticket: attempt.launchTicket,
      exit_json: JSON.stringify(exit),
    });
    expect(after.candidates).toEqual([
      expect.objectContaining({
        candidate_id: candidate.candidate_id,
        state: "durable",
        durable_at: 1_000,
      }),
    ]);
    expect(after.references).toEqual([
      expect.objectContaining({
        candidate_id: candidate.candidate_id,
        purpose: "run",
        released_at: 1_000,
      }),
    ]);
    expect(JSON.parse(candidate.manifest_json)).toEqual({
      producer: {
        identity: attempt.identity,
        launchTicket: attempt.launchTicket,
      },
      planFingerprint: attempt.job.plan.planFingerprint,
      engineInputSha256: attempt.job.engineInput.sha256,
      executionPolicyFingerprint: attempt.executionPolicy.fingerprint,
      tile: attempt.tile,
      png: result,
    });
    expect(sha256(sealed.manifest)).toBe(candidate.manifest_sha256);
    expect(sealed.manifest.length).toBe(candidate.manifest_byte_length);
    expect(await sealedFiles(f.storage.directory, candidate)).toEqual(sealed);
    expect(f.executor.prepareCalls).toHaveLength(1);
    expect(f.executor.authorizeCalls).toHaveLength(1);
    expect(f.executor.activeCount()).toBe(0);
  });

  it("lets success COMMIT before a pending user cancellation at the final directory acknowledgement", async () => {
    const f = await fixture();
    const { attempt, runner } = await f.start();
    const gate = lastDirectoryGate(f);
    const { png } = await f.emitSuccess(attempt);
    const pending = f.track(runner.wake());
    await reachedBeforeRunnerSettled(gate, pending);
    const candidate = f.rows().candidates[0]!;
    const sealed = await sealedFiles(f.storage.directory, candidate);
    const cancellation = f.storage
      .service()
      .cancel(f.storage.principal(), attempt.identity.jobId);
    expect(cancellation).toMatchObject({ applied: true, status: 202 });
    expect(f.storage.store.getActiveAttempt(attempt.identity)?.stopReason).toBe(
      "user_cancel",
    );
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "running",
      result: null,
      cancelRequested: true,
    });
    expect(f.rows().references[0]!.released_at).toBeNull();
    // No extra wake: the final I/O return goes directly to the success CAS.
    gate.release();
    await pending;
    const succeeded = f.job(attempt.identity.jobId);
    expect(succeeded).toMatchObject({
      status: "succeeded",
      reason: null,
      result: nativeResult(attempt, png),
    });
    expect(f.rows().slot).toEqual([]);
    expect(f.rows().references[0]!.released_at).toBe(1_000);
    expect(await sealedFiles(f.storage.directory, candidate)).toEqual(sealed);
    expect(
      f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId),
    ).toEqual({
      status: 200,
      applied: false,
      job: succeeded,
    });
  });

  it("commits cancellation and starts the next slot while the old final directory acknowledgement is held", async () => {
    const f = await fixture();
    const { attempt, runner } = await f.start();
    const waiting = await f.submit("artifact-runner-waiting");
    const gate = lastDirectoryGate(f);
    await f.emitSuccess(attempt);
    const pending = f.track(runner.wake());
    await reachedBeforeRunnerSettled(gate, pending);
    const before = f.rows();
    const candidate = before.candidates[0]!;
    const sealed = await sealedFiles(f.storage.directory, candidate);
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    // This must finish without releasing the old gate or awaiting its promise.
    await f.track(runner.wake());
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "cancelled",
      reason: "user_cancel",
      result: null,
    });
    expect(f.job(waiting.job.jobId).status).toBe("running");
    expect(f.rows().references[0]!.released_at).toBeNull();
    const next = f.executor.launchCalls.find(
      (call) => call.identity.jobId === waiting.job.jobId,
    );
    assert.ok(next);
    const nextPng = await nativePng(next);
    await writeActualFile(next.outputPath, nextPng);
    const nextFacts = f.sourceFacts(next.identity.jobId);
    const slot = f.rows().slot;
    expect(slot).toEqual([
      expect.objectContaining({
        job_id: next.identity.jobId,
        attempt_no: next.identity.attemptNo,
        fence: next.identity.fence,
      }),
    ]);
    gate.release();
    await pending;
    expect(f.rows().slot).toEqual(slot);
    expect(f.sourceFacts(next.identity.jobId)).toEqual(nextFacts);
    expect(await readFile(next.outputPath)).toEqual(nextPng);
    expect(await sealedFiles(f.storage.directory, candidate)).toEqual(sealed);
    expect(f.rows().references[0]!.released_at).toBe(1_000);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "cancelled",
      result: null,
    });
    expect(f.executor.launchCalls.map((call) => call.identity.jobId)).toEqual([
      attempt.identity.jobId,
      next.identity.jobId,
    ]);
    expect(f.executor.stopCalls).toEqual([]);
    expect(f.executor.activeCount()).toBe(1);
  });

  it("closes a real late-open handle after close without querying the closed store or releasing its unknown reference", async () => {
    const f = await fixture();
    const { attempt, runner } = await f.start();
    const gate = f.gate(
      (event) =>
        event.stage === "open" &&
        event.path === attempt.inputPath &&
        event.flags === "r",
    );
    await f.emitSuccess(attempt);
    const pending = f.track(runner.wake());
    const opened = await reachedBeforeRunnerSettled(gate, pending);
    assert.ok(opened.file);
    const probes = [
      vi.spyOn(f.storage.store, "getActiveAttempt"),
      vi.spyOn(f.storage.store, "readArtifactWork"),
      vi.spyOn(f.storage.store, "recordArtifactObservation"),
      vi.spyOn(f.storage.store, "finishSucceeded"),
      vi.spyOn(f.storage.store, "releaseArtifactReference"),
      vi.spyOn(f.storage.store, "claimNext"),
    ];
    await runner.close();
    f.storage.store.close();
    const calls = probes.map((probe) => probe.mock.calls.length);
    const rows = f.rows();
    expect(rows.references).toHaveLength(1);
    expect(rows.references[0]!.released_at).toBeNull();
    const afterOpen = f.events.length;
    gate.release();
    await pending;
    expect(probes.map((probe) => probe.mock.calls.length)).toEqual(calls);
    expect(f.rows()).toEqual(rows);
    expect(
      f.events.slice(afterOpen).map(({ phase, event }) => [phase, event.stage]),
    ).toEqual([
      ["before", "close"],
      ["after", "close"],
    ]);
    await expect(opened.file.stat()).rejects.toBeInstanceOf(Error);
    expect(f.executor.prepareCalls).toHaveLength(1);
    expect(f.executor.authorizeCalls).toHaveLength(1);
    expect(f.time.pending()).toEqual([]);
  });

  it("keeps an old late-open continuation fenced after a real recovery control transfers to a new publisher", async () => {
    const f = await fixture();
    const { attempt, runner } = await f.start();
    const oldGate = f.gate(
      (event) =>
        event.stage === "open" &&
        event.path === attempt.inputPath &&
        event.flags === "r",
    );
    const { png } = await f.emitSuccess(attempt);
    const oldPending = f.track(runner.wake());
    const oldOpen = await reachedBeforeRunnerSettled(oldGate, oldPending);
    assert.ok(oldOpen.file);
    const original = f.sourceFacts(attempt.identity.jobId);
    const nextGate = lastDirectoryGate(f);
    const recovery = f.runner("artifact-control-successor");
    const recovered = f.track(recovery.recover());
    await reachedBeforeRunnerSettled(nextGate, recovered);
    const beforeOldReturn = f.rows();
    expect(beforeOldReturn.references).toHaveLength(2);
    const successorRef = beforeOldReturn.references.find(
      (ref) => ref.purpose === "recovery",
    );
    assert.ok(successorRef);
    const publisher = JSON.parse(successorRef.publisher_identity_json);
    expect(publisher).toEqual({
      ...attempt.identity,
      ownerInstanceId: "artifact-control-successor",
      fence: attempt.identity.fence + 1,
    });
    expect(beforeOldReturn.slot).toEqual([
      expect.objectContaining({ fence: publisher.fence }),
    ]);
    const candidate = beforeOldReturn.candidates[0]!;
    const sealed = await sealedFiles(f.storage.directory, candidate);
    const beforeOldClose = f.events.length;
    oldGate.release();
    await oldPending;
    expect(f.rows()).toEqual(beforeOldReturn);
    expect(
      f.events
        .slice(beforeOldClose)
        .map(({ phase, event }) => [phase, event.stage]),
    ).toEqual([
      ["before", "close"],
      ["after", "close"],
    ]);
    expect(f.sourceFacts(attempt.identity.jobId)).toEqual(original);
    expect(await sealedFiles(f.storage.directory, candidate)).toEqual(sealed);
    await expect(oldOpen.file.stat()).rejects.toBeInstanceOf(Error);
    nextGate.release();
    await recovered;
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "succeeded",
      result: nativeResult(attempt, png),
    });
    expect(f.rows().references).toEqual([
      expect.objectContaining({ purpose: "run", released_at: null }),
      expect.objectContaining({ purpose: "recovery", released_at: 1_000 }),
    ]);
    expect(f.executor.prepareCalls).toHaveLength(1);
    expect(f.executor.authorizeCalls).toHaveLength(1);
    expect(f.rows().attempts).toHaveLength(1);
  });

  it.each([-1, 0, 1])(
    "uses the original lease boundary at offset %i while the final directory acknowledgement is held",
    async (offset) => {
      const f = await fixture();
      const acquire = vi.spyOn(f.storage.store, "acquireArtifactWork");
      const { attempt, runner } = await f.start();
      const gate = lastDirectoryGate(f);
      const { png } = await f.emitSuccess(attempt);
      const pending = f.track(runner.wake());
      await reachedBeforeRunnerSettled(gate, pending);
      const candidate = f.rows().candidates[0]!;
      const sealed = await sealedFiles(f.storage.directory, candidate);
      const beforeAtBoundary = artifactFacts(f);
      const at = attempt.leaseExpiresAt + offset;
      expect(at).toBeLessThan(attempt.executionDeadlineAt);
      // Advance the shared Clock without delivering its queued timer, as a delayed
      // event loop would. Calling wake here would legitimately renew the lease.
      f.storage.setNow(at);
      expect(f.time.clock.now()).toBe(at);
      expect(
        f.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
      ).toBe(attempt.leaseExpiresAt);
      gate.release();
      await pending;
      if (offset <= 0) {
        expect(f.job(attempt.identity.jobId)).toMatchObject({
          status: "succeeded",
          completedAt: at,
          result: nativeResult(attempt, png),
        });
        expect(f.rows().slot).toEqual([]);
        expect(f.rows().references[0]!.released_at).toBe(at);
      } else {
        expect(f.job(attempt.identity.jobId)).toMatchObject({
          status: "running",
          result: null,
          completedAt: null,
        });
        expect(f.rows().candidates[0]!.state).toBe("intent");
        expect(f.rows().references[0]!.released_at).toBeNull();
        expect(artifactFacts(f)).toEqual(beforeAtBoundary);
        const facts = artifactFacts(f);
        const names = (await recursiveFiles(attempt.workingDirectory)).sort();
        const roots = (
          await readdir(join(attempt.workingDirectory, "artifacts"))
        ).sort();
        expect(roots).toEqual([candidate.candidate_id]);
        await f.track(runner.wake());
        await f.track(runner.recover());
        await f.track(runner.wake());
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(artifactFacts(f)).toEqual(facts);
        expect((await recursiveFiles(attempt.workingDirectory)).sort()).toEqual(
          names,
        );
        expect(
          (await readdir(join(attempt.workingDirectory, "artifacts"))).sort(),
        ).toEqual(roots);
        expect(
          f.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
        ).toBe(attempt.leaseExpiresAt);
      }
      expect(await sealedFiles(f.storage.directory, candidate)).toEqual(sealed);
      expect(f.executor.prepareCalls).toHaveLength(1);
    },
  );

  it.each([-1, 0, 1])(
    "uses the first execution deadline at offset %i without an earlier lease expiry",
    async (offset) => {
      const f = await fixture();
      f.storage.setRunnerLimits({ ...runnerLimits, executionTimeoutMs: 5_000 });
      const { attempt, runner } = await f.start();
      const gate = lastDirectoryGate(f);
      const { png } = await f.emitSuccess(attempt);
      const pending = f.track(runner.wake());
      await reachedBeforeRunnerSettled(gate, pending);
      const original = f.sourceFacts(attempt.identity.jobId);
      const at = attempt.executionDeadlineAt + offset;
      expect(at).toBeLessThan(attempt.leaseExpiresAt);
      f.storage.setNow(at);
      expect(f.time.clock.now()).toBe(at);
      gate.release();
      await pending;
      if (offset <= 0) {
        expect(f.job(attempt.identity.jobId)).toMatchObject({
          status: "succeeded",
          completedAt: at,
          result: nativeResult(attempt, png),
        });
      } else {
        expect(f.job(attempt.identity.jobId).status).not.toBe("succeeded");
        await f.track(runner.wake());
        expect(f.job(attempt.identity.jobId)).toMatchObject({
          status: "cancelled",
          reason: "execution_timeout",
          result: null,
        });
      }
      expect(f.rows().slot).toEqual([]);
      expect(f.sourceFacts(attempt.identity.jobId)).toEqual(original);
      expect(f.executor.prepareCalls).toHaveLength(1);
      expect(f.executor.authorizeCalls).toHaveLength(1);
    },
  );

  it.each(["user_cancel", "execution_timeout"] as const)(
    "keeps a resolved blocked artifact chain cached across ordinary, timer and repeated recovery wakes before %s",
    async (convergence) => {
      const f = await fixture();
      const acquire = vi.spyOn(f.storage.store, "acquireArtifactWork");
      const reserve = vi.spyOn(f.storage.store, "reserveArtifactCandidate");
      const { attempt, runner } = await f.start();
      const gate = f.gate(
        (event) =>
          event.stage === "mkdir" && event.role === "candidate-directory",
      );
      const gatedAfter = f.hooks.after;
      let injected = false;
      f.hooks.after = async (event) => {
        await gatedAfter?.(event);
        if (
          !injected &&
          event.stage === "mkdir" &&
          event.role === "candidate-directory"
        ) {
          injected = true;
          throw Object.assign(
            new Error("controlled mkdir acknowledgement unavailable"),
            { code: "EIO" },
          );
        }
      };
      await f.emitSuccess(attempt);
      const pending = f.track(runner.wake());
      await reachedBeforeRunnerSettled(gate, pending);
      expect(f.rows().candidates).toHaveLength(1);
      gate.release();
      await pending;
      expect(injected).toBe(true);
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "running",
        result: null,
      });
      expect(f.rows().observations).toContainEqual(
        expect.objectContaining({ code: "io_failure", stage: "mkdir" }),
      );
      f.hooks.after = gatedAfter;
      const facts = artifactFacts(f);
      const names = (await recursiveFiles(attempt.workingDirectory)).sort();
      const roots = (
        await readdir(join(attempt.workingDirectory, "artifacts"))
      ).sort();
      expect(roots).toEqual([facts.candidates[0]!.candidate_id]);
      const mkdirEvents = f.events.filter(
        ({ phase, event }) => phase === "after" && event.stage === "mkdir",
      );
      await f.track(runner.wake());
      await f.track(runner.recover());
      await f.track(runner.recover());
      const heartbeat = f.time.pending()[0];
      assert.ok(heartbeat);
      f.time.advanceTo(heartbeat.at);
      await f.track(runner.wake());
      expect(
        f.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
      ).toBeGreaterThan(attempt.leaseExpiresAt);
      expect(
        f.storage.store.getActiveAttempt(attempt.identity)?.executionDeadlineAt,
      ).toBe(attempt.executionDeadlineAt);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(artifactFacts(f)).toEqual(facts);
      expect((await recursiveFiles(attempt.workingDirectory)).sort()).toEqual(
        names,
      );
      expect(
        (await readdir(join(attempt.workingDirectory, "artifacts"))).sort(),
      ).toEqual(roots);
      expect(
        f.events.filter(
          ({ phase, event }) => phase === "after" && event.stage === "mkdir",
        ),
      ).toEqual(mkdirEvents);
      if (convergence === "user_cancel")
        f.storage
          .service()
          .cancel(f.storage.principal(), attempt.identity.jobId);
      else f.time.advanceTo(attempt.executionDeadlineAt + 1);
      await f.track(runner.wake());
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "cancelled",
        reason: convergence,
        result: null,
      });
      expect(f.rows().slot).toEqual([]);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect((await recursiveFiles(attempt.workingDirectory)).sort()).toEqual(
        names,
      );
      expect(
        (await readdir(join(attempt.workingDirectory, "artifacts"))).sort(),
      ).toEqual(roots);
      expect(f.executor.launchCalls).toHaveLength(1);
    },
  );

  it("recovers a complete intent through the real runner after reopen without preparing or executing again", async () => {
    const f = await fixture();
    const { attempt, runner } = await f.start();
    const originalGate = lastDirectoryGate(f);
    const { png } = await f.emitSuccess(attempt);
    const oldPending = f.track(runner.wake());
    await reachedBeforeRunnerSettled(originalGate, oldPending);
    const candidate = f.rows().candidates[0]!;
    const files = await sealedFiles(f.storage.directory, candidate);
    const original = f.sourceFacts(attempt.identity.jobId);
    await f.reopen();
    originalGate.release();
    await oldPending;
    const readGate = f.gate(
      (event) =>
        event.stage === "read" &&
        event.path ===
          join(
            f.storage.directory,
            "attempts",
            candidate.directory,
            "artifact.png",
          ) &&
        (event.bytesRead ?? 0) > 0,
    );
    const recovery = f.runner("artifact-reopened-runner");
    const recoveryEvents = f.events.length;
    const pending = f.track(recovery.recover());
    await reachedBeforeRunnerSettled(readGate, pending);
    expect(f.rows().candidates).toEqual([candidate]);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "running",
      result: null,
    });
    readGate.release();
    await pending;
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "succeeded",
      result: nativeResult(attempt, png),
    });
    expect(f.rows().candidates).toEqual([
      expect.objectContaining({
        candidate_id: candidate.candidate_id,
        directory: candidate.directory,
        state: "durable",
      }),
    ]);
    expect(f.rows().slot).toEqual([]);
    expect(f.rows().references).toEqual([
      expect.objectContaining({ purpose: "run", released_at: null }),
      expect.objectContaining({ purpose: "recovery", released_at: 1_000 }),
    ]);
    expect(f.sourceFacts(attempt.identity.jobId)).toEqual(original);
    expect(await sealedFiles(f.storage.directory, candidate)).toEqual(files);
    expect(
      f.events
        .slice(recoveryEvents)
        .filter(
          ({ event }) => event.stage === "write" || event.stage === "rename",
        ),
    ).toEqual([]);
    expect(f.executor.prepareCalls).toHaveLength(1);
    expect(f.executor.authorizeCalls).toHaveLength(1);
    expect(f.executor.launchCalls).toHaveLength(1);
  });

  it("advances the next slot from persisted success when published revalidation returns blocked", async () => {
    const f = await fixture();
    const { attempt, runner } = await f.start();
    const waiting = await f.submit("artifact-published-waiting");
    const finish = f.storage.store.finishSucceeded.bind(f.storage.store);
    let committed = false;
    vi.spyOn(f.storage.store, "finishSucceeded").mockImplementation(
      (...args) => {
        const applied = finish(...args);
        if (applied && !committed) {
          committed = true;
          throw new Error(
            "controlled success acknowledgement unavailable after COMMIT",
          );
        }
        return applied;
      },
    );
    const gate = f.gate(
      (event) =>
        committed && event.stage === "stat" && event.role === "candidate-png",
    );
    const gatedAfter = f.hooks.after;
    let injected = false;
    f.hooks.after = async (event) => {
      await gatedAfter?.(event);
      if (
        committed &&
        !injected &&
        event.stage === "stat" &&
        event.role === "candidate-png"
      ) {
        injected = true;
        throw Object.assign(
          new Error("controlled published stat acknowledgement unavailable"),
          { code: "EIO" },
        );
      }
    };
    const { png } = await f.emitSuccess(attempt);
    const pending = f.track(runner.wake());
    await reachedBeforeRunnerSettled(gate, pending);
    expect(committed).toBe(true);
    const succeeded = f.job(attempt.identity.jobId);
    expect(succeeded).toMatchObject({
      status: "succeeded",
      result: nativeResult(attempt, png),
    });
    expect(f.job(waiting.job.jobId).status).toBe("queued");
    expect(f.rows().references).toEqual([
      expect.objectContaining({ purpose: "run", released_at: 1_000 }),
      expect.objectContaining({ purpose: "recovery", released_at: null }),
    ]);
    const candidate = f.rows().candidates[0]!;
    const files = await sealedFiles(f.storage.directory, candidate);
    gate.release();
    await pending;
    expect(injected).toBe(true);
    expect(f.job(attempt.identity.jobId)).toEqual(succeeded);
    expect(f.job(waiting.job.jobId).status).toBe("running");
    expect(f.rows().slot).toEqual([
      expect.objectContaining({ job_id: waiting.job.jobId }),
    ]);
    expect(f.rows().observations).toContainEqual(
      expect.objectContaining({ code: "io_failure", stage: "stat" }),
    );
    expect(f.rows().references).toEqual([
      expect.objectContaining({ purpose: "run", released_at: 1_000 }),
      expect.objectContaining({ purpose: "recovery", released_at: 1_000 }),
    ]);
    expect(await sealedFiles(f.storage.directory, candidate)).toEqual(files);
    expect(f.executor.launchCalls.map((call) => call.identity.jobId)).toEqual([
      attempt.identity.jobId,
      waiting.job.jobId,
    ]);
    expect(f.executor.activeCount()).toBe(1);
  });
});
