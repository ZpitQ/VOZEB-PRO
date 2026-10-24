import assert from "node:assert/strict";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import { createClient, revokeCredential } from "../src/credentials.js";
import type { JobDto } from "../src/store.js";
import { nativeResult } from "./artifact-runner-fixtures.js";
import { configInput } from "./fixtures.js";
import {
  httpFixture,
  jobOf,
  transportLimits,
  type HttpResult,
} from "./http-fixtures.js";
import {
  requestBinary,
  succeededThroughRunner,
} from "./result-http-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const f = await httpFixture();
  cleanups.push(() => f.cleanup());
  return f;
}

function safeSucceededDto(
  result: HttpResult,
  expected: JobDto,
  privateValues: readonly string[],
) {
  const job = jobOf(result);
  expect(job).toEqual(expected);
  expect(Object.keys(job).sort()).toEqual([
    "cancelRequested",
    "clientId",
    "completedAt",
    "createdAt",
    "engineInput",
    "jobId",
    "plan",
    "queueDeadlineAt",
    "reason",
    "result",
    "serviceId",
    "source",
    "status",
  ]);
  assert.ok(job.result);
  expect(Object.keys(job.result).sort()).toEqual([
    "byteLength",
    "format",
    "height",
    "sha256",
    "width",
  ]);
  for (const value of [
    ...privateValues,
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
  ])
    expect(result.raw).not.toContain(value);
}

describe("HTTP consumes the real runner succeeded DTO", () => {
  it("returns one safe succeeded DTO for GET, frozen replay and late cancellation across not-ready and restart", async () => {
    const f = await fixture();
    const success = await succeededThroughRunner(f, (cleanup) =>
      cleanups.push(cleanup),
    );
    const { succeeded, original, attempt, facts } = success;
    const base = `/v1/enhancement-jobs/${succeeded.jobId}`;
    const privateValues = [
      f.storage.directory,
      f.storage.initialized.credential.key,
      attempt.identity.ownerInstanceId,
      attempt.launchTicket,
      attempt.inputPath,
      attempt.outputPath,
      attempt.workingDirectory,
      facts.candidates[0]!.candidate_id,
      facts.candidates[0]!.directory,
      facts.references[0]!.reference_id,
    ];
    const fetched = await f.call("GET", base);
    expect(fetched.status).toBe(200);
    safeSucceededDto(fetched, succeeded, privateValues);
    expect(jobOf(fetched)).toMatchObject({
      source: original.source,
      engineInput: original.engineInput,
      plan: original.plan,
    });
    expect(jobOf(fetched).result).toEqual(nativeResult(attempt, success.png));
    expect(jobOf(fetched).result!.width).not.toBe(original.plan.target.width);

    expect(
      (await f.upload(success.bytes, "artifact-http-waiting-a")).status,
    ).toBe(202);
    expect(
      (await f.upload(success.bytes, "artifact-http-waiting-b")).status,
    ).toBe(202);
    expect(
      await f.upload(success.bytes, "artifact-http-over-capacity"),
    ).toMatchObject({ status: 429, body: { code: "queue_full" } });
    const changed = configInput();
    changed.budgets.input.maxBytes = 1;
    changed.budgets.input.maxPixels = 1;
    changed.models[0]!.binarySha256 = "e".repeat(64);
    changed.models[0]!.defaultTile = 128;
    f.setConfig(createWorkerConfig(changed));
    f.setReady(false);
    const replay = await f.upload(success.bytes, "artifact-http-first");
    expect(replay).toMatchObject({
      status: 202,
      body: { data: { replayed: true } },
    });
    safeSucceededDto(replay, succeeded, privateValues);
    const cancelled = await f.call("DELETE", base);
    expect(cancelled).toMatchObject({
      status: 200,
      body: { data: { applied: false } },
    });
    safeSucceededDto(cancelled, succeeded, privateValues);
    await success.runner.close();
    await f.restart();
    const reopened = await f.call("GET", base);
    expect(reopened.status).toBe(200);
    safeSucceededDto(reopened, succeeded, privateValues);
    const replayedAgain = await f.upload(success.bytes, "artifact-http-first");
    expect(replayedAgain).toMatchObject({
      status: 202,
      body: { data: { replayed: true } },
    });
    safeSucceededDto(replayedAgain, succeeded, privateValues);
    expect(success.executor.launchCalls).toHaveLength(1);
  });

  it("returns a succeeded result PNG and rejects an empty receipt while keeping real non-success 409 and ownership 404 guards", async () => {
    const f = await fixture();
    const success = await succeededThroughRunner(f, (cleanup) =>
      cleanups.push(cleanup),
    );
    const waiting = await f.upload(success.bytes, "artifact-http-still-queued");
    expect(waiting.status).toBe(202);
    expect(jobOf(waiting)).toMatchObject({ status: "queued", result: null });
    const other = createClient(f.storage.store);
    const base = `/v1/enhancement-jobs/${success.succeeded.jobId}`;
    for (const [method, suffix] of [
      ["GET", "/result"],
      ["POST", "/receipt"],
    ] as const) {
      if (suffix === "/result") {
        const downloaded = await requestBinary(f, `${base}${suffix}`);
        expect(downloaded.status).toBe(200);
        expect(downloaded.headers["content-type"]).toBe("image/png");
        expect(downloaded.bytes).toEqual(success.png);
      } else {
        const unavailable = await f.call(method, `${base}${suffix}`);
        expect(unavailable).toMatchObject({
          status: 400,
          body: {
            code: "invalid_request",
            data: { requestId: expect.any(String) },
          },
        });
        expect(unavailable.raw).not.toContain(f.storage.directory);
        expect(unavailable.raw).not.toContain(success.attempt.launchTicket);
        expect(unavailable.raw).not.toContain(
          success.facts.candidates[0]!.candidate_id,
        );
      }
      expect(
        await f.call(
          method,
          `/v1/enhancement-jobs/${jobOf(waiting).jobId}${suffix}`,
        ),
      ).toMatchObject({ status: 409, body: { code: "result_not_ready" } });
      expect(
        await f.call(method, `/v1/enhancement-jobs/missing${suffix}`),
      ).toMatchObject({ status: 404, body: { code: "job_not_found" } });
      expect(
        await f.call(method, `${base}${suffix}`, undefined, {
          authorization: `Bearer ${other.key}`,
        }),
      ).toMatchObject({ status: 404, body: { code: "job_not_found" } });
    }
    expect(jobOf(await f.call("GET", base))).toEqual(success.succeeded);
    expect((await f.call("DELETE", base)).body.data.applied).toBe(false);
    expect(success.executor.launchCalls).toHaveLength(1);
  });
});

