import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { StoredGenerationLog } from "./generation-log-types";

const mocks = vi.hoisted(() => ({
    postgres: false,
    readGenerationLogDb: vi.fn(),
    list: vi.fn(),
    getEnhancementJob: vi.fn(),
    listEnhancementJobsForTask: vi.fn(),
    insertEnhancementJob: vi.fn(),
    mutateEnhancementJob: vi.fn(),
    claimEnhancementJobs: vi.fn(),
    mutateGenerationLogDb: vi.fn(),
    runImageEnhancementBatch: vi.fn(),
    fetch: vi.fn(),
}));

vi.mock("@/lib/server/database", async (original) => ({ ...await original<typeof import("@/lib/server/database")>(), isPostgresDatabaseEnabled: () => mocks.postgres, ensurePostgresSchema: vi.fn(), createPostgresRepositories: () => ({ generationLogs: { list: mocks.list } }) }));
vi.mock("./generation-log-repository", async (original) => ({ ...await original<typeof import("./generation-log-repository")>(), readGenerationLogDb: mocks.readGenerationLogDb, mutateGenerationLogDb: mocks.mutateGenerationLogDb }));
vi.mock("./database/image-enhancement-job-repository", () => ({ getEnhancementJob: mocks.getEnhancementJob, listEnhancementJobsForTask: mocks.listEnhancementJobsForTask, insertEnhancementJob: mocks.insertEnhancementJob, mutateEnhancementJob: mocks.mutateEnhancementJob, claimEnhancementJobs: mocks.claimEnhancementJobs }));
vi.mock("./image-enhancement-service", () => ({ runImageEnhancementBatch: mocks.runImageEnhancementBatch }));

import { listGenerationLogs } from "./generation-log-store";

const adminOptions = { page: 1, pageSize: 1, includeImageEnhancement: true };

function fixtureLog(): StoredGenerationLog {
    return {
        id: "log-one", userId: "owner-one", username: "creator", displayName: "创作者", kind: "image", source: "image-workbench", status: "success", title: "图片记录", prompt: "公开需求", model: "image-model", summary: "完成", durationMs: 1000, count: 1, successCount: 1, failCount: 0,
        taskId: "image-task-one", assets: [{ type: "image", url: "/api/generation-log-assets/native.png", resultId: "native-result-one", enhancementId: "enhancement-one" }],
        createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:01.000Z",
    } as StoredGenerationLog;
}

function fixtureJob(): ImageEnhancementJob {
    return {
        id: "enhancement-one", userId: "owner-one", imageTaskId: "image-task-one", resultId: "native-result-one", status: "running", phase: "poll", reason: null, attempt: 2,
        decision: { status: "queued", reason: null, source: { url: "/api/generation-log-assets/native.png", width: 1254, height: 1254, byteLength: 1200, sha256: "a".repeat(64), format: "png", hasAlpha: false, provenance: "provider_native" }, target: { width: 4096, height: 4096 }, inference: { width: 5016, height: 5016 }, connection: { revision: "private-revision", credentialRef: "private-credential", serviceId: "private-service", timeoutMs: 10000, model: { id: "fixture-model", binaryVersion: "binary-v2", binarySha256: "b".repeat(64), modelVersion: "model-v3", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 } } },
        timings: { workerQueueMs: 0, workerExecutionMs: 125.5, deliveryEncodingMs: 2.75 },
        events: [{ stage: "prepared", at: 1000, attempt: 2 }, { stage: "worker_running", at: 2000, attempt: 2 }],
        remoteKey: "private-remote-key", receiptId: "private-receipt", cancelRequested: false, createdAt: 1000, updatedAt: 2000, nextPollAt: 3000, workerId: "private-worker", leaseToken: "private-lease", leaseUntil: 90000,
    };
}

