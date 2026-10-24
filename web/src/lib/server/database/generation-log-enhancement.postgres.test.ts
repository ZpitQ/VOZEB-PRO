import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPostgresRepositories } from "./repositories";
import type { GenerationLogAssetRecord, GenerationLogRecord } from "./repository-shared";
import * as postgres from "./postgres";
import * as jobs from "./image-enhancement-job-repository";
import { listGenerationLogs } from "../generation-log-store";

const enabled = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
const ownerId = `generation-log-observation-owner-${randomUUID()}`;
const otherOwnerId = `generation-log-observation-other-${randomUUID()}`;
const userIds = [ownerId, otherOwnerId];
const nativeSource = { url: "/api/generation-log-assets/fixture-native.png", width: 1254, height: 1254, byteLength: 1200, sha256: "a".repeat(64), format: "png", hasAlpha: false, provenance: "provider_native" as const };
const skipReasons = ["disabled", "not_requested", "protected_contract", "unsupported_layers"] as const;

function job(overrides: Partial<jobs.ImageEnhancementJob> = {}): jobs.ImageEnhancementJob {
    const id = randomUUID();
    return {
        id, userId: ownerId, imageTaskId: "fixture-image-task", resultId: "fixture-native-result", status: "queued", phase: "prepare", reason: null, attempt: 1,
        decision: { status: "queued", reason: null, source: nativeSource, target: { width: 4096, height: 4096 }, inference: { width: 5016, height: 5016 }, connection: { revision: "private-revision", credentialRef: "private-credential", serviceId: "private-service", timeoutMs: 10000, model: { id: "fixture-model", binaryVersion: "binary-v2", binarySha256: "b".repeat(64), modelVersion: "model-v3", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 } } },
        remoteKey: "private-remote-key", receiptId: randomUUID(), events: [{ stage: "queued", at: 1000, attempt: 1 }], cancelRequested: false, createdAt: 1000, updatedAt: 1000, nextPollAt: 1000, workerId: null, leaseToken: null, leaseUntil: null,
        ...overrides,
    };
}

function log(assets: GenerationLogAssetRecord[], overrides: Partial<GenerationLogRecord> = {}): GenerationLogRecord {
    return {
        id: `fixture-generation-log-${randomUUID()}`, userId: ownerId, username: "fixture-owner", displayName: "Fixture", kind: "image", source: "image-workbench", status: "success", title: "Generation log enhancement fixture", prompt: "公开需求", model: "image-model", summary: "完成", durationMs: 1000, count: assets.length, successCount: assets.length, failCount: 0, taskId: "fixture-image-task", assets, createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:01.000Z", ...overrides,
    };
}

async function save(record: GenerationLogRecord) {
    return postgres.withPostgresTransaction((executor) => createPostgresRepositories(executor).generationLogs.upsert(record));
}

function adminRead() {
    return listGenerationLogs({ userId: ownerId, page: 1, pageSize: 20, includeImageEnhancement: true });
}

async function storedJobs() {
    return (await postgres.postgresQuery("SELECT id, payload FROM image_enhancement_jobs WHERE user_id = ANY($1::text[]) ORDER BY id", [userIds])).rows;
}

