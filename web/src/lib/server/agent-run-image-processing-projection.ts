import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentRun, AgentRunChildTask } from "./agent-run-store";
import type { AgentImageProcessingPayload, ImageProcessingStoredResult } from "./image-processing-service";
import type { ImageTask } from "./image-task-store";
import { appliedImageResultRunBinding, fileImageResultRun, imageResultRunBinding } from "./image-task-result-run";
import { canonicalImageTaskResultValue, imageTaskResultInputsMatch, imageTaskResultSourceIdentityDigest } from "./image-task-result-contract";
import { imageProcessingFailureIdentity, imageProcessingPauseMessage } from "./image-processing-failure";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction, type QueryExecutor } from "./database";
import { GENERATION_TASK_FILE, getStoredGenerationTaskRecord, withGenerationTaskFileRead, type StoredGenerationTaskRecord } from "./generation-task-store";
import { writeJsonDataFile } from "./data-adapter";
import { applyRuntimeMutation, normalizeTaskStatus, queueRuntimeFileOperation, readRuntimeFile, updatePostgresAssistant, writeRuntimeFile, type RunMutation } from "./creative-runtime-repository";
import { notifyCreativeRunEvent } from "./creative-run-event-signal";

export type AgentImageProcessingFact = {
    jobId: string;
    inputDigest: string;
    factIdentity: string;
    eventType: "task.needs_review" | "task.child.completed" | "task.child.failed";
};

export type AgentImageProcessingObservation = {
    runId: string;
    taskId: string;
    imageId: string;
    attempt: number;
    sourceIdentity: string;
    fact: AgentImageProcessingFact | null;
};

type Storage = QueryExecutor | StoredGenerationTaskRecord[];
type ProjectionMutation = RunMutation<AgentRun> & { event: { type: string; data: Record<string, unknown> } };
type Projection = (run: AgentRun, observation: AgentImageProcessingObservation & { fact: AgentImageProcessingFact }) => ProjectionMutation;
type AppliedObservation = AgentImageProcessingObservation & { fact: AgentImageProcessingFact };
type FactUpdate = {
    observation: AgentImageProcessingObservation;
    executionId: string;
    ttlMs: number;
    mutate: (current: AgentRun) => AgentRun | null;
};

export class AgentImageProcessingFactChangedError extends Error {
    constructor() {
        super("图像结果处理状态已变化，请稍后检查。");
    }
}

export class AgentImageProcessingProjectionError extends Error {
    constructor(cause: unknown) {
        super("图像结果事实读取或公开消息投影暂未完成。", { cause });
    }
}

function identity(value: unknown) {
    return createHash("sha256")
        .update(JSON.stringify(canonicalImageTaskResultValue(value)))
        .digest("hex");
}

function stageFact(stage: StoredGenerationTaskRecord, payload: AgentImageProcessingPayload, image: StoredGenerationTaskRecord): AgentImageProcessingFact | null {
    const result = stage.resultPayload as ImageProcessingStoredResult | undefined;
    let evidence: unknown;
    let eventType: AgentImageProcessingFact["eventType"];
    if (stage.status === "success" && image.status === "success" && result?.manifestDigest && result.manifest?.jobId === stage.id && result.manifest.executionId === result.executionId && result.executionId === payload.executionId) {
        evidence = ["success", result.executionId, result.manifestDigest];
        eventType = "task.child.completed";
    } else if (result?.failure && result.workerId && result.executionId === payload.executionId && result.failure.jobId === stage.id && result.failure.executionId === result.executionId) {
        const failure = imageProcessingFailureIdentity(result.failure);
        if (stage.status === "paused" && failure.status === "resource_failure" && image.status === "running" && image.executionPhase === "needs_review") eventType = "task.needs_review";
        else if (stage.status === "error" && failure.status === "rejected" && image.status === "error") eventType = "task.child.failed";
        else return null;
        evidence = ["failure", result.executionId, result.workerId, failure];
    } else if (stage.status === "paused" && stage.executionPhase === "needs_review" && !payload.executionId && payload.resource.unavailable && image.executionPhase === "needs_review") {
        evidence = ["admission", stage.updatedAt, payload.resource.unavailable, payload.resource];
        eventType = "task.needs_review";
    } else return null;
    return { jobId: stage.id, inputDigest: payload.inputDigest, factIdentity: identity([stage.id, payload.inputDigest, evidence]), eventType };
}

