import { NextResponse } from "next/server";
import { readJsonBodyResult } from "@/lib/auth/request";
import { claimImageProcessingTasks, ImageProcessingInputError } from "@/lib/server/image-processing-service";
import { isAuthorizedWorkerRequest, isWorkerTokenConfigured } from "@/lib/server/maintenance-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    if (!isWorkerTokenConfigured()) return NextResponse.json({ code: 503, data: null, msg: "Worker 令牌未配置或未与维护令牌分离" }, { status: 503 });
    if (!isAuthorizedWorkerRequest(request)) return NextResponse.json({ code: 401, data: null, msg: "Worker 认证失败" }, { status: 401 });
    try {
        const parsed = await readJsonBodyResult<Record<string, unknown>>(request);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const body = parsed.data;
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.workerId !== "string" || typeof body.profileVersion !== "string" || typeof body.availableMemoryBytes !== "number" || typeof body.slots !== "number")
            return NextResponse.json({ code: 400, data: null, msg: "领取请求字段不正确" }, { status: 400 });
        const data = await claimImageProcessingTasks({ workerId: body.workerId.trim(), profileVersion: body.profileVersion, availableMemoryBytes: body.availableMemoryBytes, slots: body.slots });
        return NextResponse.json({ code: 0, data, msg: "OK" }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        if (error instanceof ImageProcessingInputError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Image processing claim failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "图像处理任务领取失败" }, { status: 500 });
    }
}
