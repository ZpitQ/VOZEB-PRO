import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { ImageProcessingArtifact, ImageProcessingInput, ImageProcessingOutcome, ImageProcessingRequest } from "../lib/image-processing/contracts.js";
import { imageProcessingResourceConfig } from "../lib/image-processing/resource-config.js";

type SupervisorRequest = Pick<ImageProcessingRequest, "version" | "jobId" | "executionId" | "inputs" | "outputDirectory"> & { operation: ImageProcessingRequest["operation"]; options: unknown };
type LaneOptions = {
    origin: string;
    token: string;
    workerId: string;
    stop: AbortSignal;
    idleDelayMs: number;
    supervise: (request: SupervisorRequest, execution: { taskDirectory: string; maxHeapMiB: number; signal: AbortSignal }) => Promise<ImageProcessingOutcome>;
};
type ClaimedTask = {
    id: string;
    executionId: string;
    leaseUntil: number;
    inputDigest: string;
    requiredMemoryBytes: number;
    operation: ImageProcessingRequest["operation"];
    options: unknown;
    inputs: Array<Omit<ImageProcessingInput, "path"> & { expectedSha256: string; url: string }>;
};
type StoredArtifact = Omit<ImageProcessingArtifact, "path"> & { storageKey: string };
type StopCause = "cancel_requested" | "lease_lost" | "unknown";

class TransportError extends Error {
    constructor(readonly status: number) {
        super("Image processing endpoint returned HTTP " + status);
    }
}

