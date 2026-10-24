import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { ResultReceiptRequest } from "../src/contracts.js";
import {
  authenticate,
  createClient,
  revokeCredential,
  rotateCredential,
} from "../src/credentials.js";
import { openStore, type EnhancementStore } from "../src/store.js";
import {
  artifactFixture,
  nativePng,
  type ArtifactFixture,
} from "./artifact-fixtures.js";
import { publishedArtifactControl } from "./artifact-fault-fixtures.js";
import { commitFault, snapshot } from "./lifecycle-fixtures.js";
import { sourceImage, submission } from "./storage-fixtures.js";

const firstReceiptId = "a9c16e4d-06ab-4cc2-87c8-c2f012be1d36";
const nextReceiptId = "cf0029db-6c7c-4bd0-ab11-de04e377f1c7";
const foreignServiceId = "f187c72a-4d9a-4f41-9763-09db13e36ddc";
const fixtures: ArtifactFixture[] = [];

afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});

async function fixture() {
  const f = await artifactFixture();
  fixtures.push(f);
  return f;
}

function receiptRequest(
  f: ArtifactFixture,
  published: Awaited<ReturnType<typeof publishedArtifactControl>>,
  receiptId = firstReceiptId,
): ResultReceiptRequest {
  assert.ok(published.work.candidate);
  return {
    serviceId: f.storage.store.identity.serviceId,
    receiptId,
    result: { ...published.work.candidate.manifest.png },
  };
}

type ReceiptRow = {
  job_id: string;
  client_id: string;
  receipt_id: string;
  candidate_id: string;
  attempt_no: number;
  received_at: number;
};

function receipts(f: ArtifactFixture) {
  return snapshot(
    f.storage,
    (db) =>
      db
        .prepare("SELECT * FROM result_receipts ORDER BY rowid")
        .all() as ReceiptRow[],
  );
}

