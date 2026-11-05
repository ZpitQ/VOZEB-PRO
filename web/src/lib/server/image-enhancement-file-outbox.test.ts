import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    resolve: vi.fn(),
    prepare: vi.fn(),
    submit: vi.fn(),
    query: vi.fn(),
    download: vi.fn(),
    acknowledge: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
    readSource: vi.fn(),
    beforeWrite: vi.fn(),
}));
vi.mock("./data-adapter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./data-adapter")>();
    const writeJsonDataFile: typeof actual.writeJsonDataFile = async (name, value) => {
        await mocks.beforeWrite(name, value);
        return actual.writeJsonDataFile(name, value);
    };
    return { ...actual, writeJsonDataFile };
});
vi.mock("./image-enhancement-config", async (importOriginal) => ({ ...(await importOriginal<typeof import("./image-enhancement-config")>()), resolveImageEnhancementConnection: mocks.resolve }));
vi.mock("./image-enhancement-worker-client", async (importOriginal) => ({ ...(await importOriginal<typeof import("./image-enhancement-worker-client")>()), createEnhancementTaskClient: () => mocks }));
vi.mock("@/app/api/image-tasks/image-task-support", () => ({ imageReferenceToDataUrl: mocks.readSource }));
vi.mock("./maintenance-auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("./maintenance-auth")>()), maintenanceWorkerContext: () => "fixture-worker-context" }));

import { getEnhancementJob, listEnhancementJobsForTask } from "./database/image-enhancement-job-repository";
import { createStoredGenerationTask, type StoredGenerationTaskRecord } from "./generation-task-store";
import { getImageTask, transitionImageTask, type ImageTask } from "./image-task-store";
import { enqueueImageEnhancement } from "./image-enhancement-enqueue";
import { runImageEnhancementBatch } from "./image-enhancement-service";
import { createCreativeConversation, listCreativeAssets, registerCreativeAssets } from "./creative-runtime-store";
import type { FrozenImageEnhancementPolicy } from "./image-enhancement-config";
import type { FrozenWorkerEnhancementPlan, RemoteEnhancementJob } from "./image-enhancement-worker-client";
import * as generationTasks from "./generation-task-store";

const policy: FrozenImageEnhancementPolicy = {
    revision: "policy-one",
    enabled: true,
    connection: {
        revision: "policy-one",
        credentialRef: "credential-fixture",
        serviceId: "31313131-3131-4131-8131-313131313131",
        timeoutMs: 60_000,
        model: { id: "model-fixture", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 },
    },
};
function barrier() {
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
        release = resolve;
    });
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
        const source = await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        const native = { url: "/api/generation-log-assets/native.png", sha256: createHash("sha256").update(source).digest("hex"), width: 32, height: 32, byteLength: source.length, format: "png", hasAlpha: false, provenance: "provider_native" as const };
        const media = { resultId: `${taskId}:1`, enhancementId: id, dataUrl: native.url, serverUrl: native.url, nativeSource: native, width: 32, height: 32, bytes: source.length, mimeType: "image/png" };
        const result = { ...media, results: [media] };
        const task = await createStoredGenerationTask<ImageTask>(
            "image",
            {
                id: taskId,
                userId,
                username: "fixture",
                displayName: "fixture",
                kind: "generation",
                source: "image-workbench",
                conversationId: conversation.id,
                runId: "fixture-run",
                status: "running",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                config: { baseUrl: "https://fixture.invalid", apiKey: "system", apiFormat: "openai", model: "fixture", quality: "4k", size: "64x64" },
                prompt: "fixture",
                references: [],
                enhancementPolicy: structuredClone(policy),
            },
            60_000,
        );
        const [original] = await registerCreativeAssets([
            {
                userId,
                conversationId: conversation.id,
                sourceRunId: task.runId,
                sourceTaskId: task.id,
                ordinal: 0,
                type: "image",
                title: "native",
                storageKind: "local",
                serverUrl: native.url,
                width: 32,
                height: 32,
                mimeType: "image/png",
                bytes: source.length,
            },
        ]);
        const plan: FrozenWorkerEnhancementPlan = {
            protocolVersion: "image-enhancement.v1",
            scope: "full_image",
            target: { width: 64, height: 64, format: "png" },
            normalizationProfile: "srgb-upright-v1",
            engine: { modelId: "model-fixture", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, tile: 0, tta: false, gpuId: 0 },
            budgets: { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } },
            sourceSha256: native.sha256,
            source: native,
            strategyFingerprint: "d".repeat(64),
            planFingerprint: "e".repeat(64),
        };
        const remote: RemoteEnhancementJob = { jobId: randomUUID(), status: "queued", reason: null, result: null, createdAt: Date.now(), completedAt: null };
        mocks.resolve.mockResolvedValue({ endpoint: "http://fixture.invalid", token: "fixture", serviceId: policy.connection!.serviceId, timeoutMs: 60_000, trust: "system", caPem: "" });
        mocks.prepare.mockResolvedValue(plan);
        mocks.submit.mockResolvedValue({ job: remote, replayed: false });
        mocks.close.mockResolvedValue(undefined);
        mocks.readSource.mockResolvedValue("data:image/png;base64," + source.toString("base64"));

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
        let completion: ReturnType<typeof transitionImageTask> | undefined;
        let consuming: ReturnType<typeof runImageEnhancementBatch> | undefined;
        try {
            completion = transitionImageTask(task, ["running"], { status: "success", result });
            await Promise.race([
                successWrite.reached,
                completion.then(() => {
                    throw new Error("Native completion did not reach the held success write");
                }),
            ]);
            expect(await getImageTask(task.id)).toMatchObject({ status: "running" });
            expect((await getImageTask(task.id))?.result).toBeUndefined();
            const [intent] = await listEnhancementJobsForTask(task.id, userId);
            expect(intent).toMatchObject({ id, status: "queued", phase: "prepare", reason: null, resultId: media.resultId, decision: { source: native, connection: policy.connection } });

            const readFile = generationTasks.withGenerationTaskFileRead;
            const observeRead: typeof readFile = (read) => {
                const pending = readFile(read);
                snapshotRequested.release();
                return pending;
            };
            vi.spyOn(generationTasks, "withGenerationTaskFileRead").mockImplementation(observeRead);
            consuming = run();
            // The read is queued behind the held native write before it can acquire the file lock.
            await Promise.race([snapshotRequested.reached, consuming]);
            const beforeRelease = await job();
            expect(beforeRelease?.status, "A visible outbox intent must wait for its original success write").toBe("queued");
            expect(beforeRelease).toStrictEqual(intent);
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
            expect(await listEnhancementJobsForTask(task.id, userId)).toEqual([
                expect.objectContaining({
                    id: intent.id,
                    status: "running",
                    phase: "poll",
                    reason: null,
                    attempt: 1,
                    remoteKey: intent.remoteKey,
                    receiptId: intent.receiptId,
                    decision: intent.decision,
                    remoteJobId: remote.jobId,
                }),
            ]);
            expect(await getImageTask(task.id)).toMatchObject({ status: "success", result });
            expect(await listCreativeAssets(conversation.id, userId)).toEqual([original]);
            expect(mocks.prepare).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledOnce();
            expect(mocks.submit).toHaveBeenCalledWith(plan, source, intent.remoteKey);
            expect(mocks.query).not.toHaveBeenCalled();
            expect(mocks.download).not.toHaveBeenCalled();
            expect(mocks.acknowledge).not.toHaveBeenCalled();
        } finally {
            releaseSuccess.release();
            await Promise.allSettled([completion, consuming].filter((pending) => pending !== undefined));
        }
    });
});
