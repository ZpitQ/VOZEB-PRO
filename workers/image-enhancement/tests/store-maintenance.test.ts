import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import {
  EnhancementError,
  INTERNAL_SELF_TEST_KEY_PREFIX,
  toErrorResponse,
} from "../src/contracts.js";
import { authenticate, createClient } from "../src/credentials.js";
import { createJobService } from "../src/jobs.js";
import { openStore, type EnhancementStore } from "../src/store.js";
import { configInput } from "./fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import {
  recursiveFiles,
  runnerLimits,
  sourceImage,
  storageFixture,
  submission,
  submissionLimits,
} from "./storage-fixtures.js";

type Storage = Awaited<ReturnType<typeof storageFixture>>;
type Counts = Readonly<{
  queued: number;
  running: number;
  slots: number;
  unreleasedReferences: number;
}>;
const empty: Counts = {
  queued: 0,
  running: 0,
  slots: 0,
  unreleasedReferences: 0,
};
const busy: Counts = {
  queued: 0,
  running: 2,
  slots: 1,
  unreleasedReferences: 4,
};
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const storage = await storageFixture();
  cleanups.push(() => storage.cleanup());
  return storage;
}

// Called inside each it before further preparation, so a missing additive
// method is an explicit behavior assertion rather than a fixture/import error.
function inspector(store: EnhancementStore) {
  const method: unknown = Reflect.get(store, "inspectMaintenance");
  expect(typeof method, "Store exposes callable inspectMaintenance").toBe(
    "function",
  );
  return () => Reflect.apply(method as () => unknown, store, []) as Counts;
}

function expectCounts(actual: Counts, expected: Counts) {
  expect(
    actual !== null && typeof actual === "object" && !Array.isArray(actual),
    "synchronous count object",
  ).toBe(true);
  const keys = Reflect.ownKeys(actual);
  expect(
    keys.every((key) => typeof key === "string") &&
      isDeepStrictEqual(keys.slice().sort(), Object.keys(expected).sort()),
    "exact primitive count whitelist",
  ).toBe(true);
  expect(
    keys.every((key) =>
      Object.hasOwn(Object.getOwnPropertyDescriptor(actual, key)!, "value"),
    ),
    "count properties are data, without external getters",
  ).toBe(true);
  expect(
    Object.values(actual).every(
      (value) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    ) && actual.slots <= 1,
  ).toBe(true);
  expect(Object.isFrozen(actual), "frozen count snapshot").toBe(true);
  expect(isDeepStrictEqual(actual, expected), "global count facts").toBe(true);
}

async function durableBytes(storage: Storage) {
  return Promise.all(
    (await recursiveFiles(storage.directory)).sort().map(async (path) => ({
      name: relative(storage.directory, path),
      bytes: await readFile(path),
    })),
  );
}

// Existing retention/identity tests use this same synchronous capture. Every
// setup prepare delegates to the real driver; the Store keeps the real handle.
function reopenWithConnection(storage: Storage, clock = storage.clock) {
  storage.store.close();
  const path = join(storage.directory, "worker.sqlite");
  const prepare = Database.prototype.prepare;
  let connection: Database.Database | undefined;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    if (this.name === path) connection = this;
    return prepare.call(this, sql);
  } as typeof prepare;
  try {
    const store = openStore({ directory: storage.directory, clock });
    storage.setStore(store);
    assert.ok(connection, "the real Store connection was observed");
    return { store, db: connection };
  } finally {
    Database.prototype.prepare = prepare;
  }
}

function forbiddenWork(store: EnhancementStore) {
  return [
    vi.spyOn(store, "now"),
    vi.spyOn(store, "assertPrincipal"),
    vi.spyOn(store, "claimNext"),
    vi.spyOn(store, "beginRecovery"),
    vi.spyOn(store, "releaseArtifactReference"),
  ];
}

