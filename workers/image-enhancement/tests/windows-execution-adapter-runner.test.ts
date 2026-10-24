import assert from "node:assert/strict";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaimedAttempt, ExecutionExit } from "../src/execution.js";
import { createRunner } from "../src/runner.js";
import { openStore } from "../src/store.js";
import type { createWindowsControlBridgeHost } from "../src/windows-control-bridge-host.js";
import {
  createWindowsExecutionAdapter,
  type WindowsExecutionAdapter,
} from "../src/windows-execution-adapter.js";
import type { createWindowsJournalLauncher } from "../src/windows-journal-launcher.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import {
  nativePng,
  writeActualFile,
  type ArtifactCandidateRow,
  type ArtifactReferenceRow,
} from "./artifact-fixtures.js";
import { nativeResult, sealedFiles } from "./artifact-runner-fixtures.js";
import { manualClock, snapshot } from "./lifecycle-fixtures.js";
import { sourceImage, storageFixture, submission } from "./storage-fixtures.js";
import {
  runnerAdapterOptions,
  runnerNativePorts,
} from "./windows-execution-adapter-runner-fixtures.js";

const factories = vi.hoisted(() => ({
  host: vi.fn<typeof createWindowsControlBridgeHost>(),
  journal: vi.fn<typeof createWindowsJournalLauncher>(),
}));
vi.mock("../src/windows-control-bridge-host.js", () => ({
  createWindowsControlBridgeHost: factories.host,
}));
vi.mock("../src/windows-journal-launcher.js", () => ({
  createWindowsJournalLauncher: factories.journal,
}));

