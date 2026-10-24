import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArtifactFiles } from "../src/artifacts.js";
import type { Clock, ExecutionAdapter } from "../src/execution.js";
import { createRunner } from "../src/runner.js";
import {
  artifactRunnerFixture,
  nativeResult,
  reachedBeforeRunnerSettled,
} from "./artifact-runner-fixtures.js";
import { authorizedRecoveryFixture } from "./authorized-recovery-fixtures.js";
import { completionExit } from "./completion-fixtures.js";
import { deferred } from "./http-fixtures.js";
import { snapshot, treeExit } from "./lifecycle-fixtures.js";
import { recoveryFixture, target } from "./recovery-fixtures.js";
import { runnerLimits, type storageFixture } from "./storage-fixtures.js";

type Storage = Awaited<ReturnType<typeof storageFixture>>;
type Selection = "none" | "ordinary" | Readonly<{ onlyJobId: string }>;
type Selector = () => Selection;
type Base = {
  storage: Storage;
  time: { clock: Clock };
  executor: { adapter: ExecutionAdapter };
};
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture() {
  const f = await recoveryFixture();
  cleanups.push(() => f.cleanup());
  return f;
}

function selectedRunner(
  base: Base,
  claimSelection?: Selector,
  artifactFiles?: ArtifactFiles,
) {
  const options = {
    store: base.storage.store,
    clock: base.time.clock,
    executor: base.executor.adapter,
    ownerInstanceId: "selection-runner",
    ...(claimSelection ? { claimSelection } : {}),
    ...(artifactFiles ? { artifactFiles } : {}),
  };
  const runner = createRunner(options);
  cleanups.push(() => runner.close());
  return runner;
}

function attemptCount(storage: Storage) {
  return snapshot(
    storage,
    (db) =>
      (
        db.prepare("SELECT COUNT(*) AS count FROM attempts").get() as {
          count: number;
        }
      ).count,
  );
}

function queued(storage: Storage, jobId: string) {
  return snapshot(storage, (db) => {
    const job = db
      .prepare("SELECT status FROM jobs WHERE job_id = ?")
      .get(jobId) as { status: string };
    const attempts = db
      .prepare("SELECT COUNT(*) AS count FROM attempts WHERE job_id = ?")
      .get(jobId) as { count: number };
    return job.status === "queued" && attempts.count === 0;
  });
}

