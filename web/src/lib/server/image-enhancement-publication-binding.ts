import { createHash } from "node:crypto";

import type { ImageProcessingEnhancementOptions, ProductEnhancementEvidence, SceneProtectionEvidence, SceneProtectionSnapshot } from "../image-processing/contracts";
import type { EcommerceEnhancementDelivery } from "./image-enhancement-delivery";
import type { EnhancementDecision, EnhancementSource } from "./image-enhancement-plan";
import type { EnhancementArtifact, FrozenWorkerEnhancementPlan } from "./image-enhancement-worker-client";

export type EnhancementPublicationBindingInput = {
    enhancementId: string;
    userId: string;
    imageTaskId: string;
    resultId: string;
    resultIndex: number;
    attempt: number;
    remoteKey: string;
    remoteJobId: string;
    receiptId: string;
    decision: Extract<EnhancementDecision, { status: "queued" }>;
    remotePlan: FrozenWorkerEnhancementPlan;
    remoteResult: EnhancementArtifact;
    originalProof?: ProductEnhancementEvidence | SceneProtectionEvidence;
};
export type EnhancementPublicationBinding = EnhancementPublicationBindingInput & { version: "enhancement-publication.v1"; algorithmVersion: "enhancement-publication.v1"; bindingDigest: string };

/** Only immutable business facts enter this tuple; current execution and resource policy stay outside it. */
export function createEnhancementPublicationBinding(input: EnhancementPublicationBindingInput): EnhancementPublicationBinding {
    const { decision, remotePlan: plan, remoteResult } = input;
    const scope = decision.delivery?.contract.scope ?? "full_image";
    const tuple = [
        "enhancement-publication.v1",
        [input.enhancementId, input.userId, input.imageTaskId, input.resultId, input.resultIndex, input.attempt, input.remoteKey, input.remoteJobId, input.receiptId],
        [plan.protocolVersion, scope, plan.normalizationProfile, plan.planFingerprint, plan.strategyFingerprint, plan.scope],
        [plan.engine.modelId, plan.engine.binaryVersion, plan.engine.binarySha256, plan.engine.modelVersion, plan.engine.modelSha256, plan.engine.nativeScale, plan.engine.tile, plan.engine.tta, plan.engine.gpuId],
        [decision.connection.revision, decision.connection.credentialRef, decision.connection.serviceId],
        [budgetTuple(plan.budgets.input), budgetTuple(plan.budgets.ai), budgetTuple(plan.budgets.delivery)],
        [
            sourceTuple(decision.source),
            sourceTuple(plan.source),
            plan.sourceSha256,
            sizeTuple(decision.inference),
            artifactTuple(remoteResult),
            sizeTuple(decision.target),
            decision.requestedTarget ? sizeTuple(decision.requestedTarget) : null,
            [plan.target.width, plan.target.height, plan.target.format],
            plan.requestTta === undefined ? null : plan.requestTta,
        ],
        decision.delivery ? [deliveryTuple(decision.delivery.contract), sourceTuple(decision.delivery.baseline)] : null,
        input.originalProof ? proofTuple(input.originalProof) : null,
    ];
    return {
        version: "enhancement-publication.v1",
        algorithmVersion: "enhancement-publication.v1",
        enhancementId: input.enhancementId,
        userId: input.userId,
        imageTaskId: input.imageTaskId,
        resultId: input.resultId,
        resultIndex: input.resultIndex,
        attempt: input.attempt,
        remoteKey: input.remoteKey,
        remoteJobId: input.remoteJobId,
        receiptId: input.receiptId,
        decision: structuredClone(decision),
        remotePlan: structuredClone(plan),
        remoteResult: structuredClone(remoteResult),
        originalProof: input.originalProof ? structuredClone(input.originalProof) : undefined,
        bindingDigest: createHash("sha256").update(JSON.stringify(tuple)).digest("hex"),
    };
}

