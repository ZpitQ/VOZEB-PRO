import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "./agent-run-store";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { ImageTask } from "./image-task-store";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { completeClaimedImageProcessingFixture } from "./image-processing.test-fixture";

describe("full-image generation inputs through the File CPU queue", () => {
    let directory: string;
    let runtime: typeof import("./creative-runtime-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    let service: typeof import("./image-processing-service");

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-full-image-input-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
        vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
        vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
        [runtime, tasks, scheduler, service] = await Promise.all([import("./creative-runtime-store"), import("./generation-task-store"), import("./generation-task-scheduler"), import("./image-processing-service")]);
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated full-image input fixture requires local media storage");
    }, 30_000);

    afterAll(async () => {
        try {
            if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    async function claimParent(runId: string) {
        const claimed = await scheduler.claimDueGenerationTasks({ workerId: "fixture-full-image-parent", taskIds: [runId], limit: 1 });
        expect(claimed).toHaveLength(1);
        const run = await tasks.mutateStoredGenerationTask<AgentRun>("agent", runId, 60_000, (current) => ({ ...current, executionId: randomUUID() }));
        assert(run?.executionId);
        return run;
    }

    async function completeCpu() {
        const { imageProcessingResourceConfig } = await import("../image-processing/resource-config");
        const { profileVersion, budgetBytes } = imageProcessingResourceConfig(process.env);
        const workerId = "fixture-full-image-cpu";
        const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion, availableMemoryBytes: budgetBytes, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const child = claimed.tasks[0];
        await completeClaimedImageProcessingFixture(child, workerId, directory);
        return child;
    }

    it("submits full-image primary and auxiliary generation copies without masks and rejects a changed original", async () => {
        const userId = `fixture-full-image-${randomUUID()}`;
        const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
        const source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#8a6243" } })
            .png()
            .toBuffer();
        const { writeReferenceImageDataUrl } = await import("./reference-asset-store");
        const stored = await writeReferenceImageDataUrl(`data:image/png;base64,${source.toString("base64")}`, { ownerUserId: userId, conversationId: conversation.id, source: "fixture-full-image" });
        const [asset] = await runtime.registerCreativeAssets([
            { id: `reference-${randomUUID()}`, userId, conversationId: conversation.id, ordinal: 0, type: "image", title: "original.png", sourceRunId: "fixture-upload", serverUrl: `/api/reference-assets/${stored.token}`, metadata: {} },
        ]);
        const auxiliarySource = await sharp({ create: { width: 20, height: 40, channels: 3, background: "#5a7c9e" } })
            .png()
            .toBuffer();
        const auxiliaryStored = await writeReferenceImageDataUrl(`data:image/png;base64,${auxiliarySource.toString("base64")}`, { ownerUserId: userId, conversationId: conversation.id, source: "fixture-full-image" });
        const [auxiliary] = await runtime.registerCreativeAssets([
            { id: `reference-${randomUUID()}`, userId, conversationId: conversation.id, ordinal: 1, type: "image", title: "auxiliary.png", sourceRunId: "fixture-upload", serverUrl: `/api/reference-assets/${auxiliaryStored.token}`, metadata: {} },
        ]);
        const assets = [asset, auxiliary];
        const now = Date.now();
        const run: AgentRun = {
            id: `agent-${randomUUID()}`,
            userId,
            conversationId: conversation.id,
            clientRequestId: randomUUID(),
            surface: "chat",
            inputMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
            prompt: "Change the camera angle",
            referencedAssetIds: assets.map((item) => item.id),
            assetIds: [],
            status: "running",
            tasks: [],
            reviewed: false,
            createdAt: now,
            updatedAt: now,
        };
        const { buildEcommercePlanningInput } = await import("./ecommerce-generation-snapshot");
        const { createEcommerceReferenceCheckpoint } = await import("./ecommerce-reference-recovery");
        const checkpoint = createEcommerceReferenceCheckpoint(run, buildEcommercePlanningInput(run, assets, { summary: "", recentMessages: [] }), assets);
        run.ecommerceSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            input: { userRequest: run.prompt, assetIds: assets.map((item) => item.id), conversationId: conversation.id, surface: "chat" },
            referenceCheckpoint: checkpoint,
            createdAt: now,
            runId: run.id,
            userId,
        };
        await runtime.createCreativeRunBundle(userId, { run, conversationId: conversation.id, title: "Full-image input fixture", prompt: run.prompt, assetIds: assets.map((item) => item.id), ttlMs: 60_000 });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: now });
        const preparing = await claimParent(run.id);
        await service.enqueueImageProcessingTask({
            runId: run.id,
            parentExecutionId: preparing.executionId!,
            operation: "prepare_reference",
            algorithmVersion: "reference-input-policy.v1",
            inputs: [{ assetId: asset.id, assetVersion: checkpoint.assets[0].assetVersion }],
            options: {},
        });
        const analysis = await completeCpu();
        const preparingAuxiliary = await claimParent(run.id);
        await service.enqueueImageProcessingTask({
            runId: run.id,
            parentExecutionId: preparingAuxiliary.executionId!,
            operation: "prepare_reference",
            algorithmVersion: "reference-input-policy.v1",
            inputs: [{ assetId: auxiliary.id, assetVersion: checkpoint.assets[1].assetVersion }],
            options: {},
        });
        await completeCpu();
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
            planVersion: "ecommerce-edit.v7",
            strategy: "full_image",
            operation: "scene_edit",
            taskId: "full-image-edit",
            source: { productAnchorId: null, currentSceneBaselineId: asset.id, sceneReferenceIds: [auxiliary.id] },
            referenceUses: [
                { assetId: asset.id, alias: "Image 1", purposes: ["edit_target"], usedCueIds: [] },
                { assetId: auxiliary.id, alias: "Image 2", purposes: ["style"], usedCueIds: ["fixture-blue-style"] },
            ],
            baseline: { productFacts: null, sceneFacts: null },
            delta: { requestedChanges: [run.prompt], targetObjects: [], targetRegions: [] },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            protection: { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: false },
            canvas: { mode: "exact", size: { width: 12, height: 12 }, source: "explicit_size", allowReframe: true },
            modelRoles: { visionAnalysis: "fixture-vision", editPlanning: "fixture-planner", generation: "fixture-image", qualityCheck: null },
            continuity: { branchId: "fixture-branch", parentResultId: null },
            validation: { requiredChecks: ["requested_edit"] },
        };
        const profile = resolveEcommerceImageProviderProfile(route);
        assert(profile);
        const execution = compileEcommerceImageRequest(plan, profile);
        await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => {
            assert(current.ecommerceSnapshot?.referenceCheckpoint);
            return {
                ...current,
                ecommerceSnapshot: {
                    ...current.ecommerceSnapshot,
                    plan,
                    compilerVersion: execution.compilerVersion,
                    modelRouteSnapshots: { image_generation: route },
                    referenceCheckpoint: { ...current.ecommerceSnapshot.referenceCheckpoint, state: "resolved", analysisStage: { ...current.ecommerceSnapshot.referenceCheckpoint.analysisStage, state: "completed" } },
                },
            };
        });
        const current = await claimParent(run.id);
        const analysisBefore = await tasks.getStoredGenerationTaskRecord("image_processing", analysis.id);
        expect(await service.prepareEcommerceGenerationReferences(current, current.executionId!, execution, { imageQuality: "high", imageSize: "12x12" })).toBe(false);
        const prepared = await completeCpu();
        expect(prepared.payload).toMatchObject({ operation: "prepare_reference", options: { generationInput: { bounds: { width: 12, height: 12 }, quality: "high" } }, inputs: [{ assetId: asset.id }] });
        const parent = await tasks.getStoredGenerationTask<AgentRun>("agent", run.id);
        expect(parent?.ecommerceSnapshot?.processing?.protection).toBeUndefined();
        expect(parent?.ecommerceSnapshot?.processing?.generationReferences?.[0].manifest?.artifacts).toEqual([expect.objectContaining({ kind: "generation_reference", mimeType: "image/png", width: 12, height: 9 })]);
        expect(await tasks.getStoredGenerationTaskRecord("image_processing", analysis.id)).toEqual(analysisBefore);
        const { prepareEcommerceFullImageTask } = await import("./ecommerce-protection-preparation");
        const next = await claimParent(run.id);
        expect(await prepareEcommerceFullImageTask(next, next.executionId!, { imageQuality: "low", imageSize: "100x100" })).toBeUndefined();
        const auxiliaryCopy = await completeCpu();
        expect(auxiliaryCopy.payload).toMatchObject({ operation: "prepare_reference", options: { generationInput: { bounds: { width: 12, height: 12 }, quality: "high" } }, inputs: [{ assetId: auxiliary.id }] });
        const ready = await claimParent(run.id);
        const executable = await prepareEcommerceFullImageTask(ready, ready.executionId!, { imageQuality: "low", imageSize: "100x100" });
        assert(executable?.references);
        expect(executable).toMatchObject({ quality: "high", ratio: "12x12" });
        expect(executable.sceneProtection).toBeUndefined();
        expect(executable.productProtectionRegions).toBeUndefined();
        await tasks.mutateStoredGenerationTask<AgentRun>("agent", run.id, 60_000, (current) => ({ ...current, tasks: [{ ...executable, status: "running", attempts: 1 }] }));
        const { emptyAdvancedConfig } = await import("@/lib/channel-protocol-registry");
        const image: ImageTask = {
            id: randomUUID(),
            userId,
            username: "fixture",
            displayName: "fixture",
            kind: "edit",
            source: "agent",
            status: "pending",
            createdAt: now,
            updatedAt: now,
            runId: run.id,
            parentTaskId: executable.id,
            conversationId: run.conversationId,
            clientRequestId: `${run.clientRequestId}:${executable.id}:1:1`,
            attemptNo: 1,
            config: { model: route.upstreamModel, apiFormat: "openai", baseUrl: "/api/fixture-image", apiKey: "fixture", quality: "high", size: "12x12", advancedConfig: { ...emptyAdvancedConfig(), protocol: "sub2api" } },
            prompt: executable.prompt,
            ecommerceExecution: executable.ecommerceExecution,
            references: executable.references.map((reference) => ({ id: reference.assetId, url: reference.url, dataUrl: "", width: reference.width, height: reference.height, ecommerceRole: reference.ecommerceRole })),
            referenceDispatch: { executionId: ready.executionId!, inputId: checkpoint.inputId, decisionId: checkpoint.decisionId, analysisRequestId: checkpoint.analysisStage.requestId, copy: 1 },
        };
        await tasks.createStoredGenerationTask("image", image, 60_000, { referenceDispatch: image.referenceDispatch });
        await tasks.linkStoredGenerationTask("image", image.id, { parentTaskId: run.id });
        const linked = await tasks.getStoredGenerationTask<ImageTask>("image", image.id);
        assert(linked);
        const inputs = await service.readEcommerceGenerationInput(linked, "high", "12x12");
        expect(inputs.references).toEqual([expect.objectContaining({ id: asset.id, width: 12, height: 9 }), expect.objectContaining({ id: auxiliary.id, width: 6, height: 12 })]);
        expect(inputs.mask).toBeUndefined();
        const frozen = (await tasks.getStoredGenerationTask<AgentRun>("agent", run.id))?.ecommerceSnapshot?.processing?.generationReferences;
        const primaryArtifact = frozen?.[0].manifest?.artifacts[0];
        const auxiliaryArtifact = frozen?.[1].manifest?.artifacts[0];
        assert(primaryArtifact && auxiliaryArtifact);
        const { readReferenceAsset } = await import("./reference-asset-store");
        const primaryFile = await readReferenceAsset(primaryArtifact.storageKey);
        const auxiliaryFile = await readReferenceAsset(auxiliaryArtifact.storageKey);
        assert(primaryFile && auxiliaryFile);
        const primaryBytes = await readFile(primaryFile.filePath);
        const auxiliaryBytes = await readFile(auxiliaryFile.filePath);
        const fetched: string[] = [];
        const server = createServer((request, response) => {
            const requested = request.url || "";
            fetched.push(requested);
            const body = requested === `/api/reference-assets/${primaryArtifact.storageKey}` ? primaryBytes : requested === `/api/reference-assets/${auxiliaryArtifact.storageKey}` ? auxiliaryBytes : undefined;
            response.writeHead(body ? 200 : 404, { "content-type": "image/png" });
            response.end(body);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        try {
            const address = server.address();
            assert(address && typeof address !== "string");
            const origin = `http://127.0.0.1:${address.port}`;
            const { buildJsonImageEditBodies } = await import("@/app/api/image-tasks/image-task-openai");
            const [body] = await buildJsonImageEditBodies(linked, "high", "12x12", "url", origin, origin, "session=fixture");
            const payload = JSON.parse(JSON.stringify(body)) as { images: { image_url: string }[]; mask?: unknown };
            expect(payload.mask).toBeUndefined();
            expect(payload.images).toHaveLength(2);
            expect(
                createHash("sha256")
                    .update(Buffer.from(payload.images[0].image_url.split(",")[1], "base64"))
                    .digest("hex"),
            ).toBe(primaryArtifact.sha256);
            expect(
                createHash("sha256")
                    .update(Buffer.from(payload.images[1].image_url.split(",")[1], "base64"))
                    .digest("hex"),
            ).toBe(auxiliaryArtifact.sha256);
            expect(fetched).toEqual(expect.arrayContaining([`/api/reference-assets/${primaryArtifact.storageKey}`, `/api/reference-assets/${auxiliaryArtifact.storageKey}`]));
            expect(fetched).toHaveLength(2);
            const original = await readReferenceAsset(stored.token);
            assert(original);
            const changedSource = Buffer.from(source);
            changedSource[changedSource.length - 1] ^= 1;
            await writeFile(original.filePath, changedSource);
            await expect(buildJsonImageEditBodies(linked, "high", "12x12", "url", origin, origin, "session=fixture")).rejects.toMatchObject({ name: "GenerationSubmissionSafeFailure", cause: { status: 409 } });
            expect(fetched).toHaveLength(2);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    }, 30_000);
});
