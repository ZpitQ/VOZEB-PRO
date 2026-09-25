import { refundUserPoints } from "@/lib/auth/store";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";

import { parseValidatedAgentFunctionCall } from "./agent-function-call";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceRoleCandidate, EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import { requestStructuredText } from "./text-planning-runtime";

export const ECOMMERCE_QUALITY_CHECK_VERSION = "ecommerce-quality.v1" as const;
export const ECOMMERCE_QUALITY_CHECK_KEYS = ["product_identity", "product_silhouette", "product_color_material", "product_proportions_view", "brand_logo", "packaging_text", "scene_intent", "composition_lighting"] as const;

export type EcommerceQualityCheckKey = (typeof ECOMMERCE_QUALITY_CHECK_KEYS)[number];
export type EcommerceQualityCheckItem = {
    resultId: string;
    key: EcommerceQualityCheckKey;
    status: "passed" | "failed" | "not_applicable";
    reason: string;
};
export type EcommerceQualityCheck = {
    version: typeof ECOMMERCE_QUALITY_CHECK_VERSION;
    status: "passed" | "needs_adjustment" | "blocked" | "unavailable";
    publicStatus: "passed" | "needs_adjustment" | "needs_review";
    modelRole: EcommerceRoleRouteSnapshot;
    checks: EcommerceQualityCheckItem[];
    hardFailures: EcommerceQualityCheckItem[];
    internalReason: string;
    checkedAt: number;
};
export type EcommerceQualityCheckRequest = {
    origin: string;
    cookie: string;
    userId: string;
    requestId: string;
    plan: EcommerceEditPlan;
    productReference: { assetId: string; url: string };
    resultImages: Array<{ resultId: string; url: string }>;
};

const HARD_CHECKS = new Set<EcommerceQualityCheckKey>(["product_identity", "product_silhouette", "product_color_material", "product_proportions_view", "brand_logo", "packaging_text"]);

export async function checkEcommerceResult(input: EcommerceQualityCheckRequest, candidate: EcommerceRoleCandidate): Promise<EcommerceQualityCheck> {
    try {
        assertQualityRequest(input, candidate);
        const resultIds = input.resultImages.map((item) => item.resultId);
        const idempotencyKey = systemAiIdempotencyKey("ecommerce-quality-check", input.userId, input.requestId, candidate.logicalModelId, candidate.channelId, candidate.upstreamModel);
        const call = await requestStructuredText({
            origin: input.origin,
            cookie: input.cookie,
            candidate,
            messages: await qualityCheckMessages(input),
            tool: ecommerceQualityCheckTool,
            headers: {
                ...qualityImageRequestHeaders(input.cookie),
                ...systemAiBillingHeaders(candidate.logicalModelId, idempotencyKey, candidate.upstreamModel),
            },
            preferNativeTools: true,
            validateArguments: (argumentsText) => parseQualityResult(argumentsText, resultIds) !== null,
            onInvalidResponse: (headers) => refundInvalidResponse(input.userId, candidate.logicalModelId, headers),
        });
        const checks = await parseValidatedAgentFunctionCall(
            call,
            (value) => normalizeQualityResult(value, resultIds),
            () => refundInvalidResponse(input.userId, candidate.logicalModelId, call.headers),
            "结果验收模型返回的字段不完整",
        );
        const hardFailures = checks.filter((item) => HARD_CHECKS.has(item.key) && (item.status === "failed" || (item.status === "not_applicable" && requiresVisibleProductEvidence(item.key, input.plan))));
        const failed = checks.filter((item) => item.status === "failed");
        const status = hardFailures.length ? "blocked" : failed.length ? "needs_adjustment" : "passed";
        return {
            version: ECOMMERCE_QUALITY_CHECK_VERSION,
            status,
            publicStatus: status === "blocked" ? "needs_review" : status,
            modelRole: candidate.snapshot,
            checks,
            hardFailures,
            internalReason: hardFailures.length ? hardFailures.map((item) => `${item.resultId}:${item.key}:${item.status}`).join(",") : failed.length ? failed.map((item) => `${item.resultId}:${item.key}`).join(",") : "all required checks passed",
            checkedAt: Date.now(),
        };
    } catch (error) {
        return unavailableEcommerceQualityCheck(error instanceof Error ? error.message : "结果验收模型不可用", candidate.snapshot);
    }
}

