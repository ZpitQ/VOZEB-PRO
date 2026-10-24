import assert from "node:assert/strict";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";
import sharp from "sharp";

import type {
  ClaimedAttempt,
  CompletionEvidence,
  ExecutionExit,
} from "../src/execution.js";
import { createRunner } from "../src/runner.js";
import { openStore } from "../src/store.js";
import { manualClock, snapshot, treeExit } from "./lifecycle-fixtures.js";
import { fixtureSendGuard } from "./execution-send-permission-fixtures.js";
import { recoveryExecutor } from "./recovery-fixtures.js";
import type {
  ArtifactCandidateRow,
  ArtifactReferenceRow,
} from "./artifact-fixtures.js";
import { sourceImage, storageFixture, submission } from "./storage-fixtures.js";

export const completions: readonly (readonly [
  string,
  Extract<CompletionEvidence, { kind: "success" | "failure" }>,
])[] = [
  ["success", { kind: "success", exitCode: 0, signal: null }],
  ["nonzero failure", { kind: "failure", exitCode: 7, signal: null }],
  ["signal failure", { kind: "failure", exitCode: null, signal: "SIGTERM" }],
];

export const failures = completions.slice(1);

export function completionExit(
  attempt: ClaimedAttempt,
  completion?: CompletionEvidence,
): ExecutionExit {
  return {
    ...treeExit(attempt),
    ...(completion === undefined ? {} : { completion }),
  };
}

export async function completionFixture() {
  const storage = await storageFixture();
  const time = manualClock(storage);
  const executor = recoveryExecutor();
  const runners: ReturnType<typeof createRunner>[] = [];
  const bytes = await sourceImage();
  const submit = (key = "completion-first") =>
    storage.service().submit(storage.principal(), submission(bytes, key));
  return {
    storage,
    time,
    executor,
    submit,
    async claim(
      phase: "claimed" | "prepared" | "authorized" = "authorized",
      key = "completion-first",
    ) {
      await submit(key);
      const attempt = storage.store.claimNext("completion-producer");
      assert.ok(attempt);
      if (phase !== "claimed") {
        const owner = await executor.adapter.prepare(
          attempt,
          fixtureSendGuard(() =>
            storage.store.canPrepareAttempt(
              attempt.identity,
              attempt.launchTicket,
            ),
          ),
        );
        assert.equal(
          storage.store.registerPrepared(attempt.identity, owner),
          true,
        );
        if (phase === "authorized") {
          assert.equal(
            storage.store.authorizeLaunch(attempt.identity, owner),
            true,
          );
          await executor.adapter.authorize(
            attempt,
            owner,
            fixtureSendGuard(() =>
              storage.store.canAuthorizeLaunch(
                attempt.identity,
                attempt.launchTicket,
                owner,
              ),
            ),
          );
        }
      }
      return attempt;
    },
    runner(ownerInstanceId = "completion-runner") {
      const runner = createRunner({
        store: storage.store,
        clock: time.clock,
        executor: executor.adapter,
        ownerInstanceId,
      });
      runners.push(runner);
      return runner;
    },
    job(jobId: string) {
      return storage.store.getOwned(storage.principal(), jobId);
    },
    rows() {
      return snapshot(storage, (db) => ({
        jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
        attempts: db
          .prepare("SELECT * FROM attempts ORDER BY job_id, attempt_no")
          .all(),
        slot: db.prepare("SELECT * FROM execution_slot").all(),
        controls: db
          .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
          .all(),
        events: db
          .prepare("SELECT * FROM recovery_events ORDER BY rowid")
          .all(),
        candidates: db
          .prepare("SELECT * FROM artifact_candidates ORDER BY rowid")
          .all() as ArtifactCandidateRow[],
        references: db
          .prepare("SELECT * FROM artifact_references ORDER BY rowid")
          .all() as ArtifactReferenceRow[],
      }));
    },
    removeCommitFault(point: "job status" | "slot delete") {
      storage.store.close();
      const db = new Database(join(storage.directory, "worker.sqlite"));
      try {
        db.exec(
          point === "job status"
            ? "DROP TRIGGER completion_job_commit"
            : "DROP TRIGGER completion_slot_commit",
        );
      } finally {
        db.close();
      }
      storage.setStore(
        openStore({ directory: storage.directory, clock: storage.clock }),
      );
    },
    async residualPng(attempt: ClaimedAttempt) {
      const png = await sharp({
        create: {
          width:
            attempt.job.engineInput.width * attempt.job.plan.engine.nativeScale,
          height:
            attempt.job.engineInput.height *
            attempt.job.plan.engine.nativeScale,
          channels: 3,
          background: "green",
        },
      })
        .png()
        .toBuffer();
      await mkdir(attempt.workingDirectory, { recursive: true });
      const file = await open(attempt.outputPath, "wx", 0o600);
      try {
        await file.writeFile(png);
        await file.sync();
      } finally {
        await file.close();
      }
      return png;
    },
    async reopen() {
      for (const runner of runners) await runner.close();
      storage.store.close();
      storage.setStore(
        openStore({ directory: storage.directory, clock: storage.clock }),
      );
    },
    async cleanup() {
      for (const runner of runners) await runner.close();
      await storage.cleanup();
    },
  };
}

export type CompletionFixture = Awaited<ReturnType<typeof completionFixture>>;
