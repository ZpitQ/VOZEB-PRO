import assert from "node:assert/strict";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ExecutionAdapter,
  ExecutionSendGuard,
  ExecutionStopRequest,
  ExecutionTarget,
  OwnerDescriptor,
  RecoveryControl,
  RecoveryStop,
} from "../src/execution.js";
import { createRunner } from "../src/runner.js";
import { openStore, type EnhancementStore } from "../src/store.js";
import { deferred } from "./http-fixtures.js";
import {
  descriptor,
  manualClock,
  snapshot,
  treeExit,
} from "./lifecycle-fixtures.js";
import { recoveryExecutor, target } from "./recovery-fixtures.js";
import {
  runnerLimits,
  sourceImage,
  storageFixture,
  submission,
} from "./storage-fixtures.js";

type StopCall = {
  target: ExecutionTarget;
  descriptor: OwnerDescriptor;
  request: ExecutionStopRequest;
  guard: ExecutionSendGuard;
};
type StopMode =
  "send" | "send-reject" | "fulfill-unused" | "reject-unused" | "throw-unused";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const storage = await storageFixture();
  let clockHook: (() => void) | undefined;
  const storeClock = () => {
    const hook = clockHook;
    clockHook = undefined;
    hook?.();
    return storage.clock();
  };
  storage.store.close();
  storage.setStore(
    openStore({
      directory: storage.directory,
      clock: storeClock,
    }),
  );
  const time = manualClock(storage);
  const executor = recoveryExecutor();
  const gate = deferred();
  const arrived = deferred<StopCall>();
  const settled = deferred<StopCall>();
  const calls: StopCall[] = [];
  const sends: StopCall[] = [];
  const events: { phase: "arrive" | "send" | "settle"; call: StopCall }[] = [];
  const pending: Promise<void>[] = [];
  const runners: ReturnType<typeof createRunner>[] = [];
  const bindings: { store: EnhancementStore }[] = [];
  const modes: Record<"soft" | "force", StopMode> = {
    soft: "send",
    force: "send",
  };
  const hooks: { beforeSend?: (call: StopCall) => void } = {};
  const adapter: ExecutionAdapter = {
    ...executor.adapter,
    requestStop(
      execution: ExecutionTarget,
      descriptor: OwnerDescriptor,
      request: ExecutionStopRequest,
      guard: ExecutionSendGuard,
    ) {
      const call = { target: target(execution), descriptor, request, guard };
      calls.push(call);
      events.push({ phase: "arrive", call });
      arrived.resolve(call);
      const mode = modes[request.mode];
      if (mode === "throw-unused") {
        events.push({ phase: "settle", call });
        settled.resolve(call);
        throw new Error("synthetic-stop-sync-throw");
      }
      const operation = (async () => {
        await gate.promise;
        if (mode === "reject-unused")
          throw new Error("synthetic-stop-ack-lost");
        if (mode === "fulfill-unused") return;
        hooks.beforeSend?.(call);
        if (!guard.takeSendPermission()) return;
        sends.push(call);
        events.push({ phase: "send", call });
        if (mode === "send-reject")
          throw new Error("synthetic-sent-stop-ack-lost");
      })().finally(() => {
        events.push({ phase: "settle", call });
        settled.resolve(call);
      });
      pending.push(operation);
      void operation.catch(() => {});
      return operation;
    },
  };
  const bytes = await sourceImage();
  const drain = () => Promise.allSettled(pending);
  const f = {
    storage,
    executor,
    time,
    gate,
    arrived,
    settled,
    calls,
    sends,
    events,
    bindings,
    modes,
    hooks,
    runner(ownerInstanceId = "stop-permission-producer") {
      const options = {
        store: storage.store,
        clock: time.clock,
        executor: adapter,
        ownerInstanceId,
      };
      bindings.push(options);
      const runner = createRunner(options);
      runners.push(runner);
      return runner;
    },
    async submit(key = "stop-permission-first") {
      return storage
        .service()
        .submit(storage.principal(), submission(bytes, key));
    },
    async arrive(work: Promise<void>) {
      return Promise.race([
        arrived.promise,
        work.then(() => {
          throw new Error("runner settled before the stop adapter boundary");
        }),
      ]);
    },
    drain,
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
        controls: db
          .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
          .all(),
        schema: db.pragma("user_version", { simple: true }),
      }));
    },
    async reopen() {
      for (const runner of runners) await runner.close();
      storage.store.close();
      storage.setStore(
        openStore({
          directory: storage.directory,
          clock: storeClock,
        }),
      );
    },
    async cleanup() {
      for (const runner of runners) await runner.close();
      gate.resolve();
      await drain();
      await storage.cleanup();
    },
  };
  cleanups.push(() => f.cleanup());
  return f;
}