export async function runImageProcessingLane(options: LaneOptions): Promise<void> {
    const configuration = imageProcessingResourceConfig(process.env);
    const origin = new URL(options.origin);
    if (origin.username || origin.password || !["http:", "https:"].includes(origin.protocol)) throw new Error("Image processing origin is invalid");
    const active = new Map<string, Promise<void>>();
    let reservedMemoryBytes = 0;
    try {
        while (!options.stop.aborted) {
            const slots = configuration.concurrency - active.size;
            const availableMemoryBytes = configuration.budgetBytes - reservedMemoryBytes;
            if (!slots || !availableMemoryBytes) {
                await waitForChange([...active.values()], options.stop);
                continue;
            }
            try {
                const response = await post(
                    "/api/maintenance/image-processing/claim",
                    {
                        workerId: options.workerId,
                        profileVersion: configuration.profileVersion,
                        availableMemoryBytes,
                        slots,
                    },
                    options.stop,
                );
                const tasks = claimBatch(response, configuration.profileVersion, slots, availableMemoryBytes, active, origin);
                // Reserve the complete batch before any job starts its asynchronous work.
                for (const task of tasks) {
                    reservedMemoryBytes += task.requiredMemoryBytes;
                    const running = Promise.resolve()
                        .then(() => processTask(task))
                        .catch((error: unknown) => {
                            console.error("Image processing job outcome unknown", task.id, task.executionId, error);
                        })
                        .finally(() => {
                            reservedMemoryBytes -= task.requiredMemoryBytes;
                            active.delete(task.id);
                        });
                    active.set(task.id, running);
                }
                if (!tasks.length) await idle(options.idleDelayMs, options.stop);
            } catch (error) {
                if (options.stop.aborted) break;
                console.error("Image processing claim failed", error);
                await idle(options.idleDelayMs, options.stop);
            }
        }
    } finally {
        await Promise.all(active.values());
    }

    async function post(endpoint: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
        const response = await fetch(new URL(endpoint, origin.origin), {
            method: "POST",
            headers: { authorization: "Bearer " + options.token, "content-type": "application/json" },
            body: JSON.stringify(body),
            redirect: "error",
            signal,
        });
        return envelope(response);
    }

    async function processTask(task: ClaimedTask): Promise<void> {
        const execution = new AbortController();
        const heartbeatStop = new AbortController();
        const identity = { workerId: options.workerId, executionId: task.executionId };
        const endpoint = "/api/maintenance/image-processing/" + encodeURIComponent(task.id);
        const headers = { authorization: "Bearer " + options.token, "x-vozeb-pro-worker-id": options.workerId, "x-vozeb-pro-execution-id": task.executionId };
        let taskDirectory: string | undefined;
        let outcome: ImageProcessingOutcome | undefined;
        let superviseEntered = false;
        let stopCause: StopCause | undefined;
        let stopError: unknown;
        let deferredStop: { cause: StopCause; error: unknown } | undefined;
        let submittingTerminal = false;
        let terminal = false;
        let closing = false;
        let heartbeatPending: Promise<void> | undefined;
        let leaseDeadline: ReturnType<typeof setTimeout> | undefined;

        function stopJob(cause: StopCause, error: unknown, leaseExpired = false) {
            if (terminal || closing || stopCause) return;
            // A terminal receipt decides whether a simultaneous heartbeat conflict is expected.
            if (submittingTerminal && !leaseExpired) {
                deferredStop ??= { cause, error };
                return;
            }
            stopCause = cause;
            stopError = error;
            execution.abort(error);
        }

        function renewLease(leaseUntil: number) {
            clearTimeout(leaseDeadline);
            leaseDeadline = setTimeout(
                () => {
                    const error = new Error("Image processing lease expired", { cause: deferredStop?.error });
                    heartbeatStop.abort(error);
                    stopJob("lease_lost", error, true);
                },
                Math.max(0, leaseUntil - Date.now()),
            );
        }

        function heartbeat(): Promise<void> {
            if (terminal || closing || stopCause || deferredStop) return Promise.resolve();
            if (heartbeatPending) return heartbeatPending;
            heartbeatPending = post(endpoint + "/heartbeat", identity, AbortSignal.any([heartbeatStop.signal, execution.signal]))
                .then((data) => {
                    if (terminal || closing || stopCause) return;
                    const leaseUntil = positiveInteger(data.leaseUntil);
                    if (typeof data.cancelRequested !== "boolean") throw new Error("Invalid image processing heartbeat receipt");
                    renewLease(leaseUntil);
                    if (data.cancelRequested) stopJob("cancel_requested", new Error("Image processing cancellation requested"));
                })
                .catch((error: unknown) => {
                    if (closing || terminal) return;
                    stopJob(error instanceof TransportError && (error.status === 404 || error.status === 409) ? "lease_lost" : "unknown", error);
                })
                .finally(() => {
                    heartbeatPending = undefined;
                });
            return heartbeatPending;
        }

        async function submitTerminal(kind: "complete" | "fail", body: unknown) {
            execution.signal.throwIfAborted();
            submittingTerminal = true;
            try {
                const receipt = await post(endpoint + "/" + kind, body, execution.signal);
                if (receipt.jobId !== task.id) throw new Error("Image processing terminal receipt has a different job");
                if (kind === "complete") {
                    if (receipt.executionId !== task.executionId || receipt.inputDigest !== task.inputDigest || typeof receipt.parentRescheduled !== "boolean") throw new Error("Invalid image processing completion receipt");
                } else if ((receipt.status !== "error" && receipt.status !== "paused") || receipt.executionPhase !== "needs_review") throw new Error("Invalid image processing failure receipt");
                terminal = true;
            } finally {
                submittingTerminal = false;
                if (!terminal && deferredStop) stopJob(deferredStop.cause, deferredStop.error);
            }
        }

        renewLease(task.leaseUntil);
        const heartbeatTimer = setInterval(() => {
            void heartbeat();
        }, 25_000);
        try {
            await heartbeat();
            execution.signal.throwIfAborted();
            taskDirectory = await mkdtemp(path.join(tmpdir(), "vozeb-image-processing-"));
            const outputDirectory = path.join(taskDirectory, "outputs");
            await mkdir(outputDirectory);
            const inputs: ImageProcessingInput[] = [];
            for (const [index, input] of task.inputs.entries()) {
                execution.signal.throwIfAborted();
                const filename = path.join(taskDirectory, "input-" + index);
                const response = await fetch(input.url, { headers, redirect: "error", signal: execution.signal });
                if (!response.ok) throw new TransportError(response.status);
                if (!response.body) throw new Error("Image processing input body is missing");
                const hash = createHash("sha256");
                const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
                const writer = createWriteStream(filename, { flags: "wx" });
                const closed = Promise.all([new Promise<void>((resolve) => source.once("close", resolve)), new Promise<void>((resolve) => writer.once("close", resolve))]);
                try {
                    await pipeline(
                        source,
                        async function* (chunks: AsyncIterable<Uint8Array>) {
                            for await (const chunk of chunks) {
                                hash.update(chunk);
                                yield chunk;
                            }
                        },
                        writer,
                        { signal: execution.signal },
                    );
                } finally {
                    await closed;
                }
                if (hash.digest("hex") !== input.expectedSha256) throw new Error("source_hash_mismatch: downloaded image differs from its frozen identity");
                inputs.push({ path: filename, assetId: input.assetId, assetVersion: input.assetVersion, expectedSha256: input.expectedSha256 });
            }
            execution.signal.throwIfAborted();
            // The existing supervisor validates operation options before forking the child.
            superviseEntered = true;
            outcome = await options.supervise(
                { version: "image-processing.v1", jobId: task.id, executionId: task.executionId, operation: task.operation, options: task.options, inputs, outputDirectory },
                {
                    taskDirectory,
                    maxHeapMiB: configuration.processHeapMb,
                    signal: execution.signal,
                },
            );
            execution.signal.throwIfAborted();
            if (outcome.status === "completed") {
                const stored: StoredArtifact[] = [];
                for (const artifact of outcome.result.artifacts) {
                    execution.signal.throwIfAborted();
                    const url = new URL(endpoint + "/outputs/" + artifact.kind, origin.origin);
                    if (artifact.kind === "final") {
                        if (!artifact.resultId) throw new Error("Final image artifact is missing its result identity");
                        url.searchParams.set("resultId", artifact.resultId);
                    }
                    const file = createReadStream(artifact.path);
                    const iterator = file[Symbol.asyncIterator]();
                    const body = new ReadableStream<Uint8Array>({
                        async pull(controller) {
                            const next = await iterator.next();
                            if (next.done) controller.close();
                            else controller.enqueue(next.value);
                        },
                        cancel() {
                            file.destroy();
                        },
                    });
                    const uploadStop = new AbortController();
                    try {
                        const request: RequestInit & { duplex: "half" } = {
                            method: "PUT",
                            headers: { ...headers, "content-type": artifact.mimeType },
                            body,
                            duplex: "half",
                            redirect: "error",
                            signal: AbortSignal.any([execution.signal, uploadStop.signal]),
                        };
                        const receipt = await envelope(await fetch(url, request));
                        stored.push(storedArtifact(receipt, artifact));
                    } finally {
                        uploadStop.abort();
                        file.destroy();
                        await iterator.return?.();
                    }
                }
                const { artifacts: _artifacts, metrics, ...manifest } = outcome.result;
                await submitTerminal("complete", { ...identity, manifest: { ...manifest, artifacts: stored }, metrics });
            } else if (outcome.status === "rejected" || outcome.status === "resource_failure") {
                await submitTerminal("fail", { ...identity, failure: outcome });
            } else {
                throw new Error("Image processing child closed with " + outcome.status, { cause: outcome });
            }
        } catch (error) {
            if (stopCause === "cancel_requested" && !superviseEntered && task.operation !== "process_result") {
                const receipt = await post(endpoint + "/heartbeat", { ...identity, notStarted: true, stopCause }, heartbeatStop.signal);
                if (receipt.jobId !== task.id || receipt.executionId !== task.executionId || receipt.status !== "cancelled" || receipt.executionPhase !== "completed")
                    throw new Error("Invalid image processing not-started acknowledgement", { cause: error });
                terminal = true;
            } else if ((stopCause === "cancel_requested" || stopCause === "lease_lost") && outcome && outcome.pid !== null && outcome.pid > 0) {
                const { jobId, executionId, pid, exitCode, signal, stderr, status } = outcome;
                const closed = {
                    jobId,
                    executionId,
                    pid,
                    exitCode,
                    signal,
                    stderr,
                    status,
                    ...(outcome.status === "rejected" || outcome.status === "crashed" ? { error: outcome.error } : {}),
                    ...(outcome.status === "resource_failure" ? { reason: outcome.reason } : {}),
                };
                const receipt = await post(endpoint + "/heartbeat", { ...identity, closed, stopCause: outcome.status === "aborted" ? stopCause : null }, heartbeatStop.signal);
                if (receipt.jobId !== task.id || receipt.executionId !== task.executionId || receipt.status !== "cancelled" || receipt.executionPhase !== "completed") throw new Error("Invalid image processing close acknowledgement", { cause: error });
                terminal = true;
            } else {
                throw stopError === undefined ? error : new Error("Image processing stopped without a terminal receipt", { cause: stopError });
            }
        } finally {
            closing = true;
            clearInterval(heartbeatTimer);
            clearTimeout(leaseDeadline);
            heartbeatStop.abort();
            await heartbeatPending;
            if (taskDirectory) await rm(taskDirectory, { recursive: true, force: true });
        }
    }
}

