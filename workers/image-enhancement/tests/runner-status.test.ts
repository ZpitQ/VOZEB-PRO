import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EnhancementError } from "../src/contracts.js";
import type { Inspection } from "../src/execution.js";
import {
  permissionFixture,
  type PermissionFixture,
  type SendPhase,
} from "./execution-send-permission-fixtures.js";
import { deferred } from "./http-fixtures.js";
import { treeExit } from "./lifecycle-fixtures.js";
import {
  observeInspection,
  recoveryFixture,
  target,
} from "./recovery-fixtures.js";

type RunnerStatus = Readonly<{
  closed: boolean;
  storeClosed: boolean;
  recoveryState:
    "idle" | "inspecting" | "owned-alive" | "unknown" | "awaiting-artifacts";
  recoveryInFlight: boolean;
  ownedState: "none" | "busy" | "unknown";
}>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function statusReader(subject: object) {
  const status = Reflect.get(subject, "status");
  expect(typeof status, "Runner exposes its real status method").toBe(
    "function",
  );
  return () => {
    const result = (status as () => RunnerStatus).call(subject);
    expect(Object.isFrozen(result), "frozen Runner snapshot").toBe(true);
    return result;
  };
}

function state(
  ownedState: RunnerStatus["ownedState"],
  overrides: Partial<RunnerStatus> = {},
): RunnerStatus {
  return {
    closed: false,
    storeClosed: false,
    recoveryState: "idle",
    recoveryInFlight: false,
    ownedState,
    ...overrides,
  };
}

function expectStatus(actual: RunnerStatus, expected: RunnerStatus) {
  // A failing snapshot must not print an accidentally exposed descriptor/path.
  expect(isDeepStrictEqual(actual, expected), "exact Runner status").toBe(true);
}

