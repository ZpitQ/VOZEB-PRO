import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CreativeAsset, CreativeMessage } from "@/lib/creative-runtime-contract";
import type { CreativeAgentRun } from "@/services/api/creative";

import { CreativeImageEnhancement } from "./creative-image-enhancement";
import { CreativeMediaResult } from "./creative-media-result";
import { creativeResultPrompt } from "./creative-messages";
import { CreativeVideoResult } from "./creative-video-result";

function renderedText(markup: string) {
    const text = (node: DefaultTreeAdapterMap["node"]): string => ("value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "");
    return text(parseFragment(markup));
}

describe("creative generation results", () => {
    it("describes protected enhancement as keeping the original canvas instead of promising 4K", () => {
        const original = imageOriginal("native-one", "result-one", "enhancement-one");
        const enhanced = enhancedChild("enhanced-one", original);
        enhanced.metadata.scope = "product_background";
        const markup = renderToStaticMarkup(<CreativeMediaResult assets={[original, enhanced]} />);
        expect(renderedText(markup)).toContain("商品保护增强 · 保持原画幅");
        expect(renderedText(markup)).not.toContain("4K");
    });
    it("renders a single portrait image shrink-to-fit without a switcher", () => {
        const markup = renderToStaticMarkup(<CreativeMediaResult assets={[asset("image-one", "image", 720, 1280)]} renderActions={(active) => <div data-active={active.id} />} />);

        expect(markup).toContain('data-results-count="1"');
        expect(markup).toContain('data-rendered-width="300"');
        expect(markup).toContain('data-rendered-height="533"');
        expect(markup).toContain('data-active="image-one"');
        expect(markup).toContain("col-start-1 row-start-2");
        expect(markup).not.toContain("更多生成结果");
        expect(markup).not.toContain("max-w-[612px]");
        expect(markup).not.toContain("min-h-[300px]");
    });

    it("renders the shared switcher for multiple real image assets", () => {
        const markup = renderToStaticMarkup(<CreativeMediaResult assets={[asset("image-one", "image", 1024, 1024), asset("image-two", "image", 1920, 1080)]} />);

        expect(markup).toContain('data-results-count="2"');
        expect(markup).toContain("更多生成结果");
        expect(markup).toContain('aria-label="查看生成结果 2"');
    });

    it("counts only successful image assets when deciding whether to render more results", () => {
        const failed = { ...asset("image-failed", "image", 1024, 1024), status: "failed" as const };
        const markup = renderToStaticMarkup(<CreativeMediaResult assets={[asset("image-ready", "image", 1024, 1024), failed]} />);

        expect(markup).toContain('data-results-count="1"');
        expect(markup).not.toContain("更多生成结果");
    });

    it("treats a persisted enhanced child as a variant of its original and defaults to the real child", () => {
        const original = imageOriginal("native-one", "result-one", "enhancement-one");
        const enhanced = enhancedChild("enhanced-one", original);
        const markup = renderToStaticMarkup(<CreativeMediaResult assets={[original, enhanced]} renderActions={(active) => <div data-active={active.id} data-download={active.serverUrl} />} />);

        expect(markup).toContain('data-results-count="1"');
        expect(markup).not.toContain("更多生成结果");
        expect(markup).toContain('data-active="enhanced-one"');
        expect(markup).toContain('data-download="/enhanced-one.png"');
        expect(renderedText(markup)).toMatch(/当前AI增强\s*2048×2048/);
        expect(markup).toContain("原图");
        expect(markup).toContain("AI增强");
    });

    it.each([
        [false, "native-one", "当前原图", "1254×1536"],
        [true, "native-one", "当前原图", "1254×1536"],
        [true, "enhanced-one", "当前AI增强", "4096×3072"],
    ] as const)("reports selected dimensions with enhanced available=%s and active asset=%s", (hasEnhanced, activeAssetId, label, size) => {
        const original = { ...imageOriginal("native-one", "result-one", "enhancement-one"), width: 1254, height: 1536 };
        const enhanced = hasEnhanced ? { ...enhancedChild("enhanced-one", original), width: 4096, height: 3072 } : undefined;
        const markup = renderToStaticMarkup(<CreativeImageEnhancement original={original} enhanced={enhanced} activeAssetId={activeAssetId} onSelect={() => undefined} />);
        const text = renderedText(markup);

        expect(text.replace(/\s+/g, "")).toContain(`${label}${size}`);
        expect(text).not.toContain(label === "当前原图" ? "当前AI增强" : "当前原图");
        expect(markup).toContain(hasEnhanced ? "AI增强已完成" : "正在读取增强状态，原图可用");
    });

    it.each([
        [undefined, undefined],
        [undefined, 1024],
        [1024, undefined],
        [0, 1024],
        [1024, 0],
        [-1, 1024],
        [1024, -1],
        [1024.5, 1024],
        [1024, 1024.5],
        [Number.NaN, 1024],
        [1024, Number.NaN],
        [Number.POSITIVE_INFINITY, 1024],
        [1024, Number.POSITIVE_INFINITY],
    ])("does not invent selected original or enhanced dimensions for invalid saved size %s×%s", (width, height) => {
        const original = imageOriginal("native-one", "result-one", "enhancement-one");
        const enhanced = enhancedChild("enhanced-one", original);

        for (const selected of [original, enhanced]) {
            const invalid = { ...selected, width, height, metadata: { ...selected.metadata, width: 4096, height: 4096, size: "4096x4096" } };
            const markup = renderToStaticMarkup(<CreativeImageEnhancement original={selected === original ? invalid : original} enhanced={selected === enhanced ? invalid : enhanced} activeAssetId={selected.id} onSelect={() => undefined} />);
            const text = renderedText(markup);

            expect(text).not.toMatch(/\d+[×x]\d+/);
            expect(text).not.toContain("×");
            expect(text).not.toContain("undefined");
            expect(text).not.toContain("NaN");
            expect(text).not.toContain("Infinity");
            expect(markup).toContain("AI增强已完成");
        }
    });

    it.each(["parentAssetId", "parentResultId", "enhancementId"] as const)("groups the actual enhanced child using %s", (link) => {
        const original = imageOriginal("native-one", "result-one", "enhancement-one");
        const enhanced = enhancedChild("enhanced-one", original);
        if (link !== "parentAssetId") delete enhanced.parentAssetId;
        if (link !== "parentResultId") delete enhanced.metadata.parentResultId;
        if (link !== "enhancementId") delete enhanced.metadata.enhancementId;
        const markup = renderToStaticMarkup(<CreativeMediaResult assets={[original, enhanced]} renderActions={(active) => <div data-active={active.id} />} />);

        expect(markup).toContain('data-results-count="1"');
        expect(markup).toContain('data-active="enhanced-one"');
    });

    it("keeps multiple original outputs in the existing switcher without counting their enhanced children", () => {
        const first = imageOriginal("native-one", "result-one", "enhancement-one");
        const second = imageOriginal("native-two", "result-two", "enhancement-two");
        const markup = renderToStaticMarkup(<CreativeMediaResult assets={[first, enhancedChild("enhanced-one", first), second, enhancedChild("enhanced-two", second)]} />);

        expect(markup).toContain('data-results-count="2"');
        expect(markup).toContain('aria-label="查看生成结果 2"');
        expect(markup).not.toContain('aria-label="查看生成结果 3"');
    });

    it("copies the original task public prompt when the enhanced child source task is the enhancement job", () => {
        const original = imageOriginal("native-one", "result-one", "enhancement-one");
        original.metadata.agentTaskId = "original-image-task";
        const enhanced = { ...enhancedChild("enhanced-one", original), sourceTaskId: "enhancement-job" };
        const run: CreativeAgentRun = {
            id: "run",
            conversationId: "conversation",
            inputMessageId: "user",
            assistantMessageId: "assistant",
            status: "completed",
            assetIds: [original.id],
            tasks: [
                { id: "original-image-task", title: "原生图片", type: "image", status: "completed", optimizedPrompt: "原结果的公开优化提示词" },
                { id: "another-image-task", title: "另一个原生图片", type: "image", status: "completed", optimizedPrompt: "其他结果的公开提示词" },
            ],
        };

        expect(creativeResultPrompt(enhanced, [original, enhanced], run)).toBe("原结果的公开优化提示词");
        expect(enhanced.sourceTaskId).toBe("enhancement-job");
    });

    it.each([
        ["disabled", "未启用AI增强"],
        ["not_requested", "本次未请求AI增强"],
        ["protected_contract", "保护图像保持原图"],
        ["unsupported_layers", "分层结果保持原图"],
    ])("shows the truthful no-job skip reason %s while preserving the original", (reason, label) => {
        const original = imageOriginal("native-one", "result-one");
        original.metadata.enhancementSkip = { status: "skipped", reason };
        const markup = renderToStaticMarkup(<CreativeMediaResult assets={[original]} renderActions={(active) => <div data-active={active.id} />} />);

        expect(markup).toContain(label);
        expect(markup).toContain('data-active="native-one"');
        expect(markup).not.toContain("重试增强");
        expect(markup).not.toContain("取消增强");
    });

    it("renders a single square video with no highlights, storyboard or switcher", () => {
        const markup = renderToStaticMarkup(<CreativeVideoResult assets={[asset("video-one", "video", 1024, 1024)]} message={message()} />);

        expect(markup).toContain('data-results-count="1"');
        expect(markup).toContain('data-rendered-width="420"');
        expect(markup).toContain('data-rendered-height="420"');
        expect(markup).not.toContain("更多生成结果");
        expect(markup).not.toContain("视频亮点");
        expect(markup).not.toContain("镜头分镜");
    });

    it("uses the same switcher for multiple real video assets", () => {
        const markup = renderToStaticMarkup(<CreativeVideoResult assets={[asset("video-one", "video", 1920, 1080), asset("video-two", "video", 720, 1280)]} message={message()} />);

        expect(markup).toContain('data-results-count="2"');
        expect(markup).toContain("更多生成结果");
        expect(markup).toContain('aria-label="查看生成结果 2"');
        expect((markup.match(/preload="metadata"/g) || []).length).toBe(1);
    });

    it("counts only successful video assets when deciding whether to render more results", () => {
        const failed = { ...asset("video-failed", "video", 1920, 1080), status: "failed" as const };
        const markup = renderToStaticMarkup(<CreativeVideoResult assets={[asset("video-ready", "video", 1920, 1080), failed]} message={message()} />);

        expect(markup).toContain('data-results-count="1"');
        expect(markup).not.toContain("更多生成结果");
    });

    it("keeps the React-managed video source during Strict Mode effect cleanup", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/create/components/creative-video-result.tsx"), "utf8");
        const effectStart = source.indexOf("useEffect(() =>", source.indexOf("function useVideoPlayback"));
        const cleanup = source.slice(effectStart, source.indexOf("const togglePlayback", effectStart));

        expect(cleanup).toContain("video?.pause()");
        expect(cleanup).not.toContain('removeAttribute("src")');
        expect(cleanup).not.toContain("video.load()");
    });
});

function asset(id: string, type: "image" | "video", width: number, height: number): CreativeAsset {
    return {
        id,
        userId: "user",
        conversationId: "conversation",
        messageId: "assistant",
        sourceRunId: "run",
        ordinal: 0,
        type,
        status: "ready",
        title: id,
        serverUrl: `/${id}.${type === "video" ? "mp4" : "png"}`,
        width,
        height,
        durationMs: type === "video" ? 10_000 : undefined,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
    };
}

function message(): CreativeMessage {
    return { id: "assistant", conversationId: "conversation", runId: "run", sequence: 2, role: "assistant", status: "completed", content: "完成", metadata: {}, createdAt: 1, updatedAt: 1 };
}

function imageOriginal(id: string, resultId: string, enhancementId?: string): CreativeAsset {
    return { ...asset(id, "image", 1024, 1024), metadata: { resultId, ...(enhancementId ? { enhancementId } : {}) } };
}

function enhancedChild(id: string, original: CreativeAsset): CreativeAsset {
    return {
        ...asset(id, "image", 2048, 2048),
        messageId: undefined,
        parentAssetId: original.id,
        metadata: { provenance: "ai_enhanced", parentResultId: original.metadata.resultId, enhancementId: original.metadata.enhancementId },
    };
}
