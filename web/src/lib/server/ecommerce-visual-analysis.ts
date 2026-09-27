import { refundUserPoints } from "@/lib/auth/store";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";

import { parseValidatedAgentFunctionCall } from "./agent-function-call";
import type { EcommerceProductFacts, EcommerceSceneFacts } from "./ecommerce-edit-plan";
import type { EcommercePlanningAssetCandidate, EcommercePlanningInput } from "./ecommerce-generation-snapshot";
import type { EcommerceRoleCandidate, EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import { rankTextPlanningCandidates, requestStructuredText } from "./text-planning-runtime";

export const ECOMMERCE_VISUAL_ANALYSIS_VERSION = "ecommerce-visual-analysis.v1" as const;

export type EcommerceNormalizedRegion = { x: number; y: number; width: number; height: number };
export type EcommerceEditableTargetKind = "background" | "environment" | "prop" | "lighting" | "shadow";
export type EcommerceEditableTarget = {
    id: string;
    kind: EcommerceEditableTargetKind;
    label: string;
    region: EcommerceNormalizedRegion;
};
export type EcommerceVisualReference = {
    assetId: string;
    role: "product" | "scene" | "unknown";
    confidence: "high" | "medium" | "low";
    visualEvidence: {
        whiteBackground: boolean;
        transparentBackground: boolean;
        isolatedSubject: boolean;
        completeScene: boolean;
    };
    productFacts: EcommerceProductFacts | null;
    sceneFacts: EcommerceSceneFacts | null;
    productCore: EcommerceNormalizedRegion | null;
    fusionHalo: EcommerceNormalizedRegion | null;
    editableTargets: EcommerceEditableTarget[];
};
export type EcommerceVisualAnalysisContract = {
    analysisVersion: typeof ECOMMERCE_VISUAL_ANALYSIS_VERSION;
    references: EcommerceVisualReference[];
};
export type EcommerceVisualAnalysis = EcommerceVisualAnalysisContract & {
    modelRole: Pick<EcommerceRoleRouteSnapshot, "logicalModelId" | "channelId" | "upstreamModel"> & Partial<Pick<EcommerceRoleRouteSnapshot, "capability" | "apiFormat">> & { logicalRole: "vision_analysis" };
};
export type EcommerceVisualAnalysisRequest = {
    origin: string;
    cookie: string;
    userId: string;
    requestId: string;
    planningInput: EcommercePlanningInput;
};

export class EcommerceVisualAnalysisError extends Error {
    constructor(
        message: string,
        readonly status = 502,
    ) {
        super(message);
        this.name = "EcommerceVisualAnalysisError";
    }
}

export async function analyzeEcommerceReferences(input: EcommerceVisualAnalysisRequest, candidates: EcommerceRoleCandidate[]): Promise<EcommerceVisualAnalysis> {
    assertRoleCandidates(candidates, "vision_analysis");
    if (!candidates.length) throw new EcommerceVisualAnalysisError("视觉分析角色没有可用模型", 503);
    const assets = input.planningInput.assetCandidates;
    if (!assets.length || assets.length > 2 || assets.some((asset) => asset.type !== "image" || !asset.url?.trim())) {
        throw new EcommerceVisualAnalysisError("视觉分析需要一至两张可访问的图片", 400);
    }
    const images = await Promise.all(assets.map((asset) => normalizePlanningImage(asset.url!, input.origin, input.cookie)));
    const messages = visualAnalysisMessages(input.planningInput, assets, images);
    let latestError: unknown;
    for (const candidate of rankTextPlanningCandidates(candidates)) {
        const idempotencyKey = systemAiIdempotencyKey("ecommerce-visual-analysis", input.userId, input.requestId, candidate.logicalModelId, candidate.channelId, candidate.upstreamModel);
        try {
            const call = await requestStructuredText({
                origin: input.origin,
                cookie: input.cookie,
                candidate,
                messages,
                tool: ecommerceVisualAnalysisTool,
                headers: systemAiBillingHeaders(candidate.logicalModelId, idempotencyKey, candidate.upstreamModel),
                preferNativeTools: true,
                validateArguments: (argumentsText) => parseAnalysis(argumentsText, assets) !== null,
                onInvalidResponse: (headers) => refundInvalidResponse(input.userId, candidate.logicalModelId, headers),
            });
            const analysis = await parseValidatedAgentFunctionCall(
                call,
                (value) => normalizeEcommerceVisualAnalysis(value, assets),
                () => refundInvalidResponse(input.userId, candidate.logicalModelId, call.headers),
                "视觉分析模型返回的字段不完整",
            );
            return {
                ...analysis,
                modelRole: candidate.snapshot as EcommerceVisualAnalysis["modelRole"],
            };
        } catch (error) {
            latestError = error;
        }
    }
    if (latestError instanceof EcommerceVisualAnalysisError) throw latestError;
    throw new EcommerceVisualAnalysisError(latestError instanceof Error ? latestError.message : "视觉分析失败，请检查模型角色配置");
}

export function normalizeEcommerceVisualAnalysis(value: unknown, assets: EcommercePlanningAssetCandidate[]): EcommerceVisualAnalysisContract | null {
    if (!isRecord(value) || value.analysisVersion !== ECOMMERCE_VISUAL_ANALYSIS_VERSION || !Array.isArray(value.references)) return null;
    const expectedIds = new Set(assets.map((asset) => asset.id));
    if (expectedIds.size !== assets.length || value.references.length !== assets.length) return null;
    const references = value.references.map(normalizeReference);
    if (references.some((reference) => !reference)) return null;
    const normalized = references as EcommerceVisualReference[];
    const actualIds = new Set(normalized.map((reference) => reference.assetId));
    if (actualIds.size !== normalized.length || actualIds.size !== expectedIds.size || [...actualIds].some((id) => !expectedIds.has(id))) return null;
    return { analysisVersion: ECOMMERCE_VISUAL_ANALYSIS_VERSION, references: normalized };
}

function normalizeReference(value: unknown): EcommerceVisualReference | null {
    if (!isRecord(value)) return null;
    const assetId = text(value.assetId);
    const role = value.role;
    const confidence = value.confidence;
    const evidence = normalizeEvidence(value.visualEvidence);
    if (!assetId || !["product", "scene", "unknown"].includes(String(role)) || !["high", "medium", "low"].includes(String(confidence)) || !evidence) return null;
    const productFacts = normalizeProductFacts(value.productFacts);
    const sceneFacts = normalizeSceneFacts(value.sceneFacts);
    const productCore = normalizeRegion(value.productCore);
    const fusionHalo = normalizeRegion(value.fusionHalo);
    const editableTargets = normalizeEditableTargets(value.editableTargets);
    if (!editableTargets || Boolean(productCore) !== Boolean(fusionHalo)) return null;
    const productEvidence = evidence.isolatedSubject && (evidence.whiteBackground || evidence.transparentBackground) && !evidence.completeScene;
    const sceneEvidence = evidence.completeScene && !evidence.whiteBackground && !evidence.transparentBackground;
    if (confidence === "high" && role === "product" && !productEvidence) return null;
    if (confidence === "high" && role === "scene" && !sceneEvidence) return null;
    if (role === "product" && (!productFacts || sceneFacts || !productCore || !fusionHalo || editableTargets.length)) return null;
    if (role === "scene" && (productFacts || !sceneFacts)) return null;
    if (role === "unknown" && (productFacts || sceneFacts || productCore || fusionHalo || editableTargets.length)) return null;
    return {
        assetId,
        role: role as EcommerceVisualReference["role"],
        confidence: confidence as EcommerceVisualReference["confidence"],
        visualEvidence: evidence,
        productFacts,
        sceneFacts,
        productCore,
        fusionHalo,
        editableTargets,
    };
}

function normalizeProductFacts(value: unknown): EcommerceProductFacts | null {
    if (!isRecord(value)) return null;
    const brandText = stringArray(value.brandText);
    if (!brandText) return null;
    const facts = {
        identity: text(value.identity),
        outline: text(value.outline),
        color: text(value.color),
        material: text(value.material),
        brandText,
        view: text(value.view),
    };
    return facts.identity && facts.outline && facts.color && facts.material && facts.view ? facts : null;
}

function normalizeSceneFacts(value: unknown): EcommerceSceneFacts | null {
    if (!isRecord(value)) return null;
    const facts = { space: text(value.space), composition: text(value.composition), lighting: text(value.lighting) };
    return facts.space && facts.composition && facts.lighting ? facts : null;
}

function normalizeEvidence(value: unknown) {
    if (!isRecord(value)) return null;
    const keys = ["whiteBackground", "transparentBackground", "isolatedSubject", "completeScene"] as const;
    if (keys.some((key) => typeof value[key] !== "boolean")) return null;
    return Object.fromEntries(keys.map((key) => [key, value[key]])) as EcommerceVisualReference["visualEvidence"];
}

function normalizeRegion(value: unknown): EcommerceNormalizedRegion | null {
    if (value === null) return null;
    if (!isRecord(value)) return null;
    const region = { x: value.x, y: value.y, width: value.width, height: value.height };
    if (Object.values(region).some((item) => typeof item !== "number" || !Number.isFinite(item))) return null;
    const typed = region as EcommerceNormalizedRegion;
    if (typed.x < 0 || typed.y < 0 || typed.width <= 0 || typed.height <= 0 || typed.x + typed.width > 1 || typed.y + typed.height > 1) return null;
    return typed;
}

function normalizeEditableTargets(value: unknown): EcommerceEditableTarget[] | null {
    if (!Array.isArray(value)) return null;
    const targets = value.map((item) => {
        if (!isRecord(item)) return null;
        const id = text(item.id);
        const label = text(item.label);
        const kind = item.kind;
        const region = normalizeRegion(item.region);
        if (!id || !label || !["background", "environment", "prop", "lighting", "shadow"].includes(String(kind)) || !region) return null;
        return { id, kind: kind as EcommerceEditableTargetKind, label, region };
    });
    if (targets.some((target) => !target)) return null;
    const normalized = targets as EcommerceEditableTarget[];
    return new Set(normalized.map((target) => target.id)).size === normalized.length ? normalized : null;
}

function visualAnalysisMessages(planningInput: EcommercePlanningInput, assets: EcommercePlanningAssetCandidate[], images: string[]) {
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
        {
            type: "text",
            text: JSON.stringify({
                userRequest: planningInput.userRequest,
                assets: assets.map((asset) => ({ id: asset.id, title: asset.title, width: asset.width, height: asset.height })),
                rule: "每张图片必须按给定 assetId 独立判断；不得按标题、顺序或用户描述猜测角色。",
            }),
        },
    ];
    assets.forEach((asset, index) => {
        content.push({ type: "text", text: `assetId=${asset.id}` }, { type: "image_url", image_url: { url: images[index] } });
    });
    return [
        {
            role: "system" as const,
            content:
                "你是电商商品视觉分析模型。逐图识别商品或场景，商品事实只能来自商品图，场景事实只能来自场景图。角色约束：role=product 时 productFacts 必须是完整商品事实，sceneFacts 必须为 null，productCore 与 fusionHalo 均不得为 null，fusionHalo 必须完整包围 productCore，editableTargets 必须为空；role=scene 时 productFacts 必须为 null，sceneFacts 必须完整，若场景包含本轮需要保护的商品则同时返回 productCore 与 fusionHalo，否则两者均为 null；role=unknown 时两类事实、两个区域均为 null 且 editableTargets 为空。场景 editableTargets 只列出可安全修改的背景、环境、道具、光线或阴影候选，并给每个候选稳定唯一 ID。不得把商品颜色、材质、结构或包装文字列为可编辑目标。无法可靠判断时使用 unknown，禁止为了完成任务互换角色。区域坐标使用 0 到 1 的归一化坐标。",
        },
        { role: "user" as const, content },
    ];
}

