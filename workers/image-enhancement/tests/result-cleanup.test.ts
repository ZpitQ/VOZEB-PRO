import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createArtifacts } from "../src/artifacts.js";
import {
  EnhancementError,
  type ResultReceiptRequest,
} from "../src/contracts.js";
import { revokeCredential } from "../src/credentials.js";
import { openStore } from "../src/store.js";
import {
  artifactFixture,
  writeActualFile,
  type ArtifactFileEvent,
  type ArtifactFixture,
} from "./artifact-fixtures.js";
import {
  artifactJobRows,
  assertCandidateFiles,
  publishedArtifactControl,
} from "./artifact-fault-fixtures.js";
import { commitFault, snapshot } from "./lifecycle-fixtures.js";

const retentionMs = 60_000;
const fixtures: ArtifactFixture[] = [];
const releases: (() => void)[] = [];
const controllers: AbortController[] = [];
const pending: Promise<unknown>[] = [];
type State = Awaited<
  ReturnType<ReturnType<typeof createArtifacts>["cleanupAcknowledgedResult"]>
>["state"];
type RetirementRow = {
  job_id: string;
  candidate_id: string;
  attempt_no: number;
  retention_ms: number;
  retired_at: number;
  cleaned_at: number | null;
};

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const f of fixtures) f.controller.abort();
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});

async function fixture(commit?: "retire" | "complete") {
  const f = await artifactFixture();
  fixtures.push(f);
  if (commit)
    commitFault(
      f.storage,
      `CREATE TRIGGER cleanup_commit_fault AFTER ${
        commit === "retire" ? "INSERT" : "UPDATE OF cleaned_at"
      } ON result_retirements
       BEGIN
         INSERT INTO lifecycle_commit_fault(client_id)
         VALUES ('cleanup-fault-missing-client');
       END;`,
    );
  return f;
}

async function publishedResult(existing?: ArtifactFixture, acknowledge = true) {
  const f = existing ?? (await fixture());
  const published = await publishedArtifactControl(f, "cleanup-source");
  const jobId = published.attempt.identity.jobId;
  const candidate = published.work.candidate;
  assert.ok(candidate);
  const principal = f.storage.principal();
  const request: ResultReceiptRequest = {
    serviceId: f.storage.store.identity.serviceId,
    receiptId: randomUUID(),
    result: { ...candidate.manifest.png },
  };
  if (acknowledge) f.storage.store.acknowledgeResult(principal, jobId, request);
  const completedAt = f.job(jobId).completedAt;
  assert.notEqual(completedAt, null);
  const deadline = completedAt! + retentionMs;
  f.storage.setNow(deadline);
  const artifacts = createArtifacts({ store: f.storage.store, files: f.files });
  return {
    f,
    published,
    jobId,
    candidate,
    principal,
    request,
    deadline,
    artifacts,
  };
}

type PublishedResult = Awaited<ReturnType<typeof publishedResult>>;

function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => undefined);
  return promise;
}

function controller() {
  const value = new AbortController();
  controllers.push(value);
  return value;
}

function cleanup(r: PublishedResult, signal?: AbortSignal) {
  return track(
    r.artifacts.cleanupAcknowledgedResult(
      r.principal,
      r.jobId,
      retentionMs,
      signal,
    ),
  );
}

function expectState(result: Readonly<{ state: State }>, state: State) {
  expect(result).toEqual({ state });
  expect(Reflect.ownKeys(result)).toEqual(["state"]);
  expect(Object.isFrozen(result)).toBe(true);
}

function retirementRows(f: ArtifactFixture) {
  return snapshot(f.storage, (db) =>
    db.prepare("SELECT * FROM result_retirements ORDER BY rowid").all(),
  ) as RetirementRow[];
}

