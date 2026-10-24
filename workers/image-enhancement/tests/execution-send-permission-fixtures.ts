import assert from "node:assert/strict";

import { EnhancementError } from "../src/contracts.js";
import type {
  ClaimedAttempt,
  ExecutionAdapter,
  ExecutionExit,
  ExecutionSendGuard,
  OwnerDescriptor,
} from "../src/execution.js";
import { createRunner } from "../src/runner.js";
import { openStore, type EnhancementStore } from "../src/store.js";
import { deferred } from "./http-fixtures.js";
import { descriptor, manualClock, snapshot } from "./lifecycle-fixtures.js";
import { sourceImage, storageFixture, submission } from "./storage-fixtures.js";

// Direct fixture invocations have no runner holder. Each caller explicitly binds
// its durable predicate (or identifies a deliberately nonconforming setup).
export function fixtureSendGuard(permitted: () => boolean): ExecutionSendGuard {
  let consumed = false;
  const signal = new AbortController().signal;
  return Object.freeze({
    signal,
    stillCurrent: permitted,
    takeSendPermission() {
      if (consumed) return false;
      consumed = true;
      return permitted();
    },
  });
}

export function fixturePrepareGuard(
  store: EnhancementStore,
  attempt: ClaimedAttempt,
) {
  return fixtureSendGuard(
    () =>
      !store.closed &&
      store.canPrepareAttempt(attempt.identity, attempt.launchTicket),
  );
}

export function fixtureAuthorizeGuard(
  store: EnhancementStore,
  attempt: ClaimedAttempt,
  owner: OwnerDescriptor,
) {
  return fixtureSendGuard(
    () =>
      !store.closed &&
      store.canAuthorizeLaunch(attempt.identity, attempt.launchTicket, owner),
  );
}

export type SendPhase = "prepare" | "authorize";
export type SendCall = {
  attempt: ClaimedAttempt;
  owner: OwnerDescriptor;
  guard: ExecutionSendGuard;
};
type Mode =
  | "send"
  | "send-throw-sync"
  | "fulfill-unused"
  | "reject-unused"
  | "throw-unused";

