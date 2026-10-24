import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api/points", () => ({ refreshUserPointsIfSystem: vi.fn(), syncUserPointsFromHeaders: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({ resolveModelRequestConfig: vi.fn((config: Record<string, unknown>, model: string) => ({ ...config, model })) }));

import { ImageGenerationTaskTerminalError, createImageGenerationTask, recoverImageGenerationTask, waitForImageGenerationTask } from "./image";
import type { AiConfig } from "@/stores/use-config-store";

describe("图片任务轮询", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("uses the server error message when a restored task has expired", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ error: "图片任务不存在" }, { status: 404 })),
        );

        await expect(waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "expired-task", kind: "generation", model: "image-model" })).rejects.toThrow("图片任务不存在");
    });

    it("sends the stable request identity in both the body and fast lookup headers", async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ task: { id: "image-task", kind: "generation", model: "image-model" } }));
        vi.stubGlobal("fetch", fetchMock);

        await createImageGenerationTask({ apiSource: "system", model: "image-model", imageModel: "image-model" } as AiConfig, "生成图片", [], undefined, {
            clientRequestId: "image-workbench:conversation:slot",
            attemptNo: 3,
        });

        const init = fetchMock.mock.calls[0]?.[1];
        expect(init).toBeDefined();
        if (!init) throw new Error("缺少图片任务请求参数");
        const headers = new Headers(init.headers);
        const body = JSON.parse(String(init.body)) as { context?: { clientRequestId?: string; attemptNo?: number } };
        expect(headers.get("x-vozeb-pro-client-request-id")).toBe("image-workbench:conversation:slot");
        expect(headers.get("x-vozeb-pro-attempt-no")).toBe("3");
        expect(body.context).toMatchObject({ clientRequestId: "image-workbench:conversation:slot", attemptNo: 3 });
    });

    it("reuses a permanent server reference without downloading it before task creation", async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ task: { id: "image-task", kind: "edit", model: "image-model" } }));
        vi.stubGlobal("fetch", fetchMock);

        await createImageGenerationTask({ apiSource: "system", model: "image-model", imageModel: "image-model" } as AiConfig, "基于参考图生成", [
            {
                id: "reference",
                name: "reference.png",
                type: "image/png",
                dataUrl: "/api/reference-assets/permanent/2026/08/04/images/reference.png",
                serverUrl: "/api/reference-assets/permanent/2026/08/04/images/reference.png",
                storageKey: "permanent/2026/08/04/images/reference.png",
                width: 1024,
                height: 1024,
            },
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/image-tasks");
        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { references: Array<{ dataUrl: string; serverUrl?: string }> };
        expect(body.references[0]).toMatchObject({
            dataUrl: "/api/reference-assets/permanent/2026/08/04/images/reference.png",
            serverUrl: "/api/reference-assets/permanent/2026/08/04/images/reference.png",
        });
    });

    it("keeps inline base64 references for providers that require inline images", async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ task: { id: "image-task", kind: "edit", model: "image-model" } }));
        vi.stubGlobal("fetch", fetchMock);
        const inlineImage = "data:image/png;base64,AA==";

        await createImageGenerationTask({ apiSource: "system", model: "image-model", imageModel: "image-model" } as AiConfig, "基于参考图生成", [{ id: "inline", name: "inline.png", type: "image/png", dataUrl: inlineImage, width: 1, height: 1 }]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { references: Array<{ dataUrl: string }> };
        expect(body.references[0]?.dataUrl).toBe(inlineImage);
    });

    it("requests transparent output only for an explicit transparent image task", async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ task: { id: "image-task", kind: "edit", model: "image-model" } }));
        vi.stubGlobal("fetch", fetchMock);

        await createImageGenerationTask({ apiSource: "system", model: "image-model", imageModel: "image-model" } as AiConfig, "提取透明元素", [{ id: "source", name: "source.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }], undefined, {
            outputBackground: "transparent",
        });

        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { config?: { outputBackground?: string } };
        expect(body.config?.outputBackground).toBe("transparent");
    });

    it("marks a single upstream edit request as a layer-output task", async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ task: { id: "layer-task", kind: "edit", model: "image-model" } }));
        vi.stubGlobal("fetch", fetchMock);

        await createImageGenerationTask({ apiSource: "system", model: "image-model", imageModel: "image-model" } as AiConfig, "分层", [{ id: "source", name: "source.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }], undefined, {
            outputMode: "layers",
        });

        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { kind?: string; config?: { outputMode?: string } };
        expect(body).toMatchObject({ kind: "edit", config: { outputMode: "layers" } });
    });

    it("stops polling when the upstream submission needs manual review", async () => {
        const fetchMock = vi.fn(async () => Response.json({ task: { id: "review-task", kind: "generation", model: "image-model", status: "running", needsReview: true, reviewReason: "渠道未返回可查询任务 ID" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "review-task", kind: "generation", model: "image-model" })).rejects.toThrow("渠道未返回可查询任务 ID");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("keeps the original image task checkable when recovery is still inconclusive", async () => {
        const fetchMock = vi.fn(async () => Response.json({ task: { id: "review-task", kind: "generation", model: "image-model", status: "running", needsReview: true, reviewReason: "上游任务仍在处理中" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(recoverImageGenerationTask("review-task")).rejects.toThrow("上游任务仍在处理中");
        expect(fetchMock).toHaveBeenCalledWith("/api/image-tasks/review-task", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "recover" }) }));
    });

    it("keeps polling the same task after a temporary query failure", async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ error: "服务暂不可用" }, { status: 503 }))
            .mockResolvedValueOnce(Response.json({ task: { id: "image-task", kind: "generation", model: "image-model", status: "success", result: { dataUrl: "data:image/png;base64,AA==" } } }));
        vi.stubGlobal("fetch", fetchMock);

        const result = waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "image-task", kind: "generation", model: "image-model" });
        await vi.advanceTimersByTimeAsync(1800);

        await expect(result).resolves.toMatchObject({ dataUrl: "data:image/png;base64,AA==" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("delivers original media immediately and preserves each stable enhancement identity through polling", async () => {
        const nativeSource = { url: "/api/generation-log-assets/native.png", width: 1254, height: 1254, sha256: "a".repeat(64), byteLength: 1000, format: "png", hasAlpha: false, provenance: "provider_native" as const };
        const first = { resultId: "image-task:1", enhancementId: "enhancement:image-task:1", nativeSource, dataUrl: nativeSource.url, width: 1254, height: 1254 };
        const second = { ...first, resultId: "image-task:2", enhancementId: "enhancement:image-task:2", dataUrl: "/api/generation-log-assets/native-second.png", nativeSource: { ...nativeSource, url: "/api/generation-log-assets/native-second.png" } };
        const fetchMock = vi.fn(async () => Response.json({ task: { id: "image-task", kind: "generation", model: "image-model", status: "success", result: { ...first, results: [first, second] } } }));
        vi.stubGlobal("fetch", fetchMock);

        const result = await waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "image-task", kind: "generation", model: "image-model" });

        expect(result).toMatchObject({ ...first, results: [first, second] });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith("/api/image-tasks/image-task", expect.objectContaining({ cache: "no-store" }));
    });

    it.each(["disabled", "not_requested", "protected_contract", "unsupported_layers"])("delivers a no-job %s result immediately and whitelists its public facts", async (reason) => {
        const nativeSource = { url: "/api/generation-log-assets/native.png", width: 8, height: 8, sha256: "a".repeat(64), byteLength: 100, format: "png", hasAlpha: false, provenance: "provider_native" };
        const first = { resultId: "image-task:1", dataUrl: "/api/generation-log-assets/skipped.png", enhancementSkip: { status: "skipped", reason, token: "private-token" }, privateUnknown: "private-future" };
        const second = { resultId: "image-task:2", enhancementId: "enhancement:image-task:2", dataUrl: nativeSource.url, nativeSource: { ...nativeSource, frozenConnection: "private-connection" } };
        const fetchMock = vi.fn(async () => Response.json({ task: { id: "image-task", status: "success", result: { ...first, results: [first, second] } } }));
        vi.stubGlobal("fetch", fetchMock);
        const result = await waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "image-task", kind: "generation", model: "image-model" });
        expect(result).toMatchObject({ resultId: first.resultId, enhancementSkip: { status: "skipped", reason }, results: [{ resultId: first.resultId, enhancementSkip: { status: "skipped", reason } }, { resultId: second.resultId, enhancementId: second.enhancementId, nativeSource }] });
        expect(JSON.stringify(result)).not.toContain("private-");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([{ status: "queued", reason: "disabled" }, { status: "skipped", reason: "private-reason" }, null])("omits an unrecognized no-job contract on the client: %s", async (enhancementSkip) => {
        const media = { dataUrl: "/api/generation-log-assets/skipped.png", enhancementSkip };
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ task: { id: "image-task", status: "success", result: { ...media, results: [media] } } })));
        const result = await waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "image-task", kind: "generation", model: "image-model" });
        expect(result).not.toHaveProperty("enhancementSkip");
        expect(result.results[0]).not.toHaveProperty("enhancementSkip");
    });

    it("marks only an explicit upstream terminal error as retryable", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ task: { id: "failed-task", kind: "generation", model: "image-model", status: "error", error: "上游生成失败", canRetry: true } })),
        );

        const error = await waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "failed-task", kind: "generation", model: "image-model" }).catch((reason) => reason);

        expect(error).toBeInstanceOf(ImageGenerationTaskTerminalError);
        expect(error).toMatchObject({ message: "上游生成失败", canRetry: true });
    });
});
