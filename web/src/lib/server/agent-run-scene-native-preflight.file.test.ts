import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";
import type { AuthSettings } from "@/lib/auth/store";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { StructuredTextRequest } from "./text-planning-runtime";
import { settings } from "./agent-run-executor.test-fixtures";

const boundary = vi.hoisted(() => ({
    settings: vi.fn<() => Promise<AuthSettings>>(),
    request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
    model: vi.fn<typeof import("./text-planning-runtime").requestStructuredText>(),
    user: vi.fn<() => Promise<{ id: string } | null>>(),
}));
vi.mock("@/lib/auth/store", async (original) => ({ ...(await original<typeof import("@/lib/auth/store")>()), getAuthSettings: boundary.settings }));
vi.mock("@/lib/auth/session", async (original) => ({ ...(await original<typeof import("@/lib/auth/session")>()), getCurrentUser: boundary.user }));
vi.mock("./internal-origin", async (original) => ({ ...(await original<typeof import("./internal-origin")>()), fetchInternalApi: boundary.request }));
vi.mock("./text-planning-runtime", async (original) => ({ ...(await original<typeof import("./text-planning-runtime")>()), requestStructuredText: boundary.model }));
vi.mock("./object-storage-service", async (original) => ({ ...(await original<typeof import("./object-storage-service")>()), persistExternalMediaIfEnabled: async () => null }));
vi.mock("./safe-outbound-fetch", async (original) => ({
    ...(await original<typeof import("./safe-outbound-fetch")>()),
    fetchSafeOutbound: async () => {
        throw new Error("Fixture forbids outbound HTTP");
    },
}));

