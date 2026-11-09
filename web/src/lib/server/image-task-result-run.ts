import { isDeepStrictEqual } from "node:util";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, type QueryExecutor } from "./database";
import { getStoredGenerationTaskRecord, type StoredGenerationTaskRecord } from "./generation-task-store";
import type { AgentRun, AgentRunChildTask, AgentRunTask } from "./agent-run-store";
import { originalImageSourceUrl } from "@/lib/media-image-url";
import type { ImageTask } from "./image-task-store";
import { isNativeGlobalSceneImageTaskResult, isNativeProductImageTaskResult, isNativeSceneImageTaskResult, usesImageTaskResultProcessing } from "./image-task-result-contract";
import { compileStrictProductEdit } from "./ecommerce-product-regions";

export type ImageResultRunBinding = { runId: string; agentTaskId: string; agentAttempt: number };
export type ImageResultRun = Pick<StoredGenerationTaskRecord, "id" | "userId" | "status" | "expiresAt" | "conversationId" | "surface" | "projectId"> & { payload: AgentRun };

export async function readImageResultRun(runId: string | undefined, executor?: QueryExecutor, lock = false): Promise<ImageResultRun | undefined> {
    if (!runId) return;
    if (getDatabaseProvider() !== "postgres") {
        const record = await getStoredGenerationTaskRecord("agent", runId);
        return record ? fileImageResultRun([record], runId) : undefined;
    }
    if (!executor) await ensurePostgresSchema();
    const query: QueryExecutor["query"] = executor ? executor.query.bind(executor) : postgresQuery;
    const result = await query<{
        id: string;
        user_id: string;
        status: StoredGenerationTaskRecord["status"];
        payload: AgentRun;
        expires_at: Date;
        conversation_id: string | null;
        surface: StoredGenerationTaskRecord["surface"] | null;
        project_id: string | null;
    }>(`SELECT id, user_id, status, payload, expires_at, conversation_id, surface, project_id FROM generation_tasks WHERE id = $1 AND task_type = 'agent'${lock ? " FOR UPDATE" : ""}`, [runId]);
    const row = result.rows[0];
    return row
        ? { id: row.id, userId: row.user_id, status: row.status, payload: row.payload, expiresAt: row.expires_at.getTime(), conversationId: row.conversation_id ?? undefined, surface: row.surface ?? undefined, projectId: row.project_id ?? undefined }
        : undefined;
}

export function fileImageResultRun(records: StoredGenerationTaskRecord[], runId: string | undefined): ImageResultRun | undefined {
    const record = runId ? records.find((item) => item.type === "agent" && item.id === runId) : undefined;
    return record ? { ...record, payload: record.payload as AgentRun } : undefined;
}

function imageResultRunSourceIdentityMatches(run: ImageResultRun | undefined, image: ImageTask, now: number): run is ImageResultRun {
    return Boolean(
        run &&
        run.id === image.runId &&
        run.userId === image.userId &&
        run.payload.id === run.id &&
        run.payload.userId === run.userId &&
        run.expiresAt > now &&
        run.conversationId === run.payload.conversationId &&
        run.surface === run.payload.surface &&
        run.projectId === run.payload.projectId &&
        run.payload.conversationId === image.conversationId &&
        run.payload.surface === image.surface &&
        run.payload.projectId === image.projectId,
    );
}

function imageResultRunSourceMatches(run: ImageResultRun | undefined, image: ImageTask, now: number, cancelling: boolean): run is ImageResultRun {
    return (
        imageResultRunSourceIdentityMatches(run, image, now) &&
        (cancelling || (!run.payload.cancellation && run.status !== "success" && run.status !== "error" && run.status !== "cancelled" && run.payload.status !== "completed" && run.payload.status !== "failed" && run.payload.status !== "cancelled"))
    );
}

