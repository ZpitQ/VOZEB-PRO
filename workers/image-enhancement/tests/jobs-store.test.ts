import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import { toErrorResponse } from "../src/contracts.js";
import { createJobService, localInputFiles } from "../src/jobs.js";
import { openStore } from "../src/store.js";
import { configInput } from "./fixtures.js";
import {
  recursiveFiles,
  runnerLimits,
  sha256,
  sourceImage,
  storageFixture,
  submission,
  submissionLimits,
} from "./storage-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const f = await storageFixture();
  cleanups.push(() => f.cleanup());
  return f;
}
async function inputs(directory: string) {
  return (await readdir(join(directory, "inputs"))).sort();
}

describe("durable immutable submissions", () => {
  it("registers original bytes and an independent upright engine PNG before accepting", async () => {
    const f = await fixture();
    const source = await sharp(await sourceImage())
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const request = submission(source);
    request.plan.target = { width: 9, height: 12, format: "png" };
    const accepted = await f.service().submit(f.principal(), request);
    expect(accepted.replayed).toBe(false);
    expect(accepted.job).toMatchObject({
      serviceId: f.store.identity.serviceId,
      clientId: f.initialized.credential.clientId,
      status: "queued",
      reason: null,
      createdAt: 1_000,
      queueDeadlineAt: 31_000,
      completedAt: null,
      source: {
        format: "jpeg",
        width: 3,
        height: 4,
        encodedWidth: 4,
        encodedHeight: 3,
        orientation: 6,
        sha256: sha256(source),
        byteLength: source.length,
      },
      engineInput: {
        format: "png",
        width: 3,
        height: 4,
        normalizationProfile: "srgb-upright-v1",
      },
    });
    const path = join(f.directory, "inputs", accepted.job.jobId);
    expect(await readFile(join(path, "original.jpeg"))).toEqual(source);
    const engine = await readFile(join(path, "engine.png"));
    const decoded = await sharp(engine)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 3, height: 4, channels: 3 });
    expect(accepted.job.engineInput.sha256).toBe(sha256(engine));
    expect(accepted.job.engineInput.byteLength).toBe(engine.length);
    expect(JSON.stringify(accepted)).not.toContain(f.directory);
    expect(JSON.stringify(accepted)).not.toContain("key_digest");
    expect(Object.isFrozen(accepted.job.plan.engine)).toBe(true);
    f.store.close();
    f.setStore(openStore({ directory: f.directory, clock: f.clock }));
    expect(f.service().get(f.principal(), accepted.job.jobId)).toEqual(
      accepted.job,
    );
    expect(await f.service().submit(f.principal(), request)).toEqual({
      job: accepted.job,
      replayed: true,
    });
  });

  it("concurrent matching submissions and a lost response register exactly one immutable input set", async () => {
    const f = await fixture();
    const request = submission(await sourceImage());
    const [a, b] = await Promise.all([
      f.service().submit(f.principal(), request),
      f.service().submit(f.principal(), request),
    ]);
    expect(a.job.jobId).toBe(b.job.jobId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await inputs(f.directory)).toEqual([a.job.jobId]);
    expect(await recursiveFiles(join(f.directory, "inputs"))).toHaveLength(2);
    expect((await f.service().submit(f.principal(), request)).job).toEqual(
      a.job,
    );
    f.store.close();
    const db = new Database(join(f.directory, "worker.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
      count: 1,
    });
    expect(() =>
      db.prepare("INSERT INTO jobs SELECT * FROM jobs").run(),
    ).toThrow();
    db.close();
  });

  it("replays before readiness or capacity checks and never requeues a cancelled terminal task", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const firstRequest = submission(bytes);
    const first = await f.service().submit(f.principal(), firstRequest);
    await f.service().submit(f.principal(), submission(bytes, "request-2"));
    await expect(
      f.service().submit(f.principal(), submission(bytes, "request-3")),
    ).rejects.toMatchObject({ code: "queue_full", status: 429 });
    expect((await f.service().submit(f.principal(), firstRequest)).job).toEqual(
      first.job,
    );
    f.setReady(false);
    expect(
      (await f.service().submit(f.principal(), firstRequest)).replayed,
    ).toBe(true);
    await expect(
      f.service().submit(f.principal(), submission(bytes, "request-4")),
    ).rejects.toMatchObject({ code: "not_ready", status: 503 });
    f.setNow(7_000);
    const outcome = f.service().cancel(f.principal(), first.job.jobId);
    expect(outcome).toMatchObject({ status: 200, applied: true });
    const cancelled = outcome.job;
    expect(cancelled).toMatchObject({
      status: "cancelled",
      reason: "user_cancel",
      completedAt: 7_000,
    });
    expect(f.service().cancel(f.principal(), first.job.jobId)).toEqual({
      job: cancelled,
      status: 200,
      applied: false,
    });
    expect(await f.service().submit(f.principal(), firstRequest)).toEqual({
      job: cancelled,
      replayed: true,
    });
    expect(await inputs(f.directory)).toHaveLength(2);
  });

  it.each(["target", "model", "tile", "source"] as const)(
    "returns 409 for a changed %s without replacing an accepted task",
    async (change) => {
      const f = await fixture();
      const request = submission(await sourceImage());
      const accepted = await f.service().submit(f.principal(), request);
      const changed = structuredClone(request);
      changed.sourceBytes = Buffer.from(changed.sourceBytes);
      if (change === "target")
        changed.plan.target = { width: 16, height: 12, format: "png" };
      if (change === "model") changed.plan.modelId = "another-valid-model";
      if (change === "tile") changed.plan.tile = 128;
      if (change === "source") {
        changed.sourceBytes = await sourceImage("blue");
        changed.plan.sourceSha256 = sha256(changed.sourceBytes);
      }
      f.setReady(false);
      await expect(
        f.service().submit(f.principal(), changed),
      ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
      expect(f.service().get(f.principal(), accepted.job.jobId)).toEqual(
        accepted.job,
      );
      expect(await inputs(f.directory)).toEqual([accepted.job.jobId]);
    },
  );

  it("canonicalizes object order, SHA case and explicit selection of the frozen default tile", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const request = submission(bytes);
    const { tile: _tile, ...withoutTile } = request.plan;
    const first = await f
      .service()
      .submit(f.principal(), { ...request, plan: withoutTile });
    const reordered = {
      tile: 256,
      modelId: request.plan.modelId,
      normalizationProfile: request.plan.normalizationProfile,
      target: { format: "png", height: 9, width: 12 },
      sourceSha256: request.plan.sourceSha256.toUpperCase(),
      scope: request.plan.scope,
      protocolVersion: request.plan.protocolVersion,
    };
    expect(
      await f.service().submit(f.principal(), { ...request, plan: reordered }),
    ).toEqual({ job: first.job, replayed: true });
  });

  it("uses frozen engine and budgets for old requests, while new jobs use current settings", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const request = submission(bytes);
    const first = await f.service().submit(f.principal(), request);
    const engineBefore = await readFile(
      join(f.directory, "inputs", first.job.jobId, "engine.png"),
    );
    const next = configInput();
    next.models[0]!.binaryVersion = "fixture-binary-v2";
    next.models[0]!.binarySha256 = "d".repeat(64);
    next.models[0]!.modelVersion = "fixture-model-v2";
    next.models[0]!.modelSha256 = "e".repeat(64);
    next.models[0]!.defaultTile = 128;
    next.budgets.input.maxPixels = 1;
    f.setConfig(createWorkerConfig(next));
    expect((await f.service().submit(f.principal(), request)).job.plan).toEqual(
      first.job.plan,
    );
    expect(
      await readFile(
        join(f.directory, "inputs", first.job.jobId, "engine.png"),
      ),
    ).toEqual(engineBefore);
    await expect(
      f.service().submit(f.principal(), submission(bytes, "new-under-budget")),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    next.budgets.input.maxPixels = 40_000_000;
    f.setConfig(createWorkerConfig(next));
    const { tile: _tile, ...defaultTilePlan } = request.plan;
    const second = await f.service().submit(f.principal(), {
      ...request,
      idempotencyKey: "new-with-config",
      plan: defaultTilePlan,
    });
    expect(second.job.plan.engine).toMatchObject({
      binaryVersion: "fixture-binary-v2",
      modelVersion: "fixture-model-v2",
      tile: 128,
    });
    expect(second.job.plan.planFingerprint).not.toBe(
      first.job.plan.planFingerprint,
    );
  });

  it.each([
    "",
    " ",
    "bad\nkey",
    "bad\tkey",
    "bad\u007fkey",
    "非ASCII",
    "x".repeat(129),
  ])(
    "rejects unsafe or over-budget idempotency keys %#",
    async (idempotencyKey) => {
      const f = await fixture();
      await expect(
        f
          .service()
          .submit(
            f.principal(),
            submission(await sourceImage(), idempotencyKey),
          ),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(await inputs(f.directory)).toHaveLength(0);
    },
  );

  it("accepts the configured exact maximum key length", async () => {
    const f = await fixture();
    expect(
      (
        await f
          .service()
          .submit(
            f.principal(),
            submission(
              await sourceImage(),
              "x".repeat(submissionLimits.maxIdempotencyKeyLength),
            ),
          )
      ).job.status,
    ).toBe("queued");
  });

  it.each([
    (request: ReturnType<typeof submission>) => ({
      ...request,
      path: "untrusted.png",
    }),
    (request: ReturnType<typeof submission>) => ({
      ...request,
      plan: { ...request.plan, scope: "masked" },
    }),
    (request: ReturnType<typeof submission>) => ({
      ...request,
      plan: { ...request.plan, tile: -1 },
    }),
    (request: ReturnType<typeof submission>) => ({
      ...request,
      plan: {
        ...request.plan,
        target: { ...request.plan.target, width: "12" },
      },
    }),
    (request: ReturnType<typeof submission>) => ({
      ...request,
      plan: { ...request.plan, sourceSha256: "bad" },
    }),
    (request: ReturnType<typeof submission>) => ({
      ...request,
      plan: { ...request.plan, sourceUrl: "file:///untrusted" },
    }),
  ])(
    "strictly validates malformed inputs even when the key already exists %#",
    async (change) => {
      const f = await fixture();
      const request = submission(await sourceImage());
      await f.service().submit(f.principal(), request);
      await expect(
        f.service().submit(f.principal(), change(request)),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^invalid_(request|plan)$/),
      });
    },
  );

  it("checks the actual source digest before matching a recorded plan", async () => {
    const f = await fixture();
    const request = submission(await sourceImage());
    await f.service().submit(f.principal(), request);
    await expect(
      f.service().submit(f.principal(), {
        ...request,
        sourceBytes: await sourceImage("blue"),
      }),
    ).rejects.toMatchObject({ code: "input_digest_mismatch" });
  });

  it.each(["write", "rename"] as const)(
    "does not accept after a real file-stage %s failure or clean another job",
    async (stage) => {
      const f = await fixture();
      const bytes = await sourceImage();
      const first = await f.service().submit(f.principal(), submission(bytes));
      const firstFile = join(
        f.directory,
        "inputs",
        first.job.jobId,
        "original.jpeg",
      );
      const failingFiles = {
        ...localInputFiles,
        [stage]: async () => {
          throw Object.assign(new Error("private filesystem failure"), {
            code: "EIO",
          });
        },
      };
      const service = createJobService({
        store: f.store,
        config: () => createWorkerConfig(configInput()),
        ready: () => true,
        limits: submissionLimits,
        runnerLimits,
        files: failingFiles,
      });
      let failure: unknown;
      try {
        await service.submit(
          f.principal(),
          submission(bytes, `failed-${stage}`),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "internal_error", status: 503 });
      expect(
        JSON.stringify(toErrorResponse(failure, "fixture-request")),
      ).not.toContain("private filesystem");
      expect(await inputs(f.directory)).toEqual([first.job.jobId]);
      expect(await readFile(firstFile)).toEqual(bytes);
      expect(
        (
          await f
            .service()
            .submit(f.principal(), submission(bytes, `failed-${stage}`))
        ).replayed,
      ).toBe(false);
    },
  );

  it.each(["insert", "commit"] as const)(
    "rolls back real SQLite %s failures without accepting or deleting existing inputs",
    async (stage) => {
      const f = await fixture();
      const bytes = await sourceImage();
      const first = await f.service().submit(f.principal(), submission(bytes));
      f.store.close();
      const db = new Database(join(f.directory, "worker.sqlite"));
      db.pragma("foreign_keys = ON");
      if (stage === "insert") {
        db.exec(
          "CREATE TRIGGER injected_failure BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END",
        );
      } else {
        db.exec(
          "CREATE TABLE commit_fault (client_id TEXT REFERENCES clients(client_id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER injected_failure AFTER INSERT ON jobs BEGIN INSERT INTO commit_fault VALUES ('nonexistent-client'); END",
        );
      }
      db.close();
      f.setStore(openStore({ directory: f.directory, clock: f.clock }));
      await expect(
        f.service().submit(f.principal(), submission(bytes, `failed-${stage}`)),
      ).rejects.toMatchObject({ code: "internal_error" });
      expect(await inputs(f.directory)).toEqual([first.job.jobId]);
      expect(
        await readFile(
          join(f.directory, "inputs", first.job.jobId, "original.jpeg"),
        ),
      ).toEqual(bytes);
      f.store.close();
      const check = new Database(join(f.directory, "worker.sqlite"));
      expect(check.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual(
        { count: 1 },
      );
      check.exec("DROP TRIGGER injected_failure");
      check.close();
      f.setStore(openStore({ directory: f.directory, clock: f.clock }));
      expect(
        (
          await f
            .service()
            .submit(f.principal(), submission(bytes, `failed-${stage}`))
        ).replayed,
      ).toBe(false);
    },
  );
});
