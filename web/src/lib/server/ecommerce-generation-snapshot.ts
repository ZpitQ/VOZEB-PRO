import type { CreativeAsset, CreativeConversationContext, CreativeSurface } from "@/lib/creative-runtime-contract";
import type { AgentRun } from "./agent-run-store";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import type { EcommerceQualityCheck } from "./ecommerce-quality-check";
import type { EcommerceLogicalModelRole } from "./agent-run-surface-policy";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";

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
    continuity?: { parentResultId: string | null; branchId: string };
    visualAnalysis?: EcommerceVisualAnalysis;
    plan?: EcommerceEditPlan;
    modelRoles?: Record<string, string>;
    modelRouteSnapshots?: Partial<Record<EcommerceLogicalModelRole, EcommerceRoleRouteSnapshot>>;
    compilerVersion?: string;
    qualityCheck?: EcommerceQualityCheck;
    stageTimings?: { analysisCompletedAt?: number; planningCompletedAt?: number };
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
    const orderedAssets = run.referencedAssetIds.length
        ? [...run.referencedAssetIds.map((id) => assetsById.get(id)).filter((asset): asset is CreativeAsset => Boolean(asset)), ...assets.filter((asset) => !run.referencedAssetIds.includes(asset.id))]
        : assets;
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
        ...(snapshot.continuity ? { continuity: { ...snapshot.continuity } } : {}),
        ...(snapshot.visualAnalysis
            ? {
                  visualAnalysis: {
                      ...snapshot.visualAnalysis,
                      modelRole: { ...snapshot.visualAnalysis.modelRole },
                      references: snapshot.visualAnalysis.references.map((reference) => ({
                          ...reference,
                          visualEvidence: { ...reference.visualEvidence },
                          productFacts: reference.productFacts ? { ...reference.productFacts, brandText: [...reference.productFacts.brandText] } : null,
                          sceneFacts: reference.sceneFacts ? { ...reference.sceneFacts } : null,
                          productCore: reference.productCore ? { ...reference.productCore } : null,
                          fusionHalo: reference.fusionHalo ? { ...reference.fusionHalo } : null,
                          editableTargets: reference.editableTargets.map((target) => ({ ...target, region: { ...target.region } })),
                      })),
                  },
              }
            : {}),
        ...(snapshot.plan ? { plan: snapshot.plan } : {}),
        ...(snapshot.modelRouteSnapshots
            ? {
                  modelRouteSnapshots: Object.fromEntries(Object.entries(snapshot.modelRouteSnapshots).map(([role, route]) => [role, route ? { ...route } : route])) as EcommerceGenerationSnapshot["modelRouteSnapshots"],
              }
            : {}),
        ...(snapshot.qualityCheck
            ? {
                  qualityCheck: {
                      ...snapshot.qualityCheck,
                      modelRole: { ...snapshot.qualityCheck.modelRole },
                      checks: snapshot.qualityCheck.checks.map((item) => ({ ...item })),
                      hardFailures: snapshot.qualityCheck.hardFailures.map((item) => ({ ...item })),
                  },
              }
            : {}),
        ...(snapshot.stageTimings ? { stageTimings: { ...snapshot.stageTimings } } : {}),
        runId: run.id,
        userId: run.userId,
    };
}

export function legacyPlanFallback(input: EcommerceSnapshotInput): EcommerceLegacyFallback {
    return { mode: "legacy", reason: "ecommerce_planner_disabled", input: { ...input, assetIds: [...input.assetIds] } };
}
