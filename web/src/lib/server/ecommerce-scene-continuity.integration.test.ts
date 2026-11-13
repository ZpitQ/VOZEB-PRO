import assert from "node:assert/strict";
import { prepareAdvisoryReview, recoverAdvisoryReview } from "./ecommerce-visual-review.test-fixture";
import { randomUUID } from "node:crypto";
import { completeClaimedImageProcessingFixture, completeImageTaskResultFixture } from "./image-processing.test-fixture";
import { routeEcommerceRole } from "./ecommerce-model-routing";
import { toSystemGenerationChannel } from "./generation-channel";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "./agent-run-store";
import type { LocalMediaRegistration } from "./local-media-registry";

const transport = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn(), poll: vi.fn(), settings: {} as never }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: async () => transport.settings, refundUserPoints: vi.fn() }));
vi.mock("./internal-origin", async (original) => ({ ...(await original<typeof import("./internal-origin")>()), fetchInternalApi: transport.request }));
vi.mock("./safe-outbound-fetch", () => ({
    fetchSafeOutbound: () => {
        throw new Error("fixture forbids external requests");
    },
}));
vi.mock("@/app/api/image-tasks/image-task-support", async (original) => ({ ...(await original<typeof import("@/app/api/image-tasks/image-task-support")>()), imageSubmissionFetch: transport.create, pollOpenAiImageTask: transport.poll }));

let createAgentRun: typeof import("./agent-run-store").createAgentRun;
let getAgentRun: typeof import("./agent-run-store").getAgentRun;
let selectCurrentSceneBaseline: typeof import("./agent-run-store").selectCurrentSceneBaseline;
let updateAgentRunById: typeof import("./agent-run-store").updateAgentRunById;
let executeAgentRun: typeof import("./agent-run-executor").executeAgentRun;
let createCreativeConversation: typeof import("./creative-runtime-store").createCreativeConversation;
let getCreativeAssetsByIds: typeof import("./creative-runtime-store").getCreativeAssetsByIds;
let listCreativeRunEvents: typeof import("./creative-runtime-store").listCreativeRunEvents;
let registerCreativeAssets: typeof import("./creative-runtime-store").registerCreativeAssets;
let createImageTask: typeof import("./image-task-store").createImageTask;
let getImageTask: typeof import("./image-task-store").getImageTask;
let ECOMMERCE_QUALITY_CHECK_KEYS: typeof import("./ecommerce-quality-check").ECOMMERCE_QUALITY_CHECK_KEYS;
let compileEcommerceImageRequest: typeof import("./ecommerce-image-compiler").compileEcommerceImageRequest;
let referenceUsesFromEcommerceDecision: typeof import("./ecommerce-reference-purpose").referenceUsesFromEcommerceDecision;
import { settings } from "./agent-run-executor.test-fixtures";

