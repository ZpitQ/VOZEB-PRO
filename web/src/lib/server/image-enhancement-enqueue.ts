import { randomUUID } from "node:crypto";
import { parseImageDimensions, resolveResultSize } from "@/app/api/image-tasks/image-task-size";
import { insertEnhancementJob, type ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { QueryExecutor } from "./database/postgres";
import { planImageEnhancement } from "./image-enhancement-plan";
import type { ImageTask } from "./image-task-store";

export function planImageTaskEnhancement(task: ImageTask, result: NonNullable<ImageTask["result"]>) {
    const source = result.nativeSource;
    if (!source) throw new Error("native_invalid");
    return planImageEnhancement({
        nativeValid: source.url === (result.serverUrl || result.dataUrl) && source.width === result.width && source.height === result.height,
        enabled: task.enhancementPolicy?.enabled ?? false,
        requested4k: resolveResultSize(task.config.quality, "1:1") === resolveResultSize("4k", "1:1"),
        protectedContract: Boolean(task.ecommerceExecution?.canvas || task.sceneProtection || task.productProtection || task.mask),
        layered: task.config.outputMode === "layers", source,
        target: parseImageDimensions(resolveResultSize(task.config.quality, task.config.size || "auto") || "") || { width: 0, height: 0 },
        connection: task.enhancementPolicy?.connection ?? null,
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
            id: result.enhancementId, userId: task.userId, imageTaskId: task.id, resultId: result.resultId, decision,
            status: decision.status === "rejected" ? "failed" : decision.status,
            phase: decision.status === "queued" ? "prepare" : "completed", reason: decision.reason,
            attempt: 1, remoteKey: `${result.enhancementId}:1`, receiptId: randomUUID(),
            events: [{ stage: decision.status, at: now, attempt: 1, ...(decision.reason ? { reason: decision.reason } : {}) }],
            cancelRequested: false, createdAt: now, updatedAt: now, nextPollAt: decision.status === "queued" ? now : null,
            workerId: null, leaseToken: null, leaseUntil: null,
        };
        await insertEnhancementJob(job, executor);
    }
}
