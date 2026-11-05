import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";
import type { AuthSettings } from "@/lib/auth/store";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { CreateImageTaskBody } from "@/app/api/image-tasks/image-task-types";
import type { ImageProcessingOperation } from "../image-processing/contracts";
import type { ImageTask } from "./image-task-store";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";
import type { StructuredTextRequest } from "./text-planning-runtime";
import { settings } from "./agent-run-executor.test-fixtures";

const boundary = vi.hoisted(() => ({
    settings: vi.fn<() => Promise<AuthSettings>>(),
    request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
    model: vi.fn<typeof import("./text-planning-runtime").requestStructuredText>(),
    user: vi.fn<(request?: Request) => Promise<{ id: string } | null>>(),
    create: vi.fn<typeof import("@/app/api/image-tasks/image-task-openai").runOpenAiImageTask>(),
    cookie: "",
    after: vi.fn(),
}));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: boundary.after }));
vi.mock("next/headers", async () => {
    const { RequestCookies } = await import("next/dist/server/web/spec-extension/cookies");
    return { cookies: async () => new RequestCookies(new Headers({ cookie: boundary.cookie })) };
});
vi.mock("@/app/api/image-tasks/image-task-openai", async (original) => ({ ...(await original<typeof import("@/app/api/image-tasks/image-task-openai")>()), runOpenAiImageTask: boundary.create }));
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