function budgetTuple(value: { maxBytes: number; maxPixels: number }) {
    return [value.maxBytes, value.maxPixels];
}
function sizeTuple(value: { width: number; height: number }) {
    return [value.width, value.height];
}
function rectangleTuple(value: { x: number; y: number; width: number; height: number }) {
    return [value.x, value.y, value.width, value.height];
}
function artifactTuple(value: { sha256: string; byteLength: number; width: number; height: number; format: string }) {
    return [value.sha256, value.byteLength, value.width, value.height, value.format];
}
function sourceTuple(value: Omit<EnhancementSource, "provenance"> & { provenance?: EnhancementSource["provenance"] }) {
    return [value.url, value.sha256, value.byteLength, value.width, value.height, value.format, value.hasAlpha, value.provenance ?? null];
}
function sceneTuple(value: SceneProtectionSnapshot) {
    return [
        value.version,
        value.sourceAssetId,
        value.sourceDigest,
        sizeTuple(value.sourceSize),
        value.maskDigest,
        sizeTuple(value.maskSize),
        rectangleTuple(value.targetRegion),
        value.semantics,
        value.selectionSource,
        value.confirmation ? [value.confirmation.actorUserId, value.confirmation.confirmedAt] : null,
        value.maskSemantics,
        value.method,
    ];
}
function proofTuple(value: ProductEnhancementEvidence | SceneProtectionEvidence) {
    if (value.version === "product-enhancement.v2")
        return [
            value.version,
            value.normalization,
            value.productAnchorId,
            value.sourceAssetId,
            value.sourceSha256,
            value.maskSha256,
            value.aiSha256,
            value.compositeSha256,
            sizeTuple(value.sourceSize),
            sizeTuple(value.aiSize),
            value.allowedPixels,
            value.protectedPixels,
            value.protectedChangedPixels,
        ];
    return [
        sceneTuple(value),
        sizeTuple(value.nativeSize),
        value.normalization,
        value.nativeDigest,
        value.compositeDigest,
        value.outsidePixels,
        value.mappedOutsideChangedPixels,
        value.nativeOutsideChangedPixels ?? null,
        value.compositeOutsideChangedPixels,
    ];
}
function deliveryTuple(value: EcommerceEnhancementDelivery) {
    const canvas = value.canvas ? [value.canvas.mode, value.canvas.size.width, value.canvas.size.height, value.canvas.source, value.canvas.allowReframe] : null;
    if (value.scope === "full_image") return [value.version, value.scope, canvas];
    const baseline = [value.baseline.url, value.baseline.sha256, value.baseline.byteLength, value.baseline.width, value.baseline.height, value.baseline.normalizedSha256];
    if (value.scope === "local_edit") return [value.version, value.scope, canvas, baseline, [value.protection.version, value.protection.normalization, sceneTuple(value.protection.scene)]];
    const protection = value.protection;
    const product = protection.product;
    return [
        value.version,
        value.scope,
        canvas,
        baseline,
        [
            protection.version,
            protection.normalization,
            product.compilerVersion,
            product.state,
            product.productAnchorId,
            product.sourceAssetId,
            sizeTuple(product.sourceSize),
            product.productCore.map(rectangleTuple),
            product.fusionHalo.map(rectangleTuple),
            product.editableBackground.map(rectangleTuple),
            product.maskProvider ?? null,
            product.reason ?? null,
            protection.maskSha256,
        ],
    ];
}

export type EnhancementPublicationFrozenInput = {
    inputIndex: number;
    assetId: string;
    assetVersion: string;
    expectedSha256: string;
    scope: "generation" | "reference";
    storageKey: string;
    storageProvider: "local" | "object";
    externalStorageId?: string;
    ownerUserId: string;
    bytes: number;
    width: number;
    height: number;
    mimeType: string;
};

export function enhancementPublicationInputDigest(bindingDigest: string, options: ImageProcessingEnhancementOptions, inputs: readonly EnhancementPublicationFrozenInput[]): string {
    const common = [
        options.scope,
        options.bindingDigest,
        options.resultId,
        options.resultIndex,
        options.aiInputIndex,
        sizeTuple(options.engineInput),
        artifactTuple(options.expectedAi),
        sizeTuple(options.targetSize),
        [budgetTuple(options.budgets.input), budgetTuple(options.budgets.ai), budgetTuple(options.budgets.delivery)],
        options.stagedDelivered ? [options.stagedDelivered.inputIndex, artifactTuple(options.stagedDelivered.expected)] : null,
    ];
    let protectedTuple: unknown[] | null = null;
    if (options.scope !== "full_image") {
        const source = options.source;
        const descriptor =
            options.scope === "local_edit"
                ? [options.protection.version, options.protection.normalization, sceneTuple(options.protection.scene)]
                : [options.protection.version, options.protection.normalization, productTuple(options.protection.product), options.protection.maskSha256];
        protectedTuple = [
            options.sourceInputIndex,
            options.nativeInputIndex,
            options.baselineInputIndex,
            options.maskInputIndex,
            [source.sha256, source.byteLength, source.width, source.height, source.normalizedSha256],
            artifactTuple(options.native),
            artifactTuple(options.baseline),
            descriptor,
            proofTuple(options.originalProof),
        ];
    }
    return createHash("sha256")
        .update(
            JSON.stringify([
                "enhancement-publication.v1",
                bindingDigest,
                "process_enhancement",
                [common, protectedTuple],
                inputs.map((input) => [
                    input.inputIndex,
                    input.assetId,
                    input.assetVersion,
                    input.expectedSha256,
                    input.scope,
                    input.storageKey,
                    input.storageProvider,
                    input.externalStorageId ?? null,
                    input.ownerUserId,
                    input.bytes,
                    input.width,
                    input.height,
                    input.mimeType,
                ]),
            ]),
        )
        .digest("hex");
}

function productTuple(product: Extract<EcommerceEnhancementDelivery, { scope: "product_background" }>["protection"]["product"]) {
    return [
        product.compilerVersion,
        product.state,
        product.productAnchorId,
        product.sourceAssetId,
        sizeTuple(product.sourceSize),
        product.productCore.map(rectangleTuple),
        product.fusionHalo.map(rectangleTuple),
        product.editableBackground.map(rectangleTuple),
        product.maskProvider ?? null,
        product.reason ?? null,
    ];
}