function safeFailure(action: () => unknown, privateValues: readonly string[]) {
  let returned = false;
  let failure: unknown;
  try {
    action();
    returned = true;
  } catch (error) {
    failure = error;
  }
  expect(returned, "failure returns no snapshot or fallback zero").toBe(false);
  expect(
    failure instanceof EnhancementError &&
      failure.code === "internal_error" &&
      failure.status === 503,
    "safe internal_error",
  ).toBe(true);
  const rendered =
    String(failure) +
    JSON.stringify(failure) +
    JSON.stringify(toErrorResponse(failure, "maintenance-count-test"));
  expect(
    privateValues.every((value) => !rendered.includes(value)),
    "no private path, credential, SQL or driver detail",
  ).toBe(true);
}

// Observe the original transaction/statement executions, without replacing any
// row, count or transaction body. The callable default is recorded separately.
function observeReads(db: Database.Database) {
  const modes: string[] = [];
  const preparedReadOnly: boolean[] = [];
  const reads: { readonly: boolean; inTransaction: boolean }[] = [];
  const transaction = db.transaction;
  const prepare = db.prepare;
  db.transaction = function (
    this: Database.Database,
    operation: (...parameters: unknown[]) => unknown,
  ) {
    const real = transaction.call(this, operation);
    const invoke =
      (mode: "deferred" | "immediate" | "exclusive") =>
      (...parameters: unknown[]) => {
        modes.push(mode);
        return Reflect.apply(real[mode], real, parameters);
      };
    return Object.assign(
      (...parameters: unknown[]) => {
        modes.push("default");
        return Reflect.apply(real, real, parameters);
      },
      {
        deferred: invoke("deferred"),
        immediate: invoke("immediate"),
        exclusive: invoke("exclusive"),
      },
    );
  } as typeof transaction;
  db.prepare = function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql);
    preparedReadOnly.push(statement.readonly);
    const get = statement.get;
    Object.defineProperty(statement, "get", {
      configurable: true,
      value: (...parameters: unknown[]) => {
        reads.push({
          readonly: statement.readonly,
          inTransaction: db.inTransaction,
        });
        return Reflect.apply(get, statement, parameters);
      },
    });
    return statement;
  } as typeof prepare;
  return {
    modes,
    preparedReadOnly,
    reads,
    restore() {
      db.transaction = transaction;
      db.prepare = prepare;
    },
  };
}

async function busyFixture(storage: Storage) {
  const bytes = await sourceImage();
  const first = await storage
    .service()
    .submit(storage.principal(), submission(bytes, "maintenance-origin"));
  const other = createClient(storage.store);
  const otherPrincipal = authenticate(storage.store, "Bearer " + other.key);
  const second = await storage
    .service()
    .submit(otherPrincipal, submission(bytes, "maintenance-other-client"));
  const original = storage.store.claimNext(
    "maintenance-old-owner",
    first.job.jobId,
  );
  assert.ok(original);
  const clock = vi.fn(storage.clock);
  const { store, db } = reopenWithConnection(storage, clock);

  // Legal table states deliberately lack a matching active-holder join: keep
  // the first running row without a slot, then claim the second with the Store.
  db.prepare("DELETE FROM execution_slot").run();
  const current = store.claimNext(
    "maintenance-current-owner",
    second.job.jobId,
  );
  assert.ok(current);
  const insert = db.prepare(
    "INSERT INTO artifact_references " +
      "(reference_id, job_id, attempt_no, publisher_identity_json, incarnation_id, " +
      "purpose, candidate_id, acquired_at, released_at) " +
      "SELECT ?, job_id, attempt_no, producer_identity_json, producer_incarnation_id, " +
      "?, NULL, 1000, ? FROM attempts WHERE job_id = ? AND attempt_no = ?",
  );
  for (const attempt of [original, current]) {
    for (const purpose of ["run", "recovery"] as const)
      expect(
        insert.run(
          randomUUID(),
          purpose,
          null,
          attempt.identity.jobId,
          attempt.identity.attemptNo,
        ).changes,
      ).toBe(1);
  }
  expect(
    insert.run(
      randomUUID(),
      "recovery",
      1000,
      current.identity.jobId,
      current.identity.attemptNo,
    ).changes,
  ).toBe(1);
  db.prepare("UPDATE jobs SET cancel_requested_at = 1000 WHERE job_id = ?").run(
    original.identity.jobId,
  );
  db.prepare(
    "UPDATE jobs SET active_attempt_no = active_attempt_no + 1, " +
      "current_fence = current_fence + 1 WHERE job_id = ?",
  ).run(current.identity.jobId);
  expect(isDeepStrictEqual(db.pragma("foreign_key_check"), [])).toBe(true);
  storage.setNow(200_000);
  clock.mockClear();
  return { store, db, clock };
}

