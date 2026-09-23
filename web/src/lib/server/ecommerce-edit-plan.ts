export const ECOMMERCE_EDIT_PLAN_VERSION = "ecommerce-edit.v1" as const;

export type EcommerceOperation = "product_to_scene" | "local_edit";
export type EcommerceStrategy = "strict_product" | "integrated_scene" | "creative_variation";
export type EcommerceModelRoles = {
    visionAnalysis: string;
    editPlanning: string;
    generation: string;
    qualityCheck: string;
};

export type EcommerceProductFacts = {
    identity: string;
    outline: string;
    color: string;
    material: string;
    brandText: string[];
    view: string;
};

export type EcommerceSceneFacts = {
    space: string;
    composition: string;
    lighting: string;
};

export type EcommerceManualRegion = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type EcommerceEditPlan = {
    planVersion: typeof ECOMMERCE_EDIT_PLAN_VERSION;
    operation: EcommerceOperation;
    source: {
        productAnchorId: string;
        currentSceneBaselineId: string | null;
        sceneReferenceIds: string[];
    };
    baseline: {
        productFacts: EcommerceProductFacts;
        sceneFacts: EcommerceSceneFacts;
    };
    delta: {
        requestedChanges: string[];
        targetObjects: string[];
        targetRegions: string[];
        manualRegion?: EcommerceManualRegion;
    };
    preserve: {
        productCore: string[];
        sceneElements: string[];
    };
    strategy: EcommerceStrategy;
    modelRoles: EcommerceModelRoles;
    continuity: {
        parentResultId: string | null;
        branchId: string;
    };
    validation: {
        requiredChecks: string[];
    };
};

export type EcommerceEditPlanPublicSummary = {
    operation: EcommerceOperation;
    strategy: EcommerceStrategy;
    requestedChanges: string[];
    targetObjects: string[];
};

const OPERATIONS = new Set<EcommerceOperation>(["product_to_scene", "local_edit"]);
const STRATEGIES = new Set<EcommerceStrategy>(["strict_product", "integrated_scene", "creative_variation"]);
const STRICT_PRODUCT_CORE = ["outline", "brand_text", "color", "material", "scale", "view"];

export function normalizeEcommerceEditPlan(value: unknown): EcommerceEditPlan | null {
    if (!isRecord(value) || value.planVersion !== ECOMMERCE_EDIT_PLAN_VERSION) return null;

    const source = asRecord(value.source);
    const baseline = asRecord(value.baseline);
    const delta = asRecord(value.delta);
    const preserve = asRecord(value.preserve);
    const modelRoles = asRecord(value.modelRoles);
    const continuity = asRecord(value.continuity);
    const validation = asRecord(value.validation);
    const productFacts = asRecord(baseline?.productFacts);
    const sceneFacts = asRecord(baseline?.sceneFacts);

    const normalized: EcommerceEditPlan = {
        planVersion: ECOMMERCE_EDIT_PLAN_VERSION,
        operation: value.operation as EcommerceOperation,
        source: {
            productAnchorId: normalizeId(source?.productAnchorId) || "",
            currentSceneBaselineId: normalizeNullableId(source?.currentSceneBaselineId),
            sceneReferenceIds: normalizeStringArray(source?.sceneReferenceIds),
        },
        baseline: {
            productFacts: {
                identity: normalizeText(productFacts?.identity),
                outline: normalizeText(productFacts?.outline),
                color: normalizeText(productFacts?.color),
                material: normalizeText(productFacts?.material),
                brandText: normalizeStringArray(productFacts?.brandText),
                view: normalizeText(productFacts?.view),
            },
            sceneFacts: {
                space: normalizeText(sceneFacts?.space),
                composition: normalizeText(sceneFacts?.composition),
                lighting: normalizeText(sceneFacts?.lighting),
            },
        },
        delta: {
            requestedChanges: normalizeStringArray(delta?.requestedChanges),
            targetObjects: normalizeStringArray(delta?.targetObjects),
            targetRegions: normalizeStringArray(delta?.targetRegions),
            ...(normalizeManualRegion(delta?.manualRegion) ? { manualRegion: normalizeManualRegion(delta?.manualRegion) } : {}),
        },
        preserve: {
            productCore: normalizeStringArray(preserve?.productCore),
            sceneElements: normalizeStringArray(preserve?.sceneElements),
        },
        strategy: value.strategy as EcommerceStrategy,
        modelRoles: {
            visionAnalysis: normalizeText(modelRoles?.visionAnalysis),
            editPlanning: normalizeText(modelRoles?.editPlanning),
            generation: normalizeText(modelRoles?.generation),
            qualityCheck: normalizeText(modelRoles?.qualityCheck),
        },
        continuity: {
            parentResultId: normalizeNullableId(continuity?.parentResultId),
            branchId: normalizeId(continuity?.branchId) || "",
        },
        validation: {
            requiredChecks: normalizeStringArray(validation?.requiredChecks),
        },
    };

    try {
        validateEcommerceEditPlan(normalized);
    } catch {
        return null;
    }
    return normalized;
}

