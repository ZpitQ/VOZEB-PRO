import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn(), fetch: vi.fn(), persist: vi.fn() }));

vi.mock("@/lib/server/generation-log-task-service", () => ({ recordGenerationTaskLogResult: mocks.record }));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.fetch }));
vi.mock("@/lib/server/security", async (original) => ({ ...(await original<typeof import("@/lib/server/security")>()), isSafeOutboundUrl: vi.fn(() => true) }));
vi.mock("@/lib/server/object-storage-service", async (original) => ({ ...(await original<typeof import("@/lib/server/object-storage-service")>()), persistExternalMediaIfEnabled: mocks.persist }));

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import type { ImageTask } from "@/lib/server/image-task-store";
import { writeImageGenerationLog } from "./image-task-runner";

describe("writeImageGenerationLog", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.record.mockResolvedValue({});
    });

    it("reuses the saved native ecommerce file without secondary size normalization", async () => {
        const task = imageTask();
        task.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-openai-image-2.5.v1",
            providerProfileId: "gpt-image-2.5-flare",
            prompt: "preserve",
            referenceRoles: [],
            parameters: { variant: "gpt-image-2.5-flare", size: "3840x2160" },
            canvas: { mode: "exact", size: { width: 3840, height: 2160 }, source: "user_text", allowReframe: false },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" },
        };
        await writeImageGenerationLog(task, "success", [{ dataUrl: "/api/generation-log-assets/native.png", remoteUrl: "https://upstream.fixture/native.png", width: 2880, height: 2880 }], 10);
        const asset = mocks.record.mock.calls[0][0].assets[0];
        expect(asset).not.toHaveProperty("targetSize");
        expect(asset).toMatchObject({ url: "/api/generation-log-assets/native.png", width: 2880, height: 2880 });
    });

    it("passes an ordinary image's existing permanent server URL alongside its expired upstream URL", async () => {
        const media = {
            dataUrl: "/api/generation-log-assets/permanent/native.png",
            serverUrl: "/api/generation-log-assets/permanent/native.png",
            remoteUrl: "https://expired.example.com/native.png",
            width: 1254,
            height: 1254,
            resultId: "image-one:1",
            enhancementId: "enhancement-one",
        };
        await writeImageGenerationLog(imageTask(), "success", [media], 10);
        expect(mocks.record.mock.calls[0][0].assets[0]).toMatchObject({ serverUrl: media.serverUrl, remoteUrl: media.remoteUrl, resultId: media.resultId, enhancementId: media.enhancementId, targetSize: "1024x1024" });
    });

    it("does not resample validated layer assets", async () => {
        await writeImageGenerationLog(imageTask({ outputMode: "layers" }), "success", [{ dataUrl: "data:image/png;base64,AA==" }], 10);

        const asset = mocks.record.mock.calls[0][0].assets[0];
        expect(asset).not.toHaveProperty("targetSize");
    });

    it("keeps target-size normalization for ordinary image tasks", async () => {
        await writeImageGenerationLog(imageTask(), "success", [{ dataUrl: "data:image/png;base64,AA==" }], 10);

        expect(mocks.record.mock.calls[0][0].assets[0]).toMatchObject({ targetSize: "1024x1024" });
    });

    it("preserves native custom Gemini image sizes when recording the result", async () => {
        const task = imageTask({ model: "gemini-3.1-flash-image", size: "16:9", quality: "4k", advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom" } });
        await writeImageGenerationLog(task, "success", [{ dataUrl: "/api/generation-log-assets/result.png", width: 4096, height: 2304 }], 10);

        expect(mocks.record.mock.calls[0][0].assets[0]).not.toHaveProperty("targetSize");
        expect(mocks.record.mock.calls[0][0].assets[0]).toMatchObject({ width: 4096, height: 2304 });
    });

    it("keeps exact custom dimensions for custom Gemini image results", async () => {
        const task = imageTask({ model: "gemini-3.1-flash-image", size: "768x512", quality: "4k", advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom" } });
        await writeImageGenerationLog(task, "success", [{ dataUrl: "data:image/png;base64,AA==" }], 10);

        expect(mocks.record.mock.calls[0][0].assets[0]).toMatchObject({ targetSize: "768x512" });
    });

    it("preserves validated media metadata in the generation log", async () => {
        await writeImageGenerationLog(imageTask(), "success", [{ dataUrl: "/api/generation-log-assets/result.png", width: 64, height: 64, bytes: 128, mimeType: "image/png" }], 10);

        expect(mocks.record.mock.calls[0][0].assets[0]).toMatchObject({ width: 64, height: 64, bytes: 128, mimeType: "image/png" });
    });

    it.each(["native", "disabled", "not_requested", "protected_contract", "unsupported_layers"] as const)("passes only public %s enhancement facts to the log service", async (kind) => {
        const nativeSource = { url: "/api/generation-log-assets/native.png", sha256: "a".repeat(64), width: 64, height: 64, byteLength: 128, format: "png", hasAlpha: false, provenance: "provider_native" as const };
        const facts = kind === "native" ? { resultId: "image-one:1", enhancementId: "enhancement:image-one:1", nativeSource } : { resultId: "image-one:1", enhancementSkip: { status: "skipped" as const, reason: kind } };
        const media = {
            ...facts,
            ...(kind === "native" ? { nativeSource: { ...nativeSource, credentialRef: "private-credential" } } : { enhancementSkip: { ...facts.enhancementSkip, token: "private-token" } }),
            dataUrl: nativeSource.url,
            width: 64,
            height: 64,
            canvasEvidence: { nativeUrl: "private-evidence" },
            unknown: "private-future",
        };
        await writeImageGenerationLog(imageTask(), "success", [media], 10);
        expect(mocks.record.mock.calls[0][0].assets[0]).toMatchObject(facts);
        expect(JSON.stringify(mocks.record.mock.calls[0][0].assets)).not.toContain("private-");
    });

    it("records an already-saved ordinary result through the real file service without fetching its expired upstream URL or persisting media again", async () => {
        const directory = await mkdtemp(join(tmpdir(), "vozeb-runner-log-reuse-"));
        try {
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
            vi.resetModules();
            mocks.fetch.mockResolvedValue(new Response("expired", { status: 410 }));
            const actualService = await vi.importActual<typeof import("@/lib/server/generation-log-task-service")>("@/lib/server/generation-log-task-service");
            mocks.record.mockImplementation(actualService.recordGenerationTaskLogResult);
            const caller = await import("./image-task-runner");
            const nativeSource = { url: "/api/generation-log-assets/permanent/native.png", width: 1254, height: 1254, byteLength: 1200, sha256: "a".repeat(64), format: "png", hasAlpha: false, provenance: "provider_native" as const };
            const media = {
                dataUrl: nativeSource.url,
                serverUrl: nativeSource.url,
                remoteUrl: "https://expired.example.com/native.png",
                width: nativeSource.width,
                height: nativeSource.height,
                bytes: nativeSource.byteLength,
                mimeType: "image/png",
                resultId: "image-one:1",
                enhancementId: "enhancement-one",
                nativeSource,
            };
            await caller.writeImageGenerationLog(imageTask(), "success", [media], 10);

            const persisted = JSON.parse(await readFile(join(directory, "generation-logs.json"), "utf8"));
            expect(persisted.logs[0]).toMatchObject({
                status: "success",
                assets: [{ url: nativeSource.url, serverUrl: nativeSource.url, remoteUrl: media.remoteUrl, width: 1254, height: 1254, resultId: media.resultId, enhancementId: media.enhancementId, nativeSource }],
            });
            expect(mocks.fetch).not.toHaveBeenCalled();
            expect(mocks.persist).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
            await rm(directory, { recursive: true, force: true });
        }
    });
});

function imageTask(config: Partial<ImageTask["config"]> = {}): ImageTask {
    return {
        id: "image-one",
        userId: "user-one",
        username: "user",
        displayName: "User",
        kind: "edit",
        source: "canvas",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        config: {
            baseUrl: "https://provider.example",
            apiKey: "key",
            apiFormat: "openai",
            model: "image-one",
            size: "1024x1024",
            advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" },
            ...config,
        },
        prompt: "test",
        references: [],
    };
}
