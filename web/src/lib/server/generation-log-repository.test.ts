import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    fetchSafeOutbound: vi.fn(),
    persistExternalMediaIfEnabled: vi.fn(),
}));

vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.fetchSafeOutbound }));
vi.mock("@/lib/server/security", () => ({ isSafeOutboundUrl: vi.fn(() => true) }));
vi.mock("@/lib/server/object-storage-service", () => ({ deleteExternalMediaObject: vi.fn(), persistExternalMediaIfEnabled: mocks.persistExternalMediaIfEnabled }));

import { insertPostgresGenerationLogAssets, mapPostgresGenerationLogAsset, normalizeAssets, normalizeStoredAsset, normalizeStoredLog, readPostgresGenerationLogDb, writeRemoteAsset } from "./generation-log-repository";

function storedLogWithAssets(count: number) {
    return normalizeStoredLog({
        id: "image-workbench:batch",
        userId: "user-1",
        username: "user",
        displayName: "User",
        kind: "image",
        source: "image-workbench",
        status: "success",
        title: "Batch",
        prompt: "Prompt",
        model: "image-model",
        summary: "Done",
        durationMs: 100,
        count,
        successCount: count,
        failCount: 0,
        assets: Array.from({ length: count }, (_, index) => ({ type: "image" as const, url: `/api/generation-log-assets/result-${index}.png` })),
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
    });
}

