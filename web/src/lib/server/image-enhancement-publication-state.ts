import { createHash } from "node:crypto";

import type { ImageProcessingInput, ImageProcessingOutcome } from "../image-processing/contracts";
import type { ImageProcessingResourceFacts } from "../image-processing/resource-model";
import type { ImageProcessingManifest, ImageProcessingMediaReference } from "./image-processing-service";
import type { EnhancementPublicationBinding } from "./image-enhancement-publication-binding";

export type EnhancementProcessingBinding = Pick<EnhancementPublicationBinding, "version" | "enhancementId" | "userId" | "imageTaskId" | "resultId" | "resultIndex" | "attempt" | "remoteKey" | "remoteJobId" | "receiptId" | "bindingDigest">;

export type EnhancementPublicationAdmission = {
    kind: "never_started_unavailable";
    code: "image_processing_resource_unavailable";
    reason: "profile_uncalibrated" | "exceeds_total_budget";
    modelVersion: string;
    profileVersion: string;
    factsDigest: string;
};

type ClosedEnhancementProcessingFailure = Extract<ImageProcessingOutcome, { status: "rejected" | "resource_failure" }>;

export type EnhancementPublicationCheckpoint = {
    version: "enhancement-publication.v1";
    bindingDigest: string;
    jobId: string;
    inputDigest: string;
    algorithmVersion: "enhancement-publication.v1";
    // This only locates frozen owned bytes. A closed CPU receipt qualifies them as an AI artifact.
    rawAi: {
        input: Omit<ImageProcessingInput, "path">;
        source: ImageProcessingMediaReference;
    };
    // Persist both destinations before media writes so interrupted promotion reuses the same originals.
    promotion?: { aiStorageKey: string; deliveredStorageKey: string };
    admission?: EnhancementPublicationAdmission;
    outcome?: { status: "completed"; executionId: string; attemptNo: number; manifestDigest: string; manifest: ImageProcessingManifest } | { status: "failed"; executionId: string; attemptNo: number; failure: ClosedEnhancementProcessingFailure };
};

export function enhancementProcessingBinding(binding: EnhancementPublicationBinding): EnhancementProcessingBinding {
    return {
        version: binding.version,
        enhancementId: binding.enhancementId,
        userId: binding.userId,
        imageTaskId: binding.imageTaskId,
        resultId: binding.resultId,
        resultIndex: binding.resultIndex,
        attempt: binding.attempt,
        remoteKey: binding.remoteKey,
        remoteJobId: binding.remoteJobId,
        receiptId: binding.receiptId,
        bindingDigest: binding.bindingDigest,
    };
}

/** Resource admission has its own frozen facts; execution and business identities do not change with policy. */
export function enhancementPublicationFactsDigest(facts: ImageProcessingResourceFacts): string {
    const tuple = [
        "enhancement-resource-facts.v1",
        facts.encodedInputs.map((input) => [
            input.inputIndex,
            input.assetId,
            input.assetVersion,
            input.sha256,
            input.bytes,
            input.metadataRejected ? ["metadata_rejected"] : input.layout ? ["layout", input.layout.format, input.layout.depth, input.layout.channels] : null,
        ]),
        facts.decodedInputs.map((input) => [input.inputIndex, input.assetId, input.assetVersion, input.sha256, input.width, input.height]),
    ];
    return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}

export function enhancementManifestDigest(manifest: ImageProcessingManifest) {
    const result = manifest.enhancement;
    const proof = result?.protection;
    const protection = !proof
        ? null
        : [
              proof.version,
              proof.normalization,
              proof.sourceAssetId,
              proof.sourceSha256,
              proof.maskSha256,
              proof.aiSha256,
              proof.compositeSha256,
              [proof.sourceSize.width, proof.sourceSize.height],
              [proof.aiSize.width, proof.aiSize.height],
              proof.allowedPixels,
              proof.protectedPixels,
              proof.protectedChangedPixels,
              proof.version === "product-enhancement.v2"
                  ? proof.productAnchorId
                  : [
                        [proof.mapping.context.x, proof.mapping.context.y, proof.mapping.context.width, proof.mapping.context.height],
                        [proof.mapping.targetRegion.x, proof.mapping.targetRegion.y, proof.mapping.targetRegion.width, proof.mapping.targetRegion.height],
                    ],
          ];
    return createHash("sha256")
        .update(
            JSON.stringify([
                "enhancement-manifest.v1",
                manifest.jobId,
                manifest.executionId,
                manifest.sourceIdentities.map((source) => [
                    source.assetId,
                    source.assetVersion,
                    source.sha256,
                    source.bytes,
                    source.width ?? null,
                    source.height ?? null,
                    source.mimeType ?? null,
                    source.decodeError ? [source.decodeError.code, source.decodeError.message] : null,
                ]),
                manifest.artifacts.map((artifact) => [
                    artifact.kind,
                    artifact.storageKey,
                    artifact.sha256,
                    artifact.bytes,
                    artifact.mimeType,
                    artifact.width,
                    artifact.height,
                    artifact.resultId ?? null,
                    artifact.resultIndex ?? null,
                    artifact.layerKind ?? null,
                ]),
                manifest.geometry.sourceSize ? [manifest.geometry.sourceSize.width, manifest.geometry.sourceSize.height] : null,
                result
                    ? [
                          result.version,
                          result.bindingDigest,
                          result.scope,
                          result.aiInputIndex,
                          [result.ai.sha256, result.ai.byteLength, result.ai.width, result.ai.height, result.ai.format],
                          result.deliveredArtifactIndex,
                          result.deliveryEncodingMs ?? null,
                          protection,
                      ]
                    : null,
            ]),
        )
        .digest("hex");
}
