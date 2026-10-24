import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  nativePng,
  reachedBeforeSettled,
  writeActualFile,
} from "./artifact-fixtures.js";
import {
  artifactJobRows,
  assertCandidateFiles,
  installArtifactCommitFault,
} from "./artifact-fault-fixtures.js";
import {
  artifactRecoveryFixture,
  artifactSourceFacts,
  candidateFromWork,
  changedArtifactBytes,
  completedEvents,
  readWorksWith,
  writableEvents,
  type ArtifactRecoveryFixture,
} from "./artifact-recovery-fixtures.js";
import { sourceImage, submission } from "./storage-fixtures.js";

const fixtures: ArtifactRecoveryFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});
async function fixture() {
  const f = await artifactRecoveryFixture();
  fixtures.push(f);
  return f;
}

describe("published artifact facts after a lost success acknowledgement", () => {
  it.each(["intact", "candidate_mismatch", "engine_io"] as const)(
    "queries the committed success and revalidates a dedicated published ref for %s",
    async (mode) => {
      const f = await fixture();
      const attempt = await f.claim();
      const png = await nativePng(attempt);
      await f.complete(attempt, png);
      const source = artifactSourceFacts(f, attempt.identity.jobId);
      const trace = f.trace();
      let lost = false;
      let ioFaultReached = false;
      trace.hooks.afterSucceeded = () => {
        assert.equal(lost, false, "success may COMMIT only once");
        lost = true;
        throw new Error("controlled success acknowledgement loss");
      };
      const gate = f.gate(
        (event) => lost && event.stage === "stat" && event.role === "engine",
      );
      const pending = f.settle(attempt);
      const opened = await reachedBeforeSettled(gate, pending);
      assert.ok(opened.file);
      expect((await opened.file.stat()).isFile()).toBe(true);
      expect(lost).toBe(true);
      expect(trace.successCommits).toHaveLength(1);
      const committed = trace.successCommits[0];
      assert.ok(committed?.result);
      expect(committed.rows.jobs[0]).toMatchObject({
        status: "succeeded",
        result_candidate_id: committed.candidateId,
      });
      expect(committed.rows.slot).toEqual([]);
      expect(
        committed.rows.references.find(
          (row) => row.reference_id === committed.key.referenceId,
        ),
      ).toMatchObject({ released_at: f.storage.clock() });
      const acquisitions = trace.acquisition.calls;
      expect(acquisitions).toHaveLength(2);
      expect(acquisitions[0]?.args).toEqual([attempt.identity, "run"]);
      expect(acquisitions[1]?.args).toEqual([attempt.identity, "recovery"]);
      const published = acquisitions[1]?.result;
      assert.ok(published);
      const candidate = candidateFromWork(published);
      expect(published).toMatchObject({
        purpose: "recovery",
        access: "published",
      });
      expect(published.key.referenceId).not.toBe(committed.key.referenceId);
      expect(candidate.candidateId).toBe(committed.candidateId);
      expect(candidate.state).toBe("durable");
      expect(candidate.manifest.producer).toEqual({
        identity: attempt.identity,
        launchTicket: attempt.launchTicket,
      });
      const query = trace.readWork.calls.find(
        ({ args, result }) =>
          args[0].referenceId === committed.key.referenceId &&
          result?.kind === "published",
      );
      assert.ok(query);
      expect(query.facts.order).toBeGreaterThan(
        trace.success.calls[0]!.facts.order,
      );
      expect(query.facts.order).toBeLessThan(acquisitions[1]!.facts.order);
      expect(query.result).toMatchObject({
        kind: "published",
        work: { candidate: { candidateId: committed.candidateId } },
      });
      const publishedRow = artifactJobRows(
        f,
        attempt.identity.jobId,
      ).references.find(
        (row) => row.reference_id === published.key.referenceId,
      );
      expect(publishedRow).toMatchObject({
        purpose: "recovery",
        candidate_id: candidate.candidateId,
        released_at: null,
      });
      expect(
        artifactJobRows(f, attempt.identity.jobId).observations,
      ).toContainEqual(
        expect.objectContaining({
          reference_id: published.key.referenceId,
          candidate_id: candidate.candidateId,
          code: "publication_unknown",
        }),
      );
      expect(
        readWorksWith(f, published.key.referenceId, "publication_unknown"),
      ).not.toEqual([]);
      const originalResult = f.job(attempt.identity.jobId);
      expect(originalResult).toMatchObject({
        status: "succeeded",
        reason: null,
        result: candidate.manifest.png,
      });
      await assertCandidateFiles(candidate, png);
      // The dedicated recovery ref is still held here. Rejection must follow
      // published access, rather than accidentally following an already-ended ref.
      const beforeDeniedWrites = f.rows();
      expect(
        f.storage.store.reserveArtifactCandidate(
          published.key,
          candidate.manifest.png,
        ),
      ).toBeUndefined();
      expect(
        f.storage.store.recordArtifactCandidate(
          published.key,
          candidate.candidateId,
        ),
      ).toBe(false);
      expect(
        f.storage.store.finishSucceeded(published.key, candidate.candidateId),
      ).toBe(false);
      expect(
        f.storage.store.recordArtifactObservation(committed.key, {
          code: "publication_unknown",
          candidateId: candidate.candidateId,
        }),
      ).toBe(false);
      expect(f.rows()).toEqual(beforeDeniedWrites);
      if (mode === "candidate_mismatch")
        await writeActualFile(
          candidate.pngPath,
          changedArtifactBytes(png),
          false,
        );
      if (mode === "engine_io") {
        // stat has really completed on this descriptor. Closing that exact
        // descriptor makes the next real read fail with EBADF; no read stub.
        await opened.file.close();
        await expect(opened.file.stat()).rejects.toMatchObject({
          code: "EBADF",
        });
        ioFaultReached = true;
      }
      gate.release();
      await expect(pending).resolves.toBe(
        mode === "intact" ? "succeeded" : "blocked",
      );
      expect(ioFaultReached).toBe(mode === "engine_io");
      expect(f.job(attempt.identity.jobId)).toEqual(originalResult);
      expect(artifactSourceFacts(f, attempt.identity.jobId)).toEqual(source);
      expect(f.executor.prepareCalls).toEqual([attempt]);
      expect(f.executor.authorizeCalls).toEqual([attempt]);
      expect(f.executor.launchCalls).toEqual([attempt]);
      const rows = artifactJobRows(f, attempt.identity.jobId);
      expect(rows.attempts).toHaveLength(1);
      expect(rows.candidates).toHaveLength(1);
      expect(rows.slot).toEqual([]);
      expect(
        rows.references.find(
          (row) => row.reference_id === published.key.referenceId,
        ),
      ).toMatchObject({ released_at: f.storage.clock() });
      expect(trace.release.calls).toHaveLength(1);
      expect(trace.release.calls[0]).toMatchObject({
        args: [published.key],
        result: true,
      });
      const revalidationStart = acquisitions[1]!.facts.fileEventIndex;
      expect(writableEvents(f, revalidationStart)).toEqual([]);
      expect(
        f.events
          .slice(revalidationStart)
          .filter(({ event }) => event.stage === "open" && event.flags !== "r"),
      ).toEqual([]);
      expect(
        f.events
          .slice(revalidationStart)
          .filter(
            ({ event }) =>
              event.role === "raw-output" ||
              event.stage === "file_sync" ||
              event.stage === "directory_sync",
          ),
      ).toEqual([]);
      const completed = completedEvents(f, revalidationStart);
      expect(
        completed.some(
          ({ event }) =>
            event.stage === "close" && event.path === attempt.inputPath,
        ),
      ).toBe(true);
      if (mode !== "engine_io") {
        for (const path of [candidate.manifestPath, candidate.pngPath]) {
          expect(
            completed.some(
              ({ event }) =>
                event.stage === "read" &&
                event.path === path &&
                (event.bytesRead ?? 0) > 0,
            ),
          ).toBe(true);
          expect(
            completed.some(
              ({ event }) => event.stage === "close" && event.path === path,
            ),
          ).toBe(true);
        }
      }
      const expectedDiagnostic =
        mode === "candidate_mismatch"
          ? { code: "candidate_integrity", candidateId: candidate.candidateId }
          : {
              code: "io_failure",
              stage: "read",
              candidateId: candidate.candidateId,
            };
      if (mode === "intact") {
        expect(rows.observations).toHaveLength(1);
      } else {
        expect(rows.observations).toContainEqual(
          expect.objectContaining({
            reference_id: published.key.referenceId,
            candidate_id: candidate.candidateId,
            code: expectedDiagnostic.code,
            ...(mode === "engine_io" ? { stage: "read" } : {}),
          }),
        );
        expect(
          readWorksWith(f, published.key.referenceId, expectedDiagnostic.code),
        ).not.toEqual([]);
        const next = f.storage.store.acquireArtifactWork(
          attempt.identity,
          "recovery",
        );
        assert.ok(next);
        expect(next.access).toBe("published");
        expect(next.key.referenceId).not.toBe(published.key.referenceId);
        expect(next.candidate?.candidateId).toBe(candidate.candidateId);
        expect(next.observations).toContainEqual(
          expect.objectContaining(expectedDiagnostic),
        );
        expect(f.storage.store.readArtifactWork(next.key)).toMatchObject({
          kind: "published",
          work: {
            observations: expect.arrayContaining([
              expect.objectContaining(expectedDiagnostic),
            ]),
          },
        });
        expect(f.storage.store.releaseArtifactReference(next.key)).toBe(true);
      }
      expect(trace.successCommits.filter((call) => call.result)).toHaveLength(
        1,
      );
      expect(await readFile(attempt.outputPath)).toEqual(png);
      f.reopen();
      expect(f.job(attempt.identity.jobId)).toEqual(originalResult);
      expect(
        f.storage.store.requestCancel(
          f.storage.principal(),
          attempt.identity.jobId,
        ),
      ).toMatchObject({ status: 200, applied: false, job: originalResult });
    },
  );

  it("keeps a published ref when publication-unknown observation COMMIT rolls back and verifies a later fault-free consumer", async () => {
    const f = await fixture();
    const fault = installArtifactCommitFault(f, "observation");
    const first = await f.claim(
      submission(await sourceImage(), "publication-observation-commit-fault"),
    );
    const png = await nativePng(first);
    await f.complete(first, png);
    const trace = f.trace();
    let lost = 0;
    trace.hooks.afterSucceeded = () => {
      lost += 1;
      if (lost === 1) fault.setEnabled(true);
      throw new Error(
        "controlled success acknowledgement loss around observation COMMIT",
      );
    };
    await expect(f.settle(first)).resolves.toBe("blocked");
    expect(lost).toBe(1);
    const originalResult = f.job(first.identity.jobId);
    expect(originalResult.status).toBe("succeeded");
    expect(originalResult.result).not.toBeNull();
    const published = trace.acquisition.calls.find(
      ({ result }) => result?.access === "published",
    )?.result;
    assert.ok(published);
    const candidate = candidateFromWork(published);
    await assertCandidateFiles(candidate, png);
    expect(trace.successCommits).toEqual([
      expect.objectContaining({
        result: true,
        candidateId: candidate.candidateId,
      }),
    ]);
    expect(trace.observation.calls).toHaveLength(1);
    const failed = trace.observation.calls[0];
    expect(failed?.args).toEqual([
      published.key,
      expect.objectContaining({
        code: "publication_unknown",
        candidateId: candidate.candidateId,
      }),
    ]);
    expect(failed?.error).toMatchObject({ code: "internal_error" });
    expect(failed?.result).toBeUndefined();
    const firstRows = artifactJobRows(f, first.identity.jobId);
    expect(firstRows.slot).toEqual([]);
    expect(firstRows.observations).toEqual([]);
    expect(
      firstRows.references.find(
        (row) => row.reference_id === published.key.referenceId,
      ),
    ).toMatchObject({
      released_at: null,
      candidate_id: candidate.candidateId,
      purpose: "recovery",
    });
    expect(
      readWorksWith(f, published.key.referenceId, "publication_unknown"),
    ).toEqual([]);
    expect(trace.release.calls).toEqual([]);
    expect(fault.rolledBackFaultRows()).toEqual([]);
    fault.setEnabled(false);
    const control = await f.claim(
      submission(
        await sourceImage("blue"),
        "publication-observation-positive-control",
      ),
    );
    const controlPng = await nativePng(control);
    await f.complete(control, controlPng);
    const startAcquisition = trace.acquisition.calls.length;
    const gate = f.gate(
      (event) =>
        lost === 2 &&
        event.stage === "open" &&
        event.role === "engine" &&
        event.flags === "r",
    );
    const pending = f.settle(control);
    await reachedBeforeSettled(gate, pending);
    expect(lost).toBe(2);
    const controlPublished = trace.acquisition.calls
      .slice(startAcquisition)
      .find(({ result }) => result?.access === "published")?.result;
    assert.ok(controlPublished);
    const controlCandidate = candidateFromWork(controlPublished);
    expect(controlPublished.key.referenceId).not.toBe(
      published.key.referenceId,
    );
    expect(controlCandidate.candidateId).not.toBe(candidate.candidateId);
    expect(
      artifactJobRows(f, control.identity.jobId).observations,
    ).toContainEqual(
      expect.objectContaining({
        reference_id: controlPublished.key.referenceId,
        candidate_id: controlCandidate.candidateId,
        code: "publication_unknown",
      }),
    );
    expect(
      readWorksWith(f, controlPublished.key.referenceId, "publication_unknown"),
    ).not.toEqual([]);
    expect(artifactJobRows(f, first.identity.jobId)).toEqual(firstRows);
    gate.release();
    await expect(pending).resolves.toBe("succeeded");
    expect(trace.observation.calls).toHaveLength(2);
    expect(trace.observation.calls[1]).toMatchObject({ result: true });
    expect(trace.release.calls).toEqual([
      expect.objectContaining({ args: [controlPublished.key], result: true }),
    ]);
    expect(
      artifactJobRows(f, control.identity.jobId).references.find(
        (row) => row.reference_id === controlPublished.key.referenceId,
      ),
    ).toMatchObject({ released_at: f.storage.clock() });
    expect(artifactJobRows(f, first.identity.jobId)).toEqual(firstRows);
    expect(f.job(first.identity.jobId)).toEqual(originalResult);
    await assertCandidateFiles(controlCandidate, controlPng);
  });
});
