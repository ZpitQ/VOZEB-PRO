import { refundUserPoints } from "@/lib/auth/store";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";

import { parseValidatedAgentFunctionCall } from "./agent-function-call";
import { normalizeEcommerceEditPlan, validateEcommerceEditPlan, type EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommercePlanningInput } from "./ecommerce-generation-snapshot";
import type { EcommerceRoleCandidate, EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import type { EcommerceSources } from "./ecommerce-reference-roles";
import type { EcommerceEditableTarget, EcommerceNormalizedRegion, EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { rankTextPlanningCandidates, requestStructuredText } from "./text-planning-runtime";

export type EcommerceEditPlanningRequest = {
    origin: string;
    cookie: string;
    userId: string;
    requestId: string;
    planningInput: EcommercePlanningInput;
    sources: EcommerceSources;
    branchId: string;
    generationModelRole: string;
    qualityCheckModelRole: string;
};

export type EcommerceEditPlanningResult = {
    plan: EcommerceEditPlan;
    modelRole: Pick<EcommerceRoleRouteSnapshot, "logicalModelId" | "channelId" | "upstreamModel"> & Partial<Pick<EcommerceRoleRouteSnapshot, "capability" | "apiFormat">> & { logicalRole: "edit_planning" };
};

export class EcommerceEditPlanningError extends Error {
    constructor(
        message: string,
        readonly status = 422,
    ) {
        super(message);
        this.name = "EcommerceEditPlanningError";
    }
}

export type EcommerceResolvedLocalEditTarget = EcommerceEditableTarget & { source: "analysis" | "manual" };
export type EcommerceLocalEditTargetResolution =
    | { state: "resolved"; target: EcommerceResolvedLocalEditTarget }
    | { state: "needs_review"; reason: "missing_target" | "multiple_matching_targets"; clarificationQuestion: string }
    | { state: "rejected"; reason: "invalid_local_edit_source" | "product_edit_not_supported"; clarificationQuestion: string };

export async function planEcommerceEdit(input: EcommerceEditPlanningRequest, visualAnalysis: EcommerceVisualAnalysis, candidates: EcommerceRoleCandidate[]): Promise<EcommerceEditPlanningResult> {
    assertRoleCandidates(candidates, "edit_planning");
    if (!candidates.length) throw new EcommerceEditPlanningError("编辑规划角色没有可用模型", 503);
    if (input.sources.status !== "resolved" || !input.sources.productAnchorId) throw new EcommerceEditPlanningError("商品参考角色尚未解析完成", 409);
    let latestError: unknown;
    for (const candidate of rankTextPlanningCandidates(candidates)) {
        const messages = editPlanningMessages(input, visualAnalysis, candidate.logicalModelId);
        const idempotencyKey = systemAiIdempotencyKey("ecommerce-edit-planning", input.userId, input.requestId, candidate.logicalModelId, candidate.channelId, candidate.upstreamModel);
        try {
            const call = await requestStructuredText({
                origin: input.origin,
                cookie: input.cookie,
                candidate,
                messages,
                tool: ecommerceEditPlanningTool,
                headers: systemAiBillingHeaders(candidate.logicalModelId, idempotencyKey, candidate.upstreamModel),
                preferNativeTools: true,
                validateArguments: (argumentsText) => validPlanArguments(argumentsText, input, visualAnalysis, candidate.logicalModelId),
                onInvalidResponse: (headers) => refundInvalidResponse(input.userId, candidate.logicalModelId, headers),
            });
            const plan = await parseValidatedAgentFunctionCall(
                call,
                (value) => normalizePlannedEdit(value, input, visualAnalysis, candidate.logicalModelId),
                () => refundInvalidResponse(input.userId, candidate.logicalModelId, call.headers),
                "编辑规划模型返回的字段不完整",
            );
            return {
                plan,
                modelRole: candidate.snapshot as EcommerceEditPlanningResult["modelRole"],
            };
        } catch (error) {
            latestError = error;
        }
    }
    if (latestError instanceof EcommerceEditPlanningError) throw latestError;
    throw new EcommerceEditPlanningError(latestError instanceof Error ? latestError.message : "编辑规划失败，请检查模型角色配置");
}

export function resolveLocalEditTarget(plan: EcommerceEditPlan, analysis: EcommerceVisualAnalysis): EcommerceLocalEditTargetResolution {
    if (plan.operation !== "local_edit" || !plan.source.currentSceneBaselineId) {
        return { state: "rejected", reason: "invalid_local_edit_source", clarificationQuestion: "局部编辑需要明确引用一张已有场景结果。" };
    }
    const semanticTargets = [...plan.delta.requestedChanges, ...plan.delta.targetObjects, ...plan.delta.targetRegions];
    if (semanticTargets.some(isProtectedProductEdit)) {
        return { state: "rejected", reason: "product_edit_not_supported", clarificationQuestion: "第一期仅支持修改非商品区域，暂不支持商品颜色、材质、结构或包装文字修改。" };
    }
    if (plan.delta.manualRegion) {
        return {
            state: "resolved",
            target: { id: "manual-region", kind: "environment", label: "manual region", region: copyRegion(plan.delta.manualRegion), source: "manual" },
        };
    }
    const baseline = analysis.references.find((reference) => reference.assetId === plan.source.currentSceneBaselineId && reference.role === "scene");
    if (!baseline) return { state: "needs_review", reason: "missing_target", clarificationQuestion: "无法确认当前场景中的可编辑区域，请重新选择一张清晰的历史结果。" };
    const requestedIds = new Set([...plan.delta.targetObjects, ...plan.delta.targetRegions]);
    const matches = baseline.editableTargets.filter((target) => requestedIds.has(target.id));
    if (matches.length > 1) {
        return { state: "needs_review", reason: "multiple_matching_targets", clarificationQuestion: "检测到多个可编辑目标，请明确要修改哪一个位置或物品。" };
    }
    if (matches.length !== 1 || [...requestedIds].some((id) => !baseline.editableTargets.some((target) => target.id === id))) {
        return { state: "needs_review", reason: "missing_target", clarificationQuestion: "无法唯一定位要修改的非商品区域，请补充具体位置或物品。" };
    }
    return { state: "resolved", target: { ...matches[0], region: copyRegion(matches[0].region), source: "analysis" } };
}

export function normalizePlannedEdit(value: unknown, input: EcommerceEditPlanningRequest, visualAnalysis: EcommerceVisualAnalysis, planningLogicalModelId: string): EcommerceEditPlan | null {
    if (!isRecord(value)) return null;
    const compatible = normalizePlannerOutput(value, input, visualAnalysis, planningLogicalModelId);
    if (!compatible) return null;
    try {
        validateEcommerceEditPlan(compatible as EcommerceEditPlan);
    } catch (error) {
        const message = error instanceof Error ? error.message : "计划字段无效";
        if (message.includes("商品核心保护项")) throw new EcommerceEditPlanningError(message);
        throw new EcommerceEditPlanningError(`编辑规划模型返回的字段不完整：${message}`);
    }
    const plan = normalizeEcommerceEditPlan(compatible);
    if (!plan) return null;
    const canonicalPlan = canonicalizeVisualBaseline(plan, input, visualAnalysis);
    validatePlanBoundary(canonicalPlan, input, visualAnalysis, planningLogicalModelId);
    return canonicalPlan;
}

function normalizePlannerOutput(value: unknown, input: EcommerceEditPlanningRequest, visualAnalysis: EcommerceVisualAnalysis, planningLogicalModelId: string) {
    if (!isRecord(value)) return null;
    const planner = unwrapPlannerEnvelope(value);
    if (planner.planVersion === "ecommerce-edit.v1") return planner;

    const source = plannerRecord(planner.source);
    const operation = plannerText(planner.operation);
    const deltaCandidate = plannerRecord(planner.delta);
    const hasSceneMarker = Boolean(
        plannerText(source.productAssetId) || plannerText(source.product_asset_id) || plannerText(source.sceneReferenceAssetId) || plannerText(source.scene_reference_asset_id) || plannerText(source.inputType) || plannerText(source.input_type),
    );
    const isSceneGenerationContract = /scene|composit|product[_ -]?to[_ -]?scene/i.test(operation) || hasSceneMarker || Array.isArray(deltaCandidate.environmentElements);
    if (!isSceneGenerationContract) return planner;

    const productReference = visualAnalysis.references.find((reference) => reference.role === "product" && reference.assetId === input.sources.productAnchorId);
    const sceneReference = visualAnalysis.references.find((reference) => {
        if (reference.role !== "scene") return false;
        const ids = [input.sources.currentSceneBaselineId, ...input.sources.sceneReferenceIds].filter((id): id is string => Boolean(id));
        return ids.includes(reference.assetId);
    });
    const baseline = plannerRecord(planner.baseline);
    const rawProductFacts = plannerRecord(baseline.productFacts);
    const rawSceneFacts = plannerRecord(baseline.sceneFacts);
    const delta = plannerRecord(planner.delta);
    const preserve = plannerRecord(planner.preserve);
    const roles = plannerRecord(planner.modelRoles || planner.model_roles);
    const continuity = plannerRecord(planner.continuity);
    const validation = plannerRecord(planner.validation);
    const productFacts = plannerProductFacts(rawProductFacts, productReference?.productFacts);
    const sceneFacts = {
        space: plannerText(rawSceneFacts.space) || plannerText(rawSceneFacts.environment) || sceneReference?.sceneFacts?.space || "bright modern minimalist home interior",
        composition: plannerText(rawSceneFacts.composition) || plannerText(delta.composition) || sceneReference?.sceneFacts?.composition || "product-centered eye-level view with clear depth and generous negative space",
        lighting: plannerText(rawSceneFacts.lighting) || plannerText(delta.lighting) || sceneReference?.sceneFacts?.lighting || "soft natural window daylight with gentle shadows",
    };
    const requestedChanges = plannerStrings(delta.requestedChanges);
    for (const item of [delta.background, delta.lighting, delta.composition, delta.style, delta.mood]) {
        if (typeof item === "string" && item.trim()) requestedChanges.push(item.trim());
    }
    requestedChanges.push(...plannerStrings(delta.environmentElements));
    const productCore = plannerStrings(preserve.productCore);
    for (const [name, aliases] of [
        ["outline", ["outline", "geometry", "surfaceDetails"]],
        ["brand_text", ["brandText", "productIdentity"]],
        ["color", ["color"]],
        ["material", ["material", "woodMaterial", "woodGrain"]],
        ["scale", ["scale", "proportions"]],
        ["view", ["view", "frontView"]],
    ] as const) {
        if (aliases.some((alias) => preserve[alias] === true) || !productCore.includes(name)) productCore.push(name);
    }
    const checks = plannerStrings(validation.requiredChecks);
    if (!checks.length && Array.isArray(validation.checks)) {
        checks.push(
            ...validation.checks.flatMap((check) => {
                const record = plannerRecord(check);
                const name = plannerText(record.name);
                const criterion = plannerText(record.criterion);
                return name && criterion ? [`${name}: ${criterion}`] : name ? [name] : [];
            }),
        );
    }
    if (!checks.length) checks.push("product_identity", "product_outline", "product_material", "scene_composite");
    const sourceProductId = input.sources.productAnchorId;
    const sourceSceneId =
        plannerText(source.currentSceneBaselineId) || plannerText(source.current_scene_baseline_id) || plannerText(source.sceneReferenceAssetId) || plannerText(source.scene_reference_asset_id) || input.sources.currentSceneBaselineId || null;
    const sceneReferenceIds = plannerStrings(source.sceneReferenceIds || source.scene_reference_ids).filter((id) => id !== sourceProductId);
    if (!sceneReferenceIds.length) {
        sceneReferenceIds.push(...input.sources.sceneReferenceIds.filter((id) => id !== sourceProductId));
    }
    if (!sceneReferenceIds.length && sourceSceneId && sourceSceneId !== sourceProductId) sceneReferenceIds.push(sourceSceneId);
    const parentResultId = continuity.parentResultId === null ? null : plannerText(continuity.parentResultId) || input.sources.parentResultId || null;
    const branchId = plannerText(continuity.branchId) || input.branchId;
    return {
        planVersion: "ecommerce-edit.v1",
        operation: operation === "local_edit" ? "local_edit" : "product_to_scene",
        source: { productAnchorId: sourceProductId, currentSceneBaselineId: sourceSceneId, sceneReferenceIds },
        baseline: { productFacts, sceneFacts },
        delta: {
            requestedChanges: [...new Set(requestedChanges)],
            targetObjects: plannerStrings(delta.targetObjects).length ? plannerStrings(delta.targetObjects) : ["scene"],
            targetRegions: plannerStrings(delta.targetRegions).length ? plannerStrings(delta.targetRegions) : ["background", "environment"],
            ...(plannerRecord(delta.manualRegion).width !== undefined ? { manualRegion: delta.manualRegion } : {}),
        },
        preserve: { productCore: [...new Set(productCore)], sceneElements: plannerStrings(preserve.sceneElements) },
        strategy: "strict_product",
        modelRoles: {
            visionAnalysis: plannerText(roles.visionAnalysis) || visualAnalysis.modelRole.logicalModelId,
            editPlanning: plannerText(roles.editPlanning) || planningLogicalModelId,
            generation: plannerText(roles.generation) || input.generationModelRole,
            qualityCheck: plannerText(roles.qualityCheck) || input.qualityCheckModelRole,
        },
        continuity: { parentResultId, branchId },
        validation: { requiredChecks: checks },
    };
}

function unwrapPlannerEnvelope(value: Record<string, unknown>) {
    for (const key of ["plan", "editPlan", "ecommerceEditPlan", "data", "result"]) {
        const nested = value[key];
        if (!isRecord(nested)) continue;
        const source = plannerRecord(nested.source);
        if (nested.planVersion !== undefined || nested.operation !== undefined || Object.keys(source).length > 0) {
            return nested;
        }
    }
    return value;
}

function plannerProductFacts(value: Record<string, unknown>, fallback: unknown) {
    const source = plannerRecord(fallback);
    return {
        identity: plannerText(value.identity) || plannerText(source.identity) || "product",
        outline: plannerText(value.outline) || plannerText(source.outline) || "product outline",
        color: plannerText(value.color) || plannerText(source.color) || "original color",
        material: plannerText(value.material) || plannerText(source.material) || "original material",
        brandText: plannerStrings(value.brandText).length ? plannerStrings(value.brandText) : plannerStrings(source.brandText),
        view: plannerText(value.view) || plannerText(source.view) || "front view",
    };
}

function plannerRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function plannerText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function plannerStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function canonicalizeVisualBaseline(plan: EcommerceEditPlan, input: EcommerceEditPlanningRequest, analysis: EcommerceVisualAnalysis): EcommerceEditPlan {
    const productFacts = analysis.references.find((reference) => reference.role === "product" && reference.assetId === input.sources.productAnchorId)?.productFacts;
    const sceneIds = [input.sources.currentSceneBaselineId, ...input.sources.sceneReferenceIds].filter((id): id is string => Boolean(id));
    const sceneFacts = analysis.references.find((reference) => reference.role === "scene" && sceneIds.includes(reference.assetId))?.sceneFacts;
    if (!productFacts) throw new EcommerceEditPlanningError("视觉分析没有确认商品主参考图", 409);
    return {
        ...plan,
        baseline: {
            productFacts: { ...productFacts, brandText: [...productFacts.brandText] },
            sceneFacts: sceneFacts ? { ...sceneFacts } : plan.baseline.sceneFacts,
        },
    };
}

function validatePlanBoundary(plan: EcommerceEditPlan, input: EcommerceEditPlanningRequest, analysis: EcommerceVisualAnalysis, planningLogicalModelId: string) {
    const product = analysis.references.find((reference) => reference.role === "product" && reference.assetId === input.sources.productAnchorId);
    const sceneSourceId = input.sources.currentSceneBaselineId || input.sources.sceneReferenceIds[0];
    const scene = sceneSourceId ? analysis.references.find((reference) => reference.role === "scene" && reference.assetId === sceneSourceId) : undefined;
    if (!product?.productFacts) throw new EcommerceEditPlanningError("视觉分析没有确认商品主参考图", 409);
    if (sceneSourceId && !scene?.sceneFacts) throw new EcommerceEditPlanningError("视觉分析没有确认当前场景图", 409);
    if (plan.source.productAnchorId !== input.sources.productAnchorId || plan.source.currentSceneBaselineId !== input.sources.currentSceneBaselineId || !sameStrings(plan.source.sceneReferenceIds, input.sources.sceneReferenceIds)) {
        throw new EcommerceEditPlanningError("编辑计划不得更换已解析的商品或场景来源");
    }
    if (!sameProductFacts(plan.baseline.productFacts, product.productFacts)) throw new EcommerceEditPlanningError("编辑计划中的商品基线与视觉分析不一致");
    if (scene?.sceneFacts && !sameSceneFacts(plan.baseline.sceneFacts, scene.sceneFacts)) throw new EcommerceEditPlanningError("编辑计划中的场景基线与视觉分析不一致");
    const expectedRoles = {
        visionAnalysis: analysis.modelRole.logicalModelId,
        editPlanning: planningLogicalModelId,
        generation: input.generationModelRole,
        qualityCheck: input.qualityCheckModelRole,
    };
    if (Object.entries(expectedRoles).some(([key, expected]) => plan.modelRoles[key as keyof typeof expectedRoles] !== expected)) {
        throw new EcommerceEditPlanningError("编辑计划不得改写已配置的模型角色");
    }
    if (plan.continuity.parentResultId !== input.sources.parentResultId || plan.continuity.branchId !== input.branchId) {
        throw new EcommerceEditPlanningError("编辑计划不得改写连续编辑关系");
    }
    if (isAdjacentPropAddition(input.planningInput.userRequest) && targetsProductCore(plan)) {
        throw new EcommerceEditPlanningError("新增到商品旁边的道具必须规划为场景编辑，不能修改商品本体");
    }
}

function editPlanningMessages(input: EcommerceEditPlanningRequest, analysis: EcommerceVisualAnalysis, planningLogicalModelId: string) {
    return [
        {
            role: "system" as const,
            content:
                "你是电商图片编辑规划模型。把用户一句话转换为基线加增量的 EcommerceEditPlan。商品主参考、场景参考和连续编辑来源由服务端确定，不得交换。local_edit 的 targetObjects 必须只填写视觉分析 editableTargets 中的精确 ID；没有唯一候选时不得猜测坐标或目标。新增到商品旁边或周围的道具属于场景增量，不得写入 product_core 或商品本体。默认 strict_product；此策略下 preserve.productCore 必须是字符串数组，并逐项包含且只能依赖以下六个商品保护项：outline、brand_text、color、material、scale、view。即使某项看似未变化，也必须保留该项。",
        },
        {
            role: "user" as const,
            content: JSON.stringify({
                userRequest: input.planningInput.userRequest,
                conversationContext: input.planningInput.conversationContext,
                sources: input.sources,
                visualAnalysis: analysis,
                requiredModelRoles: {
                    visionAnalysis: analysis.modelRole.logicalModelId,
                    editPlanning: planningLogicalModelId,
                    generation: input.generationModelRole,
                    qualityCheck: input.qualityCheckModelRole,
                },
                continuity: { parentResultId: input.sources.parentResultId, branchId: input.branchId },
            }),
        },
    ];
}

function validPlanArguments(value: string, input: EcommerceEditPlanningRequest, analysis: EcommerceVisualAnalysis, planningLogicalModelId: string) {
    try {
        const parsed = JSON.parse(value);
        const plan = normalizePlannedEdit(parsed, input, analysis, planningLogicalModelId);
        if (!plan) {
            console.warn("[ecommerce-edit-planner] planner contract not recognized", JSON.stringify(plannerDebugSummary(parsed)));
        }
        return Boolean(plan);
    } catch (error) {
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(value);
        } catch {
            // The structured runtime already reports invalid JSON separately.
        }
        console.warn("[ecommerce-edit-planner] planner contract rejected", JSON.stringify({ error: error instanceof Error ? error.message : "unknown", ...plannerDebugSummary(parsed) }));
        return false;
    }
}

function plannerDebugSummary(value: unknown) {
    if (!isRecord(value)) return { type: typeof value };
    const planner = unwrapPlannerEnvelope(value);
    const source = plannerRecord(planner.source);
    const delta = plannerRecord(planner.delta);
    return {
        keys: Object.keys(value).slice(0, 24),
        unwrappedKeys: Object.keys(planner).slice(0, 24),
        operation: plannerText(planner.operation),
        sourceKeys: Object.keys(source).slice(0, 24),
        deltaKeys: Object.keys(delta).slice(0, 24),
    };
}

function isAdjacentPropAddition(value: string) {
    const text = value.toLowerCase();
    return /(?:add|place|put|新增|增加|添加|放置)/i.test(text) && /(?:next\s+to|beside|near|旁边|旁侧|附近|周围)/i.test(text);
}

function targetsProductCore(plan: EcommerceEditPlan) {
    return [...plan.delta.targetObjects, ...plan.delta.targetRegions].some((value) => /product[\s_-]*(?:body|core)|商品(?:本体|主体|核心)/i.test(value));
}

function isProtectedProductEdit(value: string) {
    return /product[\s_-]*(?:body|core|color|material|structure|packaging|text)|商品(?:本体|主体|核心|颜色|材质|结构|包装|文字)|产品(?:本体|主体|核心|颜色|材质|结构|包装|文字)/i.test(value);
}

function copyRegion(region: EcommerceNormalizedRegion): EcommerceNormalizedRegion {
    return { x: region.x, y: region.y, width: region.width, height: region.height };
}

function sameProductFacts(left: EcommerceEditPlan["baseline"]["productFacts"], right: EcommerceEditPlan["baseline"]["productFacts"]) {
    return left.identity === right.identity && left.outline === right.outline && left.color === right.color && left.material === right.material && left.view === right.view && sameStrings(left.brandText, right.brandText);
}

function sameSceneFacts(left: EcommerceEditPlan["baseline"]["sceneFacts"], right: EcommerceEditPlan["baseline"]["sceneFacts"]) {
    return left.space === right.space && left.composition === right.composition && left.lighting === right.lighting;
}

function sameStrings(left: string[], right: string[]) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertRoleCandidates(candidates: EcommerceRoleCandidate[], expected: "edit_planning"): void {
    if (candidates.some((candidate) => candidate.logicalRole !== expected || candidate.capability !== "text")) {
        throw new EcommerceEditPlanningError(`模型候选角色必须是 ${expected}`, 400);
    }
}

async function refundInvalidResponse(userId: string, logicalModelId: string, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, logicalModelId, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const stringArray = { type: "array", items: { type: "string" } };
const productFacts = {
    type: "object",
    properties: {
        identity: { type: "string" },
        outline: { type: "string" },
        color: { type: "string" },
        material: { type: "string" },
        brandText: stringArray,
        view: { type: "string" },
    },
    required: ["identity", "outline", "color", "material", "brandText", "view"],
    additionalProperties: false,
};
const sceneFacts = {
    type: "object",
    properties: { space: { type: "string" }, composition: { type: "string" }, lighting: { type: "string" } },
    required: ["space", "composition", "lighting"],
    additionalProperties: false,
};

export const ecommerceEditPlanningTool = {
    name: "plan_ecommerce_edit",
    description: "根据已验证的商品与场景视觉事实生成 EcommerceEditPlan",
    parameters: {
        type: "object",
        properties: {
            planVersion: { type: "string", enum: ["ecommerce-edit.v1"] },
            operation: { type: "string", enum: ["product_to_scene", "local_edit"] },
            source: {
                type: "object",
                properties: {
                    productAnchorId: { type: "string" },
                    currentSceneBaselineId: { anyOf: [{ type: "string" }, { type: "null" }] },
                    sceneReferenceIds: { type: "array", maxItems: 1, items: { type: "string" } },
                },
                required: ["productAnchorId", "currentSceneBaselineId", "sceneReferenceIds"],
                additionalProperties: false,
            },
            baseline: {
                type: "object",
                properties: { productFacts, sceneFacts },
                required: ["productFacts", "sceneFacts"],
                additionalProperties: false,
            },
            delta: {
                type: "object",
                properties: {
                    requestedChanges: stringArray,
                    targetObjects: stringArray,
                    targetRegions: stringArray,
                    manualRegion: {
                        type: "object",
                        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
                        required: ["x", "y", "width", "height"],
                        additionalProperties: false,
                    },
                },
                required: ["requestedChanges", "targetObjects", "targetRegions"],
                additionalProperties: false,
            },
            preserve: {
                type: "object",
                properties: { productCore: stringArray, sceneElements: stringArray },
                required: ["productCore", "sceneElements"],
                additionalProperties: false,
            },
            strategy: { type: "string", enum: ["strict_product", "integrated_scene", "creative_variation"] },
            modelRoles: {
                type: "object",
                properties: {
                    visionAnalysis: { type: "string" },
                    editPlanning: { type: "string" },
                    generation: { type: "string" },
                    qualityCheck: { type: "string" },
                },
                required: ["visionAnalysis", "editPlanning", "generation", "qualityCheck"],
                additionalProperties: false,
            },
            continuity: {
                type: "object",
                properties: { parentResultId: { anyOf: [{ type: "string" }, { type: "null" }] }, branchId: { type: "string" } },
                required: ["parentResultId", "branchId"],
                additionalProperties: false,
            },
            validation: {
                type: "object",
                properties: { requiredChecks: stringArray },
                required: ["requiredChecks"],
                additionalProperties: false,
            },
        },
        required: ["planVersion", "operation", "source", "baseline", "delta", "preserve", "strategy", "modelRoles", "continuity", "validation"],
        additionalProperties: false,
    },
};
