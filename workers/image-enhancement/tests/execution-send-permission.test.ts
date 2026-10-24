import { afterEach, describe, expect, it, vi } from "vitest";

import { EnhancementError } from "../src/contracts.js";
import type { AttemptIdentity, OwnerDescriptor } from "../src/execution.js";
import { openStore } from "../src/store.js";
import { deferred } from "./http-fixtures.js";
import {
  commitFault,
  descriptor,
  snapshot,
  treeExit,
} from "./lifecycle-fixtures.js";
import { runnerLimits } from "./storage-fixtures.js";
import {
  permissionFixture,
  type PermissionFixture,
  type SendCall,
  type SendPhase,
} from "./execution-send-permission-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(configure?: Parameters<typeof permissionFixture>[0]) {
  const f = await permissionFixture(configure);
  cleanups.push(() => f.cleanup());
  return f;
}
async function waiting(f: PermissionFixture, phase: SendPhase) {
  await f.submit();
  if (phase === "authorize") f.gates.prepare.resolve();
  const wake = f.track(f.runner.wake());
  return { wake, call: await f.arrive(phase, wake) };
}
function release(f: PermissionFixture) {
  f.gates.prepare.resolve();
  f.gates.authorize.resolve();
}
function permission(f: PermissionFixture, call: SendCall, phase: SendPhase) {
  return phase === "prepare"
    ? f.storage.store.canPrepareAttempt(
        call.attempt.identity,
        call.attempt.launchTicket,
      )
    : f.storage.store.canAuthorizeLaunch(
        call.attempt.identity,
        call.attempt.launchTicket,
        call.owner,
      );
}
function retained(f: PermissionFixture, call: SendCall, authorized: boolean) {
  expect(
    snapshot(f.storage, (db) =>
      db
        .prepare(
          "SELECT owner_instance_id, fence, launch_ticket, authorized_at, exit_json, sealed_at FROM attempts",
        )
        .get(),
    ),
  ).toEqual({
    owner_instance_id: call.attempt.identity.ownerInstanceId,
    fence: call.attempt.identity.fence,
    launch_ticket: call.attempt.launchTicket,
    authorized_at: authorized ? 1_000 : null,
    exit_json: null,
    sealed_at: null,
  });
  expect(f.durable().slot).toHaveLength(1);
  expect(
    f.storage.store.claimNext("blocked-send-permission-owner"),
  ).toBeUndefined();
}

