import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { freezeEcommerceEnhancementDelivery } from "./image-enhancement-delivery";
import type { ImageTask } from "./image-task-store";
import { buildSceneEditProtection } from "./ecommerce-product-regions";

type Input = Parameters<typeof freezeEcommerceEnhancementDelivery>[0];
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function input(): Input {
    return {
        kind: "edit",
        config: { baseUrl: "https://fixture.invalid", apiKey: "system", model: "fixture", apiFormat: "openai", quality: "4k" },
        references: [{ id: "scene", name: "scene.png", type: "image/png", dataUrl: "/api/reference-assets/permanent/fixture-scene.png", ecommerceRole: "scene" }],
        ecommerceExecution: {
            state: "ready",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            prompt: "fixture",
            parameters: { variant: "nano-banana-2" },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "openai" },
            protection: { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: true },
            referenceRoles: [{ assetId: "scene", role: "scene" }],
            canvas: { mode: "ratio", size: { width: 4, height: 4 }, source: "baseline", allowReframe: true },
        },
    };
}
async function strict() {
    const task = input();
    const source = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#724121" } })
        .png()
        .toBuffer();
    const maskPixels = Buffer.alloc(4 * 4 * 4, 255);
    for (let x = 0; x < 4; x++) maskPixels[x * 4 + 3] = 0;
    const mask = await sharp(maskPixels, { raw: { width: 4, height: 4, channels: 4 } })
        .png()
        .toBuffer();
    task.references[0].id = "product";
    task.references[0].ecommerceRole = "product";
    task.ecommerceExecution!.referenceRoles = [{ assetId: "product", role: "product" }];
    task.ecommerceExecution!.protection!.protectedObjectIds = ["product"];
    task.productProtection = {
        compilerVersion: "strict-product.v1",
        state: "ready",
        productAnchorId: "product-root",
        sourceAssetId: "product",
        sourceSize: { width: 4, height: 4 },
        productCore: [{ x: 1, y: 1, width: 2, height: 2 }],
        fusionHalo: [],
        editableBackground: [{ x: 0, y: 0, width: 4, height: 1 }],
        maskProvider: "fixture-trusted",
    };
    task.mask = { id: "mask", name: "mask.png", type: "image/png", dataUrl: `data:image/png;base64,${mask.toString("base64")}`, width: 4, height: 4 };
    const read = vi.fn(async (reference: { id?: string }) => (reference.id === "mask" ? mask : source));
    return { task, source, mask, read };
}

