import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), prepare: vi.fn(), submit: vi.fn(), query: vi.fn(), download: vi.fn(), acknowledge: vi.fn(), cancel: vi.fn(), close: vi.fn(), readSource: vi.fn(), store: vi.fn(), beforeWrite: vi.fn(), snapshotRequested: vi.fn(), enterLock: vi.fn() }));
vi.mock("./data-adapter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./data-adapter")>();
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const held = new AsyncLocalStorage<string[]>();
    const writeJsonDataFile: typeof actual.writeJsonDataFile = async (name, value) => {
        await mocks.beforeWrite(name, value);
        return actual.writeJsonDataFile(name, value);
    };
    const withJsonDataFileLock: typeof actual.withJsonDataFileLock = (name, callback, options) => {
        if (name === "generation-tasks.json") mocks.snapshotRequested();
        return actual.withJsonDataFileLock(name, async () => {
            const ancestors = held.getStore() || [];
            mocks.enterLock(name, ancestors);
            return held.run([...ancestors, name], callback);
        }, options);
    };
    return { ...actual, writeJsonDataFile, withJsonDataFileLock };
});
vi.mock("./image-enhancement-config", async (importOriginal) => ({ ...await importOriginal<typeof import("./image-enhancement-config")>(), resolveImageEnhancementConnection: mocks.resolve }));
vi.mock("./image-enhancement-worker-client", async (importOriginal) => ({ ...await importOriginal<typeof import("./image-enhancement-worker-client")>(), createEnhancementTaskClient: () => mocks }));
vi.mock("@/app/api/image-tasks/image-task-support", () => ({ imageReferenceToDataUrl: mocks.readSource }));
vi.mock("./maintenance-auth", async (importOriginal) => ({ ...await importOriginal<typeof import("./maintenance-auth")>(), maintenanceWorkerContext: () => "fixture-worker-context" }));
vi.mock("./generation-log-repository", async (importOriginal) => ({ ...await importOriginal<typeof import("./generation-log-repository")>(), writeAssetBytes: mocks.store }));

import { getEnhancementJob, listEnhancementJobsForTask, mutateEnhancementJob } from "./database/image-enhancement-job-repository";
import { createStoredGenerationTask, type StoredGenerationTaskRecord } from "./generation-task-store";
import { getImageTask, transitionImageTask, type ImageTask } from "./image-task-store";
import { enqueueImageEnhancement } from "./image-enhancement-enqueue";
import { runImageEnhancementBatch } from "./image-enhancement-service";
import { createCreativeConversation, listCreativeAssets, registerCreativeAssets } from "./creative-runtime-store";
import type { FrozenImageEnhancementPolicy } from "./image-enhancement-config";
import type { FrozenWorkerEnhancementPlan, RemoteEnhancementJob } from "./image-enhancement-worker-client";
import * as generationTasks from "./generation-task-store";

const policy: FrozenImageEnhancementPolicy = { revision: "policy-one", enabled: true, connection: { revision: "policy-one", credentialRef: "credential-fixture", serviceId: "31313131-3131-4131-8131-313131313131", timeoutMs: 60_000, model: { id: "model-fixture", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 } } };
function barrier() {
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { release = resolve; });
    return { reached, release };
}