export function imageResultRunBinding(run: ImageResultRun | undefined, image: ImageTask, now: number, cancelling = false): ImageResultRunBinding | undefined {
    if (!imageResultRunSourceMatches(run, image, now, cancelling)) return;
    return imageResultRunTaskBinding(run, image, (task, child) => (cancelling || (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled")) && (cancelling || child.status === "pending" || child.status === "needs_review"));
}

// An applied completion may outlive natural Run completion; cancellation never authorizes repair.
export function appliedImageResultRunBinding(run: ImageResultRun | undefined, image: ImageTask, now: number): ImageResultRunBinding | undefined {
    if (!imageResultRunSourceIdentityMatches(run, image, now) || run.payload.cancellation || run.status === "cancelled" || run.status === "error" || run.payload.status === "cancelled" || run.payload.status === "failed") return;
    return imageResultRunTaskBinding(run, image, (task, child) => task.status !== "cancelled" && task.taskIds?.includes(image.id) === true && child.status !== "pending" && child.status !== "cancelled");
}

function imageResultRunTaskBinding(run: ImageResultRun, image: ImageTask, eligible: (task: AgentRunTask, child: AgentRunChildTask) => boolean): ImageResultRunBinding | undefined {
    const confirmedScene = image.sceneProtection && usesImageTaskResultProcessing(image);
    const nativeScene = isNativeSceneImageTaskResult(image);
    const nativeProduct = isNativeProductImageTaskResult(image);
    const nativeGlobal = isNativeGlobalSceneImageTaskResult(image);
    if ((nativeScene || nativeProduct || nativeGlobal) && run.payload.tasks.flatMap((task) => task.childTasks || []).filter((child) => child.id === image.id).length !== 1) return;
    const matches = run.payload.tasks.flatMap((task) =>
        task.type === "image" &&
        (!nativeProduct || nativeProductResultTaskMatches(run.payload, task, image)) &&
        (!nativeGlobal || nativeGlobalSceneResultTaskMatches(run.payload, task, image)) &&
        (!confirmedScene ||
            ((nativeScene ? nativeSceneResultTaskMatches(run.payload, task, image) : task.count === 1 && task.childTasks?.length === 1) &&
                isDeepStrictEqual(task.sceneProtection, image.sceneProtection) &&
                isDeepStrictEqual(task.ecommerceExecution, image.ecommerceExecution)))
            ? (task.childTasks || []).filter((child) => child.id === image.id && child.attempt === task.attempts && eligible(task, child)).map((child) => ({ runId: run.id, agentTaskId: task.id, agentAttempt: child.attempt }))
            : [],
    );
    if (matches.length !== 1) return;
    return matches[0];
}

function nativeSceneResultTaskMatches(run: AgentRun, task: AgentRunTask, image: ImageTask, prompt = task.prompt) {
    const fence = image.referenceDispatch;
    const checkpoint = run.ecommerceSnapshot?.referenceCheckpoint;
    const references = task.references || [];
    return Boolean(
        image.parentTaskId === run.id &&
        task.taskIds?.includes(image.id) &&
        fence?.executionId.trim() &&
        checkpoint?.version === "ecommerce-reference-checkpoint.v1" &&
        checkpoint.state === "resolved" &&
        checkpoint.analysisStage.state === "completed" &&
        fence.inputId === checkpoint.inputId &&
        fence.decisionId === checkpoint.decisionId &&
        fence.analysisRequestId === checkpoint.analysisStage.requestId &&
        Number.isSafeInteger(fence.copy) &&
        fence.copy >= 1 &&
        fence.copy <= task.count &&
        image.clientRequestId === `${run.clientRequestId}:${task.id}:${task.attempts}:${fence.copy}` &&
        image.prompt === prompt &&
        references.length === image.references.length &&
        references.every(
            (reference, index) =>
                reference.assetId === image.references[index].id &&
                reference.ecommerceRole === image.references[index].ecommerceRole &&
                originalImageSourceUrl(reference.url) === originalImageSourceUrl(image.references[index].url || image.references[index].serverUrl || image.references[index].remoteUrl || ""),
        ),
    );
}

export function nativeGlobalSceneResultTaskMatches(run: AgentRun, task: AgentRunTask, image: ImageTask) {
    return isNativeGlobalSceneImageTaskResult(image) && !task.sceneProtection && !task.productProtectionRegions && isDeepStrictEqual(task.ecommerceExecution, image.ecommerceExecution) && nativeSceneResultTaskMatches(run, task, image);
}

export function nativeProductResultTaskMatches(run: AgentRun, task: AgentRunTask, image: ImageTask) {
    if (image.kind !== "edit" || !image.productProtection || !task.productProtectionRegions || !isDeepStrictEqual(task.ecommerceExecution, image.ecommerceExecution)) return false;
    try {
        const compiled = compileStrictProductEdit({ kind: image.kind, prompt: task.prompt, config: image.config, references: image.references }, task.productProtectionRegions);
        if (compiled.state !== "ready") return false;
        // JSON persistence omits the ready snapshot's undefined reason.
        const { reason, ...protection } = image.productProtection;
        const { reason: _reason, ...expectedProtection } = compiled.task.productProtection;
        return reason === undefined && nativeSceneResultTaskMatches(run, task, image, compiled.task.prompt) && isDeepStrictEqual(expectedProtection, protection) && isDeepStrictEqual(compiled.task.mask, image.mask);
    } catch {
        return false;
    }
}

export function imageResultRunMatches(run: ImageResultRun | undefined, image: ImageTask, binding: ImageResultRunBinding | undefined, now: number, cancelling = false) {
    if (!binding) return !image.runId;
    const current = imageResultRunBinding(run, image, now, cancelling);
    return current?.runId === binding.runId && current.agentTaskId === binding.agentTaskId && current.agentAttempt === binding.agentAttempt;
}

// POST schedules its after callback before the dispatcher can persist task.created.
// This permits waiting for that association; only actual child membership authorizes a job.
export function canWaitForImageResultRun(run: ImageResultRun | undefined, image: ImageTask, now: number) {
    if (image.resultProcessing || !imageResultRunSourceMatches(run, image, now, false) || run.payload.tasks.some((task) => task.childTasks?.some((child) => child.id === image.id))) return false;
    return run.payload.tasks.some((task) => task.type === "image" && task.status === "running" && (image.parentTaskId === task.id || image.parentTaskId === run.id));
}