async function envelope(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) {
        await response.body?.cancel();
        throw new TransportError(response.status);
    }
    const payload: unknown = await response.json();
    const result = fields(payload);
    if (result.code !== 0) throw new Error("Image processing response code is invalid");
    return fields(result.data);
}

function claimBatch(data: Record<string, unknown>, profileVersion: string, slots: number, availableMemoryBytes: number, active: ReadonlyMap<string, Promise<void>>, origin: URL): ClaimedTask[] {
    if (!Array.isArray(data.tasks) || data.tasks.length > slots) throw new Error("Image processing claim exceeds offered slots");
    const ids = new Set<string>();
    let remainingMemoryBytes = availableMemoryBytes;
    return data.tasks.map((value: unknown): ClaimedTask => {
        const task = fields(value);
        const id = text(task.id);
        const executionId = text(task.executionId);
        const leaseUntil = positiveInteger(task.leaseUntil);
        if (ids.has(id) || active.has(id)) throw new Error("Image processing claim contains a duplicate job");
        ids.add(id);
        const payload = fields(task.payload);
        const resource = fields(payload.resource);
        if (payload.version !== "image-processing.v1" || payload.executionId !== executionId || resource.profileVersion !== profileVersion || resource.unavailable !== undefined)
            throw new Error("Image processing claim has an invalid execution or resource profile");
        const requiredMemoryBytes = positiveInteger(resource.requiredMemoryBytes);
        if (requiredMemoryBytes > remainingMemoryBytes) throw new Error("Image processing claim exceeds offered memory");
        remainingMemoryBytes -= requiredMemoryBytes;
        if (payload.operation !== "prepare_reference" && payload.operation !== "prepare_review" && payload.operation !== "build_protection" && payload.operation !== "process_result" && payload.operation !== "process_enhancement")
            throw new Error("Image processing operation is invalid");
        const operation = payload.operation;
        const options = fields(payload.options);
        const inputDigest = sha256(payload.inputDigest);
        if (!Array.isArray(payload.inputs) || !payload.inputs.length || !Array.isArray(task.inputUrls) || task.inputUrls.length !== payload.inputs.length) throw new Error("Image processing claim input list is invalid");
        const urls: unknown[] = task.inputUrls;
        const inputs = payload.inputs.map((value: unknown, index: number) => {
            const input = fields(value);
            const assetId = text(input.assetId);
            const url = new URL(text(urls[index]), origin.origin);
            const expectedPath = "/api/maintenance/image-processing/" + encodeURIComponent(id) + "/inputs/" + encodeURIComponent(assetId);
            if (url.origin !== origin.origin || url.username || url.password || url.pathname !== expectedPath || url.search || url.hash) throw new Error("Image processing input URL is outside its authenticated job");
            return { assetId, assetVersion: text(input.assetVersion), expectedSha256: sha256(input.expectedSha256), url: url.href };
        });
        return { id, executionId, leaseUntil, inputDigest, requiredMemoryBytes, operation, options, inputs };
    });
}

