import type { CreativeAsset, CreativeConversationContext, CreativeSurface } from "@/lib/creative-runtime-contract";
import type { AgentRun } from "./agent-run-store";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";

export const ECOMMERCE_GENERATION_SNAPSHOT_VERSION = "ecommerce-generation.v1" as const;

export type EcommercePlanningAssetCandidate = {
    id: string;
    type: CreativeAsset["type"];
    title: string;
    url?: string;
    width?: number;
    height?: number;
};

export type EcommercePlanningInput = {
    userRequest: string;
    conversationId: string;
    surface: CreativeSurface;
    assetCandidates: EcommercePlanningAssetCandidate[];
    conversationContext: {
        summary: string;
        recentMessages: Array<{ role: string; content: string; sequence: number }>;
    };
};

export type EcommerceSnapshotInput = {
    userRequest: string;
    assetIds: string[];
    conversationId: string;
    surface: CreativeSurface;
};

export type EcommerceGenerationSnapshot = {
    version: typeof ECOMMERCE_GENERATION_SNAPSHOT_VERSION;
    mode: "shadow" | "legacy" | "active";
    input: EcommerceSnapshotInput;
    plan?: EcommerceEditPlan;
    modelRoles?: Record<string, string>;
    compilerVersion?: string;
    qualityCheck?: Record<string, unknown>;
    fallback?: { reason: string };
    createdAt: number;
};

export type EcommerceGenerationSnapshotRecord = EcommerceGenerationSnapshot & {
    runId: string;
    userId: string;
};

export type EcommerceLegacyFallback = {
    mode: "legacy";
    reason: "ecommerce_planner_disabled";
    input: EcommerceSnapshotInput;
};

export function ecommerceShadowPlanningEnabled(value: unknown): boolean {
    return typeof value === "string" && value.trim().toLowerCase() === "shadow";
}

export function buildEcommercePlanningInput(
    run: Pick<AgentRun, "prompt" | "conversationId" | "surface" | "referencedAssetIds">,
    assets: CreativeAsset[],
    conversationContext: Pick<CreativeConversationContext, "summary" | "recentMessages">,
): EcommercePlanningInput {
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const orderedAssets = run.referencedAssetIds.length ? run.referencedAssetIds.map((id) => assetsById.get(id)).filter((asset): asset is CreativeAsset => Boolean(asset)) : assets;
    return {
        userRequest: run.prompt,
        conversationId: run.conversationId,
        surface: run.surface,
        assetCandidates: orderedAssets.map((asset) => ({
            id: asset.id,
            type: asset.type,
            title: asset.title,
            ...(asset.remoteUrl || asset.serverUrl ? { url: asset.remoteUrl || asset.serverUrl } : {}),
            ...(Number.isFinite(asset.width) ? { width: asset.width } : {}),
            ...(Number.isFinite(asset.height) ? { height: asset.height } : {}),
        })),
        conversationContext: {
            summary: conversationContext.summary,
            recentMessages: conversationContext.recentMessages.map((message) => ({ role: message.role, content: message.content, sequence: message.sequence })),
        },
    };
}

export function recordEcommerceGenerationSnapshot(run: Pick<AgentRun, "id" | "userId">, snapshot: EcommerceGenerationSnapshot): EcommerceGenerationSnapshotRecord {
    return {
        ...snapshot,
        input: { ...snapshot.input, assetIds: [...snapshot.input.assetIds] },
        ...(snapshot.plan ? { plan: snapshot.plan } : {}),
        runId: run.id,
        userId: run.userId,
    };
}

export function legacyPlanFallback(input: EcommerceSnapshotInput): EcommerceLegacyFallback {
    return { mode: "legacy", reason: "ecommerce_planner_disabled", input: { ...input, assetIds: [...input.assetIds] } };
}