async function normalizePlanningImage(value: string, origin: string, cookie: string) {
    const source = value.trim();
    const dataMatch = source.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
    if (dataMatch) {
        const bytes = Buffer.from(dataMatch[2], "base64");
        if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new EcommerceVisualAnalysisError("视觉分析图片无效或过大", 413);
        return `data:${dataMatch[1].toLowerCase()};base64,${bytes.toString("base64")}`;
    }
    const response = source.startsWith("/api/") ? await fetchInternalApi(`${origin}${source}`, { headers: { cookie }, cache: "no-store" }) : /^https:\/\//i.test(source) ? await fetchSafeOutbound(source, { cache: "no-store" }) : null;
    if (!response?.ok) throw new EcommerceVisualAnalysisError("无法读取视觉分析图片", 400);
    const mimeType = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!mimeType.startsWith("image/") || contentLength > CREATIVE_UPLOAD_MAX_BYTES) throw new EcommerceVisualAnalysisError("视觉分析图片无效或过大", 413);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new EcommerceVisualAnalysisError("视觉分析图片无效或过大", 413);
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function parseAnalysis(value: string, assets: EcommercePlanningAssetCandidate[]) {
    try {
        const parsed = JSON.parse(value);
        const normalized = normalizeEcommerceVisualAnalysis(parsed, assets);
        if (!normalized) {
            console.warn("[ecommerce-visual-analysis] contract rejected", JSON.stringify(visualAnalysisDebugSummary(parsed)));
        }
        return normalized;
    } catch (error) {
        console.warn("[ecommerce-visual-analysis] response was not JSON", JSON.stringify({ error: error instanceof Error ? error.message : "unknown" }));
        return null;
    }
}