async function fixture() {
  const f = await permissionFixture();
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

describe("Runner read-only runtime status", () => {
  it("returns new frozen snapshots without advancing time, work or durable facts", async () => {
    const f = await fixture();
    const read = statusReader(f.runner);
    const first = read();
    expectStatus(first, state("none"));
    expect(read() === first).toBe(false);

    const { wake } = await waiting(f, "prepare");
    const now = vi.spyOn(f.time.clock, "now");
    const schedule = vi.spyOn(f.time.clock, "scheduleAt");
    const writes = [
      vi.spyOn(f.storage.store, "claimNext"),
      vi.spyOn(f.storage.store, "renewLease"),
      vi.spyOn(f.storage.store, "requestStop"),
      vi.spyOn(f.storage.store, "registerPrepared"),
      vi.spyOn(f.storage.store, "authorizeLaunch"),
      vi.spyOn(f.storage.store, "registerExit"),
      vi.spyOn(f.storage.store, "beginRecovery"),
    ];
    const before = f.durable();
    const timers = f.time.entries.length;
    const sends = [
      f.calls.prepare.length,
      f.calls.authorize.length,
      f.stops.length,
    ];
    for (let index = 0; index < 3; index++) expectStatus(read(), state("busy"));
    await Promise.resolve();
    expect(now).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(writes.map((write) => write.mock.calls.length)).toEqual(
      writes.map(() => 0),
    );
    expect(f.time.entries.length).toBe(timers);
    expect([
      f.calls.prepare.length,
      f.calls.authorize.length,
      f.stops.length,
    ]).toEqual(sends);
    expect(isDeepStrictEqual(f.durable(), before)).toBe(true);
    expectStatus(first, state("none"));
    release(f);
    await wake;
    expectStatus(read(), state("busy"));
    expect(f.runner.readiness()).toEqual({
      ready: false,
      recoveryState: "idle",
    });
  });

  it("keeps prepare and AUTH barriers busy through the original positive ACK", async () => {
    const f = await fixture();
    const read = statusReader(f.runner);
    const { wake } = await waiting(f, "prepare");
    expectStatus(read(), state("busy"));
    f.gates.prepare.resolve();
    const call = await f.arrive("authorize", wake);
    expectStatus(read(), state("busy"));
    expect(
      f.storage.store.getActiveAttempt(call.attempt.identity)?.authorizedAt,
    ).toBe(1_000);
    f.gates.authorize.resolve();
    await wake;
    expectStatus(read(), state("busy"));
    expect(f.sends.authorize.length).toBe(1);
  });

  it.each(["prepare", "authorize"] as const)(
    "keeps the original holder unknown after an admitted %s rejects",
    async (phase) => {
      const f = await fixture();
      const read = statusReader(f.runner);
      f.hooks.afterSend = (sent) => {
        if (sent === phase) throw new Error("synthetic-response-lost");
      };
      const { wake, call } = await waiting(f, phase);
      const before = f.durable();
      expectStatus(read(), state("busy"));
      release(f);
      await expect(wake).rejects.toMatchObject({ code: "internal_error" });
      expectStatus(read(), state("unknown"));
      expect(isDeepStrictEqual(f.durable(), before)).toBe(true);
      expect(f.sends[phase].length).toBe(1);
      expect(
        f.storage.store.getActiveAttempt(call.attempt.identity)
          ?.launchTicket === call.attempt.launchTicket,
      ).toBe(true);
      await f.submit("waiting-after-unknown");
      await f.runner.wake();
      expect(f.calls.prepare.length).toBe(1);
      expect(f.calls.authorize.length).toBe(phase === "authorize" ? 1 : 0);
      expect(f.durable().slot.length).toBe(1);
      await f.runner.close();
      expectStatus(read(), state("unknown", { closed: true }));
      f.storage.store.close();
      expectStatus(
        read(),
        state("unknown", { closed: true, storeClosed: true }),
      );
    },
  );

  it.each([
    "before-prepare-guard",
    "before-prepare-return",
    "after-register-prepared",
    "inside-observe-exit",
  ] as const)(
    "records an unknown launch after real cancellation %s and a fulfilled wake",
    async (when) => {
      const f = await fixture();
      const read = statusReader(f.runner);
      const accepted = await f.submit();
      const cancel = () =>
        f.storage.service().cancel(f.storage.principal(), accepted.job.jobId);
      if (when === "before-prepare-guard") {
        const claim = f.storage.store.claimNext.bind(f.storage.store);
        vi.spyOn(f.storage.store, "claimNext").mockImplementation((owner) => {
          const attempt = claim(owner);
          if (attempt) cancel();
          return attempt;
        });
      } else if (when === "before-prepare-return") {
        f.hooks.afterSend = (phase) => {
          if (phase === "prepare") cancel();
        };
      } else if (when === "after-register-prepared") {
        const register = f.storage.store.registerPrepared.bind(f.storage.store);
        vi.spyOn(f.storage.store, "registerPrepared").mockImplementation(
          (...args) => {
            const registered = register(...args);
            if (registered) cancel();
            return registered;
          },
        );
      } else {
        f.hooks.observe = () => {
          cancel();
        };
      }
      release(f);
      await f.runner.wake();
      expectStatus(read(), state("unknown"));
      const before = f.durable();
      expect(before.slot.length).toBe(1);
      const job = f.storage.store.getOwned(
        f.storage.principal(),
        accepted.job.jobId,
      );
      expect({
        status: job.status,
        cancelRequested: job.cancelRequested,
        completedAt: job.completedAt,
      }).toEqual({
        status: "running",
        cancelRequested: true,
        completedAt: null,
      });
      expect(f.calls.authorize.length).toBe(0);
      expect(f.sends.authorize.length).toBe(0);
      await f.runner.wake();
      expect(f.calls.prepare.length).toBe(
        when === "before-prepare-guard" ? 0 : 1,
      );
      expect(f.calls.authorize.length).toBe(0);
      expect(isDeepStrictEqual(f.durable(), before)).toBe(true);
      expect(f.runner.readiness()).toEqual({
        ready: false,
        recoveryState: "idle",
      });
    },
  );

  it("keeps a matching strict terminal busy when subscription prevents AUTH entry", async () => {
    const f = await fixture();
    const read = statusReader(f.runner);
    f.hooks.observe = (call, listener) =>
      listener(treeExit(call.attempt, call.owner));
    await f.submit();
    release(f);
    await f.runner.wake();
    expectStatus(read(), state("busy"));
    expect(f.calls.authorize.length).toBe(0);
    expect(f.durable().slot.length).toBe(1);
  });

  it.each(["absent", "different-ticket", "read-failure"] as const)(
    "projects %s as unknown without retiring or poisoning the original holder",
    async (fault) => {
      const f = await fixture();
      const read = statusReader(f.runner);
      const { wake, call } = await waiting(f, "authorize");
      release(f);
      await wake;
      const active = f.storage.store.getActiveAttempt(call.attempt.identity)!;
      const before = f.durable();
      const now = vi.spyOn(f.time.clock, "now");
      const lookup = vi.spyOn(f.storage.store, "getActiveAttempt");
      lookup.mockImplementationOnce(() => {
        if (fault === "read-failure")
          throw new Error("synthetic-status-read-fault");
        return fault === "absent"
          ? undefined
          : { ...active, launchTicket: "other-ticket" };
      });
      expectStatus(read(), state("unknown"));
      expectStatus(read(), state("busy"));
      expect(now).not.toHaveBeenCalled();
      expect(isDeepStrictEqual(f.durable(), before)).toBe(true);
      expect(f.calls.prepare.length).toBe(1);
      expect(f.calls.authorize.length).toBe(1);
    },
  );

  it("preserves the original rejection and seals its guard when the final diagnostic read fails", async () => {
    const f = await fixture();
    const read = statusReader(f.runner);
    f.hooks.afterSend = (phase) => {
      if (phase !== "authorize") return;
      vi.spyOn(f.storage.store, "getActiveAttempt").mockImplementationOnce(
        () => {
          throw new Error("synthetic-diagnostic-read-fault");
        },
      );
      throw new EnhancementError("not_ready");
    };
    const { wake, call } = await waiting(f, "authorize");
    release(f);
    await expect(wake).rejects.toMatchObject({ code: "not_ready" });
    expect(call.guard.stillCurrent()).toBe(false);
    expect(call.guard.takeSendPermission()).toBe(false);
    expectStatus(read(), state("unknown"));
    expect(f.durable().slot.length).toBe(1);
  });

  it.each(["prepare", "authorize"] as const)(
    "preserves closed ownership across a late %s result",
    async (phase) => {
      const f = await fixture();
      const read = statusReader(f.runner);
      const { wake } = await waiting(f, phase);
      const before = f.durable();
      await f.runner.close();
      expect(read().closed).toBe(true);
      expect(read().ownedState === "none").toBe(false);
      release(f);
      await expect(wake).rejects.toMatchObject({ code: "not_ready" });
      expect(read().closed).toBe(true);
      expect(read().ownedState === "none").toBe(false);
      expect(isDeepStrictEqual(f.durable(), before)).toBe(true);
      expect(f.sends[phase].length).toBe(0);
      expect(f.durable().slot.length).toBe(1);
    },
  );

  it.each(["ack", "reject"] as const)(
    "does not write an old AUTH %s into the new holder",
    async (reply) => {
      const f = await fixture();
      const read = statusReader(f.runner);
      const late = deferred();
      f.releaseOnCleanup(() => late.resolve());
      const { wake, call } = await waiting(f, "authorize");
      f.hooks.afterSend = (phase, sent) => {
        if (
          phase !== "authorize" ||
          sent.attempt.launchTicket !== call.attempt.launchTicket
        )
          return;
        return late.promise.then(() => {
          if (reply === "reject")
            throw new Error("synthetic-late-response-lost");
        });
      };
      f.gates.authorize.resolve();
      await f.dispatches.authorize.promise;
      const next = await f.submit("replacement-after-terminal");
      f.cancel(call);
      f.observers[0]!.listener(treeExit(call.attempt, call.owner));
      const nextWake = f.track(f.runner.wake());
      await nextWake;
      const replacement = f.calls.authorize.find(
        (item) => item.attempt.identity.jobId === next.job.jobId,
      );
      expect(!!replacement).toBe(true);
      expectStatus(read(), state("busy"));
      late.resolve();
      if (reply === "reject")
        await expect(wake).rejects.toMatchObject({ code: "internal_error" });
      else await wake;
      expectStatus(read(), state("busy"));
      expect(
        replacement &&
          f.storage.store.getActiveAttempt(replacement.attempt.identity)
            ?.launchTicket === replacement.attempt.launchTicket,
      ).toBe(true);
      expect(f.durable().slot.length).toBe(1);
      expect(f.calls.prepare.length).toBe(2);
      expect(f.sends.authorize.length).toBe(2);
    },
  );

  it.each(["settle", "close-pending"] as const)(
    "observes one shared recovery promise through %s without calling unknown idle",
    async (mode) => {
      const f = await recoveryFixture();
      cleanups.push(() => f.cleanup());
      const attempt = await f.claim("authorized");
      await f.reopen();
      const runner = f.runner();
      const read = statusReader(runner);
      const gate = deferred<Inspection>();
      f.releaseOnCleanup(() =>
        gate.resolve({ kind: "unknown", ...target(attempt) }),
      );
      let nested: Promise<void> | undefined;
      f.executor.hooks.inspect = () => {
        nested = runner.recover();
        expectStatus(
          read(),
          state("none", {
            recoveryState: "inspecting",
            recoveryInFlight: true,
          }),
        );
        return gate.promise;
      };
      const pending = runner.recover();
      void pending.catch(() => {});
      expectStatus(read(), state("none", { recoveryInFlight: true }));
      expect(runner.recover()).toBe(pending);
      await observeInspection(f.executor, pending);
      expect(nested).toBe(pending);
      const before = f.storage.store.getActiveAttempt(attempt.identity);
      if (mode === "close-pending") {
        await runner.close();
        expectStatus(
          read(),
          state("none", {
            closed: true,
            recoveryState: "inspecting",
            recoveryInFlight: true,
          }),
        );
      }
      gate.resolve({ kind: "unknown", ...target(attempt) });
      await pending;
      const recoveryState = mode === "settle" ? "unknown" : "inspecting";
      expectStatus(
        read(),
        state("none", {
          closed: mode === "close-pending",
          recoveryState,
        }),
      );
      expect(runner.readiness()).toEqual({ ready: false, recoveryState });
      expect(
        isDeepStrictEqual(
          f.storage.store.getActiveAttempt(attempt.identity),
          before,
        ),
      ).toBe(true);
      expect(f.executor.inspectCalls.length).toBe(1);
      expect(f.executor.stopCalls.length).toBe(0);
    },
  );
});
