import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { createWorkerConfig } from "../src/config.js";
import { normalizePlan } from "../src/contracts.js";
import { configInput, planInput } from "./fixtures.js";
import {
  boundary,
  httpFixture,
  jobOf,
  multipart,
  transportLimits,
  uploadParts,
  type Part,
} from "./http-fixtures.js";
import { sha256, sourceImage } from "./storage-fixtures.js";
import { descriptor, snapshot, treeExit } from "./lifecycle-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(...args: Parameters<typeof httpFixture>) {
  const f = await httpFixture(...args);
  cleanups.push(() => f.cleanup());
  return f;
}

describe("bounded raw multipart submission over TCP", () => {
  it("returns fixed persisted timing facts from read-only GETs and the reopened HTTP service", async () => {
    const f = await fixture();
    const accepted = jobOf(await f.upload(await sourceImage(), "timing-http"));
    const path = `/v1/enhancement-jobs/${accepted.jobId}`;
    expect(jobOf(await f.call("GET", path))).not.toHaveProperty("timings");
    f.storage.setNow(1_400);
    const attempt = f.storage.store.claimNext("timing-http-owner")!;
    const owner = descriptor(attempt);
    expect(f.storage.store.registerPrepared(attempt.identity, owner)).toBe(true);
    expect(jobOf(await f.call("GET", path))).toMatchObject({ timings: { workerQueueMs: 400 } });
    expect(jobOf(await f.call("GET", path))).not.toHaveProperty("timings.workerExecutionMs");
    f.storage.setNow(1_600);
    expect(f.storage.store.authorizeLaunch(attempt.identity, owner)).toBe(true);
    f.storage.setNow(2_100);
    expect(f.storage.store.registerExit({ ...treeExit(attempt), completion: { kind: "failure", exitCode: 7, signal: null } })).toBe(true);
    expect(f.storage.store.finishFailed(attempt.identity)).toBe(true);
    const finished = jobOf(await f.call("GET", path));
    expect(finished).toMatchObject({ status: "failed", timings: { workerQueueMs: 400, workerExecutionMs: 500 } });
    const rows = () => snapshot(f.storage, (db) => ({
      job: db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(accepted.jobId),
      attempt: db.prepare("SELECT * FROM attempts WHERE job_id = ?").all(accepted.jobId),
    }));
    const before = rows();
    f.storage.setNow(4_000);
    expect(jobOf(await f.call("GET", path))).toEqual(finished);
    expect(rows()).toEqual(before);
    await f.restart();
    expect(jobOf(await f.call("GET", path))).toEqual(finished);
    expect(rows()).toEqual(before);
  });
  it("advertises strategy binding and refuses mismatches without creating input files", async () => {
    const f = await fixture();
    const capabilities = await f.call("GET", "/v1/capabilities");
    expect(capabilities.body.data).toMatchObject({ features: { expectedStrategyFingerprint: true } });
    const bytes = await sourceImage();
    const plan = { ...planInput(sha256(bytes)), expectedStrategyFingerprint: "0".repeat(64) };
    expect(await f.upload(bytes, "frozen-mismatch", uploadParts(bytes, {}, plan))).toMatchObject({ status: 409, body: { code: "strategy_mismatch" } });
    expect(await f.inputNames()).toEqual([]);
  });
  it("replays an accepted constrained job after configuration changes and rejects a different constraint", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const input = planInput(sha256(bytes));
    const expectedStrategyFingerprint = normalizePlan(input, createWorkerConfig(configInput())).strategyFingerprint;
    const plan = { ...input, expectedStrategyFingerprint };
    const first = await f.upload(bytes, "frozen-replay", uploadParts(bytes, {}, plan));
    expect(first.status).toBe(202);
    const changed = configInput();
    changed.models[0]!.modelSha256 = "e".repeat(64);
    f.setConfig(createWorkerConfig(changed));
    const replay = await f.upload(bytes, "frozen-replay", uploadParts(bytes, {}, plan));
    expect(replay).toMatchObject({ status: 202, body: { data: { replayed: true, job: { jobId: jobOf(first).jobId } } } });
    const conflict = { ...plan, expectedStrategyFingerprint: "0".repeat(64) };
    expect(await f.upload(bytes, "frozen-replay", uploadParts(bytes, {}, conflict))).toMatchObject({ status: 409, body: { code: "idempotency_conflict" } });
    expect(await f.inputNames()).toEqual([jobOf(first).jobId]);
  });
  it.each(["jpeg-plan-first", "png-image-first"])(
    "accepts %s with chunked boundaries and preserves exact original bytes",
    async (kind) => {
      const f = await fixture();
      const bytes = kind.startsWith("png")
        ? await sharp(await sourceImage())
            .png()
            .toBuffer()
        : await sourceImage();
      const parts = uploadParts(
        bytes,
        kind.startsWith("png") ? { type: "image/png" } : {},
      );
      if (kind.startsWith("png")) parts.reverse();
      const result = await f.upload(bytes, "legal-chunked", parts, true);
      expect(result.status).toBe(202);
      expect(result.body.data.replayed).toBe(false);
      const job = jobOf(result);
      expect(job).toMatchObject({
        status: "queued",
        source: {
          sha256: sha256(bytes),
          byteLength: bytes.length,
          width: 4,
          height: 3,
        },
      });
      expect(await f.original(job)).toEqual(bytes);
      expect(await f.inputNames()).toEqual([job.jobId]);
      expect(
        (await f.call("GET", `/v1/enhancement-jobs/${job.jobId}/result`))
          .status,
      ).toBe(409);
    },
  );

  it("accepts an authenticated Expect upload only after 100 Continue", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const body = multipart(uploadParts(bytes));
    const connection = f.start("POST", "/v1/enhancement-jobs", {
      ...f.uploadHeaders(),
      expect: "100-continue",
      "content-length": body.length,
    });
    let continued = 0;
    connection.req.once("continue", () => {
      continued++;
      connection.req.end(body);
    });
    connection.req.flushHeaders();
    const result = await connection.result;
    expect(continued).toBe(1);
    expect(result.status).toBe(202);
    expect(await f.original(jobOf(result))).toEqual(bytes);
  });

  it.each([-1, 0, 1])(
    "enforces actual image bytes at configured boundary (actual minus limit = %s)",
    async (difference) => {
      const f = await fixture();
      const bytes = await sourceImage();
      const config = configInput();
      config.budgets.input.maxBytes = bytes.length - difference;
      f.setConfig(createWorkerConfig(config));
      const body = multipart(uploadParts(bytes));
      expect(body.length).toBeGreaterThan(config.budgets.input.maxBytes);
      const result = await f.upload(
        bytes,
        "file-boundary",
        uploadParts(bytes),
        true,
      );
      expect(result.status).toBe(difference > 0 ? 413 : 202);
      if (difference > 0) {
        expect(result.body.code).toBe("budget_exceeded");
        expect(await f.inputNames()).toEqual([]);
      } else expect(await f.original(jobOf(result))).toEqual(bytes);
    },
  );

  it.each([-1, 0, 1])(
    "enforces raw UTF-8 plan bytes at configured boundary (actual minus limit = %s)",
    async (difference) => {
      const f = await fixture();
      const bytes = await sourceImage();
      const parts = uploadParts(bytes);
      const text = parts[0]!.bytes.toString("utf8");
      parts[0] = {
        ...parts[0]!,
        bytes: Buffer.from(
          text.padEnd(transportLimits.maxPlanBytes + difference, " "),
        ),
      };
      const result = await f.upload(bytes, "plan-boundary", parts, true);
      expect(result.status).toBe(difference > 0 ? 413 : 202);
      if (difference > 0) expect(result.body.code).toBe("budget_exceeded");
    },
  );

  it("counts multibyte plan bytes before parsing and rejects malformed UTF-8 without replacement", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const parts = uploadParts(bytes);
    const unicode = JSON.stringify({
      ...planInput(sha256(bytes)),
      modelId: "é".repeat(9_000),
    });
    expect(unicode.length).toBeLessThan(transportLimits.maxPlanBytes);
    expect(Buffer.byteLength(unicode)).toBeGreaterThan(
      transportLimits.maxPlanBytes,
    );
    parts[0] = { ...parts[0]!, bytes: Buffer.from(unicode) };
    expect(await f.upload(bytes, "unicode-budget", parts, true)).toMatchObject({
      status: 413,
      body: { code: "budget_exceeded" },
    });
    const malformed = uploadParts(bytes);
    malformed[0] = {
      ...malformed[0]!,
      bytes: Buffer.concat([
        Buffer.from('{"modelId":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}'),
      ]),
    };
    expect(
      await f.upload(bytes, "invalid-utf8", malformed, true),
    ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    expect(await f.inputNames()).toEqual([]);
  });

  it.each([
    "missing-plan",
    "missing-image",
    "duplicate-plan",
    "duplicate-image",
    "unknown-part",
    "third-part",
    "plan-file",
    "image-field",
    "invalid-json",
    "missing-boundary",
    "truncated-boundary",
  ])(
    "rejects malformed multipart %s and leaves no accepted task or spool",
    async (kind) => {
      const f = await fixture();
      const bytes = await sourceImage();
      let parts: Part[] = uploadParts(bytes);
      if (kind === "missing-plan") parts = parts.slice(1);
      if (kind === "missing-image") parts = parts.slice(0, 1);
      if (kind === "duplicate-plan") parts = [parts[0]!, parts[0]!];
      if (kind === "duplicate-image") parts = [parts[1]!, parts[1]!];
      if (kind === "unknown-part")
        parts[0] = { ...parts[0]!, name: "unexpected" };
      if (kind === "third-part")
        parts.push({ name: "extra", bytes: Buffer.from("untrusted") });
      if (kind === "plan-file")
        parts[0] = { ...parts[0]!, filename: "plan.json" };
      if (kind === "image-field") {
        const { filename: _filename, ...field } = parts[1]!;
        parts[1] = field;
      }
      if (kind === "invalid-json")
        parts[0] = { ...parts[0]!, bytes: Buffer.from("{") };
      const headers = {
        ...f.uploadHeaders(kind),
        ...(kind === "missing-boundary"
          ? { "content-type": "multipart/form-data" }
          : {}),
      };
      const result = await f.call(
        "POST",
        "/v1/enhancement-jobs",
        multipart(parts, kind !== "truncated-boundary"),
        headers,
      );
      expect(result).toMatchObject({
        status: 400,
        body: { code: "invalid_request" },
      });
      expect(await f.inputNames()).toEqual([]);
      expect((await f.call("GET", "/healthz")).status).toBe(200);
    },
  );

  it.each(["request-json", "file-webp", "plan-binary", "transfer-base64"])(
    "rejects unsupported %s media before a durable submit",
    async (kind) => {
      const f = await fixture();
      const bytes = await sourceImage();
      const parts = uploadParts(bytes);
      if (kind === "file-webp") parts[1] = { ...parts[1]!, type: "image/webp" };
      if (kind === "plan-binary")
        parts[0] = { ...parts[0]!, type: "application/octet-stream" };
      if (kind === "transfer-base64")
        parts[1] = { ...parts[1]!, encoding: "base64" };
      const headers = {
        ...f.uploadHeaders(kind),
        ...(kind === "request-json"
          ? { "content-type": "application/json" }
          : {}),
      };
      expect(
        await f.call("POST", "/v1/enhancement-jobs", multipart(parts), headers),
      ).toMatchObject({
        status: 415,
        body: { code: "unsupported_media_type" },
      });
      expect(await f.inputNames()).toEqual([]);
    },
  );

  it.each(["missing", "duplicate", "space", "over-limit"])(
    "strictly rejects %s Idempotency-Key before upload directory creation",
    async (kind) => {
      const f = await fixture();
      const query = vi.spyOn(f.storage.store, "findByKey");
      const headers = f.uploadHeaders(
        kind === "space"
          ? "two words"
          : "x".repeat(kind === "over-limit" ? 129 : 1),
      );
      const { "idempotency-key": key, ...withoutKey } = headers;
      const duplicate = [
        "Authorization",
        f.auth(),
        "Content-Type",
        `multipart/form-data; boundary=${boundary}`,
        "Idempotency-Key",
        key,
        "idempotency-key",
        key,
      ];
      const result = await f.call(
        "POST",
        "/v1/enhancement-jobs",
        multipart(uploadParts(await sourceImage())),
        kind === "missing"
          ? withoutKey
          : kind === "duplicate"
            ? duplicate
            : headers,
      );
      expect(result).toMatchObject({
        status: 400,
        body: { code: "invalid_request" },
      });
      expect(query).not.toHaveBeenCalled();
      expect(await f.inputNames()).toEqual([]);
    },
  );

  it("limits measured multipart overhead and an oversized declared total independently of image bytes", async () => {
    const f = await fixture();
    const bytes = await sourceImage();
    const body = Buffer.concat([
      multipart(uploadParts(bytes)),
      Buffer.alloc(transportLimits.maxMultipartOverheadBytes + 1, "x"),
    ]);
    expect(
      await f.call(
        "POST",
        "/v1/enhancement-jobs",
        body,
        f.uploadHeaders("overhead"),
        true,
      ),
    ).toMatchObject({ status: 413, body: { code: "budget_exceeded" } });
    const connection = f.start("POST", "/v1/enhancement-jobs", {
      ...f.uploadHeaders("declared-total"),
      "content-length":
        f.config.budgets.input.maxBytes +
        transportLimits.maxPlanBytes +
        transportLimits.maxMultipartOverheadBytes +
        1,
    });
    connection.req.flushHeaders();
    expect(await connection.result).toMatchObject({
      status: 413,
      body: { code: "budget_exceeded" },
    });
    connection.req.destroy();
    expect(await f.inputNames()).toEqual([]);
    expect((await f.upload(bytes, "after-overhead")).status).toBe(202);
  });
});