function visualAnalysisDebugSummary(value: unknown) {
    if (!isRecord(value)) return { type: typeof value };
    const references = Array.isArray(value.references) ? value.references : [];
    return {
        keys: Object.keys(value).slice(0, 24),
        analysisVersion: text(value.analysisVersion),
        referenceCount: Array.isArray(value.references) ? value.references.length : null,
        referenceKeys: references.slice(0, 2).map((item) => (isRecord(item) ? Object.keys(item).slice(0, 24) : [])),
        referenceIds: references.slice(0, 4).map((item) => (isRecord(item) ? text(item.assetId || item.asset_id || item.id) : "")),
        referenceRoles: references.slice(0, 4).map((item) => (isRecord(item) ? text(item.role || item.assetRole || item.asset_role) : "")),
        referenceValidation: references.slice(0, 2).map((item) =>
            isRecord(item)
                ? {
                      role: text(item.role),
                      confidence: text(item.confidence),
                      visualEvidence:
                          item.visualEvidence === null
                              ? "null"
                              : {
                                    type: typeof item.visualEvidence,
                                    keys: isRecord(item.visualEvidence) ? Object.keys(item.visualEvidence).slice(0, 12) : [],
                                    valid: Boolean(normalizeEvidence(item.visualEvidence)),
                                },
                      productFacts: item.productFacts === null ? "null" : normalizeProductFacts(item.productFacts) ? "valid" : "invalid",
                      sceneFacts: item.sceneFacts === null ? "null" : normalizeSceneFacts(item.sceneFacts) ? "valid" : "invalid",
                      productCore: item.productCore === null ? "null" : { type: typeof item.productCore, keys: isRecord(item.productCore) ? Object.keys(item.productCore).slice(0, 12) : [] },
                      productCoreValid: item.productCore === null ? true : Boolean(normalizeRegion(item.productCore)),
                      fusionHalo: item.fusionHalo === null ? "null" : { type: typeof item.fusionHalo, keys: isRecord(item.fusionHalo) ? Object.keys(item.fusionHalo).slice(0, 12) : [] },
                      fusionHaloValid: item.fusionHalo === null ? true : Boolean(normalizeRegion(item.fusionHalo)),
                      editableTargetCount: Array.isArray(item.editableTargets) ? item.editableTargets.length : null,
                      editableTargetsValid: Boolean(normalizeEditableTargets(item.editableTargets)),
                      referenceValid: Boolean(normalizeReference(item)),
                  }
                : { type: typeof item },
        ),
    };
}

