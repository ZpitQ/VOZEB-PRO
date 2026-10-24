import assert from "node:assert/strict";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { ResultReceiptRequest } from "../src/contracts.js";
import {
  authenticate,
  createClient,
  revokeCredential,
} from "../src/credentials.js";
import {
  openStore,
  type EnhancementStore,
  type ResultRetentionInspection,
} from "../src/store.js";
import {
  artifactFixture,
  nativePng,
  type ArtifactFixture,
} from "./artifact-fixtures.js";
import { publishedArtifactControl } from "./artifact-fault-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import { sourceImage, submission } from "./storage-fixtures.js";

const retentionMs = 60_000;
const receiptId = "10c01468-1604-4ec0-917e-d1270e686842";
const fixtures: ArtifactFixture[] = [];

afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});

async function fixture() {
  const f = await artifactFixture();
  fixtures.push(f);
  return f;
}

type Published = Awaited<ReturnType<typeof publishedArtifactControl>>;

function receiptRequest(f: ArtifactFixture, published: Published) {
  assert.ok(published.work.candidate);
  return {
    serviceId: f.storage.store.identity.serviceId,
    receiptId,
    result: { ...published.work.candidate.manifest.png },
  } satisfies ResultReceiptRequest;
}

function completedAt(f: ArtifactFixture, published: Published) {
  const value = f.job(published.attempt.identity.jobId).completedAt;
  assert.notEqual(value, null);
  return value!;
}

function facts(f: ArtifactFixture) {
  const tables = [
    "jobs",
    "attempts",
    "artifact_candidates",
    "artifact_references",
    "artifact_observations",
    "result_receipts",
    "execution_slot",
    "recovery_controls",
    "recovery_events",
    "store_incarnations",
  ] as const;
  return snapshot(f.storage, (db) =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  );
}

function reopen(f: ArtifactFixture, clock = f.storage.clock) {
  f.storage.store.close();
  const store = openStore({ directory: f.storage.directory, clock });
  f.storage.setStore(store);
  return store;
}

function editDatabase(
  f: ArtifactFixture,
  edit: (db: Database.Database) => void,
) {
  f.storage.store.close();
  const db = new Database(join(f.storage.directory, "worker.sqlite"));
  try {
    db.pragma("foreign_keys = ON");
    edit(db);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
    f.storage.setStore(
      openStore({ directory: f.storage.directory, clock: f.storage.clock }),
    );
  }
}

// Capture the real connection only during synchronous openStore setup. Every
// prepare still delegates unchanged; no statement, row or transaction is mocked.
function reopenWithConnection(f: ArtifactFixture, clock = f.storage.clock) {
  f.storage.store.close();
  const path = join(f.storage.directory, "worker.sqlite");
  const original = Database.prototype.prepare;
  let connection: Database.Database | undefined;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    if (this.name === path) connection = this;
    return original.call(this, sql);
  } as typeof original;
  try {
    const store = openStore({ directory: f.storage.directory, clock });
    f.storage.setStore(store);
    assert.ok(connection);
    return { store, db: connection };
  } finally {
    Database.prototype.prepare = original;
  }
}

