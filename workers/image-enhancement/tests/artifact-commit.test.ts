import assert from "node:assert/strict";

import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactWork, ArtifactWorkKey } from "../src/artifacts.js";
import {
  artifactFixture,
  nativePng,
  reachedBeforeSettled,
  type ArtifactFixture,
} from "./artifact-fixtures.js";
import {
  artifactJobRows,
  assertCandidateFiles,
  assertIntentAndReference,
  assertQualifiedArtifactAttempt,
  installArtifactCommitFault,
  publishedArtifactControl,
  traceArtifactCommit,
} from "./artifact-fault-fixtures.js";
import { sha256, sourceImage, submission } from "./storage-fixtures.js";

const fixtures: ArtifactFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});
async function fixture() {
  const f = await artifactFixture();
  fixtures.push(f);
  return f;
}
function activeWork(f: ArtifactFixture, key: ArtifactWorkKey) {
  const read = f.storage.store.readArtifactWork(key);
  assert.equal(read.kind, "active");
  assert.ok(read.kind === "active");
  return read.work;
}
function expectCurrentIncarnation(
  rows: ReturnType<typeof artifactJobRows>,
  incarnationId: string,
) {
  expect(rows.attempts[0]?.producer_incarnation_id).toBe(incarnationId);
  for (const reference of rows.references)
    expect(reference.incarnation_id).toBe(incarnationId);
}
function expectCommitError(
  call: { error?: unknown; result?: unknown } | undefined,
) {
  assert.ok(call, "the actual target store method must be invoked");
  expect(call.error).toMatchObject({ code: "internal_error" });
  expect(call.result).toBeUndefined();
}
function expectCommittedSuccess(f: ArtifactFixture, work: ArtifactWork) {
  assert.ok(work.candidate);
  const rows = artifactJobRows(f, work.key.publisher.jobId);
  expect(rows.jobs).toEqual([
    expect.objectContaining({
      status: "succeeded",
      reason: null,
      completed_at: f.storage.clock(),
      result_candidate_id: work.candidate.candidateId,
    }),
  ]);
  expect(rows.candidates).toEqual([
    expect.objectContaining({
      candidate_id: work.candidate.candidateId,
      state: "durable",
    }),
  ]);
  expect(
    rows.references.find((row) => row.reference_id === work.key.referenceId)
      ?.released_at,
  ).toBe(f.storage.clock());
  expect(rows.slot).toEqual([]);
  expect(rows.attempts).toHaveLength(1);
  expect(f.job(work.key.publisher.jobId).result).toEqual(
    work.candidate.manifest.png,
  );
}
function expectCommitObservation(
  f: ArtifactFixture,
  work: ArtifactWork,
  stage: string,
) {
  const rows = artifactJobRows(f, work.key.publisher.jobId);
  expect(rows.observations).toEqual([
    expect.objectContaining({
      reference_id: work.key.referenceId,
      candidate_id: work.candidate?.candidateId ?? null,
      code: "io_failure",
      stage,
    }),
  ]);
  expect(activeWork(f, work.key).observations).toEqual([
    {
      code: "io_failure",
      stage,
      ...(work.candidate ? { candidateId: work.candidate.candidateId } : {}),
    },
  ]);
}