function requiresVisibleProductEvidence(key: EcommerceQualityCheckKey, plan: EcommerceEditPlan) {
    if (key === "brand_logo" || key === "packaging_text") return plan.baseline.productFacts.brandText.length > 0;
    return key === "product_identity" || key === "product_silhouette" || key === "product_color_material" || key === "product_proportions_view";
}

export function unavailableEcommerceQualityCheck(reason: string, modelRole: EcommerceRoleRouteSnapshot): EcommerceQualityCheck {
    return {
        version: ECOMMERCE_QUALITY_CHECK_VERSION,
        status: "unavailable",
        publicStatus: "needs_review",
        modelRole: { ...modelRole },
        checks: [],
        hardFailures: [],
        internalReason: reason.trim() || "结果验收模型不可用",
        checkedAt: Date.now(),
    };
}

export function shouldBlockEcommerceResult(check: EcommerceQualityCheck): boolean {
    return check.status === "blocked" || check.status === "unavailable";
}

export function ecommerceQualityGate(check: EcommerceQualityCheck) {
    if (shouldBlockEcommerceResult(check)) {
        return { action: "pause" as const, publicStatus: "needs_review" as const, publicMessage: "商品一致性检查未通过，需要复核。" };
    }
    if (check.status === "needs_adjustment") {
        return { action: "publish" as const, publicStatus: "needs_adjustment" as const, publicMessage: "图片已生成，场景细节可继续调整。" };
    }
    return { action: "publish" as const, publicStatus: "passed" as const, publicMessage: "商品一致性检查通过。" };
}

async function qualityCheckMessages(input: EcommerceQualityCheckRequest) {
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
        {
            type: "text",
            text: JSON.stringify({
                task: "compare_product_reference_with_generated_results",
                productAssetId: input.productReference.assetId,
                plan: {
                    operation: input.plan.operation,
                    baseline: input.plan.baseline,
                    delta: input.plan.delta,
                    preserve: input.plan.preserve,
                    strategy: input.plan.strategy,
                    requiredChecks: input.plan.validation.requiredChecks,
                },
                resultIds: input.resultImages.map((item) => item.resultId),
            }),
        },
        { type: "text", text: `productReference=${input.productReference.assetId}` },
        { type: "image_url", image_url: { url: await normalizeQualityImage(input.productReference.url, input.origin, input.cookie) } },
    ];
    for (const result of input.resultImages) {
        content.push({ type: "text", text: `resultId=${result.resultId}` }, { type: "image_url", image_url: { url: await normalizeQualityImage(result.url, input.origin, input.cookie) } });
    }
    return [
        {
            role: "system" as const,
            content:
                "你是电商商品图片结果验收模型。逐张比较生成结果与唯一商品参考图。商品身份、轮廓、颜色与材质、比例与视角、品牌 Logo、包装文字属于硬检查；场景意图、构图与光线属于软检查。只根据实际可见证据判断，无法适用时返回 not_applicable，不得用场景美感掩盖商品变化。必须调用 check_ecommerce_results，并为每个 resultId 返回全部八项检查；reason 只写简短事实，不输出推理过程。",
        },
        { role: "user" as const, content },
    ];
}