function assertRoleCandidates(candidates: EcommerceRoleCandidate[], expected: "vision_analysis"): void {
    if (candidates.some((candidate) => candidate.logicalRole !== expected || candidate.capability !== "text")) {
        throw new EcommerceVisualAnalysisError(`模型候选角色必须是 ${expected}`, 400);
    }
}

async function refundInvalidResponse(userId: string, logicalModelId: string, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, logicalModelId, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown) {
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.trim()).filter(Boolean) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const regionSchema = {
    anyOf: [
        {
            type: "object",
            properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 }, width: { type: "number", exclusiveMinimum: 0, maximum: 1 }, height: { type: "number", exclusiveMinimum: 0, maximum: 1 } },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
        },
        { type: "null" },
    ],
};

const productFactsSchema = {
    anyOf: [
        {
            type: "object",
            properties: {
                identity: { type: "string" },
                outline: { type: "string" },
                color: { type: "string" },
                material: { type: "string" },
                brandText: { type: "array", items: { type: "string" } },
                view: { type: "string" },
            },
            required: ["identity", "outline", "color", "material", "brandText", "view"],
            additionalProperties: false,
        },
        { type: "null" },
    ],
};

const sceneFactsSchema = {
    anyOf: [
        {
            type: "object",
            properties: { space: { type: "string" }, composition: { type: "string" }, lighting: { type: "string" } },
            required: ["space", "composition", "lighting"],
            additionalProperties: false,
        },
        { type: "null" },
    ],
};

