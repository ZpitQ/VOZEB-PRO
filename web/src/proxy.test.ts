import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { config, proxy } from "./proxy";

describe("application proxy security", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("ignores spoofed forwarded origins unless a trusted proxy is configured", () => {
        const request = writeRequest({
            origin: "https://public.example.com",
            "x-forwarded-host": "public.example.com",
            "x-forwarded-proto": "https",
        });

        expect(proxy(request).status).toBe(403);
        vi.stubEnv("VOZEB_PRO_TRUSTED_PROXY_HOPS", "1");
        expect(proxy(request).status).toBe(200);
    });

    it("uses a per-request script nonce and restricts production connections", () => {
        vi.stubEnv("NODE_ENV", "production");

        const policy = proxy(new NextRequest("https://app.example.com/create")).headers.get("content-security-policy") || "";

        expect(policy).toMatch(/script-src 'self' 'nonce-[a-f0-9]+' 'strict-dynamic' 'wasm-unsafe-eval'/);
        expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
        expect(policy).not.toMatch(/script-src[^;]* 'unsafe-eval'/);
        expect(policy).toContain("connect-src 'self' https:");
        expect(policy).not.toMatch(/connect-src[^;]*http:/);
        expect(policy).toContain("upgrade-insecure-requests");
    });
});

describe("image processing output proxy matching", () => {
    let unstable_doesMiddlewareMatch: typeof import("next/experimental/testing/server").unstable_doesMiddlewareMatch;

    beforeAll(async () => {
        // Next's testing barrel needs its Node environment before it is evaluated.
        await import("next/dist/server/node-environment");
        ({ unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server"));
    });

    it.each([
        "/api/maintenance/image-processing/image-process-case/outputs/analysis",
        "/api/maintenance/image-processing/image-process-case/outputs/analysis/",
        "/api/maintenance/image-processing/image-process-case/outputs/analysis?download=1",
        "/api/maintenance/image-processing/image-process-case/outputs/analysis/?download=1",
        "/api/maintenance/image-processing/image-process-case/outputs/mask",
        "/api/maintenance/image-processing/image-process-case/outputs/mask/",
        "/api/maintenance/image-processing/image-process-case/outputs/mask?download=1",
        "/api/maintenance/image-processing/image-process-case/outputs/mask/?download=1",
        "/api/maintenance/image-processing/image-process-case/outputs/final",
        "/api/maintenance/image-processing/image-process-case/outputs/final/",
        "/api/maintenance/image-processing/image-process-case/outputs/final?resultId=image-task%3A2",
        "/api/maintenance/image-processing/image-process-case/outputs/final/?resultId=image-task%3A2",
        "/api/maintenance/image-processing/image-process-case/outputs/unknown-kind",
    ])("lets the output Route receive its complete path without entering proxy: %s", (url) => {
        expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
    });

    it.each([
        "/api/maintenance/image-processing/claim",
        "/api/maintenance/image-processing/image-process-case/inputs/source",
        "/api/maintenance/image-processing/image-process-case/heartbeat",
        "/api/maintenance/image-processing/image-process-case/complete",
        "/api/auth/login",
        "/api/media-proxy?url=https%3A%2F%2Fmedia.example.com%2Fimage.png",
        "/api/maintenance/image-processing/image-process-case/outputs-extra/mask",
        "/api/maintenance/image-processing/image-process-case/outputs/mask/extra",
        "/api/maintenance/image-processing/image-process-case/outputs/final/extra?resultId=image-task%3A2",
        "/api/maintenance/image-processing/image-process-case/outputs",
        "/api/maintenance/image-processing/image-process-case/outputs/",
        "/api/maintenance/image-processing//outputs/mask",
        "/api/maintenance/image-processing/image-process-case/extra/outputs/mask",
        "/api/maintenance/image-processing-extra/image-process-case/outputs/mask",
        "/api/other/image-processing/image-process-case/outputs/mask",
        "/api/auth/login?next=%2Fapi%2Fmaintenance%2Fimage-processing%2Fimage-process-case%2Foutputs%2Fmask",
    ])("keeps other API and incomplete output paths inside proxy: %s", (url) => {
        expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    });
});

function writeRequest(headers: Record<string, string>) {
    return new NextRequest("http://app.internal/api/auth/login", { method: "POST", headers });
}
