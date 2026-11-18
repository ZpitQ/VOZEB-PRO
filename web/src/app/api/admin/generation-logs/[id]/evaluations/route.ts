import { NextResponse } from "next/server";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { evaluateGenerationLog, parseGenerationLogEvaluationInput } from "@/lib/server/generation-log-evaluation-service";
import { listGenerationLogEvaluations } from "@/lib/server/generation-log-evaluation-store";
import { getGenerationLogById } from "@/lib/server/generation-log-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
    const user = await getCurrentUser();
    if (!user) return response(401, "请先登录");
    if (!hasAdminPermission(user, "generation.read")) return response(403, "没有查看生成记录的职责权限");
    const { id } = await context.params;
    if (!(await getGenerationLogById(id))) return response(404, "生成记录不存在");
    return response(200, "", { evaluations: await listGenerationLogEvaluations(id) });
}

export async function POST(request: Request, context: Context) {
    const user = await getCurrentUser();
    if (!user) return response(401, "请先登录");
    if (!hasAdminPermission(user, "generation.manage")) return response(403, "没有管理生成记录的职责权限");
    const { id } = await context.params;
    try {
        const action = parseGenerationLogEvaluationInput(await readJsonBody(request));
        const evaluation = await evaluateGenerationLog({ logId: id, actor: user, action, origin: resolveInternalOrigin(new URL(request.url).origin), cookie: request.headers.get("cookie") || "" });
        await safeRecordAuditLog({
            action: `admin.generation_log.${action.kind}`,
            status: evaluation.status === "failed" ? "failure" : "success",
            actor: auditActorFromRequest(request, user),
            target: { type: "generation_log", id },
            metadata: { evaluationId: evaluation.id, status: evaluation.status },
        });
        return response(200, "记录已保存", { evaluation });
    } catch (error) {
        const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 500;
        await safeRecordAuditLog({ action: "admin.generation_log.evaluation", status: "failure", actor: auditActorFromRequest(request, user), target: { type: "generation_log", id }, metadata: { status } });
        if (status === 500) console.error("Generation log evaluation failed", error);
        return response(status, status === 500 ? "评价记录保存失败" : error instanceof Error ? error.message : "评价请求失败");
    }
}

function response(status: number, msg: string, data: unknown = null) {
    return NextResponse.json({ code: status === 200 ? 0 : status, data, msg }, { status, headers: { "Cache-Control": "private, no-store" } });
}
