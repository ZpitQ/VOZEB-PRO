import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { ArtifactCandidate, ArtifactWork } from "../src/artifacts.js";
import {
  nativePng,
  reachedBeforeSettled,
  type ArtifactCandidateRow,
  type ArtifactFixture,
  type ArtifactObservationRow,
  type ArtifactReferenceRow,
} from "./artifact-fixtures.js";
import { commitFault, snapshot } from "./lifecycle-fixtures.js";
import { sha256, sourceImage, submission } from "./storage-fixtures.js";

export function artifactJobRows(f: ArtifactFixture, jobId: string) {
  return snapshot(f.storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs WHERE job_id = ?").all(jobId) as {
      job_id: string;
      status: string;
      reason: string | null;
      completed_at: number | null;
      result_candidate_id: string | null;
    }[],
    attempts: db
      .prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY attempt_no")
      .all(jobId) as {
      job_id: string;
      attempt_no: number;
      authorized_at: number | null;
      exit_json: string | null;
      producer_identity_json: string;
      producer_incarnation_id: string;
      launch_ticket: string;
    }[],
    slot: db
      .prepare("SELECT * FROM execution_slot WHERE job_id = ?")
      .all(jobId),
    candidates: db
      .prepare(
        "SELECT * FROM artifact_candidates WHERE job_id = ? ORDER BY rowid",
      )
      .all(jobId) as ArtifactCandidateRow[],
    references: db
      .prepare(
        "SELECT * FROM artifact_references WHERE job_id = ? ORDER BY rowid",
      )
      .all(jobId) as (ArtifactReferenceRow & { incarnation_id: string })[],
    observations: db
      .prepare(
        `SELECT o.* FROM artifact_observations o
         JOIN artifact_references r ON r.reference_id = o.reference_id
         WHERE r.job_id = ? ORDER BY r.rowid, o.observation_no`,
      )
      .all(jobId) as ArtifactObservationRow[],
  }));
}

export function assertQualifiedArtifactAttempt(
  rows: ReturnType<typeof artifactJobRows>,
) {
  assert.equal(rows.jobs.length, 1);
  assert.equal(rows.jobs[0]?.status, "running");
  assert.equal(rows.jobs[0]?.reason, null);
  assert.equal(rows.jobs[0]?.completed_at, null);
  assert.equal(rows.jobs[0]?.result_candidate_id, null);
  assert.equal(rows.slot.length, 1);
  assert.equal(rows.attempts.length, 1);
  assert.notEqual(rows.attempts[0]?.authorized_at, null);
  const exit = JSON.parse(rows.attempts[0]?.exit_json ?? "null");
  assert.equal(exit?.treeExited, true);
  assert.deepEqual(exit?.completion, {
    kind: "success",
    exitCode: 0,
    signal: null,
  });
}

export function assertIntentAndReference(
  rows: ReturnType<typeof artifactJobRows>,
  work: ArtifactWork,
) {
  assertQualifiedArtifactAttempt(rows);
  assert.ok(work.candidate);
  assert.equal(rows.candidates.length, 1);
  assert.equal(rows.candidates[0]?.candidate_id, work.candidate.candidateId);
  assert.equal(rows.candidates[0]?.state, "intent");
  assert.equal(rows.candidates[0]?.durable_at, null);
  const reference = rows.references.find(
    (row) => row.reference_id === work.key.referenceId,
  );
  assert.ok(reference);
  assert.equal(reference.candidate_id, work.candidate.candidateId);
  assert.equal(reference.released_at, null);
  assert.deepEqual(
    JSON.parse(reference.publisher_identity_json),
    work.key.publisher,
  );
}

export async function assertCandidateFiles(
  candidate: ArtifactCandidate,
  png: Buffer,
) {
  assert.equal((await stat(candidate.pngPath)).isFile(), true);
  assert.deepEqual(await readFile(candidate.pngPath), png);
  const manifest = await readFile(candidate.manifestPath);
  assert.equal((await stat(candidate.manifestPath)).isFile(), true);
  assert.equal(sha256(manifest), candidate.manifestSha256);
  assert.equal(manifest.length, candidate.manifestByteLength);
  assert.deepEqual(
    manifest,
    Buffer.from(JSON.stringify(candidate.manifest), "utf8"),
  );
  await assert.rejects(stat(candidate.pngPartPath), { code: "ENOENT" });
  await assert.rejects(stat(candidate.manifestPartPath), { code: "ENOENT" });
}

