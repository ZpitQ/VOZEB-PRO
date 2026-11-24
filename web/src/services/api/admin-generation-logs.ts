import type { GenerationLogEvaluation, GenerationLogEvaluationInput } from "@/lib/generation-log-evaluation";
import type { StoredGenerationLog } from "@/lib/server/generation-log-types";

export async function getAdminGenerationLog(id: string): Promise<StoredGenerationLog> {
    const response = await fetch(`/api/admin/generation-logs/${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = (await response.json()) as { code: number; data: { log: StoredGenerationLog }; msg: string };
    if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "刷新详情失败");
    return payload.data.log;
}

export async function listAdminGenerationLogEvaluations(id: string): Promise<GenerationLogEvaluation[]> {
    return (await evaluationRequest<{ evaluations: GenerationLogEvaluation[] }>(id)).evaluations;
}

export async function createAdminGenerationLogEvaluation(id: string, input: GenerationLogEvaluationInput): Promise<GenerationLogEvaluation> {
    return (await evaluationRequest<{ evaluation: GenerationLogEvaluation }>(id, input)).evaluation;
}

async function evaluationRequest<T>(id: string, input?: GenerationLogEvaluationInput): Promise<T> {
    const response = await fetch(`/api/admin/generation-logs/${encodeURIComponent(id)}/evaluations`, {
        method: input ? "POST" : "GET",
        cache: "no-store",
        ...(input ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}),
    });
    const payload = (await response.json()) as { code: number; data: T; msg: string };
    if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "读取评价记录失败");
    return payload.data;
}
