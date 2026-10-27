import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseImageDimensions, resolveResultSize } from "@/app/api/image-tasks/image-task-size";
import { insertEnhancementJob, type ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { QueryExecutor } from "./database/postgres";
import { planImageEnhancement, type EnhancementDeliverySnapshot, type EnhancementSource } from "./image-enhancement-plan";
import type { ImageTask } from "./image-task-store";
import { evaluateEcommerceCanvas } from "./ecommerce-quality-check";
import { localEnhancementContractMatches } from "./image-enhancement-delivery";

export function imageTaskEnhancementDelivery(task: ImageTask, result: NonNullable<ImageTask["result"]>): EnhancementDeliverySnapshot | undefined {
    const contract = task.enhancementDelivery;
    const source = result.nativeSource;
    if (!contract || contract.version !== "ecommerce-delivery.v2" || !source || !isDeepStrictEqual(contract.canvas, task.ecommerceExecution?.canvas)) return;
    if (contract.scope === "local_edit") {
        if (!localEnhancementContractMatches(task, contract)) return;
        const proof = result.sceneProtectionEvidence;
        const { mask: _mask, ...snapshot } = contract.protection.scene;
        if (!proof) return;
        const { nativeSize, normalization, nativeDigest, compositeDigest, outsidePixels, mappedOutsideChangedPixels, nativeOutsideChangedPixels, compositeOutsideChangedPixels, maskUrl: _maskUrl, nativeUrl, compositeUrl, ...proofSnapshot } = proof;
        const size = contract.protection.scene.sourceSize;
        const region = contract.protection.scene.targetRegion;
        if (![source.width, source.height, source.byteLength, size.width, size.height].every((value) => Number.isSafeInteger(value) && value > 0) || !/^[a-f0-9]{64}$/.test(source.sha256)) return;
        const cross = BigInt(source.width) * BigInt(size.height) - BigInt(source.height) * BigInt(size.width);
        const expectedNormalization = source.width === size.width && source.height === size.height ? "none" : cross === BigInt(0) ? "uniform_scale" : "pixel_grid_scale";
        if (
            !isDeepStrictEqual(snapshot, proofSnapshot) ||
            !isDeepStrictEqual(nativeSize, { width: source.width, height: source.height }) ||
            BigInt(2) * (cross < BigInt(0) ? -cross : cross) >= BigInt(size.width) + BigInt(size.height) ||
            normalization !== expectedNormalization ||
            nativeDigest !== source.sha256 ||
            nativeUrl !== source.url ||
            compositeUrl !== (result.serverUrl || result.dataUrl) ||
            !/^[a-f0-9]{64}$/.test(compositeDigest) ||
            compositeOutsideChangedPixels !== 0 ||
            outsidePixels !== size.width * size.height - region.width * region.height ||
            !Number.isSafeInteger(mappedOutsideChangedPixels) ||
            mappedOutsideChangedPixels < 0 ||
            mappedOutsideChangedPixels > outsidePixels ||
            (normalization === "none" && nativeOutsideChangedPixels !== mappedOutsideChangedPixels) ||
            result.width !== size.width ||
            result.height !== size.height ||
            !Number.isSafeInteger(result.bytes) ||
            result.bytes! <= 0 ||
            result.mimeType !== "image/png"
        )
            return;
        if (
            contract.canvas &&
            (!result.canvasEvidence ||
                !isDeepStrictEqual(result.canvasEvidence.constraint, contract.canvas) ||
                !isDeepStrictEqual(result.canvasEvidence.nativeSize, nativeSize) ||
                !isDeepStrictEqual(result.canvasEvidence.storedSize, size) ||
                result.canvasEvidence.nativeUrl !== nativeUrl ||
                result.canvasEvidence.normalization !== normalization)
        )
            return;
        return { contract, baseline: { url: compositeUrl!, sha256: compositeDigest, width: size.width, height: size.height, byteLength: result.bytes!, format: "png", hasAlpha: false } };
    }
    if (task.sceneProtection) return;
    if (contract.canvas) {
        const evidence = result.canvasEvidence;
        if (
            !evidence ||
            !isDeepStrictEqual(evidence.constraint, contract.canvas) ||
            !isDeepStrictEqual(evidence.nativeSize, { width: source.width, height: source.height }) ||
            !evaluateEcommerceCanvas(contract.canvas, evidence.nativeSize, evidence.storedSize).nativeMatches
        )
            return;
    }
    if (contract.scope === "full_image") {
        const protection = task.ecommerceExecution?.protection;
        if (
            task.productProtection ||
            task.mask ||
            !protection ||
            protection.scope !== "global" ||
            protection.preserveOutsideMask ||
            protection.protectedObjectIds.length ||
            task.ecommerceExecution?.referenceRoles.some((item) => item.role === "product") ||
            task.references.some((item) => item.ecommerceRole === "product")
        )
            return;
        const { provenance: _provenance, ...baseline } = source;
        return { contract, baseline };
    }
    const proof = result.productEnhancementEvidence;
    const composition = proof?.composition;
    const product = contract.protection.product;
    if (
        !isDeepStrictEqual(task.productProtection, product) ||
        !task.mask ||
        task.mask.dataUrl !== contract.protection.maskDataUrl ||
        task.mask.serverUrl ||
        task.mask.url ||
        task.mask.remoteUrl ||
        task.ecommerceExecution?.protection?.scope === "local" ||
        proof?.version !== "product-baseline.v2" ||
        proof.nativeUrl !== source.url ||
        proof.nativeSha256 !== source.sha256 ||
        proof.baselineUrl !== (result.serverUrl || result.dataUrl) ||
        !/^[a-f0-9]{64}$/.test(proof.baselineSha256) ||
        composition?.version !== "product-enhancement.v2" ||
        composition.normalization !== contract.protection.normalization ||
        composition.productAnchorId !== product.productAnchorId ||
        composition.sourceAssetId !== product.sourceAssetId ||
        composition.sourceSha256 !== contract.baseline.sha256 ||
        composition.maskSha256 !== contract.protection.maskSha256 ||
        composition.aiSha256 !== source.sha256 ||
        composition.compositeSha256 !== proof.baselineSha256 ||
        composition.protectedChangedPixels !== 0 ||
        composition.protectedPixels <= 0 ||
        composition.allowedPixels <= 0 ||
        !Number.isSafeInteger(result.bytes) ||
        result.bytes! <= 0 ||
        !isDeepStrictEqual(product.sourceSize, { width: source.width, height: source.height }) ||
        !isDeepStrictEqual(composition.sourceSize, product.sourceSize) ||
        !isDeepStrictEqual(composition.aiSize, product.sourceSize)
    )
        return;
    return { contract, baseline: { url: proof.baselineUrl, sha256: proof.baselineSha256, width: result.width!, height: result.height!, byteLength: result.bytes!, format: "png", hasAlpha: false } };
}

export function enhancementNativeIdentityMatches(task: ImageTask, result: NonNullable<ImageTask["result"]>, source: EnhancementSource, delivery?: EnhancementDeliverySnapshot): boolean {
    if (!isDeepStrictEqual(result.nativeSource, source)) return false;
    if (delivery?.contract.scope === "local_edit") return isDeepStrictEqual(imageTaskEnhancementDelivery(task, result), delivery);
    if (source.width !== result.width || source.height !== result.height) return false;
    if (delivery) return isDeepStrictEqual(imageTaskEnhancementDelivery(task, result), delivery);
    return source.url === (result.serverUrl || result.dataUrl);
}

export function planImageTaskEnhancement(task: ImageTask, result: NonNullable<ImageTask["result"]>) {
    const source = result.nativeSource;
    if (!source) throw new Error("native_invalid");
    const delivery = imageTaskEnhancementDelivery(task, result);
    return planImageEnhancement({
        nativeValid: enhancementNativeIdentityMatches(task, result, source, delivery),
        enabled: task.enhancementPolicy?.enabled ?? false,
        requested4k: resolveResultSize(task.config.quality, "1:1") === resolveResultSize("4k", "1:1"),
        protectedContract:
            !delivery &&
            Boolean(
                task.ecommerceExecution?.canvas ||
                task.sceneProtection ||
                task.productProtection ||
                task.mask ||
                task.ecommerceExecution?.protection?.protectedObjectIds.length ||
                task.ecommerceExecution?.referenceRoles.some((item) => item.role === "product") ||
                task.references.some((item) => item.ecommerceRole === "product"),
            ),
        layered: task.config.outputMode === "layers",
        source,
        target: parseImageDimensions(resolveResultSize(task.config.quality, task.config.size || "auto") || "") || { width: 0, height: 0 },
        connection: task.enhancementPolicy?.connection ?? null,
        ...(delivery ? { delivery } : {}),
    });
}

export async function enqueueImageEnhancement(task: ImageTask, executor?: QueryExecutor): Promise<void> {
    if (task.status !== "success") return;
    const results = task.result?.results?.length ? task.result.results : task.result ? [task.result] : [];
    for (const result of results) {
        if (!result.nativeSource || !result.resultId || !result.enhancementId) continue;
        const decision = planImageTaskEnhancement(task, result);
        const now = task.updatedAt;
        const job: ImageEnhancementJob = {
            id: result.enhancementId,
            userId: task.userId,
            imageTaskId: task.id,
            resultId: result.resultId,
            decision,
            status: decision.status === "rejected" ? "failed" : decision.status,
            phase: decision.status === "queued" ? "prepare" : "completed",
            reason: decision.reason,
            attempt: 1,
            remoteKey: `${result.enhancementId}:1`,
            receiptId: randomUUID(),
            events: [{ stage: decision.status, at: now, attempt: 1, ...(decision.reason ? { reason: decision.reason } : {}) }],
            cancelRequested: false,
            createdAt: now,
            updatedAt: now,
            nextPollAt: decision.status === "queued" ? now : null,
            workerId: null,
            leaseToken: null,
            leaseUntil: null,
        };
        await insertEnhancementJob(job, executor);
    }
}
