import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canvasProviderDimensions, parseImageDimensions, resolveResultSize } from "@/app/api/image-tasks/image-task-size";
import type { ImageProcessingBaseline, ImageProcessingResultInput, ImageProcessingResultOptions } from "@/lib/image-processing/contracts";
import { originalImageSourceUrl } from "@/lib/media-image-url";
import type { ImageProcessingPayload } from "./image-processing-service";
import { localEnhancementContractMatches } from "./image-enhancement-delivery";
import { ecommerceSceneProtectionReferencesMatch } from "./ecommerce-image-task-orchestration";
import type { ImageTask, ImageTaskReference } from "./image-task-store";
import type { LocalMediaRegistration } from "./local-media-registry";

export function imageTaskNativeSceneBaseline(image: ImageTask): ImageProcessingBaseline | undefined {
    if (!image.runId || resolveResultSize(image.config.quality, "1:1") !== resolveResultSize("4k", "1:1") || !image.mask?.serverUrl) return;
    const delivery = image.enhancementDelivery;
    if (
        delivery?.version !== "ecommerce-delivery.v2" ||
        delivery.scope !== "local_edit" ||
        !localEnhancementContractMatches(image, delivery) ||
        !Number.isSafeInteger(delivery.baseline.byteLength) ||
        delivery.baseline.byteLength <= 0 ||
        !/^[a-f0-9]{64}$/.test(delivery.baseline.normalizedSha256)
    )
        throw new Error("Native 4k scene result differs from its frozen delivery");
    const { url: _url, ...baseline } = delivery.baseline;
    return baseline;
}

function isConfirmedLocalSceneRun(image: ImageTask) {
    const protection = image.sceneProtection;
    const execution = image.ecommerceExecution;
    const confirmed = Boolean(
        image.runId &&
        image.kind === "edit" &&
        image.config.outputMode !== "layers" &&
        !image.productProtection &&
        protection?.confirmation &&
        protection.confirmation.actorUserId.trim() &&
        protection.confirmation.confirmedAt > 0 &&
        ecommerceSceneProtectionReferencesMatch(protection.sourceAssetId, image.references, execution) &&
        execution?.state === "ready" &&
        execution.protection?.scope === "local" &&
        execution.protection.preserveOutsideMask &&
        execution.mask?.mode === "independent" &&
        execution.mask.required &&
        execution.canvas?.mode === "exact" &&
        !execution.canvas.allowReframe &&
        isDeepStrictEqual(execution.canvas.size, protection.sourceSize) &&
        isDeepStrictEqual(canvasProviderDimensions(image.ecommerceCanvasRequest), execution.canvas.size) &&
        ((image.mask?.dataUrl.startsWith("data:image/png;base64,") && !image.mask.serverUrl) || (image.mask?.dataUrl === "" && image.mask.serverUrl?.startsWith("/api/reference-assets/"))) &&
        !image.mask.url &&
        !image.mask.remoteUrl &&
        isDeepStrictEqual(image.mask, protection.mask),
    );
    if (!confirmed) return false;
    if (resolveResultSize(image.config.quality, "1:1") !== resolveResultSize("4k", "1:1")) return !image.enhancementDelivery;
    if (!image.mask?.serverUrl) return false;
    return Boolean(imageTaskNativeSceneBaseline(image));
}

export function isNativeSceneImageTaskResult(image: ImageTask) {
    return isConfirmedLocalSceneRun(image) && Boolean(image.mask?.serverUrl);
}

