"use client";

import { Button, Input, Select } from "antd";
import { useEffect, useState } from "react";
import type { GenerationLogEvaluation, GenerationLogEvaluationInput } from "@/lib/generation-log-evaluation";
import { createAdminGenerationLogEvaluation, listAdminGenerationLogEvaluations } from "@/services/api/admin-generation-logs";

const sentiments = { satisfied: "满意", partly_satisfied: "部分满意", unsatisfied: "不满意" };
const outcomes = { no_issue_observed: "记录中未发现流程问题", issues_found: "发现可改进项", insufficient_evidence: "证据不足" };

export function GenerationLogEvaluationSection({ logId, canManage, refreshVersion = 0 }: { logId: string; canManage: boolean; refreshVersion?: number }) {
    const [records, setRecords] = useState<GenerationLogEvaluation[]>([]);
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
            setRecords((items) => [result, ...items.filter((item) => item.id !== result.id)]);
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
            {records.map((item) => (
                <article key={item.id} className="space-y-2 rounded-lg border border-stone-200 p-3 text-xs dark:border-stone-800">
                    <div className="font-medium">
                        {item.kind === "feedback" ? `用户反馈 · ${sentiments[item.feedback.sentiment]}` : "AI 流程复盘"} · {item.actorName} · {new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}
                    </div>
                    {item.kind === "feedback" ? (
                        <p className="whitespace-pre-wrap">{item.feedback.message}</p>
                    ) : (
                        <>
                            <div>
                                {item.status === "pending"
                                    ? "复盘结果待确认，请刷新读取原请求；不会自动再次调用模型。"
                                    : item.status === "failed"
                                      ? `复盘失败：${item.review.error}`
                                      : item.review.report
                                        ? outcomes[item.review.report.outcome]
                                        : "复盘结果未知"}
                            </div>
                            {item.review.report ? (
                                <>
                                    <p className="whitespace-pre-wrap">{item.review.report.summary}</p>
                                    {item.review.report.issues.map((issue, index) => (
                                        <div key={index} className="space-y-1">
                                            <p>
                                                {issue.category}：{issue.message}
                                            </p>
                                            <p>建议：{issue.recommendation}</p>
                                            <div className="text-stone-500 dark:text-stone-400">证据：{issue.evidenceIds.join("、")}</div>
                                        </div>
                                    ))}
                                    {item.review.report.limitations.map((limitation, index) => (
                                        <p key={index} className="text-stone-500 dark:text-stone-400">
                                            {limitation}
                                        </p>
                                    ))}
                                </>
                            ) : null}
                            <div className="break-all text-stone-500 dark:text-stone-400">
                                模型：{item.review.model.logicalModelId} → {item.review.model.upstreamModel} · 规则：{item.review.ruleVersion}
                                {item.review.pointsCost !== undefined ? ` · ${item.review.pointsCost} 积分${item.review.refunded ? "（已退款）" : ""}` : ""}
                            </div>
                            <details>
                                <summary className="cursor-pointer">复盘时的事实与证据</summary>
                                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all">
                                    {JSON.stringify({ mode: item.review.mode, model: item.review.model, factsDigest: item.review.factsDigest, evidence: item.review.evidence, pointsRecordId: item.review.pointsRecordId }, null, 2)}
                                </pre>
                            </details>
                        </>
                    )}
                </article>
            ))}
        </section>
    );
}
