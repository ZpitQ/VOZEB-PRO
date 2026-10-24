import assert from "node:assert/strict";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";

import { EnhancementError } from "../src/contracts.js";
import type {
  ClaimedAttempt,
  ExecutionAdapter,
  ExecutionExit,
  ExecutionTarget,
  Inspection,
  OwnerDescriptor,
} from "../src/execution.js";
import { createRunner } from "../src/runner.js";
import { openStore } from "../src/store.js";
import { deferred } from "./http-fixtures.js";
import { fixtureSendGuard } from "./execution-send-permission-fixtures.js";
import { descriptor, manualClock } from "./lifecycle-fixtures.js";
import { sourceImage, storageFixture, submission } from "./storage-fixtures.js";

export function target(attempt: ExecutionTarget): ExecutionTarget {
  return {
    identity: { ...attempt.identity },
    launchTicket: attempt.launchTicket,
  };
}

export function recoveryExecutor() {
  type Ticket = {
    target: ExecutionTarget;
    owner: OwnerDescriptor | null;
    authorized: boolean;
    active: boolean;
    sealed: boolean;
    exit: ExecutionExit | null;
  };
  const tickets = new Map<string, Ticket>();
  const prepared = deferred<ClaimedAttempt>();
  const authorized = deferred<ClaimedAttempt>();
  const inspected = deferred<ExecutionTarget>();
  const prepareCalls: ClaimedAttempt[] = [];
  const authorizeCalls: ClaimedAttempt[] = [];
  const launchCalls: ClaimedAttempt[] = [];
  const inspectCalls: {
    target: ExecutionTarget;
    descriptor: OwnerDescriptor | null;
  }[] = [];
  const stopCalls: {
    target: ExecutionTarget;
    descriptor: OwnerDescriptor;
    mode: "soft" | "force";
  }[] = [];
  const observers: {
    target: ExecutionTarget;
    descriptor: OwnerDescriptor;
    listener: (exit: ExecutionExit) => void;
    subscribed: boolean;
  }[] = [];
  const hooks: {
    prepare?: (
      attempt: ClaimedAttempt,
      owner: OwnerDescriptor,
    ) => Promise<OwnerDescriptor>;
    authorize?: (
      attempt: ClaimedAttempt,
      owner: OwnerDescriptor,
    ) => Promise<void>;
    inspect?: (call: (typeof inspectCalls)[number]) => Promise<Inspection>;
    stop?: (call: (typeof stopCalls)[number]) => Promise<void>;
    observe?: (observer: (typeof observers)[number]) => void;
  } = {};
  function ticket(execution: ExecutionTarget) {
    const existing = tickets.get(execution.launchTicket);
    if (existing) {
      assert.deepEqual(existing.target, target(execution));
      return existing;
    }
    const created: Ticket = {
      target: target(execution),
      owner: null,
      authorized: false,
      active: false,
      sealed: false,
      exit: null,
    };
    tickets.set(execution.launchTicket, created);
    return created;
  }
  const adapter: ExecutionAdapter = {
    kind: "test",
    async prepare(attempt, guard) {
      prepareCalls.push(attempt);
      prepared.resolve(attempt);
      const state = ticket(attempt);
      const owner = descriptor(attempt);
      const preparedOwner = hooks.prepare
        ? await hooks.prepare(attempt, owner)
        : owner;
      if (!guard.takeSendPermission()) throw new EnhancementError("not_ready");
      state.owner = preparedOwner;
      return preparedOwner;
    },
    async authorize(attempt, owner, guard) {
      authorizeCalls.push(attempt);
      authorized.resolve(attempt);
      const state = ticket(attempt);
      if (state.sealed) throw new EnhancementError("not_ready");
      assert.deepEqual(state.owner, owner);
      // Entry is pessimistically remembered before waiting; it is not a native
      // AUTH record or evidence that the controlled start happened.
      state.authorized = true;
      await hooks.authorize?.(attempt, owner);
      if (!guard.takeSendPermission() || state.sealed)
        throw new EnhancementError("not_ready");
      state.active = true;
      launchCalls.push(attempt);
    },
    async inspect(execution, owner) {
      const call = { target: target(execution), descriptor: owner };
      inspectCalls.push(call);
      inspected.resolve(call.target);
      if (hooks.inspect) return hooks.inspect(call);
      const state = ticket(execution);
      if (owner !== null && !isDeepStrictEqual(state.owner, owner))
        return { kind: "unknown", ...call.target };
      if (state.exit) return { kind: "tree-exited", exit: state.exit };
      if (state.active && state.owner)
        return { kind: "owned-alive", ...call.target, descriptor: state.owner };
      if (state.authorized) return { kind: "unknown", ...call.target };
      // Sealing exists independently of a descriptor or a whole-tree exit.
      // prepare/authorize arriving later consult the same ticket barrier.
      state.sealed = true;
      return { kind: "never-authorized", ...call.target };
    },
    async requestStop(execution, owner, request, guard) {
      if (!guard.takeSendPermission()) throw new EnhancementError("not_ready");
      const call = {
        target: target(execution),
        descriptor: owner,
        mode: request.mode,
      };
      stopCalls.push(call);
      if (hooks.stop) await hooks.stop(call);
    },
    observeExit(execution, owner, listener) {
      const observer = {
        target: target(execution),
        descriptor: owner,
        listener,
        subscribed: true,
      };
      observers.push(observer);
      hooks.observe?.(observer);
      return () => {
        observer.subscribed = false;
      };
    },
  };
  return {
    adapter,
    hooks,
    prepared,
    authorized,
    inspected,
    prepareCalls,
    authorizeCalls,
    launchCalls,
    inspectCalls,
    stopCalls,
    observers,
    activeCount: () =>
      [...tickets.values()].filter((state) => state.active).length,
    isSealed: (launchTicket: string) =>
      tickets.get(launchTicket)?.sealed === true,
    emit(exit: ExecutionExit) {
      const state = tickets.get(exit.launchTicket);
      if (
        state &&
        exit.treeExited === true &&
        isDeepStrictEqual(state.target.identity, exit.identity) &&
        isDeepStrictEqual(state.owner, exit.descriptor)
      ) {
        state.sealed = true;
        state.active = false;
        state.exit = exit;
      }
      for (const observer of observers.filter((item) => item.subscribed))
        observer.listener(exit);
    },
  };
}