export function isNativeProductImageTaskResult(image: ImageTask) {
    const protection = image.productProtection;
    const execution = image.ecommerceExecution;
    const source = image.references.find((reference) => reference.id === protection?.sourceAssetId);
    return Boolean(
        image.runId &&
        image.kind === "edit" &&
        image.config.outputMode !== "layers" &&
        !image.sceneProtection &&
        !image.enhancementDelivery &&
        protection?.compilerVersion === "strict-product.v1" &&
        protection.state === "ready" &&
        execution?.state === "ready" &&
        execution.canvas &&
        execution.mask?.mode === "independent" &&
        execution.mask.required &&
        source &&
        ((protection.productAnchorId === protection.sourceAssetId && source.ecommerceRole === "product") ||
            (protection.maskProvider === "local-edit-target.v1" &&
                protection.productAnchorId !== protection.sourceAssetId &&
                execution.protection &&
                !execution.protection.preserveOutsideMask &&
                source.ecommerceRole === "scene" &&
                image.references.length >= 2 &&
                image.references[0].id === protection.sourceAssetId &&
                image.references[1].id === protection.productAnchorId &&
                image.references[1].ecommerceRole === "product" &&
                isDeepStrictEqual(
                    execution.referenceRoles,
                    image.references.map((reference) => ({ assetId: reference.id, role: reference.ecommerceRole })),
                ))) &&
        source.width === protection.sourceSize.width &&
        source.height === protection.sourceSize.height &&
        image.mask?.dataUrl === "" &&
        image.mask.serverUrl?.startsWith("/api/reference-assets/") &&
        !image.mask.url &&
        !image.mask.remoteUrl &&
        image.mask.width === protection.sourceSize.width &&
        image.mask.height === protection.sourceSize.height,
    );
}

export function isNativeGlobalSceneImageTaskResult(image: ImageTask) {
    const execution = image.ecommerceExecution;
    if (
        !image.runId ||
        image.kind !== "edit" ||
        image.config.outputMode === "layers" ||
        image.mask ||
        image.sceneProtection ||
        image.productProtection ||
        execution?.state !== "ready" ||
        execution.protection?.scope !== "global" ||
        execution.mask ||
        !execution.canvas ||
        !image.references.length ||
        !image.references.every((reference) => reference.ecommerceRole === "scene")
    )
        return false;
    if (resolveResultSize(image.config.quality, "1:1") !== resolveResultSize("4k", "1:1")) return !image.enhancementDelivery;
    return (
        image.config.outputBackground !== "transparent" &&
        !execution.protection.preserveOutsideMask &&
        Array.isArray(execution.protection.protectedObjectIds) &&
        execution.protection.protectedObjectIds.length === 0 &&
        !execution.referenceRoles.some((reference) => reference.role === "product") &&
        isDeepStrictEqual(image.enhancementDelivery, { version: "ecommerce-delivery.v2", scope: "full_image", canvas: execution.canvas })
    );
}

export function usesImageTaskResultProcessing(image: ImageTask) {
    const requests4k = resolveResultSize(image.config.quality, "1:1") === resolveResultSize("4k", "1:1");
    if (isConfirmedLocalSceneRun(image) || isNativeProductImageTaskResult(image) || isNativeGlobalSceneImageTaskResult(image)) return true;
    if (image.ecommerceExecution || image.ecommerceCanvasRequest) return false;
    if (image.runId && (image.config.outputMode === "layers" || image.sceneProtection || image.productProtection || image.mask)) return false;
    if (requests4k && image.mask && !image.sceneProtection && !image.productProtection && !image.enhancementDelivery && image.config.outputMode !== "layers") return true;
    if (requests4k && image.enhancementDelivery?.scope !== "product_background" && (image.sceneProtection || image.productProtection || image.mask)) return false;
    if (image.config.outputMode === "layers") return Boolean(image.references[0]);
    const sourceId = image.sceneProtection?.sourceAssetId || (requests4k && image.enhancementDelivery?.scope === "product_background" ? image.enhancementDelivery.protection.product.sourceAssetId : undefined);
    if (!sourceId) return true;
    const source = image.references.find((reference) => reference.id === sourceId);
    return Boolean(source);
}

export function imageTaskResultSourceIdentity(image: ImageTask) {
    return {
        kind: image.kind,
        references: image.references,
        mask: image.mask ?? null,
        sceneProtection: image.sceneProtection ?? null,
        productProtection: image.productProtection ?? null,
        enhancementDelivery: image.enhancementDelivery ?? null,
        runId: image.runId ?? null,
        ecommerceExecution: image.ecommerceExecution ?? false,
        ecommerceCanvasRequest: image.ecommerceCanvasRequest ?? false,
        quality: image.config.quality ?? null,
        size: image.config.size ?? null,
        outputBackground: image.config.outputBackground ?? null,
        outputMode: image.config.outputMode ?? null,
    };
}

// PostgreSQL JSONB can reorder every nested object in persisted image facts.
export function canonicalImageTaskResultValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalImageTaskResultValue);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, item]) => [key, canonicalImageTaskResultValue(item)]),
        );
    return value;
}

