import { canResumeSkippedEnhancement, type ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { ImageEnhancementTimings, PublicImageEnhancement } from "@/lib/image-enhancement-contract";

export function publicImageEnhancement(job: ImageEnhancementJob): PublicImageEnhancement {
    const source = job.decision.source;
    const delivery = job.decision.delivery;
    const background = delivery?.contract.scope === "product_background" || delivery?.contract.scope === "local_edit";
    const original = background ? delivery.baseline : source;
    const publication = job.publication;
    const model = job.decision.status === "queued" ? job.decision.connection.model : undefined;
    const timings: ImageEnhancementTimings = {};
    for (const key of ["workerQueueMs", "workerExecutionMs", "deliveryEncodingMs"] as const) {
        const value = job.timings?.[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) timings[key] = value;
    }
    return {
        id: job.id,
        imageTaskId: job.imageTaskId,
        resultId: job.resultId,
        status: job.status,
        phase: job.phase,
        reason: job.reason,
        attempt: job.attempt,
        ...(Object.keys(timings).length ? { timings } : {}),
        native: { url: original.url, width: original.width, height: original.height, sha256: original.sha256, byteLength: original.byteLength, format: original.format, provenance: background ? "protected_composite" : source.provenance },
        ...(background ? { providerNative: { url: source.url, width: source.width, height: source.height, sha256: source.sha256, byteLength: source.byteLength, format: source.format } } : {}),
        ...(delivery
            ? {
                  delivery: {
                      version: delivery.contract.version,
                      scope: delivery.contract.scope,
                      requestedTarget: { width: job.decision.requestedTarget?.width ?? job.decision.target.width, height: job.decision.requestedTarget?.height ?? job.decision.target.height },
                      ...(publication?.protection ? { protectedPixels: publication.protection.protectedPixels, allowedPixels: publication.protection.allowedPixels, protectedChangedPixels: publication.protection.protectedChangedPixels } : {}),
                  },
              }
            : {}),
        target: { width: job.decision.target.width, height: job.decision.target.height },
        ...(job.decision.status === "queued" ? { plannedInference: { width: job.decision.inference.width, height: job.decision.inference.height } } : {}),
        ...(model ? { model: { id: model.id, binaryVersion: model.binaryVersion, modelVersion: model.modelVersion, tta: job.remotePlan?.engine.tta ?? model.tta } } : {}),
        ...(publication
            ? {
                  ai: { width: publication.ai.width, height: publication.ai.height, sha256: publication.ai.sha256, byteLength: publication.ai.byteLength, format: publication.ai.format },
                  enhanced: {
                      url: publication.delivered.url,
                      width: publication.delivered.width,
                      height: publication.delivered.height,
                      sha256: publication.delivered.sha256,
                      byteLength: publication.delivered.byteLength,
                      format: publication.delivered.format,
                      assetId: publication.assetId,
                  },
              }
            : {}),
        events: job.events.map((event) => ({ stage: event.stage, at: event.at, attempt: event.attempt, ...(event.reason ? { reason: event.reason } : {}) })),
        canRetry: (job.status === "failed" && !job.cancelRequested && job.decision.status === "queued") || canResumeSkippedEnhancement(job),
        canCancel: ["queued", "running", "failed"].includes(job.status) && !publication && (!job.cancelRequested || job.status === "failed"),
    };
}