export async function recoveryFixture() {
  const storage = await storageFixture();
  const time = manualClock(storage);
  const executor = recoveryExecutor();
  const runners: ReturnType<typeof createRunner>[] = [];
  const cleanupReleases: (() => void)[] = [];
  const bytes = await sourceImage();
  const submit = (key = "recovery-first") =>
    storage.service().submit(storage.principal(), submission(bytes, key));
  return {
    storage,
    time,
    executor,
    submit,
    releaseOnCleanup(release: () => void) {
      cleanupReleases.push(release);
    },
    async claim(
      phase: "claimed" | "prepared" | "authorized" = "claimed",
      ownerInstanceId = "producer-owner",
    ) {
      await submit();
      const attempt = storage.store.claimNext(ownerInstanceId);
      assert.ok(attempt, "fixture must claim the submitted job");
      if (phase !== "claimed") {
        const owner = await executor.adapter.prepare(
          attempt,
          fixtureSendGuard(() =>
            storage.store.canPrepareAttempt(
              attempt.identity,
              attempt.launchTicket,
            ),
          ),
        );
        assert.equal(
          storage.store.registerPrepared(attempt.identity, owner),
          true,
        );
        if (phase === "authorized") {
          assert.equal(
            storage.store.authorizeLaunch(attempt.identity, owner),
            true,
          );
          await executor.adapter.authorize(
            attempt,
            owner,
            fixtureSendGuard(() =>
              storage.store.canAuthorizeLaunch(
                attempt.identity,
                attempt.launchTicket,
                owner,
              ),
            ),
          );
        }
      }
      return attempt;
    },
    runner(ownerInstanceId = "recovery-owner") {
      const runner = createRunner({
        store: storage.store,
        clock: time.clock,
        executor: executor.adapter,
        ownerInstanceId,
      });
      runners.push(runner);
      return runner;
    },
    async reopen() {
      for (const runner of runners) await runner.close();
      storage.store.close();
      storage.setStore(
        openStore({ directory: storage.directory, clock: storage.clock }),
      );
    },
    async cleanup() {
      for (const release of cleanupReleases) release();
      for (const runner of runners) await runner.close();
      await storage.cleanup();
    },
  };
}

export type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>;

export async function observeInspection(
  executor: ReturnType<typeof recoveryExecutor>,
  recovery: Promise<void>,
) {
  await Promise.race([
    executor.inspected.promise,
    recovery.then(() => {
      throw new Error("recover returned before inspecting the durable slot");
    }),
  ]);
}

export async function publisherFenceBoundary(f: RecoveryFixture) {
  // Approved private boundary injection after a real terminal transfer. Keep the
  // producer, ticket, paths, attempt number and every qualification fact intact.
  f.storage.store.close();
  const db = new Database(join(f.storage.directory, "worker.sqlite"));
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      const slot = db
        .prepare("SELECT job_id, attempt_no FROM execution_slot")
        .get() as { job_id: string; attempt_no: number };
      assert.ok(slot);
      db.prepare(
        "UPDATE attempts SET fence = ? WHERE job_id = ? AND attempt_no = ?",
      ).run(Number.MAX_SAFE_INTEGER, slot.job_id, slot.attempt_no);
      db.prepare("UPDATE jobs SET current_fence = ? WHERE job_id = ?").run(
        Number.MAX_SAFE_INTEGER,
        slot.job_id,
      );
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    }).immediate();
  } finally {
    db.close();
  }
  f.storage.setStore(
    openStore({ directory: f.storage.directory, clock: f.storage.clock }),
  );
}
