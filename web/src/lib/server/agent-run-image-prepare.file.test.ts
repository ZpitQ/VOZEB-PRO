import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSettings } from "@/lib/auth/store";
import { settings } from "./agent-run-executor.test-fixtures";
import type { AgentRun } from "./agent-run-store";

const boundary = vi.hoisted(() => ({
    settings: vi.fn<() => Promise<AuthSettings>>(),
    request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
    model: vi.fn<typeof import("./text-planning-runtime").requestStructuredText>(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => ({ id: "agent-prepare-entry-user" }) }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));

vi.mock("@/lib/auth/store", async (original) => ({ ...(await original<typeof import("@/lib/auth/store")>()), getAuthSettings: boundary.settings }));
vi.mock("./internal-origin", async (original) => ({ ...(await original<typeof import("./internal-origin")>()), fetchInternalApi: boundary.request }));
vi.mock("./text-planning-runtime", async (original) => ({ ...(await original<typeof import("./text-planning-runtime")>()), requestStructuredText: boundary.model }));
vi.mock("./object-storage-service", async (original) => ({ ...(await original<typeof import("./object-storage-service")>()), persistExternalMediaIfEnabled: async () => null }));
vi.mock("./safe-outbound-fetch", async (original) => ({
    ...(await original<typeof import("./safe-outbound-fetch")>()),
    fetchSafeOutbound: async () => {
        throw new Error("Fixture forbids outbound HTTP");
    },
}));

describe("Agent reference prepare through real file storage", () => {
    let directory: string;
    let runtime: typeof import("./creative-runtime-store");
    let runs: typeof import("./agent-run-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let references: typeof import("./reference-asset-store");
    let executor: typeof import("./agent-run-executor");
    let service: typeof import("./image-processing-service");
    let actionRoute: typeof import("@/app/api/agent/runs/[id]/[action]/route");
    const userId = "agent-prepare-entry-user";
    const origin = "http://fixture.local";

    beforeEach(async () => {
        vi.resetModules();
        boundary.settings.mockReset();
        boundary.request.mockReset();
        boundary.model.mockReset();
        boundary.model.mockRejectedValue(new Error("Fixture stops model transport before any upstream submission"));
        directory = await mkdtemp(join(tmpdir(), "vozeb-agent-reference-prepare-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const configured: AuthSettings = settings("image-model", "image-channel");
        configured.ecommerceGenerationEnabled = true;
        configured.ecommerceVisualQualityCheckEnabled = false;
        configured.ecommerceModelRoles = { vision_analysis: ["planner"], edit_planning: ["planner"], image_generation: ["image-model"], quality_check: [] };
        configured.systemChannels[1].models = ["gpt-image-2.5-flare"];
        configured.logicalModels[1].bindings[0].upstreamModel = "gpt-image-2.5-flare";
        boundary.settings.mockResolvedValue(configured);
        [runtime, runs, tasks, scheduler, references, executor, service, actionRoute] = await Promise.all([
            import("./creative-runtime-store"),
            import("./agent-run-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./reference-asset-store"),
            import("./agent-run-executor"),
            import("./image-processing-service"),
            import("@/app/api/agent/runs/[id]/[action]/route"),
        ]);
        const { getDatabaseProvider } = await import("./database");
        expect(getDatabaseProvider()).toBe("file");
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("enqueues its first registered reference and yields the original Run before visual analysis or upstream submission", async () => {
        const userId = "agent-prepare-entry-user";
        const origin = "http://fixture.local";
        const source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#8a6243" } })
            .png()
            .toBuffer();
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const stored = await references.writeReferenceImageDataUrl("data:image/png;base64," + source.toString("base64"), { ownerUserId: userId, conversationId: conversation.id, source: "fixture-agent-prepare-entry" });
        const media = await references.readReferenceAsset(stored.token);
        assert(media, "The fixture reference must exist on disk");
        expect(media.registration).toMatchObject({ ownerUserId: userId, scope: "reference", type: "image", storageKey: stored.token });
        expect(await readFile(media.filePath)).toEqual(source);
        const [asset] = await runtime.registerCreativeAssets([
            { userId, conversationId: conversation.id, ordinal: 0, type: "image", title: "product.png", sourceRunId: "upload", serverUrl: "/api/reference-assets/" + stored.token, storageKey: stored.token, width: 24, height: 18, metadata: {} },
        ]);
        boundary.request.mockImplementation(async (url, init) => {
            expect(url).toBe(origin + asset.serverUrl);
            expect(init?.method || "GET").toBe("GET");
            return new Response(new Uint8Array(await readFile(media.filePath)), { headers: { "content-type": "image/png" } });
        });
        const { run } = await runs.createAgentRun(userId, {
            clientRequestId: "agent-prepare-entry-first",
            conversationId: conversation.id,
            surface: "chat",
            prompt: "把图片1中的商品放入明亮客厅",
            assetIds: [asset.id],
            skillIds: [],
            modelIds: [],
            preferences: { mode: "image" },
        });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        const claimed = await scheduler.claimDueGenerationTasks({ workerId: "agent-prepare-entry-parent", taskIds: [run.id], limit: 1 });
        expect(claimed).toMatchObject([{ id: run.id, workerId: "agent-prepare-entry-parent" }]);
        const ownedParent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
        assert(ownedParent);
        expect(ownedParent.workerId).toBe("agent-prepare-entry-parent");
        expect(ownedParent.leaseUntil).toBeGreaterThan(Date.now());

        await executor.executeAgentRun(run, origin, "session=fixture");

        const saved = await runs.getAgentRun(run.id);
        assert(saved);
        const snapshot = saved.ecommerceSnapshot;
        assert(snapshot, "The real Agent must reach the active ecommerce branch");
        expect(snapshot).toMatchObject({
            version: "ecommerce-generation.v1",
            mode: "active",
            input: { assetIds: [asset.id] },
            referenceCheckpoint: { assets: [{ asset: { id: asset.id, userId, conversationId: conversation.id, serverUrl: asset.serverUrl } }] },
        });
        expect(saved.failure, "Configuration or ownership failures are not a valid prepare RED").toBeUndefined();
        expect(snapshot.visualAnalysisFailure?.kind, "Unreadable fixture media is not a valid prepare RED").not.toBe("input_media");
        assert(snapshot.referenceCheckpoint);
        const records = await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId]);
        const stages = records.filter((record) => record.type === "image_processing");
        const diagnostics = JSON.stringify({
            runId: saved.id,
            status: saved.status,
            fallback: snapshot.fallback,
            failure: snapshot.visualAnalysisFailure,
            stageIds: stages.map((stage) => stage.id),
            modelCalls: boundary.model.mock.calls.length,
            httpCalls: boundary.request.mock.calls.map(([url, init]) => ({ url, method: init?.method || "GET" })),
        });
        expect(stages, diagnostics).toHaveLength(1);
        const stage = stages[0];
        expect(stage).toMatchObject({
            type: "image_processing",
            userId,
            runId: run.id,
            parentTaskId: run.id,
            status: "pending",
            executionPhase: "created",
            payload: { operation: "prepare_reference", inputs: [{ assetId: asset.id, assetVersion: snapshot.referenceCheckpoint.assets[0].assetVersion }] },
        });
        expect(snapshot.processing).toMatchObject({
            version: "image-processing-checkpoint.v1",
            prepareReferences: [{ assetId: asset.id, assetVersion: snapshot.referenceCheckpoint.assets[0].assetVersion, jobId: stage.id, inputDigest: stage.payload.inputDigest }],
            waitingFor: { jobId: stage.id, inputDigest: stage.payload.inputDigest },
        });
        expect(saved).toMatchObject({ id: run.id, status: "running", tasks: [] });
        expect(saved.executionId).toBeUndefined();
        const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
        assert(parent);
        expect(parent.workerId).toBeUndefined();
        expect(parent.leaseUntil).toBeUndefined();
        expect(parent.nextPollAt).toBeUndefined();
        expect(boundary.model).not.toHaveBeenCalled();
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    });

    async function seedReference(conversationId: string, ordinal: number, width: number, height: number, background: string) {
        const source = await sharp({ create: { width, height, channels: 3, background } })
            .png()
            .toBuffer();
        const stored = await references.writeReferenceImageDataUrl("data:image/png;base64," + source.toString("base64"), { ownerUserId: userId, conversationId, source: "fixture-agent-prepare-reentry" });
        const media = await references.readReferenceAsset(stored.token);
        assert(media);
        expect(media.registration).toMatchObject({ ownerUserId: userId, storageKey: stored.token, scope: "reference" });
        expect(await readFile(media.filePath)).toEqual(source);
        const [asset] = await runtime.registerCreativeAssets([
            {
                userId,
                conversationId,
                ordinal,
                type: "image",
                title: "reference.png",
                sourceRunId: "upload",
                serverUrl: "/api/reference-assets/" + stored.token + "?sourceProof=original&format=webp&width=12&download=1",
                storageKey: stored.token,
                width,
                height,
                metadata: {},
            },
        ]);
        return { asset, source, sourceSha256: createHash("sha256").update(source).digest("hex"), path: media.filePath };
    }

    function serveRegisteredReferences() {
        boundary.request.mockImplementation(async (url, init) => {
            expect(init?.method || "GET").toBe("GET");
            const pathname = new URL(url).pathname;
            expect(pathname).toMatch(/^\/api\/reference-assets\//);
            const media = await references.readReferenceAsset(decodeURIComponent(pathname.slice("/api/reference-assets/".length)));
            assert(media, "Every fixture HTTP response must come from real registered media");
            expect(media.registration?.ownerUserId).toBe(userId);
            return new Response(new Uint8Array(await readFile(media.filePath)), { headers: { "content-type": media.mimeType } });
        });
    }

    async function claimAndExecute(runId: string, workerId: string) {
        const due = await tasks.getStoredGenerationTaskRecord("agent", runId);
        assert(due);
        expect(due.workerId).toBeUndefined();
        expect(due.leaseUntil).toBeUndefined();
        expect(due.nextPollAt).toBeGreaterThan(0);
        const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [runId], limit: 1 });
        expect(claimed).toMatchObject([{ id: runId, workerId }]);
        const current = await runs.getAgentRun(runId);
        assert(current);
        await executor.executeAgentRun(current, origin, "session=fixture");
        const saved = await runs.getAgentRun(runId);
        assert(saved);
        return saved;
    }

    async function waitingPrepare(runId: string, assetId: string, count: number) {
        const run = await runs.getAgentRun(runId);
        assert(run?.ecommerceSnapshot?.referenceCheckpoint);
        expect(run.ecommerceSnapshot.mode).toBe("active");
        expect(run.failure, "A configuration/ownership failure is not a valid prepare RED").toBeUndefined();
        expect(run.ecommerceSnapshot.visualAnalysisFailure?.kind, "Unreadable source media is not a valid prepare RED").not.toBe("input_media");
        const children = (await tasks.listStoredGenerationTaskRecordsByRunIds([runId], [userId])).filter((record) => record.type === "image_processing");
        const diagnostics = JSON.stringify({ status: run.status, fallback: run.ecommerceSnapshot.fallback, visualFailure: run.ecommerceSnapshot.visualAnalysisFailure, children, modelCalls: boundary.model.mock.calls.length });
        expect(children, diagnostics).toHaveLength(count);
        const waiting = run.ecommerceSnapshot.processing?.waitingFor;
        assert(waiting, diagnostics);
        const stage = await tasks.getStoredGenerationTaskRecord("image_processing", waiting.jobId);
        assert(stage);
        expect(stage).toMatchObject({ userId, runId, parentTaskId: runId, status: "pending", payload: { operation: "prepare_reference", inputs: [{ assetId }] } });
        expect(waiting.inputDigest).toBe(stage.payload.inputDigest);
        expect(run.executionId).toBeUndefined();
        const parent = await tasks.getStoredGenerationTaskRecord("agent", runId);
        assert(parent);
        expect(parent.workerId).toBeUndefined();
        expect(parent.leaseUntil).toBeUndefined();
        expect(parent.nextPollAt).toBeUndefined();
        return stage;
    }

    async function completePrepare(jobId: string) {
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const workerId = "prepare-reentry-image-worker";
        const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const task = claimed.tasks[0];
        expect(task.id).toBe(jobId);
        assert(task.payload.operation === "prepare_reference");
        const identity = { workerId, executionId: task.executionId };
        const taskDirectory = await mkdtemp(join(directory, "native-prepare-"));
        const filename = join(taskDirectory, "source.png");
        const input = await service.readImageProcessingInput(jobId, task.payload.inputs[0].assetId, identity);
        await pipeline(input.stream, createWriteStream(filename, { flags: "wx" }));
        const outputDirectory = join(taskDirectory, "outputs");
        await mkdir(outputDirectory);
        const outcome = await runImageProcessing(
            { version: "image-processing.v1", operation: "prepare_reference", options: {}, jobId, executionId: identity.executionId, inputs: [{ ...task.payload.inputs[0], path: filename }], outputDirectory },
            { taskDirectory, maxHeapMiB: task.payload.resource.configuration.processHeapMb },
        );
        expect(outcome).toMatchObject({ status: "completed", jobId, executionId: identity.executionId, exitCode: 0, signal: null });
        assert(outcome.status === "completed");
        const { artifacts, metrics, ...manifest } = outcome.result;
        const native = artifacts[0];
        expect(native.kind).toBe("analysis");
        expect(native.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(native.width).toBeLessThanOrEqual(2048);
        expect(native.height).toBeLessThanOrEqual(2048);
        const bytes = await readFile(native.path);
        const response = new Response(new Uint8Array(bytes));
        assert(response.body);
        const artifact = await service.writeImageProcessingOutput(jobId, "analysis", identity, { stream: response.body, mimeType: native.mimeType });
        expect(artifact).toMatchObject({ kind: "analysis", sha256: native.sha256, bytes: native.bytes, width: native.width, height: native.height });
        const completedManifest = { ...manifest, artifacts: [artifact] };
        expect(await service.completeImageProcessingTask(jobId, { ...identity, manifest: completedManifest, metrics })).toMatchObject({ jobId, executionId: identity.executionId, parentRescheduled: true });
        return { jobId, inputDigest: task.payload.inputDigest, input: task.payload.inputs[0], manifest: completedManifest, artifact, dataUrl: "data:" + artifact.mimeType + ";base64," + bytes.toString("base64") };
    }

    function productVisionReply(assetId: string) {
        return {
            arguments: JSON.stringify({
                analysisVersion: "ecommerce-visual-analysis.v4",
                references: [
                    {
                        assetId,
                        contentType: "isolated_product",
                        confidence: "high",
                        visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                        productFacts: { identity: "chair", outline: "chair", color: "oak", material: "wood", brandText: [], view: "front" },
                        sceneFacts: null,
                        productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
                        fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
                        editableTargets: [],
                        visibleStructure: [],
                        cues: [],
                    },
                ],
                purposeSuggestions: [],
            }),
            headers: new Headers(),
            protocol: "chat" as const,
            elapsedMs: 1,
        };
    }

    async function completedVisualCheckpoint() {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const reference = await seedReference(conversation.id, 0, 2100, 1050, "#8a6243");
        serveRegisteredReferences();
        const { run } = await runs.createAgentRun(userId, {
            clientRequestId: "prepare-checkpoint",
            conversationId: conversation.id,
            surface: "chat",
            prompt: "修改图片1",
            assetIds: [reference.asset.id],
            skillIds: [],
            modelIds: [],
            preferences: { mode: "image" },
        });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        await claimAndExecute(run.id, "checkpoint-prepare-parent");
        const queued = await waitingPrepare(run.id, reference.asset.id, 1);
        const phase = await completePrepare(queued.id);
        boundary.model.mockResolvedValueOnce(productVisionReply(reference.asset.id));
        const accepted = await claimAndExecute(run.id, "checkpoint-vision-parent");
        expect(accepted).toMatchObject({
            status: "failed",
            failureStage: "planning",
            ecommerceSnapshot: {
                referenceCheckpoint: { analysisStage: { state: "completed" }, analysis: { analysisVersion: "ecommerce-visual-analysis.v4" } },
                modelRouteSnapshots: { vision_analysis: { logicalModelId: "planner", channelId: "planner-channel" } },
            },
        });
        expect(boundary.model.mock.calls).toHaveLength(2);
        expect(boundary.model.mock.calls[0][0].tool.name).toBe("analyze_ecommerce_references");
        expect(boundary.model.mock.calls[1][0].tool.name).not.toBe("analyze_ecommerce_references");
        assert(accepted.ecommerceSnapshot?.referenceCheckpoint?.analysis);
        expect(await scheduler.releaseGenerationTaskLease("agent", run.id, "checkpoint-vision-parent", { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "fixture-planning-stopped" })).not.toBeNull();
        return { run, accepted, reference, phase };
    }

    async function actOnOriginalRun(run: AgentRun, action: "pause" | "resume" | "retry" | "cancel") {
        const response = await actionRoute.POST(new Request(origin + "/api/agent/runs/" + run.id + "/" + action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: run.conversationId }) }), {
            params: Promise.resolve({ id: run.id, action }),
        });
        expect(response.status).toBe(200);
        return response;
    }

    it("consumes two real prepare completions across three claims of the same Run before sending bounded analysis images", async () => {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const first = await seedReference(conversation.id, 0, 2100, 1050, "#8a6243");
        const second = await seedReference(conversation.id, 1, 2160, 1080, "#102030");
        serveRegisteredReferences();
        const { run } = await runs.createAgentRun(userId, {
            clientRequestId: "prepare-two-references",
            conversationId: conversation.id,
            surface: "chat",
            prompt: "按图片1和图片2准备这次创作",
            assetIds: [first.asset.id, second.asset.id],
            skillIds: [],
            modelIds: [],
            preferences: { mode: "image" },
        });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        await claimAndExecute(run.id, "two-reference-parent-one");
        const firstStage = await waitingPrepare(run.id, first.asset.id, 1);
        expect(boundary.model).not.toHaveBeenCalled();
        const firstPhase = await completePrepare(firstStage.id);
        const afterFirst = await runs.getAgentRun(run.id);
        assert(afterFirst?.ecommerceSnapshot?.referenceCheckpoint);
        expect(afterFirst.ecommerceSnapshot.referenceCheckpoint.assets[0]).toMatchObject({ contentSha256: first.sourceSha256, asset: { width: 2100, height: 1050 } });
        expect(afterFirst.ecommerceSnapshot.referenceCheckpoint.assets[0].assetVersion).not.toBe(firstPhase.input.assetVersion);
        expect(afterFirst.ecommerceSnapshot.processing?.prepareReferences[0]).toMatchObject({ jobId: firstStage.id, assetVersion: firstPhase.input.assetVersion, manifest: firstPhase.manifest });

        await claimAndExecute(run.id, "two-reference-parent-two");
        const secondStage = await waitingPrepare(run.id, second.asset.id, 2);
        expect(secondStage.id).not.toBe(firstStage.id);
        expect(boundary.model).not.toHaveBeenCalled();
        const secondPhase = await completePrepare(secondStage.id);
        const delivered = await claimAndExecute(run.id, "two-reference-parent-three");
        const snapshot = delivered.ecommerceSnapshot;
        assert(snapshot?.referenceCheckpoint && snapshot.processing);
        expect(delivered).toMatchObject({ id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId });
        expect(snapshot.referenceCheckpoint.assets).toMatchObject([
            { asset: { id: first.asset.id, width: 2100, height: 1050 }, contentSha256: first.sourceSha256 },
            { asset: { id: second.asset.id, width: 2160, height: 1080 }, contentSha256: second.sourceSha256 },
        ]);
        expect(snapshot.processing.prepareReferences).toEqual([
            { assetId: first.asset.id, assetVersion: firstPhase.input.assetVersion, jobId: firstStage.id, inputDigest: firstPhase.inputDigest, manifest: firstPhase.manifest },
            { assetId: second.asset.id, assetVersion: secondPhase.input.assetVersion, jobId: secondStage.id, inputDigest: secondPhase.inputDigest, manifest: secondPhase.manifest },
        ]);
        expect(snapshot.processing.waitingFor).toBeUndefined();
        const stages = (await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).filter((record) => record.type === "image_processing");
        expect(stages).toHaveLength(2);
        expect(stages).toEqual(expect.arrayContaining([expect.objectContaining({ id: firstStage.id, status: "success" }), expect.objectContaining({ id: secondStage.id, status: "success" })]));
        expect(firstPhase.artifact).toMatchObject({ width: 2048, height: 1024 });
        expect(firstPhase.artifact.sha256).not.toBe(first.sourceSha256);
        expect(boundary.model.mock.calls).toHaveLength(1);
        const request = boundary.model.mock.calls[0][0];
        expect(request.tool.name).toBe("analyze_ecommerce_references");
        const userMessage = request.messages[1];
        assert(Array.isArray(userMessage.content));
        expect(userMessage.content).toEqual(
            expect.arrayContaining([
                { type: "image_url", image_url: { url: firstPhase.dataUrl } },
                { type: "image_url", image_url: { url: secondPhase.dataUrl } },
            ]),
        );
        const description = userMessage.content[0];
        assert("text" in description);
        expect(JSON.parse(description.text).assets).toEqual([
            { id: first.asset.id, width: 2100, height: 1050 },
            { id: second.asset.id, width: 2160, height: 1080 },
        ]);
        expect(boundary.request.mock.calls.map(([url]) => url)).toEqual([origin + "/api/reference-assets/" + firstPhase.artifact.storageKey, origin + "/api/reference-assets/" + secondPhase.artifact.storageKey]);
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    }, 30_000);

    it("keeps the same pending prepare through actual pause and resume actions and releases its recovery queue lease", async () => {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const reference = await seedReference(conversation.id, 0, 2100, 1050, "#8a6243");
        serveRegisteredReferences();
        const { run } = await runs.createAgentRun(userId, {
            clientRequestId: "prepare-pending-replay",
            conversationId: conversation.id,
            surface: "chat",
            prompt: "修改图片1",
            assetIds: [reference.asset.id],
            skillIds: [],
            modelIds: [],
            preferences: { mode: "image" },
        });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        await claimAndExecute(run.id, "pending-original-parent");
        const queued = await waitingPrepare(run.id, reference.asset.id, 1);
        const before = await runs.getAgentRun(run.id);
        assert(before?.ecommerceSnapshot?.processing?.waitingFor);
        await actOnOriginalRun(run, "pause");
        const paused = await runs.getAgentRun(run.id);
        expect(paused).toMatchObject({ id: run.id, status: "paused", ecommerceSnapshot: { processing: before.ecommerceSnapshot.processing } });
        await actOnOriginalRun(run, "resume");
        const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
        const recovered = await runGenerationTaskRecoveryBatch({ origin, cookie: "session=fixture", limit: 1, taskIds: [run.id], workerId: "pending-resumed-parent" });
        expect(recovered).toMatchObject({ claimed: 1, pending: 1, failed: 0, completed: 0 });
        const resumed = await runs.getAgentRun(run.id);
        assert(resumed);
        expect(resumed).toMatchObject({ id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId, status: "running", tasks: [] });
        expect(resumed.ecommerceSnapshot?.processing).toEqual(before.ecommerceSnapshot.processing);
        const stages = (await tasks.listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).filter((record) => record.type === "image_processing");
        expect(stages).toEqual([queued]);
        const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
        assert(parent);
        expect(parent.workerId).toBeUndefined();
        expect(parent.leaseUntil).toBeUndefined();
        expect(parent.executionPhase).toBe("polling");
        expect(parent.nextPollAt).toBeGreaterThan(0);
        console.info("Agent pending prepare replay recovery", { runId: run.id, jobId: queued.id, runExecutionId: resumed.executionId, queueWorkerId: parent.workerId, queueLeaseUntil: parent.leaseUntil, queueNextPollAt: parent.nextPollAt });
        expect(boundary.model).not.toHaveBeenCalled();
        expect(boundary.request).not.toHaveBeenCalled();
    }, 30_000);

    it("cancels its claimed native prepare through the user action while preserving another Run", async () => {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const reference = await seedReference(conversation.id, 0, 2100, 1050, "#8a6243");
        serveRegisteredReferences();
        const { run } = await runs.createAgentRun(userId, {
            clientRequestId: "native-cancel-original",
            conversationId: conversation.id,
            surface: "chat",
            prompt: "修改图片1",
            assetIds: [reference.asset.id],
            skillIds: [],
            modelIds: [],
            preferences: { mode: "image" },
        });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        await claimAndExecute(run.id, "native-cancel-original-parent");
        const queued = await waitingPrepare(run.id, reference.asset.id, 1);
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const claimInput = { workerId: "native-cancel-worker", profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 };
        const claimed = await service.claimImageProcessingTasks(claimInput);
        expect(claimed.tasks).toHaveLength(1);
        const native = claimed.tasks[0];
        expect(native.id).toBe(queued.id);
        const identity = { workerId: claimInput.workerId, executionId: native.executionId };
        const beforeChild = await tasks.getStoredGenerationTaskRecord("image_processing", queued.id);
        assert(beforeChild);
        expect(beforeChild).toMatchObject({
            userId,
            runId: run.id,
            parentTaskId: run.id,
            status: "running",
            workerId: identity.workerId,
            payload: { operation: "prepare_reference", inputDigest: queued.payload.inputDigest, executionId: identity.executionId, inputs: [{ assetId: reference.asset.id, expectedSha256: reference.sourceSha256 }] },
        });
        expect(beforeChild.leaseUntil).toBe(native.leaseUntil);
        expect(beforeChild.leaseUntil).toBeGreaterThan(Date.now());
        expect(beforeChild.resultPayload).toBeUndefined();

        const { run: otherRun } = await runs.createAgentRun(userId, {
            clientRequestId: "native-cancel-other",
            conversationId: conversation.id,
            surface: "chat",
            prompt: "修改图片1",
            assetIds: [reference.asset.id],
            skillIds: [],
            modelIds: [],
            preferences: { mode: "image" },
        });
        expect(otherRun.id).not.toBe(run.id);
        await scheduler.scheduleGenerationTask("agent", otherRun.id, { executionPhase: "created", nextPollAt: Date.now() });
        await claimAndExecute(otherRun.id, "native-cancel-other-parent");
        const otherChild = await waitingPrepare(otherRun.id, reference.asset.id, 1);
        expect(otherChild.id).not.toBe(queued.id);
        const otherParent = await tasks.getStoredGenerationTaskRecord("agent", otherRun.id);
        assert(otherParent);
        const beforeRun = await runs.getAgentRun(run.id);
        assert(beforeRun?.ecommerceSnapshot?.processing?.waitingFor);
        expect(beforeRun.ecommerceSnapshot.processing.waitingFor).toMatchObject({ jobId: queued.id, inputDigest: queued.payload.inputDigest });
        expect(beforeRun.tasks).toEqual([]);

        const response = await actOnOriginalRun(run, "cancel");
        expect(await response.json()).toMatchObject({ code: 0, data: { run: { id: run.id, status: "cancelled" } } });
        const cancelled = await runs.getAgentRun(run.id);
        expect(cancelled).toMatchObject({ id: run.id, userId, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId, status: "cancelled" });
        expect(await tasks.getStoredGenerationTaskRecord("agent", otherRun.id)).toEqual(otherParent);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", otherChild.id)).toEqual(otherChild);
        const afterChild = await tasks.getStoredGenerationTaskRecord("image_processing", queued.id);
        assert(afterChild);
        expect(afterChild).toMatchObject({ id: queued.id, userId, runId: run.id, parentTaskId: run.id });
        expect(afterChild.payload).toEqual(beforeChild.payload);
        expect(afterChild.resultPayload).toEqual(beforeChild.resultPayload);
        expect(afterChild.workerId).toBe(beforeChild.workerId);
        expect(afterChild.leaseUntil).toBe(beforeChild.leaseUntil);
        expect(afterChild.lastHeartbeatAt).toBe(beforeChild.lastHeartbeatAt);
        expect(boundary.model).not.toHaveBeenCalled();
        expect(boundary.request).not.toHaveBeenCalled();

        expect(afterChild, "The user cancel action must cancel the actual waiting native child, not only its Agent Run").toMatchObject({ status: "cancelled", executionPhase: "cancel_requested" });
        expect(afterChild.nextPollAt).toBeUndefined();
        await expect(service.heartbeatImageProcessingTask(queued.id, identity)).resolves.toMatchObject({ cancelRequested: true });
        const next = await service.claimImageProcessingTasks({ ...claimInput, workerId: "native-cancel-other-worker" });
        expect(next.tasks).toHaveLength(1);
        expect(next.tasks[0].id).toBe(otherChild.id);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", queued.id)).toMatchObject({ status: "cancelled", executionPhase: "cancel_requested", workerId: identity.workerId, payload: { executionId: identity.executionId } });
        expect(await runs.getAgentRun(run.id)).toMatchObject({ id: run.id, status: "cancelled" });
    }, 30_000);

    it("reuses its accepted visual checkpoint and original prepare job through the actual same-Run retry action", async () => {
        const fixture = await completedVisualCheckpoint();
        const beforeStage = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.phase.jobId);
        const beforeSnapshot = fixture.accepted.ecommerceSnapshot;
        assert(beforeSnapshot?.referenceCheckpoint);
        boundary.model.mockClear();
        boundary.request.mockClear();
        await actOnOriginalRun(fixture.run, "retry");
        const resumed = await claimAndExecute(fixture.run.id, "checkpoint-retry-parent");
        expect(resumed).toMatchObject({ id: fixture.run.id, conversationId: fixture.run.conversationId, inputMessageId: fixture.run.inputMessageId, assistantMessageId: fixture.run.assistantMessageId, status: "failed", failureStage: "planning" });
        expect(resumed.ecommerceSnapshot?.referenceCheckpoint?.analysis).toEqual(beforeSnapshot.referenceCheckpoint.analysis);
        expect(resumed.ecommerceSnapshot?.referenceCheckpoint?.analysisStage).toEqual(beforeSnapshot.referenceCheckpoint.analysisStage);
        expect(resumed.ecommerceSnapshot?.referenceCheckpoint?.route).toEqual(beforeSnapshot.referenceCheckpoint.route);
        expect(resumed.ecommerceSnapshot?.processing).toEqual(beforeSnapshot.processing);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.phase.jobId)).toEqual(beforeStage);
        expect((await tasks.listStoredGenerationTaskRecordsByRunIds([fixture.run.id], [userId])).filter((record) => record.type === "image_processing")).toHaveLength(1);
        expect(boundary.model.mock.calls).toHaveLength(1);
        expect(boundary.model.mock.calls[0][0].tool.name).not.toBe("analyze_ecommerce_references");
        expect(boundary.request.mock.calls.map(([url]) => url)).toEqual([origin + "/api/reference-assets/" + fixture.reference.asset.storageKey + "?sourceProof=original"]);
    }, 30_000);

    it("rejects changed original bytes before resuming an accepted visual checkpoint and keeps the original prepare evidence", async () => {
        const fixture = await completedVisualCheckpoint();
        const beforeStage = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.phase.jobId);
        const beforeSnapshot = fixture.accepted.ecommerceSnapshot;
        assert(beforeSnapshot?.referenceCheckpoint);
        await writeFile(fixture.reference.path, Buffer.concat([fixture.reference.source, Buffer.from([0])]));
        boundary.model.mockClear();
        boundary.request.mockClear();
        await actOnOriginalRun(fixture.run, "retry");
        const paused = await claimAndExecute(fixture.run.id, "changed-source-retry-parent");
        expect(paused).toMatchObject({ id: fixture.run.id, status: "paused", ecommerceSnapshot: { fallback: { reason: "reference_source_changed" }, referenceCheckpoint: { state: "needs_review", analysisStage: { state: "completed" } } } });
        expect(paused.ecommerceSnapshot?.referenceCheckpoint?.analysis).toEqual(beforeSnapshot.referenceCheckpoint.analysis);
        expect(paused.ecommerceSnapshot?.referenceCheckpoint?.assets).toEqual(beforeSnapshot.referenceCheckpoint.assets);
        expect(paused.ecommerceSnapshot?.processing).toEqual(beforeSnapshot.processing);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.phase.jobId)).toEqual(beforeStage);
        expect((await tasks.listStoredGenerationTaskRecordsByRunIds([fixture.run.id], [userId])).filter((record) => record.type === "image_processing")).toHaveLength(1);
        expect(boundary.model).not.toHaveBeenCalled();
    }, 30_000);
});
