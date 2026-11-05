import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { buildPointRecordDescription } from "@/lib/auth/store-normalizers";
import { readPostgresAuthSettings } from "@/lib/auth/store-repository";
import type { QueryExecutor } from "@/lib/server/database";
import { refundPoints } from "@/lib/server/points-wallet-service";
import { imageUnits } from "@/app/api/image-tasks/image-task-support";
import { generationModelId } from "@/lib/server/generation-channel";
import { getImageTask, updateImageTask, type ImageTask } from "@/lib/server/image-task-store";

export async function refundImageTask(task: ImageTask) {
    const refunded = await refundImageTaskBilling(task);
    if (refunded === task) return task;
    await updateImageTask(task.id, { billing: refunded.billing });
    return (await getImageTask(task.id)) || task;
}

export async function refundImageTaskBilling(task: ImageTask, executor?: QueryExecutor): Promise<ImageTask> {
    const billing = task.billing;
    if ((task.status !== "error" && task.status !== "cancelled") || !billing?.pointsRecordId || billing.refunded) return task;
    const settings = executor ? await readPostgresAuthSettings(executor) : await getAuthSettings();
    const model = generationModelId(task.config);
    const units = imageUnits(task.config.quality, settings.generationPointMultipliers.imageQuality);
    if (executor)
        await refundPoints(
            { userId: task.userId, sourceRecordId: billing.pointsRecordId, idempotencyKey: imageTaskRefundIdempotencyKey(task), usageKind: "image", units, model, description: buildPointRecordDescription(model, "image", "refund") },
            executor,
        );
    else await refundUserPoints(task.userId, model, billing.pointsCost, "image", units, imageTaskRefundIdempotencyKey(task), billing.pointsRecordId);
    return { ...task, billing: { ...billing, refunded: true } };
}

export function imageTaskRefundIdempotencyKey(task: Pick<ImageTask, "id" | "attemptNo">) {
    return `image-task:${task.id}:attempt:${task.attemptNo || 1}:refund`;
}
