import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactResult } from "../src/artifacts.js";
import type { ClaimedAttempt } from "../src/execution.js";
import { createRunner } from "../src/runner.js";
import { openStore } from "../src/store.js";
import {
  artifactFixture,
  nativePng,
  writeActualFile,
  type ArtifactCandidateRow,
} from "./artifact-fixtures.js";
import { completionExit } from "./completion-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import { sha256, sourceImage, submission } from "./storage-fixtures.js";

export function nativeResult(
  attempt: ClaimedAttempt,
  bytes: Buffer,
): ArtifactResult {
  return {
    format: "png",
    width: attempt.job.engineInput.width * attempt.job.plan.engine.nativeScale,
    height:
      attempt.job.engineInput.height * attempt.job.plan.engine.nativeScale,
    sha256: sha256(bytes),
    byteLength: bytes.length,
  };
}

export async function sealedFiles(
  storageDirectory: string,
  candidate: ArtifactCandidateRow,
) {
  const directory = join(storageDirectory, "attempts", candidate.directory);
  return {
    png: await readFile(join(directory, "artifact.png")),
    manifest: await readFile(join(directory, "manifest.json")),
  };
}

export async function artifactRunnerFixture() {
  const base = await artifactFixture();
  const runners: ReturnType<typeof createRunner>[] = [];
  const gates: ReturnType<typeof base.gate>[] = [];
  const pending: Promise<void>[] = [];
  const bytes = await sourceImage();
  const track = (promise: Promise<void>) => {
    pending.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  const submit = (key = "artifact-runner-first") =>
    base.storage
      .service()
      .submit(base.storage.principal(), submission(bytes, key));
  const runner = (ownerInstanceId = "artifact-live-runner") => {
    const value = createRunner({
      store: base.storage.store,
      clock: base.time.clock,
      executor: base.executor.adapter,
      ownerInstanceId,
      artifactFiles: base.files,
    });
    runners.push(value);
    return value;
  };
  return {
    storage: base.storage,
    time: base.time,
    executor: base.executor,
    hooks: base.hooks,
    files: base.files,
    events: base.events,
    rows: base.rows,
    job: base.job,
    submit,
    runner,
    track,
    gate(...args: Parameters<typeof base.gate>) {
      const gate = base.gate(...args);
      gates.push(gate);
      return gate;
    },
    async start(key = "artifact-runner-first") {
      const accepted = await submit(key);
      const consumer = runner();
      await track(consumer.wake());
      const attempt = base.executor.launchCalls.find(
        (call) => call.identity.jobId === accepted.job.jobId,
      );
      assert.ok(attempt);
      return { accepted, attempt, runner: consumer };
    },
    async emitSuccess(attempt: ClaimedAttempt) {
      const png = await nativePng(attempt);
      await writeActualFile(attempt.outputPath, png);
      const exit = completionExit(attempt, {
        kind: "success",
        exitCode: 0,
        signal: null,
      });
      // The subscribed live runner is the sole registerExit consumer. Calling
      // artifactFixture.complete here would register this same exit a second time.
      base.executor.emit(exit);
      return { png, exit };
    },
    sourceFacts(jobId: string) {
      return snapshot(base.storage, (db) => ({
        job: db
          .prepare(
            "SELECT first_started_at, execution_deadline_at, active_attempt_no FROM jobs WHERE job_id = ?",
          )
          .get(jobId),
        attempts: db
          .prepare(
            "SELECT attempt_no, producer_identity_json, producer_incarnation_id, launch_ticket, run_directory, tile, authorized_at, exit_json FROM attempts WHERE job_id = ? ORDER BY attempt_no",
          )
          .all(jobId),
      }));
    },
    async reopen() {
      for (const consumer of runners) await consumer.close();
      base.storage.store.close();
      base.storage.setStore(
        openStore({
          directory: base.storage.directory,
          clock: base.storage.clock,
        }),
      );
    },
    async cleanup() {
      for (const consumer of runners) await consumer.close();
      for (const gate of gates) gate.release();
      await Promise.allSettled(pending);
      await base.cleanup();
    },
  };
}

export type ArtifactRunnerFixture = Awaited<
  ReturnType<typeof artifactRunnerFixture>
>;

export function reachedBeforeRunnerSettled(
  gate: ReturnType<ArtifactRunnerFixture["gate"]>,
  pending: Promise<void>,
) {
  return Promise.race([
    gate.reached,
    pending.then(() => {
      throw new Error(
        "runner settled before the required real artifact I/O stage",
      );
    }),
  ]);
}