export const ecommerceVisualAnalysisTool = {
    name: "analyze_ecommerce_references",
    description: "逐张分析电商商品图和可选场景参考图，返回严格分离的视觉事实与候选区域",
    parameters: {
        type: "object",
        properties: {
            analysisVersion: { type: "string", enum: [ECOMMERCE_VISUAL_ANALYSIS_VERSION] },
            references: {
                type: "array",
                minItems: 1,
                maxItems: 2,
                items: {
                    type: "object",
                    properties: {
                        assetId: { type: "string" },
                        role: { type: "string", enum: ["product", "scene", "unknown"] },
                        confidence: { type: "string", enum: ["high", "medium", "low"] },
                        visualEvidence: {
                            type: "object",
                            properties: {
                                whiteBackground: { type: "boolean" },
                                transparentBackground: { type: "boolean" },
                                isolatedSubject: { type: "boolean" },
                                completeScene: { type: "boolean" },
                            },
                            required: ["whiteBackground", "transparentBackground", "isolatedSubject", "completeScene"],
                            additionalProperties: false,
                        },
                        productFacts: productFactsSchema,
                        sceneFacts: sceneFactsSchema,
                        productCore: regionSchema,
                        fusionHalo: regionSchema,
                        editableTargets: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    kind: { type: "string", enum: ["background", "environment", "prop", "lighting", "shadow"] },
                                    label: { type: "string" },
                                    region: regionSchema.anyOf[0],
                                },
                                required: ["id", "kind", "label", "region"],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ["assetId", "role", "confidence", "visualEvidence", "productFacts", "sceneFacts", "productCore", "fusionHalo", "editableTargets"],
                    additionalProperties: false,
                },
            },
        },
        required: ["analysisVersion", "references"],
        additionalProperties: false,
    },
};
