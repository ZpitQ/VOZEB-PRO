import type { EnhancementDecision } from "../image-enhancement-plan";
import type { ImageEnhancementTimings } from "@/lib/image-enhancement-contract";
import type { EnhancementArtifact, FrozenWorkerEnhancementPlan } from "../image-enhancement-worker-client";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction, type QueryExecutor } from "./postgres";

export type StoredEnhancementArtifact = EnhancementArtifact & { url: string };
export type ImageEnhancementJob = {
    id: string;
    userId: string;
    imageTaskId: string;
    resultId: string;
    decision: EnhancementDecision;
    status: "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
    phase: "prepare" | "submit" | "poll" | "download" | "publish" | "receipt" | "completed";
    reason: string | null;
    attempt: number;
    timings?: ImageEnhancementTimings;
    remoteKey: string;
    remotePlan?: FrozenWorkerEnhancementPlan;
    remoteJobId?: string;
    remoteStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    submittedAt?: number;
    remoteResult?: EnhancementArtifact;
    receiptId: string;
    receiptConfirmedAt?: number;
    staged?: { ai?: StoredEnhancementArtifact; delivered?: StoredEnhancementArtifact };
    publication?: { ai: StoredEnhancementArtifact; delivered: StoredEnhancementArtifact; assetId: string | null; publishedAt: number };
    events: { stage: string; at: number; attempt: number; reason?: string }[];
    cancelRequested: boolean;
    createdAt: number;
    updatedAt: number;
    nextPollAt: number | null;
    workerId: string | null;
    leaseToken: string | null;
    leaseUntil: number | null;
};
export type EnhancementLease = { token: string; now: number };
export function canResumeSkippedEnhancement(job: ImageEnhancementJob) {
    return (
        job.status === "skipped" &&
        job.phase === "completed" &&
        job.reason === "aspect_ratio_mismatch" &&
        job.decision.status === "skipped" &&
        job.decision.reason === "aspect_ratio_mismatch" &&
        !job.cancelRequested &&
        [job.submittedAt, job.remotePlan, job.remoteJobId, job.remoteStatus, job.remoteResult, job.staged, job.publication].every((value) => value === undefined) &&
        job.workerId === null &&
        job.leaseToken === null &&
        job.leaseUntil === null &&
        job.nextPollAt === null
    );
}
const fileName = "image-enhancement-jobs.json";
const activeSql = "(status IN ('queued', 'running') OR (status = 'succeeded' AND phase = 'receipt')) AND next_poll_at IS NOT NULL";
const fileJobs = () => readJsonDataFile<ImageEnhancementJob[]>(fileName, []);
function active(job: ImageEnhancementJob) {
    return job.nextPollAt !== null && (["queued", "running"].includes(job.status) || (job.status === "succeeded" && job.phase === "receipt"));
}
function assertIdentity(before: ImageEnhancementJob, after: ImageEnhancementJob, sameId = true) {
    // A skipped plan has never executed; only its first explicit resume may add the frozen engine policy.
    if (
        sameId &&
        canResumeSkippedEnhancement(before) &&
        after.status === "queued" &&
        after.phase === "prepare" &&
        after.reason === null &&
        after.decision.status === "queued" &&
        after.attempt === before.attempt &&
        after.remoteKey === before.remoteKey &&
        after.receiptId === before.receiptId &&
        [after.submittedAt, after.remotePlan, after.remoteJobId, after.remoteStatus, after.remoteResult, after.staged, after.publication].every((value) => value === undefined) &&
        after.events.length === before.events.length + 1 &&
        after.events.at(-1)?.stage === "retry_requested" &&
        isDeepStrictEqual(after.events.slice(0, -1), before.events)
    ) {
        before = { ...before, decision: { ...after.decision, source: before.decision.source, target: before.decision.target } };
    }
    const identity = (job: ImageEnhancementJob) => ({ userId: job.userId, imageTaskId: job.imageTaskId, resultId: job.resultId, decision: { ...job.decision, source: { ...job.decision.source, url: sameId ? job.decision.source.url : undefined } } });
    if ((sameId && before.id !== after.id) || !isDeepStrictEqual(identity(before), identity(after))) throw new Error("enhancement_identity_conflict");
}
async function updateFile<T>(operation: (jobs: ImageEnhancementJob[]) => T | Promise<T>): Promise<T> {
    return withJsonDataFileLock(fileName, async () => {
        const jobs = await fileJobs();
        const value = await operation(jobs);
        await writeJsonDataFile(fileName, jobs);
        return value;
    });
}
async function persist(client: QueryExecutor, job: ImageEnhancementJob) {
    await client.query("UPDATE image_enhancement_jobs SET status=$2, phase=$3, next_poll_at=$4, lease_token=$5, lease_until=$6, updated_at=$7, payload=$8::jsonb WHERE id=$1", [
        job.id,
        job.status,
        job.phase,
        job.nextPollAt === null ? null : new Date(job.nextPollAt),
        job.leaseToken,
        job.leaseUntil === null ? null : new Date(job.leaseUntil),
        new Date(job.updatedAt),
        JSON.stringify(job),
    ]);
}
export async function insertEnhancementJob(candidate: ImageEnhancementJob, executor?: QueryExecutor): Promise<ImageEnhancementJob> {
    if (!executor && getDatabaseProvider() !== "postgres")
        return updateFile((jobs) => {
            const existing = jobs.find((job) => job.userId === candidate.userId && job.imageTaskId === candidate.imageTaskId && job.resultId === candidate.resultId);
            if (existing) {
                assertIdentity(existing, candidate, false);
                return existing;
            }
            const stored = structuredClone(candidate);
            jobs.push(stored);
            return stored;
        });
    if (!executor) await ensurePostgresSchema();
    const perform = async (client: QueryExecutor) => {
        const inserted = await client.query(
            "INSERT INTO image_enhancement_jobs (id,user_id,image_task_id,result_id,status,phase,next_poll_at,lease_token,lease_until,created_at,updated_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT (user_id,image_task_id,result_id) DO NOTHING RETURNING payload",
            [
                candidate.id,
                candidate.userId,
                candidate.imageTaskId,
                candidate.resultId,
                candidate.status,
                candidate.phase,
                candidate.nextPollAt === null ? null : new Date(candidate.nextPollAt),
                candidate.leaseToken,
                candidate.leaseUntil === null ? null : new Date(candidate.leaseUntil),
                new Date(candidate.createdAt),
                new Date(candidate.updatedAt),
                JSON.stringify(candidate),
            ],
        );
        const existing =
            inserted.rows[0]?.payload ?? (await client.query("SELECT payload FROM image_enhancement_jobs WHERE user_id=$1 AND image_task_id=$2 AND result_id=$3", [candidate.userId, candidate.imageTaskId, candidate.resultId])).rows[0]?.payload;
        if (!existing) throw new Error("enhancement_identity_conflict");
        assertIdentity(existing as ImageEnhancementJob, candidate, false);
        return existing as ImageEnhancementJob;
    };
    return executor ? perform(executor) : withPostgresTransaction(perform);
}
export async function getEnhancementJob(id: string, userId?: string): Promise<ImageEnhancementJob | null> {
    if (getDatabaseProvider() !== "postgres") return (await fileJobs()).find((job) => job.id === id && (userId === undefined || job.userId === userId)) ?? null;
    await ensurePostgresSchema();
    return ((await postgresQuery(`SELECT payload FROM image_enhancement_jobs WHERE id=$1${userId === undefined ? "" : " AND user_id=$2"}`, userId === undefined ? [id] : [id, userId])).rows[0]?.payload as ImageEnhancementJob) ?? null;
}
export async function listEnhancementJobsForTask(imageTaskId: string, userId: string): Promise<ImageEnhancementJob[]> {
    if (getDatabaseProvider() !== "postgres") return (await fileJobs()).filter((job) => job.imageTaskId === imageTaskId && job.userId === userId);
    await ensurePostgresSchema();
    return (await postgresQuery("SELECT payload FROM image_enhancement_jobs WHERE image_task_id=$1 AND user_id=$2 ORDER BY created_at,id", [imageTaskId, userId])).rows.map((row) => row.payload as ImageEnhancementJob);
}
export async function mutateEnhancementJob(id: string, userId: string, update: (job: ImageEnhancementJob, executor?: QueryExecutor) => ImageEnhancementJob | Promise<ImageEnhancementJob>, lease?: EnhancementLease): Promise<ImageEnhancementJob | null> {
    const apply = async (job: ImageEnhancementJob | undefined, executor?: QueryExecutor) => {
        if (!job || (lease && (job.leaseToken !== lease.token || job.leaseUntil === null || job.leaseUntil <= lease.now))) return null;
        const changed = await update(structuredClone(job), executor);
        assertIdentity(job, changed);
        return changed;
    };
    if (getDatabaseProvider() !== "postgres")
        return updateFile(async (jobs) => {
            const index = jobs.findIndex((job) => job.id === id && job.userId === userId);
            const changed = await apply(jobs[index]);
            if (changed) jobs[index] = changed;
            return changed;
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const selected = await client.query("SELECT payload FROM image_enhancement_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE", [id, userId]);
        const changed = await apply(selected.rows[0]?.payload as ImageEnhancementJob | undefined, client);
        if (changed) await persist(client, changed);
        return changed;
    });
}
export async function claimEnhancementJobs(input: { workerId: string; now: number; leaseMs: number; limit: number }): Promise<ImageEnhancementJob[]> {
    if (!input.workerId || ![input.now, input.leaseMs, input.limit, input.now + input.leaseMs].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("invalid_enhancement_claim");
    const due = (job: ImageEnhancementJob) => active(job) && job.nextPollAt! <= input.now && (job.leaseUntil === null || job.leaseUntil <= input.now);
    const claim = (job: ImageEnhancementJob): ImageEnhancementJob => ({ ...job, workerId: input.workerId, leaseToken: randomUUID(), leaseUntil: input.now + input.leaseMs, updatedAt: input.now });
    if (getDatabaseProvider() !== "postgres")
        return updateFile((jobs) => {
            const claimed = jobs
                .filter(due)
                .sort((a, b) => a.nextPollAt! - b.nextPollAt! || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
                .slice(0, input.limit)
                .map(claim);
            for (const job of claimed) jobs[jobs.findIndex((row) => row.id === job.id)] = job;
            return claimed;
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const selected = await client.query(`SELECT payload FROM image_enhancement_jobs WHERE ${activeSql} AND next_poll_at <= $1 AND (lease_until IS NULL OR lease_until <= $1) ORDER BY next_poll_at,created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`, [
            new Date(input.now),
            input.limit,
        ]);
        const claimed = selected.rows.map((row) => claim(row.payload as ImageEnhancementJob));
        for (const job of claimed) await persist(client, job);
        return claimed;
    });
}
export async function nextEnhancementDueAt(): Promise<number | null> {
    if (getDatabaseProvider() !== "postgres") {
        const due = (await fileJobs()).filter(active).map((job) => Math.max(job.nextPollAt!, job.leaseUntil ?? job.nextPollAt!));
        return due.length ? Math.min(...due) : null;
    }
    await ensurePostgresSchema();
    const value = (await postgresQuery(`SELECT MIN(GREATEST(next_poll_at,COALESCE(lease_until,next_poll_at))) AS due FROM image_enhancement_jobs WHERE ${activeSql}`)).rows[0]?.due;
    return value ? new Date(value as string).getTime() : null;
}