function facts(r: PublishedResult) {
  return {
    ...artifactJobRows(r.f, r.jobId),
    preserved: snapshot(r.f.storage, (db) => ({
      receipts: db
        .prepare("SELECT * FROM result_receipts ORDER BY rowid")
        .all(),
      controls: db
        .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
        .all(),
      history: db.prepare("SELECT * FROM recovery_events ORDER BY rowid").all(),
    })),
  };
}

function issued(f: ArtifactFixture, first: number) {
  return f.events
    .slice(first)
    .filter(({ phase }) => phase === "before")
    .map(({ event }) => ({ stage: event.stage, path: event.path }));
}

function operations(r: PublishedResult) {
  return [
    { stage: "unlink", path: r.candidate.pngPath },
    { stage: "unlink", path: r.candidate.manifestPath },
    { stage: "directory_sync", path: r.candidate.directory },
  ] as const;
}

function gate(
  r: PublishedResult,
  operation: { stage: ArtifactFileEvent["stage"]; path: string },
  phase: "before" | "after" = "after",
) {
  const value = r.f.gate(
    (event) => event.stage === operation.stage && event.path === operation.path,
    phase,
  );
  releases.push(() => value.release());
  return value;
}

function reached<T>(barrier: Promise<T>, result: Promise<unknown>) {
  return Promise.race([
    barrier,
    result.then(
      () => {
        throw new Error(
          "cleanup/read settled before its required real I/O boundary",
        );
      },
      (cause: unknown) => {
        throw new Error(
          "cleanup/read rejected before its required real I/O boundary",
          {
            cause,
          },
        );
      },
    ),
  ]);
}

async function expectFinals(
  r: PublishedResult,
  png: boolean,
  manifest: boolean,
) {
  for (const [path, present, bytes] of [
    [r.candidate.pngPath, png, r.published.png],
    [
      r.candidate.manifestPath,
      manifest,
      Buffer.from(JSON.stringify(r.candidate.manifest), "utf8"),
    ],
  ] as const) {
    if (present) expect(await readFile(path)).toEqual(bytes);
    else await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect((await stat(r.candidate.directory)).isDirectory()).toBe(true);
}

function reopen(f: ArtifactFixture) {
  f.storage.store.close();
  const store = openStore({
    directory: f.storage.directory,
    clock: f.storage.clock,
  });
  f.storage.setStore(store);
  return createArtifacts({ store, files: f.files });
}

// Capture only the actual openStore connection; every statement still runs SQLite.
function captureConnection(f: ArtifactFixture) {
  f.storage.store.close();
  const path = join(f.storage.directory, "worker.sqlite");
  const original = Database.prototype.prepare;
  let database: Database.Database | undefined;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    if (this.name === path) database = this;
    return original.call(this, sql);
  } as typeof original;
  try {
    f.storage.setStore(
      openStore({ directory: f.storage.directory, clock: f.storage.clock }),
    );
    assert.ok(database);
    return database;
  } finally {
    Database.prototype.prepare = original;
  }
}