// This is a real preceding job in the same store, ArtifactFiles adapter and
// createArtifacts instance. An old failed intent is never resumed as a writer.
export async function publishedArtifactControl(
  f: ArtifactFixture,
  idempotencyKey: string,
) {
  const attempt = await f.claim(
    submission(await sourceImage("blue"), idempotencyKey),
  );
  const png = await nativePng(attempt);
  await f.complete(attempt, png);
  const firstEvent = f.events.length;
  const gate = f.gate(
    (event) =>
      event.stage === "directory_sync" && event.role === "candidate-directory",
  );
  const pending = f.settle(attempt);
  await reachedBeforeSettled(gate, pending);
  const work = f.currentWork();
  assert.ok(work.candidate);
  await assertCandidateFiles(work.candidate, png);
  assertIntentAndReference(artifactJobRows(f, attempt.identity.jobId), work);
  gate.release();
  assert.equal(await pending, "succeeded");
  assert.equal(f.job(attempt.identity.jobId).status, "succeeded");
  const rows = artifactJobRows(f, attempt.identity.jobId);
  assert.equal(rows.candidates[0]?.state, "durable");
  assert.equal(rows.jobs[0]?.result_candidate_id, work.candidate.candidateId);
  assert.equal(rows.references[0]?.released_at, f.storage.clock());
  assert.equal(rows.slot.length, 0);
  return { attempt, png, work, events: f.events.slice(firstEvent) };
}

export function trustedArtifactAncestors(
  workingDirectory: string,
  storageDirectory: string,
) {
  const trustedRoot = resolve(storageDirectory);
  let current = resolve(workingDirectory);
  const paths: string[] = [];
  for (;;) {
    const withinRoot = relative(trustedRoot, current);
    assert.ok(
      withinRoot === "" ||
        (!isAbsolute(withinRoot) &&
          withinRoot !== ".." &&
          !withinRoot.startsWith(`..${sep}`)),
      "artifact directory sync must stay inside its trusted store root",
    );
    paths.push(current);
    if (current === trustedRoot) return paths;
    const parent = dirname(current);
    assert.notEqual(parent, current, "trusted store root must be reached");
    current = parent;
  }
}

type ArtifactCommitTarget =
  | "acquire"
  | "reserve"
  | "durable"
  | "success"
  | "invalid_output"
  | "release"
  | "observation";