export function validateEcommerceEditPlan(plan: EcommerceEditPlan): void {
    if (!isRecord(plan) || plan.planVersion !== ECOMMERCE_EDIT_PLAN_VERSION) throw new Error("商品编辑计划版本无效");
    if (!OPERATIONS.has(plan.operation)) throw new Error("商品编辑操作无效");
    if (!STRATEGIES.has(plan.strategy)) throw new Error("商品编辑策略无效");
    if (!isRecord(plan.source)) throw new Error("商品编辑来源无效");

    requireId(plan.source.productAnchorId, "商品主参考图");
    if (!Array.isArray(plan.source.sceneReferenceIds) || plan.source.sceneReferenceIds.length > 1) throw new Error("场景参考图数量无效");
    plan.source.sceneReferenceIds.forEach((id) => {
        requireId(id, "场景参考图");
        if (id === plan.source.productAnchorId) throw new Error("场景参考图不能作为商品主参考图");
    });
    if (plan.source.currentSceneBaselineId !== null) {
        requireId(plan.source.currentSceneBaselineId, "当前场景基线");
        if (plan.source.currentSceneBaselineId === plan.source.productAnchorId) throw new Error("当前场景基线不能替代商品主参考图");
    }

    validateProductFacts(plan.baseline?.productFacts);
    validateSceneFacts(plan.baseline?.sceneFacts);
    if (!isRecord(plan.delta)) throw new Error("场景增量无效");
    requireStringArray(plan.delta.requestedChanges, "创作请求");
    requireStringArray(plan.delta.targetObjects, "编辑目标");
    requireStringArray(plan.delta.targetRegions, "编辑区域");
    if (plan.delta.manualRegion !== undefined) validateManualRegion(plan.delta.manualRegion);
    if (plan.operation === "local_edit" && !plan.delta.targetObjects.length && !plan.delta.manualRegion) throw new Error("局部编辑目标无效");

    if (!isRecord(plan.preserve)) throw new Error("商品保护项无效");
    requireStringArray(plan.preserve.productCore, "商品核心保护项");
    requireStringArray(plan.preserve.sceneElements, "场景保护项");
    if (plan.strategy === "strict_product" && STRICT_PRODUCT_CORE.some((key) => !plan.preserve.productCore.includes(key))) throw new Error("商品核心保护项不完整");

    if (!isRecord(plan.modelRoles)) throw new Error("模型角色无效");
    [plan.modelRoles.visionAnalysis, plan.modelRoles.editPlanning, plan.modelRoles.generation, plan.modelRoles.qualityCheck].forEach((role) => requireId(role, "模型角色"));

    if (!isRecord(plan.continuity)) throw new Error("连续编辑关系无效");
    if (plan.continuity.parentResultId !== null) requireId(plan.continuity.parentResultId, "父结果");
    requireId(plan.continuity.branchId, "编辑分支");

    if (!isRecord(plan.validation)) throw new Error("验收规则无效");
    requireStringArray(plan.validation.requiredChecks, "验收规则");
}

export function planPublicSummary(plan: EcommerceEditPlan): EcommerceEditPlanPublicSummary {
    validateEcommerceEditPlan(plan);
    return {
        operation: plan.operation,
        strategy: plan.strategy,
        requestedChanges: [...plan.delta.requestedChanges],
        targetObjects: [...plan.delta.targetObjects],
    };
}

function validateProductFacts(value: EcommerceProductFacts | undefined): asserts value is EcommerceProductFacts {
    if (!isRecord(value)) throw new Error("商品事实无效");
    [value.identity, value.outline, value.color, value.material, value.view].forEach((item) => requireText(item, "商品事实"));
    requireStringArray(value.brandText, "品牌文字");
}

function validateSceneFacts(value: EcommerceSceneFacts | undefined): asserts value is EcommerceSceneFacts {
    if (!isRecord(value)) throw new Error("场景事实无效");
    [value.space, value.composition, value.lighting].forEach((item) => requireText(item, "场景事实"));
}

function validateManualRegion(value: EcommerceManualRegion): void {
    if (!isRecord(value) || ![value.x, value.y, value.width, value.height].every((item) => typeof item === "number" && Number.isFinite(item))) throw new Error("手动编辑区域无效");
    if (value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0) throw new Error("手动编辑区域无效");
}

function requireText(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label}无效`);
}

function requireId(value: unknown, label: string): asserts value is string {
    requireText(value, label);
}

function requireStringArray(value: unknown, label: string): asserts value is string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label}无效`);
}

function normalizeText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeId(value: unknown): string | null {
    const text = normalizeText(value);
    return text || null;
}

function normalizeNullableId(value: unknown): string | null {
    return value === null || value === undefined ? null : typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function normalizeManualRegion(value: unknown): EcommerceManualRegion | undefined {
    if (!isRecord(value)) return undefined;
    const values = [value.x, value.y, value.width, value.height];
    if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
    const [x, y, width, height] = values as number[];
    return { x, y, width, height };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
