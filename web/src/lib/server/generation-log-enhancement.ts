import { getEnhancementJob } from "./database/image-enhancement-job-repository";
import { publicImageEnhancement } from "./image-enhancement-public";
import { generationLogEnhancementReasonLabels, generationLogEnhancementStageLabels, type StoredGenerationLog } from "./generation-log-types";

export async function hydrateGenerationLogEnhancements(logs: StoredGenerationLog[]): Promise<StoredGenerationLog[]> {
    return Promise.all(
        logs.map(async (log) => {
            if (log.kind !== "image") return log;
            const assets = await Promise.all(
                log.assets.map(async (asset, index) => {
                    if (asset.type !== "image" || !asset.enhancementId || !asset.resultId || asset.enhancementSkip) return asset;
                    const slots = log.requestSnapshot?.slots;
                    const taskId = slots?.length ? slots.find((slot) => slot.status === "success" && slot.assetIndex === index)?.taskId : log.taskId;
                    if (!taskId) return asset;
                    const job = await getEnhancementJob(asset.enhancementId, log.userId);
                    if (!job || job.id !== asset.enhancementId || job.userId !== log.userId || job.resultId !== asset.resultId || job.imageTaskId !== taskId) return asset;
                    const summary = publicImageEnhancement(job);
                    const reason = (value: string) => (Object.hasOwn(generationLogEnhancementReasonLabels, value) ? value : "unknown");
                    return {
                        ...asset,
                        enhancement: {
                            ...summary,
                            reason: summary.reason === null ? null : reason(summary.reason),
                            events: summary.events.map((event) => ({ ...event, stage: Object.hasOwn(generationLogEnhancementStageLabels, event.stage) ? event.stage : "unknown", ...(event.reason !== undefined ? { reason: reason(event.reason) } : {}) })),
                        },
                    };
                }),
            );
            return { ...log, assets };
        }),
    );
}