describe("exact cleanup of an acknowledged published result", () => {
  it.each(["awaiting_receipt", "retention_pending", "reference_held"] as const)(
    "returns frozen %s without retirement or file operations",
    async (state) => {
      const r = await publishedResult(
        await fixture(),
        state !== "awaiting_receipt",
      );
      if (state === "retention_pending") r.f.storage.setNow(r.deadline - 1);
      const held =
        state === "reference_held"
          ? r.f.storage.store.acquireArtifactWork(
              r.published.attempt.identity,
              "recovery",
            )
          : undefined;
      if (state === "reference_held") assert.ok(held);
      const before = facts(r);
      const first = r.f.events.length;
      const complete = vi.spyOn(r.f.storage.store, "completeResultCleanup");
      expectState(await cleanup(r), state);
      expect(retirementRows(r.f)).toEqual([]);
      expect(r.f.events.slice(first)).toEqual([]);
      expect(complete).not.toHaveBeenCalled();
      expect(facts(r)).toEqual(before);
      await assertCandidateFiles(r.candidate, r.published.png);
      if (held)
        expect(r.f.storage.store.releaseArtifactReference(held.key)).toBe(true);
    },
  );

  it("commits retirement before removing only the selected finals, then completes after candidate sync", async () => {
    const r = await publishedResult();
    const other = await publishedArtifactControl(
      r.f,
      "cleanup-other-published",
    );
    assert.ok(other.work.candidate);
    const original = await r.f.originalBytes(r.published.attempt);
    const preservedPaths = [
      r.published.attempt.inputPath,
      r.published.attempt.outputPath,
      other.work.candidate.pngPath,
      other.work.candidate.manifestPath,
    ];
    const preservedBytes = await Promise.all(
      preservedPaths.map((path) => readFile(path)),
    );
    const partPaths = [
      r.candidate.pngPartPath,
      r.candidate.manifestPartPath,
      join(r.candidate.directory, "unrelated.part"),
      join(
        dirname(r.candidate.directory),
        "unselected-candidate-fixture",
        "artifact.png",
      ),
      join(
        dirname(r.candidate.directory),
        "unselected-candidate-fixture",
        "manifest.json",
      ),
    ];
    for (const path of partPaths)
      await writeActualFile(path, Buffer.from(path));
    const before = facts(r);
    const otherBefore = artifactJobRows(r.f, other.attempt.identity.jobId);
    const dto = r.f.job(r.jobId);
    const first = r.f.events.length;
    r.f.hooks.before = async (event) => {
      if (event.stage === "unlink")
        expect(retirementRows(r.f)).toEqual([
          expect.objectContaining({ job_id: r.jobId, cleaned_at: null }),
        ]);
    };
    const actualComplete = r.f.storage.store.completeResultCleanup.bind(
      r.f.storage.store,
    );
    const complete = vi
      .spyOn(r.f.storage.store, "completeResultCleanup")
      .mockImplementation((...args) => {
        expect(
          r.f.events
            .slice(first)
            .map(({ phase, event }) => [phase, event.stage, event.path]),
        ).toEqual(
          operations(r).flatMap((event) => [
            ["before", event.stage, event.path],
            ["after", event.stage, event.path],
          ]),
        );
        return actualComplete(...args);
      });
    expectState(await cleanup(r), "complete");
    expect(issued(r.f, first)).toEqual(operations(r));
    expect(complete).toHaveBeenCalledTimes(1);
    await expectFinals(r, false, false);
    expect(retirementRows(r.f)).toEqual([
      expect.objectContaining({
        job_id: r.jobId,
        candidate_id: r.candidate.candidateId,
        attempt_no: r.published.attempt.identity.attemptNo,
        retention_ms: retentionMs,
        retired_at: r.deadline,
        cleaned_at: r.deadline,
      }),
    ]);
    expect(facts(r)).toEqual(before);
    expect(artifactJobRows(r.f, other.attempt.identity.jobId)).toEqual(
      otherBefore,
    );
    expect(r.f.job(r.jobId)).toEqual(dto);
    expect(await r.f.originalBytes(r.published.attempt)).toEqual(original);
    for (const [index, path] of preservedPaths.entries())
      expect(await readFile(path)).toEqual(preservedBytes[index]);
    for (const path of partPaths)
      expect(await readFile(path)).toEqual(Buffer.from(path));
    const after = r.f.events.length;
    expectState(await cleanup(r), "complete");
    expect(r.f.events.slice(after)).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("returns pending to a second caller without stealing the held first cleanup's one work grant", async () => {
    const r = await publishedResult();
    const held = gate(r, operations(r)[0], "before");
    const first = r.f.events.length;
    const retiring = cleanup(r);
    await reached(held.reached, retiring);
    const row = retirementRows(r.f);
    expect(row).toEqual([expect.objectContaining({ cleaned_at: null })]);
    const afterGate = r.f.events.length;
    const independent = createArtifacts({
      store: r.f.storage.store,
      files: r.f.files,
    });
    expectState(
      await track(
        independent.cleanupAcknowledgedResult(
          r.principal,
          r.jobId,
          retentionMs,
        ),
      ),
      "pending",
    );
    expect(r.f.events.slice(afterGate)).toEqual([]);
    expect(retirementRows(r.f)).toEqual(row);
    await expectFinals(r, true, true);
    held.release();
    expectState(await retiring, "complete");
    expect(issued(r.f, first)).toEqual(operations(r));
    await expectFinals(r, false, false);
  });

  it("never emits file work for an existing pending retirement, including after Store reopen", async () => {
    const r = await publishedResult();
    const retired = r.f.storage.store.retireResult(
      r.principal,
      r.jobId,
      retentionMs,
    );
    assert.ok(retired.kind === "retired" && retired.work);
    const before = facts(r);
    const row = retirementRows(r.f);
    const first = r.f.events.length;
    expectState(await cleanup(r), "pending");
    const reopened = reopen(r.f);
    expectState(
      await track(
        reopened.cleanupAcknowledgedResult(
          r.f.storage.principal(),
          r.jobId,
          retentionMs,
        ),
      ),
      "pending",
    );
    expect(r.f.events.slice(first)).toEqual([]);
    expect(retirementRows(r.f)).toEqual(row);
    expect(facts(r)).toEqual(before);
    await expectFinals(r, true, true);
  });

  it.each(
    [0, 1, 2].flatMap((operation) =>
      (["before", "actual", "after"] as const).map((phase) => ({
        operation,
        phase,
      })),
    ),
  )(
    "keeps pending at operation $operation/$phase and never reissues unknown file work",
    async ({ operation, phase }) => {
      const r = await publishedResult();
      const target = operations(r)[operation];
      assert.ok(target);
      const before = facts(r);
      const first = r.f.events.length;
      const complete = vi.spyOn(r.f.storage.store, "completeResultCleanup");
      const displaced = `${target.path}.cleanup-fault-kept`;
      let moved = false;
      let hits = 0;
      r.f.hooks[phase === "after" ? "after" : "before"] = async (event) => {
        if (event.stage !== target.stage || event.path !== target.path) return;
        hits++;
        if (phase === "actual") {
          await rename(target.path, displaced);
          moved = true;
        } else throw new Error("cleanup boundary confirmation unknown");
      };
      try {
        expectState(await cleanup(r), "pending");
      } finally {
        if (moved) await rename(displaced, target.path);
      }
      expect(hits).toBe(1);
      expect(issued(r.f, first)).toEqual(operations(r).slice(0, operation + 1));
      if (phase === "actual")
        expect(r.f.failures).toEqual([
          expect.objectContaining({
            event: expect.objectContaining(target),
            error: expect.objectContaining({ code: "ENOENT" }),
          }),
        ]);
      expect(complete).not.toHaveBeenCalled();
      expect(retirementRows(r.f)).toEqual([
        expect.objectContaining({ cleaned_at: null }),
      ]);
      expect(facts(r)).toEqual(before);
      await expectFinals(
        r,
        operation === 0 && phase !== "after",
        operation < 1 || (operation === 1 && phase !== "after"),
      );
      const row = retirementRows(r.f);
      const after = r.f.events.length;
      expectState(await cleanup(r), "pending");
      expect(r.f.events.slice(after)).toEqual([]);
      expect(retirementRows(r.f)).toEqual(row);
      expect(hits).toBe(1);
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it.each(
    (["abort", "close", "revoke"] as const).flatMap((mode) =>
      (["before", "after"] as const).map((phase) => ({ mode, phase })),
    ),
  )(
    "waits for issued unlink to settle after $mode at its $phase hook, then stops",
    async ({ mode, phase }) => {
      const r = await publishedResult();
      const signal = controller();
      const held = gate(r, operations(r)[0], phase);
      const first = r.f.events.length;
      const complete = vi.spyOn(r.f.storage.store, "completeResultCleanup");
      let settled = false;
      const cleaning = cleanup(r, signal.signal);
      void cleaning.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await reached(held.reached, cleaning);
      if (mode === "abort") signal.abort();
      else if (mode === "close") r.f.storage.store.close();
      else revokeCredential(r.f.storage.store, r.principal.credentialId);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(retirementRows(r.f)).toEqual([
        expect.objectContaining({ cleaned_at: null }),
      ]);
      await expectFinals(r, phase === "before", true);
      expect(settled).toBe(false);
      held.release();
      expectState(await cleaning, "pending");
      expect(issued(r.f, first)).toEqual(operations(r).slice(0, 1));
      expect(complete).not.toHaveBeenCalled();
      await expectFinals(r, false, true);
      expect(retirementRows(r.f)).toEqual([
        expect.objectContaining({ cleaned_at: null }),
      ]);
    },
  );
});

describe("retirement fences published downloads", () => {
  it.each(["retire-first", "publisher-before-microtask-acquire"] as const)(
    "%s yields 410 with no inserted reference or artifact open",
    async (order) => {
      const r = await publishedResult();
      const before = facts(r);
      const first = r.f.events.length;
      const publisher = vi.spyOn(
        r.f.storage.store,
        "getPublishedResultPublisher",
      );
      const reading =
        order === "publisher-before-microtask-acquire"
          ? track(
              r.artifacts.readPublished(
                r.principal,
                r.jobId,
                controller().signal,
              ),
            )
          : undefined;
      if (reading)
        expect(publisher).toHaveBeenCalledExactlyOnceWith(r.principal, r.jobId);
      const retired = r.f.storage.store.retireResult(
        r.principal,
        r.jobId,
        retentionMs,
      );
      assert.ok(retired.kind === "retired" && retired.work);
      await expect(
        reading ??
          track(
            r.artifacts.readPublished(
              r.principal,
              r.jobId,
              controller().signal,
            ),
          ),
      ).rejects.toMatchObject({ code: "result_gone", status: 410 });
      expect(r.f.events.slice(first)).toEqual([]);
      expect(facts(r)).toEqual(before);
      expect(
        r.f.storage.store.getPublishedResultPublisher(r.principal, r.jobId),
      ).toEqual(r.published.attempt.identity);
      await expectFinals(r, true, true);
    },
  );

  it("blocks cleanup while the earlier download holds its real PNG handle and cleans only after release", async () => {
    const r = await publishedResult();
    const first = r.f.events.length;
    const held = gate(r, { stage: "open", path: r.candidate.pngPath });
    const reading = track(
      r.artifacts.readPublished(r.principal, r.jobId, controller().signal),
    );
    const opened = await reached(held.reached, reading);
    assert.ok(opened.file);
    expect((await opened.file.stat()).isFile()).toBe(true);
    const rows = artifactJobRows(r.f, r.jobId);
    const heldReference = rows.references.find(
      (reference) => reference.released_at === null,
    );
    assert.ok(heldReference);
    expect(heldReference).toMatchObject({
      purpose: "recovery",
      candidate_id: r.candidate.candidateId,
    });
    const beforeCleanup = r.f.events.length;
    expectState(await cleanup(r), "reference_held");
    expect(r.f.events.slice(beforeCleanup)).toEqual([]);
    expect(retirementRows(r.f)).toEqual([]);
    await expectFinals(r, true, true);
    held.release();
    expect(await reading).toEqual({
      ...r.candidate.manifest.png,
      bytes: r.published.png,
    });
    await expect(opened.file.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(
      artifactJobRows(r.f, r.jobId).references.find(
        (reference) => reference.reference_id === heldReference.reference_id,
      ),
    ).toMatchObject({ released_at: r.deadline });
    const afterRead = r.f.events.length;
    expectState(await cleanup(r), "complete");
    expect(issued(r.f, afterRead)).toEqual(operations(r));
    expect(artifactJobRows(r.f, r.jobId).references).toHaveLength(
      rows.references.length,
    );
    await expectFinals(r, false, false);
    for (const { event, phase } of r.f.events.slice(first))
      if (phase === "after" && event.stage === "open") {
        assert.ok(event.file);
        await expect(event.file.stat()).rejects.toMatchObject({
          code: "EBADF",
        });
      }
  });
});

describe("cleanup commit outcomes are never replayed", () => {
  it("keeps pending after a one-off real assertion confirmation loss inside the first directory guard", async () => {
    const r = await publishedResult();
    const store = r.f.storage.store;
    const before = facts(r);
    const first = r.f.events.length;
    const actualAssert = store.assertResultCleanupWork.bind(store);
    const actualSync = r.f.files.syncDirectory.bind(r.f.files);
    const complete = vi.spyOn(store, "completeResultCleanup");
    let insideDirectoryGuard = false;
    let guardCalls = 0;
    let losses = 0;
    const asserted = vi
      .spyOn(store, "assertResultCleanupWork")
      .mockImplementation((...args) => {
        actualAssert(...args);
        if (insideDirectoryGuard && losses === 0) {
          losses++;
          throw new EnhancementError("internal_error");
        }
      });
    const sync = vi
      .spyOn(r.f.files, "syncDirectory")
      .mockImplementation(async (path, guard) => {
        expect(path).toBe(r.candidate.directory);
        await expectFinals(r, false, false);
        return actualSync(path, () => {
          guardCalls++;
          insideDirectoryGuard = true;
          try {
            return guard();
          } finally {
            insideDirectoryGuard = false;
          }
        });
      });
    const result = await cleanup(r);
    expect(losses).toBe(1);
    expect(guardCalls).toBe(1);
    expect(sync).toHaveBeenCalledExactlyOnceWith(
      r.candidate.directory,
      expect.any(Function),
    );
    expect(issued(r.f, first)).toEqual(operations(r));
    await expectFinals(r, false, false);
    const originalWork = asserted.mock.calls[0]?.[0];
    assert.ok(originalWork);
    // The same real permit is still valid; only one guard confirmation was lost.
    expect(() => store.assertResultCleanupWork(originalWork)).not.toThrow();
    expect(
      asserted.mock.results.filter((call) => call.type === "throw"),
    ).toHaveLength(1);
    expectState(result, "pending");
    const row = retirementRows(r.f);
    expect(row).toEqual([
      expect.objectContaining({ job_id: r.jobId, cleaned_at: null }),
    ]);
    expect(complete).not.toHaveBeenCalled();
    expect(facts(r)).toEqual(before);
    const after = r.f.events.length;
    expectState(await cleanup(r), "pending");
    expect(r.f.events.slice(after)).toEqual([]);
    expect(retirementRows(r.f)).toEqual(row);
    expect(complete).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(guardCalls).toBe(1);
    expect(losses).toBe(1);
  });

  it("keeps pending after a real completion COMMIT failure installed before publication", async () => {
    const r = await publishedResult(await fixture("complete"));
    const before = facts(r);
    const first = r.f.events.length;
    const complete = vi.spyOn(r.f.storage.store, "completeResultCleanup");
    expectState(await cleanup(r), "pending");
    expect(issued(r.f, first)).toEqual(operations(r));
    await expectFinals(r, false, false);
    const row = retirementRows(r.f);
    expect(row).toEqual([expect.objectContaining({ cleaned_at: null })]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.results[0]?.type).toBe("throw");
    expect(
      snapshot(r.f.storage, (db) =>
        db.prepare("SELECT * FROM lifecycle_commit_fault").all(),
      ),
    ).toEqual([]);
    expect(facts(r)).toEqual(before);
    const after = r.f.events.length;
    expectState(await cleanup(r), "pending");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(r.f.events.slice(after)).toEqual([]);
    expect(retirementRows(r.f)).toEqual(row);
  });

  it("reads complete after the real completion method committed but its outer confirmation was lost", async () => {
    const r = await publishedResult();
    const first = r.f.events.length;
    const before = facts(r);
    const actual = r.f.storage.store.completeResultCleanup.bind(
      r.f.storage.store,
    );
    const read = vi.spyOn(r.f.storage.store, "readResultRetirement");
    let readsAtLoss = -1;
    const complete = vi
      .spyOn(r.f.storage.store, "completeResultCleanup")
      .mockImplementation((...args) => {
        const persisted = actual(...args);
        expect(persisted.cleanedAt).toBe(r.deadline);
        expect(retirementRows(r.f)).toEqual([
          expect.objectContaining({ cleaned_at: r.deadline }),
        ]);
        readsAtLoss = read.mock.calls.length;
        throw new EnhancementError("internal_error");
      });
    expectState(await cleanup(r), "pending");
    expect(read).toHaveBeenCalledTimes(readsAtLoss);
    const row = retirementRows(r.f);
    expect(row).toEqual([expect.objectContaining({ cleaned_at: r.deadline })]);
    expect(issued(r.f, first)).toEqual(operations(r));
    await expectFinals(r, false, false);
    const after = r.f.events.length;
    r.f.storage.setNow(r.deadline + 1);
    expectState(await cleanup(r), "complete");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(r.f.events.slice(after)).toEqual([]);
    expect(retirementRows(r.f)).toEqual(row);
    expect(facts(r)).toEqual(before);
    const reopened = reopen(r.f);
    expectState(
      await track(
        reopened.cleanupAcknowledgedResult(
          r.f.storage.principal(),
          r.jobId,
          retentionMs,
        ),
      ),
      "complete",
    );
    expect(r.f.events.slice(after)).toEqual([]);
    expect(retirementRows(r.f)).toEqual(row);
  });

  it("propagates 503 for a real retirement COMMIT failure and never emits file work", async () => {
    const r = await publishedResult(await fixture("retire"));
    const before = facts(r);
    const first = r.f.events.length;
    const retire = vi.spyOn(r.f.storage.store, "retireResult");
    await expect(cleanup(r)).rejects.toMatchObject({
      code: "internal_error",
      status: 503,
    });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(retirementRows(r.f)).toEqual([]);
    expect(r.f.events.slice(first)).toEqual([]);
    expect(facts(r)).toEqual(before);
    await expectFinals(r, true, true);
  });

  it("propagates 503 for lost actual retirement COMMIT confirmation, then only reports the persisted pending row", async () => {
    const f = await fixture();
    const db = captureConnection(f);
    const r = await publishedResult(f);
    const before = facts(r);
    const first = f.events.length;
    const nativeTransaction = db.transaction;
    const committed: RetirementRow[] = [];
    let lost = false;
    db.transaction = new Proxy(nativeTransaction, {
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
                  .get(r.jobId) as RetirementRow | undefined;
                if (row) {
                  committed.push({ ...row });
                  if (!lost) {
                    lost = true;
                    throw new Error(
                      "lost confirmation after actual retirement COMMIT",
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
    try {
      await expect(cleanup(r)).rejects.toMatchObject({
        code: "internal_error",
        status: 503,
      });
      expect(committed).toEqual([
        expect.objectContaining({ retired_at: r.deadline, cleaned_at: null }),
      ]);
    } finally {
      db.transaction = nativeTransaction;
    }
    const row = retirementRows(f);
    expectState(await cleanup(r), "pending");
    expect(f.events.slice(first)).toEqual([]);
    expect(retirementRows(f)).toEqual(row);
    expect(facts(r)).toEqual(before);
    await expectFinals(r, true, true);
    const reopened = reopen(f);
    expectState(
      await track(
        reopened.cleanupAcknowledgedResult(
          f.storage.principal(),
          r.jobId,
          retentionMs,
        ),
      ),
      "pending",
    );
    expect(f.events.slice(first)).toEqual([]);
    expect(retirementRows(f)).toEqual(row);
  });
});
