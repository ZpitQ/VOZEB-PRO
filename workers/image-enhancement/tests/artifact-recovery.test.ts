import assert from "node:assert/strict";
import { readFile, rename, stat, unlink } from "node:fs/promises";
import { sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactWork, ArtifactWorkKey } from "../src/artifacts.js";
import type { ClaimedAttempt } from "../src/execution.js";
import {
  nativePng,
  reachedBeforeSettled,
  writeActualFile,
} from "./artifact-fixtures.js";
import {
  artifactJobRows,
  assertCandidateFiles,
  assertQualifiedArtifactAttempt,
  installArtifactCommitFault,
  trustedArtifactAncestors,
} from "./artifact-fault-fixtures.js";
import {
  artifactRecoveryFixture,
  artifactSourceFacts,
  candidateDirectoryBytes,
  candidateFromWork,
  changedArtifactBytes,
  completedEvents,
  readWorksWith,
  transferArtifactPublisher,
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
function expectSourceUnchanged(
  f: ArtifactRecoveryFixture,
  attempt: ClaimedAttempt,
  before: ReturnType<typeof artifactSourceFacts>,
) {
  expect(artifactSourceFacts(f, attempt.identity.jobId)).toEqual(before);
  expect(f.executor.prepareCalls).toEqual([attempt]);
  expect(f.executor.authorizeCalls).toEqual([attempt]);
  expect(f.executor.launchCalls).toEqual([attempt]);
}
function expectPublished(f: ArtifactRecoveryFixture, work: ArtifactWork) {
  const candidate = candidateFromWork(work);
  const rows = artifactJobRows(f, work.key.publisher.jobId);
  expect(rows.jobs).toEqual([
    expect.objectContaining({
      status: "succeeded",
      reason: null,
      completed_at: f.storage.clock(),
      result_candidate_id: candidate.candidateId,
    }),
  ]);
  expect(
    rows.candidates.find((row) => row.candidate_id === candidate.candidateId),
  ).toMatchObject({ state: "durable" });
  expect(rows.slot).toEqual([]);
  expect(rows.attempts).toHaveLength(1);
  expect(f.job(work.key.publisher.jobId).result).toEqual(
    candidate.manifest.png,
  );
  expect(
    rows.references.find((row) => row.reference_id === work.key.referenceId),
  ).toMatchObject({ released_at: f.storage.clock() });
}
function expectReferenceHeld(f: ArtifactRecoveryFixture, key: ArtifactWorkKey) {
  expect(
    artifactJobRows(f, key.publisher.jobId).references.find(
      (row) => row.reference_id === key.referenceId,
    ),
  ).toMatchObject({ released_at: null });
}
function expectReadOnlyCandidateRecovery(
  f: ArtifactRecoveryFixture,
  start: number,
) {
  expect(writableEvents(f, start)).toEqual([]);
  expect(
    f.events.slice(start).filter(({ event }) => event.role === "raw-output"),
  ).toEqual([]);
}

async function holdEngineOpen(f: ArtifactRecoveryFixture, key: string) {
  const attempt = await f.claim(submission(await sourceImage(), key));
  const png = await nativePng(attempt);
  await f.complete(attempt, png);
  const gate = f.gate(
    (event) =>
      event.stage === "open" && event.role === "engine" && event.flags === "r",
  );
  const pending = f.settle(attempt);
  const opened = await reachedBeforeSettled(gate, pending);
  assert.ok(opened.file);
  expect((await opened.file.stat()).isFile()).toBe(true);
  const work = f.currentWork();
  expectReferenceHeld(f, work.key);
  return { attempt, png, gate, pending, opened, work };
}
function commitCancellation(
  f: ArtifactRecoveryFixture,
  attempt: ClaimedAttempt,
) {
  expect(
    f.storage.store.requestCancel(
      f.storage.principal(),
      attempt.identity.jobId,
    ),
  ).toMatchObject({ status: 202, applied: true });
  expect(f.storage.store.finishCancelled(attempt.identity)).toBe(true);
  expect(f.job(attempt.identity.jobId)).toMatchObject({
    status: "cancelled",
    reason: "user_cancel",
    result: null,
  });
  expect(artifactJobRows(f, attempt.identity.jobId).slot).toEqual([]);
}

async function recoverableIntent(f: ArtifactRecoveryFixture) {
  const attempt = await f.claim();
  const png = await nativePng(attempt);
  await f.complete(attempt, png);
  const source = artifactSourceFacts(f, attempt.identity.jobId);
  const gate = f.gate(
    (event) =>
      event.stage === "directory_sync" && event.path === f.storage.directory,
  );
  const pending = f.settle(attempt);
  await reachedBeforeSettled(gate, pending);
  const original = f.currentWork();
  const candidate = candidateFromWork(original);
  await assertCandidateFiles(candidate, png);
  expect(
    artifactJobRows(f, attempt.identity.jobId).candidates[0],
  ).toMatchObject({ state: "intent", durable_at: null });
  f.reopen();
  gate.release();
  await expect(pending).resolves.toBe("stale");
  const publisher = await transferArtifactPublisher(f, attempt);
  return { attempt, png, source, original, candidate, publisher };
}

describe("same-source artifact recovery", () => {
  it("recovers a half intent into a new storage root without executing again", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const source = artifactSourceFacts(f, attempt.identity.jobId);
    const gate = f.gate(
      (event) => event.stage === "rename" && event.role === "artifact-part",
    );
    const pending = f.settle(attempt);
    await reachedBeforeSettled(gate, pending);
    const original = f.currentWork();
    const oldCandidate = candidateFromWork(original);
    expect(await readFile(oldCandidate.pngPath)).toEqual(png);
    await expect(stat(oldCandidate.manifestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const oldBytes = await candidateDirectoryBytes(oldCandidate);
    const oldReference = artifactJobRows(f, attempt.identity.jobId)
      .references[0];
    f.reopen();
    gate.release();
    await expect(pending).resolves.toBe("stale");
    const publisher = await transferArtifactPublisher(f, attempt);
    const start = f.events.length;
    const newRoot = f.gate(
      (event) =>
        event.stage === "mkdir" && event.role === "candidate-directory",
      "before",
    );
    const recovered = f.settle(publisher, "recovery");
    await reachedBeforeSettled(newRoot, recovered);
    const work = f.currentWork();
    const candidate = candidateFromWork(work);
    expect(candidate.candidateId).not.toBe(oldCandidate.candidateId);
    expect(candidate.directory).not.toBe(oldCandidate.directory);
    expect(work.attempt.producer).toEqual(attempt.identity);
    expect(work.attempt.launchTicket).toBe(attempt.launchTicket);
    expect(candidate.manifest).toEqual(oldCandidate.manifest);
    const acquisitions = f.trace().acquisition.calls;
    expect(acquisitions).toHaveLength(2);
    const inspected = acquisitions[0]?.result;
    const fresh = acquisitions[1]?.result;
    assert.ok(inspected && fresh);
    expect(inspected.candidate?.candidateId).toBe(oldCandidate.candidateId);
    expect(inspected.key.referenceId).not.toBe(original.key.referenceId);
    expect(fresh.candidate).toBeNull();
    expect(fresh.key).toEqual(work.key);
    expect(fresh.key.referenceId).not.toBe(inspected.key.referenceId);
    const rows = artifactJobRows(f, attempt.identity.jobId);
    expect(rows.observations).toEqual([
      expect.objectContaining({
        reference_id: inspected.key.referenceId,
        candidate_id: oldCandidate.candidateId,
        code: "no_qualified_candidate",
        checked_engine_sha256: attempt.job.engineInput.sha256,
      }),
    ]);
    expect(
      readWorksWith(f, inspected.key.referenceId, "no_qualified_candidate"),
    ).not.toEqual([]);
    expect(
      rows.references.find(
        (row) => row.reference_id === inspected.key.referenceId,
      ),
    ).toMatchObject({
      candidate_id: oldCandidate.candidateId,
      released_at: f.storage.clock(),
    });
    expect(
      rows.references.find(
        (row) => row.reference_id === original.key.referenceId,
      ),
    ).toEqual(oldReference);
    expect(
      rows.references.find((row) => row.reference_id === work.key.referenceId),
    ).toMatchObject({ candidate_id: candidate.candidateId, released_at: null });
    expect(
      f.events
        .slice(start)
        .some(
          ({ event }) =>
            event.stage === "open" &&
            event.path === oldCandidate.pngPath &&
            event.flags === "r",
        ),
    ).toBe(true);
    expect(
      f.events
        .slice(start)
        .some(
          ({ event }) =>
            event.stage === "open" &&
            event.path === oldCandidate.manifestPath &&
            event.flags === "r",
        ),
    ).toBe(true);
    expect(
      completedEvents(f, start).some(
        ({ event }) =>
          event.stage === "read" &&
          event.path === attempt.inputPath &&
          (event.bytesRead ?? 0) > 0,
      ),
    ).toBe(true);
    expect(
      writableEvents(f, start).filter(
        ({ event }) =>
          event.path === oldCandidate.directory ||
          event.path.startsWith(`${oldCandidate.directory}${sep}`),
      ),
    ).toEqual([]);
    expect(
      f.events
        .slice(start)
        .filter(
          ({ event }) =>
            (event.path === oldCandidate.pngPath ||
              event.path === oldCandidate.manifestPath) &&
            (event.stage === "file_sync" ||
              (event.stage === "open" && event.flags !== "r")),
        ),
    ).toEqual([]);
    expect(await candidateDirectoryBytes(oldCandidate)).toEqual(oldBytes);
    newRoot.release();
    await expect(recovered).resolves.toBe("succeeded");
    expectPublished(f, work);
    await assertCandidateFiles(candidate, png);
    expect(await candidateDirectoryBytes(oldCandidate)).toEqual(oldBytes);
    expectReferenceHeld(f, original.key);
    expectSourceUnchanged(f, attempt, source);
    expect(artifactJobRows(f, attempt.identity.jobId).candidates).toHaveLength(
      2,
    );
  });

  it("revalidates flushed final files and publishes the same intent candidate", async () => {
    const f = await fixture();
    const { attempt, png, source, original, candidate, publisher } =
      await recoverableIntent(f);
    const start = f.events.length;
    const read = f.gate(
      (event) =>
        event.stage === "read" &&
        event.path === candidate.pngPath &&
        (event.bytesRead ?? 0) > 0,
    );
    const recovered = f.settle(publisher, "recovery");
    await reachedBeforeSettled(read, recovered);
    const work = f.currentWork();
    expect(work.candidate).toEqual(candidate);
    expectReferenceHeld(f, work.key);
    read.release();
    const verdict = await recovered;
    expect(
      f.failures.filter(({ event }) => event.stage === "file_sync"),
    ).toEqual([]);
    expect(verdict).toBe("succeeded");
    expectPublished(f, work);
    expectReadOnlyCandidateRecovery(f, start);
    const completed = completedEvents(f, start);
    for (const path of [candidate.pngPath, candidate.manifestPath]) {
      const opened = completed.filter(
        ({ event }) => event.stage === "open" && event.path === path,
      );
      expect(opened.map(({ event }) => event.flags)).toEqual(
        process.platform === "win32" ? ["r", "r+"] : ["r"],
      );
      for (const { event: handle } of opened) {
        expect(
          completed.some(
            ({ event }) =>
              event.stage === "read" &&
              event.file === handle.file &&
              (event.bytesRead ?? 0) > 0,
          ),
        ).toBe(true);
        expect(
          completed.some(
            ({ event }) =>
              event.stage === "close" && event.file === handle.file,
          ),
        ).toBe(true);
      }
      expect(
        completed
          .filter(
            ({ event }) => event.stage === "file_sync" && event.path === path,
          )
          .map(({ event }) => event.file),
      ).toEqual([opened.at(-1)!.event.file]);
    }
    expect(
      completed
        .filter(({ event }) => event.stage === "directory_sync")
        .map(({ event }) => event.path),
    ).toEqual(
      trustedArtifactAncestors(candidate.directory, f.storage.directory),
    );
    expect(artifactJobRows(f, attempt.identity.jobId).candidates).toHaveLength(
      1,
    );
    expectReferenceHeld(f, original.key);
    expectSourceUnchanged(f, attempt, source);
    await assertCandidateFiles(candidate, png);
  });

  it
    .runIf(process.platform === "win32")
    .each(["replaced PNG", "missing manifest"] as const)(
    "rejects a %s after read-only qualification without flushing it or falling back to raw output",
    async (change) => {
      const f = await fixture();
      const { attempt, png, source, original, candidate, publisher } =
        await recoverableIntent(f);
      const start = f.events.length;
      const gate = f.gate(
        (event) =>
          event.stage === "open" &&
          event.path === candidate.pngPath &&
          String(event.flags) === "r+",
        "before",
      );
      const pending = f.settle(publisher, "recovery");
      await reachedBeforeSettled(gate, pending);
      const work = f.currentWork();
      for (const path of [candidate.pngPath, candidate.manifestPath]) {
        expect(
          completedEvents(f, start)
            .filter(
              ({ event }) => event.stage === "open" && event.path === path,
            )
            .map(({ event }) => event.flags),
        ).toEqual(["r"]);
        expect(
          completedEvents(f, start).some(
            ({ event }) => event.stage === "close" && event.path === path,
          ),
        ).toBe(true);
      }
      if (change === "replaced PNG") {
        await rename(candidate.pngPath, `${candidate.pngPath}.original`);
        await writeActualFile(candidate.pngPath, changedArtifactBytes(png));
      } else await unlink(candidate.manifestPath);
      gate.release();
      await expect(pending).resolves.toBe("blocked");
      expect(f.currentWork().observations).toContainEqual({
        code: "candidate_integrity",
        candidateId: candidate.candidateId,
      });
      expect(
        f.events
          .slice(start)
          .filter(
            ({ event }) =>
              event.stage === "file_sync" || event.stage === "directory_sync",
          ),
      ).toEqual([]);
      for (const { event } of completedEvents(f, start)) {
        if (event.stage === "open")
          await expect(event.file!.stat()).rejects.toMatchObject({
            code: "EBADF",
          });
      }
      expectReadOnlyCandidateRecovery(f, start);
      expect(f.trace().reserve.calls).toEqual([]);
      expect(f.trace().durable.calls).toEqual([]);
      expect(f.trace().success.calls).toEqual([]);
      expect(
        artifactJobRows(f, attempt.identity.jobId).candidates,
      ).toHaveLength(1);
      expectReferenceHeld(f, work.key);
      expectReferenceHeld(f, original.key);
      expectSourceUnchanged(f, attempt, source);
    },
  );

  it.runIf(process.platform === "win32")(
    "closes a late write-capable validation handle before releasing a cancelled reference",
    async () => {
      const f = await fixture();
      const { attempt, candidate, publisher } = await recoverableIntent(f);
      const start = f.events.length;
      const opened = f.gate(
        (event) =>
          event.stage === "open" &&
          event.path === candidate.pngPath &&
          String(event.flags) === "r+",
      );
      const pending = f.settle(publisher, "recovery");
      const handle = await reachedBeforeSettled(opened, pending);
      const work = f.currentWork();
      const closed = f.gate(
        (event) => event.stage === "close" && event.file === handle.file,
      );
      commitCancellation(f, { ...attempt, identity: publisher });
      opened.release();
      await reachedBeforeSettled(closed, pending);
      await expect(handle.file!.stat()).rejects.toMatchObject({
        code: "EBADF",
      });
      expectReferenceHeld(f, work.key);
      expect(f.trace().release.calls).toEqual([]);
      closed.release();
      await expect(pending).resolves.toBe("stale");
      expect(f.storage.store.readArtifactReference(work.key)).toBe("released");
      expect(f.trace().release.calls).toHaveLength(1);
      expect(
        f.events
          .slice(start)
          .filter(
            ({ event }) =>
              event.file === handle.file &&
              event.stage !== "open" &&
              event.stage !== "close",
          ),
      ).toEqual([]);
      expect(f.trace().reserve.calls).toEqual([]);
    },
  );

  it("publishes a durable candidate after a failed success COMMIT without raw fallback", async () => {
    const f = await fixture();
    const fault = installArtifactCommitFault(f, "success");
    const attempt = await f.claim();
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const source = artifactSourceFacts(f, attempt.identity.jobId);
    fault.setEnabled(true);
    await expect(f.settle(attempt)).resolves.toBe("blocked");
    expect(f.trace().success.calls).toHaveLength(1);
    expect(f.trace().success.calls[0]?.error).toMatchObject({
      code: "internal_error",
    });
    const original = f.currentWork();
    const candidate = candidateFromWork(original);
    expect(candidate.state).toBe("durable");
    assertQualifiedArtifactAttempt(artifactJobRows(f, attempt.identity.jobId));
    await assertCandidateFiles(candidate, png);
    expect(fault.rolledBackFaultRows()).toEqual([]);
    fault.setEnabled(false);
    f.reopen();
    const publisher = await transferArtifactPublisher(f, attempt);
    const start = f.events.length;
    const gate = f.gate(
      (event) =>
        event.stage === "read" &&
        event.path === candidate.pngPath &&
        (event.bytesRead ?? 0) > 0,
    );
    const recovered = f.settle(publisher, "recovery");
    await reachedBeforeSettled(gate, recovered);
    const work = f.currentWork();
    expect(work.candidate).toEqual(candidate);
    expect(work.observations).toContainEqual({
      code: "io_failure",
      stage: "success_commit",
      candidateId: candidate.candidateId,
    });
    gate.release();
    await expect(recovered).resolves.toBe("succeeded");
    expectPublished(f, work);
    expectReadOnlyCandidateRecovery(f, start);
    expect(
      completedEvents(f, start)
        .filter(({ event }) => event.stage === "open")
        .map(({ event }) => event.flags),
    ).toEqual(["r", "r", "r"]);
    expect(f.trace().reserve.calls).toEqual([]);
    expect(artifactJobRows(f, attempt.identity.jobId).candidates).toHaveLength(
      1,
    );
    expectReferenceHeld(f, original.key);
    expectSourceUnchanged(f, attempt, source);
  });

  it("blocks a mismatched durable candidate without falling back to the original raw output", async () => {
    const f = await fixture();
    const fault = installArtifactCommitFault(f, "success");
    const attempt = await f.claim();
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const source = artifactSourceFacts(f, attempt.identity.jobId);
    fault.setEnabled(true);
    await expect(f.settle(attempt)).resolves.toBe("blocked");
    const original = f.currentWork();
    const candidate = candidateFromWork(original);
    const changed = changedArtifactBytes(png);
    expect(changed).not.toEqual(png);
    await writeActualFile(candidate.pngPath, changed, false);
    fault.setEnabled(false);
    f.reopen();
    const publisher = await transferArtifactPublisher(f, attempt);
    const start = f.events.length;
    await expect(f.settle(publisher, "recovery")).resolves.toBe("blocked");
    const consumerReadCount = f.trace().readWork.calls.length;
    const work = f.currentWork();
    expect(work.candidate).toEqual(candidate);
    expect(work.observations).toContainEqual(
      expect.objectContaining({
        code: "candidate_integrity",
        candidateId: candidate.candidateId,
      }),
    );
    expect(
      readWorksWith(
        f,
        work.key.referenceId,
        "candidate_integrity",
        consumerReadCount,
      ),
    ).not.toEqual([]);
    const rows = artifactJobRows(f, attempt.identity.jobId);
    assertQualifiedArtifactAttempt(rows);
    expect(rows.candidates).toHaveLength(1);
    expect(rows.candidates[0]).toMatchObject({ state: "durable" });
    expectReferenceHeld(f, original.key);
    expectReferenceHeld(f, work.key);
    expectReadOnlyCandidateRecovery(f, start);
    expect(f.trace().reserve.calls).toEqual([]);
    expect(f.trace().success.calls).toEqual([]);
    expect(await readFile(attempt.outputPath)).toEqual(png);
    expect(await readFile(candidate.pngPath)).toEqual(changed);
    expectSourceUnchanged(f, attempt, source);
  });

  for (const { stage, finals, title } of (
    ["directory_sync", "candidate_commit"] as const
  ).flatMap((stage) => [
    {
      stage,
      finals: "missing" as const,
      title: `keeps a historically complete intent after ${stage} failure and a later missing final`,
    },
    {
      stage,
      finals: "intact" as const,
      title: `revalidates a historically complete intent after ${stage} failure while both finals remain intact`,
    },
  ])) {
    it(title, async () => {
      const f = await fixture();
      const fault =
        stage === "candidate_commit"
          ? installArtifactCommitFault(f, "durable")
          : undefined;
      const attempt = await f.claim();
      const png = await nativePng(attempt);
      await f.complete(attempt, png);
      const source = artifactSourceFacts(f, attempt.identity.jobId);
      let thrown = false;
      if (stage === "directory_sync") {
        f.hooks.after = async (event) => {
          if (
            !thrown &&
            event.stage === "directory_sync" &&
            event.role === "candidate-directory"
          ) {
            thrown = true;
            throw Object.assign(
              new Error("controlled directory acknowledgement failure"),
              { code: "EIO" },
            );
          }
        };
      } else fault?.setEnabled(true);
      await expect(f.settle(attempt)).resolves.toBe("blocked");
      const original = f.currentWork();
      const candidate = candidateFromWork(original);
      expect(candidate.state).toBe("intent");
      await assertCandidateFiles(candidate, png);
      expect(original.observations).toContainEqual({
        code: "io_failure",
        stage,
        candidateId: candidate.candidateId,
      });
      if (fault) {
        expect(f.trace().durable.calls[0]?.error).toMatchObject({
          code: "internal_error",
        });
        expect(fault.rolledBackFaultRows()).toEqual([]);
        fault.setEnabled(false);
      } else expect(thrown).toBe(true);
      if (finals === "missing") await unlink(candidate.manifestPath);
      f.reopen();
      const publisher = await transferArtifactPublisher(f, attempt);
      const start = f.events.length;
      const gate =
        finals === "intact"
          ? f.gate(
              (event) =>
                event.stage === "read" &&
                event.path === candidate.pngPath &&
                (event.bytesRead ?? 0) > 0,
            )
          : undefined;
      const pending = f.settle(publisher, "recovery");
      if (gate) await reachedBeforeSettled(gate, pending);
      else await expect(pending).resolves.toBe("blocked");
      const consumerReadCount = f.trace().readWork.calls.length;
      const work = f.currentWork();
      expect(work.candidate).toEqual(candidate);
      expect(work.observations).toContainEqual({
        code: "io_failure",
        stage,
        candidateId: candidate.candidateId,
      });
      expect(
        work.observations.some(
          (observation) => observation.code === "no_qualified_candidate",
        ),
      ).toBe(false);
      if (gate) {
        expectReferenceHeld(f, work.key);
        gate.release();
        await expect(pending).resolves.toBe("succeeded");
        expectPublished(f, work);
        await assertCandidateFiles(candidate, png);
        const completed = completedEvents(f, start);
        for (const path of [candidate.pngPath, candidate.manifestPath]) {
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
              ({ event }) => event.stage === "file_sync" && event.path === path,
            ),
          ).toBe(true);
          expect(
            completed.some(
              ({ event }) => event.stage === "close" && event.path === path,
            ),
          ).toBe(true);
        }
        expect(
          completed
            .filter(({ event }) => event.stage === "directory_sync")
            .map(({ event }) => event.path),
        ).toEqual(
          trustedArtifactAncestors(candidate.directory, f.storage.directory),
        );
      } else {
        expect(work.observations).toContainEqual(
          expect.objectContaining({
            code: "candidate_integrity",
            candidateId: candidate.candidateId,
          }),
        );
        expect(
          readWorksWith(
            f,
            work.key.referenceId,
            "candidate_integrity",
            consumerReadCount,
          ),
        ).not.toEqual([]);
        assertQualifiedArtifactAttempt(
          artifactJobRows(f, attempt.identity.jobId),
        );
        expectReferenceHeld(f, work.key);
      }
      expect(
        artifactJobRows(f, attempt.identity.jobId).candidates,
      ).toHaveLength(1);
      expect(f.trace().acquisition.calls).toHaveLength(1);
      expect(f.trace().reserve.calls).toEqual([]);
      expectReadOnlyCandidateRecovery(f, start);
      expectReferenceHeld(f, original.key);
      expectSourceUnchanged(f, attempt, source);
    });
  }

  it("reads a historical candidate-integrity observation through a new ref before classifying a later missing final", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const source = artifactSourceFacts(f, attempt.identity.jobId);
    const gate = f.gate(
      (event) =>
        event.stage === "directory_sync" && event.path === f.storage.directory,
    );
    const pending = f.settle(attempt);
    await reachedBeforeSettled(gate, pending);
    const original = f.currentWork();
    const candidate = candidateFromWork(original);
    f.reopen();
    gate.release();
    await expect(pending).resolves.toBe("stale");
    const publisher = await transferArtifactPublisher(f, attempt);
    await writeActualFile(candidate.pngPath, changedArtifactBytes(png), false);
    await expect(f.settle(publisher, "recovery")).resolves.toBe("blocked");
    const first = f.currentWork();
    expect(first.observations).toContainEqual(
      expect.objectContaining({
        code: "candidate_integrity",
        candidateId: candidate.candidateId,
      }),
    );
    await unlink(candidate.pngPath);
    const start = f.events.length;
    await expect(f.settle(publisher, "recovery")).resolves.toBe("blocked");
    const consumerReadCount = f.trace().readWork.calls.length;
    const second = f.currentWork();
    expect(second.key.referenceId).not.toBe(first.key.referenceId);
    expect(second.candidate).toEqual(candidate);
    const acquired = f.trace().acquisition.calls.at(-1)?.result;
    expect(acquired?.observations).toContainEqual(
      expect.objectContaining({
        code: "candidate_integrity",
        candidateId: candidate.candidateId,
      }),
    );
    expect(
      second.observations.some(
        (observation) => observation.code === "no_qualified_candidate",
      ),
    ).toBe(false);
    expect(
      readWorksWith(
        f,
        second.key.referenceId,
        "candidate_integrity",
        consumerReadCount,
      ),
    ).not.toEqual([]);
    expectReadOnlyCandidateRecovery(f, start);
    expect(f.trace().reserve.calls).toEqual([]);
    expect(artifactJobRows(f, attempt.identity.jobId).candidates).toHaveLength(
      1,
    );
    expectReferenceHeld(f, original.key);
    expectReferenceHeld(f, first.key);
    expectReferenceHeld(f, second.key);
    expectSourceUnchanged(f, attempt, source);
  });
});

