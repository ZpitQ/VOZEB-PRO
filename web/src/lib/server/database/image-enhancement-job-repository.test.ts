import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializePostgresSchema, postgresQuery } from "./postgres";
import { claimEnhancementJobs, getEnhancementJob, insertEnhancementJob, listEnhancementJobsForTask, mutateEnhancementJob, nextEnhancementDueAt, type ImageEnhancementJob } from "./image-enhancement-job-repository";
import { planImageEnhancement } from "../image-enhancement-plan";

const userId = "enhancement-job-fixture-owner";
const pg = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
const now = 1000;
const leaseMs = 90_000;
function candidate(): ImageEnhancementJob {
    const id = randomUUID();
    return { id, userId, imageTaskId: "fixture-task", resultId: "fixture-result", decision: planImageEnhancement({ nativeValid: true, enabled: false, requested4k: true, protectedContract: false, layered: false, source: { url: "/api/generation-log-assets/images/fixture.png", width: 1254, height: 1254, sha256: "a".repeat(64), byteLength: 1000, format: "png", hasAlpha: false, provenance: "provider_native" }, target: { width: 4096, height: 4096 }, connection: null }), status: "queued", phase: "prepare", reason: null, attempt: 1, remoteKey: `enhancement:${id}:1`, receiptId: randomUUID(), events: [], cancelRequested: false, createdAt: now, updatedAt: now, nextPollAt: now, workerId: null, leaseToken: null, leaseUntil: null };
}
for (const provider of ["file", "postgres"] as const) {
    describe.skipIf(provider === "postgres" && !pg)(`${provider} durable enhancement queue`, () => {
        let directory: string;
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-jobs-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            if (provider === "postgres") {
                const target = new URL(process.env.DATABASE_URL || "");
                if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_m5_e2e")) throw new Error("An explicitly isolated M5 PostgreSQL fixture is required");
                await initializePostgresSchema();
                await postgresQuery("DELETE FROM image_enhancement_jobs WHERE user_id = $1", [userId]);
            }
        });
        afterEach(async () => {
            if (provider === "postgres") await postgresQuery("DELETE FROM image_enhancement_jobs WHERE user_id = $1", [userId]);
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        });
        it("inserts one durable identity for concurrent requests on the same native result", async () => {
            const first = candidate();
            const second = { ...candidate(), decision: first.decision };
            const results = await Promise.all([insertEnhancementJob(first), insertEnhancementJob(second)]);
            expect(results[0].id).toBe(results[1].id);
            expect(await listEnhancementJobsForTask(first.imageTaskId, userId)).toHaveLength(1);
            expect(await getEnhancementJob(results[0].id, userId)).toEqual(results[0]);
        });
        it("refuses conflicting native content under the same result identity", async () => {
            const first = await insertEnhancementJob(candidate());
            const second = candidate();
            second.decision = { ...second.decision, source: { ...second.decision.source, sha256: "b".repeat(64) } };
            await expect(insertEnhancementJob(second)).rejects.toThrow("enhancement_identity_conflict");
            expect(await getEnhancementJob(first.id, userId)).toEqual(first);
        });
        it("lets only one concurrent claimant own a row and schedules the original lease deadline", async () => {
            await insertEnhancementJob(candidate());
            const batches = await Promise.all(["worker-a", "worker-b"].map((workerId) => claimEnhancementJobs({ workerId, now, leaseMs, limit: 1 })));
            expect(batches.flat()).toHaveLength(1);
            expect(batches.flat()[0]).toMatchObject({ leaseToken: expect.any(String), leaseUntil: now + leaseMs });
            expect(await nextEnhancementDueAt()).toBe(now + leaseMs);
        });
        it("takes over an expired lease and fences the old execution from publication", async () => {
            const original = await insertEnhancementJob(candidate());
            const [old] = await claimEnhancementJobs({ workerId: "worker-a", now, leaseMs, limit: 1 });
            const [next] = await claimEnhancementJobs({ workerId: "worker-b", now: now + leaseMs, leaseMs, limit: 1 });
            expect(next.id).toBe(old.id);
            expect(next.leaseToken).not.toBe(old.leaseToken);
            expect(await mutateEnhancementJob(original.id, userId, (job) => ({ ...job, status: "succeeded" }), { token: old.leaseToken!, now: now + leaseMs })).toBeNull();
            const done = await mutateEnhancementJob(original.id, userId, (job) => ({ ...job, status: "succeeded", phase: "completed", nextPollAt: null }), { token: next.leaseToken!, now: now + leaseMs });
            expect(done?.status).toBe("succeeded");
            expect(await nextEnhancementDueAt()).toBeNull();
        });
        it("keeps an explicit cancellation when the current worker updates its own phase", async () => {
            const original = await insertEnhancementJob(candidate());
            const [claimed] = await claimEnhancementJobs({ workerId: "worker-a", now, leaseMs, limit: 1 });
            await mutateEnhancementJob(original.id, userId, (job) => ({ ...job, cancelRequested: true }));
            const changed = await mutateEnhancementJob(original.id, userId, (job) => ({ ...job, phase: "submit" }), { token: claimed.leaseToken!, now });
            expect(changed?.cancelRequested).toBe(true);
        });
        it("binds all reads and writes to the owner", async () => {
            const original = await insertEnhancementJob(candidate());
            expect(await getEnhancementJob(original.id, "other-owner")).toBeNull();
            expect(await listEnhancementJobsForTask(original.imageTaskId, "other-owner")).toEqual([]);
            expect(await mutateEnhancementJob(original.id, "other-owner", (job) => ({ ...job, cancelRequested: true }))).toBeNull();
            expect((await getEnhancementJob(original.id, userId))?.cancelRequested).toBe(false);
        });
        it("allows an exact id read for an already-authorized administrator while retaining owner filtering", async () => {
            const first = await insertEnhancementJob(candidate());
            const second = await insertEnhancementJob({ ...candidate(), resultId: "another-result" });
            expect(await getEnhancementJob(first.id)).toEqual(first);
            expect(await getEnhancementJob(second.id)).toEqual(second);
            expect(await getEnhancementJob("missing-enhancement")).toBeNull();
            expect(await getEnhancementJob(first.id, "other-owner")).toBeNull();
            expect(await getEnhancementJob(first.id, "")).toBeNull();
            expect(await getEnhancementJob(second.id, userId)).toEqual(second);
        });
        it("rolls back failed mutations and rejects identity changes", async () => {
            const original = await insertEnhancementJob(candidate());
            await expect(mutateEnhancementJob(original.id, userId, (job) => { job.reason = "uncommitted"; throw new Error("fixture rollback"); })).rejects.toThrow("fixture rollback");
            expect(await getEnhancementJob(original.id, userId)).toEqual(original);
            await expect(mutateEnhancementJob(original.id, userId, (job) => ({ ...job, resultId: "different-result" }))).rejects.toThrow("enhancement_identity_conflict");
        });
        it("awaits asynchronous durable effects before persisting a leased mutation", async () => {
            const original = await insertEnhancementJob(candidate());
            const [claimed] = await claimEnhancementJobs({ workerId: "worker-a", now, leaseMs, limit: 1 });
            const changed = await mutateEnhancementJob(original.id, userId, async (job, executor) => {
                await Promise.resolve();
                expect(Boolean(executor)).toBe(provider === "postgres");
                return { ...job, reason: "effect_committed" };
            }, { token: claimed.leaseToken!, now });
            expect(changed?.reason).toBe("effect_committed");
            expect((await getEnhancementJob(original.id, userId))?.reason).toBe("effect_committed");
        });
        it("does not persist a mutation when its asynchronous effect fails", async () => {
            const original = await insertEnhancementJob(candidate());
            await expect(mutateEnhancementJob(original.id, userId, async () => {
                await Promise.resolve();
                throw new Error("fixture asynchronous effect failed");
            })).rejects.toThrow("fixture asynchronous effect failed");
            expect(await getEnhancementJob(original.id, userId)).toEqual(original);
        });
        it("keeps the frozen native reference immutable during later mutations", async () => {
            const original = await insertEnhancementJob(candidate());
            await expect(mutateEnhancementJob(original.id, userId, (job) => ({ ...job, decision: { ...job.decision, source: { ...job.decision.source, url: "/different-native.png" } } }))).rejects.toThrow("enhancement_identity_conflict");
            expect(await getEnhancementJob(original.id, userId)).toEqual(original);
        });
        it("does not claim future work or completed results", async () => {
            const future = { ...candidate(), nextPollAt: now + 1 };
            await insertEnhancementJob(future);
            expect(await claimEnhancementJobs({ workerId: "worker-a", now, leaseMs, limit: 1 })).toEqual([]);
            expect(await nextEnhancementDueAt()).toBe(now + 1);
            await mutateEnhancementJob(future.id, userId, (job) => ({ ...job, status: "failed", nextPollAt: null }));
            expect(await nextEnhancementDueAt()).toBeNull();
        });
        it("recovers receipt work without reverting a published success", async () => {
            const original = { ...candidate(), status: "succeeded" as const, phase: "receipt" as const };
            await insertEnhancementJob(original);
            const [claimed] = await claimEnhancementJobs({ workerId: "worker-a", now, leaseMs, limit: 1 });
            expect(claimed).toMatchObject({ id: original.id, status: "succeeded", phase: "receipt", remoteKey: original.remoteKey, receiptId: original.receiptId });
        });
    });
}