async function normalizeQualityImage(value: string, origin: string, cookie: string) {
    const source = value.trim();
    const dataMatch = source.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
    if (dataMatch) {
        const bytes = Buffer.from(dataMatch[2], "base64");
        if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new Error("结果验收图片无效或过大");
        return `data:${dataMatch[1].toLowerCase()};base64,${bytes.toString("base64")}`;
    }
    if (/^https:\/\//i.test(source)) return source;
    if (!source.startsWith("/api/")) throw new Error("结果验收图片地址无效");
    const response = await fetchInternalApi(`${origin}${source}`, {
        headers: qualityImageRequestHeaders(cookie),
        cache: "no-store",
    });
    if (!response.ok) throw new Error("无法读取结果验收图片");
    const mimeType = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!mimeType.startsWith("image/") || contentLength > CREATIVE_UPLOAD_MAX_BYTES) throw new Error("结果验收图片无效或过大");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new Error("结果验收图片无效或过大");
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function qualityImageRequestHeaders(credential: string): Record<string, string> {
    const normalized = credential.trim();
    if (normalized.startsWith("vozeb-worker-v1.")) {
        const workerHeaders = maintenanceWorkerContextHeaders(normalized);
        if (!workerHeaders) throw new Error("quality worker credential invalid");
        return workerHeaders;
    }
    return normalized ? { cookie: normalized } : {};
}

function assertQualityRequest(input: EcommerceQualityCheckRequest, candidate: EcommerceRoleCandidate) {
    if (candidate.logicalRole !== "quality_check" || candidate.capability !== "text") throw new Error("结果验收模型角色无效");
    if (!input.productReference.assetId.trim() || !input.productReference.url.trim()) throw new Error("商品参考图不可用");
    if (!input.resultImages.length || new Set(input.resultImages.map((item) => item.resultId)).size !== input.resultImages.length || input.resultImages.some((item) => !item.resultId.trim() || !item.url.trim())) {
        throw new Error("生成结果图片不可用");
    }
}

function parseQualityResult(value: string, resultIds: string[]) {
    try {
        return normalizeQualityResult(JSON.parse(value), resultIds);
    } catch {
        return null;
    }
}

function normalizeQualityResult(value: unknown, resultIds: string[]): EcommerceQualityCheckItem[] | null {
    if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== resultIds.length) return null;
    const expectedIds = new Set(resultIds);
    const seenIds = new Set<string>();
    const checks: EcommerceQualityCheckItem[] = [];
    for (const result of value.results) {
        if (!isRecord(result) || typeof result.resultId !== "string" || !expectedIds.has(result.resultId) || seenIds.has(result.resultId) || !Array.isArray(result.checks)) return null;
        seenIds.add(result.resultId);
        const seenKeys = new Set<EcommerceQualityCheckKey>();
        for (const check of result.checks) {
            if (!isRecord(check) || !isQualityKey(check.key) || seenKeys.has(check.key) || !["passed", "failed", "not_applicable"].includes(String(check.status)) || typeof check.reason !== "string" || !check.reason.trim()) {
                return null;
            }
            seenKeys.add(check.key);
            checks.push({ resultId: result.resultId, key: check.key, status: check.status as EcommerceQualityCheckItem["status"], reason: check.reason.trim() });
        }
        if (seenKeys.size !== ECOMMERCE_QUALITY_CHECK_KEYS.length || ECOMMERCE_QUALITY_CHECK_KEYS.some((key) => !seenKeys.has(key))) return null;
    }
    return seenIds.size === expectedIds.size ? checks : null;
}

function isQualityKey(value: unknown): value is EcommerceQualityCheckKey {
    return typeof value === "string" && (ECOMMERCE_QUALITY_CHECK_KEYS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function refundInvalidResponse(userId: string, logicalModelId: string, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, logicalModelId, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}

export const ecommerceQualityCheckTool = {
    name: "check_ecommerce_results",
    description: "比较商品参考图与生成结果，返回商品硬检查和场景软检查",
    parameters: {
        type: "object",
        properties: {
            results: {
                type: "array",
                minItems: 1,
                items: {
                    type: "object",
                    properties: {
                        resultId: { type: "string" },
                        checks: {
                            type: "array",
                            minItems: ECOMMERCE_QUALITY_CHECK_KEYS.length,
                            maxItems: ECOMMERCE_QUALITY_CHECK_KEYS.length,
                            items: {
                                type: "object",
                                properties: {
                                    key: { type: "string", enum: [...ECOMMERCE_QUALITY_CHECK_KEYS] },
                                    status: { type: "string", enum: ["passed", "failed", "not_applicable"] },
                                    reason: { type: "string" },
                                },
                                required: ["key", "status", "reason"],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ["resultId", "checks"],
                    additionalProperties: false,
                },
            },
        },
        required: ["results"],
        additionalProperties: false,
    },
};
