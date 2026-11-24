import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GenerationLogMediaResult } from "./admin-generation-log-media";
import type { PublicImageEnhancement } from "@/lib/image-enhancement-contract";
import type { GenerationLogAsset } from "@/lib/server/generation-log-types";

function enhancedAsset(): GenerationLogAsset {
    const enhancement: PublicImageEnhancement = {
        id: "enhancement-one",
        imageTaskId: "image-task-one",
        resultId: "result-one",
        status: "succeeded",
        phase: "completed",
        reason: null,
        attempt: 1,
        native: { url: "/api/generation-log-assets/native.png", width: 1254, height: 1254, byteLength: 1200, sha256: "native-digest", format: "png", provenance: "provider_native" },
        target: { width: 4096, height: 4096 },
        ai: { width: 5016, height: 5016, byteLength: 6000, sha256: "ai-digest", format: "png" },
        enhanced: { url: "/api/generation-log-assets/delivered.jpg", width: 3072, height: 3072, byteLength: 3000, sha256: "delivered-digest", format: "jpeg", assetId: "delivered-asset" },
        events: [],
        canRetry: false,
        canCancel: false,
    };
    return { type: "image", url: enhancement.native.url, width: 1254, height: 1254, bytes: 1200, resultId: "result-one", enhancement };
}

describe("GenerationLogMediaResult", () => {
    it("defaults to the actual delivered file with WebP preview and separate original-byte downloads", () => {
        const markup = renderToStaticMarkup(<GenerationLogMediaResult asset={enhancedAsset()} index={0} />);

        expect(markup).toContain('src="/api/generation-log-assets/delivered.jpg?format=webp&amp;width=960"');
        expect(markup).toContain('alt="图片 1 · 交付图 · result-one"');
        expect(markup).toContain("3072 × 3072");
        expect(markup).toContain("JPEG");
        expect(markup).toContain("2.9 KB");
        expect(markup).toContain("delivered-digest");
        expect(markup).toContain('data-result-id="result-one"');
        expect(markup).toContain('href="/api/generation-log-assets/native.png?download=original"');
        expect(markup).toContain('href="/api/generation-log-assets/delivered.jpg?download=original"');
        expect(markup).toContain("下载原图");
        expect(markup).toContain("下载交付图");
        expect(markup).not.toContain("4096 × 4096");
        expect(markup).not.toContain("5016 × 5016");
        expect(markup).not.toContain('src="/api/generation-log-assets/native.png');
    });

    it.each([undefined, ""])("keeps native media when a successful enhancement has no usable delivered URL (%s)", (url) => {
        const asset = enhancedAsset();
        asset.enhancement = { ...asset.enhancement!, enhanced: url === undefined ? undefined : { ...asset.enhancement!.enhanced!, url } };
        const markup = renderToStaticMarkup(<GenerationLogMediaResult asset={asset} index={0} />);

        expect(markup).toContain('src="/api/generation-log-assets/native.png?format=webp&amp;width=960"');
        expect(markup).toContain("1254 × 1254");
        expect(markup).toContain("PNG");
        expect(markup).toContain("native-digest");
        expect(markup).not.toContain("交付图");
        expect(markup).not.toContain("3072 × 3072");
    });

    it("does not treat an uncompleted artifact as delivered", () => {
        const asset = enhancedAsset();
        asset.enhancement!.status = "running";
        const markup = renderToStaticMarkup(<GenerationLogMediaResult asset={asset} index={0} />);

        expect(markup).toContain('src="/api/generation-log-assets/native.png?format=webp&amp;width=960"');
        expect(markup).not.toContain("交付图");
        expect(markup).not.toContain("delivered-digest");
    });

    it("uses the owned media URL and reports unrecorded facts without inventing file metadata", () => {
        const asset: GenerationLogAsset = { type: "image", url: "https://expired-upstream.invalid/image.png", remoteUrl: "https://expired-upstream.invalid/image.png", serverUrl: "/api/generation-log-assets/owned.png", resultId: "owned-result" };
        const markup = renderToStaticMarkup(<GenerationLogMediaResult asset={asset} index={1} />);

        expect(markup).toContain('src="/api/generation-log-assets/owned.png?format=webp&amp;width=960"');
        expect(markup).toContain('href="/api/generation-log-assets/owned.png?download=original"');
        expect(markup).toContain("尺寸未记录");
        expect(markup).toContain("格式未记录");
        expect(markup).toContain("大小未记录");
        expect(markup).not.toContain("expired-upstream.invalid");
    });

    it("retains video playback controls and the original video download", () => {
        const asset: GenerationLogAsset = { type: "video", url: "/api/generation-log-assets/video.mp4", width: 1920, height: 1080, bytes: 1048576, mimeType: "video/mp4", resultId: "video-result" };
        const markup = renderToStaticMarkup(<GenerationLogMediaResult asset={asset} index={0} />);

        expect(markup).toMatch(/<video[^>]*src="\/api\/generation-log-assets\/video.mp4"[^>]*controls=""/);
        expect(markup).toContain('href="/api/generation-log-assets/video.mp4?download=original"');
        expect(markup).toContain("下载视频");
        expect(markup).toContain("1920 × 1080");
        expect(markup).toContain("MP4");
        expect(markup).not.toContain("交付图");
    });
});
