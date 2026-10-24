import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import { createClient } from "../src/credentials.js";
import {
  writeActualFile,
  type ArtifactObservationRow,
  type ArtifactReferenceRow,
} from "./artifact-fixtures.js";
import { nativeResult } from "./artifact-runner-fixtures.js";
import { completionExit } from "./completion-fixtures.js";
import { configInput } from "./fixtures.js";
import { httpFixture, jobOf } from "./http-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import {
  requestBinary,
  succeededThroughRunner,
  type BinaryHttpResult,
  type ResultHttpFixture,
} from "./result-http-fixtures.js";
import { sha256 } from "./storage-fixtures.js";

type Success = Awaited<ReturnType<typeof succeededThroughRunner>>;
type DownloadReference = ArtifactReferenceRow & {
  incarnation_id: string;
  acquired_at: number;
};
type DownloadObservation = ArtifactObservationRow & {
  observation_no: number;
  checked_engine_sha256: string | null;
  observed_at: number;
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: Parameters<typeof httpFixture>[0] = {}) {
  const f = await httpFixture(options);
  cleanups.push(() => f.cleanup());
  return f;
}

const succeed = (f: ResultHttpFixture) =>
  succeededThroughRunner(f, (cleanup) => cleanups.push(cleanup));

function storedFacts(f: ResultHttpFixture) {
  return snapshot(f.storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
    attempts: db
      .prepare("SELECT * FROM attempts ORDER BY job_id, attempt_no")
      .all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
    candidates: db
      .prepare("SELECT * FROM artifact_candidates ORDER BY rowid")
      .all(),
  }));
}

function downloadLedger(f: ResultHttpFixture) {
  return snapshot(f.storage, (db) => ({
    references: db
      .prepare("SELECT * FROM artifact_references ORDER BY rowid")
      .all() as DownloadReference[],
    observations: db
      .prepare("SELECT * FROM artifact_observations ORDER BY rowid")
      .all() as DownloadObservation[],
  }));
}

function expectRecoveryReference(
  f: ResultHttpFixture,
  success: Success,
  before: ReturnType<typeof downloadLedger>,
  diagnostic?: "candidate_integrity",
) {
  const after = downloadLedger(f);
  expect(after.references).toHaveLength(before.references.length + 1);
  expect(after.references.slice(0, before.references.length)).toEqual(
    before.references,
  );
  const reference = after.references.at(-1);
  assert.ok(reference);
  expect(before.references.map((row) => row.reference_id)).not.toContain(
    reference.reference_id,
  );
  expect(reference).toMatchObject({
    job_id: success.attempt.identity.jobId,
    attempt_no: success.attempt.identity.attemptNo,
    publisher_identity_json: JSON.stringify(success.attempt.identity),
    candidate_id: success.facts.candidates[0]!.candidate_id,
    purpose: "recovery",
    acquired_at: f.storage.clock(),
    released_at: f.storage.clock(),
  });
  expect(reference.incarnation_id).toEqual(expect.any(String));
  const runId = success.facts.references[0]!.reference_id;
  const originalRun = before.references.find(
    (row) => row.reference_id === runId,
  );
  assert.ok(originalRun);
  expect(originalRun.purpose).toBe("run");
  expect(after.references.find((row) => row.reference_id === runId)).toEqual(
    originalRun,
  );
  expect(after.observations.slice(0, before.observations.length)).toEqual(
    before.observations,
  );
  expect(after.observations.slice(before.observations.length)).toEqual(
    diagnostic === undefined
      ? []
      : [
          {
            reference_id: reference.reference_id,
            observation_no: 1,
            candidate_id: success.facts.candidates[0]!.candidate_id,
            code: diagnostic,
            stage: null,
            checked_engine_sha256: null,
            observed_at: f.storage.clock(),
          },
        ],
  );
  return reference;
}

function privateValues(f: ResultHttpFixture, success: Success) {
  return [
    f.storage.directory,
    f.storage.initialized.credential.key,
    success.attempt.identity.ownerInstanceId,
    success.attempt.launchTicket,
    success.attempt.inputPath,
    success.attempt.outputPath,
    success.attempt.workingDirectory,
    success.facts.candidates[0]!.candidate_id,
    success.facts.candidates[0]!.directory,
    success.facts.references[0]!.reference_id,
    '"candidateId"',
    '"candidate_id"',
    '"referenceId"',
    '"reference_id"',
    '"producer"',
    '"ownerDescriptor"',
    '"manifest"',
    '"observations"',
    "publication_unknown",
    "candidate_integrity",
  ];
}

function noPrivateValues(
  response: BinaryHttpResult,
  values: readonly string[],
) {
  const headers = JSON.stringify(response.headers);
  for (const value of values) {
    expect(headers).not.toContain(value);
    expect(response.bytes.includes(Buffer.from(value))).toBe(false);
  }
}

