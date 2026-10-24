import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  type ResultCleanupWork,
  type ResultRetirementOutcome,
} from "../src/store.js";
import { artifactFixture, type ArtifactFixture } from "./artifact-fixtures.js";
import { publishedArtifactControl } from "./artifact-fault-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import { sourceImage, submission } from "./storage-fixtures.js";

const retentionMs = 60_000;
const fixtures: ArtifactFixture[] = [];
const internalError = expect.objectContaining({ code: "internal_error" });
type Published = Awaited<ReturnType<typeof publishedArtifactControl>>;
type RetirementRow = {
  job_id: string;
  candidate_id: string;
  attempt_no: number;
  retention_ms: number;
  retired_at: number;
  cleaned_at: number | null;
};

afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});

async function fixture() {
  const f = await artifactFixture();
  fixtures.push(f);
  return f;
}

async function publishedResult(acknowledge = true) {
  const f = await fixture();
  const published = await publishedArtifactControl(f, "retirement-source");
  const jobId = published.attempt.identity.jobId;
  assert.ok(published.work.candidate);
  const request: ResultReceiptRequest = {
    serviceId: f.storage.store.identity.serviceId,
    receiptId: randomUUID(),
    result: { ...published.work.candidate.manifest.png },
  };
  const completedAt = f.job(jobId).completedAt;
  assert.notEqual(completedAt, null);
  if (acknowledge)
    f.storage.store.acknowledgeResult(f.storage.principal(), jobId, request);
  const deadline = completedAt! + retentionMs;
  f.storage.setNow(deadline);
  return { f, published, jobId, request, deadline };
}

function originalFacts(f: ArtifactFixture) {
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
  ];
  return snapshot(f.storage, (db) =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  );
}

function retirements(f: ArtifactFixture) {
  return snapshot(
    f.storage,
    (db) =>
      db
        .prepare("SELECT * FROM result_retirements ORDER BY rowid")
        .all() as RetirementRow[],
  );
}

// 故障注入前先断言 schema；缺表是明确的缺行为，不能让 CREATE TRIGGER 充当 RED。
function requireSchema7(f: ArtifactFixture) {
  const schema = snapshot(f.storage, (db) => ({
    version: db.pragma("user_version", { simple: true }),
    columns: (
      db.prepare("PRAGMA table_info(result_retirements)").all() as {
        name: string;
      }[]
    )
      .map((column) => column.name)
      .sort(),
  }));
  expect(schema.version, "fresh Store must initialize schema7").toBe(7);
  expect(
    schema.columns,
    "schema7 must include the complete retirement row",
  ).toEqual([
    "attempt_no",
    "candidate_id",
    "cleaned_at",
    "job_id",
    "retention_ms",
    "retired_at",
  ]);
}

function reopen(f: ArtifactFixture, clock = f.storage.clock) {
  f.storage.store.close();
  const store = openStore({ directory: f.storage.directory, clock });
  f.storage.setStore(store);
  return store;
}

// 只在同步 openStore 中捕获真实连接；所有 prepare 与事务仍执行原 SQLite 操作。
function captureConnection(f: ArtifactFixture, clock = f.storage.clock) {
  f.storage.store.close();
  const path = join(f.storage.directory, "worker.sqlite");
  const original = Database.prototype.prepare;
  let db: Database.Database | undefined;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    if (this.name === path) db = this;
    return original.call(this, sql);
  } as typeof original;
  try {
    const store = openStore({ directory: f.storage.directory, clock });
    f.storage.setStore(store);
    assert.ok(db);
    return { store, db };
  } finally {
    Database.prototype.prepare = original;
  }
}

function workFrom(outcome: ResultRetirementOutcome): ResultCleanupWork {
  expect(outcome.kind).toBe("retired");
  assert.ok(outcome.kind === "retired");
  assert.ok(outcome.work);
  return outcome.work;
}

function holdFixtureReference(
  db: Database.Database,
  published: Published,
  purpose: "run" | "recovery",
  candidateId: string | null,
) {
  const id = randomUUID();
  const inserted = db
    .prepare(
      `INSERT INTO artifact_references
    SELECT ?, job_id, attempt_no, publisher_identity_json, incarnation_id,
      ?, ?, acquired_at, NULL
    FROM artifact_references WHERE reference_id = ?`,
    )
    .run(id, purpose, candidateId, published.work.key.referenceId);
  assert.equal(inserted.changes, 1);
  return id;
}

