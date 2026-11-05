import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { imageProcessingS3Fixture } from "./image-processing-s3-fixture";
import { putObjectBytes } from "./object-storage-client";

const settings = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("./object-storage-config", async (original) => ({ ...(await original<typeof import("./object-storage-config")>()), getObjectStorageRuntimeConfig: settings.config }));

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("permanent enhancement file promotion from a closed CPU receipt", () => {
    let directory: string;
    let fixture: Awaited<ReturnType<typeof imageProcessingS3Fixture>>;
    let repository: typeof import("./generation-log-repository");
    let registry: typeof import("./local-media-registry");
    const context = { ownerUserId: "fixture-enhancement-owner", source: "image-workbench", taskId: "fixture-enhancement", originalName: "enhanced.png", storageKey: "permanent/fixture/images/enhancement.png" };

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "enhancement-file-writer-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.resetModules();
        fixture = await imageProcessingS3Fixture();
        settings.config.mockResolvedValue({ ...fixture.config, enabled: false });
        repository = await import("./generation-log-repository");
        registry = await import("./local-media-registry");
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await fixture.close();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    async function source(format: "png" | "jpeg") {
        const bytes = await sharp({ create: { width: 32, height: 19, channels: 3, background: "#517b9d" } })
            .toFormat(format)
            .toBuffer();
        const sourcePath = join(directory, `closed.${format}`);
        await writeFile(sourcePath, bytes);
        return { bytes, sourcePath, artifact: { format, width: 32, height: 19, byteLength: bytes.length, sha256: digest(bytes) } };
    }

    it.each(["png", "jpeg"] as const)("preserves the actual %s bytes in generation storage with no parent pixel methods", async (format) => {
        const input = await source(format);
        const targets = { png: context, jpeg: { ...context, storageKey: "permanent/fixture/images/enhancement.jpg", originalName: "enhanced.jpg" } };
        const target = targets[format];
        const raw = vi.spyOn(sharp.prototype, "raw");
        const stats = vi.spyOn(sharp.prototype, "stats");
        const resize = vi.spyOn(sharp.prototype, "resize");
        const toBuffer = vi.spyOn(sharp.prototype, "toBuffer");
        const toFile = vi.spyOn(sharp.prototype, "toFile");
        const saved = await repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, target);
        expect({ raw: raw.mock.calls.length, stats: stats.mock.calls.length, resize: resize.mock.calls.length, toBuffer: toBuffer.mock.calls.length, toFile: toFile.mock.calls.length }).toEqual({ raw: 0, stats: 0, resize: 0, toBuffer: 0, toFile: 0 });
        expect(saved).toMatchObject({ type: "image", serverUrl: `/api/generation-log-assets/${target.storageKey}`, width: 32, height: 19, mimeType: `image/${format}` });
        expect(await readFile(join(directory, "generation-assets", target.storageKey))).toEqual(input.bytes);
        expect(await readFile(input.sourcePath)).toEqual(input.bytes);
        expect(await registry.getLocalMediaRegistration(target.storageKey)).toMatchObject({
            ownerUserId: "fixture-enhancement-owner",
            taskId: "fixture-enhancement",
            scope: "generation",
            storageClass: "permanent",
            mimeType: `image/${format}`,
            bytes: input.bytes.length,
            storageProvider: "local",
        });
        expect(fixture.requests).toEqual([]);
    });

    it("reuses the same permanent local artifact when the closed temporary source has gone", async () => {
        const input = await source("png");
        const first = await repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, context);
        await unlink(input.sourcePath);
        const resumed = await repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, context);
        expect(resumed).toEqual(first);
        expect(await readFile(join(directory, "generation-assets", context.storageKey))).toEqual(input.bytes);
    });

    it("writes and reads the actual S3 file stream and retains its provider after new object writes are disabled", async () => {
        const input = await source("png");
        settings.config.mockResolvedValue(fixture.config);
        const first = await repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, context);
        await expect(readFile(join(directory, "generation-assets", context.storageKey))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await registry.getLocalMediaRegistration(context.storageKey)).toMatchObject({ storageProvider: "object", externalStorageId: "default", externalObjectKey: "fixture/media/generation/permanent/fixture/images/enhancement.png" });
        await unlink(input.sourcePath);
        settings.config.mockResolvedValue({ ...fixture.config, enabled: false });
        expect(await repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, context)).toEqual(first);
        expect(fixture.requests).toEqual([
            { method: "PUT", key: "fixture/media/generation/permanent/fixture/images/enhancement.png" },
            { method: "GET", key: "fixture/media/generation/permanent/fixture/images/enhancement.png" },
            { method: "GET", key: "fixture/media/generation/permanent/fixture/images/enhancement.png" },
        ]);
    });

    it("rejects a corrupted registered local artifact without overwriting it from the temporary source", async () => {
        const input = await source("png");
        await repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, context);
        const target = join(directory, "generation-assets", context.storageKey);
        const corrupt = Buffer.alloc(input.bytes.length, 0);
        await writeFile(target, corrupt);
        await expect(repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, context)).rejects.toThrow("Enhancement artifact bytes/hash do not match CPU receipt");
        expect(await readFile(target)).toEqual(corrupt);
    });

    it("rejects a corrupted actual object readback without a second writer upload", async () => {
        const input = await source("png");
        settings.config.mockResolvedValue(fixture.config);
        await repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, context);
        await putObjectBytes(fixture.config, { key: "fixture/media/generation/permanent/fixture/images/enhancement.png", bytes: Buffer.alloc(input.bytes.length, 0), contentType: "image/png" });
        await expect(repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, context)).rejects.toThrow("Enhancement artifact bytes/hash do not match CPU receipt");
        expect(fixture.requests.map((request) => request.method)).toEqual(["PUT", "GET", "PUT", "GET"]);
    });

    it("rejects a source hash mismatch before registering a permanent asset", async () => {
        const input = await source("png");
        await expect(repository.writeEnhancementArtifactFile(input.sourcePath, { ...input.artifact, sha256: "f".repeat(64) }, context)).rejects.toThrow("Enhancement artifact bytes/hash do not match CPU receipt");
        expect(await registry.getLocalMediaRegistration(context.storageKey)).toBeNull();
        expect(fixture.requests).toEqual([]);
    });

    it("does not take over another owner's registered target", async () => {
        const input = await source("png");
        await repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, context);
        await expect(repository.writeEnhancementArtifactFile(input.sourcePath, input.artifact, { ...context, ownerUserId: "another-fixture-owner" })).rejects.toThrow("Enhancement permanent artifact registration changed");
        expect(await registry.getLocalMediaRegistration(context.storageKey)).toMatchObject({ ownerUserId: "fixture-enhancement-owner" });
    });
});
