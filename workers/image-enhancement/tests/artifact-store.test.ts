import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactWorkKey } from "../src/artifacts.js";
import {
  artifactFixture,
  nativePng,
  reachedBeforeSettled,
  type ArtifactFixture,
} from "./artifact-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import { sha256 } from "./storage-fixtures.js";

const fixtures: ArtifactFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup();
});
async function fixture() {
  const value = await artifactFixture();
  fixtures.push(value);
  return value;
}
function existingRows(f: ArtifactFixture) {
  return snapshot(f.storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
    attempts: db
      .prepare("SELECT * FROM attempts ORDER BY job_id, attempt_no")
      .all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
  }));
}

describe("artifact permissions and durable candidate prerequisites", () => {
  it("rejects an unknown work reference without changing the occupied execution", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const before = existingRows(f);
    const key: ArtifactWorkKey = {
      publisher: attempt.identity,
      referenceId: "unknown-reference",
    };
    expect(f.storage.store.readArtifactWork(key)).toEqual({ kind: "retired" });
    expect(existingRows(f)).toEqual(before);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "running",
      reason: null,
    });
  });

  it("rejects acquisition by another publisher without opening image files", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    await f.complete(attempt, await nativePng(attempt));
    const before = existingRows(f);
    expect(
      f.storage.store.acquireArtifactWork(
        { ...attempt.identity, ownerInstanceId: "foreign-publisher" },
        "run",
      ),
    ).toBeUndefined();
    expect(existingRows(f)).toEqual(before);
    expect(f.events).toEqual([]);
    expect(f.storage.store.claimNext("another-owner")).toBeUndefined();
    const work = f.storage.store.acquireArtifactWork(attempt.identity, "run");
    assert.ok(work);
    expect(work).toMatchObject({
      purpose: "run",
      access: "active",
      key: { publisher: attempt.identity },
      attempt: {
        identity: attempt.identity,
        producer: attempt.identity,
        launchTicket: attempt.launchTicket,
        job: {
          source: attempt.job.source,
          engineInput: attempt.job.engineInput,
        },
        exit: {
          identity: attempt.identity,
          launchTicket: attempt.launchTicket,
          treeExited: true,
          completion: { kind: "success", exitCode: 0, signal: null },
        },
      },
    });
    expect(f.storage.store.readArtifactWork(work.key)).toMatchObject({
      kind: "active",
      work: { key: work.key },
    });
    expect(f.events).toEqual([]);
  });

  it("persists the unique candidate intent and reference before creating its exclusive directory", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const gate = f.gate(
      (event) =>
        event.stage === "mkdir" && event.role === "candidate-directory",
      "before",
    );
    const pending = f.settle(attempt);
    await reachedBeforeSettled(gate, pending);
    const work = f.currentWork();
    assert.ok(work.candidate);
    expect(work).toMatchObject({
      purpose: "run",
      access: "active",
      attempt: {
        producer: attempt.identity,
        launchTicket: attempt.launchTicket,
      },
    });
    expect(work.candidate.state).toBe("intent");
    expect(f.rows().candidates).toEqual([
      expect.objectContaining({
        candidate_id: work.candidate.candidateId,
        state: "intent",
        durable_at: null,
      }),
    ]);
    expect(f.rows().references).toEqual([
      expect.objectContaining({
        reference_id: work.key.referenceId,
        candidate_id: work.candidate.candidateId,
        released_at: null,
      }),
    ]);
    await expect(stat(work.candidate.pngPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "running",
      result: null,
    });
    gate.release();
    await expect(pending).resolves.toBe("succeeded");
    expect(f.rows().candidates).toEqual([
      expect.objectContaining({
        candidate_id: work.candidate.candidateId,
        state: "durable",
        durable_at: 1_000,
      }),
    ]);
  });

  it("keeps both flushed files as intent until the final directory-sync acknowledgement returns", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const gate = f.gate(
      (event) =>
        event.stage === "directory_sync" && event.path === f.storage.directory,
    );
    const pending = f.settle(attempt);
    await reachedBeforeSettled(gate, pending);
    const work = f.currentWork();
    assert.ok(work.candidate);
    const candidate = work.candidate;
    expect(await readFile(candidate.pngPath)).toEqual(png);
    const manifest = await readFile(candidate.manifestPath);
    expect(sha256(manifest)).toBe(candidate.manifestSha256);
    expect(manifest.length).toBe(candidate.manifestByteLength);
    expect(JSON.parse(manifest.toString("utf8"))).toEqual(candidate.manifest);
    expect(f.rows().candidates[0]).toMatchObject({
      candidate_id: candidate.candidateId,
      state: "intent",
      durable_at: null,
    });
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "running",
      completedAt: null,
      result: null,
    });
    expect(f.rows().slot).toHaveLength(1);
    gate.release();
    await expect(pending).resolves.toBe("succeeded");
    expect(f.job(attempt.identity.jobId).result).toEqual(
      candidate.manifest.png,
    );
    expect(f.rows().slot).toEqual([]);
    expect(f.rows().references[0]?.released_at).toBe(1_000);
  });

  it("rejects a foreign candidate and a premature success without poisoning the live work", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    await f.complete(attempt, await nativePng(attempt));
    const gate = f.gate(
      (event) =>
        event.stage === "mkdir" && event.role === "candidate-directory",
      "before",
    );
    const pending = f.settle(attempt);
    await reachedBeforeSettled(gate, pending);
    const work = f.currentWork();
    assert.ok(work.candidate);
    const before = f.rows();
    expect(
      f.storage.store.recordArtifactCandidate(work.key, "foreign-candidate"),
    ).toBe(false);
    expect(f.storage.store.finishSucceeded(work.key, "foreign-candidate")).toBe(
      false,
    );
    expect(
      f.storage.store.finishSucceeded(work.key, work.candidate.candidateId),
    ).toBe(false);
    expect(f.rows()).toEqual(before);
    gate.release();
    await expect(pending).resolves.toBe("succeeded");
    expect(f.rows().candidates).toHaveLength(1);
  });

  it("cannot fail the current producer with another work reference", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    await f.complete(attempt, await nativePng(attempt));
    const before = existingRows(f);
    expect(
      f.storage.store.finishFailed(attempt.identity, {
        publisher: attempt.identity,
        referenceId: "foreign-reference",
      }),
    ).toBe(false);
    expect(existingRows(f)).toEqual(before);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "running",
      reason: null,
    });
  });

  it("short-circuits a closed store before attempting any reference query", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    f.storage.store.close();
    expect(
      f.storage.store.readArtifactWork({
        publisher: attempt.identity,
        referenceId: "unknown-reference",
      }),
    ).toEqual({ kind: "retired" });
  });
});