describe("Runner ordinary claim selection", () => {
  it.each(["wake", "recover"] as const)(
    "none fences the %s entry and repeated wakes without claiming or preparing",
    async (entry) => {
      const f = await fixture();
      const accepted = await f.submit();
      const selector = vi.fn<Selector>(() => "none");
      const claim = vi.spyOn(f.storage.store, "claimNext");
      const runner = selectedRunner(f, selector);
      await runner[entry]();
      await runner.wake();
      await runner.wake();
      expect(queued(f.storage, accepted.job.jobId)).toBe(true);
      expect(attemptCount(f.storage)).toBe(0);
      expect(claim.mock.calls.length).toBe(0);
      expect(f.executor.prepareCalls.length).toBe(0);
      expect(f.executor.authorizeCalls.length).toBe(0);
      expect(selector.mock.calls.length).toBe(3);
    },
  );

  it.each(["absent", "ordinary"] as const)(
    "%s selection keeps the original FIFO behavior",
    async (mode) => {
      const f = await fixture();
      const first = await f.submit("fifo-first");
      const second = await f.submit("fifo-second");
      const selector = vi.fn<Selector>(() => "ordinary");
      const runner = selectedRunner(
        f,
        mode === "ordinary" ? selector : undefined,
      );
      await runner.wake();
      await runner.wake();
      expect(f.executor.prepareCalls.length).toBe(1);
      expect(f.executor.authorizeCalls.length).toBe(1);
      expect(f.executor.launchCalls.length).toBe(1);
      expect(
        f.executor.launchCalls[0]?.identity.jobId === first.job.jobId,
      ).toBe(true);
      expect(queued(f.storage, second.job.jobId)).toBe(true);
      expect(selector.mock.calls.length).toBe(mode === "ordinary" ? 1 : 0);
    },
  );

  it("moves from none to one exact later job synchronously and never falls back after its terminal exit", async () => {
    const f = await fixture();
    const ordinary = await f.submit("earlier-ordinary");
    let selection: Selection = "none";
    let selectedMicrotask = false;
    const selector = vi.fn<Selector>(() => {
      if (typeof selection === "object")
        queueMicrotask(() => {
          selectedMicrotask = true;
        });
      return selection;
    });
    const runner = selectedRunner(f, selector);
    await runner.wake();
    expect(attemptCount(f.storage)).toBe(0);
    const selected = await f.submit("later-selected");
    selection = Object.freeze({ onlyJobId: selected.job.jobId });
    selector.mockClear();
    const starting = runner.wake();
    expect(selectedMicrotask).toBe(false);
    expect(selector.mock.calls.length).toBe(1);
    expect(
      f.storage.service().get(f.storage.principal(), selected.job.jobId).status,
    ).toBe("running");
    expect(queued(f.storage, ordinary.job.jobId)).toBe(true);
    await starting;
    await runner.wake();
    expect(selector.mock.calls.length).toBe(1);
    expect(f.executor.launchCalls.length).toBe(1);
    const attempt = f.executor.launchCalls[0]!;
    expect(attempt.identity.jobId === selected.job.jobId).toBe(true);
    f.executor.emit(
      completionExit(attempt, { kind: "failure", exitCode: 7, signal: null }),
    );
    await runner.wake();
    await runner.wake();
    expect(
      f.storage.service().get(f.storage.principal(), selected.job.jobId).status,
    ).toBe("failed");
    expect(queued(f.storage, ordinary.job.jobId)).toBe(true);
    expect(attemptCount(f.storage)).toBe(1);
    expect(f.executor.prepareCalls.length).toBe(1);
    expect(f.executor.authorizeCalls.length).toBe(1);
  });

  const badSelections: readonly [string, () => unknown][] = [
    [
      "throw",
      () => {
        throw new Error("controlled-selector-fault");
      },
    ],
    ["undefined", () => undefined],
    ["null", () => null],
    ["invalid mode", () => "all"],
    ["missing exact ID", () => ({})],
    ["invalid exact ID", () => ({ onlyJobId: " leading" })],
    ["nonstring exact ID", () => ({ onlyJobId: 7 })],
  ];
  it.each(badSelections)(
    "fails closed for %s without ordinary fallback",
    async (_label, select) => {
      const f = await fixture();
      const accepted = await f.submit();
      const selector = vi.fn(select);
      const claim = vi.spyOn(f.storage.store, "claimNext");
      const runner = selectedRunner(f, selector as Selector);
      await Promise.allSettled([runner.wake()]);
      await Promise.allSettled([runner.wake()]);
      expect(queued(f.storage, accepted.job.jobId)).toBe(true);
      expect(attemptCount(f.storage)).toBe(0);
      expect(claim.mock.calls.length).toBe(0);
      expect(f.executor.prepareCalls.length).toBe(0);
      expect(f.executor.authorizeCalls.length).toBe(0);
    },
  );

  it.each([
    "callback-runner",
    "callback-store",
    "getter-runner",
    "getter-store",
  ] as const)("rechecks sealing after %s reenters close", async (mode) => {
    const f = await fixture();
    const accepted = await f.submit();
    let runner: ReturnType<typeof createRunner>;
    let reads = 0;
    const seal = () => {
      if (mode.endsWith("runner")) runner.close();
      else f.storage.store.close();
    };
    const selector: Selector = () => {
      if (mode.startsWith("callback")) {
        seal();
        return "ordinary";
      }
      return Object.defineProperty({}, "onlyJobId", {
        enumerable: true,
        get() {
          reads++;
          seal();
          return accepted.job.jobId;
        },
      }) as Readonly<{ onlyJobId: string }>;
    };
    const claim = vi.spyOn(f.storage.store, "claimNext");
    runner = selectedRunner(f, selector);
    await Promise.allSettled([runner.wake()]);
    expect(queued(f.storage, accepted.job.jobId)).toBe(true);
    expect(attemptCount(f.storage)).toBe(0);
    expect(claim.mock.calls.length).toBe(0);
    expect(f.executor.prepareCalls.length).toBe(0);
    expect(f.executor.authorizeCalls.length).toBe(0);
    expect(reads <= 1, "exact ID is never reread after sealing").toBe(true);
    if (mode.startsWith("callback"))
      expect(
        mode.endsWith("runner")
          ? runner.status().closed
          : f.storage.store.closed,
      ).toBe(true);
  });
});