function insertReceipt(
  db: Database.Database,
  published: Published,
  clientId: string,
  candidateId = published.work.candidate!.candidateId,
  attemptNo = published.attempt.identity.attemptNo,
  receivedAt: unknown = 1_000,
) {
  db.prepare(
    `INSERT INTO result_receipts
      (job_id, client_id, receipt_id, candidate_id, attempt_no, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    published.attempt.identity.jobId,
    clientId,
    receiptId,
    candidateId,
    attemptNo,
    receivedAt,
  );
}

function insertFixtureRow(
  db: Database.Database,
  table: "attempts" | "artifact_candidates",
  row: Record<string, unknown>,
) {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...Object.values(row));
}

describe("read-only retention qualification of a receipted successful result", () => {
  it("returns exactly eight frozen primitive fields and applies receipt, time and reference priority at the boundary", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(f, "retention-boundary");
    const store = f.storage.store;
    const principal = f.storage.principal();
    const jobId = published.attempt.identity.jobId;
    const retainUntil = completedAt(f, published) + retentionMs;
    const held = store.acquireArtifactWork(
      published.attempt.identity,
      "recovery",
    );
    assert.ok(held);
    f.storage.setNow(retainUntil + 1);
    const awaiting: ResultRetentionInspection = store.inspectResultRetention(
      principal,
      jobId,
      retentionMs,
    );
    expect(awaiting).toEqual({
      serviceId: store.identity.serviceId,
      jobId,
      state: "awaiting_receipt",
      checkedAt: retainUntil + 1,
      retentionMs,
      retainUntil,
      receivedAt: null,
      heldReferences: 1,
    });
    expect(Reflect.ownKeys(awaiting).sort()).toEqual(
      [
        "serviceId",
        "jobId",
        "state",
        "checkedAt",
        "retentionMs",
        "retainUntil",
        "receivedAt",
        "heldReferences",
      ].sort(),
    );
    expect(Object.isFrozen(awaiting)).toBe(true);
    expect(
      Object.values(awaiting).every(
        (value) =>
          value === null || ["string", "number"].includes(typeof value),
      ),
    ).toBe(true);

    f.storage.setNow(retainUntil - 1);
    const receipt = store.acknowledgeResult(
      principal,
      jobId,
      receiptRequest(f, published),
    );
    const pending = store.inspectResultRetention(principal, jobId, retentionMs);
    expect(pending).toEqual({
      ...awaiting,
      state: "retention_pending",
      checkedAt: retainUntil - 1,
      receivedAt: receipt.receipt.receivedAt,
    });
    expect(Object.isFrozen(pending)).toBe(true);
    f.storage.setNow(retainUntil);
    const referenced = store.inspectResultRetention(
      principal,
      jobId,
      retentionMs,
    );
    expect(referenced).toEqual({
      ...awaiting,
      state: "reference_held",
      checkedAt: retainUntil,
      receivedAt: receipt.receipt.receivedAt,
    });
    expect(Object.isFrozen(referenced)).toBe(true);
    expect(store.releaseArtifactReference(held.key)).toBe(true);
    const eligible = store.inspectResultRetention(
      principal,
      jobId,
      retentionMs,
    );
    expect(eligible).toEqual({
      ...awaiting,
      state: "eligible",
      checkedAt: retainUntil,
      receivedAt: receipt.receipt.receivedAt,
      heldReferences: 0,
    });
    expect(Object.isFrozen(eligible)).toBe(true);
    f.storage.setNow(retainUntil + 1);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs).state,
    ).toBe("eligible");
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs * 2),
    ).toMatchObject({
      state: "retention_pending",
      retentionMs: retentionMs * 2,
      retainUntil: retainUntil + retentionMs,
    });
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs - 1),
    ).toMatchObject({
      state: "eligible",
      retentionMs: retentionMs - 1,
      retainUntil: retainUntil - 1,
    });
  });

  it("keeps success as the retention origin for a late receipt and waits through clock rollback before receivedAt", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-late-receipt",
    );
    const store = f.storage.store;
    const principal = f.storage.principal();
    const jobId = published.attempt.identity.jobId;
    const retainUntil = completedAt(f, published) + retentionMs;
    const receivedAt = retainUntil + 15_000;
    f.storage.setNow(receivedAt);
    const request = receiptRequest(f, published);
    const receipt = store.acknowledgeResult(principal, jobId, request);
    expect(store.inspectResultRetention(principal, jobId, retentionMs)).toEqual(
      {
        serviceId: store.identity.serviceId,
        jobId,
        state: "eligible",
        checkedAt: receivedAt,
        retentionMs,
        retainUntil,
        receivedAt,
        heldReferences: 0,
      },
    );
    f.storage.setNow(receivedAt - 1);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs),
    ).toMatchObject({
      state: "retention_pending",
      checkedAt: receivedAt - 1,
      retainUntil,
      receivedAt,
    });
    f.storage.setNow(receivedAt);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs).state,
    ).toBe("eligible");
    f.storage.setNow(receivedAt + 1);
    expect(store.acknowledgeResult(principal, jobId, request)).toEqual({
      receipt: receipt.receipt,
      applied: false,
    });
  });

  it("counts every current recovery reference exactly and can become held again after an eligible snapshot", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-reference-target",
    );
    const other = await publishedArtifactControl(
      f,
      "retention-reference-other",
    );
    const store = f.storage.store;
    const principal = f.storage.principal();
    const jobId = published.attempt.identity.jobId;
    store.acknowledgeResult(principal, jobId, receiptRequest(f, published));
    f.storage.setNow(completedAt(f, published) + retentionMs);
    const first = store.acquireArtifactWork(
      published.attempt.identity,
      "recovery",
    );
    const second = store.acquireArtifactWork(
      published.attempt.identity,
      "recovery",
    );
    const foreign = store.acquireArtifactWork(
      other.attempt.identity,
      "recovery",
    );
    assert.ok(first && second && foreign);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs),
    ).toMatchObject({ state: "reference_held", heldReferences: 2 });
    expect(store.releaseArtifactReference(first.key)).toBe(true);
    expect(store.releaseArtifactReference(first.key)).toBe(true);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs),
    ).toMatchObject({ state: "reference_held", heldReferences: 1 });
    expect(store.releaseArtifactReference(second.key)).toBe(true);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs),
    ).toMatchObject({ state: "eligible", heldReferences: 0 });
    expect(store.readArtifactReference(foreign.key)).toBe("held");
    const later = store.acquireArtifactWork(
      published.attempt.identity,
      "recovery",
    );
    assert.ok(later);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs),
    ).toMatchObject({ state: "reference_held", heldReferences: 1 });
    expect(store.releaseArtifactReference(later.key)).toBe(true);
    expect(store.releaseArtifactReference(foreign.key)).toBe(true);
  });

  it("preserves old-incarnation, run, NULL-candidate and other-candidate protection instead of treating retired keys as released", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-old-incarnation",
    );
    const jobId = published.attempt.identity.jobId;
    f.storage.store.acknowledgeResult(
      f.storage.principal(),
      jobId,
      receiptRequest(f, published),
    );
    const originalHeld = f.storage.store.acquireArtifactWork(
      published.attempt.identity,
      "recovery",
    );
    assert.ok(originalHeld);
    const nullReference = "9b1c068b-f7ca-47cd-853f-89a832129d62";
    const otherReference = "582954de-4bcb-42d4-ab92-bcc496b926e9";
    const otherCandidate = "2ada681f-dcf4-4fd0-9492-9bb554f2b224";
    editDatabase(f, (db) => {
      db.prepare(
        `INSERT INTO artifact_candidates
          SELECT ?, job_id, attempt_no, producer_identity_json, launch_ticket,
            directory || '-retention-other', manifest_json, manifest_sha256,
            manifest_byte_length, 'intent', created_at, NULL
          FROM artifact_candidates WHERE candidate_id = ?`,
      ).run(otherCandidate, published.work.candidate!.candidateId);
      const insert = db.prepare(
        `INSERT INTO artifact_references
          SELECT ?, job_id, attempt_no, publisher_identity_json, incarnation_id,
            ?, ?, acquired_at, NULL
          FROM artifact_references WHERE reference_id = ?`,
      );
      insert.run(nullReference, "run", null, originalHeld.key.referenceId);
      insert.run(
        otherReference,
        "recovery",
        otherCandidate,
        originalHeld.key.referenceId,
      );
    });
    const store = f.storage.store;
    const principal = f.storage.principal();
    f.storage.setNow(completedAt(f, published) + retentionMs);
    expect(store.readArtifactReference(originalHeld.key)).toBe("retired");
    expect(store.releaseArtifactReference(originalHeld.key)).toBe(false);
    const before = facts(f);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs),
    ).toMatchObject({ state: "reference_held", heldReferences: 3 });
    expect(facts(f)).toEqual(before);
    const current = store.acquireArtifactWork(
      published.attempt.identity,
      "recovery",
    );
    assert.ok(current);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs)
        .heldReferences,
    ).toBe(4);
    expect(store.releaseArtifactReference(current.key)).toBe(true);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs)
        .heldReferences,
    ).toBe(3);
  });

  it("does not add artifact I/O, references or durable facts and preserves successful job and receipt replays", async () => {
    const f = await fixture();
    const key = "retention-read-only";
    const published = await publishedArtifactControl(f, key);
    const store = f.storage.store;
    const principal = f.storage.principal();
    const jobId = published.attempt.identity.jobId;
    const request = receiptRequest(f, published);
    const receipt = store.acknowledgeResult(principal, jobId, request);
    const job = store.getOwned(principal, jobId);
    f.storage.setNow(completedAt(f, published) + retentionMs);
    f.storage.setReady(false);
    const before = facts(f);
    const events = f.events.length;
    const execution = [
      f.executor.prepareCalls.length,
      f.executor.authorizeCalls.length,
      f.executor.launchCalls.length,
      f.executor.inspectCalls.length,
      f.executor.stopCalls.length,
    ];
    for (let index = 0; index < 3; index++) {
      expect(
        store.inspectResultRetention(principal, jobId, retentionMs).state,
      ).toBe("eligible");
    }
    expect(facts(f)).toEqual(before);
    expect(f.events).toHaveLength(events);
    expect([
      f.executor.prepareCalls.length,
      f.executor.authorizeCalls.length,
      f.executor.launchCalls.length,
      f.executor.inspectCalls.length,
      f.executor.stopCalls.length,
    ]).toEqual(execution);
    expect(store.getOwned(principal, jobId)).toEqual(job);
    expect(job.result).toEqual(request.result);
    f.storage.setReady(true);
    const replay = await f.storage
      .service()
      .submit(principal, submission(await sourceImage("blue"), key));
    expect(replay).toEqual({ job, replayed: true });
    expect(store.acknowledgeResult(principal, jobId, request)).toEqual({
      receipt: receipt.receipt,
      applied: false,
    });
    expect(facts(f)).toEqual(before);
    expect(f.events).toHaveLength(events);
  });

  it("preserves authentication, ownership and every non-success guard without changing result facts", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(f, "retention-guards");
    const store = f.storage.store;
    const principal = f.storage.principal();
    const jobId = published.attempt.identity.jobId;
    const other = createClient(store);
    const foreign = authenticate(store, `Bearer ${other.key}`);
    const queued = await f.storage
      .service()
      .submit(principal, submission(await sourceImage(), "retention-queued"));
    const nonSuccess = (id: string) => {
      const before = facts(f);
      const events = f.events.length;
      expect(() =>
        store.inspectResultRetention(principal, id, retentionMs),
      ).toThrowError(
        expect.objectContaining({ code: "result_not_ready", status: 409 }),
      );
      expect(facts(f)).toEqual(before);
      expect(f.events).toHaveLength(events);
    };
    nonSuccess(queued.job.jobId);
    store.requestCancel(principal, queued.job.jobId);
    nonSuccess(queued.job.jobId);
    const running = await f.claim(
      submission(await sourceImage(), "retention-running"),
    );
    nonSuccess(running.identity.jobId);
    await f.complete(running, await nativePng(running, { width: 1 }));
    expect(await f.settle(running)).toBe("failed");
    nonSuccess(running.identity.jobId);
    const before = facts(f);
    for (const [client, id, code, status] of [
      [principal, "missing-job", "job_not_found", 404],
      [foreign, jobId, "job_not_found", 404],
      [{ ...principal }, jobId, "authentication_failed", 401],
    ] as const) {
      expect(() =>
        store.inspectResultRetention(client, id, retentionMs),
      ).toThrowError(expect.objectContaining({ code, status }));
    }
    revokeCredential(store, principal.credentialId);
    expect(() =>
      store.inspectResultRetention(principal, jobId, retentionMs),
    ).toThrowError(
      expect.objectContaining({ code: "authentication_failed", status: 401 }),
    );
    expect(facts(f)).toEqual(before);
  });

  it("requires an explicit positive safe integer before clock access and rejects a safe duration whose sum overflows", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-input-boundary",
    );
    const jobId = published.attempt.identity.jobId;
    f.storage.store.acknowledgeResult(
      f.storage.principal(),
      jobId,
      receiptRequest(f, published),
    );
    const completed = completedAt(f, published);
    let observed = false;
    let calls = 0;
    let db: Database.Database | undefined;
    const transactions: boolean[] = [];
    const captured = reopenWithConnection(f, () => {
      if (observed) {
        calls++;
        transactions.push(db!.inTransaction);
      }
      return f.storage.clock();
    });
    db = captured.db;
    const store = captured.store;
    const principal = f.storage.principal();
    const before = facts(f);
    const events = f.events.length;
    observed = true;
    for (const value of [
      undefined,
      null,
      "60000",
      true,
      {},
      1n,
      0,
      -1,
      0.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        store.inspectResultRetention(principal, jobId, value as number),
      ).toThrowError(
        expect.objectContaining({ code: "invalid_request", status: 400 }),
      );
    }
    expect(calls).toBe(0);
    expect(() =>
      store.inspectResultRetention(principal, jobId, Number.MAX_SAFE_INTEGER),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_request", status: 400 }),
    );
    expect(calls).toBe(1);
    calls = 0;
    f.storage.setNow(Number.MAX_SAFE_INTEGER);
    const signal = new AbortController().signal;
    const nativeAborted = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    )?.get;
    assert.ok(nativeAborted);
    const signalTransactions: boolean[] = [];
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get() {
        signalTransactions.push(db!.inTransaction);
        return nativeAborted.call(signal) as boolean;
      },
    });
    const originalOwned = store.getOwned;
    const originalPublished = store.getPublishedResultPublisher;
    const ownedTransactions: boolean[] = [];
    const publishedTransactions: boolean[] = [];
    store.getOwned = (client, id) => {
      ownedTransactions.push(db!.inTransaction);
      return originalOwned.call(store, client, id);
    };
    store.getPublishedResultPublisher = (client, id) => {
      publishedTransactions.push(db!.inTransaction);
      return originalPublished.call(store, client, id);
    };
    try {
      expect(
        store.inspectResultRetention(
          principal,
          jobId,
          Number.MAX_SAFE_INTEGER - completed,
          signal,
        ),
      ).toMatchObject({
        state: "eligible",
        checkedAt: Number.MAX_SAFE_INTEGER,
        retainUntil: Number.MAX_SAFE_INTEGER,
      });
    } finally {
      store.getOwned = originalOwned;
      store.getPublishedResultPublisher = originalPublished;
      Reflect.deleteProperty(signal, "aborted");
    }
    expect(calls).toBe(1);
    expect(transactions.every((active) => !active)).toBe(true);
    expect(signalTransactions.length).toBeGreaterThan(0);
    expect(signalTransactions.every((active) => !active)).toBe(true);
    expect(ownedTransactions.length).toBeGreaterThan(0);
    expect(publishedTransactions.length).toBeGreaterThan(0);
    expect(ownedTransactions.every((active) => active)).toBe(true);
    expect(publishedTransactions.every((active) => active)).toBe(true);
    expect(facts(f)).toEqual(before);
    expect(f.events).toHaveLength(events);
    const controller = new AbortController();
    controller.abort();
    calls = 0;
    expect(() =>
      store.inspectResultRetention(
        principal,
        jobId,
        retentionMs,
        controller.signal,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_request", status: 400 }),
    );
    expect(calls).toBe(0);
    store.close();
    expect(() =>
      store.inspectResultRetention(principal, jobId, retentionMs),
    ).toThrowError(
      expect.objectContaining({ code: "internal_error", status: 503 }),
    );
    expect(calls).toBe(0);
    expect(facts(f)).toEqual(before);
  });

  it("uses the existing Store.now safe clock contract without publishing a snapshot for invalid clock values", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-invalid-clock",
    );
    let override: number | undefined;
    const store = reopen(f, () => override ?? f.storage.clock());
    const principal = f.storage.principal();
    const before = facts(f);
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      override = value;
      expect(() =>
        store.inspectResultRetention(
          principal,
          published.attempt.identity.jobId,
          retentionMs,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "configuration_invalid" }),
      );
    }
    override = undefined;
    expect(facts(f)).toEqual(before);
  });

  it.each(["revoke", "close", "abort"] as const)(
    "rechecks authority after a synchronous clock callback can %s",
    async (mode) => {
      const f = await fixture();
      const published = await publishedArtifactControl(
        f,
        `retention-clock-${mode}`,
      );
      const jobId = published.attempt.identity.jobId;
      f.storage.store.acknowledgeResult(
        f.storage.principal(),
        jobId,
        receiptRequest(f, published),
      );
      f.storage.setNow(completedAt(f, published) + retentionMs);
      const controller = new AbortController();
      let armed = false;
      let calls = 0;
      let store: EnhancementStore;
      store = reopen(f, () => {
        const now = f.storage.clock();
        if (armed) {
          armed = false;
          calls++;
          if (mode === "revoke") store.revokeCredential(principal.credentialId);
          if (mode === "close") store.close();
          if (mode === "abort") controller.abort();
        }
        return now;
      });
      const principal = f.storage.principal();
      const before = facts(f);
      const events = f.events.length;
      const [code, status] =
        mode === "revoke"
          ? ["authentication_failed", 401]
          : mode === "close"
            ? ["internal_error", 503]
            : ["invalid_request", 400];
      armed = true;
      expect(() =>
        store.inspectResultRetention(
          principal,
          jobId,
          retentionMs,
          controller.signal,
        ),
      ).toThrowError(expect.objectContaining({ code, status }));
      expect(calls).toBe(1);
      expect(facts(f)).toEqual(before);
      expect(f.events).toHaveLength(events);
    },
  );

  it("rechecks the principal after a post-clock native signal getter revokes it and calls no external callback in its transaction", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-signal-authority",
    );
    let armed = false;
    let afterClock = false;
    const { store, db } = reopenWithConnection(f, () => {
      if (armed) {
        armed = false;
        afterClock = true;
      }
      return f.storage.clock();
    });
    const principal = f.storage.principal();
    const before = facts(f);
    const signal = new AbortController().signal;
    const nativeAborted = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    )?.get;
    assert.ok(nativeAborted);
    const transactions: boolean[] = [];
    let revocations = 0;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get() {
        transactions.push(db.inTransaction);
        if (afterClock && revocations === 0) {
          revocations++;
          revokeCredential(store, principal.credentialId);
        }
        return nativeAborted.call(signal) as boolean;
      },
    });
    try {
      armed = true;
      expect(() =>
        store.inspectResultRetention(
          principal,
          published.attempt.identity.jobId,
          retentionMs,
          signal,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "authentication_failed", status: 401 }),
      );
    } finally {
      Reflect.deleteProperty(signal, "aborted");
    }
    expect(revocations).toBe(1);
    expect(transactions.length).toBeGreaterThan(0);
    expect(transactions.every((active) => !active)).toBe(true);
    expect(nativeAborted.call(signal)).toBe(false);
    expect(facts(f)).toEqual(before);
  });

  it("rejects an existing uncommitted receipt transaction before calling clock", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-existing-transaction",
    );
    let observed = false;
    let calls = 0;
    const { store, db } = reopenWithConnection(f, () => {
      if (observed) calls++;
      return f.storage.clock();
    });
    const principal = f.storage.principal();
    const jobId = published.attempt.identity.jobId;
    f.storage.setNow(completedAt(f, published) + retentionMs);
    const before = facts(f);
    observed = true;
    db.exec("BEGIN");
    try {
      insertReceipt(db, published, principal.clientId);
      expect(() =>
        store.inspectResultRetention(principal, jobId, retentionMs),
      ).toThrowError(
        expect.objectContaining({ code: "internal_error", status: 503 }),
      );
      expect(calls).toBe(0);
      expect(db.inTransaction).toBe(true);
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
    }
    expect(facts(f)).toEqual(before);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs).state,
    ).toBe("awaiting_receipt");
  });

  it("rejects a transaction opened by clock before it can join an uncommitted receipt snapshot", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-new-outer-transaction",
    );
    let armed = false;
    let calls = 0;
    let active: Database.Database | undefined;
    const { store, db } = reopenWithConnection(f, () => {
      if (armed) {
        armed = false;
        calls++;
        active!.exec("BEGIN");
        insertReceipt(active!, published, principal.clientId);
      }
      return f.storage.clock();
    });
    active = db;
    const principal = f.storage.principal();
    const jobId = published.attempt.identity.jobId;
    f.storage.setNow(completedAt(f, published) + retentionMs);
    const before = facts(f);
    armed = true;
    try {
      expect(() =>
        store.inspectResultRetention(principal, jobId, retentionMs),
      ).toThrowError(
        expect.objectContaining({ code: "internal_error", status: 503 }),
      );
      expect(calls).toBe(1);
      expect(db.inTransaction).toBe(true);
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
    }
    expect(facts(f)).toEqual(before);
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs).state,
    ).toBe("awaiting_receipt");
  });

  it("maps a real SQLite connection read failure to internal_error without artifact work", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-sqlite-read-failure",
    );
    const { store, db } = reopenWithConnection(f);
    const principal = f.storage.principal();
    const before = facts(f);
    const events = f.events.length;
    db.close();
    expect(store.closed).toBe(false);
    expect(() =>
      store.inspectResultRetention(
        principal,
        published.attempt.identity.jobId,
        retentionMs,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "internal_error", status: 503 }),
    );
    expect(facts(f)).toEqual(before);
    expect(f.events).toHaveLength(events);
  });

  it("excludes another attempt's reference and rejects schema-valid wrong receipt bindings; schema excludes invalid receipt times", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-corrupt-receipt",
    );
    const jobId = published.attempt.identity.jobId;
    const clientId = f.storage.principal().clientId;
    const otherClient = createClient(f.storage.store).clientId;
    const otherCandidate = "f3d428b6-c85d-4637-86bf-201a8b0a747e";
    const otherAttemptCandidate = "7325778b-356c-479a-bf54-061499013e85";
    const otherAttemptNo = published.attempt.identity.attemptNo + 1;
    editDatabase(f, (db) => {
      const attempt = db
        .prepare("SELECT * FROM attempts WHERE job_id = ? AND attempt_no = ?")
        .get(jobId, published.attempt.identity.attemptNo) as Record<
        string,
        unknown
      >;
      const candidate = db
        .prepare("SELECT * FROM artifact_candidates WHERE candidate_id = ?")
        .get(published.work.candidate!.candidateId) as Record<string, unknown>;
      insertFixtureRow(db, "artifact_candidates", {
        ...candidate,
        candidate_id: otherCandidate,
        directory: `${candidate.directory}-retention-wrong-candidate`,
        state: "intent",
        durable_at: null,
      });
      const producer = JSON.stringify({
        ...JSON.parse(attempt.producer_identity_json as string),
        attemptNo: otherAttemptNo,
      });
      const launchTicket = "ac9f3bbc-e8d5-4e7b-bdda-6fdcb104ae32";
      insertFixtureRow(db, "attempts", {
        ...attempt,
        attempt_no: otherAttemptNo,
        producer_identity_json: producer,
        launch_ticket: launchTicket,
        run_directory: `${attempt.run_directory}-retention-wrong-attempt`,
      });
      insertFixtureRow(db, "artifact_candidates", {
        ...candidate,
        candidate_id: otherAttemptCandidate,
        attempt_no: otherAttemptNo,
        producer_identity_json: producer,
        launch_ticket: launchTicket,
        directory: `${candidate.directory}-retention-wrong-attempt`,
        state: "intent",
        durable_at: null,
      });
      db.prepare(
        `INSERT INTO artifact_references
          (reference_id, job_id, attempt_no, publisher_identity_json,
           incarnation_id, purpose, candidate_id, acquired_at, released_at)
         VALUES (?, ?, ?, ?, ?, 'recovery', ?, 1000, NULL)`,
      ).run(
        "a939b9cd-6b7c-47ef-b58c-3f19e18805d7",
        jobId,
        otherAttemptNo,
        producer,
        attempt.producer_incarnation_id,
        otherAttemptCandidate,
      );
    });
    const retainUntil = completedAt(f, published) + retentionMs;
    f.storage.setNow(retainUntil);
    f.storage.store.acknowledgeResult(
      f.storage.principal(),
      jobId,
      receiptRequest(f, published),
    );
    expect(
      f.storage.store.inspectResultRetention(
        f.storage.principal(),
        jobId,
        retentionMs,
      ),
    ).toMatchObject({
      state: "eligible",
      heldReferences: 0,
      retainUntil,
      receivedAt: retainUntil,
    });
    for (const [owner, candidateId, attemptNo] of [
      [
        otherClient,
        published.work.candidate!.candidateId,
        published.attempt.identity.attemptNo,
      ],
      [clientId, otherCandidate, published.attempt.identity.attemptNo],
      [clientId, otherAttemptCandidate, otherAttemptNo],
    ] as const) {
      editDatabase(f, (db) => {
        db.prepare("DELETE FROM result_receipts WHERE job_id = ?").run(jobId);
        insertReceipt(db, published, owner, candidateId, attemptNo);
      });
      const before = facts(f);
      const events = f.events.length;
      expect(() =>
        f.storage.store.inspectResultRetention(
          f.storage.principal(),
          jobId,
          retentionMs,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "internal_error", status: 503 }),
      );
      expect(facts(f)).toEqual(before);
      expect(f.events).toHaveLength(events);
    }
    editDatabase(f, (db) => {
      db.prepare("DELETE FROM result_receipts WHERE job_id = ?").run(jobId);
      for (const value of [
        -1,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        Infinity,
        NaN,
        "invalid",
        null,
      ]) {
        expect(() =>
          insertReceipt(
            db,
            published,
            clientId,
            published.work.candidate!.candidateId,
            published.attempt.identity.attemptNo,
            value,
          ),
        ).toThrowError(
          expect.objectContaining({
            code: expect.stringMatching(/^SQLITE_CONSTRAINT_/),
          }),
        );
      }
    });
  });

  it("keeps the existing selected-result qualification checks for a schema-valid success with missing exit evidence", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "retention-success-qualification",
    );
    const jobId = published.attempt.identity.jobId;
    f.storage.store.acknowledgeResult(
      f.storage.principal(),
      jobId,
      receiptRequest(f, published),
    );
    editDatabase(f, (db) => {
      db.prepare(
        "UPDATE attempts SET exit_json = NULL, exit_observed_at = NULL WHERE job_id = ? AND attempt_no = ?",
      ).run(jobId, published.attempt.identity.attemptNo);
    });
    const before = facts(f);
    const events = f.events.length;
    expect(() =>
      f.storage.store.inspectResultRetention(
        f.storage.principal(),
        jobId,
        retentionMs,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "internal_error", status: 503 }),
    );
    expect(facts(f)).toEqual(before);
    expect(f.events).toHaveLength(events);
  });
});