// Only fault tests replace native COUNT result data, after the real SELECT.
// The distinct real totals (0, 2, 1, 4) identify a field without fixing SQL aliases
// or requiring either one combined SELECT or four individual COUNT statements.
function faultCountRows(
  db: Database.Database,
  edit: (row: Record<string, unknown>) => unknown,
) {
  const prepare = db.prepare;
  let calls = 0;
  db.prepare = function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql);
    if (statement.reader && /\bcount\s*\(/i.test(sql)) {
      const get = statement.get;
      Object.defineProperty(statement, "get", {
        configurable: true,
        value: (...parameters: unknown[]) => {
          const row = Reflect.apply(get, statement, parameters) as Record<
            string,
            unknown
          >;
          calls++;
          return edit(row);
        },
      });
    }
    return statement;
  } as typeof prepare;
  return {
    calls: () => calls,
    restore() {
      db.prepare = prepare;
    },
  };
}

describe("Store global read-only maintenance counts", () => {
  it("returns an exact frozen empty snapshot in one synchronous deferred read transaction without clock or authority callbacks", async () => {
    const storage = await fixture();
    inspector(storage.store);
    const clock = vi.fn(storage.clock);
    const { store, db } = reopenWithConnection(storage, clock);
    const inspect = inspector(store);
    const forbidden = forbiddenWork(store);
    const before = await durableBytes(storage);
    clock.mockClear();
    const observation = observeReads(db);
    let result: Counts;
    try {
      result = inspect();
    } finally {
      observation.restore();
    }
    expectCounts(result!, empty);
    expect(isDeepStrictEqual(observation.modes, ["deferred"])).toBe(true);
    expect(
      observation.preparedReadOnly.length > 0 &&
        observation.preparedReadOnly.every(Boolean),
      "prepared statements are read-only",
    ).toBe(true);
    expect(
      observation.reads.length > 0 &&
        observation.reads.every((read) => read.readonly && read.inTransaction),
      "every real count read belongs to the sole read transaction",
    ).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(clock.mock.calls.length).toBe(0);
    expect(forbidden.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(isDeepStrictEqual(await durableBytes(storage), before)).toBe(true);
  }, 15_000);

  it("counts ordinary, self-test, other-client and already expired queued rows globally without expiring or rewriting their bytes", async () => {
    const storage = await fixture();
    inspector(storage.store);
    const bytes = await sourceImage();
    const operator = storage.principal();
    const other = createClient(storage.store);
    const otherPrincipal = authenticate(storage.store, "Bearer " + other.key);
    const config = createWorkerConfig(configInput());
    const options = {
      store: storage.store,
      config: () => config,
      ready: () => true,
      limits: { ...submissionLimits, maxWaitingJobs: 3 },
      runnerLimits,
    };
    const service = createJobService(options);
    const terminal = await service.submit(
      operator,
      submission(bytes, "maintenance-terminal"),
    );
    service.cancel(operator, terminal.job.jobId);
    await service.submit(operator, submission(bytes, "maintenance-ordinary"));
    const key = INTERNAL_SELF_TEST_KEY_PREFIX + randomUUID();
    await createJobService({
      ...options,
      internalIdempotencyKey: key,
    }).submit(operator, submission(bytes, key));
    await service.submit(
      otherPrincipal,
      submission(bytes, "maintenance-foreign"),
    );
    storage.setNow(storage.clock() + submissionLimits.queueTimeoutMs + 1);
    const clock = vi.fn(storage.clock);
    const { store } = reopenWithConnection(storage, clock);
    const inspect = inspector(store);
    const forbidden = forbiddenWork(store);
    const rows = snapshot(storage, (db) =>
      db.prepare("SELECT status, queue_deadline_at FROM jobs").all(),
    ) as { status: string; queue_deadline_at: number }[];
    expect(
      rows.filter(
        (row) =>
          row.status === "queued" && row.queue_deadline_at < storage.clock(),
      ).length,
    ).toBe(3);
    expect(rows.filter((row) => row.status === "cancelled").length).toBe(1);
    const before = await durableBytes(storage);
    clock.mockClear();
    expectCounts(inspect(), { ...empty, queued: 3 });
    expectCounts(inspect(), { ...empty, queued: 3 });
    expect(clock.mock.calls.length).toBe(0);
    expect(forbidden.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(isDeepStrictEqual(await durableBytes(storage), before)).toBe(true);
  }, 15_000);

  it("keeps running rows with pending cancellation or expired leases/deadlines, an unmatched raw slot, and old/current run/recovery NULL-candidate references visible while excluding released references", async () => {
    const storage = await fixture();
    inspector(storage.store);
    const { store, db, clock } = await busyFixture(storage);
    const inspect = inspector(store);
    const references = db
      .prepare(
        "SELECT incarnation_id, purpose, candidate_id, released_at FROM artifact_references",
      )
      .all() as {
      incarnation_id: string;
      purpose: string;
      candidate_id: string | null;
      released_at: number | null;
    }[];
    expect(new Set(references.map((row) => row.incarnation_id)).size).toBe(2);
    expect(new Set(references.map((row) => row.purpose)).size).toBe(2);
    expect(references.every((row) => row.candidate_id === null)).toBe(true);
    expect(references.filter((row) => row.released_at === null).length).toBe(4);
    expect(references.filter((row) => row.released_at !== null).length).toBe(1);
    expect(
      db
        .prepare(
          "SELECT 1 FROM execution_slot s JOIN jobs j ON j.job_id = s.job_id " +
            "AND j.active_attempt_no = s.attempt_no AND j.current_fence = s.fence",
        )
        .get() === undefined,
      "the raw slot cannot be recovered by an active-job join",
    ).toBe(true);
    const forbidden = forbiddenWork(store);
    const before = await durableBytes(storage);
    clock.mockClear();
    expectCounts(inspect(), busy);
    expect(clock.mock.calls.length).toBe(0);
    expect(forbidden.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(isDeepStrictEqual(await durableBytes(storage), before)).toBe(true);
  }, 15_000);

  it("rejects a closed Store without a fallback zero or durable change", async () => {
    const storage = await fixture();
    const inspect = inspector(storage.store);
    storage.store.close();
    const before = await durableBytes(storage);
    safeFailure(inspect, [
      storage.directory,
      storage.initialized.credential.key,
    ]);
    expect(storage.store.closed).toBe(true);
    expect(isDeepStrictEqual(await durableBytes(storage), before)).toBe(true);
  }, 15_000);

  it("rejects an existing uncommitted transaction before clock access without committing or rolling back the caller's write", async () => {
    const storage = await fixture();
    inspector(storage.store);
    const accepted = await storage
      .service()
      .submit(storage.principal(), submission(await sourceImage()));
    const clock = vi.fn(storage.clock);
    const { store, db } = reopenWithConnection(storage, clock);
    const inspect = inspector(store);
    const before = await durableBytes(storage);
    clock.mockClear();
    const marker = "maintenance-uncommitted-private";
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE jobs SET idempotency_key = ? WHERE job_id = ?").run(
        marker,
        accepted.job.jobId,
      );
      const beforeInspection = await durableBytes(storage);
      safeFailure(inspect, [storage.directory, marker]);
      expect(
        isDeepStrictEqual(await durableBytes(storage), beforeInspection),
      ).toBe(true);
      expect(db.inTransaction).toBe(true);
      expect(
        db
          .prepare("SELECT 1 FROM jobs WHERE idempotency_key = ?")
          .get(marker) !== undefined,
      ).toBe(true);
      expect(clock.mock.calls.length).toBe(0);
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
    }
    const afterRollback = await durableBytes(storage);
    expect(
      isDeepStrictEqual(
        afterRollback.find((file) => file.name === "worker.sqlite"),
        before.find((file) => file.name === "worker.sqlite"),
      ),
    ).toBe(true);
    expectCounts(inspect(), { ...empty, queued: 1 });
  }, 15_000);

  it("sanitizes a real SQLite read failure while Store.closed remains false and leaves durable bytes unchanged", async () => {
    const storage = await fixture();
    inspector(storage.store);
    const clock = vi.fn(storage.clock);
    const { store, db } = reopenWithConnection(storage, clock);
    const inspect = inspector(store);
    clock.mockClear();
    db.close();
    expect(store.closed).toBe(false);
    const before = await durableBytes(storage);
    safeFailure(inspect, [
      storage.directory,
      storage.initialized.credential.key,
      "worker.sqlite",
      "The database connection is not open",
      "SQLITE",
    ]);
    expect(clock.mock.calls.length).toBe(0);
    expect(isDeepStrictEqual(await durableBytes(storage), before)).toBe(true);
  }, 15_000);

  it("sanitizes missing result shapes and negative, fractional, unsafe, nonnumber or multiple-slot counts instead of returning a partial or zero snapshot", async () => {
    const storage = await fixture();
    inspector(storage.store);
    const { store, db, clock } = await busyFixture(storage);
    const inspect = inspector(store);
    expectCounts(inspect(), busy);
    const before = await durableBytes(storage);
    const faults: {
      name: string;
      target?: number;
      value?: unknown;
      row?: () => unknown;
    }[] = [
      { name: "negative queued", target: 0, value: -1 },
      { name: "fractional running", target: 2, value: 0.5 },
      { name: "multiple slots", target: 1, value: 2 },
      {
        name: "unsafe references",
        target: 4,
        value: Number.MAX_SAFE_INTEGER + 1,
      },
      { name: "nonnumber queued", target: 0, value: "0" },
      { name: "missing row", row: () => undefined },
      { name: "missing count properties", row: () => ({}) },
    ];
    clock.mockClear();
    for (const fault of faults) {
      let injected = false;
      const interception = faultCountRows(db, (row) => {
        if (fault.row) {
          injected = true;
          return fault.row();
        }
        return Object.fromEntries(
          Object.entries(row).map(([key, value]) => {
            if (value !== fault.target) return [key, value];
            injected = true;
            return [key, fault.value];
          }),
        );
      });
      try {
        safeFailure(inspect, [
          storage.directory,
          storage.initialized.credential.key,
          "SQLITE",
        ]);
        expect(
          injected && interception.calls() > 0,
          fault.name + " perturbs a real COUNT result",
        ).toBe(true);
        expect(
          db.inTransaction,
          "failed read releases its own transaction",
        ).toBe(false);
      } finally {
        interception.restore();
      }
    }
    expect(clock.mock.calls.length).toBe(0);
    expectCounts(inspect(), busy);
    expect(isDeepStrictEqual(await durableBytes(storage), before)).toBe(true);
  }, 15_000);
});
