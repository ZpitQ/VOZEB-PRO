import { NextResponse } from "next/server";
import { readJsonBodyResult } from "@/lib/auth/request";
import { failImageProcessingTask, ImageProcessingInputError, type FailImageProcessingInput } from "@/lib/server/image-processing-service";
import { isAuthorizedWorkerRequest, isWorkerTokenConfigured } from "@/lib/server/maintenance-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    if (!isWorkerTokenConfigured()) return NextResponse.json({ code: 503, data: null, msg: "Worker 令牌未配置或未与维护令牌分离" }, { status: 503 });
    if (!isAuthorizedWorkerRequest(request)) return NextResponse.json({ code: 401, data: null, msg: "Worker 认证失败" }, { status: 401 });
    try {
        const parsed = await readJsonBodyResult<unknown>(request);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const input = failureInput(parsed.data);
        const { id } = await context.params;
        const data = await failImageProcessingTask(id, input);
        return NextResponse.json({ code: 0, data, msg: "OK" }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        if (error instanceof ImageProcessingInputError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Image processing failure registration failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "图像处理失败状态登记失败" }, { status: 500 });
    }
}

function failureInput(value: unknown): FailImageProcessingInput {
    const body = fields(value, ["workerId", "executionId", "failure"]);
    const report = fields(body.failure, ["status", "jobId", "executionId", "pid", "exitCode", "signal", "stderr", "error", "reason"]);
    if ((report.status !== "rejected" && report.status !== "resource_failure") || (report.status === "rejected" && report.reason !== undefined) || (report.status === "resource_failure" && (report.reason !== "v8_heap_oom" || report.error !== undefined)))
        throw new ImageProcessingInputError("失败请求不接受此子进程结果", 400);
    const pid = report.pid === null ? null : integer(report.pid);
    if (pid !== null && pid <= 0) throw new ImageProcessingInputError("失败请求进程身份无效", 400);
    const exit = {
        jobId: text(report.jobId),
        executionId: text(report.executionId),
        pid,
        exitCode: report.exitCode === null ? null : integer(report.exitCode),
        signal: report.signal === null ? null : text(report.signal),
        stderr: diagnostic(report.stderr),
    };
    const identity = { workerId: text(body.workerId).trim(), executionId: text(body.executionId) };
    if (report.status === "resource_failure") return { ...identity, failure: { ...exit, status: "resource_failure", reason: "v8_heap_oom" } };
    const error = fields(report.error, ["code", "message"]);
    return { ...identity, failure: { ...exit, status: "rejected", error: { code: text(error.code), message: diagnostic(error.message) } } };
}

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new ImageProcessingInputError("失败请求含未知字段或结构无效", 400);
    return value as Record<string, unknown>;
}

function text(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) throw new ImageProcessingInputError("失败请求身份字段无效", 400);
    return value;
}

function diagnostic(value: unknown): string {
    if (typeof value !== "string") throw new ImageProcessingInputError("失败请求诊断字段无效", 400);
    return value;
}

function integer(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new ImageProcessingInputError("失败请求退出数值无效", 400);
    return value;
}
