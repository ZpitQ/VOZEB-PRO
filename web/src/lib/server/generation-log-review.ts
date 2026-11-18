import type { GenerationLogEvaluation, GenerationLogEvidence, GenerationLogReviewReport } from "@/lib/generation-log-evaluation";
import type { StoredGenerationLog } from "./generation-log-types";

export const GENERATION_LOG_REVIEW_RULE_VERSION = "generation-log-process-review.v1";
export const GENERATION_LOG_REVIEW_LIMITATION = "仅分析文字记录和产物元数据，未查看图片或视频；不能判断画面质量或推断用户满意度。";

export function buildGenerationLogEvidence(log: StoredGenerationLog, evaluations: GenerationLogEvaluation[]): GenerationLogEvidence[] {
    const snapshot = log.requestSnapshot;
    return [
        {
            id: "request",
            label: "用户需求与执行",
            facts: {
                userPrompt: snapshot?.userPrompt || null,
                parameters: snapshot?.parameters,
                run: snapshot?.run,
                executionPrompts: snapshot?.slots.map((slot) => ({ taskId: slot.taskId, prompt: slot.prompt, attempts: slot.attempts, billing: slot.billing })),
            },
        },
        {
            id: "delivery",
            label: "交付事实",
            facts: { status: log.status, count: log.count, successCount: log.successCount, failCount: log.failCount, model: log.model, createdAt: log.createdAt, completedAt: log.completedAt, durationMs: log.durationMs, error: log.error },
        },
        {
            id: "references",
            label: "参考素材身份和顺序",
            facts:
                snapshot?.references.map((reference) => ({
                    id: reference.id,
                    name: reference.name,
                    alias: reference.alias,
                    purposes: reference.purposes,
                    providerIndex: reference.providerIndex,
                    sha256: reference.sha256,
                    width: reference.width,
                    height: reference.height,
                })) || [],
        },
        ...log.assets.map((asset, index) => ({
            id: `result:${index + 1}`,
            label: `产物 ${index + 1} 元数据（未看图）`,
            facts: {
                resultId: asset.resultId,
                type: asset.type,
                width: asset.width,
                height: asset.height,
                mimeType: asset.mimeType,
                bytes: asset.bytes,
                sha256: asset.nativeSource?.sha256,
                enhancement: asset.enhancement
                    ? { status: asset.enhancement.status, reason: asset.enhancement.reason, timings: asset.enhancement.timings, native: dimensions(asset.enhancement.native), delivered: dimensions(asset.enhancement.enhanced) }
                    : asset.enhancementSkip,
            },
        })),
        ...(log.ecommerceTrace?.stages.map((stage) => ({
            id: `stage:${stage.key}`,
            label: stage.key,
            facts: {
                status: stage.status,
                startedAt: stage.startedAt,
                completedAt: stage.completedAt,
                model: stage.model,
                technicalCheck: stage.key === "image_generation" ? checkFacts(object(stage.output).technicalCheck) : undefined,
                visualReview: stage.key === "quality_check" ? checkFacts(stage.output) : undefined,
            },
        })) || []),
        { id: "feedback", label: "用户反馈（管理员转录）", facts: evaluations.flatMap((item) => (item.kind === "feedback" ? [{ id: item.id, createdAt: item.createdAt, actorName: item.actorName, ...item.feedback }] : [])) },
    ];
}

function checkFacts(value: unknown) {
    const check = object(value);
    return { version: check.version, policy: check.policy, status: check.status, publicStatus: check.publicStatus, checks: check.checks, hardFailures: check.hardFailures, checkedAt: check.checkedAt };
}

function dimensions(value?: { width?: number; height?: number; format?: string; byteLength?: number; sha256?: string }) {
    return value ? { width: value.width, height: value.height, format: value.format, byteLength: value.byteLength, sha256: value.sha256 } : undefined;
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseGenerationLogReview(text: string, evidence: GenerationLogEvidence[]): GenerationLogReviewReport {
    const value = object(JSON.parse(text));
    if (
        !["no_issue_observed", "issues_found", "insufficient_evidence"].includes(String(value.outcome)) ||
        typeof value.summary !== "string" ||
        !value.summary.trim() ||
        !Array.isArray(value.limitations) ||
        !value.limitations.every((entry) => typeof entry === "string") ||
        !Array.isArray(value.issues)
    )
        throw new Error("复盘报告结构无效");
    const ids = new Set(evidence.map((item) => item.id));
    const issues = value.issues.map((entry) => {
        const issue = object(entry);
        if (
            typeof issue.category !== "string" ||
            !issue.category.trim() ||
            typeof issue.message !== "string" ||
            !issue.message.trim() ||
            typeof issue.recommendation !== "string" ||
            !issue.recommendation.trim() ||
            !Array.isArray(issue.evidenceIds) ||
            !issue.evidenceIds.length ||
            !issue.evidenceIds.every((id) => typeof id === "string" && ids.has(id))
        )
            throw new Error("复盘建议缺少有效证据引用");
        return { category: issue.category, message: issue.message, recommendation: issue.recommendation, evidenceIds: issue.evidenceIds as string[] };
    });
    if ((value.outcome === "issues_found" && !issues.length) || (value.outcome === "no_issue_observed" && issues.length)) throw new Error("复盘结论与问题列表矛盾");
    return { outcome: value.outcome as GenerationLogReviewReport["outcome"], summary: value.summary, limitations: value.limitations as string[], issues };
}

export const generationLogReviewTool = {
    name: "review_generation_process",
    description: "根据可引用的日志事实提出流程优化建议，不修改事实或生成状态",
    parameters: {
        type: "object",
        properties: {
            outcome: { type: "string", enum: ["no_issue_observed", "issues_found", "insufficient_evidence"] },
            summary: { type: "string" },
            limitations: { type: "array", items: { type: "string" } },
            issues: {
                type: "array",
                items: {
                    type: "object",
                    properties: { category: { type: "string" }, message: { type: "string" }, evidenceIds: { type: "array", items: { type: "string" } }, recommendation: { type: "string" } },
                    required: ["category", "message", "evidenceIds", "recommendation"],
                    additionalProperties: false,
                },
            },
        },
        required: ["outcome", "summary", "limitations", "issues"],
        additionalProperties: false,
    },
};
