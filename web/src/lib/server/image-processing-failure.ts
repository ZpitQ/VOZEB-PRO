import type { ImageProcessingOutcome } from "@/lib/image-processing/contracts";

export type ClosedImageProcessingFailure = Extract<ImageProcessingOutcome, { status: "rejected" | "resource_failure" }>;

export function imageProcessingPauseMessage(failure: ClosedImageProcessingFailure) {
    if (failure.status === "resource_failure") return "图像处理资源不足，已暂停等待人工检查。";
    return failure.error.code === "segmentation_rejected" ? "无法可靠识别商品与背景边界，已暂停处理，请核对图片或保护范围后继续。" : "图像处理未能完成，请检查参考图片或保护设置后继续。";
}

export function imageProcessingFailureIdentity(failure: ClosedImageProcessingFailure): ClosedImageProcessingFailure {
    const exit = { jobId: failure.jobId, executionId: failure.executionId, pid: failure.pid, exitCode: failure.exitCode, signal: failure.signal, stderr: failure.stderr };
    return failure.status === "rejected" ? { ...exit, status: "rejected", error: { code: failure.error.code, message: failure.error.message } } : { ...exit, status: "resource_failure", reason: failure.reason };
}
