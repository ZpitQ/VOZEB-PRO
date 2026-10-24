import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { imageReferenceToDataUrl } from "@/app/api/image-tasks/image-task-support";
import { withJsonDataFileLock } from "./data-adapter";
import { getDatabaseProvider } from "./database/postgres";
import { canResumeSkippedEnhancement, claimEnhancementJobs, getEnhancementJob, mutateEnhancementJob, type ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import { planImageTaskEnhancement } from "./image-enhancement-enqueue";
import { ImageEnhancementConfigError, resolveImageEnhancementConnection } from "./image-enhancement-config";
import { createEnhancementTaskClient, WorkerCheckError, type RemoteEnhancementJob } from "./image-enhancement-worker-client";
import { GENERATION_TASK_FILE } from "./generation-task-store";
import { generationTaskNextPollAt } from "./generation-task-scheduler";
import { runWithConcurrency } from "./generation-task-recovery-service";
import { getImageTask } from "./image-task-store";
import { maintenanceWorkerContext } from "./maintenance-auth";
import { ImageEnhancementPublicationError, publishImageEnhancement } from "./image-enhancement-publication";

class EnhancementExecutionError extends Error {}
class EnhancementLeaseLost extends Error {}
const leaseMs = 90_000;

export async function runImageEnhancementBatch(input: { origin: string; workerId?: string; limit?: number }) {
    const workerId = input.workerId || `image-enhancement:${process.pid}:${randomUUID()}`;
    const leases = await claimEnhancementJobs({ workerId, now: Date.now(), leaseMs, limit: input.limit ?? 50 });
    const heartbeat = setInterval(() => {
        void Promise.allSettled(leases.map((job) => mutateEnhancementJob(job.id, job.userId, (current) => ({ ...current, leaseUntil: Date.now() + leaseMs }), { token: job.leaseToken!, now: Date.now() })));
    }, 25_000);
    try {
        const persistence = leases.filter((job) => ["download", "publish", "receipt"].includes(job.phase));
        const queries = leases.filter((job) => !persistence.includes(job));
        const results = [...await runWithConcurrency(queries, 20, (job) => processEnhancement(job, input.origin)), ...await runWithConcurrency(persistence, 4, (job) => processEnhancement(job, input.origin))];
        return { claimed: leases.length, completed: results.filter((job) => job?.status === "succeeded" || job?.status === "cancelled").length, failed: results.filter((job) => job?.status === "failed").length };
    } finally {
        clearInterval(heartbeat);
    }
}

async function processEnhancement(lease: ImageEnhancementJob, origin: string) {
    const update = async (change: (job: ImageEnhancementJob) => ImageEnhancementJob) => {
        const result = await mutateEnhancementJob(lease.id, lease.userId, (job) => ({ ...change(job), updatedAt: Date.now() }), { token: lease.leaseToken!, now: Date.now() });
        if (!result) throw new EnhancementLeaseLost();
        return result;
    };
    const finish = (status: "cancelled" | "failed", reason: string) => update((job) => ({ ...job, status, reason, phase: status === "cancelled" ? "completed" : job.phase, nextPollAt: null, events: [...job.events, { stage: status, at: Date.now(), attempt: job.attempt, reason }] }));
    let client: ReturnType<typeof createEnhancementTaskClient> | undefined;
    try {
        const current = await getEnhancementJob(lease.id, lease.userId);
        if (!current || current.leaseToken !== lease.leaseToken) throw new EnhancementLeaseLost();
        if (current.cancelRequested && !current.submittedAt && !current.remoteJobId) return await finish("cancelled", "cancelled_before_submission");
        const task = await (getDatabaseProvider() === "file"
            ? withJsonDataFileLock(GENERATION_TASK_FILE, () => getImageTask(current.imageTaskId))
            : getImageTask(current.imageTaskId));
        const native = (task?.result?.results?.length ? task.result.results : task?.result ? [task.result] : []).find((result) => result.resultId === current.resultId);
        if (!current.publication && (!task || task.status !== "success" || task.userId !== current.userId || !native || !isDeepStrictEqual(native.nativeSource, current.decision.source) || (native.serverUrl || native.dataUrl) !== current.decision.source.url)) throw new EnhancementExecutionError("native_identity_changed");
        if (!current.publication && !(current.cancelRequested && current.remoteJobId)) {
            const output = task?.ecommerceTrace?.stages.find((stage) => stage.key === "image_generation")?.output;
            const technical = output && typeof output === "object" && !Array.isArray(output) ? output.technicalCheck : null;
            if (technical && typeof technical === "object" && !Array.isArray(technical) && technical.version === "ecommerce-technical.v1" && Array.isArray(technical.hardFailures) && technical.hardFailures.some((check) =>
                check && typeof check === "object" && !Array.isArray(check) && check.status === "failed" && (check.resultId === current.resultId || check.resultId === "batch"),
            )) throw new EnhancementExecutionError("native_invalid");
        }
        if (current.decision.status !== "queued") throw new EnhancementExecutionError("invalid_enhancement_plan");
        client = createEnhancementTaskClient(await resolveImageEnhancementConnection(current.decision.connection));
        if (current.phase === "prepare") {
            const remotePlan = await client.prepare(current.decision);
            return await update((job) => ({ ...job, status: "running", phase: "submit", remotePlan, nextPollAt: Date.now(), events: [...job.events, { stage: "prepared", at: Date.now(), attempt: job.attempt }] }));
        }
        const plan = current.remotePlan;
        if (!plan) throw new EnhancementExecutionError("invalid_enhancement_plan");
        const recordRemote = (remote: RemoteEnhancementJob) => update((job) => {
            const cancelled = job.cancelRequested || remote.status === "cancelled";
            const terminal = remote.status === "failed" || remote.status === "cancelled" || (cancelled && remote.status === "succeeded");
            const timings = { ...remote.timings, ...(job.timings?.deliveryEncodingMs === undefined ? {} : { deliveryEncodingMs: job.timings.deliveryEncodingMs }) };
            return { ...job, remoteJobId: remote.jobId, remoteStatus: remote.status, remoteResult: remote.result || undefined, timings: Object.keys(timings).length ? timings : undefined, status: terminal ? cancelled ? "cancelled" : "failed" : "running", phase: terminal ? cancelled ? "completed" : job.phase : remote.status === "succeeded" ? "download" : "poll", reason: terminal ? remote.reason || (cancelled ? "cancelled" : "engine_failed") : null, nextPollAt: terminal ? null : generationTaskNextPollAt({ submittedAt: job.submittedAt || job.createdAt }), events: [...job.events, { stage: `worker_${remote.status}`, at: Date.now(), attempt: job.attempt }] };
        });
        if (current.phase === "submit") {
            const dataUrl = await imageReferenceToDataUrl({ dataUrl: current.decision.source.url }, "enhancement-native.png", origin, maintenanceWorkerContext(current.userId));
            const bytes = Buffer.from(dataUrl.split(",")[1] || "", "base64");
            if (bytes.length !== plan.source.byteLength || createHash("sha256").update(bytes).digest("hex") !== plan.sourceSha256) throw new EnhancementExecutionError("input_digest_mismatch");
            const marked = await update((job) => job.cancelRequested && !job.submittedAt ? job : { ...job, submittedAt: job.submittedAt || Date.now() });
            if (marked.cancelRequested && !marked.submittedAt) return await finish("cancelled", "cancelled_before_submission");
            const accepted = await client.submit(plan, bytes, current.remoteKey);
            return await recordRemote(accepted.job);
        }
        if (!current.remoteJobId) throw new EnhancementExecutionError("invalid_enhancement_plan");
        if (current.phase === "receipt" && current.publication && current.remoteResult) {
            await client.acknowledge(plan, current.remoteJobId, current.receiptId, current.remoteResult);
            return await update((job) => ({ ...job, status: "succeeded", phase: "completed", reason: null, receiptConfirmedAt: Date.now(), nextPollAt: null, events: [...job.events, { stage: "receipt_confirmed", at: Date.now(), attempt: job.attempt }] }));
        }
        if (current.cancelRequested) return await recordRemote(await client.cancel(plan, current.remoteJobId));
        if (current.phase === "poll") return await recordRemote(await client.query(plan, current.remoteJobId));
        if ((current.phase === "download" || current.phase === "publish") && current.remoteResult && task) {
            const bytes = current.staged?.ai ? undefined : await client.download(plan, current.remoteJobId, current.remoteResult);
            return await publishImageEnhancement(current, task, origin, bytes);
        }
        throw new EnhancementExecutionError("invalid_enhancement_plan");
    } catch (error) {
        if (error instanceof EnhancementLeaseLost) return null;
        const reason = error instanceof EnhancementExecutionError || error instanceof ImageEnhancementPublicationError ? error.message : error instanceof WorkerCheckError ? error.reason : error instanceof ImageEnhancementConfigError ? error.code : "enhancement_unavailable";
        if (reason === "lease_lost") return null;
        if (reason === "cancel_requested") return await finish("cancelled", "cancelled");
        const published = await getEnhancementJob(lease.id, lease.userId);
        if (published?.publication) return await update((job) => ({ ...job, status: "succeeded", phase: "receipt", reason, nextPollAt: generationTaskNextPollAt({ submittedAt: job.submittedAt || job.createdAt }), events: [...job.events, { stage: "receipt_deferred", at: Date.now(), attempt: job.attempt, reason }] }));
        try { return await finish("failed", reason); } catch (failure) { if (failure instanceof EnhancementLeaseLost) return null; throw failure; }
    } finally {
        await client?.close().catch(() => undefined);
        await mutateEnhancementJob(lease.id, lease.userId, (job) => ({ ...job, workerId: null, leaseToken: null, leaseUntil: null }), { token: lease.leaseToken!, now: Date.now() });
    }
}

export async function retryImageEnhancement(id: string, userId: string) {
    const initial = await getEnhancementJob(id, userId);
    let resumed: Extract<ImageEnhancementJob["decision"], { status: "queued" }> | undefined;
    if (initial && canResumeSkippedEnhancement(initial)) {
        const task = await getImageTask(initial.imageTaskId);
        const native = (task?.result?.results?.length ? task.result.results : task?.result ? [task.result] : []).find((result) => result.resultId === initial.resultId && result.enhancementId === id);
        if (!task || task.userId !== userId || task.status !== "success" || !native || !isDeepStrictEqual(native.nativeSource, initial.decision.source)) return null;
        const decision = planImageTaskEnhancement(task, native);
        if (decision.status !== "queued" || !isDeepStrictEqual(decision.target, initial.decision.target)) return null;
        resumed = decision;
    }
    let accepted = false;
    const changed = await mutateEnhancementJob(id, userId, (job) => {
        if (resumed && canResumeSkippedEnhancement(job) && isDeepStrictEqual(job.decision.source, resumed.source) && isDeepStrictEqual(job.decision.target, resumed.target)) {
            accepted = true;
            return { ...job, decision: resumed, status: "queued", phase: "prepare", reason: null, nextPollAt: Date.now(), events: [...job.events, { stage: "retry_requested", at: Date.now(), attempt: job.attempt }] };
        }
        if (job.status !== "failed" || job.cancelRequested || job.decision.status !== "queued") return job;
        accepted = true;
        const newInference = job.remoteStatus === "failed" || job.remoteStatus === "cancelled";
        const attempt = job.attempt + (newInference ? 1 : 0);
        return { ...job, status: "queued", reason: null, nextPollAt: Date.now(), ...(newInference ? { attempt, phase: "submit" as const, remoteJobId: undefined, remoteStatus: undefined, remoteResult: undefined, timings: undefined, submittedAt: undefined, remoteKey: `${job.id}:${attempt}`, receiptId: randomUUID() } : {}), events: [...job.events, { stage: "retry_requested", at: Date.now(), attempt }] };
    });
    return accepted ? changed : null;
}
export async function cancelImageEnhancement(id: string, userId: string) {
    let accepted = false;
    const changed = await mutateEnhancementJob(id, userId, (job) => {
        if (!["queued", "running", "failed"].includes(job.status) || job.publication || (job.cancelRequested && job.status !== "failed")) return job;
        accepted = true;
        return { ...job, status: "queued", cancelRequested: true, nextPollAt: Date.now(), events: [...job.events, { stage: "cancel_requested", at: Date.now(), attempt: job.attempt }] };
    });
    return accepted ? changed : null;
}
