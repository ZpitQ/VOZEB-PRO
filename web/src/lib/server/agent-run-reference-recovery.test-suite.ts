import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImageProcessing } from "../../../scripts/image-processing-supervisor.mjs";
import type { AuthSettings } from "@/lib/auth/store";
import type { AgentRun } from "./agent-run-store";
import type { StoredGenerationTaskRecord } from "./generation-task-types";
import type { ImageProcessingPayload } from "./image-processing-service";
import type { CreativeReferenceRecovery, CreativeReferenceReview } from "@/lib/creative-runtime-contract";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { StructuredTextRequest } from "./text-planning-runtime";
import { settings } from "./agent-run-executor.test-fixtures";

const boundary = vi.hoisted(() => ({
    userId: "agent-reference-recovery-user",
    settings: vi.fn<() => Promise<AuthSettings>>(),
    request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
    model: vi.fn<typeof import("./text-planning-runtime").requestStructuredText>(),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => ({ id: boundary.userId }) }));
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

export const agentReferenceRecoverySuite = (provider: "file" | "postgres") =>
    (provider === "file" || process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1" ? describe : describe.skip)(`${provider} reference review resumes its original Run with completed native prepares`, () => {
        let directory: string;
        let runtime: typeof import("./creative-runtime-store");
        let runs: typeof import("./agent-run-store");
        let tasks: typeof import("./generation-task-store");
        let scheduler: typeof import("./generation-task-scheduler");
        let references: typeof import("./reference-asset-store");
        let executor: typeof import("./agent-run-executor");
        let service: typeof import("./image-processing-service");
        let actionRoute: typeof import("@/app/api/agent/runs/[id]/[action]/route");
        let getRoute: typeof import("@/app/api/agent/runs/[id]/route");
        let imageTasks: typeof import("./image-task-store");
        let database: typeof import("./database");
        let unavailableOriginalPath: string | undefined;
        const userId = provider === "postgres" ? `agent-reference-recovery-${randomUUID()}` : "agent-reference-recovery-user";
        const otherUserId = `agent-reference-recovery-other-${randomUUID()}`;
        const origin = "http://fixture.local";
        const productFacts = { identity: "cabinet", outline: "rectangular cabinet", color: "oak", material: "wood", brandText: [], view: "front" };
        const sceneFacts = { space: "living room", composition: "eye level", lighting: "soft daylight" };

        beforeEach(async () => {
            if (provider === "postgres" && (process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" || process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || !process.env.DATABASE_URL))
                throw new Error("Explicit isolated PostgreSQL fixture authorization is required");
            vi.resetModules();
            boundary.userId = userId;
            boundary.settings.mockReset();
            boundary.request.mockReset();
            boundary.model.mockReset();
            unavailableOriginalPath = undefined;
            directory = await mkdtemp(join(tmpdir(), "vozeb-agent-reference-recovery-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
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
            [runtime, runs, tasks, scheduler, references, executor, service, actionRoute, getRoute, imageTasks, database] = await Promise.all([
                import("./creative-runtime-store"),
                import("./agent-run-store"),
                import("./generation-task-store"),
                import("./generation-task-scheduler"),
                import("./reference-asset-store"),
                import("./agent-run-executor"),
                import("./image-processing-service"),
                import("@/app/api/agent/runs/[id]/[action]/route"),
                import("@/app/api/agent/runs/[id]/route"),
                import("./image-task-store"),
                import("./database"),
            ]);
            expect(database.getDatabaseProvider()).toBe(provider);
            if (provider === "postgres") {
                await database.initializePostgresSchema();
                await createFixtureUser(userId);
                await createFixtureUser(otherUserId);
            }
            boundary.request.mockImplementation(async (url, init) => {
                const parsed = new URL(url);
                if (parsed.pathname === "/api/image-tasks" && init?.method === "POST") return new Response("Fixture stops at the downstream image submission boundary", { status: 502 });
                expect(init?.method || "GET").toBe("GET");
                if (parsed.pathname === unavailableOriginalPath) return new Response("Temporary original-source read failure", { status: 503 });
                expect(parsed.pathname).toMatch(/^\/api\/reference-assets\//);
                const media = await references.readReferenceAsset(decodeURIComponent(parsed.pathname.slice("/api/reference-assets/".length)));
                assert(media, "Fixture HTTP must read actual registered media");
                expect(media.registration?.ownerUserId).toBe(userId);
                return new Response(new Uint8Array(await readFile(media.filePath)), { headers: { "content-type": media.mimeType } });
            });
        });

        afterEach(async () => {
            if (provider === "postgres") {
                const users = database.createPostgresRepositories().users;
                await users.delete(userId);
                await users.delete(otherUserId);
            }
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        });

        async function createFixtureUser(id: string) {
            const repositories = database.createPostgresRepositories();
            const configured = await repositories.settings.getSettings();
            const planId = configured.settings?.defaultPlanId || configured.plans[0]?.id;
            assert(planId);
            await repositories.users.createWithNextAccountId({
                id,
                username: "fixture_" + randomUUID().replaceAll("-", "").slice(0, 16),
                displayName: "Reference recovery fixture",
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

        async function registerSource(conversationId: string, ordinal: number, source: Buffer) {
            const stored = await references.writeReferenceImageDataUrl("data:image/png;base64," + source.toString("base64"), { ownerUserId: userId, conversationId, source: "fixture-agent-reference-recovery" });
            const media = await references.readReferenceAsset(stored.token);
            assert(media);
            expect(media.registration).toMatchObject({ ownerUserId: userId, storageKey: stored.token, scope: "reference" });
            expect(await readFile(media.filePath)).toEqual(source);
            const [asset] = await runtime.registerCreativeAssets([
                { userId, conversationId, ordinal, type: "image", title: "reference.png", sourceRunId: "upload", serverUrl: "/api/reference-assets/" + stored.token, storageKey: stored.token, width: 100, height: 80, metadata: {} },
            ]);
            return { asset, sourceSha256: createHash("sha256").update(source).digest("hex") };
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

        async function waitingStage(runId: string, operation: "prepare_reference" | "build_protection", count: number, parentTaskId: string) {
            const run = await runs.getAgentRun(runId);
            assert(run?.ecommerceSnapshot);
            const children = (await tasks.listStoredGenerationTaskRecordsByRunIds([runId], [userId])).filter((record) => record.type === "image_processing" && record.payload.operation === operation);
            const diagnostic = JSON.stringify({
                status: run.status,
                failure: run.failure,
                fallback: run.ecommerceSnapshot.fallback,
                tasks: run.tasks,
                children,
                modelTools: boundary.model.mock.calls.map(([request]) => request.tool.name),
                http: boundary.request.mock.calls.map(([url, init]) => ({ url, method: init?.method || "GET" })),
            });
            expect(children, diagnostic).toHaveLength(count);
            const waiting = run.ecommerceSnapshot.processing?.waitingFor;
            assert(waiting, diagnostic);
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

        async function completePrepare(jobId: string) {
            const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
            const workerId = "reference-recovery-image-worker";
            const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
            expect(claimed.tasks).toHaveLength(1);
            const task = claimed.tasks[0];
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
            const { artifacts, metrics, ...manifest } = outcome.result;
            expect(artifacts).toHaveLength(1);
            const native = artifacts[0];
            expect(native.kind).toBe("analysis");
            assert(native.kind === "analysis");
            const bytes = await readFile(native.path);
            const response = new Response(new Uint8Array(bytes));
            assert(response.body);
            const artifact = await service.writeImageProcessingOutput(jobId, native.kind, identity, { stream: response.body, mimeType: native.mimeType });
            expect(artifact).toMatchObject({ kind: native.kind, sha256: native.sha256, bytes: native.bytes, width: native.width, height: native.height });
            const completedManifest = { ...manifest, artifacts: [artifact] };
            expect(await service.completeImageProcessingTask(jobId, { ...identity, manifest: completedManifest, metrics })).toMatchObject({ jobId, executionId: identity.executionId, parentRescheduled: true });
            return { payload: task.payload, manifest: completedManifest, artifact };
        }

        function modelReply(value: unknown) {
            return { arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat" as const, elapsedMs: 1 };
        }

        type PlannerMessage = {
            sources: { productAnchorId: string | null; currentSceneBaselineId: string | null; sceneReferenceIds: string[] };
            requiredModelRoles: EcommerceEditPlan["modelRoles"];
            continuity: EcommerceEditPlan["continuity"];
            visualAnalysis: { references: Array<{ assetId: string; alias: string | null; purposes: string[]; productFacts: EcommerceEditPlan["baseline"]["productFacts"]; sceneFacts: EcommerceEditPlan["baseline"]["sceneFacts"] }> };
        };

        function installModelReplies(analysis: unknown, operation: "product_to_scene" | "local_edit") {
            boundary.model.mockImplementation(async (request: StructuredTextRequest) => {
                if (request.tool.name === "analyze_ecommerce_references") return modelReply(analysis);
                expect(request.tool.name).toBe("plan_ecommerce_edit");
                const user = request.messages.find((message) => message.role === "user");
                assert(user && typeof user.content === "string");
                const input: PlannerMessage = JSON.parse(user.content);
                const product = input.visualAnalysis.references.find((reference) => reference.assetId === input.sources.productAnchorId);
                const scene = input.visualAnalysis.references.find((reference) => reference.assetId === input.sources.currentSceneBaselineId);
                assert(product?.productFacts, "The real planner must receive a confirmed product anchor");
                return modelReply({
                    planVersion: "ecommerce-edit.v7",
                    operation,
                    source: { productAnchorId: input.sources.productAnchorId, currentSceneBaselineId: input.sources.currentSceneBaselineId, sceneReferenceIds: input.sources.sceneReferenceIds },
                    baseline: { productFacts: product.productFacts, sceneFacts: scene?.sceneFacts ?? null },
                    delta: { requestedChanges: ["把背景换成厨房"], targetObjects: ["background-main"], targetRegions: [] },
                    preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
                    strategy: "full_image",
                    modelRoles: input.requiredModelRoles,
                    continuity: input.continuity,
                    referenceUses: input.visualAnalysis.references.map((reference) => ({ assetId: reference.assetId, alias: reference.alias, purposes: reference.purposes, usedCueIds: [] })),
                    validation: { requiredChecks: ["product_identity"] },
                });
            });
        }

        function productObservation(assetId: string) {
            return {
                assetId,
                contentType: "isolated_product",
                confidence: "high",
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts,
                sceneFacts: null,
                productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
                fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
                editableTargets: [],
                visibleStructure: [],
                cues: [],
            };
        }

        function sceneObservation(assetId: string) {
            return {
                assetId,
                contentType: "interior_scene",
                confidence: "high",
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts,
                productCore: { x: 0.4, y: 0.25, width: 0.2, height: 0.5 },
                fusionHalo: { x: 0.35, y: 0.2, width: 0.3, height: 0.6 },
                editableTargets: [{ id: "background-main", kind: "background", label: "main background", region: { x: 0, y: 0, width: 1, height: 1 } }],
                visibleStructure: [],
                cues: [],
            };
        }

        async function productSource() {
            return sharp({ create: { width: 100, height: 80, channels: 4, background: "white" } })
                .composite([{ input: { create: { width: 32, height: 40, channels: 4, background: "#8a6243" } }, left: 34, top: 20 }])
                .png()
                .toBuffer();
        }

        async function startRun(conversationId: string, assetIds: string[], prompt: string, beforePrepare: (run: AgentRun) => Promise<void> = async () => {}) {
            const { run } = await runs.createAgentRun(userId, { clientRequestId: "reference-recovery-original-run", conversationId, surface: "chat", prompt, assetIds, skillIds: [], modelIds: [], preferences: { mode: "image" } });
            await beforePrepare(run);
            await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
            await claimAndExecute(run.id, "prepare-parent-one");
            return run;
        }

        async function completeReference(runId: string, assetId: string, count: number) {
            const stage = await waitingStage(runId, "prepare_reference", count, runId);
            expect(stage.payload.inputs).toMatchObject([{ assetId }]);
            expect(boundary.model).not.toHaveBeenCalled();
            const completed = await completePrepare(stage.id);
            expect(completed.manifest.sourceIdentities).toMatchObject([{ assetId, width: 100, height: 80 }]);
            return stage.id;
        }

        type PublicRun = Awaited<ReturnType<typeof import("./agent-run-public-selection").publicAgentRunForRequest>>;
        type RunReply = { code: number; data: { run: PublicRun } | null; msg: string };

        async function readPublicRun(run: AgentRun) {
            const response = await getRoute.GET(new Request(origin + "/api/agent/runs/" + run.id, { headers: { cookie: "session=fixture" } }), { params: Promise.resolve({ id: run.id }) });
            expect(response.status).toBe(200);
            const body: RunReply = await response.json();
            expect(body.code).toBe(0);
            assert(body.data);
            expect(body.data.run).toMatchObject({ id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId });
            return body.data.run;
        }

        async function readReview(run: AgentRun, kind: CreativeReferenceReview["kind"]) {
            const publicRun = await readPublicRun(run);
            const review = publicRun.ecommerceReferenceReview;
            expect(review).toMatchObject({ version: "ecommerce-reference-review.v1", kind, reviewId: run.ecommerceSnapshot?.referenceCheckpoint?.reviewId });
            assert(review);
            return review;
        }

        async function referenceResume(run: AgentRun, referenceRecovery: CreativeReferenceRecovery) {
            return actionRoute.POST(
                new Request(origin + "/api/agent/runs/" + run.id + "/resume", {
                    method: "POST",
                    headers: { "content-type": "application/json", cookie: "session=fixture" },
                    body: JSON.stringify({ conversationId: run.conversationId, referenceRecovery }),
                }),
                { params: Promise.resolve({ id: run.id, action: "resume" }) },
            );
        }

        async function retryOriginalRun(run: AgentRun) {
            const response = await actionRoute.POST(
                new Request(origin + "/api/agent/runs/" + run.id + "/retry", {
                    method: "POST",
                    headers: { "content-type": "application/json", cookie: "session=fixture" },
                    body: JSON.stringify({ conversationId: run.conversationId }),
                }),
                { params: Promise.resolve({ id: run.id, action: "retry" }) },
            );
            expect(response.status).toBe(200);
            const body: RunReply = await response.json();
            expect(body.code).toBe(0);
        }

        async function assertOriginalMessages(run: AgentRun) {
            const messages = await runtime.listCreativeMessages(run.conversationId);
            expect(messages).toHaveLength(2);
            expect(messages.map((message) => message.id)).toEqual([run.inputMessageId, run.assistantMessageId]);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
            expect(messages.map((message) => message.sequence)).toEqual([1, 2]);
        }

        async function prepareRecords(runId: string) {
            return (await tasks.listStoredGenerationTaskRecordsByRunIds([runId], [userId])).filter((record) => record.type === "image_processing" && record.payload.operation === "prepare_reference");
        }

        async function arrangeConfirmPurposes(beforePrepare: (run: AgentRun) => Promise<void> = async () => {}) {
            const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
            const product = await registerSource(conversation.id, 0, await productSource());
            const scene = await registerSource(
                conversation.id,
                1,
                await sharp({ create: { width: 100, height: 80, channels: 4, background: "#a0b0c0" } })
                    .composite([{ input: { create: { width: 20, height: 40, channels: 4, background: "#8a6243" } }, left: 40, top: 20 }])
                    .png()
                    .toBuffer(),
            );
            installModelReplies({ analysisVersion: "ecommerce-visual-analysis.v4", references: [productObservation(product.asset.id), sceneObservation(scene.asset.id)], purposeSuggestions: [] }, "local_edit");
            const run = await startRun(conversation.id, [product.asset.id, scene.asset.id], "以图片1的商品为商品身份，修改图片2的背景为厨房，保留商品外观", beforePrepare);
            const first = await completeReference(run.id, product.asset.id, 1);
            await claimAndExecute(run.id, "review-prepare-two-parent");
            const second = await completeReference(run.id, scene.asset.id, 2);
            const paused = await claimAndExecute(run.id, "purpose-review-parent");
            expect(paused).toMatchObject({
                status: "paused",
                ecommerceSnapshot: { fallback: { reason: "reference_purpose_confirmation_required" }, referenceCheckpoint: { state: "needs_review", analysisStage: { state: "completed" }, analysis: { analysisVersion: "ecommerce-visual-analysis.v4" } } },
            });
            expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references"]);
            const review = await readReview(paused, "confirm_purposes");
            const productReview = review.assets.find((asset) => asset.assetId === product.asset.id);
            const sceneReview = review.assets.find((asset) => asset.assetId === scene.asset.id);
            assert(productReview && sceneReview);
            const recovery: CreativeReferenceRecovery = {
                reviewId: review.reviewId,
                action: "confirm_purposes",
                decisionVersion: "ecommerce-reference-decision.v1",
                bindings: [
                    { assetId: product.asset.id, assetVersion: productReview.assetVersion, purposes: ["product_identity"] },
                    { assetId: scene.asset.id, assetVersion: sceneReview.assetVersion, purposes: ["edit_target"] },
                ],
            };
            return {
                run,
                paused,
                recovery,
                prepareJobs: [first, second],
                prepareStatuses: ["success", "success"],
                sources: [
                    { assetId: product.asset.id, sha256: product.sourceSha256 },
                    { assetId: scene.asset.id, sha256: scene.sourceSha256 },
                ],
                baseline: scene,
            };
        }

        async function arrangeRetryAnalysis() {
            const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
            const product = await registerSource(conversation.id, 0, await productSource());
            installModelReplies({ analysisVersion: "ecommerce-visual-analysis.v4", references: [productObservation(product.asset.id)], purposeSuggestions: [] }, "product_to_scene");
            boundary.model.mockResolvedValueOnce(modelReply({ analysisVersion: "ecommerce-visual-analysis.v4", references: [], purposeSuggestions: [] }));
            const run = await startRun(conversation.id, [product.asset.id], "修改图片1，把背景换成厨房，保留商品外观");
            const prepared = await completeReference(run.id, product.asset.id, 1);
            const paused = await claimAndExecute(run.id, "invalid-analysis-review-parent");
            expect(paused).toMatchObject({
                status: "paused",
                ecommerceSnapshot: { fallback: { reason: "visual_analysis_unavailable" }, referenceCheckpoint: { state: "needs_review", analysisStage: { state: "failed" }, failure: { kind: "invalid_structure" } } },
            });
            expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references"]);
            const review = await readReview(paused, "retry_analysis");
            const recovery: CreativeReferenceRecovery = { reviewId: review.reviewId, action: "retry_analysis" };
            return { run, paused, recovery, prepareJobs: [prepared], prepareStatuses: ["success"], sources: [{ assetId: product.asset.id, sha256: product.sourceSha256 }], baseline: product };
        }

        async function arrangeRetrySource() {
            const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
            const product = await registerSource(conversation.id, 0, await productSource());
            const analysis = { analysisVersion: "ecommerce-visual-analysis.v4", references: [productObservation(product.asset.id)], purposeSuggestions: [] };
            installModelReplies(analysis, "product_to_scene");
            const validReply = boundary.model.getMockImplementation();
            assert(validReply);
            boundary.model.mockImplementation(async (request) => {
                if (request.tool.name === "plan_ecommerce_edit") throw new Error("Fixture stops planning after the accepted visual checkpoint");
                return validReply(request);
            });
            const run = await startRun(conversation.id, [product.asset.id], "修改图片1，把背景换成厨房，保留商品外观");
            const prepared = await completeReference(run.id, product.asset.id, 1);
            const accepted = await claimAndExecute(run.id, "accepted-visual-parent");
            expect(accepted).toMatchObject({ status: "failed", failureStage: "planning", ecommerceSnapshot: { referenceCheckpoint: { analysisStage: { state: "completed" }, analysis: { analysisVersion: "ecommerce-visual-analysis.v4" } } } });
            expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
            expect(await scheduler.releaseGenerationTaskLease("agent", run.id, "accepted-visual-parent", { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "fixture-planning-stopped" })).not.toBeNull();
            assert(product.asset.serverUrl);
            unavailableOriginalPath = new URL(product.asset.serverUrl, origin).pathname;
            await retryOriginalRun(run);
            const paused = await claimAndExecute(run.id, "source-read-review-parent");
            expect(paused).toMatchObject({
                status: "paused",
                ecommerceSnapshot: { fallback: { reason: "reference_source_unavailable" }, referenceCheckpoint: { state: "needs_review", analysisStage: { state: "completed" }, sourceReadFailure: { kind: "source_read", status: 503 } } },
            });
            expect(paused.ecommerceSnapshot?.referenceCheckpoint?.analysis).toEqual(accepted.ecommerceSnapshot?.referenceCheckpoint?.analysis);
            expect(paused.ecommerceSnapshot?.referenceCheckpoint?.route).toEqual(accepted.ecommerceSnapshot?.referenceCheckpoint?.route);
            expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references", "plan_ecommerce_edit"]);
            unavailableOriginalPath = undefined;
            installModelReplies(analysis, "product_to_scene");
            const review = await readReview(paused, "retry_source");
            const recovery: CreativeReferenceRecovery = { reviewId: review.reviewId, action: "retry_source" };
            return { run, paused, recovery, prepareJobs: [prepared], prepareStatuses: ["success"], sources: [{ assetId: product.asset.id, sha256: product.sourceSha256 }], baseline: product };
        }

        function assertPreservedVisual(before: AgentRun, consumed: AgentRun, planned: AgentRun) {
            const checkpoint = before.ecommerceSnapshot?.referenceCheckpoint;
            assert(checkpoint?.analysis && checkpoint.route);
            expect(consumed.ecommerceSnapshot?.referenceCheckpoint).toMatchObject({ analysis: checkpoint.analysis, analysisStage: checkpoint.analysisStage, route: checkpoint.route });
            expect(planned.ecommerceSnapshot?.referenceCheckpoint).toMatchObject({ analysis: checkpoint.analysis, analysisStage: checkpoint.analysisStage, route: checkpoint.route });
        }

        function assertConfirmedCheckpoint(before: AgentRun, consumed: AgentRun, planned: AgentRun) {
            assertPreservedVisual(before, consumed, planned);
            expect(consumed.ecommerceSnapshot?.referenceCheckpoint?.confirmedBindings).toEqual([
                { assetId: before.referencedAssetIds[0], alias: "图片1", purposes: ["product_identity"] },
                { assetId: before.referencedAssetIds[1], alias: "图片2", purposes: ["edit_target"] },
            ]);
            expect(planned.ecommerceSnapshot?.referenceDecision).toMatchObject({ state: "resolved", editTargetId: before.referencedAssetIds[1], productAnchorId: before.referencedAssetIds[0] });
        }

        function assertRetriedAnalysisCheckpoint(before: AgentRun, consumed: AgentRun, planned: AgentRun) {
            const previous = before.ecommerceSnapshot?.referenceCheckpoint;
            const next = consumed.ecommerceSnapshot?.referenceCheckpoint;
            assert(previous?.failure && next);
            expect(next.analysis).toBeUndefined();
            expect(next.route).toBeUndefined();
            expect(next.failure).toBeUndefined();
            expect(next.analysisStage.state).toBe("created");
            expect(next.analysisStage.requestId).not.toBe(previous.analysisStage.requestId);
            expect(next.history).toMatchObject([{ requestId: previous.analysisStage.requestId, failure: previous.failure }]);
            expect(next.history).toHaveLength(1);
            expect(planned.ecommerceSnapshot?.referenceCheckpoint).toMatchObject({ analysisStage: { requestId: next.analysisStage.requestId, state: "completed" }, analysis: { analysisVersion: "ecommerce-visual-analysis.v4" }, history: next.history });
        }

        function assertRetriedSourceCheckpoint(before: AgentRun, consumed: AgentRun, planned: AgentRun) {
            assertPreservedVisual(before, consumed, planned);
            expect(consumed.ecommerceSnapshot?.referenceCheckpoint?.sourceReadFailure).toEqual(before.ecommerceSnapshot?.referenceCheckpoint?.sourceReadFailure);
            expect(planned.ecommerceSnapshot?.referenceCheckpoint?.sourceReadFailure).toBeUndefined();
            expect(planned.ecommerceSnapshot?.referenceCheckpoint?.sourceReadHistory).toEqual(before.ecommerceSnapshot?.referenceCheckpoint?.sourceReadHistory);
        }

        it.each([
            {
                action: "confirm_purposes",
                arrange: arrangeConfirmPurposes,
                beforeTools: ["analyze_ecommerce_references"],
                afterTools: ["analyze_ecommerce_references", "plan_ecommerce_edit"],
                operation: "local_edit",
                parentTaskId: "ecommerce-local-edit",
                check: assertConfirmedCheckpoint,
            },
            {
                action: "retry_analysis",
                arrange: arrangeRetryAnalysis,
                beforeTools: ["analyze_ecommerce_references"],
                afterTools: ["analyze_ecommerce_references", "analyze_ecommerce_references", "plan_ecommerce_edit"],
                operation: "product_to_scene",
                parentTaskId: "ecommerce-product-scene",
                check: assertRetriedAnalysisCheckpoint,
            },
            {
                action: "retry_source",
                arrange: arrangeRetrySource,
                beforeTools: ["analyze_ecommerce_references", "plan_ecommerce_edit"],
                afterTools: ["analyze_ecommerce_references", "plan_ecommerce_edit", "plan_ecommerce_edit"],
                operation: "product_to_scene",
                parentTaskId: "ecommerce-product-scene",
                check: assertRetriedSourceCheckpoint,
            },
        ])(
            "accepts $action with only its real completed prepare children and continues the same public turn",
            async ({ action, arrange, beforeTools, afterTools, operation, check }) => {
                const fixture = await arrange();
                const before = fixture.paused;
                const checkpoint = before.ecommerceSnapshot?.referenceCheckpoint;
                assert(checkpoint && before.ecommerceSnapshot?.processing);
                expect(checkpoint.assets.map((item) => ({ assetId: item.asset.id, sha256: item.contentSha256 }))).toEqual(fixture.sources);
                const prepared = await prepareRecords(fixture.run.id);
                expect(prepared).toHaveLength(fixture.prepareJobs.length);
                expect(prepared.map((record) => record.id)).toEqual(expect.arrayContaining(fixture.prepareJobs));
                expect(prepared.map((record) => record.status)).toEqual(fixture.prepareStatuses);
                expect(before.ecommerceSnapshot.processing.prepareReferences.map((reference) => reference.jobId)).toEqual(fixture.prepareJobs);
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(beforeTools);
                expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
                expect((await tasks.listStoredGenerationTaskRecordsByRunIds([fixture.run.id], [userId])).filter((record) => record.type === "image")).toHaveLength(0);
                await assertOriginalMessages(fixture.run);
                const response = await referenceResume(before, fixture.recovery);
                const body: RunReply = await response.json();
                const diagnostic = JSON.stringify({ action, response: { status: response.status, body }, reviewId: checkpoint.reviewId, prepareJobs: fixture.prepareJobs, modelTools: boundary.model.mock.calls.map(([request]) => request.tool.name) });
                expect(response.status, "The real review and completed prepares must reach resume acceptance: " + diagnostic).toBe(200);
                expect(body.code, diagnostic).toBe(0);
                assert(body.data);
                expect(body.data.run).toMatchObject({ id: fixture.run.id, conversationId: fixture.run.conversationId, inputMessageId: fixture.run.inputMessageId, assistantMessageId: fixture.run.assistantMessageId });
                const consumed = await runs.getAgentRun(fixture.run.id);
                assert(consumed?.ecommerceSnapshot?.referenceCheckpoint);
                expect(consumed).toMatchObject({ id: fixture.run.id, status: "planning", tasks: [], inputMessageId: fixture.run.inputMessageId, assistantMessageId: fixture.run.assistantMessageId });
                expect(consumed.ecommerceSnapshot.referenceCheckpoint).toMatchObject({ state: "consumed", inputId: checkpoint.inputId, assets: checkpoint.assets, consumption: { action, actorId: userId, acceptedAt: expect.any(Number) } });
                expect(consumed.ecommerceSnapshot.referenceCheckpoint.decisionId).not.toBe(checkpoint.decisionId);
                expect(consumed.ecommerceSnapshot.processing).toEqual(before.ecommerceSnapshot.processing);
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(beforeTools);
                const planned = await claimAndExecute(fixture.run.id, "reference-recovered-parent");
                expect(planned).toMatchObject({
                    id: fixture.run.id,
                    conversationId: fixture.run.conversationId,
                    inputMessageId: fixture.run.inputMessageId,
                    assistantMessageId: fixture.run.assistantMessageId,
                    ecommerceSnapshot: { plan: { planVersion: "ecommerce-edit.v7", strategy: "full_image", operation }, compilerVersion: "ecommerce-openai-image-2.5.v5" },
                });
                expect(planned.ecommerceSnapshot?.referenceCheckpoint?.assets).toEqual(checkpoint.assets);
                expect(planned.ecommerceSnapshot?.processing?.prepareReferences).toEqual(before.ecommerceSnapshot.processing.prepareReferences);
                expect(await prepareRecords(fixture.run.id)).toEqual(prepared);
                expect(planned.ecommerceSnapshot?.processing?.protection).toBeUndefined();
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(afterTools);
                expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
                check(before, consumed, planned);
                await assertOriginalMessages(fixture.run);
                const publicRun = await readPublicRun(planned);
                expect(publicRun.ecommerceReferenceReview).toBeNull();
            },
            30_000,
        );

        it("keeps the same review unconsumed when a real persistent media child exists beside completed prepares", async () => {
            const created: { image?: Awaited<ReturnType<typeof imageTasks.createImageTask>> } = {};
            const fixture = await arrangeConfirmPurposes(async (run) => {
                expect(run.ecommerceSnapshot).toBeUndefined();
                created.image = await imageTasks.createImageTask({
                    userId,
                    username: "fixture-reference-recovery",
                    displayName: "Reference recovery media barrier",
                    source: "image-workbench",
                    surface: "chat",
                    conversationId: run.conversationId,
                    runId: run.id,
                    parentTaskId: "existing-media-child",
                    kind: "generation",
                    prompt: "Existing media creation owns the submission boundary",
                    references: [],
                    config: { baseUrl: "https://provider.fixture.invalid", apiKey: "fixture-local-key", apiFormat: "openai", model: "gpt-image-2.5-flare" },
                });
            });
            const image = created.image;
            assert(image);
            const media = await tasks.getStoredGenerationTaskRecord("image", image.id);
            expect(media).toMatchObject({ id: image.id, userId, runId: fixture.run.id, conversationId: fixture.run.conversationId, type: "image", status: "pending" });
            const before = await runs.getAgentRun(fixture.run.id);
            assert(before);
            const prepared = await prepareRecords(fixture.run.id);
            expect(prepared.map((record) => record.status)).toEqual(["success", "success"]);
            const response = await referenceResume(before, fixture.recovery);
            expect(response.status).toBe(409);
            const body: RunReply = await response.json();
            expect(body).toMatchObject({ code: 409, data: null });
            expect(await runs.getAgentRun(fixture.run.id)).toEqual(before);
            expect(await tasks.getStoredGenerationTaskRecord("image", image.id)).toEqual(media);
            expect(await prepareRecords(fixture.run.id)).toEqual(prepared);
            expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references"]);
            expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
            await assertOriginalMessages(fixture.run);
        }, 30_000);

        type RecoveryFixture = Awaited<ReturnType<typeof arrangeConfirmPurposes>>;

        async function alterPrepare(fixture: RecoveryFixture, change: (record: StoredGenerationTaskRecord) => StoredGenerationTaskRecord | null) {
            const jobId = fixture.prepareJobs[0];
            const original = await tasks.getStoredGenerationTaskRecord("image_processing", jobId);
            assert(original);
            expect(original).toMatchObject({ status: "success", executionPhase: "completed", userId, runId: fixture.run.id });
            const changed = change(original);
            if (provider === "postgres") {
                const result = changed
                    ? await database.postgresQuery(
                          "UPDATE generation_tasks SET user_id = $2, run_id = $3, status = $4, payload = $5::jsonb, result_payload = $6::jsonb, execution_phase = $7 WHERE id = $1 AND task_type = 'image_processing' AND user_id = $8",
                          [jobId, changed.userId, changed.runId, changed.status, JSON.stringify(changed.payload), changed.resultPayload ? JSON.stringify(changed.resultPayload) : null, changed.executionPhase, original.userId],
                      )
                    : await database.postgresQuery("DELETE FROM generation_tasks WHERE id = $1 AND task_type = 'image_processing' AND user_id = $2", [jobId, original.userId]);
                expect(result.rowCount).toBe(1);
            } else {
                await tasks.withGenerationTaskFileMutation(async (records) => ({ tasks: changed ? records.map((record) => (record.id === jobId ? changed : record)) : records.filter((record) => record.id !== jobId), result: undefined }));
            }
        }

        it.each([
            { reason: "active prepare", alter: (fixture: RecoveryFixture) => alterPrepare(fixture, (record) => ({ ...record, status: "running", executionPhase: "polling" })) },
            { reason: "build operation", alter: (fixture: RecoveryFixture) => alterPrepare(fixture, (record) => ({ ...record, payload: { ...record.payload, operation: "build_protection" } })) },
            { reason: "input digest", alter: (fixture: RecoveryFixture) => alterPrepare(fixture, (record) => ({ ...record, payload: { ...record.payload, inputDigest: "b".repeat(64) } })) },
            {
                reason: "input asset",
                alter: (fixture: RecoveryFixture) =>
                    alterPrepare(fixture, (record) => {
                        const payload = record.payload as ImageProcessingPayload;
                        return { ...record, payload: { ...payload, inputs: [{ ...payload.inputs[0], assetId: fixture.sources[1].assetId }] } };
                    }),
            },
            {
                reason: "source hash",
                alter: (fixture: RecoveryFixture) =>
                    alterPrepare(fixture, (record) => {
                        const payload = record.payload as ImageProcessingPayload;
                        return { ...record, payload: { ...payload, inputs: [{ ...payload.inputs[0], expectedSha256: "b".repeat(64) }] } };
                    }),
            },
            { reason: "execution identity", alter: (fixture: RecoveryFixture) => alterPrepare(fixture, (record) => ({ ...record, payload: { ...record.payload, executionId: "different-completed-execution" } })) },
            { reason: "result digest", alter: (fixture: RecoveryFixture) => alterPrepare(fixture, (record) => ({ ...record, resultPayload: { ...record.resultPayload, manifestDigest: "b".repeat(64) } })) },
            { reason: "wrong owner", alter: (fixture: RecoveryFixture) => alterPrepare(fixture, (record) => ({ ...record, userId: otherUserId })) },
            { reason: "missing row", alter: (fixture: RecoveryFixture) => alterPrepare(fixture, () => null) },
            {
                reason: "wrong Run",
                alter: async (fixture: RecoveryFixture) => {
                    const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
                    const { run } = await runs.createAgentRun(userId, {
                        clientRequestId: "reference-recovery-other-run",
                        conversationId: conversation.id,
                        surface: "chat",
                        prompt: "An unrelated original turn",
                        assetIds: [],
                        skillIds: [],
                        modelIds: [],
                        preferences: { mode: "image" },
                    });
                    await alterPrepare(fixture, (record) => ({ ...record, runId: run.id }));
                },
            },
            {
                reason: "checkpoint job",
                alter: async (fixture: RecoveryFixture) => {
                    const snapshot = fixture.paused.ecommerceSnapshot;
                    assert(snapshot?.processing);
                    const [first, second] = snapshot.processing.prepareReferences;
                    await runs.updateAgentRunById(fixture.run.id, { ecommerceSnapshot: { ...snapshot, processing: { ...snapshot.processing, prepareReferences: [{ ...first, jobId: "different-real-prepare-binding" }, second] } } });
                },
            },
            {
                reason: "checkpoint manifest",
                alter: async (fixture: RecoveryFixture) => {
                    const snapshot = fixture.paused.ecommerceSnapshot;
                    assert(snapshot?.processing);
                    const [first, second] = snapshot.processing.prepareReferences;
                    assert(first.manifest && second.manifest);
                    await runs.updateAgentRunById(fixture.run.id, { ecommerceSnapshot: { ...snapshot, processing: { ...snapshot.processing, prepareReferences: [{ ...first, manifest: second.manifest }, second] } } });
                },
            },
            {
                reason: "duplicate checkpoint binding",
                alter: async (fixture: RecoveryFixture) => {
                    const snapshot = fixture.paused.ecommerceSnapshot;
                    assert(snapshot?.processing);
                    const first = snapshot.processing.prepareReferences[0];
                    await runs.updateAgentRunById(fixture.run.id, { ecommerceSnapshot: { ...snapshot, processing: { ...snapshot.processing, prepareReferences: [first, first] } } });
                },
            },
        ])(
            "keeps a real review unconsumed after $reason drift in its completed native prepare evidence",
            async ({ alter }) => {
                const fixture = await arrangeConfirmPurposes();
                await alter(fixture);
                const before = await runs.getAgentRun(fixture.run.id);
                assert(before);
                const records = await Promise.all(fixture.prepareJobs.map((jobId) => tasks.getStoredGenerationTaskRecord("image_processing", jobId)));
                const messages = await runtime.listCreativeMessages(fixture.run.conversationId);
                const response = await referenceResume(before, fixture.recovery);
                expect(response.status).toBe(409);
                const body: RunReply = await response.json();
                expect(body).toMatchObject({ code: 409, data: null });
                expect(await runs.getAgentRun(fixture.run.id)).toEqual(before);
                expect(await Promise.all(fixture.prepareJobs.map((jobId) => tasks.getStoredGenerationTaskRecord("image_processing", jobId)))).toEqual(records);
                expect(await runtime.listCreativeMessages(fixture.run.conversationId)).toEqual(messages);
                expect(boundary.model.mock.calls.map(([request]) => request.tool.name)).toEqual(["analyze_ecommerce_references"]);
                expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
                await assertOriginalMessages(fixture.run);
            },
            30_000,
        );
    });
