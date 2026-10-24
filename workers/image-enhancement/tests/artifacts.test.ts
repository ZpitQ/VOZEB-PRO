import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactManifest } from "../src/artifacts.js";
import { createWorkerConfig } from "../src/config.js";
import {
  artifactFixture,
  nativePng,
  reachedBeforeSettled,
  writeActualFile,
  type ArtifactFixture,
} from "./artifact-fixtures.js";
import { configInput } from "./fixtures.js";
import { sha256, submission } from "./storage-fixtures.js";

const fixtures: ArtifactFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup();
});
async function fixture() {
  const value = await artifactFixture();
  fixtures.push(value);
  return value;
}

describe("real artifact chain with frozen input and native output", () => {
  it.each(["RGB", "opaque RGBA"] as const)(
    "publishes a fully decoded native %s PNG and canonical manifest",
    async (mode) => {
      const f = await fixture();
      const attempt = await f.claim();
      const original = await f.originalBytes(attempt);
      const engine = await readFile(attempt.inputPath);
      const png = await nativePng(
        attempt,
        mode === "opaque RGBA" ? { alpha: 1 } : {},
      );
      if (mode === "opaque RGBA")
        expect((await sharp(png).metadata()).hasAlpha).toBe(true);
      await f.complete(attempt, png);
      await expect(f.settle(attempt)).resolves.toBe("succeeded");

      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "succeeded",
        reason: null,
        completedAt: 1_000,
        source: attempt.job.source,
        engineInput: attempt.job.engineInput,
        plan: attempt.job.plan,
        result: {
          format: "png",
          width: attempt.job.engineInput.width * 4,
          height: attempt.job.engineInput.height * 4,
          sha256: sha256(png),
          byteLength: png.length,
        },
      });
      expect(f.job(attempt.identity.jobId).result?.width).not.toBe(
        attempt.job.plan.target.width,
      );
      const rows = f.rows();
      expect(rows.slot).toEqual([]);
      expect(rows.attempts).toHaveLength(1);
      expect(rows.candidates).toHaveLength(1);
      const candidate = rows.candidates[0];
      assert.ok(candidate);
      expect(candidate).toMatchObject({
        job_id: attempt.identity.jobId,
        attempt_no: attempt.identity.attemptNo,
        state: "durable",
        durable_at: 1_000,
      });
      const directory = join(
        attempt.workingDirectory,
        "artifacts",
        candidate.candidate_id,
      );
      const sealedPng = await readFile(join(directory, "artifact.png"));
      const manifestBytes = await readFile(join(directory, "manifest.json"));
      const manifest = JSON.parse(
        manifestBytes.toString("utf8"),
      ) as ArtifactManifest;
      expect(sealedPng).toEqual(png);
      expect(manifestBytes.toString("utf8")).toBe(candidate.manifest_json);
      expect(sha256(manifestBytes)).toBe(candidate.manifest_sha256);
      expect(manifestBytes.length).toBe(candidate.manifest_byte_length);
      expect(manifest).toEqual({
        producer: {
          identity: attempt.identity,
          launchTicket: attempt.launchTicket,
        },
        planFingerprint: attempt.job.plan.planFingerprint,
        engineInputSha256: attempt.job.engineInput.sha256,
        executionPolicyFingerprint: attempt.executionPolicy.fingerprint,
        tile: attempt.tile,
        png: f.job(attempt.identity.jobId).result,
      });
      expect(rows.references).toEqual([
        expect.objectContaining({
          purpose: "run",
          candidate_id: candidate.candidate_id,
          released_at: 1_000,
        }),
      ]);
      expect(await readFile(attempt.inputPath)).toEqual(engine);
      expect(await f.originalBytes(attempt)).toEqual(original);
      expect(await readFile(attempt.outputPath)).toEqual(png);
      expect(f.executor.launchCalls).toHaveLength(1);
    },
  );

  it.each([
    "missing",
    "truncated",
    "bad pixels",
    "JPEG",
    "transparent",
    "orientation",
    "native size",
    "byte budget",
  ] as const)(
    "records current raw-output %s as invalid_output without a candidate or new computation",
    async (kind) => {
      const f = await fixture();
      if (kind === "byte budget") {
        const input = configInput();
        input.budgets.ai.maxBytes = 1_024;
        f.storage.setConfig(createWorkerConfig(input));
      }
      const attempt = await f.claim();
      let png = await nativePng(attempt);
      if (kind === "truncated") png = png.subarray(0, png.length - 20);
      if (kind === "bad pixels") {
        png = Buffer.from(png);
        const idat = png.indexOf(Buffer.from("IDAT"));
        assert.ok(idat > 0);
        png[idat + 4] = 0;
        expect(await sharp(png).metadata()).toMatchObject({
          width: 16,
          height: 12,
          format: "png",
        });
      }
      if (kind === "JPEG") png = await nativePng(attempt, { jpeg: true });
      if (kind === "transparent")
        png = await nativePng(attempt, { alpha: 0.5 });
      if (kind === "orientation") {
        png = await nativePng(attempt, { orientation: 6 });
        expect((await sharp(png).metadata()).orientation).toBe(6);
      }
      if (kind === "native size") png = await nativePng(attempt, { width: 15 });
      if (kind === "byte budget")
        png = Buffer.concat([
          png,
          Buffer.alloc(attempt.job.plan.budgets.ai.maxBytes + 1),
        ]);
      await f.complete(attempt, kind === "missing" ? undefined : png);
      await expect(f.settle(attempt)).resolves.toBe("failed");
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "failed",
        reason: "invalid_output",
        completedAt: 1_000,
        result: null,
      });
      const rows = f.rows();
      expect(rows.slot).toEqual([]);
      expect(rows.attempts).toHaveLength(1);
      expect(rows.candidates).toEqual([]);
      expect(rows.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "output_invalid" }),
        ]),
      );
      expect(rows.references).toHaveLength(1);
      expect(rows.references[0]?.released_at).toBe(1_000);
      expect(f.executor.launchCalls).toHaveLength(1);
    },
  );

  it.each(["missing", "same-length changed bytes"] as const)(
    "retains accepted-engine %s as integrity trouble rather than invalid output",
    async (kind) => {
      const f = await fixture();
      const attempt = await f.claim();
      const png = await nativePng(attempt);
      await f.complete(attempt, png);
      const original = await readFile(attempt.inputPath);
      if (kind === "missing") await unlink(attempt.inputPath);
      else {
        const changed = Buffer.from(original);
        changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
        await writeActualFile(attempt.inputPath, changed, false);
        expect(changed.length).toBe(attempt.job.engineInput.byteLength);
        expect(sha256(changed)).not.toBe(attempt.job.engineInput.sha256);
      }
      await expect(f.settle(attempt)).resolves.toBe("blocked");
      expect(f.job(attempt.identity.jobId)).toMatchObject({
        status: "running",
        reason: null,
        completedAt: null,
        result: null,
      });
      const rows = f.rows();
      expect(rows.slot).toHaveLength(1);
      expect(rows.attempts).toHaveLength(1);
      expect(rows.candidates).toEqual([]);
      expect(rows.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "engine_integrity" }),
        ]),
      );
      expect(rows.references.some((ref) => ref.released_at === null)).toBe(
        true,
      );
      expect(f.storage.store.claimNext("unrelated-owner")).toBeUndefined();
      expect(await readFile(attempt.outputPath)).toEqual(png);
    },
  );

  it("continues real short reads to EOF and still publishes the exact bytes", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    f.hooks.maxReadLength = 3;
    await expect(f.settle(attempt)).resolves.toBe("succeeded");
    expect(f.job(attempt.identity.jobId).result).toMatchObject({
      sha256: sha256(png),
      byteLength: png.length,
    });
    expect(
      f.events.filter(
        ({ phase, event }) =>
          phase === "after" &&
          event.stage === "read" &&
          event.role === "engine",
      ).length,
    ).toBeGreaterThan(1);
    expect(
      f.events.filter(
        ({ phase, event }) =>
          phase === "after" &&
          event.stage === "read" &&
          event.role === "raw-output",
      ).length,
    ).toBeGreaterThan(1);
    expect(f.rows().candidates).toHaveLength(1);
  });

  it("reads the registered engine through its original descriptor when the pathname changes after fstat", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const engine = await readFile(attempt.inputPath);
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const gate = f.gate(
      (event) => event.role === "engine" && event.stage === "stat",
    );
    const pending = f.settle(attempt);
    await reachedBeforeSettled(gate, pending);
    const retainedPath = join(attempt.workingDirectory, "retained-engine.png");
    await rename(attempt.inputPath, retainedPath);
    const replacement = Buffer.from(
      "fixture pathname replacement must not be read as accepted engine",
    );
    await writeActualFile(attempt.inputPath, replacement);
    gate.release();
    await expect(pending).resolves.toBe("succeeded");
    expect(await readFile(retainedPath)).toEqual(engine);
    expect(await readFile(attempt.inputPath)).toEqual(replacement);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "succeeded",
      engineInput: attempt.job.engineInput,
      result: { sha256: sha256(png) },
    });
  });

  it("rejects same-inode growth after fstat using bounded bytes and the registered digest", async () => {
    const f = await fixture();
    const config = configInput();
    config.budgets.ai.maxBytes = 1_024;
    f.storage.setConfig(createWorkerConfig(config));
    const attempt = await f.claim();
    const engine = await readFile(attempt.inputPath);
    const cap = attempt.job.plan.budgets.ai.maxBytes;
    expect(cap).toBe(1_024);
    expect(engine.length).toBe(attempt.job.engineInput.byteLength);
    expect(engine.length).toBeLessThan(cap);
    expect(sha256(engine)).toBe(attempt.job.engineInput.sha256);
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const gate = f.gate(
      (event) => event.role === "engine" && event.stage === "stat",
    );
    const pending = f.settle(attempt);
    const opened = await reachedBeforeSettled(gate, pending);
    assert.ok(opened.file);
    expect((await opened.file.stat()).size).toBe(engine.length);
    await appendFile(attempt.inputPath, Buffer.alloc(cap + 1));
    expect((await opened.file.stat()).size).toBeGreaterThan(cap + 1);
    gate.release();
    await expect(pending).resolves.toBe("blocked");
    const reads = f.events.filter(
      ({ phase, event }) =>
        phase === "after" && event.role === "engine" && event.stage === "read",
    );
    expect(reads.length).toBeGreaterThan(0);
    let totalRead = 0;
    for (const { event } of reads) {
      assert.ok(
        event.position !== undefined &&
          event.length !== undefined &&
          event.bytesRead !== undefined,
      );
      expect(event.file).toBe(opened.file);
      expect(event.position).toBe(totalRead);
      expect(event.length).toBeGreaterThanOrEqual(0);
      expect(event.length).toBeLessThanOrEqual(cap + 1 - totalRead);
      expect(event.position + event.length).toBeLessThanOrEqual(cap + 1);
      expect(event.bytesRead).toBeGreaterThanOrEqual(0);
      expect(event.bytesRead).toBeLessThanOrEqual(event.length);
      totalRead += event.bytesRead;
    }
    expect(totalRead).toBeLessThanOrEqual(cap + 1);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "running",
      reason: null,
      completedAt: null,
      result: null,
      engineInput: attempt.job.engineInput,
    });
    const rows = f.rows();
    expect(rows.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "engine_integrity" }),
      ]),
    );
    expect(rows.slot).toHaveLength(1);
    expect(rows.attempts).toHaveLength(1);
    expect(rows.candidates).toEqual([]);
    expect(f.executor.launchCalls).toHaveLength(1);
    expect(f.storage.store.claimNext("unrelated-owner")).toBeUndefined();
    expect(await readFile(attempt.outputPath)).toEqual(png);
  });

  it("uses the frozen AI byte budget for expanded JPEG input after the current configuration changes", async () => {
    const f = await fixture();
    const pixels = Buffer.alloc(64 * 64 * 3);
    for (let offset = 0; offset < pixels.length; offset += 32)
      createHash("sha256")
        .update(`fixture-jpeg-noise-${offset}`)
        .digest()
        .copy(pixels, offset);
    const bytes = await sharp(pixels, {
      raw: { width: 64, height: 64, channels: 3 },
    })
      .jpeg({ quality: 20 })
      .toBuffer();
    const normalized = await sharp(bytes)
      .rotate()
      .toColourspace("srgb")
      .removeAlpha()
      .png()
      .toBuffer();
    const config = configInput();
    config.budgets.input.maxBytes = bytes.length + 1;
    config.budgets.ai.maxBytes = normalized.length + 1;
    f.storage.setConfig(createWorkerConfig(config));
    const input = submission(bytes, "expanded-artifact-source");
    input.plan.target = { width: 128, height: 128, format: "png" };
    const attempt = await f.claim(input);
    expect(attempt.job.source.byteLength).toBeLessThan(
      attempt.job.plan.budgets.input.maxBytes,
    );
    expect(attempt.job.engineInput.byteLength).toBeGreaterThan(
      attempt.job.plan.budgets.input.maxBytes,
    );
    expect(attempt.job.engineInput.byteLength).toBeLessThanOrEqual(
      attempt.job.plan.budgets.ai.maxBytes,
    );
    const png = await nativePng(attempt);
    expect(png.length).toBeLessThanOrEqual(
      attempt.job.plan.budgets.ai.maxBytes,
    );
    await f.complete(attempt, png);
    const changed = configInput();
    changed.budgets.ai.maxBytes = 1;
    changed.models[0]!.defaultTile = 128;
    f.storage.setConfig(createWorkerConfig(changed));
    await expect(f.settle(attempt)).resolves.toBe("succeeded");
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "succeeded",
      source: attempt.job.source,
      engineInput: attempt.job.engineInput,
      plan: attempt.job.plan,
      result: { sha256: sha256(png) },
    });
    expect(await f.originalBytes(attempt)).toEqual(bytes);
    expect(await readFile(attempt.inputPath)).toEqual(normalized);
    const manifest = JSON.parse(
      f.rows().candidates[0]!.manifest_json,
    ) as ArtifactManifest;
    expect(manifest.tile).toBe(attempt.tile);
    expect(manifest.executionPolicyFingerprint).toBe(
      attempt.executionPolicy.fingerprint,
    );
  });

  it("shares the in-flight artifact chain for one publisher and creates one physical candidate", async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const png = await nativePng(attempt);
    await f.complete(attempt, png);
    const gate = f.gate(
      (event) => event.role === "artifact-part" && event.stage === "write",
      "before",
    );
    const first = f.settle(attempt);
    await reachedBeforeSettled(gate, first);
    const second = f.settle(attempt);
    expect(f.rows().candidates).toHaveLength(1);
    expect(
      f.rows().references.filter((ref) => ref.released_at === null),
    ).toHaveLength(1);
    gate.release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "succeeded",
      "succeeded",
    ]);
    const rows = f.rows();
    expect(rows.candidates).toHaveLength(1);
    expect(rows.references).toHaveLength(1);
    const candidate = rows.candidates[0];
    assert.ok(candidate);
    const directory = join(
      attempt.workingDirectory,
      "artifacts",
      candidate.candidate_id,
    );
    const createdDirectories = f.events.filter(
      ({ phase, event }) =>
        phase === "after" &&
        event.stage === "mkdir" &&
        event.role === "candidate-directory",
    );
    expect(createdDirectories.map(({ event }) => event.path)).toEqual([
      directory,
    ]);
    const manifestBytes = Buffer.from(candidate.manifest_json, "utf8");
    for (const [role, partPath, finalPath, bytes] of [
      [
        "artifact-part",
        join(directory, "artifact.part.png"),
        join(directory, "artifact.png"),
        png,
      ],
      [
        "manifest-part",
        join(directory, "manifest.part.json"),
        join(directory, "manifest.json"),
        manifestBytes,
      ],
    ] as const) {
      const operations = f.events.filter(
        ({ event }) =>
          event.role === role &&
          event.path === partPath &&
          ["open", "write", "file_sync", "close", "rename"].includes(
            event.stage,
          ),
      );
      const opens = operations.filter(
        ({ phase, event }) => phase === "after" && event.stage === "open",
      );
      expect(opens).toHaveLength(1);
      const opened = opens[0]!.event;
      assert.ok(opened.file);
      expect(opened.flags).toBe("wx");
      expect(dirname(opened.path)).toBe(directory);
      expect(
        operations
          .slice(0, 2)
          .map(({ phase, event }) => [phase, event.stage, event.flags]),
      ).toEqual([
        ["before", "open", "wx"],
        ["after", "open", "wx"],
      ]);
      let index = 2;
      let totalWritten = 0;
      while (operations[index]?.event.stage === "write") {
        const before = operations[index++];
        const after = operations[index++];
        assert.ok(before && after);
        expect(before.phase).toBe("before");
        expect(after.phase).toBe("after");
        expect(before.event.stage).toBe("write");
        expect(after.event.stage).toBe("write");
        expect(before.event.file).toBe(opened.file);
        expect(after.event.file).toBe(opened.file);
        expect(before.event.position).toBe(totalWritten);
        expect(after.event.position).toBe(totalWritten);
        assert.ok(
          before.event.buffer &&
            before.event.offset !== undefined &&
            before.event.length !== undefined &&
            after.event.bytesWritten !== undefined,
        );
        expect(after.event.length).toBe(before.event.length);
        expect(after.event.bytesWritten).toBeGreaterThan(0);
        expect(after.event.bytesWritten).toBeLessThanOrEqual(
          before.event.length,
        );
        expect(
          before.event.buffer.subarray(
            before.event.offset,
            before.event.offset + after.event.bytesWritten,
          ),
        ).toEqual(
          bytes.subarray(totalWritten, totalWritten + after.event.bytesWritten),
        );
        totalWritten += after.event.bytesWritten;
      }
      expect(totalWritten).toBe(bytes.length);
      const sealing = operations.slice(index);
      expect(sealing.map(({ phase, event }) => [phase, event.stage])).toEqual([
        ["before", "file_sync"],
        ["after", "file_sync"],
        ["before", "close"],
        ["after", "close"],
        ["before", "rename"],
        ["after", "rename"],
      ]);
      for (const { event } of sealing) {
        if (event.stage === "rename") expect(event.to).toBe(finalPath);
        else expect(event.file).toBe(opened.file);
      }
      expect(await readFile(finalPath)).toEqual(bytes);
    }
    expect(sha256(manifestBytes)).toBe(candidate.manifest_sha256);
    expect(manifestBytes.length).toBe(candidate.manifest_byte_length);
    expect(f.job(attempt.identity.jobId)).toMatchObject({
      status: "succeeded",
      result: { sha256: sha256(png), byteLength: png.length },
    });
  });
});