export function imageTaskResultSourceIdentityDigest(image: ImageTask) {
    return createHash("sha256")
        .update(
            JSON.stringify(
                canonicalImageTaskResultValue({
                    ...imageTaskResultSourceIdentity(image),
                    ...(isNativeSceneImageTaskResult(image) || isNativeProductImageTaskResult(image) || isNativeGlobalSceneImageTaskResult(image)
                        ? { clientRequestId: image.clientRequestId, referenceDispatch: image.referenceDispatch, parentTaskId: image.parentTaskId }
                        : {}),
                }),
            ),
        )
        .digest("hex");
}

export function imageTaskResultFrozenSourceRegistrationMatches(registration: LocalMediaRegistration, imageTaskId: string | undefined) {
    return imageTaskId !== undefined && registration.taskId === imageTaskId && registration.scope === "reference" && registration.storageClass === "permanent" && registration.expiresAt === undefined && registration.source === "image-task-result-source";
}

export function imageTaskResultOptions(image: ImageTask, results: ImageProcessingResultInput[]): ImageProcessingResultOptions {
    // Canvas QA must observe the provider's actual frame, without a target resize.
    if (isNativeProductImageTaskResult(image) || isNativeGlobalSceneImageTaskResult(image)) return { mode: "ordinary", results, transparentBackground: image.config.outputBackground === "transparent" };
    const sourceInputIndex = results.length;
    const maskInputIndex = sourceInputIndex + 1;
    if (image.config.outputMode === "layers") return { mode: "layers", results, sourceInputIndex };
    if (image.sceneProtection) {
        const { mask: _mask, ...protection } = image.sceneProtection;
        const baseline = imageTaskNativeSceneBaseline(image);
        return { mode: "scene_protection", results, sourceInputIndex, maskInputIndex, protection, ...(baseline ? { baseline } : {}) };
    }
    const delivery = image.enhancementDelivery;
    if (resolveResultSize(image.config.quality, "1:1") === resolveResultSize("4k", "1:1") && delivery?.scope === "product_background") {
        const source = image.references.find((reference) => reference.id === delivery.protection.product.sourceAssetId);
        if (
            !source ||
            !isDeepStrictEqual(image.productProtection, delivery.protection.product) ||
            !image.mask ||
            image.mask.dataUrl !== delivery.protection.maskDataUrl ||
            image.mask.serverUrl ||
            image.mask.url ||
            image.mask.remoteUrl ||
            originalImageSourceUrl(imageTaskResultReferenceUrl(source)) !== originalImageSourceUrl(delivery.baseline.url)
        )
            throw new Error("Product result protection differs from its frozen delivery");
        const { maskDataUrl: _maskDataUrl, ...protection } = delivery.protection;
        const { url: _url, ...baseline } = delivery.baseline;
        return { mode: "product_protection", results, sourceInputIndex, maskInputIndex, protection, baseline };
    }
    const targetSize = parseImageDimensions(resolveResultSize(image.config.quality, image.config.size || "auto") || "");
    return { mode: "ordinary", results, ...(targetSize && resolveResultSize(image.config.quality, "1:1") !== resolveResultSize("4k", "1:1") ? { targetSize } : {}), transparentBackground: image.config.outputBackground === "transparent" };
}

export function imageTaskResultReferences(image: ImageTask, options: ImageProcessingResultOptions): ImageTaskReference[] {
    if (options.mode === "ordinary") return [];
    if (options.mode === "layers" && (image.kind !== "edit" || image.references.length !== 1)) throw new Error("Image layers require exactly one original edit source");
    const sourceId = options.mode === "layers" ? image.references[0]?.id : options.mode === "scene_protection" ? options.protection.sourceAssetId : options.protection.product.sourceAssetId;
    if (options.mode === "scene_protection" && (image.kind !== "edit" || !ecommerceSceneProtectionReferencesMatch(sourceId, image.references, image.ecommerceExecution)))
        throw new Error("Scene result protection requires its original edit source and frozen references");
    const source = image.references.find((reference) => reference.id === sourceId);
    if (!source) throw new Error("Image result processing requires its original source reference");
    if (options.mode === "layers") return [source];
    const mask = image.mask;
    if (!mask || (options.mode === "scene_protection" && !isDeepStrictEqual(mask, image.sceneProtection?.mask))) throw new Error("Image result processing requires its original protection mask");
    return [source, mask];
}

