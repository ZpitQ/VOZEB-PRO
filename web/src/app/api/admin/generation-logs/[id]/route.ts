import { NextResponse } from "next/server";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { getPublicUsersByIds } from "@/lib/auth/store";
import { getGenerationLogById } from "@/lib/server/generation-log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return result(401, "请先登录");
    if (!hasAdminPermission(user, "generation.read")) return result(403, "没有查看生成记录的职责权限");
    const { id } = await context.params;
    const log = await getGenerationLogById(id);
    if (!log) return result(404, "生成记录不存在");
    const owner = (await getPublicUsersByIds([log.userId]))[0];
    return result(200, "", { log: { ...log, accountId: owner?.accountId, username: owner?.username || log.username, displayName: owner?.displayName || log.displayName } });
}

function result(status: number, msg: string, data: unknown = null) {
    return NextResponse.json({ code: status === 200 ? 0 : status, data, msg }, { status, headers: { "Cache-Control": "private, no-store" } });
}
