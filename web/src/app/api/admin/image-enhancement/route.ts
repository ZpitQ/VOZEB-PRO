import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { getImageEnhancementSettings, saveImageEnhancementSettings, checkImageEnhancementSettings, ImageEnhancementConfigError } from "@/lib/server/image-enhancement-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
    return handle(request, "read");
}
export function PATCH(request: Request) {
    return handle(request, "update");
}
export function POST(request: Request) {
    return handle(request, "check");
}

async function handle(request: Request, action: "read" | "update" | "check") {
    const user = await getCurrentUser();
    if (!user) return reply(401, null, "请先登录");
    if (!hasAdminPermission(user, "system.manage")) return reply(403, null, "当前管理员没有管理增强服务的职责权限");
    try {
        let data;
        if (action === "read") data = await getImageEnhancementSettings();
        else {
            const body = await readJsonBodyResult<unknown>(request);
            if (!body.ok) return reply(body.status, null, body.message);
            data = await (action === "update" ? saveImageEnhancementSettings(body.data) : checkImageEnhancementSettings(body.data));
            await safeRecordAuditLog({
                action: `admin.image-enhancement.${action}`,
                actor: auditActorFromRequest(request, user),
                target: { type: "image_enhancement", id: "default" },
                metadata: { enabled: data.enabled, ready: data.ready, revision: data.revision },
            });
        }
        return reply(200, data, "OK");
    } catch (error) {
        const known = error instanceof ImageEnhancementConfigError;
        return reply(known ? error.status : 500, null, known ? error.message : "增强配置操作失败，请检查服务端配置后重试");
    }
}
function reply(status: number, data: unknown, msg: string) {
    return NextResponse.json({ code: status === 200 ? 0 : status, data, msg }, { status, headers: { "Cache-Control": "private, no-store" } });
}
