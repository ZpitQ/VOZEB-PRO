"use client";

import { Button, Input, Select } from "antd";
import { useEffect, useState } from "react";
import type { GenerationLogEvaluation, GenerationLogEvaluationInput } from "@/lib/generation-log-evaluation";
import { createAdminGenerationLogEvaluation, listAdminGenerationLogEvaluations } from "@/services/api/admin-generation-logs";

type AiReview = Extract<GenerationLogEvaluation, { kind: "ai_review" }>;

const sentiments = { satisfied: "满意", partly_satisfied: "部分满意", unsatisfied: "不满意" };
const outcomes = { no_issue_observed: "记录中未发现流程问题", issues_found: "发现可改进项", insufficient_evidence: "证据不足" };

export function GenerationLogEvaluationSection({ logId, canManage, refreshVersion = 0 }: { logId: string; canManage: boolean; refreshVersion?: number }) {
    const [records, setRecords] = useState<GenerationLogEvaluation[]>([]);
    const [selectedReviewId, setSelectedReviewId] = useState<string>();
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [sentiment, setSentiment] = useState<"satisfied" | "partly_satisfied" | "unsatisfied">();
    const [message, setMessage] = useState("");
    const [retryAction, setRetryAction] = useState<GenerationLogEvaluationInput>();
    useEffect(() => {
        let active = true;
        listAdminGenerationLogEvaluations(logId)
            .then((items) => {
                if (active) {
                    setRecords(items);
                    setLoaded(true);
                }
            })
            .catch((cause: Error) => {
                if (active) setError(cause.message);
            });
        return () => {
            active = false;
        };
    }, [logId, refreshVersion]);
    async function submit(action: GenerationLogEvaluationInput) {
        setBusy(true);
        setError("");
        setRetryAction(action);
        try {
            const result = await createAdminGenerationLogEvaluation(logId, action);
            setRecords((items) => (items.some((item) => item.id === result.id) ? items.map((item) => (item.id === result.id ? result : item)) : [result, ...items]));
            if (result.kind === "ai_review") setSelectedReviewId(result.id);
            setRetryAction(undefined);
            if (action.kind === "feedback") {
                setSentiment(undefined);
                setMessage("");
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "保存评价失败");
        } finally {
            setBusy(false);
        }
    }
    const reviews = records.filter((item) => item.kind === "ai_review");
    const selectedReview = reviews.find((item) => item.id === selectedReviewId) ?? reviews[0];

    return (
        <section className="space-y-3" aria-label="用户反馈与AI流程复盘">
            <h3 className="text-sm font-semibold">用户反馈与 AI 流程复盘</h3>
            <p className="text-xs text-stone-500 dark:text-stone-400">
                {loaded ? (records.some((item) => item.kind === "feedback") ? "用户反馈来源：管理员转录，保留记录人与原话。" : "用户反馈：未知，尚未记录。") : "正在读取评价记录…"} AI 复盘独立留档，不改变生成状态。
            </p>
            {canManage ? (
                <>
                    <div className="space-y-2 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs font-medium">录入用户反馈（管理员转录）</div>
                        <Select
                            aria-label="用户满意程度"
                            placeholder="选择用户明确表达的满意程度"
                            value={sentiment}
                            onChange={setSentiment}
                            options={Object.entries(sentiments).map(([value, label]) => ({ value, label }))}
                            className="w-full"
                            disabled={busy}
                        />
                        <Input.TextArea aria-label="用户反馈原话" placeholder="填写用户反馈原话，不推测用户态度" value={message} onChange={(event) => setMessage(event.target.value)} autoSize={{ minRows: 2 }} disabled={busy} />
                        <Button
                            size="small"
                            disabled={!loaded || busy || !sentiment || !message.trim() || Boolean(retryAction)}
                            onClick={() => {
                                if (sentiment) void submit({ kind: "feedback", requestId: crypto.randomUUID(), sentiment, message });
                            }}
                        >
                            保存用户反馈
                        </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="small" disabled={!loaded || busy || Boolean(retryAction)} loading={busy} onClick={() => void submit({ kind: "ai_review", requestId: crypto.randomUUID() })}>
                            手动 AI 流程复盘
                        </Button>
                        <span className="text-xs text-stone-500 dark:text-stone-400">使用后台默认文本模型，消耗当前管理员的文本积分；分析文字与元数据，未查看图片。暂不开定时。</span>
                    </div>
                </>
            ) : null}
            {error ? (
                <div role="alert" className="text-sm text-red-600 dark:text-red-300">
                    {error}
                    {retryAction ? (
                        <Button size="small" disabled={busy} onClick={() => void submit(retryAction)}>
                            检查原请求
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {selectedReview ? (
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold">复盘记录（{reviews.length} 份）</h4>
                        {reviews.length > 1 ? (
                            <select
                                aria-label="切换复盘记录"
                                className="min-h-9 max-w-full rounded-md border border-stone-300 bg-white px-2 text-sm dark:border-stone-700 dark:bg-stone-900"
                                value={selectedReview.id}
                                onChange={(event) => setSelectedReviewId(event.target.value)}
                            >
                                {reviews.map((item, index) => (
                                    <option key={item.id} value={item.id}>
                                        {index === 0 ? "最新 · " : ""}
                                        {evaluationTime(item.createdAt)} · {item.actorName}
                                    </option>
                                ))}
                            </select>
                        ) : null}
                    </div>
                    {!canManage ? <p className="text-sm text-stone-600 dark:text-stone-400">仅分析文字与元数据，未查看图片。</p> : null}
                    <GenerationLogReview key={selectedReview.id} item={selectedReview} />
                </div>
            ) : null}
            {records
                .filter((item) => item.kind === "feedback")
                .map((item) => (
                    <article key={item.id} className="space-y-2 rounded-lg border border-stone-200 p-4 text-sm dark:border-stone-800">
                        <div className="font-semibold">
                            用户反馈 · {sentiments[item.feedback.sentiment]} · {item.actorName} · {evaluationTime(item.createdAt)}
                        </div>
                        <p className="whitespace-pre-wrap text-base leading-7">{item.feedback.message}</p>
                    </article>
                ))}
        </section>
    );
}

function GenerationLogReview({ item }: { item: AiReview }) {
    const [expanded, setExpanded] = useState(false);
    const {
        review: { report, model, ruleVersion, pointsCost, refunded },
    } = item;
    const status = item.status === "pending" ? "复盘结果待确认，请刷新读取原请求；不会自动再次调用模型。" : item.status === "failed" ? `复盘失败：${item.review.error}` : report ? outcomes[report.outcome] : "复盘结果未知";

    return (
        <article className="space-y-3 rounded-lg border border-stone-200 p-4 text-sm dark:border-stone-800">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h5 className="text-base font-semibold">
                    {status}
                    {report?.issues.length ? ` · ${report.issues.length} 项` : ""}
                </h5>
                <div className="text-stone-600 dark:text-stone-400">
                    {evaluationTime(item.createdAt)} · {item.actorName}
                </div>
            </div>
            {report ? <p className={`whitespace-pre-wrap break-words text-xs leading-7${expanded ? "" : " line-clamp-3"}`}>{report.summary}</p> : null}
            <Button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
                {report ? (expanded ? "收起完整报告" : "展开完整报告") : expanded ? "收起复盘详情" : "查看复盘详情"}
            </Button>
            {expanded ? (
                <div className="space-y-4 border-t border-stone-200 pt-4 dark:border-stone-800">
                    {report?.issues.map((issue, index) => (
                        <div key={index} className="space-y-2 border-l-2 border-stone-200 pl-3 text-xs leading-7 dark:border-stone-700">
                            <h6 className="font-semibold">{issue.category}</h6>
                            <p className="whitespace-pre-wrap break-words">{issue.message}</p>
                            <p className="whitespace-pre-wrap break-words">
                                <strong>建议</strong>　<span>{issue.recommendation}</span>
                            </p>
                            <p className="break-words text-sm text-stone-600 dark:text-stone-400">证据：{issue.evidenceIds.join("、")}</p>
                        </div>
                    ))}
                    {report?.limitations.length ? (
                        <details>
                            <summary className="cursor-pointer font-medium">分析范围与限制（{report.limitations.length} 条）</summary>
                            <ul className="mt-2 list-disc space-y-2 pl-5 text-xs leading-7">
                                {report.limitations.map((limitation, index) => (
                                    <li key={index}>{limitation}</li>
                                ))}
                            </ul>
                        </details>
                    ) : null}
                    <div className="break-words text-stone-600 dark:text-stone-400">
                        模型：{model.logicalModelId} → {model.upstreamModel} · 规则：{ruleVersion}
                        {pointsCost !== undefined ? ` · ${pointsCost} 积分${refunded ? "（已退款）" : ""}` : ""}
                    </div>
                    <details>
                        <summary className="cursor-pointer font-medium">复盘时的事实与证据</summary>
                        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">
                            {JSON.stringify({ mode: item.review.mode, model, factsDigest: item.review.factsDigest, evidence: item.review.evidence, pointsRecordId: item.review.pointsRecordId }, null, 2)}
                        </pre>
                    </details>
                </div>
            ) : null}
        </article>
    );
}

function evaluationTime(createdAt: string) {
    return new Date(createdAt).toLocaleString("zh-CN", { hour12: false });
}