describe("durable acknowledgements of the selected successful result", () => {
  it("commits one exact frozen receipt and replays it after restart and key rotation", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(f, "receipt-replay");
    const jobId = published.attempt.identity.jobId;
    const principal = f.storage.principal();
    const original = receiptRequest(f, published);
    const input = {
      serviceId: original.serviceId.toUpperCase(),
      receiptId: original.receiptId.toUpperCase(),
      result: {
        ...original.result,
        sha256: original.result.sha256.toUpperCase(),
      },
    };
    const before = f.rows();
    const firstEvent = f.events.length;
    f.storage.setReady(false);
    const first = f.storage.store.acknowledgeResult(principal, jobId, input);
    expect(first).toEqual({
      receipt: {
        serviceId: original.serviceId,
        jobId,
        clientId: principal.clientId,
        receiptId: firstReceiptId,
        result: original.result,
        receivedAt: 1_000,
      },
      applied: true,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.receipt)).toBe(true);
    expect(Object.isFrozen(first.receipt.result)).toBe(true);
    expect(first.receipt.result).not.toBe(input.result);
    input.result.width++;
    expect(first.receipt.result).toEqual(original.result);
    const rows = receipts(f);
    expect(rows).toEqual([
      {
        job_id: jobId,
        client_id: principal.clientId,
        receipt_id: firstReceiptId,
        candidate_id: published.work.candidate!.candidateId,
        attempt_no: published.attempt.identity.attemptNo,
        received_at: 1_000,
      },
    ]);
    f.storage.setNow(2_000);
    expect(
      f.storage.store.acknowledgeResult(principal, jobId, original),
    ).toEqual({
      receipt: first.receipt,
      applied: false,
    });
    f.storage.store.close();
    f.storage.setStore(
      openStore({ directory: f.storage.directory, clock: f.storage.clock }),
    );
    expect(() =>
      f.storage.store.acknowledgeResult(principal, jobId, original),
    ).toThrowError(
      expect.objectContaining({ code: "authentication_failed", status: 401 }),
    );
    expect(
      f.storage.store.acknowledgeResult(f.storage.principal(), jobId, original),
    ).toEqual({
      receipt: first.receipt,
      applied: false,
    });
    const activePrincipal = f.storage.principal();
    const rotated = rotateCredential(f.storage.store, {
      clientId: activePrincipal.clientId,
      revokeCredentialId: activePrincipal.credentialId,
    });
    const fresh = authenticate(f.storage.store, `Bearer ${rotated.key}`);
    expect(() =>
      f.storage.store.acknowledgeResult(activePrincipal, jobId, original),
    ).toThrowError(
      expect.objectContaining({ code: "authentication_failed", status: 401 }),
    );
    expect(f.storage.store.acknowledgeResult(fresh, jobId, original)).toEqual({
      receipt: first.receipt,
      applied: false,
    });
    expect(receipts(f)).toEqual(rows);
    expect(f.rows()).toEqual(before);
    expect(f.events).toHaveLength(firstEvent);
  });

  it("rejects a new receipt identity or any changed result field without replacing the first acknowledgement", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(f, "receipt-conflicts");
    const request = receiptRequest(f, published);
    const jobId = published.attempt.identity.jobId;
    const principal = f.storage.principal();
    expect(
      f.storage.store.acknowledgeResult(principal, jobId, request).applied,
    ).toBe(true);
    const before = f.rows();
    const stored = receipts(f);
    const changes: unknown[] = [
      { ...request, receiptId: nextReceiptId },
      { ...request, serviceId: foreignServiceId },
      {
        ...request,
        result: { ...request.result, width: request.result.width + 1 },
      },
      {
        ...request,
        result: { ...request.result, height: request.result.height + 1 },
      },
      {
        ...request,
        result: {
          ...request.result,
          byteLength: request.result.byteLength + 1,
        },
      },
      { ...request, result: { ...request.result, sha256: "0".repeat(64) } },
    ];
    for (const changed of changes) {
      expect(() =>
        f.storage.store.acknowledgeResult(principal, jobId, changed),
      ).toThrowError(
        expect.objectContaining({ code: "receipt_conflict", status: 409 }),
      );
    }
    expect(receipts(f)).toEqual(stored);
    expect(f.rows()).toEqual(before);
  });

  it("binds a client receipt ID to one real job and leaves another successful result unacknowledged on conflict", async () => {
    const f = await fixture();
    const first = await publishedArtifactControl(f, "receipt-job-first");
    const next = await publishedArtifactControl(f, "receipt-job-next");
    const principal = f.storage.principal();
    const firstRequest = receiptRequest(f, first);
    expect(
      f.storage.store.acknowledgeResult(
        principal,
        first.attempt.identity.jobId,
        firstRequest,
      ).applied,
    ).toBe(true);
    const before = f.rows();
    const rows = receipts(f);
    expect(() =>
      f.storage.store.acknowledgeResult(
        principal,
        next.attempt.identity.jobId,
        receiptRequest(f, next),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "receipt_conflict", status: 409 }),
    );
    expect(receipts(f)).toEqual(rows);
    expect(f.rows()).toEqual(before);
    const nextReceipt = f.storage.store.acknowledgeResult(
      principal,
      next.attempt.identity.jobId,
      receiptRequest(f, next, nextReceiptId),
    );
    expect(nextReceipt.applied).toBe(true);
    expect(receipts(f)).toHaveLength(2);
  });

  it("scopes receipt identity to the authenticated client while preserving job ownership", async () => {
    const f = await fixture();
    const first = await publishedArtifactControl(f, "receipt-client-first");
    const firstPrincipal = f.storage.principal();
    expect(
      f.storage.store.acknowledgeResult(
        firstPrincipal,
        first.attempt.identity.jobId,
        receiptRequest(f, first),
      ).applied,
    ).toBe(true);
    const other = createClient(f.storage.store);
    const originalPrincipal = f.storage.principal;
    f.storage.principal = () =>
      authenticate(f.storage.store, `Bearer ${other.key}`);
    let next: Awaited<ReturnType<typeof publishedArtifactControl>>;
    try {
      next = await publishedArtifactControl(f, "receipt-client-next");
    } finally {
      f.storage.principal = originalPrincipal;
    }
    const nextPrincipal = authenticate(f.storage.store, `Bearer ${other.key}`);
    const nextRequest = receiptRequest(f, next);
    expect(() =>
      f.storage.store.acknowledgeResult(
        firstPrincipal,
        next.attempt.identity.jobId,
        nextRequest,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "job_not_found", status: 404 }),
    );
    const acknowledged = f.storage.store.acknowledgeResult(
      nextPrincipal,
      next.attempt.identity.jobId,
      nextRequest,
    );
    expect(acknowledged.applied).toBe(true);
    expect(acknowledged.receipt.clientId).toBe(other.clientId);
    expect(receipts(f).map((row) => [row.client_id, row.receipt_id])).toEqual([
      [firstPrincipal.clientId, firstReceiptId],
      [other.clientId, firstReceiptId],
    ]);
  });

  it("rejects missing, non-success and unauthenticated jobs without recording a receipt", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "receipt-guards-control",
    );
    const principal = f.storage.principal();
    const request = receiptRequest(f, published);
    expect(
      f.storage.store.acknowledgeResult(
        principal,
        published.attempt.identity.jobId,
        request,
      ).applied,
    ).toBe(true);
    const rows = receipts(f);
    expect(() =>
      f.storage.store.acknowledgeResult(principal, "missing-job", request),
    ).toThrowError(
      expect.objectContaining({ code: "job_not_found", status: 404 }),
    );
    const queued = await f.storage
      .service()
      .submit(principal, submission(await sourceImage(), "receipt-queued"));
    expect(() =>
      f.storage.store.acknowledgeResult(principal, queued.job.jobId, request),
    ).toThrowError(
      expect.objectContaining({ code: "result_not_ready", status: 409 }),
    );
    expect(
      f.storage.store.requestCancel(principal, queued.job.jobId).job.status,
    ).toBe("cancelled");
    expect(() =>
      f.storage.store.acknowledgeResult(principal, queued.job.jobId, request),
    ).toThrowError(
      expect.objectContaining({ code: "result_not_ready", status: 409 }),
    );
    const running = await f.claim(
      submission(await sourceImage(), "receipt-running"),
    );
    expect(() =>
      f.storage.store.acknowledgeResult(
        principal,
        running.identity.jobId,
        request,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "result_not_ready", status: 409 }),
    );
    await f.complete(running, await nativePng(running, { width: 1 }));
    expect(await f.settle(running)).toBe("failed");
    expect(f.job(running.identity.jobId).status).toBe("failed");
    expect(() =>
      f.storage.store.acknowledgeResult(
        principal,
        running.identity.jobId,
        request,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "result_not_ready", status: 409 }),
    );
    const before = f.rows();
    expect(() =>
      f.storage.store.acknowledgeResult(
        { ...principal },
        published.attempt.identity.jobId,
        request,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "authentication_failed", status: 401 }),
    );
    revokeCredential(f.storage.store, principal.credentialId);
    expect(() =>
      f.storage.store.acknowledgeResult(
        principal,
        published.attempt.identity.jobId,
        request,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "authentication_failed", status: 401 }),
    );
    expect(receipts(f)).toEqual(rows);
    expect(f.rows()).toEqual(before);
  });

  it("validates direct Store input instead of accepting self-reported ownership or malformed result data", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(f, "receipt-direct-input");
    const request = receiptRequest(f, published);
    const principal = f.storage.principal();
    const before = f.rows();
    for (const value of [
      undefined,
      { ...request, clientId: principal.clientId },
      { ...request, receiptId: "not-a-uuid" },
      { ...request, result: { ...request.result, format: "jpeg" } },
      { ...request, result: { ...request.result, width: "16" } },
    ]) {
      expect(() =>
        f.storage.store.acknowledgeResult(
          principal,
          published.attempt.identity.jobId,
          value,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "invalid_request", status: 400 }),
      );
    }
    expect(receipts(f)).toEqual([]);
    expect(f.rows()).toEqual(before);
  });

  it.each(["revoke", "close", "abort"] as const)(
    "rechecks authority after the synchronous clock callback can %s",
    async (mode) => {
      const f = await fixture();
      const published = await publishedArtifactControl(
        f,
        `receipt-clock-${mode}`,
      );
      const jobId = published.attempt.identity.jobId;
      const request = receiptRequest(f, published);
      expect(
        f.storage.store.acknowledgeResult(f.storage.principal(), jobId, request)
          .applied,
      ).toBe(true);
      const rows = receipts(f);
      const before = f.rows();
      const controller = new AbortController();
      let armed = false;
      let calls = 0;
      let store: EnhancementStore;
      f.storage.store.close();
      store = openStore({
        directory: f.storage.directory,
        clock() {
          const now = f.storage.clock();
          if (armed) {
            armed = false;
            calls++;
            if (mode === "revoke")
              store.revokeCredential(
                f.storage.initialized.credential.credentialId,
              );
            if (mode === "close") store.close();
            if (mode === "abort") controller.abort();
          }
          return now;
        },
      });
      f.storage.setStore(store);
      const principal = f.storage.principal();
      armed = true;
      const code =
        mode === "revoke"
          ? "authentication_failed"
          : mode === "close"
            ? "internal_error"
            : "invalid_request";
      expect(() =>
        store.acknowledgeResult(principal, jobId, request, controller.signal),
      ).toThrowError(expect.objectContaining({ code }));
      expect(calls).toBe(1);
      expect(receipts(f)).toEqual(rows);
      expect(f.rows()).toEqual(before);
    },
  );

  it("rejects already-aborted and closed calls without adding or replacing persisted acknowledgement", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "receipt-closed-aborted",
    );
    const principal = f.storage.principal();
    const request = receiptRequest(f, published);
    const jobId = published.attempt.identity.jobId;
    expect(
      f.storage.store.acknowledgeResult(principal, jobId, request).applied,
    ).toBe(true);
    const rows = receipts(f);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      f.storage.store.acknowledgeResult(
        principal,
        jobId,
        request,
        controller.signal,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_request", status: 400 }),
    );
    f.storage.store.close();
    expect(() =>
      f.storage.store.acknowledgeResult(principal, jobId, request),
    ).toThrowError(
      expect.objectContaining({ code: "internal_error", status: 503 }),
    );
    expect(receipts(f)).toEqual(rows);
  });

  it("rechecks principal after receipt input getters synchronously revoke the key", async () => {
    const f = await fixture();
    const published = await publishedArtifactControl(
      f,
      "receipt-input-callback",
    );
    const principal = f.storage.principal();
    const request = receiptRequest(f, published);
    const before = f.rows();
    let getterCalls = 0;
    const input = {
      serviceId: request.serviceId,
      receiptId: request.receiptId,
      get result() {
        getterCalls++;
        revokeCredential(f.storage.store, principal.credentialId);
        return request.result;
      },
    };
    expect(() =>
      f.storage.store.acknowledgeResult(
        principal,
        published.attempt.identity.jobId,
        input,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "authentication_failed", status: 401 }),
    );
    expect(getterCalls).toBeGreaterThan(0);
    expect(receipts(f)).toEqual([]);
    expect(f.rows()).toEqual(before);
  });

  it.each(["insert", "commit"] as const)(
    "rolls back a real SQLite %s failure and accepts the same receipt only after the fault is removed",
    async (stage) => {
      const f = await fixture();
      const control = await publishedArtifactControl(
        f,
        `receipt-${stage}-control`,
      );
      expect(
        f.storage.store.acknowledgeResult(
          f.storage.principal(),
          control.attempt.identity.jobId,
          receiptRequest(f, control),
        ).applied,
      ).toBe(true);
      const published = await publishedArtifactControl(
        f,
        `receipt-${stage}-target`,
      );
      const jobId = published.attempt.identity.jobId;
      const request = receiptRequest(f, published, nextReceiptId);
      const before = f.rows();
      const rows = receipts(f);
      const trigger =
        stage === "insert"
          ? `CREATE TRIGGER receipt_write_fault BEFORE INSERT ON result_receipts
           WHEN NEW.job_id = '${jobId}'
           BEGIN SELECT RAISE(ABORT, 'fixture receipt insertion failure'); END;`
          : `CREATE TRIGGER receipt_write_fault AFTER INSERT ON result_receipts
           WHEN NEW.job_id = '${jobId}'
           BEGIN INSERT INTO lifecycle_commit_fault(client_id) VALUES ('receipt-missing-client'); END;`;
      commitFault(f.storage, trigger);
      expect(() =>
        f.storage.store.acknowledgeResult(
          f.storage.principal(),
          jobId,
          request,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "internal_error", status: 503 }),
      );
      expect(receipts(f)).toEqual(rows);
      expect(
        snapshot(f.storage, (db) =>
          db.prepare("SELECT * FROM lifecycle_commit_fault").all(),
        ),
      ).toEqual([]);
      expect(f.rows()).toEqual(before);
      f.storage.store.close();
      const database = new Database(join(f.storage.directory, "worker.sqlite"));
      try {
        expect(
          database
            .prepare("SELECT * FROM result_receipts ORDER BY rowid")
            .all(),
        ).toEqual(rows);
        database.exec("DROP TRIGGER receipt_write_fault");
      } finally {
        database.close();
      }
      f.storage.setStore(
        openStore({ directory: f.storage.directory, clock: f.storage.clock }),
      );
      expect(
        f.storage.store.acknowledgeResult(f.storage.principal(), jobId, request)
          .applied,
      ).toBe(true);
      expect(
        f.storage.store.acknowledgeResult(f.storage.principal(), jobId, request)
          .applied,
      ).toBe(false);
      expect(receipts(f)).toHaveLength(2);
      expect(f.rows()).toEqual(before);
      assert.ok(published.work.candidate);
      expect(readFileSync(published.work.candidate.pngPath)).toEqual(
        published.png,
      );
    },
  );

  it.each(["missing table", "missing columns"] as const)(
    "rejects a declared schema7 with %s without repairing or modifying accepted work",
    async (mode) => {
      const f = await fixture();
      const accepted = await f.storage
        .service()
        .submit(
          f.storage.principal(),
          submission(await sourceImage(), "receipt-schema"),
        );
      expect(
        snapshot(f.storage, (db) =>
          db.pragma("user_version", { simple: true }),
        ),
      ).toBe(7);
      const input = join(
        f.storage.store.inputDirectory,
        accepted.job.jobId,
        "original.jpeg",
      );
      const original = readFileSync(input);
      f.storage.store.close();
      const database = new Database(join(f.storage.directory, "worker.sqlite"));
      try {
        database.exec("DROP TABLE result_receipts");
        if (mode === "missing columns")
          database.exec(
            "CREATE TABLE result_receipts (job_id TEXT PRIMARY KEY) STRICT",
          );
      } finally {
        database.close();
      }
      const readState = () =>
        snapshot(f.storage, (db) => ({
          version: db.pragma("user_version", { simple: true }),
          schema: db
            .prepare(
              "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
            )
            .all(),
          identity: db.prepare("SELECT * FROM service_identity").all(),
          incarnations: db
            .prepare("SELECT * FROM store_incarnations ORDER BY rowid")
            .all(),
          jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
        }));
      const before = readState();
      let reopened: EnhancementStore | undefined;
      try {
        expect(() => {
          reopened = openStore({
            directory: f.storage.directory,
            clock: f.storage.clock,
          });
        }).toThrowError(
          expect.objectContaining({
            code: "configuration_invalid",
            status: 503,
          }),
        );
      } finally {
        reopened?.close();
      }
      expect(readState()).toEqual(before);
      expect(readFileSync(input)).toEqual(original);
    },
  );
});

