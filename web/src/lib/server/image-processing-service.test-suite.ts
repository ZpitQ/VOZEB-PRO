import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageProcessingOperation, ImageProcessingOutcome, ImageProcessingProtectionOptions } from "@/lib/image-processing/contracts";
import type { AgentRun } from "./agent-run-store";
import type { StoredGenerationTaskRecord } from "./generation-task-types";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { LocalMediaRegistration } from "./local-media-registry";
import type { ImageProcessingProcessInput, ImageProcessingProcessResult, ImageProcessingProcessStage } from "./image-processing-process-fixture.test";
import type { ClosedImageProcessingFailure, CompleteImageProcessingInput, EnqueueImageProcessingInput, FailImageProcessingInput, ImageProcessingManifest, ImageProcessingTask, StoredImageProcessingArtifact } from "./image-processing-service";
import { imageProcessingS3Fixture, imageProcessingStreamBytes } from "./image-processing-s3-fixture";

// The same cases use real file storage or the explicitly selected isolated PG database.
export function imageProcessingEnqueueSuite(provider: "file" | "postgres") {
    const enabled = provider === "file" || process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1";
    (enabled ? describe : describe.skip)(`${provider} image processing enqueue`, () => {
        let directory: string;
        let userId: string;
        let otherUserId: string;
        let source: Buffer;
        let highDepthSource: Buffer;
        let run: AgentRun;
        let input: EnqueueImageProcessingInput;
        let database: typeof import("./database");
        let runtime: typeof import("./creative-runtime-store");
        let tasks: typeof import("./generation-task-store");
        let scheduler: typeof import("./generation-task-scheduler");
        let service: typeof import("./image-processing-service");

        beforeAll(async () => {
            if (provider === "postgres" && (process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" || process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || !process.env.DATABASE_URL))
                throw new Error("Explicit isolated PostgreSQL fixture authorization is required");
            directory = await mkdtemp(path.join(tmpdir(), "vozeb-image-processing-enqueue-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
            vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
            [database, runtime, tasks, scheduler, service] = await Promise.all([import("./database"), import("./creative-runtime-store"), import("./generation-task-store"), import("./generation-task-scheduler"), import("./image-processing-service")]);
            if (provider === "postgres") await database.initializePostgresSchema();
            const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
            if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated enqueue fixture requires local media storage");
            userId = `fixture-image-processing-${randomUUID()}`;
            otherUserId = `fixture-image-processing-${randomUUID()}`;
            if (provider === "postgres") {
                const repositories = database.createPostgresRepositories();
                const settings = await repositories.settings.getSettings();
                const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
                if (!planId) throw new Error("Fixture entitlement plan missing");
                for (const id of [userId, otherUserId])
                    await repositories.users.createWithNextAccountId({
                        id,
                        username: `fixture_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
                        displayName: "Isolated image processing fixture",
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
            source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#8a6243" } })
                .png()
                .toBuffer();
            highDepthSource = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#8a6243" } })
                .toColourspace("rgb16")
                .png()
                .toBuffer();
            expect((await sharp(highDepthSource).metadata()).depth).toBe("ushort");
        }, 30_000);

        async function seedReference(ownerId: string, bytes = source) {
            const conversation = await runtime.createCreativeConversation(ownerId, { surface: "chat" });
            const { writeReferenceImageDataUrl } = await import("./reference-asset-store");
            const stored = await writeReferenceImageDataUrl(`data:image/png;base64,${bytes.toString("base64")}`, { ownerUserId: ownerId, conversationId: conversation.id, source: "fixture-image-processing" });
            const [asset] = await runtime.registerCreativeAssets([
                {
                    id: `fixture-reference-${randomUUID()}`,
                    userId: ownerId,
                    conversationId: conversation.id,
                    ordinal: 0,
                    type: "image",
                    title: "reference.png",
                    sourceRunId: `fixture-upload-${randomUUID()}`,
                    serverUrl: `/api/reference-assets/${stored.token}`,
                    metadata: {},
                },
            ]);
            const now = Date.now();
            const parentExecutionId = randomUUID();
            const seededRun: AgentRun = {
                id: `agent-fixture-${randomUUID()}`,
                userId: ownerId,
                conversationId: conversation.id,
                clientRequestId: randomUUID(),
                surface: "chat",
                inputMessageId: `message-${randomUUID()}`,
                assistantMessageId: `message-${randomUUID()}`,
                prompt: "Prepare the registered reference",
                referencedAssetIds: [asset.id],
                assetIds: [],
                status: "running",
                executionId: parentExecutionId,
                tasks: [],
                reviewed: false,
                createdAt: now,
                updatedAt: now,
            };
            const { buildEcommercePlanningInput } = await import("./ecommerce-generation-snapshot");
            const { createEcommerceReferenceCheckpoint } = await import("./ecommerce-reference-recovery");
            const planningInput = buildEcommercePlanningInput(seededRun, [asset], { summary: "", recentMessages: [] });
            const checkpoint = createEcommerceReferenceCheckpoint(seededRun, planningInput, [asset]);
            seededRun.ecommerceSnapshot = {
                version: "ecommerce-generation.v1",
                mode: "active",
                input: { userRequest: seededRun.prompt, assetIds: [asset.id], conversationId: conversation.id, surface: "chat" },
                referenceCheckpoint: checkpoint,
                createdAt: now,
                runId: seededRun.id,
                userId: ownerId,
            };
            await runtime.createCreativeRunBundle(ownerId, { run: seededRun, conversationId: conversation.id, title: "Image processing fixture", prompt: seededRun.prompt, assetIds: [asset.id], ttlMs: 60_000 });
            await scheduler.scheduleGenerationTask("agent", seededRun.id, { executionPhase: "created", nextPollAt: now });
            const claimed = await scheduler.claimDueGenerationTasks({ workerId: "fixture-parent-worker", taskIds: [seededRun.id], limit: 1 });
            expect(claimed.map((task) => task.id)).toEqual([seededRun.id]);
            const seededInput: EnqueueImageProcessingInput = {
                runId: seededRun.id,
                parentExecutionId,
                algorithmVersion: "reference-input-policy.v1",
                operation: "prepare_reference",
                inputs: [{ assetId: asset.id, assetVersion: checkpoint.assets[0].assetVersion }],
                options: {},
            };
            return { run: seededRun, input: seededInput, storageKey: stored.token };
        }

        beforeEach(async () => {
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
            ({ run, input } = await seedReference(userId));
        });

        afterAll(async () => {
            try {
                if (provider === "postgres" && userId) await database.postgresQuery("DELETE FROM users WHERE id = ANY($1::text[])", [[userId, otherUserId]]);
            } finally {
                vi.unstubAllEnvs();
                if (directory) await rm(directory, { recursive: true, force: true });
            }
        });

        it("persists the child and the parent's waiting dependency while releasing the parent's old execution", async () => {
            const child = await service.enqueueImageProcessingTask(input);
            const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
            const persisted = await tasks.getStoredGenerationTaskRecord("image_processing", child.id);

            expect(child.id).toMatch(/^image-process-[a-f0-9]{64}$/);
            expect(child.id).toBe(`image-process-${child.payload.inputDigest}`);
            expect(persisted).toMatchObject({
                id: child.id,
                type: "image_processing",
                userId,
                runId: run.id,
                status: "pending",
                executionPhase: "created",
                attemptNo: 0,
                clientRequestId: child.payload.inputDigest,
                payload: {
                    version: "image-processing.v1",
                    operation: "prepare_reference",
                    algorithmVersion: "reference-input-policy.v1",
                    inputs: [{ ...input.inputs[0], expectedSha256: createHash("sha256").update(source).digest("hex") }],
                    resource: {
                        requiredMemoryBytes: 405 * 1024 * 1024,
                        facts: {
                            encodedInputs: [
                                {
                                    inputIndex: 0,
                                    assetId: input.inputs[0].assetId,
                                    assetVersion: input.inputs[0].assetVersion,
                                    bytes: source.length,
                                    sha256: createHash("sha256").update(source).digest("hex"),
                                    layout: { format: "png", depth: "uchar", channels: 3 },
                                },
                            ],
                            decodedInputs: [],
                        },
                    },
                },
            });
            expect(parent).toMatchObject({ payload: { status: "running", ecommerceSnapshot: { processing: { version: "image-processing-checkpoint.v1", waitingFor: { jobId: child.id, inputDigest: child.payload.inputDigest } } } } });
            expect(parent?.payload.executionId).toBeUndefined();
            expect(parent?.nextPollAt).toBeUndefined();
            expect(parent?.workerId).toBeUndefined();
            expect(parent?.leaseUntil).toBeUndefined();
            expect(persisted?.nextPollAt).toBeTypeOf("number");
            expect(persisted?.workerId).toBeUndefined();
            expect(persisted?.leaseUntil).toBeUndefined();
            expect(persisted?.estimatedPoints).toBeUndefined();
        });

        it("rejects a stale parent execution without creating a child or changing the current parent", async () => {
            const before = await tasks.getStoredGenerationTaskRecord("agent", run.id);
            await expect(service.enqueueImageProcessingTask({ ...input, parentExecutionId: "stale-parent-execution" })).rejects.toMatchObject({ status: 409 });
            expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(before);
            expect(await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).toEqual([]);
        });

        it("replays the initial prepare request read only after the parent yields without collecting the original again", async () => {
            const original = await service.enqueueImageProcessingTask(input);
            const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
            const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", original.id);
            const beforeEvents = await runtime.listCreativeRunEvents(run.id);
            const beforeMessages = await runtime.listCreativeMessages(run.conversationId);
            const { readReferenceAsset } = await import("./reference-asset-store");
            const registered = await readReferenceAsset(original.payload.sources[0].storageKey);
            assert(registered);
            const unavailablePath = `${registered.filePath}.replay-fixture-unavailable`;
            await rename(registered.filePath, unavailablePath);
            try {
                const replay = await service.enqueueImageProcessingTask(input);

                expect(replay).toEqual(original);
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", original.id)).toEqual(beforeChild);
                expect((await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).map((task) => task.id)).toEqual([original.id]);
                expect(await runtime.listCreativeRunEvents(run.id)).toEqual(beforeEvents);
                expect(await runtime.listCreativeMessages(run.conversationId)).toEqual(beforeMessages);
            } finally {
                await rename(unavailablePath, registered.filePath);
            }
        });

        it("replays the initial prepare request with its resolved hash while retaining the original job digest and input version", async () => {
            const original = await service.enqueueImageProcessingTask(input);
            const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
            const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", original.id);
            const replay = await service.enqueueImageProcessingTask({ ...input, inputs: [{ ...input.inputs[0], expectedSha256: createHash("sha256").update(source).digest("hex") }] });

            expect(replay.id).toBe(original.id);
            expect(replay.payload.inputDigest).toBe(original.payload.inputDigest);
            expect(replay.payload.inputs[0].assetVersion).toBe(input.inputs[0].assetVersion);
            expect(replay.payload.inputs[0].expectedSha256).toBe(original.payload.inputs[0].expectedSha256);
            expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", original.id)).toEqual(beforeChild);
            expect((await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).map((task) => task.id)).toEqual([original.id]);
        });

        it.each([
            {
                state: "a newer dependency",
                update: (current: AgentRun): AgentRun => {
                    const snapshot = current.ecommerceSnapshot;
                    assert(snapshot?.processing);
                    return { ...current, executionId: "new-parent-execution", ecommerceSnapshot: { ...snapshot, processing: { ...snapshot.processing, waitingFor: { jobId: "new-stage", inputDigest: "new-stage-digest" } } } };
                },
            },
            { state: "cancellation", update: (current: AgentRun): AgentRun => ({ ...current, status: "cancelled", executionId: undefined, cancellation: { requestedAt: Date.now(), pendingChildTaskIds: [] } }) },
        ])("replays the initial prepare request read only when the parent already has $state", async ({ update }) => {
            const original = await service.enqueueImageProcessingTask(input);
            await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, update);
            const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
            const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", original.id);

            expect(await service.enqueueImageProcessingTask(input)).toEqual(original);
            expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", original.id)).toEqual(beforeChild);
            expect((await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).map((task) => task.id)).toEqual([original.id]);
        });

        it("rejects a prepare replay carrying a different content hash without changing either persisted record", async () => {
            const original = await service.enqueueImageProcessingTask(input);
            const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
            const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", original.id);

            await expect(service.enqueueImageProcessingTask({ ...input, inputs: [{ ...input.inputs[0], expectedSha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }] })).rejects.toMatchObject({ status: 409 });
            expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
            expect(await tasks.getStoredGenerationTaskRecord("image_processing", original.id)).toEqual(beforeChild);
            expect((await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).map((task) => task.id)).toEqual([original.id]);
        });

        it("atomically pauses the parent and child when the prepare requirement exceeds the configured total budget", async () => {
            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "128");
            const child = await service.enqueueImageProcessingTask(input);
            const persisted = await tasks.getStoredGenerationTaskRecord("image_processing", child.id);
            const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);

            expect(persisted).toMatchObject({
                status: "paused",
                executionPhase: "needs_review",
                lastUpstreamStatus: "image_processing_resource_unavailable",
                payload: {
                    resource: {
                        requiredMemoryBytes: 405 * 1024 * 1024,
                        configuration: { budgetBytes: 128 * 1024 * 1024, workerMemoryBytes: 1536 * 1024 * 1024 },
                        unavailable: { code: "image_processing_resource_unavailable", reason: "exceeds_total_budget" },
                    },
                },
            });
            expect(parent).toMatchObject({
                status: "paused",
                executionPhase: "needs_review",
                lastUpstreamStatus: "image_processing_resource_unavailable",
                payload: { status: "paused", ecommerceSnapshot: { processing: { waitingFor: { jobId: child.id, inputDigest: child.payload.inputDigest } } } },
            });
            expect(parent?.payload.executionId).toBeUndefined();
            expect(parent?.workerId).toBeUndefined();
            expect(parent?.leaseUntil).toBeUndefined();
            expect(parent?.nextPollAt).toBeUndefined();
            expect(persisted?.workerId).toBeUndefined();
            expect(persisted?.leaseUntil).toBeUndefined();
            expect(persisted?.nextPollAt).toBeUndefined();
        });

        it("keeps due internal image processing records out of the existing network claim", async () => {
            const now = Date.now();
            const id = `image-process-fixture-${randomUUID()}`;
            await tasks.createStoredGenerationTask("image_processing", { id, userId, runId: run.id, status: "pending", createdAt: now, updatedAt: now }, 60_000);
            await scheduler.scheduleGenerationTask("image_processing", id, { executionPhase: "created", nextPollAt: now });

            expect(await tasks.getStoredGenerationTaskRecord("image_processing", id)).toMatchObject({ id, type: "image_processing", status: "pending" });
            expect(await scheduler.claimDueGenerationTasks({ workerId: "fixture-network-worker", taskIds: [id], limit: 1 })).toEqual([]);
            const current = await tasks.getStoredGenerationTaskRecord("image_processing", id);
            expect(current?.workerId).toBeUndefined();
            expect(current?.leaseUntil).toBeUndefined();
        });

        type FailureFixture = { task: ImageProcessingTask; identity: { workerId: string; executionId: string }; artifact: StoredImageProcessingArtifact; completion: CompleteImageProcessingInput };

        async function removePauseProjection() {
            if (provider === "postgres") {
                await database.withPostgresTransaction(async (executor) => {
                    await executor.query("DELETE FROM creative_run_events WHERE run_id = $1 AND type = 'run.paused'", [run.id]);
                    await executor.query("UPDATE creative_messages SET content = 'stale planning' WHERE id = $1", [run.assistantMessageId]);
                });
            } else {
                const repository = await import("./creative-runtime-repository");
                const db = await repository.readRuntimeFile();
                await repository.writeRuntimeFile({
                    ...db,
                    events: db.events.filter((event) => event.runId !== run.id || event.type !== "run.paused"),
                    messages: db.messages.map((message) => (message.id === run.assistantMessageId ? { ...message, content: "stale planning" } : message)),
                });
            }
        }

        function failureCases(operation: "prepare_reference" | "build_protection", fixture: () => Promise<FailureFixture>) {
            describe(`${operation} closed failure registration`, () => {
                const workerToken = "fixture-image-worker-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                let failRoute: typeof import("@/app/api/maintenance/image-processing/[id]/fail/route");

                beforeAll(async () => {
                    failRoute = await import("@/app/api/maintenance/image-processing/[id]/fail/route");
                });

                beforeEach(() => {
                    vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
                    vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-maintenance-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
                });

                function postFail(task: ImageProcessingTask, body: unknown, authorization = `Bearer ${workerToken}`) {
                    return failRoute.POST(new Request(`http://localhost/api/maintenance/image-processing/${task.id}/fail`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) }), {
                        params: Promise.resolve({ id: task.id }),
                    });
                }

                async function truthRows(task: ImageProcessingTask) {
                    if (provider === "postgres") {
                        const result = await database.postgresQuery<{ record: Record<string, unknown> }>("SELECT to_jsonb(task) AS record FROM generation_tasks AS task WHERE id = ANY($1::text[]) ORDER BY id", [[run.id, task.id]]);
                        return result.rows.map((row) => row.record);
                    }
                    return [await tasks.getStoredGenerationTaskRecord("agent", run.id), await tasks.getStoredGenerationTaskRecord("image_processing", task.id)];
                }

                function rejectedReport(current: FailureFixture): Extract<ClosedImageProcessingFailure, { status: "rejected" }> {
                    return {
                        status: "rejected",
                        jobId: current.task.id,
                        executionId: current.identity.executionId,
                        pid: 4321,
                        exitCode: 0,
                        signal: null,
                        stderr: "controlled Worker report: /fixture/private/child.stderr",
                        error: { code: "fixture_closed_rejection", message: "controlled Worker report: /fixture/private/input.png" },
                    };
                }

                function failureInput(current: FailureFixture): FailImageProcessingInput {
                    return { ...current.identity, failure: rejectedReport(current) };
                }

                async function actualHashRejection(current: FailureFixture): Promise<Extract<ClosedImageProcessingFailure, { status: "rejected" }>> {
                    const original = await service.readImageProcessingInput(current.task.id, current.task.payload.inputs[0].assetId, current.identity);
                    const bytes = await imageProcessingStreamBytes(original.stream);
                    expect(createHash("sha256").update(bytes).digest("hex")).toBe(current.task.payload.inputs[0].expectedSha256);
                    const taskDirectory = await mkdtemp(path.join(directory, "fail-child-"));
                    try {
                        const filename = path.join(taskDirectory, "downloaded.png");
                        await writeFile(filename, Buffer.concat([Buffer.from([0]), bytes.subarray(1)]));
                        const outputDirectory = await mkdtemp(path.join(taskDirectory, "output-"));
                        const payload = current.task.payload;
                        assert(payload.operation === "prepare_reference" || payload.operation === "build_protection");
                        const requestOperation: ImageProcessingOperation = payload.operation === "prepare_reference" ? { operation: "prepare_reference", options: {} } : { operation: "build_protection", options: payload.options };
                        const outcome = await runImageProcessing(
                            { ...requestOperation, version: "image-processing.v1", jobId: current.task.id, executionId: current.identity.executionId, inputs: [{ ...payload.inputs[0], path: filename }], outputDirectory },
                            { taskDirectory, maxHeapMiB: payload.resource.configuration.processHeapMb },
                        );
                        console.info("Image processing fail real child", { provider, operation, status: outcome.status, jobId: outcome.jobId, executionId: outcome.executionId, pid: outcome.pid, exitCode: outcome.exitCode, signal: outcome.signal });
                        expect(outcome).toMatchObject({ status: "rejected", jobId: current.task.id, executionId: current.identity.executionId, error: { code: "source_hash_mismatch" }, exitCode: 0, signal: null });
                        assert(outcome.status === "rejected");
                        const pid = outcome.pid;
                        assert.ok(pid);
                        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
                        const stillOriginal = await service.readImageProcessingInput(current.task.id, payload.inputs[0].assetId, current.identity);
                        expect(await imageProcessingStreamBytes(stillOriginal.stream)).toEqual(bytes);
                        return outcome;
                    } finally {
                        await rm(taskDirectory, { recursive: true, force: true });
                    }
                }

                it("records an actual closed source-hash rejection and pauses only its waiting parent through the fail Route", async () => {
                    const current = await fixture();
                    const childBefore = await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id);
                    const parentBefore = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                    assert(childBefore && parentBefore);
                    const failure = await actualHashRejection(current);

                    const response = await postFail(current.task, { ...current.identity, failure });

                    expect(response.status).toBe(200);
                    await expect(response.json()).resolves.toEqual({ code: 0, data: { jobId: current.task.id, status: "error", executionPhase: "needs_review" }, msg: "OK" });
                    const child = await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id);
                    const parent = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                    expect(child).toMatchObject({ status: "error", executionPhase: "needs_review" });
                    expect(child?.workerId).toBeUndefined();
                    expect(child?.leaseUntil).toBeUndefined();
                    expect(child?.lastHeartbeatAt).toBeUndefined();
                    expect(child?.nextPollAt).toBeUndefined();
                    expect(child?.payload).toEqual(childBefore.payload);
                    expect(child?.resultPayload).toMatchObject({ workerId: current.identity.workerId, executionId: current.identity.executionId, failure, artifacts: [current.artifact] });
                    expect(parent).toMatchObject({ status: "paused", executionPhase: "needs_review" });
                    expect(parent?.executionId).toBeUndefined();
                    expect(parent?.ecommerceSnapshot).toEqual(parentBefore.ecommerceSnapshot);
                    expect(parent?.tasks).toEqual(parentBefore.tasks);
                    expect(parent?.failure).toEqual(expect.stringMatching(/[\u4e00-\u9fff]/));
                    const parentRecord = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                    expect(parentRecord).toMatchObject({ status: "paused" });
                    expect(parentRecord?.workerId).toBeUndefined();
                    expect(parentRecord?.leaseUntil).toBeUndefined();
                    expect(parentRecord?.lastHeartbeatAt).toBeUndefined();
                    expect(parentRecord?.nextPollAt).toBeUndefined();
                }, 30_000);

                it("pauses a reported V8 resource failure while preserving frozen resources, staged artifacts and private exit evidence", async () => {
                    const current = await fixture();
                    const childBefore = await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id);
                    const parentBefore = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                    assert(childBefore && parentBefore);
                    // This controlled Worker report proves service mapping only, not a real OOM.
                    const failure: ClosedImageProcessingFailure = {
                        status: "resource_failure",
                        jobId: current.task.id,
                        executionId: current.identity.executionId,
                        pid: 4321,
                        exitCode: 134,
                        signal: null,
                        stderr: "controlled Worker report: FATAL ERROR: Reached heap limit /fixture/private/child.stderr",
                        reason: "v8_heap_oom",
                    };

                    await expect(service.failImageProcessingTask(current.task.id, { ...current.identity, failure })).resolves.toEqual({ jobId: current.task.id, status: "paused", executionPhase: "needs_review" });

                    const child = await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id);
                    const parent = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                    expect(child).toMatchObject({ status: "paused", executionPhase: "needs_review" });
                    expect(child?.nextPollAt).toBeUndefined();
                    expect(child?.workerId).toBeUndefined();
                    expect(child?.leaseUntil).toBeUndefined();
                    expect(child?.lastHeartbeatAt).toBeUndefined();
                    expect(child?.payload).toEqual(childBefore.payload);
                    expect(child?.resultPayload).toMatchObject({ workerId: current.identity.workerId, executionId: current.identity.executionId, failure, artifacts: [current.artifact] });
                    expect(parent).toMatchObject({ status: "paused", executionPhase: "needs_review" });
                    expect(parent?.executionId).toBeUndefined();
                    expect(parent?.ecommerceSnapshot).toEqual(parentBefore.ecommerceSnapshot);
                    expect(parent?.failure).toEqual(expect.stringMatching(/[\u4e00-\u9fff]/));
                    expect(parent?.failure).not.toContain("/fixture/private");
                    expect(parent?.failure).not.toContain("v8_heap_oom");
                });

                if (provider === "postgres") {
                    it("resumes the original resource-paused stage with the startup pool maximum one", async () => {
                        expect(process.env.VOZEB_PRO_DATABASE_POOL_MAX).toBe("1");
                        const previousHeap = process.env.VOZEB_PRO_IMAGE_PROCESS_HEAP_MB;
                        expect(previousHeap).toBe("384");
                        try {
                            const current = await fixture();
                            const childBefore = await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id);
                            const parentBefore = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                            assert(childBefore && parentBefore);
                            const { readReferenceAsset } = await import("./reference-asset-store");
                            const original = await readReferenceAsset(current.task.payload.sources[0].storageKey);
                            assert(original);
                            const originalBytes = await readFile(original.filePath);
                            expect(createHash("sha256").update(originalBytes).digest("hex")).toBe(current.task.payload.inputs[0].expectedSha256);
                            const mediaKeys = [current.task.payload.sources[0].storageKey, current.artifact.storageKey];
                            const mediaBefore = await database.postgresQuery<{ record: Record<string, unknown> }>(
                                "SELECT to_jsonb(asset) AS record FROM local_media_assets AS asset WHERE owner_user_id = $1 AND storage_key = ANY($2::text[]) ORDER BY storage_key",
                                [userId, mediaKeys],
                            );
                            expect(mediaBefore.rows).toHaveLength(2);
                            // Closed failure is controlled; the shared staged-media fixture is not a supervisor OOM.
                            const failure: ClosedImageProcessingFailure = {
                                status: "resource_failure",
                                reason: "v8_heap_oom",
                                jobId: current.task.id,
                                executionId: current.identity.executionId,
                                pid: 4341,
                                exitCode: 134,
                                signal: null,
                                stderr: "controlled PG owner report: FATAL ERROR: Reached heap limit",
                            };
                            const failed = await postFail(current.task, { ...current.identity, failure });
                            expect(failed.status).toBe(200);
                            expect(await failed.json()).toMatchObject({ code: 0, data: { jobId: current.task.id, status: "paused", executionPhase: "needs_review" } });
                            const paused = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                            assert(paused);
                            expect(paused).toMatchObject({ id: run.id, status: "paused", ecommerceSnapshot: parentBefore.ecommerceSnapshot });
                            expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id)).toMatchObject({ status: "paused", executionPhase: "needs_review", payload: childBefore.payload });
                            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "512");
                            const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
                            const configured = imageProcessingResourceConfig(process.env);
                            expect(configured.profileVersion).not.toBe(current.task.payload.resource.profileVersion);

                            const resumed = await service.resumeImageProcessingTaskForRun(paused);
                            expect(resumed).toMatchObject({ id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId, status: "running", ecommerceSnapshot: paused.ecommerceSnapshot });
                            const rearmed = await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id);
                            assert(rearmed);
                            expect(rearmed).toMatchObject({ id: current.task.id, userId, runId: run.id, status: "pending", executionPhase: "created" });
                            expect(rearmed.payload).toMatchObject({
                                version: current.task.payload.version,
                                operation,
                                algorithmVersion: current.task.payload.algorithmVersion,
                                inputDigest: current.task.payload.inputDigest,
                                inputs: current.task.payload.inputs,
                                sources: current.task.payload.sources,
                                options: current.task.payload.options,
                                resource: { profileVersion: configured.profileVersion, facts: current.task.payload.resource.facts },
                            });
                            expect(rearmed.payload.executionId).toBeUndefined();
                            expect(rearmed.workerId).toBeUndefined();
                            expect(rearmed.leaseUntil).toBeUndefined();
                            expect(rearmed.lastHeartbeatAt).toBeUndefined();
                            expect(rearmed.nextPollAt).toBeGreaterThan(0);
                            expect(rearmed.resultPayload).toEqual({ executionId: current.identity.executionId, checkpoints: [{ ...current.identity, failure, resource: current.task.payload.resource, artifacts: [current.artifact] }] });
                            const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                            expect(parent).toMatchObject({ status: "running", payload: { id: run.id, ecommerceSnapshot: paused.ecommerceSnapshot } });
                            expect(parent?.workerId).toBeUndefined();
                            expect(parent?.leaseUntil).toBeUndefined();
                            expect(parent?.nextPollAt).toBeUndefined();
                            expect(parent?.payload.executionId).toBeUndefined();
                            const claimed = await service.claimImageProcessingTasks({ workerId: "resource-resume-pool-one-worker", profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 });
                            expect(claimed.tasks).toHaveLength(1);
                            expect(claimed.tasks[0].id).toBe(current.task.id);
                            expect(claimed.tasks[0].executionId).not.toBe(current.identity.executionId);
                            expect(claimed.tasks[0].payload).toMatchObject({ inputDigest: current.task.payload.inputDigest, inputs: current.task.payload.inputs, sources: current.task.payload.sources, options: current.task.payload.options });
                            expect(await service.claimImageProcessingTasks({ workerId: "resource-resume-pool-one-second-worker", profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 })).toEqual({ tasks: [] });
                            const mediaAfter = await database.postgresQuery<{ record: Record<string, unknown> }>(
                                "SELECT to_jsonb(asset) AS record FROM local_media_assets AS asset WHERE owner_user_id = $1 AND storage_key = ANY($2::text[]) ORDER BY storage_key",
                                [userId, mediaKeys],
                            );
                            expect(mediaAfter.rows).toEqual(mediaBefore.rows);
                            expect(await readFile(original.filePath)).toEqual(originalBytes);
                        } finally {
                            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", previousHeap);
                        }
                    }, 30_000);
                }

                it.each([
                    { code: "fixture_closed_rejection", message: "图像处理未能完成，请检查参考图片或保护设置后继续。" },
                    { code: "segmentation_rejected", message: "无法可靠识别商品与背景边界，已暂停处理，请核对图片或保护范围后继续。" },
                ])("keeps reported rejection diagnostics internal while returning a safe parent failure ($code)", async ({ code, message }) => {
                    const current = await fixture();
                    const failure = rejectedReport(current);
                    failure.error.code = code;

                    const response = await postFail(current.task, { ...current.identity, failure });

                    expect(response.status).toBe(200);
                    await expect(response.json()).resolves.toEqual({ code: 0, data: { jobId: current.task.id, status: "error", executionPhase: "needs_review" }, msg: "OK" });
                    const parent = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                    expect(parent?.failure).toEqual(expect.stringMatching(/[\u4e00-\u9fff]/));
                    expect(parent?.failure).not.toContain(failure.error.code);
                    expect(parent?.failure).not.toContain(failure.error.message);
                    expect(parent?.failure).not.toContain(failure.stderr);
                    expect(parent?.failure).not.toContain("/fixture/private");
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id)).toMatchObject({ resultPayload: { failure } });
                    assert(parent);
                    expect((await runtime.listCreativeMessages(run.conversationId)).find((item) => item.id === run.assistantMessageId)?.content).toBe(message);
                    const truth = await truthRows(current.task);
                    await removePauseProjection();
                    const selection = await import("./agent-run-public-selection");
                    const request = new Request("http://localhost/api/agent/runs/" + run.id);
                    expect(await selection.publicAgentRunForRequest(parent, request)).toMatchObject({ imageProcessingRecovery: { reason: "input_rejected", canResume: false, message } });
                    expect((await runtime.listCreativeMessages(run.conversationId)).find((item) => item.id === run.assistantMessageId)?.content).toBe(message);
                    const events = await runtime.listCreativeRunEvents(run.id);
                    expect(events.filter((event) => event.type === "run.paused")).toHaveLength(1);
                    expect(await selection.publicAgentRunSnapshotForRequest(parent, request)).toMatchObject({ imageProcessingRecovery: { reason: "input_rejected", canResume: false } });
                    expect(await runtime.listCreativeRunEvents(run.id)).toEqual(events);
                    expect(await truthRows(current.task)).toEqual(truth);
                });

                it.each([
                    { status: "crashed", extra: { error: { code: "unexpected_exit", message: "unknown process exit" } } },
                    { status: "aborted", extra: {} },
                    { status: "completed", extra: { result: {} } },
                    { status: "resource_failure", extra: { reason: "unconfirmed_sigkill" } },
                ])("rejects unaccepted $status failure reports through the actual Route without changing either complete row", async ({ status, extra }) => {
                    const current = await fixture();
                    const before = await truthRows(current.task);
                    const { error: _error, ...exit } = rejectedReport(current);

                    const response = await postFail(current.task, { ...current.identity, failure: { ...exit, status, ...extra } });

                    expect(response.status).toBe(400);
                    await expect(response.json()).resolves.toMatchObject({ code: 400, data: null });
                    expect(await truthRows(current.task)).toEqual(before);
                });

                it.each<{ reason: string; body: (current: FailureFixture) => unknown }>([
                    { reason: "another job identity", body: (current) => ({ ...failureInput(current), failure: { ...rejectedReport(current), jobId: "another-job" } }) },
                    { reason: "a mismatched report epoch", body: (current) => ({ ...failureInput(current), failure: { ...rejectedReport(current), executionId: "another-epoch" } }) },
                    { reason: "a caller-provided user identity", body: (current) => ({ ...failureInput(current), userId: otherUserId }) },
                    { reason: "a missing rejected error", body: (current) => ({ ...current.identity, failure: { status: "rejected", jobId: current.task.id, executionId: current.identity.executionId, pid: 4321, exitCode: 0, signal: null, stderr: "" } }) },
                    { reason: "a string exit code", body: (current) => ({ ...failureInput(current), failure: { ...rejectedReport(current), exitCode: "0" } }) },
                ])("rejects $reason at the HTTP boundary without changing either complete row", async ({ body }) => {
                    const current = await fixture();
                    const before = await truthRows(current.task);

                    const response = await postFail(current.task, body(current));

                    expect(response.status).toBe(400);
                    expect(await truthRows(current.task)).toEqual(before);
                });

                it.each<{ reason: string; arrange: (current: FailureFixture) => Promise<FailImageProcessingInput> }>([
                    { reason: "another worker", arrange: async (current) => ({ ...failureInput(current), workerId: "foreign-worker" }) },
                    {
                        reason: "the same worker's old epoch",
                        arrange: async (current) => {
                            const body = failureInput(current);
                            return { ...body, executionId: "old-epoch", failure: { ...body.failure, executionId: "old-epoch" } };
                        },
                    },
                    {
                        reason: "an actually expired lease",
                        arrange: async (current) => {
                            await setInputState(current.task, true, false);
                            return failureInput(current);
                        },
                    },
                    {
                        reason: "a cancelled stage",
                        arrange: async (current) => {
                            await setInputState(current.task, false, true);
                            return failureInput(current);
                        },
                    },
                    {
                        reason: "an already successful stage",
                        arrange: async (current) => {
                            await service.completeImageProcessingTask(current.task.id, current.completion);
                            return failureInput(current);
                        },
                    },
                ])("rejects fail from $reason while retaining both complete records", async ({ arrange }) => {
                    const current = await fixture();
                    const body = await arrange(current);
                    const before = await truthRows(current.task);

                    const response = await postFail(current.task, body);

                    expect(response.status).toBe(409);
                    expect(await truthRows(current.task)).toEqual(before);
                });

                it.each<{ reason: string; change: (parent: AgentRun) => AgentRun }>([
                    {
                        reason: "another waiting job",
                        change: (parent) => {
                            assert(parent.ecommerceSnapshot?.processing?.waitingFor);
                            return { ...parent, ecommerceSnapshot: { ...parent.ecommerceSnapshot, processing: { ...parent.ecommerceSnapshot.processing, waitingFor: { ...parent.ecommerceSnapshot.processing.waitingFor, jobId: "new-waiting-job" } } } };
                        },
                    },
                    {
                        reason: "another waiting input digest",
                        change: (parent) => {
                            assert(parent.ecommerceSnapshot?.processing?.waitingFor);
                            return {
                                ...parent,
                                ecommerceSnapshot: { ...parent.ecommerceSnapshot, processing: { ...parent.ecommerceSnapshot.processing, waitingFor: { ...parent.ecommerceSnapshot.processing.waitingFor, inputDigest: "new-input-digest" } } },
                            };
                        },
                    },
                    { reason: "cancellation requested", change: (parent) => ({ ...parent, cancellation: { requestedAt: Date.now(), pendingChildTaskIds: [] } }) },
                    { reason: "a cancelled parent", change: (parent) => ({ ...parent, status: "cancelled" }) },
                    { reason: "a completed parent", change: (parent) => ({ ...parent, status: "completed" }) },
                    { reason: "a failed parent", change: (parent) => ({ ...parent, status: "failed" }) },
                ])("records only the child rejection when the current parent has $reason", async ({ change }) => {
                    const current = await fixture();
                    await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, change);
                    const before = await tasks.getStoredGenerationTaskRecord("agent", run.id);

                    await expect(service.failImageProcessingTask(current.task.id, failureInput(current))).resolves.toEqual({ jobId: current.task.id, status: "error", executionPhase: "needs_review" });

                    expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(before);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id)).toMatchObject({ status: "error", resultPayload: { failure: rejectedReport(current), artifacts: [current.artifact] } });
                });

                it.each<{ field: string; change: (failure: Extract<ClosedImageProcessingFailure, { status: "rejected" }>) => ClosedImageProcessingFailure }>([
                    { field: "code", change: (failure) => ({ ...failure, error: { ...failure.error, code: "changed_rejection" } }) },
                    { field: "message", change: (failure) => ({ ...failure, error: { ...failure.error, message: "changed private message" } }) },
                    { field: "stderr", change: (failure) => ({ ...failure, stderr: "changed private stderr" }) },
                ])("replays fixed failure fields in any JSON key order and rejects a changed $field without row changes", async ({ change }) => {
                    const current = await fixture();
                    const failure = rejectedReport(current);
                    const first = await service.failImageProcessingTask(current.task.id, { ...current.identity, failure });
                    const before = await truthRows(current.task);
                    const reordered: ClosedImageProcessingFailure = {
                        stderr: failure.stderr,
                        signal: failure.signal,
                        exitCode: failure.exitCode,
                        pid: failure.pid,
                        executionId: failure.executionId,
                        jobId: failure.jobId,
                        status: "rejected",
                        error: { message: failure.error.message, code: failure.error.code },
                    };

                    await expect(service.failImageProcessingTask(current.task.id, { ...current.identity, failure: reordered })).resolves.toEqual(first);
                    expect(await truthRows(current.task)).toEqual(before);
                    await expect(service.failImageProcessingTask(current.task.id, { ...current.identity, failure: change(failure) })).rejects.toMatchObject({ status: 409 });
                    expect(await truthRows(current.task)).toEqual(before);
                });

                it("rejects a failed-stage replay from another execution while retaining both complete rows", async () => {
                    const current = await fixture();
                    const failure = rejectedReport(current);
                    await service.failImageProcessingTask(current.task.id, { ...current.identity, failure });
                    const before = await truthRows(current.task);

                    await expect(service.failImageProcessingTask(current.task.id, { ...current.identity, executionId: "old-epoch", failure: { ...failure, executionId: "old-epoch" } })).rejects.toMatchObject({ status: 409 });

                    expect(await truthRows(current.task)).toEqual(before);
                });

                it.each(["", "Bearer wrong-worker-token"])("retains Worker authentication for fail (%s)", async (authorization) => {
                    const current = await fixture();
                    const before = await truthRows(current.task);

                    const response = await postFail(current.task, failureInput(current), authorization);

                    expect(response.status).toBe(401);
                    expect(await truthRows(current.task)).toEqual(before);
                });

                it.each(["", "fixture-maintenance-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"])("retains the unconfigured or unseparated Worker token response (%s)", async (token) => {
                    const current = await fixture();
                    const before = await truthRows(current.task);
                    vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", token);

                    const response = await postFail(current.task, failureInput(current));

                    expect(response.status).toBe(503);
                    expect(await truthRows(current.task)).toEqual(before);
                });

                if (provider === "file") {
                    it("rejects fail called with an active lease after the fixture advances beyond expiry", async () => {
                        const current = await fixture();
                        const leaseUntil = Date.now() + 3_000;
                        await tasks.withGenerationTaskFileMutation(async (records) => ({
                            tasks: records.map((record) => (record.type === "image_processing" && record.id === current.task.id ? { ...record, leaseUntil } : record)),
                            result: undefined,
                        }));
                        const before = await truthRows(current.task);
                        const entered = Promise.withResolvers<void>();
                        const release = Promise.withResolvers<void>();
                        const gate = tasks.withGenerationTaskFileMutation(async (records) => {
                            entered.resolve();
                            await release.promise;
                            return { tasks: records, result: undefined };
                        });
                        let pending: ReturnType<typeof service.failImageProcessingTask> | undefined;
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
                            assert.ok(calledAt < leaseUntil, "Fixture setup: file lease expired before fail was called");
                            let settled = false;
                            pending = service.failImageProcessingTask(current.task.id, failureInput(current));
                            void pending.then(
                                () => {
                                    settled = true;
                                },
                                () => {
                                    settled = true;
                                },
                            );
                            await Promise.resolve();
                            // Async pre-reads mean this does not prove entry into the mutation queue.
                            assert.equal(settled, false, "Fixture setup: fail settled before the fixture advanced beyond lease expiry");
                            vi.setSystemTime(leaseUntil + 1);
                            const unlockedAt = Date.now();
                            release.resolve();
                            await gate;

                            await expect(pending).rejects.toMatchObject({ status: 409 });
                            expect(await truthRows(current.task)).toEqual(before);
                            console.info("Image processing fail expiry gate", { provider, operation, calledAt, leaseUntil, unlockedAt });
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
                    }, 30_000);
                }

                if (provider === "postgres") {
                    it("rejects fail after its active database lease expires while blocked on the parent row lock", async () => {
                        assert.equal(process.env.VOZEB_PRO_DATABASE_POOL_MAX, "1", "Fixture setup: fail lock qualification requires a fresh process with pool maximum one");
                        const current = await fixture();
                        const { Client } = await import("pg");
                        const locker = new Client({ connectionString: database.getPostgresConnectionString() });
                        let transactionOpen = false;
                        let pending: ReturnType<typeof service.failImageProcessingTask> | undefined;
                        try {
                            await locker.connect();
                            const business = await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                            const businessPid = business.rows[0]?.pid;
                            assert.ok(businessPid);
                            const owner = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                            const lockerPid = owner.rows[0]?.pid;
                            assert.ok(lockerPid);
                            assert.notEqual(businessPid, lockerPid);
                            await database.postgresQuery("UPDATE generation_tasks SET lease_until = clock_timestamp() + $2::double precision * interval '1 millisecond' WHERE id = $1 AND task_type = 'image_processing'", [current.task.id, 3_000]);
                            const before = await truthRows(current.task);
                            await locker.query("BEGIN");
                            transactionOpen = true;
                            // A pure parent row lock cannot cause an UPDATE-based child lease recheck through EPQ.
                            await locker.query("SELECT id FROM vozeb_pro_generation_tasks WHERE id = $1 AND task_type = 'agent' FOR UPDATE", [run.id]);
                            const lease = await locker.query<{ lease_until: string; active: boolean }>(
                                "SELECT lease_until::text AS lease_until, lease_until > clock_timestamp() AS active FROM vozeb_pro_generation_tasks WHERE id = $1 AND task_type = 'image_processing'",
                                [current.task.id],
                            );
                            const original = lease.rows[0];
                            assert.ok(original?.active, "Fixture setup: PostgreSQL lease expired before fail was called");
                            let settled = false;
                            pending = service.failImageProcessingTask(current.task.id, failureInput(current));
                            void pending.then(
                                () => {
                                    settled = true;
                                },
                                () => {
                                    settled = true;
                                },
                            );
                            let blockedAt: string;
                            while (true) {
                                if (settled) throw new Error("Fixture setup: fail settled before an active parent lock wait was observed");
                                await locker.query("SELECT pg_stat_clear_snapshot()");
                                const observed = await locker.query<{ blocked: boolean; active: boolean; observed_at: string }>(
                                    "SELECT clock_timestamp()::text AS observed_at, $3::timestamptz > clock_timestamp() AS active, $2::int = ANY(pg_blocking_pids($1::int)) AND EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1::int AND wait_event_type = 'Lock') AS blocked",
                                    [businessPid, lockerPid, original.lease_until],
                                );
                                const state = observed.rows[0];
                                assert.ok(state?.active, "Fixture setup: no parent lock wait was observed before the actual lease expired");
                                if (state.blocked) {
                                    blockedAt = state.observed_at;
                                    break;
                                }
                            }
                            await locker.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))))", [original.lease_until]);
                            const expiry = await locker.query<{ expired: boolean; expired_at: string }>("SELECT clock_timestamp() >= $1::timestamptz AS expired, clock_timestamp()::text AS expired_at", [original.lease_until]);
                            const expired = expiry.rows[0];
                            assert.ok(expired?.expired, "Fixture setup: the actual PostgreSQL lease has not expired");
                            await locker.query("COMMIT");
                            transactionOpen = false;

                            await expect(pending).rejects.toMatchObject({ status: 409 });
                            expect(await truthRows(current.task)).toEqual(before);
                            console.info("Image processing fail expiry gate", { provider, operation, businessPid, lockerPid, blockedAt, leaseUntil: original.lease_until, unlockedAt: expired.expired_at });
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
                    }, 30_000);

                    it("rolls back both complete truth rows when a named CHECK rejects the matching parent pause", async () => {
                        const current = await fixture();
                        const before = await truthRows(current.task);
                        const constraint = `fixture_fail_parent_${randomUUID().replaceAll("-", "")}`;
                        await database.postgresQuery(`ALTER TABLE generation_tasks ADD CONSTRAINT ${constraint} CHECK (id <> '${run.id}' OR status <> 'paused')`);
                        try {
                            await expect(service.failImageProcessingTask(current.task.id, failureInput(current))).rejects.toMatchObject({ code: "23514", constraint });
                            expect(await truthRows(current.task)).toEqual(before);
                        } finally {
                            await database.postgresQuery(`ALTER TABLE generation_tasks DROP CONSTRAINT ${constraint}`);
                        }
                    });
                }
            });
        }

        function cancellationInput(task: ImageProcessingTask) {
            assert(task.runId);
            return { userId: task.userId, runId: task.runId, jobId: task.id };
        }

        async function markImageProcessingCancellation(runId: string, state: "requested" | "cancelled" = "requested") {
            await tasks.mutateStoredGenerationTask<AgentRun>("agent", runId, 60_000, (parent) => (state === "cancelled" ? { ...parent, status: "cancelled" } : { ...parent, cancellation: { requestedAt: Date.now(), pendingChildTaskIds: [] } }));
        }

        async function cancellationTruthRows(task: ImageProcessingTask) {
            if (provider === "postgres") {
                const result = await database.postgresQuery<{ record: Record<string, unknown> }>("SELECT to_jsonb(task) AS record FROM generation_tasks AS task WHERE id = ANY($1::text[]) ORDER BY task_type", [[task.runId, task.id]]);
                return result.rows.map((row) => row.record);
            }
            return [await tasks.getStoredGenerationTaskRecord("agent", cancellationInput(task).runId), await tasks.getStoredGenerationTaskRecord("image_processing", task.id)];
        }

        function claimForCancellation(task: ImageProcessingTask, workerId = "cancel-order-worker") {
            return service.claimImageProcessingTasks({ workerId, profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
        }

        async function expectCancelledImageProcessingOwner(task: ImageProcessingTask, before: StoredGenerationTaskRecord, beforeRows: Awaited<ReturnType<typeof cancellationTruthRows>>) {
            const current = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
            assert(current);
            expect(current).toMatchObject({ status: "cancelled", executionPhase: "cancel_requested" });
            expect(current.workerId).toBe(before.workerId);
            expect(current.payload).toEqual(before.payload);
            expect(current.resultPayload).toEqual(before.resultPayload);
            expect(current.leaseUntil).toBe(before.leaseUntil);
            expect(current.lastHeartbeatAt).toBe(before.lastHeartbeatAt);
            expect(current.nextPollAt).toBeUndefined();
            if (provider === "postgres") {
                const original = beforeRows[1];
                assert(original && "worker_id" in original && "lease_until" in original && "last_heartbeat_at" in original);
                expect((await cancellationTruthRows(task))[1]).toMatchObject({ worker_id: original.worker_id, lease_until: original.lease_until, last_heartbeat_at: original.last_heartbeat_at });
            }
            return current;
        }

        function cancellationCases(operation: "prepare_reference" | "build_protection", pending: () => Promise<ImageProcessingTask>, staged: () => Promise<FailureFixture>) {
            describe(`${operation} child-only queue cancellation`, () => {
                it.each(["requested", "cancelled"] as const)("cancels a real pending stage before claim when its parent is %s", async (state) => {
                    const task = await pending();
                    const request = cancellationInput(task);
                    const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                    assert(before);
                    expect(before.status).toBe("pending");
                    await markImageProcessingCancellation(request.runId, state);
                    const rows = await cancellationTruthRows(task);

                    await expect(service.cancelImageProcessingTaskForRun(request)).resolves.toBeUndefined();

                    const current = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                    expect(current).toMatchObject({ status: "cancelled", executionPhase: "completed" });
                    expect(current?.workerId).toBeUndefined();
                    expect(current?.leaseUntil).toBeUndefined();
                    expect(current?.lastHeartbeatAt).toBeUndefined();
                    expect(current?.nextPollAt).toBeUndefined();
                    expect(current?.payload).toEqual(before.payload);
                    expect(current?.resultPayload).toEqual(before.resultPayload);
                    expect((await cancellationTruthRows(task))[0]).toEqual(rows[0]);
                    await expect(claimForCancellation(task)).resolves.toEqual({ tasks: [] });
                });

                it.each<{ lease: string; arrange: (current: FailureFixture) => Promise<void>; heartbeat: (current: FailureFixture) => Promise<void> }>([
                    {
                        lease: "active",
                        arrange: async () => {},
                        heartbeat: async (current) => {
                            await expect(service.heartbeatImageProcessingTask(current.task.id, current.identity)).resolves.toMatchObject({ cancelRequested: true });
                        },
                    },
                    {
                        lease: "expired",
                        arrange: async (current) => {
                            await setInputState(current.task, true, false);
                        },
                        heartbeat: async (current) => {
                            const rows = await cancellationTruthRows(current.task);
                            await expect(service.heartbeatImageProcessingTask(current.task.id, current.identity)).rejects.toMatchObject({ status: 409 });
                            expect(await cancellationTruthRows(current.task)).toEqual(rows);
                        },
                    },
                ])("records cancellation with an $lease owner lease while preserving the actual owner and staged evidence", async ({ arrange, heartbeat }) => {
                    const current = await staged();
                    await arrange(current);
                    await markImageProcessingCancellation(cancellationInput(current.task).runId);
                    const before = await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id);
                    assert(before);
                    const rows = await cancellationTruthRows(current.task);

                    await expect(service.cancelImageProcessingTaskForRun(cancellationInput(current.task))).resolves.toBeUndefined();

                    await expectCancelledImageProcessingOwner(current.task, before, rows);
                    expect((await cancellationTruthRows(current.task))[0]).toEqual(rows[0]);
                    await heartbeat(current);
                    const afterHeartbeat = await cancellationTruthRows(current.task);
                    await expect(service.heartbeatImageProcessingTask(current.task.id, { ...current.identity, executionId: "previous-cancel-owner-epoch" })).rejects.toMatchObject({ status: 409 });
                    expect(await cancellationTruthRows(current.task)).toEqual(afterHeartbeat);
                });

                it.each([
                    { state: "pending", create: pending },
                    { state: "running", create: async () => (await staged()).task },
                ])("replays cancellation of a $state stage without changing either complete row", async ({ create }) => {
                    const task = await create();
                    await markImageProcessingCancellation(cancellationInput(task).runId);
                    await service.cancelImageProcessingTaskForRun(cancellationInput(task));
                    const rows = await cancellationTruthRows(task);

                    await expect(service.cancelImageProcessingTaskForRun(cancellationInput(task))).resolves.toBeUndefined();

                    expect(await cancellationTruthRows(task)).toEqual(rows);
                });

                function reportedFailure(current: FailureFixture, resource: boolean): FailImageProcessingInput {
                    const exit = { jobId: current.task.id, executionId: current.identity.executionId, pid: 4321, exitCode: 0, signal: null, stderr: "controlled existing failure fixture" };
                    const failure: ClosedImageProcessingFailure = resource
                        ? { ...exit, status: "resource_failure", reason: "v8_heap_oom", exitCode: 134 }
                        : { ...exit, status: "rejected", error: { code: "fixture_cancel_terminal_rejection", message: "controlled existing failure fixture" } };
                    return { ...current.identity, failure };
                }

                it.each<{ state: string; finish: (current: FailureFixture) => Promise<unknown> }>([
                    { state: "success", finish: (current) => service.completeImageProcessingTask(current.task.id, current.completion) },
                    { state: "error", finish: (current) => service.failImageProcessingTask(current.task.id, reportedFailure(current, false)) },
                    { state: "paused", finish: (current) => service.failImageProcessingTask(current.task.id, reportedFailure(current, true)) },
                ])("retains a real $state terminal stage and both complete rows", async ({ finish }) => {
                    const current = await staged();
                    await finish(current);
                    await markImageProcessingCancellation(cancellationInput(current.task).runId);
                    const rows = await cancellationTruthRows(current.task);

                    await expect(service.cancelImageProcessingTaskForRun(cancellationInput(current.task))).resolves.toBeUndefined();

                    expect(await cancellationTruthRows(current.task)).toEqual(rows);
                });

                it("rejects cancellation without a persisted parent cancellation intent", async () => {
                    const task = await pending();
                    const rows = await cancellationTruthRows(task);

                    await expect(service.cancelImageProcessingTaskForRun(cancellationInput(task))).rejects.toMatchObject({ status: 409 });

                    expect(await cancellationTruthRows(task)).toEqual(rows);
                });

                it.each<{ binding: string; request: (task: ImageProcessingTask) => Promise<ReturnType<typeof cancellationInput>> }>([
                    { binding: "another user", request: async (task) => ({ ...cancellationInput(task), userId: otherUserId }) },
                    {
                        binding: "another real Run",
                        request: async (task) => {
                            const other = await seedReference(task.userId);
                            await markImageProcessingCancellation(other.run.id);
                            return { ...cancellationInput(task), runId: other.run.id };
                        },
                    },
                ])("rejects $binding binding without changing either complete row", async ({ request }) => {
                    const task = await pending();
                    await markImageProcessingCancellation(cancellationInput(task).runId);
                    const body = await request(task);
                    const rows = await cancellationTruthRows(task);

                    await expect(service.cancelImageProcessingTaskForRun(body)).rejects.toMatchObject({ status: 409 });

                    expect(await cancellationTruthRows(task)).toEqual(rows);
                });

                if (provider === "file") {
                    it("preserves the claim committed while cancellation waits for the real creative gate", async () => {
                        const task = await pending();
                        await markImageProcessingCancellation(cancellationInput(task).runId);
                        const rows = await cancellationTruthRows(task);
                        const { queueRuntimeFileOperation } = await import("./creative-runtime-repository");
                        const entered = Promise.withResolvers<void>();
                        const release = Promise.withResolvers<void>();
                        const gate = queueRuntimeFileOperation(async () => {
                            entered.resolve();
                            await release.promise;
                        });
                        let cancellation: Promise<void> | undefined;
                        try {
                            await Promise.race([
                                entered.promise,
                                gate.then(() => {
                                    throw new Error("Fixture setup: creative gate exited before entering");
                                }),
                            ]);
                            let settled = false;
                            cancellation = service.cancelImageProcessingTaskForRun(cancellationInput(task));
                            void cancellation.then(
                                () => {
                                    settled = true;
                                },
                                () => {
                                    settled = true;
                                },
                            );
                            const claimed = await claimForCancellation(task);
                            expect(claimed.tasks.map((item) => item.id)).toEqual([task.id]);
                            const owner = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                            assert(owner);
                            const ownerRows = await cancellationTruthRows(task);
                            assert.equal(settled, false, "Fixture setup: cancel settled before the actual claim committed behind the creative gate");
                            release.resolve();
                            await gate;

                            await expect(cancellation).resolves.toBeUndefined();

                            await expectCancelledImageProcessingOwner(task, owner, ownerRows);
                            expect((await cancellationTruthRows(task))[0]).toEqual(rows[0]);
                            await expect(service.heartbeatImageProcessingTask(task.id, { workerId: "cancel-order-worker", executionId: claimed.tasks[0].executionId })).resolves.toMatchObject({ cancelRequested: true });
                        } finally {
                            release.resolve();
                            try {
                                await gate;
                            } finally {
                                if (cancellation) await cancellation.catch(() => undefined);
                            }
                        }
                    }, 30_000);
                }
            });
        }

        type CancelCloseStopCause = "cancel_requested" | "lease_lost" | "worker_stopping" | null;
        type CancelCloseReport = Pick<ImageProcessingOutcome, "jobId" | "executionId" | "exitCode" | "signal" | "stderr"> & { pid: number } & (
                { status: "aborted" | "completed" } | { status: "rejected" | "crashed"; error: { code: string; message: string } } | { status: "resource_failure"; reason: "v8_heap_oom" }
            );
        type CancelCloseInput = { workerId: string; executionId: string; closed: CancelCloseReport; stopCause: CancelCloseStopCause };

        function cancelCloseCases(operation: "prepare_reference" | "build_protection", pending: () => Promise<ImageProcessingTask>, fixture: () => Promise<FailureFixture>) {
            describe(`${operation} cancelled execution close acknowledgement`, () => {
                const workerToken = "fixture-image-worker-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                let heartbeatRoute: typeof import("@/app/api/maintenance/image-processing/[id]/heartbeat/route");

                beforeAll(async () => {
                    heartbeatRoute = await import("@/app/api/maintenance/image-processing/[id]/heartbeat/route");
                });

                beforeEach(() => {
                    vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
                    vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-maintenance-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
                });

                function postHeartbeat(task: ImageProcessingTask, body: unknown) {
                    return heartbeatRoute.POST(
                        new Request(`http://localhost/api/maintenance/image-processing/${task.id}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
                        {
                            params: Promise.resolve({ id: task.id }),
                        },
                    );
                }

                async function closeTruthRows(task: ImageProcessingTask) {
                    if (provider === "postgres") return cancellationTruthRows(task);
                    const { readJsonDataFile } = await import("./data-adapter");
                    const records = await readJsonDataFile<StoredGenerationTaskRecord[]>("generation-tasks.json", []);
                    return [records.find((record) => record.type === "agent" && record.id === task.runId), records.find((record) => record.type === "image_processing" && record.id === task.id)];
                }

                async function requestCancellation(current: FailureFixture) {
                    await markImageProcessingCancellation(cancellationInput(current.task).runId);
                    await service.cancelImageProcessingTaskForRun(cancellationInput(current.task));
                }

                function controlledClose(current: FailureFixture): CancelCloseInput {
                    // Mapping cases use a controlled Worker report; the focused case below uses a real Task2 close.
                    return {
                        ...current.identity,
                        closed: { jobId: current.task.id, executionId: current.identity.executionId, status: "aborted", pid: 4321, exitCode: null, signal: "SIGTERM", stderr: "controlled closed child" },
                        stopCause: "cancel_requested",
                    };
                }

                function rejectedClose(current: FailureFixture) {
                    return {
                        jobId: current.task.id,
                        executionId: current.identity.executionId,
                        status: "rejected" as const,
                        pid: 4321,
                        exitCode: 0,
                        signal: null,
                        stderr: "controlled private close stderr",
                        error: { code: "controlled_rejection", message: "controlled private close error" },
                    };
                }

                async function reopenCloseFixture(task: ImageProcessingTask) {
                    if (provider === "postgres")
                        await database.postgresQuery(
                            "UPDATE generation_tasks SET status = 'pending', execution_phase = 'created', worker_id = NULL, lease_until = NULL, last_heartbeat_at = NULL, next_poll_at = now() WHERE id = $1 AND task_type = 'image_processing'",
                            [task.id],
                        );
                    else
                        await tasks.withGenerationTaskFileMutation(async (records) => ({
                            tasks: records.map((record) =>
                                record.id === task.id && record.type === "image_processing"
                                    ? { ...record, status: "pending", executionPhase: "created", workerId: undefined, leaseUntil: undefined, lastHeartbeatAt: undefined, nextPollAt: Date.now() }
                                    : record,
                            ),
                            result: undefined,
                        }));
                }

                async function expireCloseFixture(task: ImageProcessingTask) {
                    if (provider === "postgres") await database.postgresQuery("UPDATE generation_tasks SET expires_at = now() - interval '1 second' WHERE id = $1 AND task_type = 'image_processing'", [task.id]);
                    else
                        await tasks.withGenerationTaskFileMutation(async (records) => ({
                            tasks: records.map((record) => (record.id === task.id && record.type === "image_processing" ? { ...record, expiresAt: Date.now() - 1_000 } : record)),
                            result: undefined,
                        }));
                }

                async function replaceCloseReceiptEpoch(task: ImageProcessingTask) {
                    if (provider === "postgres")
                        await database.postgresQuery("UPDATE generation_tasks SET payload = jsonb_set(payload, '{executionId}', to_jsonb($2::text)) WHERE id = $1 AND task_type = 'image_processing'", [task.id, "replacement-close-epoch"]);
                    else
                        await tasks.withGenerationTaskFileMutation(async (records) => ({
                            tasks: records.map((record) => (record.id === task.id && record.type === "image_processing" ? { ...record, payload: { ...record.payload, executionId: "replacement-close-epoch" } } : record)),
                            result: undefined,
                        }));
                }

                async function actualCancelledClose(current: FailureFixture): Promise<CancelCloseReport> {
                    const original = await service.readImageProcessingInput(current.task.id, current.task.payload.inputs[0].assetId, current.identity);
                    const bytes = await imageProcessingStreamBytes(original.stream);
                    expect(createHash("sha256").update(bytes).digest("hex")).toBe(current.task.payload.inputs[0].expectedSha256);
                    const taskDirectory = await mkdtemp(path.join(directory, "cancel-close-child-"));
                    try {
                        const filename = path.join(taskDirectory, "downloaded.png");
                        await writeFile(filename, bytes);
                        const outputDirectory = await mkdtemp(path.join(taskDirectory, "output-"));
                        await requestCancellation(current);
                        const heartbeat = await postHeartbeat(current.task, current.identity);
                        expect(heartbeat.status).toBe(200);
                        await expect(heartbeat.json()).resolves.toEqual({ code: 0, data: { leaseUntil: expect.any(Number), cancelRequested: true }, msg: "OK" });
                        const payload = current.task.payload;
                        assert(payload.operation === "prepare_reference" || payload.operation === "build_protection");
                        const requestOperation: ImageProcessingOperation = payload.operation === "prepare_reference" ? { operation: "prepare_reference", options: {} } : { operation: "build_protection", options: payload.options };
                        const controller = new AbortController();
                        const running = runImageProcessing(
                            { ...requestOperation, version: "image-processing.v1", jobId: current.task.id, executionId: current.identity.executionId, inputs: [{ ...payload.inputs[0], path: filename }], outputDirectory },
                            { taskDirectory, maxHeapMiB: payload.resource.configuration.processHeapMb, signal: controller.signal },
                        );
                        controller.abort();
                        const outcome = await running;
                        expect(outcome).toMatchObject({ status: "aborted", jobId: current.task.id, executionId: current.identity.executionId });
                        assert(outcome.status === "aborted");
                        const pid = outcome.pid;
                        assert(pid && Number.isSafeInteger(pid));
                        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
                        expect(await readFile(filename)).toEqual(bytes);
                        console.info("Image processing cancel real close", { provider, operation, jobId: outcome.jobId, executionId: outcome.executionId, pid, exitCode: outcome.exitCode, signal: outcome.signal });
                        return { ...outcome, pid };
                    } finally {
                        await rm(taskDirectory, { recursive: true, force: true });
                    }
                }

                async function notStartedTruth(task: ImageProcessingTask) {
                    const original = task.payload.sources[0];
                    assert(original && original.storageProvider === "local");
                    const { getLocalMediaRegistrations } = await import("./local-media-registry");
                    const { readReferenceAsset } = await import("./reference-asset-store");
                    const media = await getLocalMediaRegistrations([original.storageKey], { ownerUserId: userId });
                    expect(media).toHaveLength(1);
                    const saved = await readReferenceAsset(original.storageKey);
                    assert(saved);
                    return { rows: await closeTruthRows(task), media, sourceBytes: await readFile(saved.filePath) };
                }

                async function notStartedCancellation() {
                    const task = await pending();
                    const workerId = "not-started-owner";
                    const claimed = await claimForCancellation(task, workerId);
                    expect(claimed.tasks).toHaveLength(1);
                    const owned = claimed.tasks[0];
                    assert(owned);
                    expect(owned.id).toBe(task.id);
                    const identity = { workerId, executionId: owned.executionId };
                    await markImageProcessingCancellation(cancellationInput(task).runId);
                    await service.cancelImageProcessingTaskForRun(cancellationInput(task));
                    const body = { ...identity, notStarted: true, stopCause: "cancel_requested" };
                    const before = await notStartedTruth(task);
                    return { task, identity, body, before };
                }

                async function expectNotStartedReceipt(current: Awaited<ReturnType<typeof notStartedCancellation>>) {
                    const receipt = { jobId: current.task.id, executionId: current.identity.executionId, status: "cancelled", executionPhase: "completed" };
                    const after = await notStartedTruth(current.task);
                    const parent = current.before.rows[0];
                    const child = current.before.rows[1];
                    assert(parent && child);
                    const result = { executionId: current.identity.executionId, cancelNotStarted: { ...current.body, receipt } };
                    if (provider === "postgres") {
                        expect(child).toMatchObject({
                            status: "cancelled",
                            execution_phase: "cancel_requested",
                            worker_id: current.identity.workerId,
                            lease_until: expect.any(String),
                            last_heartbeat_at: expect.any(String),
                            next_poll_at: null,
                            payload: { executionId: current.identity.executionId },
                            result_payload: null,
                        });
                        expect(after).toStrictEqual({
                            ...current.before,
                            rows: [parent, { ...child, execution_phase: "completed", updated_at: expect.any(String), worker_id: null, lease_until: null, last_heartbeat_at: null, next_poll_at: null, result_payload: result }],
                        });
                    } else {
                        assert("workerId" in child && "leaseUntil" in child && "lastHeartbeatAt" in child);
                        const { workerId, leaseUntil, lastHeartbeatAt, ...released } = child;
                        expect(workerId).toBe(current.identity.workerId);
                        expect(leaseUntil).toBeTypeOf("number");
                        expect(lastHeartbeatAt).toBeTypeOf("number");
                        expect(child).toMatchObject({ status: "cancelled", executionPhase: "cancel_requested", payload: { executionId: current.identity.executionId } });
                        expect(Object.hasOwn(child, "nextPollAt")).toBe(false);
                        expect(Object.hasOwn(child, "resultPayload")).toBe(false);
                        expect(after).toStrictEqual({ ...current.before, rows: [parent, { ...released, executionPhase: "completed", updatedAt: expect.any(Number), resultPayload: result }] });
                    }
                }

                it("acknowledges a not-started owned cancellation through the existing service", async () => {
                    const current = await notStartedCancellation();
                    const receipt = { jobId: current.task.id, executionId: current.identity.executionId, status: "cancelled", executionPhase: "completed" };

                    await expect(service.acknowledgeImageProcessingCancellation(current.task.id, current.body)).resolves.toStrictEqual(receipt);

                    await expectNotStartedReceipt(current);
                });

                it("acknowledges a not-started owned cancellation through the heartbeat Route", async () => {
                    const current = await notStartedCancellation();
                    const receipt = { jobId: current.task.id, executionId: current.identity.executionId, status: "cancelled", executionPhase: "completed" };

                    const response = await postHeartbeat(current.task, current.body);

                    expect(response.status).toBe(200);
                    await expect(response.json()).resolves.toStrictEqual({ code: 0, data: receipt, msg: "OK" });
                    expect(response.headers.get("cache-control")).toBe("no-store");
                    await expectNotStartedReceipt(current);
                });

                it("rejects a reserved not-started marker without a stop cause instead of renewing its lease", async () => {
                    const current = await notStartedCancellation();

                    const response = await postHeartbeat(current.task, { ...current.identity, notStarted: true });
                    const after = await notStartedTruth(current.task);

                    expect(response.status).toBe(400);
                    expect(after).toStrictEqual(current.before);
                });

                it("acknowledges an actual owned Task2 abort and close through the heartbeat Route", async () => {
                    const current = await fixture();
                    const closed = await actualCancelledClose(current);
                    const rows = await closeTruthRows(current.task);
                    const before = await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id);
                    assert(before);
                    const receipt = { jobId: current.task.id, executionId: current.identity.executionId, status: "cancelled", executionPhase: "completed" };

                    const response = await postHeartbeat(current.task, { ...current.identity, closed, stopCause: "cancel_requested" });

                    expect(response.status).toBe(200);
                    await expect(response.json()).resolves.toEqual({ code: 0, data: receipt, msg: "OK" });
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id)).toEqual({
                        ...before,
                        status: "cancelled",
                        executionPhase: "completed",
                        updatedAt: expect.any(Number),
                        workerId: undefined,
                        leaseUntil: undefined,
                        lastHeartbeatAt: undefined,
                        nextPollAt: undefined,
                        resultPayload: { ...before.resultPayload, cancelClose: { ...current.identity, closed, stopCause: "cancel_requested", receipt } },
                    });
                    expect((await closeTruthRows(current.task))[0]).toEqual(rows[0]);
                    const { readReferenceAsset } = await import("./reference-asset-store");
                    const staged = await readReferenceAsset(current.artifact.storageKey);
                    assert(staged);
                    expect(
                        createHash("sha256")
                            .update(await readFile(staged.filePath))
                            .digest("hex"),
                    ).toBe(current.artifact.sha256);
                }, 30_000);

                it("accepts the actual closed original owner after lease expiry while ordinary heartbeat still rejects", async () => {
                    const current = await fixture();
                    const closed = await actualCancelledClose(current);
                    await setInputState(current.task, true, false);
                    const rows = await closeTruthRows(current.task);
                    const ordinary = await postHeartbeat(current.task, current.identity);
                    expect(ordinary.status).toBe(409);
                    expect(await closeTruthRows(current.task)).toEqual(rows);

                    const response = await postHeartbeat(current.task, { ...current.identity, closed, stopCause: "cancel_requested" });

                    expect(response.status).toBe(200);
                    await expect(response.json()).resolves.toEqual({ code: 0, data: { jobId: current.task.id, executionId: current.identity.executionId, status: "cancelled", executionPhase: "completed" }, msg: "OK" });
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id)).toMatchObject({ status: "cancelled", executionPhase: "completed", payload: current.task.payload });
                    expect((await closeTruthRows(current.task))[0]).toEqual(rows[0]);
                }, 30_000);

                it.each<{ status: string; closed: (current: FailureFixture) => CancelCloseReport; stopCause: CancelCloseStopCause }>([
                    { status: "completed", closed: (current) => ({ ...controlledClose(current).closed, status: "completed", exitCode: 0, signal: null }), stopCause: null },
                    { status: "rejected", closed: rejectedClose, stopCause: null },
                    { status: "crashed", closed: (current) => ({ ...rejectedClose(current), status: "crashed" }), stopCause: null },
                    { status: "resource_failure", closed: (current) => ({ ...controlledClose(current).closed, status: "resource_failure", exitCode: 134, signal: null, reason: "v8_heap_oom" }), stopCause: null },
                    { status: "aborted after lease loss", closed: (current) => controlledClose(current).closed, stopCause: "lease_lost" },
                    { status: "aborted during Worker stopping", closed: (current) => controlledClose(current).closed, stopCause: "worker_stopping" },
                ])("retains the reported $status and stop cause when closing an already cancelled execution", async ({ closed: report, stopCause }) => {
                    const current = await fixture();
                    await requestCancellation(current);
                    const closed = report(current);
                    const rows = await closeTruthRows(current.task);

                    const response = await postHeartbeat(current.task, { ...current.identity, closed, stopCause });

                    expect(response.status).toBe(200);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id)).toMatchObject({ status: "cancelled", executionPhase: "completed", resultPayload: { cancelClose: { ...current.identity, closed, stopCause } } });
                    expect((await closeTruthRows(current.task))[0]).toEqual(rows[0]);
                });

                it("replays the first receipt with reordered report and error keys without rewriting either complete row", async () => {
                    const current = await fixture();
                    await requestCancellation(current);
                    const closed = rejectedClose(current);
                    const first = await postHeartbeat(current.task, { ...current.identity, closed, stopCause: null });
                    expect(first.status).toBe(200);
                    const receipt = await first.json();
                    expect(receipt).toEqual({ code: 0, data: { jobId: current.task.id, executionId: current.identity.executionId, status: "cancelled", executionPhase: "completed" }, msg: "OK" });
                    const rows = await closeTruthRows(current.task);
                    const reordered = {
                        stderr: closed.stderr,
                        signal: closed.signal,
                        exitCode: closed.exitCode,
                        pid: closed.pid,
                        error: { message: closed.error.message, code: closed.error.code },
                        status: closed.status,
                        executionId: closed.executionId,
                        jobId: closed.jobId,
                    };

                    const replay = await postHeartbeat(current.task, { stopCause: null, closed: reordered, executionId: current.identity.executionId, workerId: current.identity.workerId });

                    expect(replay.status).toBe(200);
                    await expect(replay.json()).resolves.toEqual(receipt);
                    expect(await closeTruthRows(current.task)).toEqual(rows);
                });

                it.each<{ field: string; change: (closed: ReturnType<typeof rejectedClose>) => CancelCloseReport }>([
                    { field: "pid", change: (closed) => ({ ...closed, pid: 4322 }) },
                    { field: "exit code", change: (closed) => ({ ...closed, exitCode: 1 }) },
                    { field: "signal", change: (closed) => ({ ...closed, signal: "SIGTERM" }) },
                    { field: "stderr", change: (closed) => ({ ...closed, stderr: "changed close stderr" }) },
                    { field: "status", change: (closed) => ({ ...closed, status: "crashed" }) },
                    { field: "error code", change: (closed) => ({ ...closed, error: { ...closed.error, code: "changed_close_error" } }) },
                    { field: "error message", change: (closed) => ({ ...closed, error: { ...closed.error, message: "changed close error message" } }) },
                ])("rejects a changed $field after the first close receipt without rewriting either complete row", async ({ change }) => {
                    const current = await fixture();
                    await requestCancellation(current);
                    const closed = rejectedClose(current);
                    expect((await postHeartbeat(current.task, { ...current.identity, closed, stopCause: null })).status).toBe(200);
                    const rows = await closeTruthRows(current.task);

                    const response = await postHeartbeat(current.task, { ...current.identity, closed: change(closed), stopCause: null });

                    expect(response.status).toBe(409);
                    expect(await closeTruthRows(current.task)).toEqual(rows);
                });

                it("rejects a changed first stop cause without rewriting either complete row", async () => {
                    const current = await fixture();
                    await requestCancellation(current);
                    const body = controlledClose(current);
                    expect((await postHeartbeat(current.task, body)).status).toBe(200);
                    const rows = await closeTruthRows(current.task);

                    const response = await postHeartbeat(current.task, { ...body, stopCause: "worker_stopping" });

                    expect(response.status).toBe(409);
                    expect(await closeTruthRows(current.task)).toEqual(rows);
                });

                it.each<{ identity: string; change: (body: CancelCloseInput) => CancelCloseInput }>([
                    { identity: "another worker", change: (body) => ({ ...body, workerId: "another-close-worker" }) },
                    { identity: "an old epoch", change: (body) => ({ ...body, executionId: "old-close-epoch", closed: { ...body.closed, executionId: "old-close-epoch" } }) },
                ])("rejects $identity before and after a close receipt without rewriting either complete row", async ({ change }) => {
                    const current = await fixture();
                    await requestCancellation(current);
                    const body = controlledClose(current);
                    const before = await closeTruthRows(current.task);
                    expect((await postHeartbeat(current.task, change(body))).status).toBe(409);
                    expect(await closeTruthRows(current.task)).toEqual(before);
                    expect((await postHeartbeat(current.task, body)).status).toBe(200);
                    const closed = await closeTruthRows(current.task);

                    expect((await postHeartbeat(current.task, change(body))).status).toBe(409);
                    expect(await closeTruthRows(current.task)).toEqual(closed);
                });

                it.each<{ identity: string; workerId: (current: FailureFixture) => string }>([
                    { identity: "same Worker", workerId: (current) => current.identity.workerId },
                    { identity: "another Worker", workerId: () => "another-takeover-worker" },
                ])("rejects the old owner after an actual $identity takeover without changing the cancelled current owner", async ({ workerId }) => {
                    const current = await fixture();
                    const body = controlledClose(current);
                    await setInputState(current.task, true, false);
                    await scheduler.scheduleGenerationTask("image_processing", current.task.id, { nextPollAt: Date.now() });
                    const claimed = await claimForCancellation(current.task, workerId(current));
                    expect(claimed.tasks.map((task) => task.id)).toEqual([current.task.id]);
                    expect(claimed.tasks[0].executionId).not.toBe(current.identity.executionId);
                    await requestCancellation(current);
                    const rows = await closeTruthRows(current.task);

                    const response = await postHeartbeat(current.task, body);

                    expect(response.status).toBe(409);
                    expect(await closeTruthRows(current.task)).toEqual(rows);
                });

                it.each<CancelCloseStopCause>(["cancel_requested", "lease_lost", "worker_stopping", null])("does not turn an uncancelled execution into cancelled from reported cause %s", async (stopCause) => {
                    const current = await fixture();
                    const rows = await closeTruthRows(current.task);

                    const response = await postHeartbeat(current.task, { ...controlledClose(current), stopCause });

                    expect(response.status).toBe(409);
                    expect(await closeTruthRows(current.task)).toEqual(rows);
                });

                it.each<{ state: string; finish: (current: FailureFixture) => Promise<unknown> }>([
                    { state: "success", finish: (current) => service.completeImageProcessingTask(current.task.id, current.completion) },
                    { state: "error", finish: (current) => service.failImageProcessingTask(current.task.id, { ...current.identity, failure: rejectedClose(current) }) },
                    {
                        state: "paused",
                        finish: (current) => service.failImageProcessingTask(current.task.id, { ...current.identity, failure: { ...controlledClose(current).closed, status: "resource_failure", exitCode: 134, signal: null, reason: "v8_heap_oom" } }),
                    },
                ])("does not replace a real $state terminal stage with a cancellation close", async ({ finish }) => {
                    const current = await fixture();
                    await finish(current);
                    const rows = await closeTruthRows(current.task);

                    const response = await postHeartbeat(current.task, controlledClose(current));

                    expect(response.status).toBe(409);
                    expect(await closeTruthRows(current.task)).toEqual(rows);
                });

                it("does not fabricate a close receipt for a pending stage cancelled before claim", async () => {
                    const task = await pending();
                    await markImageProcessingCancellation(cancellationInput(task).runId);
                    await service.cancelImageProcessingTaskForRun(cancellationInput(task));
                    const rows = await closeTruthRows(task);

                    const response = await postHeartbeat(task, {
                        workerId: "unclaimed-close-worker",
                        executionId: "unclaimed-close-epoch",
                        closed: { jobId: task.id, executionId: "unclaimed-close-epoch", status: "aborted", pid: 4321, exitCode: null, signal: "SIGTERM", stderr: "" },
                        stopCause: "cancel_requested",
                    });

                    expect(response.status).toBe(409);
                    expect(await closeTruthRows(task)).toEqual(rows);
                });

                it("does not replay an old receipt over a reopened and actually reclaimed stage", async () => {
                    const current = await fixture();
                    await requestCancellation(current);
                    const body = controlledClose(current);
                    expect((await postHeartbeat(current.task, body)).status).toBe(200);
                    // Reopening is a persisted fixture prerequisite, not a claim that the Run retry action is integrated.
                    await reopenCloseFixture(current.task);
                    const reopened = await closeTruthRows(current.task);
                    expect((await postHeartbeat(current.task, body)).status).toBe(409);
                    expect(await closeTruthRows(current.task)).toEqual(reopened);
                    const reclaimed = await claimForCancellation(current.task, "reopened-close-worker");
                    expect(reclaimed.tasks.map((task) => task.id)).toEqual([current.task.id]);
                    expect(reclaimed.tasks[0].executionId).not.toBe(current.identity.executionId);
                    const rows = await closeTruthRows(current.task);

                    const response = await postHeartbeat(current.task, body);

                    expect(response.status).toBe(409);
                    expect(await closeTruthRows(current.task)).toEqual(rows);
                });

                it.each<{ state: string; arrange: (current: FailureFixture) => Promise<unknown>; responseStatus: 404 | 409 }>([
                    { state: "a non-completed phase", arrange: (current) => scheduler.scheduleGenerationTask("image_processing", current.task.id, { executionPhase: "cancel_requested" }), responseStatus: 409 },
                    { state: "a replacement payload epoch", arrange: (current) => replaceCloseReceiptEpoch(current.task), responseStatus: 409 },
                    { state: "an expired child TTL", arrange: (current) => expireCloseFixture(current.task), responseStatus: 404 },
                ])("rejects a saved close receipt after $state without rewriting either complete row", async ({ arrange, responseStatus }) => {
                    const current = await fixture();
                    await requestCancellation(current);
                    const body = controlledClose(current);
                    const first = await postHeartbeat(current.task, body);
                    expect(first.status).toBe(200);
                    await expect(first.json()).resolves.toEqual({ code: 0, data: { jobId: current.task.id, executionId: current.identity.executionId, status: "cancelled", executionPhase: "completed" }, msg: "OK" });
                    await arrange(current);
                    const rows = await closeTruthRows(current.task);

                    const response = await postHeartbeat(current.task, body);

                    expect(response.status).toBe(responseStatus);
                    expect(await closeTruthRows(current.task)).toEqual(rows);
                });

                it("does not recreate an expired child from the original owner's close report", async () => {
                    const current = await fixture();
                    await requestCancellation(current);
                    await expireCloseFixture(current.task);
                    const rows = await closeTruthRows(current.task);

                    const response = await postHeartbeat(current.task, controlledClose(current));

                    expect(response.status).toBe(404);
                    expect(await closeTruthRows(current.task)).toEqual(rows);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", current.task.id)).toBeNull();
                });

                it.each<{ reason: string; change: (body: CancelCloseInput) => unknown }>([
                    { reason: "an unknown outer field", change: (body) => ({ ...body, metrics: {} }) },
                    { reason: "a missing closed report", change: (body) => ({ ...body, closed: undefined }) },
                    { reason: "a missing stop cause", change: (body) => ({ ...body, stopCause: undefined }) },
                    { reason: "an unknown stop cause", change: (body) => ({ ...body, stopCause: "timeout" }) },
                    { reason: "a null closed report", change: (body) => ({ ...body, closed: null }) },
                    { reason: "a closed report without its required structure", change: (body) => ({ ...body, closed: {} }) },
                    { reason: "a not-started null pid", change: (body) => ({ ...body, closed: { ...body.closed, pid: null } }) },
                    { reason: "a nonpositive pid", change: (body) => ({ ...body, closed: { ...body.closed, pid: 0 } }) },
                    { reason: "an unknown closed field", change: (body) => ({ ...body, closed: { ...body.closed, artifacts: [] } }) },
                    { reason: "a completed result payload", change: (body) => ({ ...body, closed: { ...body.closed, status: "completed", result: {} } }) },
                    { reason: "an aborted error payload", change: (body) => ({ ...body, closed: { ...body.closed, error: { code: "unexpected", message: "unexpected" } } }) },
                    { reason: "an unconfirmed resource reason", change: (body) => ({ ...body, closed: { ...body.closed, status: "resource_failure", reason: "sigkill" } }) },
                    { reason: "a mismatched report job", change: (body) => ({ ...body, closed: { ...body.closed, jobId: "another-close-job" } }) },
                    { reason: "a mismatched report epoch", change: (body) => ({ ...body, closed: { ...body.closed, executionId: "another-close-epoch" } }) },
                ])("rejects $reason through the real heartbeat Route without changing either complete row", async ({ change }) => {
                    const current = await fixture();
                    await requestCancellation(current);
                    const rows = await closeTruthRows(current.task);

                    const response = await postHeartbeat(current.task, change(controlledClose(current)));

                    expect(response.status).toBe(400);
                    expect(await closeTruthRows(current.task)).toEqual(rows);
                });
            });
        }

        async function leasedPrepare(stageInput = input) {
            const task = await service.enqueueImageProcessingTask(stageInput);
            const claimed = await service.claimImageProcessingTasks({ workerId: "prepare-output-worker", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            expect(claimed.tasks[0].id).toBe(task.id);
            return { task, identity: { workerId: "prepare-output-worker", executionId: claimed.tasks[0].executionId } };
        }

        function imageBody(bytes = source) {
            const response = new Response(new Uint8Array(bytes));
            assert(response.body);
            return response.body;
        }

        function prepareCompletion(task: ImageProcessingTask, identity: { workerId: string; executionId: string }, artifact: StoredImageProcessingArtifact, bytes = source): CompleteImageProcessingInput {
            return {
                ...identity,
                manifest: {
                    jobId: task.id,
                    executionId: identity.executionId,
                    sourceIdentities: [
                        { assetId: task.payload.inputs[0].assetId, assetVersion: task.payload.inputs[0].assetVersion, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mimeType: "image/png", width: 24, height: 18 },
                    ],
                    artifacts: [artifact],
                    geometry: { sourceSize: { width: 24, height: 18 } },
                },
                metrics: { pid: process.pid, peakRssBytes: 64 * 1024 * 1024, peakHeapUsedBytes: 8 * 1024 * 1024, peakExternalBytes: 4 * 1024 * 1024, elapsedMs: 12 },
            };
        }

        describe("image processing prepare analysis upload and complete", () => {
            const workerToken = "fixture-image-worker-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            type OutputRequestOptions = { authorization?: string; kind?: string; mimeType?: string; bytes?: Buffer; query?: string; headers?: Record<string, string> };
            let outputRoute: typeof import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route");
            let completeRoute: typeof import("@/app/api/maintenance/image-processing/[id]/complete/route");

            beforeAll(async () => {
                [outputRoute, completeRoute] = await Promise.all([import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route"), import("@/app/api/maintenance/image-processing/[id]/complete/route")]);
            });

            beforeEach(async () => {
                await clearInternalFixtureTasks();
                vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
                vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-maintenance-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
            });

            function putAnalysis(task: ImageProcessingTask, identity: { workerId: string; executionId: string }, options: OutputRequestOptions = {}) {
                const kind = options.kind ?? "analysis";
                const init: RequestInit & { duplex: "half" } = {
                    method: "PUT",
                    duplex: "half",
                    headers: {
                        authorization: options.authorization ?? `Bearer ${workerToken}`,
                        "content-type": options.mimeType ?? "image/png",
                        "x-vozeb-pro-worker-id": identity.workerId,
                        "x-vozeb-pro-execution-id": identity.executionId,
                        ...options.headers,
                    },
                    body: imageBody(options.bytes ?? source),
                };
                return outputRoute.PUT(new Request(`http://localhost/api/maintenance/image-processing/${task.id}/outputs/${kind}${options.query ?? ""}`, init), { params: Promise.resolve({ id: task.id, kind }) });
            }

            function postComplete(task: ImageProcessingTask, body: unknown, authorization = `Bearer ${workerToken}`) {
                return completeRoute.POST(new Request(`http://localhost/api/maintenance/image-processing/${task.id}/complete`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) }), {
                    params: Promise.resolve({ id: task.id }),
                });
            }

            async function stagedPrepare() {
                const leased = await leasedPrepare();
                const artifact = await service.writeImageProcessingOutput(leased.task.id, "analysis", leased.identity, { stream: imageBody(), mimeType: "image/png" });
                return { ...leased, artifact, completion: prepareCompletion(leased.task, leased.identity, artifact) };
            }

            failureCases("prepare_reference", stagedPrepare);
            cancellationCases("prepare_reference", () => service.enqueueImageProcessingTask(input), stagedPrepare);
            cancelCloseCases("prepare_reference", () => service.enqueueImageProcessingTask(input), stagedPrepare);

            async function seedCompletedPrepareForRecovery() {
                const { task, identity } = await leasedPrepare();
                const { writeReferenceImageDataUrl } = await import("./reference-asset-store");
                const stored = await writeReferenceImageDataUrl(`data:image/png;base64,${source.toString("base64")}`, { ownerUserId: userId, source: "fixture-completed-prepare", conversationId: run.conversationId, runId: run.id, taskId: task.id });
                const artifact: StoredImageProcessingArtifact = { kind: "analysis", storageKey: stored.token, mimeType: "image/png", sha256: createHash("sha256").update(source).digest("hex"), bytes: source.length, width: 24, height: 18 };
                const completion = prepareCompletion(task, identity, artifact);
                const resultPayload = { executionId: identity.executionId, manifest: completion.manifest, manifestDigest: createHash("sha256").update(JSON.stringify(completion.manifest)).digest("hex"), metrics: completion.metrics };
                // Persist a completed restart fixture so the existing replay path can
                // show its own RED before the new completion skeleton is implemented.
                if (provider === "postgres")
                    await database.postgresQuery("UPDATE generation_tasks SET status = 'success', execution_phase = 'completed', result_payload = $2::jsonb, worker_id = NULL, lease_until = NULL WHERE id = $1 AND task_type = 'image_processing'", [
                        task.id,
                        JSON.stringify(resultPayload),
                    ]);
                else
                    await tasks.withGenerationTaskFileMutation(async (records) => ({
                        tasks: records.map((record) => (record.id === task.id ? { ...record, status: "success", executionPhase: "completed", resultPayload, workerId: undefined, leaseUntil: undefined } : record)),
                        result: undefined,
                    }));
                const { referenceSourcesLoaded } = await import("./ecommerce-reference-recovery");
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => {
                    assert(current.ecommerceSnapshot?.referenceCheckpoint && current.ecommerceSnapshot.processing);
                    const snapshot = current.ecommerceSnapshot;
                    return {
                        ...current,
                        ecommerceSnapshot: {
                            ...snapshot,
                            referenceCheckpoint: referenceSourcesLoaded(current.ecommerceSnapshot.referenceCheckpoint, [
                                { assetId: task.payload.inputs[0].assetId, contentSha256: completion.manifest.sourceIdentities[0].sha256, sourceSize: { width: 24, height: 18 } },
                            ]),
                            processing: {
                                ...current.ecommerceSnapshot.processing,
                                waitingFor: undefined,
                                prepareReferences: [{ jobId: task.id, inputDigest: task.payload.inputDigest, assetId: task.payload.inputs[0].assetId, assetVersion: task.payload.inputs[0].assetVersion, manifest: completion.manifest }],
                            },
                        },
                    };
                });
                return { task, completion };
            }

            it("registers an internal image file with its operation policy and preserves the original bytes", async () => {
                const filename = path.join(directory, `${randomUUID()}.png`);
                await writeFile(filename, source);
                try {
                    const { writeReferenceMediaFile, readReferenceAsset } = await import("./reference-asset-store");
                    const stored = await writeReferenceMediaFile(filename, "image", "image/png", false, { ownerUserId: userId, source: "image-processing-analysis", runId: run.id, maxBytes: 4 * 1024 * 1024 });
                    const registered = await readReferenceAsset(stored.token);
                    assert(registered);
                    expect(registered.registration).toMatchObject({ ownerUserId: userId, type: "image", mimeType: "image/png", bytes: source.length, runId: run.id });
                    expect(await readFile(registered.filePath)).toEqual(source);
                    expect(await readFile(filename)).toEqual(source);
                } finally {
                    await rm(filename, { force: true });
                }
            });

            it("streams a real PNG into a registered local artifact before associating it with this execution", async () => {
                const { task, identity } = await leasedPrepare();
                const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                const artifact = await service.writeImageProcessingOutput(task.id, "analysis", identity, { stream: imageBody(), mimeType: "image/png" });
                expect(artifact).toEqual({ kind: "analysis", storageKey: expect.any(String), sha256: createHash("sha256").update(source).digest("hex"), mimeType: "image/png", bytes: source.length, width: 24, height: 18 });
                const { getLocalMediaRegistration } = await import("./local-media-registry");
                expect(await getLocalMediaRegistration(artifact.storageKey)).toMatchObject({ ownerUserId: userId, scope: "reference", type: "image", runId: run.id, taskId: task.id, bytes: source.length, mimeType: "image/png" });
                const { readReferenceAsset } = await import("./reference-asset-store");
                const registered = await readReferenceAsset(artifact.storageKey);
                assert(registered);
                expect(await readFile(registered.filePath)).toEqual(source);
                const original = await service.readImageProcessingInput(task.id, task.payload.inputs[0].assetId, identity);
                expect(await imageProcessingStreamBytes(original.stream)).toEqual(source);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toMatchObject({ status: "running", resultPayload: { executionId: identity.executionId, artifacts: [artifact] } });
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
            });

            it.each([
                { mimeType: "image/jpeg", encode: () => sharp(source).jpeg().toBuffer() },
                { mimeType: "image/webp", encode: () => sharp(source).webp().toBuffer() },
                { mimeType: "image/gif", encode: () => sharp(source).gif().toBuffer() },
                { mimeType: "image/tiff", encode: () => sharp(source).tiff().toBuffer() },
                { mimeType: "image/avif", encode: () => sharp(source).avif().toBuffer() },
            ])("registers and reads the native prepare analysis format $mimeType without changing its bytes", async ({ mimeType, encode }) => {
                const bytes = await encode();
                const { task, identity } = await leasedPrepare();
                const artifact = await service.writeImageProcessingOutput(task.id, "analysis", identity, { stream: imageBody(bytes), mimeType });
                expect(artifact).toMatchObject({ mimeType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: 24, height: 18 });
                const { readReferenceAsset } = await import("./reference-asset-store");
                const stored = await readReferenceAsset(artifact.storageKey);
                assert(stored);
                expect(stored.mimeType).toBe(mimeType);
                expect(await readFile(stored.filePath)).toEqual(bytes);
            });

            it("accepts authenticated streamed PUT and JSON complete while returning only the internal stage result", async () => {
                const { task, identity } = await leasedPrepare();
                const uploaded = await putAnalysis(task, identity);
                expect(uploaded.status).toBe(201);
                const uploadBody = await uploaded.json();
                expect(uploadBody).toMatchObject({ code: 0, data: { kind: "analysis", width: 24, height: 18 } });
                const artifact: StoredImageProcessingArtifact = uploadBody.data;
                const completion = prepareCompletion(task, identity, artifact);
                const response = await postComplete(task, completion);
                expect(response.status).toBe(200);
                const body = await response.json();
                expect(body).toEqual({ code: 0, data: { jobId: task.id, inputDigest: task.payload.inputDigest, executionId: identity.executionId, manifest: completion.manifest, parentRescheduled: true }, msg: "OK" });
                expect(JSON.stringify(body)).not.toContain("parentExecutionId");
                expect(JSON.stringify(body)).not.toContain("ecommerceSnapshot");
            });

            it.each(["", "Bearer wrong-worker-token"])("rejects output with missing or wrong Worker Bearer (%s)", async (authorization) => {
                const { task, identity } = await leasedPrepare();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await putAnalysis(task, identity, { authorization });
                expect(response.status).toBe(401);
                await expect(response.json()).resolves.toMatchObject({ code: 401, data: null });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it.each(["", "Bearer wrong-worker-token"])("rejects complete with missing or wrong Worker Bearer (%s)", async (authorization) => {
                const { task, identity } = await leasedPrepare();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await postComplete(task, { ...identity, manifest: {}, metrics: {} }, authorization);
                expect(response.status).toBe(401);
                await expect(response.json()).resolves.toMatchObject({ code: 401, data: null });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("returns the existing 503 boundary for an unconfigured output Worker token", async () => {
                const { task, identity } = await leasedPrepare();
                vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "");
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await putAnalysis(task, identity);
                expect(response.status).toBe(503);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("returns the existing 503 boundary for an unconfigured complete Worker token", async () => {
                const { task, identity } = await leasedPrepare();
                vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "");
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await postComplete(task, identity);
                expect(response.status).toBe(503);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it.each<{ reason: string; options: OutputRequestOptions; status: number }>([
                { reason: "another operation's kind", options: { kind: "mask" }, status: 400 },
                { reason: "unknown kind", options: { kind: "native" }, status: 400 },
                { reason: "analysis result selector", options: { query: "?resultId=unfrozen-slot" }, status: 400 },
                { reason: "non-image content type", options: { mimeType: "application/octet-stream" }, status: 415 },
                { reason: "MIME/signature mismatch", options: { mimeType: "image/jpeg" }, status: 415 },
                { reason: "invalid image bytes", options: { bytes: Buffer.from("not-an-image") }, status: 400 },
                { reason: "missing Worker header", options: { headers: { "x-vozeb-pro-worker-id": "" } }, status: 400 },
                { reason: "missing epoch header", options: { headers: { "x-vozeb-pro-execution-id": "" } }, status: 400 },
            ])("rejects $reason without staging an artifact", async ({ options, status }) => {
                const { task, identity } = await leasedPrepare();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await putAnalysis(task, identity, options);
                expect(response.status).toBe(status);
                await expect(response.json()).resolves.toMatchObject({ code: status, data: null });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("applies the analysis 4MiB byte policy instead of the reference 20MiB limit", async () => {
                const { task, identity } = await leasedPrepare();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await putAnalysis(task, identity, { bytes: Buffer.concat([source, Buffer.alloc(4 * 1024 * 1024)]) });
                expect(response.status).toBe(413);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("rejects an analysis PNG whose actual dimension exceeds 2048", async () => {
                const bytes = await sharp({ create: { width: 1, height: 2049, channels: 3, background: "white" } })
                    .png()
                    .toBuffer();
                const { task, identity } = await leasedPrepare();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                expect((await putAnalysis(task, identity, { bytes })).status).toBe(400);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it.each([
                { reason: "another Worker", workerId: "foreign-worker", oldEpoch: false, expired: false, cancelled: false },
                { reason: "the same Worker's old epoch", workerId: "prepare-output-worker", oldEpoch: true, expired: false, cancelled: false },
                { reason: "expired lease", workerId: "prepare-output-worker", oldEpoch: false, expired: true, cancelled: false },
                { reason: "cancellation", workerId: "prepare-output-worker", oldEpoch: false, expired: false, cancelled: true },
            ])("rejects upload and complete after $reason without changing the current task", async ({ workerId, oldEpoch, expired, cancelled }) => {
                const { task, identity, completion } = await stagedPrepare();
                await setInputState(task, expired, cancelled);
                const attempted = { workerId, executionId: oldEpoch ? "old-prepare-epoch" : identity.executionId };
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                expect((await putAnalysis(task, attempted)).status).toBe(409);
                expect((await postComplete(task, { ...completion, ...attempted })).status).toBe(409);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
            });

            it("keeps one staged descriptor after a same-epoch same-bytes retry and accepts the first 201 descriptor", async () => {
                const { task, identity, artifact, completion } = await stagedPrepare();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const replay = await service.writeImageProcessingOutput(task.id, "analysis", identity, { stream: imageBody(), mimeType: "image/png" });
                expect(replay).toEqual(artifact);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
                await expect(service.completeImageProcessingTask(task.id, completion)).resolves.toMatchObject({ jobId: task.id, manifest: completion.manifest, parentRescheduled: true });
            });

            it("rejects a different hash for an already staged kind and preserves the first descriptor", async () => {
                const { task, identity, completion } = await stagedPrepare();
                const different = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#102030" } })
                    .png()
                    .toBuffer();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                await expect(service.writeImageProcessingOutput(task.id, "analysis", identity, { stream: imageBody(different), mimeType: "image/png" })).rejects.toMatchObject({ status: 409 });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
                await expect(service.completeImageProcessingTask(task.id, completion)).resolves.toMatchObject({ manifest: completion.manifest });
            });

            it("rechecks the lease after streaming without holding the database connection during the body read", async () => {
                const { task, identity } = await leasedPrepare();
                const started = Promise.withResolvers<void>();
                const release = Promise.withResolvers<void>();
                const stream = new ReadableStream<Uint8Array>(
                    {
                        async pull(controller) {
                            started.resolve();
                            controller.enqueue(source);
                            await release.promise;
                            controller.close();
                        },
                    },
                    { highWaterMark: 0 },
                );
                const upload = service.writeImageProcessingOutput(task.id, "analysis", identity, { stream, mimeType: "image/png" });
                try {
                    await Promise.race([
                        started.promise,
                        upload.then(() => {
                            throw new Error("Upload completed before the source stream reached EOF");
                        }),
                    ]);
                    expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toMatchObject({ id: run.id });
                    await setInputState(task, true, false);
                    const expired = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                    release.resolve();
                    await expect(upload).rejects.toMatchObject({ status: 409 });
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(expired);
                } finally {
                    release.resolve();
                    await upload.catch(() => undefined);
                }
            });

            it("does not let a new epoch complete using the old epoch's staged artifact", async () => {
                const { task, identity, completion } = await stagedPrepare();
                await setInputState(task, true, false);
                const claimed = await service.claimImageProcessingTasks({ workerId: identity.workerId, profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
                expect(claimed.tasks).toHaveLength(1);
                const executionId = claimed.tasks[0].executionId;
                expect(executionId).not.toBe(identity.executionId);
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                await expect(service.completeImageProcessingTask(task.id, { ...completion, executionId, manifest: { ...completion.manifest, executionId } })).rejects.toMatchObject({ status: 400 });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it.each([
                { reason: "another registered media key", change: (manifest: ImageProcessingManifest, task: ImageProcessingTask) => ({ ...manifest, artifacts: [{ ...manifest.artifacts[0], storageKey: task.payload.sources[0].storageKey }] }) },
                { reason: "forged artifact hash", change: (manifest: ImageProcessingManifest) => ({ ...manifest, artifacts: [{ ...manifest.artifacts[0], sha256: "0".repeat(64) }] }) },
                { reason: "wrong source asset", change: (manifest: ImageProcessingManifest) => ({ ...manifest, sourceIdentities: [{ ...manifest.sourceIdentities[0], assetId: "foreign-asset" }] }) },
                { reason: "wrong source v0", change: (manifest: ImageProcessingManifest) => ({ ...manifest, sourceIdentities: [{ ...manifest.sourceIdentities[0], assetVersion: "foreign-version" }] }) },
                { reason: "wrong source digest", change: (manifest: ImageProcessingManifest) => ({ ...manifest, sourceIdentities: [{ ...manifest.sourceIdentities[0], sha256: "0".repeat(64) }] }) },
                { reason: "wrong original job", change: (manifest: ImageProcessingManifest) => ({ ...manifest, jobId: "foreign-stage" }) },
                { reason: "missing analysis", change: (manifest: ImageProcessingManifest) => ({ ...manifest, artifacts: [] }) },
            ])("rejects complete with $reason without changing either truth record", async ({ change }) => {
                const { task, completion } = await stagedPrepare();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                await expect(service.completeImageProcessingTask(task.id, { ...completion, manifest: change(completion.manifest, task) })).rejects.toMatchObject({ status: 400 });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
            });

            it.each(["path", "signedUrl", "externalObjectKey"])("rejects a Worker-supplied %s field instead of persisting it", async (field) => {
                const { task, completion } = await stagedPrepare();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await postComplete(task, { ...completion, manifest: { ...completion.manifest, artifacts: [{ ...completion.manifest.artifacts[0], [field]: "untrusted-location" }] } });
                expect(response.status).toBe(400);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("uses the existing JSON-body boundary for malformed complete requests", async () => {
                const { task } = await leasedPrepare();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await completeRoute.POST(
                    new Request(`http://localhost/api/maintenance/image-processing/${task.id}/complete`, { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: "{" }),
                    { params: Promise.resolve({ id: task.id }) },
                );
                expect(response.status).toBe(400);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("rejects an unregistered manifest and does not publish a completed result", async () => {
                const { task, identity } = await leasedPrepare();
                const artifact: StoredImageProcessingArtifact = { kind: "analysis", storageKey: "temporary/unregistered.png", sha256: createHash("sha256").update(source).digest("hex"), mimeType: "image/png", bytes: source.length, width: 24, height: 18 };
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                await expect(service.completeImageProcessingTask(task.id, prepareCompletion(task, identity, artifact))).rejects.toMatchObject({ status: 400 });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
            });

            it("rejects an artifact whose actual media registration was reassigned to another user", async () => {
                const { task, artifact, completion } = await stagedPrepare();
                const { getLocalMediaRegistration, registerLocalMediaAsset } = await import("./local-media-registry");
                const registration = await getLocalMediaRegistration(artifact.storageKey);
                assert(registration);
                await registerLocalMediaAsset({ ...registration, ownerUserId: otherUserId });
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                await expect(service.completeImageProcessingTask(task.id, completion)).rejects.toMatchObject({ status: 400 });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it.each([
                { reason: "manifest", body: (completion: CompleteImageProcessingInput) => ({ ...completion, manifest: { ...completion.manifest, signedUrl: "untrusted-location" } }) },
                { reason: "metrics", body: (completion: CompleteImageProcessingInput) => ({ ...completion, metrics: { ...completion.metrics, secret: "untrusted-field" } }) },
            ])("rejects unexpected $reason fields at the complete boundary", async ({ body }) => {
                const { task, completion } = await stagedPrepare();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await postComplete(task, body(completion));
                expect(response.status).toBe(400);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("merges the current parent, binds the original v0 manifest and wakes only its matching dependency", async () => {
                const { task, identity, completion } = await stagedPrepare();
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => ({ ...current, prompt: "Parent changed after enqueue" }));
                const completed = await service.completeImageProcessingTask(task.id, completion);
                expect(completed).toEqual({ jobId: task.id, inputDigest: task.payload.inputDigest, executionId: identity.executionId, manifest: completion.manifest, parentRescheduled: true });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toMatchObject({
                    status: "success",
                    executionPhase: "completed",
                    resultPayload: { executionId: identity.executionId, manifest: completion.manifest, manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/), metrics: completion.metrics },
                });
                const child = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                expect(child?.workerId).toBeUndefined();
                expect(child?.leaseUntil).toBeUndefined();
                const parent = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                assert(parent?.ecommerceSnapshot?.referenceCheckpoint && parent.ecommerceSnapshot.processing);
                const sourceHash = createHash("sha256").update(source).digest("hex");
                const { referenceAssetVersion } = await import("./ecommerce-reference-recovery");
                expect(parent.prompt).toBe("Parent changed after enqueue");
                expect(parent.ecommerceSnapshot.referenceCheckpoint.assets[0]).toMatchObject({
                    assetVersion: referenceAssetVersion(parent.ecommerceSnapshot.referenceCheckpoint.assets[0].asset, sourceHash),
                    contentSha256: sourceHash,
                    asset: { width: 24, height: 18 },
                });
                expect(parent.ecommerceSnapshot.referenceCheckpoint.analysisStage.state).toBe("sources_loaded");
                expect(parent.ecommerceSnapshot.processing.prepareReferences).toEqual([
                    { jobId: task.id, inputDigest: task.payload.inputDigest, assetId: input.inputs[0].assetId, assetVersion: input.inputs[0].assetVersion, manifest: completion.manifest },
                ]);
                expect(parent.ecommerceSnapshot.processing.waitingFor).toBeUndefined();
                expect((await tasks.getStoredGenerationTaskRecord("agent", run.id))?.nextPollAt).toBeTypeOf("number");
                expect(parent.executionId).toBeUndefined();
                expect((await tasks.getStoredGenerationTaskRecord("image_processing", task.id))?.payload.inputs).toEqual(task.payload.inputs);
            });

            it.each([
                {
                    reason: "a new dependency",
                    change: (current: AgentRun): AgentRun => {
                        assert(current.ecommerceSnapshot?.processing);
                        return { ...current, ecommerceSnapshot: { ...current.ecommerceSnapshot, processing: { ...current.ecommerceSnapshot.processing, waitingFor: { jobId: "new-stage", inputDigest: "new-digest" } } } };
                    },
                },
                { reason: "parent cancellation", change: (current: AgentRun): AgentRun => ({ ...current, cancellation: { requestedAt: Date.now(), pendingChildTaskIds: [] } }) },
            ])("preserves a valid child result without changing or waking a parent with $reason", async ({ change }) => {
                const { task, completion } = await stagedPrepare();
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, change);
                const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                await expect(service.completeImageProcessingTask(task.id, completion)).resolves.toMatchObject({ manifest: completion.manifest, parentRescheduled: false });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toMatchObject({ status: "success", resultPayload: { manifest: completion.manifest } });
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
            });

            it("replays the same completed epoch and manifest read only and rejects a conflicting result", async () => {
                const { task, completion } = await stagedPrepare();
                const completed = await service.completeImageProcessingTask(task.id, completion);
                const child = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                const events = await runtime.listCreativeRunEvents(run.id);
                await expect(service.completeImageProcessingTask(task.id, completion)).resolves.toEqual(completed);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(child);
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
                expect(await runtime.listCreativeRunEvents(run.id)).toEqual(events);
                await expect(service.completeImageProcessingTask(task.id, { ...completion, manifest: { ...completion.manifest, geometry: { sourceSize: { width: 25, height: 18 } } } })).rejects.toMatchObject({ status: 409 });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(child);
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
            });

            it("recovers the original completed v0 prepare through its proven current v1 reference without rereading or rebuilding", async () => {
                const { task } = await seedCompletedPrepareForRecovery();
                const parent = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                assert(parent?.ecommerceSnapshot?.referenceCheckpoint);
                const current = parent.ecommerceSnapshot.referenceCheckpoint.assets[0];
                expect(current.assetVersion).not.toBe(input.inputs[0].assetVersion);
                const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const { readReferenceAsset } = await import("./reference-asset-store");
                const original = await readReferenceAsset(task.payload.sources[0].storageKey);
                assert(original);
                const heldPath = `${original.filePath}.held-${randomUUID()}`;
                await rename(original.filePath, heldPath);
                try {
                    const recovered = await service.enqueueImageProcessingTask({ ...input, inputs: [{ assetId: current.asset.id, assetVersion: current.assetVersion, expectedSha256: current.contentSha256 }] });
                    expect(recovered.id).toBe(task.id);
                    expect(recovered.payload.inputDigest).toBe(task.payload.inputDigest);
                    expect(recovered.payload.inputs).toEqual(task.payload.inputs);
                    expect(recovered.resultPayload).toEqual(beforeChild?.resultPayload);
                    expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(beforeChild);
                } finally {
                    await rename(heldPath, original.filePath);
                }
            });

            it("rejects a v1 recovery hash that conflicts with the completed v0 manifest", async () => {
                const { task, completion } = await seedCompletedPrepareForRecovery();
                const parent = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                assert(parent?.ecommerceSnapshot?.referenceCheckpoint);
                const current = parent.ecommerceSnapshot.referenceCheckpoint.assets[0];
                const before = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                await expect(service.enqueueImageProcessingTask({ ...input, inputs: [{ assetId: current.asset.id, assetVersion: current.assetVersion, expectedSha256: "0".repeat(64) }] })).rejects.toMatchObject({ status: 409 });
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(before);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toMatchObject({ status: "success", resultPayload: { manifest: completion.manifest } });
            });

            it("does not reuse a completed v0 prepare after the current reference source tuple changes", async () => {
                const { task } = await seedCompletedPrepareForRecovery();
                const { referenceAssetVersion } = await import("./ecommerce-reference-recovery");
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => {
                    assert(current.ecommerceSnapshot?.referenceCheckpoint);
                    const item = current.ecommerceSnapshot.referenceCheckpoint.assets[0];
                    const asset = { ...item.asset, serverUrl: "/api/reference-assets/replaced-source.png" };
                    return {
                        ...current,
                        ecommerceSnapshot: { ...current.ecommerceSnapshot, referenceCheckpoint: { ...current.ecommerceSnapshot.referenceCheckpoint, assets: [{ ...item, asset, assetVersion: referenceAssetVersion(asset, item.contentSha256) }] } },
                    };
                });
                const parent = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                assert(parent?.ecommerceSnapshot?.referenceCheckpoint);
                const changed = parent.ecommerceSnapshot.referenceCheckpoint.assets[0];
                const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                await expect(service.enqueueImageProcessingTask({ ...input, inputs: [{ assetId: changed.asset.id, assetVersion: changed.assetVersion, expectedSha256: changed.contentSha256 }] })).rejects.toMatchObject({ status: 409 });
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(beforeChild);
            });

            it("completes two real references in steps and marks sources_loaded only after both original prepare manifests exist", async () => {
                const secondBytes = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#102030" } })
                    .png()
                    .toBuffer();
                const { writeReferenceImageDataUrl } = await import("./reference-asset-store");
                const stored = await writeReferenceImageDataUrl(`data:image/png;base64,${secondBytes.toString("base64")}`, { ownerUserId: userId, conversationId: run.conversationId, source: "fixture-image-processing" });
                const [secondAsset] = await runtime.registerCreativeAssets([
                    {
                        id: `fixture-reference-${randomUUID()}`,
                        userId,
                        conversationId: run.conversationId,
                        ordinal: 1,
                        type: "image",
                        title: "second.png",
                        sourceRunId: `fixture-upload-${randomUUID()}`,
                        serverUrl: `/api/reference-assets/${stored.token}`,
                        metadata: {},
                    },
                ]);
                assert(run.ecommerceSnapshot?.referenceCheckpoint);
                const firstAsset = run.ecommerceSnapshot.referenceCheckpoint.assets[0].asset;
                const twoReferenceRun = { ...run, referencedAssetIds: [firstAsset.id, secondAsset.id] };
                const { buildEcommercePlanningInput } = await import("./ecommerce-generation-snapshot");
                const { createEcommerceReferenceCheckpoint, referenceAssetVersion } = await import("./ecommerce-reference-recovery");
                const planning = buildEcommercePlanningInput(twoReferenceRun, [firstAsset, secondAsset], { summary: "", recentMessages: [] });
                const checkpoint = createEcommerceReferenceCheckpoint(twoReferenceRun, planning, [firstAsset, secondAsset]);
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => {
                    assert(current.ecommerceSnapshot);
                    return {
                        ...current,
                        referencedAssetIds: [firstAsset.id, secondAsset.id],
                        ecommerceSnapshot: { ...current.ecommerceSnapshot, input: { ...current.ecommerceSnapshot.input, assetIds: [firstAsset.id, secondAsset.id] }, referenceCheckpoint: checkpoint },
                    };
                });
                const firstInput = { ...input, inputs: [{ assetId: firstAsset.id, assetVersion: checkpoint.assets[0].assetVersion }] };
                const first = await leasedPrepare(firstInput);
                const firstArtifact = await service.writeImageProcessingOutput(first.task.id, "analysis", first.identity, { stream: imageBody(), mimeType: "image/png" });
                const firstCompletion = prepareCompletion(first.task, first.identity, firstArtifact);
                await service.completeImageProcessingTask(first.task.id, firstCompletion);
                const afterFirst = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                assert(afterFirst?.ecommerceSnapshot?.referenceCheckpoint && afterFirst.ecommerceSnapshot.processing);
                const firstHash = createHash("sha256").update(source).digest("hex");
                expect(afterFirst.ecommerceSnapshot.referenceCheckpoint.assets[0]).toMatchObject({ contentSha256: firstHash, assetVersion: referenceAssetVersion(firstAsset, firstHash), asset: { width: 24, height: 18 } });
                expect(afterFirst.ecommerceSnapshot.referenceCheckpoint.assets[1]).toEqual(checkpoint.assets[1]);
                expect(afterFirst.ecommerceSnapshot.referenceCheckpoint.analysisStage).toEqual(checkpoint.analysisStage);
                expect(afterFirst.ecommerceSnapshot.referenceCheckpoint.analysisStage.state).toBe("created");
                expect(afterFirst.ecommerceSnapshot.processing.prepareReferences).toEqual([
                    { jobId: first.task.id, inputDigest: first.task.payload.inputDigest, assetId: firstAsset.id, assetVersion: checkpoint.assets[0].assetVersion, manifest: firstCompletion.manifest },
                ]);
                const completedFirst = await tasks.getStoredGenerationTaskRecord("image_processing", first.task.id);

                const resumedExecutionId = randomUUID();
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => ({ ...current, executionId: resumedExecutionId }));
                const resumed = await scheduler.claimDueGenerationTasks({ workerId: "fixture-parent-worker", taskIds: [run.id], limit: 1 });
                expect(resumed.map((item) => item.id)).toEqual([run.id]);
                const secondInput = { ...input, parentExecutionId: resumedExecutionId, inputs: [{ assetId: secondAsset.id, assetVersion: checkpoint.assets[1].assetVersion }] };
                const second = await leasedPrepare(secondInput);
                const secondArtifact = await service.writeImageProcessingOutput(second.task.id, "analysis", second.identity, { stream: imageBody(secondBytes), mimeType: "image/png" });
                const secondCompletion = prepareCompletion(second.task, second.identity, secondArtifact, secondBytes);
                await service.completeImageProcessingTask(second.task.id, secondCompletion);
                const afterSecond = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                assert(afterSecond?.ecommerceSnapshot?.referenceCheckpoint && afterSecond.ecommerceSnapshot.processing);
                const secondHash = createHash("sha256").update(secondBytes).digest("hex");
                expect(afterSecond.ecommerceSnapshot.referenceCheckpoint.assets[0]).toEqual(afterFirst.ecommerceSnapshot.referenceCheckpoint.assets[0]);
                expect(afterSecond.ecommerceSnapshot.referenceCheckpoint.assets[1]).toMatchObject({ contentSha256: secondHash, assetVersion: referenceAssetVersion(secondAsset, secondHash), asset: { width: 24, height: 18 } });
                expect(afterSecond.ecommerceSnapshot.referenceCheckpoint.analysisStage).toEqual({ ...checkpoint.analysisStage, state: "sources_loaded" });
                expect(afterSecond.ecommerceSnapshot.processing.prepareReferences).toEqual([
                    { jobId: first.task.id, inputDigest: first.task.payload.inputDigest, assetId: firstAsset.id, assetVersion: checkpoint.assets[0].assetVersion, manifest: firstCompletion.manifest },
                    { jobId: second.task.id, inputDigest: second.task.payload.inputDigest, assetId: secondAsset.id, assetVersion: checkpoint.assets[1].assetVersion, manifest: secondCompletion.manifest },
                ]);
                expect(afterSecond.ecommerceSnapshot.processing.waitingFor).toBeUndefined();
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", first.task.id)).toEqual(completedFirst);
                expect((await tasks.getStoredGenerationTaskRecord("image_processing", second.task.id))?.payload.inputs).toEqual(second.task.payload.inputs);
                await expect(service.enqueueImageProcessingTask({ ...firstInput, inputs: [{ assetId: firstAsset.id, assetVersion: referenceAssetVersion(firstAsset, firstHash), expectedSha256: firstHash }] })).resolves.toMatchObject({
                    id: first.task.id,
                    payload: { inputDigest: first.task.payload.inputDigest },
                });
                await expect(service.enqueueImageProcessingTask({ ...secondInput, inputs: [{ assetId: secondAsset.id, assetVersion: referenceAssetVersion(secondAsset, secondHash), expectedSha256: secondHash }] })).resolves.toMatchObject({
                    id: second.task.id,
                    payload: { inputDigest: second.task.payload.inputDigest },
                });
            });

            if (provider === "postgres") {
                it.each(["parent", "child"])("rolls back both completion truth records when a named PostgreSQL CHECK rejects the %s write", async (target) => {
                    const { task, completion } = await stagedPrepare();
                    const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                    const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                    const constraint = `fixture_prepare_complete_${randomUUID().replaceAll("-", "")}`;
                    const predicate = target === "parent" ? `id <> '${run.id}' OR payload #> '{ecommerceSnapshot,processing,waitingFor}' IS NOT NULL` : `id <> '${task.id}' OR status <> 'success'`;
                    await database.postgresQuery(`ALTER TABLE generation_tasks ADD CONSTRAINT ${constraint} CHECK (${predicate})`);
                    try {
                        await expect(service.completeImageProcessingTask(task.id, completion)).rejects.toMatchObject({ code: "23514", constraint });
                        expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(beforeChild);
                        const { getLocalMediaRegistration } = await import("./local-media-registry");
                        expect(await getLocalMediaRegistration(completion.manifest.artifacts[0].storageKey)).toMatchObject({ ownerUserId: userId, taskId: task.id });
                    } finally {
                        await database.postgresQuery(`ALTER TABLE generation_tasks DROP CONSTRAINT ${constraint}`);
                    }
                });
            }
        });

        describe("image processing build protection enqueue", () => {
            const white: Extract<ImageProcessingProtectionOptions, { transparentBackground: boolean }> = { transparentBackground: false };
            const local: Extract<ImageProcessingProtectionOptions, { mode: "local_edit" }> = { mode: "local_edit", targetRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, protectedRectangles: [{ x: 0, y: 0, width: 4, height: 4 }] };
            const scene: Extract<ImageProcessingProtectionOptions, { mode: "scene_selection" }> = { mode: "scene_selection", region: { x: 4, y: 3, width: 8, height: 6 }, semantics: ["add a lamp and contact shadow"], selectionSource: "user_selection" };
            type ProtectionInput = Extract<EnqueueImageProcessingInput, { operation: "build_protection" }>;

            beforeEach(async () => {
                await clearInternalFixtureTasks();
            });

            function qualifiedLocal(assetId: string): Extract<ImageProcessingProtectionOptions, { mode: "local_edit" }> {
                return { ...local, freezeEnhancementBaseline: { productAnchorId: assetId, productCore: [{ x: 0, y: 0, width: 2, height: 2 }] } };
            }

            async function resumeProtectionParent(options: ImageProcessingProtectionOptions) {
                const current = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                assert(current?.ecommerceSnapshot?.referenceCheckpoint);
                const reference = current.ecommerceSnapshot.referenceCheckpoint.assets[0];
                const parentExecutionId = randomUUID();
                const plan: EcommerceEditPlan = {
                    planVersion: "ecommerce-edit.v6",
                    operation: "mode" in options ? (options.mode === "local_edit" ? "local_edit" : "scene_edit") : "product_to_scene",
                    source: { productAnchorId: reference.asset.id, currentSceneBaselineId: "mode" in options ? reference.asset.id : null, sceneReferenceIds: [] },
                    baseline: { productFacts: null, sceneFacts: null },
                    delta: { requestedChanges: "mode" in options && options.mode === "scene_selection" ? [...options.semantics] : ["change the background"], targetObjects: [], targetRegions: [] },
                    preserve: { productCore: ["outline"], sceneElements: [] },
                    strategy: "strict_product",
                    modelRoles: { visionAnalysis: "fixture-vision", editPlanning: "fixture-planning", generation: "fixture-image", qualityCheck: null },
                    continuity: { parentResultId: null, branchId: "fixture-protection-branch" },
                    validation: { requiredChecks: ["preserve_source_pixels"] },
                };
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (parent) => {
                    assert(parent.ecommerceSnapshot);
                    return { ...parent, executionId: parentExecutionId, ecommerceSnapshot: { ...parent.ecommerceSnapshot, plan, modelRoles: plan.modelRoles, modelRouteSnapshots: {}, stageTimings: { analysisCompletedAt: 1, planningCompletedAt: 2 } } };
                });
                await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
                const claimed = await scheduler.claimDueGenerationTasks({ workerId: "fixture-protection-parent-worker", taskIds: [run.id], limit: 1 });
                expect(claimed.map((task) => task.id)).toEqual([run.id]);
                const buildInput: ProtectionInput = {
                    runId: run.id,
                    parentExecutionId,
                    algorithmVersion: "fixture-protection-policy.v1",
                    operation: "build_protection",
                    inputs: [{ assetId: reference.asset.id, assetVersion: reference.assetVersion, expectedSha256: reference.contentSha256 }],
                    options,
                };
                return { buildInput, plan };
            }

            async function protectionFixture(options: ImageProcessingProtectionOptions = white) {
                const leased = await leasedPrepare();
                const artifact = await service.writeImageProcessingOutput(leased.task.id, "analysis", leased.identity, { stream: imageBody(), mimeType: "image/png" });
                const completion = prepareCompletion(leased.task, leased.identity, artifact);
                await service.completeImageProcessingTask(leased.task.id, completion);
                const preparedRecord = await tasks.getStoredGenerationTaskRecord("image_processing", leased.task.id);
                assert(preparedRecord);
                return { ...(await resumeProtectionParent(options)), prepare: leased.task, preparedRecord, manifest: completion.manifest };
            }

            async function expectProtectionRejected(buildInput: ProtectionInput) {
                const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                const children = await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId]);
                await expect(service.enqueueImageProcessingTask(buildInput)).rejects.toMatchObject({ status: 409 });
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
                expect(await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).toEqual(children);
            }

            it.each<{ policy: string; options: (assetId: string) => ImageProcessingProtectionOptions }>([
                { policy: "white opaque", options: () => white },
                { policy: "white transparent", options: () => ({ transparentBackground: true }) },
                { policy: "white detail framing", options: () => ({ transparentBackground: false, sourceFraming: "visible_extent" }) },
                { policy: "white qualified baseline", options: () => ({ ...white, freezeEnhancementBaseline: true }) },
                { policy: "local normalized target and pixel protection", options: () => local },
                { policy: "local qualified pixel core", options: qualifiedLocal },
                { policy: "scene confirmed pixel selection", options: () => scene },
                { policy: "scene qualified baseline", options: () => ({ ...scene, freezeEnhancementBaseline: true }) },
            ])("enqueues $policy using the completed source's v1 facts while preserving its original prepare", async ({ options }) => {
                const { buildInput, prepare, preparedRecord, manifest, plan } = await protectionFixture(options(input.inputs[0].assetId));
                const previousParent = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                assert(previousParent?.ecommerceSnapshot?.processing);
                const task = await service.enqueueImageProcessingTask(buildInput);
                const sha256 = createHash("sha256").update(source).digest("hex");
                expect(task.id).toMatch(/^image-process-[a-f0-9]{64}$/);
                expect(task.id).toBe(`image-process-${task.payload.inputDigest}`);
                expect(task.id).not.toBe(prepare.id);
                expect(task).toMatchObject({
                    type: "image_processing",
                    status: "pending",
                    executionPhase: "created",
                    attemptNo: 0,
                    clientRequestId: task.payload.inputDigest,
                    userId,
                    runId: run.id,
                    payload: {
                        operation: "build_protection",
                        algorithmVersion: buildInput.algorithmVersion,
                        inputs: buildInput.inputs,
                        options: buildInput.options,
                        resource: {
                            requiredMemoryBytes: 141 * 1024 * 1024,
                            facts: {
                                encodedInputs: [{ inputIndex: 0, assetId: buildInput.inputs[0].assetId, assetVersion: buildInput.inputs[0].assetVersion, sha256, bytes: source.length, layout: { format: "png", depth: "uchar", channels: 3 } }],
                                decodedInputs: [{ inputIndex: 0, assetId: buildInput.inputs[0].assetId, assetVersion: buildInput.inputs[0].assetVersion, sha256, width: 24, height: 18 }],
                            },
                        },
                    },
                });
                expect(task.payload.sources).toEqual(prepare.payload.sources);
                expect(task.workerId).toBeUndefined();
                expect(task.leaseUntil).toBeUndefined();
                expect(task.estimatedPoints).toBeUndefined();
                expect(task.payload.inputs[0].assetVersion).not.toBe(prepare.payload.inputs[0].assetVersion);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toEqual(preparedRecord);
                const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                expect(parent).toMatchObject({
                    status: "running",
                    payload: {
                        ecommerceSnapshot: {
                            plan,
                            modelRoles: plan.modelRoles,
                            modelRouteSnapshots: {},
                            stageTimings: { analysisCompletedAt: 1, planningCompletedAt: 2 },
                            processing: {
                                prepareReferences: previousParent.ecommerceSnapshot.processing.prepareReferences,
                                protection: { jobId: task.id, inputDigest: task.payload.inputDigest },
                                waitingFor: { jobId: task.id, inputDigest: task.payload.inputDigest },
                            },
                        },
                    },
                });
                expect(parent?.payload.executionId).toBeUndefined();
                expect(parent?.nextPollAt).toBeUndefined();
                expect(parent?.workerId).toBeUndefined();
                expect(parent?.leaseUntil).toBeUndefined();
                expect(manifest.sourceIdentities[0].assetVersion).toBe(prepare.payload.inputs[0].assetVersion);
                expect(task.payload.resource.facts.decodedInputs[0].assetVersion).toBe(buildInput.inputs[0].assetVersion);
                expect((await tasks.getStoredGenerationTask<AgentRun>("agent", run.id))?.ecommerceSnapshot?.referenceCheckpoint).toEqual(previousParent.ecommerceSnapshot.referenceCheckpoint);
            });

            it("rejects creating a native product child that drops its frozen generation execution", async () => {
                await protectionFixture();
                const execution: import("./ecommerce-image-compiler").EcommerceCompiledImageRequest = {
                    state: "ready",
                    compilerVersion: "ecommerce-openai-image-2.5.v1",
                    providerProfileId: "gpt-image-2.5-sunburst",
                    prompt: "fixture product",
                    referenceRoles: [],
                    parameters: { variant: "gpt-image-2.5-sunburst" },
                    modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "fixture-image", channelId: "fixture-image", upstreamModel: "gpt-image-2.5-sunburst", apiFormat: "openai" },
                    generationInput: { bounds: { width: 12, height: 12 }, quality: "high" },
                };
                const parent = await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => {
                    assert(current.ecommerceSnapshot?.referenceCheckpoint);
                    return {
                        ...current,
                        status: "running",
                        executionId: "fixture-product-dispatch",
                        tasks: [{ id: "ecommerce-product-scene", type: "image", title: "fixture product", prompt: execution.prompt, count: 1, attempts: 1, status: "running", dependencies: [], ecommerceExecution: execution }],
                        ecommerceSnapshot: {
                            ...current.ecommerceSnapshot,
                            referenceCheckpoint: { ...current.ecommerceSnapshot.referenceCheckpoint, state: "resolved", analysisStage: { ...current.ecommerceSnapshot.referenceCheckpoint.analysisStage, state: "completed" } },
                        },
                    };
                });
                assert(parent?.ecommerceSnapshot?.referenceCheckpoint);
                const checkpoint = parent.ecommerceSnapshot.referenceCheckpoint;
                const child = {
                    id: randomUUID(),
                    userId,
                    status: "pending",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    runId: run.id,
                    conversationId: run.conversationId,
                    parentTaskId: "ecommerce-product-scene",
                    attemptNo: 1,
                    clientRequestId: `${parent.clientRequestId}:ecommerce-product-scene:1:1`,
                };
                const referenceDispatch = { executionId: "fixture-product-dispatch", inputId: checkpoint.inputId, decisionId: checkpoint.decisionId, analysisRequestId: checkpoint.analysisStage.requestId, copy: 1 };
                await expect(tasks.createStoredGenerationTask("image", child, 60_000, { referenceDispatch })).rejects.toThrow("参考任务派发身份已失效");
                expect(await tasks.getStoredGenerationTaskRecord("image", child.id)).toBeNull();
                expect(await tasks.createStoredGenerationTask("image", { ...child, ecommerceExecution: execution }, 60_000, { referenceDispatch })).toMatchObject({ id: child.id, ecommerceExecution: execution });
            });

            it("resolves an omitted source hash from the completed prepare instead of weakening the new stage identity", async () => {
                const { buildInput, prepare, preparedRecord } = await protectionFixture();
                const task = await service.enqueueImageProcessingTask({ ...buildInput, inputs: [{ assetId: buildInput.inputs[0].assetId, assetVersion: buildInput.inputs[0].assetVersion }] });
                expect(task.payload.inputs[0]).toEqual(buildInput.inputs[0]);
                expect(task.payload.resource.facts.decodedInputs).toEqual([
                    { inputIndex: 0, assetId: buildInput.inputs[0].assetId, assetVersion: buildInput.inputs[0].assetVersion, sha256: createHash("sha256").update(source).digest("hex"), width: 24, height: 18 },
                ]);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toEqual(preparedRecord);
            });

            it("replays the same protection request read only after the parent yields", async () => {
                const { buildInput } = await protectionFixture(local);
                const first = await service.enqueueImageProcessingTask(buildInput);
                const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                const children = await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId]);
                expect(await service.enqueueImageProcessingTask(buildInput)).toEqual(first);
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
                expect(await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).toEqual(children);
            });

            it("uses the same protection fingerprint when JSON object keys are reordered", async () => {
                const { buildInput } = await protectionFixture(local);
                const first = await service.enqueueImageProcessingTask(buildInput);
                const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                const reordered: ImageProcessingProtectionOptions = { protectedRectangles: [{ height: 4, width: 4, y: 0, x: 0 }], targetRegion: { height: 0.5, width: 0.5, y: 0.25, x: 0.25 }, mode: "local_edit" };
                expect(await service.enqueueImageProcessingTask({ ...buildInput, options: reordered })).toEqual(first);
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
            });

            it.each<{ change: string; first: (assetId: string) => ImageProcessingProtectionOptions; second: (assetId: string) => ImageProcessingProtectionOptions }>([
                { change: "white transparency policy", first: () => white, second: () => ({ transparentBackground: true }) },
                { change: "white baseline policy", first: () => white, second: () => ({ ...white, freezeEnhancementBaseline: true }) },
                { change: "normalized local target", first: () => local, second: () => ({ ...local, targetRegion: { x: 0.5, y: 0.25, width: 0.25, height: 0.5 } }) },
                { change: "pixel protection rectangle", first: () => local, second: () => ({ ...local, protectedRectangles: [{ x: 1, y: 0, width: 4, height: 4 }] }) },
                { change: "qualified pixel core", first: qualifiedLocal, second: (assetId) => ({ ...local, freezeEnhancementBaseline: { productAnchorId: assetId, productCore: [{ x: 0, y: 0, width: 3, height: 2 }] } }) },
                { change: "scene pixel selection", first: () => scene, second: () => ({ ...scene, region: { x: 4, y: 3, width: 9, height: 6 } }) },
                { change: "scene requested semantics", first: () => scene, second: () => ({ ...scene, semantics: ["change the contact shadow"] }) },
                { change: "scene baseline policy", first: () => scene, second: () => ({ ...scene, freezeEnhancementBaseline: true }) },
            ])("creates a different protection stage for changed $change", async ({ first, second }) => {
                const { buildInput, prepare, preparedRecord } = await protectionFixture(first(input.inputs[0].assetId));
                const original = await service.enqueueImageProcessingTask(buildInput);
                const originalRecord = await tasks.getStoredGenerationTaskRecord("image_processing", original.id);
                const resumed = await resumeProtectionParent(second(input.inputs[0].assetId));
                const changed = await service.enqueueImageProcessingTask(resumed.buildInput);
                expect(changed.id).not.toBe(original.id);
                expect(changed.payload.inputDigest).not.toBe(original.payload.inputDigest);
                expect(changed.payload.options).toEqual(resumed.buildInput.options);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", original.id)).toEqual(originalRecord);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toEqual(preparedRecord);
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toMatchObject({
                    payload: { ecommerceSnapshot: { processing: { protection: { jobId: changed.id, inputDigest: changed.payload.inputDigest }, waitingFor: { jobId: changed.id, inputDigest: changed.payload.inputDigest } } } },
                });
            });

            it("binds a changed protection algorithm version to a new stage", async () => {
                const { buildInput } = await protectionFixture();
                const original = await service.enqueueImageProcessingTask(buildInput);
                const resumed = await resumeProtectionParent(white);
                const changed = await service.enqueueImageProcessingTask({ ...resumed.buildInput, algorithmVersion: "fixture-protection-policy.v2" });
                expect(changed.id).not.toBe(original.id);
                expect(changed.payload.algorithmVersion).toBe("fixture-protection-policy.v2");
            });

            it("rejects a metadata/staged analysis receipt whose prepare has not actually completed", async () => {
                const leased = await leasedPrepare();
                const artifact = await service.writeImageProcessingOutput(leased.task.id, "analysis", leased.identity, { stream: imageBody(), mimeType: "image/png" });
                const completion = prepareCompletion(leased.task, leased.identity, artifact);
                const { referenceSourcesLoaded } = await import("./ecommerce-reference-recovery");
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => {
                    assert(current.ecommerceSnapshot?.referenceCheckpoint && current.ecommerceSnapshot.processing);
                    return {
                        ...current,
                        ecommerceSnapshot: {
                            ...current.ecommerceSnapshot,
                            referenceCheckpoint: referenceSourcesLoaded(current.ecommerceSnapshot.referenceCheckpoint, [
                                { assetId: input.inputs[0].assetId, contentSha256: createHash("sha256").update(source).digest("hex"), sourceSize: { width: 24, height: 18 } },
                            ]),
                            processing: {
                                ...current.ecommerceSnapshot.processing,
                                prepareReferences: [{ jobId: leased.task.id, inputDigest: leased.task.payload.inputDigest, assetId: input.inputs[0].assetId, assetVersion: input.inputs[0].assetVersion, manifest: completion.manifest }],
                            },
                        },
                    };
                });
                const { buildInput } = await resumeProtectionParent(white);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", leased.task.id)).toMatchObject({ status: "running", resultPayload: { artifacts: [artifact] } });
                await expectProtectionRejected(buildInput);
            });

            it("rejects a v1 source without its preserved completed prepare reference", async () => {
                const { buildInput } = await protectionFixture();
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => {
                    assert(current.ecommerceSnapshot?.processing);
                    return { ...current, ecommerceSnapshot: { ...current.ecommerceSnapshot, processing: { ...current.ecommerceSnapshot.processing, prepareReferences: [] } } };
                });
                await expectProtectionRejected(buildInput);
            });

            it("rejects a preserved prepare reference whose actual successful child no longer has its completion manifest", async () => {
                const { buildInput, prepare } = await protectionFixture();
                await scheduler.scheduleGenerationTask("image_processing", prepare.id, { resultPayload: { executionId: "missing-completion-receipt" } });
                await expectProtectionRejected(buildInput);
            });

            it("rejects a source hash that conflicts with the completed prepare", async () => {
                const { buildInput } = await protectionFixture();
                await expectProtectionRejected({ ...buildInput, inputs: [{ ...buildInput.inputs[0], expectedSha256: "0".repeat(64) }] });
            });

            it("rejects the original prepare version as the source of a new v1 protection stage", async () => {
                const { buildInput, prepare } = await protectionFixture();
                await expectProtectionRejected({ ...buildInput, inputs: prepare.payload.inputs });
            });

            it("rejects a reference source tuple changed after the completed prepare", async () => {
                const { buildInput } = await protectionFixture();
                const { referenceAssetVersion } = await import("./ecommerce-reference-recovery");
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => {
                    assert(current.ecommerceSnapshot?.referenceCheckpoint);
                    const item = current.ecommerceSnapshot.referenceCheckpoint.assets[0];
                    const asset = { ...item.asset, serverUrl: "/api/reference-assets/replaced-protection-source.png" };
                    return {
                        ...current,
                        ecommerceSnapshot: { ...current.ecommerceSnapshot, referenceCheckpoint: { ...current.ecommerceSnapshot.referenceCheckpoint, assets: [{ ...item, asset, assetVersion: referenceAssetVersion(asset, item.contentSha256) }] } },
                    };
                });
                const current = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                assert(current?.ecommerceSnapshot?.referenceCheckpoint);
                const reference = current.ecommerceSnapshot.referenceCheckpoint.assets[0];
                await expectProtectionRejected({ ...buildInput, inputs: [{ assetId: reference.asset.id, assetVersion: reference.assetVersion, expectedSha256: reference.contentSha256 }] });
            });

            it.each([
                { field: "provider", change: (registration: LocalMediaRegistration): LocalMediaRegistration => ({ ...registration, storageProvider: "object", externalStorageId: "changed-storage" }) },
                { field: "owner", change: (registration: LocalMediaRegistration): LocalMediaRegistration => ({ ...registration, ownerUserId: otherUserId }) },
            ])("rejects a completed source whose registered $field changed", async ({ change }) => {
                const { buildInput, prepare } = await protectionFixture();
                const { getLocalMediaRegistration, registerLocalMediaAsset } = await import("./local-media-registry");
                const registration = await getLocalMediaRegistration(prepare.payload.sources[0].storageKey);
                assert(registration);
                await registerLocalMediaAsset(change(registration));
                await expectProtectionRejected(buildInput);
            });

            it("rejects a stale parent execution without adding protection or changing its completed prepare", async () => {
                const { buildInput } = await protectionFixture();
                await expectProtectionRejected({ ...buildInput, parentExecutionId: "stale-protection-parent-execution" });
            });

            it("rejects new protection enqueue when the current parent has cancellation", async () => {
                const { buildInput } = await protectionFixture();
                await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => ({ ...current, cancellation: { requestedAt: Date.now(), pendingChildTaskIds: [] } }));
                await expectProtectionRejected(buildInput);
            });

            it("atomically pauses protection and its parent when the current total budget cannot fit the completed-source requirement", async () => {
                const { buildInput, prepare, preparedRecord } = await protectionFixture();
                vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "128");
                const task = await service.enqueueImageProcessingTask(buildInput);
                expect(task).toMatchObject({
                    status: "paused",
                    executionPhase: "needs_review",
                    payload: {
                        operation: "build_protection",
                        resource: { requiredMemoryBytes: 141 * 1024 * 1024, configuration: { budgetBytes: 128 * 1024 * 1024 }, unavailable: { code: "image_processing_resource_unavailable", reason: "exceeds_total_budget" } },
                    },
                });
                expect(task.nextPollAt).toBeUndefined();
                expect(task.workerId).toBeUndefined();
                expect(task.leaseUntil).toBeUndefined();
                const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                expect(parent).toMatchObject({
                    status: "paused",
                    executionPhase: "needs_review",
                    lastUpstreamStatus: "image_processing_resource_unavailable",
                    payload: { status: "paused", ecommerceSnapshot: { processing: { protection: { jobId: task.id, inputDigest: task.payload.inputDigest }, waitingFor: { jobId: task.id, inputDigest: task.payload.inputDigest } } } },
                });
                expect(parent?.payload.executionId).toBeUndefined();
                expect(parent?.nextPollAt).toBeUndefined();
                expect(parent?.workerId).toBeUndefined();
                expect(parent?.leaseUntil).toBeUndefined();
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepare.id)).toEqual(preparedRecord);
            });

            describe("image processing protection mask upload and complete", () => {
                const workerToken = "fixture-image-worker-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                const metrics = { pid: process.pid, peakRssBytes: 64 * 1024 * 1024, peakHeapUsedBytes: 8 * 1024 * 1024, peakExternalBytes: 4 * 1024 * 1024, elapsedMs: 12 };
                let opaqueProduct: Buffer;
                let transparentProduct: Buffer;
                let largeSource: Buffer;
                let largeMask: Buffer;
                let operations: typeof import("@/lib/image-processing/operations");
                let outputRoute: typeof import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route");
                let completeRoute: typeof import("@/app/api/maintenance/image-processing/[id]/complete/route");

                beforeAll(async () => {
                    [operations, outputRoute, completeRoute] = await Promise.all([
                        import("@/lib/image-processing/operations"),
                        import("@/app/api/maintenance/image-processing/[id]/outputs/[kind]/route"),
                        import("@/app/api/maintenance/image-processing/[id]/complete/route"),
                    ]);
                    const product = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#42688a" } })
                        .png()
                        .toBuffer();
                    opaqueProduct = await sharp({ create: { width: 24, height: 18, channels: 4, background: "#ffffff" } })
                        .composite([{ input: product, left: 8, top: 5 }])
                        .png()
                        .toBuffer();
                    transparentProduct = await sharp({ create: { width: 24, height: 18, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
                        .composite([{ input: product, left: 8, top: 5 }])
                        .png()
                        .toBuffer();
                    largeSource = await sharp({ create: { width: 2300, height: 2300, channels: 4, background: "#42688a" } })
                        .png()
                        .toBuffer();
                    const { buildLocalEditMask } = await import("@/lib/image-processing/protection-masks");
                    const pixels = await buildLocalEditMask({ width: 2300, height: 2300 }, local.targetRegion, local.protectedRectangles);
                    // One real low-compression PNG exercises encoded transport policy;
                    // its alpha pixels are those of the actual local-mask producer.
                    largeMask = await sharp(pixels).png({ compressionLevel: 0 }).toBuffer();
                });

                beforeEach(() => {
                    vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
                    vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-maintenance-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
                });

                async function nativeArtifact(task: Pick<ImageProcessingTask, "id" | "payload">, identity: { workerId: string; executionId: string }) {
                    const { readReferenceAsset } = await import("./reference-asset-store");
                    const original = await readReferenceAsset(task.payload.sources[0].storageKey);
                    assert(original);
                    const outputDirectory = await mkdtemp(path.join(directory, "native-mask-fixture-"));
                    const result = await operations.executeImageProcessing({ ...task.payload, jobId: task.id, executionId: identity.executionId, inputs: [{ ...task.payload.inputs[0], path: original.filePath }], outputDirectory }, () => {});
                    const artifact = result.artifacts[0];
                    return { result, path: artifact.path, bytes: await readFile(artifact.path) };
                }

                async function leasedMask(options: (assetId: string) => ImageProcessingProtectionOptions = () => local, bytes = opaqueProduct) {
                    ({ run, input } = await seedReference(userId, bytes));
                    const prepare = await leasedPrepare();
                    const prepared = await nativeArtifact(prepare.task, prepare.identity);
                    const analysis = await service.writeImageProcessingOutput(prepare.task.id, "analysis", prepare.identity, { stream: imageBody(prepared.bytes), mimeType: prepared.result.artifacts[0].mimeType });
                    const prepareInput: CompleteImageProcessingInput = { ...prepare.identity, manifest: { ...prepared.result, artifacts: [analysis] }, metrics };
                    await service.completeImageProcessingTask(prepare.task.id, prepareInput);
                    const preparedRecord = await tasks.getStoredGenerationTaskRecord("image_processing", prepare.task.id);
                    const resumed = await resumeProtectionParent(options(input.inputs[0].assetId));
                    const task = await service.enqueueImageProcessingTask(resumed.buildInput);
                    const claimed = await service.claimImageProcessingTasks({ workerId: "mask-output-worker", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
                    expect(claimed.tasks.map((item) => item.id)).toEqual([task.id]);
                    const identity = { workerId: "mask-output-worker", executionId: claimed.tasks[0].executionId };
                    const native = await nativeArtifact(task, identity);
                    return { task, identity, native, prepare, prepareInput, preparedRecord, plan: resumed.plan };
                }

                function completionFor(fixture: Awaited<ReturnType<typeof leasedMask>>, artifact: StoredImageProcessingArtifact): CompleteImageProcessingInput {
                    return { ...fixture.identity, manifest: { ...fixture.native.result, artifacts: [artifact] }, metrics };
                }

                function putMask(fixture: Awaited<ReturnType<typeof leasedMask>>, bytes = fixture.native.bytes, headers: Record<string, string> = {}, query = "") {
                    return outputRoute.PUT(
                        new Request(`http://localhost/api/maintenance/image-processing/${fixture.task.id}/outputs/mask${query}`, {
                            method: "PUT",
                            headers: { authorization: `Bearer ${workerToken}`, "content-type": "image/png", "x-vozeb-pro-worker-id": fixture.identity.workerId, "x-vozeb-pro-execution-id": fixture.identity.executionId, ...headers },
                            body: new Uint8Array(bytes),
                        }),
                        { params: Promise.resolve({ id: fixture.task.id, kind: "mask" }) },
                    );
                }

                function postMaskComplete(task: Pick<ImageProcessingTask, "id">, completion: unknown) {
                    return completeRoute.POST(
                        new Request(`http://localhost/api/maintenance/image-processing/${task.id}/complete`, { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: JSON.stringify(completion) }),
                        { params: Promise.resolve({ id: task.id }) },
                    );
                }

                async function stagedMask(options: (assetId: string) => ImageProcessingProtectionOptions = () => local, bytes = opaqueProduct) {
                    const fixture = await leasedMask(options, bytes);
                    const { writeReferenceMediaFile } = await import("./reference-asset-store");
                    const stored = await writeReferenceMediaFile(fixture.native.path, "image", "image/png", false, { ownerUserId: userId, runId: run.id, taskId: fixture.task.id, source: "fixture-mask-staging", maxBytes: fixture.native.bytes.length });
                    const artifact: StoredImageProcessingArtifact = {
                        kind: "mask",
                        storageKey: stored.token,
                        sha256: createHash("sha256").update(fixture.native.bytes).digest("hex"),
                        mimeType: "image/png",
                        bytes: fixture.native.bytes.length,
                        width: fixture.native.result.artifacts[0].width,
                        height: fixture.native.result.artifacts[0].height,
                    };
                    // A real file/registry/staging fixture isolates the missing complete
                    // behavior from the separately failing production mask PUT.
                    await scheduler.scheduleGenerationTask("image_processing", fixture.task.id, { resultPayload: { executionId: fixture.identity.executionId, artifacts: [artifact] } });
                    return { ...fixture, artifact, completion: completionFor(fixture, artifact) };
                }

                it("registers the paired generation inputs with the original full-resolution mask", async () => {
                    const generationInput = { bounds: { width: 12, height: 12 }, quality: "high" };
                    const fixture = await leasedMask(() => ({ transparentBackground: false, generationInput }));
                    const upload = async (index: number) => {
                        const artifact = fixture.native.result.artifacts[index];
                        const response = await outputRoute.PUT(
                            new Request(`http://localhost/api/maintenance/image-processing/${fixture.task.id}/outputs/${artifact.kind}`, {
                                method: "PUT",
                                headers: { authorization: `Bearer ${workerToken}`, "content-type": artifact.mimeType, "x-vozeb-pro-worker-id": fixture.identity.workerId, "x-vozeb-pro-execution-id": fixture.identity.executionId },
                                body: new Uint8Array(await readFile(artifact.path)),
                            }),
                            { params: Promise.resolve({ id: fixture.task.id, kind: artifact.kind }) },
                        );
                        expect(response.status, await response.clone().text()).toBe(201);
                        return (await response.json()).data as StoredImageProcessingArtifact;
                    };
                    const mask = await upload(0);
                    const reference = await upload(1);
                    const generationMask = await upload(2);
                    const completion = { ...fixture.identity, manifest: { ...fixture.native.result, artifacts: [mask, reference, generationMask] }, metrics };
                    expect(mask).toMatchObject({ kind: "mask", width: 24, height: 18 });
                    expect(reference).toMatchObject({ kind: "generation_reference", width: 12, height: 9 });
                    expect(generationMask).toMatchObject({ kind: "generation_mask", width: 12, height: 9 });
                    const incomplete = await postMaskComplete(fixture.task, { ...completion, manifest: { ...completion.manifest, artifacts: [mask, reference, reference] } });
                    expect(incomplete.status).toBe(400);
                    const response = await postMaskComplete(fixture.task, completion);
                    expect(response.status, await response.clone().text()).toBe(200);
                    const parent = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                    expect(parent?.ecommerceSnapshot?.processing?.protection).toMatchObject({ jobId: fixture.task.id, generationInput, manifest: { artifacts: [mask, reference, generationMask] } });
                    expect(parent?.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepare.task.id)).toEqual(fixture.preparedRecord);
                });

                it("keeps the primary mask pair and prepares the auxiliary original before dispatch and TCP submission", async () => {
                    const { prepareEcommerceProtectionTask } = await import("./ecommerce-protection-preparation");
                    const { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } = await import("./ecommerce-image-compiler");
                    const { compileStrictProductEdit } = await import("./ecommerce-product-regions");
                    const { emptyAdvancedConfig } = await import("@/lib/channel-protocol-registry");
                    ({ run, input } = await seedReference(userId, opaqueProduct));
                    const prepare = await leasedPrepare();
                    const prepared = await nativeArtifact(prepare.task, prepare.identity);
                    const analysisArtifact = await service.writeImageProcessingOutput(prepare.task.id, "analysis", prepare.identity, { stream: imageBody(prepared.bytes), mimeType: prepared.result.artifacts[0].mimeType });
                    await service.completeImageProcessingTask(prepare.task.id, { ...prepare.identity, manifest: { ...prepared.result, artifacts: [analysisArtifact] }, metrics });
                    const auxiliaryBytes = await sharp({ create: { width: 48, height: 36, channels: 3, background: "#5a7c9e" } })
                        .png()
                        .toBuffer();
                    const { writeReferenceImageDataUrl } = await import("./reference-asset-store");
                    const storedAuxiliary = await writeReferenceImageDataUrl(`data:image/png;base64,${auxiliaryBytes.toString("base64")}`, { ownerUserId: userId, conversationId: run.conversationId, source: "fixture-auxiliary" });
                    const [auxiliary] = await runtime.registerCreativeAssets([
                        {
                            id: `fixture-auxiliary-${randomUUID()}`,
                            userId,
                            conversationId: run.conversationId,
                            ordinal: 1,
                            type: "image",
                            title: "auxiliary.png",
                            sourceRunId: run.id,
                            serverUrl: `/api/reference-assets/${storedAuxiliary.token}`,
                            metadata: {},
                        },
                    ]);
                    const { buildEcommercePlanningInput } = await import("./ecommerce-generation-snapshot");
                    const { createEcommerceReferenceCheckpoint } = await import("./ecommerce-reference-recovery");
                    const auxiliaryExecutionId = randomUUID();
                    const expanded = await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => {
                        assert(current.ecommerceSnapshot?.referenceCheckpoint);
                        const original = current.ecommerceSnapshot.referenceCheckpoint.assets[0];
                        const assets = [original.asset, auxiliary];
                        const planningInput = buildEcommercePlanningInput(current, assets, { summary: "", recentMessages: [] });
                        const checkpoint = createEcommerceReferenceCheckpoint(current, planningInput, assets);
                        return {
                            ...current,
                            executionId: auxiliaryExecutionId,
                            referencedAssetIds: assets.map((asset) => asset.id),
                            ecommerceSnapshot: { ...current.ecommerceSnapshot, referenceCheckpoint: { ...checkpoint, assets: [original, checkpoint.assets[1]] } },
                        };
                    });
                    assert(expanded?.ecommerceSnapshot?.referenceCheckpoint);
                    await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
                    expect(await scheduler.claimDueGenerationTasks({ workerId: "fixture-auxiliary-parent", taskIds: [run.id], limit: 1 })).toHaveLength(1);
                    const auxPrepare = await leasedPrepare({ ...input, parentExecutionId: auxiliaryExecutionId, inputs: [{ assetId: auxiliary.id, assetVersion: expanded.ecommerceSnapshot.referenceCheckpoint.assets[1].assetVersion }] });
                    const auxNative = await nativeArtifact(auxPrepare.task, auxPrepare.identity);
                    const auxAnalysis = await service.writeImageProcessingOutput(auxPrepare.task.id, "analysis", auxPrepare.identity, { stream: imageBody(auxNative.bytes), mimeType: auxNative.result.artifacts[0].mimeType });
                    await service.completeImageProcessingTask(auxPrepare.task.id, { ...auxPrepare.identity, manifest: { ...auxNative.result, artifacts: [auxAnalysis] }, metrics });
                    const analysisBefore = await tasks.getStoredGenerationTaskRecord("image_processing", auxPrepare.task.id);
                    const resumed = await resumeProtectionParent(white);
                    const assetId = resumed.buildInput.inputs[0].assetId;
                    const analysis: import("./ecommerce-visual-analysis").EcommerceVisualAnalysis = {
                        analysisVersion: "ecommerce-visual-analysis.v1",
                        modelRole: { logicalRole: "vision_analysis", logicalModelId: "fixture-vision", channelId: "fixture-vision", upstreamModel: "fixture-vision" },
                        references: [
                            {
                                assetId,
                                role: "product",
                                confidence: "high",
                                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                                productFacts: { identity: "cabinet", outline: "rectangle", color: "brown", material: "wood", brandText: [], view: "front" },
                                sceneFacts: null,
                                productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
                                fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
                                editableTargets: [],
                            },
                        ],
                    };
                    const route: import("./ecommerce-model-routing").EcommerceRoleRouteSnapshot = {
                        logicalRole: "image_generation",
                        capability: "image",
                        logicalModelId: "fixture-image",
                        channelId: "fixture-image",
                        upstreamModel: "gpt-image-2.5-sunburst",
                        apiFormat: "openai",
                        imageEdit: { protocol: "sub2api", editPath: "/images/edits", transport: "json", supportsIndependentMask: true },
                    };
                    const plan: EcommerceEditPlan = {
                        ...resumed.plan,
                        source: { ...resumed.plan.source, sceneReferenceIds: [auxiliary.id] },
                        planVersion: "ecommerce-edit.v1",
                        canvas: { mode: "exact", size: { width: 12, height: 9 }, source: "user_text", allowReframe: false },
                    };
                    const profile = resolveEcommerceImageProviderProfile(route);
                    assert(profile);
                    const execution = compileEcommerceImageRequest(plan, profile);
                    const parent = await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => {
                        assert(current.ecommerceSnapshot?.referenceCheckpoint);
                        return {
                            ...current,
                            ecommerceSnapshot: {
                                ...current.ecommerceSnapshot,
                                plan,
                                visualAnalysis: analysis,
                                modelRouteSnapshots: { image_generation: route },
                                compilerVersion: execution.compilerVersion,
                                referenceCheckpoint: { ...current.ecommerceSnapshot.referenceCheckpoint, state: "resolved", analysisStage: { ...current.ecommerceSnapshot.referenceCheckpoint.analysisStage, state: "completed" } },
                            },
                        };
                    });
                    assert(parent);
                    expect(await prepareEcommerceProtectionTask(parent, resumed.buildInput.parentExecutionId, analysis, { imageQuality: "high", imageSize: "auto" })).toBeUndefined();
                    const leases = await service.claimImageProcessingTasks({ workerId: "fixture-native-copy-worker", profileVersion: prepare.task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
                    expect(leases.tasks).toHaveLength(1);
                    const lease = leases.tasks[0];
                    assert(lease.payload.operation === "build_protection");
                    const identity = { workerId: "fixture-native-copy-worker", executionId: lease.executionId };
                    const native = await nativeArtifact({ id: lease.id, payload: lease.payload }, identity);
                    const upload = async (index: number) => {
                        const artifact = native.result.artifacts[index];
                        return service.writeImageProcessingOutput(lease.id, artifact.kind, identity, { stream: imageBody(await readFile(artifact.path)), mimeType: artifact.mimeType });
                    };
                    const originalMask = await upload(0);
                    const generationReference = await upload(1);
                    const generationMask = await upload(2);
                    await service.completeImageProcessingTask(lease.id, { ...identity, manifest: { ...native.result, artifacts: [originalMask, generationReference, generationMask] }, metrics });
                    const executionId = randomUUID();
                    await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => ({ ...current, executionId }));
                    await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
                    expect(await scheduler.claimDueGenerationTasks({ workerId: "fixture-native-copy-parent", taskIds: [run.id], limit: 1 })).toHaveLength(1);
                    const ready = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                    assert(ready);
                    const checkpointBefore = structuredClone(ready.ecommerceSnapshot?.referenceCheckpoint);
                    expect(await prepareEcommerceProtectionTask(ready, executionId, analysis, { imageQuality: "low", imageSize: "1024x1024" })).toBeUndefined();
                    const auxiliaryStage = await service.claimImageProcessingTasks({ workerId: "fixture-auxiliary-generation", profileVersion: prepare.task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
                    expect(auxiliaryStage.tasks).toHaveLength(1);
                    expect(auxiliaryStage.tasks[0].payload).toMatchObject({ operation: "prepare_reference", options: { generationInput: { bounds: { width: 12, height: 9 }, quality: "high" } }, inputs: [{ assetId: auxiliary.id }] });
                    const generationTask = auxiliaryStage.tasks[0];
                    assert(generationTask.payload.operation === "prepare_reference");
                    const generationIdentity = { workerId: "fixture-auxiliary-generation", executionId: generationTask.executionId };
                    const generated = await nativeArtifact({ id: generationTask.id, payload: generationTask.payload }, generationIdentity);
                    const generationUpload = await outputRoute.PUT(
                        new Request(`http://localhost/api/maintenance/image-processing/${generationTask.id}/outputs/generation_reference`, {
                            method: "PUT",
                            headers: { authorization: `Bearer ${workerToken}`, "content-type": generated.result.artifacts[0].mimeType, "x-vozeb-pro-worker-id": generationIdentity.workerId, "x-vozeb-pro-execution-id": generationIdentity.executionId },
                            body: new Uint8Array(generated.bytes),
                        }),
                        { params: Promise.resolve({ id: generationTask.id, kind: "generation_reference" }) },
                    );
                    expect(generationUpload.status, await generationUpload.clone().text()).toBe(201);
                    const auxiliaryReference = (await generationUpload.json()).data;
                    const { artifacts: _artifacts, ...generationManifest } = generated.result;
                    const completed = await postMaskComplete(generationTask, { ...generationIdentity, manifest: { ...generationManifest, artifacts: [auxiliaryReference] }, metrics });
                    expect(completed.status, await completed.clone().text()).toBe(200);
                    expect(auxiliaryReference).toMatchObject({ kind: "generation_reference", width: 12, height: 9 });
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", auxPrepare.task.id)).toEqual(analysisBefore);
                    const nextExecutionId = randomUUID();
                    await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => ({ ...current, executionId: nextExecutionId }));
                    await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
                    expect(await scheduler.claimDueGenerationTasks({ workerId: "fixture-auxiliary-ready", taskIds: [run.id], limit: 1 })).toHaveLength(1);
                    const generationReady = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                    assert(generationReady);
                    expect(generationReady.ecommerceSnapshot?.referenceCheckpoint).toEqual(checkpointBefore);
                    const executable = await prepareEcommerceProtectionTask(generationReady, nextExecutionId, analysis, { imageQuality: "low", imageSize: "1024x1024" });
                    assert(executable?.productProtectionRegions && executable.references);
                    expect(executable.quality).toBe("high");
                    await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => ({ ...current, tasks: [{ ...executable, status: "running", attempts: 1 }] }));
                    const config: import("./image-task-store").ImageTaskConfig = {
                        baseUrl: "http://127.0.0.1",
                        apiKey: "fixture-only",
                        apiFormat: "openai",
                        model: "gpt-image-2.5-sunburst",
                        quality: "high",
                        size: "12x9",
                        advancedConfig: { ...emptyAdvancedConfig(), protocol: "sub2api" },
                    };
                    const references = executable.references.map((reference) => ({ id: reference.assetId, url: reference.url, dataUrl: "", width: reference.width, height: reference.height, ecommerceRole: reference.ecommerceRole }));
                    const compiled = compileStrictProductEdit({ kind: "edit" as const, prompt: executable.prompt, config, references }, executable.productProtectionRegions);
                    assert(compiled.state === "ready");
                    const checkpoint = ready.ecommerceSnapshot?.referenceCheckpoint;
                    assert(checkpoint);
                    const referenceDispatch = { executionId: nextExecutionId, inputId: checkpoint.inputId, decisionId: checkpoint.decisionId, analysisRequestId: checkpoint.analysisStage.requestId, copy: 1 };
                    const image: import("./image-task-store").ImageTask = {
                        ...compiled.task,
                        id: randomUUID(),
                        userId,
                        username: "fixture",
                        displayName: "fixture",
                        source: "agent",
                        status: "pending",
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        runId: run.id,
                        conversationId: run.conversationId,
                        parentTaskId: executable.id,
                        clientRequestId: `${run.clientRequestId}:${executable.id}:1:1`,
                        attemptNo: 1,
                        referenceDispatch,
                        ecommerceExecution: executable.ecommerceExecution,
                    };
                    await tasks.createStoredGenerationTask("image", image, 60_000, { referenceDispatch });
                    await tasks.linkStoredGenerationTask("image", image.id, { parentTaskId: run.id });
                    const linked = await tasks.getStoredGenerationTask<import("./image-task-store").ImageTask>("image", image.id);
                    assert(linked);
                    expect(linked.parentTaskId).toBe(run.id);
                    const pair = await service.readEcommerceGenerationInput(linked, "high", "12x9");
                    expect(pair.references[0]).toMatchObject({ serverUrl: "/api/reference-assets/" + generationReference.storageKey, width: 12, height: 9 });
                    expect(pair.references[1]).toMatchObject({ id: auxiliary.id, serverUrl: "/api/reference-assets/" + auxiliaryReference.storageKey, width: 12, height: 9 });
                    expect(await service.readEcommerceGenerationInput(linked, "high", "12x9")).toEqual(pair);
                    await tasks.mutateStoredGenerationTask<import("./image-task-store").ImageTask>("image", image.id, 60_000, (value) => ({ ...value, executionId: "fixture-superseding-image-epoch" }));
                    await expect(service.readEcommerceGenerationInput(linked, "high", "12x9")).rejects.toMatchObject({ status: 409 });
                    await tasks.mutateStoredGenerationTask<import("./image-task-store").ImageTask>("image", image.id, 60_000, (value) => ({ ...value, executionId: undefined }));
                    const secondAttempt = await tasks.mutateStoredGenerationTask<import("./image-task-store").ImageTask>("image", image.id, 60_000, (value) => ({ ...value, attemptNo: 2 }));
                    assert(secondAttempt);
                    expect(await service.readEcommerceGenerationInput(secondAttempt, "high", "12x9")).toEqual(pair);
                    await expect(service.readEcommerceGenerationInput(linked, "high", "12x9")).rejects.toMatchObject({ status: 409 });
                    await tasks.mutateStoredGenerationTask<import("./image-task-store").ImageTask>("image", image.id, 60_000, (value) => ({ ...value, attemptNo: 1 }));
                    const before = await tasks.getStoredGenerationTaskRecord("image", image.id);
                    expect(pair.mask).toMatchObject({ serverUrl: "/api/reference-assets/" + generationMask.storageKey, width: 12, height: 9 });
                    const { buildJsonImageEditBodies } = await import("@/app/api/image-tasks/image-task-openai");
                    await expect(buildJsonImageEditBodies(linked, "low", "12x9", "url", "http://127.0.0.1", "http://127.0.0.1")).rejects.toMatchObject({
                        name: "GenerationSubmissionSafeFailure",
                        cause: { message: "生成输入副本与原计划、参考或实际请求不一致" },
                    });
                    expect(await tasks.getStoredGenerationTaskRecord("image", image.id)).toEqual(before);
                    expect((await tasks.getStoredGenerationTask<AgentRun>("agent", run.id))?.tasks[0].childTasks).toBeUndefined();
                    const { buffer } = await import("node:stream/consumers");
                    const { createImageTaskUpstreamStep } = await import("./image-task-runtime");
                    let received: { images: { image_url: string }[]; mask: { image_url: string }; size: string } | undefined;
                    const sourceUrl = linked.references[0].url;
                    assert(sourceUrl);
                    const media = new Map([
                        [new URL(sourceUrl, "http://fixture").pathname, opaqueProduct],
                        [new URL(auxiliary.serverUrl!, "http://fixture").pathname, auxiliaryBytes],
                        ["/api/reference-assets/" + auxiliaryReference.storageKey, await readFile((await (await import("./reference-asset-store")).readReferenceAsset(auxiliaryReference.storageKey))!.filePath)],
                        ["/api/reference-assets/" + generationReference.storageKey, await readFile(native.result.artifacts[1].path)],
                        ["/api/reference-assets/" + generationMask.storageKey, await readFile(native.result.artifacts[2].path)],
                    ]);
                    const provider = createServer(async (request, response) => {
                        if (request.method === "GET") {
                            const body = media.get(new URL(request.url || "/", "http://fixture").pathname);
                            assert(body);
                            response.writeHead(200, { "content-type": "image/png" });
                            response.end(body);
                            return;
                        }
                        received = JSON.parse((await buffer(request)).toString("utf8"));
                        response.writeHead(400, { "content-type": "application/json" });
                        response.end(JSON.stringify({ error: { message: "fixture input received" } }));
                    });
                    await new Promise<void>((resolve, reject) => {
                        provider.once("error", reject);
                        provider.listen(0, "127.0.0.1", resolve);
                    });
                    try {
                        const address = provider.address();
                        assert(address && typeof address !== "string");
                        const origin = `http://127.0.0.1:${address.port}`;
                        const current = await tasks.mutateStoredGenerationTask<import("./image-task-store").ImageTask>("image", image.id, 60_000, (value) => ({ ...value, config: { ...value.config, baseUrl: "/api/fixture-image" } }));
                        assert(current);
                        const step = await createImageTaskUpstreamStep(current, origin, origin, "session=fixture-only");
                        expect(received, JSON.stringify(step)).toBeDefined();
                        expect(step.state).toBe("failed");
                        assert(received);
                        expect(received.size).toBe("12x9");
                        const submittedReference = Buffer.from(received.images[0].image_url.split(",")[1], "base64");
                        expect(
                            createHash("sha256")
                                .update(Buffer.from(received.images[1].image_url.split(",")[1], "base64"))
                                .digest("hex"),
                        ).toBe(auxiliaryReference.sha256);
                        const submittedMask = Buffer.from(received.mask.image_url.split(",")[1], "base64");
                        expect(createHash("sha256").update(submittedReference).digest("hex")).toBe(generationReference.sha256);
                        expect(createHash("sha256").update(submittedMask).digest("hex")).toBe(generationMask.sha256);
                        expect(await sharp(submittedReference).metadata()).toMatchObject({ width: 12, height: 9 });
                        expect(await sharp(submittedMask).metadata()).toMatchObject({ width: 12, height: 9 });
                        const saved = await tasks.getStoredGenerationTask<import("./image-task-store").ImageTask>("image", image.id);
                        expect(saved?.references).toEqual(linked.references);
                        expect(saved?.mask).toEqual(linked.mask);
                    } finally {
                        const closed = new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
                        provider.closeAllConnections();
                        await closed;
                    }
                }, 120_000);

                failureCases("build_protection", stagedMask);
                cancellationCases(
                    "build_protection",
                    async () => {
                        const prepared = await protectionFixture(local);
                        return service.enqueueImageProcessingTask(prepared.buildInput);
                    },
                    stagedMask,
                );
                cancelCloseCases(
                    "build_protection",
                    async () => {
                        const prepared = await protectionFixture(local);
                        return service.enqueueImageProcessingTask(prepared.buildInput);
                    },
                    stagedMask,
                );

                async function expectMaskCompleteRejected(fixture: Awaited<ReturnType<typeof stagedMask>>, completion: CompleteImageProcessingInput) {
                    const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                    const child = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id);
                    await expect(service.completeImageProcessingTask(fixture.task.id, completion)).rejects.toMatchObject({ status: 400 });
                    expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toEqual(child);
                }

                it.each<{ policy: string; options: (assetId: string) => ImageProcessingProtectionOptions; bytes: () => Buffer; geometry: Record<string, unknown> }>([
                    { policy: "white product", options: () => white, bytes: () => opaqueProduct, geometry: { productBounds: { x: 8, y: 5, width: 8, height: 8 }, haloBounds: { x: 7, y: 4, width: 10, height: 10 } } },
                    {
                        policy: "qualified white baseline",
                        options: () => ({ ...white, freezeEnhancementBaseline: true }),
                        bytes: () => opaqueProduct,
                        geometry: { enhancementBaseline: { status: "qualified", scope: "product_background", hasAlpha: false } },
                    },
                    {
                        policy: "unsupported transparent baseline",
                        options: () => ({ transparentBackground: true, freezeEnhancementBaseline: true }),
                        bytes: () => transparentProduct,
                        geometry: { enhancementBaseline: { status: "unsupported", scope: "product_background", error: { code: "product_protection_rejected" } } },
                    },
                    { policy: "local edit", options: () => local, bytes: () => opaqueProduct, geometry: {} },
                    { policy: "qualified local baseline", options: qualifiedLocal, bytes: () => opaqueProduct, geometry: { enhancementBaseline: { status: "qualified", scope: "product_background", hasAlpha: false } } },
                    {
                        policy: "scene selection",
                        options: () => scene,
                        bytes: () => opaqueProduct,
                        geometry: { sceneProtection: { targetRegion: scene.region, semantics: scene.semantics, selectionSource: "user_selection", maskSemantics: "alpha_zero_edit", method: "source_pixels_copy" } },
                    },
                    {
                        policy: "qualified transparent scene baseline",
                        options: () => ({ ...scene, freezeEnhancementBaseline: true }),
                        bytes: () => transparentProduct,
                        geometry: { enhancementBaseline: { status: "qualified", scope: "local_edit", hasAlpha: true } },
                    },
                ])("uploads and completes the actual $policy mask through both HTTP boundaries", async ({ options, bytes, geometry }) => {
                    const fixture = await leasedMask(options, bytes());
                    const parentBefore = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                    const response = await putMask(fixture);
                    expect(response.status).toBe(201);
                    const body: { code: number; data: StoredImageProcessingArtifact } = await response.json();
                    expect(body).toMatchObject({ code: 0, data: { kind: "mask", mimeType: "image/png", bytes: fixture.native.bytes.length, width: 24, height: 18, sha256: createHash("sha256").update(fixture.native.bytes).digest("hex") } });
                    const completion = completionFor(fixture, body.data);
                    const completed = await postMaskComplete(fixture.task, completion);
                    expect(completed.status).toBe(200);
                    await expect(completed.json()).resolves.toMatchObject({ code: 0, data: { jobId: fixture.task.id, inputDigest: fixture.task.payload.inputDigest, manifest: completion.manifest, parentRescheduled: true } });
                    expect(completion.manifest.geometry).toMatchObject({ sourceSize: { width: 24, height: 18 }, ...geometry });
                    const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                    expect(parent).toMatchObject({
                        status: "running",
                        nextPollAt: expect.any(Number),
                        payload: {
                            ecommerceSnapshot: {
                                plan: fixture.plan,
                                processing: { protection: { jobId: fixture.task.id, inputDigest: fixture.task.payload.inputDigest, manifest: completion.manifest }, prepareReferences: parentBefore?.ecommerceSnapshot?.processing?.prepareReferences },
                            },
                        },
                    });
                    expect((parent?.payload as AgentRun).ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
                    expect((parent?.payload as AgentRun).ecommerceSnapshot?.referenceCheckpoint).toEqual(parentBefore?.ecommerceSnapshot?.referenceCheckpoint);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepare.task.id)).toEqual(fixture.preparedRecord);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toMatchObject({
                        status: "success",
                        executionPhase: "completed",
                        resultPayload: { executionId: fixture.identity.executionId, manifest: completion.manifest },
                    });
                    await expect(service.completeImageProcessingTask(fixture.prepare.task.id, fixture.prepareInput)).resolves.toMatchObject({ manifest: fixture.prepareInput.manifest });
                });

                it("completes an actually registered and staged mask independently of its PUT plumbing", async () => {
                    const fixture = await stagedMask();
                    await expect(service.completeImageProcessingTask(fixture.task.id, fixture.completion)).resolves.toMatchObject({ manifest: fixture.completion.manifest, parentRescheduled: true });
                });

                it("accepts an actually registered mask through the HTTP complete boundary independently of PUT", async () => {
                    const fixture = await stagedMask();
                    const response = await postMaskComplete(fixture.task, fixture.completion);
                    expect(response.status).toBe(200);
                    await expect(response.json()).resolves.toMatchObject({ code: 0, data: { manifest: fixture.completion.manifest, parentRescheduled: true } });
                });

                it("retains the exact saved prepare manifest digest when replaying a legacy completion receipt", async () => {
                    const jobId = `image-process-${"1".repeat(64)}`;
                    const manifest: ImageProcessingManifest = {
                        jobId,
                        executionId: "legacy-prepare-execution",
                        sourceIdentities: [{ assetId: "legacy-source", assetVersion: "legacy-v0", sha256: "a".repeat(64), bytes: 110, width: 24, height: 18, mimeType: "image/png" }],
                        artifacts: [{ kind: "analysis", storageKey: "temporary/image/legacy-prepare.png", sha256: "b".repeat(64), mimeType: "image/png", bytes: 110, width: 24, height: 18 }],
                        geometry: { sourceSize: { width: 24, height: 18 } },
                    };
                    const now = Date.now();
                    await tasks.createStoredGenerationTask("image_processing", { id: jobId, userId, runId: run.id, status: "success", inputDigest: "1".repeat(64), createdAt: now, updatedAt: now }, 60_000);
                    // This pre-existing receipt tuple has a fixed literal hash. It is
                    // replay evidence, not a claim that its old media still exists.
                    await scheduler.scheduleGenerationTask("image_processing", jobId, {
                        executionPhase: "completed",
                        resultPayload: { executionId: manifest.executionId, workerId: "legacy-prepare-worker", manifest, manifestDigest: "0eaa4716ce6ea3eb3807b33ce53658fbde02b7d7ef20225c5acaa432260396ad", metrics, parentRescheduled: true },
                    });
                    const before = await tasks.getStoredGenerationTaskRecord("image_processing", jobId);
                    await expect(service.completeImageProcessingTask(jobId, { workerId: "legacy-prepare-worker", executionId: manifest.executionId, manifest, metrics })).resolves.toEqual({
                        jobId,
                        inputDigest: "1".repeat(64),
                        executionId: manifest.executionId,
                        manifest,
                        parentRescheduled: true,
                    });
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", jobId)).toEqual(before);
                });

                it("accepts a tiny real PNG whose encoded bytes exceed the 4N raw reserve", async () => {
                    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#42688a" } })
                        .png()
                        .toBuffer();
                    const fixture = await leasedMask(() => ({ mode: "local_edit", targetRegion: { x: 0, y: 0, width: 0.5, height: 0.5 }, protectedRectangles: [] }), bytes);
                    expect(fixture.native.bytes.length).toBeGreaterThan(16);
                    await expect(service.writeImageProcessingOutput(fixture.task.id, "mask", fixture.identity, { stream: imageBody(fixture.native.bytes), mimeType: "image/png" })).resolves.toMatchObject({
                        width: 2,
                        height: 2,
                        bytes: fixture.native.bytes.length,
                    });
                });

                async function uploadLargeMask(storage: "local" | "object", fixture: Awaited<ReturnType<typeof leasedMask>>) {
                    const { readReferenceAsset } = await import("./reference-asset-store");
                    const { getLocalMediaRegistration } = await import("./local-media-registry");
                    if (storage === "local") {
                        const artifact = await service.writeImageProcessingOutput(fixture.task.id, "mask", fixture.identity, { stream: imageBody(largeMask), mimeType: "image/png" });
                        const actual = await readReferenceAsset(artifact.storageKey);
                        assert(actual);
                        return { artifact, registration: await getLocalMediaRegistration(artifact.storageKey), bytes: await readFile(actual.filePath) };
                    }
                    const config = await import("./object-storage-config");
                    const repository = await import("./database/object-storage-repository");
                    const originalSettingsExisted = provider !== "postgres" || (await database.postgresQuery("SELECT id FROM object_storage_settings WHERE id = 'default'")).rows.length === 1;
                    const originalSettings = await repository.readObjectStorageSettings();
                    const tcp = await imageProcessingS3Fixture();
                    try {
                        await config.saveObjectStorageAdminSettings(tcp.config);
                        const artifact = await service.writeImageProcessingOutput(fixture.task.id, "mask", fixture.identity, { stream: imageBody(largeMask), mimeType: "image/png" });
                        const registration = await getLocalMediaRegistration(artifact.storageKey);
                        assert(registration?.externalObjectKey);
                        expect(tcp.requests).toContainEqual({ method: "PUT", key: registration.externalObjectKey });
                        const { readExternalMediaStream } = await import("./object-storage-service");
                        return { artifact, registration, bytes: await imageProcessingStreamBytes(await readExternalMediaStream(registration)) };
                    } finally {
                        await tcp.close();
                        if (provider === "postgres" && !originalSettingsExisted) await database.postgresQuery("DELETE FROM object_storage_settings WHERE id = 'default'");
                        else await repository.writeObjectStorageSettings(originalSettings);
                        await config.getObjectStorageAdminSettings();
                    }
                }

                it.each(["local", "object"] as const)("registers a real PNG mask above 20MiB through the %s Provider without a reference or analysis cap", async (storage) => {
                    const fixture = await leasedMask(() => local, largeSource);
                    expect(largeMask.length).toBeGreaterThan(20 * 1024 * 1024);
                    const uploaded = await uploadLargeMask(storage, fixture);
                    expect(uploaded.artifact).toMatchObject({ kind: "mask", width: 2300, height: 2300, bytes: largeMask.length, sha256: createHash("sha256").update(largeMask).digest("hex") });
                    expect(uploaded.registration).toMatchObject({ storageProvider: storage, ownerUserId: userId, runId: run.id, taskId: fixture.task.id, bytes: largeMask.length });
                    expect(uploaded.bytes.equals(largeMask)).toBe(true);
                });

                it("keeps the first actually registered mask on same-epoch identical upload replay", async () => {
                    const fixture = await leasedMask();
                    const first = await service.writeImageProcessingOutput(fixture.task.id, "mask", fixture.identity, { stream: imageBody(fixture.native.bytes), mimeType: "image/png" });
                    const before = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id);
                    expect(await service.writeImageProcessingOutput(fixture.task.id, "mask", fixture.identity, { stream: imageBody(fixture.native.bytes), mimeType: "image/png" })).toEqual(first);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toEqual(before);
                });

                function heldMaskBody(bytes: Buffer) {
                    let enter: () => void = () => {};
                    let release: () => void = () => {};
                    const entered = new Promise<void>((resolve) => {
                        enter = resolve;
                    });
                    const gate = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    let firstChunk = true;
                    const stream = new ReadableStream<Uint8Array>({
                        async pull(controller) {
                            if (firstChunk) {
                                firstChunk = false;
                                controller.enqueue(bytes.subarray(0, 8));
                                return;
                            }
                            enter();
                            await gate;
                            controller.enqueue(bytes.subarray(8));
                            controller.close();
                        },
                    });
                    return { stream, entered, release };
                }

                it("lets a current heartbeat use the only PG connection while real mask bytes are held before EOF", async () => {
                    const fixture = await leasedMask();
                    const held = heldMaskBody(fixture.native.bytes);
                    const uploading = service.writeImageProcessingOutput(fixture.task.id, "mask", fixture.identity, { stream: held.stream, mimeType: "image/png" });
                    try {
                        await Promise.race([
                            held.entered,
                            uploading.then(() => {
                                throw new Error("Mask upload completed before its actual EOF gate");
                            }),
                        ]);
                        await expect(service.heartbeatImageProcessingTask(fixture.task.id, fixture.identity)).resolves.toMatchObject({ cancelRequested: false });
                        held.release();
                        await expect(uploading).resolves.toMatchObject({ kind: "mask", bytes: fixture.native.bytes.length });
                    } finally {
                        held.release();
                        await uploading.catch(() => undefined);
                    }
                });

                it("rejects changed same-epoch mask bytes while retaining the actual first stage descriptor", async () => {
                    const fixture = await stagedMask();
                    const changed = await sharp(fixture.native.bytes).png({ compressionLevel: 0 }).toBuffer();
                    expect(changed).not.toEqual(fixture.native.bytes);
                    const before = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id);
                    await expect(service.writeImageProcessingOutput(fixture.task.id, "mask", fixture.identity, { stream: imageBody(changed), mimeType: "image/png" })).rejects.toMatchObject({ status: 409 });
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toEqual(before);
                });

                it.each([
                    { reason: "another epoch", identity: { workerId: "mask-output-worker", executionId: "old-mask-epoch" } },
                    { reason: "another Worker", identity: { workerId: "another-mask-worker", executionId: "old-mask-epoch" } },
                ])("rejects mask upload and complete from $reason without mutation", async ({ identity }) => {
                    const fixture = await stagedMask();
                    const before = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id);
                    await expect(service.writeImageProcessingOutput(fixture.task.id, "mask", identity, { stream: imageBody(fixture.native.bytes), mimeType: "image/png" })).rejects.toMatchObject({ status: 409 });
                    await expect(service.completeImageProcessingTask(fixture.task.id, { ...fixture.completion, ...identity })).rejects.toMatchObject({ status: 409 });
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toEqual(before);
                });

                it.each([
                    {
                        reason: "wrong frozen dimensions",
                        bytes: () =>
                            sharp({ create: { width: 23, height: 18, channels: 4, background: "#ffffff" } })
                                .png()
                                .toBuffer(),
                        mimeType: "image/png",
                        status: 400,
                    },
                    { reason: "JPEG disguised as PNG", bytes: () => sharp(opaqueProduct).jpeg().toBuffer(), mimeType: "image/png", status: 400 },
                    { reason: "a non-PNG mask MIME", bytes: () => sharp(opaqueProduct).jpeg().toBuffer(), mimeType: "image/jpeg", status: 415 },
                ])("rejects $reason before associating a mask", async ({ bytes, mimeType, status }) => {
                    const fixture = await leasedMask();
                    const before = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id);
                    await expect(service.writeImageProcessingOutput(fixture.task.id, "mask", fixture.identity, { stream: imageBody(await bytes()), mimeType })).rejects.toMatchObject({ status });
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toEqual(before);
                });

                it("keeps analysis kind and result selectors out of a protection mask upload", async () => {
                    const fixture = await leasedMask();
                    await expect(service.writeImageProcessingOutput(fixture.task.id, "analysis", fixture.identity, { stream: imageBody(fixture.native.bytes), mimeType: "image/png" })).rejects.toMatchObject({ status: 400 });
                    const response = await putMask(fixture, fixture.native.bytes, {}, "?resultId=foreign-slot");
                    expect(response.status).toBe(400);
                });

                it.each<{ reason: string; change: (completion: CompleteImageProcessingInput) => void }>([
                    {
                        reason: "source hash",
                        change: (value) => {
                            value.manifest.sourceIdentities[0].sha256 = "0".repeat(64);
                        },
                    },
                    {
                        reason: "original v0 source version",
                        change: (value) => {
                            value.manifest.sourceIdentities[0].assetVersion = "old-prepare-v0";
                        },
                    },
                    {
                        reason: "source bytes",
                        change: (value) => {
                            value.manifest.sourceIdentities[0].bytes += 1;
                        },
                    },
                    {
                        reason: "source geometry",
                        change: (value) => {
                            value.manifest.geometry.sourceSize = { width: 23, height: 18 };
                        },
                    },
                    {
                        reason: "mask hash",
                        change: (value) => {
                            value.manifest.artifacts[0].sha256 = "0".repeat(64);
                        },
                    },
                    {
                        reason: "unstaged media key",
                        change: (value) => {
                            value.manifest.artifacts[0].storageKey = "temporary/image/unregistered-mask.png";
                        },
                    },
                    {
                        reason: "unexpected local product bounds",
                        change: (value) => {
                            value.manifest.geometry.productBounds = { x: 1, y: 1, width: 2, height: 2 };
                        },
                    },
                    {
                        reason: "an unrequested baseline",
                        change: (value) => {
                            value.manifest.geometry.enhancementBaseline = { status: "unsupported", scope: "product_background", error: { code: "product_protection_rejected", message: "not requested" } };
                        },
                    },
                ])("rejects a mask complete with conflicting $reason and preserves both truth records", async ({ change }) => {
                    const fixture = await stagedMask();
                    const changed = structuredClone(fixture.completion);
                    change(changed);
                    await expectMaskCompleteRejected(fixture, changed);
                });

                it("rejects a mask whose real registration was reassigned to another task", async () => {
                    const fixture = await stagedMask();
                    const { getLocalMediaRegistration, registerLocalMediaAsset } = await import("./local-media-registry");
                    const registration = await getLocalMediaRegistration(fixture.artifact.storageKey);
                    assert(registration);
                    await registerLocalMediaAsset({ ...registration, taskId: "another-mask-task" });
                    await expectMaskCompleteRejected(fixture, fixture.completion);
                });

                it("rejects a staged mask from an old execution even when the caller owns the current lease", async () => {
                    const fixture = await stagedMask();
                    await scheduler.scheduleGenerationTask("image_processing", fixture.task.id, { resultPayload: { executionId: "old-mask-stage-epoch", artifacts: [fixture.artifact] } });
                    await expectMaskCompleteRejected(fixture, fixture.completion);
                });

                it.each([
                    { field: "owner", change: (registration: LocalMediaRegistration): LocalMediaRegistration => ({ ...registration, ownerUserId: otherUserId }) },
                    { field: "Provider", change: (registration: LocalMediaRegistration): LocalMediaRegistration => ({ ...registration, storageProvider: "object", externalStorageId: "replaced-source-storage" }) },
                ])("rejects a mask complete whose frozen source registration changed $field", async ({ change }) => {
                    const fixture = await stagedMask();
                    const { getLocalMediaRegistration, registerLocalMediaAsset } = await import("./local-media-registry");
                    const registration = await getLocalMediaRegistration(fixture.task.payload.sources[0].storageKey);
                    assert(registration);
                    await registerLocalMediaAsset(change(registration));
                    const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                    const child = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id);
                    await expect(service.completeImageProcessingTask(fixture.task.id, fixture.completion)).rejects.toMatchObject({ status: 409 });
                    expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toEqual(child);
                });

                it.each<{ reason: string; change: (completion: CompleteImageProcessingInput) => void }>([
                    {
                        reason: "scene region",
                        change: (value) => {
                            assert(value.manifest.geometry.sceneProtection);
                            value.manifest.geometry.sceneProtection.targetRegion.width += 1;
                        },
                    },
                    {
                        reason: "scene semantics",
                        change: (value) => {
                            assert(value.manifest.geometry.sceneProtection);
                            value.manifest.geometry.sceneProtection.semantics = ["changed selection semantics"];
                        },
                    },
                    {
                        reason: "scene mask digest",
                        change: (value) => {
                            assert(value.manifest.geometry.sceneProtection);
                            value.manifest.geometry.sceneProtection.maskDigest = "0".repeat(64);
                        },
                    },
                    {
                        reason: "qualified baseline source",
                        change: (value) => {
                            const baseline = value.manifest.geometry.enhancementBaseline;
                            assert(baseline?.status === "qualified");
                            baseline.baseline.sha256 = "0".repeat(64);
                        },
                    },
                    {
                        reason: "qualified baseline byte identity",
                        change: (value) => {
                            const baseline = value.manifest.geometry.enhancementBaseline;
                            assert(baseline?.status === "qualified");
                            baseline.baseline.byteLength += 1;
                        },
                    },
                    {
                        reason: "baseline scope",
                        change: (value) => {
                            assert(value.manifest.geometry.enhancementBaseline);
                            value.manifest.geometry.enhancementBaseline.scope = "product_background";
                        },
                    },
                    {
                        reason: "missing requested baseline",
                        change: (value) => {
                            delete value.manifest.geometry.enhancementBaseline;
                        },
                    },
                ])("rejects a scene mask complete with conflicting $reason", async ({ change }) => {
                    const fixture = await stagedMask(() => ({ ...scene, freezeEnhancementBaseline: true }));
                    const changed = structuredClone(fixture.completion);
                    change(changed);
                    await expectMaskCompleteRejected(fixture, changed);
                });

                it.each<{ reason: string; change: (completion: CompleteImageProcessingInput) => void }>([
                    {
                        reason: "product anchor",
                        change: (value) => {
                            const baseline = value.manifest.geometry.enhancementBaseline;
                            assert(baseline?.status === "qualified" && baseline.composition);
                            baseline.composition.productAnchorId = "another-product-anchor";
                        },
                    },
                    {
                        reason: "composition mask identity",
                        change: (value) => {
                            const baseline = value.manifest.geometry.enhancementBaseline;
                            assert(baseline?.status === "qualified" && baseline.composition);
                            baseline.composition.maskSha256 = "0".repeat(64);
                        },
                    },
                    {
                        reason: "normalized baseline binding",
                        change: (value) => {
                            const baseline = value.manifest.geometry.enhancementBaseline;
                            assert(baseline?.status === "qualified" && baseline.composition);
                            baseline.composition.aiSha256 = "0".repeat(64);
                        },
                    },
                ])("rejects qualified product evidence with conflicting $reason", async ({ change }) => {
                    const fixture = await stagedMask(() => ({ ...white, freezeEnhancementBaseline: true }));
                    const changed = structuredClone(fixture.completion);
                    change(changed);
                    await expectMaskCompleteRejected(fixture, changed);
                });

                it("replays a completed nested geometry manifest with reordered JSON keys and changed metrics read only", async () => {
                    const fixture = await stagedMask(() => ({ ...scene, freezeEnhancementBaseline: true }));
                    const first = await service.completeImageProcessingTask(fixture.task.id, fixture.completion);
                    const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                    const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id);
                    const protection = fixture.completion.manifest.geometry.sceneProtection;
                    const baseline = fixture.completion.manifest.geometry.enhancementBaseline;
                    assert(protection && baseline?.status === "qualified");
                    const reordered = {
                        ...fixture.completion,
                        metrics: { ...metrics, elapsedMs: 99 },
                        manifest: {
                            ...fixture.completion.manifest,
                            geometry: {
                                enhancementBaseline: {
                                    hasAlpha: baseline.hasAlpha,
                                    baseline: { normalizedSha256: baseline.baseline.normalizedSha256, height: baseline.baseline.height, width: baseline.baseline.width, byteLength: baseline.baseline.byteLength, sha256: baseline.baseline.sha256 },
                                    normalization: baseline.normalization,
                                    scope: baseline.scope,
                                    status: baseline.status,
                                },
                                sceneProtection: {
                                    method: protection.method,
                                    maskSemantics: protection.maskSemantics,
                                    selectionSource: protection.selectionSource,
                                    semantics: protection.semantics,
                                    targetRegion: { height: protection.targetRegion.height, width: protection.targetRegion.width, y: protection.targetRegion.y, x: protection.targetRegion.x },
                                    maskDigest: protection.maskDigest,
                                    maskSize: { height: 18, width: 24 },
                                    sourceDigest: protection.sourceDigest,
                                    sourceSize: { height: 18, width: 24 },
                                    sourceAssetId: protection.sourceAssetId,
                                    version: protection.version,
                                },
                                sourceSize: { height: 18, width: 24 },
                            },
                        },
                    };
                    expect(await service.completeImageProcessingTask(fixture.task.id, reordered)).toEqual(first);
                    expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toEqual(beforeChild);
                    const conflicting = structuredClone(reordered);
                    conflicting.manifest.geometry.enhancementBaseline.baseline.normalizedSha256 = "0".repeat(64);
                    await expect(service.completeImageProcessingTask(fixture.task.id, conflicting)).rejects.toMatchObject({ status: 409 });
                });

                it("replays qualified product composition after nested evidence keys are reordered", async () => {
                    const fixture = await stagedMask(() => ({ ...white, freezeEnhancementBaseline: true }));
                    const first = await service.completeImageProcessingTask(fixture.task.id, fixture.completion);
                    const baseline = fixture.completion.manifest.geometry.enhancementBaseline;
                    assert(baseline?.status === "qualified" && baseline.composition);
                    const evidence = baseline.composition;
                    const reordered = {
                        ...fixture.completion,
                        manifest: {
                            ...fixture.completion.manifest,
                            geometry: {
                                ...fixture.completion.manifest.geometry,
                                enhancementBaseline: {
                                    ...baseline,
                                    composition: {
                                        protectedChangedPixels: evidence.protectedChangedPixels,
                                        protectedPixels: evidence.protectedPixels,
                                        allowedPixels: evidence.allowedPixels,
                                        aiSize: { height: evidence.aiSize.height, width: evidence.aiSize.width },
                                        sourceSize: { height: evidence.sourceSize.height, width: evidence.sourceSize.width },
                                        compositeSha256: evidence.compositeSha256,
                                        aiSha256: evidence.aiSha256,
                                        maskSha256: evidence.maskSha256,
                                        sourceSha256: evidence.sourceSha256,
                                        sourceAssetId: evidence.sourceAssetId,
                                        productAnchorId: evidence.productAnchorId,
                                        normalization: evidence.normalization,
                                        version: evidence.version,
                                    },
                                },
                            },
                        },
                    };
                    const before = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id);
                    expect(await service.completeImageProcessingTask(fixture.task.id, reordered)).toEqual(first);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toEqual(before);
                });

                it("replays a legitimate unsupported baseline with reordered error keys and rejects a changed reason", async () => {
                    const fixture = await stagedMask(() => ({ transparentBackground: true, freezeEnhancementBaseline: true }), transparentProduct);
                    const first = await service.completeImageProcessingTask(fixture.task.id, fixture.completion);
                    const baseline = fixture.completion.manifest.geometry.enhancementBaseline;
                    assert(baseline?.status === "unsupported");
                    const reordered = {
                        ...fixture.completion,
                        manifest: {
                            ...fixture.completion.manifest,
                            geometry: { ...fixture.completion.manifest.geometry, enhancementBaseline: { error: { message: baseline.error.message, code: baseline.error.code }, scope: baseline.scope, status: baseline.status } },
                        },
                    };
                    expect(await service.completeImageProcessingTask(fixture.task.id, reordered)).toEqual(first);
                    const changed = structuredClone(reordered);
                    changed.manifest.geometry.enhancementBaseline.error.message = "different qualification outcome";
                    await expect(service.completeImageProcessingTask(fixture.task.id, changed)).rejects.toMatchObject({ status: 409 });
                });

                it("preserves current parent edits while merging only the matching protection reference", async () => {
                    const fixture = await stagedMask();
                    await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (parent) => ({ ...parent, prompt: "newer prompt survives mask completion" }));
                    await expect(service.completeImageProcessingTask(fixture.task.id, fixture.completion)).resolves.toMatchObject({ parentRescheduled: true });
                    expect(await tasks.getStoredGenerationTask<AgentRun>("agent", run.id)).toMatchObject({
                        prompt: "newer prompt survives mask completion",
                        ecommerceSnapshot: { plan: fixture.plan, processing: { protection: { manifest: fixture.completion.manifest } } },
                    });
                });

                it.each<{ reason: string; change: (parent: AgentRun) => AgentRun }>([
                    {
                        reason: "a newer dependency",
                        change: (parent) => {
                            assert(parent.ecommerceSnapshot?.processing);
                            return { ...parent, ecommerceSnapshot: { ...parent.ecommerceSnapshot, processing: { ...parent.ecommerceSnapshot.processing, waitingFor: { jobId: "newer-mask-dependency", inputDigest: "newer-mask-input" } } } };
                        },
                    },
                    {
                        reason: "a replaced protection reference",
                        change: (parent) => {
                            assert(parent.ecommerceSnapshot?.processing);
                            return { ...parent, ecommerceSnapshot: { ...parent.ecommerceSnapshot, processing: { ...parent.ecommerceSnapshot.processing, protection: { jobId: "newer-protection-stage", inputDigest: "newer-protection-input" } } } };
                        },
                    },
                    { reason: "cancellation", change: (parent) => ({ ...parent, cancellation: { requestedAt: Date.now(), pendingChildTaskIds: [] } }) },
                ])("keeps a valid completed mask without waking a parent that has $reason", async ({ change }) => {
                    const fixture = await stagedMask();
                    await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, change);
                    const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                    await expect(service.completeImageProcessingTask(fixture.task.id, fixture.completion)).resolves.toMatchObject({ parentRescheduled: false });
                    expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toMatchObject({ status: "success", resultPayload: { manifest: fixture.completion.manifest, parentRescheduled: false } });
                });

                if (provider === "postgres") {
                    it.each([
                        { target: "parent", predicate: (runId: string, _taskId: string) => `id <> '${runId}' OR payload #> '{ecommerceSnapshot,processing,waitingFor}' IS NOT NULL` },
                        { target: "child", predicate: (_runId: string, taskId: string) => `id <> '${taskId}' OR status <> 'success'` },
                    ])("rolls back mask complete truth when the actual PostgreSQL CHECK rejects the $target write", async ({ predicate }) => {
                        const fixture = await stagedMask();
                        const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                        const child = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id);
                        const constraint = `fixture_mask_complete_${randomUUID().replaceAll("-", "")}`;
                        await database.postgresQuery(`ALTER TABLE generation_tasks ADD CONSTRAINT ${constraint} CHECK (${predicate(run.id, fixture.task.id)})`);
                        try {
                            await expect(service.completeImageProcessingTask(fixture.task.id, fixture.completion)).rejects.toMatchObject({ code: "23514", constraint });
                            expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
                            expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.task.id)).toEqual(child);
                        } finally {
                            await database.postgresQuery(`ALTER TABLE generation_tasks DROP CONSTRAINT ${constraint}`);
                        }
                    });
                }
            });

            if (provider === "postgres") {
                it.each([
                    { target: "parent", predicate: (id: string) => `id <> '${id}' OR payload #> '{ecommerceSnapshot,processing,protection}' IS NULL` },
                    { target: "child", predicate: (id: string) => `run_id IS DISTINCT FROM '${id}' OR task_type <> 'image_processing' OR payload ->> 'operation' <> 'build_protection'` },
                ])("rolls back both protection enqueue records when PostgreSQL rejects the $target write", async ({ predicate }) => {
                    const { buildInput } = await protectionFixture();
                    const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                    const beforeChildren = await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId]);
                    const constraint = `fixture_build_protection_${randomUUID().replaceAll("-", "")}`;
                    await database.postgresQuery(`ALTER TABLE generation_tasks ADD CONSTRAINT ${constraint} CHECK (${predicate(run.id)})`);
                    try {
                        await expect(service.enqueueImageProcessingTask(buildInput)).rejects.toMatchObject({ code: "23514", constraint });
                        expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
                        expect(await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).toEqual(beforeChildren);
                    } finally {
                        await database.postgresQuery(`ALTER TABLE generation_tasks DROP CONSTRAINT ${constraint}`);
                    }
                });
            }
        });

        describe("image processing S3 registered original inputs", () => {
            let fixture: Awaited<ReturnType<typeof imageProcessingS3Fixture>>;
            let storageConfig: typeof import("./object-storage-config");
            let storageRepository: typeof import("./database/object-storage-repository");
            let originalSettings: Awaited<ReturnType<(typeof import("./database/object-storage-repository"))["readObjectStorageSettings"]>>;
            let originalSettingsExisted: boolean;
            let inputRoute: typeof import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route");
            const workerToken = "fixture-image-worker-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

            beforeAll(async () => {
                [storageConfig, storageRepository, inputRoute] = await Promise.all([import("./object-storage-config"), import("./database/object-storage-repository"), import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route")]);
            });

            beforeEach(async () => {
                await clearInternalFixtureTasks();
                originalSettingsExisted = provider !== "postgres" || (await database.postgresQuery("SELECT id FROM object_storage_settings WHERE id = 'default'")).rows.length === 1;
                originalSettings = await storageRepository.readObjectStorageSettings();
                fixture = await imageProcessingS3Fixture();
                await storageConfig.saveObjectStorageAdminSettings(fixture.config);
                vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
                vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-maintenance-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
            });

            afterEach(async () => {
                try {
                    await fixture?.close();
                } finally {
                    if (provider === "postgres" && !originalSettingsExisted) await database.postgresQuery("DELETE FROM object_storage_settings WHERE id = 'default'");
                    else await storageRepository.writeObjectStorageSettings(originalSettings);
                    await storageConfig.getObjectStorageAdminSettings();
                }
            });

            async function objectReference() {
                const seeded = await seedReference(userId);
                const { getLocalMediaRegistration } = await import("./local-media-registry");
                const registration = await getLocalMediaRegistration(seeded.storageKey);
                assert(registration && registration.externalObjectKey);
                expect(registration.storageProvider).toBe("object");
                return { ...seeded, registration };
            }

            async function inputRequest(task: ImageProcessingTask, signal?: AbortSignal) {
                const claimed = await service.claimImageProcessingTasks({ workerId: "s3-input-worker", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
                expect(claimed.tasks).toHaveLength(1);
                const assetId = task.payload.inputs[0].assetId;
                return inputRoute.GET(
                    new Request(`http://localhost/api/maintenance/image-processing/${task.id}/inputs/${assetId}`, {
                        signal,
                        headers: { authorization: `Bearer ${workerToken}`, "x-vozeb-pro-worker-id": "s3-input-worker", "x-vozeb-pro-execution-id": claimed.tasks[0].executionId },
                    }),
                    { params: Promise.resolve({ id: task.id, assetId }) },
                );
            }

            it("registers a real S3 analysis stream before completing and preserves the registered source original", async () => {
                const { task, identity } = await leasedPrepare();
                const artifact = await service.writeImageProcessingOutput(task.id, "analysis", identity, { stream: imageBody(), mimeType: "image/png" });
                const { getLocalMediaRegistration } = await import("./local-media-registry");
                const registration = await getLocalMediaRegistration(artifact.storageKey);
                assert(registration?.externalObjectKey);
                expect(registration).toMatchObject({ storageProvider: "object", ownerUserId: userId, runId: run.id, taskId: task.id, mimeType: "image/png", bytes: source.length });
                expect(fixture.requests).toContainEqual({ method: "PUT", key: registration.externalObjectKey });
                const { readExternalMediaStream } = await import("./object-storage-service");
                expect(await imageProcessingStreamBytes(await readExternalMediaStream(registration))).toEqual(source);
                const original = await service.readImageProcessingInput(task.id, task.payload.inputs[0].assetId, identity);
                expect(await imageProcessingStreamBytes(original.stream)).toEqual(source);
                const completion = prepareCompletion(task, identity, artifact);
                await expect(service.completeImageProcessingTask(task.id, completion)).resolves.toMatchObject({ manifest: completion.manifest, parentRescheduled: true });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toMatchObject({ status: "success", resultPayload: { manifest: completion.manifest } });
            });

            it("reads a real registered historical object after new object writes are disabled", async () => {
                const seeded = await objectReference();
                await storageConfig.saveObjectStorageAdminSettings({ ...fixture.config, enabled: false });
                const before = await tasks.getStoredGenerationTaskRecord("agent", seeded.run.id);
                const { readExternalMediaStream } = await import("./object-storage-service");
                const stream = await readExternalMediaStream(seeded.registration);
                expect(await imageProcessingStreamBytes(stream)).toEqual(source);
                expect(await tasks.getStoredGenerationTaskRecord("agent", seeded.run.id)).toEqual(before);
            });

            it("freezes actual S3 prepare bytes/hash/layout while retaining the initial conservative stage", async () => {
                const seeded = await objectReference();
                const task = await service.enqueueImageProcessingTask(seeded.input);
                const sha256 = createHash("sha256").update(source).digest("hex");
                expect(task.payload.inputs[0]).toMatchObject({ assetId: seeded.input.inputs[0].assetId, assetVersion: seeded.input.inputs[0].assetVersion, expectedSha256: sha256 });
                expect(task.payload.resource.facts.encodedInputs[0]).toMatchObject({ bytes: source.length, sha256, layout: { format: "png", depth: "uchar", channels: 3 } });
                expect(task.payload.resource.facts.decodedInputs).toEqual([]);
                expect(task.payload.resource.requiredMemoryBytes).toBe(405 * 1024 * 1024);
                expect(task.payload.sources).toEqual([{ inputIndex: 0, scope: "reference", storageKey: seeded.storageKey, storageProvider: "object", externalStorageId: "default" }]);
                const replay = await service.enqueueImageProcessingTask({ ...seeded.input, inputs: [{ ...seeded.input.inputs[0], expectedSha256: sha256 }] });
                expect(replay.id).toBe(task.id);
                expect(replay.payload.inputDigest).toBe(task.payload.inputDigest);
                expect(replay.payload.inputs).toEqual(task.payload.inputs);
            });

            it("does not enqueue or yield the parent after an actual truncated S3 source", async () => {
                const seeded = await objectReference();
                const objectKey = seeded.registration.externalObjectKey;
                assert(objectKey);
                const transfer = fixture.control(objectKey, true);
                transfer.releaseFirst();
                transfer.releaseEnd();
                const before = await tasks.getStoredGenerationTaskRecord("agent", seeded.run.id);
                await expect(service.enqueueImageProcessingTask(seeded.input)).rejects.toThrow();
                expect(fixture.requests).toContainEqual({ method: "GET", key: objectKey });
                await transfer.closed;
                expect(await tasks.getStoredGenerationTaskRecord("agent", seeded.run.id)).toEqual(before);
                expect(await tasks.listStoredGenerationTaskRecordsByRunIds([seeded.run.id], [userId])).toEqual([]);
            });

            it("streams the original object through the input Route after new writes switch to local", async () => {
                const seeded = await objectReference();
                const task = await service.enqueueImageProcessingTask(seeded.input);
                await storageConfig.saveObjectStorageAdminSettings({ ...fixture.config, enabled: false });
                const response = await inputRequest(task);
                expect(response.status).toBe(200);
                expect(response.headers.get("content-type")).toBe("image/png");
                expect(response.headers.get("location")).toBeNull();
                expect(Buffer.from(await response.arrayBuffer())).toEqual(source);
            });

            it("streams a historical local registration after new writes switch to objects", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                expect(task.payload.sources[0].storageProvider).toBe("local");
                const response = await inputRequest(task);
                expect(response.status).toBe(200);
                expect(Buffer.from(await response.arrayBuffer())).toEqual(source);
                expect(fixture.requests).toEqual([]);
            });

            it.each([
                {
                    ending: "request abort",
                    stop: async (response: Response, controller: AbortController) => {
                        const reading = response.arrayBuffer();
                        controller.abort();
                        await expect(reading).rejects.toThrow();
                    },
                },
                {
                    ending: "Response cancellation",
                    stop: async (response: Response) => {
                        assert(response.body);
                        await response.body.cancel();
                    },
                },
            ])("cleans the real S3 input connection on $ending before the first byte", async ({ stop }) => {
                const seeded = await objectReference();
                const task = await service.enqueueImageProcessingTask(seeded.input);
                const objectKey = seeded.registration.externalObjectKey;
                assert(objectKey);
                const transfer = fixture.control(objectKey);
                const controller = new AbortController();
                const response = await inputRequest(task, controller.signal);
                expect(response.status).toBe(200);
                await transfer.headers;
                expect(transfer.connectionClosed).toBe(false);
                await stop(response, controller);
                await transfer.closed;
                expect(transfer.connectionClosed).toBe(true);
            });
        });

        describe("image processing HTTP original input boundary", () => {
            const workerToken = "fixture-image-worker-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let claimRoute: typeof import("@/app/api/maintenance/image-processing/claim/route");
            let heartbeatRoute: typeof import("@/app/api/maintenance/image-processing/[id]/heartbeat/route");
            let inputRoute: typeof import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route");

            beforeAll(async () => {
                [claimRoute, heartbeatRoute, inputRoute] = await Promise.all([
                    import("@/app/api/maintenance/image-processing/claim/route"),
                    import("@/app/api/maintenance/image-processing/[id]/heartbeat/route"),
                    import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route"),
                ]);
            });

            beforeEach(async () => {
                vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
                vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-maintenance-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
                await clearInternalFixtureTasks();
            });

            async function leasedInput() {
                const task = await service.enqueueImageProcessingTask(input);
                const claimed = await service.claimImageProcessingTasks({ workerId: "input-worker", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
                expect(claimed.tasks).toHaveLength(1);
                return { task, lease: claimed.tasks[0] };
            }

            function getInput(task: ImageProcessingTask, identity: { workerId: string; executionId: string }, assetId = task.payload.inputs[0].assetId, extraHeaders: Record<string, string> = {}) {
                return inputRoute.GET(
                    new Request(`http://localhost/api/maintenance/image-processing/${task.id}/inputs/${assetId}?format=webp&width=1&userId=ignored&storageKey=ignored`, {
                        headers: { authorization: `Bearer ${workerToken}`, "x-vozeb-pro-worker-id": identity.workerId, "x-vozeb-pro-execution-id": identity.executionId, ...extraHeaders },
                    }),
                    { params: Promise.resolve({ id: task.id, assetId }) },
                );
            }

            async function callBoundary(operation: "claim" | "heartbeat" | "input", task: ImageProcessingTask, authorization: string) {
                const headers = { authorization, "content-type": "application/json", "x-vozeb-pro-worker-id": "input-worker", "x-vozeb-pro-execution-id": "unclaimed-epoch" };
                if (operation === "claim")
                    return claimRoute.POST(
                        new Request("http://localhost/api/maintenance/image-processing/claim", {
                            method: "POST",
                            headers,
                            body: JSON.stringify({ workerId: "input-worker", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 }),
                        }),
                    );
                if (operation === "heartbeat")
                    return heartbeatRoute.POST(new Request(`http://localhost/api/maintenance/image-processing/${task.id}/heartbeat`, { method: "POST", headers, body: JSON.stringify({ workerId: "input-worker", executionId: "unclaimed-epoch" }) }), {
                        params: Promise.resolve({ id: task.id }),
                    });
                return inputRoute.GET(new Request(`http://localhost/api/maintenance/image-processing/${task.id}/inputs/${task.payload.inputs[0].assetId}`, { headers }), {
                    params: Promise.resolve({ id: task.id, assetId: task.payload.inputs[0].assetId }),
                });
            }

            it("normalizes a JSON Worker identity consistently across claim, heartbeat and streamed input headers", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                const claimed = await claimRoute.POST(
                    new Request("http://localhost/api/maintenance/image-processing/claim", {
                        method: "POST",
                        headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
                        body: JSON.stringify({ workerId: "  input-worker  ", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 }),
                    }),
                );
                expect(claimed.status).toBe(200);
                const body = await claimed.json();
                expect(body.data.tasks).toHaveLength(1);
                const executionId: string = body.data.tasks[0].executionId;
                const heartbeat = await heartbeatRoute.POST(
                    new Request(`http://localhost/api/maintenance/image-processing/${task.id}/heartbeat`, {
                        method: "POST",
                        headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
                        body: JSON.stringify({ workerId: "  input-worker  ", executionId }),
                    }),
                    { params: Promise.resolve({ id: task.id }) },
                );
                expect(heartbeat.status).toBe(200);
                const original = await getInput(task, { workerId: "  input-worker  ", executionId });
                expect(original.status).toBe(200);
                expect(original.headers.get("content-type")).toBe("image/png");
                expect(Buffer.from(await original.arrayBuffer())).toEqual(source);
            });

            it.each([
                { operation: "claim" as const, authorization: "" },
                { operation: "claim" as const, authorization: "Bearer wrong-worker-token" },
                { operation: "heartbeat" as const, authorization: "" },
                { operation: "heartbeat" as const, authorization: "Bearer wrong-worker-token" },
                { operation: "input" as const, authorization: "" },
                { operation: "input" as const, authorization: "Bearer wrong-worker-token" },
            ])("rejects $operation with missing or wrong Worker Bearer without queue writes ($authorization)", async ({ operation, authorization }) => {
                const task = await service.enqueueImageProcessingTask(input);
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                const response = await callBoundary(operation, task, authorization);
                expect(response.status).toBe(401);
                await expect(response.json()).resolves.toMatchObject({ code: 401, data: null, msg: expect.any(String) });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(parent);
            });

            it("retains the existing unconfigured Worker token 503 response", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "");
                const response = await callBoundary("claim", task, `Bearer ${workerToken}`);
                expect(response.status).toBe(503);
                await expect(response.json()).resolves.toMatchObject({ code: 503, data: null });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("claims through the authenticated JSON Route and returns its persisted epoch", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                const response = await callBoundary("claim", task, `Bearer ${workerToken}`);
                expect(response.status).toBe(200);
                const body = await response.json();
                expect(body).toMatchObject({
                    code: 0,
                    msg: expect.any(String),
                    data: { tasks: [{ id: task.id, executionId: expect.any(String), leaseUntil: expect.any(Number), inputUrls: [`/api/maintenance/image-processing/${task.id}/inputs/${task.payload.inputs[0].assetId}`] }] },
                });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toMatchObject({ status: "running", workerId: "input-worker", payload: { executionId: body.data.tasks[0].executionId } });
            });

            it("renews the current epoch through the authenticated heartbeat JSON Route", async () => {
                const { task, lease } = await leasedInput();
                const response = await heartbeatRoute.POST(
                    new Request(`http://localhost/api/maintenance/image-processing/${task.id}/heartbeat`, {
                        method: "POST",
                        headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
                        body: JSON.stringify({ workerId: "input-worker", executionId: lease.executionId }),
                    }),
                    { params: Promise.resolve({ id: task.id }) },
                );
                expect(response.status).toBe(200);
                const body = await response.json();
                expect(body).toMatchObject({ code: 0, data: { cancelRequested: false, leaseUntil: expect.any(Number) } });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toMatchObject({ workerId: "input-worker", leaseUntil: body.data.leaseUntil, payload: { executionId: lease.executionId } });
            });

            it("streams the bound original despite preview parameters and a foreign user header", async () => {
                const { task, lease } = await leasedInput();
                const response = await getInput(task, { workerId: "input-worker", executionId: lease.executionId }, task.payload.inputs[0].assetId, { accept: "image/webp", "sec-fetch-dest": "image", "x-vozeb-pro-worker-user-id": otherUserId });
                expect(response.status).toBe(200);
                expect(response.headers.get("content-type")).toBe("image/png");
                expect(response.headers.get("location")).toBeNull();
                expect(Buffer.from(await response.arrayBuffer())).toEqual(source);
            });

            it("streams all bytes appended after the input identity was frozen without advertising the old length", async () => {
                const { task, lease } = await leasedInput();
                const { readReferenceAsset } = await import("./reference-asset-store");
                const { getLocalMediaRegistration } = await import("./local-media-registry");
                const original = await readReferenceAsset(task.payload.sources[0].storageKey);
                assert(original);
                const beforeTask = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const tail = Buffer.from("tail-after-freeze");
                try {
                    await appendFile(original.filePath, tail);
                    const response = await getInput(task, { workerId: "input-worker", executionId: lease.executionId });
                    expect(response.status).toBe(200);
                    expect(response.headers.get("content-length")).toBeNull();
                    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.concat([source, tail]));
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(beforeTask);
                    expect(await getLocalMediaRegistration(task.payload.sources[0].storageKey)).toEqual(original.registration);
                } finally {
                    await writeFile(original.filePath, source);
                }
            });

            it("opens the current execution's original through the input service independently of Route plumbing", async () => {
                const { task, lease } = await leasedInput();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const original = await service.readImageProcessingInput(task.id, task.payload.inputs[0].assetId, { workerId: "input-worker", executionId: lease.executionId });
                expect(original.mimeType).toBe("image/png");
                expect(original.bytes).toBe(source.length);
                expect(await imageProcessingStreamBytes(original.stream)).toEqual(source);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("rejects malformed claim JSON at the HTTP boundary without leasing work", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await claimRoute.POST(new Request("http://localhost/api/maintenance/image-processing/claim", { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: "{" }));
                expect(response.status).toBe(400);
                await expect(response.json()).resolves.toMatchObject({ code: 400, data: null });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("rejects a heartbeat with a non-string execution identity without mutation", async () => {
                const { task } = await leasedInput();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await heartbeatRoute.POST(
                    new Request(`http://localhost/api/maintenance/image-processing/${task.id}/heartbeat`, {
                        method: "POST",
                        headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
                        body: JSON.stringify({ workerId: "input-worker", executionId: 123 }),
                    }),
                    { params: Promise.resolve({ id: task.id }) },
                );
                expect(response.status).toBe(400);
                await expect(response.json()).resolves.toMatchObject({ code: 400, data: null });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("maps the existing resource profile conflict to JSON 409 without writes", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await claimRoute.POST(
                    new Request("http://localhost/api/maintenance/image-processing/claim", {
                        method: "POST",
                        headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
                        body: JSON.stringify({ workerId: "input-worker", profileVersion: "wrong-profile", availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 }),
                    }),
                );
                expect(response.status).toBe(409);
                await expect(response.json()).resolves.toMatchObject({ code: 409, data: null });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it.each([
                { reason: "another Worker", identity: (executionId: string) => ({ workerId: "other-worker", executionId }), expired: false, cancelled: false },
                { reason: "the same Worker's old epoch", identity: () => ({ workerId: "input-worker", executionId: "old-epoch" }), expired: false, cancelled: false },
                { reason: "an expired lease", identity: (executionId: string) => ({ workerId: "input-worker", executionId }), expired: true, cancelled: false },
                { reason: "an already cancelled task", identity: (executionId: string) => ({ workerId: "input-worker", executionId }), expired: false, cancelled: true },
            ])("rejects input reads from $reason without persistent changes", async ({ identity, expired, cancelled }) => {
                const { task, lease } = await leasedInput();
                await setInputState(task, expired, cancelled);
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await getInput(task, identity(lease.executionId));
                expect(response.status).toBe(409);
                await expect(response.json()).resolves.toMatchObject({ code: 409, data: null });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("rejects an asset outside this task's input manifest with 404", async () => {
                const { task, lease } = await leasedInput();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await getInput(task, { workerId: "input-worker", executionId: lease.executionId }, "not-an-input-asset");
                expect(response.status).toBe(404);
                await expect(response.json()).resolves.toMatchObject({ code: 404, data: null });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("rejects missing input identity headers before reading the media", async () => {
                const { task } = await leasedInput();
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await inputRoute.GET(new Request(`http://localhost/api/maintenance/image-processing/${task.id}/inputs/${task.payload.inputs[0].assetId}`, { headers: { authorization: `Bearer ${workerToken}` } }), {
                    params: Promise.resolve({ id: task.id, assetId: task.payload.inputs[0].assetId }),
                });
                expect(response.status).toBe(400);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("rejects a missing media registration with 404 and no task mutation", async () => {
                const { task, lease } = await leasedInput();
                const { deleteLocalMediaRegistrations } = await import("./local-media-registry");
                await deleteLocalMediaRegistrations([task.payload.sources[0].storageKey]);
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await getInput(task, { workerId: "input-worker", executionId: lease.executionId });
                expect(response.status).toBe(404);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("rejects a registration reassigned to a foreign user with 409 and no task mutation", async () => {
                const { task, lease } = await leasedInput();
                const { getLocalMediaRegistration, registerLocalMediaAsset } = await import("./local-media-registry");
                const registration = await getLocalMediaRegistration(task.payload.sources[0].storageKey);
                assert(registration);
                await registerLocalMediaAsset({ ...registration, ownerUserId: otherUserId });
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                const response = await getInput(task, { workerId: "input-worker", executionId: lease.executionId });
                expect(response.status).toBe(409);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });
        });

        async function clearInternalFixtureTasks() {
            if (provider === "postgres") await database.postgresQuery("DELETE FROM generation_tasks WHERE task_type = 'image_processing' AND user_id = ANY($1::text[])", [[userId, otherUserId]]);
            else await tasks.withGenerationTaskFileMutation(async (records) => ({ tasks: records.filter((task) => task.type !== "image_processing" || (task.userId !== userId && task.userId !== otherUserId)), result: undefined }));
        }

        async function setInputState(task: ImageProcessingTask, expired: boolean, cancelled: boolean) {
            if (provider === "postgres")
                await database.postgresQuery(
                    "UPDATE generation_tasks SET status = CASE WHEN $3::boolean THEN 'cancelled' ELSE status END, execution_phase = CASE WHEN $3::boolean THEN 'cancel_requested' ELSE execution_phase END, lease_until = CASE WHEN $4::boolean THEN now() - interval '1 second' ELSE lease_until END WHERE id = $1 AND user_id = $2 AND task_type = 'image_processing'",
                    [task.id, task.userId, cancelled, expired],
                );
            else
                await tasks.withGenerationTaskFileMutation(async (records) => ({
                    tasks: records.map((record) =>
                        record.id === task.id && record.userId === task.userId
                            ? { ...record, status: cancelled ? "cancelled" : record.status, executionPhase: cancelled ? "cancel_requested" : record.executionPhase, leaseUntil: expired ? Date.now() - 1000 : record.leaseUntil }
                            : record,
                    ),
                    result: undefined,
                }));
        }

        describe("image processing claim and heartbeat", () => {
            beforeEach(async () => {
                if (provider === "postgres") {
                    await database.postgresQuery("DELETE FROM generation_tasks WHERE task_type = 'image_processing' AND user_id = ANY($1::text[])", [[userId, otherUserId]]);
                } else {
                    await tasks.withGenerationTaskFileMutation(async (records) => ({ tasks: records.filter((task) => task.type !== "image_processing" || (task.userId !== userId && task.userId !== otherUserId)), result: undefined }));
                }
            });

            async function enqueueReference(ownerId: string, bytes = source) {
                const seeded = await seedReference(ownerId, bytes);
                return service.enqueueImageProcessingTask(seeded.input);
            }

            async function makeDue(task: ImageProcessingTask, secondsAgo: number) {
                if (provider === "postgres") {
                    await database.postgresQuery("UPDATE generation_tasks SET next_poll_at = now() - ($3::integer * interval '1 second') WHERE id = $1 AND user_id = $2 AND task_type = 'image_processing'", [task.id, task.userId, secondsAgo]);
                } else {
                    await tasks.withGenerationTaskFileMutation(async (records) => ({
                        tasks: records.map((record) => (record.id === task.id && record.userId === task.userId ? { ...record, nextPollAt: Date.now() - secondsAgo * 1000 } : record)),
                        result: undefined,
                    }));
                }
            }

            async function seedRunning(task: ImageProcessingTask, identity: { workerId: string; executionId: string }, expired = false, cancelled = false) {
                if (provider === "postgres") {
                    await database.postgresQuery(
                        `UPDATE generation_tasks
                         SET status = CASE WHEN $6::boolean THEN 'cancelled' ELSE 'running' END,
                             execution_phase = CASE WHEN $6::boolean THEN 'cancel_requested' ELSE 'created' END,
                             payload = jsonb_set(payload, '{executionId}', to_jsonb($3::text)), worker_id = $4,
                             lease_until = CASE WHEN $5::boolean THEN now() - interval '1 second' ELSE now() + interval '30 seconds' END,
                             last_heartbeat_at = now(), next_poll_at = now()
                         WHERE id = $1 AND user_id = $2 AND task_type = 'image_processing'`,
                        [task.id, task.userId, identity.executionId, identity.workerId, expired, cancelled],
                    );
                } else {
                    const now = Date.now();
                    await tasks.withGenerationTaskFileMutation(async (records) => ({
                        tasks: records.map((record) =>
                            record.id === task.id && record.userId === task.userId
                                ? {
                                      ...record,
                                      status: cancelled ? "cancelled" : "running",
                                      executionPhase: cancelled ? "cancel_requested" : "created",
                                      payload: { ...record.payload, executionId: identity.executionId },
                                      workerId: identity.workerId,
                                      leaseUntil: now + (expired ? -1000 : 30_000),
                                      lastHeartbeatAt: now,
                                      nextPollAt: now,
                                  }
                                : record,
                        ),
                        result: undefined,
                    }));
                }
                const current = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                assert(current);
                expect(current).toMatchObject({ workerId: identity.workerId, payload: { executionId: identity.executionId } });
                return current;
            }

            it.each([
                { reason: "zero free memory", availableMemoryBytes: 0, slots: 1 },
                { reason: "zero free slots", availableMemoryBytes: 1024 * 1024 * 1024, slots: 0 },
                { reason: "insufficient temporary memory", availableMemoryBytes: 404 * 1024 * 1024, slots: 1 },
            ])("keeps pending tasks unleased with $reason", async ({ availableMemoryBytes, slots }) => {
                const task = await service.enqueueImageProcessingTask(input);
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);

                expect(await service.claimImageProcessingTasks({ workerId: "claim-worker", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes, slots })).toEqual({ tasks: [] });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it.each([
                { limit: "slots", availableMemoryBytes: 810 * 1024 * 1024, slots: 1 },
                { limit: "cumulative memory", availableMemoryBytes: 405 * 1024 * 1024, slots: 2 },
            ])("leases only the pending task admitted by the free $limit", async ({ availableMemoryBytes, slots }) => {
                vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "2");
                const first = await service.enqueueImageProcessingTask(input);
                const second = await enqueueReference(otherUserId);
                await makeDue(first, 3);
                await makeDue(second, 2);
                const beforeSecond = await tasks.getStoredGenerationTaskRecord("image_processing", second.id);
                const claimed = await service.claimImageProcessingTasks({ workerId: "claim-worker", profileVersion: first.payload.resource.profileVersion, availableMemoryBytes, slots });

                expect(claimed.tasks.map((task) => task.id)).toEqual([first.id]);
                const [lease] = claimed.tasks;
                expect(lease.executionId).toMatch(/\S/);
                expect(lease.payload.executionId).toBe(lease.executionId);
                expect(lease.inputUrls).toEqual([`/api/maintenance/image-processing/${first.id}/inputs/${first.payload.inputs[0].assetId}`]);
                const stored = await tasks.getStoredGenerationTaskRecord("image_processing", first.id);
                expect(stored).toMatchObject({ status: "running", executionPhase: "created", workerId: "claim-worker", leaseUntil: lease.leaseUntil, payload: { executionId: lease.executionId } });
                expect(lease.leaseUntil - Number(stored?.lastHeartbeatAt)).toBe(90_000);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", second.id)).toEqual(beforeSecond);
            });

            it("rejects a mismatched resource profile without modifying the parent or child", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);

                await expect(service.claimImageProcessingTasks({ workerId: "claim-worker", profileVersion: "mismatched-profile", availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 })).rejects.toMatchObject({ status: 409 });
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(beforeChild);
            });

            it.each([
                { reason: "negative memory", availableMemoryBytes: -1, slots: 1 },
                { reason: "fractional memory", availableMemoryBytes: 0.5, slots: 1 },
                { reason: "memory above the deployment budget", availableMemoryBytes: 1024 * 1024 * 1024 + 1, slots: 1 },
                { reason: "negative slots", availableMemoryBytes: 1024 * 1024 * 1024, slots: -1 },
                { reason: "fractional slots", availableMemoryBytes: 1024 * 1024 * 1024, slots: 0.5 },
                { reason: "slots above configured concurrency", availableMemoryBytes: 1024 * 1024 * 1024, slots: 2 },
            ])("rejects $reason instead of clamping and leaves the task unchanged", async ({ availableMemoryBytes, slots }) => {
                const task = await service.enqueueImageProcessingTask(input);
                const before = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);

                await expect(service.claimImageProcessingTasks({ workerId: "claim-worker", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes, slots })).rejects.toMatchObject({ status: 400 });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(before);
            });

            it("selects each user's earliest executable task before a second task from the same user", async () => {
                vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "2");
                const first = await service.enqueueImageProcessingTask(input);
                const sameUserSecond = await enqueueReference(userId);
                const otherUserFirst = await enqueueReference(otherUserId);
                await makeDue(first, 3);
                await makeDue(sameUserSecond, 2);
                await makeDue(otherUserFirst, 1);
                const beforeSecond = await tasks.getStoredGenerationTaskRecord("image_processing", sameUserSecond.id);
                const claimed = await service.claimImageProcessingTasks({ workerId: "claim-worker", profileVersion: first.payload.resource.profileVersion, availableMemoryBytes: 810 * 1024 * 1024, slots: 2 });

                expect(new Set(claimed.tasks.map((task) => task.id))).toEqual(new Set([first.id, otherUserFirst.id]));
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", sameUserSecond.id)).toEqual(beforeSecond);
            });

            it("serves another queued user across single-slot workers after the first user's task completes", async () => {
                const first = await service.enqueueImageProcessingTask(input);
                const sameUserSecond = await enqueueReference(userId);
                const otherUserFirst = await enqueueReference(otherUserId);
                await makeDue(first, 3);
                await makeDue(sameUserSecond, 2);
                await makeDue(otherUserFirst, 1);
                const beforeSecond = await tasks.getStoredGenerationTaskRecord("image_processing", sameUserSecond.id);
                expect(beforeSecond).toMatchObject({ userId, status: "pending" });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", otherUserFirst.id)).toMatchObject({ userId: otherUserId, status: "pending" });

                const firstClaim = await service.claimImageProcessingTasks({ workerId: "fairness-worker-1", profileVersion: first.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
                expect(firstClaim.tasks.map((task) => task.id)).toEqual([first.id]);
                const [firstLease] = firstClaim.tasks;
                expect(firstLease.executionId).toMatch(/\S/);
                const firstIdentity = { workerId: "fairness-worker-1", executionId: firstLease.executionId };
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", first.id)).toMatchObject({
                    userId,
                    status: "running",
                    workerId: firstIdentity.workerId,
                    leaseUntil: firstLease.leaseUntil,
                    payload: { executionId: firstLease.executionId },
                });

                const artifact = await service.writeImageProcessingOutput(first.id, "analysis", firstIdentity, { stream: imageBody(), mimeType: "image/png" });
                await expect(service.completeImageProcessingTask(first.id, prepareCompletion(first, firstIdentity, artifact))).resolves.toMatchObject({ jobId: first.id, executionId: firstLease.executionId, parentRescheduled: true });
                const completed = await tasks.getStoredGenerationTaskRecord("image_processing", first.id);
                assert(completed);
                expect(completed).toMatchObject({ userId, status: "success", executionPhase: "completed" });
                expect(completed.workerId).toBeUndefined();
                expect(completed.leaseUntil).toBeUndefined();

                const secondClaim = await service.claimImageProcessingTasks({ workerId: "fairness-worker-2", profileVersion: first.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
                expect(secondClaim.tasks.map((task) => task.id)).toEqual([otherUserFirst.id]);
                const [secondLease] = secondClaim.tasks;
                expect(secondLease.executionId).toMatch(/\S/);
                expect(secondLease.payload.executionId).toBe(secondLease.executionId);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", otherUserFirst.id)).toMatchObject({
                    userId: otherUserId,
                    status: "running",
                    workerId: "fairness-worker-2",
                    leaseUntil: secondLease.leaseUntil,
                    payload: { executionId: secondLease.executionId },
                });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", sameUserSecond.id)).toEqual(beforeSecond);
            });

            it("skips an older temporarily unaffordable task for the same user's affordable task", async () => {
                const expensive = await enqueueReference(userId, highDepthSource);
                const affordable = await service.enqueueImageProcessingTask(input);
                expect(expensive.payload.resource.requiredMemoryBytes).toBe(649 * 1024 * 1024);
                expect(affordable.payload.resource.requiredMemoryBytes).toBe(405 * 1024 * 1024);
                await makeDue(expensive, 3);
                await makeDue(affordable, 2);
                const beforeExpensive = await tasks.getStoredGenerationTaskRecord("image_processing", expensive.id);
                const claimed = await service.claimImageProcessingTasks({ workerId: "claim-worker", profileVersion: affordable.payload.resource.profileVersion, availableMemoryBytes: 405 * 1024 * 1024, slots: 1 });

                expect(claimed.tasks.map((task) => task.id)).toEqual([affordable.id]);
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", expensive.id)).toEqual(beforeExpensive);
            });

            it("takes over an expired running task with a fresh epoch even for the same worker", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                await seedRunning(task, { workerId: "claim-worker", executionId: "previous-epoch" }, true);
                const claimed = await service.claimImageProcessingTasks({ workerId: "claim-worker", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });

                expect(claimed.tasks.map((item) => item.id)).toEqual([task.id]);
                expect(claimed.tasks[0].executionId).not.toBe("previous-epoch");
                expect(claimed.tasks[0].executionId).toMatch(/\S/);
                const current = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                expect(current).toMatchObject({ status: "running", workerId: "claim-worker", payload: { executionId: claimed.tasks[0].executionId }, leaseUntil: claimed.tasks[0].leaseUntil });
                expect(claimed.tasks[0].leaseUntil - Number(current?.lastHeartbeatAt)).toBe(90_000);
                await expect(service.heartbeatImageProcessingTask(task.id, { workerId: "claim-worker", executionId: "previous-epoch" })).rejects.toMatchObject({ status: 409 });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(current);
            });

            it("does not reclaim a running task while its current lease remains valid", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                const current = await seedRunning(task, { workerId: "current-worker", executionId: "current-epoch" });

                expect(await service.claimImageProcessingTasks({ workerId: "other-worker", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 })).toEqual({ tasks: [] });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(current);
            });

            it("renews the current worker and epoch's valid lease for ninety server seconds", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                const current = await seedRunning(task, { workerId: "current-worker", executionId: "current-epoch" });
                const heartbeat = await service.heartbeatImageProcessingTask(task.id, { workerId: "current-worker", executionId: "current-epoch" });
                const renewed = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);

                expect(heartbeat.cancelRequested).toBe(false);
                expect(heartbeat.leaseUntil).toBeGreaterThan(Number(current.leaseUntil));
                expect(renewed).toMatchObject({ status: "running", workerId: "current-worker", payload: { executionId: "current-epoch" }, leaseUntil: heartbeat.leaseUntil });
                expect(heartbeat.leaseUntil - Number(renewed?.lastHeartbeatAt)).toBe(90_000);
            });

            it.each([
                { reason: "another worker", workerId: "other-worker", executionId: "current-epoch", expired: false, cancelled: false },
                { reason: "the same worker's old epoch", workerId: "current-worker", executionId: "old-epoch", expired: false, cancelled: false },
                { reason: "an expired lease", workerId: "current-worker", executionId: "current-epoch", expired: true, cancelled: false },
                { reason: "another cancelled-task worker", workerId: "other-worker", executionId: "current-epoch", expired: false, cancelled: true },
                { reason: "the cancelled owner's old epoch", workerId: "current-worker", executionId: "old-epoch", expired: false, cancelled: true },
                { reason: "the cancelled owner's expired lease", workerId: "current-worker", executionId: "current-epoch", expired: true, cancelled: true },
            ])("rejects heartbeat from $reason without changing persistent state", async ({ workerId, executionId, expired, cancelled }) => {
                const task = await service.enqueueImageProcessingTask(input);
                const current = await seedRunning(task, { workerId: "current-worker", executionId: "current-epoch" }, expired, cancelled);

                await expect(service.heartbeatImageProcessingTask(task.id, { workerId, executionId })).rejects.toMatchObject({ status: 409 });
                expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(current);
            });

            it("returns cancellation only to the current cancellation owner while retaining the cancelled state", async () => {
                const task = await service.enqueueImageProcessingTask(input);
                await seedRunning(task, { workerId: "current-worker", executionId: "current-epoch" }, false, true);
                const heartbeat = await service.heartbeatImageProcessingTask(task.id, { workerId: "current-worker", executionId: "current-epoch" });
                const current = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);

                expect(heartbeat.cancelRequested).toBe(true);
                expect(current).toMatchObject({ status: "cancelled", executionPhase: "cancel_requested", workerId: "current-worker", payload: { executionId: "current-epoch" }, leaseUntil: heartbeat.leaseUntil });
                expect(heartbeat.leaseUntil - Number(current?.lastHeartbeatAt)).toBe(90_000);
            });
        });

        if (provider === "postgres") {
            describe("image processing independent PostgreSQL processes", () => {
                let server: Server;
                let origin: string;
                const gates = new Map<string, ReturnType<typeof imageProcessingProcessGate>>();
                const results = new Map<string, ImageProcessingProcessResult>();
                const commands = new Map<ChildProcess, Promise<void>>();
                const handlers = new Set<Promise<void>>();
                const handlerErrors: unknown[] = [];

                beforeEach(async () => {
                    await database.postgresQuery("DELETE FROM generation_tasks WHERE task_type = 'image_processing' AND user_id = ANY($1::text[])", [[userId, otherUserId]]);
                    server = createServer((incoming, outgoing) => {
                        const operation = (async () => {
                            try {
                                const match = new URL(incoming.url || "/", origin).pathname.match(/^\/_image-processing-process\/([^/]+)\/(ready|selected|claimed|result)$/);
                                if (!match || incoming.method !== "POST") throw new Error("Unexpected image process fixture request");
                                const [, key, phase] = match;
                                const chunks: Buffer[] = [];
                                for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
                                const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                                if (phase === "result") results.set(key, value as ImageProcessingProcessResult);
                                else {
                                    const checkpoint = gates.get(`${key}:${phase}`);
                                    if (!checkpoint) throw new Error("Unexpected image process fixture stage");
                                    checkpoint.arrive(value as ImageProcessingProcessStage);
                                    await checkpoint.released;
                                }
                                outgoing.end("ok");
                            } catch (error) {
                                handlerErrors.push(error);
                                outgoing.writeHead(500);
                                outgoing.end("Image process fixture handler failed");
                            }
                        })();
                        handlers.add(operation);
                        void operation.finally(() => handlers.delete(operation));
                    });
                    await new Promise<void>((resolve, reject) => {
                        server.once("error", reject);
                        server.listen(0, "127.0.0.1", () => {
                            server.off("error", reject);
                            resolve();
                        });
                    });
                    const address = server.address();
                    assert(address && typeof address !== "string");
                    origin = `http://127.0.0.1:${address.port}`;
                });

                afterEach(async () => {
                    try {
                        for (const checkpoint of gates.values()) checkpoint.release();
                        const pending = [...commands.entries()];
                        for (const [child] of pending) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
                        await Promise.all(pending.map(([, exited]) => exited));
                        while (handlers.size) await Promise.allSettled([...handlers]);
                    } finally {
                        if (server?.listening) {
                            const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
                            server.closeAllConnections();
                            await closed;
                        }
                        gates.clear();
                        results.clear();
                    }
                    if (handlerErrors.length) throw new AggregateError(handlerErrors.splice(0), "Image process fixture handlers failed");
                }, 120_000);

                function command(task: ImageProcessingTask, workerId: string, action: ImageProcessingProcessInput["command"] = "claim", observeSelection = false) {
                    const key = randomUUID();
                    gates.set(`${key}:ready`, imageProcessingProcessGate());
                    gates.set(`${key}:selected`, imageProcessingProcessGate());
                    gates.set(`${key}:claimed`, imageProcessingProcessGate());
                    const processInput: ImageProcessingProcessInput = {
                        command: action,
                        origin,
                        key,
                        taskId: task.id,
                        userId: task.userId,
                        runId: task.runId,
                        workerId,
                        profileVersion: task.payload.resource.profileVersion,
                        availableMemoryBytes: 1024 * 1024 * 1024,
                        observeSelection,
                    };
                    const child = spawn(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "src/lib/server/image-processing-process-fixture.test.ts", "--no-file-parallelism", "--reporter=dot"], {
                        cwd: process.cwd(),
                        env: { ...process.env, VOZEB_PRO_DATABASE_POOL_MAX: "1", VOZEB_PRO_IMAGE_PROCESSING_PROCESS_INPUT: JSON.stringify(processInput) },
                        stdio: ["ignore", "pipe", "pipe"],
                    });
                    let output = "";
                    child.stdout?.on("data", (chunk) => {
                        output += chunk;
                    });
                    child.stderr?.on("data", (chunk) => {
                        output += chunk;
                    });
                    const completed = new Promise<ImageProcessingProcessResult>((resolve, reject) => {
                        child.once("error", reject);
                        child.once("close", (code) => {
                            const result = results.get(key);
                            results.delete(key);
                            if (code === 0 && result) resolve(result);
                            else {
                                for (const secret of [process.env.DATABASE_URL, process.env.VOZEB_PRO_ENCRYPTION_KEY].filter((value): value is string => Boolean(value))) output = output.replaceAll(secret, "[redacted]");
                                reject(new Error(`Independent image processing fixture failed (${code}): ${output}`));
                            }
                        });
                    });
                    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
                    commands.set(child, exited);
                    void exited.finally(() => commands.delete(child));
                    void completed.catch(() => {});
                    return {
                        child,
                        completed,
                        phase: (phase: "ready" | "selected" | "claimed") =>
                            Promise.race([
                                gates.get(`${key}:${phase}`)!.arrived,
                                completed.then(() => {
                                    throw new Error(`Image process actor exited before ${phase}`);
                                }),
                            ]),
                        release: (phase: "ready" | "selected" | "claimed") => gates.get(`${key}:${phase}`)!.release(),
                    };
                }

                async function waitForCancellationParentLock(locker: import("pg").Client, backendPid: number, lockerPid: number, settled: () => boolean) {
                    while (true) {
                        if (settled()) throw new Error("Fixture setup: cancel actor exited before an actual parent lock wait was observed");
                        await locker.query("SELECT pg_stat_clear_snapshot()");
                        const observed = await locker.query<{ blocked: boolean }>("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AND EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1::int AND wait_event_type = 'Lock') AS blocked", [
                            backendPid,
                            lockerPid,
                        ]);
                        if (observed.rows[0]?.blocked) return;
                    }
                }

                it("child-only queue cancellation holds the actual child lock before a competing claim skips it", async () => {
                    const task = await service.enqueueImageProcessingTask(input);
                    await markImageProcessingCancellation(cancellationInput(task).runId);
                    const rows = await cancellationTruthRows(task);
                    const cancelling = command(task, "cancel-process-actor", "cancel", true);
                    const cancelReady = await cancelling.phase("ready");
                    cancelling.release("ready");
                    const selected = await cancelling.phase("selected");
                    expect(selected).toMatchObject({ pid: cancelReady.pid, backendPid: expect.any(Number), selectedIds: [task.id] });
                    expect(await cancellationTruthRows(task)).toEqual(rows);
                    const claiming = command(task, "cancel-locked-claim-worker");
                    const claimReady = await claiming.phase("ready");
                    expect(new Set([cancelReady.pid, claimReady.pid, process.pid]).size).toBe(3);
                    claiming.release("ready");
                    const skipped = await claiming.completed;
                    expect(skipped.claims).toEqual([]);
                    expect(cancelling.child.exitCode).toBeNull();
                    expect(await cancellationTruthRows(task)).toEqual(rows);
                    cancelling.release("selected");

                    await expect(cancelling.completed).resolves.toMatchObject({ pid: cancelReady.pid, claims: [] });

                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toMatchObject({ status: "cancelled", executionPhase: "completed" });
                    expect((await cancellationTruthRows(task))[0]).toEqual(rows[0]);
                    await expect(claimForCancellation(task)).resolves.toEqual({ tasks: [] });
                    console.info("Image processing cancel lock order", { cancelPid: cancelReady.pid, claimPid: claimReady.pid, cancelBackendPid: selected.backendPid, taskId: task.id, winner: "cancel" });
                }, 120_000);

                it("child-only queue cancellation preserves the actual claim committed while cancel waits on the parent", async () => {
                    const task = await service.enqueueImageProcessingTask(input);
                    const request = cancellationInput(task);
                    await markImageProcessingCancellation(request.runId);
                    const rows = await cancellationTruthRows(task);
                    const { Client } = await import("pg");
                    const locker = new Client({ connectionString: database.getPostgresConnectionString() });
                    let transactionOpen = false;
                    try {
                        await locker.connect();
                        const backend = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                        const lockerPid = backend.rows[0].pid;
                        await locker.query("BEGIN");
                        transactionOpen = true;
                        await locker.query("SELECT id FROM vozeb_pro_generation_tasks WHERE id = $1 AND task_type = 'agent' FOR UPDATE", [request.runId]);
                        const cancelling = command(task, "cancel-waiting-process", "cancel");
                        const cancelReady = await cancelling.phase("ready");
                        assert(cancelReady.backendPid);
                        let settled = false;
                        void cancelling.completed.then(
                            () => {
                                settled = true;
                            },
                            () => {
                                settled = true;
                            },
                        );
                        cancelling.release("ready");
                        await waitForCancellationParentLock(locker, cancelReady.backendPid, lockerPid, () => settled);
                        const claiming = command(task, "cancel-claim-first-worker");
                        const claimReady = await claiming.phase("ready");
                        expect(new Set([cancelReady.pid, claimReady.pid, process.pid]).size).toBe(3);
                        claiming.release("ready");
                        const claimed = await claiming.completed;
                        expect(claimed.claims).toHaveLength(1);
                        expect(claimed.claims[0].id).toBe(task.id);
                        const owner = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                        assert(owner);
                        const ownerRows = await cancellationTruthRows(task);
                        expect(owner).toMatchObject({ status: "running", workerId: "cancel-claim-first-worker", payload: { executionId: claimed.claims[0].executionId }, leaseUntil: claimed.claims[0].leaseUntil });
                        expect(cancelling.child.exitCode).toBeNull();
                        await locker.query("COMMIT");
                        transactionOpen = false;

                        await expect(cancelling.completed).resolves.toMatchObject({ pid: cancelReady.pid, claims: [] });

                        await expectCancelledImageProcessingOwner(task, owner, ownerRows);
                        expect((await cancellationTruthRows(task))[0]).toEqual(rows[0]);
                        await expect(service.heartbeatImageProcessingTask(task.id, { workerId: "cancel-claim-first-worker", executionId: claimed.claims[0].executionId })).resolves.toMatchObject({ cancelRequested: true });
                        await expect(claimForCancellation(task)).resolves.toEqual({ tasks: [] });
                        console.info("Image processing cancel lock order", { cancelPid: cancelReady.pid, cancelBackendPid: cancelReady.backendPid, claimPid: claimReady.pid, lockerPid, taskId: task.id, winner: "claim" });
                    } finally {
                        try {
                            if (transactionOpen) await locker.query("ROLLBACK");
                        } finally {
                            await locker.end();
                        }
                    }
                }, 120_000);

                async function waitForResourceResumeParentLocks(locker: import("pg").Client, actorPids: number[], lockerPid: number, settled: () => boolean) {
                    while (true) {
                        if (settled()) throw new Error("Fixture setup: a resource resume actor exited before both actual parent lock waits were observed");
                        await locker.query("SELECT pg_stat_clear_snapshot()");
                        const observed = await locker.query<{ pid: number; blockers: number[]; blocked: boolean }>(
                            `WITH RECURSIVE blocking(actor_pid, blocker_pid) AS (
                                SELECT actor.pid, blocker.pid FROM unnest($1::int[]) AS actor(pid) CROSS JOIN LATERAL unnest(pg_blocking_pids(actor.pid)) AS blocker(pid)
                                UNION
                                SELECT blocking.actor_pid, blocker.pid FROM blocking CROSS JOIN LATERAL unnest(pg_blocking_pids(blocking.blocker_pid)) AS blocker(pid)
                             )
                             SELECT activity.pid, pg_blocking_pids(activity.pid) AS blockers,
                                    EXISTS (SELECT 1 FROM blocking WHERE actor_pid = activity.pid AND blocker_pid = $2::int)
                                    AND activity.wait_event_type = 'Lock' AND activity.query LIKE '%task_type = ''agent''%' AND activity.query LIKE '%FOR UPDATE%' AS blocked
                             FROM pg_stat_activity AS activity WHERE activity.pid = ANY($1::int[]) ORDER BY activity.pid`,
                            [actorPids, lockerPid],
                        );
                        if (observed.rows.length === 2 && observed.rows.every((row) => row.blocked)) return observed.rows;
                    }
                }

                it("lets two resource resume backends wait on the same parent and reopens the original child only once", async () => {
                    expect(process.env.VOZEB_PRO_DATABASE_POOL_MAX).toBe("1");
                    const previousHeap = process.env.VOZEB_PRO_IMAGE_PROCESS_HEAP_MB;
                    expect(previousHeap).toBe("384");
                    const { Client } = await import("pg");
                    const locker = new Client({ connectionString: database.getPostgresConnectionString() });
                    let transactionOpen = false;
                    try {
                        const task = await service.enqueueImageProcessingTask(input);
                        const claimed = await service.claimImageProcessingTasks({ workerId: "resource-race-failed-worker", profileVersion: task.payload.resource.profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
                        expect(claimed.tasks).toHaveLength(1);
                        expect(claimed.tasks[0].id).toBe(task.id);
                        const identity = { workerId: "resource-race-failed-worker", executionId: claimed.tasks[0].executionId };
                        // Registered/staged source bytes and this controlled report do not imply a native process or OOM.
                        const artifact = await service.writeImageProcessingOutput(task.id, "analysis", identity, { stream: imageBody(), mimeType: "image/png" });
                        const failure: ClosedImageProcessingFailure = {
                            status: "resource_failure",
                            reason: "v8_heap_oom",
                            jobId: task.id,
                            executionId: identity.executionId,
                            pid: 4342,
                            exitCode: 134,
                            signal: null,
                            stderr: "controlled PG race report: FATAL ERROR: Reached heap limit",
                        };
                        await expect(service.failImageProcessingTask(task.id, { ...identity, failure })).resolves.toEqual({ jobId: task.id, status: "paused", executionPhase: "needs_review" });
                        const paused = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
                        const pausedChild = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                        assert(paused && pausedChild);
                        expect(paused).toMatchObject({ id: run.id, status: "paused", ecommerceSnapshot: { processing: { waitingFor: { jobId: task.id, inputDigest: task.payload.inputDigest } } } });
                        expect(pausedChild).toMatchObject({ status: "paused", executionPhase: "needs_review", resultPayload: { ...identity, failure, artifacts: [artifact] } });
                        const { readReferenceAsset } = await import("./reference-asset-store");
                        const original = await readReferenceAsset(task.payload.sources[0].storageKey);
                        assert(original);
                        const originalBytes = await readFile(original.filePath);
                        expect(createHash("sha256").update(originalBytes).digest("hex")).toBe(task.payload.inputs[0].expectedSha256);
                        const mediaKeys = [task.payload.sources[0].storageKey, artifact.storageKey];
                        const mediaBefore = await database.postgresQuery<{ record: Record<string, unknown> }>(
                            "SELECT to_jsonb(asset) AS record FROM local_media_assets AS asset WHERE owner_user_id = $1 AND storage_key = ANY($2::text[]) ORDER BY storage_key",
                            [userId, mediaKeys],
                        );
                        expect(mediaBefore.rows).toHaveLength(2);
                        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "512");
                        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
                        const configured = imageProcessingResourceConfig(process.env);
                        expect(configured.profileVersion).not.toBe(task.payload.resource.profileVersion);
                        await locker.connect();
                        const backend = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                        const lockerPid = backend.rows[0].pid;
                        await locker.query("BEGIN");
                        transactionOpen = true;
                        await locker.query("SELECT id FROM vozeb_pro_generation_tasks WHERE id = $1 AND task_type = 'agent' FOR UPDATE", [run.id]);
                        const first = command(task, "resource-resume-actor-a", "resource_resume");
                        const second = command(task, "resource-resume-actor-b", "resource_resume");
                        const [firstReady, secondReady] = await Promise.all([first.phase("ready"), second.phase("ready")]);
                        assert(firstReady.backendPid && secondReady.backendPid);
                        expect(new Set([firstReady.pid, secondReady.pid, process.pid]).size).toBe(3);
                        expect(new Set([firstReady.backendPid, secondReady.backendPid, lockerPid]).size).toBe(3);
                        let firstSettled = false;
                        let secondSettled = false;
                        void first.completed.then(
                            () => {
                                firstSettled = true;
                            },
                            () => {
                                firstSettled = true;
                            },
                        );
                        void second.completed.then(
                            () => {
                                secondSettled = true;
                            },
                            () => {
                                secondSettled = true;
                            },
                        );
                        first.release("ready");
                        second.release("ready");
                        const lockWaits = await waitForResourceResumeParentLocks(locker, [firstReady.backendPid, secondReady.backendPid], lockerPid, () => firstSettled || secondSettled);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(pausedChild);
                        await locker.query("COMMIT");
                        transactionOpen = false;
                        const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
                        expect(firstResult.pid).toBe(firstReady.pid);
                        expect(secondResult.pid).toBe(secondReady.pid);
                        expect(firstResult.claims).toEqual([]);
                        expect(secondResult.claims).toEqual([]);
                        expect([firstResult.resourceResume, secondResult.resourceResume]).toEqual(expect.arrayContaining([{ outcome: "resumed", runId: run.id }, { outcome: "conflict" }]));
                        const rearmed = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                        const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                        assert(rearmed && parent);
                        expect(rearmed).toMatchObject({ id: task.id, userId, runId: run.id, status: "pending", executionPhase: "created" });
                        expect(rearmed.payload).toMatchObject({
                            inputDigest: task.payload.inputDigest,
                            inputs: task.payload.inputs,
                            sources: task.payload.sources,
                            options: task.payload.options,
                            resource: { profileVersion: configured.profileVersion, facts: task.payload.resource.facts },
                        });
                        expect(rearmed.payload.executionId).toBeUndefined();
                        expect(rearmed.workerId).toBeUndefined();
                        expect(rearmed.leaseUntil).toBeUndefined();
                        expect(rearmed.resultPayload).toEqual({ executionId: identity.executionId, checkpoints: [{ ...identity, failure, resource: task.payload.resource, artifacts: [artifact] }] });
                        expect(parent).toMatchObject({
                            status: "running",
                            payload: { id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId, ecommerceSnapshot: paused.ecommerceSnapshot },
                        });
                        expect(parent.workerId).toBeUndefined();
                        expect(parent.leaseUntil).toBeUndefined();
                        expect(parent.nextPollAt).toBeUndefined();
                        const next = await service.claimImageProcessingTasks({ workerId: "resource-race-successor-worker", profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 });
                        expect(next.tasks).toHaveLength(1);
                        expect(next.tasks[0].id).toBe(task.id);
                        expect(next.tasks[0].executionId).not.toBe(identity.executionId);
                        expect(await service.claimImageProcessingTasks({ workerId: "resource-race-duplicate-worker", profileVersion: configured.profileVersion, availableMemoryBytes: configured.budgetBytes, slots: 1 })).toEqual({ tasks: [] });
                        const mediaAfter = await database.postgresQuery<{ record: Record<string, unknown> }>(
                            "SELECT to_jsonb(asset) AS record FROM local_media_assets AS asset WHERE owner_user_id = $1 AND storage_key = ANY($2::text[]) ORDER BY storage_key",
                            [userId, mediaKeys],
                        );
                        expect(mediaAfter.rows).toEqual(mediaBefore.rows);
                        expect(await readFile(original.filePath)).toEqual(originalBytes);
                        console.info("Image processing resource resume competition", {
                            firstPid: firstReady.pid,
                            secondPid: secondReady.pid,
                            firstBackendPid: firstReady.backendPid,
                            secondBackendPid: secondReady.backendPid,
                            lockerPid,
                            lockWaits,
                            outcomes: [firstResult.resourceResume, secondResult.resourceResume],
                        });
                    } finally {
                        try {
                            if (transactionOpen) await locker.query("ROLLBACK");
                        } finally {
                            vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", previousHeap);
                            await locker.end();
                        }
                    }
                }, 120_000);

                it("lets two live processes compete for one task and persists only the winning epoch", async () => {
                    const task = await service.enqueueImageProcessingTask(input);
                    const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                    const first = command(task, "competition-worker-a", "claim", true);
                    const second = command(task, "competition-worker-b", "claim", true);
                    const [firstReady, secondReady] = await Promise.all([first.phase("ready"), second.phase("ready")]);
                    expect(new Set([firstReady.pid, secondReady.pid, process.pid]).size).toBe(3);
                    expect(first.child.exitCode).toBeNull();
                    expect(second.child.exitCode).toBeNull();
                    first.release("ready");
                    second.release("ready");
                    const [firstSelected, secondSelected] = await Promise.all([first.phase("selected"), second.phase("selected")]);
                    expect(firstSelected).toMatchObject({ pid: firstReady.pid, backendPid: expect.any(Number) });
                    expect(secondSelected).toMatchObject({ pid: secondReady.pid, backendPid: expect.any(Number) });
                    expect(new Set([firstSelected.backendPid, secondSelected.backendPid]).size).toBe(2);
                    assert(firstSelected.selectedIds && secondSelected.selectedIds);
                    expect([...firstSelected.selectedIds, ...secondSelected.selectedIds]).toEqual([task.id]);
                    const beforeLease = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                    expect(beforeLease?.status).toBe("pending");
                    expect(beforeLease?.workerId).toBeUndefined();
                    expect(beforeLease?.leaseUntil).toBeUndefined();
                    expect(beforeLease?.payload.executionId).toBeUndefined();
                    first.release("selected");
                    second.release("selected");
                    const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
                    expect(firstResult.pid).toBe(firstReady.pid);
                    expect(secondResult.pid).toBe(secondReady.pid);
                    const claims = [...firstResult.claims, ...secondResult.claims];
                    expect(claims).toHaveLength(1);
                    expect(claims[0].id).toBe(task.id);
                    expect(claims[0].executionId).toMatch(/\S/);
                    const winner = [firstResult, secondResult].find((result) => result.claims.length === 1);
                    assert(winner);
                    const owners = new Map([
                        [firstReady.pid, "competition-worker-a"],
                        [secondReady.pid, "competition-worker-b"],
                    ]);
                    expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toMatchObject({ status: "running", workerId: owners.get(winner.pid), payload: { executionId: claims[0].executionId }, leaseUntil: claims[0].leaseUntil });
                    expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
                }, 120_000);

                it.each([
                    { identity: "same Worker ID", nextWorkerId: "takeover-worker-a" },
                    { identity: "different Worker ID", nextWorkerId: "takeover-worker-b" },
                ])(
                    "rejects the still-live old process after a fresh process takes over with $identity",
                    async ({ nextWorkerId }) => {
                        const task = await service.enqueueImageProcessingTask(input);
                        const beforeParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                        const old = command(task, "takeover-worker-a", "late_heartbeat");
                        const oldReady = await old.phase("ready");
                        old.release("ready");
                        const held = await old.phase("claimed");
                        expect(held.pid).toBe(oldReady.pid);
                        assert(held.claims);
                        expect(held.claims).toHaveLength(1);
                        const oldEpoch = held.claims[0].executionId;
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toMatchObject({ workerId: "takeover-worker-a", payload: { executionId: oldEpoch } });
                        const expired = await database.postgresQuery(
                            "UPDATE generation_tasks SET lease_until = now() - interval '1 second' WHERE id = $1 AND user_id = $2 AND task_type = 'image_processing' AND worker_id = 'takeover-worker-a' AND payload ->> 'executionId' = $3",
                            [task.id, userId, oldEpoch],
                        );
                        expect(expired.rowCount).toBe(1);

                        const fresh = command(task, nextWorkerId);
                        const freshReady = await fresh.phase("ready");
                        expect(new Set([held.pid, freshReady.pid, process.pid]).size).toBe(3);
                        expect(old.child.exitCode).toBeNull();
                        expect(fresh.child.exitCode).toBeNull();
                        fresh.release("ready");
                        const freshResult = await fresh.completed;
                        expect(freshResult.pid).toBe(freshReady.pid);
                        expect(freshResult.claims).toHaveLength(1);
                        expect(freshResult.claims[0].id).toBe(task.id);
                        expect(freshResult.claims[0].executionId).not.toBe(oldEpoch);
                        expect(freshResult.claims[0].executionId).toMatch(/\S/);
                        const current = await tasks.getStoredGenerationTaskRecord("image_processing", task.id);
                        expect(current).toMatchObject({ status: "running", workerId: nextWorkerId, payload: { executionId: freshResult.claims[0].executionId }, leaseUntil: freshResult.claims[0].leaseUntil });
                        expect(old.child.exitCode).toBeNull();
                        old.release("claimed");
                        const lateResult = await old.completed;
                        expect(lateResult).toMatchObject({ pid: held.pid, heartbeatStatus: 409 });
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", task.id)).toEqual(current);
                        expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(beforeParent);
                    },
                    120_000,
                );
            });

            it.each([
                { target: "parent", predicate: (id: string) => `id <> '${id}' OR payload #> '{ecommerceSnapshot,processing,waitingFor}' IS NULL` },
                { target: "child", predicate: (id: string) => `task_type <> 'image_processing' OR run_id IS DISTINCT FROM '${id}'` },
            ])("rolls back both records when PostgreSQL rejects the $target write", async ({ predicate }) => {
                const constraint = `fixture_image_processing_${randomUUID().replaceAll("-", "")}`;
                const before = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                await database.postgresQuery(`ALTER TABLE generation_tasks ADD CONSTRAINT ${constraint} CHECK (${predicate(run.id)})`);
                try {
                    await expect(service.enqueueImageProcessingTask(input)).rejects.toMatchObject({ code: "23514", constraint });
                    expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(before);
                    expect(await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).toEqual([]);
                } finally {
                    await database.postgresQuery(`ALTER TABLE generation_tasks DROP CONSTRAINT ${constraint}`);
                }
            });
        }
    });
}

function imageProcessingProcessGate() {
    const arrived = Promise.withResolvers<ImageProcessingProcessStage>();
    const released = Promise.withResolvers<void>();
    return { arrived: arrived.promise, released: released.promise, arrive: arrived.resolve, release: () => released.resolve() };
}