describe("claim selection preserves current work", () => {
  it("none preserves renewal, cancellation, soft/force stop and terminal retirement", async () => {
    const f = await fixture();
    const accepted = await f.submit();
    let selection: Selection = "ordinary";
    const runner = selectedRunner(f, () => selection);
    await runner.wake();
    const original = f.executor.launchCalls[0]!;
    const waiting = await f.submit("waiting-through-stop");
    selection = "none";
    f.time.advanceTo(1_000 + runnerLimits.heartbeatIntervalMs);
    expect(
      f.storage.store.getActiveAttempt(original.identity)!.leaseExpiresAt >
        original.leaseExpiresAt,
    ).toBe(true);
    f.storage.service().cancel(f.storage.principal(), accepted.job.jobId);
    await runner.wake();
    expect(
      f.executor.stopCalls.filter((call) => call.mode === "soft").length,
    ).toBe(1);
    const stopping = f.storage.store.getActiveAttempt(original.identity)!;
    f.time.advanceTo(stopping.terminateAfterAt! + 1);
    expect(
      f.executor.stopCalls.filter((call) => call.mode === "force").length,
    ).toBe(1);
    f.executor.emit(treeExit(original));
    await runner.wake();
    await runner.wake();
    expect(
      f.storage.service().get(f.storage.principal(), accepted.job.jobId).status,
    ).toBe("cancelled");
    expect(queued(f.storage, waiting.job.jobId)).toBe(true);
    expect(attemptCount(f.storage)).toBe(1);
    expect(f.executor.prepareCalls.length).toBe(1);
    expect(f.executor.authorizeCalls.length).toBe(1);
  });

  it("none also fences a timer that retires a persisted failed execution", async () => {
    const f = await fixture();
    await f.submit();
    let selection: Selection = "ordinary";
    const runner = selectedRunner(f, () => selection);
    await runner.wake();
    const original = f.executor.launchCalls[0]!;
    const waiting = await f.submit("timer-waiting");
    selection = "none";
    expect(
      f.storage.store.registerExit(
        completionExit(original, {
          kind: "failure",
          exitCode: 7,
          signal: null,
        }),
      ),
    ).toBe(true);
    f.time.advanceTo(1_000 + runnerLimits.heartbeatIntervalMs);
    await runner.wake();
    expect(
      f.storage.service().get(f.storage.principal(), original.identity.jobId)
        .status,
    ).toBe("failed");
    expect(queued(f.storage, waiting.job.jobId)).toBe(true);
    expect(attemptCount(f.storage)).toBe(1);
    expect(f.executor.prepareCalls.length).toBe(1);
  });

  it.each(["none", "exact"] as const)(
    "%s after an actual PNG publication lets artifacts settle without taking the waiting job",
    async (mode) => {
      const f = await artifactRunnerFixture();
      cleanups.push(() => f.cleanup());
      const accepted = await f.submit();
      let selection: Selection = "ordinary";
      const runner = selectedRunner(f, () => selection, f.files);
      await f.track(runner.wake());
      const original = f.executor.launchCalls[0]!;
      const waiting = await f.submit("artifact-waiting");
      selection = mode === "none" ? "none" : { onlyJobId: accepted.job.jobId };
      const gate = f.gate(
        (event) =>
          event.stage === "directory_sync" &&
          event.path === f.storage.directory,
      );
      const { png } = await f.emitSuccess(original);
      const publishing = f.track(runner.wake());
      await reachedBeforeRunnerSettled(gate, publishing);
      expect(queued(f.storage, waiting.job.jobId)).toBe(true);
      expect(f.executor.prepareCalls.length).toBe(1);
      gate.release();
      await publishing;
      await f.track(runner.wake());
      const job = f.job(accepted.job.jobId);
      expect(job.status).toBe("succeeded");
      expect(
        isDeepStrictEqual(job.result, nativeResult(original, png)),
        "real published PNG result",
      ).toBe(true);
      const references = f.rows().references;
      expect(references.length).toBe(1);
      expect(references.every((ref) => ref.released_at !== null)).toBe(true);
      expect(queued(f.storage, waiting.job.jobId)).toBe(true);
      expect(attemptCount(f.storage)).toBe(1);
      expect(f.executor.prepareCalls.length).toBe(1);
      expect(f.executor.authorizeCalls.length).toBe(1);
    },
  );

  it("an exact selection cannot replace the ordinary prepare barrier holder", async () => {
    const f = await fixture();
    await f.submit();
    let selection: Selection = "ordinary";
    const gate = deferred<void>();
    f.releaseOnCleanup(() => gate.resolve());
    f.executor.hooks.prepare = async (_attempt, owner) => {
      await gate.promise;
      return owner;
    };
    const runner = selectedRunner(f, () => selection);
    const firstWake = runner.wake();
    void firstWake.catch(() => {});
    await Promise.race([
      f.executor.prepared.promise,
      firstWake.then(() => {
        throw new Error("runner settled before controlled prepare");
      }),
    ]);
    const waiting = await f.submit("prepare-barrier-waiting");
    selection = { onlyJobId: waiting.job.jobId };
    const secondWake = runner.wake();
    void secondWake.catch(() => {});
    expect(queued(f.storage, waiting.job.jobId)).toBe(true);
    expect(attemptCount(f.storage)).toBe(1);
    expect(f.executor.prepareCalls.length).toBe(1);
    expect(f.executor.authorizeCalls.length).toBe(0);
    gate.resolve();
    await Promise.all([firstWake, secondWake]);
    expect(f.executor.launchCalls.length).toBe(1);
    expect(queued(f.storage, waiting.job.jobId)).toBe(true);
  });

  it("an exact selection preserves launchUnknown and its original durable slot", async () => {
    const f = await fixture();
    await f.submit();
    let selection: Selection = "ordinary";
    f.executor.hooks.authorize = async () => {
      throw new Error("controlled-AUTH-ack-loss");
    };
    const runner = selectedRunner(f, () => selection);
    await Promise.allSettled([runner.wake()]);
    const waiting = await f.submit("launch-unknown-waiting");
    selection = { onlyJobId: waiting.job.jobId };
    await Promise.allSettled([runner.wake()]);
    expect(runner.status().ownedState).toBe("unknown");
    expect(queued(f.storage, waiting.job.jobId)).toBe(true);
    expect(attemptCount(f.storage)).toBe(1);
    expect(f.executor.prepareCalls.length).toBe(1);
    expect(f.executor.authorizeCalls.length).toBe(1);
    expect(f.executor.launchCalls.length).toBe(0);
  });

  it.each(["unknown", "owned-alive", "awaiting-artifacts"] as const)(
    "an exact waiting target cannot preempt %s recovery after the old lease expires",
    async (state) => {
      const f = await fixture();
      const original = await f.claim("authorized");
      const waiting = await f.submit("recovery-waiting");
      if (state === "unknown")
        f.executor.hooks.inspect = async () => ({
          kind: "unknown",
          ...target(original),
        });
      if (state === "awaiting-artifacts") f.executor.emit(treeExit(original));
      f.storage.setNow(original.leaseExpiresAt + 1);
      await f.reopen();
      let selection: Selection = { onlyJobId: waiting.job.jobId };
      const runner = selectedRunner(f, () => selection);
      await runner.recover();
      await runner.wake();
      expect(runner.readiness().recoveryState).toBe(state);
      expect(queued(f.storage, waiting.job.jobId)).toBe(true);
      expect(attemptCount(f.storage)).toBe(1);
      expect(f.executor.prepareCalls.length).toBe(1);
      expect(f.executor.authorizeCalls.length).toBe(1);
      expect(f.executor.launchCalls.length).toBe(1);
      if (state === "owned-alive") {
        selection = "none";
        f.storage
          .service()
          .cancel(f.storage.principal(), original.identity.jobId);
        await runner.wake();
        expect(
          f.executor.stopCalls.filter((call) => call.mode === "soft").length,
        ).toBe(1);
        const stopping = f.storage.store.getActiveAttempt(original.identity)!;
        f.time.advanceTo(stopping.terminateAfterAt! + 1);
        expect(
          f.executor.stopCalls.filter((call) => call.mode === "force").length,
        ).toBe(1);
        expect(queued(f.storage, waiting.job.jobId)).toBe(true);
        expect(attemptCount(f.storage)).toBe(1);
      }
      expect(
        snapshot(f.storage, (db) => {
          const slot = db
            .prepare("SELECT job_id FROM execution_slot")
            .all() as { job_id: string }[];
          const ticket = db
            .prepare("SELECT launch_ticket FROM attempts")
            .get() as { launch_ticket: string };
          return (
            slot.length === 1 &&
            slot[0]!.job_id === original.identity.jobId &&
            ticket.launch_ticket === original.launchTicket
          );
        }),
        "original job and ticket keep the slot",
      ).toBe(true);
    },
  );
});

