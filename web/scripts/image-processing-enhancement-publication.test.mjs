import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runImageProcessing } from "./image-processing-supervisor.mjs";

const directories = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function jpegStructure(bytes) {
    assert.equal(bytes.readUInt16BE(0), 0xffd8);
    const quantization = new Map();
    let frame;
    let offset = 2;
    while (offset < bytes.length) {
        assert.equal(bytes[offset++], 0xff);
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        const length = bytes.readUInt16BE(offset);
        assert.ok(length >= 2 && offset + length <= bytes.length);
        const start = offset + 2;
        const end = offset + length;
        if (marker === 0xdb) {
            let table = start;
            while (table < end) {
                const header = bytes[table++];
                assert.equal(header >> 4, 0);
                assert.ok(table + 64 <= end);
                quantization.set(header & 15, [...bytes.subarray(table, table + 64)]);
                table += 64;
            }
        }
        if (marker === 0xc0) {
            const count = bytes[start + 5];
            const components = [];
            for (let index = 0; index < count; index++) components.push([...bytes.subarray(start + 6 + index * 3, start + 9 + index * 3)]);
            frame = { precision: bytes[start], height: bytes.readUInt16BE(start + 1), width: bytes.readUInt16BE(start + 3), components };
        }
        offset = end;
    }
    assert.ok(frame);
    return { frame, quantization };
}

describe("compiled enhancement publication pixels", () => {
    it("processes full-image enhancement AI into JPEG95 444 in a supervised CPU child", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "image-processing-enhancement-publication-"));
        directories.push(directory);
        const outputDirectory = path.join(directory, "output");
        await mkdir(outputDirectory);
        // Fixture creation precedes observation of the caller process.
        const native = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#517b9d" } })
            .png()
            .toBuffer();
        const ai = await sharp(native).resize(128, 128).png().toBuffer();
        const nativePath = path.join(directory, "native.png");
        const aiPath = path.join(directory, "ai.png");
        await writeFile(nativePath, native);
        await writeFile(aiPath, ai);
        const bindingDigest = digest(Buffer.from(JSON.stringify(["enhancement-publication.v1", "fixture-enhancement", "fixture-result:1", 1, digest(native), digest(ai), [64, 64]])));
        const expectedAi = { width: 128, height: 128, format: "png", sha256: digest(ai), byteLength: ai.length };
        const request = {
            version: "image-processing.v1",
            jobId: `image-process-${randomUUID()}`,
            executionId: randomUUID(),
            operation: "process_enhancement",
            inputs: [{ path: aiPath, assetId: "fixture-ai", assetVersion: "fixture-ai-v1", expectedSha256: expectedAi.sha256 }],
            outputDirectory,
            options: {
                scope: "full_image",
                bindingDigest,
                resultId: "fixture-result:1",
                resultIndex: 1,
                aiInputIndex: 0,
                engineInput: { width: 32, height: 32 },
                expectedAi,
                targetSize: { width: 64, height: 64 },
                budgets: { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } },
            },
        };
        const raw = vi.spyOn(sharp.prototype, "raw");
        const stats = vi.spyOn(sharp.prototype, "stats");
        const resize = vi.spyOn(sharp.prototype, "resize");
        const toBuffer = vi.spyOn(sharp.prototype, "toBuffer");
        const toFile = vi.spyOn(sharp.prototype, "toFile");
        let outcome;
        let callerPixels;
        try {
            // Fixed fixture heap only; this does not pass or calibrate scheduler admission.
            const running = runImageProcessing(request, { taskDirectory: directory, maxHeapMiB: 128 });
            // First gate: current public supervisor rejects the absent operation before fork.
            await expect(running).resolves.toMatchObject({ status: "completed" });
            outcome = await running;
            callerPixels = { raw: raw.mock.calls.length, stats: stats.mock.calls.length, resize: resize.mock.calls.length, toBuffer: toBuffer.mock.calls.length, toFile: toFile.mock.calls.length };
        } finally {
            vi.restoreAllMocks();
        }

        // These gates are unreached until the real operation enters and closes a CPU child.
        expect(outcome.exitCode).toBe(0);
        expect(outcome.result.metrics.pid).toBe(outcome.pid);
        expect(outcome.pid).not.toBe(process.pid);
        expect(() => process.kill(outcome.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        expect(callerPixels).toEqual({ raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
        expect(outcome.result.sourceIdentities).toEqual([{ assetId: "fixture-ai", assetVersion: "fixture-ai-v1", sha256: digest(ai), bytes: ai.length, width: 128, height: 128, mimeType: "image/png" }]);
        expect(outcome.result.enhancement).toMatchObject({ version: "enhancement-processing-result.v1", bindingDigest, scope: "full_image", aiInputIndex: 0, ai: expectedAi, deliveredArtifactIndex: 0 });
        expect(outcome.result.enhancement.deliveryEncodingMs).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(outcome.result.enhancement.deliveryEncodingMs)).toBe(true);
        expect(outcome.result.artifacts).toHaveLength(1);
        const [artifact] = outcome.result.artifacts;
        expect(artifact).toMatchObject({ kind: "final", resultId: "fixture-result:1", resultIndex: 1, width: 64, height: 64, mimeType: "image/jpeg" });
        const final = await readFile(artifact.path);
        expect(artifact.bytes).toBe(final.length);
        expect(artifact.sha256).toBe(digest(final));
        const jpeg = jpegStructure(final);
        expect(jpeg.frame).toEqual({
            precision: 8,
            width: 64,
            height: 64,
            components: [
                [1, 0x11, 0],
                [2, 0x11, 1],
                [3, 0x11, 1],
            ],
        });
        expect(jpeg.quantization.get(0)).toEqual([
            2, 1, 1, 1, 1, 1, 2, 1, 1, 1, 2, 2, 2, 2, 2, 4, 3, 2, 2, 2, 2, 5, 4, 4, 3, 4, 6, 5, 6, 6, 6, 5, 6, 6, 6, 7, 9, 8, 6, 7, 9, 7, 6, 6, 8, 11, 8, 9, 10, 10, 10, 10, 10, 6, 8, 11, 12, 11, 10, 12, 9, 10, 10, 10,
        ]);
        expect(jpeg.quantization.get(1)).toEqual([
            2, 2, 2, 2, 2, 2, 5, 3, 3, 5, 10, 7, 6, 7, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
        ]);
        expect(await readFile(aiPath)).toEqual(ai);
        expect(await readFile(nativePath)).toEqual(native);
    }, 30_000);
});