function storedArtifact(receipt: Record<string, unknown>, artifact: ImageProcessingArtifact): StoredArtifact {
    if (
        receipt.kind !== artifact.kind ||
        receipt.sha256 !== artifact.sha256 ||
        receipt.mimeType !== artifact.mimeType ||
        receipt.bytes !== artifact.bytes ||
        receipt.width !== artifact.width ||
        receipt.height !== artifact.height ||
        receipt.resultId !== artifact.resultId ||
        receipt.resultIndex !== artifact.resultIndex
    )
        throw new Error("Image processing upload receipt differs from the closed artifact");
    const { path: _path, ...descriptor } = artifact;
    return { ...descriptor, storageKey: text(receipt.storageKey) };
}

function fields(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid image processing response object");
    return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error("Invalid image processing identity");
    return value;
}

function sha256(value: unknown): string {
    const result = text(value);
    if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("Invalid frozen image processing SHA-256");
    return result;
}

function positiveInteger(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid image processing resource or lease value");
    return value;
}

function idle(milliseconds: number, stop: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            stop.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        stop.addEventListener("abort", finish, { once: true });
        if (stop.aborted) finish();
    });
}

function waitForChange(active: Promise<void>[], stop: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            stop.removeEventListener("abort", finish);
            resolve();
        };
        stop.addEventListener("abort", finish, { once: true });
        void Promise.race(active).then(finish);
        if (stop.aborted) finish();
    });
}
