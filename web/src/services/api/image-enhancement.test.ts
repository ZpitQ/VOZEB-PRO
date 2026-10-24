import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicImageEnhancement } from "@/lib/image-enhancement-contract";
import * as api from "./image-enhancement";

const summary: PublicImageEnhancement = {
    id: "enhancement:fixture/1", imageTaskId: "fixture", resultId: "fixture:1", status: "failed", phase: "poll", reason: "connection_failed", attempt: 1,
    native: { url: "/api/generation-log-assets/native.png", width: 1254, height: 1254, sha256: "a".repeat(64), byteLength: 1000, format: "png", provenance: "provider_native" },
    target: { width: 4096, height: 4096 }, events: [], canRetry: true, canCancel: true,
};
afterEach(() => vi.unstubAllGlobals());

describe("public enhancement task API client", () => {
    it("reads the encoded task URL with a fresh same-origin request", async () => {
        const fetchMock = vi.fn(async () => Response.json({ code: 0, data: summary, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);
        expect(api.getImageEnhancement).toBeTypeOf("function");
        await expect(api.getImageEnhancement(summary.id)).resolves.toEqual(summary);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/image-enhancements/enhancement%3Afixture%2F1", { method: "GET", cache: "no-store", credentials: "same-origin" });
    });

    it.each(["retry", "cancel"] as const)("sends only the explicit %s action to the same encoded task URL", async (action) => {
        const fetchMock = vi.fn(async () => Response.json({ code: 0, data: summary, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);
        expect(api.controlImageEnhancement).toBeTypeOf("function");
        await expect(api.controlImageEnhancement(summary.id, action)).resolves.toEqual(summary);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/image-enhancements/enhancement%3Afixture%2F1", {
            method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
        });
    });

    it.each([
        [409, { code: 409, data: null, msg: "当前增强任务无法操作" }],
        [200, { code: 409, data: null, msg: "当前增强任务无法操作" }],
    ] as const)("uses only the backend message for HTTP %s or application failures", async (status, body) => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
        expect(api.controlImageEnhancement).toBeTypeOf("function");
        await expect(api.controlImageEnhancement(summary.id, "retry")).rejects.toThrow("当前增强任务无法操作");
    });

    it.each([
        () => Response.json({ code: 500, data: { private: "private-token" }, error: "private-worker" }, { status: 500 }),
        () => Response.json({ code: 500, msg: { private: "private-token" } }, { status: 500 }),
        () => new Response("private-worker-token", { status: 500 }),
        () => Response.json(null),
    ])("uses a fixed Chinese fallback for absent messages and malformed responses", async (response) => {
        vi.stubGlobal("fetch", vi.fn(async () => response()));
        expect(api.getImageEnhancement).toBeTypeOf("function");
        await expect(api.getImageEnhancement(summary.id)).rejects.toThrow("增强任务操作失败");
    });

    it("does not expose a transport exception", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private-transport-token"); }));
        expect(api.controlImageEnhancement).toBeTypeOf("function");
        await expect(api.controlImageEnhancement(summary.id, "cancel")).rejects.toThrow("增强任务操作失败");
    });
});

describe("existing administrator enhancement configuration client", () => {
    it.each([
        ["GET", () => api.getImageEnhancementSettings(), undefined],
        ["PATCH", () => api.saveImageEnhancementSettings({ revision: "fixture", enabled: false }), { revision: "fixture", enabled: false }],
        ["POST", () => api.checkImageEnhancementSettings({ revision: "fixture", action: "connection" }), { revision: "fixture", action: "connection" }],
    ] as const)("retains its %s path and request semantics", async (method, invoke, body) => {
        const settings = { revision: "fixture", enabled: false };
        const fetchMock = vi.fn(async () => Response.json({ code: 0, data: settings, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);
        await expect(invoke()).resolves.toEqual(settings);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/admin/image-enhancement", { method, cache: "no-store", credentials: "same-origin", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    });

    it("retains its configuration fallback message", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: 500 }, { status: 500 })));
        await expect(api.getImageEnhancementSettings()).rejects.toThrow("增强配置操作失败");
    });
});