type StoreFixture = Awaited<ReturnType<typeof storageFixture>>;
type AttemptRow = {
  job_id: string;
  attempt_no: number;
  owner_instance_id: string;
  fence: number;
  producer_identity_json: string;
  producer_incarnation_id: string;
  launch_ticket: string;
  owner_descriptor_json: string | null;
  authorized_at: number | null;
  stop_reason: "user_cancel" | "execution_timeout" | null;
  stop_requested_at: number | null;
  terminate_after_at: number | null;
  exit_json: string | null;
};

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  factories.host.mockReset().mockImplementation(() => {
    throw new Error("unexpected test Host allocation");
  });
  factories.journal.mockReset().mockImplementation(() => {
    throw new Error("unexpected test journal allocation");
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function constructAdapter(): WindowsExecutionAdapter {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  try {
    // Only synchronous Windows configuration validation uses this value. Every
    // real Store, fsync, runner and artifact operation runs on the native OS.
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    return createWindowsExecutionAdapter(runnerAdapterOptions);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

function rows(storage: StoreFixture) {
  return snapshot(storage, (db) => ({
    attempts: db
      .prepare("SELECT * FROM attempts ORDER BY attempt_no")
      .all() as AttemptRow[],
    jobs: db
      .prepare(
        "SELECT first_started_at, execution_deadline_at, active_attempt_no FROM jobs ORDER BY queue_sequence",
      )
      .all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
    controls: db
      .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
      .all(),
    events: db.prepare("SELECT * FROM recovery_events ORDER BY rowid").all(),
    candidates: db
      .prepare("SELECT * FROM artifact_candidates ORDER BY rowid")
      .all() as ArtifactCandidateRow[],
    references: db
      .prepare("SELECT * FROM artifact_references ORDER BY rowid")
      .all() as ArtifactReferenceRow[],
  }));
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function fixture() {
  const native = runnerNativePorts();
  const journals: ReturnType<typeof native.journal>[] = [];
  factories.host.mockImplementation(() => native.host);
  factories.journal.mockImplementation(() => {
    const journal = native.journal();
    journals.push(journal);
    return journal.reader;
  });
  const adapter = constructAdapter();
  assert.equal(process.platform, "linux");
  const storage = await storageFixture();
  const time = manualClock(storage);
  const owners: {
    adapter: WindowsExecutionAdapter;
    runner: ReturnType<typeof createRunner>;
  }[] = [];
  const pending: Promise<void>[] = [];
  let original: ClaimedAttempt | undefined;
  const track = (promise: Promise<void>) => {
    pending.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  native.hooks.prepare = (target) => {
    const active = storage.store.getActiveAttempt(target.identity);
    assert.ok(active);
    assert.equal(active.ownerDescriptor, null);
    assert.equal(active.authorizedAt, null);
    original = active;
    const committed = rows(storage).attempts[0];
    assert.ok(committed);
    assert.equal(committed.authorized_at, null);
  };
  native.hooks.authorize = (target, descriptor) => {
    assert.ok(original);
    assert.deepEqual(native.request, freezeWindowsPrepareRequest(original));
    const active = storage.store.getActiveAttempt(target.identity);
    assert.ok(active);
    assert.deepEqual(active.ownerDescriptor, descriptor);
    assert.equal(active.authorizedAt, storage.clock());
    const committed = rows(storage).attempts[0];
    assert.ok(committed);
    assert.equal(committed.authorized_at, storage.clock());
    assert.equal(committed.owner_descriptor_json, JSON.stringify(descriptor));
  };
  function owner(executor: WindowsExecutionAdapter, ownerInstanceId: string) {
    const runner = createRunner({
      store: storage.store,
      clock: time.clock,
      executor,
      ownerInstanceId,
    });
    const value = { adapter: executor, runner };
    owners.push(value);
    return value;
  }
  const live = owner(adapter, "windows-adapter-original-producer");
  async function closeOwner(value: (typeof owners)[number]) {
    await value.runner.close();
    const cleanup = await value.adapter.close();
    return cleanup;
  }
  cleanups.push(async () => {
    try {
      for (const value of [...owners].reverse()) await closeOwner(value);
    } finally {
      native.release();
      await Promise.allSettled(pending);
      await storage.cleanup();
    }
  });
  return {
    storage,
    time,
    native,
    journals,
    live,
    track,
    closeOwner,
    get attempt() {
      assert.ok(original, "the real Adapter must prepare the claimed attempt");
      return original;
    },
    job(jobId: string) {
      return storage.store.getOwned(storage.principal(), jobId);
    },
    async submit() {
      return storage
        .service()
        .submit(
          storage.principal(),
          submission(await sourceImage(), "windows-adapter-runner"),
        );
    },
    async reopen() {
      await closeOwner(live);
      storage.store.close();
      const fresh = constructAdapter();
      assert.equal(process.platform, "linux");
      const reader = fresh.readInterruptionEvidence;
      assert.ok(reader);
      storage.setStore(
        openStore({
          directory: storage.directory,
          clock: storage.clock,
          interruptionEvidenceReader: reader,
        }),
      );
      return owner(fresh, "windows-adapter-recovery-publisher");
    },
  };
}

// Windows native interop is a separate group. Do not hide the existing Windows
// Store/directory-fsync gap with shims or claim this Linux seam as its evidence.
describe.skipIf(process.platform !== "linux")(
  "Windows Adapter with real Linux runner/Store seam",
  () => {
    it("subscribes after real AUTH COMMIT and records fast failure before the Host AUTH reply", async () => {
      const f = await fixture();
      await f.submit();
      f.native.holdAuthorization();
      const waking = f.track(f.live.runner.wake());
      await Promise.race([
        f.native.authorized,
        waking.then(() => {
          throw new Error("runner settled before original AUTH");
        }),
      ]);
      const attempt = f.attempt;
      expect(f.native.host.prepare).toHaveBeenCalledOnce();
      expect(f.native.host.authorize).toHaveBeenCalledOnce();
      const terminal = f.native.finish("engine-exit", 7);
      await flush();
      // This is the subscribed real runner's registerExit, while AUTH is held.
      expect(rows(f.storage).attempts[0]?.exit_json).toBe(
        JSON.stringify(terminal.exit),
      );
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "failed",
        reason: "execution_failed",
        result: null,
      });
      expect(rows(f.storage).slot).toEqual([]);
      expect(rows(f.storage).candidates).toEqual([]);
      f.native.acknowledgeAuthorization();
      await waking;
      const prepareGuard = f.native.host.prepare.mock.calls[0]?.[2];
      const authGuard = f.native.host.authorize.mock.calls[0]?.[3];
      expect(prepareGuard?.stillCurrent()).toBe(false);
      expect(authGuard?.stillCurrent()).toBe(false);
    });

    it("publishes an opaque native 4x PNG through real decoding, artifact files and Store transactions", async () => {
      const f = await fixture();
      await f.submit();
      await f.track(f.live.runner.wake());
      const attempt = f.attempt;
      const png = await nativePng(attempt);
      await writeActualFile(attempt.outputPath, png);
      const terminal = f.native.finish("engine-exit");
      await flush();
      await f.track(f.live.runner.wake());
      const committed = rows(f.storage);
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "succeeded",
        reason: null,
        result: nativeResult(attempt, png),
        source: attempt.job.source,
        engineInput: attempt.job.engineInput,
        plan: attempt.job.plan,
      });
      expect(committed.slot).toEqual([]);
      expect(committed.attempts).toHaveLength(1);
      expect(committed.attempts[0]).toMatchObject({
        producer_identity_json: JSON.stringify(attempt.identity),
        launch_ticket: attempt.launchTicket,
        exit_json: JSON.stringify(terminal.exit),
      });
      expect(committed.candidates).toEqual([
        expect.objectContaining({ state: "durable" }),
      ]);
      const candidate = committed.candidates[0];
      assert.ok(candidate);
      const files = await sealedFiles(f.storage.directory, candidate);
      expect(files.png).toEqual(png);
      expect(files.manifest.toString("utf8")).toBe(candidate.manifest_json);
      expect(JSON.parse(candidate.manifest_json).producer).toEqual({
        identity: attempt.identity,
        launchTicket: attempt.launchTicket,
      });
      expect(committed.references).toEqual([
        expect.objectContaining({
          purpose: "run",
          candidate_id: candidate.candidate_id,
          publisher_identity_json: JSON.stringify(attempt.identity),
          released_at: f.storage.clock(),
        }),
      ]);
    });

    it.each(["stop", "deadline"] as const)(
      "retains the original committed cancellation pair after ACK, then accepts %s without completion",
      async (kind) => {
        const f = await fixture();
        await f.submit();
        await f.track(f.live.runner.wake());
        const attempt = f.attempt;
        f.storage.setNow(attempt.firstStartedAt + 100);
        const cancelledAt = f.storage.clock();
        f.storage
          .service()
          .cancel(f.storage.principal(), attempt.identity.jobId);
        const saved = rows(f.storage).attempts[0];
        assert.ok(saved);
        expect(saved).toMatchObject({
          stop_reason: "user_cancel",
          stop_requested_at: cancelledAt,
          terminate_after_at:
            cancelledAt + attempt.executionPolicy.limits.cancelGraceMs,
        });
        f.native.hooks.stop = (_target, _descriptor, request) => {
          expect(rows(f.storage).attempts[0]).toEqual(saved);
          expect(request).toEqual({
            mode: "soft",
            stopRequestedAt: saved.stop_requested_at,
            terminateAfterAt: saved.terminate_after_at,
          });
        };
        await f.track(f.live.runner.wake());
        await flush();
        expect(f.native.host.requestStop).toHaveBeenCalledOnce();
        expect(f.job(attempt.identity.jobId)).toMatchObject({
          status: "running",
          result: null,
        });
        expect(rows(f.storage).slot).toHaveLength(1);
        expect(rows(f.storage).attempts[0]?.exit_json).toBeNull();
        f.storage.setNow(cancelledAt + 100);
        await f.track(f.live.runner.wake());
        expect(rows(f.storage).attempts[0]?.stop_requested_at).toBe(
          saved.stop_requested_at,
        );
        expect(rows(f.storage).attempts[0]?.terminate_after_at).toBe(
          saved.terminate_after_at,
        );
        const terminal = f.native.finish(kind, 0);
        expect(Object.hasOwn(terminal.exit, "completion")).toBe(false);
        await flush();
        await f.track(f.live.runner.wake());
        expect(f.job(attempt.identity.jobId)).toMatchObject({
          status: "cancelled",
          reason: "user_cancel",
          result: null,
        });
        expect(rows(f.storage).slot).toEqual([]);
        expect(rows(f.storage).attempts[0]).toMatchObject({
          stop_reason: saved.stop_reason,
          stop_requested_at: saved.stop_requested_at,
          terminate_after_at: saved.terminate_after_at,
          exit_json: JSON.stringify(terminal.exit),
        });
        expect(f.native.host.requestStop).toHaveBeenCalledOnce();
      },
    );

    it.each(["stop", "deadline"] as const)(
      "recovers %s read-only with original producer and a new publisher, without an interruption restart",
      async (kind) => {
        const f = await fixture();
        await f.submit();
        await f.track(f.live.runner.wake());
        const attempt = f.attempt;
        f.storage
          .service()
          .cancel(f.storage.principal(), attempt.identity.jobId);
        const before = rows(f.storage);
        const fresh = await f.reopen();
        const terminal = f.native.terminal(kind, 0);
        await f.track(fresh.runner.recover());
        expect(f.job(attempt.identity.jobId)).toMatchObject({
          status: "cancelled",
          reason: "user_cancel",
          result: null,
        });
        const after = rows(f.storage);
        expect(after.slot).toEqual([]);
        expect(after.jobs).toEqual(before.jobs);
        expect(after.attempts).toHaveLength(1);
        expect(after.attempts[0]).toMatchObject({
          owner_instance_id: "windows-adapter-recovery-publisher",
          fence: attempt.identity.fence + 1,
          producer_identity_json: JSON.stringify(attempt.identity),
          producer_incarnation_id: before.attempts[0]?.producer_incarnation_id,
          launch_ticket: attempt.launchTicket,
          stop_reason: before.attempts[0]?.stop_reason,
          stop_requested_at: before.attempts[0]?.stop_requested_at,
          terminate_after_at: before.attempts[0]?.terminate_after_at,
          exit_json: JSON.stringify(terminal.exit),
        });
        expect(after.events).toEqual([]);
        expect(after.candidates).toEqual([]);
        expect(after.references).toEqual([]);
        expect(after.controls).toEqual([
          expect.objectContaining({
            owner_instance_id: "windows-adapter-recovery-publisher",
            source_identity_json: JSON.stringify(attempt.identity),
            classification: "tree-exited",
            state: "consumed",
          }),
        ]);
        const persistedExit = JSON.parse(
          after.attempts[0]!.exit_json!,
        ) as ExecutionExit;
        expect(persistedExit.identity).toEqual(attempt.identity);
        expect(Object.hasOwn(persistedExit, "completion")).toBe(false);
        const reader = fresh.adapter.readInterruptionEvidence;
        assert.ok(reader);
        await expect(
          reader(
            { target: f.native.scope.target, descriptor: f.native.descriptor },
            () => true,
          ),
        ).resolves.toBeUndefined();
        expect(factories.host).toHaveBeenCalledOnce();
        expect(f.native.host.prepare).toHaveBeenCalledOnce();
        expect(f.native.host.authorize).toHaveBeenCalledOnce();
        expect(f.native.host.requestStop).not.toHaveBeenCalled();
        await f.track(fresh.runner.recover());
        expect(rows(f.storage)).toEqual(after);
        expect(await f.closeOwner(fresh)).toBe("closed");
        expect(f.storage.store.closed).toBe(false);
      },
    );

    it("requires the fresh recovery owner to await runner.close then adapter.close before closing Store", async () => {
      const f = await fixture();
      await f.submit();
      await f.track(f.live.runner.wake());
      const attempt = f.attempt;
      const fresh = await f.reopen();
      const pending = f.track(fresh.runner.recover());
      await flush();
      const journal = f.journals.at(-1);
      assert.ok(journal);
      expect(journal.reader.read).toHaveBeenCalledOnce();
      const read = journal.reader.read.mock.calls[0];
      assert.ok(read);
      expect(read[2].aborted).toBe(false);
      const before = rows(f.storage);
      await fresh.runner.close();
      // A recovery-only Adapter never received this runner's prepare signal.
      expect(read[2].aborted).toBe(false);
      expect(journal.reader.close).not.toHaveBeenCalled();
      expect(f.storage.store.closed).toBe(false);
      expect(await fresh.adapter.close()).toBe("closed");
      expect(read[2].aborted).toBe(true);
      await pending;
      expect(rows(f.storage)).toEqual(before);
      expect(f.job(attempt.identity.jobId).status).toBe("running");
      expect(rows(f.storage).slot).toHaveLength(1);
      expect(factories.host).toHaveBeenCalledOnce();
      f.storage.store.close();
      expect(f.storage.store.closed).toBe(true);
    });
  },
);
