import type { SceneEditProtection } from "./ecommerce-product-regions";
import { compositeSceneEnhancementBytes } from "../image-processing/scene-enhancement";
export type { SceneEnhancementEvidence } from "../image-processing/contracts";

export type SceneEnhancementProtection = {
    version: "scene-enhancement.v1";
    normalization: "srgb-upright-v1";
    scene: SceneEditProtection;
};

export async function compositeSceneEnhancement(baseline: Buffer, ai: Buffer, protection: SceneEnhancementProtection, maxPixels: number) {
    const mask = protection.scene.mask;
    const size = protection.scene.sourceSize;
    if (mask.width !== size.width || mask.height !== size.height) throw new Error("Scene enhancement mask dimensions must match the source");
    if ([mask.serverUrl, mask.url, mask.remoteUrl].some((value) => value !== undefined)) throw new Error("Scene enhancement mask must be inline without URL aliases");
    const dataUrl = mask.dataUrl;
    if (typeof dataUrl !== "string" || !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataUrl)) throw new Error("Scene enhancement mask must be a strict inline PNG data URL");
    const payload = dataUrl.slice("data:image/png;base64,".length);
    const bytes = Buffer.from(payload, "base64");
    if (!bytes.length || bytes.toString("base64") !== payload) throw new Error("Scene enhancement mask must be a strict inline PNG data URL");
    return compositeSceneEnhancementBytes(baseline, ai, bytes, protection, maxPixels);
}
