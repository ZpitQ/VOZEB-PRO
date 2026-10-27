import type { EcommerceCanvasConstraint } from "./ecommerce-edit-plan";
import { resolveResultSize } from "@/app/api/image-tasks/image-task-size";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { isDeepStrictEqual } from "node:util";
import type { ImageTask, ImageTaskReference } from "./image-task-store";
import { compositeProductEnhancement, type ProductEnhancementEvidence, type ProductEnhancementProtection } from "./image-enhancement-product-protection";
import { validateSceneEditProtection } from "./ecommerce-product-regions";
import { ecommerceSceneProtectionReferencesMatch } from "./ecommerce-image-task-orchestration";
import type { SceneEnhancementProtection } from "./image-enhancement-scene-protection";

export type EcommerceEnhancementDelivery =
    | { version: "ecommerce-delivery.v2"; scope: "full_image"; canvas: EcommerceCanvasConstraint }
    | {
          version: "ecommerce-delivery.v2";
          scope: "product_background";
          canvas?: EcommerceCanvasConstraint;
          protection: ProductEnhancementProtection;
          baseline: { url: string; sha256: string; byteLength: number; width: number; height: number; normalizedSha256: string };
      }
    | {
          version: "ecommerce-delivery.v2";
          scope: "local_edit";
          canvas?: EcommerceCanvasConstraint;
          protection: SceneEnhancementProtection;
          baseline: { url: string; sha256: string; byteLength: number; width: number; height: number; normalizedSha256: string };
      };
export type ProductEnhancementBaselineEvidence = {
    version: "product-baseline.v2";
    nativeUrl: string;
    nativeSha256: string;
    baselineUrl: string;
    baselineSha256: string;
    composition: ProductEnhancementEvidence;
};
type DeliveryInput = Pick<ImageTask, "kind" | "config" | "references" | "mask" | "productProtection" | "sceneProtection" | "ecommerceExecution">;

