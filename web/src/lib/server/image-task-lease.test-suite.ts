import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationTaskLease } from "./generation-task-scheduler";
import type { GenerationTaskType } from "./generation-task-types";

export function imageTaskLeaseSuite(provider: "file" | "postgres") {
    const enabled = provider === "file" || process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1";
    (enabled ? describe : describe.skip)(`${provider} image task claim execution`, () => {
        let directory: string;
        let userId: string;
        let database: typeof import("./database");
        let imageTasks: typeof import("./image-task-store");
        let tasks: typeof import("./generation-task-store");
        let scheduler: typeof import("./generation-task-scheduler");
        const workerId = "fixture-image-lease-worker";

        beforeAll(async () => {
            if (provider === "postgres" && (process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" || process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" || !process.env.DATABASE_URL))
                throw new Error("Explicit isolated PostgreSQL fixture with startup pool maximum one is required");
            directory = await mkdtemp(path.join(tmpdir(), "vozeb-image-lease-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            [database, imageTasks, tasks, scheduler] = await Promise.all([import("./database"), import("./image-task-store"), import("./generation-task-store"), import("./generation-task-scheduler")]);
            if (provider === "postgres") await database.initializePostgresSchema();
            userId = `fixture-image-lease-${randomUUID()}`;
            if (provider === "postgres") {
                const repositories = database.createPostgresRepositories();
                const settings = await repositories.settings.getSettings();
                const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
                if (!planId) throw new Error("Fixture entitlement plan missing");
                await repositories.users.createWithNextAccountId({
                    id: userId,
                    username: `fixture_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
                    displayName: "Isolated image lease fixture",
                    bio: "",
                    role: "user",
                    adminPermissions: [],
                    status: "active",
                    planId,
                    pointsBalance: 1000,
                    passwordHash: "fixture-only",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
            }
        }, 30_000);

        afterAll(async () => {
            try {
                if (provider === "postgres" && userId) await database.postgresQuery("DELETE FROM users WHERE id = $1", [userId]);
            } finally {
                vi.unstubAllEnvs();
                if (directory) await rm(directory, { recursive: true, force: true });
            }
        });

        async function seedImage(clientContext: { executionId?: string } = {}) {
            const task = await imageTasks.createImageTask({
                ...clientContext,
                userId,
                username: "fixture-image-lease",
                displayName: "Isolated image lease fixture",
                kind: "generation",
                source: "image-workbench",
                config: { baseUrl: "https://image.example.com", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model" },
                prompt: "Keep the original image task and its lease identity",
                references: [],
            });
            await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "created", nextPollAt: Date.now() - 1 });
            return task;
        }

        async function claim(id: string): Promise<GenerationTaskLease> {
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [id], limit: 1 });
            assert.equal(claimed.length, 1);
            const lease = claimed[0];
            assert.ok(lease);
            return lease;
        }

        async function record(type: GenerationTaskType, id: string) {
            const saved = await tasks.getStoredGenerationTaskRecord(type, id);
            assert.ok(saved);
            return saved;
        }

        async function expireImageLease(id: string) {
            if (provider === "postgres") {
                await database.postgresQuery("UPDATE generation_tasks SET lease_until = clock_timestamp() - interval '1 millisecond' WHERE id = $1 AND task_type = 'image'", [id]);
                return;
            }
            await tasks.withGenerationTaskFileMutation(async (records) => ({
                tasks: records.map((task) => (task.type === "image" && task.id === id ? { ...task, leaseUntil: Date.now() - 1 } : task)),
                result: undefined,
            }));
        }

        it("does not accept a claim execution supplied through the creation context", async () => {
            const task = await seedImage({ executionId: "client-forged-execution" });

            expect(task.executionId).toBeUndefined();
            expect((await record("image", task.id)).payload.executionId).toBeUndefined();
        });

        it("returns the stored private execution for each image claim and replaces it on reclaim", async () => {
            const task = await seedImage();
            const first = await claim(task.id);

            expect(first.executionId).toEqual(expect.any(String));
            expect(first.executionId).not.toBe("");
            expect((await record("image", task.id)).payload.executionId).toBe(first.executionId);
            await expireImageLease(task.id);
            const second = await claim(task.id);
            expect(second.executionId).toEqual(expect.any(String));
            expect(second.executionId).not.toBe(first.executionId);
            expect((await record("image", task.id)).payload.executionId).toBe(second.executionId);
        });

        it("rejects renewal from the old execution after the same worker reclaims and keeps the new owner eligible", async () => {
            const task = await seedImage();
            const first = await claim(task.id);
            await expireImageLease(task.id);
            const second = await claim(task.id);
            const before = await record("image", task.id);

            const oldRenewal = await scheduler.renewGenerationTaskLeases(workerId, [first]);
            expect(oldRenewal).toBe(0);
            expect(await record("image", task.id)).toEqual(before);
            expect(await scheduler.renewGenerationTaskLeases(workerId, [second])).toBe(1);
            const renewed = await record("image", task.id);
            expect(renewed.payload.executionId).toBe(second.executionId);
            expect(renewed.workerId).toBe(workerId);
            expect(renewed.leaseUntil).toBeGreaterThan(Date.now());
            expect(await scheduler.claimDueGenerationTasks({ workerId: "fixture-other-worker", taskIds: [task.id], limit: 1 })).toEqual([]);
        });

        it("rejects release from the old execution without changing the new complete record and accepts its current release", async () => {
            const task = await seedImage();
            const first = await claim(task.id);
            await expireImageLease(task.id);
            const second = await claim(task.id);
            const before = await record("image", task.id);
            const patch = { executionPhase: "completed" as const, nextPollAt: undefined, lastUpstreamStatus: "fixture-persisted" };

            const oldRelease = await scheduler.releaseGenerationTaskLease("image", task.id, workerId, patch, { executionId: first.executionId });
            expect(oldRelease).toBeNull();
            expect(await record("image", task.id)).toEqual(before);
            expect(await scheduler.releaseGenerationTaskLease("image", task.id, workerId, patch, { executionId: second.executionId })).toMatchObject({
                id: task.id,
                executionPhase: "completed",
                nextPollAt: undefined,
                workerId: undefined,
                leaseUntil: undefined,
            });
        });

        it("rejects a current image execution release after its actual lease has expired", async () => {
            const task = await seedImage();
            const current = await claim(task.id);
            await expireImageLease(task.id);
            const before = await record("image", task.id);

            const released = await scheduler.releaseGenerationTaskLease("image", task.id, workerId, { executionPhase: "completed", nextPollAt: undefined }, { executionId: current.executionId });
            expect(released).toBeNull();
            expect(await record("image", task.id)).toEqual(before);
        });

        it("keeps a real nonimage task on its existing owner-based claim, renewal and release path", async () => {
            const now = Date.now();
            const task = { id: `text-lease-${randomUUID()}`, userId, status: "running", createdAt: now, updatedAt: now };
            await tasks.createStoredGenerationTask("text", task, 60_000);
            await scheduler.scheduleGenerationTask("text", task.id, { executionPhase: "polling", nextPollAt: now - 1 });
            const current = await claim(task.id);

            expect(current.type).toBe("text");
            expect(current.executionId).toBeUndefined();
            expect(await scheduler.renewGenerationTaskLeases("fixture-other-worker", [current])).toBe(0);
            expect(await scheduler.renewGenerationTaskLeases(workerId, [current])).toBe(1);
            expect(await scheduler.releaseGenerationTaskLease("text", task.id, "fixture-other-worker", { executionPhase: "completed", nextPollAt: undefined })).toBeNull();
            expect(await scheduler.releaseGenerationTaskLease("text", task.id, workerId, { executionPhase: "completed", nextPollAt: undefined })).toMatchObject({ executionPhase: "completed", workerId: undefined, leaseUntil: undefined });
            expect((await record("text", task.id)).payload).toEqual(task);
        });
    });
}
