import type { GenerationLogReferenceSnapshot, GenerationLogRequestSnapshot, GenerationLogRunSnapshot } from "@/lib/generation-log-snapshot";
import type { AgentRun } from "./agent-run-store";
import type { ImageTask } from "./image-task-store";
import { getDatabaseProvider, postgresQuery, type QueryExecutor } from "./database";
import { getStoredGenerationTask } from "./generation-task-store";
import { readJsonDataFile } from "./data-adapter";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { GenerationTaskExecutionState } from "./generation-task-types";
import { toSafeGenerationErrorMessage } from "./generation-errors";

export function generationLogRunSnapshot(run: AgentRun, recordType: GenerationLogRunSnapshot["recordType"]): GenerationLogRunSnapshot {
    return {
        id: run.id,
        recordType,
        status: run.status,
        inputMessageId: run.inputMessageId,
        reason: run.failure || run.ecommerceSnapshot?.fallback?.reason || run.tasks.find((task) => task.error)?.error,
        failureStage: run.failureStage,
        childTaskIds: [...new Set(run.tasks.flatMap((task) => [...(task.taskIds || (task.taskId ? [task.taskId] : [])), ...(task.childTasks?.map((child) => child.id) || [])]))],
    };
}

export async function generationLogReferences(ids: string[], userId: string, executor?: QueryExecutor): Promise<GenerationLogReferenceSnapshot[]> {
    if (!ids.length) return [];
    if (executor || getDatabaseProvider() === "postgres") {
        const result = await (executor || { query: postgresQuery }).query<GenerationLogReferenceSnapshot>(
            `SELECT id, type AS kind, title AS name, mime_type AS "mimeType", server_url AS url,
                    storage_key AS "storageKey", width, height, bytes, duration_ms AS "durationMs",
                    source_run_id AS "sourceRunId", source_task_id AS "sourceTaskId", parent_asset_id AS "parentAssetId",
                    metadata ->> 'sha256' AS sha256
             FROM creative_assets WHERE id = ANY($1::text[]) AND user_id = $2 AND status <> 'deleted' AND type IN ('image', 'video', 'audio')`,
            [ids, userId],
        );
        return result.rows;
    }
    const db = await readJsonDataFile<{ assets: CreativeAsset[] }>("creative-runtime.json", { assets: [] });
    return db.assets
        .filter((asset) => ids.includes(asset.id) && asset.userId === userId && asset.status !== "deleted" && asset.type !== "text")
        .map((asset) => ({
            id: asset.id,
            kind: asset.type === "video" || asset.type === "audio" ? asset.type : "image",
            name: asset.title,
            mimeType: asset.mimeType || "",
            url: asset.serverUrl,
            storageKey: asset.storageKey,
            width: asset.width,
            height: asset.height,
            bytes: asset.bytes,
            durationMs: asset.durationMs,
            sourceRunId: asset.sourceRunId,
            sourceTaskId: asset.sourceTaskId,
            parentAssetId: asset.parentAssetId,
            sha256: typeof asset.metadata.sha256 === "string" ? asset.metadata.sha256 : undefined,
        }));
}

export async function imageTaskLogRequestSnapshot(task: ImageTask & Partial<GenerationTaskExecutionState>, status: "success" | "failed" | "pending", durationMs: number, executor?: QueryExecutor): Promise<GenerationLogRequestSnapshot> {
    let run: AgentRun | null = null;
    if (task.runId) {
        if (executor) {
            const result = await executor.query<{ payload: AgentRun }>("SELECT payload FROM generation_tasks WHERE id = $1 AND user_id = $2 AND task_type = 'agent'", [task.runId, task.userId]);
            run = result.rows[0]?.payload || null;
        } else run = await getStoredGenerationTask<AgentRun>("agent", task.runId);
        if (run && run.userId !== task.userId) throw new Error("生成记录的原始请求归属不匹配");
    }
    const references = run
        ? await generationLogReferences(
              task.references.flatMap((reference) => (reference.id ? [reference.id] : [])),
              task.userId,
              executor,
          )
        : [];
    const checkpoint = run?.ecommerceSnapshot?.referenceCheckpoint;
    return {
        version: 1,
        ...(run ? { run: generationLogRunSnapshot(run, "generation"), userPrompt: run.publicPrompt || run.ecommerceSnapshot?.input.userRequest || run.prompt } : !task.runId ? { userPrompt: task.prompt } : {}),
        parameters: { model: task.config.logicalModel || task.config.model, size: task.config.size, quality: task.config.quality },
        references: task.references.map((reference, providerIndex) => {
            const saved = references.find((asset) => asset.id === reference.id);
            const frozen = checkpoint?.assets.find((entry) => entry.asset.id === reference.id);
            const mapping = task.ecommerceExecution?.referenceMapping?.find((entry) => entry.assetId === reference.id);
            const stableUrl = reference.serverUrl || reference.url || (reference.dataUrl.startsWith("/api/") ? reference.dataUrl : undefined);
            const sourceUrl = frozen?.asset.serverUrl || saved?.url || stableUrl;
            return {
                id: reference.id || `${task.id}:reference:${providerIndex}`,
                kind: "image",
                name: reference.name || saved?.name || `图片${providerIndex + 1}`,
                mimeType: saved?.mimeType || "image/png",
                ...(saved ? saved : {}),
                ...(sourceUrl ? { url: sourceUrl } : {}),
                ...(stableUrl && stableUrl !== sourceUrl ? { submittedUrl: stableUrl } : {}),
                ...(reference.width ? { width: reference.width } : {}),
                ...(reference.height ? { height: reference.height } : {}),
                alias: mapping ? mapping.userAlias || undefined : frozen?.alias,
                purposes: mapping?.purposes,
                providerIndex,
                assetVersion: frozen?.assetVersion,
                sha256: frozen?.contentSha256 || saved?.sha256,
            };
        }),
        slots: [
            {
                id: task.generationSlotId || task.id,
                index: 0,
                status,
                taskId: task.id,
                prompt: task.prompt,
                taskKind: task.kind,
                taskModel: task.config.model,
                referenceIds: task.references.flatMap((reference) => (reference.id ? [reference.id] : [])),
                startedAt: task.createdAt,
                error: status === "failed" ? task.error : undefined,
                attempts: task.attempts?.map((attempt) => {
                    const current = attempt.attemptNo === (task.attemptNo || task.attempts?.at(-1)?.attemptNo);
                    const error = attempt.error || (current && status === "failed" ? task.error : undefined);
                    return {
                        attemptNo: attempt.attemptNo,
                        channelId: attempt.channelId,
                        model: attempt.model,
                        status: current && attempt.status === "running" && status !== "pending" ? (status === "success" ? "succeeded" : "failed") : attempt.status,
                        startedAt: attempt.startedAt,
                        completedAt: attempt.completedAt ?? (current && status !== "pending" ? task.createdAt + durationMs : undefined),
                        pointsCost: attempt.pointsCost ?? (current ? task.billing?.pointsCost : undefined),
                        pointsRecordId: attempt.pointsRecordId || (current ? task.billing?.pointsRecordId : undefined),
                        error: error ? toSafeGenerationErrorMessage(error, "渠道调用失败") : undefined,
                    };
                }),
                billing: task.billing ? { pointsCost: task.billing.pointsCost, pointsRecordId: task.billing.pointsRecordId, refunded: task.billing.refunded } : undefined,
                upstreamTaskId: task.upstream?.id,
                executionPhase: task.executionPhase,
                reviewReason: task.reviewReason,
            },
        ],
    };
}
