import type { ImageProcessingOutcome } from "@/lib/image-processing/contracts";

export type ClosedImageProcessingFailure = Extract<ImageProcessingOutcome, { status: "rejected" | "resource_failure" }>;

export function imageProcessingFailureIdentity(failure: ClosedImageProcessingFailure): ClosedImageProcessingFailure {
    const exit = { jobId: failure.jobId, executionId: failure.executionId, pid: failure.pid, exitCode: failure.exitCode, signal: failure.signal, stderr: failure.stderr };
    return failure.status === "rejected" ? { ...exit, status: "rejected", error: { code: failure.error.code, message: failure.error.message } } : { ...exit, status: "resource_failure", reason: failure.reason };
}
