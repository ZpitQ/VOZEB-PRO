import { describe, expect, it } from "vitest";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { CreativeAgentRun } from "@/services/api/creative";

import { creativeRunDuration, creativeRunPresentation } from "./creative-run-presentation";

describe("creativeRunPresentation", () => {
    it.each(["hard_failure", "check_unavailable", "needs_adjustment"] as const)("keeps completed delivery status with advisory %s", (kind) => {
        const run: CreativeAgentRun = {
            id: "run-advisory",
            conversationId: "conversation",
            inputMessageId: "input",
            assistantMessageId: "assistant",
            status: "completed",
            assetIds: ["result"],
            tasks: [],
            ecommerceQualityStatus: "needs_adjustment",
            ecommerceQualityReview: { kind, advisory: true, failureKeys: [] },
        };
        expect(creativeRunPresentation(run, new Map())).toContainEqual({ key: "status", label: "状态", value: "已完成" });
    });
    it.each([
        ["needs_adjustment", "需要调整"],
        ["needs_review", "待复核"],
        ["passed", "已完成"],
    ] as const)("uses %s acceptance before the completed generation state", (ecommerceQualityStatus, value) => {
        const run = { status: "completed", ecommerceQualityStatus, tasks: [] } as unknown as CreativeAgentRun;
        expect(creativeRunPresentation(run, new Map()).find((item) => item.key === "status")?.value).toBe(value);
    });
    it("shows public final video parameters without internal planning fields", () => {
        const run: CreativeAgentRun = {
            id: "run-one",
            conversationId: "conversation-one",
            inputMessageId: "user-one",
            assistantMessageId: "assistant-one",
            status: "completed",
            prompt: "让参考图自然动起来",
            requestedModelIds: ["seedance"],
            generationPreferences: { mode: "video", video: { size: "16:9", quality: "720P", seconds: 10, referenceMode: "first_frame" } },
            assetIds: [],
            tasks: [{ id: "task-one", title: "生成视频", type: "video", model: "seedance", ratio: "16:9", quality: "720P", seconds: 10, count: 1, status: "completed" }],
        };

        expect(creativeRunPresentation(run, new Map([["seedance", "Seedance 2.0"]]))).toEqual([
            { key: "mode", label: "类型", value: "视频生成" },
            { key: "model", label: "模型", value: "Seedance 2.0" },
            { key: "size", label: "比例", value: "16:9" },
            { key: "quality", label: "清晰度", value: "720P" },
            { key: "seconds", label: "时长", value: "10秒" },
            { key: "status", label: "状态", value: "已完成" },
        ]);
    });

    it("falls back to explicit preferences while planning", () => {
        const run = {
            id: "run-two",
            conversationId: "conversation-one",
            inputMessageId: "user-two",
            assistantMessageId: "assistant-two",
            status: "planning",
            generationPreferences: { mode: "image", image: { size: "3:4", quality: "high" } },
            assetIds: [],
            tasks: [],
        } satisfies CreativeAgentRun;

        expect(creativeRunPresentation(run, new Map())).toEqual([
            { key: "mode", label: "类型", value: "图片生成" },
            { key: "size", label: "请求尺寸", value: "3:4" },
            { key: "quality", label: "请求画质", value: "高画质" },
            { key: "status", label: "状态", value: "规划中" },
        ]);
    });

    it("separates requested 4K quality from the saved native image dimensions", () => {
        const asset = imageAsset("native-square", 1254, 1254);
        const run = imageRun([asset.id]);

        expect(creativeRunPresentation(run, new Map(), [asset])).toEqual([
            { key: "mode", label: "类型", value: "图片生成" },
            { key: "model", label: "模型", value: "image-model" },
            { key: "size", label: "请求尺寸", value: "1:1" },
            { key: "quality", label: "请求画质", value: "4K" },
            { key: "actual-size", label: "实际尺寸", value: "1254×1254" },
            { key: "status", label: "状态", value: "已完成" },
        ]);
    });

    it("labels the delivered original dimensions when an enhancement has its own child asset", () => {
        const original = { ...imageAsset("native-square", 1254, 1254), metadata: { enhancementId: "enhancement-one" } };
        const enhanced = { ...imageAsset("enhanced-square", 4096, 4096), parentAssetId: original.id, metadata: { enhancementId: "enhancement-one", provenance: "ai_enhanced" } };
        const run = imageRun([original.id]);

        const items = creativeRunPresentation(run, new Map(), [original, enhanced]);

        expect(items.find((item) => item.key === "actual-size")).toEqual({ key: "actual-size", label: "原图尺寸", value: "1254×1254" });
        expect(items).toContainEqual({ key: "quality", label: "请求画质", value: "4K" });
        expect(run.assetIds).toEqual([original.id]);
        expect([original.width, original.height]).toEqual([1254, 1254]);
    });

    it("keeps every distinct original size when one delivered image has an enhancement identity", () => {
        const originals = [{ ...imageAsset("square-one", 1254, 1254), metadata: { enhancementId: " enhancement-one " } }, imageAsset("portrait", 1024, 1536), imageAsset("square-two", 1254, 1254)];
        const enhanced = { ...imageAsset("enhanced-square", 4096, 4096), parentAssetId: originals[0].id, metadata: { enhancementId: "enhancement-one", provenance: "ai_enhanced" } };

        const items = creativeRunPresentation(imageRun(originals.map((asset) => asset.id)), new Map(), [...originals, enhanced]);

        expect(items.find((item) => item.key === "actual-size")).toEqual({ key: "actual-size", label: "原图尺寸", value: "1254×1254 / 1024×1536" });
    });

    it.each([undefined, "", "   ", 42])("keeps the established label without a delivered enhancement identity (%s)", (enhancementId) => {
        const original = { ...imageAsset("plain-native", 1254, 1254), metadata: { enhancementId } };
        const unrelated = { ...imageAsset("another-run", 4096, 4096), sourceRunId: "another-run", metadata: { enhancementId: "unrelated-enhancement" } };

        const items = creativeRunPresentation(imageRun([original.id]), new Map(), [original, unrelated]);

        expect(items.find((item) => item.key === "actual-size")).toEqual({ key: "actual-size", label: "实际尺寸", value: "1254×1254" });
    });

    it("does not borrow enhanced or requested dimensions when the original size is missing", () => {
        const original = { ...imageAsset("unknown-native", 1254, 1254), width: undefined, metadata: { enhancementId: "enhancement-one", width: 4096, height: 4096 } };
        const enhanced = { ...imageAsset("enhanced-square", 4096, 4096), parentAssetId: original.id, metadata: { enhancementId: "enhancement-one", provenance: "ai_enhanced" } };

        const items = creativeRunPresentation(imageRun([original.id]), new Map(), [original, enhanced]);

        expect(items.find((item) => item.key === "actual-size")).toBeUndefined();
        expect(items).toContainEqual({ key: "quality", label: "请求画质", value: "4K" });
    });

    it("shows every distinct ready image size without repeating matching results", () => {
        const assets = [imageAsset("square-one", 1254, 1254), imageAsset("portrait", 1024, 1536), imageAsset("square-two", 1254, 1254)];

        const items = creativeRunPresentation(imageRun(assets.map((asset) => asset.id)), new Map(), assets);

        expect(items.find((item) => item.key === "actual-size")).toEqual({ key: "actual-size", label: "实际尺寸", value: "1254×1254 / 1024×1536" });
    });

    it("ignores failed images, references, other rounds and media that are not delivered images", () => {
        const result = imageAsset("result", 1254, 1254);
        const failed = { ...imageAsset("failed", 4096, 4096), status: "failed" as const };
        const video = { ...imageAsset("video", 1920, 1080), type: "video" as const };
        const reference = { ...imageAsset("reference", 3000, 3000), sourceRunId: "upload" };
        const previous = { ...imageAsset("previous", 2048, 2048), sourceRunId: "previous-run", messageId: "previous-assistant" };
        const run = imageRun([result.id, failed.id, video.id]);

        const items = creativeRunPresentation(run, new Map(), [reference, previous, failed, video, result]);

        expect(items.find((item) => item.key === "actual-size")).toEqual({ key: "actual-size", label: "实际尺寸", value: "1254×1254" });
    });

    it.each([
        [undefined, undefined],
        [1254, undefined],
        [0, 1254],
        [-1, 1254],
        [1254.5, 1254],
        [Number.NaN, 1254],
        [Number.POSITIVE_INFINITY, 1254],
    ])("does not invent actual dimensions for invalid saved size %s×%s", (width, height) => {
        const asset = { ...imageAsset("unknown", 1254, 1254), width, height, metadata: { width: 4096, height: 4096, size: "4096x4096" } };

        const items = creativeRunPresentation(imageRun([asset.id]), new Map(), [asset]);

        expect(items).toContainEqual({ key: "quality", label: "请求画质", value: "4K" });
        expect(items.find((item) => item.key === "actual-size")).toBeUndefined();
    });

    it("does not treat requested image size as actual output while the assets are unavailable", () => {
        const run = { ...imageRun(["not-loaded"]), generationPreferences: { mode: "image" as const, image: { size: "4096x4096", quality: "4K" } }, tasks: [] };

        const items = creativeRunPresentation(run, new Map(), []);

        expect(items).toContainEqual({ key: "size", label: "请求尺寸", value: "4096x4096" });
        expect(items.find((item) => item.key === "actual-size")).toBeUndefined();
    });

    it.each([undefined, ""])("does not report actual dimensions for a ready image without a media URL (%s)", (serverUrl) => {
        const asset = { ...imageAsset("unavailable", 1254, 1254), serverUrl, remoteUrl: undefined, metadata: { serverUrl: "/generated/not-a-root-url.png" } };

        const items = creativeRunPresentation(imageRun([asset.id]), new Map(), [asset]);

        expect(items).toContainEqual({ key: "quality", label: "请求画质", value: "4K" });
        expect(items.find((item) => item.key === "actual-size")).toBeUndefined();
    });

    it("accepts a delivered image using the existing remote media URL field", () => {
        const asset = { ...imageAsset("remote", 1254, 1254), serverUrl: undefined, remoteUrl: "https://fixture.invalid/native.png" };

        const items = creativeRunPresentation(imageRun([asset.id]), new Map(), [asset]);

        expect(items.find((item) => item.key === "actual-size")).toEqual({ key: "actual-size", label: "实际尺寸", value: "1254×1254" });
    });

    it("preserves audio parameter labels when delivered image dimensions are supplied", () => {
        const run: CreativeAgentRun = {
            ...imageRun(["unrelated-image"]),
            generationPreferences: { mode: "audio", audio: { voice: "alloy", format: "mp3" } },
            requestedModelIds: [],
            tasks: [{ id: "audio-task", title: "生成音频", type: "audio", voice: "alloy", format: "mp3", status: "completed" }],
        };

        expect(creativeRunPresentation(run, new Map(), [imageAsset("unrelated-image", 1254, 1254)])).toEqual([
            { key: "mode", label: "类型", value: "音频生成" },
            { key: "voice", label: "音色", value: "alloy" },
            { key: "format", label: "格式", value: "MP3" },
            { key: "status", label: "状态", value: "已完成" },
        ]);
    });

    it("formats the persisted run duration without inventing a timeout", () => {
        expect(creativeRunDuration({ createdAt: 1_000, updatedAt: 66_000 } as CreativeAgentRun)).toBe("1分5秒");
        expect(creativeRunDuration({ createdAt: 1_000, updatedAt: 1_200 } as CreativeAgentRun)).toBe("1秒");
        expect(creativeRunDuration({ createdAt: 2_000, updatedAt: 1_000 } as CreativeAgentRun)).toBe("");
    });
});

function imageRun(assetIds: string[]): CreativeAgentRun {
    return {
        id: "image-run",
        conversationId: "conversation-one",
        inputMessageId: "image-input",
        assistantMessageId: "image-assistant",
        status: "completed",
        generationPreferences: { mode: "image", image: { size: "1:1", quality: "4K" } },
        assetIds,
        tasks: [{ id: "image-task", title: "生成图片", type: "image", model: "image-model", ratio: "1:1", quality: "4K", status: "completed" }],
    };
}

function imageAsset(id: string, width: number, height: number): CreativeAsset {
    return {
        id,
        userId: "user-one",
        conversationId: "conversation-one",
        sourceRunId: "image-run",
        messageId: "image-assistant",
        ordinal: 0,
        type: "image",
        status: "ready",
        title: id,
        serverUrl: `/generated/${id}.png`,
        width,
        height,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
    };
}
