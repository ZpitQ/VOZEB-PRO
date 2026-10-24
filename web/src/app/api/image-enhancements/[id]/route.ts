import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getEnhancementJob } from "@/lib/server/database/image-enhancement-job-repository";
import { retryImageEnhancement, cancelImageEnhancement } from "@/lib/server/image-enhancement-service";
import { publicImageEnhancement } from "@/lib/server/image-enhancement-public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

type RouteContext = { params: Promise<{ id: string }> };

export function GET(request: Request, context: RouteContext) {
    return handle(request, context, "read");
}

export function POST(request: Request, context: RouteContext) {
    return handle(request, context, "control");
}

async function handle(request: Request, context: RouteContext, operation: "read" | "control") {
    try {
        const user = await getCurrentUser(request);
        if (!user) return reply(401, null, "请先登录");
        const { id } = await context.params;
        const job = await getEnhancementJob(id, user.role === "admin" ? undefined : user.id);
        if (!job || (job.userId !== user.id && user.role !== "admin")) return reply(404, null, "增强任务不存在或已过期");
        if (operation === "read") return reply(200, publicImageEnhancement(job), "OK");

        const parsed = await readJsonBodyResult<{ action?: unknown } | null>(request);
        if (!parsed.ok) return reply(parsed.status, null, parsed.message);
        const action = parsed.data?.action;
        if (action !== "retry" && action !== "cancel") return reply(400, null, "不支持的增强任务操作");
        const changed = await (action === "retry" ? retryImageEnhancement : cancelImageEnhancement)(job.id, job.userId);
        if (!changed) return reply(409, null, "当前增强任务无法执行此操作，请刷新后重试");
        return reply(200, publicImageEnhancement(changed), "OK");
    } catch {
        return reply(500, null, "增强任务操作失败，请稍后重试");
    }
}

function reply(status: number, data: unknown, msg: string) {
    return NextResponse.json({ code: status === 200 ? 0 : status, data, msg }, { status, headers: { "Cache-Control": "private, no-store" } });
}
