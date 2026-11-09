import { createHash } from "node:crypto";
import { IMAGE_PROCESSING_MEMORY_MODEL_VERSION } from "./resource-model.ts";

const MiB = 1024 * 1024;

export function imageProcessingResourceConfig(environment: Readonly<Record<string, string | undefined>>) {
    const positiveInteger = (name: string, fallback?: number) => {
        const raw = environment[name];
        if (raw === undefined && fallback !== undefined) return fallback;
        const value = Number(raw);
        if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) throw new Error(`${name} must be an explicit positive integer`);
        return value;
    };
    const memoryBytes = (name: string, fallback?: number) => {
        const bytes = positiveInteger(name, fallback) * MiB;
        if (!Number.isSafeInteger(bytes)) throw new Error(`${name} cannot be represented as an exact byte count`);
        return bytes;
    };
    const cpuLimit = environment.VOZEB_PRO_GENERATION_WORKER_CPUS;
    if (cpuLimit !== undefined) {
        const cpus = Number(cpuLimit);
        if (!Number.isFinite(cpus) || cpus <= 0) throw new Error("VOZEB_PRO_GENERATION_WORKER_CPUS must be a finite positive number");
    }
    const workerMemoryBytes = memoryBytes("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB");
    const supervisorHeapBytes = memoryBytes("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", 384);
    const budgetBytes = memoryBytes("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB");
    const processHeapMb = positiveInteger("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", 384);
    const concurrency = positiveInteger("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", 1);
    if (budgetBytes + supervisorHeapBytes >= workerMemoryBytes) throw new Error("Image processing budget plus supervisor heap must be smaller than Worker memory");
    const profileVersion = createHash("sha256")
        .update(JSON.stringify([IMAGE_PROCESSING_MEMORY_MODEL_VERSION, budgetBytes, processHeapMb, concurrency]))
        .digest("hex");
    return { workerMemoryBytes, supervisorHeapBytes, budgetBytes, processHeapMb, concurrency, profileVersion };
}