describe("administrator generation log enhancement observations", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.postgres = false;
        mocks.readGenerationLogDb.mockResolvedValue({ version: 1, logs: [fixtureLog()] });
        mocks.getEnhancementJob.mockResolvedValue(fixtureJob());
        vi.stubGlobal("fetch", mocks.fetch);
    });

    afterEach(() => {
        for (const operation of [mocks.insertEnhancementJob, mocks.mutateEnhancementJob, mocks.claimEnhancementJobs, mocks.mutateGenerationLogDb, mocks.runImageEnhancementBatch, mocks.fetch]) expect(operation).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it.each([false, true])("hydrates only the returned page with exact owner and result/task binding (postgres=%s)", async (postgres) => {
        mocks.postgres = postgres;
        const current = fixtureLog();
        const older = { ...fixtureLog(), id: "older-log", userId: "other-owner", assets: [{ type: "image", url: "/api/generation-log-assets/older.png", resultId: "other-result", enhancementId: "other-enhancement" }], createdAt: "2026-10-22T00:00:00.000Z" };
        mocks.readGenerationLogDb.mockResolvedValue({ version: 1, logs: [older, current] });
        mocks.list.mockResolvedValue({ items: [current], total: 2, page: 1, pageSize: 1 });
        const result = await listGenerationLogs(adminOptions);

        expect(result).toMatchObject({ total: 2, items: [{ status: "success", successCount: 1, failCount: 0, assets: [{ enhancement: { id: "enhancement-one", status: "running", attempt: 2, native: { width: 1254, height: 1254 }, plannedInference: { width: 5016, height: 5016 }, target: { width: 4096, height: 4096 }, model: { id: "fixture-model", binaryVersion: "binary-v2", modelVersion: "model-v3" }, timings: { workerQueueMs: 0, workerExecutionMs: 125.5, deliveryEncodingMs: 2.75 }, events: [{ stage: "prepared" }, { stage: "worker_running" }] } }] }] });
        expect(mocks.getEnhancementJob).toHaveBeenCalledExactlyOnceWith("enhancement-one", "owner-one");
        expect(mocks.listEnhancementJobsForTask).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain("private-");
        expect(current.assets[0]).not.toHaveProperty("enhancement");
    });

    it.each(["id", "userId", "resultId", "imageTaskId"] as const)("does not expose an enhancement with a mismatched %s", async (field) => {
        mocks.getEnhancementJob.mockResolvedValue({ ...fixtureJob(), [field]: "foreign-identity" });
        const result = await listGenerationLogs(adminOptions);
        expect(result.items[0]?.assets[0]).not.toHaveProperty("enhancement");
    });

    it("uses the original asset slot's image task and rejects another slot's task", async () => {
        const log = fixtureLog();
        log.taskId = "first-image-task";
        log.requestSnapshot = { version: 1, parameters: {}, references: [], slots: [{ id: "slot-one", index: 0, status: "success", assetIndex: 0, taskId: "image-task-one", serverTaskId: "unrelated-server-task" }] };
        mocks.readGenerationLogDb.mockResolvedValue({ version: 1, logs: [log] });
        expect((await listGenerationLogs(adminOptions)).items[0]?.assets[0]).toHaveProperty("enhancement.id", "enhancement-one");
        mocks.getEnhancementJob.mockResolvedValue({ ...fixtureJob(), imageTaskId: "first-image-task" });
        expect((await listGenerationLogs(adminOptions)).items[0]?.assets[0]).not.toHaveProperty("enhancement");
    });

    it("does not query jobs for ordinary reads, no-job skips, video, or incomplete identities", async () => {
        await listGenerationLogs({ page: 1 });
        const log = fixtureLog();
        log.assets = [
            { type: "image", url: "/api/generation-log-assets/skipped.png", resultId: "skip-result", enhancementSkip: { status: "skipped", reason: "disabled" } },
            { type: "image", url: "/api/generation-log-assets/missing-result.png", enhancementId: "unbound-job" },
            { type: "image", url: "/api/generation-log-assets/native-only.png", resultId: "native-only" },
            { type: "video", url: "/api/generation-log-assets/video.mp4", resultId: "video-result", enhancementId: "video-job" },
        ] as StoredGenerationLog["assets"];
        mocks.readGenerationLogDb.mockResolvedValue({ version: 1, logs: [log] });
        expect((await listGenerationLogs(adminOptions)).items[0]?.assets[0]).toMatchObject({ enhancementSkip: { status: "skipped", reason: "disabled" } });
        expect(mocks.getEnhancementJob).not.toHaveBeenCalled();
        expect(mocks.listEnhancementJobsForTask).not.toHaveBeenCalled();
    });

    it("returns absent observations honestly and reads fresh facts after status changes without changing original results", async () => {
        mocks.getEnhancementJob.mockResolvedValue(null);
        expect((await listGenerationLogs(adminOptions)).items[0]?.assets[0]).not.toHaveProperty("enhancement");
        for (const status of ["queued", "running", "failed", "cancelled", "succeeded"] as const) {
            mocks.getEnhancementJob.mockResolvedValue({ ...fixtureJob(), status, events: [{ stage: status === "succeeded" ? "published" : `worker_${status}`, at: 3000, attempt: 2 }] });
            const log = (await listGenerationLogs(adminOptions)).items[0];
            expect(log).toMatchObject({ status: "success", successCount: 1, failCount: 0, assets: [{ url: "/api/generation-log-assets/native.png", enhancement: { status } }] });
        }
    });

    it("exposes actual published dimensions while suppressing nested private fields and arbitrary upstream stage/reason text", async () => {
        const job = fixtureJob();
        const ai = { width: 5016, height: 5016, format: "png" as const, byteLength: 5000, sha256: "d".repeat(64), url: "/api/generation-log-assets/ai.png", evidencePath: "private-native-evidence" };
        Object.assign(job, { status: "succeeded", phase: "receipt", reason: "private-upstream-error", publication: { ai, delivered: { ...ai, width: 4096, height: 4096, url: "/api/generation-log-assets/delivered.png" }, assetId: "asset-one", publishedAt: 3000 }, events: [{ stage: "private-worker-address", reason: "private-token", at: 2000, attempt: 2 }], timings: { workerQueueMs: 0, workerExecutionMs: 125.5, deliveryEncodingMs: -1, internal: "private-timing" } });
        mocks.getEnhancementJob.mockResolvedValue(job);
        const result = await listGenerationLogs(adminOptions);
        expect(result.items[0]?.assets[0]).toMatchObject({ enhancement: { native: { width: 1254, height: 1254 }, ai: { width: 5016, height: 5016 }, enhanced: { width: 4096, height: 4096 }, reason: "unknown", events: [{ stage: "unknown", reason: "unknown" }], timings: { workerQueueMs: 0, workerExecutionMs: 125.5 } } });
        expect(JSON.stringify(result)).not.toContain("private-");
    });
});