function installWriteFault(
  db: Database.Database,
  event: "INSERT" | "UPDATE OF cleaned_at",
  stage: "statement" | "commit",
) {
  db.exec(`CREATE TABLE result_retirement_commit_fault (
    client_id TEXT REFERENCES clients(client_id) DEFERRABLE INITIALLY DEFERRED
  );
  CREATE TRIGGER retirement_write_fault ${stage === "statement" ? "BEFORE" : "AFTER"}
    ${event} ON result_retirements
  BEGIN ${
    stage === "statement"
      ? "SELECT RAISE(ABORT, 'fixture retirement write failure');"
      : "INSERT INTO result_retirement_commit_fault VALUES ('missing-retirement-client');"
  }
  END;`);
}

// 在真实 immediate COMMIT 返回后丢一次确认；持久行来自真实数据库，未伪造事务结果。
function loseCommitConfirmation(
  db: Database.Database,
  jobId: string,
  cleaned: boolean,
) {
  const original = db.transaction;
  const committed: RetirementRow[] = [];
  let lost = false;
  db.transaction = new Proxy(original, {
    apply(target, receiver, args) {
      const actual = Reflect.apply(
        target,
        receiver,
        args,
      ) as Database.Transaction;
      const wrapped = (...values: unknown[]) =>
        Reflect.apply(actual, receiver, values);
      for (const mode of ["deferred", "immediate", "exclusive"] as const)
        Object.defineProperty(wrapped, mode, {
          value: (...values: unknown[]) => {
            const result = Reflect.apply(actual[mode], receiver, values);
            if (mode === "immediate") {
              const row = db
                .prepare("SELECT * FROM result_retirements WHERE job_id = ?")
                .get(jobId) as RetirementRow | undefined;
              if (row && (row.cleaned_at !== null) === cleaned) {
                committed.push({ ...row });
                if (!lost) {
                  lost = true;
                  throw new Error(
                    "fixture lost confirmation after actual COMMIT",
                  );
                }
              }
            }
            return result;
          },
        });
      return wrapped;
    },
  });
  return {
    committed,
    restore: () => {
      db.transaction = original;
    },
  };
}