// Real File services, scheduler, native supervisor and GET handler; auth and media HTTP are fixture boundaries.
// This round tests trusted preflight only. It does not qualify Next/TCP/Session or Web pixel exit.
describe("scene selection GET requires the paused Run's completed native preparation", () => {
    let directory: string;
    let runtime: typeof import("./creative-runtime-store");
    let runs: typeof import("./agent-run-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let references: typeof import("./reference-asset-store");
    let executor: typeof import("./agent-run-executor");
    let service: typeof import("./image-processing-service");
    let route: typeof import("@/app/api/agent/runs/[id]/route");
    const userId = "agent-scene-preflight-user";
    const origin = "http://fixture.local";
    const sceneFacts = { space: "living room", composition: "eye level", lighting: "soft daylight" };

    beforeEach(async () => {
        vi.resetModules();
        boundary.settings.mockReset();
        boundary.request.mockReset();
        boundary.model.mockReset();
        boundary.user.mockReset();
        directory = await mkdtemp(join(tmpdir(), "vozeb-agent-scene-preflight-"));
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
        boundary.user.mockResolvedValue({ id: userId });
        [runtime, runs, tasks, scheduler, references, executor, service, route] = await Promise.all([
            import("./creative-runtime-store"),
            import("./agent-run-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./reference-asset-store"),
            import("./agent-run-executor"),
            import("./image-processing-service"),
            import("@/app/api/agent/runs/[id]/route"),
        ]);
        const { getDatabaseProvider } = await import("./database");
        expect(getDatabaseProvider()).toBe("file");
        boundary.request.mockImplementation(async (url, init) => {
            const parsed = new URL(url);
            expect(init?.method || "GET").toBe("GET");
            expect(parsed.pathname).toMatch(/^\/api\/reference-assets\//);
            const media = await references.readReferenceAsset(decodeURIComponent(parsed.pathname.slice("/api/reference-assets/".length)));
            assert(media, "Fixture HTTP must read actual registered media");
            expect(media.registration?.ownerUserId).toBe(userId);
            return new Response(new Uint8Array(await readFile(media.filePath)), { headers: { "content-type": media.mimeType } });
        });
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    async function registerSource(conversationId: string, source: Buffer) {
        const stored = await references.writeReferenceImageDataUrl("data:image/png;base64," + source.toString("base64"), { ownerUserId: userId, conversationId, source: "fixture-agent-scene-preflight" });
        const media = await references.readReferenceAsset(stored.token);
        assert(media);
        expect(media.registration).toMatchObject({ ownerUserId: userId, storageKey: stored.token, scope: "reference" });
        expect(await readFile(media.filePath)).toEqual(source);
        const [asset] = await runtime.registerCreativeAssets([
            { userId, conversationId, ordinal: 0, type: "image", title: "scene.png", sourceRunId: "upload", serverUrl: "/api/reference-assets/" + stored.token, storageKey: stored.token, width: 100, height: 80, metadata: {} },
        ]);
        assert(asset);
        return { asset, token: stored.token, sourceSha256: createHash("sha256").update(source).digest("hex") };
    }

    async function claimAndExecute(runId: string, workerId: string) {
        const due = await tasks.getStoredGenerationTaskRecord("agent", runId);
        assert(due);
        expect(due.workerId).toBeUndefined();
        expect(due.leaseUntil).toBeUndefined();
        expect(due.nextPollAt).toBeGreaterThan(0);
        expect(await scheduler.claimDueGenerationTasks({ workerId, taskIds: [runId], limit: 1 })).toMatchObject([{ id: runId, workerId }]);
        const current = await runs.getAgentRun(runId);
        assert(current);
        await executor.executeAgentRun(current, origin, "session=fixture");
        const saved = await runs.getAgentRun(runId);
        assert(saved);
        return saved;
    }

    async function waitingPreparation(runId: string) {
        const run = await runs.getAgentRun(runId);
        assert(run?.ecommerceSnapshot);
        const children = (await tasks.listStoredGenerationTaskRecordsByRunIds([runId], [userId])).filter((record) => record.type === "image_processing");
        expect(children, JSON.stringify({ run, children })).toHaveLength(1);
        const waiting = run.ecommerceSnapshot.processing?.waitingFor;
        assert(waiting);
        const stage = await tasks.getStoredGenerationTaskRecord("image_processing", waiting.jobId);
        assert(stage);
        expect(stage).toMatchObject({ userId, runId, parentTaskId: runId, status: "pending", payload: { operation: "prepare_reference" } });
        expect(waiting.inputDigest).toBe(stage.payload.inputDigest);
        expect(run.executionId).toBeUndefined();
        const parent = await tasks.getStoredGenerationTaskRecord("agent", runId);
        assert(parent);
        expect(parent.workerId).toBeUndefined();
        expect(parent.leaseUntil).toBeUndefined();
        expect(parent.nextPollAt).toBeUndefined();
        return stage;
    }

    async function completePreparation(jobId: string) {
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const workerId = "scene-preflight-image-worker";
        const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const task = claimed.tasks[0];
        assert(task);
        expect(task.id).toBe(jobId);
        assert(task.payload.operation === "prepare_reference");
        const identity = { workerId, executionId: task.executionId };
        const taskDirectory = await mkdtemp(join(directory, "native-stage-"));
        const inputPath = join(taskDirectory, "source.png");
        const source = await service.readImageProcessingInput(jobId, task.payload.inputs[0].assetId, identity);
        await pipeline(source.stream, createWriteStream(inputPath, { flags: "wx" }));
        const outputDirectory = join(taskDirectory, "outputs");
        await mkdir(outputDirectory);
        const outcome = await runImageProcessing(
            { operation: "prepare_reference", options: {}, version: "image-processing.v1", jobId, executionId: identity.executionId, inputs: [{ ...task.payload.inputs[0], path: inputPath }], outputDirectory },
            { taskDirectory, maxHeapMiB: task.payload.resource.configuration.processHeapMb },
        );
        expect(outcome).toMatchObject({ status: "completed", jobId, executionId: identity.executionId, exitCode: 0, signal: null });
        expect(outcome.pid).toBeGreaterThan(0);
        assert(outcome.status === "completed");
        expect(outcome.result.metrics.pid).not.toBe(process.pid);
        expect(outcome.result.metrics.peakRssBytes).toBeGreaterThan(0);
        const { artifacts, metrics, ...manifest } = outcome.result;
        expect(artifacts).toHaveLength(1);
        const native = artifacts[0];
        assert(native?.kind === "analysis");
        const bytes = await readFile(native.path);
        const response = new Response(new Uint8Array(bytes));
        assert(response.body);
        const artifact = await service.writeImageProcessingOutput(jobId, "analysis", identity, { stream: response.body, mimeType: native.mimeType });
        expect(artifact).toMatchObject({ kind: "analysis", sha256: native.sha256, bytes: native.bytes, width: native.width, height: native.height });
        const completedManifest = { ...manifest, artifacts: [artifact] };
        const receipt = await service.completeImageProcessingTask(jobId, { ...identity, manifest: completedManifest, metrics });
        expect(receipt).toMatchObject({ jobId, executionId: identity.executionId, parentRescheduled: true });
        return { manifest: completedManifest, receipt };
    }

    function modelReply(value: unknown) {
        return { arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat" as const, elapsedMs: 1 };
    }

    type PlannerMessage = {
        sources: { productAnchorId: string | null; currentSceneBaselineId: string | null; sceneReferenceIds: string[] };
        requiredModelRoles: EcommerceEditPlan["modelRoles"];
        continuity: EcommerceEditPlan["continuity"];
        visualAnalysis: { references: Array<{ assetId: string; alias: string | null; purposes: string[]; sceneFacts: EcommerceEditPlan["baseline"]["sceneFacts"] }> };
    };

    function installSceneModelReplies(assetId: string) {
        boundary.model.mockImplementation(async (request: StructuredTextRequest) => {
            if (request.tool.name === "analyze_ecommerce_references")
                return modelReply({
                    analysisVersion: "ecommerce-visual-analysis.v4",
                    references: [
                        {
                            assetId,
                            contentType: "interior_scene",
                            confidence: "high",
                            visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                            productFacts: null,
                            sceneFacts,
                            productCore: null,
                            fusionHalo: null,
                            editableTargets: [],
                            visibleStructure: [],
                            cues: [],
                        },
                    ],
                    purposeSuggestions: [{ assetId, purposes: ["edit_target"], confidence: "high" }],
                });
            expect(request.tool.name).toBe("plan_ecommerce_edit");
            const user = request.messages.find((message) => message.role === "user");
            assert(user && typeof user.content === "string");
            const input: PlannerMessage = JSON.parse(user.content);
            expect(input.sources).toMatchObject({ productAnchorId: null, currentSceneBaselineId: assetId, sceneReferenceIds: [] });
            const baseline = input.visualAnalysis.references.find((reference) => reference.assetId === assetId);
            assert(baseline?.sceneFacts);
            return modelReply({
                planVersion: "ecommerce-edit.v6",
                operation: "scene_edit",
                source: input.sources,
                baseline: { productFacts: null, sceneFacts: baseline.sceneFacts },
                delta: { requestedChanges: ["在柜子上增加花瓶和接触阴影"], targetObjects: ["vase"], targetRegions: ["cabinet-top"] },
                preserve: { productCore: [], sceneElements: ["layout", "camera"] },
                protection: { scope: "local", protectedObjectIds: [assetId], preserveOutsideMask: true, allowLightingChange: false },
                strategy: "integrated_scene",
                modelRoles: input.requiredModelRoles,
                continuity: input.continuity,
                referenceUses: input.visualAnalysis.references.map((reference) => ({ assetId: reference.assetId, alias: reference.alias, purposes: reference.purposes, usedCueIds: [] })),
                visibleStructure: [],
                validation: { requiredChecks: ["requested_edit", "scene_preservation"] },
            });
        });
    }

    async function pausedSceneRun(conversationId: string, assetId: string, requestId: string) {
        const { run } = await runs.createAgentRun(userId, {
            clientRequestId: requestId,
            conversationId,
            surface: "chat",
            prompt: "修改图片1，在柜子上增加花瓶和接触阴影，只修改局部，保留其他区域和原图尺寸",
            assetIds: [assetId],
            skillIds: [],
            modelIds: [],
            preferences: { mode: "image" },
        });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        await claimAndExecute(run.id, "scene-preflight-prepare-parent");
        const stage = await waitingPreparation(run.id);
        expect(stage.payload.inputs).toMatchObject([{ assetId }]);
        const completed = await completePreparation(stage.id);
        const paused = await claimAndExecute(run.id, "scene-preflight-planning-parent");
        expect(paused, JSON.stringify(paused)).toMatchObject({
            id: run.id,
            userId,
            conversationId,
            status: "paused",
            tasks: [{ id: "ecommerce-scene-edit", type: "image", status: "needs_review", attempts: 0, ecommerceExecution: { state: "ready" } }],
            ecommerceSnapshot: {
                mode: "active",
                fallback: { reason: "scene_selection_required" },
                plan: {
                    operation: "scene_edit",
                    source: { currentSceneBaselineId: assetId },
                    protection: { scope: "local", preserveOutsideMask: true },
                    canvas: { mode: "exact", size: { width: 100, height: 80 }, source: "user_text", allowReframe: false },
                },
            },
        });
        expect(paused.tasks).toHaveLength(1);
        const task = paused.tasks[0];
        expect(task.sceneProtection).toBeUndefined();
        expect(task.taskId).toBeUndefined();
        expect(task.taskIds).toBeUndefined();
        expect(task.childTasks).toBeUndefined();
        expect(paused.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
        expect(paused.ecommerceSnapshot?.processing?.protection).toBeUndefined();
        const prepared = paused.ecommerceSnapshot?.processing?.prepareReferences;
        assert(prepared?.length === 1);
        expect(prepared[0]).toMatchObject({ jobId: stage.id, inputDigest: stage.payload.inputDigest, assetId, manifest: completed.manifest });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", stage.id)).toMatchObject({
            id: stage.id,
            userId,
            runId: run.id,
            parentTaskId: run.id,
            status: "success",
            executionPhase: "completed",
            resultPayload: { manifest: completed.manifest },
        });
        return { run: paused, prepared: prepared[0], completed };
    }

    async function getRun(runId: string) {
        const response = await route.GET(new Request(origin + "/api/agent/runs/" + runId, { headers: { cookie: "session=fixture" } }), { params: Promise.resolve({ id: runId }) });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ code: 0, data: { run: { id: runId } } });
        return body.data.run;
    }

    it("hides selection for another Run's real native receipt while the same original remains readable", async () => {
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const original = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#a0b0c0" } })
            .composite([{ input: { create: { width: 32, height: 40, channels: 3, background: "#8a6243" } }, left: 34, top: 20 }])
            .png()
            .toBuffer();
        const source = await registerSource(conversation.id, original);
        installSceneModelReplies(source.asset.id);
        const target = await pausedSceneRun(conversation.id, source.asset.id, "scene-native-preflight-target");
        const other = await pausedSceneRun(conversation.id, source.asset.id, "scene-native-preflight-other");
        expect(other.run.id).not.toBe(target.run.id);
        expect(other.prepared.jobId).not.toBe(target.prepared.jobId);
        expect(target.completed.manifest.sourceIdentities).toMatchObject([{ assetId: source.asset.id, sha256: source.sourceSha256, bytes: original.length, width: 100, height: 80 }]);
        expect(other.completed.manifest.sourceIdentities).toMatchObject([{ assetId: source.asset.id, sha256: source.sourceSha256, bytes: original.length, width: 100, height: 80 }]);

        const beforeNormalGet = await tasks.listStoredGenerationTaskRecordsByRunIds([target.run.id, other.run.id], [userId]);
        expect(beforeNormalGet.filter((record) => record.type === "image")).toStrictEqual([]);
        expect(await getRun(target.run.id)).toMatchObject({ ecommerceSceneSelection: { action: "confirm_scene_selection", baselineAssetId: source.asset.id, url: "/api/reference-assets/" + source.token, width: 100, height: 80 } });
        expect(await tasks.listStoredGenerationTaskRecordsByRunIds([target.run.id, other.run.id], [userId])).toStrictEqual(beforeNormalGet);

        const snapshot = target.run.ecommerceSnapshot;
        assert(snapshot?.processing);
        const replacedSnapshot = { ...snapshot, processing: { ...snapshot.processing, prepareReferences: [structuredClone(other.prepared)] } };
        // Deliberate parent-only corruption: use an actual completed receipt from a distinct Run, never a fabricated success.
        await tasks.withGenerationTaskFileMutation(async (records) => ({
            tasks: records.map((record) => (record.type === "agent" && record.id === target.run.id ? { ...record, payload: { ...record.payload, ecommerceSnapshot: replacedSnapshot } } : record)),
            result: undefined,
        }));
        expect(await runs.getAgentRun(target.run.id)).toStrictEqual({ ...target.run, ecommerceSnapshot: replacedSnapshot });
        expect(await runs.getAgentRun(other.run.id)).toStrictEqual(other.run);
        const beforeForeignGet = await tasks.listStoredGenerationTaskRecordsByRunIds([target.run.id, other.run.id], [userId]);
        expect(beforeForeignGet.filter((record) => record.type === "image_processing")).toStrictEqual(beforeNormalGet.filter((record) => record.type === "image_processing"));
        const stillReadable = await references.readReferenceAsset(source.token);
        assert(stillReadable);
        expect(await readFile(stillReadable.filePath)).toEqual(original);

        const view = await getRun(target.run.id);
        expect(await tasks.listStoredGenerationTaskRecordsByRunIds([target.run.id, other.run.id], [userId])).toStrictEqual(beforeForeignGet);
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toStrictEqual([]);
        expect(view.ecommerceSceneSelection, "A readable original must not authorize scene selection using another Run's completed native preparation").toBeUndefined();
    }, 90_000);
});
