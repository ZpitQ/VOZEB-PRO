import fs, { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ClaimedAttempt,
  Clock,
  ExecutionAdapter,
  OwnerDescriptor,
} from "../src/execution.js";
import { EnhancementError } from "../src/contracts.js";
import { createRunner } from "../src/runner.js";
import { deferred, httpFixture, jobOf } from "./http-fixtures.js";
import { manualClock } from "./lifecycle-fixtures.js";
import {
  runnerLimits,
  sourceImage,
  storageFixture,
  submission,
} from "./storage-fixtures.js";

type StorageFixture = Awaited<ReturnType<typeof storageFixture>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function snapshot<T>(
  storage: StorageFixture,
  read: (db: Database.Database) => T,
) {
  const db = new Database(
    readFileSync(join(storage.directory, "worker.sqlite")),
  );
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function clock(storage: StorageFixture): Clock {
  return manualClock(storage).clock;
}

function controlledExecutor() {
  const prepared = deferred<ClaimedAttempt>();
  const prepareCalls: ClaimedAttempt[] = [];
  const authorizeCalls: ClaimedAttempt[] = [];
  const active = new Set<string>();
  const owners = new Map<string, OwnerDescriptor>();
  const sealedTickets = new Set<string>();
  const hooks: {
    prepare?: (
      attempt: ClaimedAttempt,
      owner: OwnerDescriptor,
    ) => Promise<OwnerDescriptor>;
    authorize?: (
      attempt: ClaimedAttempt,
      owner: OwnerDescriptor,
    ) => Promise<void>;
  } = {};
  const adapter: ExecutionAdapter = {
    kind: "test",
    async prepare(attempt, guard) {
      prepareCalls.push(attempt);
      prepared.resolve(attempt);
      const owner: OwnerDescriptor = {
        adapterId: "controlled-fixture",
        launchTicket: attempt.launchTicket,
        executionId: `execution-${attempt.identity.jobId}`,
        details: { controlled: true },
      };
      const preparedOwner = hooks.prepare
        ? await hooks.prepare(attempt, owner)
        : owner;
      if (!guard.takeSendPermission()) throw new EnhancementError("not_ready");
      owners.set(attempt.launchTicket, preparedOwner);
      return preparedOwner;
    },
    async authorize(attempt, owner, guard) {
      authorizeCalls.push(attempt);
      if (sealedTickets.has(attempt.launchTicket))
        throw new EnhancementError("not_ready");
      // This fixture's hook models the ACK after the synchronous start.
      if (!guard.takeSendPermission()) throw new EnhancementError("not_ready");
      active.add(attempt.identity.jobId);
      await hooks.authorize?.(attempt, owner);
    },
    async inspect(target, owner) {
      const original = prepareCalls.find(
        (attempt) =>
          isDeepStrictEqual(attempt.identity, target.identity) &&
          attempt.launchTicket === target.launchTicket,
      );
      const preparedOwner = owners.get(target.launchTicket);
      if (
        !original ||
        !preparedOwner ||
        (owner !== null && !isDeepStrictEqual(owner, preparedOwner))
      )
        return { kind: "unknown", ...target };
      if (active.has(target.identity.jobId))
        return { kind: "owned-alive", ...target, descriptor: preparedOwner };
      sealedTickets.add(target.launchTicket);
      return { kind: "never-authorized", ...target };
    },
    async requestStop() {},
    observeExit() {
      return () => {};
    },
  };
  return {
    adapter,
    hooks,
    prepared,
    prepareCalls,
    authorizeCalls,
    activeCount: () => active.size,
    async started(jobId: string) {
      if (!active.has(jobId))
        throw new Error("runner returned without authorizing this job");
    },
  };
}

async function harness() {
  const storage = await storageFixture();
  const executor = controlledExecutor();
  const runner = createRunner({
    store: storage.store,
    clock: clock(storage),
    executor: executor.adapter,
    ownerInstanceId: "runner-fixture-owner",
  });
  cleanups.push(async () => {
    await runner.close();
    await storage.cleanup();
  });
  const bytes = await sourceImage();
  return {
    storage,
    executor,
    runner,
    submit: (key: string) =>
      storage.service().submit(storage.principal(), submission(bytes, key)),
  };
}

async function observePrepared(
  executor: ReturnType<typeof controlledExecutor>,
  wake: Promise<void>,
) {
  // A missing implementation must fail behaviorally, not hang on a fixture barrier.
  await Promise.race([
    executor.prepared.promise,
    wake.then(() => {
      throw new Error("runner returned before preparing an accepted task");
    }),
  ]);
}

describe("minimal durable runner", () => {
  it("creates the accepted attempt directory before the executor prepares its output", async () => {
    const h = await harness();
    let outputPath: string | undefined;
    h.executor.hooks.prepare = async (attempt, owner) => {
      expect(statSync(attempt.workingDirectory).isDirectory()).toBe(true);
      outputPath = attempt.outputPath;
      writeFileSync(attempt.outputPath, "prepared-output", { flag: "wx" });
      return owner;
    };
    await h.submit("working-directory-before-prepare");
    await h.runner.wake();
    expect(h.executor.authorizeCalls).toHaveLength(1);
    expect(readFileSync(outputPath!, "utf8")).toBe("prepared-output");
  });

  it("does not prepare an attempt when its directory parent is a file", async () => {
    const h = await harness();
    const submitted = await h.submit("working-directory-parent-file");
    const blocked = join(h.storage.directory, "attempts", submitted.job.jobId);
    writeFileSync(blocked, "keep-parent", { flag: "wx" });
    await expect(h.runner.wake()).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(h.executor.prepareCalls).toHaveLength(0);
    expect(h.executor.authorizeCalls).toHaveLength(0);
    expect(readFileSync(blocked, "utf8")).toBe("keep-parent");
  });

  it("does not reuse an existing attempt directory or overwrite its contents", async () => {
    const h = await harness();
    const submitted = await h.submit("working-directory-existing");
    const directory = join(
      h.storage.directory,
      "attempts",
      submitted.job.jobId,
      "attempt-1",
      "fence-1",
    );
    mkdirSync(directory, { recursive: true });
    const preserved = join(directory, "preserved.txt");
    writeFileSync(preserved, "keep-existing", { flag: "wx" });
    await expect(h.runner.wake()).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(h.executor.prepareCalls).toHaveLength(0);
    expect(h.executor.authorizeCalls).toHaveLength(0);
    expect(readFileSync(preserved, "utf8")).toBe("keep-existing");
  });

  it("does not prepare an attempt when syncing its new directory fails", async () => {
    const h = await harness();
    await h.submit("working-directory-sync-failure");
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("controlled-directory-sync");
    });
    await expect(h.runner.wake()).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(h.executor.prepareCalls).toHaveLength(0);
    expect(h.executor.authorizeCalls).toHaveLength(0);
  });

  it("rechecks preparation permission after syncing the attempt directory", async () => {
    const h = await harness();
    await h.submit("working-directory-expired-during-sync");
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      sync(descriptor);
      h.storage.setNow(1_001 + runnerLimits.leaseDurationMs);
    });
    await h.runner.wake();
    expect(h.executor.prepareCalls).toHaveLength(0);
    expect(h.executor.authorizeCalls).toHaveLength(0);
  });

  it("starts the first job before allowing exactly two waiting jobs", async () => {
    const h = await harness();
    const first = await h.submit("first");
    await h.runner.wake();
    await h.executor.started(first.job.jobId);
    await h.submit("waiting-a");
    await h.submit("waiting-b");
    await expect(h.submit("overflow")).rejects.toMatchObject({
      code: "queue_full",
      status: 429,
    });
    expect(h.executor.activeCount()).toBe(1);
    expect(
      h.storage.store.getOwned(h.storage.principal(), first.job.jobId).status,
    ).toBe("running");
    await h.runner.wake();
    expect(h.executor.prepareCalls).toHaveLength(1);
    expect(h.executor.authorizeCalls).toHaveLength(1);
    expect(
      snapshot(h.storage, (db) =>
        db
          .prepare(
            "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status ORDER BY status",
          )
          .all(),
      ),
    ).toEqual([
      { status: "queued", count: 2 },
      { status: "running", count: 1 },
    ]);
  });

  it("coalesces concurrent wake calls while prepare is suspended", async () => {
    const h = await harness();
    const first = await h.submit("first");
    const gate = deferred();
    h.executor.hooks.prepare = async (_attempt, owner) => {
      await gate.promise;
      return owner;
    };
    const firstWake = h.runner.wake();
    void firstWake.catch(() => {});
    await observePrepared(h.executor, firstWake);
    const otherWake = h.runner.wake();
    void otherWake.catch(() => {});
    expect(h.executor.prepareCalls).toHaveLength(1);
    expect(h.executor.authorizeCalls).toHaveLength(0);
    gate.resolve();
    await Promise.all([firstWake, otherWake]);
    await h.executor.started(first.job.jobId);
    expect(h.executor.authorizeCalls).toHaveLength(1);
    expect(
      snapshot(h.storage, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM attempts").get(),
      ),
    ).toEqual({ count: 1 });
  });

  it("observes committed claim before prepare and committed descriptor authorization before execution", async () => {
    const h = await harness();
    const first = await h.submit("barriers");
    h.executor.hooks.prepare = async (attempt, owner) => {
      expect(
        snapshot(h.storage, (db) => ({
          job: db
            .prepare("SELECT status FROM jobs WHERE job_id = ?")
            .get(first.job.jobId),
          slot: db.prepare("SELECT job_id FROM execution_slot").get(),
          attempt: db
            .prepare(
              "SELECT launch_ticket, owner_descriptor_json, authorized_at FROM attempts",
            )
            .get(),
        })),
      ).toEqual({
        job: { status: "running" },
        slot: { job_id: first.job.jobId },
        attempt: {
          launch_ticket: attempt.launchTicket,
          owner_descriptor_json: null,
          authorized_at: null,
        },
      });
      return owner;
    };
    h.executor.hooks.authorize = async (attempt, owner) => {
      const row = snapshot(h.storage, (db) =>
        db
          .prepare(
            "SELECT launch_ticket, owner_descriptor_json, prepared_at, authorized_at FROM attempts",
          )
          .get(),
      ) as {
        launch_ticket: string;
        owner_descriptor_json: string;
        prepared_at: number;
        authorized_at: number;
      };
      expect(row).toMatchObject({
        launch_ticket: attempt.launchTicket,
        prepared_at: 1_000,
        authorized_at: 1_000,
      });
      expect(JSON.parse(row.owner_descriptor_json)).toEqual(owner);
      expect(Object.isFrozen(owner)).toBe(true);
      expect(Object.isFrozen(owner.details)).toBe(true);
      expect(readFileSync(attempt.inputPath)).not.toHaveLength(0);
    };
    await h.runner.wake();
    expect(h.executor.activeCount()).toBe(1);
  });

  it("keeps the durable slot when prepare fails without guessing that nothing started", async () => {
    const h = await harness();
    const first = await h.submit("first");
    h.executor.hooks.prepare = async () => {
      throw new Error("private preparation failure with internal paths");
    };
    await expect(h.runner.wake()).rejects.toMatchObject({
      code: "internal_error",
      status: 503,
    });
    expect(
      h.storage.store.getOwned(h.storage.principal(), first.job.jobId),
    ).toMatchObject({ status: "running", completedAt: null });
    expect(
      snapshot(h.storage, (db) =>
        db
          .prepare("SELECT owner_descriptor_json, authorized_at FROM attempts")
          .get(),
      ),
    ).toEqual({ owner_descriptor_json: null, authorized_at: null });
    await h.submit("waiting");
    await h.runner.wake();
    expect(h.executor.prepareCalls).toHaveLength(1);
    expect(h.executor.activeCount()).toBe(0);
  });

  it("blocks authorization of a descriptor for another launch ticket", async () => {
    const h = await harness();
    const first = await h.submit("first");
    h.executor.hooks.prepare = async (_attempt, owner) => ({
      ...owner,
      launchTicket: "wrong-ticket",
    });
    await expect(h.runner.wake()).rejects.toMatchObject({
      code: "configuration_invalid",
      status: 503,
    });
    expect(h.executor.authorizeCalls).toHaveLength(0);
    expect(
      h.storage.store.getOwned(h.storage.principal(), first.job.jobId).status,
    ).toBe("running");
    await h.runner.wake();
    expect(h.executor.prepareCalls).toHaveLength(1);
  });

  it("preserves authorization and the occupied slot when execution starts but its response is lost", async () => {
    const h = await harness();
    const first = await h.submit("first");
    h.executor.hooks.authorize = async () => {
      throw new Error("private authorization response lost");
    };
    await expect(h.runner.wake()).rejects.toMatchObject({
      code: "internal_error",
      status: 503,
    });
    expect(h.executor.activeCount()).toBe(1);
    expect(
      h.storage.store.getOwned(h.storage.principal(), first.job.jobId).status,
    ).toBe("running");
    expect(
      snapshot(h.storage, (db) =>
        db.prepare("SELECT authorized_at FROM attempts").get(),
      ),
    ).toEqual({ authorized_at: 1_000 });
    await h.runner.wake();
    expect(h.executor.authorizeCalls).toHaveLength(1);
    expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
  });

  it("does not authorize a suspended prepare after close or release its unknown slot", async () => {
    const h = await harness();
    const first = await h.submit("first");
    const gate = deferred();
    h.executor.hooks.prepare = async (_attempt, owner) => {
      await gate.promise;
      return owner;
    };
    const wake = h.runner.wake();
    void wake.catch(() => {});
    await observePrepared(h.executor, wake);
    await h.runner.close();
    gate.resolve();
    await expect(wake).rejects.toMatchObject({ code: "not_ready" });
    expect(h.executor.authorizeCalls).toHaveLength(0);
    expect(
      h.storage.store.getOwned(h.storage.principal(), first.job.jobId).status,
    ).toBe("running");
    expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
    await expect(h.runner.wake()).rejects.toMatchObject({
      code: "not_ready",
      status: 503,
    });
  });

  it("leaves an already authorized execution running when runner resources close", async () => {
    const h = await harness();
    const first = await h.submit("first");
    await h.runner.wake();
    await h.runner.close();
    await h.runner.close();
    expect(h.executor.activeCount()).toBe(1);
    expect(
      h.storage.store.getOwned(h.storage.principal(), first.job.jobId).status,
    ).toBe("running");
    expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
  });

  it.each(["lease", "execution"] as const)(
    "does not authorize when the frozen %s deadline passes during prepare",
    async (deadline) => {
      const h = await harness();
      if (deadline === "execution")
        h.storage.setRunnerLimits({
          ...runnerLimits,
          executionTimeoutMs: runnerLimits.heartbeatIntervalMs,
        });
      const first = await h.submit("first");
      h.executor.hooks.prepare = async (attempt, owner) => {
        h.storage.setNow(
          (deadline === "lease"
            ? attempt.leaseExpiresAt
            : attempt.executionDeadlineAt) + 1,
        );
        return owner;
      };
      await expect(h.runner.wake()).rejects.toMatchObject({
        code: "not_ready",
      });
      expect(h.executor.authorizeCalls).toHaveLength(0);
      expect(
        h.storage.store.getOwned(h.storage.principal(), first.job.jobId).status,
      ).toBe("running");
      expect(h.storage.store.claimNext("replacement-owner")).toBeUndefined();
    },
  );

  it("never reclaims an unknown active attempt after reopening the same persistent store", async () => {
    const h = await harness();
    const first = await h.submit("first");
    h.storage.store.claimNext("interrupted-owner");
    await h.runner.close();
    h.storage.store.close();
    const { openStore } = await import("../src/store.js");
    h.storage.setStore(
      openStore({ directory: h.storage.directory, clock: h.storage.clock }),
    );
    const runner = createRunner({
      store: h.storage.store,
      clock: clock(h.storage),
      executor: h.executor.adapter,
      ownerInstanceId: "new-owner",
    });
    cleanups.push(() => runner.close());
    await runner.wake();
    expect(h.executor.prepareCalls).toHaveLength(0);
    expect(
      h.storage.store.getOwned(h.storage.principal(), first.job.jobId).status,
    ).toBe("running");
    expect(
      snapshot(h.storage, (db) =>
        db.prepare("SELECT owner_instance_id FROM attempts").get(),
      ),
    ).toEqual({ owner_instance_id: "interrupted-owner" });
  });

  it("requires explicit wake and returns 202 for running cancel through real HTTP", async () => {
    const f = await httpFixture();
    const executor = controlledExecutor();
    const runner = createRunner({
      store: f.storage.store,
      clock: clock(f.storage),
      executor: executor.adapter,
      ownerInstanceId: "http-runner-owner",
    });
    cleanups.push(async () => {
      await runner.close();
      await f.cleanup();
    });
    const accepted = await f.upload(await sourceImage(), "http-running-cancel");
    expect(accepted.status).toBe(202);
    const first = jobOf(accepted);
    expect(first.status).toBe("queued");
    expect(executor.prepareCalls).toHaveLength(0);
    await runner.wake();
    const cancelled = await f.call(
      "DELETE",
      `/v1/enhancement-jobs/${first.jobId}`,
    );
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.code).toBe("ok");
    expect(cancelled.body.data.applied).toBe(true);
    const current = await f.call("GET", `/v1/enhancement-jobs/${first.jobId}`);
    expect(jobOf(current)).toMatchObject({
      status: "running",
      reason: null,
      completedAt: null,
      cancelRequested: true,
    });
    expect(current.raw).not.toContain(f.storage.directory);
    expect(current.raw).not.toContain("launchTicket");
    expect(executor.activeCount()).toBe(1);
    const result = await f.call(
      "GET",
      `/v1/enhancement-jobs/${first.jobId}/result`,
    );
    expect(result.status).toBe(409);
  });
});
