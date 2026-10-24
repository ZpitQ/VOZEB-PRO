import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { createCreativeConversation, listCreativeAssets, registerCreativeAssets } from "./creative-runtime-store";
import { registerGenerationTaskAssetsForUser } from "./creative-runtime-service";
import { registerAgentTaskAssets } from "./agent-run-assets";

vi.mock("@/lib/server/reference-asset-store", () => ({ writePersistentMediaDataUrl: vi.fn() }));
vi.mock("@/lib/server/creative-entity-deletion-store", () => ({ deleteCreativeConversationAggregates: vi.fn() }));
vi.mock("@/lib/server/user-media-deletion-service", () => ({ deleteUserMediaAssetsCascade: vi.fn() }));

describe("image result registration through both real asset paths", () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-image-result-assets-"));
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubGlobal(
            "fetch",
            vi.fn(() => {
                throw new Error("Asset registration must not invoke a provider or Worker");
            }),
        );
    });
    afterEach(async () => {
        expect(fetch).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it.each(["native", "disabled", "not_requested", "protected_contract", "unsupported_layers"] as const)("retains public %s facts, the same original identity and an existing enhancement child after refresh", async (kind) => {
        const conversation = await createCreativeConversation("fixture-owner", { surface: "chat" });
        const currentRun = run(conversation.id);
        const url = "/api/generation-log-assets/fixture-native.png";
        const nativeSource = { url, sha256: "a".repeat(64), width: 1254, height: 1254, byteLength: 1000, format: "png", hasAlpha: false, provenance: "provider_native" as const };
        const facts = kind === "native" ? { resultId: "image-task:1", enhancementId: "enhancement:image-task:1", nativeSource } : { resultId: "image-task:1", enhancementSkip: { status: "skipped" as const, reason: kind } };
        const record = {
            ...facts,
            ...(kind === "native" ? { nativeSource: { ...nativeSource, credentialRef: "private-credential", frozenConnection: { token: "private-token" } } } : { enhancementSkip: { ...facts.enhancementSkip, unknown: "private-skip-field" } }),
            url,
            type: "image" as const,
            width: 1254,
            height: 1254,
            mimeType: "image/png",
            bytes: 1000,
            canvasEvidence: { nativeUrl: "private-canvas" },
            sceneProtectionEvidence: { maskUrl: "private-mask" },
            batchEvidence: ["private-batch"],
            unknown: "private-future",
        };
        const input = { conversationId: conversation.id, runId: currentRun.id, surface: "chat" as const, taskId: "image-task", title: "原图", assets: [record] };
        const [original] = await registerGenerationTaskAssetsForUser(currentRun.userId, input);
        expect(original.metadata).toMatchObject(facts);
        expect(JSON.stringify(original.metadata)).not.toContain("private-");
        const frozenB = { assetId: original.id, url: original.serverUrl, nativeSource: structuredClone(original.metadata.nativeSource) };
        const [child] = await registerCreativeAssets([
            {
                userId: currentRun.userId,
                conversationId: conversation.id,
                sourceRunId: currentRun.id,
                sourceTaskId: "enhancement:image-task:1",
                ordinal: 0,
                parentAssetId: original.id,
                type: "image",
                title: "增强图",
                storageKind: "local",
                serverUrl: "/api/generation-log-assets/fixture-enhanced.png",
                metadata: { provenance: "ai_enhanced", enhancementId: "enhancement:image-task:1", parentResultId: "image-task:1" },
            },
        ]);
        for (let refresh = 0; refresh < 2; refresh++) {
            const [agentAsset] = await registerAgentTaskAssets(currentRun, task(), { results: [record] }, ["image-task"]);
            expect(agentAsset).toMatchObject({ id: original.id, sourceRunId: currentRun.id, sourceTaskId: "image-task", ordinal: 0, serverUrl: url, metadata: facts });
            expect(JSON.stringify(agentAsset.metadata)).not.toContain("private-");
            const [registeredAgain] = await registerGenerationTaskAssetsForUser(currentRun.userId, input);
            expect(registeredAgain.id).toBe(original.id);
            expect(registeredAgain.metadata).toMatchObject(facts);
        }
        const all = await listCreativeAssets(conversation.id, currentRun.userId);
        expect(all).toHaveLength(2);
        expect(all.find((asset) => asset.id === child.id)).toEqual(child);
        const restored = all.find((asset) => asset.id === original.id)!;
        expect({ assetId: restored.id, url: restored.serverUrl, nativeSource: restored.metadata.nativeSource }).toEqual(frozenB);
    });

    it.each([
        { slotsByTask: [[1], [1]] },
        {
            slotsByTask: [
                [1, 2],
                [1, 2],
            ],
        },
        {
            slotsByTask: [
                [2, 4],
                [1, 3],
            ],
        },
    ])("preserves every original and enhancement parent across two-child aggregate registration with result slots $slotsByTask", async ({ slotsByTask }) => {
        const conversation = await createCreativeConversation("fixture-owner", { surface: "chat" });
        const currentRun = run(conversation.id);
        const sourceTaskIds = ["image-task-one", "image-task-two"];
        const resultsByTask = sourceTaskIds.map((sourceTaskId, taskIndex) =>
            slotsByTask[taskIndex].map((slot, ordinal) => {
                const resultId = `${sourceTaskId}:${slot}`;
                const serverUrl = `/api/generation-log-assets/${sourceTaskId}-${slot}.png`;
                return {
                    resultId,
                    enhancementId: `enhancement:${resultId}`,
                    dataUrl: serverUrl,
                    serverUrl,
                    width: 1254,
                    height: 1254,
                    bytes: 1000,
                    mimeType: "image/png",
                    nativeSource: { url: serverUrl, sha256: String(taskIndex * slotsByTask[taskIndex].length + ordinal + 1).repeat(64), width: 1254, height: 1254, byteLength: 1000, format: "png", hasAlpha: false, provenance: "provider_native" as const },
                };
            }),
        );
        const directInputs = resultsByTask.map((results, taskIndex) => ({
            conversationId: conversation.id,
            runId: currentRun.id,
            surface: "chat" as const,
            taskId: sourceTaskIds[taskIndex],
            title: "原图",
            assets: results.map((media) => ({ ...media, type: "image" as const, url: media.serverUrl })),
        }));
        const originals: CreativeAsset[] = [];
        for (const input of directInputs) originals.push(...(await registerGenerationTaskAssetsForUser(currentRun.userId, input)));
        expect(originals.map((asset) => [asset.sourceTaskId, asset.ordinal, asset.metadata.resultId])).toEqual(resultsByTask.flatMap((results, taskIndex) => results.map((media, ordinal) => [sourceTaskIds[taskIndex], ordinal, media.resultId])));
        const enhanced = await registerCreativeAssets(
            originals.map((original) => ({
                userId: currentRun.userId,
                conversationId: conversation.id,
                sourceRunId: currentRun.id,
                sourceTaskId: String(original.metadata.enhancementId),
                ordinal: 0,
                parentAssetId: original.id,
                type: "image" as const,
                title: "增强图",
                storageKind: "local" as const,
                serverUrl: `/api/generation-log-assets/${original.metadata.resultId}-enhanced.png`,
                metadata: { provenance: "ai_enhanced", enhancementId: original.metadata.enhancementId, parentResultId: original.metadata.resultId },
            })),
        );
        const readFrozenBReferences = async () => {
            const all = await listCreativeAssets(conversation.id, currentRun.userId);
            expect(all).toHaveLength(originals.length + enhanced.length);
            for (const child of enhanced) expect(all.find((asset) => asset.id === child.id)).toEqual(child);
            return originals.map((original) => {
                const stored = all.find((asset) => asset.id === original.id)!;
                return {
                    assetId: stored.id,
                    sourceRunId: stored.sourceRunId,
                    sourceTaskId: stored.sourceTaskId,
                    ordinal: stored.ordinal,
                    url: stored.serverUrl,
                    resultId: stored.metadata.resultId,
                    nativeSource: structuredClone(stored.metadata.nativeSource),
                    enhancementId: stored.metadata.enhancementId,
                };
            });
        };
        const frozenB = await readFrozenBReferences();
        const aggregated = { results: resultsByTask.map((results) => ({ ...results[0], results })) };
        for (let refresh = 0; refresh < 2; refresh++) {
            const registered = await registerAgentTaskAssets(currentRun, { ...task(), count: sourceTaskIds.length }, aggregated, sourceTaskIds);
            expect(await readFrozenBReferences()).toEqual(frozenB);
            expect(registered.map((asset) => asset.id)).toEqual(originals.map((asset) => asset.id));
            for (let taskIndex = 0; taskIndex < directInputs.length; taskIndex++) {
                const registeredAgain = await registerGenerationTaskAssetsForUser(currentRun.userId, directInputs[taskIndex]);
                expect(registeredAgain.map((asset) => asset.id)).toEqual(originals.filter((asset) => asset.sourceTaskId === sourceTaskIds[taskIndex]).map((asset) => asset.id));
            }
            expect(await readFrozenBReferences()).toEqual(frozenB);
        }
    });

    it("keeps the existing source-task and ordinal mapping for image results without resultId", async () => {
        const conversation = await createCreativeConversation("fixture-owner", { surface: "chat" });
        const currentRun = run(conversation.id);
        const result = { results: [{ url: "/api/generation-log-assets/one.png" }, { url: "/api/generation-log-assets/two.png" }] };
        const assets = await registerAgentTaskAssets(currentRun, task(), result, ["image-task-one", "image-task-two"]);
        expect(assets.map((asset) => [asset.sourceTaskId, asset.ordinal])).toEqual([
            ["image-task-one", 0],
            ["image-task-two", 1],
        ]);
        const repeated = await registerAgentTaskAssets(currentRun, task(), result, ["image-task-one", "image-task-two"]);
        expect(repeated.map((asset) => asset.id)).toEqual(assets.map((asset) => asset.id));
        expect(await listCreativeAssets(conversation.id, currentRun.userId)).toHaveLength(2);
    });

    it.each([{ status: "running", reason: "disabled" }, { status: "skipped", reason: "private-reason" }, null])("omits unknown skip values in both actual asset registrations: %s", async (enhancementSkip) => {
        const conversation = await createCreativeConversation("fixture-owner", { surface: "chat" });
        const currentRun = run(conversation.id);
        const record = { type: "image" as const, url: "/api/generation-log-assets/skipped.png", enhancementSkip };
        const [direct] = await registerGenerationTaskAssetsForUser(currentRun.userId, { conversationId: conversation.id, runId: currentRun.id, taskId: "image-task", title: "原图", assets: [record] });
        expect(direct.metadata).not.toHaveProperty("enhancementSkip");
        const [agent] = await registerAgentTaskAssets(currentRun, task(), record, ["image-task"]);
        expect(agent.id).toBe(direct.id);
        expect(agent.metadata).not.toHaveProperty("enhancementSkip");
    });
});

function task(): AgentRunTask {
    return { id: "agent-image", title: "原图", type: "image", prompt: "fixture", count: 1, dependencies: [], status: "completed", attempts: 1 };
}

function run(conversationId: string): AgentRun {
    return {
        id: "fixture-run",
        userId: "fixture-owner",
        conversationId,
        clientRequestId: "fixture-request",
        surface: "chat",
        inputMessageId: "fixture-input",
        assistantMessageId: "fixture-assistant",
        prompt: "fixture",
        referencedAssetIds: [],
        assetIds: [],
        status: "running",
        tasks: [],
        reviewed: false,
        createdAt: 1,
        updatedAt: 1,
    };
}