describe("artifact reference lifetime and unknown release facts", () => {
  it("holds a cancelled reference until the issued open and its actual handle close have both returned", async () => {
    const f = await fixture();
    const held = await holdEngineOpen(f, "cancelled-in-flight-reference");
    const closed = f.gate(
      (event) => event.stage === "close" && event.role === "engine",
    );
    commitCancellation(f, held.attempt);
    expectReferenceHeld(f, held.work.key);
    expect(f.storage.store.readArtifactReference(held.work.key)).toBe("held");
    expect(f.trace().release.calls).toEqual([]);
    held.gate.release();
    await reachedBeforeSettled(closed, held.pending);
    await expect(held.opened.file!.stat()).rejects.toMatchObject({
      code: "EBADF",
    });
    expectReferenceHeld(f, held.work.key);
    expect(f.storage.store.readArtifactReference(held.work.key)).toBe("held");
    expect(f.trace().release.calls).toEqual([]);
    closed.release();
    await held.pending;
    expect(f.trace().release.calls).toHaveLength(1);
    expect(f.trace().release.calls[0]?.args).toEqual([held.work.key]);
    expect(f.trace().release.calls[0]?.result).toBe(true);
    expect(f.storage.store.readArtifactReference(held.work.key)).toBe(
      "released",
    );
    expect(
      artifactJobRows(f, held.attempt.identity.jobId).references[0],
    ).toMatchObject({ released_at: f.storage.clock() });
    const actualCloseIndex = f.events.findIndex(
      ({ phase, event }) =>
        phase === "after" &&
        event.stage === "close" &&
        event.path === held.attempt.inputPath,
    );
    expect(f.trace().release.calls[0]?.facts.fileEventIndex).toBeGreaterThan(
      actualCloseIndex,
    );
    expect(f.trace().reserve.calls).toEqual([]);
  });

  it("keeps an old unknown ref across close and reopen while a new incarnation releases only its own ref", async () => {
    const f = await fixture();
    const held = await holdEngineOpen(f, "closed-in-flight-reference");
    const originalReference = artifactJobRows(f, held.attempt.identity.jobId)
      .references[0];
    const oldTrace = f.trace();
    const oldStore = f.reopen();
    expect(oldStore.readArtifactReference(held.work.key)).toBe("retired");
    expect(oldStore.readArtifactWork(held.work.key)).toEqual({
      kind: "retired",
    });
    held.gate.release();
    await expect(held.pending).resolves.toBe("stale");
    await expect(held.opened.file!.stat()).rejects.toMatchObject({
      code: "EBADF",
    });
    expect(oldTrace.release.calls).toEqual([]);
    const publisher = await transferArtifactPublisher(f, held.attempt);
    expect(f.storage.store.readArtifactReference(held.work.key)).toBe(
      "retired",
    );
    await expect(f.settle(publisher, "recovery")).resolves.toBe("succeeded");
    const rows = artifactJobRows(f, held.attempt.identity.jobId);
    expect(
      rows.references.find(
        (row) => row.reference_id === held.work.key.referenceId,
      ),
    ).toEqual(originalReference);
    const own = f.trace().acquisition.calls[0]?.result;
    assert.ok(own);
    expect(own.key.referenceId).not.toBe(held.work.key.referenceId);
    expect(
      rows.references.find((row) => row.reference_id === own.key.referenceId),
    ).toMatchObject({ released_at: f.storage.clock() });
    expect(f.storage.store.readArtifactReference(own.key)).toBe("released");
    expect(f.storage.store.releaseArtifactReference(held.work.key)).toBe(false);
  });

  it("fences a late open after a real control replacement without releasing the previous holder ref", async () => {
    const f = await fixture();
    const held = await holdEngineOpen(f, "replaced-control-reference");
    const oldReference = artifactJobRows(f, held.attempt.identity.jobId)
      .references[0];
    const first = f.storage.store.beginRecovery("replaced-controller");
    assert.ok(first);
    const second = f.storage.store.beginRecovery("current-controller");
    assert.ok(second);
    expect(second.control.recoveryId).not.toBe(first.control.recoveryId);
    const inspection = await f.executor.adapter.inspect(
      second.target,
      second.active.ownerDescriptor,
    );
    expect(
      f.storage.store.applyRecoveryInspection(first.control, inspection),
    ).toBeUndefined();
    const transferred = f.storage.store.applyRecoveryInspection(
      second.control,
      inspection,
    );
    assert.ok(transferred?.kind === "transferred");
    expect(f.storage.store.readArtifactReference(held.work.key)).toBe(
      "retired",
    );
    held.gate.release();
    await expect(held.pending).resolves.toBe("stale");
    expect(f.trace().release.calls).toEqual([]);
    await expect(held.opened.file!.stat()).rejects.toMatchObject({
      code: "EBADF",
    });
    await expect(f.settle(transferred.publisher, "recovery")).resolves.toBe(
      "succeeded",
    );
    const rows = artifactJobRows(f, held.attempt.identity.jobId);
    expect(
      rows.references.find(
        (row) => row.reference_id === held.work.key.referenceId,
      ),
    ).toEqual(oldReference);
    const own = f.trace().acquisition.calls.at(-1)?.result;
    assert.ok(own);
    expect(f.storage.store.readArtifactReference(own.key)).toBe("released");
    expect(f.storage.store.releaseArtifactReference(held.work.key)).toBe(false);
  });

  it("reads held after a real release COMMIT rollback without blindly retrying and releases a later fault-free ref", async () => {
    const f = await fixture();
    const fault = installArtifactCommitFault(f, "release");
    const held = await holdEngineOpen(f, "release-commit-fault");
    commitCancellation(f, held.attempt);
    expectReferenceHeld(f, held.work.key);
    fault.setEnabled(true);
    held.gate.release();
    await held.pending;
    expect(f.trace().release.calls).toHaveLength(1);
    const failed = f.trace().release.calls[0];
    expect(failed?.args).toEqual([held.work.key]);
    expect(failed?.error).toMatchObject({ code: "internal_error" });
    expect(failed?.result).toBeUndefined();
    expect(f.trace().readReference.calls).toEqual([
      expect.objectContaining({ args: [held.work.key], result: "held" }),
      expect.objectContaining({ args: [held.work.key], result: "held" }),
    ]);
    const [beforeRelease, afterFailure] = f.trace().readReference.calls;
    assert.ok(beforeRelease && afterFailure && failed);
    expect(beforeRelease.facts.order).toBeLessThan(failed.facts.order);
    expect(afterFailure.facts.order).toBeGreaterThan(failed.facts.order);
    const closeIndex = f.events.reduce(
      (last, { phase, event }, index) =>
        phase === "after" &&
        event.stage === "close" &&
        event.path === held.attempt.inputPath
          ? index
          : last,
      -1,
    );
    expect(closeIndex).toBeGreaterThan(-1);
    expect(beforeRelease.facts.fileEventIndex).toBeGreaterThan(closeIndex);
    expect(beforeRelease.facts.fileEventIndex).toBe(f.events.length);
    expectReferenceHeld(f, held.work.key);
    expect(fault.rolledBackFaultRows()).toEqual([]);
    const firstRows = artifactJobRows(f, held.attempt.identity.jobId);
    expect(firstRows.observations).toEqual([]);
    fault.setEnabled(false);
    const control = await holdEngineOpen(f, "release-commit-positive-control");
    commitCancellation(f, control.attempt);
    control.gate.release();
    await control.pending;
    expect(f.trace().release.calls).toHaveLength(2);
    expect(f.trace().release.calls[1]).toMatchObject({
      args: [control.work.key],
      result: true,
    });
    expect(f.storage.store.readArtifactReference(control.work.key)).toBe(
      "released",
    );
    expect(artifactJobRows(f, held.attempt.identity.jobId)).toEqual(firstRows);
    expectReferenceHeld(f, held.work.key);
  });

  it("confirms released after a real release COMMIT loses its acknowledgement exactly once", async () => {
    const f = await fixture();
    const held = await holdEngineOpen(f, "release-lost-acknowledgement");
    let lost = false;
    f.trace().hooks.afterReleased = (key) => {
      expect(key).toEqual(held.work.key);
      assert.equal(lost, false);
      lost = true;
      throw new Error("controlled release acknowledgement loss");
    };
    commitCancellation(f, held.attempt);
    expectReferenceHeld(f, held.work.key);
    held.gate.release();
    await held.pending;
    expect(lost).toBe(true);
    expect(f.trace().release.calls).toHaveLength(1);
    expect(f.trace().release.calls[0]?.error).toBeInstanceOf(Error);
    expect(f.trace().releaseCommits).toEqual([
      expect.objectContaining({ key: held.work.key, result: true }),
    ]);
    expect(f.trace().releaseCommits[0]?.rows.references[0]).toMatchObject({
      released_at: f.storage.clock(),
    });
    expect(f.trace().readReference.calls).toEqual([
      expect.objectContaining({ args: [held.work.key], result: "held" }),
      expect.objectContaining({ args: [held.work.key], result: "released" }),
    ]);
    const [beforeRelease, afterFailure] = f.trace().readReference.calls;
    const release = f.trace().release.calls[0];
    assert.ok(beforeRelease && afterFailure && release);
    expect(beforeRelease.facts.order).toBeLessThan(release.facts.order);
    expect(afterFailure.facts.order).toBeGreaterThan(release.facts.order);
    const closeIndex = f.events.reduce(
      (last, { phase, event }, index) =>
        phase === "after" &&
        event.stage === "close" &&
        event.path === held.attempt.inputPath
          ? index
          : last,
      -1,
    );
    expect(closeIndex).toBeGreaterThan(-1);
    expect(beforeRelease.facts.fileEventIndex).toBeGreaterThan(closeIndex);
    expect(beforeRelease.facts.fileEventIndex).toBe(f.events.length);
    expect(f.job(held.attempt.identity.jobId).status).toBe("cancelled");
    expect(artifactJobRows(f, held.attempt.identity.jobId).slot).toEqual([]);
  });

  it("rejects wrong-job and wrong-holder reference queries without poisoning a real current ref", async () => {
    const f = await fixture();
    const first = await f.claim(
      submission(await sourceImage("blue"), "reference-fact-source"),
    );
    await f.complete(first, await nativePng(first));
    await expect(f.settle(first)).resolves.toBe("succeeded");
    const firstWork = f.trace().acquisition.calls[0]?.result;
    assert.ok(firstWork);
    expect(f.storage.store.readArtifactReference(firstWork.key)).toBe(
      "released",
    );
    const second = await holdEngineOpen(f, "reference-fact-target");
    const before = f.rows();
    const foreign: ArtifactWorkKey[] = [
      {
        publisher: second.attempt.identity,
        referenceId: firstWork.key.referenceId,
      },
      { publisher: first.identity, referenceId: second.work.key.referenceId },
      {
        publisher: {
          ...second.attempt.identity,
          ownerInstanceId: "foreign-reference-holder",
        },
        referenceId: second.work.key.referenceId,
      },
      {
        publisher: second.attempt.identity,
        referenceId: "unknown-artifact-reference",
      },
    ];
    for (const key of foreign) {
      expect(f.storage.store.readArtifactReference(key)).toBe("retired");
      expect(f.storage.store.releaseArtifactReference(key)).toBe(false);
    }
    expect(f.rows()).toEqual(before);
    expect(f.storage.store.readArtifactReference(second.work.key)).toBe("held");
    second.gate.release();
    await expect(second.pending).resolves.toBe("succeeded");
    expect(f.storage.store.readArtifactReference(second.work.key)).toBe(
      "released",
    );
    f.storage.store.close();
    expect(f.storage.store.readArtifactReference(second.work.key)).toBe(
      "retired",
    );
  });
});