type StopFixture = Awaited<ReturnType<typeof fixture>>;

async function running(f: StopFixture) {
  await f.submit();
  const runner = f.runner();
  await runner.wake();
  const attempt = f.executor.launchCalls[0];
  assert.ok(attempt, "the real runner must first authorize and dispatch");
  expect(f.executor.activeCount()).toBe(1);
  f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
  return { runner, attempt };
}

function retained(f: StopFixture, execution: ExecutionTarget) {
  const rows = f.durable();
  expect(rows.attempts[0]).toMatchObject({
    job_id: execution.identity.jobId,
    attempt_no: execution.identity.attemptNo,
    owner_instance_id: execution.identity.ownerInstanceId,
    fence: execution.identity.fence,
    producer_identity_json: JSON.stringify(execution.identity),
    launch_ticket: execution.launchTicket,
    prepared_at: 1_000,
    authorized_at: 1_000,
    stop_reason: "user_cancel",
    stop_requested_at: 1_000,
    terminate_after_at: 1_000 + runnerLimits.cancelGraceMs,
    exit_json: null,
    sealed_at: null,
  });
  expect(rows.jobs[0]).toMatchObject({
    status: "running",
    completed_at: null,
  });
  expect(rows.slot).toHaveLength(1);
  expect(rows.schema).toBe(7);
  expect(f.executor.activeCount()).toBe(1);
}

async function waiting(f: StopFixture, recover = false) {
  const original = await running(f);
  const attempt = original.attempt;
  let runner = original.runner;
  let control: RecoveryControl | undefined;
  if (recover) {
    await f.reopen();
    runner = f.runner("stop-permission-recovery");
  }
  const work = recover ? runner.recover() : runner.wake();
  const call = await f.arrive(work);
  await work;
  if (recover) {
    const session = f.storage.store.beginRecovery("stop-permission-recovery");
    assert.ok(session);
    control = session.control;
  }
  return { runner, attempt, call, control };
}

function recoveryStop(call: StopCall): RecoveryStop {
  return { ...call.request, target: call.target, descriptor: call.descriptor };
}

function permitted(f: StopFixture, call: StopCall, control?: RecoveryControl) {
  return control
    ? f.storage.store.canRequestRecoveryStop(control, recoveryStop(call))
    : f.storage.store.canRequestStop(
        call.target,
        call.descriptor,
        call.request,
      );
}

function otherTargets(execution: ExecutionTarget): ExecutionTarget[] {
  const identity = execution.identity;
  return [
    { ...identity, jobId: "other-stop-job" },
    { ...identity, attemptNo: identity.attemptNo + 1 },
    { ...identity, ownerInstanceId: "other-stop-owner" },
    { ...identity, fence: identity.fence + 1 },
  ].map((identity) => ({ identity, launchTicket: execution.launchTicket }));
}

