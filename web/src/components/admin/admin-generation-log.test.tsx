import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GenerationLogAssetPreview, GenerationLogDetail } from "./admin-generation-log";
import type { PublicImageEnhancement } from "@/lib/image-enhancement-contract";
import type { StoredGenerationLog } from "@/lib/server/generation-log-types";

function enhancementFixture(): PublicImageEnhancement {
    return {
        id: "enhancement-one", imageTaskId: "image-task-one", resultId: "native-result-one", status: "succeeded", phase: "receipt", reason: null, attempt: 2,
        native: { url: "/api/generation-log-assets/native.png", width: 1254, height: 1254, byteLength: 1200, sha256: "a".repeat(64), format: "png", provenance: "provider_native" },
        target: { width: 4096, height: 4096 }, plannedInference: { width: 5016, height: 5016 }, ai: { width: 5016, height: 5016, byteLength: 4000, sha256: "b".repeat(64), format: "png" }, enhanced: { url: "/api/generation-log-assets/delivered.png", width: 4096, height: 4096, byteLength: 3000, sha256: "c".repeat(64), format: "png", assetId: "asset-one" },
        model: { id: "fixture-model", binaryVersion: "binary-v2", modelVersion: "model-v3" }, timings: { workerQueueMs: 0, workerExecutionMs: 125.5, deliveryEncodingMs: 2.75 }, events: [{ stage: "prepared", at: 1000, attempt: 2 }, { stage: "published", at: 2000, attempt: 2 }], canCancel: false, canRetry: false,
    };
}