it("rechecks the current credential after a native AbortSignal getter synchronously revokes it", async () => {
  const f = await fixture();
  const published = await publishedArtifactControl(
    f,
    "receipt-native-signal-boundary",
  );
  const store = f.storage.store;
  const principal = f.storage.principal();
  const request = receiptRequest(f, published);
  const before = f.rows();
  expect(receipts(f)).toEqual([]);
  const controller = new AbortController();
  const signal = controller.signal;
  const nativeAborted = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted",
  )?.get;
  assert.ok(nativeAborted);
  expect(nativeAborted.call(signal)).toBe(false);
  const originalPublished = store.getPublishedResultPublisher;
  const originalPrincipal = store.assertPrincipal;
  const trace: string[] = [];
  const reads: boolean[] = [];
  let qualified = false;
  let revocations = 0;
  store.getPublishedResultPublisher = (client, jobId) => {
    const publisher = originalPublished.call(store, client, jobId);
    qualified = true;
    trace.push("qualified-published");
    return publisher;
  };
  store.assertPrincipal = (client) => {
    trace.push(qualified ? "final-principal-start" : "principal-start");
    originalPrincipal.call(store, client);
    trace.push(qualified ? "final-principal-accepted" : "principal-accepted");
  };
  Object.defineProperty(signal, "aborted", {
    configurable: true,
    get() {
      const aborted = nativeAborted.call(signal) as boolean;
      reads.push(aborted);
      if (qualified && revocations === 0) {
        revocations++;
        trace.push("native-signal-revoke");
        revokeCredential(store, principal.credentialId);
      }
      return aborted;
    },
  });
  let result: ReturnType<EnhancementStore["acknowledgeResult"]> | undefined;
  let failure: unknown;
  try {
    result = store.acknowledgeResult(
      principal,
      published.attempt.identity.jobId,
      request,
      signal,
    );
  } catch (error) {
    failure = error;
  } finally {
    store.getPublishedResultPublisher = originalPublished;
    store.assertPrincipal = originalPrincipal;
    Reflect.deleteProperty(signal, "aborted");
  }
  const afterReceipts = receipts(f);
  expect(trace.filter((event) => event === "qualified-published")).toHaveLength(
    1,
  );
  expect(revocations).toBe(1);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((aborted) => aborted === false)).toBe(true);
  expect(nativeAborted.call(signal)).toBe(false);
  expect(
    failure,
    JSON.stringify({
      trace,
      receiptCount: afterReceipts.length,
      returnedApplied: result?.applied,
    }),
  ).toEqual(
    expect.objectContaining({ code: "authentication_failed", status: 401 }),
  );
  expect(result).toBeUndefined();
  expect(afterReceipts).toEqual([]);
  expect(f.rows()).toEqual(before);
});