function expectError(
  response: BinaryHttpResult,
  status: number,
  code: string,
  values: readonly string[],
) {
  expect(response.status).toBe(status);
  expect(response.headers["content-type"]).toMatch(/^application\/json(?:;|$)/);
  expect(JSON.parse(response.bytes.toString("utf8"))).toMatchObject({
    code,
    data: { requestId: expect.any(String) },
  });
  noPrivateValues(response, values);
}

function expectPng(response: BinaryHttpResult, png: Buffer) {
  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toBe("image/png");
  expect(response.headers["content-length"]).toBe(String(png.length));
  expect(response.headers.etag).toBe(`"${sha256(png)}"`);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.bytes).toEqual(png);
}

describe("HTTP downloads only the durable succeeded native PNG", () => {
  it("returns exact bytes and headers repeatedly without changing the DTO, attempts or commit notifications", async () => {
    let committed = 0;
    const f = await fixture({
      onJobCommitted() {
        committed++;
      },
    });
    const success = await succeed(f);
    expect(committed).toBe(1);
    const base = `/v1/enhancement-jobs/${success.succeeded.jobId}`;
    const values = privateValues(f, success);
    const before = storedFacts(f);
    const candidate = success.facts.candidates[0]!;
    const published = await readFile(
      join(
        f.storage.directory,
        "attempts",
        candidate.directory,
        "artifact.png",
      ),
    );
    expect(published).toEqual(success.png);
    const recoveryIds: string[] = [];
    for (let request = 0; request < 2; request++) {
      const beforeLedger = downloadLedger(f);
      const response = await requestBinary(f, `${base}/result`);
      expectPng(response, published);
      const reference = expectRecoveryReference(f, success, beforeLedger);
      recoveryIds.push(reference.reference_id);
      noPrivateValues(response, [
        ...values,
        reference.reference_id,
        reference.incarnation_id,
      ]);
      expect(jobOf(await f.call("GET", base))).toEqual(success.succeeded);
    }
    expect(new Set(recoveryIds).size).toBe(2);
    const dto = jobOf(await f.call("GET", base));
    expect(dto.result).toEqual(nativeResult(success.attempt, published));
    expect(dto.result!.width).not.toBe(dto.plan.target.width);
    expect(dto.result!.height).not.toBe(dto.plan.target.height);
    expect(storedFacts(f)).toEqual(before);
    expect(success.executor.prepareCalls).toHaveLength(1);
    expect(success.executor.authorizeCalls).toHaveLength(1);
    expect(success.executor.launchCalls).toHaveLength(1);
    expect(committed).toBe(1);
  });

  it("survives runner close and Store/HTTP reopen while not ready with changed model and current budgets", async () => {
    let committed = 0;
    const f = await fixture({
      onJobCommitted() {
        committed++;
      },
    });
    const success = await succeed(f);
    const changed = configInput();
    for (const budget of Object.values(changed.budgets)) {
      budget.maxBytes = 1;
      budget.maxPixels = 1;
    }
    changed.models[0]!.binarySha256 = "d".repeat(64);
    changed.models[0]!.modelSha256 = "e".repeat(64);
    changed.models[0]!.defaultTile = 128;
    f.setConfig(createWorkerConfig(changed));
    f.setReady(false);
    await success.runner.close();
    await f.restart();
    const before = storedFacts(f);
    const beforeLedger = downloadLedger(f);
    const base = `/v1/enhancement-jobs/${success.succeeded.jobId}`;
    const response = await requestBinary(f, `${base}/result`);
    expectPng(response, success.png);
    const reference = expectRecoveryReference(f, success, beforeLedger);
    const originalRun = beforeLedger.references.find(
      (row) => row.reference_id === success.facts.references[0]!.reference_id,
    );
    assert.ok(originalRun);
    expect(reference.incarnation_id).not.toBe(originalRun.incarnation_id);
    noPrivateValues(response, [
      ...privateValues(f, success),
      reference.reference_id,
      reference.incarnation_id,
    ]);
    expect(jobOf(await f.call("GET", base))).toEqual(success.succeeded);
    expect(await f.call("POST", `${base}/receipt`)).toMatchObject({
      status: 400,
      body: { code: "invalid_request" },
    });
    expect(storedFacts(f)).toEqual(before);
    expect(success.executor.prepareCalls).toHaveLength(1);
    expect(success.executor.authorizeCalls).toHaveLength(1);
    expect(success.executor.launchCalls).toHaveLength(1);
    expect(committed).toBe(1);
  });

  it("keeps authentication, ownership and real queued, failed and cancelled result guards", async () => {
    const f = await fixture();
    const success = await succeed(f);
    const values = privateValues(f, success);
    const base = `/v1/enhancement-jobs/${success.succeeded.jobId}`;
    expectError(
      await requestBinary(f, `${base}/result`, {}),
      401,
      "authentication_failed",
      values,
    );
    expectError(
      await requestBinary(f, `${base}/result`, [
        "Authorization",
        f.auth(),
        "authorization",
        f.auth(),
      ]),
      401,
      "authentication_failed",
      values,
    );
    expectError(
      await requestBinary(f, "/v1/enhancement-jobs/missing/result"),
      404,
      "job_not_found",
      values,
    );
    const other = createClient(f.storage.store);
    expectError(
      await requestBinary(f, `${base}/result`, {
        authorization: `Bearer ${other.key}`,
      }),
      404,
      "job_not_found",
      [...values, other.key],
    );

    const acceptedFailure = await f.upload(
      success.bytes,
      "result-http-to-fail",
    );
    expect(acceptedFailure.status).toBe(202);
    const queued = jobOf(acceptedFailure);
    expect(queued.status).toBe("queued");
    expectError(
      await requestBinary(f, `/v1/enhancement-jobs/${queued.jobId}/result`),
      409,
      "result_not_ready",
      values,
    );
    await success.runner.wake();
    const failedAttempt = success.executor.launchCalls.find(
      (attempt) => attempt.identity.jobId === queued.jobId,
    );
    assert.ok(failedAttempt);
    success.executor.emit(
      completionExit(failedAttempt, {
        kind: "failure",
        exitCode: 7,
        signal: null,
      }),
    );
    await success.runner.wake();
    expect(
      jobOf(await f.call("GET", `/v1/enhancement-jobs/${queued.jobId}`)),
    ).toMatchObject({ status: "failed", result: null });
    expectError(
      await requestBinary(f, `/v1/enhancement-jobs/${queued.jobId}/result`),
      409,
      "result_not_ready",
      [...values, failedAttempt.launchTicket, failedAttempt.outputPath],
    );

    const acceptedCancellation = await f.upload(
      success.bytes,
      "result-http-to-cancel",
    );
    expect(acceptedCancellation.status).toBe(202);
    const cancelled = jobOf(acceptedCancellation);
    expect(cancelled.status).toBe("queued");
    const cancellation = await f.call(
      "DELETE",
      `/v1/enhancement-jobs/${cancelled.jobId}`,
    );
    expect(cancellation.status).toBe(200);
    expect(jobOf(cancellation)).toMatchObject({
      status: "cancelled",
      result: null,
    });
    expectError(
      await requestBinary(f, `/v1/enhancement-jobs/${cancelled.jobId}/result`),
      409,
      "result_not_ready",
      values,
    );
    expect(jobOf(await f.call("GET", base))).toEqual(success.succeeded);
    expect(await f.call("POST", `${base}/receipt`)).toMatchObject({
      status: 400,
      body: { code: "invalid_request" },
    });
    expect(success.executor.prepareCalls).toHaveLength(2);
    expect(success.executor.authorizeCalls).toHaveLength(2);
    expect(success.executor.launchCalls).toHaveLength(2);
  });

  for (const corruption of [
    "PNG bytes",
    "manifest bytes",
    "missing PNG",
  ] as const) {
    it(`returns a private 503 for ${corruption} without fallback or mutating succeeded`, async () => {
      let committed = 0;
      const f = await fixture({
        onJobCommitted() {
          committed++;
        },
      });
      const success = await succeed(f);
      const directory = join(
        f.storage.directory,
        "attempts",
        success.facts.candidates[0]!.directory,
      );
      const pngPath = join(directory, "artifact.png");
      const manifestPath = join(directory, "manifest.json");
      expect(await readFile(pngPath)).toEqual(success.png);
      const manifest = await readFile(manifestPath);
      if (corruption === "PNG bytes") {
        const tampered = Buffer.from(success.png);
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
        expect(tampered.length).toBe(success.png.length);
        await writeActualFile(pngPath, tampered, false);
      } else if (corruption === "manifest bytes") {
        // Valid JSON with different bytes must still fail the durable manifest seal.
        await writeActualFile(
          manifestPath,
          Buffer.concat([manifest, Buffer.from("\n")]),
          false,
        );
      } else {
        await unlink(pngPath);
      }
      const before = storedFacts(f);
      const beforeLedger = downloadLedger(f);
      const base = `/v1/enhancement-jobs/${success.succeeded.jobId}`;
      const response = await requestBinary(f, `${base}/result`);
      expectError(response, 503, "internal_error", privateValues(f, success));
      const reference = expectRecoveryReference(
        f,
        success,
        beforeLedger,
        "candidate_integrity",
      );
      noPrivateValues(response, [
        reference.reference_id,
        reference.incarnation_id,
      ]);
      expect(response.bytes.includes(success.png)).toBe(false);
      expect(jobOf(await f.call("GET", base))).toEqual(success.succeeded);
      expect(storedFacts(f)).toEqual(before);
      expect(success.executor.prepareCalls).toHaveLength(1);
      expect(success.executor.authorizeCalls).toHaveLength(1);
      expect(success.executor.launchCalls).toHaveLength(1);
      expect(committed).toBe(1);
    });
  }
});
