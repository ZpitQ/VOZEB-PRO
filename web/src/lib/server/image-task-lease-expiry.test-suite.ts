import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationTaskLease } from "./generation-task-scheduler";

export function imageTaskLeaseExpirySuite(provider: "file" | "postgres") {
    const enabled = provider === "file" || process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1";
    (enabled ? describe : describe.skip)(`${provider} image lease expiry during lock wait`, () => {
        let directory: string;
        let userId: string;
        let database: typeof import("./database");
        let imageTasks: typeof import("./image-task-store");
        let tasks: typeof import("./generation-task-store");
        let scheduler: typeof import("./generation-task-scheduler");
        const workerId = "fixture-image-lease-expiry-worker";
        const fixtureLeaseMs = 3_000;

        beforeAll(async () => {
            if (provider === "postgres" && (process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" || process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" || !process.env.DATABASE_URL))
                throw new Error("Explicit isolated PostgreSQL fixture with startup pool maximum one is required");
            directory = await mkdtemp(path.join(tmpdir(), "vozeb-image-lease-expiry-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            [database, imageTasks, tasks, scheduler] = await Promise.all([import("./database"), import("./image-task-store"), import("./generation-task-store"), import("./generation-task-scheduler")]);
            if (provider === "postgres") await database.initializePostgresSchema();
            userId = `fixture-image-lease-expiry-${randomUUID()}`;
            if (provider === "postgres") {
                const repositories = database.createPostgresRepositories();
                const settings = await repositories.settings.getSettings();
                const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
                if (!planId) throw new Error("Fixture entitlement plan missing");
                await repositories.users.createWithNextAccountId({
                    id: userId,
                    username: `fixture_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
                    displayName: "Isolated image lease expiry fixture",
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

        async function claimImage(): Promise<GenerationTaskLease> {
            const task = await imageTasks.createImageTask({
                userId,
                username: "fixture-image-lease-expiry",
                displayName: "Isolated image lease expiry fixture",
                kind: "generation",
                source: "image-workbench",
                config: { baseUrl: "https://image.example.com", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-image-model" },
                prompt: "Preserve the image claim after its lease expires while waiting for a lock",
                references: [],
            });
            await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "created", nextPollAt: Date.now() - 1 });
            const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [task.id], limit: 1 });
            assert.equal(claimed.length, 1);
            const current = claimed[0];
            assert.ok(current);
            assert.ok(current.executionId);
            return current;
        }

        async function fileRecord(id: string) {
            const record = await tasks.getStoredGenerationTaskRecord("image", id);
            assert.ok(record);
            return record;
        }

        async function fileExpiryGate<T>(current: GenerationTaskLease, operation: (held: GenerationTaskLease) => Promise<T>, name: string) {
            const leaseUntil = Date.now() + fixtureLeaseMs;
            await tasks.withGenerationTaskFileMutation(async (records) => ({
                tasks: records.map((record) => (record.type === "image" && record.id === current.id ? { ...record, leaseUntil } : record)),
                result: undefined,
            }));
            const before = await fileRecord(current.id);
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const gate = tasks.withGenerationTaskFileMutation(async (records) => {
                entered.resolve();
                await release.promise;
                return { tasks: records, result: undefined };
            });
            let pending: Promise<T> | undefined;
            try {
                await Promise.race([
                    entered.promise,
                    gate.then(() => {
                        throw new Error("Fixture setup: file lock holder completed before entering its gate");
                    }),
                ]);
                vi.useFakeTimers({ toFake: ["Date"] });
                const calledAt = Date.now();
                vi.setSystemTime(calledAt);
                assert.ok(calledAt < leaseUntil, "Fixture setup: file lease expired before the operation was called");
                pending = operation({ ...current, leaseUntil });
                void pending.catch(() => undefined);
                vi.setSystemTime(leaseUntil + 1);
                const unlockedAt = Date.now();
                release.resolve();
                await gate;
                const value = await pending;
                const after = await fileRecord(current.id);
                console.info("Image lease expiry gate", { provider, operation: name, fixtureLeaseMs, calledAt, leaseUntil, unlockedAt });
                return { value, before, after };
            } finally {
                release.resolve();
                try {
                    await gate;
                } finally {
                    try {
                        if (pending) await pending.catch(() => undefined);
                    } finally {
                        vi.useRealTimers();
                    }
                }
            }
        }

        async function waitForPostgresLock(locker: Client, businessPid: number, lockerPid: number, leaseUntil: string, settled: () => boolean) {
            while (true) {
                if (settled()) throw new Error("Fixture setup: operation settled before an active lease lock wait was observed");
                await locker.query("SELECT pg_stat_clear_snapshot()");
                const result = await locker.query<{ blocked: boolean; active: boolean; observed_at: string }>(
                    `SELECT clock_timestamp()::text AS observed_at, $3::timestamptz > clock_timestamp() AS active,
                            $2::int = ANY(pg_blocking_pids($1::int)) AND EXISTS (
                                SELECT 1 FROM pg_stat_activity WHERE pid = $1::int AND wait_event_type = 'Lock'
                            ) AS blocked`,
                    [businessPid, lockerPid, leaseUntil],
                );
                const observed = result.rows[0];
                assert.ok(observed);
                assert.ok(observed.active, "Fixture setup: no business lock wait was observed before the actual lease expired");
                if (observed.blocked) return observed.observed_at;
            }
        }

        async function postgresExpiryGate<T>(current: GenerationTaskLease, operation: (held: GenerationTaskLease) => Promise<T>, name: string) {
            const locker = new Client({ connectionString: database.getPostgresConnectionString() });
            let transactionOpen = false;
            let pending: Promise<T> | undefined;
            try {
                await locker.connect();
                const business = await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                const businessPid = business.rows[0]?.pid;
                assert.ok(businessPid);
                const owner = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                const lockerPid = owner.rows[0]?.pid;
                assert.ok(lockerPid);
                assert.notEqual(businessPid, lockerPid);
                await database.postgresQuery("UPDATE generation_tasks SET lease_until = clock_timestamp() + $2::double precision * interval '1 millisecond' WHERE id = $1 AND task_type = 'image'", [current.id, fixtureLeaseMs]);
                await locker.query("BEGIN");
                transactionOpen = true;
                // A pure row lock preserves the original tuple; no UPDATE can trigger an expiry recheck through EPQ.
                const locked = await locker.query<{ record: Record<string, unknown>; lease_until: string; active: boolean }>(
                    "SELECT to_jsonb(task) AS record, lease_until::text AS lease_until, lease_until > clock_timestamp() AS active FROM vozeb_pro_generation_tasks AS task WHERE id = $1 AND task_type = 'image' FOR UPDATE",
                    [current.id],
                );
                const original = locked.rows[0];
                assert.ok(original);
                assert.ok(original.active, "Fixture setup: PostgreSQL lease expired before the pure row lock was acquired");
                let settled = false;
                pending = operation({ ...current, leaseUntil: new Date(original.lease_until).getTime() });
                void pending.then(
                    () => {
                        settled = true;
                    },
                    () => {
                        settled = true;
                    },
                );
                const blockedAt = await waitForPostgresLock(locker, businessPid, lockerPid, original.lease_until, () => settled);
                await locker.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))))", [original.lease_until]);
                const expiry = await locker.query<{ expired: boolean; expired_at: string }>("SELECT clock_timestamp() >= $1::timestamptz AS expired, clock_timestamp()::text AS expired_at", [original.lease_until]);
                const observed = expiry.rows[0];
                assert.ok(observed);
                assert.ok(observed.expired, "Fixture setup: the actual PostgreSQL lease has not expired");
                await locker.query("COMMIT");
                transactionOpen = false;
                const value = await pending;
                const saved = await database.postgresQuery<{ record: Record<string, unknown> }>("SELECT to_jsonb(task) AS record FROM generation_tasks AS task WHERE id = $1 AND task_type = 'image'", [current.id]);
                const after = saved.rows[0]?.record;
                assert.ok(after);
                console.info("Image lease expiry gate", { provider, operation: name, fixtureLeaseMs, businessPid, lockerPid, blockedAt, leaseUntil: original.lease_until, unlockedAt: observed.expired_at });
                return { value, before: original.record, after };
            } finally {
                try {
                    if (transactionOpen) await locker.query("ROLLBACK");
                } finally {
                    try {
                        if (pending) await pending.catch(() => undefined);
                    } finally {
                        await locker.end();
                    }
                }
            }
        }

        const expiryGate = provider === "file" ? fileExpiryGate : postgresExpiryGate;

        it("rejects renewal after the active image lease expires while waiting for its real lock", async () => {
            const current = await claimImage();
            const observed = await expiryGate(current, (held) => scheduler.renewGenerationTaskLeases(workerId, [held]), "renew");

            expect({ renewed: observed.value, record: observed.after }).toEqual({ renewed: 0, record: observed.before });
        }, 30_000);

        it("rejects release after the active image lease expires while waiting for its real lock", async () => {
            const current = await claimImage();
            const observed = await expiryGate(
                current,
                (held) => scheduler.releaseGenerationTaskLease("image", held.id, workerId, { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "fixture-completed" }, { executionId: held.executionId }),
                "release",
            );

            expect({ released: observed.value, record: observed.after }).toEqual({ released: null, record: observed.before });
        }, 30_000);

        it("continues to renew the current owner while its original image lease remains active", async () => {
            const current = await claimImage();

            expect(await scheduler.renewGenerationTaskLeases(workerId, [current])).toBe(1);
            const saved = await tasks.getStoredGenerationTaskRecord("image", current.id);
            expect(saved).toMatchObject({ workerId, payload: { executionId: current.executionId } });
            expect(saved?.leaseUntil).toBeGreaterThan(Date.now());
        });

        it("continues to release the current owner while its original image lease remains active", async () => {
            const current = await claimImage();

            expect(await scheduler.releaseGenerationTaskLease("image", current.id, workerId, { executionPhase: "completed", nextPollAt: undefined }, { executionId: current.executionId })).toMatchObject({
                id: current.id,
                executionPhase: "completed",
                workerId: undefined,
                leaseUntil: undefined,
            });
        });
    });
}