describe("scene continuity with real services and file persistence", () => {
    let directory: string;
    let bytes: Buffer;
    let styleBytes: Buffer;
    let submissions: Array<{ id: string; body: Record<string, unknown> }>;
    let interruptAfterSubmission: boolean;
    let adjustment: boolean;
    let scheduler: typeof import("./generation-task-scheduler");
    let tasks: typeof import("./generation-task-store");
    let mediaRegistry: typeof import("./local-media-registry");
    let mediaStorage: typeof import("./local-media-storage");
    let processing: typeof import("./image-processing-service");
    const structure = [{ objectId: "cabinet", feature: "drawers", count: 3, certainty: "confirmed", evidenceRegion: { x: 20, y: 25, width: 60, height: 45 } }] as const;
    const photography = {
        materials: [{ objectId: "cabinet", textureDirection: "vertical", textureScale: "fine", roughness: "matte", gloss: "low" }],
        lighting: { keyLight: "daylight", fillLight: "ambient fill", whiteBalance: "neutral", contactShadow: "existing contact shadow" },
        composition: { focalSubject: "cabinet", depth: "existing room depth", negativeSpace: "above cabinet" },
    };
    beforeEach(async () => {
        vi.resetModules();
        directory = await mkdtemp(join(tmpdir(), "vozeb-scene-continuity-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "off");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "8192");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "6144");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        submissions = [];
        interruptAfterSubmission = false;
        adjustment = false;
        bytes = await sharp(
            Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#ddd"/><rect x="20" y="25" width="60" height="45" fill="#987654"/><path d="M20 40H80M20 55H80M45 33H55M45 48H55M45 63H55" stroke="#432"/></svg>',
            ),
        )
            .png()
            .toBuffer();
        styleBytes = await sharp({ create: { width: 70, height: 120, channels: 3, background: "#abc" } })
            .png()
            .toBuffer();
        const configured = settings("image-model", "image-channel") as unknown as {
            ecommerceGenerationEnabled: boolean;
            systemChannels: Array<{ id: string; models: string[] }>;
            logicalModels: Array<{ id: string; bindings: Array<{ upstreamModel: string }> }>;
        };
        configured.ecommerceGenerationEnabled = true;
        configured.systemChannels.find((channel) => channel.id === "image-channel")!.models = ["gpt-image-2.5-flare"];
        configured.logicalModels.find((model) => model.id === "image-model")!.bindings[0].upstreamModel = "gpt-image-2.5-flare";
        transport.settings = configured as never;
        ({ createAgentRun, getAgentRun, selectCurrentSceneBaseline, updateAgentRunById } = await import("./agent-run-store"));
        ({ executeAgentRun } = await import("./agent-run-executor"));
        ({ createCreativeConversation, getCreativeAssetsByIds, listCreativeRunEvents, registerCreativeAssets } = await import("./creative-runtime-store"));
        ({ createImageTask, getImageTask } = await import("./image-task-store"));
        ({ ECOMMERCE_QUALITY_CHECK_KEYS } = await import("./ecommerce-quality-check"));
        ({ compileEcommerceImageRequest } = await import("./ecommerce-image-compiler"));
        ({ referenceUsesFromEcommerceDecision } = await import("./ecommerce-reference-purpose"));
        [scheduler, tasks, mediaRegistry, mediaStorage, processing] = await Promise.all([
            import("./generation-task-scheduler"),
            import("./generation-task-store"),
            import("./local-media-registry"),
            import("./local-media-storage"),
            import("./image-processing-service"),
        ]);
        transport.create.mockReset().mockImplementation(async (_config, _url, init) => {
            expect(init.method).toBe("POST");
            return Response.json({ id: "fixture-upstream-" + randomUUID(), status: "pending" });
        });
        transport.poll.mockReset().mockImplementation(async () => ({ dataUrl: "data:image/png;base64," + bytes.toString("base64") }));
        transport.request.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
            try {
                if (/\/api\/(reference-assets|generation-log-assets)\//.test(url)) {
                    const media = await readFixtureMedia(url);
                    return new Response(new Uint8Array(media.bytes), { headers: { "content-type": media.mimeType } });
                }
                if (init?.method === "POST" && url.endsWith("/api/image-tasks")) {
                    const body = JSON.parse(String(init.body));
                    const { prepareEcommerceImageTask, schedulePreparedImageTask } = await import("./ecommerce-image-task-orchestration");
                    const { reviewReason, ...prepared } = prepareEcommerceImageTask({ ...body, compatibleConfigs: [{ ...body.config, ...toSystemGenerationChannel(routeEcommerceRole(transport.settings, "image_generation")!) }] });
                    expect(reviewReason).toBe("");
                    const child = await createImageTask({
                        ...body,
                        ...body.context,
                        userId: "scene-user",
                        username: "scene-fixture",
                        displayName: "Scene Fixture",
                        ...prepared,
                    });
                    const id = child.id;
                    submissions.push({ id, body });
                    expect(await schedulePreparedImageTask(child, reviewReason)).toEqual({ needsReview: false });
                    return Response.json({ task: { id } });
                }
                if (url.includes("/api/image-tasks/")) {
                    if (interruptAfterSubmission) {
                        interruptAfterSubmission = false;
                        return new Response("temporarily unavailable", { status: 503 });
                    }
                    const child = await completeImageTaskResultFixture(url.split("/").at(-1)!, { origin: "http://fixture.local", cookie: "session=fixture", directory });
                    const parent = child.runId ? await getAgentRun(child.runId) : null;
                    if (parent?.ecommerceSnapshot?.plan?.planVersion === "ecommerce-edit.v7") {
                        expect(child.nativeResults?.slots).toMatchObject([{ status: "stored" }]);
                        assert.ok(child.resultProcessing);
                        expect(await tasks.getStoredGenerationTaskRecord("image_processing", child.resultProcessing.jobId)).toMatchObject({
                            status: "success",
                            executionPhase: "completed",
                            parentTaskId: child.id,
                            runId: child.runId,
                            payload: { operation: "process_result" },
                        });
                    }
                    return Response.json({ task: child });
                }
                const body = JSON.parse(String(init?.body));
                const nativeTool = body.tools?.[0]?.name || body.tools?.[0]?.function?.name;
                const messages = body.messages || body.input;
                const content = messages.find((message: { role: string }) => message.role === "user").content;
                const payloads = (typeof content === "string" ? [content] : content.filter((item: { text?: string }) => item.text?.startsWith("{")).map((item: { text: string }) => item.text)).map((text: string) => JSON.parse(text));
                const payload = payloads.find((value: { assets?: unknown[]; sources?: unknown; resultIds?: string[] }) => Array.isArray(value.assets) || Boolean(value.sources) || Array.isArray(value.resultIds));
                if (!payload) throw new Error("Fixture request is missing its stage payload");
                const tool = nativeTool || (Array.isArray(payload.assets) ? "analyze_ecommerce_references" : payload.sources ? "plan_ecommerce_edit" : "check_ecommerce_results");
                let argumentsValue;
                if (tool === "analyze_ecommerce_references")
                    argumentsValue = {
                        analysisVersion: "ecommerce-visual-analysis.v4",
                        purposeSuggestions: payload.assets.filter((asset: { id: string }) => asset.id === "style-scene-upload").map((asset: { id: string }) => ({ assetId: asset.id, purposes: ["style", "lighting"], confidence: "high" })),
                        references: payload.assets.map((asset: { id: string }) => ({
                            assetId: asset.id,
                            contentType: "interior_scene",
                            confidence: "high",
                            visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                            productFacts: null,
                            sceneFacts: { space: "living room", composition: "eye level", lighting: "daylight" },
                            productCore: null,
                            fusionHalo: null,
                            editableTargets: [{ id: "lighting", kind: "lighting", label: "lighting", region: { x: 0, y: 0, width: 1, height: 1 } }],
                            visibleStructure: asset.id === "style-scene-upload" ? [] : structure,
                            photographyFacts: photography,
                            cues:
                                asset.id === "style-scene-upload"
                                    ? [
                                          { id: "scene-light", facet: "lighting", confidence: "high", description: "soft window daylight" },
                                          { id: "scene-style", facet: "style", confidence: "high", description: "minimal interior styling" },
                                      ]
                                    : [],
                        })),
                    };
                else if (tool === "plan_ecommerce_edit") {
                    const local = payload.userRequest.includes("花瓶");
                    argumentsValue = {
                        planVersion: "ecommerce-edit.v7",
                        operation: "scene_edit",
                        source: { productAnchorId: null, currentSceneBaselineId: payload.sources.currentSceneBaselineId, sceneReferenceIds: payload.sources.sceneReferenceIds },
                        referenceUses: referenceUsesFromEcommerceDecision({ decision: payload.referenceDecision, sourceOrder: [payload.sources.currentSceneBaselineId, ...payload.sources.sceneReferenceIds] }),
                        baseline: { productFacts: null, sceneFacts: payload.visualAnalysis.references.find((reference: { assetId: string }) => reference.assetId === payload.sources.currentSceneBaselineId).sceneFacts },
                        delta: {
                            requestedChanges: [payload.userRequest, ...payload.visualAnalysis.references.flatMap((reference: { cues: Array<{ description: string }> }) => reference.cues.map((cue) => cue.description))],
                            targetObjects: [local ? "vase" : "lighting"],
                            targetRegions: [local ? "cabinet-top" : "whole-scene"],
                        },
                        preserve: { productCore: [], sceneElements: ["layout", "camera"] },
                        protection: { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: !local },
                        visibleStructure: structure,
                        photography,
                        strategy: "full_image",
                        modelRoles: payload.requiredModelRoles,
                        continuity: payload.continuity,
                        validation: { requiredChecks: ["requested_edit", "scene_preservation", "composition_lighting"] },
                    };
                } else if (tool === "check_ecommerce_results") {
                    const independent = Object.hasOwn(payload.plan, "structureRegionHints");
                    // Deterministic observations are independent of the planner's counts.
                    const observation = {
                        readable: true,
                        logo: "absent",
                        packagingText: "absent",
                        visibleStructure: [{ objectId: "cabinet", feature: "drawers", count: 3, certainty: "confirmed", evidenceRegion: { x: 20, y: 25, width: 60, height: 45 } }],
                    };
                    argumentsValue = {
                        ...(independent ? { baselineObservation: observation } : {}),
                        results: payload.resultIds.map((resultId: string) => ({
                            resultId,
                            ...(independent ? { observation } : {}),
                            checks: (independent ? ECOMMERCE_QUALITY_CHECK_KEYS : ECOMMERCE_QUALITY_CHECK_KEYS.slice(0, 8)).map((key, index) => ({
                                key,
                                status: index === 4 || index === 5 ? "not_applicable" : adjustment && key === "scene_intent" ? "failed" : "passed",
                                reason: adjustment && key === "scene_intent" ? "vase is too large" : "visible scene evidence",
                            })),
                        })),
                    };
                } else throw new Error(`unexpected fixture tool ${tool}`);
                const argumentsText = JSON.stringify(argumentsValue);
                return body.messages
                    ? Response.json({
                          choices: [{ message: { role: "assistant", content: nativeTool ? null : argumentsText, ...(nativeTool ? { tool_calls: [{ id: `fixture-${tool}`, type: "function", function: { name: tool, arguments: argumentsText } }] } : {}) } }],
                      })
                    : Response.json(nativeTool ? { output: [{ type: "function_call", name: tool, arguments: argumentsText }] } : { output_text: argumentsText });
            } catch (error) {
                console.error("unexpected scene fixture request failure", error);
                throw error;
            }
        });
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    async function registerFixtureMedia(scope: "reference" | "generation", storageKey: string, source: Buffer, context: Pick<LocalMediaRegistration, "conversationId" | "runId" | "taskId">) {
        const filePath = join(scope === "reference" ? mediaStorage.REFERENCE_MEDIA_ROOT : mediaStorage.GENERATION_MEDIA_ROOT, storageKey);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, source, { flag: "wx" });
        await mediaRegistry.registerLocalMediaAsset({
            storageKey,
            scope,
            storageClass: "permanent",
            type: "image",
            ownerUserId: "scene-user",
            originalName: storageKey,
            source: "fixture-scene-continuity",
            mimeType: "image/png",
            bytes: source.length,
            ...context,
        });
    }

    async function readFixtureMedia(url: string) {
        const pathname = new URL(url, "http://fixture.local").pathname;
        const scope = pathname.startsWith("/api/reference-assets/") ? "reference" : "generation";
        const prefix = scope === "reference" ? "/api/reference-assets/" : "/api/generation-log-assets/";
        const storageKey = pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
        const registration = await mediaRegistry.getLocalMediaRegistration(storageKey);
        assert(registration, "Continuity HTTP must read actual registered media");
        expect(registration).toMatchObject({ ownerUserId: "scene-user", scope, storageProvider: "local" });
        const source = await readFile(join(scope === "reference" ? mediaStorage.REFERENCE_MEDIA_ROOT : mediaStorage.GENERATION_MEDIA_ROOT, storageKey));
        expect(source.length).toBe(registration.bytes);
        return { bytes: source, mimeType: registration.mimeType };
    }

    async function registerSources(assets: Parameters<typeof registerCreativeAssets>[0]) {
        const registered = await Promise.all(
            assets.map(async (asset) => {
                assert(asset.serverUrl);
                const storageKey = asset.serverUrl.slice("/api/reference-assets/".length);
                const source = asset.id === "style-scene-upload" ? styleBytes : bytes;
                await registerFixtureMedia("reference", storageKey, source, { conversationId: asset.conversationId, runId: asset.sourceRunId, taskId: asset.sourceTaskId });
                expect((await readFixtureMedia(asset.serverUrl)).bytes).toEqual(source);
                return { ...asset, storageKey };
            }),
        );
        return registerCreativeAssets(registered);
    }

    async function claimAndExecute(runId: string) {
        const parent = await tasks.getStoredGenerationTaskRecord("agent", runId);
        assert(parent);
        expect(parent.workerId).toBeUndefined();
        expect(parent.leaseUntil).toBeUndefined();
        expect(parent.nextPollAt).toBeGreaterThan(0);
        const workerId = `scene-continuity-parent-${randomUUID()}`;
        expect(await scheduler.claimDueGenerationTasks({ workerId, taskIds: [runId], limit: 1 })).toMatchObject([{ id: runId, workerId }]);
        const current = await getAgentRun(runId);
        assert(current);
        await executeAgentRun(current, "http://fixture.local", "session=fixture");
        const saved = await getAgentRun(runId);
        assert(saved);
        return saved;
    }

    async function completePrepare(jobId: string) {
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const workerId = "scene-continuity-native-worker";
        const claimed = await processing.claimImageProcessingTasks({ workerId, profileVersion: imageProcessingResourceConfig(process.env).profileVersion, availableMemoryBytes: 1024 * 1024 * 1024, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const task = claimed.tasks[0];
        expect(task.id).toBe(jobId);
        assert(task.payload.operation === "prepare_reference");
        const identity = { workerId, executionId: task.executionId };
        const { manifest: completedManifest, receipt } = await completeClaimedImageProcessingFixture(task, workerId, directory);
        expect(receipt.parentRescheduled).toBe(true);
        expect(completedManifest.artifacts).toHaveLength(1);
        expect(completedManifest.artifacts[0].kind).toBe("analysis");
        const saved = await tasks.getStoredGenerationTaskRecord("image_processing", jobId);
        assert(saved);
        expect(saved).toMatchObject({
            status: "success",
            executionPhase: "completed",
            payload: { executionId: identity.executionId },
            resultPayload: { executionId: identity.executionId, manifest: completedManifest, manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
        });
        expect(saved.workerId).toBeUndefined();
        expect(saved.leaseUntil).toBeUndefined();
    }

    async function executeWithPreparedReferences(run: AgentRun) {
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        let current = await claimAndExecute(run.id);
        const completed = new Set<string>();
        while (current.ecommerceSnapshot?.processing?.waitingFor) {
            const waiting = current.ecommerceSnapshot.processing.waitingFor;
            expect(completed.has(waiting.jobId)).toBe(false);
            completed.add(waiting.jobId);
            const stage = await tasks.getStoredGenerationTaskRecord("image_processing", waiting.jobId);
            assert(stage);
            expect(stage).toMatchObject({ userId: "scene-user", runId: run.id, parentTaskId: run.id, status: "pending", executionPhase: "created", payload: { operation: "prepare_reference", inputDigest: waiting.inputDigest } });
            expect(current.executionId).toBeUndefined();
            const released = await tasks.getStoredGenerationTaskRecord("agent", run.id);
            assert(released);
            expect(released.workerId).toBeUndefined();
            expect(released.leaseUntil).toBeUndefined();
            expect(released.nextPollAt).toBeUndefined();
            await completePrepare(waiting.jobId);
            current = await claimAndExecute(run.id);
        }
        expect(current.ecommerceSnapshot?.plan).toMatchObject({ planVersion: "ecommerce-edit.v7", strategy: "full_image" });
        expect(current.tasks[0].ecommerceExecution).toMatchObject({ compilerVersion: "ecommerce-openai-image-2.5.v5", state: "ready" });
        expect(current.tasks[0].ecommerceExecution).not.toHaveProperty("mask");
        expect(current.tasks[0]).not.toHaveProperty("sceneProtection");
        expect(current.ecommerceSnapshot?.processing?.protection).toBeUndefined();
        return current;
    }

    async function completeLinkedResults(run: AgentRun) {
        for (const task of run.tasks) {
            for (const imageId of task.taskIds || []) {
                await completeImageTaskResultFixture(imageId, { origin: "http://fixture.local", cookie: "session=fixture", directory });
            }
        }
        // Consume the completed CPU fact in a separate parent execution.
        const current = await getAgentRun(run.id);
        assert.ok(current);
        await executeAgentRun(current, "http://fixture.local", "session=fixture");
    }

    it("preserves an explicit historical scene while applying its authorized new style reference", async () => {
        const conversation = await createCreativeConversation("scene-user", { surface: "chat" });
        const [root, style] = await registerSources([
            { id: "old-root", userId: "scene-user", conversationId: conversation.id, sourceRunId: "upload", sourceTaskId: "old-upload", ordinal: 0, type: "image", title: "old scene", serverUrl: "/api/reference-assets/old-root.png", metadata: {} },
            {
                id: "style-scene-upload",
                userId: "scene-user",
                conversationId: conversation.id,
                sourceRunId: "upload",
                sourceTaskId: "style-upload",
                ordinal: 1,
                type: "image",
                title: "new lighting style",
                serverUrl: "/api/reference-assets/style-scene-upload.png",
                metadata: {},
            },
        ]);
        const first = (await createAgentRun("scene-user", { clientRequestId: "old-scene", conversationId: conversation.id, surface: "chat", prompt: "改成午后阳光", assetIds: [root.id], skillIds: [], modelIds: [] })).run;
        await completeLinkedResults(await executeWithPreparedReferences(first));
        const completedFirst = (await getAgentRun(first.id))!;
        expect(completedFirst.status, completedFirst.ecommerceSnapshot?.qualityCheck?.internalReason).toBe("completed");
        expect(completedFirst).toMatchObject({ status: "completed", ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "passed" } } });
        expect(completedFirst.ecommerceSnapshot?.qualityCheck).toBeUndefined();
        const oldResultId = completedFirst.assetIds[0];
        const originalSnapshot = JSON.stringify(completedFirst.ecommerceSnapshot);
        const branch = (
            await createAgentRun("scene-user", {
                clientRequestId: "style-branch",
                conversationId: conversation.id,
                surface: "chat",
                prompt: "保持旧图构图，参考图片2的灯光和风格，修改图片1整体光线为午后阳光",
                assetIds: [oldResultId, style.id],
                skillIds: [],
                modelIds: [],
            })
        ).run;

        await completeLinkedResults(await executeWithPreparedReferences(branch));

        const completedBranch = (await getAgentRun(branch.id))!;
        expect(completedBranch).toMatchObject({ status: "completed", tasks: [{ status: "completed", attempts: 1, taskIds: [submissions[1].id] }], ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "passed" } } });
        expect(completedBranch.ecommerceSnapshot).not.toHaveProperty("fallback");
        expect(submissions).toHaveLength(2);
        expect(completedBranch.ecommerceSnapshot).toMatchObject({
            input: { assetIds: [oldResultId, style.id] },
            continuity: { sceneRootAssetId: root.id, parentResultId: oldResultId },
            visualAnalysis: { analysisVersion: "ecommerce-visual-analysis.v4", references: [{ assetId: oldResultId }, { assetId: style.id }] },
            plan: {
                planVersion: "ecommerce-edit.v7",
                strategy: "full_image",
                operation: "scene_edit",
                source: { productAnchorId: null, currentSceneBaselineId: oldResultId, sceneReferenceIds: [style.id] },
                continuity: { parentResultId: oldResultId },
                canvas: { mode: "ratio", source: "baseline", size: { width: 100, height: 80 }, allowReframe: false },
            },
        });
        expect(completedBranch.ecommerceSnapshot!.referenceDecision).toMatchObject({
            state: "resolved",
            editTargetId: oldResultId,
            currentSceneBaselineId: oldResultId,
            bindings: [
                { assetId: oldResultId, alias: "图片1", purposes: ["edit_target"], source: "explicit" },
                { assetId: style.id, alias: "图片2", purposes: ["style", "lighting"], source: "explicit" },
            ],
        });
        expect(completedBranch.ecommerceSnapshot!.plan!.referenceUses).toEqual([
            { assetId: oldResultId, alias: "图片1", purposes: ["edit_target"], usedCueIds: [] },
            { assetId: style.id, alias: "图片2", purposes: ["style", "lighting"], usedCueIds: ["scene-style", "scene-light"] },
        ]);
        expect((submissions[1].body.references as Array<{ id: string }>).map((reference) => reference.id)).toEqual([oldResultId, style.id]);
        expect(submissions[1].body.ecommerceExecution).toMatchObject({
            compilerVersion: "ecommerce-openai-image-2.5.v5",
            referenceMapping: [
                { assetId: oldResultId, userAlias: "图片1", providerIndex: 0, purposes: ["edit_target"] },
                { assetId: style.id, userAlias: "图片2", providerIndex: 1, purposes: ["style", "lighting"] },
            ],
            prompt: expect.stringContaining("soft window daylight"),
        });
        const disk = JSON.parse(await readFile(join(directory, "generation-tasks.json"), "utf8"));
        expect(disk.find((task: { id: string }) => task.id === branch.id).payload.ecommerceSnapshot).toEqual(completedBranch.ecommerceSnapshot);
        await executeAgentRun(completedBranch, "http://fixture.local", "session=fixture");
        expect((await getAgentRun(branch.id))!.ecommerceSnapshot).toEqual(completedBranch.ecommerceSnapshot);
        for (const current of [completedFirst, completedBranch]) {
            expect(submissions.filter((submission) => current.tasks[0].taskIds!.includes(submission.id))).toHaveLength(1);
            expect((await listCreativeRunEvents(current.id)).filter((event) => event.type === "task.created")).toHaveLength(1);
        }
        expect(submissions).toHaveLength(2);
        expect(JSON.stringify((await getAgentRun(first.id))!.ecommerceSnapshot)).toBe(originalSnapshot);
    });

    it("persists two scene rounds, recovers the submitted child and branches from adjustment evidence", async () => {
        transport.settings = { ...(transport.settings as Record<string, unknown>), ecommerceVisualQualityCheckEnabled: true } as never;
        const conversation = await createCreativeConversation("scene-user", { surface: "chat" });
        const [root] = await registerSources([
            { id: "scene-root", userId: "scene-user", conversationId: conversation.id, sourceRunId: "upload", sourceTaskId: "scene-upload", ordinal: 0, type: "image", title: "scene", serverUrl: "/api/reference-assets/scene-root.png", metadata: {} },
        ]);
        const create = async (prompt: string, ids: string[] = []) => (await createAgentRun("scene-user", { clientRequestId: prompt, conversationId: conversation.id, surface: "chat", prompt, assetIds: ids, skillIds: [], modelIds: [] })).run;
        const first = await create("改成午后阳光", [root.id]);
        await completeLinkedResults(await executeWithPreparedReferences(first));
        await prepareAdvisoryReview(first.id, { origin: "http://fixture.local", cookie: "session=fixture", directory });
        await recoverAdvisoryReview(first.id);
        const completedFirst = (await getAgentRun(first.id))!;
        expect(completedFirst).toMatchObject({
            status: "completed",
            ecommerceSnapshot: {
                visualAnalysis: { analysisVersion: "ecommerce-visual-analysis.v4" },
                plan: { planVersion: "ecommerce-edit.v7", strategy: "full_image", photography: { materials: [{ objectId: "cabinet", textureDirection: expect.stringContaining("vertical") }], lighting: { keyLight: "daylight" } } },
                continuity: { sceneRootAssetId: root.id, parentResultId: null },
                qualityCheck: { version: "ecommerce-quality.v2", status: "passed" },
            },
        });
        const firstAsset = (await getCreativeAssetsByIds(completedFirst.assetIds, "scene-user"))[0];
        expect(firstAsset.metadata).toMatchObject({ ecommerceContinuity: { sceneRootAssetId: root.id } });
        const unchangedFirst = JSON.stringify(completedFirst.ecommerceSnapshot);
        const second = await create("再加一个花瓶");
        interruptAfterSubmission = true;
        await executeWithPreparedReferences(second);
        const waiting = (await getAgentRun(second.id))!;
        expect(waiting).toMatchObject({ status: "running", tasks: [{ taskIds: [submissions[1].id] }] });
        expect(submissions).toHaveLength(2);
        const disk = JSON.parse(await readFile(join(directory, "generation-tasks.json"), "utf8"));
        expect(disk.find((task: { id: string }) => task.id === second.id).payload.tasks[0].taskIds).toEqual([submissions[1].id]);
        adjustment = true;
        await completeLinkedResults(waiting);
        await prepareAdvisoryReview(second.id, { origin: "http://fixture.local", cookie: "session=fixture", directory });
        await recoverAdvisoryReview(second.id);
        const completedSecond = (await getAgentRun(second.id))!;
        expect(submissions).toHaveLength(2);
        expect(completedSecond).toMatchObject({
            status: "completed",
            ecommerceSnapshot: {
                continuity: { sceneRootAssetId: root.id, parentResultId: firstAsset.id },
                plan: { planVersion: "ecommerce-edit.v7", strategy: "full_image", delta: { targetObjects: ["vase"], targetRegions: ["cabinet-top"] } },
                qualityCheck: { version: "ecommerce-quality.v2", status: "needs_adjustment", sceneProtectionEvidence: [] },
            },
        });
        expect(submissions[1].body.references).toMatchObject([{ id: firstAsset.id }]);
        const secondAsset = (await getCreativeAssetsByIds(completedSecond.assetIds, "scene-user"))[0];
        expect(await selectCurrentSceneBaseline(conversation.id, undefined, "scene-user")).toMatchObject({ id: secondAsset.id });
        expect(secondAsset.metadata).toMatchObject({ ecommerceContinuity: { parentResultId: firstAsset.id } });
        expect(JSON.stringify(secondAsset.metadata)).not.toContain("vase is too large");
        const branch = await create("修改图片1，继续调整花瓶", [secondAsset.id]);
        adjustment = false;
        await completeLinkedResults(await executeWithPreparedReferences(branch));
        expect((await getAgentRun(branch.id))!.ecommerceSnapshot!.referenceDecision).toMatchObject({
            state: "resolved",
            editTargetId: secondAsset.id,
            currentSceneBaselineId: secondAsset.id,
            bindings: [{ assetId: secondAsset.id, alias: "图片1", purposes: ["edit_target"], source: "explicit" }],
        });
        await prepareAdvisoryReview(branch.id, { origin: "http://fixture.local", cookie: "session=fixture", directory });
        await recoverAdvisoryReview(branch.id);
        const completedBranch = (await getAgentRun(branch.id))!;
        expect(completedBranch.status).toBe("completed");
        expect(completedBranch.ecommerceSnapshot?.continuity).toMatchObject({
            sceneRootAssetId: root.id,
            parentResultId: secondAsset.id,
            parentQualityCheck: { status: "needs_adjustment", checks: expect.arrayContaining([expect.objectContaining({ reason: "vase is too large" })]) },
        });
        expect(JSON.stringify((await getAgentRun(first.id))!.ecommerceSnapshot)).toBe(unchangedFirst);
        expect(submissions.map((submission) => submission.id)).toEqual([completedFirst.tasks[0].taskIds![0], completedSecond.tasks[0].taskIds![0], completedBranch.tasks[0].taskIds![0]]);
        expect(new Set(submissions.map((submission) => submission.id)).size).toBe(3);
        for (const current of [completedFirst, completedSecond, completedBranch]) {
            expect(submissions.filter((submission) => current.tasks[0].taskIds!.includes(submission.id))).toHaveLength(1);
            const events = await listCreativeRunEvents(current.id);
            const stages = events.filter((event) => event.type === "ecommerce.progress").map((event) => (event.data as { stage: string }).stage);
            expect(stages).toEqual(expect.arrayContaining(["identifying_product", "planning_scene", "generating_image", "checking_result"]));
            expect(events.filter((event) => event.type === "task.created")).toHaveLength(1);
            expect((await getImageTask(current.tasks[0].taskIds![0]))?.ecommerceTrace).toMatchObject({ runId: current.id, imageTaskIds: current.tasks[0].taskIds });
        }
        expect(completedFirst.tasks[0].taskIds).not.toEqual(completedSecond.tasks[0].taskIds);
        expect(await selectCurrentSceneBaseline(conversation.id, secondAsset.id, "other-user")).toBeNull();
        expect(await selectCurrentSceneBaseline("other-conversation", secondAsset.id, "scene-user")).toBeNull();
    }, 30_000);

    it("recovers an already-started v1 child without upgrading its immutable plan or compiler", async () => {
        const conversation = await createCreativeConversation("scene-user", { surface: "chat" });
        const [root] = await registerSources([
            {
                id: "legacy-scene-root",
                userId: "scene-user",
                conversationId: conversation.id,
                sourceRunId: "upload",
                sourceTaskId: "legacy-scene-upload",
                ordinal: 0,
                type: "image",
                title: "scene",
                serverUrl: "/api/reference-assets/legacy-scene-root.png",
                metadata: {},
            },
        ]);
        const first = (await createAgentRun("scene-user", { clientRequestId: "current-seed", conversationId: conversation.id, surface: "chat", prompt: "改成午后阳光", assetIds: [root.id], skillIds: [], modelIds: [] })).run;
        await completeLinkedResults(await executeWithPreparedReferences(first));
        const completedFirst = (await getAgentRun(first.id))!;
        expect(completedFirst.status).toBe("completed");
        const legacy = (await createAgentRun("scene-user", { clientRequestId: "started-v1-fixture", conversationId: conversation.id, surface: "chat", prompt: "恢复旧任务", assetIds: [], skillIds: [], modelIds: [] })).run;
        const legacySnapshot = structuredClone(completedFirst.ecommerceSnapshot!);
        legacySnapshot.runId = legacy.id;
        legacySnapshot.plan!.planVersion = "ecommerce-edit.v1";
        legacySnapshot.plan!.strategy = "integrated_scene";
        delete legacySnapshot.plan!.referenceUses;
        delete legacySnapshot.plan!.canvas;
        delete legacySnapshot.plan!.protection;
        delete legacySnapshot.plan!.visibleStructure;
        delete legacySnapshot.plan!.photography;
        delete legacySnapshot.continuity!.sceneRootAssetId;
        delete legacySnapshot.qualityCheck;
        delete legacySnapshot.qualityPolicy;
        delete legacySnapshot.technicalCheck;
        delete legacySnapshot.visualAnalysis;
        delete legacySnapshot.referenceCheckpoint;
        delete legacySnapshot.processing;
        const legacyTask = structuredClone(completedFirst.tasks[0]);
        legacyTask.status = "running";
        legacyTask.assetIds = [];
        legacyTask.ecommerceExecution = compileEcommerceImageRequest(legacySnapshot.plan!, {
            profileId: "gpt-image-2.5-flare",
            compilerFamily: "openai-image-2.5",
            supportsIndependentMask: true,
            modelSnapshot: legacyTask.ecommerceExecution!.modelSnapshot,
        });
        expect(legacyTask.ecommerceExecution).toMatchObject({ compilerVersion: "ecommerce-openai-image-2.5.v1", state: "ready" });
        expect(legacyTask.ecommerceExecution).not.toHaveProperty("mask");
        legacyTask.prompt = legacyTask.ecommerceExecution.prompt;
        const seed = (await getImageTask(submissions[0].id))!;
        const original = await createImageTask({
            userId: "scene-user",
            username: "scene-fixture",
            displayName: "Scene Fixture",
            kind: "edit",
            source: seed.source,
            config: seed.config,
            prompt: legacyTask.prompt,
            references: seed.references,
            ecommerceExecution: legacyTask.ecommerceExecution,
            runId: legacy.id,
            parentTaskId: legacy.id,
            conversationId: conversation.id,
            surface: legacy.surface,
            clientRequestId: `${legacy.clientRequestId}:${legacyTask.id}:1:1`,
        });
        legacyTask.taskId = original.id;
        legacyTask.taskIds = [original.id];
        legacyTask.childTasks = [{ id: original.id, status: "pending", attempt: 1 }];
        const frozenPlan = JSON.stringify(legacySnapshot.plan);
        const frozenExecution = JSON.stringify(legacyTask.ecommerceExecution);
        const savedLegacy = (await updateAgentRunById(legacy.id, { status: "running", tasks: [legacyTask], ecommerceSnapshot: legacySnapshot }, undefined, ["planning"]))!;
        const runtime = await import("./image-task-runtime");
        const { schedulePreparedImageTask } = await import("./ecommerce-image-task-orchestration");
        await schedulePreparedImageTask(original, "");
        const originalWorker = "scene-continuity-original-v1";
        const claim = (await scheduler.claimDueGenerationTasks({ workerId: originalWorker, taskIds: [original.id], limit: 1 }))[0];
        assert.ok(claim?.executionId);
        const claimed = (await getImageTask(original.id))!;
        expect(await runtime.createImageTaskUpstreamStep(claimed, "http://fixture.local", "http://fixture.local", "session=fixture")).toMatchObject({ state: "pending" });
        const submitted = (await getImageTask(original.id))!;
        assert.ok(submitted.upstream);
        expect(submitted).toMatchObject({ status: "running", runId: legacy.id, attempts: [{ attemptNo: 1, status: "running" }] });
        await scheduler.releaseGenerationTaskLease("image", original.id, originalWorker, { executionPhase: "submitted", upstreamTaskId: submitted.upstream.id, nextPollAt: Date.now() }, { executionId: claim.executionId });
        const createCount = transport.create.mock.calls.length;
        await completeLinkedResults(savedLegacy);
        const recoveredLegacy = (await getAgentRun(legacy.id))!;
        expect(recoveredLegacy.status).toBe("completed");
        expect(JSON.stringify(recoveredLegacy.ecommerceSnapshot!.plan)).toBe(frozenPlan);
        expect(JSON.stringify(recoveredLegacy.tasks[0].ecommerceExecution)).toBe(frozenExecution);
        expect(recoveredLegacy.ecommerceSnapshot!.qualityCheck).toMatchObject({ version: "ecommerce-quality.v1", status: "passed" });
        expect(recoveredLegacy.ecommerceSnapshot!.qualityCheck).not.toHaveProperty("observations");
        expect(recoveredLegacy.ecommerceSnapshot!.continuity).not.toHaveProperty("sceneRootAssetId");
        expect(submissions).toHaveLength(1);
        expect(transport.create).toHaveBeenCalledTimes(createCount);
        expect(await getImageTask(original.id)).toMatchObject({ status: "success", runId: legacy.id, upstream: submitted.upstream, attempts: [{ attemptNo: 1, status: "succeeded" }] });
        expect(recoveredLegacy.tasks[0].taskIds).toEqual([original.id]);
    });
});
