import { createHash } from "node:crypto";
import sharp from "sharp";

import type { ImageProcessingEnhancementBaseline, ImageProcessingRectangle, ImageProcessingSize, SceneProtectionSnapshot } from "./contracts.ts";
import { ImageProcessingRejection } from "./errors.ts";
import { prepareProductProtection, compositePreparedProduct } from "./product-protection.ts";
import { validateSceneProtectionBytes } from "./scene-protection.ts";

type Qualification = { scope: "local_edit"; protection: SceneProtectionSnapshot } | { scope: "product_background"; productAnchorId: string; productCore: ImageProcessingRectangle[] };

export async function freezeEnhancementBaseline(source: Buffer, mask: Buffer, sourceAssetId: string, size: ImageProcessingSize, qualification: Qualification, sampleMemory: () => void): Promise<ImageProcessingEnhancementBaseline> {
    try {
        if (qualification.scope === "local_edit") {
            const original = await validateSceneProtectionBytes(source, mask, qualification.protection);
            sampleMemory();
            const normalized = await canonicalPng(original.data, size);
            sampleMemory();
            return { status: "qualified", scope: qualification.scope, normalization: "srgb-upright-v1", baseline: baseline(source, normalized, size), hasAlpha: hasTransparentPixel(original.data) };
        }
        const protection = {
            version: "product-enhancement.v2" as const,
            normalization: "srgb-upright-v1" as const,
            maskSha256: digest(mask),
            product: { compilerVersion: "strict-product.v1" as const, state: "ready" as const, productAnchorId: qualification.productAnchorId, sourceAssetId, sourceSize: size, productCore: qualification.productCore },
        };
        const context = await prepareProductProtection(source, mask, protection, size.width * size.height, sampleMemory);
        const normalized = await canonicalPng(context.original.data, size);
        sampleMemory();
        const composed = await compositePreparedProduct(normalized, context, "ai", sampleMemory);
        return { status: "qualified", scope: qualification.scope, normalization: "srgb-upright-v1", baseline: baseline(source, normalized, size), hasAlpha: false, composition: composed.evidence };
    } catch (error) {
        // Only explicit protection ineligibility is optional; codec and infrastructure failures remain failures.
        if (!(error instanceof ImageProcessingRejection) || error.cause !== undefined) throw error;
        return { status: "unsupported", scope: qualification.scope, error: { code: error.code, message: error.message } };
    }
}

export function canonicalPng(pixels: Buffer, size: ImageProcessingSize) {
    return sharp(pixels, { raw: { ...size, channels: 4 } })
        .png()
        .toBuffer();
}
function baseline(source: Buffer, normalized: Buffer, size: ImageProcessingSize) {
    return { sha256: digest(source), byteLength: source.length, width: size.width, height: size.height, normalizedSha256: digest(normalized) };
}
function hasTransparentPixel(pixels: Buffer) {
    for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset] !== 255) return true;
    return false;
}
function digest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}
