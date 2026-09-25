import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";

export type EcommerceImageProviderProfile = {
    profileId: "gpt-image-2.5-flare" | "gpt-image-2.5-sunburst" | "nano-banana-2";
    compilerFamily: "openai-image-2.5" | "nano-banana-2";
    supportsIndependentMask: boolean;
    modelSnapshot: EcommerceRoleRouteSnapshot;
};

export type EcommerceCompiledImageRequest = {
    state: "ready" | "needs_review";
    compilerVersion: "ecommerce-openai-image-2.5.v1" | "ecommerce-nano-banana-2.v1";
    providerProfileId: EcommerceImageProviderProfile["profileId"];
    prompt: string;
    referenceRoles: Array<{ assetId: string; role: "product" | "scene" }>;
    mask?: { mode: "independent"; required: true };
    reason?: "independent_mask_unsupported";
    parameters: { variant: EcommerceImageProviderProfile["profileId"] };
    modelSnapshot: EcommerceRoleRouteSnapshot;
};

export function resolveEcommerceImageProviderProfile(snapshot: EcommerceRoleRouteSnapshot): EcommerceImageProviderProfile | null {
    if (snapshot.logicalRole !== "image_generation" || snapshot.capability !== "image") return null;
    const model = normalizeModelName(snapshot.upstreamModel);
    if (model === "gpt-image-2.5-flare" || model === "gpt-image-2.5-sunburst") {
        return {
            profileId: model,
            compilerFamily: "openai-image-2.5",
            supportsIndependentMask: snapshot.apiFormat === "openai",
            modelSnapshot: { ...snapshot },
        };
    }
    if (model === "nano-banana-2") {
        return {
            profileId: "nano-banana-2",
            compilerFamily: "nano-banana-2",
            supportsIndependentMask: false,
            modelSnapshot: { ...snapshot },
        };
    }
    return null;
}

export function compileEcommerceImageRequest(plan: EcommerceEditPlan, profile: EcommerceImageProviderProfile): EcommerceCompiledImageRequest {
    const referenceRoles = plan.operation === "local_edit" ? localEditReferences(plan) : productSceneReferences(plan);
    const compilerVersion: EcommerceCompiledImageRequest["compilerVersion"] = profile.compilerFamily === "openai-image-2.5" ? "ecommerce-openai-image-2.5.v1" : "ecommerce-nano-banana-2.v1";
    const prompt = profile.compilerFamily === "openai-image-2.5" ? compileOpenAiPrompt(plan, referenceRoles) : compileNanoBananaPrompt(plan, referenceRoles);
    const common = {
        compilerVersion,
        providerProfileId: profile.profileId,
        prompt,
        referenceRoles,
        parameters: { variant: profile.profileId },
        modelSnapshot: { ...profile.modelSnapshot },
    };
    if (plan.strategy === "strict_product" && !profile.supportsIndependentMask) {
        return { ...common, state: "needs_review", reason: "independent_mask_unsupported" };
    }
    return {
        ...common,
        state: "ready",
        ...(plan.strategy === "strict_product" ? { mask: { mode: "independent" as const, required: true as const } } : {}),
    };
}

function productSceneReferences(plan: EcommerceEditPlan) {
    return uniqueReferences([{ assetId: plan.source.productAnchorId, role: "product" as const }, ...plan.source.sceneReferenceIds.map((assetId) => ({ assetId, role: "scene" as const }))]);
}

function localEditReferences(plan: EcommerceEditPlan) {
    return uniqueReferences([
        ...(plan.source.currentSceneBaselineId ? [{ assetId: plan.source.currentSceneBaselineId, role: "scene" as const }] : []),
        { assetId: plan.source.productAnchorId, role: "product" as const },
        ...plan.source.sceneReferenceIds.map((assetId) => ({ assetId, role: "scene" as const })),
    ]);
}

function uniqueReferences(references: Array<{ assetId: string; role: "product" | "scene" }>) {
    const seen = new Set<string>();
    return references.filter((reference) => Boolean(reference.assetId) && !seen.has(reference.assetId) && Boolean(seen.add(reference.assetId)));
}

function compileOpenAiPrompt(plan: EcommerceEditPlan, references: Array<{ assetId: string; role: "product" | "scene" }>) {
    return [
        `执行 ${plan.operation}，策略 ${plan.strategy}。`,
        `参考图角色：${references.map((reference) => `${reference.assetId}=${reference.role}`).join("；")}。`,
        `商品基线：${productFacts(plan)}。`,
        `场景基线：${sceneFacts(plan)}。`,
        `本轮增量：${changes(plan)}。`,
        `必须保持：${[...plan.preserve.productCore, ...plan.preserve.sceneElements].join("、")}。`,
        plan.operation === "local_edit" ? "只重绘独立蒙版允许的目标区域；商品核心、融合边缘和其他场景像素保持不变。" : "商品锚点决定商品身份；场景参考仅决定空间、构图、光线和氛围。",
    ].join("\n");
}

function compileNanoBananaPrompt(plan: EcommerceEditPlan, references: Array<{ assetId: string; role: "product" | "scene" }>) {
    return [
        `任务：${plan.operation}；策略：${plan.strategy}。`,
        ...references.map((reference, index) => `参考图${index + 1}（${reference.role === "product" ? "商品锚点" : "场景参考"}）：${reference.assetId}。`),
        `商品事实：${productFacts(plan)}。`,
        `场景事实：${sceneFacts(plan)}。`,
        `只执行本轮变化：${changes(plan)}。`,
        `禁止改变：${plan.preserve.productCore.join("、")}。`,
    ].join("\n");
}

function productFacts(plan: EcommerceEditPlan) {
    const facts = plan.baseline.productFacts;
    return [facts.identity, facts.outline, facts.color, facts.material, facts.brandText.join("、"), facts.view].filter(Boolean).join("；");
}

function sceneFacts(plan: EcommerceEditPlan) {
    const facts = plan.baseline.sceneFacts;
    return [facts.space, facts.composition, facts.lighting].filter(Boolean).join("；");
}

function changes(plan: EcommerceEditPlan) {
    return [...plan.delta.requestedChanges, ...plan.delta.targetObjects, ...plan.delta.targetRegions].filter(Boolean).join("；");
}

function normalizeModelName(value: string) {
    return value
        .trim()
        .toLowerCase()
        .replace(/^models\//, "")
        .replace(/[\s_]+/g, "-");
}