export async function permissionFixture(
  configure?: (storage: Awaited<ReturnType<typeof storageFixture>>) => void,
) {
  const storage = await storageFixture();
  configure?.(storage);
  let clockHook: (() => void) | undefined;
  storage.store.close();
  storage.setStore(
    openStore({
      directory: storage.directory,
      clock() {
        const hook = clockHook;
        clockHook = undefined;
        hook?.();
        return storage.clock();
      },
    }),
  );
  const time = manualClock(storage);
  const gates = { prepare: deferred(), authorize: deferred() };
  const arrivals = {
    prepare: deferred<SendCall>(),
    authorize: deferred<SendCall>(),
  };
  const dispatches = {
    prepare: deferred<SendCall>(),
    authorize: deferred<SendCall>(),
  };
  const calls: Record<SendPhase, SendCall[]> = { prepare: [], authorize: [] };
  // These count synthetic synchronous dispatches, never native/pipe/GPU I/O.
  const sends: Record<SendPhase, SendCall[]> = { prepare: [], authorize: [] };
  const modes: Record<SendPhase, Mode> = { prepare: "send", authorize: "send" };
  const hooks: {
    beforeSend?: (phase: SendPhase, call: SendCall) => void;
    afterSend?: (phase: SendPhase, call: SendCall) => void | Promise<void>;
    observe?: (call: SendCall, listener: (exit: ExecutionExit) => void) => void;
    preparedResult?: (owner: OwnerDescriptor) => OwnerDescriptor;
  } = {};
  const observers: {
    call: SendCall;
    listener: (exit: ExecutionExit) => void;
  }[] = [];
  const stops: { mode: "soft" | "force"; owner: OwnerDescriptor }[] = [];
  function dispatch(phase: SendPhase, call: SendCall) {
    // Missing guards fail closed in the pre-feature RED round, without TypeError.
    if (!call.guard?.takeSendPermission())
      throw new EnhancementError("not_ready");
    sends[phase].push(call);
    dispatches[phase].resolve(call);
  }
  function invocation(phase: SendPhase, call: SendCall) {
    calls[phase].push(call);
    arrivals[phase].resolve(call);
    if (modes[phase] === "throw-unused")
      throw new EnhancementError("not_ready");
    if (modes[phase] === "send-throw-sync") {
      dispatch(phase, call);
      throw new Error("synthetic-dispatch-threw-synchronously");
    }
    return (async () => {
      await gates[phase].promise;
      // Unused modes deliberately model a nonconforming adapter leaking a guard.
      if (modes[phase] === "reject-unused")
        throw new EnhancementError("not_ready");
      if (modes[phase] === "fulfill-unused") return;
      hooks.beforeSend?.(phase, call);
      dispatch(phase, call);
      await hooks.afterSend?.(phase, call);
    })();
  }
  const adapter: ExecutionAdapter = {
    kind: "test",
    prepare(attempt, guard) {
      const owner = descriptor(attempt);
      const pending = invocation("prepare", { attempt, owner, guard });
      return pending.then(() =>
        hooks.preparedResult ? hooks.preparedResult(owner) : owner,
      );
    },
    authorize(attempt, owner, guard) {
      return invocation("authorize", { attempt, owner, guard });
    },
    async inspect(target) {
      return { kind: "unknown", ...target };
    },
    async requestStop(_target, owner, request, guard) {
      if (!guard.takeSendPermission()) throw new EnhancementError("not_ready");
      stops.push({ owner, mode: request.mode });
    },
    observeExit(target, owner, listener) {
      const call = calls.prepare.find(
        (item) => item.attempt.launchTicket === target.launchTicket,
      );
      assert.ok(call);
      const observed = { call: { ...call, owner }, listener };
      observers.push(observed);
      hooks.observe?.(observed.call, listener);
      return () => {
        const index = observers.indexOf(observed);
        if (index !== -1) observers.splice(index, 1);
      };
    },
  };
  // Mutable at runtime on purpose: readonly typing cannot protect the binding.
  const options = {
    store: storage.store,
    clock: time.clock,
    executor: adapter,
    ownerInstanceId: "send-permission-owner",
  };
  const runner = createRunner(options);
  const bytes = await sourceImage();
  const pending: Promise<void>[] = [];
  const cleanupReleases: (() => void)[] = [];
  return {
    storage,
    time,
    adapter,
    options,
    runner,
    gates,
    calls,
    sends,
    modes,
    hooks,
    observers,
    dispatches,
    stops,
    armClock(hook: () => void) {
      clockHook = hook;
    },
    durable() {
      return snapshot(storage, (db) => ({
        attempts: db
          .prepare("SELECT * FROM attempts ORDER BY attempt_no")
          .all(),
        jobs: db.prepare("SELECT * FROM jobs ORDER BY job_id").all(),
        slot: db.prepare("SELECT * FROM execution_slot").all(),
        controls: db.prepare("SELECT * FROM recovery_controls").all(),
      }));
    },
    cancel(call: SendCall) {
      return storage
        .service()
        .cancel(storage.principal(), call.attempt.identity.jobId);
    },
    async submit(key = "send-permission-first") {
      return storage
        .service()
        .submit(storage.principal(), submission(bytes, key));
    },
    track(wake: Promise<void>) {
      pending.push(wake);
      void wake.catch(() => {});
      return wake;
    },
    releaseOnCleanup(release: () => void) {
      cleanupReleases.push(release);
    },
    async arrive(phase: SendPhase, wake: Promise<void>) {
      return Promise.race([
        arrivals[phase].promise,
        wake.then(() => {
          throw new Error(
            `runner settled before the ${phase} adapter boundary`,
          );
        }),
      ]);
    },
    async cleanup() {
      await runner.close();
      gates.prepare.resolve();
      gates.authorize.resolve();
      for (const release of cleanupReleases) release();
      await Promise.allSettled(pending);
      await storage.cleanup();
    },
  };
}

export type PermissionFixture = Awaited<ReturnType<typeof permissionFixture>>;