it("rejects acknowledgement reentered from an outer Store transaction before that transaction can roll it back", async () => {
  const f = await fixture();
  const published = await publishedArtifactControl(
    f,
    "receipt-nested-transaction-boundary",
  );
  const request = receiptRequest(f, published);
  const jobId = published.attempt.identity.jobId;
  const before = f.rows();
  expect(receipts(f)).toEqual([]);
  let armed = false;
  let callbacks = 0;
  let nestedResult:
    ReturnType<EnhancementStore["acknowledgeResult"]> | undefined;
  let nestedFailure: unknown;
  let store: EnhancementStore;
  f.storage.store.close();
  store = openStore({
    directory: f.storage.directory,
    clock() {
      const now = f.storage.clock();
      if (armed) {
        armed = false;
        callbacks++;
        try {
          nestedResult = store.acknowledgeResult(principal, jobId, request);
        } catch (error) {
          nestedFailure = error;
        }
        throw new Error(
          "fixture outer transaction rolls back after receipt call",
        );
      }
      return now;
    },
  });
  f.storage.setStore(store);
  const principal = f.storage.principal();
  const originalCredentials = snapshot(f.storage, (db) =>
    db.prepare("SELECT * FROM credentials ORDER BY rowid").all(),
  );
  armed = true;
  expect(() => store.issueCredential("d".repeat(64))).toThrowError(
    expect.objectContaining({ code: "internal_error", status: 503 }),
  );
  const afterReceipts = receipts(f);
  expect(callbacks).toBe(1);
  expect(
    nestedFailure,
    JSON.stringify({
      nestedReturnedApplied: nestedResult?.applied,
      receiptCountAfterOuterRollback: afterReceipts.length,
    }),
  ).toEqual(expect.objectContaining({ code: "internal_error", status: 503 }));
  expect(nestedResult).toBeUndefined();
  expect(afterReceipts).toEqual([]);
  expect(f.rows()).toEqual(before);
  expect(
    snapshot(f.storage, (db) =>
      db.prepare("SELECT * FROM credentials ORDER BY rowid").all(),
    ),
  ).toEqual(originalCredentials);
});