describe("HTTP preserves content and policy error classifications", () => {
  it.each(["input-pixels", "ai-pixels", "delivery-pixels"])(
    "returns 413 for %s before accepting",
    async (layer) => {
      const f = await fixture();
      const input = configInput();
      if (layer === "input-pixels") input.budgets.input.maxPixels = 11;
      if (layer === "ai-pixels") input.budgets.ai.maxPixels = 191;
      if (layer === "delivery-pixels") input.budgets.delivery.maxPixels = 107;
      f.setConfig(createWorkerConfig(input));
      expect(await f.upload(await sourceImage())).toMatchObject({
        status: 413,
        body: { code: "budget_exceeded" },
      });
      expect(await f.inputNames()).toEqual([]);
    },
  );

  it.each([
    "bad-image",
    "fake-mime",
    "corrupt-idat",
    "digest",
    "transparency",
    "aspect",
    "target",
    "unknown-plan",
  ])("keeps %s errors safe and classified", async (kind) => {
    const f = await fixture();
    let bytes = await sourceImage();
    let expected = "invalid_image";
    if (kind === "bad-image")
      bytes = Buffer.from("private-invalid-image-content");
    if (kind === "fake-mime") {
      bytes = await sharp(bytes).webp().toBuffer();
      expected = "unsupported_media_type";
    }
    if (kind === "corrupt-idat") {
      bytes = await sharp(bytes).png().toBuffer();
      bytes.fill(
        0xff,
        bytes.indexOf(Buffer.from("IDAT")) + 4,
        bytes.length - 12,
      );
    }
    if (kind === "transparency") {
      bytes = await sharp({
        create: {
          width: 4,
          height: 3,
          channels: 4,
          background: { r: 10, g: 20, b: 30, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer();
      expected = "unsupported_transparency";
    }
    const plan: Record<string, unknown> = planInput(sha256(bytes));
    if (kind === "digest") {
      plan.sourceSha256 = "f".repeat(64);
      expected = "input_digest_mismatch";
    }
    if (kind === "aspect") {
      plan.target = { width: 12, height: 10, format: "png" };
      expected = "aspect_ratio_mismatch";
    }
    if (kind === "target") {
      plan.target = { width: 20, height: 15, format: "png" };
      expected = "unsupported_target";
    }
    if (kind === "unknown-plan") {
      plan.sourceUrl = "file:///private/untrusted-image";
      expected = "invalid_request";
    }
    const result = await f.upload(
      bytes,
      kind,
      uploadParts(
        bytes,
        { filename: "../private-token-should-not-leak.png" },
        plan,
      ),
    );
    expect(result).toMatchObject({
      status: kind === "unknown-plan" ? 400 : kind === "fake-mime" ? 415 : 422,
      body: { code: expected },
    });
    expect(result.raw).not.toContain("private-");
    expect(result.raw).not.toContain(f.storage.directory);
    expect(result.raw).not.toContain(f.storage.initialized.credential.key);
    expect(await f.inputNames()).toEqual([]);
  });

  it.each([
    "../outside.png",
    "/absolute/source.png",
    "space source.png",
    "$(whoami); source.png",
    "unicode-图像.png",
  ])("uses server-owned random filenames for %s", async (filename) => {
    const f = await fixture();
    const bytes = await sourceImage();
    const result = await f.upload(
      bytes,
      "untrusted-filename",
      uploadParts(bytes, { filename }),
    );
    expect(result.status).toBe(202);
    const job = jobOf(result);
    expect(await f.original(job)).toEqual(bytes);
    expect(await f.inputNames()).toEqual([job.jobId]);
    expect(result.raw).not.toContain(filename);
  });
});
