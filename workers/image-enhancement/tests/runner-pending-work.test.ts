import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionSendGuard, Inspection } from "../src/execution.js";
import { createRunner } from "../src/runner.js";
import {
  artifactRunnerFixture,
  reachedBeforeRunnerSettled,
  type ArtifactRunnerFixture,
} from "./artifact-runner-fixtures.js";
import { authorizedRecoveryFixture } from "./authorized-recovery-fixtures.js";
import { permissionFixture } from "./execution-send-permission-fixtures.js";
import { deferred } from "./http-fixtures.js";
import { snapshot, treeExit } from "./lifecycle-fixtures.js";
import {
  observeInspection,
  recoveryFixture,
  target,
} from "./recovery-fixtures.js";

type Runner = ReturnType<typeof createRunner>;
const cleanups: (() => Promise<void>)[] = [];
const runners: Runner[] = [];
const releases: (() => void)[] = [];
const issued: Promise<unknown>[] = [];

afterEach(async () => {
  try {
    for (const runner of runners.splice(0).reverse()) await runner.close();
    for (const release of releases.splice(0)) release();
    await Promise.allSettled(issued.splice(0));
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function keep<T extends { cleanup(): Promise<void> }>(fixture: T): T {
  cleanups.push(() => fixture.cleanup());
  return fixture;
}

function own(runner: Runner) {
  runners.push(runner);
  return runner;
}

function track<T>(promise: Promise<T>): Promise<T> {
  issued.push(promise);
  void promise.catch(() => {});
  return promise;
}

// The missing additive method is asserted in each it, before starting work.
// Never import a future type or detach the method from its original receiver.
function pendingReader(runner: Runner) {
  const method: unknown = Reflect.get(runner, "pendingWork");
  expect(typeof method, "Runner exposes callable pendingWork").toBe("function");
  return () => {
    const value: unknown = Reflect.apply(method as () => unknown, runner, []);
    expect(
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
      "synchronous nonnegative safe pending count",
    ).toBe(true);
    return value as number;
  };
}

async function drained(read: () => number) {
  await vi.waitFor(() => expect(read()).toBe(0));
}

function exactProjections(runner: Runner) {
  const status = runner.status();
  expect(Object.isFrozen(status)).toBe(true);
  expect(
    isDeepStrictEqual(Object.keys(status).sort(), [
      "closed",
      "ownedState",
      "recoveryInFlight",
      "recoveryState",
      "storeClosed",
    ]),
    "original exact RunnerStatus",
  ).toBe(true);
  const readiness = runner.readiness();
  expect(Object.isFrozen(readiness)).toBe(true);
  expect(
    isDeepStrictEqual(Object.keys(readiness).sort(), [
      "ready",
      "recoveryState",
    ]),
    "original exact readiness projection",
  ).toBe(true);
  expect(readiness.ready).toBe(false);
}

async function startArtifact(f: ArtifactRunnerFixture, runner: Runner) {
  const accepted = await f.submit("pending-artifact-first");
  await track(runner.wake());
  const attempt = f.executor.launchCalls.find(
    (call) => call.identity.jobId === accepted.job.jobId,
  );
  assert.ok(attempt);
  return attempt;
}

type StopTail = Readonly<{
  before: number;
  after: number;
  beforePermission: boolean;
  afterPermission: boolean;
}>;

// Keep the real requestStop promise and native then scheduling. Observe handlers
// around their original invocation; permission and pending are never supplied
// or replaced by this helper. The live guard transition identifies its seal.
function observeStopTail(
  promise: Promise<void>,
  guard: ExecutionSendGuard,
  read: () => number,
  observations: StopTail[],
) {
  const then = promise.then;
  const invoke = (callback: unknown, rejected: boolean) => (value: unknown) => {
    const before = read();
    const beforePermission = guard.stillCurrent();
    try {
      if (typeof callback === "function")
        return Reflect.apply(callback, undefined, [value]);
      if (rejected) throw value;
      return value;
    } finally {
      observations.push({
        before,
        after: read(),
        beforePermission,
        afterPermission: guard.stillCurrent(),
      });
    }
  };
  Object.defineProperty(promise, "then", {
    configurable: true,
    value(onFulfilled: unknown, onRejected: unknown) {
      return Reflect.apply(then, promise, [
        invoke(onFulfilled, false),
        invoke(onRejected, true),
      ]);
    },
  });
  return promise;
}

describe("Runner pending original work", () => {
  it("reserves launch before prepare reentry, keeps prepare/AUTH/subscription work counted through close, and reads pending without side effects", async () => {
    const f = keep(await permissionFixture());
    releases.push(
      () => f.gates.prepare.resolve(),
      () => f.gates.authorize.resolve(),
    );
    const runner = own(f.runner);
    const read = pendingReader(runner);
    expect(read()).toBe(0);
    const entries: number[] = [];
    const prepare = f.adapter.prepare.bind(f.adapter);
    vi.spyOn(f.adapter, "prepare").mockImplementation((...args) => {
      entries.push(read());
      track(runner.wake());
      return prepare(...args);
    });
    const authorize = f.adapter.authorize.bind(f.adapter);
    vi.spyOn(f.adapter, "authorize").mockImplementation((...args) => {
      entries.push(read());
      return authorize(...args);
    });
    f.hooks.observe = () => entries.push(read());
    await f.submit();
    const work = track(runner.wake());
    await f.arrive("prepare", work);
    expect(isDeepStrictEqual(entries, [1])).toBe(true);
    expect(read()).toBe(1);
    const probes = [
      vi.spyOn(f.time.clock, "now"),
      vi.spyOn(f.time.clock, "scheduleAt"),
      vi.spyOn(f.storage.store, "getActiveAttempt"),
      vi.spyOn(f.storage.store, "claimNext"),
      vi.spyOn(f.storage.store, "renewLease"),
      vi.spyOn(f.storage.store, "requestStop"),
      vi.spyOn(f.storage.store, "registerPrepared"),
      vi.spyOn(f.storage.store, "authorizeLaunch"),
      vi.spyOn(f.storage.store, "registerExit"),
      vi.spyOn(f.storage.store, "beginRecovery"),
      vi.spyOn(f.adapter, "inspect"),
      vi.spyOn(f.adapter, "requestStop"),
    ];
    const beforeRead = f.durable();
    const timers = f.time.entries.length;
    const calls = [f.calls.prepare.length, f.calls.authorize.length];
    for (let index = 0; index < 3; index++) expect(read()).toBe(1);
    await Promise.resolve();
    expect(probes.every((probe) => probe.mock.calls.length === 0)).toBe(true);
    expect(f.time.entries.length).toBe(timers);
    expect(
      isDeepStrictEqual(
        [f.calls.prepare.length, f.calls.authorize.length],
        calls,
      ),
    ).toBe(true);
    expect(isDeepStrictEqual(f.durable(), beforeRead)).toBe(true);
    exactProjections(runner);
    f.gates.prepare.resolve();
    const authorization = await f.arrive("authorize", work);
    expect(entries.length).toBe(3);
    expect(entries.every((value) => value === 1)).toBe(true);
    expect(read()).toBe(1);
    const beforeClose = f.durable();
    await runner.close();
    expect(authorization.guard.signal.aborted).toBe(true);
    expect(read()).toBe(1);
    expect(runner.status().closed).toBe(true);
    expect(isDeepStrictEqual(f.durable(), beforeClose)).toBe(true);
    f.gates.authorize.resolve();
    await expect(work).rejects.toMatchObject({ code: "not_ready" });
    await drained(read);
    expect(f.sends.authorize.length).toBe(0);
    expect(isDeepStrictEqual(f.durable(), beforeClose)).toBe(true);
    exactProjections(runner);
  }, 15_000);

  it("counts a shared recovery before inspect reentry, adds no work for joins, and retains its late rejection after close", async () => {
    const f = keep(await recoveryFixture());
    const runner = own(f.runner());
    const read = pendingReader(runner);
    const attempt = await f.claim("authorized");
    const gate = deferred<Inspection>();
    releases.push(() => gate.resolve({ kind: "unknown", ...target(attempt) }));
    let nested: Promise<void> | undefined;
    f.executor.hooks.inspect = () => {
      expect(read()).toBe(1);
      nested = track(runner.recover());
      return gate.promise;
    };
    const first = track(runner.recover());
    expect(read()).toBe(1);
    const concurrent = track(runner.recover());
    expect(concurrent === first).toBe(true);
    expect(read()).toBe(1);
    await observeInspection(f.executor, first);
    assert.ok(nested);
    expect(nested === first).toBe(true);
    expect(f.executor.inspectCalls.length).toBe(1);
    const before = snapshot(f.storage, (db) => ({
      slot: db.prepare("SELECT * FROM execution_slot").all(),
      attempts: db.prepare("SELECT * FROM attempts").all(),
      controls: db.prepare("SELECT * FROM recovery_controls").all(),
    }));
    await runner.close();
    expect(read()).toBe(1);
    gate.resolve(
      Promise.reject(new Error("private-controlled-inspection-reply-lost")),
    );
    const results = await Promise.allSettled([first, concurrent, nested]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    await drained(read);
    expect(
      isDeepStrictEqual(
        snapshot(f.storage, (db) => ({
          slot: db.prepare("SELECT * FROM execution_slot").all(),
          attempts: db.prepare("SELECT * FROM attempts").all(),
          controls: db.prepare("SELECT * FROM recovery_controls").all(),
        })),
        before,
      ),
    ).toBe(true);
    expect(f.executor.inspectCalls.length).toBe(1);
    expect(f.executor.stopCalls.length).toBe(0);
    exactProjections(runner);
  }, 15_000);

  it("counts real artifact reads and durability stages through afterArtifacts and the next launch without counting cached wake joins", async () => {
    const f = keep(await artifactRunnerFixture());
    const runner = own(f.runner());
    const read = pendingReader(runner);
    const attempt = await startArtifact(f, runner);
    await drained(read);
    const waiting = await f.submit("pending-artifact-next");
    const engine = f.gate(
      (event) =>
        event.stage === "open" &&
        event.path === attempt.inputPath &&
        event.flags === "r",
    );
    const durable = f.gate(
      (event) =>
        event.stage === "directory_sync" && event.path === f.storage.directory,
    );
    releases.push(engine.release, durable.release);
    const nextReached = deferred();
    const nextRelease = deferred();
    releases.push(() => nextRelease.resolve());
    f.executor.hooks.prepare = async (next, owner) => {
      if (next.identity.jobId === waiting.job.jobId) {
        expect(read()).toBeGreaterThanOrEqual(2);
        nextReached.resolve();
        await nextRelease.promise;
      }
      return owner;
    };
    const finish = f.storage.store.finishSucceeded.bind(f.storage.store);
    const getActive = f.storage.store.getActiveAttempt.bind(f.storage.store);
    let committed = false;
    let afterArtifactsPending: number | undefined;
    vi.spyOn(f.storage.store, "finishSucceeded").mockImplementation(
      (...args) => {
        const applied = finish(...args);
        if (applied) committed = true;
        return applied;
      },
    );
    vi.spyOn(f.storage.store, "getActiveAttempt").mockImplementation(
      (identity) => {
        const active = getActive(identity);
        if (
          committed &&
          identity.jobId === attempt.identity.jobId &&
          active === undefined &&
          afterArtifactsPending === undefined
        )
          afterArtifactsPending = read();
        return active;
      },
    );
    await f.emitSuccess(attempt);
    const work = track(runner.wake());
    await reachedBeforeRunnerSettled(engine, work);
    expect(read()).toBe(1);
    const shared = track(runner.wake());
    expect(shared === work).toBe(true);
    expect(read()).toBe(1);
    const events = f.events.length;
    const facts = f.rows();
    for (let index = 0; index < 3; index++) expect(read()).toBe(1);
    expect(f.events.length).toBe(events);
    expect(isDeepStrictEqual(f.rows(), facts)).toBe(true);
    engine.release();
    await reachedBeforeRunnerSettled(durable, work);
    expect(read()).toBe(1);
    expect(f.job(attempt.identity.jobId).status).toBe("running");
    expect(f.rows().references[0]!.released_at).toBeNull();
    let returned = false;
    void work.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      },
    );
    durable.release();
    await Promise.race([
      nextReached.promise,
      work.then(() => {
        throw new Error("artifact tail returned before its next prepare");
      }),
    ]);
    expect(afterArtifactsPending).toBeGreaterThan(0);
    expect(returned).toBe(false);
    expect(read()).toBeGreaterThanOrEqual(2);
    expect(f.job(attempt.identity.jobId).status).toBe("succeeded");
    expect(f.rows().references[0]!.released_at).not.toBeNull();
    nextRelease.resolve();
    await Promise.all([work, shared]);
    await drained(read);
    expect(f.job(waiting.job.jobId).status).toBe("running");
    expect(f.executor.launchCalls.length).toBe(2);
    exactProjections(runner);
  }, 15_000);

  it("keeps an old artifact chain counted after holder retirement, then through close until its issued file really closes", async () => {
    const f = keep(await artifactRunnerFixture());
    const runner = own(f.runner());
    const read = pendingReader(runner);
    const attempt = await startArtifact(f, runner);
    const gate = f.gate(
      (event) =>
        event.stage === "open" &&
        event.path === attempt.inputPath &&
        event.flags === "r",
    );
    releases.push(gate.release);
    await f.emitSuccess(attempt);
    const work = track(runner.wake());
    const opened = await reachedBeforeRunnerSettled(gate, work);
    assert.ok(opened.file);
    expect(read()).toBe(1);
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    await track(runner.wake());
    expect(f.job(attempt.identity.jobId).status).toBe("cancelled");
    expect(runner.status().ownedState).toBe("none");
    expect(f.rows().slot.length).toBe(0);
    expect(f.rows().references[0]!.released_at).toBeNull();
    expect(read()).toBe(1);
    await runner.close();
    f.storage.store.close();
    const facts = f.rows();
    const beforeClose = f.events.length;
    expect(read()).toBe(1);
    gate.release();
    await work;
    await drained(read);
    expect(isDeepStrictEqual(f.rows(), facts)).toBe(true);
    expect(
      isDeepStrictEqual(
        f.events
          .slice(beforeClose)
          .map(({ phase, event }) => [phase, event.stage]),
        [
          ["before", "close"],
          ["after", "close"],
        ],
      ),
    ).toBe(true);
    await expect(opened.file.stat()).rejects.toBeInstanceOf(Error);
    expect(f.rows().references[0]!.released_at).toBeNull();
    exactProjections(runner);
  }, 15_000);

  it("does not keep a fulfilled blocked artifact cache pending or rerun its original I/O on later wakes", async () => {
    const f = keep(await artifactRunnerFixture());
    const runner = own(f.runner());
    const read = pendingReader(runner);
    const attempt = await startArtifact(f, runner);
    const acquire = vi.spyOn(f.storage.store, "acquireArtifactWork");
    let failed = false;
    f.hooks.after = async (event) => {
      if (
        !failed &&
        event.stage === "mkdir" &&
        event.role === "candidate-directory"
      ) {
        failed = true;
        throw Object.assign(new Error("private-mkdir-acknowledgement-lost"), {
          code: "EIO",
        });
      }
    };
    await f.emitSuccess(attempt);
    const cached = track(runner.wake());
    await cached;
    expect(failed).toBe(true);
    await drained(read);
    expect(f.job(attempt.identity.jobId).status).toBe("running");
    expect(f.rows().slot.length).toBe(1);
    expect(runner.status().ownedState).toBe("busy");
    const facts = f.rows();
    const events = f.events.length;
    const repeated = track(runner.wake());
    expect(repeated === cached).toBe(true);
    expect(read()).toBe(0);
    await repeated;
    await track(runner.recover());
    await track(runner.wake());
    await drained(read);
    expect(acquire.mock.calls.length).toBe(1);
    expect(f.events.length).toBe(events);
    expect(isDeepStrictEqual(f.rows(), facts)).toBe(true);
    exactProjections(runner);
  }, 15_000);

  it("counts real recoverArtifacts and its canonical interruption reader after close without starting a late replacement", async () => {
    const f = keep(await authorizedRecoveryFixture());
    const producer = own(
      createRunner({
        store: f.storage.store,
        clock: f.time.clock,
        executor: f.executor.adapter,
        artifactFiles: f.actualFiles,
        ownerInstanceId: "pending-durable-producer",
      }),
    );
    const producerRead = pendingReader(producer);
    await f.submit();
    await track(producer.wake());
    await drained(producerRead);
    const original = f.allLaunchCalls[0];
    assert.ok(original);
    await producer.close();
    await f.executor.loseController(target(original));
    await f.reopen();
    const runner = own(
      createRunner({
        store: f.storage.store,
        clock: f.time.clock,
        executor: f.executor.adapter,
        artifactFiles: f.actualFiles,
        ownerInstanceId: "pending-durable-recovery",
      }),
    );
    const read = pendingReader(runner);
    const gate = f.gate(
      (event) =>
        event.operation === "reader" &&
        event.role === "authorization" &&
        event.stage === "read" &&
        event.phase === "after" &&
        (event.bytesRead ?? 0) > 0,
    );
    releases.push(gate.release);
    f.executor.hooks.after = gate.hook;
    const work = track(runner.recover());
    await Promise.race([
      gate.reached,
      work.then(() => {
        throw new Error("recoverArtifacts returned before its real reader");
      }),
    ]);
    expect(f.restartCalls.length).toBe(1);
    expect(f.artifactEvents.some((event) => event.stage === "read")).toBe(true);
    expect(read()).toBeGreaterThanOrEqual(2);
    const shared = track(runner.recover());
    expect(shared === work).toBe(true);
    const count = read();
    expect(read()).toBe(count);
    const before = snapshot(f.storage, (db) => ({
      jobs: db.prepare("SELECT * FROM jobs").all(),
      attempts: db.prepare("SELECT * FROM attempts").all(),
      slot: db.prepare("SELECT * FROM execution_slot").all(),
      references: db.prepare("SELECT * FROM artifact_references").all(),
      events: db.prepare("SELECT * FROM recovery_events").all(),
    }));
    await runner.close();
    expect(read()).toBe(count);
    gate.release();
    await Promise.all([work, shared]);
    await drained(read);
    expect(f.allLaunchCalls.length).toBe(1);
    expect(
      isDeepStrictEqual(
        snapshot(f.storage, (db) => ({
          jobs: db.prepare("SELECT * FROM jobs").all(),
          attempts: db.prepare("SELECT * FROM attempts").all(),
          slot: db.prepare("SELECT * FROM execution_slot").all(),
          references: db.prepare("SELECT * FROM artifact_references").all(),
          events: db.prepare("SELECT * FROM recovery_events").all(),
        })),
        before,
      ),
    ).toBe(true);
    exactProjections(runner);
  }, 15_000);

  it("keeps owned detached stop pending through its real guard seal and pairs a later synchronous force throw", async () => {
    const f = keep(await recoveryFixture());
    const runner = own(f.runner());
    const read = pendingReader(runner);
    await f.submit();
    await track(runner.wake());
    await drained(read);
    const attempt = f.executor.launchCalls[0]!;
    const acknowledgement = deferred();
    releases.push(() => acknowledgement.resolve());
    f.executor.hooks.stop = () => acknowledgement.promise;
    const stop = f.executor.adapter.requestStop.bind(f.executor.adapter);
    const tails: StopTail[] = [];
    const guards: ExecutionSendGuard[] = [];
    vi.spyOn(f.executor.adapter, "requestStop").mockImplementation(
      (...args) => {
        expect(read()).toBeGreaterThan(0);
        guards.push(args[3]);
        const actual = track(stop(...args));
        if (args[2].mode === "force")
          throw new Error("private-stop-threw-after-controlled-dispatch");
        return observeStopTail(actual, args[3], read, tails);
      },
    );
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    await track(runner.wake());
    expect(read()).toBe(1);
    expect(guards[0]!.stillCurrent()).toBe(true);
    await track(runner.wake());
    expect(f.executor.stopCalls.length).toBe(1);
    expect(read()).toBe(1);
    const before = snapshot(f.storage, (db) => ({
      jobs: db.prepare("SELECT * FROM jobs").all(),
      attempts: db.prepare("SELECT * FROM attempts").all(),
      slot: db.prepare("SELECT * FROM execution_slot").all(),
    }));
    acknowledgement.resolve();
    await drained(read);
    const seals = tails.filter(
      (tail) => tail.beforePermission && !tail.afterPermission,
    );
    expect(seals.length).toBeGreaterThan(0);
    expect(seals.every((tail) => tail.before > 0)).toBe(true);
    expect(guards[0]!.stillCurrent()).toBe(false);
    expect(
      isDeepStrictEqual(
        snapshot(f.storage, (db) => ({
          jobs: db.prepare("SELECT * FROM jobs").all(),
          attempts: db.prepare("SELECT * FROM attempts").all(),
          slot: db.prepare("SELECT * FROM execution_slot").all(),
        })),
        before,
      ),
    ).toBe(true);
    const active = f.storage.store.getActiveAttempt(attempt.identity)!;
    f.storage.setNow(active.terminateAfterAt! + 1);
    await track(runner.wake());
    await drained(read);
    expect(
      isDeepStrictEqual(
        f.executor.stopCalls.map((call) => call.mode),
        ["soft", "force"],
      ),
    ).toBe(true);
    expect(guards[1]!.stillCurrent()).toBe(false);
    expect(
      f.storage.store.getOwned(f.storage.principal(), attempt.identity.jobId)
        .status,
    ).toBe("running");
    exactProjections(runner);
  }, 15_000);

  it("keeps recovery detached stop pending after its old holder and slot end, then drains its real rejection without retrying", async () => {
    const f = keep(await recoveryFixture());
    const runner = own(
      createRunner({
        store: f.storage.store,
        clock: f.time.clock,
        executor: f.executor.adapter,
        ownerInstanceId: "pending-recovery-stop",
        claimSelection: () => "none",
      }),
    );
    const read = pendingReader(runner);
    const attempt = await f.claim("authorized");
    const waiting = await f.submit("pending-stop-waiting");
    f.storage.service().cancel(f.storage.principal(), attempt.identity.jobId);
    const acknowledgement = deferred();
    releases.push(() => acknowledgement.resolve());
    f.executor.hooks.stop = () => acknowledgement.promise;
    const stop = f.executor.adapter.requestStop.bind(f.executor.adapter);
    const guards: ExecutionSendGuard[] = [];
    vi.spyOn(f.executor.adapter, "requestStop").mockImplementation(
      (...args) => {
        expect(read()).toBeGreaterThan(0);
        guards.push(args[3]);
        return track(stop(...args));
      },
    );
    await track(runner.recover());
    expect(runner.readiness().recoveryState).toBe("owned-alive");
    expect(read()).toBe(1);
    expect(f.executor.stopCalls.length).toBe(1);
    f.executor.emit(treeExit(attempt));
    await track(runner.wake());
    await vi.waitFor(() => expect(runner.status().ownedState).toBe("none"));
    expect(
      f.storage.store.getOwned(f.storage.principal(), attempt.identity.jobId)
        .status,
    ).toBe("cancelled");
    expect(
      snapshot(f.storage, (db) =>
        db.prepare("SELECT * FROM execution_slot").all(),
      ).length,
    ).toBe(0);
    expect(read()).toBe(1);
    expect(
      f.storage.store.getOwned(f.storage.principal(), waiting.job.jobId).status,
    ).toBe("queued");
    const before = snapshot(f.storage, (db) => ({
      jobs: db.prepare("SELECT * FROM jobs").all(),
      attempts: db.prepare("SELECT * FROM attempts").all(),
      controls: db.prepare("SELECT * FROM recovery_controls").all(),
      slot: db.prepare("SELECT * FROM execution_slot").all(),
    }));
    await runner.close();
    expect(read()).toBe(1);
    acknowledgement.resolve(
      Promise.reject(new Error("private-recovery-stop-reply-lost")),
    );
    await drained(read);
    expect(guards[0]!.stillCurrent()).toBe(false);
    expect(f.executor.stopCalls.length).toBe(1);
    expect(f.executor.inspectCalls.length).toBe(1);
    expect(
      isDeepStrictEqual(
        snapshot(f.storage, (db) => ({
          jobs: db.prepare("SELECT * FROM jobs").all(),
          attempts: db.prepare("SELECT * FROM attempts").all(),
          controls: db.prepare("SELECT * FROM recovery_controls").all(),
          slot: db.prepare("SELECT * FROM execution_slot").all(),
        })),
        before,
      ),
    ).toBe(true);
    exactProjections(runner);
  }, 15_000);

  it.each(["prepare-sync", "authorize-reject"] as const)(
    "pairs %s launch failure without clearing the original Unknown slot",
    async (mode) => {
      const f = keep(await permissionFixture());
      releases.push(
        () => f.gates.prepare.resolve(),
        () => f.gates.authorize.resolve(),
      );
      const runner = own(f.runner);
      const read = pendingReader(runner);
      const entries: number[] = [];
      if (mode === "prepare-sync") {
        f.modes.prepare = "send-throw-sync";
        const prepare = f.adapter.prepare.bind(f.adapter);
        vi.spyOn(f.adapter, "prepare").mockImplementation((...args) => {
          entries.push(read());
          return prepare(...args);
        });
      } else {
        f.modes.authorize = "reject-unused";
        f.gates.prepare.resolve();
        const authorize = f.adapter.authorize.bind(f.adapter);
        vi.spyOn(f.adapter, "authorize").mockImplementation((...args) => {
          entries.push(read());
          return authorize(...args);
        });
      }
      await f.submit();
      const work = track(runner.wake());
      if (mode === "authorize-reject") {
        await f.arrive("authorize", work);
        expect(read()).toBe(1);
        f.gates.authorize.resolve();
      }
      await expect(work).rejects.toMatchObject({
        code: mode === "prepare-sync" ? "internal_error" : "not_ready",
      });
      await drained(read);
      expect(isDeepStrictEqual(entries, [1])).toBe(true);
      expect(runner.status().ownedState).toBe("unknown");
      const facts = f.durable();
      expect(facts.slot.length).toBe(1);
      const call =
        mode === "prepare-sync" ? f.calls.prepare[0]! : f.calls.authorize[0]!;
      expect(call.guard.stillCurrent()).toBe(false);
      for (let index = 0; index < 3; index++) expect(read()).toBe(0);
      expect(isDeepStrictEqual(f.durable(), facts)).toBe(true);
      exactProjections(runner);
    },
    15_000,
  );
});