// Real File stores, wallet, routing/compiler, Action, scheduler and native subprocesses.
// Auth/settings, media HTTP, model replies and deferred Next after are controlled fixture boundaries.
// The first case stops after native completion and parent due. The separate successor reaches actual ImageTask submission.
describe("scene confirmation persists its receipt before a new claim builds the native mask", () => {
    let directory: string;
    let runtime: typeof import("./creative-runtime-store");
    let runs: typeof import("./agent-run-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let references: typeof import("./reference-asset-store");
    let executor: typeof import("./agent-run-executor");
    let service: typeof import("./image-processing-service");
    let actionRoute: typeof import("@/app/api/agent/runs/[id]/[action]/route");
    let auth: typeof import("@/lib/auth/store-repository");
    let wallet: typeof import("./points-wallet-service");
    let compiler: typeof import("./ecommerce-image-compiler");
    let routing: typeof import("./ecommerce-model-routing");
    let configured: AuthSettings;
    const userId = "agent-scene-native-action-user";
    const origin = "http://fixture.local";
    const sceneFacts = { space: "living room", composition: "eye level", lighting: "soft daylight" };

    beforeEach(async () => {
        vi.resetModules();
        boundary.settings.mockReset();
        boundary.request.mockReset();
        boundary.model.mockReset();
        boundary.user.mockReset();
        boundary.after.mockReset();
        boundary.create.mockReset();
        boundary.cookie = "";
        directory = await mkdtemp(join(tmpdir(), "vozeb-agent-scene-native-action-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        configured = settings("image-model", "image-channel");
        configured.ecommerceGenerationEnabled = true;
        configured.ecommerceVisualQualityCheckEnabled = false;
        configured.ecommerceModelRoles = { vision_analysis: ["planner"], edit_planning: ["planner"], image_generation: ["image-model"], quality_check: [] };
        configured.systemChannels[1].models = ["gpt-image-2.5-flare"];
        const { normalizeSystemChannelAdvancedConfig } = await import("@/lib/auth/store-normalizers");
        const advancedConfig = normalizeSystemChannelAdvancedConfig({ protocol: "openai", editPath: "/images/edits", supportsReferenceImage: true });
        assert.ok(advancedConfig, "SETUP: the real normalizer must produce the configured image edit protocol");
        configured.systemChannels[1].advancedConfig = advancedConfig;
        configured.logicalModels[1].bindings[0].upstreamModel = "gpt-image-2.5-flare";
        boundary.settings.mockResolvedValue(configured);
        boundary.user.mockResolvedValue({ id: userId });
        [runtime, runs, tasks, scheduler, references, executor, service, actionRoute, auth, wallet, compiler, routing] = await Promise.all([
            import("./creative-runtime-store"),
            import("./agent-run-store"),
            import("./generation-task-store"),
            import("./generation-task-scheduler"),
            import("./reference-asset-store"),
            import("./agent-run-executor"),
            import("./image-processing-service"),
            import("@/app/api/agent/runs/[id]/[action]/route"),
            import("@/lib/auth/store-repository"),
            import("./points-wallet-service"),
            import("./ecommerce-image-compiler"),
            import("./ecommerce-model-routing"),
        ]);
        const { getDatabaseProvider } = await import("./database");
        expect(getDatabaseProvider()).toBe("file");
        const db = await auth.readAuthDb();
        expect(db.users).toHaveLength(0);
        const now = new Date().toISOString();
        db.users.push({
            id: userId,
            accountId: "0001",
            username: "scene-action-user",
            displayName: "Scene Action fixture",
            bio: "",
            role: "user",
            adminPermissions: [],
            status: "active",
            planId: db.settings.entitlements.defaultPlanId,
            pointsBalance: 0,
            passwordHash: "fixture-only",
            createdAt: now,
            updatedAt: now,
        });
        db.nextUserAccountId = 2;
        await auth.writeAuthDb(db);
        const credit = await wallet.creditPermanentPoints({ userId, amount: 1000, description: "Isolated scene Action fixture", idempotencyKey: "fixture-scene-action-credit" });
        expect(credit).toMatchObject({ applied: true, record: { userId, type: "credit", amount: 1000 } });
        // Settle before the test freezes its paused-run financial preimage.
        await wallet.getPointsWalletSnapshot(userId);

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
        const stored = await references.writeReferenceImageDataUrl("data:image/png;base64," + source.toString("base64"), { ownerUserId: userId, conversationId, source: "fixture-agent-scene-native-action" });
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

    async function claimAndExecute(runId: string, workerId: string, cookie = "session=fixture") {
        const due = await tasks.getStoredGenerationTaskRecord("agent", runId);
        assert(due);
        expect(due.workerId).toBeUndefined();
        expect(due.leaseUntil).toBeUndefined();
        expect(due.nextPollAt).toBeGreaterThan(0);
        expect(await scheduler.claimDueGenerationTasks({ workerId, taskIds: [runId], limit: 1 })).toMatchObject([{ id: runId, workerId }]);
        const current = await runs.getAgentRun(runId);
        assert(current);
        await executor.executeAgentRun(current, origin, cookie);
        const saved = await runs.getAgentRun(runId);
        assert(saved);
        return saved;
    }

    async function childrenForRun(runId: string) {
        return (await tasks.listStoredGenerationTaskRecordsByRunIds([runId], [userId])).filter((record) => record.type !== "agent");
    }

    async function waitingStage(runId: string, operation: "prepare_reference" | "build_protection", parentTaskId: string) {
        const run = await runs.getAgentRun(runId);
        assert(run?.ecommerceSnapshot);
        const children = (await childrenForRun(runId)).filter((record) => record.type === "image_processing" && record.payload.operation === operation);
        expect(children, JSON.stringify({ run, children })).toHaveLength(1);
        const waiting = run.ecommerceSnapshot.processing?.waitingFor;
        assert(waiting);
        const stage = await tasks.getStoredGenerationTaskRecord("image_processing", waiting.jobId);
        assert(stage);
        expect(stage).toMatchObject({ userId, runId, parentTaskId, status: "pending", payload: { operation } });
        expect(waiting.inputDigest).toBe(stage.payload.inputDigest);
        expect(run.executionId).toBeUndefined();
        const parent = await tasks.getStoredGenerationTaskRecord("agent", runId);
        assert(parent);
        expect(parent.workerId).toBeUndefined();
        expect(parent.leaseUntil).toBeUndefined();
        expect(parent.nextPollAt).toBeUndefined();
        return stage;
    }

    async function completeStage(jobId: string) {
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const workerId = "scene-action-image-worker";
        const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const task = claimed.tasks[0];
        assert(task);
        expect(task.id).toBe(jobId);
        assert(task.payload.operation === "prepare_reference" || task.payload.operation === "build_protection");
        const identity = { workerId, executionId: task.executionId };
        const taskDirectory = await mkdtemp(join(directory, "native-stage-"));
        const inputPath = join(taskDirectory, "source.png");
        const source = await service.readImageProcessingInput(jobId, task.payload.inputs[0].assetId, identity);
        await pipeline(source.stream, createWriteStream(inputPath, { flags: "wx" }));
        const outputDirectory = join(taskDirectory, "outputs");
        await mkdir(outputDirectory);
        const operation: ImageProcessingOperation = task.payload.operation === "prepare_reference" ? { operation: "prepare_reference", options: {} } : { operation: "build_protection", options: task.payload.options };
        const outcome = await runImageProcessing(
            { ...operation, version: "image-processing.v1", jobId, executionId: identity.executionId, inputs: [{ ...task.payload.inputs[0], path: inputPath }], outputDirectory },
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
        assert(native && (native.kind === "analysis" || native.kind === "mask"));
        expect(native.kind).toBe(task.payload.operation === "prepare_reference" ? "analysis" : "mask");
        const bytes = await readFile(native.path);
        const response = new Response(new Uint8Array(bytes));
        assert(response.body);
        const artifact = await service.writeImageProcessingOutput(jobId, native.kind, identity, { stream: response.body, mimeType: native.mimeType });
        expect(artifact).toMatchObject({ kind: native.kind, sha256: native.sha256, bytes: native.bytes, width: native.width, height: native.height });
        const completedManifest = { ...manifest, artifacts: [artifact] };
        expect(await service.completeImageProcessingTask(jobId, { ...identity, manifest: completedManifest, metrics })).toMatchObject({ jobId, executionId: identity.executionId, parentRescheduled: true });
        return { payload: task.payload, executionId: identity.executionId, manifest: completedManifest, artifact, bytes };
    }

    async function financialTruth() {
        const db = await auth.readAuthDb();
        const user = db.users.find((item) => item.id === userId);
        assert(user);
        return { user, pointRecords: db.pointRecords.filter((item) => item.userId === userId), dailyPlanPointWallets: db.dailyPlanPointWallets.filter((item) => item.userId === userId), quotaUsage: db.quotaUsage.filter((item) => item.userId === userId) };
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

    async function pausedSceneRun(conversationId: string, assetId: string, requestId: string, cookie = "session=fixture") {
        const { run } = await runs.createAgentRun(userId, {
            clientRequestId: requestId,
            conversationId,
            surface: "chat",
            prompt: "修改图片1，在柜子上增加花瓶和接触阴影，只修改局部，保留其他区域和原图尺寸",
            assetIds: [assetId],
            skillIds: [],
            modelIds: [],
            preferences: { mode: "image", image: { count: 2 } },
        });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        await claimAndExecute(run.id, "scene-action-prepare-parent", cookie);
        const stage = await waitingStage(run.id, "prepare_reference", run.id);
        expect(stage.payload.inputs).toMatchObject([{ assetId }]);
        const completed = await completeStage(stage.id);
        const paused = await claimAndExecute(run.id, "scene-action-planning-parent", cookie);
        expect(paused, JSON.stringify(paused)).toMatchObject({
            id: run.id,
            userId,
            conversationId,
            status: "paused",
            tasks: [
                {
                    id: "ecommerce-scene-edit",
                    type: "image",
                    count: 2,
                    status: "needs_review",
                    attempts: 0,
                    ecommerceExecution: { state: "ready", mask: { mode: "independent", required: true }, modelSnapshot: { imageEdit: { supportsIndependentMask: true } } },
                },
            ],
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

    it("stores the authenticated confirmation before claim A builds and completes the native mask", async () => {
        const imageRoute = routing.routeEcommerceRole(configured, "image_generation");
        assert(imageRoute, "SETUP: a real configured image route is required");
        expect(imageRoute.snapshot).toMatchObject({ apiFormat: "openai", upstreamModel: "gpt-image-2.5-flare", imageEdit: { editPath: "/images/edits", transport: "multipart", supportsIndependentMask: true } });
        const profile = compiler.resolveEcommerceImageProviderProfile(imageRoute.snapshot);
        assert(profile, "SETUP: the configured route must resolve a real ecommerce profile");
        expect(profile.supportsIndependentMask).toBe(true);
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const original = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#a0b0c0" } })
            .composite([{ input: { create: { width: 32, height: 40, channels: 3, background: "#8a6243" } }, left: 34, top: 20 }])
            .png()
            .toBuffer();
        const baseline = await registerSource(conversation.id, original);
        installSceneModelReplies(baseline.asset.id);
        const fixture = await pausedSceneRun(conversation.id, baseline.asset.id, "scene-action-receipt");
        const paused = fixture.run;
        const snapshot = paused.ecommerceSnapshot;
        const plan = snapshot?.plan;
        const currentReference = snapshot?.referenceCheckpoint?.assets.find((item) => item.asset.id === baseline.asset.id);
        assert(snapshot?.processing && plan && currentReference);
        expect(compiler.compileEcommerceImageRequest(plan, profile)).toEqual(paused.tasks[0].ecommerceExecution);
        const { referenceAssetVersion } = await import("./ecommerce-reference-recovery");
        expect(fixture.completed.payload.inputs[0].assetVersion).toBe(referenceAssetVersion(baseline.asset));
        expect(fixture.prepared.assetVersion).toBe(fixture.completed.payload.inputs[0].assetVersion);
        expect(currentReference.assetVersion).toBe(referenceAssetVersion(baseline.asset, baseline.sourceSha256));
        expect(currentReference.assetVersion).not.toBe(fixture.prepared.assetVersion);
        expect(currentReference).toMatchObject({ contentSha256: baseline.sourceSha256, asset: { width: 100, height: 80 } });
        expect(fixture.completed.manifest.sourceIdentities).toMatchObject([{ assetId: baseline.asset.id, sha256: baseline.sourceSha256, bytes: original.length, width: 100, height: 80 }]);
        const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepared.jobId);
        assert(prepareBefore);
        const prepareManifestDigest = prepareBefore.resultPayload?.manifestDigest;
        assert(typeof prepareManifestDigest === "string", "SETUP: use the actual successful prepare digest");
        expect(service.hasOnlyCompletedEcommerceReferencePrepares(paused, await childrenForRun(paused.id))).toBe(true);
        const moneyBefore = await financialTruth();
        expect(moneyBefore.user.pointsBalance).toBeGreaterThan(0);
        expect(moneyBefore.pointRecords).toContainEqual(expect.objectContaining({ type: "credit", amount: 1000 }));
        const originalTasks = structuredClone(paused.tasks);
        const region = { x: 20, y: 20, width: 25, height: 16 };
        const requestedAt = Date.now();
        const response = await actionRoute.POST(
            new Request(origin + "/api/agent/runs/" + paused.id + "/resume", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=fixture" },
                body: JSON.stringify({ conversationId: conversation.id, sceneSelection: { baselineAssetId: baseline.asset.id, region, actorUserId: "forged-client-actor", confirmedAt: 1, semantics: ["forged client semantics"] } }),
            }),
            { params: Promise.resolve({ id: paused.id, action: "resume" }) },
        );
        const responseAt = Date.now();
        expect(response.status, "SETUP: the real authenticated resume handler must accept this valid scene selection").toBe(200);
        expect(await response.json()).toMatchObject({ code: 0, data: { run: { id: paused.id, status: "running" } } });
        const confirmed = await runs.getAgentRun(paused.id);
        assert(confirmed);

        // First new behavior assertion: expected RED on v406 only after the real Action returns 200.
        // Matcher keys do not require the future field to exist in current production types.
        expect(confirmed.ecommerceSnapshot?.processing, "Confirmation must persist its server receipt before any mask is trusted").toMatchObject({
            sceneSelection: {
                version: "scene-selection-receipt.v1",
                parentTaskId: paused.tasks[0].id,
                baseline: { assetId: baseline.asset.id, assetVersion: currentReference.assetVersion, sha256: baseline.sourceSha256, bytes: original.length, width: 100, height: 80 },
                prepare: { jobId: fixture.prepared.jobId, inputDigest: fixture.prepared.inputDigest, executionId: fixture.completed.executionId, manifestDigest: prepareManifestDigest, assetVersion: fixture.prepared.assetVersion },
                region: { x: 20, y: 20, width: 25, height: 16 },
                semantics: ["在柜子上增加花瓶和接触阴影"],
                confirmation: { actorUserId: userId, confirmedAt: expect.any(Number) },
            },
        });

        // Everything below is UNREACHED in the first RED, not evidence of a completed native bridge.
        const processingFields: Record<string, unknown> = { ...confirmed.ecommerceSnapshot?.processing };
        const savedReceipt = processingFields.sceneSelection;
        assert(savedReceipt && typeof savedReceipt === "object" && "confirmation" in savedReceipt);
        const confirmation = savedReceipt.confirmation;
        assert(confirmation && typeof confirmation === "object" && "confirmedAt" in confirmation);
        const confirmedAt = confirmation.confirmedAt;
        assert(typeof confirmedAt === "number");
        expect(Number.isSafeInteger(confirmedAt)).toBe(true);
        expect(confirmedAt).toBeGreaterThanOrEqual(requestedAt);
        expect(confirmedAt).toBeLessThanOrEqual(responseAt);
        const receiptBefore = structuredClone(savedReceipt);
        expect(savedReceipt).not.toHaveProperty("mask");
        expect(savedReceipt).not.toHaveProperty("maskDigest");
        expect(confirmed.tasks).toStrictEqual(originalTasks);
        expect(confirmed.executionId).toBeUndefined();
        expect(confirmed.ecommerceSnapshot).toMatchObject({ plan, modelRouteSnapshots: snapshot.modelRouteSnapshots, compilerVersion: snapshot.compilerVersion, referenceCheckpoint: snapshot.referenceCheckpoint, fallback: snapshot.fallback });
        expect(confirmed).toMatchObject({ id: paused.id, userId, conversationId: paused.conversationId, inputMessageId: paused.inputMessageId, assistantMessageId: paused.assistantMessageId, status: "running" });
        expect(confirmed.ecommerceSnapshot?.processing?.prepareReferences).toStrictEqual(snapshot.processing.prepareReferences);
        expect(confirmed.ecommerceSnapshot?.processing?.protection).toBeUndefined();
        expect(confirmed.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
        expect(await childrenForRun(paused.id)).toStrictEqual([prepareBefore]);
        expect(await financialTruth()).toStrictEqual(moneyBefore);
        const dueAfterAction = await tasks.getStoredGenerationTaskRecord("agent", paused.id);
        assert(dueAfterAction);
        expect(dueAfterAction.executionPhase).toBe("created");
        expect(dueAfterAction.nextPollAt).toBeGreaterThan(0);
        expect(dueAfterAction.workerId).toBeUndefined();
        expect(dueAfterAction.leaseUntil).toBeUndefined();

        const waiting = await claimAndExecute(paused.id, "scene-action-build-parent");
        expect(waiting.status).toBe("running");
        const build = await waitingStage(paused.id, "build_protection", originalTasks[0].id);
        expect(build.payload).toMatchObject({
            operation: "build_protection",
            inputs: [{ assetId: baseline.asset.id, assetVersion: currentReference.assetVersion, expectedSha256: baseline.sourceSha256 }],
            options: { mode: "scene_selection", region: { x: 20, y: 20, width: 25, height: 16 }, semantics: ["在柜子上增加花瓶和接触阴影"], selectionSource: "user_selection" },
            sources: fixture.completed.payload.sources,
            resource: {
                facts: {
                    encodedInputs: [{ assetId: baseline.asset.id, assetVersion: currentReference.assetVersion, sha256: baseline.sourceSha256, bytes: original.length }],
                    decodedInputs: [{ assetId: baseline.asset.id, assetVersion: currentReference.assetVersion, sha256: baseline.sourceSha256, width: 100, height: 80 }],
                },
            },
        });
        expect(waiting.tasks).toStrictEqual(originalTasks);
        expect(waiting.ecommerceSnapshot?.processing).toMatchObject({ sceneSelection: receiptBefore, protection: { jobId: build.id, inputDigest: build.payload.inputDigest }, waitingFor: { jobId: build.id, inputDigest: build.payload.inputDigest } });
        expect(await childrenForRun(paused.id)).toHaveLength(2);
        expect((await childrenForRun(paused.id)).filter((child) => child.type === "image")).toHaveLength(0);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBefore.id)).toStrictEqual(prepareBefore);
        expect(await financialTruth()).toStrictEqual(moneyBefore);

        const mask = await completeStage(build.id);
        expect(mask.payload.operation).toBe("build_protection");
        expect(mask.manifest.sourceIdentities).toMatchObject([{ assetId: baseline.asset.id, assetVersion: currentReference.assetVersion, sha256: baseline.sourceSha256, bytes: original.length, width: 100, height: 80 }]);
        expect(mask.artifact).toMatchObject({ kind: "mask", mimeType: "image/png", width: 100, height: 80, sha256: createHash("sha256").update(mask.bytes).digest("hex"), bytes: mask.bytes.length });
        expect(mask.manifest.geometry.sceneProtection).toMatchObject({
            sourceAssetId: baseline.asset.id,
            sourceDigest: baseline.sourceSha256,
            sourceSize: { width: 100, height: 80 },
            maskDigest: mask.artifact.sha256,
            maskSize: { width: 100, height: 80 },
            targetRegion: { x: 20, y: 20, width: 25, height: 16 },
            semantics: ["在柜子上增加花瓶和接触阴影"],
            selectionSource: "user_selection",
            maskSemantics: "alpha_zero_edit",
            method: "source_pixels_copy",
        });
        expect(mask.manifest.geometry.sceneProtection?.confirmation).toBeUndefined();
        const registeredMask = await references.readReferenceAsset(mask.artifact.storageKey);
        assert(registeredMask);
        expect(registeredMask.registration).toMatchObject({ ownerUserId: userId, scope: "reference", storageKey: mask.artifact.storageKey });
        expect(await readFile(registeredMask.filePath)).toEqual(mask.bytes);
        const pixels = await sharp(mask.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(pixels.info).toMatchObject({ width: 100, height: 80, channels: 4 });
        expect(pixels.data[3]).toBe(255);
        expect(pixels.data[(20 * 100 + 20) * 4 + 3]).toBe(0);
        expect(pixels.data[(36 * 100 + 20) * 4 + 3]).toBe(255);
        const completed = await runs.getAgentRun(paused.id);
        assert(completed);
        expect(completed.status).toBe("running");
        expect(completed.tasks).toStrictEqual(originalTasks);
        expect(completed.ecommerceSnapshot?.processing).toMatchObject({ sceneSelection: receiptBefore, protection: { jobId: build.id, inputDigest: build.payload.inputDigest, manifest: mask.manifest } });
        expect(completed.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
        expect(completed.executionId).toBeUndefined();
        expect(completed.ecommerceSnapshot).toMatchObject({ plan, modelRouteSnapshots: snapshot.modelRouteSnapshots, compilerVersion: snapshot.compilerVersion, referenceCheckpoint: snapshot.referenceCheckpoint, fallback: snapshot.fallback });
        expect(completed).toMatchObject({ id: paused.id, userId, conversationId: paused.conversationId, inputMessageId: paused.inputMessageId, assistantMessageId: paused.assistantMessageId });
        const dueAfterMask = await tasks.getStoredGenerationTaskRecord("agent", paused.id);
        assert(dueAfterMask);
        expect(dueAfterMask.nextPollAt).toBeGreaterThan(0);
        expect(dueAfterMask.workerId).toBeUndefined();
        expect(dueAfterMask.leaseUntil).toBeUndefined();
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { manifest: mask.manifest } });
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBefore.id)).toStrictEqual(prepareBefore);
        expect(await childrenForRun(paused.id)).toHaveLength(2);
        expect((await childrenForRun(paused.id)).filter((child) => child.type === "image")).toHaveLength(0);
        expect(await financialTruth()).toStrictEqual(moneyBefore);
        const originalMedia = await references.readReferenceAsset(baseline.token);
        assert(originalMedia);
        expect(await readFile(originalMedia.filePath)).toEqual(original);
        // No claim B here: current ImageTask runtime still requires inline-mask validation.
        // Its actual submission/Worker and outside-copy qualification needs a separate gate after that bridge exists.
    }, 30_000);

    async function nativeScenePreclaimFixture() {
        const store = await import("@/lib/auth/store");
        const storedSettings = await store.getFreshAuthSettings();
        configured = {
            ...storedSettings,
            defaultModels: configured.defaultModels,
            systemChannels: configured.systemChannels,
            logicalModels: configured.logicalModels,
            agentSkills: configured.agentSkills,
            generationConcurrency: configured.generationConcurrency,
            generationDefaults: { ...storedSettings.generationDefaults, ...configured.generationDefaults },
            ecommerceGenerationEnabled: true,
            ecommerceVisualQualityCheckEnabled: false,
            ecommerceModelRoles: configured.ecommerceModelRoles,
            modelPointCosts: { ...storedSettings.modelPointCosts, "image-model": 2 },
        };
        boundary.settings.mockResolvedValue(configured);
        const db = await auth.readAuthDb();
        db.settings.modelPointCosts = { ...db.settings.modelPointCosts, "image-model": 2 };
        await auth.writeAuthDb(db);
        expect((await auth.readAuthDb()).settings.modelPointCosts["image-model"]).toBe(2);
        expect(configured.generationConcurrency.image).toBe(2);

        const session = await store.createSession(userId);
        boundary.cookie = "vozeb_pro_session=" + session;
        const cookie = boundary.cookie;
        expect(await store.getUserBySession(session), "SETUP: the isolated real Session must resolve the funded source owner").toMatchObject({ id: userId, status: "active" });
        const sessionAuth = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
        boundary.user.mockImplementation(sessionAuth.getCurrentUser);
        const authenticated = await sessionAuth.getCurrentUser(new Request(origin, { headers: { cookie } }));
        assert(authenticated);
        expect(authenticated).toMatchObject({ id: userId, username: "scene-action-user" });
        expect(authenticated.pointsBalance).toBeGreaterThanOrEqual(1000);

        const [imageRoute, imageDetail, referenceRoute, images, imageRuntime] = await Promise.all([
            import("@/app/api/image-tasks/route"),
            import("@/app/api/image-tasks/[id]/route"),
            import("@/app/api/reference-assets/[...path]/route"),
            import("./image-task-store"),
            import("./image-task-runtime"),
        ]);
        const posts: Array<{ requestId: string; taskId: string; body: CreateImageTaskBody }> = [];
        const reads: string[] = [];
        let maskGate: ReturnType<typeof nativeMaskBodyGate> | undefined;
        boundary.request.mockImplementation(async (url, init) => {
            const request = new Request(url, init);
            const parsed = new URL(url);
            expect(request.headers.get("cookie"), "SETUP: real Routes must receive the same Session as the Next cookies fixture").toBe(cookie);
            if (request.method === "GET" && parsed.pathname.startsWith("/api/reference-assets/")) {
                const response = await referenceRoute.GET(request, { params: Promise.resolve({ path: parsed.pathname.slice("/api/reference-assets/".length).split("/").map(decodeURIComponent) }) });
                expect(response.status, "SETUP: real authenticated media Route must read the registered source or native artifact").toBe(200);
                reads.push(parsed.pathname);
                return maskGate?.pathname === parsed.pathname ? maskGate.wrap(response) : response;
            }
            if (request.method === "POST" && parsed.pathname === "/api/image-tasks") {
                const body: CreateImageTaskBody = await request.clone().json();
                const response = await imageRoute.POST(request);
                expect(response.status, "SETUP: actual ImageTask POST must pass current source, logical-task, config and Session checks; response=" + (await response.clone().text())).toBe(200);
                const envelope: { task?: { id?: string } } = await response.clone().json();
                assert(envelope.task?.id && body.context?.clientRequestId);
                posts.push({ requestId: body.context.clientRequestId, taskId: envelope.task.id, body });
                return response;
            }
            const image = /^\/api\/image-tasks\/([^/]+)$/.exec(parsed.pathname);
            assert(request.method === "GET" && image, "Fixture forbids unrelated transport or a hand-made image child");
            const response = await imageDetail.GET(request, { params: Promise.resolve({ id: decodeURIComponent(image[1]) }) });
            expect(response.status).toBe(200);
            return response;
        });
        let charge: Awaited<ReturnType<typeof store.consumeUserPoints>> | undefined;
        async function submitProviderAttempt(submission: ImageTask, requestOrigin: string, requestCookie: string, idempotencyKey: string) {
            expect(requestCookie).toBe(cookie);
            const [{ buildImageEditFormData, normalizeQuality }, { recordEcommerceCanvasRequest, resolveCanvasRequestSize }] = await Promise.all([import("@/app/api/image-tasks/image-task-support"), import("@/app/api/image-tasks/image-task-size")]);
            const quality = normalizeQuality(submission.config.quality || "");
            const form = await buildImageEditFormData(submission, quality, resolveCanvasRequestSize(submission, quality), requestOrigin, requestCookie, "url", false);
            expect(form.get("size")).toBe("100x80");
            expect(form.getAll("image")).toHaveLength(1);
            expect(form.get("mask")).toBeInstanceOf(File);
            await recordEcommerceCanvasRequest(submission, { size: String(form.get("size") || "") }, "OpenAI multipart");
            expect((await images.getImageTask(submission.id))?.ecommerceCanvasRequest).toStrictEqual({ size: "100x80" });
            charge = await store.consumeUserPoints(userId, "image-model", 1, "image", idempotencyKey);
            return {
                dataUrl: "",
                pending: { id: "fixture-native-scene-upstream", mediaBaseUrl: "https://fixture.invalid", pollBaseUrl: "https://fixture.invalid/v1" },
                pointsCost: charge.cost,
                pointsRecordId: charge.recordId,
                pointsRemaining: charge.remaining,
            };
        }
        boundary.create.mockImplementation((submission, requestOrigin, _publicOrigin, requestCookie) => submitProviderAttempt(submission, requestOrigin, requestCookie, "fixture-native-scene-submit:" + submission.id));

        const route = routing.routeEcommerceRole(configured, "image_generation");
        assert(route, "SETUP: real current settings must resolve the supported image route");
        const profile = compiler.resolveEcommerceImageProviderProfile(route.snapshot);
        assert(profile?.supportsIndependentMask);
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const original = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#a0b0c0" } })
            .png()
            .toBuffer();
        const baseline = await registerSource(conversation.id, original);
        installSceneModelReplies(baseline.asset.id);
        const fixture = await pausedSceneRun(conversation.id, baseline.asset.id, "scene-native-claim-b-submit", cookie);
        const paused = fixture.run;
        const originalTask = structuredClone(paused.tasks[0]);
        const snapshot = paused.ecommerceSnapshot;
        assert(snapshot?.plan && snapshot.referenceCheckpoint);
        expect(compiler.compileEcommerceImageRequest(snapshot.plan, profile)).toStrictEqual(originalTask.ecommerceExecution);
        expect(snapshot.referenceCheckpoint).toMatchObject({ state: "resolved", analysisStage: { state: "completed" } });
        const prepareBefore = await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepared.jobId);
        assert(prepareBefore?.resultPayload);
        expect(service.hasOnlyCompletedEcommerceReferencePrepares(paused, await childrenForRun(paused.id))).toBe(true);
        const response = await actionRoute.POST(
            new Request(origin + "/api/agent/runs/" + paused.id + "/resume", {
                method: "POST",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ conversationId: conversation.id, sceneSelection: { baselineAssetId: baseline.asset.id, region: { x: 20, y: 20, width: 25, height: 16 } } }),
            }),
            { params: Promise.resolve({ id: paused.id, action: "resume" }) },
        );
        expect(response.status, "SETUP: actual authenticated Action must persist a native-confirmation receipt").toBe(200);
        const confirmed = await runs.getAgentRun(paused.id);
        const receipt = confirmed?.ecommerceSnapshot?.processing?.sceneSelection;
        assert(confirmed && receipt);
        expect(confirmed.tasks).toStrictEqual(paused.tasks);
        expect(receipt).toMatchObject({ parentTaskId: originalTask.id, confirmation: { actorUserId: userId }, prepare: { jobId: prepareBefore.id, executionId: fixture.completed.executionId, manifestDigest: prepareBefore.resultPayload.manifestDigest } });
        const receiptBefore = structuredClone(receipt);
        await claimAndExecute(paused.id, "scene-submit-claim-a", cookie);
        const build = await waitingStage(paused.id, "build_protection", originalTask.id);
        const native = await completeStage(build.id);
        expect(native.payload).toMatchObject({ operation: "build_protection", inputs: [{ assetId: baseline.asset.id, assetVersion: receiptBefore.baseline.assetVersion, expectedSha256: baseline.sourceSha256 }] });
        expect(native.manifest.sourceIdentities).toMatchObject([{ assetId: baseline.asset.id, assetVersion: receiptBefore.baseline.assetVersion, sha256: baseline.sourceSha256, bytes: original.length, width: 100, height: 80 }]);
        expect(native.manifest.geometry.sceneProtection).toMatchObject({
            sourceAssetId: baseline.asset.id,
            sourceDigest: baseline.sourceSha256,
            sourceSize: { width: 100, height: 80 },
            maskSize: { width: 100, height: 80 },
            maskDigest: native.artifact.sha256,
            targetRegion: receiptBefore.region,
            semantics: receiptBefore.semantics,
            selectionSource: "user_selection",
            maskSemantics: "alpha_zero_edit",
            method: "source_pixels_copy",
        });
        expect(createHash("sha256").update(native.bytes).digest("hex")).toBe(native.artifact.sha256);
        const buildBefore = await tasks.getStoredGenerationTaskRecord("image_processing", build.id);
        assert(buildBefore);
        expect(buildBefore).toMatchObject({ status: "success", executionPhase: "completed", resultPayload: { executionId: native.executionId, manifestDigest: service.imageProcessingManifestDigest(native.manifest), manifest: native.manifest } });
        expect(native.manifest.geometry.sceneProtection?.confirmation).toBeUndefined();
        const registeredMask = await references.readReferenceAsset(native.artifact.storageKey);
        const registeredSource = await references.readReferenceAsset(baseline.token);
        assert(registeredMask?.registration && registeredSource);
        expect(registeredMask.registration).toMatchObject({ ownerUserId: userId, scope: "reference", type: "image", source: "image-processing-mask", runId: paused.id, taskId: build.id, mimeType: "image/png", bytes: native.bytes.length });
        expect(await readFile(registeredMask.filePath)).toEqual(native.bytes);
        expect(await readFile(registeredSource.filePath)).toEqual(original);
        const moneyBefore = await financialTruth();
        expect(moneyBefore.user.pointsBalance).toBe(1000);
        expect(boundary.create).not.toHaveBeenCalled();

        const dispatched = await claimAndExecute(paused.id, "scene-submit-claim-b", cookie);
        const task = dispatched.tasks[0];
        const checkpoint = dispatched.ecommerceSnapshot?.referenceCheckpoint;
        assert(dispatched.executionId && task.sceneProtection && checkpoint);
        expect(dispatched.status, "SETUP: real claim B must materialize and dispatch the original task").toBe("running");
        expect(task).toMatchObject({
            id: originalTask.id,
            count: 2,
            attempts: 1,
            status: "running",
            ecommerceExecution: originalTask.ecommerceExecution,
            sceneProtection: { confirmation: receiptBefore.confirmation, sourceAssetId: baseline.asset.id, sourceDigest: baseline.sourceSha256, maskDigest: native.artifact.sha256, targetRegion: receiptBefore.region, semantics: receiptBefore.semantics },
        });
        const maskUrl = "/api/reference-assets/" + native.artifact.storageKey.split("/").map(encodeURIComponent).join("/");
        expect(task.sceneProtection.mask).toMatchObject({ dataUrl: "", serverUrl: maskUrl, type: "image/png", width: 100, height: 80 });
        expect(task.sceneProtection.confirmation).toStrictEqual(receiptBefore.confirmation);
        expect(dispatched.ecommerceSnapshot).toMatchObject({ plan: snapshot.plan, modelRouteSnapshots: snapshot.modelRouteSnapshots, compilerVersion: snapshot.compilerVersion, referenceCheckpoint: snapshot.referenceCheckpoint });
        expect(dispatched.ecommerceSnapshot?.processing?.sceneSelection).toStrictEqual(receiptBefore);
        expect(dispatched.ecommerceSnapshot?.processing?.waitingFor).toBeUndefined();
        expect(dispatched.ecommerceSnapshot?.fallback).toBeUndefined();
        expect(posts, "SETUP: claim B must create both requested copies through actual ImageTask POST").toHaveLength(2);
        const first = posts.find((post) => post.requestId === paused.clientRequestId + ":" + originalTask.id + ":1:1");
        const second = posts.find((post) => post.requestId === paused.clientRequestId + ":" + originalTask.id + ":1:2");
        assert(first && second);
        expect(first.taskId).not.toBe(second.taskId);
        expect(task.taskIds).toEqual(expect.arrayContaining([first.taskId, second.taskId]));
        expect(task.childTasks).toHaveLength(2);
        expect(task.childTasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.taskId, status: "pending", attempt: 1 }), expect.objectContaining({ id: second.taskId, status: "pending", attempt: 1 })]));
        expect(first.body.sceneProtection).toStrictEqual(task.sceneProtection);
        expect(first.body.ecommerceExecution).toStrictEqual(originalTask.ecommerceExecution);
        const [image, untouchedCopy] = await Promise.all([images.getImageTask(first.taskId), images.getImageTask(second.taskId)]);
        assert(image && untouchedCopy);
        expect(image).toMatchObject({
            id: first.taskId,
            userId,
            runId: paused.id,
            parentTaskId: paused.id,
            conversationId: conversation.id,
            clientRequestId: first.requestId,
            status: "pending",
            kind: "edit",
            references: [{ id: baseline.asset.id, url: baseline.asset.serverUrl, ecommerceRole: "scene" }],
            mask: task.sceneProtection.mask,
            sceneProtection: task.sceneProtection,
            ecommerceExecution: originalTask.ecommerceExecution,
            referenceDispatch: { executionId: dispatched.executionId, inputId: checkpoint.inputId, decisionId: checkpoint.decisionId, analysisRequestId: checkpoint.analysisStage.requestId, copy: 1 },
        });
        expect(untouchedCopy).toMatchObject({ id: second.taskId, status: "pending", referenceDispatch: { copy: 2 } });
        expect(image.mask).toStrictEqual(task.sceneProtection.mask);
        expect(image.sceneProtection).toStrictEqual(task.sceneProtection);
        expect(image.result).toBeUndefined();
        expect(image.attempts).toBeUndefined();
        expect(image.billing).toBeUndefined();
        expect(image.upstream).toBeUndefined();
        expect(untouchedCopy.attempts).toBeUndefined();
        expect(await financialTruth()).toStrictEqual(moneyBefore);
        expect(boundary.create).not.toHaveBeenCalled();
        expect((await childrenForRun(paused.id)).filter((child) => child.type === "image_processing")).toHaveLength(2);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBefore.id)).toStrictEqual(prepareBefore);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);

        const beforeClaim = await tasks.getStoredGenerationTaskRecord("image", first.taskId);
        assert(beforeClaim);
        expect(beforeClaim).toMatchObject({ executionPhase: "created" });
        expect(beforeClaim.workerId).toBeUndefined();
        expect(beforeClaim.leaseUntil).toBeUndefined();
        expect(beforeClaim.submittedAt).toBeUndefined();
        const siblingBefore = await tasks.getStoredGenerationTaskRecord("image", second.taskId);
        assert(siblingBefore);
        expect(await images.getImageTask(second.taskId)).toStrictEqual(untouchedCopy);
        return {
            images,
            imageRuntime,
            imageDetail,
            submitProviderAttempt,
            first,
            second,
            cookie,
            task,
            paused,
            conversation,
            baseline,
            original,
            registeredSource,
            registeredMask,
            native,
            maskUrl,
            receiptBefore,
            prepareBefore,
            build,
            buildBefore,
            moneyBefore,
            siblingBefore,
            posts,
            reads,
            charge: () => charge,
            holdMaskRead() {
                maskGate = nativeMaskBodyGate(maskUrl);
                return maskGate;
            },
        };
    }

    type NativeScenePreclaimFixture = Awaited<ReturnType<typeof nativeScenePreclaimFixture>>;

    async function nativeSceneSubmissionFixture() {
        const fixture = await nativeScenePreclaimFixture();
        const { first, images } = fixture;
        const [claim] = await scheduler.claimDueGenerationTasks({ workerId: "scene-submit-original-image-worker", taskIds: [first.taskId], limit: 1 });
        assert(claim && typeof claim.payload.executionId === "string");
        expect(claim).toMatchObject({ id: first.taskId, workerId: "scene-submit-original-image-worker" });
        expect(claim.leaseUntil).toBeGreaterThan(Date.now());
        const claimedImage = await images.getImageTask(first.taskId);
        assert(claimedImage);
        expect(claimedImage.executionId).toBe(claim.payload.executionId);
        expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(fixture.siblingBefore);
        return { ...fixture, claimedImage, claim };
    }

    type NativeSceneFixture = Awaited<ReturnType<typeof nativeSceneSubmissionFixture>>;

    function nativeMaskBodyGate(pathname: string) {
        const arrived = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        let wrapped = false;
        return {
            pathname,
            arrived: arrived.promise,
            closed: closed.promise,
            release: () => released.resolve(),
            wrap(response: Response) {
                expect(wrapped, "SETUP: hold exactly one actual native mask response body").toBe(false);
                wrapped = true;
                assert(response.body);
                const reader = response.body.getReader();
                let first = true;
                return new Response(
                    new ReadableStream<Uint8Array>({
                        async pull(controller) {
                            try {
                                const chunk = await reader.read();
                                if (chunk.done) {
                                    reader.releaseLock();
                                    closed.resolve();
                                    controller.close();
                                    return;
                                }
                                controller.enqueue(chunk.value);
                                if (first && chunk.value.byteLength) {
                                    first = false;
                                    arrived.resolve();
                                    await released.promise;
                                }
                            } catch (error) {
                                reader.releaseLock();
                                closed.resolve();
                                controller.error(error);
                            }
                        },
                        async cancel(reason) {
                            released.resolve();
                            await reader.cancel(reason);
                            reader.releaseLock();
                            closed.resolve();
                        },
                    }),
                    { status: response.status, headers: response.headers },
                );
            },
        };
    }

    async function mediaTruth() {
        const registry = await import("./local-media-registry");
        return Promise.all(
            (await registry.listFileLocalMediaRegistrations()).map(async (registration) => {
                expect(registration.scope).toBe("reference");
                const media = await references.readReferenceAsset(registration.storageKey);
                assert(media);
                return { registration, bytes: await readFile(media.filePath) };
            }),
        );
    }

    async function submissionPreimage(fixture: NativeScenePreclaimFixture) {
        const imageRecord = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
        const sibling = await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId);
        const parent = await runs.getAgentRun(fixture.paused.id);
        const parentRecord = await tasks.getStoredGenerationTaskRecord("agent", fixture.paused.id);
        assert(imageRecord && sibling && parent && parentRecord);
        expect(sibling).toStrictEqual(fixture.siblingBefore);
        const money = await financialTruth();
        expect(money).toStrictEqual(fixture.moneyBefore);
        return { imageRecord, sibling, parent, parentRecord, money, media: await mediaTruth(), nativeRecords: (await tasks.listStoredGenerationTaskRecords({ type: "image_processing", userId, includeAll: true })).all };
    }

    async function expectSubmissionRejectedWithoutEffects(fixture: NativeSceneFixture, before: Awaited<ReturnType<typeof submissionPreimage>>) {
        expect(boundary.create).not.toHaveBeenCalled();
        expect(fixture.charge()).toBeUndefined();
        expect(fixture.posts).toHaveLength(2);
        expect(await financialTruth()).toStrictEqual(before.money);
        expect(await mediaTruth()).toStrictEqual(before.media);
        expect((await tasks.listStoredGenerationTaskRecords({ type: "image_processing", userId, includeAll: true })).all).toStrictEqual(before.nativeRecords);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.build.id)).toStrictEqual(fixture.buildBefore);
        expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(before.sibling);
        expect(await runs.getAgentRun(fixture.paused.id)).toStrictEqual(before.parent);
        expect(await tasks.getStoredGenerationTaskRecord("agent", fixture.paused.id)).toStrictEqual(before.parentRecord);
        const image = await fixture.images.getImageTask(fixture.first.taskId);
        const schedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
        assert(image && schedule);
        expect(image.status).toBe("running");
        expect(image.attempts).toBeUndefined();
        expect(image.billing).toBeUndefined();
        expect(image.upstream).toBeUndefined();
        expect(image.result).toBeUndefined();
        expect(image.nativeResults).toBeUndefined();
        expect(image.nativeAcquisition).toBeUndefined();
        expect(image.resultProcessing).toBeUndefined();
        expect(image.ecommerceCanvasRequest).toBeUndefined();
        expect(schedule.executionPhase).toBe("created");
        expect(schedule.submittedAt).toBeUndefined();
        expect(schedule.upstreamTaskId).toBeUndefined();
        return schedule;
    }

    async function otherRealJobMask(fixture: NativeSceneFixture) {
        const donor = await pausedSceneRun(fixture.conversation.id, fixture.baseline.asset.id, "scene-native-mask-donor", fixture.cookie);
        expect(donor.run.id).not.toBe(fixture.paused.id);
        const response = await actionRoute.POST(
            new Request(origin + "/api/agent/runs/" + donor.run.id + "/resume", {
                method: "POST",
                headers: { cookie: fixture.cookie, "content-type": "application/json" },
                body: JSON.stringify({ conversationId: fixture.conversation.id, sceneSelection: { baselineAssetId: fixture.baseline.asset.id, region: { x: 60, y: 20, width: 20, height: 15 } } }),
            }),
            { params: Promise.resolve({ id: donor.run.id, action: "resume" }) },
        );
        expect(response.status).toBe(200);
        await claimAndExecute(donor.run.id, "scene-mask-donor-claim-a", fixture.cookie);
        const build = await waitingStage(donor.run.id, "build_protection", donor.run.tasks[0].id);
        const completed = await completeStage(build.id);
        const registration = await references.readReferenceAsset(completed.artifact.storageKey);
        assert(registration?.registration);
        expect(registration.registration).toMatchObject({ ownerUserId: userId, source: "image-processing-mask", scope: "reference", runId: donor.run.id, taskId: build.id, mimeType: "image/png", bytes: completed.bytes.length });
        expect(await readFile(registration.filePath)).toEqual(completed.bytes);
        expect(completed.artifact).toMatchObject({ width: 100, height: 80 });
        expect(build.id).not.toBe(fixture.build.id);
        expect(completed.artifact.storageKey).not.toBe(fixture.native.artifact.storageKey);
        expect(completed.artifact.sha256).not.toBe(fixture.native.artifact.sha256);
        const nativeBefore = (await childrenForRun(donor.run.id)).filter((record) => record.type === "image_processing");
        expect(nativeBefore).toHaveLength(2);
        const maskUrl = "/api/reference-assets/" + completed.artifact.storageKey.split("/").map(encodeURIComponent).join("/");
        expect(maskUrl).not.toBe(fixture.maskUrl);
        expect(maskUrl).toMatch(/^\/api\/reference-assets\/.+/);
        return { maskUrl, runId: donor.run.id, nativeBefore };
    }

    const mediaFaults = [
        {
            name: "source bytes at the existing frozen source guard",
            status: "reference_source_changed",
            reason: "参考图片内容已变化，请重新提供原图。",
            reads: (fixture: NativeSceneFixture) => [fixture.baseline.asset.serverUrl],
            inject: async (fixture: NativeSceneFixture) => {
                const changed = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#d0c0b0" } })
                    .png()
                    .toBuffer();
                expect(createHash("sha256").update(changed).digest("hex")).not.toBe(fixture.baseline.sourceSha256);
                await writeFile(fixture.registeredSource.filePath, changed);
                expect(await readFile(fixture.registeredSource.filePath)).toEqual(changed);
            },
        },
        {
            name: "same-length mask byte drift at the native stream meter",
            status: "scene_mask_review_required",
            reason: "参考图片内容已变化，请重新提供原图。",
            reads: (fixture: NativeSceneFixture) => [fixture.baseline.asset.serverUrl, fixture.maskUrl],
            inject: async (fixture: NativeSceneFixture) => {
                const changed = Buffer.from(fixture.native.bytes);
                changed[changed.length - 1] ^= 1;
                expect(changed.length).toBe(fixture.native.bytes.length);
                expect(changed.subarray(0, 8)).toEqual(fixture.native.bytes.subarray(0, 8));
                expect(createHash("sha256").update(changed).digest("hex")).not.toBe(fixture.native.artifact.sha256);
                await writeFile(fixture.registeredMask.filePath, changed);
                expect(await readFile(fixture.registeredMask.filePath)).toEqual(changed);
            },
        },
        {
            name: "another real same-owner job mask at the expected scene binding",
            status: "scene_mask_review_required",
            reason: "场景保护与当前父任务、确认选区或图片副本不一致",
            reads: (_fixture: NativeSceneFixture) => [],
            inject: async (fixture: NativeSceneFixture) => {
                const donor = await otherRealJobMask(fixture);
                const changed = await tasks.mutateStoredGenerationTask<ImageTask>("image", fixture.first.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
                    assert(current.mask && current.sceneProtection);
                    return { ...current, mask: { ...current.mask, serverUrl: donor.maskUrl }, sceneProtection: { ...current.sceneProtection, mask: { ...current.sceneProtection.mask, serverUrl: donor.maskUrl } } };
                });
                assert(changed?.mask && changed.sceneProtection);
                expect(changed.mask.serverUrl).toBe(donor.maskUrl);
                expect(changed.sceneProtection.mask.serverUrl).toBe(donor.maskUrl);
                expect(changed.mask.dataUrl).toBe("");
                expect(changed.sceneProtection.mask.dataUrl).toBe("");
                expect((await childrenForRun(donor.runId)).filter((record) => record.type === "image_processing")).toStrictEqual(donor.nativeBefore);
                expect((await runs.getAgentRun(fixture.paused.id))?.tasks[0].sceneProtection?.mask.serverUrl).toBe(fixture.maskUrl);
            },
        },
    ];

    it.each(mediaFaults)(
        "rejects $name before the original image attempt or debit",
        async ({ inject, status, reason, reads }) => {
            const fixture = await nativeSceneSubmissionFixture();
            await inject(fixture);
            const before = await submissionPreimage(fixture);
            fixture.reads.length = 0;
            // In particular J passes the freshly persisted image as caller, so the
            // rejection must come from expected scene provenance, not a stale copy.
            const caller = await fixture.images.getImageTask(fixture.first.taskId);
            assert(caller);
            expect(caller.executionId).toBe(fixture.claim.payload.executionId);
            expect(before.imageRecord.leaseUntil).toBeGreaterThan(Date.now());
            const step = await fixture.imageRuntime.createImageTaskUpstreamStep(caller, origin, origin, fixture.cookie);
            expect(step).toStrictEqual({ state: "needs_review", status, reason });
            expect(fixture.reads).toStrictEqual(reads(fixture));
            const after = await expectSubmissionRejectedWithoutEffects(fixture, before);
            expect(after).toStrictEqual({ ...before.imageRecord, status: "running", updatedAt: after.updatedAt, expiresAt: after.expiresAt, payload: { ...before.imageRecord.payload, status: "running", updatedAt: after.payload.updatedAt } });
        },
        30_000,
    );

    const ioFaults = [
        {
            name: "a supported logical child status changing during the actual mask body",
            reason: "场景保护提交身份在原件读取期间已变化",
            inject: async (fixture: NativeSceneFixture) => {
                const parent = await runs.getAgentRun(fixture.paused.id);
                assert(parent?.executionId);
                const changed = structuredClone(parent.tasks);
                const child = changed[0].childTasks?.find((item) => item.id === fixture.first.taskId);
                assert(child);
                expect(child.status).toBe("pending");
                child.status = "needs_review";
                const updated = await runs.updateAgentRunById(parent.id, { tasks: changed }, undefined, ["running"], parent.executionId, parent.tasks);
                assert(updated);
                expect(updated.tasks).toStrictEqual(changed);
                expect(updated.ecommerceSnapshot).toStrictEqual(parent.ecommerceSnapshot);
            },
        },
        {
            name: "a real replacement image owner and epoch during the actual mask body",
            reason: "场景保护缺少当前图片任务的有效提交身份",
            inject: async (fixture: NativeSceneFixture) => {
                assert(fixture.claim.workerId && fixture.claim.executionId);
                const released = await scheduler.releaseGenerationTaskLease("image", fixture.first.taskId, fixture.claim.workerId, { executionPhase: "created", nextPollAt: Date.now() }, { executionId: fixture.claim.executionId });
                assert(released);
                expect(released.workerId).toBeUndefined();
                expect(released.leaseUntil).toBeUndefined();
                const claims = await scheduler.claimDueGenerationTasks({ workerId: "scene-submit-replacement-image-worker", taskIds: [fixture.first.taskId], limit: 1 });
                expect(claims).toHaveLength(1);
                const replacement = claims[0];
                assert(replacement.executionId);
                expect(replacement).toMatchObject({ id: fixture.first.taskId, workerId: "scene-submit-replacement-image-worker" });
                expect(replacement.executionId).not.toBe(fixture.claim.executionId);
                expect(replacement.leaseUntil).toBeGreaterThan(Date.now());
            },
        },
    ];

    it.each(ioFaults)(
        "rejects $name before the original image attempt or debit",
        async ({ inject, reason }) => {
            const fixture = await nativeSceneSubmissionFixture();
            fixture.reads.length = 0;
            const gate = fixture.holdMaskRead();
            const pending = fixture.imageRuntime.createImageTaskUpstreamStep(fixture.claimedImage, origin, origin, fixture.cookie);
            try {
                await Promise.race([
                    gate.arrived,
                    pending.then((step) => {
                        throw new Error("SETUP: actual native mask stream gate was not reached: " + JSON.stringify(step));
                    }),
                ]);
                expect(fixture.reads).toStrictEqual([fixture.baseline.asset.serverUrl, fixture.maskUrl]);
                expect(boundary.create).not.toHaveBeenCalled();
                await inject(fixture);
                const before = await submissionPreimage(fixture);
                gate.release();
                const step = await pending;
                await gate.closed;
                expect(step).toStrictEqual({ state: "needs_review", status: "scene_mask_review_required", reason });
                expect(fixture.reads).toStrictEqual([fixture.baseline.asset.serverUrl, fixture.maskUrl]);
                const after = await expectSubmissionRejectedWithoutEffects(fixture, before);
                expect(after).toStrictEqual(before.imageRecord);
            } finally {
                gate.release();
                await pending;
            }
        },
        30_000,
    );

    it("submits the same native-confirmed scene ImageTask after claim B without an inline mask", async () => {
        const fixture = await nativeSceneSubmissionFixture();
        const { images, imageRuntime, first, second, cookie, claimedImage, claim, task, paused, registeredSource, registeredMask, original, native, receiptBefore, prepareBefore, build, buildBefore, moneyBefore } = fixture;
        const step = await imageRuntime.createImageTaskUpstreamStep(claimedImage, origin, origin, cookie);
        const charge = fixture.charge();
        const afterStep = await images.getImageTask(first.taskId);
        const afterSchedule = await tasks.getStoredGenerationTaskRecord("image", first.taskId);
        const moneyAfter = await financialTruth();
        expect(await readFile(registeredSource.filePath)).toEqual(original);
        expect(await readFile(registeredMask.filePath)).toEqual(native.bytes);
        expect((await runs.getAgentRun(paused.id))?.ecommerceSnapshot?.processing?.sceneSelection).toStrictEqual(receiptBefore);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", prepareBefore.id)).toStrictEqual(prepareBefore);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", build.id)).toStrictEqual(buildBefore);
        assert("status" in step, "SETUP: a fresh unsubmitted ImageTask must reach submission review or a pending upstream");
        expect(["scene_mask_review_required", "submitted"], "SETUP: real create step must pass source/config validation before the native-mask submission gate; actual=" + JSON.stringify(step)).toContain(step.status);
        // First business assertion. On current code the valid native mask reaches the
        // real inline PNG gate and returns scene_mask_review_required before any debit.
        expect(
            step,
            JSON.stringify({
                step,
                providerCalls: boundary.create.mock.calls.length,
                attempts: afterStep?.attempts,
                billing: afterStep?.billing,
                upstream: afterStep?.upstream,
                executionPhase: afterSchedule?.executionPhase,
                submittedAt: afterSchedule?.submittedAt,
                financialUnchanged: JSON.stringify(moneyAfter) === JSON.stringify(moneyBefore),
            }),
        ).toMatchObject({ state: "pending", status: "submitted", upstream: { id: "fixture-native-scene-upstream" } });

        // UNREACHED in the initial native-mask RED. A later GREEN qualifies submission
        // only, with the actual original attempt/debit; no result query or Worker here.
        expect(boundary.create).toHaveBeenCalledOnce();
        assert(charge && afterStep);
        expect(charge).toMatchObject({ cost: 2 });
        expect(afterStep).toMatchObject({
            id: first.taskId,
            runId: paused.id,
            executionId: claim.payload.executionId,
            attemptNo: 1,
            upstream: { id: "fixture-native-scene-upstream" },
            billing: { pointsCost: 2, pointsRecordId: charge.recordId, refunded: false },
            sceneProtection: task.sceneProtection,
            ecommerceCanvasRequest: { size: "100x80" },
        });
        expect(afterStep.attempts).toHaveLength(1);
        expect(afterStep.attempts?.[0]).toMatchObject({ attemptNo: 1, status: "running" });
        expect(afterSchedule).toMatchObject({ executionPhase: "submitted", upstreamTaskId: "fixture-native-scene-upstream" });
        expect(moneyAfter.pointRecords.filter((record) => record.type === "consume")).toMatchObject([{ id: charge.recordId, amount: -2, userId }]);
        expect((await images.getImageTask(second.taskId))?.attempts).toBeUndefined();
        expect((await runs.getAgentRun(paused.id))?.tasks[0].childTasks).toStrictEqual(task.childTasks);
    }, 30_000);

    async function expectLifecycleBindingsUnchanged(fixture: NativeScenePreclaimFixture, before: Awaited<ReturnType<typeof submissionPreimage>>) {
        expect(fixture.posts).toHaveLength(2);
        expect(await mediaTruth()).toStrictEqual(before.media);
        expect((await tasks.listStoredGenerationTaskRecords({ type: "image_processing", userId, includeAll: true })).all).toStrictEqual(before.nativeRecords);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.prepareBefore.id)).toStrictEqual(fixture.prepareBefore);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", fixture.build.id)).toStrictEqual(fixture.buildBefore);
        expect(await tasks.getStoredGenerationTaskRecord("image", fixture.second.taskId)).toStrictEqual(before.sibling);
        expect(await runs.getAgentRun(fixture.paused.id)).toStrictEqual(before.parent);
        expect(await tasks.getStoredGenerationTaskRecord("agent", fixture.paused.id)).toStrictEqual(before.parentRecord);
    }

    it("recovers the same native scene ImageTask through recover POST after a real mask review", async () => {
        const fixture = await nativeScenePreclaimFixture();
        const before = await submissionPreimage(fixture);
        const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
        const changed = Buffer.from(fixture.native.bytes);
        changed[changed.length - 1] ^= 1;
        expect(changed.length).toBe(fixture.native.bytes.length);
        expect(createHash("sha256").update(changed).digest("hex")).not.toBe(fixture.native.artifact.sha256);
        fixture.reads.length = 0;
        try {
            await writeFile(fixture.registeredMask.filePath, changed);
            expect(await readFile(fixture.registeredMask.filePath)).toEqual(changed);
            const reviewed = await runGenerationTaskRecoveryBatch({ origin, publicOrigin: origin, cookie: fixture.cookie, workerId: "scene-native-mask-review-worker", limit: 1, taskIds: [fixture.first.taskId] });
            expect(reviewed, "SETUP: the real batch must claim and persist the real byte-rejection review").toMatchObject({ claimed: 1, pending: 0, needsReview: 1, failed: 0, completed: 0 });
            expect(fixture.reads).toStrictEqual([fixture.baseline.asset.serverUrl, fixture.maskUrl]);
        } finally {
            await writeFile(fixture.registeredMask.filePath, fixture.native.bytes);
        }
        expect(await readFile(fixture.registeredMask.filePath)).toEqual(fixture.native.bytes);
        expect(
            createHash("sha256")
                .update(await readFile(fixture.registeredMask.filePath))
                .digest("hex"),
        ).toBe(fixture.native.artifact.sha256);
        const reviewedImage = await fixture.images.getImageTask(fixture.first.taskId);
        const review = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
        assert(reviewedImage && review);
        expect(review).toMatchObject({ status: "running", executionPhase: "needs_review", lastUpstreamStatus: "scene_mask_review_required:参考图片内容已变化，请重新提供原图。", resultPayload: { reviewReason: "参考图片内容已变化，请重新提供原图。" } });
        expect(review.workerId).toBeUndefined();
        expect(review.leaseUntil).toBeUndefined();
        expect(review.nextPollAt).toBeUndefined();
        expect(review.submittedAt).toBeUndefined();
        expect(review.upstreamTaskId).toBeUndefined();
        expect(reviewedImage).toMatchObject({
            id: fixture.first.taskId,
            runId: fixture.paused.id,
            clientRequestId: fixture.first.requestId,
            status: "running",
            mask: fixture.task.sceneProtection?.mask,
            sceneProtection: fixture.task.sceneProtection,
            executionId: expect.any(String),
        });
        expect(review.payload.executionId).toBe(reviewedImage.executionId);
        expect(reviewedImage.attempts).toBeUndefined();
        expect(reviewedImage.billing).toBeUndefined();
        expect(reviewedImage.upstream).toBeUndefined();
        expect(reviewedImage.result).toBeUndefined();
        expect(reviewedImage.nativeAcquisition).toBeUndefined();
        expect(reviewedImage.nativeResults).toBeUndefined();
        expect(reviewedImage.resultProcessing).toBeUndefined();
        expect(boundary.create).not.toHaveBeenCalled();
        expect(fixture.charge()).toBeUndefined();
        expect(await financialTruth()).toStrictEqual(before.money);
        await expectLifecycleBindingsUnchanged(fixture, before);

        const response = await fixture.imageDetail.POST(
            new Request(origin + "/api/image-tasks/" + fixture.first.taskId, { method: "POST", headers: { cookie: fixture.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }),
            { params: Promise.resolve({ id: fixture.first.taskId }) },
        );
        const body: { error?: string; task?: { id: string; status: string; executionPhase: string; needsReview: boolean } } = await response.clone().json();
        expect([200, 409], "SETUP: actual user recovery must pass Session/body/ownership checks").toContain(response.status);
        expect([undefined, "原任务没有保存上游任务 ID，无法安全追回结果"], "SETUP: exclude a different recovery/config failure").toContain(body.error);
        // First business assertion A. Current inline-only recovery eligibility returns
        // 409 after a genuine batch persisted the review and original bytes returned.
        expect(response.status, JSON.stringify({ body, schedule: await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId), providerCalls: boundary.create.mock.calls.length, money: await financialTruth() })).toBe(200);

        // UNREACHED in A's initial RED: actual POST must submit this original image.
        expect(body.task).toMatchObject({ id: fixture.first.taskId, status: "running", executionPhase: "polling", needsReview: false });
        expect(boundary.create).toHaveBeenCalledOnce();
        const charge = fixture.charge();
        const submitted = await fixture.images.getImageTask(fixture.first.taskId);
        assert(charge && submitted);
        expect(charge.cost).toBe(2);
        expect(submitted).toMatchObject({
            id: fixture.first.taskId,
            clientRequestId: fixture.first.requestId,
            attemptNo: 1,
            upstream: { id: "fixture-native-scene-upstream" },
            billing: { pointsCost: 2, pointsRecordId: charge.recordId, refunded: false },
            mask: fixture.task.sceneProtection?.mask,
            sceneProtection: fixture.task.sceneProtection,
        });
        expect(submitted.attempts).toMatchObject([{ attemptNo: 1, status: "running" }]);
        const money = await financialTruth();
        expect(money.user.pointsBalance).toBe(998);
        expect(money.pointRecords.filter((record) => record.type === "consume")).toMatchObject([{ id: charge.recordId, amount: -2 }]);
        await expectLifecycleBindingsUnchanged(fixture, before);
    }, 30_000);

    it("retries the same native scene ImageTask once after a queried terminal upstream failure", async () => {
        const fixture = await nativeScenePreclaimFixture();
        const before = await submissionPreimage(fixture);
        const walletBefore = await wallet.getPointsWalletSnapshot(userId);
        const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
        const { imagePointsIdempotencyKey } = await import("@/app/api/image-tasks/image-task-support");
        const firstUpstream = "fixture-native-lifecycle-upstream-1";
        const secondUpstream = "fixture-native-lifecycle-upstream-2";
        const firstPoll = origin + "/fixture-native-query/" + firstUpstream;
        const secondPoll = origin + "/fixture-native-query/" + secondUpstream;
        const failures = new Map([
            [firstPoll, { status: "failed", msg: "fixture upstream one failed" }],
            [secondPoll, { status: "failed", msg: "fixture upstream two failed" }],
        ]);
        const queries: string[] = [];
        const mediaRequest = boundary.request.getMockImplementation();
        assert(mediaRequest);
        boundary.request.mockImplementation(async (url, init) => {
            const failure = failures.get(url);
            if (failure) {
                const request = new Request(url, init);
                expect(request.method).toBe("GET");
                expect(request.headers.get("cookie")).toBe(fixture.cookie);
                queries.push(url);
                return Response.json(failure);
            }
            return mediaRequest(url, init);
        });
        boundary.create.mockImplementation(async (submission, requestOrigin, _publicOrigin, requestCookie) => {
            expect([1, 2], "SETUP: only the original provider attempt and one retry are declared").toContain(submission.attemptNo);
            const result = await fixture.submitProviderAttempt(submission, requestOrigin, requestCookie, imagePointsIdempotencyKey(submission));
            const id = "fixture-native-lifecycle-upstream-" + submission.attemptNo;
            return { ...result, pending: { id, mediaBaseUrl: origin, pollBaseUrl: origin, explicitPollUrl: origin + "/fixture-native-query/" + id } };
        });
        const firstBatch = await runGenerationTaskRecoveryBatch({ origin, publicOrigin: origin, cookie: fixture.cookie, workerId: "scene-native-first-submit-worker", limit: 1, taskIds: [fixture.first.taskId] });
        expect(firstBatch, "SETUP: actual native first submission must retain the qualified path").toMatchObject({ claimed: 1, pending: 1, needsReview: 0, failed: 0 });
        expect(boundary.create).toHaveBeenCalledOnce();
        const firstCharge = fixture.charge();
        const firstImage = await fixture.images.getImageTask(fixture.first.taskId);
        const firstSchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
        assert(firstCharge && firstImage && firstSchedule);
        expect(firstCharge).toMatchObject({ cost: 2, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:1" });
        expect(firstImage).toMatchObject({ id: fixture.first.taskId, attemptNo: 1, upstream: { id: firstUpstream, explicitPollUrl: firstPoll }, billing: { pointsCost: 2, pointsRecordId: firstCharge.recordId, refunded: false } });
        expect(firstImage.attempts).toMatchObject([{ attemptNo: 1, status: "running" }]);
        expect(firstSchedule).toMatchObject({ executionPhase: "polling", upstreamTaskId: firstUpstream });
        expect(firstSchedule.workerId).toBeUndefined();
        expect(firstSchedule.leaseUntil).toBeUndefined();
        expect((await financialTruth()).user.pointsBalance).toBe(998);
        expect(queries).toStrictEqual([]);

        const response = await fixture.imageDetail.POST(
            new Request(origin + "/api/image-tasks/" + fixture.first.taskId, { method: "POST", headers: { cookie: fixture.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }),
            { params: Promise.resolve({ id: fixture.first.taskId }) },
        );
        expect(response.status, "SETUP: actual recover POST must query and finish the first terminal-failed upstream; body=" + (await response.clone().text())).toBe(200);
        expect(await response.json()).toMatchObject({ task: { id: fixture.first.taskId, status: "running", executionPhase: "created", needsReview: false } });
        expect(queries).toStrictEqual([firstPoll]);
        expect(boundary.create).toHaveBeenCalledOnce();
        const retryImage = await fixture.images.getImageTask(fixture.first.taskId);
        const retrySchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
        const refunded = await financialTruth();
        assert(retryImage && retrySchedule);
        expect(retryImage).toMatchObject({
            id: fixture.first.taskId,
            runId: fixture.paused.id,
            clientRequestId: fixture.first.requestId,
            status: "running",
            attemptNo: 1,
            retryable: false,
            mask: fixture.task.sceneProtection?.mask,
            sceneProtection: fixture.task.sceneProtection,
        });
        expect(retryImage.attempts).toMatchObject([{ attemptNo: 1, status: "failed", error: "fixture upstream one failed", pointsCost: 2, pointsRecordId: firstCharge.recordId }]);
        expect(retryImage.attempts?.[0].completedAt).toBeGreaterThan(0);
        expect(retryImage.upstream).toBeUndefined();
        expect(retryImage.billing).toBeUndefined();
        expect(retryImage.result).toBeUndefined();
        expect(retryImage.nativeAcquisition).toBeUndefined();
        expect(retryImage.nativeResults).toBeUndefined();
        expect(retryImage.resultProcessing).toBeUndefined();
        expect(retrySchedule).toMatchObject({ executionPhase: "created", lastUpstreamStatus: "automatic_retry_after_upstream_failure" });
        expect(retrySchedule.workerId).toBeUndefined();
        expect(retrySchedule.leaseUntil).toBeUndefined();
        expect(retrySchedule.submittedAt).toBeUndefined();
        expect(retrySchedule.upstreamTaskId).toBeUndefined();
        expect(retrySchedule.queryPath).toBeUndefined();
        expect(retrySchedule.nextPollAt).toBeGreaterThan(0);
        expect(retrySchedule.nextPollAt).toBeLessThanOrEqual(Date.now());
        expect(refunded.user.pointsBalance).toBe(1000);
        expect(refunded.pointRecords.filter((record) => record.type === "consume")).toMatchObject([{ id: firstCharge.recordId, amount: -2, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:1" }]);
        expect(refunded.pointRecords.filter((record) => record.type === "refund")).toMatchObject([{ amount: 2, sourceRecordId: firstCharge.recordId, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:1:refund" }]);
        expect(await wallet.getPointsWalletSnapshot(userId)).toStrictEqual(walletBefore);
        await expectLifecycleBindingsUnchanged(fixture, before);

        const retried = await runGenerationTaskRecoveryBatch({ origin, publicOrigin: origin, cookie: fixture.cookie, workerId: "scene-native-retry-submit-worker", limit: 1, taskIds: [fixture.first.taskId] });
        const afterRetry = await fixture.images.getImageTask(fixture.first.taskId);
        const afterRetrySchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
        assert(afterRetry && afterRetrySchedule);
        expect(retried.claimed, "SETUP: the real clean automatic retry must be due and claimable").toBe(1);
        expect(["polling", "needs_review"], "SETUP: exclude a different scheduler or persistence boundary").toContain(afterRetrySchedule.executionPhase);
        expect(["submitted", "scene_mask_review_required"], "SETUP: second create must reach the native attempt gate or a pending provider").toContain(afterRetrySchedule.lastUpstreamStatus?.split(":")[0]);
        expect(afterRetry.attempts?.[0]).toStrictEqual(retryImage.attempts?.[0]);
        await expectLifecycleBindingsUnchanged(fixture, before);
        // First business assertion B. Current native submission rejects the real
        // completed attempt1 despite the real query/refund/clean retry transition.
        expect(
            retried,
            JSON.stringify({ schedule: afterRetrySchedule, image: afterRetry, providerCalls: boundary.create.mock.calls.length, queries, financialUnchangedAfterRefund: JSON.stringify(await financialTruth()) === JSON.stringify(refunded) }),
        ).toMatchObject({ claimed: 1, pending: 1, needsReview: 0, failed: 0 });

        // UNREACHED in B's initial RED: second provider attempt, then terminal stop.
        expect(boundary.create).toHaveBeenCalledTimes(2);
        const secondCharge = fixture.charge();
        assert(secondCharge);
        expect(secondCharge.recordId).not.toBe(firstCharge.recordId);
        expect(secondCharge).toMatchObject({ cost: 2, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:2" });
        expect(afterRetry).toMatchObject({
            id: fixture.first.taskId,
            clientRequestId: fixture.first.requestId,
            attemptNo: 2,
            upstream: { id: secondUpstream, explicitPollUrl: secondPoll },
            billing: { pointsCost: 2, pointsRecordId: secondCharge.recordId, refunded: false },
        });
        expect(afterRetry.attempts).toMatchObject([
            { attemptNo: 1, status: "failed" },
            { attemptNo: 2, status: "running" },
        ]);
        expect((await financialTruth()).user.pointsBalance).toBe(998);
        const terminalResponse = await fixture.imageDetail.POST(
            new Request(origin + "/api/image-tasks/" + fixture.first.taskId, { method: "POST", headers: { cookie: fixture.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }),
            { params: Promise.resolve({ id: fixture.first.taskId }) },
        );
        expect(terminalResponse.status).toBe(200);
        expect(await terminalResponse.json()).toMatchObject({ task: { id: fixture.first.taskId, status: "error", executionPhase: "completed" } });
        expect(queries).toStrictEqual([firstPoll, secondPoll]);
        expect(boundary.create).toHaveBeenCalledTimes(2);
        const failed = await fixture.images.getImageTask(fixture.first.taskId);
        const failedSchedule = await tasks.getStoredGenerationTaskRecord("image", fixture.first.taskId);
        const settled = await financialTruth();
        assert(failed && failedSchedule);
        expect(failed).toMatchObject({ status: "error", attemptNo: 2, billing: { pointsCost: 2, pointsRecordId: secondCharge.recordId, refunded: true } });
        expect(failed.attempts).toMatchObject([
            { attemptNo: 1, status: "failed", pointsRecordId: firstCharge.recordId },
            { attemptNo: 2, status: "failed", pointsRecordId: secondCharge.recordId, error: "fixture upstream two failed" },
        ]);
        expect(failedSchedule.executionPhase).toBe("completed");
        expect(failedSchedule.nextPollAt).toBeUndefined();
        expect(failedSchedule.workerId).toBeUndefined();
        expect(failedSchedule.leaseUntil).toBeUndefined();
        expect(settled.user.pointsBalance).toBe(1000);
        expect(settled.pointRecords.filter((record) => record.type === "consume")).toMatchObject([
            { id: firstCharge.recordId, amount: -2 },
            { id: secondCharge.recordId, amount: -2 },
        ]);
        expect(settled.pointRecords.filter((record) => record.type === "refund")).toMatchObject([
            { amount: 2, sourceRecordId: firstCharge.recordId, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:1:refund" },
            { amount: 2, sourceRecordId: secondCharge.recordId, idempotencyKey: "image-task:" + fixture.first.taskId + ":attempt:2:refund" },
        ]);
        expect(await wallet.getPointsWalletSnapshot(userId)).toStrictEqual(walletBefore);
        expect(await runGenerationTaskRecoveryBatch({ origin, publicOrigin: origin, cookie: fixture.cookie, workerId: "scene-native-no-third-submit-worker", limit: 1, taskIds: [fixture.first.taskId] })).toMatchObject({ claimed: 0 });
        expect(boundary.create).toHaveBeenCalledTimes(2);
        await expectLifecycleBindingsUnchanged(fixture, before);
    }, 30_000);
});