function enhancementLog(assets: unknown[]): StoredGenerationLog {
    return { id: "log-one", userId: "owner-one", username: "creator", displayName: "创作者", kind: "image", source: "image-workbench", status: "success", title: "增强记录", prompt: "公开需求", model: "image-model", summary: "完成", durationMs: 1000, count: assets.length, successCount: assets.length, failCount: 0, assets, createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:01.000Z" } as StoredGenerationLog;
}

describe("GenerationLogDetail ecommerce observability", () => {
    it("renders the four ecommerce execution stages and their actual models", () => {
        const markup = renderToStaticMarkup(
            <GenerationLogDetail
                log={
                    {
                        id: "log-one",
                        userId: "user-one",
                        username: "creator",
                        displayName: "创作者",
                        kind: "image",
                        source: "agent",
                        status: "success",
                        title: "商品场景图",
                        prompt: "生成简约家居场景",
                        model: "flare",
                        summary: "完成",
                        durationMs: 1000,
                        count: 1,
                        successCount: 1,
                        failCount: 0,
                        assets: [],
                        createdAt: "2026-09-25T00:00:00.000Z",
                        updatedAt: "2026-09-25T00:00:01.000Z",
                        ecommerceTrace: {
                            version: "ecommerce-generation-trace.v1",
                            runId: "agent-run-one",
                            agentTaskId: "ecommerce-product-scene",
                            imageTaskIds: ["image-task-one"],
                            stages: [
                                { key: "visual_analysis", status: "completed", model: { upstreamModel: "gemini-3.8-flash-high" }, output: { references: [] } },
                                { key: "edit_planning", status: "completed", model: { upstreamModel: "gpt-5.6-sol" }, output: { operation: "product_to_scene" } },
                                { key: "image_generation", status: "completed", model: { upstreamModel: "gpt-image-2.5-flare" }, output: { compilerVersion: "ecommerce-openai-image-2.5.v1" } },
                                {
                                    key: "quality_check",
                                    status: "blocked",
                                    model: { upstreamModel: "gemini-3.8-flash-high" },
                                    output: {
                                        checks: [],
                                        observations: { baseline: { readable: true } },
                                        contradictions: [{ observedCount: 3, reportedCount: 2 }],
                                        sceneProtectionEvidence: [{ outsideMaskMatches: false }],
                                        canvasEvidence: [{ nativeStatus: "readable", nativeSize: { width: 1254, height: 1254 }, nativeMatches: false, storedStatus: "unavailable", storedMatches: null }],
                                    },
                                },
                            ],
                            finalStatus: "needs_review",
                            recordedAt: 500,
                        },
                    } as never
                }
            />,
        );

        expect(markup).toContain("视觉分析");
        expect(markup).toContain("编辑规划");
        expect(markup).toContain("图片生成");
        expect(markup).toContain("结果验收");
        expect(markup).toContain("gpt-image-2.5-flare");
        expect(markup).toContain("gemini-3.8-flash-high");
        expect(markup).toContain("agent-run-one");
        const evidence = markup.replaceAll("&quot;", '"');
        expect(evidence).toContain('"storedMatches": null');
        expect(evidence).toContain('"nativeMatches": false');
        expect(evidence).toContain('"observedCount": 3');
        expect(evidence).toContain('"outsideMaskMatches": false');
        expect(evidence).not.toContain('"storedSize"');
    });
});

describe("GenerationLogDetail AI enhancement observations", () => {
    it.each([true, false])("previews permanent media after upstream expiry with serverUrl=%s", (hasServerUrl) => {
        const managed = "/api/generation-log-assets/permanent/fixture.png";
        const upstream = "https://expired-upstream.invalid/result.png";
        const log = enhancementLog([{ type: "image", url: hasServerUrl ? upstream : managed, remoteUrl: upstream, ...(hasServerUrl ? { serverUrl: managed } : {}) }]);
        const detail = renderToStaticMarkup(<GenerationLogDetail log={log} />);
        const thumbnail = renderToStaticMarkup(<GenerationLogAssetPreview log={log} />);
        for (const markup of [detail, thumbnail]) {
            expect(markup).toContain(`src="${managed}?format=webp`);
            expect(markup).not.toContain("expired-upstream.invalid");
        }
    });
    it("renders independent actual native, full AI and delivered dimensions, exact versions, attempts and measured timings", () => {
        const enhancement = enhancementFixture();
        const markup = renderToStaticMarkup(<GenerationLogDetail log={enhancementLog([{ type: "image", url: enhancement.native.url, resultId: enhancement.resultId, enhancementId: enhancement.id, enhancement }])} />);
        for (const text of ["AI高清增强", "增强成功", "原生实际尺寸", "1254 × 1254", "完整 AI 实际尺寸", "5016 × 5016", "实际交付尺寸", "4096 × 4096", "fixture-model", "binary-v2", "model-v3", "第 2 次尝试", "准备完成", "交付已保存", "Worker 排队", "引擎执行（含启动与写出）", "交付缩小与 PNG 编码", "0 ms", "125.5 ms", "2.75 ms", "下载原图"]) expect(markup).toContain(text);
        expect(markup).toContain('/api/generation-log-assets/native.png?download=1');
        expect(markup).toContain("成功 1 / 失败 0 / 共 1");
    });

    it.each([
        ["queued", "排队中"], ["running", "增强中"], ["succeeded", "增强成功"], ["failed", "增强失败"], ["skipped", "已跳过"], ["cancelled", "已取消"],
    ] as const)("shows %s enhancement without replacing original generation success", (status, label) => {
        const enhancement = { ...enhancementFixture(), status };
        const markup = renderToStaticMarkup(<GenerationLogDetail log={enhancementLog([{ type: "image", url: enhancement.native.url, resultId: enhancement.resultId, enhancementId: enhancement.id, enhancement }])} />);
        expect(markup).toContain(label);
        expect(markup).toContain("成功 1 / 失败 0 / 共 1");
        expect(markup).toContain("下载原图");
    });

    it("keeps separate result observations and describes no-job skips and missing records honestly", () => {
        const enhancement = { ...enhancementFixture(), status: "running", ai: undefined, enhanced: undefined, timings: undefined };
        const markup = renderToStaticMarkup(<GenerationLogDetail log={enhancementLog([
            { type: "image", url: enhancement.native.url, resultId: enhancement.resultId, enhancementId: enhancement.id, enhancement },
            { type: "image", url: "/api/generation-log-assets/skipped.png", resultId: "result-two", enhancementSkip: { status: "skipped", reason: "protected_contract" } },
            { type: "image", url: "/api/generation-log-assets/missing.png", resultId: "result-three", enhancementId: "missing-job" },
        ])} />);
        expect(markup.match(/data-testid="generation-log-enhancement"/g)).toHaveLength(3);
        for (const text of ["增强中", "已跳过", "保护编辑契约不执行增强", "增强记录暂未取得", "AI 预期尺寸", "交付目标尺寸", "未取得"]) expect(markup).toContain(text);
        expect(markup).not.toContain("通过");
        expect(markup).not.toContain("增强失败");
    });

    it("does not label missing actual output or invalid timings as measured facts, and safely labels unknown events", () => {
        const enhancement = { ...enhancementFixture(), status: "running", ai: undefined, enhanced: undefined, reason: "private-worker-token", events: [{ stage: "private-native-path", at: 1000, attempt: 2, reason: "private-address" }], timings: { workerQueueMs: -1, workerExecutionMs: Number.NaN, deliveryEncodingMs: Number.POSITIVE_INFINITY } };
        const markup = renderToStaticMarkup(<GenerationLogDetail log={enhancementLog([{ type: "image", url: enhancement.native.url, resultId: enhancement.resultId, enhancementId: enhancement.id, enhancement }])} />);
        expect(markup).toContain("其他阶段");
        expect(markup).toContain("未分类原因");
        expect(markup).not.toContain("private-");
        expect(markup).not.toContain("0 ms");
        expect(markup).not.toContain("NaN");
        expect(markup).not.toContain("Infinity");
        expect(markup).not.toContain("无需重新编码");
        expect(markup).toMatch(/完整 AI 实际尺寸[\s\S]*?title="未取得"/);
        expect(markup).toMatch(/实际交付尺寸[\s\S]*?title="未取得"/);
    });

    it("shows an encoding exemption only for equal actual AI and delivered artifacts", () => {
        const enhancement = enhancementFixture();
        enhancement.enhanced = { ...enhancement.enhanced!, width: enhancement.ai!.width, height: enhancement.ai!.height };
        enhancement.target = { width: enhancement.ai!.width, height: enhancement.ai!.height };
        enhancement.timings = {};
        const markup = renderToStaticMarkup(<GenerationLogDetail log={enhancementLog([{ type: "image", url: enhancement.native.url, enhancement }])} />);
        expect(markup).toContain("无需重新编码");
        expect(markup).not.toContain("0 ms");
    });
});