export async function freezeEcommerceEnhancementDelivery(input: DeliveryInput, readSource: (reference: ImageTaskReference) => Promise<Buffer>): Promise<EcommerceEnhancementDelivery | undefined> {
    if (resolveResultSize(input.config.quality, "1:1") !== resolveResultSize("4k", "1:1")) return;
    if (input.config.outputMode === "layers" || input.config.outputBackground === "transparent") return;
    const execution = input.ecommerceExecution;
    const canvas = execution?.canvas ? structuredClone(execution.canvas) : undefined;
    if (input.sceneProtection || execution?.protection?.scope === "local") {
        const scene = input.sceneProtection;
        const reference = input.references.find((item) => item.id === scene?.sourceAssetId);
        if (!scene || !reference) return;
        const sourceUrl = reference.serverUrl || reference.dataUrl || reference.url || reference.remoteUrl;
        if (!sourceUrl || !(sourceUrl.startsWith("/api/reference-assets/") || sourceUrl.startsWith("/api/generation-log-assets/") || sourceUrl.startsWith("data:image/"))) return;
        const contract: Extract<EcommerceEnhancementDelivery, { scope: "local_edit" }> = {
            version: "ecommerce-delivery.v2",
            scope: "local_edit",
            ...(canvas ? { canvas } : {}),
            protection: { version: "scene-enhancement.v1", normalization: "srgb-upright-v1", scene: structuredClone(scene) },
            baseline: { url: sourceUrl, sha256: scene.sourceDigest, byteLength: 0, ...scene.sourceSize, normalizedSha256: "" },
        };
        if (!localEnhancementContractMatches(input, contract)) return;
        try {
            const source = await readSource(reference);
            await validateSceneEditProtection(source, scene);
            const normalized = await sharp(source, { failOn: "warning" }).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer({ resolveWithObject: true });
            contract.baseline = { url: sourceUrl, sha256: digest(source), byteLength: source.length, width: normalized.info.width, height: normalized.info.height, normalizedSha256: digest(normalized.data) };
            return contract;
        } catch {
            return;
        }
    }
    if (input.productProtection) {
        const product = input.productProtection;
        const reference = input.references.find((item) => item.id === product.sourceAssetId);
        if (input.kind !== "edit" || product.state !== "ready" || !input.mask?.dataUrl?.startsWith("data:image/png;base64,") || input.mask.serverUrl || input.mask.url || input.mask.remoteUrl || !reference) return;
        try {
            const sourceUrl = reference.serverUrl || reference.dataUrl || reference.url || reference.remoteUrl;
            if (!sourceUrl || !(sourceUrl.startsWith("/api/reference-assets/") || sourceUrl.startsWith("/api/generation-log-assets/") || sourceUrl.startsWith("data:image/"))) return;
            const [source, mask] = await Promise.all([readSource(reference), readSource(input.mask)]);
            const normalized = await sharp(source, { failOn: "warning" }).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer({ resolveWithObject: true });
            const protection: ProductEnhancementProtection = {
                version: "product-enhancement.v2",
                normalization: "srgb-upright-v1",
                product: structuredClone(product),
                maskDataUrl: `data:image/png;base64,${mask.toString("base64")}`,
                maskSha256: digest(mask),
            };
            await compositeProductEnhancement(source, normalized.data, protection, normalized.info.width * normalized.info.height);
            return {
                version: "ecommerce-delivery.v2",
                scope: "product_background",
                ...(canvas ? { canvas } : {}),
                protection,
                baseline: { url: sourceUrl, sha256: digest(source), byteLength: source.length, width: normalized.info.width, height: normalized.info.height, normalizedSha256: digest(normalized.data) },
            };
        } catch {
            // Unsupported protection keeps the original task contract and never grants full-image write access.
            return;
        }
    }
    const protection = execution?.protection;
    if (
        !canvas ||
        input.mask ||
        execution?.mask ||
        execution?.state !== "ready" ||
        protection?.scope !== "global" ||
        protection.preserveOutsideMask ||
        !Array.isArray(protection.protectedObjectIds) ||
        protection.protectedObjectIds.length ||
        execution.referenceRoles.some((item) => item.role === "product") ||
        input.references.some((item) => item.ecommerceRole === "product")
    )
        return;
    return { version: "ecommerce-delivery.v2", scope: "full_image", canvas };
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function localEnhancementContractMatches(input: DeliveryInput, contract: Extract<EcommerceEnhancementDelivery, { scope: "local_edit" }>) {
    const scene = contract.protection?.scene;
    if (
        !scene?.mask ||
        !scene.sourceSize ||
        !scene.targetRegion ||
        scene.version !== "scene-edit-protection.v1" ||
        scene.selectionSource !== "user_selection" ||
        scene.maskSemantics !== "alpha_zero_edit" ||
        scene.method !== "source_pixels_copy" ||
        ![scene.sourceSize.width, scene.sourceSize.height].every((value) => Number.isSafeInteger(value) && value > 0) ||
        !/^[a-f0-9]{64}$/.test(scene.sourceDigest) ||
        !/^[a-f0-9]{64}$/.test(scene.maskDigest) ||
        typeof scene.confirmation?.actorUserId !== "string" ||
        !scene.confirmation.actorUserId.trim() ||
        !Number.isSafeInteger(scene.confirmation.confirmedAt) ||
        scene.confirmation.confirmedAt <= 0
    )
        return false;
    const execution = input.ecommerceExecution;
    const reference = input.references.find((item) => item.id === scene.sourceAssetId);
    return (
        input.kind === "edit" &&
        !input.productProtection &&
        input.config?.outputMode !== "layers" &&
        input.config?.outputBackground !== "transparent" &&
        execution?.state === "ready" &&
        execution.protection?.scope === "local" &&
        execution.protection.preserveOutsideMask === true &&
        contract.protection.version === "scene-enhancement.v1" &&
        contract.protection.normalization === "srgb-upright-v1" &&
        isDeepStrictEqual(input.sceneProtection, scene) &&
        isDeepStrictEqual(input.mask, scene.mask) &&
        [input.mask?.url, input.mask?.serverUrl, input.mask?.remoteUrl, scene.mask.url, scene.mask.serverUrl, scene.mask.remoteUrl].every((value) => value === undefined) &&
        ecommerceSceneProtectionReferencesMatch(scene.sourceAssetId, input.references, execution) &&
        Boolean(reference) &&
        (reference!.serverUrl || reference!.dataUrl || reference!.url || reference!.remoteUrl) === contract.baseline.url &&
        scene.sourceDigest === contract.baseline.sha256 &&
        isDeepStrictEqual(scene.sourceSize, { width: contract.baseline.width, height: contract.baseline.height }) &&
        isDeepStrictEqual(contract.canvas, execution.canvas)
    );
}
