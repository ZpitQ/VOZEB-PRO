import { NextResponse } from "next/server";
import { ImageProcessingInputError, writeImageProcessingOutput } from "@/lib/server/image-processing-service";
import { isAuthorizedWorkerRequest, isWorkerTokenConfigured } from "@/lib/server/maintenance-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ id: string; kind: string }> }): Promise<Response> {
    if (!isWorkerTokenConfigured()) return NextResponse.json({ code: 503, data: null, msg: "Worker 令牌未配置或未与维护令牌分离" }, { status: 503 });
    if (!isAuthorizedWorkerRequest(request)) return NextResponse.json({ code: 401, data: null, msg: "Worker 认证失败" }, { status: 401 });
    const workerId = request.headers.get("x-vozeb-pro-worker-id")?.trim();
    const executionId = request.headers.get("x-vozeb-pro-execution-id")?.trim();
    if (!workerId || !executionId) return NextResponse.json({ code: 400, data: null, msg: "缺少 Worker 或图像执行身份" }, { status: 400 });
    try {
        const { id, kind } = await context.params;
        const searchParams = new URL(request.url).searchParams;
        if ((kind !== "analysis" && kind !== "mask" && kind !== "generation_reference" && kind !== "generation_mask" && kind !== "final") || (kind !== "final" && searchParams.has("resultId")))
            throw new ImageProcessingInputError("当前阶段不接受此工件类别或槽位选择", 400);
        if (!request.body) throw new ImageProcessingInputError("图像工件内容为空", 400);
        const mimeType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const data = await writeImageProcessingOutput(id, kind, { workerId, executionId }, { stream: request.body, mimeType, signal: request.signal, resultId: searchParams.get("resultId") ?? undefined });
        return NextResponse.json({ code: 0, data, msg: "OK" }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
        if (error instanceof ImageProcessingInputError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Image processing output upload failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "图像工件登记失败" }, { status: 500 });
    }
}