describe("generation log asset normalization", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.persistExternalMediaIfEnabled.mockResolvedValue({ storageKey: "permanent/result.png" });
    });

    it("retains public enhancement identities and native facts without copying nested private data or rewriting permanent media", async () => {
        const nativeSource = { url: "/api/generation-log-assets/native.png", width: 1254, height: 1254, byteLength: 1200, sha256: "a".repeat(64), format: "png", hasAlpha: false, provenance: "provider_native" as const };
        const asset = {
            type: "image" as const,
            url: nativeSource.url,
            resultId: "task-one:result-one",
            enhancementId: "enhancement-one",
            nativeSource: { ...nativeSource, evidencePath: "private-native-path" },
            enhancement: { token: "private-stale-summary" },
            credentialRef: "private-credential",
        };

        for (const actual of [
            (await normalizeAssets([asset as unknown as Parameters<typeof normalizeAssets>[0][number]], { ownerUserId: "user-one", source: "agent" }))[0],
            normalizeStoredAsset(asset as unknown as Parameters<typeof normalizeStoredAsset>[0]),
        ]) {
            expect(actual).toMatchObject({ resultId: asset.resultId, enhancementId: asset.enhancementId, nativeSource });
            expect(JSON.stringify(actual)).not.toContain("private-");
            expect(actual).not.toHaveProperty("enhancement");
        }
        expect(mocks.persistExternalMediaIfEnabled).not.toHaveBeenCalled();
        expect(mocks.fetchSafeOutbound).not.toHaveBeenCalled();
    });

    it("reuses already persisted media even when its remote source URL is also present", async () => {
        const asset = {
            type: "image" as const,
            url: "https://cdn.example.com/native.png",
            remoteUrl: "https://cdn.example.com/native.png",
            serverUrl: "/api/generation-log-assets/native.png",
            resultId: "native-result-one",
            enhancementId: "enhancement-one",
        };
        const [actual] = await normalizeAssets([asset], { ownerUserId: "user-one", source: "agent" });
        expect(actual).toMatchObject({ url: asset.serverUrl, serverUrl: asset.serverUrl, resultId: asset.resultId, enhancementId: asset.enhancementId });
        expect(mocks.fetchSafeOutbound).not.toHaveBeenCalled();
        expect(mocks.persistExternalMediaIfEnabled).not.toHaveBeenCalled();
    });

    it.each(["disabled", "not_requested", "protected_contract", "unsupported_layers"] as const)("retains the explicit no-job %s skip in both asset normalization paths", async (reason) => {
        const asset = { type: "image" as const, url: "/api/generation-log-assets/skipped.png", resultId: "skipped-result", enhancementSkip: { status: "skipped" as const, reason, raw: "private-skip-payload" } };
        for (const actual of [(await normalizeAssets([asset], { ownerUserId: "user-one", source: "agent" }))[0], normalizeStoredAsset(asset)]) {
            expect(actual).toMatchObject({ resultId: "skipped-result", enhancementSkip: { status: "skipped", reason } });
            expect(JSON.stringify(actual)).not.toContain("private-");
        }
    });

    it("does not preserve unknown skip reasons or enhancement fields on video assets", async () => {
        const image = { type: "image" as const, url: "/api/generation-log-assets/native.png", enhancementSkip: { status: "skipped", reason: "private-arbitrary-reason" } };
        expect(normalizeStoredAsset(image as unknown as Parameters<typeof normalizeStoredAsset>[0])).not.toHaveProperty("enhancementSkip");
        const video = { ...image, type: "video" as const, resultId: "video-result", enhancementId: "video-enhancement" };
        for (const actual of [
            (await normalizeAssets([video as unknown as Parameters<typeof normalizeAssets>[0][number]], { ownerUserId: "user-one", source: "agent" }))[0],
            normalizeStoredAsset(video as unknown as Parameters<typeof normalizeStoredAsset>[0]),
        ]) {
            expect(actual).not.toHaveProperty("resultId");
            expect(actual).not.toHaveProperty("enhancementId");
            expect(actual).not.toHaveProperty("enhancementSkip");
        }
    });

    it("retains only safe enhancement metadata across the PostgreSQL backup write/read seam", async () => {
        const nativeSource = { url: "/api/generation-log-assets/native.png", width: 1254, height: 1254, byteLength: 1200, sha256: "a".repeat(64), format: "png", hasAlpha: false, provenance: "provider_native" as const };
        const asset = { type: "image" as const, url: nativeSource.url, resultId: "native-result-one", enhancementId: "enhancement-one", nativeSource: { ...nativeSource, evidencePath: "private-native-path" } };
        const query = vi.fn().mockResolvedValue({ rows: [] });
        await insertPostgresGenerationLogAssets({ query } as never, "log-one", [asset]);
        expect(String(query.mock.calls[0]?.[0])).toContain("enhancement_metadata");
        expect(JSON.parse(String(query.mock.calls[0]?.[1]?.[10]))).toEqual({ resultId: asset.resultId, enhancementId: asset.enhancementId, nativeSource });
        const actual = mapPostgresGenerationLogAsset({ type: "image", url: nativeSource.url, enhancement_metadata: { ...asset, token: "private-payload" } });
        expect(actual).toMatchObject({ resultId: asset.resultId, enhancementId: asset.enhancementId, nativeSource });
        expect(JSON.stringify(actual)).not.toContain("private-");
    });

    it("accepts a real image when the upstream declares a generic content type", async () => {
        const source = await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } })
            .png()
            .toBuffer();
        mocks.fetchSafeOutbound.mockResolvedValue(new Response(source, { headers: { "content-type": "application/octet-stream" } }));

        const asset = await writeRemoteAsset("https://cdn.example.com/result", "image", { ownerUserId: "user-1", source: "canvas" });

        expect(asset).toMatchObject({ mimeType: "image/png", type: "image" });
        expect(mocks.fetchSafeOutbound).toHaveBeenCalledWith("https://cdn.example.com/result", expect.objectContaining({ redirect: "follow" }));
    });

    it("does not persist non-image bytes hidden behind an image task URL", async () => {
        mocks.fetchSafeOutbound.mockResolvedValue(new Response("<html>not an image</html>", { headers: { "content-type": "text/plain" } }));

        await expect(writeRemoteAsset("https://cdn.example.com/result", "image", { ownerUserId: "user-1", source: "drama" })).resolves.toBeNull();
        expect(mocks.persistExternalMediaIfEnabled).not.toHaveBeenCalled();
    });

    it.each([
        { width: 1254, height: 1254 },
        { width: 6000, height: 3000 },
    ])("saves native $width x $height bytes and reuses the permanent asset without a second normalization", async ({ width, height }) => {
        const source = await sharp({ create: { width, height, channels: 3, background: "#7c8da5" } })
            .png()
            .toBuffer();
        const context = { ownerUserId: "user-1", source: "image-workbench" };
        const [asset] = await normalizeAssets([{ type: "image", url: `data:image/png;base64,${source.toString("base64")}`, targetSize: "4096x4096" }], context);

        expect(asset).toMatchObject({ type: "image", mimeType: "image/png", width, height, bytes: source.length });
        const saved = mocks.persistExternalMediaIfEnabled.mock.calls[0][0];
        expect(saved.bytes).toEqual(source);
        expect(saved.registration).toMatchObject({ mimeType: "image/png", bytes: source.length, storageClass: "permanent" });
        await expect(sharp(saved.bytes).metadata()).resolves.toMatchObject({ width, height });

        const reused = await normalizeAssets([{ ...asset, targetSize: "4096x4096" }], context);
        expect(reused).toEqual([asset]);
        expect(mocks.persistExternalMediaIfEnabled).toHaveBeenCalledTimes(1);
        expect(mocks.fetchSafeOutbound).not.toHaveBeenCalled();
    });

    it("does not register or persist an invalid image with a larger requested size", async () => {
        await expect(normalizeAssets([{ type: "image", url: `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`, targetSize: "4096x4096" }], { ownerUserId: "user-1", source: "image-workbench" })).rejects.toThrow();
        expect(mocks.persistExternalMediaIfEnabled).not.toHaveBeenCalled();
    });

    it("keeps all eight successful images in a workbench batch", () => {
        expect(storedLogWithAssets(8).assets).toHaveLength(8);
    });

    it("retains every successful asset in a large provider batch", () => {
        expect(storedLogWithAssets(205).assets).toHaveLength(205);
    });

    it("persists the public user prompt separately from task prompts", () => {
        const log = normalizeStoredLog({
            ...storedLogWithAssets(1),
            prompt: "内部执行提示词",
            requestSnapshot: {
                version: 1,
                userPrompt: "用户原始需求",
                parameters: {},
                references: [],
                slots: [{ id: "slot-1", index: 0, status: "pending", prompt: "内部执行提示词", clientRequestId: "image-workbench:conversation:slot-1", canRetry: true }],
            },
        });

        expect(log.prompt).toBe("内部执行提示词");
        expect(log.requestSnapshot).toMatchObject({ userPrompt: "用户原始需求", slots: [{ prompt: "内部执行提示词", clientRequestId: "image-workbench:conversation:slot-1", canRetry: true }] });
    });

    it("preserves long public and execution prompts at the generation contract lengths", () => {
        const publicPrompt = "原".repeat(4000);
        const executionPrompt = "执".repeat(5000);
        const log = normalizeStoredLog({
            ...storedLogWithAssets(1),
            prompt: executionPrompt,
            requestSnapshot: {
                version: 1,
                userPrompt: publicPrompt,
                parameters: {},
                references: [],
                slots: [{ id: "slot-1", index: 0, status: "pending", prompt: executionPrompt, clientRequestId: "request-slot-1" }],
            },
        });

        expect(log.prompt).toBe(executionPrompt);
        expect(log.requestSnapshot?.userPrompt).toBe(publicPrompt);
        expect(log.requestSnapshot?.slots[0]?.prompt).toBe(executionPrompt);
    });

    it("keeps every explicit reference in the request snapshot", () => {
        const references = Array.from({ length: 40 }, (_, index) => ({
            id: `reference-${index}`,
            kind: "image" as const,
            name: `reference-${index}.png`,
            mimeType: "image/png",
            url: `/api/reference-assets/reference-${index}.png`,
        }));
        const log = normalizeStoredLog({
            ...storedLogWithAssets(1),
            requestSnapshot: { version: 1, userPrompt: "生成组合图", parameters: {}, references, slots: [] },
        });

        expect(log.requestSnapshot?.references).toHaveLength(40);
    });

    it("exports the complete PostgreSQL generation log snapshot", async () => {
        const query = vi.fn().mockResolvedValue({ rows: [] });

        await readPostgresGenerationLogDb({ query } as never);

        expect(query).toHaveBeenNthCalledWith(1, "SELECT * FROM generation_logs ORDER BY created_at DESC");
        expect(String(query.mock.calls[0]?.[0])).not.toContain("LIMIT");
    });
});
