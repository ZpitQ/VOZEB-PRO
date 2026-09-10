import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import type { ImageTask } from "./image-task-store";

vi.mock("@/app/api/image-tasks/image-task-support", () => ({
    directRemoteImageResult: vi.fn(),
    imageReferenceToDataUrl: vi.fn(),
    inlineRemoteImageResult: async (dataUrl: string) => ({ dataUrl }),
    resolveProxiedMediaSource: () => ({}),
}));
vi.mock("@/lib/server/generation-media-authorization", () => ({ generationMediaProxyHeaders: vi.fn() }));
vi.mock("@/lib/server/object-storage-service", () => ({ deleteExternalMediaObject: vi.fn(), persistExternalMediaIfEnabled: async () => null }));
vi.mock("@/lib/server/local-media-registry", () => ({ registerLocalMediaAsset: vi.fn() }));

describe("image task result persistence", () => {
    let directory: string;
    let prepare: typeof import("./image-task-result-service").prepareImageTaskResults;
    let assetPath: typeof import("./generation-log-repository").localAssetUrlToPath;

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-image-result-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        ({ prepareImageTaskResults: prepare } = await import("./image-task-result-service"));
        ({ localAssetUrlToPath: assetPath } = await import("./generation-log-repository"));
    });

    afterAll(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it.each([
        { size: "16:9", quality: "4k", width: 4096, height: 2304 },
        { size: "auto", quality: "4k", width: 2304, height: 4096 },
        { size: "9:16", quality: "2k", width: 1152, height: 2048 },
        { size: "16:9", quality: "4k", width: 1024, height: 576 },
    ])("preserves native $width x $height bytes for custom Gemini $quality $size", async ({ size, quality, width, height }) => {
        const bytes = await imageBytes(width, height);
        const [result] = await prepare(imageTask({ size, quality }), { dataUrl: dataUrl(bytes) }, "http://fixture.local", "fixture");
        const persisted = await readFile(assetPath(result.serverUrl!));

        expect(result).toMatchObject({ width, height, bytes: bytes.length, mimeType: "image/png" });
        expect(persisted.equals(bytes)).toBe(true);
        expect(await sharp(persisted).metadata()).toMatchObject({ width, height });
    });

    it("continues to enforce exact custom dimensions", async () => {
        const bytes = await imageBytes(2048, 1152);
        const [result] = await prepare(imageTask({ size: "768x512", quality: "4k" }), { dataUrl: dataUrl(bytes) }, "http://fixture.local", "fixture");
        const persisted = await readFile(assetPath(result.serverUrl!));

        expect(result).toMatchObject({ width: 768, height: 512 });
        expect(await sharp(persisted).metadata()).toMatchObject({ width: 768, height: 512 });
    });

    it.each([
        { model: "other-image-model", protocol: "custom" as const },
        { model: "gemini-3.1-flash-image", protocol: "openai" as const },
    ])("keeps existing result normalization for $protocol $model", async ({ model, protocol }) => {
        const task = imageTask({ model, size: "1:1", quality: "1k", advancedConfig: { ...emptyAdvancedConfig(), protocol } });
        const [result] = await prepare(task, { dataUrl: dataUrl(await imageBytes(1280, 1280)) }, "http://fixture.local", "fixture");
        expect(result).toMatchObject({ width: 1024, height: 1024 });
    });
});

function imageBytes(width: number, height: number) {
    return sharp({ create: { width, height, channels: 3, background: "#287fbd" } })
        .png()
        .toBuffer();
}

function dataUrl(bytes: Buffer) {
    return `data:image/png;base64,${bytes.toString("base64")}`;
}

function imageTask(config: Partial<ImageTask["config"]> = {}): ImageTask {
    return {
        id: "custom-gemini-image",
        userId: "fixture-user",
        username: "fixture-user",
        displayName: "Fixture User",
        kind: "generation",
        source: "image-workbench",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        config: {
            baseUrl: "https://fixture.example",
            apiKey: "fixture-only",
            apiFormat: "openai",
            model: "gemini-3.1-flash-image",
            advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom" },
            ...config,
        },
        prompt: "Fixture image",
        references: [],
    };
}