// Install the mature deferred-FK helper before claim/authorize/ref creation.
// Two dedicated synthetic credentials provide a one-way activation/deactivation
// switch through the same real store connection, preserving its exclusive lock.
export function installArtifactCommitFault(
  f: ArtifactFixture,
  target: ArtifactCommitTarget,
) {
  const definitions = {
    acquire: ["AFTER INSERT ON artifact_references", "1"],
    reserve: ["AFTER INSERT ON artifact_candidates", "NEW.state = 'intent'"],
    durable: [
      "AFTER UPDATE OF state ON artifact_candidates",
      "NEW.state = 'durable'",
    ],
    success: ["AFTER UPDATE OF status ON jobs", "NEW.status = 'succeeded'"],
    invalid_output: [
      "AFTER UPDATE OF status ON jobs",
      "NEW.status = 'failed' AND NEW.reason = 'invalid_output'",
    ],
    release: [
      "AFTER UPDATE OF released_at ON artifact_references",
      "OLD.released_at IS NULL AND NEW.released_at IS NOT NULL",
    ],
    observation: [
      "AFTER INSERT ON artifact_observations",
      "NEW.code = 'publication_unknown'",
    ],
  } as const;
  const previousStore = f.storage.store;
  const businessClientId = f.storage.principal().clientId;
  const businessCredentials = snapshot(f.storage, (db) =>
    db
      .prepare(
        "SELECT credential_id, revoked_at FROM credentials WHERE client_id = ? ORDER BY version",
      )
      .all(businessClientId),
  );
  const activation = previousStore.issueCredential(
    sha256(Buffer.from("artifact-commit-fault-activation-fixture", "utf8")),
  );
  const deactivation = previousStore.issueCredential(
    sha256(Buffer.from("artifact-commit-fault-deactivation-fixture", "utf8")),
    { clientId: activation.clientId },
  );
  assert.notEqual(activation.clientId, businessClientId);
  assert.equal(deactivation.clientId, activation.clientId);
  assert.notEqual(activation.credentialId, deactivation.credentialId);
  const previousIncarnations = snapshot(
    f.storage,
    (db) =>
      db
        .prepare("SELECT incarnation_id FROM store_incarnations ORDER BY rowid")
        .all() as {
        incarnation_id: string;
      }[],
  );
  const [event, condition] = definitions[target];
  commitFault(
    f.storage,
    `CREATE TRIGGER artifact_exact_commit_fault ${event}
     WHEN EXISTS (
       SELECT 1 FROM credentials
       WHERE credential_id = '${activation.credentialId}'
         AND client_id = '${activation.clientId}' AND revoked_at IS NOT NULL
     ) AND EXISTS (
       SELECT 1 FROM credentials
       WHERE credential_id = '${deactivation.credentialId}'
         AND client_id = '${deactivation.clientId}' AND revoked_at IS NULL
     ) AND (${condition})
     BEGIN
       INSERT INTO lifecycle_commit_fault(client_id)
       VALUES ('artifact-fault-missing-client');
     END;`,
  );
  assert.equal(previousStore.closed, true);
  assert.notEqual(f.storage.store, previousStore);
  const incarnations = snapshot(
    f.storage,
    (db) =>
      db
        .prepare("SELECT incarnation_id FROM store_incarnations ORDER BY rowid")
        .all() as {
        incarnation_id: string;
      }[],
  );
  assert.equal(incarnations.length, previousIncarnations.length + 1);
  const incarnationId = incarnations.at(-1)?.incarnation_id;
  assert.ok(incarnationId);
  assert.notEqual(incarnationId, previousIncarnations.at(-1)?.incarnation_id);
  const currentStore = f.storage.store;
  return {
    incarnationId,
    setEnabled(enabled: boolean) {
      assert.equal(f.storage.store, currentStore);
      assert.equal(currentStore.closed, false);
      currentStore.revokeCredential(
        enabled ? activation.credentialId : deactivation.credentialId,
      );
      snapshot(f.storage, (db) => {
        const credentials = db
          .prepare(
            "SELECT credential_id, client_id, revoked_at FROM credentials WHERE credential_id IN (?, ?) ORDER BY version",
          )
          .all(activation.credentialId, deactivation.credentialId) as {
          credential_id: string;
          client_id: string;
          revoked_at: number | null;
        }[];
        assert.equal(credentials.length, 2);
        const active = credentials.find(
          (row) => row.credential_id === activation.credentialId,
        );
        const inactive = credentials.find(
          (row) => row.credential_id === deactivation.credentialId,
        );
        assert.ok(active && inactive);
        assert.equal(active.client_id, activation.clientId);
        assert.equal(inactive.client_id, activation.clientId);
        assert.equal(
          active.revoked_at !== null && inactive.revoked_at === null,
          enabled,
        );
        assert.equal(
          db
            .prepare("SELECT 1 FROM clients WHERE client_id = ?")
            .get("artifact-fault-missing-client"),
          undefined,
        );
        assert.deepEqual(
          db
            .prepare(
              "SELECT incarnation_id FROM store_incarnations ORDER BY rowid",
            )
            .all(),
          incarnations,
        );
        assert.deepEqual(
          db
            .prepare(
              "SELECT credential_id, revoked_at FROM credentials WHERE client_id = ? ORDER BY version",
            )
            .all(businessClientId),
          businessCredentials,
        );
      });
      assert.equal(f.storage.store, currentStore);
      assert.equal(currentStore.closed, false);
    },
    rolledBackFaultRows() {
      return snapshot(f.storage, (db) =>
        db.prepare("SELECT * FROM lifecycle_commit_fault").all(),
      );
    },
  };
}

export function traceArtifactCommit<Args extends unknown[], Result, Facts>(
  operation: (...args: Args) => Result,
  facts: (...args: Args) => Facts,
) {
  const calls: {
    args: Args;
    facts: Facts;
    result?: Result;
    error?: unknown;
  }[] = [];
  return {
    calls,
    invoke(...args: Args): Result {
      const call: (typeof calls)[number] = { args, facts: facts(...args) };
      calls.push(call);
      try {
        call.result = operation(...args);
        return call.result;
      } catch (error) {
        call.error = error;
        throw error;
      }
    },
  };
}
