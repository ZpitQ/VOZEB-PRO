import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { ImageProcessingInputError, readImageProcessingInput } from "@/lib/server/image-processing-service";
import { isAuthorizedWorkerRequest, isWorkerTokenConfigured } from "@/lib/server/maintenance-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string; assetId: string }> }): Promise<Response> {
    if (!isWorkerTokenConfigured()) return NextResponse.json({ code: 503, data: null, msg: "Worker 令牌未配置或未与维护令牌分离" }, { status: 503 });
    if (!isAuthorizedWorkerRequest(request)) return NextResponse.json({ code: 401, data: null, msg: "Worker 认证失败" }, { status: 401 });
    const workerId = request.headers.get("x-vozeb-pro-worker-id")?.trim();
    const executionId = request.headers.get("x-vozeb-pro-execution-id")?.trim();
    if (!workerId || !executionId) return NextResponse.json({ code: 400, data: null, msg: "缺少 Worker 或图像执行身份" }, { status: 400 });
    try {
        const { id, assetId } = await context.params;
        const original = await readImageProcessingInput(id, assetId, { workerId, executionId }, request.signal);
        // Node and DOM declarations describe this same WHATWG byte stream differently.
        return new Response(Readable.toWeb(original.stream) as ReadableStream<Uint8Array>, { headers: { "content-type": original.mimeType, "cache-control": "no-store" } });
    } catch (error) {
        if (error instanceof ImageProcessingInputError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Image processing input read failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "图像处理原件读取失败" }, { status: 500 });
    }
}