describe("creation-time ecommerce enhancement delivery", () => {
    async function local() {
        const task = input();
        const source = await sharp({ create: { width: 4, height: 6, channels: 3, background: "#724121" } })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toBuffer();
        task.sceneProtection = await buildSceneEditProtection(source, "scene", { x: 1, y: 1, width: 2, height: 2 }, ["vase"], "user_selection");
        task.sceneProtection.confirmation = { actorUserId: "owner", confirmedAt: 1 };
        task.mask = structuredClone(task.sceneProtection.mask);
        task.ecommerceExecution!.protection = { scope: "local", preserveOutsideMask: true, protectedObjectIds: [], allowLightingChange: false };
        const read = vi.fn(async () => source);
        return { task, source, read };
    }
    it("freezes a confirmed local scene source and its canonical upright digest before generation", async () => {
        const { task, source, read } = await local();
        const frozen = await freezeEcommerceEnhancementDelivery(task, read);
        const canonical = await sharp(source).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
        expect(frozen).toMatchObject({
            version: "ecommerce-delivery.v2",
            scope: "local_edit",
            protection: { version: "scene-enhancement.v1", normalization: "srgb-upright-v1", scene: task.sceneProtection },
            baseline: { sha256: digest(source), normalizedSha256: digest(canonical), width: 6, height: 4 },
        });
        task.sceneProtection!.targetRegion.x = 0;
        expect(frozen).not.toMatchObject({ protection: { scene: task.sceneProtection } });
    });
    it.each(["source", "region", "task_mask_url", "scene_mask_url", "mask_identity", "unconfirmed", "not_4k"])("does not freeze local %s outside the trusted creation binding", async (variant) => {
        const { task, source, read } = await local();
        if (variant === "source") task.sceneProtection!.sourceDigest = "f".repeat(64);
        if (variant === "region") task.sceneProtection!.targetRegion.x = 0;
        if (variant === "task_mask_url") task.mask!.remoteUrl = "https://fixture.invalid/mask.png";
        if (variant === "scene_mask_url") task.sceneProtection!.mask.serverUrl = "/api/reference-assets/other-mask.png";
        if (variant === "mask_identity") task.mask!.id = "other-mask";
        if (variant === "unconfirmed") delete task.sceneProtection!.confirmation;
        if (variant === "not_4k") task.config.quality = "2k";
        expect(await freezeEcommerceEnhancementDelivery(task, read)).toBeUndefined();
        if (variant === "not_4k") expect(read).not.toHaveBeenCalled();
        expect(source.length).toBeGreaterThan(0);
    });
    it.each(["2k", "auto", undefined])("keeps non-4K %s full and protected tasks on the original delivery contract", async (quality) => {
        const fixture = await strict();
        for (const task of [input(), fixture.task]) {
            task.config.quality = quality;
            expect(await freezeEcommerceEnhancementDelivery(task, fixture.read)).toBeUndefined();
            expect(fixture.read).not.toHaveBeenCalled();
        }
    });
    it("freezes only an explicit globally unprotected canvas without reading extra media", async () => {
        const task = input();
        const read = vi.fn();
        const frozen = await freezeEcommerceEnhancementDelivery(task, read);
        expect(frozen).toEqual({ version: "ecommerce-delivery.v2", scope: "full_image", canvas: task.ecommerceExecution!.canvas });
        task.ecommerceExecution!.canvas!.size.width = 99;
        expect(frozen!.canvas!.size.width).toBe(4);
        expect(read).not.toHaveBeenCalled();
    });
    it.each(["protected_object", "product_role", "reference_product", "unknown_scope", "local", "mask", "layers", "transparent"])("does not equate %s with permission to enhance the full image", async (variant) => {
        const task = input();
        if (variant === "protected_object") task.ecommerceExecution!.protection!.protectedObjectIds = ["furniture"];
        if (variant === "product_role") task.ecommerceExecution!.referenceRoles[0].role = "product";
        if (variant === "reference_product") task.references[0].ecommerceRole = "product";
        if (variant === "unknown_scope") task.ecommerceExecution!.protection = undefined;
        if (variant === "local") task.ecommerceExecution!.protection = { scope: "local", preserveOutsideMask: true, protectedObjectIds: [], allowLightingChange: false };
        if (variant === "mask") task.mask = { id: "untrusted", name: "mask.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };
        if (variant === "layers") task.config.outputMode = "layers";
        if (variant === "transparent") task.config.outputBackground = "transparent";
        const read = vi.fn();
        expect(await freezeEcommerceEnhancementDelivery(task, read)).toBeUndefined();
        expect(read).not.toHaveBeenCalled();
    });
    it("freezes actual product source bytes, canonical baseline, independent mask and anchor before generation", async () => {
        const { task, source, mask, read } = await strict();
        const frozen = await freezeEcommerceEnhancementDelivery(task, read);
        const canonical = await sharp(source).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
        expect(frozen).toMatchObject({
            version: "ecommerce-delivery.v2",
            scope: "product_background",
            canvas: task.ecommerceExecution!.canvas,
            baseline: { url: task.references[0].dataUrl, sha256: digest(source), byteLength: source.length, width: 4, height: 4, normalizedSha256: digest(canonical) },
            protection: { version: "product-enhancement.v2", normalization: "srgb-upright-v1", maskSha256: digest(mask), maskDataUrl: task.mask!.dataUrl, product: task.productProtection },
        });
        task.productProtection!.productAnchorId = "changed-root";
        task.productProtection!.productCore[0].x = 0;
        task.mask!.dataUrl = "changed";
        task.references[0].dataUrl = "changed-source";
        expect(frozen?.scope === "product_background" && frozen.protection.product.productAnchorId).toBe("product-root");
        expect(frozen?.scope === "product_background" && frozen.protection.product.productCore[0].x).toBe(1);
        expect(read).toHaveBeenCalledTimes(2);
    });
    it.each(["review", "size", "mask_conflict", "source_missing", "scene_local", "execution_local"])("keeps a %s strict product task out of unsupported enhancement", async (variant) => {
        const { task, source, read } = await strict();
        if (variant === "review") task.productProtection!.state = "needs_review";
        if (variant === "size") task.productProtection!.sourceSize.width = 5;
        if (variant === "mask_conflict")
            task.mask!.dataUrl = `data:image/png;base64,${(
                await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
                    .png()
                    .toBuffer()
            ).toString("base64")}`;
        if (variant === "source_missing") task.references = [];
        if (variant === "scene_local") task.sceneProtection = {} as ImageTask["sceneProtection"];
        if (variant === "execution_local") task.ecommerceExecution!.protection!.scope = "local";
        const reader = variant === "mask_conflict" ? async (reference: { id?: string; dataUrl?: string }) => (reference.id === "mask" ? Buffer.from(reference.dataUrl!.split(",")[1], "base64") : source) : read;
        expect(await freezeEcommerceEnhancementDelivery(task, reader)).toBeUndefined();
    });
});