describe("stop permission at the final queued send", () => {
  it("queued stop refuses final send after runner close and retains the running slot", async () => {
    const f = await fixture();
    const { runner, attempt } = await running(f);
    const wake = runner.wake();
    const call = await f.arrive(wake);
    await wake;
    expect(call.target).toEqual(target(attempt));
    expect(f.sends).toHaveLength(0);

    await runner.close();
    const before = f.durable();
    f.gate.resolve();
    await f.drain();
    expect(await f.settled.promise).toBe(call);
    expect(f.events[0]).toEqual({ phase: "arrive", call });
    expect(f.events.at(-1)).toEqual({ phase: "settle", call });
    expect(f.durable()).toEqual(before);
    retained(f, attempt);
    expect(
      f.sends,
      "a closed runner must not dispatch its queued stop",
    ).toHaveLength(0);
  });

  it("queued stop refuses final send after recovery control replacement and preserves the producer ticket and slot", async () => {
    const f = await fixture();
    const { attempt } = await running(f);
    await f.reopen();
    const runner = f.runner("stop-permission-recovery");
    const recovery = runner.recover();
    const call = await f.arrive(recovery);
    await recovery;
    expect(runner.readiness().recoveryState).toBe("owned-alive");
    expect(call.target).toEqual(target(attempt));
    expect(f.sends).toHaveLength(0);
    const first = f.durable().controls[0];
    expect(first).toMatchObject({
      state: "active",
      classification: "owned-alive",
    });

    const replacement = f.storage.store.beginRecovery(
      "stop-permission-replacement",
    );
    assert.ok(
      replacement,
      "a real recovery claim must replace the old control",
    );
    expect(replacement.control.source).toEqual(attempt.identity);
    expect(replacement.control.publisher).toEqual(attempt.identity);
    expect(replacement.control.launchTicket).toBe(attempt.launchTicket);
    expect(f.durable().controls[0]).toMatchObject({ state: "replaced" });
    const before = f.durable();
    f.gate.resolve();
    await f.drain();
    expect(await f.settled.promise).toBe(call);
    expect(f.events[0]).toEqual({ phase: "arrive", call });
    expect(f.events.at(-1)).toEqual({ phase: "settle", call });
    expect(f.durable()).toEqual(before);
    retained(f, attempt);
    expect(
      f.sends,
      "a replaced control must not dispatch its queued stop",
    ).toHaveLength(0);
  });

  it("carries the frozen first stop times through independently single-use soft and force sends", async () => {
    const f = await fixture();
    const { runner, attempt, call: soft } = await waiting(f);
    const first = f.storage.store.getActiveAttempt(attempt.identity)!;
    expect(Object.isFrozen(soft.request)).toBe(true);
    expect(Object.isFrozen(soft.guard)).toBe(true);
    expect(soft.guard.stillCurrent()).toBe(true);
    expect(soft.request).toEqual({
      mode: "soft",
      stopRequestedAt: first.stopRequestedAt,
      terminateAfterAt: first.terminateAfterAt,
    });
    f.storage.setNow(first.terminateAfterAt!);
    await runner.wake();
    expect(f.calls).toHaveLength(1);
    f.storage.setNow(first.terminateAfterAt! + 1);
    await runner.wake();
    await runner.wake();
    const force = f.calls[1];
    assert.ok(force);
    expect(f.calls.map((item) => item.request.mode)).toEqual(["soft", "force"]);
    expect(force.request).toEqual({ ...soft.request, mode: "force" });
    expect(Object.isFrozen(force.request)).toBe(true);
    expect(force.guard).not.toBe(soft.guard);
    expect(force.guard.signal).toBe(soft.guard.signal);
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toEqual([soft, force]);
    expect(soft.guard.takeSendPermission()).toBe(false);
    expect(force.guard.takeSendPermission()).toBe(false);
    expect(f.executor.launchCalls).toHaveLength(1);
    retained(f, attempt);
  });

  it.each(["equal", "expired", "renewed"] as const)(
    "uses the latest ordinary lease when it is %s without changing durable rows",
    async (boundary) => {
      const f = await fixture();
      const { attempt, call } = await waiting(f);
      if (boundary === "renewed") {
        f.storage.setNow(attempt.leaseExpiresAt - 1);
        expect(f.storage.store.renewLease(attempt.identity)).toBe(true);
      }
      f.storage.setNow(attempt.leaseExpiresAt + (boundary === "equal" ? 0 : 1));
      const before = f.durable();
      expect(permitted(f, call)).toBe(boundary !== "expired");
      expect(f.durable()).toEqual(before);
      f.gate.resolve();
      await f.drain();
      expect(f.sends).toHaveLength(boundary === "expired" ? 0 : 1);
      expect(f.durable()).toEqual(before);
      retained(f, attempt);
    },
  );

  it.each(["store close", "store replacement", "recovery claim"] as const)(
    "rejects a queued ordinary stop after %s without releasing its slot",
    async (action) => {
      const f = await fixture();
      const { attempt, call } = await waiting(f);
      if (action === "store close") f.storage.store.close();
      else if (action === "store replacement") {
        const other = await storageFixture();
        cleanups.push(() => other.cleanup());
        f.bindings[0]!.store = other.store;
      } else {
        expect(
          f.storage.store.beginRecovery("queued-ordinary-new-control"),
        ).toBeDefined();
      }
      const before = f.durable();
      expect(call.guard.stillCurrent()).toBe(false);
      f.gate.resolve();
      await f.drain();
      expect(f.sends).toHaveLength(0);
      expect(f.durable()).toEqual(before);
      retained(f, attempt);
    },
  );

  it("allows recovery sends after the old producer lease expires and preserves the original grace", async () => {
    const f = await fixture();
    const { attempt } = await running(f);
    await f.reopen();
    f.storage.setNow(attempt.leaseExpiresAt + 1);
    const runner = f.runner("stop-permission-recovery");
    const work = runner.recover();
    await f.arrive(work);
    await work;
    const session = f.storage.store.beginRecovery("stop-permission-recovery");
    assert.ok(session);
    const before = f.durable();
    expect(f.calls.map((call) => call.request)).toEqual([
      {
        mode: "soft",
        stopRequestedAt: 1_000,
        terminateAfterAt: 1_000 + runnerLimits.cancelGraceMs,
      },
      {
        mode: "force",
        stopRequestedAt: 1_000,
        terminateAfterAt: 1_000 + runnerLimits.cancelGraceMs,
      },
    ]);
    for (const call of f.calls) {
      expect(permitted(f, call, session.control)).toBe(true);
      expect(call.target).toEqual(target(attempt));
      expect(Object.isFrozen(call.request)).toBe(true);
    }
    expect(f.durable()).toEqual(before);
    f.gate.resolve();
    await f.drain();
    await runner.wake();
    expect(f.sends).toHaveLength(2);
    expect(f.calls).toHaveLength(2);
    expect(f.executor.authorizeCalls).toHaveLength(1);
    expect(
      f.storage.store.getActiveAttempt(attempt.identity)?.leaseExpiresAt,
    ).toBe(attempt.leaseExpiresAt);
    retained(f, attempt);
  });

  it("allows an authorized timeout stop after the execution deadline without restarting its grace", async () => {
    const f = await fixture();
    f.storage.setRunnerLimits({
      ...runnerLimits,
      executionTimeoutMs: runnerLimits.heartbeatIntervalMs,
    });
    await f.submit();
    const runner = f.runner();
    await runner.wake();
    const attempt = f.executor.launchCalls[0];
    assert.ok(attempt);
    f.storage.setNow(attempt.executionDeadlineAt + 1);
    expect(
      f.storage.store.requestStop(attempt.identity, "execution_timeout"),
    ).toBe(true);
    const first = f.storage.store.getActiveAttempt(attempt.identity)!;
    const work = runner.wake();
    const call = await f.arrive(work);
    await work;
    expect(call.request).toEqual({
      mode: "soft",
      stopRequestedAt: first.stopRequestedAt,
      terminateAfterAt: first.terminateAfterAt,
    });
    const before = f.durable();
    expect(permitted(f, call)).toBe(true);
    expect(f.durable()).toEqual(before);
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toHaveLength(1);
    expect(f.durable()).toEqual(before);
  });

  it("denies recovery after a real unknown classification replaces owned-alive", async () => {
    const f = await fixture();
    const { call, control, attempt } = await waiting(f, true);
    assert.ok(control);
    expect(
      f.storage.store.applyRecoveryInspection(control, {
        kind: "unknown",
        ...call.target,
      })?.kind,
    ).toBe("unknown");
    const before = f.durable();
    expect(permitted(f, call, control)).toBe(false);
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toHaveLength(0);
    expect(f.durable()).toEqual(before);
    retained(f, attempt);
  });

  it("rejects an ordinary stop after exact exit proof seals the attempt without releasing its slot", async () => {
    const f = await fixture();
    const { call, attempt } = await waiting(f);
    expect(
      f.storage.store.registerExit(treeExit(attempt, call.descriptor)),
    ).toBe(true);
    const before = f.durable();
    expect(permitted(f, call)).toBe(false);
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toHaveLength(0);
    expect(f.durable()).toEqual(before);
    expect(before.slot).toHaveLength(1);
    expect(before.jobs[0]).toMatchObject({ status: "running" });
  });

  it("denies a recovery guard when exact terminal proof transfers its publisher", async () => {
    const f = await fixture();
    const { call, control, attempt } = await waiting(f, true);
    assert.ok(control);
    const resolution = f.storage.store.applyRecoveryInspection(control, {
      kind: "tree-exited",
      exit: treeExit(attempt, call.descriptor),
    });
    assert.ok(resolution?.kind === "transferred");
    expect(resolution.publisher).not.toEqual(attempt.identity);
    const before = f.durable();
    expect(permitted(f, call, control)).toBe(false);
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toHaveLength(0);
    expect(f.durable()).toEqual(before);
    expect(before.slot).toHaveLength(1);
    expect(before.jobs[0]).toMatchObject({ status: "running" });
    expect(before.attempts[0]).toMatchObject({
      producer_identity_json: JSON.stringify(attempt.identity),
      launch_ticket: attempt.launchTicket,
    });
  });

  it("requires exact ordinary identity, ticket, descriptor, times and valid stop mode", async () => {
    const f = await fixture();
    const { call, attempt } = await waiting(f);
    const check = (
      execution = call.target,
      owner = call.descriptor,
      request = call.request,
    ) => f.storage.store.canRequestStop(execution, owner, request);
    const before = f.durable();
    expect(check()).toBe(true);
    for (const execution of otherTargets(call.target))
      expect(check(execution)).toBe(false);
    expect(
      check(
        { ...call.target, launchTicket: "other-stop-ticket" },
        { ...call.descriptor, launchTicket: "other-stop-ticket" },
      ),
    ).toBe(false);
    for (const owner of [
      { ...call.descriptor, adapterId: "other-stop-adapter" },
      { ...call.descriptor, executionId: "other-stop-execution" },
      { ...call.descriptor, details: { uncommitted: true } },
    ])
      expect(check(call.target, owner)).toBe(false);
    for (const request of [
      { ...call.request, stopRequestedAt: call.request.stopRequestedAt + 1 },
      { ...call.request, terminateAfterAt: call.request.terminateAfterAt + 1 },
      { ...call.request, stopRequestedAt: -1 },
      { ...call.request, terminateAfterAt: Number.NaN },
      { ...call.request, mode: "invalid" as ExecutionStopRequest["mode"] },
    ])
      expect(check(call.target, call.descriptor, request)).toBe(false);
    expect(f.durable()).toEqual(before);
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toHaveLength(1);
    retained(f, attempt);
  });

  it("binds recovery stop permission to every control field and the original producer scope", async () => {
    const f = await fixture();
    const { call, control, attempt } = await waiting(f, true);
    assert.ok(control);
    const stop = recoveryStop(call);
    const check = (bound = control, request = stop) =>
      f.storage.store.canRequestRecoveryStop(bound, request);
    const before = f.durable();
    expect(check()).toBe(true);
    const controls: RecoveryControl[] = [
      { ...control, recoveryId: "other-stop-control" },
      { ...control, ownerInstanceId: "other-stop-controller" },
      { ...control, launchTicket: "other-stop-ticket" },
      ...(["source", "publisher"] as const).flatMap((field) =>
        otherTargets({
          identity: control[field],
          launchTicket: control.launchTicket,
        }).map(({ identity }) => ({ ...control, [field]: identity })),
      ),
    ];
    for (const bound of controls) expect(check(bound)).toBe(false);
    for (const execution of otherTargets(stop.target))
      expect(check(control, { ...stop, target: execution })).toBe(false);
    expect(
      check(control, {
        ...stop,
        target: { ...stop.target, launchTicket: "other-stop-ticket" },
        descriptor: { ...stop.descriptor, launchTicket: "other-stop-ticket" },
      }),
    ).toBe(false);
    expect(
      check(control, {
        ...stop,
        descriptor: { ...stop.descriptor, executionId: "other-stop-execution" },
      }),
    ).toBe(false);
    expect(
      check(control, { ...stop, stopRequestedAt: stop.stopRequestedAt + 1 }),
    ).toBe(false);
    expect(
      check(control, { ...stop, terminateAfterAt: stop.terminateAfterAt + 1 }),
    ).toBe(false);
    expect(
      check(control, {
        ...stop,
        mode: "invalid" as ExecutionStopRequest["mode"],
      }),
    ).toBe(false);
    expect(f.durable()).toEqual(before);
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toHaveLength(1);
    retained(f, attempt);
  });

  it.each(["claimed", "prepared"] as const)(
    "rejects a persisted ordinary stop when its attempt is only %s",
    async (phase) => {
      const f = await fixture();
      await f.submit();
      const attempt = f.storage.store.claimNext("unlaunched-stop-owner");
      assert.ok(attempt);
      const owner = descriptor(attempt);
      if (phase === "prepared")
        expect(f.storage.store.registerPrepared(attempt.identity, owner)).toBe(
          true,
        );
      expect(f.storage.store.requestStop(attempt.identity, "user_cancel")).toBe(
        true,
      );
      const active = f.storage.store.getActiveAttempt(attempt.identity)!;
      const before = f.durable();
      expect(
        f.storage.store.canRequestStop(attempt, owner, {
          mode: "soft",
          stopRequestedAt: active.stopRequestedAt!,
          terminateAfterAt: active.terminateAfterAt!,
        }),
      ).toBe(false);
      expect(f.durable()).toEqual(before);
      expect(f.calls).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "uses the strict original force cutoff for recovery=%s without changing rows",
    async (recover) => {
      const f = await fixture();
      const { call, control } = await waiting(f, recover);
      const force = {
        ...call,
        request: { ...call.request, mode: "force" as const },
      };
      const before = f.durable();
      f.storage.setNow(call.request.terminateAfterAt);
      expect(permitted(f, force, control)).toBe(false);
      f.storage.setNow(call.request.terminateAfterAt + 1);
      expect(permitted(f, force, control)).toBe(true);
      expect(permitted(f, call, control)).toBe(true);
      expect(f.durable()).toEqual(before);
    },
  );

  it("consumes a stop guard on the first denied take even when runner authority is restored", async () => {
    const f = await fixture();
    const { call, attempt } = await waiting(f);
    const original = f.bindings[0]!.store;
    const other = await storageFixture();
    cleanups.push(() => other.cleanup());
    f.bindings[0]!.store = other.store;
    expect(call.guard.takeSendPermission()).toBe(false);
    f.bindings[0]!.store = original;
    expect(call.guard.stillCurrent()).toBe(true);
    expect(call.guard.takeSendPermission()).toBe(false);
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toHaveLength(0);
    retained(f, attempt);
  });

  it("consumes a successful stop guard once without admitting a later duplicate send", async () => {
    const f = await fixture();
    const { call, attempt } = await waiting(f);
    expect(call.guard.takeSendPermission()).toBe(true);
    expect(call.guard.takeSendPermission()).toBe(false);
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toHaveLength(0);
    retained(f, attempt);
  });

  it.each([
    { recover: false, mode: "fulfill-unused" },
    { recover: false, mode: "reject-unused" },
    { recover: false, mode: "throw-unused" },
    { recover: true, mode: "fulfill-unused" },
    { recover: true, mode: "reject-unused" },
    { recover: true, mode: "throw-unused" },
  ] as const)(
    "seals an unused $mode stop guard for recovery=$recover without treating it as exit",
    async ({ mode, recover }) => {
      const f = await fixture();
      f.modes.soft = mode;
      const { runner, call, attempt } = await waiting(f, recover);
      const before = f.durable();
      f.gate.resolve();
      await f.drain();
      expect(call.guard.stillCurrent()).toBe(false);
      expect(call.guard.takeSendPermission()).toBe(false);
      await runner.wake();
      expect(f.calls).toHaveLength(1);
      expect(f.sends).toHaveLength(0);
      expect(f.durable()).toEqual(before);
      retained(f, attempt);
    },
  );

  it("can attempt force while soft acknowledgement is pending and retain the slot after a sent force rejection", async () => {
    const f = await fixture();
    const { runner, call, attempt } = await waiting(f);
    expect(f.events.map((event) => event.phase)).toEqual(["arrive"]);
    f.storage.setNow(call.request.terminateAfterAt + 1);
    f.modes.force = "send-reject";
    await runner.wake();
    await runner.wake();
    expect(f.calls.map((item) => item.request.mode)).toEqual(["soft", "force"]);
    expect(f.events.map((event) => event.phase)).toEqual(["arrive", "arrive"]);
    retained(f, attempt);
    expect(f.storage.store.claimNext("blocked-stop-owner")).toBeUndefined();
    f.gate.resolve();
    const results = await f.drain();
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(f.sends).toHaveLength(2);
    retained(f, attempt);
  });

  it.each([
    { recover: false, action: "runner close" },
    { recover: false, action: "store close" },
    { recover: false, action: "control replacement" },
    { recover: true, action: "runner close" },
    { recover: true, action: "store close" },
    { recover: true, action: "control replacement" },
  ] as const)(
    "fails closed when the final clock callback performs $action with recovery=$recover",
    async ({ recover, action }) => {
      const f = await fixture();
      const { runner, call, attempt } = await waiting(f, recover);
      f.armClock(() => {
        if (action === "runner close") void runner.close();
        else if (action === "store close") f.storage.store.close();
        else f.storage.store.beginRecovery("clock-stop-new-control");
      });
      f.gate.resolve();
      await f.drain();
      expect(f.sends).toHaveLength(0);
      expect(call.guard.takeSendPermission()).toBe(false);
      retained(f, attempt);
    },
  );

  it.each([false, true])(
    "returns false before touching a clock-closed Store for recovery=%s",
    async (recover) => {
      const f = await fixture();
      const { call, control, attempt } = await waiting(f, recover);
      f.armClock(() => f.storage.store.close());
      expect(permitted(f, call, control)).toBe(false);
      expect(permitted(f, call, control)).toBe(false);
      f.gate.resolve();
      await f.drain();
      expect(f.sends).toHaveLength(0);
      retained(f, attempt);
    },
  );

  it("reads ordinary authority after a request getter creates a real recovery control", async () => {
    const f = await fixture();
    const { call, attempt } = await waiting(f);
    let read = false;
    const request = { ...call.request };
    Object.defineProperty(request, "mode", {
      enumerable: true,
      get() {
        read = true;
        f.storage.store.beginRecovery("getter-stop-new-control");
        return call.request.mode;
      },
    });
    expect(
      f.storage.store.canRequestStop(call.target, call.descriptor, request),
    ).toBe(false);
    expect(read).toBe(true);
    const before = f.durable();
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toHaveLength(0);
    expect(f.durable()).toEqual(before);
    retained(f, attempt);
  });

  it("reads recovery authority after descriptor validation replaces the control", async () => {
    const f = await fixture();
    const { call, control, attempt } = await waiting(f, true);
    assert.ok(control);
    let changed = false;
    const owner = { ...call.descriptor };
    Object.defineProperty(owner, "details", {
      enumerable: true,
      get() {
        if (!changed) {
          changed = true;
          f.storage.store.beginRecovery("descriptor-stop-new-control");
        }
        return call.descriptor.details;
      },
    });
    expect(
      f.storage.store.canRequestRecoveryStop(control, {
        ...recoveryStop(call),
        descriptor: owner,
      }),
    ).toBe(false);
    expect(changed).toBe(true);
    const before = f.durable();
    f.gate.resolve();
    await f.drain();
    expect(f.sends).toHaveLength(0);
    expect(f.durable()).toEqual(before);
    retained(f, attempt);
  });
});