async function stored(type: StoredGenerationTaskRecord["type"], id: string, storage?: Storage) {
    if (Array.isArray(storage)) return storage.find((record) => record.type === type && record.id === id) || null;
    return getStoredGenerationTaskRecord(type, id, storage, Boolean(storage));
}

async function observation(runRecord: StoredGenerationTaskRecord, taskId: string, imageId: string, now: number, storage?: Storage, applied = false): Promise<AgentImageProcessingObservation | null> {
    const imageRecord = await stored("image", imageId, storage);
    const image = imageRecord?.payload as ImageTask | undefined;
    if (!imageRecord || !image?.nativeResults || !image.resultProcessing) return null;
    const stage = await stored("image_processing", image.resultProcessing.jobId, storage);
    const checkedAt = storage && !Array.isArray(storage) ? (await storage.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime() : now;
    const run = fileImageResultRun([runRecord], runRecord.id);
    const binding = applied ? appliedImageResultRunBinding(run, image, checkedAt) : imageResultRunBinding(run, image, checkedAt);
    const task = run?.payload.tasks.find((item) => item.id === taskId);
    if (!binding || binding.agentTaskId !== taskId || !task?.taskIds?.includes(imageId) || task.childTasks?.filter((child) => child.id === imageId && child.attempt === task.attempts).length !== 1) return null;
    const payload = stage?.payload as AgentImageProcessingPayload | undefined;
    const source = payload?.imageResultBinding;
    const upstreamTaskId = image.upstream?.id || null;
    if (
        !stage ||
        !payload ||
        payload.operation !== "process_result" ||
        !source ||
        stage.expiresAt <= checkedAt ||
        imageRecord.expiresAt <= checkedAt ||
        imageRecord.userId !== runRecord.userId ||
        image.userId !== runRecord.userId ||
        image.id !== imageRecord.id ||
        imageRecord.status !== image.status ||
        imageRecord.runId !== runRecord.id ||
        image.runId !== runRecord.id ||
        imageRecord.conversationId !== image.conversationId ||
        imageRecord.surface !== image.surface ||
        imageRecord.projectId !== image.projectId ||
        (imageRecord.upstreamTaskId || null) !== upstreamTaskId ||
        image.nativeResults.attemptNo !== image.attemptNo ||
        image.nativeResults.upstreamTaskId !== upstreamTaskId ||
        stage.id !== `image-process-${payload.inputDigest}` ||
        stage.userId !== image.userId ||
        stage.parentTaskId !== image.id ||
        stage.runId !== runRecord.id ||
        stage.conversationId !== image.conversationId ||
        stage.surface !== image.surface ||
        stage.projectId !== image.projectId ||
        source.userId !== image.userId ||
        source.imageTaskId !== image.id ||
        !isDeepStrictEqual(source.run, binding) ||
        !isDeepStrictEqual(source.nativeResults, image.nativeResults) ||
        image.resultProcessing.inputDigest !== payload.inputDigest ||
        !imageTaskResultInputsMatch(image, payload)
    )
        return null;
    return {
        runId: runRecord.id,
        taskId,
        imageId,
        attempt: binding.agentAttempt,
        sourceIdentity: identity([image.attemptNo, upstreamTaskId, image.nativeResults, image.resultProcessing, imageTaskResultSourceIdentityDigest(image), source, payload.inputs, payload.sources, payload.options, payload.resource]),
        fact: stageFact(stage, payload, imageRecord),
    };
}

export async function observeAgentImageProcessingFact(runId: string, taskId: string, imageId: string): Promise<AgentImageProcessingObservation | undefined> {
    try {
        const image = await getStoredGenerationTaskRecord("image", imageId);
        if (!image?.payload.nativeResults || !image.payload.resultProcessing) return;
        const run = await getStoredGenerationTaskRecord("agent", runId);
        const observed = run && (await observation(run, taskId, imageId, Date.now()));
        if (!observed) throw new AgentImageProcessingFactChangedError();
        return observed;
    } catch (cause) {
        if (cause instanceof AgentImageProcessingFactChangedError) throw cause;
        throw new AgentImageProcessingProjectionError(cause);
    }
}

function projectionKey(observed: AppliedObservation) {
    return identity([observed.runId, observed.taskId, observed.attempt, observed.imageId, observed.fact.factIdentity, observed.fact.eventType]);
}

function appliedPointers(run: AgentRun) {
    return run.tasks.flatMap((task) =>
        (task.childTasks || []).flatMap((child) => (child.imageProcessingFact && child.attempt === task.attempts ? [{ runId: run.id, taskId: task.id, imageId: child.id, attempt: child.attempt, sourceIdentity: "", fact: child.imageProcessingFact }] : [])),
    );
}

function childStatus(eventType: AgentImageProcessingFact["eventType"]): AgentRunChildTask["status"] {
    if (eventType === "task.needs_review") return "needs_review";
    return eventType === "task.child.completed" ? "completed" : "failed";
}

async function prepare(runRecord: StoredGenerationTaskRecord, now: number, storage: Storage, update?: FactUpdate) {
    const current = runRecord.payload as AgentRun;
    if (update) {
        if (runRecord.status !== "running" || current.status !== "running" || current.executionId !== update.executionId) return null;
        const observed = await observation(runRecord, update.observation.taskId, update.observation.imageId, now, storage);
        if (!observed?.fact || !isDeepStrictEqual(observed, update.observation)) return null;
        const mutated = update.mutate(current);
        if (!mutated) return null;
        const fact = observed.fact;
        const applied = { ...observed, fact };
        const next: AgentRun = {
            ...mutated,
            tasks: mutated.tasks.map((task) => (task.id === observed.taskId ? { ...task, childTasks: task.childTasks?.map((child) => (child.id === observed.imageId ? { ...child, imageProcessingFact: fact } : child)) } : task)),
        };
        const changed = !isDeepStrictEqual(next, current);
        return { run: changed ? { ...next, updatedAt: now } : current, changed, projections: [applied] };
    }
    const projections: AppliedObservation[] = [];
    for (const pointer of appliedPointers(current)) {
        const observed = await observation(runRecord, pointer.taskId, pointer.imageId, now, storage, true);
        const task = current.tasks.find((item) => item.id === pointer.taskId);
        const child = task?.childTasks?.find((item) => item.id === pointer.imageId);
        if (!observed?.fact || !isDeepStrictEqual(observed.fact, pointer.fact) || child?.status !== childStatus(observed.fact.eventType)) continue;
        if (current.status === "completed" && observed.fact.eventType !== "task.child.completed") continue;
        projections.push({ ...observed, fact: observed.fact });
    }
    return { run: current, changed: false, projections };
}

function keyedProjection(run: AgentRun, observed: AppliedObservation, project: Projection): ProjectionMutation {
    const mutation = project(run, observed);
    return { ...mutation, event: { type: observed.fact.eventType, data: { ...mutation.event.data, imageProcessingProjectionKey: projectionKey(observed) } } };
}

async function processProjection(runId: string, project: Projection, update?: FactUpdate): Promise<AgentRun | null> {
    try {
        if (getDatabaseProvider() === "postgres") {
            await ensurePostgresSchema();
            const result = await withPostgresTransaction(async (executor) => {
                const record = await getStoredGenerationTaskRecord("agent", runId, executor, true);
                if (!record) return null;
                const now = (await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
                if (record.expiresAt <= now) return null;
                const prepared = await prepare(record, now, executor, update);
                if (!prepared) return null;
                const missing: AppliedObservation[] = [];
                for (const observed of prepared.projections) {
                    const receipt = await executor.query("SELECT id FROM creative_run_events WHERE run_id = $1 AND data ->> 'imageProcessingProjectionKey' = $2 LIMIT 1", [runId, projectionKey(observed)]);
                    if (!receipt.rows.length) missing.push(observed);
                }
                if (update && prepared.changed)
                    await executor.query("UPDATE generation_tasks SET status = $2, payload = $3::jsonb, updated_at = $4, expires_at = $5 WHERE id = $1 AND task_type = 'agent'", [
                        runId,
                        normalizeTaskStatus(prepared.run.status),
                        JSON.stringify(prepared.run),
                        new Date(now),
                        new Date(now + update.ttlMs),
                    ]);
                for (const observed of missing) {
                    const mutation = keyedProjection(prepared.run, observed, project);
                    await executor.query("INSERT INTO creative_run_events (run_id, type, data, created_at) VALUES ($1, $2, $3::jsonb, $4)", [runId, mutation.event.type, JSON.stringify(mutation.event.data), new Date(now)]);
                    if (mutation.assistant) await updatePostgresAssistant(executor, prepared.run.assistantMessageId, mutation.assistant, now);
                }
                if (missing.length) await executor.query("SELECT pg_notify('vozeb_pro_run_events', $1)", [runId]);
                return { run: prepared.run, notify: missing.length > 0 };
            });
            if (result?.notify) notifyCreativeRunEvent(runId);
            return result?.run || null;
        }
        const result = await queueRuntimeFileOperation(async () => {
            const db = await readRuntimeFile();
            const prepared = await withGenerationTaskFileRead(async (records) => {
                const now = Date.now();
                const record = records.find((item) => item.type === "agent" && item.id === runId && item.expiresAt > now);
                if (!record) return null;
                const next = await prepare(record, now, records, update);
                if (!next) return null;
                const missing = next.projections.filter((observed) => !db.events.some((event) => event.runId === runId && (event.data as { imageProcessingProjectionKey?: string } | undefined)?.imageProcessingProjectionKey === projectionKey(observed)));
                // This existing generation lock permits a single truth write, and no write for receipt-only repair.
                if (update && next.changed)
                    await writeJsonDataFile(
                        GENERATION_TASK_FILE,
                        records.map((item) => (item === record ? { ...item, status: normalizeTaskStatus(next.run.status), payload: next.run as unknown as Record<string, unknown>, updatedAt: now, expiresAt: now + update.ttlMs } : item)),
                    );
                return { ...next, missing };
            });
            if (!prepared) return null;
            let nextDb = db;
            const now = Date.now();
            for (const observed of prepared.missing) nextDb = applyRuntimeMutation(nextDb, prepared.run, keyedProjection(prepared.run, observed, project), now);
            if (prepared.missing.length) await writeRuntimeFile(nextDb);
            return { run: prepared.run, notify: prepared.missing.length > 0 };
        });
        if (result?.notify) notifyCreativeRunEvent(runId);
        return result?.run || null;
    } catch (cause) {
        throw new AgentImageProcessingProjectionError(cause);
    }
}

export function commitAgentImageProcessingFact(runId: string, update: FactUpdate, project: Projection) {
    return processProjection(runId, project, update);
}

export async function repairAgentImageProcessingFacts(run: AgentRun, project: Projection): Promise<AgentRun | null> {
    try {
        const pointers = appliedPointers(run);
        if (!pointers.length) return run;
        const keys = pointers.map(projectionKey);
        if (getDatabaseProvider() === "postgres") {
            await ensurePostgresSchema();
            const receipts = await postgresQuery<{ key: string }>("SELECT DISTINCT data ->> 'imageProcessingProjectionKey' AS key FROM creative_run_events WHERE run_id = $1 AND data ->> 'imageProcessingProjectionKey' = ANY($2::text[])", [run.id, keys]);
            if (keys.every((key) => receipts.rows.some((receipt) => receipt.key === key))) return run;
        } else {
            const db = await readRuntimeFile();
            if (keys.every((key) => db.events.some((event) => event.runId === run.id && (event.data as { imageProcessingProjectionKey?: string } | undefined)?.imageProcessingProjectionKey === key))) return run;
        }
        return processProjection(run.id, project);
    } catch (cause) {
        if (cause instanceof AgentImageProcessingProjectionError) throw cause;
        throw new AgentImageProcessingProjectionError(cause);
    }
}

async function imageProcessingPauseProjection(expected: AgentRun, now: number, storage: Storage) {
    const record = await stored("agent", expected.id, storage);
    const run = record?.payload as AgentRun | undefined;
    const waiting = run?.ecommerceSnapshot?.processing?.waitingFor;
    if (
        !record ||
        record.userId !== expected.userId ||
        record.status !== "paused" ||
        record.expiresAt <= now ||
        !run ||
        run.status !== "paused" ||
        run.cancellation ||
        !waiting ||
        !isDeepStrictEqual(waiting, expected.ecommerceSnapshot?.processing?.waitingFor)
    )
        return null;
    const stage = await stored("image_processing", waiting.jobId, storage);
    const payload = stage?.payload as AgentImageProcessingPayload | undefined;
    const result = stage?.resultPayload as ImageProcessingStoredResult | undefined;
    const failure = result?.failure;
    if (
        !stage ||
        stage.userId !== record.userId ||
        stage.runId !== run.id ||
        stage.expiresAt <= now ||
        stage.executionPhase !== "needs_review" ||
        !payload ||
        (payload.operation !== "prepare_reference" && payload.operation !== "build_protection") ||
        payload.inputDigest !== waiting.inputDigest ||
        !failure ||
        !result?.workerId ||
        !payload.executionId ||
        result.executionId !== payload.executionId ||
        failure.jobId !== stage.id ||
        failure.executionId !== payload.executionId ||
        (failure.status === "rejected" ? stage.status !== "error" : stage.status !== "paused")
    )
        return null;
    const message = imageProcessingPauseMessage(failure);
    const key = identity(["pause", stage.id, payload.inputDigest, result.executionId, result.workerId, imageProcessingFailureIdentity(failure), message]);
    const mutation: ProjectionMutation = { run, event: { type: "run.paused", data: { imageProcessingProjectionKey: key, message } }, assistant: { status: "running", content: message } };
    return { run, key, message, reason: failure.status === "rejected" ? ("input_rejected" as const) : ("resource_failure" as const), mutation };
}

export async function repairAgentImageProcessingPause(run: AgentRun) {
    if (run.status !== "paused" || !run.ecommerceSnapshot?.processing?.waitingFor) return;
    const result =
        getDatabaseProvider() === "postgres"
            ? await withPostgresTransaction(async (executor) => {
                  await getStoredGenerationTaskRecord("agent", run.id, executor, true);
                  const now = (await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
                  const projection = await imageProcessingPauseProjection(run, now, executor);
                  if (!projection) return;
                  const receipt = await executor.query("SELECT id FROM creative_run_events WHERE run_id = $1 AND data ->> 'imageProcessingProjectionKey' = $2 LIMIT 1", [run.id, projection.key]);
                  if (receipt.rows.length) return { ...projection, notify: false };
                  await updatePostgresAssistant(executor, projection.run.assistantMessageId, projection.mutation.assistant!, now);
                  await executor.query("INSERT INTO creative_run_events (run_id, type, data, created_at) VALUES ($1, $2, $3::jsonb, $4)", [run.id, projection.mutation.event.type, JSON.stringify(projection.mutation.event.data), new Date(now)]);
                  await executor.query("SELECT pg_notify('vozeb_pro_run_events', $1)", [run.id]);
                  return { ...projection, notify: true };
              })
            : await queueRuntimeFileOperation(async () => {
                  const db = await readRuntimeFile();
                  return withGenerationTaskFileRead(async (records) => {
                      const now = Date.now();
                      const projection = await imageProcessingPauseProjection(run, now, records);
                      if (!projection) return;
                      if (db.events.some((event) => event.runId === run.id && (event.data as { imageProcessingProjectionKey?: string } | undefined)?.imageProcessingProjectionKey === projection.key)) return { ...projection, notify: false };
                      await writeRuntimeFile(applyRuntimeMutation(db, projection.run, projection.mutation, now));
                      return { ...projection, notify: true };
                  });
              });
    if (result?.notify) notifyCreativeRunEvent(run.id);
    return result && { reason: result.reason, canResume: false, message: result.message };
}