describe("HTTP final result boundaries", () => {
  it.each(["credential", "store"] as const)(
    "rejects delivery when the unread-input pause synchronously retires the %s",
    async (mode) => {
      const f = await fixture();
      const success = await succeededThroughRunner(f, (cleanup) =>
        cleanups.push(cleanup),
      );
      const principal = f.storage.principal();
      const path = `/v1/enhancement-jobs/${success.succeeded.jobId}/result`;
      let retirements = 0;
      f.server.prependListener("request", (request) => {
        if (request.url !== path) return;
        request.once("pause", () => {
          retirements++;
          if (mode === "credential")
            revokeCredential(f.storage.store, principal.credentialId);
          else f.storage.store.close();
        });
      });
      const response = await requestBinary(f, path, {
        authorization: f.auth(),
        // End the client writer without satisfying the declared request body.
        "content-length": 1,
      });
      expect(retirements).toBe(1);
      expect(response.status).toBe(mode === "credential" ? 401 : 503);
      expect(response.headers["content-type"]).toMatch(
        /^application\/json(?:;|$)/,
      );
      expect(JSON.parse(response.bytes.toString("utf8"))).toMatchObject({
        code:
          mode === "credential" ? "authentication_failed" : "internal_error",
        data: { requestId: expect.any(String) },
      });
      expect(response.bytes.includes(success.png)).toBe(false);
    },
  );

  it("returns a complete 408 when the configured download timer fires during start", async () => {
    const deadlines: number[] = [];
    let cancellations = 0;
    const f = await httpFixture({
      downloadTimer: {
        start(callback, milliseconds) {
          deadlines.push(milliseconds);
          callback();
          return () => {
            cancellations++;
          };
        },
      },
    });
    cleanups.push(() => f.cleanup());
    const success = await succeededThroughRunner(f, (cleanup) =>
      cleanups.push(cleanup),
    );
    const response = await requestBinary(
      f,
      `/v1/enhancement-jobs/${success.succeeded.jobId}/result`,
    );
    expect(response.status).toBe(408);
    expect(JSON.parse(response.bytes.toString("utf8"))).toMatchObject({
      code: "download_timeout",
      data: { requestId: expect.any(String) },
    });
    expect(response.bytes.includes(success.png)).toBe(false);
    expect(deadlines).toEqual([transportLimits.requestTimeoutMs]);
    expect(cancellations).toBe(1);
  });
});
