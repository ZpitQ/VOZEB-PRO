import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializePostgresSchema, postgresQuery } from "./database/postgres";
import { listEnhancementJobsForTask } from "./database/image-enhancement-job-repository";
import { createStoredGenerationTask } from "./generation-task-store";
import { getImageTask, transitionImageTask, type ImageTask } from "./image-task-store";
import type { FrozenImageEnhancementPolicy } from "./image-enhancement-config";

const userId = "enhancement-enqueue-fixture-owner";
const pg = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
const policy: FrozenImageEnhancementPolicy = { revision: "policy-one", enabled: true, connection: { revision: "policy-one", credentialRef: "credential-fixture", serviceId: "service-fixture", timeoutMs: 60_000, model: { id: "model-fixture", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [256], defaultTile: 256, tta: false, gpuId: 0 } } };
function nativeTask(): ImageTask {
    const id = randomUUID();
    const media = { resultId: `${id}:1`, enhancementId: `enhancement:${id}:1`, dataUrl: "/api/generation-log-assets/native.png", serverUrl: "/api/generation-log-assets/native.png", width: 1254, height: 1254, bytes: 1000, mimeType: "image/png", nativeSource: { url: "/api/generation-log-assets/native.png", sha256: "a".repeat(64), width: 1254, height: 1254, byteLength: 1000, format: "png", hasAlpha: false, provenance: "provider_native" as const } };
    return { id, userId, username: "fixture", displayName: "fixture", kind: "generation", source: "image-workbench", status: "running", createdAt: Date.now(), updatedAt: Date.now(), config: { baseUrl: "https://fixture.invalid", apiKey: "system", apiFormat: "openai", model: "fixture", quality: "4k", size: "4096x4096" }, references: [], prompt: "fixture", enhancementPolicy: structuredClone(policy), result: { ...media, results: [media] } };
}
for (const provider of ["file", "postgres"] as const) {
    describe.skipIf(provider === "postgres" && !pg)(`${provider} image completion enhancement outbox`, () => {
        let directory: string;
        let initialized = false;
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-enqueue-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            if (provider === "postgres") {
                const target = new URL(process.env.DATABASE_URL || "");
                if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_m5_e2e")) throw new Error("An explicitly isolated M5 PostgreSQL fixture is required");
                await initializePostgresSchema();
                initialized = true;
                await postgresQuery("INSERT INTO users (id,username,display_name,password_hash) VALUES ($1,$1,'fixture','fixture-hash') ON CONFLICT (id) DO NOTHING", [userId]);
            }
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
        it("commits exactly one frozen job with native success and does not enqueue on repeated transitions", async () => {
            const task = await createStoredGenerationTask("image", nativeTask(), 60_000);
            const completed = await transitionImageTask(task, ["running"], { status: "success", result: task.result });
            const [job] = await listEnhancementJobsForTask(task.id, userId);
            expect(job).toMatchObject({ id: task.result!.enhancementId, imageTaskId: task.id, resultId: task.result!.resultId, status: "queued", phase: "prepare", attempt: 1, decision: { status: "queued", source: task.result!.nativeSource, target: { width: 4096, height: 4096 }, inference: { width: 5016, height: 5016 }, connection: policy.connection } });
            expect(completed?.status).toBe("success");
            expect((await getImageTask(task.id))?.result).toEqual(task.result);
            expect(await transitionImageTask(task, ["running"], { status: "success", result: task.result })).toBeNull();
            expect(await listEnhancementJobsForTask(task.id, userId)).toEqual([job]);
        });
        it.each(["disabled", "native_sufficient", "unsupported_transparency"])("records a terminal %s decision without due work", async (reason) => {
            const input = nativeTask();
            if (reason === "disabled") input.enhancementPolicy = { ...policy, enabled: false, connection: null };
            if (reason === "native_sufficient") input.config.size = "1024x1024";
            if (reason === "unsupported_transparency") input.result!.results![0].nativeSource = { ...input.result!.results![0].nativeSource!, hasAlpha: true };
            const task = await createStoredGenerationTask("image", input, 60_000);
            await transitionImageTask(task, ["running"], { status: "success", result: task.result });
            expect(await listEnhancementJobsForTask(task.id, userId)).toEqual([expect.objectContaining({ status: "skipped", phase: "completed", reason, nextPollAt: null })]);
            expect((await getImageTask(task.id))?.status).toBe("success");
        });
        it("does not create enhancement work for failed, cancelled or non-native results", async () => {
            for (const status of ["error", "cancelled", "success"] as const) {
                const input = nativeTask();
                if (status === "success") input.result = { dataUrl: "/api/generation-log-assets/unqualified.png" };
                const task = await createStoredGenerationTask("image", input, 60_000);
                await transitionImageTask(task, ["running"], { status, result: task.result });
                expect(await listEnhancementJobsForTask(task.id, userId)).toEqual([]);
            }
        });
    });
}