export function imageTaskResultReferenceId(image: ImageTask, reference: ImageTaskReference, inputIndex: number) {
    return reference.id || `${image.id}:result-input:${inputIndex}`;
}

export function imageTaskResultReferenceUrl(reference: ImageTaskReference) {
    return reference.serverUrl || reference.dataUrl || reference.url || reference.remoteUrl || "";
}

export function imageTaskResultReferenceLocation(reference: ImageTaskReference): { scope: "reference" | "generation"; storageKey: string } | undefined {
    const url = imageTaskResultReferenceUrl(reference);
    if (!url.startsWith("/api/reference-assets/") && !url.startsWith("/api/generation-log-assets/")) return;
    const match = /^\/api\/(reference-assets|generation-log-assets)\/(.+)$/.exec(new URL(originalImageSourceUrl(url), "http://vozeb.local").pathname);
    if (!match) return;
    const storageKey = match[2].split("/").map(decodeURIComponent).join("/");
    if (storageKey.includes("\\") || storageKey.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Image result reference path is invalid");
    return { scope: match[1] === "reference-assets" ? "reference" : "generation", storageKey };
}

export function imageTaskResultMaskBytes(reference: ImageTaskReference) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(reference.dataUrl);
    if (!match) throw new Error("Image result mask must contain encoded PNG bytes");
    const bytes = Buffer.from(match[1], "base64");
    if (!bytes.length || bytes.toString("base64") !== match[1]) throw new Error("Image result mask encoding is invalid");
    return bytes;
}

export function imageTaskResultInputsMatch(image: ImageTask, payload: ImageProcessingPayload) {
    if (payload.operation !== "process_result" || !usesImageTaskResultProcessing(image)) return false;
    const options = imageTaskResultOptions(image, payload.options.results);
    if (!isDeepStrictEqual(options, payload.options)) return false;
    const references = imageTaskResultReferences(image, options);
    if (
        (payload.imageResultBinding?.sourceIdentityDigest !== undefined || references.length || isNativeProductImageTaskResult(image) || isNativeGlobalSceneImageTaskResult(image)) &&
        payload.imageResultBinding?.sourceIdentityDigest !== imageTaskResultSourceIdentityDigest(image)
    )
        return false;
    const nativeCount = options.results.length;
    const retainedSceneMask = isConfirmedLocalSceneRun(image);
    if (retainedSceneMask && !payload.parentMask) return false;
    if (payload.inputs.length !== nativeCount + references.length || payload.sources.length !== payload.inputs.length - (payload.parentMask && !retainedSceneMask ? 1 : 0)) return false;
    if (payload.parentMask) {
        if (options.mode !== "scene_protection" && options.mode !== "product_protection") return false;
        if (payload.parentMask.imageTaskId !== image.id || payload.parentMask.inputIndex !== options.maskInputIndex) return false;
    }
    return references.every((reference, index) => {
        const inputIndex = nativeCount + index;
        const input = payload.inputs[inputIndex];
        const encoded = payload.resource.facts.encodedInputs.find((item) => item.inputIndex === inputIndex);
        if (
            !input ||
            !encoded ||
            input.assetId !== imageTaskResultReferenceId(image, reference, inputIndex) ||
            encoded.assetId !== input.assetId ||
            encoded.assetVersion !== input.assetVersion ||
            encoded.sha256 !== input.expectedSha256 ||
            input.assetVersion !== encoded.sha256
        )
            return false;
        const location = imageTaskResultReferenceLocation(reference);
        const source = payload.sources.find((item) => item.inputIndex === inputIndex);
        if (location) return source?.scope === location.scope && source.storageKey === location.storageKey;
        if (payload.parentMask?.inputIndex !== inputIndex) return index === 0 && source?.scope === "reference" && source.frozenResultSource === true;
        if (index !== 1 || (retainedSceneMask ? source?.scope !== "reference" || source.frozenResultSource !== true : source !== undefined)) return false;
        const bytes = imageTaskResultMaskBytes(reference);
        return bytes.length === encoded.bytes && createHash("sha256").update(bytes).digest("hex") === input.expectedSha256;
    });
}