describe("fresh single-use execution send permission", () => {
  it("carries separate frozen prepare and AUTH guards through each last await", async () => {
    const f = await fixture();
    const { wake, call: prepare } = await waiting(f, "prepare");
    expect(
      prepare.guard,
      "prepare must receive its final-send guard",
    ).toBeDefined();
    expect(Object.isFrozen(prepare.guard)).toBe(true);
    expect(prepare.guard.stillCurrent()).toBe(true);
    expect(f.sends.prepare).toHaveLength(0);
    expect(f.sends.authorize).toHaveLength(0);
    f.gates.prepare.resolve();
    const auth = await f.arrive("authorize", wake);
    expect(auth.guard).not.toBe(prepare.guard);
    expect(Object.isFrozen(auth.guard)).toBe(true);
    expect(Object.isFrozen(auth.owner)).toBe(true);
    expect(auth.guard.stillCurrent()).toBe(true);
    expect(prepare.guard.stillCurrent()).toBe(false);
    expect(f.sends.prepare).toHaveLength(1);
    expect(f.observers).toHaveLength(1);
    expect(
      f.storage.store.getActiveAttempt(auth.attempt.identity),
    ).toMatchObject({
      ownerDescriptor: auth.owner,
      preparedAt: 1_000,
      authorizedAt: 1_000,
    });
    f.hooks.beforeSend = (phase) => {
      if (phase === "authorize") {
        expect(f.observers).toHaveLength(1);
        expect(f.durable().attempts[0]).toMatchObject({ authorized_at: 1_000 });
      }
    };
    release(f);
    await wake;
    expect(f.sends.authorize).toHaveLength(1);
    expect(auth.guard.takeSendPermission()).toBe(false);
    await f.runner.wake();
    expect(f.calls.prepare).toHaveLength(1);
    expect(f.calls.authorize).toHaveLength(1);
    retained(f, auth, true);
  });

  it.each(["prepare", "authorize"] as const)(
    "rejects cancellation during the %s wait without inventing terminal proof",
    async (phase) => {
      const f = await fixture();
      const { wake, call } = await waiting(f, phase);
      f.cancel(call);
      const before = f.durable();
      release(f);
      await expect(wake).rejects.toMatchObject({ code: "not_ready" });
      expect(f.sends[phase]).toHaveLength(0);
      expect(f.sends.authorize).toHaveLength(0);
      expect(f.durable()).toEqual(before);
      retained(f, call, phase === "authorize");
    },
  );

  it.each(
    (["prepare", "authorize"] as const).flatMap((phase) =>
      (["lease", "execution"] as const).flatMap((deadline) =>
        [-1, 0, 1].map((offset) => ({ phase, deadline, offset })),
      ),
    ),
  )(
    "checks $phase $deadline offset $offset without timer delivery",
    async ({ phase, deadline, offset }) => {
      const f = await fixture((storage) => {
        if (deadline === "execution")
          storage.setRunnerLimits({
            ...runnerLimits,
            executionTimeoutMs: runnerLimits.heartbeatIntervalMs,
          });
      });
      const { wake, call } = await waiting(f, phase);
      f.storage.setNow(
        (deadline === "lease"
          ? call.attempt.leaseExpiresAt
          : call.attempt.executionDeadlineAt) + offset,
      );
      const before = f.durable();
      // This permission read neither delivers scheduled callbacks nor renews leases.
      expect(permission(f, call, phase)).toBe(offset <= 0);
      expect(f.durable()).toEqual(before);
      release(f);
      if (offset <= 0) await wake;
      else await expect(wake).rejects.toMatchObject({ code: "not_ready" });
      expect(f.sends[phase]).toHaveLength(offset <= 0 ? 1 : 0);
      expect(f.durable().jobs[0]).toMatchObject({
        execution_deadline_at: call.attempt.executionDeadlineAt,
      });
    },
  );

  it.each(["prepare", "authorize"] as const)(
    "uses the renewed durable lease during %s",
    async (phase) => {
      const f = await fixture();
      const { wake, call } = await waiting(f, phase);
      f.storage.setNow(call.attempt.leaseExpiresAt);
      expect(f.storage.store.renewLease(call.attempt.identity)).toBe(true);
      f.storage.setNow(call.attempt.leaseExpiresAt + 1);
      const before = f.durable();
      expect(permission(f, call, phase)).toBe(true);
      expect(call.guard.stillCurrent()).toBe(true);
      expect(f.durable()).toEqual(before);
      release(f);
      await wake;
      expect(f.sends[phase]).toHaveLength(1);
      expect(
        f.storage.store.getActiveAttempt(call.attempt.identity),
      ).toMatchObject({
        leaseExpiresAt:
          call.attempt.leaseExpiresAt + runnerLimits.leaseDurationMs,
        executionDeadlineAt: call.attempt.executionDeadlineAt,
      });
    },
  );

  it.each(["prepare", "authorize"] as const)(
    "rejects an active recovery control during %s with tuple and slot intact",
    async (phase) => {
      const f = await fixture();
      const { wake, call } = await waiting(f, phase);
      const control = f.storage.store.beginRecovery(
        "competing-send-permission-owner",
      );
      expect(control?.target.identity).toEqual(call.attempt.identity);
      expect(
        f.storage.store.getActiveAttempt(call.attempt.identity),
      ).toBeDefined();
      const before = f.durable();
      release(f);
      await expect(wake).rejects.toMatchObject({ code: "not_ready" });
      expect(f.sends[phase]).toHaveLength(0);
      expect(f.durable()).toEqual(before);
      expect(f.storage.store.renewLease(call.attempt.identity)).toBe(false);
      retained(f, call, phase === "authorize");
    },
  );

  it.each(
    (["prepare", "authorize"] as const).flatMap((phase) =>
      (["runner-close", "store-close", "store-replaced"] as const).map(
        (action) => ({ phase, action }),
      ),
    ),
  )("rejects $phase after $action", async ({ phase, action }) => {
    const f = await fixture();
    const { wake, call } = await waiting(f, phase);
    const original = f.storage.store;
    if (action === "runner-close") await f.runner.close();
    else {
      original.close();
      if (action === "store-replaced") {
        f.storage.setStore(
          openStore({ directory: f.storage.directory, clock: f.storage.clock }),
        );
        f.options.store = f.storage.store;
        expect(
          f.storage.store.getActiveAttempt(call.attempt.identity),
        ).toBeDefined();
      }
    }
    expect(call.guard.signal.aborted).toBe(action === "runner-close");
    expect(call.guard.stillCurrent()).toBe(false);
    release(f);
    await expect(wake).rejects.toMatchObject({ code: "not_ready" });
    expect(f.sends[phase]).toHaveLength(0);
    expect(f.durable().slot).toHaveLength(1);
  });

  it.each(["prepare", "authorize"] as const)(
    "rejects a different live Store substituted inside the %s predicate",
    async (phase) => {
      const f = await fixture();
      const { wake, call } = await waiting(f, phase);
      const other = await fixture();
      const original = f.storage.store;
      const method =
        phase === "prepare" ? "canPrepareAttempt" : "canAuthorizeLaunch";
      const read = original[method].bind(original) as (
        ...args: never[]
      ) => boolean;
      vi.spyOn(original, method).mockImplementationOnce(((...args: never[]) => {
        const allowed = read(...args);
        f.options.store = other.storage.store;
        return allowed;
      }) as (typeof original)[typeof method]);
      expect(call.guard.takeSendPermission()).toBe(false);
      f.options.store = original;
      expect(call.guard.stillCurrent()).toBe(true);
      expect(call.guard.takeSendPermission()).toBe(false);
      release(f);
      await expect(wake).rejects.toMatchObject({ code: "not_ready" });
      expect(f.sends[phase]).toHaveLength(0);
    },
  );

  it.each(["prepare", "authorize"] as const)(
    "rejects a live Store substituted before the %s predicate",
    async (phase) => {
      const f = await fixture();
      const { wake, call } = await waiting(f, phase);
      const other = await fixture();
      const before = f.durable();
      f.options.store = other.storage.store;
      expect(f.storage.store.closed).toBe(false);
      expect(call.guard.stillCurrent()).toBe(false);
      release(f);
      await expect(wake).rejects.toMatchObject({ code: "not_ready" });
      expect(f.sends[phase]).toHaveLength(0);
      expect(f.durable()).toEqual(before);
    },
  );

  it.each(["prepare", "authorize"] as const)(
    "consumes before reentrant %s permission reads",
    async (phase) => {
      const f = await fixture();
      const { wake, call } = await waiting(f, phase);
      const original = f.storage.store;
      const method =
        phase === "prepare" ? "canPrepareAttempt" : "canAuthorizeLaunch";
      const read = original[method].bind(original) as (
        ...args: never[]
      ) => boolean;
      const nested: boolean[] = [];
      vi.spyOn(original, method).mockImplementation(((...args: never[]) => {
        nested.push(call.guard.takeSendPermission());
        return read(...args);
      }) as (typeof original)[typeof method]);
      release(f);
      await wake;
      expect(nested[0]).toBe(false);
      expect(f.sends[phase]).toHaveLength(1);
      expect(call.guard.takeSendPermission()).toBe(false);
    },
  );

  it.each(
    (["prepare", "authorize"] as const).flatMap((phase) =>
      (["false", "throw"] as const).map((fault) => ({ phase, fault })),
    ),
  )(
    "consumes the first $phase attempt even when the predicate returns $fault",
    async ({ phase, fault }) => {
      const f = await fixture();
      const { wake, call } = await waiting(f, phase);
      if (fault === "throw")
        f.armClock(() => {
          throw new Error("permission-read-fault");
        });
      else f.storage.setNow(call.attempt.leaseExpiresAt + 1);
      expect(call.guard.takeSendPermission()).toBe(false);
      f.storage.setNow(1_000);
      expect(permission(f, call, phase)).toBe(true);
      expect(call.guard.stillCurrent()).toBe(true);
      expect(call.guard.takeSendPermission()).toBe(false);
      release(f);
      await expect(wake).rejects.toMatchObject({ code: "not_ready" });
      expect(f.sends[phase]).toHaveLength(0);
    },
  );

  it.each(
    (["prepare", "authorize"] as const).flatMap((phase) =>
      (["fulfill-unused", "reject-unused", "throw-unused"] as const).map(
        (mode) => ({ phase, mode }),
      ),
    ),
  )(
    "seals an unconsumed $phase guard after runner-observed $mode settlement",
    async ({ phase, mode }) => {
      const f = await fixture();
      f.modes[phase] = mode;
      if (phase === "prepare" && mode === "fulfill-unused") {
        // Deliberately malformed result keeps canPrepare true after fulfillment.
        f.hooks.preparedResult = () => null as unknown as OwnerDescriptor;
      }
      const { wake, call } = await waiting(f, phase);
      release(f);
      if (mode === "fulfill-unused" && phase === "authorize") await wake;
      else await expect(wake).rejects.toBeInstanceOf(EnhancementError);
      expect(permission(f, call, phase)).toBe(true);
      expect(call.guard.stillCurrent()).toBe(false);
      expect(call.guard.takeSendPermission()).toBe(false);
      expect(f.sends[phase]).toHaveLength(0);
      retained(f, call, phase === "authorize");
    },
  );

  it.each(["cancel", "close", "recover", "exit"] as const)(
    "checks fresh AUTH entry after a synchronous observeExit %s",
    async (action) => {
      const f = await fixture();
      f.hooks.observe = (call, listener) => {
        expect(f.durable().attempts[0]).toMatchObject({ authorized_at: 1_000 });
        if (action === "cancel") f.cancel(call);
        if (action === "close") void f.runner.close();
        if (action === "recover")
          f.storage.store.beginRecovery("subscription-recovery-owner");
        if (action === "exit") listener(treeExit(call.attempt, call.owner));
      };
      await f.submit();
      release(f);
      await f.runner.wake();
      expect(f.calls.authorize).toHaveLength(0);
      expect(f.sends.authorize).toHaveLength(0);
      expect(f.durable().attempts[0]).toMatchObject({ authorized_at: 1_000 });
      expect(f.durable().slot).toHaveLength(1);
    },
  );

  it.each(
    (["prepare", "authorize"] as const).flatMap((phase) =>
      (["throw", "reject", "lost-ack"] as const).map((fault) => ({
        phase,
        fault,
      })),
    ),
  )(
    "retains one launch after admitted $phase $fault",
    async ({ phase, fault }) => {
      const f = await fixture();
      const ack = deferred();
      f.releaseOnCleanup(() => ack.resolve());
      if (fault === "throw") f.modes[phase] = "send-throw-sync";
      f.hooks.afterSend = (sentPhase) => {
        if (sentPhase !== phase) return;
        if (fault === "reject")
          return Promise.reject(new Error("synthetic-ack-rejected"));
        return ack.promise;
      };
      const { wake, call } = await waiting(f, phase);
      release(f);
      await Promise.race([f.dispatches[phase].promise, wake]);
      expect(f.sends[phase]).toHaveLength(1);
      const repeated = f.track(f.runner.wake());
      expect(f.calls[phase]).toHaveLength(1);
      expect(call.guard.takeSendPermission()).toBe(false);
      if (fault === "lost-ack") ack.resolve();
      await Promise.allSettled([wake, repeated]);
      retained(f, call, phase === "authorize" || fault === "lost-ack");
      await f.runner.wake();
      expect(f.sends[phase]).toHaveLength(1);
    },
  );

  it("names cancellation after admission as a race and requires exact terminal proof", async () => {
    const f = await fixture();
    f.hooks.afterSend = (phase, call) => {
      if (phase === "authorize") f.cancel(call);
    };
    const { wake, call } = await waiting(f, "authorize");
    release(f);
    await wake;
    expect(f.sends.authorize).toHaveLength(1);
    await f.runner.wake();
    expect(f.stops.map((item) => item.mode)).toEqual(["soft"]);
    retained(f, call, true);
    expect(
      f.storage.store.registerExit({
        ...treeExit(call.attempt, call.owner),
        launchTicket: "wrong-send-permission-ticket",
      }),
    ).toBe(false);
    expect(f.storage.store.finishCancelled(call.attempt.identity)).toBe(false);
    retained(f, call, true);
    expect(
      f.storage.store.registerExit(treeExit(call.attempt, call.owner)),
    ).toBe(true);
    expect(f.storage.store.finishCancelled(call.attempt.identity)).toBe(true);
    expect(f.durable().slot).toHaveLength(0);
    expect(f.durable().jobs[0]).toMatchObject({ status: "cancelled" });
  });

  it("allows exact recovery proof after post-COMMIT denial but rejects stale-owner proof", async () => {
    const f = await fixture();
    const { wake, call } = await waiting(f, "authorize");
    f.cancel(call);
    const session = f.storage.store.beginRecovery("denied-send-proof-owner")!;
    expect(session).toBeDefined();
    release(f);
    await expect(wake).rejects.toMatchObject({ code: "not_ready" });
    expect(
      f.storage.store.registerExit(treeExit(call.attempt, call.owner)),
    ).toBe(false);
    expect(f.storage.store.finishCancelled(call.attempt.identity)).toBe(false);
    expect(
      f.storage.store.applyRecoveryInspection(session.control, {
        kind: "never-authorized",
        ...session.target,
      }),
    ).toBeUndefined();
    expect(f.durable().slot).toHaveLength(1);
    const resolution = f.storage.store.applyRecoveryInspection(
      session.control,
      {
        kind: "tree-exited",
        exit: treeExit(call.attempt, call.owner),
      },
    );
    expect(resolution?.kind).toBe("transferred");
    if (resolution?.kind !== "transferred")
      throw new Error("exact proof did not transfer");
    expect(f.storage.store.finishCancelled(resolution.publisher)).toBe(true);
    expect(f.durable().slot).toHaveLength(0);
    expect(f.durable().attempts[0]).toMatchObject({ authorized_at: 1_000 });
  });

  it("retires the old holder while its AUTH invocation remains suspended", async () => {
    const f = await fixture();
    const { wake, call } = await waiting(f, "authorize");
    const next = await f.submit("after-retired-holder");
    const observedNext = deferred<SendCall>();
    f.hooks.observe = (observed) => {
      if (observed.attempt.identity.jobId === next.job.jobId)
        observedNext.resolve(observed);
    };
    f.cancel(call);
    f.observers[0]!.listener(treeExit(call.attempt, call.owner));
    const nextWake = f.track(f.runner.wake());
    const replacement = await Promise.race([
      observedNext.promise,
      nextWake.then(() => {
        throw new Error("next holder was not observed");
      }),
    ]);
    expect(replacement.attempt.identity.ownerInstanceId).toBe(
      call.attempt.identity.ownerInstanceId,
    );
    expect(call.guard.signal.aborted).toBe(false);
    expect(call.guard.stillCurrent()).toBe(false);
    release(f);
    await expect(wake).rejects.toMatchObject({ code: "not_ready" });
    await nextWake;
    expect(
      f.sends.authorize.map((item) => item.attempt.identity.jobId),
    ).toEqual([next.job.jobId]);
    expect(f.durable().slot).toHaveLength(1);
  });

  it("does not enter AUTH when its durable authorization fails at real SQLite COMMIT", async () => {
    const f = await fixture((storage) =>
      commitFault(
        storage,
        `CREATE TRIGGER execution_permission_authorization_commit
       AFTER UPDATE OF authorized_at ON attempts WHEN NEW.authorized_at IS NOT NULL
       BEGIN INSERT INTO lifecycle_commit_fault VALUES ('nonexistent-client'); END;`,
      ),
    );
    await f.submit();
    release(f);
    await expect(f.runner.wake()).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(f.sends.prepare).toHaveLength(1);
    expect(f.calls.authorize).toHaveLength(0);
    expect(f.sends.authorize).toHaveLength(0);
    expect(f.observers).toHaveLength(0);
    expect(f.durable().attempts[0]).toMatchObject({
      prepared_at: 1_000,
      authorized_at: null,
    });
    expect(f.durable().slot).toHaveLength(1);
  });

  it("releases a post-COMMIT denied AUTH only after exact valid-owner terminal proof", async () => {
    const f = await fixture();
    const { wake, call } = await waiting(f, "authorize");
    f.cancel(call);
    release(f);
    await expect(wake).rejects.toMatchObject({ code: "not_ready" });
    retained(f, call, true);
    expect(f.storage.store.finishCancelled(call.attempt.identity)).toBe(false);
    expect(
      f.storage.store.registerExit({
        ...treeExit(call.attempt, call.owner),
        descriptor: { ...call.owner, executionId: "wrong-proof-execution" },
      }),
    ).toBe(false);
    retained(f, call, true);
    expect(
      f.storage.store.registerExit(treeExit(call.attempt, call.owner)),
    ).toBe(true);
    expect(f.storage.store.finishCancelled(call.attempt.identity)).toBe(true);
    expect(f.sends.authorize).toHaveLength(0);
    expect(f.durable().attempts[0]).toMatchObject({ authorized_at: 1_000 });
    expect(f.durable().slot).toHaveLength(0);
  });

  it.each(["prepare", "authorize"] as const)(
    "reads final %s SQL facts after a reentrant clock stop",
    async (phase) => {
      const f = await fixture();
      await f.submit();
      const attempt = f.storage.store.claimNext("clock-permission-owner")!;
      const call = { attempt, owner: descriptor(attempt) } as SendCall;
      if (phase === "authorize") {
        expect(
          f.storage.store.registerPrepared(attempt.identity, call.owner),
        ).toBe(true);
        expect(
          f.storage.store.authorizeLaunch(attempt.identity, call.owner),
        ).toBe(true);
      }
      f.armClock(() => f.cancel(call));
      expect(permission(f, call, phase)).toBe(false);
      expect(f.durable().attempts[0]).toMatchObject({
        stop_reason: "user_cancel",
        authorized_at: phase === "authorize" ? 1_000 : null,
        exit_json: null,
        sealed_at: null,
      });
      expect(f.durable().slot).toHaveLength(1);
    },
  );

  it.each(["prepare", "authorize"] as const)(
    "reads final %s SQL facts after reentrant clock recovery",
    async (phase) => {
      const f = await fixture();
      await f.submit();
      const attempt = f.storage.store.claimNext("clock-recovery-owner")!;
      const call = { attempt, owner: descriptor(attempt) } as SendCall;
      if (phase === "authorize") {
        f.storage.store.registerPrepared(attempt.identity, call.owner);
        f.storage.store.authorizeLaunch(attempt.identity, call.owner);
      }
      const before = f.durable();
      f.armClock(() => {
        expect(
          f.storage.store.beginRecovery("clock-competing-owner"),
        ).toBeDefined();
      });
      expect(permission(f, call, phase)).toBe(false);
      const after = f.durable();
      expect(after.slot).toEqual(before.slot);
      expect(after.attempts).toEqual(before.attempts);
      expect(after.controls).toHaveLength(1);
    },
  );

  it.each(["stop", "recovery"] as const)(
    "validates AUTH descriptor before final SQL when validation commits %s",
    async (action) => {
      const f = await fixture();
      const { wake, call } = await waiting(f, "authorize");
      let changed = false;
      const owner = { ...call.owner };
      Object.defineProperty(owner, "details", {
        enumerable: true,
        get() {
          if (!changed) {
            changed = true;
            if (action === "stop") f.cancel(call);
            else f.storage.store.beginRecovery("descriptor-recovery-owner");
          }
          return call.owner.details;
        },
      });
      expect(
        f.storage.store.canAuthorizeLaunch(
          call.attempt.identity,
          call.attempt.launchTicket,
          owner,
        ),
      ).toBe(false);
      expect(changed).toBe(true);
      const before = f.durable();
      release(f);
      await expect(wake).rejects.toMatchObject({ code: "not_ready" });
      expect(f.durable()).toEqual(before);
      retained(f, call, true);
    },
  );

  it("requires exact identity, ticket, committed descriptor and both metadata records", async () => {
    const f = await fixture();
    const { wake, call } = await waiting(f, "prepare");
    expect(
      f.storage.store.canAuthorizeLaunch(
        call.attempt.identity,
        call.attempt.launchTicket,
        call.owner,
      ),
    ).toBe(false);
    f.gates.prepare.resolve();
    const auth = await f.arrive("authorize", wake);
    const before = f.durable();
    for (const identity of [
      { ...auth.attempt.identity, jobId: "wrong-permission-job" },
      {
        ...auth.attempt.identity,
        attemptNo: auth.attempt.identity.attemptNo + 1,
      },
      { ...auth.attempt.identity, ownerInstanceId: "wrong-permission-owner" },
      { ...auth.attempt.identity, fence: auth.attempt.identity.fence + 1 },
    ] satisfies AttemptIdentity[]) {
      expect(
        f.storage.store.canAuthorizeLaunch(
          identity,
          auth.attempt.launchTicket,
          auth.owner,
        ),
      ).toBe(false);
    }
    expect(
      f.storage.store.canAuthorizeLaunch(
        auth.attempt.identity,
        "wrong-permission-ticket",
        { ...auth.owner, launchTicket: "wrong-permission-ticket" },
      ),
    ).toBe(false);
    for (const owner of [
      { ...auth.owner, executionId: "wrong-permission-execution" },
      { ...auth.owner, adapterId: "wrong-permission-adapter" },
      { ...auth.owner, details: { ...auth.owner.details, uncommitted: true } },
    ])
      expect(
        f.storage.store.canAuthorizeLaunch(
          auth.attempt.identity,
          auth.attempt.launchTicket,
          owner,
        ),
      ).toBe(false);
    expect(f.durable()).toEqual(before);
    release(f);
    await wake;
  });
});