describe("none preserves only positively proved original-slot replacements", () => {
  it.each(["valid", "wrong-ticket"] as const)(
    "uses the real never-authorized recovery transaction with %s evidence",
    async (evidence) => {
      const f = await fixture();
      const original = await f.claim();
      const waiting = await f.submit("sealed-recovery-waiting");
      await f.reopen();
      if (evidence === "wrong-ticket")
        f.executor.hooks.inspect = async () => ({
          kind: "never-authorized",
          ...target(original),
          launchTicket: "different-ticket",
        });
      const runner = selectedRunner(f, () => "none");
      await runner.recover();
      await runner.wake();
      expect(queued(f.storage, waiting.job.jobId)).toBe(true);
      if (evidence === "valid") {
        const replacement = f.executor.launchCalls[0];
        expect(replacement !== undefined).toBe(true);
        expect(replacement!.identity.jobId === original.identity.jobId).toBe(
          true,
        );
        expect(replacement!.identity.attemptNo).toBe(
          original.identity.attemptNo + 1,
        );
        expect(replacement!.identity.fence > original.identity.fence).toBe(
          true,
        );
        expect(replacement!.launchTicket !== original.launchTicket).toBe(true);
        expect(replacement!.firstStartedAt === original.firstStartedAt).toBe(
          true,
        );
        expect(
          replacement!.executionDeadlineAt === original.executionDeadlineAt,
        ).toBe(true);
        expect(
          isDeepStrictEqual(
            replacement!.executionPolicy,
            original.executionPolicy,
          ),
        ).toBe(true);
        expect(attemptCount(f.storage)).toBe(2);
        expect(f.executor.prepareCalls.length).toBe(1);
        expect(f.executor.authorizeCalls.length).toBe(1);
      } else {
        expect(runner.readiness().recoveryState).toBe("unknown");
        expect(attemptCount(f.storage)).toBe(1);
        expect(f.executor.prepareCalls.length).toBe(0);
        expect(f.executor.authorizeCalls.length).toBe(0);
        expect(f.executor.launchCalls.length).toBe(0);
      }
    },
  );

  it.each(["valid", "mismatched-terminal"] as const)(
    "uses durable authorized interruption records with %s evidence for artifacts.recover",
    async (evidence) => {
      const f = await authorizedRecoveryFixture();
      cleanups.push(() => f.cleanup());
      await f.submit();
      const producer = selectedRunner(f, () => "ordinary", f.actualFiles);
      await f.track(producer.wake());
      const original = f.allLaunchCalls[0]!;
      expect(original !== undefined).toBe(true);
      const waiting = await f.submit("interruption-waiting");
      producer.close();
      await f.executor.loseController(target(original));
      await f.reopen();
      if (evidence === "mismatched-terminal")
        await f.executor.rewriteRecordBytes(
          target(original),
          "terminal",
          (bytes) => {
            const record = JSON.parse(bytes.toString("utf8")) as Record<
              string,
              unknown
            >;
            record.authorizationRecordId = "different-authorization-record";
            return Buffer.from(JSON.stringify(record));
          },
        );
      const originalTerminal = await f.executor.recordBytes(
        target(original),
        "terminal",
      );
      expect(originalTerminal !== undefined).toBe(true);
      const runner = selectedRunner(f, () => "none", f.actualFiles);
      await f.track(runner.recover());
      await f.track(runner.wake());
      expect(queued(f.storage, waiting.job.jobId)).toBe(true);
      expect(
        isDeepStrictEqual(
          await f.executor.recordBytes(target(original), "terminal"),
          originalTerminal,
        ),
        "original durable terminal remains intact",
      ).toBe(true);
      if (evidence === "valid") {
        const replacement = f.allLaunchCalls[1];
        expect(replacement !== undefined).toBe(true);
        expect(replacement!.identity.jobId === original.identity.jobId).toBe(
          true,
        );
        expect(replacement!.identity.attemptNo).toBe(
          original.identity.attemptNo + 1,
        );
        expect(replacement!.identity.fence > original.identity.fence).toBe(
          true,
        );
        expect(replacement!.launchTicket !== original.launchTicket).toBe(true);
        expect(replacement!.firstStartedAt === original.firstStartedAt).toBe(
          true,
        );
        expect(
          replacement!.executionDeadlineAt === original.executionDeadlineAt,
        ).toBe(true);
        expect(
          isDeepStrictEqual(
            replacement!.executionPolicy,
            original.executionPolicy,
          ),
        ).toBe(true);
        expect(f.restartCalls.length).toBe(1);
        expect(f.allLaunchCalls.length).toBe(2);
        expect(attemptCount(f.storage)).toBe(2);
      } else {
        expect(runner.readiness().recoveryState).toBe("unknown");
        expect(f.restartCalls.length).toBe(0);
        expect(f.allLaunchCalls.length).toBe(1);
        expect(attemptCount(f.storage)).toBe(1);
      }
    },
  );
});
