import type { AuthSettings, LogicalModelCapability } from "@/lib/auth/store";

import type { EcommerceLogicalModelRole } from "./agent-run-surface-policy";
import { resolveLogicalModelCandidates, resolveLogicalModelSnapshot, type ResolvedLogicalModel } from "./logical-model-router";

export type EcommerceModelRoutingSettings = Pick<AuthSettings, "defaultModels" | "logicalModels" | "systemChannels"> & {
    ecommerceModelRoles?: Partial<Record<EcommerceLogicalModelRole, string[]>>;
};

export type EcommerceRoleRouteSnapshot = {
    logicalRole: EcommerceLogicalModelRole;
    capability: LogicalModelCapability;
    logicalModelId: string;
    channelId: string;
    upstreamModel: string;
    apiFormat: "openai" | "gemini";
};

export type EcommerceRoleCandidate = ResolvedLogicalModel & {
    logicalRole: EcommerceLogicalModelRole;
    capability: LogicalModelCapability;
    snapshot: EcommerceRoleRouteSnapshot;
};

export function resolveEcommerceRoleCandidates(settings: EcommerceModelRoutingSettings, role: EcommerceLogicalModelRole, capability: LogicalModelCapability): EcommerceRoleCandidate[] {
    if (capability !== capabilityForRole(role)) return [];
    const configured = settings.ecommerceModelRoles?.[role]?.map((id) => id.trim()).filter(Boolean);
    const modelIds = configured?.length ? configured : [capability === "image" ? settings.defaultModels.imageModel : settings.defaultModels.textModel].filter(Boolean);
    const seen = new Set<string>();
    return modelIds.flatMap((logicalModelId) =>
        resolveLogicalModelCandidates(settings, capability, logicalModelId).flatMap((candidate) => {
            const key = `${candidate.logicalModelId}\u0000${candidate.channelId}\u0000${candidate.upstreamModel}`;
            if (seen.has(key)) return [];
            seen.add(key);
            return [withRole(candidate, role, capability)];
        }),
    );
}

export function routeEcommerceRole(settings: EcommerceModelRoutingSettings, role: EcommerceLogicalModelRole, snapshot?: EcommerceRoleRouteSnapshot | null): EcommerceRoleCandidate | null {
    const capability = capabilityForRole(role);
    if (snapshot) {
        if (snapshot.logicalRole !== role || snapshot.capability !== capability) return null;
        const resolved = resolveLogicalModelSnapshot(settings, capability, snapshot);
        return resolved ? withRole(resolved, role, capability) : null;
    }
    return resolveEcommerceRoleCandidates(settings, role, capability)[0] || null;
}

function capabilityForRole(role: EcommerceLogicalModelRole): LogicalModelCapability {
    return role === "image_generation" ? "image" : "text";
}

function withRole(candidate: ResolvedLogicalModel, role: EcommerceLogicalModelRole, capability: LogicalModelCapability): EcommerceRoleCandidate {
    const apiFormat = candidate.channel.apiFormat === "gemini" ? "gemini" : "openai";
    return {
        ...candidate,
        logicalRole: role,
        capability,
        snapshot: {
            logicalRole: role,
            capability,
            logicalModelId: candidate.logicalModelId,
            channelId: candidate.channelId,
            upstreamModel: candidate.upstreamModel,
            apiFormat,
        },
    };
}