describe.skipIf(!enabled)("isolated PostgreSQL generation log enhancement observations", () => {
    let initialized = false;
    const fetchSpy = vi.fn();

    beforeAll(async () => {
        const target = new URL(process.env.DATABASE_URL || "");
        if (process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_m5_e2e")) throw new Error("An explicitly isolated M5 PostgreSQL fixture is required");
        await postgres.initializePostgresSchema();
        initialized = true;
        for (const id of userIds) await postgres.postgresQuery("INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, $1, 'Fixture', 'fixture-unusable-hash')", [id]);
    });

    beforeEach(async () => {
        await postgres.postgresQuery("DELETE FROM generation_logs WHERE user_id = ANY($1::text[])", [userIds]);
        await postgres.postgresQuery("DELETE FROM image_enhancement_jobs WHERE user_id = ANY($1::text[])", [userIds]);
        fetchSpy.mockReset();
        vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
        expect(fetchSpy).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    afterAll(async () => {
        if (!initialized) return;
        await postgres.postgresQuery("DELETE FROM image_enhancement_jobs WHERE user_id = ANY($1::text[])", [userIds]);
        await postgres.postgresQuery("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]);
    });

    it("round-trips a safe metadata column, all four no-job skips and distinct result IDs sharing one permanent URL", async () => {
        const first = await jobs.insertEnhancementJob(job());
        const second = await jobs.insertEnhancementJob(job({ resultId: "fixture-second-result" }));
        const assets = [
            { type: "image" as const, url: nativeSource.url, resultId: first.resultId, enhancementId: first.id, nativeSource: { ...nativeSource, evidencePath: "private-native-path" } },
            { type: "image" as const, url: nativeSource.url, resultId: second.resultId, enhancementId: second.id, nativeSource },
            ...skipReasons.map((reason) => ({ type: "image" as const, url: nativeSource.url, resultId: `skip-${reason}`, enhancementSkip: { status: "skipped" as const, reason, raw: "private-skip" } })),
        ];
        Object.assign(assets[0], { enhancement: { token: "private-stale-summary" } });
        const record = log(assets);
        const saved = await save(record);
        expect(JSON.stringify(saved)).not.toContain("private-");
        const metadata = (await postgres.postgresQuery("SELECT enhancement_metadata FROM generation_log_assets WHERE generation_log_id = $1 ORDER BY sort_order", [record.id])).rows.map((row) => row.enhancement_metadata);
        expect(metadata).toHaveLength(6);
        expect(metadata[0]).toEqual({ resultId: first.resultId, enhancementId: first.id, nativeSource });
        expect(metadata.slice(2)).toEqual(skipReasons.map((reason) => ({ resultId: `skip-${reason}`, enhancementSkip: { status: "skipped", reason } })));
        expect(JSON.stringify(metadata)).not.toContain("private-");
        const scoped = await createPostgresRepositories().generationLogs.list({ userId: ownerId, pageSize: 20 });
        expect(scoped.items[0]?.assets.slice(0, 2)).toMatchObject([{ url: nativeSource.url, resultId: first.resultId }, { url: nativeSource.url, resultId: second.resultId }]);

        const before = await storedJobs();
        const read = vi.spyOn(jobs, "getEnhancementJob");
        const result = await adminRead();
        expect(result.items[0]).toMatchObject({ status: "success", successCount: 6, failCount: 0, assets: [{ enhancement: { id: first.id, status: "queued", model: { id: "fixture-model", binaryVersion: "binary-v2", modelVersion: "model-v3" } } }, { enhancement: { id: second.id } }, ...skipReasons.map((reason) => ({ enhancementSkip: { status: "skipped", reason } }))] });
        expect(read.mock.calls).toEqual([[first.id, ownerId], [second.id, ownerId]]);
        expect(JSON.stringify(result)).not.toContain("private-");
        expect(await storedJobs()).toEqual(before);
    });

    it.each(["owner", "result", "task"] as const)("rejects a real stored job with the wrong %s binding", async (mismatch) => {
        const candidate = await jobs.insertEnhancementJob(job(mismatch === "owner" ? { userId: otherOwnerId } : mismatch === "result" ? { resultId: "foreign-result" } : { imageTaskId: "foreign-task" }));
        await save(log([{ type: "image", url: nativeSource.url, resultId: "fixture-native-result", enhancementId: candidate.id }]));
        expect((await adminRead()).items[0]?.assets[0]).not.toHaveProperty("enhancement");
    });

    it("binds each asset to its exact original slot and does not fall back to the first task when a slot is missing", async () => {
        const first = await jobs.insertEnhancementJob(job());
        const unbound = await jobs.insertEnhancementJob(job({ imageTaskId: "first-task", resultId: "unbound-result" }));
        await save(log([
            { type: "image", url: nativeSource.url, resultId: first.resultId, enhancementId: first.id },
            { type: "image", url: nativeSource.url, resultId: unbound.resultId, enhancementId: unbound.id },
        ], { taskId: "first-task", requestSnapshot: { version: 1, parameters: {}, references: [], slots: [{ id: "slot-original", index: 0, status: "success", assetIndex: 0, taskId: first.imageTaskId, serverTaskId: "unrelated-server-task" }] } }));
        const read = vi.spyOn(jobs, "getEnhancementJob");
        const result = await adminRead();
        expect(result.items[0]?.assets[0]).toHaveProperty("enhancement.id", first.id);
        expect(result.items[0]?.assets[1]).not.toHaveProperty("enhancement");
        expect(read.mock.calls).toEqual([[first.id, ownerId]]);
    });

    it("adds no job queries for skips, missing identities, video, or ordinary scoped reads", async () => {
        const first = await jobs.insertEnhancementJob(job());
        await save(log([
            ...skipReasons.map((reason) => ({ type: "image" as const, url: nativeSource.url, resultId: `skip-${reason}`, enhancementSkip: { status: "skipped" as const, reason } })),
            { type: "image", url: nativeSource.url, enhancementId: first.id },
            { type: "image", url: nativeSource.url, resultId: first.resultId },
            { type: "video", url: "/api/generation-log-assets/fixture.mp4", resultId: first.resultId, enhancementId: first.id },
        ]));
        const read = vi.spyOn(jobs, "getEnhancementJob");
        const query = vi.spyOn(postgres, "postgresQuery");
        await adminRead();
        await listGenerationLogs({ userId: ownerId, pageSize: 20 });
        expect(read).not.toHaveBeenCalled();
        expect(query.mock.calls.filter(([statement]) => statement.includes("image_enhancement_jobs"))).toEqual([]);
    });

    it("refreshes current job phase, measured timings and actual publication dimensions without rewriting either stored result", async () => {
        const candidate = await jobs.insertEnhancementJob(job());
        const record = log([{ type: "image", url: nativeSource.url, resultId: candidate.resultId, enhancementId: candidate.id, nativeSource }]);
        await save(record);
        expect((await adminRead()).items[0]?.assets[0]).toHaveProperty("enhancement.status", "queued");
        await jobs.mutateEnhancementJob(candidate.id, ownerId, (current) => ({ ...current, status: "running", phase: "poll", timings: { workerQueueMs: 0, workerExecutionMs: 125.5 }, events: [...current.events, { stage: "worker_running", at: 2000, attempt: 1 }] }));
        expect((await adminRead()).items[0]?.assets[0]).toMatchObject({ enhancement: { status: "running", phase: "poll", timings: { workerQueueMs: 0, workerExecutionMs: 125.5 } } });
        const ai = { url: "/api/generation-log-assets/fixture-ai.png", width: 5016, height: 5016, byteLength: 5000, sha256: "d".repeat(64), format: "png" as const };
        await jobs.mutateEnhancementJob(candidate.id, ownerId, (current) => ({ ...current, status: "succeeded", phase: "receipt", timings: { ...current.timings, deliveryEncodingMs: 2.75 }, publication: { ai, delivered: { ...ai, url: "/api/generation-log-assets/fixture-delivered.png", width: 4096, height: 4096 }, assetId: "fixture-child-asset", publishedAt: 3000 }, events: [...current.events, { stage: "published", at: 3000, attempt: 1 }] }));
        const beforeJobs = await storedJobs();
        const beforeLog = await createPostgresRepositories().generationLogs.getById(record.id);
        const result = await adminRead();
        expect(result.items[0]).toMatchObject({ status: "success", successCount: 1, failCount: 0, assets: [{ url: nativeSource.url, enhancement: { status: "succeeded", phase: "receipt", attempt: 1, native: { width: 1254, height: 1254 }, ai: { width: 5016, height: 5016 }, enhanced: { width: 4096, height: 4096 }, timings: { workerQueueMs: 0, workerExecutionMs: 125.5, deliveryEncodingMs: 2.75 } } }] });
        expect(await storedJobs()).toEqual(beforeJobs);
        expect(await createPostgresRepositories().generationLogs.getById(record.id)).toEqual(beforeLog);
    });
});