describe("持久结果退役", () => {
  it.each(["awaiting_receipt", "retention_pending", "reference_held"] as const)(
    "将 %s 返回为 blocked，保持资格优先级和原事实",
    async (state) => {
      const { f, published, jobId, deadline } = await publishedResult(
        state !== "awaiting_receipt",
      );
      const store = f.storage.store;
      const principal = f.storage.principal();
      if (state === "retention_pending") f.storage.setNow(deadline - 1);
      if (state !== "retention_pending")
        assert.ok(
          store.acquireArtifactWork(published.attempt.identity, "recovery"),
        );
      const before = originalFacts(f);
      const outcome = store.retireResult(principal, jobId, retentionMs);
      expect(outcome).toEqual({
        kind: "blocked",
        inspection: expect.objectContaining({ state }),
      });
      expect(store.readResultRetirement(principal, jobId)).toBeNull();
      expect(retirements(f)).toEqual([]);
      expect(originalFacts(f)).toEqual(before);
    },
  );

  it("在 completedAt 加保留期的等号边界持久写入准确行并只发真实冻结 work", async () => {
    const { f, published, jobId, deadline } = await publishedResult();
    const store = f.storage.store;
    const principal = f.storage.principal();
    const candidate = published.work.candidate!;
    const before = originalFacts(f);
    const events = f.events.length;
    const outcome = store.retireResult(principal, jobId, retentionMs);
    const work = workFrom(outcome);
    assert.ok(outcome.kind === "retired");
    expect(outcome.retirement).toEqual({
      serviceId: store.identity.serviceId,
      jobId,
      candidateId: candidate.candidateId,
      attemptNo: published.attempt.identity.attemptNo,
      retentionMs,
      retiredAt: deadline,
      cleanedAt: null,
    });
    expect(work).toEqual({
      retirement: outcome.retirement,
      directory: candidate.directory,
      pngPath: candidate.pngPath,
      manifestPath: candidate.manifestPath,
    });
    for (const value of [outcome, outcome.retirement, work, work.retirement])
      expect(Object.isFrozen(value)).toBe(true);
    expect(retirements(f)).toEqual([
      {
        job_id: jobId,
        candidate_id: candidate.candidateId,
        attempt_no: published.attempt.identity.attemptNo,
        retention_ms: retentionMs,
        retired_at: deadline,
        cleaned_at: null,
      },
    ]);
    expect(store.readResultRetirement(principal, jobId)).toEqual(
      outcome.retirement,
    );
    expect(originalFacts(f)).toEqual(before);
    expect(f.events).toHaveLength(events);
    expect(readFileSync(candidate.pngPath)).toEqual(published.png);
  });

  it("迟到收据仍从完成时间起算，并在时钟回退到 receivedAt 前阻止退役", async () => {
    const { f, jobId, request, deadline } = await publishedResult(false);
    const store = f.storage.store;
    const principal = f.storage.principal();
    f.storage.setNow(deadline + 10);
    const receivedAt = store.acknowledgeResult(principal, jobId, request)
      .receipt.receivedAt;
    f.storage.setNow(receivedAt - 1);
    expect(store.retireResult(principal, jobId, retentionMs)).toMatchObject({
      kind: "blocked",
      inspection: {
        state: "retention_pending",
        retainUntil: deadline,
        receivedAt,
      },
    });
    f.storage.setNow(receivedAt);
    expect(store.retireResult(principal, jobId, retentionMs).kind).toBe(
      "retired",
    );
  });

  it.each(["run", "NULL", "other-candidate", "old-incarnation"] as const)(
    "将同 job/attempt 的 %s 未释放引用保持为退役围栏",
    async (kind) => {
      const { f, published, jobId } = await publishedResult();
      let { store, db } = captureConnection(f);
      const candidateId = published.work.candidate!.candidateId;
      if (kind === "old-incarnation") {
        const reference = store.acquireArtifactWork(
          published.attempt.identity,
          "recovery",
        );
        assert.ok(reference);
        store = reopen(f);
        expect(store.readArtifactReference(reference.key)).toBe("retired");
      } else {
        let selected: string | null = kind === "NULL" ? null : candidateId;
        if (kind === "other-candidate") {
          selected = randomUUID();
          db.prepare(
            `INSERT INTO artifact_candidates
            SELECT ?, job_id, attempt_no, producer_identity_json, launch_ticket,
              directory || '-other', manifest_json, manifest_sha256,
              manifest_byte_length, 'intent', created_at, NULL
            FROM artifact_candidates WHERE candidate_id = ?`,
          ).run(selected, candidateId);
        }
        holdFixtureReference(
          db,
          published,
          kind === "run" ? "run" : "recovery",
          selected,
        );
      }
      const before = originalFacts(f);
      expect(
        store.retireResult(f.storage.principal(), jobId, retentionMs),
      ).toMatchObject({
        kind: "blocked",
        inspection: { state: "reference_held", heldReferences: 1 },
      });
      expect(retirements(f)).toEqual([]);
      expect(originalFacts(f)).toEqual(before);
    },
  );

  it("重新裁决 eligible 快照之后先完成的 acquire，释放后才可退役", async () => {
    const { f, published, jobId } = await publishedResult();
    const store = f.storage.store;
    const principal = f.storage.principal();
    expect(
      store.inspectResultRetention(principal, jobId, retentionMs).state,
    ).toBe("eligible");
    const held = store.acquireArtifactWork(
      published.attempt.identity,
      "recovery",
    );
    assert.ok(held);
    expect(store.retireResult(principal, jobId, retentionMs)).toMatchObject({
      kind: "blocked",
      inspection: { state: "reference_held", heldReferences: 1 },
    });
    expect(retirements(f)).toEqual([]);
    expect(store.releaseArtifactReference(held.key)).toBe(true);
    expect(store.retireResult(principal, jobId, retentionMs).kind).toBe(
      "retired",
    );
  });

  it("退役先完成时拒绝新 acquire，并保留共有 publisher 和已消费引用的事实查询", async () => {
    const { f, published, jobId } = await publishedResult();
    const store = f.storage.store;
    const principal = f.storage.principal();
    workFrom(store.retireResult(principal, jobId, retentionMs));
    const before = originalFacts(f);
    expect(() =>
      store.acquireArtifactWork(published.attempt.identity, "recovery"),
    ).toThrowError(expect.objectContaining({ code: "result_gone" }));
    expect(store.getPublishedResultPublisher(principal, jobId)).toEqual(
      published.attempt.identity,
    );
    expect(store.readArtifactWork(published.work.key).kind).toBe("published");
    expect(originalFacts(f)).toEqual(before);
  });

  it("在 acquire 的最后 clock 回调后重查真实持久围栏，不插入新引用", async () => {
    const { f, published, jobId, deadline } = await publishedResult();
    requireSchema7(f);
    let armed = false;
    let acquisitionClocks = 0;
    let active: Database.Database;
    const { store, db } = captureConnection(f, () => {
      // Active and interrupted-recovery checks each read time before reference.acquired_at.
      if (armed && ++acquisitionClocks === 3) {
        armed = false;
        active
          .prepare(
            `INSERT INTO result_retirements
          (job_id, candidate_id, attempt_no, retention_ms, retired_at, cleaned_at)
          VALUES (?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            jobId,
            published.work.candidate!.candidateId,
            published.attempt.identity.attemptNo,
            retentionMs,
            deadline,
          );
      }
      return f.storage.clock();
    });
    active = db;
    const before = originalFacts(f);
    armed = true;
    expect(() =>
      store.acquireArtifactWork(published.attempt.identity, "recovery"),
    ).toThrowError(expect.objectContaining({ code: "result_gone" }));
    expect(armed).toBe(false);
    expect(acquisitionClocks).toBe(3);
    // 注入行与 acquire 同属真实事务；拒绝必须连同它一起回滚。
    expect(retirements(f)).toEqual([]);
    expect(originalFacts(f)).toEqual(before);
    expect(
      store.retireResult(f.storage.principal(), jobId, retentionMs).kind,
    ).toBe("retired");
  });

  it("退役不改变原 DTO、同键提交、收据重放与执行历史", async () => {
    const { f, published, jobId, request } = await publishedResult();
    const store = f.storage.store;
    const principal = f.storage.principal();
    const job = store.getOwned(principal, jobId);
    const receipt = store.acknowledgeResult(principal, jobId, request).receipt;
    const before = originalFacts(f);
    workFrom(store.retireResult(principal, jobId, retentionMs));
    expect(store.getOwned(principal, jobId)).toEqual(job);
    expect(
      await f.storage
        .service()
        .submit(
          principal,
          submission(await sourceImage("blue"), "retirement-source"),
        ),
    ).toEqual({ job, replayed: true });
    expect(store.acknowledgeResult(principal, jobId, request)).toEqual({
      receipt,
      applied: false,
    });
    expect(store.getPublishedResultPublisher(principal, jobId)).toEqual(
      published.attempt.identity,
    );
    expect(originalFacts(f)).toEqual(before);
  });

  it("已存在 pending 在本 Store 与重开后均只回原时长时间，永不重新发 work", async () => {
    const { f, jobId, deadline } = await publishedResult();
    const first = f.storage.store.retireResult(
      f.storage.principal(),
      jobId,
      retentionMs,
    );
    const work = workFrom(first);
    f.storage.setNow(deadline - 1);
    expect(
      f.storage.store.retireResult(
        f.storage.principal(),
        jobId,
        retentionMs * 2,
      ),
    ).toEqual({ kind: "retired", retirement: work.retirement, work: null });
    const rows = retirements(f);
    const store = reopen(f);
    expect(store.readResultRetirement(f.storage.principal(), jobId)).toEqual(
      work.retirement,
    );
    expect(
      store.retireResult(f.storage.principal(), jobId, retentionMs + 1),
    ).toEqual({ kind: "retired", retirement: work.retirement, work: null });
    expect(() => store.assertResultCleanupWork(work)).toThrow();
    expect(retirements(f)).toEqual(rows);
  });

  it("read 的无行仅返回明确 null，认证、闭库或真实读故障均不得伪装为无行", async () => {
    const { f, jobId } = await publishedResult();
    const { store, db } = captureConnection(f);
    const principal = f.storage.principal();
    expect(store.readResultRetirement(principal, jobId)).toBeNull();
    const other = createClient(store);
    expect(() =>
      store.readResultRetirement(
        authenticate(store, `Bearer ${other.key}`),
        jobId,
      ),
    ).toThrowError(expect.objectContaining({ code: "job_not_found" }));
    expect(() =>
      store.readResultRetirement({ ...principal }, jobId),
    ).toThrowError(expect.objectContaining({ code: "authentication_failed" }));
    db.close();
    expect(() => store.readResultRetirement(principal, jobId)).toThrowError(
      internalError,
    );
    store.close();
    expect(() => store.readResultRetirement(principal, jobId)).toThrowError(
      internalError,
    );
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "首次退役拒绝非法 retentionMs=%s 而不记录行",
    async (duration) => {
      const { f, jobId } = await publishedResult();
      expect(() =>
        f.storage.store.retireResult(f.storage.principal(), jobId, duration),
      ).toThrowError(expect.objectContaining({ code: "invalid_request" }));
      expect(
        f.storage.store.readResultRetirement(f.storage.principal(), jobId),
      ).toBeNull();
    },
  );
});

describe("清理 work 许可与完成记录", () => {
  it("assert 只接受原注册对象，不取 clock、不改数据库或触发 artifact I/O", async () => {
    const { f, jobId } = await publishedResult();
    let observed = false;
    let calls = 0;
    const { store } = captureConnection(f, () => {
      if (observed) calls++;
      return f.storage.clock();
    });
    const work = workFrom(
      store.retireResult(f.storage.principal(), jobId, retentionMs),
    );
    const before = { original: originalFacts(f), retirements: retirements(f) };
    const events = f.events.length;
    observed = true;
    expect(store.assertResultCleanupWork(work)).toBeUndefined();
    expect(() => store.assertResultCleanupWork({ ...work })).toThrow();
    expect(() => store.completeResultCleanup({ ...work })).toThrow();
    expect(calls).toBe(0);
    expect({ original: originalFacts(f), retirements: retirements(f) }).toEqual(
      before,
    );
    expect(f.events).toHaveLength(events);
  });

  it("另一 Store 即使持有原 work 对象也没有该清理许可", async () => {
    const { f, jobId } = await publishedResult();
    const work = workFrom(
      f.storage.store.retireResult(f.storage.principal(), jobId, retentionMs),
    );
    const other = await fixture();
    expect(() => other.storage.store.assertResultCleanupWork(work)).toThrow();
    expect(() => other.storage.store.completeResultCleanup(work)).toThrow();
    expect(
      f.storage.store.readResultRetirement(f.storage.principal(), jobId),
    ).toEqual(work.retirement);
  });

  it.each(["revoke", "close", "abort"] as const)(
    "%s 使原 work 的 assert 与 complete 均失去权限，pending 原事实保留",
    async (mode) => {
      const { f, jobId } = await publishedResult();
      const store = f.storage.store;
      const principal = f.storage.principal();
      const work = workFrom(store.retireResult(principal, jobId, retentionMs));
      const rows = retirements(f);
      const signal = new AbortController();
      if (mode === "revoke") revokeCredential(store, principal.credentialId);
      if (mode === "close") store.close();
      if (mode === "abort") signal.abort();
      expect(() =>
        store.assertResultCleanupWork(work, signal.signal),
      ).toThrow();
      expect(() => store.completeResultCleanup(work, signal.signal)).toThrow();
      expect(retirements(f)).toEqual(rows);
    },
  );

  it("complete 只补单次 cleaned_at，重复完成和再次退役均回原事实", async () => {
    const { f, jobId, deadline } = await publishedResult();
    const store = f.storage.store;
    const principal = f.storage.principal();
    const work = workFrom(store.retireResult(principal, jobId, retentionMs));
    const before = originalFacts(f);
    f.storage.setNow(deadline + 1);
    const complete = store.completeResultCleanup(work);
    expect(complete).toEqual({ ...work.retirement, cleanedAt: deadline + 1 });
    expect(Object.isFrozen(complete)).toBe(true);
    expect(work.retirement.cleanedAt).toBeNull();
    f.storage.setNow(deadline + 99);
    expect(store.completeResultCleanup(work)).toEqual(complete);
    expect(store.readResultRetirement(principal, jobId)).toEqual(complete);
    expect(store.retireResult(principal, jobId, retentionMs * 2)).toEqual({
      kind: "retired",
      retirement: complete,
      work: null,
    });
    expect(retirements(f)).toEqual([
      expect.objectContaining({ cleaned_at: deadline + 1 }),
    ]);
    expect(originalFacts(f)).toEqual(before);
  });

  it("complete 重新检查所有未释放引用，不因已有 work 忽略后出现的 NULL/run 引用", async () => {
    const { f, published, jobId, deadline } = await publishedResult();
    const { store, db } = captureConnection(f);
    const work = workFrom(
      store.retireResult(f.storage.principal(), jobId, retentionMs),
    );
    const id = holdFixtureReference(db, published, "run", null);
    const rows = retirements(f);
    expect(() => store.completeResultCleanup(work)).toThrow();
    expect(retirements(f)).toEqual(rows);
    db.prepare(
      "UPDATE artifact_references SET released_at = ? WHERE reference_id = ?",
    ).run(deadline, id);
    expect(store.completeResultCleanup(work).cleanedAt).toBe(deadline);
  });

  it("complete 拒绝早于 retiredAt 的时刻而不补写 cleaned_at", async () => {
    const { f, jobId, deadline } = await publishedResult();
    const store = f.storage.store;
    const work = workFrom(
      store.retireResult(f.storage.principal(), jobId, retentionMs),
    );
    const rows = retirements(f);
    f.storage.setNow(deadline - 1);
    expect(() => store.completeResultCleanup(work)).toThrow();
    expect(retirements(f)).toEqual(rows);
  });
});

describe("同步外部回调与顶层事务边界", () => {
  it.each(["retire", "complete"] as const)(
    "%s 在已有外层事务时拒绝执行且不调用 clock",
    async (operation) => {
      const { f, jobId } = await publishedResult();
      let observed = false;
      let calls = 0;
      const { store, db } = captureConnection(f, () => {
        if (observed) calls++;
        return f.storage.clock();
      });
      const principal = f.storage.principal();
      const work =
        operation === "complete"
          ? workFrom(store.retireResult(principal, jobId, retentionMs))
          : undefined;
      const before = originalFacts(f);
      observed = true;
      db.exec("BEGIN");
      try {
        expect(() =>
          operation === "retire"
            ? store.retireResult(principal, jobId, retentionMs)
            : store.completeResultCleanup(work!),
        ).toThrowError(internalError);
        expect(() => store.readResultRetirement(principal, jobId)).toThrowError(
          internalError,
        );
        expect(calls).toBe(0);
        expect(db.inTransaction).toBe(true);
      } finally {
        if (db.inTransaction) db.exec("ROLLBACK");
      }
      expect(originalFacts(f)).toEqual(before);
      expect(store.readResultRetirement(principal, jobId)).toEqual(
        work?.retirement ?? null,
      );
    },
  );

  it.each([
    ["retire", "revoke"],
    ["retire", "close"],
    ["retire", "abort"],
    ["retire", "begin"],
    ["complete", "revoke"],
    ["complete", "close"],
    ["complete", "abort"],
    ["complete", "begin"],
  ] as const)(
    "%s 在 clock 同步 %s 后重新收口权限与事务状态",
    async (operation, mode) => {
      const { f, jobId } = await publishedResult();
      const controller = new AbortController();
      let armed = false;
      let calls = 0;
      let active: Database.Database;
      let store: EnhancementStore;
      const captured = captureConnection(f, () => {
        const now = f.storage.clock();
        if (armed) {
          armed = false;
          calls++;
          if (mode === "revoke")
            revokeCredential(store, principal.credentialId);
          if (mode === "close") store.close();
          if (mode === "abort") controller.abort();
          if (mode === "begin") active.exec("BEGIN");
        }
        return now;
      });
      store = captured.store;
      active = captured.db;
      const principal = f.storage.principal();
      const work =
        operation === "complete"
          ? workFrom(store.retireResult(principal, jobId, retentionMs))
          : undefined;
      const before = originalFacts(f);
      armed = true;
      try {
        expect(() =>
          operation === "retire"
            ? store.retireResult(
                principal,
                jobId,
                retentionMs,
                controller.signal,
              )
            : store.completeResultCleanup(work!, controller.signal),
        ).toThrow();
        expect(calls).toBe(1);
      } finally {
        if (active.open && active.inTransaction) active.exec("ROLLBACK");
      }
      expect(originalFacts(f)).toEqual(before);
      expect(retirements(f)).toEqual(
        work ? [expect.objectContaining({ cleaned_at: null })] : [],
      );
    },
  );

  it.each(["retire", "complete"] as const)(
    "%s 拒绝从自身 clock 同步重入，外层只完成一次真实写入",
    async (operation) => {
      const { f, jobId } = await publishedResult();
      let armed = false;
      let nested: unknown;
      let work: ResultCleanupWork | undefined;
      let store: EnhancementStore;
      const { store: current } = captureConnection(f, () => {
        if (armed) {
          armed = false;
          try {
            if (operation === "retire")
              store.retireResult(principal, jobId, retentionMs);
            else store.completeResultCleanup(work!);
          } catch (error) {
            nested = error;
          }
        }
        return f.storage.clock();
      });
      store = current;
      const principal = f.storage.principal();
      if (operation === "complete")
        work = workFrom(store.retireResult(principal, jobId, retentionMs));
      armed = true;
      if (operation === "retire")
        work = workFrom(store.retireResult(principal, jobId, retentionMs));
      else
        expect(store.completeResultCleanup(work!).cleanedAt).toBe(
          f.storage.clock(),
        );
      expect(nested).toEqual(internalError);
      expect(retirements(f)).toHaveLength(1);
    },
  );

  it.each(["retire", "complete"] as const)(
    "%s 在 post-clock 原生 signal getter 撤权后不得写入，且回调均在事务外",
    async (operation) => {
      const { f, jobId } = await publishedResult();
      let armed = false;
      let afterClock = false;
      const { store, db } = captureConnection(f, () => {
        if (armed) {
          armed = false;
          afterClock = true;
        }
        return f.storage.clock();
      });
      const principal = f.storage.principal();
      const work =
        operation === "complete"
          ? workFrom(store.retireResult(principal, jobId, retentionMs))
          : undefined;
      const signal = new AbortController().signal;
      const nativeAborted = Object.getOwnPropertyDescriptor(
        AbortSignal.prototype,
        "aborted",
      )!.get!;
      const transactions: boolean[] = [];
      let revoked = false;
      Object.defineProperty(signal, "aborted", {
        configurable: true,
        get() {
          transactions.push(db.inTransaction);
          if (afterClock && !revoked) {
            revoked = true;
            revokeCredential(store, principal.credentialId);
          }
          return nativeAborted.call(signal) as boolean;
        },
      });
      armed = true;
      try {
        expect(() =>
          operation === "retire"
            ? store.retireResult(principal, jobId, retentionMs, signal)
            : store.completeResultCleanup(work!, signal),
        ).toThrowError(
          expect.objectContaining({ code: "authentication_failed" }),
        );
      } finally {
        Reflect.deleteProperty(signal, "aborted");
      }
      expect(revoked).toBe(true);
      expect(transactions.length).toBeGreaterThan(0);
      expect(transactions.every((active) => !active)).toBe(true);
      expect(retirements(f)).toEqual(
        work ? [expect.objectContaining({ cleaned_at: null })] : [],
      );
    },
  );
});

describe("真实 SQLite 写入与 COMMIT 边界", () => {
  it.each(["statement", "commit"] as const)(
    "首次退役真实 %s 失败时不落退役行，移除故障后才可首次退役",
    async (stage) => {
      const { f, jobId } = await publishedResult();
      requireSchema7(f);
      const { store, db } = captureConnection(f);
      const principal = f.storage.principal();
      const before = originalFacts(f);
      installWriteFault(db, "INSERT", stage);
      expect(() =>
        store.retireResult(principal, jobId, retentionMs),
      ).toThrowError(internalError);
      expect(db.inTransaction).toBe(false);
      expect(retirements(f)).toEqual([]);
      expect(
        snapshot(f.storage, (copy) =>
          copy.prepare("SELECT * FROM result_retirement_commit_fault").all(),
        ),
      ).toEqual([]);
      expect(originalFacts(f)).toEqual(before);
      db.exec("DROP TRIGGER retirement_write_fault");
      expect(store.retireResult(principal, jobId, retentionMs).kind).toBe(
        "retired",
      );
    },
  );

  it.each(["statement", "commit"] as const)(
    "complete 真实 %s 失败时保持 pending，不自动重写或改动原成功链",
    async (stage) => {
      const { f, jobId } = await publishedResult();
      requireSchema7(f);
      const { store, db } = captureConnection(f);
      const principal = f.storage.principal();
      const work = workFrom(store.retireResult(principal, jobId, retentionMs));
      const before = originalFacts(f);
      const rows = retirements(f);
      installWriteFault(db, "UPDATE OF cleaned_at", stage);
      expect(() => store.completeResultCleanup(work)).toThrowError(
        internalError,
      );
      expect(db.inTransaction).toBe(false);
      expect(retirements(f)).toEqual(rows);
      expect(
        snapshot(f.storage, (copy) =>
          copy.prepare("SELECT * FROM result_retirement_commit_fault").all(),
        ),
      ).toEqual([]);
      expect(store.readResultRetirement(principal, jobId)).toEqual(
        work.retirement,
      );
      expect(originalFacts(f)).toEqual(before);
    },
  );

  it("首次退役真实 COMMIT 后丢确认只留下原持久记录，不泄漏或补发 work", async () => {
    const { f, jobId, deadline } = await publishedResult();
    requireSchema7(f);
    const { store, db } = captureConnection(f);
    const principal = f.storage.principal();
    const loss = loseCommitConfirmation(db, jobId, false);
    let returned: ResultRetirementOutcome | undefined;
    try {
      try {
        returned = store.retireResult(principal, jobId, retentionMs);
      } catch {
        /* 未知允许抛错 */
      }
      expect(returned?.kind === "retired" ? returned.work : null).toBeNull();
      expect(loss.committed).toEqual([
        expect.objectContaining({ retired_at: deadline, cleaned_at: null }),
      ]);
    } finally {
      loss.restore();
    }
    const rows = retirements(f);
    expect(rows).toHaveLength(1);
    const original = store.readResultRetirement(principal, jobId);
    expect(original).toMatchObject({ retiredAt: deadline, cleanedAt: null });
    expect(store.retireResult(principal, jobId, retentionMs + 1)).toEqual({
      kind: "retired",
      retirement: original,
      work: null,
    });
    const reopened = reopen(f);
    expect(reopened.readResultRetirement(f.storage.principal(), jobId)).toEqual(
      original,
    );
    expect(
      reopened.retireResult(f.storage.principal(), jobId, retentionMs * 2),
    ).toEqual({ kind: "retired", retirement: original, work: null });
    expect(retirements(f)).toEqual(rows);
  });

  it("complete 真实 COMMIT 后丢确认保留单次 cleaned_at，并仅回读原事实", async () => {
    const { f, jobId, deadline } = await publishedResult();
    requireSchema7(f);
    const { store, db } = captureConnection(f);
    const principal = f.storage.principal();
    const work = workFrom(store.retireResult(principal, jobId, retentionMs));
    f.storage.setNow(deadline + 1);
    const loss = loseCommitConfirmation(db, jobId, true);
    try {
      try {
        store.completeResultCleanup(work);
      } catch {
        /* 提交确认未知，禁止重放写入 */
      }
      expect(loss.committed).toEqual([
        expect.objectContaining({ cleaned_at: deadline + 1 }),
      ]);
    } finally {
      loss.restore();
    }
    const rows = retirements(f);
    expect(rows).toEqual([
      expect.objectContaining({ cleaned_at: deadline + 1 }),
    ]);
    expect(store.readResultRetirement(principal, jobId)).toEqual({
      ...work.retirement,
      cleanedAt: deadline + 1,
    });
    const reopened = reopen(f);
    expect(
      reopened.retireResult(f.storage.principal(), jobId, retentionMs),
    ).toEqual({
      kind: "retired",
      retirement: { ...work.retirement, cleanedAt: deadline + 1 },
      work: null,
    });
    expect(retirements(f)).toEqual(rows);
  });
});

describe("schema7 与不可撤销退役行", () => {
  it("新鲜初始化仅包含固定 schema7 退役列", async () => {
    requireSchema7(await fixture());
  });

  it("退役字段不可修改或删除，cleaned_at 只能由 NULL 前进一次", async () => {
    const { f, jobId, deadline } = await publishedResult();
    const { store, db } = captureConnection(f);
    const work = workFrom(
      store.retireResult(f.storage.principal(), jobId, retentionMs),
    );
    const before = retirements(f);
    for (const sql of [
      "UPDATE result_retirements SET job_id = 'changed'",
      "UPDATE result_retirements SET candidate_id = 'changed'",
      "UPDATE result_retirements SET attempt_no = attempt_no + 1",
      "UPDATE result_retirements SET retention_ms = retention_ms + 1",
      "UPDATE result_retirements SET retired_at = retired_at + 1",
      "UPDATE result_retirements SET cleaned_at = retired_at - 1",
      "DELETE FROM result_retirements",
    ])
      expect(() => db.exec(sql)).toThrow();
    expect(retirements(f)).toEqual(before);
    f.storage.setNow(deadline + 1);
    expect(store.completeResultCleanup(work).cleanedAt).toBe(deadline + 1);
    const complete = retirements(f);
    expect(() =>
      db.exec("UPDATE result_retirements SET cleaned_at = NULL"),
    ).toThrow();
    expect(() =>
      db.exec("UPDATE result_retirements SET cleaned_at = cleaned_at + 1"),
    ).toThrow();
    expect(() => db.exec("DELETE FROM result_retirements")).toThrow();
    expect(retirements(f)).toEqual(complete);
  });

  it.each(["old6", "unknown", "missing-table", "missing-column"] as const)(
    "拒绝 %s 数据库而不迁移、补表或改变已发布结果",
    async (mode) => {
      const { f, published } = await publishedResult();
      requireSchema7(f);
      const candidate = published.work.candidate!;
      const png = readFileSync(candidate.pngPath);
      f.storage.store.close();
      const db = new Database(join(f.storage.directory, "worker.sqlite"));
      try {
        if (mode === "old6") db.pragma("user_version = 6");
        else if (mode === "unknown") db.pragma("user_version = 99");
        else {
          db.exec("DROP TABLE result_retirements");
          if (mode === "missing-column")
            db.exec(
              "CREATE TABLE result_retirements (job_id TEXT PRIMARY KEY) STRICT",
            );
        }
      } finally {
        db.close();
      }
      const state = () =>
        snapshot(f.storage, (copy) => ({
          version: copy.pragma("user_version", { simple: true }),
          schema: copy
            .prepare(
              "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
            )
            .all(),
          incarnations: copy
            .prepare("SELECT * FROM store_incarnations ORDER BY rowid")
            .all(),
          jobs: copy.prepare("SELECT * FROM jobs ORDER BY rowid").all(),
        }));
      const before = state();
      let opened: EnhancementStore | undefined;
      try {
        expect(() => {
          opened = openStore({
            directory: f.storage.directory,
            clock: f.storage.clock,
          });
        }).toThrowError(
          expect.objectContaining({ code: "configuration_invalid" }),
        );
      } finally {
        opened?.close();
      }
      expect(state()).toEqual(before);
      expect(readFileSync(candidate.pngPath)).toEqual(png);
    },
  );
});