describe("file enhancement completion visibility", () => {
    let directory: string;
    beforeEach(async () => {
        vi.resetAllMocks();
        directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-file-outbox-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("waits for native success before consuming its visible enhancement outbox intent", async () => {
        const userId = "enhancement-file-outbox-owner";
        const conversation = await createCreativeConversation(userId, { surface: "chat", title: "fixture" });
        const taskId = randomUUID();
        const id = `enhancement:${taskId}:1`;
        const source = await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } }).png().toBuffer();
        const ai = await sharp(source).resize(128, 128).png().toBuffer();
        const native = { url: "/api/generation-log-assets/native.png", sha256: createHash("sha256").update(source).digest("hex"), width: 32, height: 32, byteLength: source.length, format: "png", hasAlpha: false, provenance: "provider_native" as const };
        const media = { resultId: `${taskId}:1`, enhancementId: id, dataUrl: native.url, serverUrl: native.url, nativeSource: native, width: 32, height: 32, bytes: source.length, mimeType: "image/png" };
        const result = { ...media, results: [media] };
        const task = await createStoredGenerationTask<ImageTask>("image", { id: taskId, userId, username: "fixture", displayName: "fixture", kind: "generation", source: "image-workbench", conversationId: conversation.id, runId: "fixture-run", status: "running", createdAt: Date.now(), updatedAt: Date.now(), config: { baseUrl: "https://fixture.invalid", apiKey: "system", apiFormat: "openai", model: "fixture", quality: "4k", size: "64x64" }, prompt: "fixture", references: [], enhancementPolicy: structuredClone(policy) }, 60_000);
        const [original] = await registerCreativeAssets([{ userId, conversationId: conversation.id, sourceRunId: task.runId, sourceTaskId: task.id, ordinal: 0, type: "image", title: "native", storageKind: "local", serverUrl: native.url, width: 32, height: 32, mimeType: "image/png", bytes: source.length }]);
        const plan: FrozenWorkerEnhancementPlan = { protocolVersion: "image-enhancement.v1", scope: "full_image", target: { width: 64, height: 64, format: "png" }, normalizationProfile: "srgb-upright-v1", engine: { modelId: "model-fixture", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, tile: 0, tta: false, gpuId: 0 }, budgets: { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } }, sourceSha256: native.sha256, source: native, strategyFingerprint: "d".repeat(64), planFingerprint: "e".repeat(64) };
        let remote: RemoteEnhancementJob = { jobId: randomUUID(), status: "queued", reason: null, result: null, createdAt: Date.now(), completedAt: null };
        const stored = new Map<string, Buffer>();
        mocks.resolve.mockResolvedValue({ endpoint: "http://fixture.invalid", token: "fixture", serviceId: policy.connection!.serviceId, timeoutMs: 60_000, trust: "system", caPem: "" });
        mocks.prepare.mockResolvedValue(plan);
        mocks.submit.mockResolvedValue({ job: remote, replayed: false });
        mocks.query.mockImplementation(async () => remote);
        mocks.download.mockResolvedValue(ai);
        mocks.close.mockResolvedValue(undefined);
        mocks.acknowledge.mockImplementation(async () => {
            const published = await getEnhancementJob(id, userId);
            expect(published).toMatchObject({ status: "succeeded", phase: "receipt", publication: { assetId: expect.any(String) } });
            expect(await listCreativeAssets(conversation.id, userId)).toContainEqual(expect.objectContaining({ id: published!.publication!.assetId, parentAssetId: original.id }));
        });
        mocks.readSource.mockImplementation(async (reference: { dataUrl: string }) => `data:image/png;base64,${(stored.get(reference.dataUrl) || source).toString("base64")}`);
        mocks.store.mockImplementation(async (bytes: Buffer) => {
            const url = `/api/generation-log-assets/enhancement-${stored.size + 1}.png`;
            stored.set(url, bytes);
            const dimensions = await sharp(bytes).metadata();
            return { type: "image", url, serverUrl: url, width: dimensions.width, height: dimensions.height, bytes: bytes.length, mimeType: "image/png" };
        });

        const successWrite = barrier();
        const releaseSuccess = barrier();
        const snapshotRequested = barrier();
        mocks.beforeWrite.mockImplementation(async (name: string, value: unknown) => {
            if (name === "generation-tasks.json" && Array.isArray(value) && value.some((record: StoredGenerationTaskRecord) => record.id === task.id && record.status === "success")) {
                successWrite.release();
                await releaseSuccess.reached;
            }
        });
        const run = () => runImageEnhancementBatch({ origin: "http://fixture.local", workerId: "enhancement-file-outbox-fixture", limit: 50 });
        const job = () => getEnhancementJob(id, userId);
        const due = () => mutateEnhancementJob(id, userId, (row) => ({ ...row, nextPollAt: Date.now() }));
        let completion: ReturnType<typeof transitionImageTask> | undefined;
        let consuming: ReturnType<typeof runImageEnhancementBatch> | undefined;
        try {
            completion = transitionImageTask(task, ["running"], { status: "success", result });
            await Promise.race([successWrite.reached, completion.then(() => { throw new Error("Native completion did not reach the held success write"); })]);
            expect(await getImageTask(task.id)).toMatchObject({ status: "running" });
            expect((await getImageTask(task.id))?.result).toBeUndefined();
            const [intent] = await listEnhancementJobsForTask(task.id, userId);
            expect(intent).toMatchObject({ id, status: "queued", phase: "prepare", reason: null, resultId: media.resultId, decision: { source: native, connection: policy.connection } });

            const mutateFile = generationTasks.withGenerationTaskFileMutation;
            const observeMutation: typeof mutateFile = (mutator) => {
                mocks.snapshotRequested();
                return mutateFile(mutator);
            };
            vi.spyOn(generationTasks, "withGenerationTaskFileMutation").mockImplementation(observeMutation);
            mocks.snapshotRequested.mockImplementation(() => { snapshotRequested.release(); });
            consuming = run();
            // Observe the actual snapshot request, or an incorrect terminal batch, before releasing the producer.
            await Promise.race([snapshotRequested.reached, consuming]);
            const beforeRelease = await job();
            expect(beforeRelease?.status, "A visible outbox intent must wait for its original success write").toBe("queued");
            expect(beforeRelease).toMatchObject({ phase: "prepare", reason: null, nextPollAt: expect.any(Number), workerId: "enhancement-file-outbox-fixture", leaseToken: expect.any(String) });
            expect(mocks.prepare).not.toHaveBeenCalled();
            expect(mocks.submit).not.toHaveBeenCalled();
            expect((await getImageTask(task.id))?.status).toBe("running");

            releaseSuccess.release();
            const completed = await completion;
            expect(completed).toMatchObject({ id: task.id, status: "success", result });
            expect(await consuming).toEqual({ claimed: 1, completed: 0, failed: 0 });
            const prepared = await job();
            expect(prepared).toMatchObject({ id: intent.id, status: "running", phase: "submit", attempt: 1, remoteKey: intent.remoteKey, receiptId: intent.receiptId, decision: intent.decision, remotePlan: plan });
            await enqueueImageEnhancement(completed!);
            expect(await listEnhancementJobsForTask(task.id, userId)).toEqual([prepared]);

            await run();
            expect(await job()).toMatchObject({ phase: "poll", remoteJobId: remote.jobId, remoteKey: intent.remoteKey });
            remote = { ...remote, status: "succeeded", completedAt: Date.now(), result: { width: 128, height: 128, format: "png", byteLength: ai.length, sha256: createHash("sha256").update(ai).digest("hex") } };
            await due();
            await run();
            expect(await job()).toMatchObject({ phase: "download" });
            await due();
            await run();
            const published = await job();
            expect(published).toMatchObject({ status: "succeeded", phase: "receipt", publication: { ai: { width: 128, height: 128 }, delivered: { width: 64, height: 64 } } });
            expect(mocks.acknowledge).not.toHaveBeenCalled();
            await due();
            await run();
            expect(await listEnhancementJobsForTask(task.id, userId)).toEqual([expect.objectContaining({ id: intent.id, status: "succeeded", phase: "completed", reason: null, attempt: 1, remoteKey: intent.remoteKey, receiptId: intent.receiptId, decision: intent.decision, nextPollAt: null, receiptConfirmedAt: expect.any(Number) })]);
            expect(await getImageTask(task.id)).toMatchObject({ status: "success", result });
            const assets = await listCreativeAssets(conversation.id, userId);
            expect(assets).toHaveLength(2);
            expect(assets.find((asset) => asset.id === original.id)).toEqual(original);
            expect(assets.find((asset) => asset.id === published!.publication!.assetId)).toMatchObject({ parentAssetId: original.id, sourceTaskId: id, width: 64, height: 64 });
            expect(stored.get(published!.publication!.ai.url)?.equals(ai)).toBe(true);
            expect(await sharp(stored.get(published!.publication!.delivered.url)).metadata()).toMatchObject({ width: 64, height: 64 });
            expect(mocks.prepare).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledWith(plan, source, intent.remoteKey);
            expect(mocks.query).toHaveBeenCalledOnce();
            expect(mocks.query).toHaveBeenCalledWith(plan, remote.jobId);
            expect(mocks.acknowledge).toHaveBeenCalledOnce();
            expect(mocks.acknowledge).toHaveBeenCalledWith(plan, remote.jobId, intent.receiptId, remote.result);
            for (const [name, ancestors] of mocks.enterLock.mock.calls) {
                if (name === "generation-tasks.json") {
                    expect(ancestors).not.toContain("image-enhancement-jobs.json");
                    expect(ancestors).not.toContain("generation-tasks.json");
                }
            }
        } finally {
            releaseSuccess.release();
            await Promise.allSettled([completion, consuming].filter((pending) => pending !== undefined));
        }
    });
});