describe("artifact real deferred FK COMMIT faults", () => {
  it("rolls back acquisition at COMMIT and publishes with a fresh ref from the same publisher after fault removal", async () => {
    const f = await fixture();
    const fault = installArtifactCommitFault(f, "acquire");
    // Installing the mature helper reopens the store before any publisher/ref.
    const attempt = await f.claim(
      submission(await sourceImage(), "acquire-commit"),
    );
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const original = f.storage.store.acquireArtifactWork.bind(f.storage.store);
    const trace = traceArtifactCommit(original, () =>
      artifactJobRows(f, attempt.identity.jobId),
    );
    f.storage.store.acquireArtifactWork = trace.invoke;
    const before = artifactJobRows(f, attempt.identity.jobId);
    assertQualifiedArtifactAttempt(before);
    expectCurrentIncarnation(before, fault.incarnationId);
    fault.setEnabled(true);
    await expect(f.settle(attempt)).resolves.toBe("blocked");
    expect(trace.calls).toHaveLength(1);
    expectCommitError(trace.calls[0]);
    expect(trace.calls[0]?.args).toEqual([attempt.identity, "run"]);
    expect(trace.calls[0]?.facts).toEqual(before);
    expect(artifactJobRows(f, attempt.identity.jobId)).toEqual(before);
    expect(before.references).toEqual([]);
    expect(before.candidates).toEqual([]);
    expect(before.observations).toEqual([]);
    expect(f.events).toEqual([]);
    expect(fault.rolledBackFaultRows()).toEqual([]);

    fault.setEnabled(false);
    const gate = f.gate(
      (event) =>
        event.stage === "directory_sync" && event.path === f.storage.directory,
    );
    const pending = f.settle(attempt);
    await reachedBeforeSettled(gate, pending);
    const work = f.currentWork();
    assert.ok(work.candidate);
    await assertCandidateFiles(work.candidate, png);
    expect(work.key.publisher).toEqual(attempt.identity);
    expectCurrentIncarnation(
      artifactJobRows(f, attempt.identity.jobId),
      fault.incarnationId,
    );
    gate.release();
    await expect(pending).resolves.toBe("succeeded");
    expect(trace.calls).toHaveLength(2);
    expect(trace.calls[1]?.error).toBeUndefined();
    expect(trace.calls[1]?.result?.key).toEqual(work.key);
    expectCommittedSuccess(f, work);
  });

  it("rolls back reserve intent and ref association at COMMIT then reserves with the same publisher and ref", async () => {
    const f = await fixture();
    const fault = installArtifactCommitFault(f, "reserve");
    const attempt = await f.claim(
      submission(await sourceImage(), "reserve-commit"),
    );
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const original = f.storage.store.reserveArtifactCandidate.bind(
      f.storage.store,
    );
    const trace = traceArtifactCommit(original, (key) => ({
      rows: artifactJobRows(f, attempt.identity.jobId),
      work: activeWork(f, key),
    }));
    f.storage.store.reserveArtifactCandidate = trace.invoke;
    fault.setEnabled(true);
    await expect(f.settle(attempt)).resolves.toBe("blocked");
    expect(trace.calls).toHaveLength(1);
    const call = trace.calls[0];
    expectCommitError(call);
    assert.ok(call);
    const [key, metadata] = call.args;
    expect(key.publisher).toEqual(attempt.identity);
    assertQualifiedArtifactAttempt(call.facts.rows);
    expectCurrentIncarnation(call.facts.rows, fault.incarnationId);
    expect(call.facts.work.candidate).toBeNull();
    expect(metadata).toEqual({
      format: "png",
      width:
        attempt.job.engineInput.width * attempt.job.plan.engine.nativeScale,
      height:
        attempt.job.engineInput.height * attempt.job.plan.engine.nativeScale,
      sha256: sha256(png),
      byteLength: png.length,
    });
    const rows = artifactJobRows(f, attempt.identity.jobId);
    assertQualifiedArtifactAttempt(rows);
    expect(rows.candidates).toEqual([]);
    expect(rows.references).toEqual(call.facts.rows.references);
    expect(rows.references).toEqual([
      expect.objectContaining({
        reference_id: key.referenceId,
        candidate_id: null,
        released_at: null,
      }),
    ]);
    expectCommitObservation(f, call.facts.work, "reserve_commit");
    expect(
      f.events.filter(
        (item) =>
          item.event.stage === "mkdir" ||
          item.event.flags === "wx" ||
          item.event.stage === "rename",
      ),
    ).toEqual([]);
    expect(fault.rolledBackFaultRows()).toEqual([]);

    fault.setEnabled(false);
    const candidate = original(key, metadata);
    assert.ok(candidate);
    const work = activeWork(f, key);
    expect(work.key).toEqual(key);
    expect(work.candidate?.candidateId).toBe(candidate.candidateId);
    assertIntentAndReference(artifactJobRows(f, attempt.identity.jobId), work);
    expect(work.candidate?.manifest.png).toEqual(metadata);
    // This positive control proves the exact reserve transaction, without
    // inventing file durability or resuming an existing intent as a writer.
    expect(artifactJobRows(f, attempt.identity.jobId).references).toHaveLength(
      1,
    );
  });

  it("keeps both flushed finals as intent after durable COMMIT failure then commits the same candidate", async () => {
    const f = await fixture();
    const fault = installArtifactCommitFault(f, "durable");
    const attempt = await f.claim(
      submission(await sourceImage(), "durable-commit"),
    );
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const original = f.storage.store.recordArtifactCandidate.bind(
      f.storage.store,
    );
    const trace = traceArtifactCommit(original, (key) => ({
      rows: artifactJobRows(f, attempt.identity.jobId),
      work: activeWork(f, key),
    }));
    f.storage.store.recordArtifactCandidate = trace.invoke;
    fault.setEnabled(true);
    const gate = f.gate(
      (event) =>
        event.stage === "directory_sync" && event.path === f.storage.directory,
    );
    const pending = f.settle(attempt);
    await reachedBeforeSettled(gate, pending);
    const work = f.currentWork();
    assert.ok(work.candidate);
    await assertCandidateFiles(work.candidate, png);
    const before = artifactJobRows(f, attempt.identity.jobId);
    assertIntentAndReference(before, work);
    expectCurrentIncarnation(before, fault.incarnationId);
    gate.release();
    await expect(pending).resolves.toBe("blocked");
    expect(trace.calls).toHaveLength(1);
    const call = trace.calls[0];
    expectCommitError(call);
    assert.ok(call);
    expect(call.args).toEqual([work.key, work.candidate.candidateId]);
    expect(call.facts.rows).toEqual(before);
    const after = artifactJobRows(f, attempt.identity.jobId);
    assertIntentAndReference(after, work);
    expect(after.candidates).toEqual(before.candidates);
    expect(after.references).toEqual(before.references);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.slot).toEqual(before.slot);
    expectCommitObservation(f, work, "candidate_commit");
    expect(fault.rolledBackFaultRows()).toEqual([]);
    await assertCandidateFiles(work.candidate, png);

    fault.setEnabled(false);
    expect(original(work.key, work.candidate.candidateId)).toBe(true);
    const durable = activeWork(f, work.key);
    expect(durable.candidate).toMatchObject({
      candidateId: work.candidate.candidateId,
      state: "durable",
    });
    expect(
      artifactJobRows(f, attempt.identity.jobId).candidates[0]?.durable_at,
    ).toBe(f.storage.clock());
    expect(
      f.storage.store.finishSucceeded(work.key, work.candidate.candidateId),
    ).toBe(true);
    expectCommittedSuccess(f, durable);
  });

  it("rolls back success result slot and ref consumption together then publishes the same durable candidate", async () => {
    const f = await fixture();
    const fault = installArtifactCommitFault(f, "success");
    const attempt = await f.claim(
      submission(await sourceImage(), "success-commit"),
    );
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const original = f.storage.store.finishSucceeded.bind(f.storage.store);
    const trace = traceArtifactCommit(original, (key) => ({
      rows: artifactJobRows(f, attempt.identity.jobId),
      work: activeWork(f, key),
    }));
    f.storage.store.finishSucceeded = trace.invoke;
    fault.setEnabled(true);
    await expect(f.settle(attempt)).resolves.toBe("blocked");
    expect(trace.calls).toHaveLength(1);
    const call = trace.calls[0];
    expectCommitError(call);
    assert.ok(call);
    const { work } = call.facts;
    assert.ok(work.candidate);
    assertQualifiedArtifactAttempt(call.facts.rows);
    expectCurrentIncarnation(call.facts.rows, fault.incarnationId);
    expect(work.key.publisher).toEqual(attempt.identity);
    expect(work.candidate.state).toBe("durable");
    await assertCandidateFiles(work.candidate, png);
    const after = artifactJobRows(f, attempt.identity.jobId);
    expect(after.jobs).toEqual(call.facts.rows.jobs);
    expect(after.slot).toEqual(call.facts.rows.slot);
    expect(after.references).toEqual(call.facts.rows.references);
    expect(after.candidates).toEqual(call.facts.rows.candidates);
    expect(after.references[0]?.released_at).toBeNull();
    expect(after.candidates[0]?.state).toBe("durable");
    expectCommitObservation(f, work, "success_commit");
    expect(fault.rolledBackFaultRows()).toEqual([]);

    fault.setEnabled(false);
    expect(original(work.key, work.candidate.candidateId)).toBe(true);
    expectCommittedSuccess(f, work);
    await assertCandidateFiles(work.candidate, png);
  });

  it("retains a real current output_invalid observation after terminal COMMIT failure and rejects foreign publishers and refs", async () => {
    const f = await fixture();
    const fault = installArtifactCommitFault(f, "invalid_output");
    const control = await publishedArtifactControl(
      f,
      "invalid-commit-foreign-source",
    );
    const controlRows = artifactJobRows(f, control.attempt.identity.jobId);
    const attempt = await f.claim(
      submission(await sourceImage(), "invalid-output-commit"),
    );
    await f.complete(
      attempt,
      Buffer.from("controlled invalid PNG bytes", "utf8"),
    );
    const original = f.storage.store.finishFailed.bind(f.storage.store);
    const trace = traceArtifactCommit(original, (_publisher, key) => ({
      rows: artifactJobRows(f, attempt.identity.jobId),
      work: key ? activeWork(f, key) : undefined,
    }));
    f.storage.store.finishFailed = trace.invoke;
    fault.setEnabled(true);
    await expect(f.settle(attempt)).resolves.toBe("blocked");
    expect(trace.calls).toHaveLength(1);
    const call = trace.calls[0];
    expectCommitError(call);
    assert.ok(call?.facts.work);
    const work = call.facts.work;
    expect(call.args).toEqual([attempt.identity, work.key]);
    assertQualifiedArtifactAttempt(call.facts.rows);
    expectCurrentIncarnation(call.facts.rows, fault.incarnationId);
    expect(work.candidate).toBeNull();
    expect(work.observations).toEqual([{ code: "output_invalid" }]);
    expect(call.facts.rows.observations).toEqual([
      expect.objectContaining({
        reference_id: work.key.referenceId,
        candidate_id: null,
        code: "output_invalid",
        stage: null,
      }),
    ]);
    expect(artifactJobRows(f, attempt.identity.jobId)).toEqual(call.facts.rows);
    expect(fault.rolledBackFaultRows()).toEqual([]);
    const beforeForeign = f.rows();
    const foreignKeys = [
      {
        publisher: attempt.identity,
        referenceId: control.work.key.referenceId,
      },
      {
        publisher: control.attempt.identity,
        referenceId: work.key.referenceId,
      },
    ];
    const observation = work.observations[0];
    assert.ok(observation);
    for (const key of foreignKeys) {
      expect(f.storage.store.readArtifactWork(key)).toEqual({
        kind: "retired",
      });
      expect(original(attempt.identity, key)).toBe(false);
      expect(f.storage.store.recordArtifactObservation(key, observation)).toBe(
        false,
      );
    }
    expect(original(control.attempt.identity, work.key)).toBe(false);
    expect(original(attempt.identity, control.work.key)).toBe(false);
    expect(f.rows()).toEqual(beforeForeign);

    fault.setEnabled(false);
    expect(original(attempt.identity, work.key)).toBe(true);
    const after = artifactJobRows(f, attempt.identity.jobId);
    expect(after.jobs).toEqual([
      expect.objectContaining({
        status: "failed",
        reason: "invalid_output",
        completed_at: f.storage.clock(),
        result_candidate_id: null,
      }),
    ]);
    expect(after.slot).toEqual([]);
    expect(after.references[0]?.released_at).toBe(f.storage.clock());
    expect(after.observations).toEqual(call.facts.rows.observations);
    expect(after.candidates).toEqual([]);
    expect(after.attempts).toHaveLength(1);
    expect(artifactJobRows(f, control.attempt.identity.jobId)).toEqual(
      controlRows,
    );
    await assertCandidateFiles(control.work.candidate!, control.png);
  });

  it("requires output_invalid on the finishing ref while retaining readable history from the same source", async () => {
    const f = await fixture();
    const fault = installArtifactCommitFault(f, "invalid_output");
    const attempt = await f.claim(
      submission(await sourceImage(), "invalid-output-ref-authority"),
    );
    await f.complete(
      attempt,
      Buffer.from("controlled invalid PNG bytes", "utf8"),
    );
    const original = f.storage.store.finishFailed.bind(f.storage.store);
    const trace = traceArtifactCommit(original, (_publisher, key) => ({
      rows: artifactJobRows(f, attempt.identity.jobId),
      work: key ? activeWork(f, key) : undefined,
    }));
    f.storage.store.finishFailed = trace.invoke;
    fault.setEnabled(true);
    await expect(f.settle(attempt)).resolves.toBe("blocked");
    expect(trace.calls).toHaveLength(1);
    const call = trace.calls[0];
    expectCommitError(call);
    assert.ok(call?.facts.work);
    const oldWork = call.facts.work;
    expect(call.args).toEqual([attempt.identity, oldWork.key]);
    assertQualifiedArtifactAttempt(call.facts.rows);
    expectCurrentIncarnation(call.facts.rows, fault.incarnationId);
    expect(oldWork.candidate).toBeNull();
    expect(oldWork.observations).toEqual([{ code: "output_invalid" }]);
    expect(call.facts.rows.references).toEqual([
      expect.objectContaining({
        reference_id: oldWork.key.referenceId,
        candidate_id: null,
        released_at: null,
      }),
    ]);
    expect(call.facts.rows.observations).toEqual([
      expect.objectContaining({
        reference_id: oldWork.key.referenceId,
        candidate_id: null,
        code: "output_invalid",
        stage: null,
      }),
    ]);
    expect(artifactJobRows(f, attempt.identity.jobId)).toEqual(call.facts.rows);
    expect(fault.rolledBackFaultRows()).toEqual([]);

    fault.setEnabled(false);
    const newWork = f.storage.store.acquireArtifactWork(
      attempt.identity,
      "run",
    );
    assert.ok(newWork);
    expect(newWork.key.publisher).toEqual(attempt.identity);
    expect(newWork.key.referenceId).not.toBe(oldWork.key.referenceId);
    expect(newWork.candidate).toBeNull();
    expect(newWork.attempt).toEqual(oldWork.attempt);
    expect(newWork.enginePath).toBe(oldWork.enginePath);
    expect(newWork.outputPath).toBe(oldWork.outputPath);
    const beforeBorrowedFailure = artifactJobRows(f, attempt.identity.jobId);
    assertQualifiedArtifactAttempt(beforeBorrowedFailure);
    expect(beforeBorrowedFailure.references).toHaveLength(2);
    expect(beforeBorrowedFailure.references[0]).toEqual(
      call.facts.rows.references[0],
    );
    expect(beforeBorrowedFailure.references[1]).toMatchObject({
      reference_id: newWork.key.referenceId,
      candidate_id: null,
      released_at: null,
    });
    expect(beforeBorrowedFailure.observations).toEqual(
      call.facts.rows.observations,
    );
    expect(
      beforeBorrowedFailure.observations.filter(
        (row) => row.reference_id === newWork.key.referenceId,
      ),
    ).toEqual([]);
    // 同源历史仍可读取，但不能借给尚未记录诊断的新 ref 授予终态权限。
    expect(activeWork(f, newWork.key).observations).toEqual(
      oldWork.observations,
    );
    expect(original(attempt.identity, newWork.key)).toBe(false);
    expect(artifactJobRows(f, attempt.identity.jobId)).toEqual(
      beforeBorrowedFailure,
    );

    expect(
      f.storage.store.recordArtifactObservation(newWork.key, {
        code: "output_invalid",
      }),
    ).toBe(true);
    const diagnosed = artifactJobRows(f, attempt.identity.jobId);
    expect(diagnosed.observations).toEqual([
      ...beforeBorrowedFailure.observations,
      expect.objectContaining({
        reference_id: newWork.key.referenceId,
        candidate_id: null,
        code: "output_invalid",
        stage: null,
      }),
    ]);
    expect({
      ...diagnosed,
      observations: beforeBorrowedFailure.observations,
    }).toEqual(beforeBorrowedFailure);
    expect(original(attempt.identity, newWork.key)).toBe(true);
    const after = artifactJobRows(f, attempt.identity.jobId);
    expect(after.jobs).toEqual(
      diagnosed.jobs.map((row) => ({
        ...row,
        status: "failed",
        reason: "invalid_output",
        completed_at: f.storage.clock(),
      })),
    );
    expect(after.slot).toEqual([]);
    expect(after.references).toEqual(
      diagnosed.references.map((row) =>
        row.reference_id === newWork.key.referenceId
          ? { ...row, released_at: f.storage.clock() }
          : row,
      ),
    );
    expect(after.observations).toEqual(diagnosed.observations);
    expect(after.candidates).toEqual([]);
    expect(after.attempts).toEqual(call.facts.rows.attempts);
    expect(f.job(attempt.identity.jobId).result).toBeNull();
  });

  it("rejects candidate and reference IDs from another real job without changing either source", async () => {
    const f = await fixture();
    const control = await publishedArtifactControl(
      f,
      "foreign-candidate-source",
    );
    assert.ok(control.work.candidate);
    const controlRows = artifactJobRows(f, control.attempt.identity.jobId);
    const attempt = await f.claim(
      submission(await sourceImage(), "foreign-candidate-target"),
    );
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
    assertIntentAndReference(artifactJobRows(f, attempt.identity.jobId), work);
    const before = f.rows();
    expect(
      f.storage.store.recordArtifactCandidate(
        work.key,
        control.work.candidate.candidateId,
      ),
    ).toBe(false);
    expect(
      f.storage.store.finishSucceeded(
        work.key,
        control.work.candidate.candidateId,
      ),
    ).toBe(false);
    const foreignKeys = [
      {
        publisher: attempt.identity,
        referenceId: control.work.key.referenceId,
      },
      {
        publisher: control.attempt.identity,
        referenceId: work.key.referenceId,
      },
    ];
    for (const key of foreignKeys) {
      expect(f.storage.store.readArtifactWork(key)).toEqual({
        kind: "retired",
      });
      expect(
        f.storage.store.reserveArtifactCandidate(
          key,
          work.candidate.manifest.png,
        ),
      ).toBeUndefined();
      expect(
        f.storage.store.recordArtifactCandidate(
          key,
          work.candidate.candidateId,
        ),
      ).toBe(false);
      expect(
        f.storage.store.finishSucceeded(key, work.candidate.candidateId),
      ).toBe(false);
      expect(f.storage.store.finishFailed(attempt.identity, key)).toBe(false);
      expect(f.storage.store.releaseArtifactReference(key)).toBe(false);
      expect(
        f.storage.store.recordArtifactObservation(key, {
          code: "candidate_integrity",
          candidateId: work.candidate.candidateId,
        }),
      ).toBe(false);
    }
    expect(f.rows()).toEqual(before);
    gate.release();
    await expect(pending).resolves.toBe("succeeded");
    expectCommittedSuccess(f, work);
    expect(artifactJobRows(f, control.attempt.identity.jobId)).toEqual(
      controlRows,
    );
    await assertCandidateFiles(control.work.candidate, control.png);
  });
});
