import sharp from "sharp";

import type { ImageProcessingChildReply, ImageProcessingRequest } from "../lib/image-processing/contracts.ts";
import { executeImageProcessing, ImageProcessingRejection } from "../lib/image-processing/operations.ts";

sharp.concurrency(1);
sharp.cache(false);
const send = process.send?.bind(process);
if (!send) throw new Error("Image processing child requires an IPC channel");

process.once("message", async (request: ImageProcessingRequest) => {
    const started = performance.now();
    let peakRssBytes = 0;
    let peakHeapUsedBytes = 0;
    let peakExternalBytes = 0;
    const sampleMemory = () => {
        const memory = process.memoryUsage();
        peakRssBytes = Math.max(peakRssBytes, memory.rss, process.resourceUsage().maxRSS * 1024);
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
        peakExternalBytes = Math.max(peakExternalBytes, memory.external);
    };
    sampleMemory();
    let reply: ImageProcessingChildReply;
    try {
        const result = await executeImageProcessing(request, sampleMemory);
        sampleMemory();
        reply = { status: "completed", result: { ...result, metrics: { pid: process.pid, peakRssBytes, peakHeapUsedBytes, peakExternalBytes, elapsedMs: performance.now() - started } } };
    } catch (error) {
        if (!(error instanceof ImageProcessingRejection)) {
            console.error(error);
            process.exitCode = 1;
            process.disconnect();
            return;
        }
        reply = { status: "rejected", jobId: request.jobId, executionId: request.executionId, error: { code: error.code, message: error.message } };
    }
    send(reply, (error: Error | null) => {
        if (error) {
            console.error(error);
            process.exitCode = 1;
        }
        process.disconnect();
    });
});
