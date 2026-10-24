import assert from "node:assert/strict";
import {
  request,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http";

import { expect } from "vitest";

import { createRunner } from "../src/runner.js";
import { nativePng, writeActualFile } from "./artifact-fixtures.js";
import { nativeResult } from "./artifact-runner-fixtures.js";
import { completionExit } from "./completion-fixtures.js";
import { httpFixture, jobOf } from "./http-fixtures.js";
import { manualClock, snapshot } from "./lifecycle-fixtures.js";
import { recoveryExecutor } from "./recovery-fixtures.js";
import { sourceImage } from "./storage-fixtures.js";

export type ResultHttpFixture = Awaited<ReturnType<typeof httpFixture>>;

export async function succeededThroughRunner(
  f: ResultHttpFixture,
  registerCleanup: (cleanup: () => Promise<void>) => void,
) {
  const bytes = await sourceImage();
  const accepted = await f.upload(bytes, "artifact-http-first");
  expect(accepted.status).toBe(202);
  const original = jobOf(accepted);
  const clock = manualClock(f.storage);
  const executor = recoveryExecutor();
  const runner = createRunner({
    store: f.storage.store,
    clock: clock.clock,
    executor: executor.adapter,
    ownerInstanceId: "artifact-http-runner",
  });
  registerCleanup(() => runner.close());
  await runner.wake();
  const attempt = executor.launchCalls[0];
  assert.ok(attempt);
  expect(attempt.identity.jobId).toBe(original.jobId);
  const png = await nativePng(attempt);
  await writeActualFile(attempt.outputPath, png);
  const exit = completionExit(attempt, {
    kind: "success",
    exitCode: 0,
    signal: null,
  });
  executor.emit(exit);
  await runner.wake();
  const succeeded = f.storage.store.getOwned(
    f.storage.principal(),
    original.jobId,
  );
  expect(succeeded).toMatchObject({
    status: "succeeded",
    reason: null,
    result: nativeResult(attempt, png),
  });
  const facts = snapshot(f.storage, (db) => ({
    attempts: db.prepare("SELECT * FROM attempts").all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
    candidates: db
      .prepare("SELECT candidate_id, directory, state FROM artifact_candidates")
      .all() as {
      candidate_id: string;
      directory: string;
      state: string;
    }[],
    references: db
      .prepare(
        "SELECT reference_id, purpose, released_at FROM artifact_references",
      )
      .all() as {
      reference_id: string;
      purpose: string;
      released_at: number | null;
    }[],
  }));
  expect(facts.attempts).toHaveLength(1);
  expect(facts.attempts[0]).toMatchObject({
    producer_identity_json: JSON.stringify(attempt.identity),
    exit_json: JSON.stringify(exit),
  });
  expect(facts.slot).toEqual([]);
  expect(facts.candidates).toEqual([
    expect.objectContaining({ state: "durable" }),
  ]);
  expect(facts.references).toEqual([
    expect.objectContaining({ purpose: "run", released_at: 1_000 }),
  ]);
  expect(executor.prepareCalls).toHaveLength(1);
  expect(executor.authorizeCalls).toHaveLength(1);
  return { bytes, original, succeeded, png, attempt, runner, executor, facts };
}

export type BinaryHttpResult = Readonly<{
  status: number;
  headers: IncomingHttpHeaders;
  bytes: Buffer;
}>;

export function requestBinary(
  f: ResultHttpFixture,
  path: string,
  headers: OutgoingHttpHeaders | readonly string[] = {
    authorization: f.auth(),
  },
): Promise<BinaryHttpResult> {
  const address = f.server.address();
  assert.ok(address && typeof address !== "string");
  const hostHeaders =
    Array.isArray(headers) &&
    !headers.some(
      (value, index) => index % 2 === 0 && value.toLowerCase() === "host",
    )
      ? [...headers, "Host", `127.0.0.1:${address.port}`]
      : headers;
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: address.port,
      method: "GET",
      path,
      headers: hostHeaders,
      agent: false,
    });
    req.once("error", reject);
    req.once("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("error", reject);
      res.once("aborted", () => reject(new Error("binary response aborted")));
      res.once("end", () => {
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          bytes: Buffer.concat(chunks),
        });
      });
    });
    req.end();
  });
}
