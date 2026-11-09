import { NextResponse } from "next/server";
import { readJsonBodyResult } from "@/lib/auth/request";
import { acknowledgeImageProcessingCancellation, heartbeatImageProcessingTask, ImageProcessingInputError } from "@/lib/server/image-processing-service";
import { isAuthorizedWorkerRequest, isWorkerTokenConfigured } from "@/lib/server/maintenance-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    if (!isWorkerTokenConfigured()) return NextResponse.json({ code: 503, data: null, msg: "Worker 令牌未配置或未与维护令牌分离" }, { status: 503 });
    if (!isAuthorizedWorkerRequest(request)) return NextResponse.json({ code: 401, data: null, msg: "Worker 认证失败" }, { status: 401 });
    try {
        const parsed = await readJsonBodyResult<Record<string, unknown>>(request);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const body = parsed.data;
        if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ code: 400, data: null, msg: "心跳请求缺少执行身份" }, { status: 400 });
        if (Object.hasOwn(body, "notStarted") || Object.hasOwn(body, "closed") || Object.hasOwn(body, "stopCause")) {
            const { id } = await context.params;
            const data = await acknowledgeImageProcessingCancellation(id, body);
            return NextResponse.json({ code: 0, data, msg: "OK" }, { headers: { "cache-control": "no-store" } });
        }
        if (typeof body.workerId !== "string" || !body.workerId.trim() || typeof body.executionId !== "string" || !body.executionId.trim()) return NextResponse.json({ code: 400, data: null, msg: "心跳请求缺少执行身份" }, { status: 400 });
        const { id } = await context.params;
        const data = await heartbeatImageProcessingTask(id, { workerId: body.workerId.trim(), executionId: body.executionId });
        return NextResponse.json({ code: 0, data, msg: "OK" }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        if (error instanceof ImageProcessingInputError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Image processing heartbeat failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "图像处理任务续租失败" }, { status: 500 });
    }
}
