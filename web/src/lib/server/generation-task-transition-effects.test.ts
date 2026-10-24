import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializePostgresSchema, postgresQuery } from "./database/postgres";
import { createStoredGenerationTask, getStoredGenerationTask, transitionStoredGenerationTask } from "./generation-task-store";
import { getEnhancementJob, insertEnhancementJob, type ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import { planImageEnhancement } from "./image-enhancement-plan";

const userId = "enhancement-transition-fixture-owner";
const pg = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
type NativeTask = { id: string; userId: string; status: string; createdAt: number; updatedAt: number; result?: { url: string } };
function enhancement(task: NativeTask): ImageEnhancementJob {
    const id = randomUUID();
    return {
        id,
        userId,
        imageTaskId: task.id,
        resultId: `${task.id}:1`,
        decision: planImageEnhancement({
            nativeValid: true,
            enabled: false,
            requested4k: true,
            protectedContract: false,
            layered: false,
            source: { url: "/api/generation-log-assets/images/fixture.png", width: 1254, height: 1254, sha256: "a".repeat(64), byteLength: 1000, format: "png", hasAlpha: false, provenance: "provider_native" },
            target: { width: 4096, height: 4096 },
            connection: null,
        }),
        status: "skipped",
        phase: "completed",
        reason: "disabled",
        attempt: 1,
        remoteKey: `enhancement:${id}:1`,
        receiptId: randomUUID(),
        events: [],
        cancelRequested: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nextPollAt: null,
        workerId: null,
        leaseToken: null,
        leaseUntil: null,
    };
}
for (const provider of ["file", "postgres"] as const) {
    describe.skipIf(provider === "postgres" && !pg)(`${provider} native success and enhancement durability`, () => {
        let directory: string;
        let initialized = false;
        let task: NativeTask;
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), "vozeb-native-enhancement-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            if (provider === "postgres") {
                const target = new URL(process.env.DATABASE_URL || "");
                if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_m5_e2e")) throw new Error("An explicitly isolated M5 PostgreSQL fixture is required");
                await initializePostgresSchema();
                initialized = true;
                await postgresQuery("INSERT INTO users (id,username,display_name,password_hash) VALUES ($1,$1,'fixture','fixture-hash') ON CONFLICT (id) DO NOTHING", [userId]);
            }
            const now = Date.now();
            task = await createStoredGenerationTask("image", { id: randomUUID(), userId, status: "pending", createdAt: now, updatedAt: now }, 60_000);
        });
        afterEach(async () => {
            if (provider === "postgres" && initialized) {
                await postgresQuery("DELETE FROM image_enhancement_jobs WHERE user_id=$1", [userId]);
                await postgresQuery("DELETE FROM generation_tasks WHERE user_id=$1", [userId]);
                await postgresQuery("DELETE FROM users WHERE id=$1", [userId]);
            }
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        });
        it("persists the enhancement intent before returning native success", async () => {
            const candidate = enhancement(task);
            const onPersist = vi.fn(async (next, executor) => {
                expect(next).toMatchObject({ id: task.id, status: "success", result: { url: "fixture-native" } });
                await insertEnhancementJob(candidate, executor);
            });
            const completed = await transitionStoredGenerationTask<NativeTask>("image", task.id, userId, ["pending"], { status: "success", result: { url: "fixture-native" } }, 60_000, undefined, onPersist);
            expect(completed?.status).toBe("success");
            expect(onPersist).toHaveBeenCalledTimes(1);
            expect(await getEnhancementJob(candidate.id, userId)).toEqual(candidate);
        });
        it("does not publish native success when its durable effect throws", async () => {
            const candidate = enhancement(task);
            await expect(
                transitionStoredGenerationTask<NativeTask>("image", task.id, userId, ["pending"], { status: "success" }, 60_000, undefined, async (_next, executor) => {
                    await insertEnhancementJob(candidate, executor);
                    throw new Error("fixture interrupted completion");
                }),
            ).rejects.toThrow("fixture interrupted completion");
            expect((await getStoredGenerationTask<NativeTask>("image", task.id))?.status).toBe("pending");
            // JSON files can retain a pre-success intent; execution must gate it on native success.
            expect(await getEnhancementJob(candidate.id, userId)).toEqual(provider === "postgres" ? null : candidate);
        });
        it("does not run effects for a lost state transition or another owner", async () => {
            const onPersist = vi.fn();
            expect(await transitionStoredGenerationTask<NativeTask>("image", task.id, "other-owner", ["pending"], { status: "success" }, 60_000, undefined, onPersist)).toBeNull();
            expect(await transitionStoredGenerationTask<NativeTask>("image", task.id, userId, ["running"], { status: "success" }, 60_000, undefined, onPersist)).toBeNull();
            expect(onPersist).not.toHaveBeenCalled();
            expect((await getStoredGenerationTask<NativeTask>("image", task.id))?.status).toBe("pending");
        });
    });
}
