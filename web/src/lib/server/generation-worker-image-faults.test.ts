import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants, watch } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import type { ImageProcessingOutcome } from "@/lib/image-processing/contracts";
import type { AgentRun } from "./agent-run-store";
import type { StoredGenerationTaskRecord } from "./generation-task-store";
import type { ClaimedImageProcessingTask, ClaimImageProcessingInput, FailedImageProcessingStage, FailImageProcessingInput } from "./image-processing-service";

async function requestBytes(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function relay(result: Response, response: ServerResponse) {
    const bytes = Buffer.from(await result.arrayBuffer());
    for (const [name, value] of result.headers) response.setHeader(name, value);
    response.writeHead(result.status);
    response.end(bytes);
}

async function seedPrepare(source: Buffer, userId: string) {
    const [tasks, runtime, references, registrations, service, scheduler, planning, recovery, claimRoute, inputRoute, heartbeatRoute, failRoute] = await Promise.all([
        import("./generation-task-store"),
        import("./creative-runtime-store"),
        import("./reference-asset-store"),
        import("./local-media-registry"),
        import("./image-processing-service"),
        import("./generation-task-scheduler"),
        import("./ecommerce-generation-snapshot"),
        import("./ecommerce-reference-recovery"),
        import("@/app/api/maintenance/image-processing/claim/route"),
        import("@/app/api/maintenance/image-processing/[id]/inputs/[assetId]/route"),
        import("@/app/api/maintenance/image-processing/[id]/heartbeat/route"),
        import("@/app/api/maintenance/image-processing/[id]/fail/route"),
    ]);
    const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
    assert.equal((await getObjectStorageRuntimeConfig()).enabled, false, "SETUP: Worker fault fixture requires isolated local media");
    const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
    const profile = imageProcessingResourceConfig(process.env);
    expect(profile).toMatchObject({ budgetBytes: 1073741824, concurrency: 1 });
    const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
    const original = await references.writeReferenceImageDataUrl("data:image/png;base64," + source.toString("base64"), { ownerUserId: userId, conversationId: conversation.id, source: "fixture-worker-fault" });
    const saved = await references.readReferenceAsset(original.token);
    const registration = await registrations.getLocalMediaRegistration(original.token);
    assert.ok(saved && registration, "SETUP: real source registration is missing");
    const [asset] = await runtime.registerCreativeAssets([
        {
            id: "fixture-fault-reference-" + randomUUID(),
            userId,
            conversationId: conversation.id,
            ordinal: 0,
            type: "image",
            title: "fault.png",
            sourceRunId: "fixture-upload-" + randomUUID(),
            serverUrl: "/api/reference-assets/" + original.token,
            metadata: {},
        },
    ]);
    assert.ok(asset);
    const now = Date.now();
    const parentExecutionId = randomUUID();
    const run: AgentRun = {
        id: "agent-fault-" + randomUUID(),
        userId,
        conversationId: conversation.id,
        clientRequestId: randomUUID(),
        surface: "chat",
        inputMessageId: "message-" + randomUUID(),
        assistantMessageId: "message-" + randomUUID(),
        prompt: "Prepare the registered fault reference",
        referencedAssetIds: [asset.id],
        assetIds: [],
        status: "running",
        executionId: parentExecutionId,
        tasks: [],
        reviewed: false,
        createdAt: now,
        updatedAt: now,
    };
    const checkpoint = recovery.createEcommerceReferenceCheckpoint(run, planning.buildEcommercePlanningInput(run, [asset], { summary: "", recentMessages: [] }), [asset]);
    run.ecommerceSnapshot = {
        version: "ecommerce-generation.v1",
        mode: "active",
        input: { userRequest: run.prompt, assetIds: [asset.id], conversationId: conversation.id, surface: "chat" },
        referenceCheckpoint: checkpoint,
        createdAt: now,
        runId: run.id,
        userId,
    };
    await runtime.createCreativeRunBundle(userId, { run, conversationId: conversation.id, title: "Worker fault fixture", prompt: run.prompt, assetIds: [asset.id], ttlMs: 365 * 24 * 60 * 60 * 1000 });
    assert.ok(await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: now }));
    expect((await scheduler.claimDueGenerationTasks({ workerId: "fixture-fault-parent", taskIds: [run.id], limit: 1 })).map((task) => task.id)).toStrictEqual([run.id]);
    const reference = checkpoint.assets[0];
    assert.ok(reference);
    const child = await service
        .enqueueImageProcessingTask({ runId: run.id, parentExecutionId, algorithmVersion: "reference-input-policy.v1", operation: "prepare_reference", inputs: [{ assetId: asset.id, assetVersion: reference.assetVersion }], options: {} })
        .catch((error: unknown) => {
            throw new Error("SETUP: the qualified PNG did not pass actual prepare admission", { cause: error });
        });
    const parent = await tasks.getStoredGenerationTaskRecord("agent", run.id);
    const pending = await tasks.getStoredGenerationTaskRecord("image_processing", child.id);
    assert.ok(parent && pending);
    expect(parent.payload.executionId).toBeUndefined();
    expect(Object.hasOwn(parent.payload, "executionId")).toBe(false);
    expect(pending.status).toBe("pending");
    expect(child.payload.inputs[0].expectedSha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(child.payload.resource.profileVersion).toBe(profile.profileVersion);
    expect(child.payload.resource.requiredMemoryBytes).toBeGreaterThan(0);
    expect(child.payload.resource.requiredMemoryBytes).toBeLessThanOrEqual(1073741824);
    expect(child.payload.resource.unavailable).toBeUndefined();
    return { userId, tasks, service, registrations, claimRoute, inputRoute, heartbeatRoute, failRoute, profile, asset, child, parent, registration, original, sourcePath: saved.filePath };
}

type Prepared = Awaited<ReturnType<typeof seedPrepare>>;
type Truth = { rows: StoredGenerationTaskRecord[]; media: Awaited<ReturnType<Prepared["registrations"]["listFileLocalMediaRegistrations"]>>; sourceBytes: Buffer };
type ClaimObservation = { task: ClaimedImageProcessingTask; identity: { workerId: string; executionId: string } };
type FailureObservation = { input: FailImageProcessingInput; receipt: FailedImageProcessingStage; before: Truth; after: Truth };
type CancellationUpload = { before: Truth; requested: Truth; cancelled: Truth; bytes: Buffer };
type CancellationHeartbeat = { before: Truth; after: Truth; leaseUntil: number };
type CancellationInput = ClaimObservation["identity"] & {
    closed: Pick<ImageProcessingOutcome, "jobId" | "executionId" | "status" | "exitCode" | "signal" | "stderr"> & { pid: number };
    stopCause: "cancel_requested" | "lease_lost" | "worker_stopping" | null;
};
type CancellationReceipt = { jobId: string; executionId: string; status: "cancelled"; executionPhase: "completed" };
type CancellationObservation = { input: CancellationInput; receipt: CancellationReceipt; before: Truth; after: Truth };
type NotStartedInput = ClaimObservation["identity"] & { notStarted: true; stopCause: "cancel_requested" };
type NotStartedRequest = { before: Truth; requested: Truth; cancelled: Truth };
type InputSink = { filePath: string; device: string; inode: string; writableFds: string[]; prefix: Buffer };
type InputClosure = { sink: InputSink; responseClosedAt: number; socketClosedAt: number; ackReceivedAt: number; fdAbsentAt: number };
type NotStartedObservation = { input: NotStartedInput; receipt: CancellationReceipt; before: Truth; after: Truth; closure?: InputClosure };
type WorkerFileDescriptor = { descriptor: string; target: string; device: string; inode: string; writable: boolean };
type ChildIdentity = { pid: number; parentPid: number; startTime: string; state: string };
type ChildCancellation = { child: ChildIdentity; before: Truth; requested: Truth; cancelled: Truth };
type PendingTermination = { child: ChildIdentity; sigPnd: string; shdPnd: string };

async function readChildIdentity(pid: number): Promise<ChildIdentity> {
    const text = await readFile("/proc/" + pid + "/stat", "utf8");
    const end = text.lastIndexOf(")");
    assert.ok(text.startsWith(pid + " (") && end > 0, "SETUP: malformed owned child proc stat");
    const fields = text
        .slice(end + 2)
        .trim()
        .split(/\s+/);
    const state = fields[0];
    const parent = fields[1];
    const startTime = fields[19];
    assert.ok(state && parent && startTime, "SETUP: incomplete owned child proc stat");
    return { pid, parentPid: Number(parent), startTime, state };
}

function assertSameChild(current: ChildIdentity, captured: ChildIdentity) {
    assert.equal(current.pid, captured.pid, "SETUP: child PID changed");
    assert.equal(current.parentPid, captured.parentPid, "SETUP: child parent changed");
    assert.equal(current.startTime, captured.startTime, "SETUP: child starttime changed");
}

async function workerFileDescriptors(worker: ChildIdentity): Promise<WorkerFileDescriptor[]> {
    assertSameChild(await readChildIdentity(worker.pid), worker);
    const descriptors = await readdir("/proc/" + worker.pid + "/fd");
    const observed = await Promise.all(
        descriptors.map(async (descriptor) => {
            const entry = "/proc/" + worker.pid + "/fd/" + descriptor;
            try {
                const target = await readlink(entry);
                const identity = await stat(entry, { bigint: true });
                const info = await readFile("/proc/" + worker.pid + "/fdinfo/" + descriptor, "utf8");
                const flags = /^flags:\s+([0-7]+)$/m.exec(info)?.[1];
                assert.ok(flags, "SETUP: Worker fd flags are missing");
                return { descriptor, target, device: identity.dev.toString(), inode: identity.ino.toString(), writable: (Number.parseInt(flags, 8) & (fileConstants.O_WRONLY | fileConstants.O_RDWR)) !== 0 };
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
                throw error;
            }
        }),
    );
    assertSameChild(await readChildIdentity(worker.pid), worker);
    return observed.filter((entry): entry is WorkerFileDescriptor => entry !== undefined);
}

type WorkerCase = {
    seed: Prepared;
    startup: Promise<void>;
    claimed: Promise<ClaimObservation>;
    inputRead: Promise<void>;
    notStartedRequested: Promise<NotStartedRequest>;
    inputSink: Promise<InputSink>;
    notStartedCancelled: Promise<NotStartedObservation>;
    notStartedCalls: { inputs: number; firstHeartbeat: boolean | undefined };
    failed: Promise<FailureObservation>;
    upload: Promise<CancellationUpload>;
    cancellationHeartbeat: Promise<CancellationHeartbeat>;
    cancelled: Promise<CancellationObservation>;
    uploadClosed: Promise<void>;
    released: Promise<Truth>;
    childStopped: Promise<ChildIdentity>;
    requestChildCancellation: () => Promise<ChildCancellation>;
    resumeCancelledChild: () => Promise<PendingTermination>;
    cancellationCalls: { heartbeats: number; acknowledgements: number; uploadAborts: number };
    calls: { uploads: number; completes: number; failures: number };
    waitFor: <T>(event: Promise<T>, milliseconds: number, message: string) => Promise<T>;
};

async function withPrepareWorker(source: Buffer, scenario: (fixture: WorkerCase) => Promise<void>, mode: "rejected" | "v8_heap_oom" | "cancel_after_child" | "cancel_during_child" | "cancel_before_first_heartbeat" | "cancel_during_input" = "rejected") {
    const notStartedMode = mode === "cancel_before_first_heartbeat" || mode === "cancel_during_input";
    if (notStartedMode) assert.equal(process.platform, "linux", "SETUP: not-started TCP qualification requires Linux procfs");
    const directory = await mkdtemp(path.join(tmpdir(), "vozeb-worker-fault-"));
    const workerTemp = path.join(directory, "worker-temp");
    const workerId = "fixture-image-fault-" + randomUUID();
    const workerToken = "fixture-image-fault-worker-token-00000001";
    vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
    vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
    vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-image-fault-maintenance-token-0001");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", mode === "v8_heap_oom" ? "1" : "384");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
    vi.resetModules();
    try {
        await mkdir(workerTemp);
        const workerScript = fileURLToPath(new URL("../../../scripts/generation-worker.mjs", import.meta.url));
        for (const name of ["image-processing-child.mjs", "image-processing-lane.mjs"]) {
            const entry = fileURLToPath(new URL("../../../.image-processing-runtime/workers/" + name, import.meta.url));
            const info = await stat(entry).catch((error: unknown) => {
                throw new Error("SETUP: build the actual image runtime before fault qualification", { cause: error });
            });
            assert.ok(info.isFile());
        }
        const seed = await seedPrepare(source, "fixture-fault-user-" + randomUUID());
        const startup = Promise.withResolvers<void>();
        const claimed = Promise.withResolvers<ClaimObservation>();
        const inputRead = Promise.withResolvers<void>();
        const failed = Promise.withResolvers<FailureObservation>();
        const upload = Promise.withResolvers<CancellationUpload>();
        const cancellationHeartbeat = Promise.withResolvers<CancellationHeartbeat>();
        const cancelled = Promise.withResolvers<CancellationObservation>();
        const notStartedRequested = Promise.withResolvers<NotStartedRequest>();
        const inputSink = Promise.withResolvers<InputSink>();
        const notStartedCancelled = Promise.withResolvers<NotStartedObservation>();
        const inputDisconnected = Promise.withResolvers<void>();
        const inputObserverStop = new AbortController();
        const uploadClosed = Promise.withResolvers<void>();
        const released = Promise.withResolvers<Truth>();
        const childStopped = Promise.withResolvers<ChildIdentity>();
        const childObserverStop = new AbortController();
        let childObserver: Promise<void> | undefined;
        let pausedChild: ChildIdentity | undefined;
        let pendingTerminationSeen = false;
        let childStopEstablished = false;
        const cancellationCalls = { heartbeats: 0, acknowledgements: 0, uploadAborts: 0 };
        const fixtureFailure = Promise.withResolvers<never>();
        const startupSignal = Promise.race([startup.promise, fixtureFailure.promise]);
        const requests = new Set<Promise<void>>();
        const ordinary = new Set<string>();
        const calls = { uploads: 0, completes: 0, failures: 0 };
        let refundSeen = false;
        let heartbeatSeen = false;
        let identity: ClaimObservation["identity"] | undefined;
        let workerPid: number | undefined;
        let observedFailure: unknown;
        let finalFailure: FailureObservation | undefined;
        let finalCancellation: CancellationObservation | undefined;
        let finalNotStarted: NotStartedObservation | undefined;
        let ownedWorker: ChildIdentity | undefined;
        let heldInputResponse: ServerResponse | undefined;
        let observedSink: InputSink | undefined;
        let inputResponseClosedAt = 0;
        let inputSocketClosedAt = 0;
        let inputClosedDuringCleanup = false;
        let inputCleanupStarted = false;
        let inputSequence = 0;
        const notStartedCalls: { inputs: number; firstHeartbeat: boolean | undefined } = { inputs: 0, firstHeartbeat: undefined };
        let stdout = "";
        let stderr = "";
        let origin: string;

        async function captureChild() {
            assert.ok(workerPid, "SETUP: real Worker PID missing before child capture");
            const parentPid = workerPid;
            let captured: ChildIdentity | undefined;
            try {
                for (;;) {
                    childObserverStop.signal.throwIfAborted();
                    if (!captured) {
                        const text = (await readFile("/proc/" + parentPid + "/task/" + parentPid + "/children", "utf8")).trim();
                        if (!text) continue;
                        const ids = text.split(/\s+/);
                        assert.equal(ids.length, 1, "SETUP: expected one real Worker child, not a replacement PID");
                        const pid = Number(ids[0]);
                        assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== parentPid && pid !== process.pid, "SETUP: invalid real child PID");
                        captured = await readChildIdentity(pid);
                        assert.equal(captured.parentPid, parentPid, "SETUP: child is not owned by this Worker");
                    }
                    const pid = captured.pid;
                    const current = await readChildIdentity(pid);
                    assertSameChild(current, captured);
                    assert.notEqual(current.state, "Z", "SETUP: real child closed before the exec barrier");
                    const args = (await readFile("/proc/" + pid + "/cmdline", "utf8")).split("\0");
                    assert.equal(args.pop(), "", "SETUP: malformed real child command line");
                    // This owned PID is visible before exec replaces the Worker's argv.
                    if (args.length === 0 || (args.length === 3 && args[0] === process.execPath && args[1] === "--max-old-space-size=64" && args[2] === workerScript)) continue;
                    assert.deepEqual(
                        args,
                        [process.execPath, "--max-old-space-size=" + seed.profile.processHeapMb, fileURLToPath(new URL("../../../.image-processing-runtime/workers/image-processing-child.mjs", import.meta.url))],
                        "SETUP: child is not the actual image runtime",
                    );
                    assertSameChild(await readChildIdentity(pid), captured);
                    pausedChild = captured;
                    process.kill(pid, "SIGSTOP");
                    for (;;) {
                        childObserverStop.signal.throwIfAborted();
                        const current = await readChildIdentity(pid);
                        assertSameChild(current, captured);
                        if (current.state === "T") {
                            childStopEstablished = true;
                            childStopped.resolve(current);
                            return;
                        }
                        assert.notEqual(current.state, "Z", "SETUP: real child closed before the STOP barrier");
                    }
                }
            } catch (error) {
                if (childObserverStop.signal.aborted) return;
                throw new Error("SETUP: could not capture and STOP this one real child", { cause: error });
            }
        }

        async function requestChildCancellation(): Promise<ChildCancellation> {
            assert.ok(pausedChild, "SETUP: child was not captured");
            const current = await readChildIdentity(pausedChild.pid);
            assertSameChild(current, pausedChild);
            assert.equal(current.state, "T", "SETUP: real child is not held before cancellation");
            const before = await truth();
            const cancellation = { requestedAt: Date.now(), pendingChildTaskIds: [seed.child.id] };
            assert.ok(await seed.tasks.mutateStoredGenerationTask<AgentRun>("agent", seed.parent.id, 365 * 24 * 60 * 60 * 1000, (parent) => ({ ...parent, cancellation })));
            const requested = await truth();
            await expect(seed.service.cancelImageProcessingTaskForRun({ userId: seed.userId, runId: seed.parent.id, jobId: seed.child.id })).resolves.toBeUndefined();
            return { child: current, before, requested, cancelled: await truth() };
        }

        async function resumeCancelledChild(): Promise<PendingTermination> {
            assert.ok(pausedChild, "SETUP: no owned paused child to resume");
            const captured = pausedChild;
            expect(cancellationCalls.heartbeats).toBe(1);
            for (;;) {
                childObserverStop.signal.throwIfAborted();
                const child = await readChildIdentity(captured.pid);
                assertSameChild(child, captured);
                assert.equal(child.state, "T", "Real child left the STOP barrier before pending termination");
                const status = await readFile("/proc/" + captured.pid + "/status", "utf8");
                const sigPnd = /^SigPnd:\s*([0-9a-f]+)$/im.exec(status)?.[1];
                const shdPnd = /^ShdPnd:\s*([0-9a-f]+)$/im.exec(status)?.[1];
                assert.ok(sigPnd && shdPnd, "SETUP: real child pending signals unavailable");
                const pending = BigInt("0x" + sigPnd) | BigInt("0x" + shdPnd);
                if ((pending & (BigInt(1) << BigInt(constants.signals.SIGTERM - 1))) === BigInt(0)) continue;
                assertSameChild(await readChildIdentity(captured.pid), captured);
                pendingTerminationSeen = true;
                process.kill(captured.pid, "SIGCONT");
                return { child, sigPnd, shdPnd };
            }
        }

        async function restoreOwnedChild() {
            if (!pausedChild) return;
            let current: ChildIdentity;
            try {
                current = await readChildIdentity(pausedChild.pid);
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
                throw error;
            }
            assertSameChild(current, pausedChild);
            try {
                process.kill(current.pid, "SIGCONT");
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
                throw error;
            }
        }

        async function truth(): Promise<Truth> {
            const rows = await seed.tasks.withGenerationTaskFileMutation(async (records) => ({
                tasks: records,
                result: records.filter((record) => record.userId === seed.userId).toSorted((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id)),
            }));
            const media = (await seed.registrations.listFileLocalMediaRegistrations()).filter((record) => record.ownerUserId === seed.userId).toSorted((left, right) => left.storageKey.localeCompare(right.storageKey));
            return { rows, media, sourceBytes: await readFile(seed.sourcePath) };
        }

        function diagnostics(message: string) {
            return message + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr;
        }

        async function requestNotStartedCancellation() {
            const before = await truth();
            const cancellation = { requestedAt: Date.now(), pendingChildTaskIds: [seed.child.id] };
            assert.ok(await seed.tasks.mutateStoredGenerationTask<AgentRun>("agent", seed.parent.id, 365 * 24 * 60 * 60 * 1000, (parent) => ({ ...parent, cancellation })));
            const requested = await truth();
            await expect(seed.service.cancelImageProcessingTaskForRun({ userId: seed.userId, runId: seed.parent.id, jobId: seed.child.id })).resolves.toBeUndefined();
            notStartedRequested.resolve({ before, requested, cancelled: await truth() });
        }

        async function holdInput(request: IncomingMessage, response: ServerResponse, bytes: Buffer) {
            const worker = ownedWorker;
            assert.ok(worker);
            expect(notStartedCalls.firstHeartbeat).toBe(false);
            const directories = await readdir(workerTemp);
            expect(directories).toHaveLength(1);
            const directoryName = directories[0];
            assert.ok(directoryName && directoryName.startsWith("vozeb-image-processing-"));
            const taskDirectory = path.join(workerTemp, directoryName);
            const filePath = path.join(taskDirectory, "input-0");
            const prefix = bytes.subarray(0, 8);
            expect(prefix).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            expect(bytes.length).toBeGreaterThan(prefix.length);
            const socket = request.socket;
            heldInputResponse = response;
            response.once("close", () => {
                inputResponseClosedAt = ++inputSequence;
                inputClosedDuringCleanup ||= inputCleanupStarted;
            });
            socket.once("close", () => {
                inputSocketClosedAt = ++inputSequence;
                inputClosedDuringCleanup ||= inputCleanupStarted;
                inputDisconnected.resolve();
            });
            let changed = Promise.withResolvers<void>();
            let watchError: unknown;
            const watcher = watch(taskDirectory, () => changed.resolve());
            watcher.once("error", (error) => {
                watchError = error;
                observedFailure ??= error;
                fixtureFailure.reject(error);
                changed.resolve();
            });
            const stopObserving = () => changed.resolve();
            inputObserverStop.signal.addEventListener("abort", stopObserving);
            try {
                response.setHeader("content-length", bytes.length);
                response.writeHead(200);
                response.flushHeaders();
                response.write(prefix);
                for (;;) {
                    const nextChange = changed.promise;
                    if (watchError !== undefined) throw watchError;
                    if (inputObserverStop.signal.aborted) throw new Error("CLEANUP: held input observation interrupted");
                    const partial = await stat(filePath).catch((error: unknown) => {
                        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
                        throw error;
                    });
                    if (partial) {
                        const written = await readFile(filePath);
                        if (written.length) {
                            expect(written).toEqual(prefix);
                            const fileIdentity = await stat(filePath, { bigint: true });
                            const device = fileIdentity.dev.toString();
                            const inode = fileIdentity.ino.toString();
                            const writers = (await workerFileDescriptors(worker)).filter((entry) => entry.device === device && entry.inode === inode && entry.writable);
                            if (writers.length) {
                                observedSink = { filePath, device, inode, writableFds: writers.map((entry) => entry.descriptor), prefix: written };
                                inputSink.resolve(observedSink);
                                break;
                            }
                        }
                    }
                    await nextChange;
                    changed = Promise.withResolvers<void>();
                }
            } finally {
                watcher.close();
                inputObserverStop.signal.removeEventListener("abort", stopObserving);
            }
            await requestNotStartedCancellation();
            await inputDisconnected.promise;
            expect(response.writableEnded).toBe(false);
            expect(socket.destroyed).toBe(true);
            expect(inputClosedDuringCleanup).toBe(false);
        }

        async function handle(request: IncomingMessage, response: ServerResponse) {
            assert.ok(request.url);
            const url = new URL(request.url, origin);
            const authorization = request.headers.authorization;
            expect(authorization).toBe("Bearer " + workerToken);
            assert.ok(typeof authorization === "string");
            if (url.pathname === "/api/maintenance/generation-tasks/run") {
                expect(request.method).toBe("POST");
                const id = request.headers["x-vozeb-pro-worker-id"];
                assert.ok(typeof id === "string");
                expect([workerId + ":lane-1", workerId + ":lane-2"]).toContain(id);
                ordinary.add(id);
            } else if (url.pathname === "/api/maintenance/billing-refunds/run") {
                expect(request.method).toBe("POST");
                expect(request.headers["x-vozeb-pro-worker-id"]).toBe(workerId + ":billing-refunds");
                refundSeen = true;
            } else if (url.pathname === "/api/maintenance/generation-tasks/heartbeat") {
                expect(request.method).toBe("POST");
                expect(request.headers["x-vozeb-pro-worker-id"]).toBe(workerId);
                heartbeatSeen = true;
            } else {
                return handleImage(request, response, url, authorization);
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: 0, data: { claimed: 0 }, msg: "OK" }));
            if (ordinary.size === 2 && refundSeen && heartbeatSeen) startup.resolve();
        }

        async function handleImage(request: IncomingMessage, response: ServerResponse, url: URL, authorization: string) {
            if (url.pathname === "/api/maintenance/image-processing/claim") {
                expect(request.method).toBe("POST");
                const text = (await requestBytes(request)).toString("utf8");
                const body: unknown = JSON.parse(text);
                assert.ok(body && typeof body === "object" && "workerId" in body && typeof body.workerId === "string");
                const input: ClaimImageProcessingInput = { workerId: body.workerId, profileVersion: seed.profile.profileVersion, availableMemoryBytes: 1073741824, slots: 1 };
                expect(body).toStrictEqual(input);
                const result = await seed.claimRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }));
                expect(result.status).toBe(200);
                const envelope: { code: number; data: { tasks: ClaimedImageProcessingTask[] }; msg: string } = await result.clone().json();
                expect(envelope.code).toBe(0);
                if (!identity) {
                    expect(envelope.data.tasks).toHaveLength(1);
                    const task = envelope.data.tasks[0];
                    assert.ok(task);
                    expect(task).toStrictEqual({
                        id: seed.child.id,
                        executionId: expect.any(String),
                        leaseUntil: expect.any(Number),
                        payload: { ...seed.child.payload, executionId: task.executionId },
                        inputUrls: ["/api/maintenance/image-processing/" + seed.child.id + "/inputs/" + seed.asset.id],
                    });
                    identity = { workerId: input.workerId, executionId: task.executionId };
                    if (notStartedMode) {
                        assert.ok(workerPid);
                        ownedWorker = await readChildIdentity(workerPid);
                        expect(ownedWorker.parentPid).toBe(process.pid);
                    }
                    if (mode === "cancel_before_first_heartbeat") await requestNotStartedCancellation();
                    claimed.resolve({ task, identity });
                } else {
                    expect(envelope.data.tasks).toStrictEqual([]);
                    if (mode === "v8_heap_oom" && finalFailure) released.resolve(await truth());
                    if (mode !== "rejected" && finalCancellation) {
                        const current = await truth();
                        expect(current).toStrictEqual(finalCancellation.after);
                        expect(await readdir(workerTemp)).toStrictEqual([]);
                        released.resolve(current);
                    }
                    if (notStartedMode) {
                        const current = await truth();
                        if (!finalNotStarted) {
                            assert.equal(cancellationCalls.heartbeats, 1, "SETUP/UNKNOWN: reservation returned before the cancellation heartbeat evidence");
                            expect(current.rows.find((row) => row.id === seed.child.id)).toMatchObject({ status: "cancelled", executionPhase: "cancel_requested" });
                            if (mode === "cancel_during_input") {
                                const sink = observedSink;
                                const worker = ownedWorker;
                                assert.ok(sink && worker, "SETUP/UNKNOWN: missing held input sink evidence before reservation returned");
                                assert.ok(inputResponseClosedAt > 0 && inputSocketClosedAt > 0, "SETUP/UNKNOWN: input close events were not observed before reservation returned");
                                expect(inputClosedDuringCleanup).toBe(false);
                                const descriptors = await workerFileDescriptors(worker);
                                expect(
                                    descriptors.filter((entry) => entry.device === sink.device && entry.inode === sink.inode),
                                    "SETUP/UNKNOWN: input descriptor remains open at the missing-receipt budget gate",
                                ).toStrictEqual([]);
                            }
                            throw new Error(diagnostics("RED: full budget returned after cancellation heartbeat without a not-started receipt; raw=" + JSON.stringify(current)));
                        }
                        expect(current).toStrictEqual(finalNotStarted.after);
                        expect(await readdir(workerTemp)).toStrictEqual([]);
                        released.resolve(current);
                    }
                }
                await relay(result, response);
                return;
            }
            assert.ok(identity);
            const endpoint = "/api/maintenance/image-processing/" + seed.child.id;
            if (url.pathname === endpoint + "/inputs/" + seed.asset.id) {
                if (notStartedMode) notStartedCalls.inputs += 1;
                if (mode === "cancel_before_first_heartbeat") throw new Error("Initial cancellation unexpectedly reached an input GET");
                if (mode === "cancel_during_input") expect(notStartedCalls.inputs).toBe(1);
                expect(request.method).toBe("GET");
                expect(request.headers["x-vozeb-pro-worker-id"]).toBe(identity.workerId);
                expect(request.headers["x-vozeb-pro-execution-id"]).toBe(identity.executionId);
                const before = await truth();
                const result = await seed.inputRoute.GET(new Request(url, { headers: { authorization, "x-vozeb-pro-worker-id": identity.workerId, "x-vozeb-pro-execution-id": identity.executionId } }), {
                    params: Promise.resolve({ id: seed.child.id, assetId: seed.asset.id }),
                });
                expect(result.status).toBe(200);
                const bytes = Buffer.from(await result.arrayBuffer());
                expect(bytes).toEqual(source);
                expect(await truth()).toStrictEqual(before);
                for (const [name, value] of result.headers) response.setHeader(name, value);
                if (mode === "cancel_during_input") {
                    await holdInput(request, response, bytes);
                    return;
                }
                response.writeHead(result.status);
                if (mode === "cancel_during_child") {
                    assert.equal(process.platform, "linux", "SETUP: controlled real child cancellation requires Linux procfs");
                    assert.ok(workerPid);
                    assert.equal((await readFile("/proc/" + workerPid + "/task/" + workerPid + "/children", "utf8")).trim(), "", "SETUP: Worker already has a child before input EOF");
                    childObserver = captureChild().catch((error: unknown) => {
                        observedFailure ??= error;
                        fixtureFailure.reject(error);
                    });
                }
                response.end(bytes);
                inputRead.resolve();
                return;
            }
            if (url.pathname === endpoint + "/heartbeat") {
                const text = (await requestBytes(request)).toString("utf8");
                if (mode !== "rejected") {
                    expect(request.method).toBe("POST");
                    const body: unknown = JSON.parse(text);
                    const before = await truth();
                    if (notStartedMode && body && typeof body === "object" && (Object.hasOwn(body, "notStarted") || Object.hasOwn(body, "closed") || Object.hasOwn(body, "stopCause"))) {
                        const ackReceivedAt = ++inputSequence;
                        cancellationCalls.acknowledgements += 1;
                        expect(cancellationCalls.acknowledgements).toBe(1);
                        expect(body).toStrictEqual({ ...identity, notStarted: true, stopCause: "cancel_requested" });
                        expect(cancellationCalls.heartbeats).toBe(1);
                        let closure: InputClosure | undefined;
                        if (mode === "cancel_during_input") {
                            const sink = observedSink;
                            const worker = ownedWorker;
                            const held = heldInputResponse;
                            assert.ok(sink && worker && held, "SETUP/UNKNOWN: ACK arrived without a positive input sink observation");
                            assert.ok(inputResponseClosedAt > 0 && inputSocketClosedAt > 0, "SETUP/UNKNOWN: input close events were not observed before ACK receipt");
                            expect(inputClosedDuringCleanup).toBe(false);
                            expect(held.writableEnded).toBe(false);
                            const descriptors = await workerFileDescriptors(worker);
                            expect(
                                descriptors.filter((entry) => entry.device === sink.device && entry.inode === sink.inode),
                                "Input write descriptor remains open before ACK Route acceptance",
                            ).toStrictEqual([]);
                            closure = { sink, responseClosedAt: inputResponseClosedAt, socketClosedAt: inputSocketClosedAt, ackReceivedAt, fdAbsentAt: ++inputSequence };
                        } else {
                            expect(notStartedCalls.inputs).toBe(0);
                            expect(await readdir(workerTemp)).toStrictEqual([]);
                        }
                        const result = await seed.heartbeatRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }), { params: Promise.resolve({ id: seed.child.id }) });
                        expect(result.status).toBe(200);
                        expect(result.headers.get("cache-control")).toBe("no-store");
                        const input: NotStartedInput = JSON.parse(text);
                        const envelope: { code: number; data: CancellationReceipt; msg: string } = await result.clone().json();
                        expect(envelope).toStrictEqual({ code: 0, data: { jobId: seed.child.id, executionId: identity.executionId, status: "cancelled", executionPhase: "completed" }, msg: "OK" });
                        finalNotStarted = { input, receipt: envelope.data, before, after: await truth(), ...(closure ? { closure } : {}) };
                        await relay(result, response);
                        notStartedCancelled.resolve(finalNotStarted);
                        return;
                    }
                    if (body && typeof body === "object" && ("closed" in body || "stopCause" in body)) {
                        cancellationCalls.acknowledgements += 1;
                        expect(cancellationCalls.acknowledgements).toBe(1);
                        assert.ok("closed" in body && body.closed && typeof body.closed === "object" && "pid" in body.closed && typeof body.closed.pid === "number" && Number.isSafeInteger(body.closed.pid) && body.closed.pid > 0);
                        const childPid = body.closed.pid;
                        if (mode === "cancel_during_child") {
                            assert.ok(pausedChild);
                            expect(childPid).toBe(pausedChild.pid);
                            expect(pendingTerminationSeen).toBe(true);
                        }
                        expect(childPid).not.toBe(workerPid);
                        expect(childPid).not.toBe(process.pid);
                        expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
                        const result = await seed.heartbeatRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }), { params: Promise.resolve({ id: seed.child.id }) });
                        expect(result.status).toBe(200);
                        // Preserve the actual validated report, including a possibly wrong stopCause, for the final contract assertion.
                        const input: CancellationInput = JSON.parse(text);
                        const envelope: { code: number; data: CancellationReceipt; msg: string } = await result.clone().json();
                        expect(envelope).toStrictEqual({ code: 0, data: { jobId: seed.child.id, executionId: identity.executionId, status: "cancelled", executionPhase: "completed" }, msg: "OK" });
                        finalCancellation = { input, receipt: envelope.data, before, after: await truth() };
                        await relay(result, response);
                        cancelled.resolve(finalCancellation);
                        return;
                    }
                    expect(body).toStrictEqual(identity);
                    expect(finalCancellation).toBeUndefined();
                    if (notStartedMode) expect(finalNotStarted).toBeUndefined();
                    const result = await seed.heartbeatRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }), { params: Promise.resolve({ id: seed.child.id }) });
                    expect(result.status).toBe(200);
                    const renewal: { code: number; data: { leaseUntil: number; cancelRequested: boolean }; msg: string } = await result.clone().json();
                    const child = before.rows.find((row) => row.id === seed.child.id);
                    assert.ok(child);
                    const requested = child.status === "cancelled" && child.executionPhase === "cancel_requested";
                    if (notStartedMode && notStartedCalls.firstHeartbeat === undefined) {
                        notStartedCalls.firstHeartbeat = requested;
                        if (mode === "cancel_before_first_heartbeat") expect(requested).toBe(true);
                    }
                    expect(renewal).toStrictEqual({ code: 0, data: { leaseUntil: expect.any(Number), cancelRequested: requested }, msg: "OK" });
                    if (requested) {
                        cancellationCalls.heartbeats += 1;
                        expect(cancellationCalls.heartbeats).toBe(1);
                        cancellationHeartbeat.resolve({ before, after: await truth(), leaseUntil: renewal.data.leaseUntil });
                    }
                    await relay(result, response);
                    return;
                }
                expect(JSON.parse(text)).toStrictEqual(identity);
                const result = await seed.heartbeatRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }), { params: Promise.resolve({ id: seed.child.id }) });
                if (result.status === 409) {
                    expect(await seed.tasks.getStoredGenerationTaskRecord("image_processing", seed.child.id)).toMatchObject({ status: "error", executionPhase: "needs_review", resultPayload: identity });
                } else {
                    expect(result.status).toBe(200);
                    const renewal: { code: number; data: { leaseUntil: number; cancelRequested: boolean }; msg: string } = await result.clone().json();
                    expect(renewal).toStrictEqual({ code: 0, data: { leaseUntil: expect.any(Number), cancelRequested: false }, msg: "OK" });
                }
                await relay(result, response);
                return;
            }
            if (url.pathname === endpoint + "/fail") {
                calls.failures += 1;
                if (notStartedMode) throw new Error("Not-started cancellation unexpectedly submitted a failure");
                expect(calls.failures).toBe(1);
                expect(request.method).toBe("POST");
                const text = (await requestBytes(request)).toString("utf8");
                const body: unknown = JSON.parse(text);
                assert.ok(
                    body &&
                        typeof body === "object" &&
                        "failure" in body &&
                        body.failure &&
                        typeof body.failure === "object" &&
                        "pid" in body.failure &&
                        typeof body.failure.pid === "number" &&
                        Number.isSafeInteger(body.failure.pid) &&
                        body.failure.pid > 0,
                );
                const childPid = body.failure.pid;
                expect(childPid).not.toBe(workerPid);
                expect(childPid).not.toBe(process.pid);
                expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
                const before = await truth();
                const result = await seed.failRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: text }), { params: Promise.resolve({ id: seed.child.id }) });
                expect(result.status).toBe(200);
                // The real Route validates the Worker DTO before it becomes typed fixture evidence.
                const input: FailImageProcessingInput = JSON.parse(text);
                const envelope: { code: number; data: FailedImageProcessingStage; msg: string } = await result.clone().json();
                expect(envelope.code).toBe(0);
                finalFailure = { input, receipt: envelope.data, before, after: await truth() };
                await relay(result, response);
                failed.resolve(finalFailure);
                return;
            }
            if (url.pathname.startsWith(endpoint + "/outputs/")) {
                calls.uploads += 1;
                if (mode === "cancel_during_child") throw new Error(childStopEstablished ? "Cancelled spawned child unexpectedly started an output PUT" : "SETUP: real child reached output before the STOP capture barrier");
                if (mode === "cancel_after_child") {
                    expect(calls.uploads).toBe(1);
                    expect(request.method).toBe("PUT");
                    expect(url.pathname).toBe(endpoint + "/outputs/analysis");
                    expect(url.search).toBe("");
                    expect(request.headers["x-vozeb-pro-worker-id"]).toBe(identity.workerId);
                    expect(request.headers["x-vozeb-pro-execution-id"]).toBe(identity.executionId);
                    expect(request.headers["content-type"]).toBe("image/png");
                    const disconnected = new Promise<void>((resolve) => response.once("close", resolve));
                    const bytes = await requestBytes(request);
                    expect(bytes).toEqual(source);
                    const before = await truth();
                    const cancellation = { requestedAt: Date.now(), pendingChildTaskIds: [seed.child.id] };
                    assert.ok(await seed.tasks.mutateStoredGenerationTask<AgentRun>("agent", seed.parent.id, 365 * 24 * 60 * 60 * 1000, (parent) => ({ ...parent, cancellation })));
                    const requested = await truth();
                    await expect(seed.service.cancelImageProcessingTaskForRun({ userId: seed.userId, runId: seed.parent.id, jobId: seed.child.id })).resolves.toBeUndefined();
                    upload.resolve({ before, requested, cancelled: await truth(), bytes });
                    // Hold the real PUT response until the Worker's cancellation heartbeat aborts its upload.
                    await disconnected;
                    expect(response.writableEnded).toBe(false);
                    expect(cancellationCalls.heartbeats).toBe(1);
                    cancellationCalls.uploadAborts += 1;
                    uploadClosed.resolve();
                    return;
                }
            }
            if (url.pathname === endpoint + "/complete") calls.completes += 1;
            throw new Error("Unexpected rejected-job Worker TCP path: " + url.pathname);
        }

        const server = createServer((request, response) => {
            const running = handle(request, response)
                .catch((error: unknown) => {
                    observedFailure ??= error;
                    fixtureFailure.reject(error);
                    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
                    response.end(JSON.stringify({ code: 500, data: null, msg: "Worker fault fixture rejected the request" }));
                })
                .finally(() => requests.delete(running));
            requests.add(running);
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                });
            });
            server.on("error", (error) => {
                observedFailure ??= error;
                fixtureFailure.reject(error);
            });
            const address = server.address();
            assert.ok(address && typeof address !== "string");
            origin = "http://127.0.0.1:" + address.port;
            const worker = spawn(process.execPath, ["--max-old-space-size=64", workerScript], {
                cwd: path.dirname(path.dirname(workerScript)),
                env: {
                    ...process.env,
                    TMPDIR: workerTemp,
                    TMP: workerTemp,
                    TEMP: workerTemp,
                    VOZEB_PRO_WORKER_API_ORIGIN: origin,
                    VOZEB_PRO_GENERATION_WORKER_ID: workerId,
                    VOZEB_PRO_GENERATION_WORKER_LANES: "2",
                    VOZEB_PRO_GENERATION_WORKER_HEARTBEAT_MS: "5000",
                },
                stdio: "pipe",
            });
            const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
                worker.once("error", (error) => reject(new Error("SETUP: actual fault Worker could not start", { cause: error })));
                worker.once("close", (code, signal) => resolve({ code, signal }));
            });
            workerPid = worker.pid;
            worker.stdin.end();
            worker.stdout.setEncoding("utf8");
            worker.stderr.setEncoding("utf8");
            worker.stdout.on("data", (chunk: string) => {
                stdout += chunk;
            });
            worker.stderr.on("data", (chunk: string) => {
                stderr += chunk;
            });
            const unexpectedExit = closed.then((exit) => {
                throw new Error(diagnostics("Worker exited before fault observation: " + JSON.stringify(exit)));
            });
            async function waitFor<T>(event: Promise<T>, milliseconds: number, message: string): Promise<T> {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    const deadline = new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error(diagnostics(message))), milliseconds);
                    });
                    return await Promise.race([event, fixtureFailure.promise, unexpectedExit, deadline]);
                } finally {
                    clearTimeout(timer);
                }
            }
            let scenarioError: unknown;
            try {
                assert.ok(workerPid, "SETUP: actual Worker has no PID");
                await scenario({
                    seed,
                    startup: startupSignal,
                    claimed: claimed.promise,
                    inputRead: inputRead.promise,
                    notStartedRequested: notStartedRequested.promise,
                    inputSink: inputSink.promise,
                    notStartedCancelled: notStartedCancelled.promise,
                    notStartedCalls,
                    failed: failed.promise,
                    upload: upload.promise,
                    cancellationHeartbeat: cancellationHeartbeat.promise,
                    cancelled: cancelled.promise,
                    uploadClosed: uploadClosed.promise,
                    released: released.promise,
                    childStopped: childStopped.promise,
                    requestChildCancellation,
                    resumeCancelledChild,
                    cancellationCalls,
                    calls,
                    waitFor,
                });
                expect(stderr, diagnostics("Worker reported an unknown image fault outcome")).toBe("");
            } catch (error) {
                scenarioError = error;
                throw error;
            } finally {
                inputCleanupStarted = true;
                inputObserverStop.abort();
                heldInputResponse?.destroy();
                childObserverStop.abort();
                await childObserver;
                const cleanupErrors: unknown[] = [];
                try {
                    await restoreOwnedChild();
                } catch (error) {
                    cleanupErrors.push(error);
                }
                try {
                    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
                    let closeTimer: ReturnType<typeof setTimeout> | undefined;
                    const exited = await Promise.race([
                        closed.then(() => true),
                        new Promise<boolean>((resolve) => {
                            closeTimer = setTimeout(() => resolve(false), 15_000);
                        }),
                    ]).finally(() => clearTimeout(closeTimer));
                    if (!exited) {
                        worker.kill("SIGKILL");
                        await closed;
                        throw new Error(diagnostics("CLEANUP: forced SIGKILL is not valid rejected/fail qualification"));
                    }
                    expect(await closed).toStrictEqual({ code: 0, signal: null });
                    await Promise.all([...requests]);
                    if (observedFailure) throw observedFailure;
                    expect(stderr, diagnostics("Worker reported an unknown image fault outcome")).toBe("");
                    expect(await seed.registrations.getLocalMediaRegistration(seed.original.token)).toStrictEqual(seed.registration);
                    expect(await readFile(seed.sourcePath)).toEqual(source);
                    expect(await readdir(workerTemp)).toStrictEqual([]);
                    if (finalFailure) expect(await truth()).toStrictEqual(finalFailure.after);
                    if (finalCancellation) expect(await truth()).toStrictEqual(finalCancellation.after);
                    if (finalNotStarted) expect(await truth()).toStrictEqual(finalNotStarted.after);
                } catch (error) {
                    cleanupErrors.push(error);
                }
                if (cleanupErrors.length) {
                    if (scenarioError !== undefined) cleanupErrors.unshift(scenarioError);
                    throw new AggregateError(cleanupErrors, diagnostics("CLEANUP: controlled child recovery or Worker drain failed"));
                }
            }
        } finally {
            server.closeAllConnections();
            if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    } finally {
        try {
            await rm(directory, { recursive: true, force: true });
        } finally {
            vi.unstubAllEnvs();
        }
    }
}

function expectNotStartedTruth(seed: Prepared, claimed: ClaimObservation, cancellation: NotStartedRequest, heartbeat: CancellationHeartbeat, observed: NotStartedObservation, released: Truth) {
    expect(cancellation.before.rows).toHaveLength(2);
    const beforeParent = cancellation.before.rows.find((row) => row.id === seed.parent.id);
    const beforeChild = cancellation.before.rows.find((row) => row.id === seed.child.id);
    assert.ok(beforeParent && beforeChild);
    expect(beforeParent).toStrictEqual(seed.parent);
    expect(beforeChild).toMatchObject({ status: "running", executionPhase: "created", workerId: claimed.identity.workerId, leaseUntil: expect.any(Number), lastHeartbeatAt: expect.any(Number) });
    expect(beforeChild.payload).toStrictEqual({ ...seed.child.payload, executionId: claimed.identity.executionId });
    expect(beforeChild.resultPayload).toBeUndefined();
    const requestedParent = cancellation.requested.rows.find((row) => row.id === seed.parent.id);
    assert.ok(requestedParent);
    expect(cancellation.requested).toStrictEqual({
        ...cancellation.before,
        rows: [
            { ...beforeParent, updatedAt: expect.any(Number), expiresAt: expect.any(Number), payload: { ...beforeParent.payload, updatedAt: expect.any(Number), cancellation: { requestedAt: expect.any(Number), pendingChildTaskIds: [seed.child.id] } } },
            beforeChild,
        ],
    });
    const { nextPollAt, ...ownedChild } = beforeChild;
    expect(nextPollAt).toBeTypeOf("number");
    expect(cancellation.cancelled).toStrictEqual({ ...cancellation.requested, rows: [requestedParent, { ...ownedChild, status: "cancelled", executionPhase: "cancel_requested", updatedAt: expect.any(Number) }] });
    const cancelledChild = cancellation.cancelled.rows.find((row) => row.id === seed.child.id);
    assert.ok(cancelledChild && typeof cancelledChild.leaseUntil === "number");
    expect(heartbeat.before).toStrictEqual(cancellation.cancelled);
    expect(heartbeat.leaseUntil).toBeGreaterThanOrEqual(cancelledChild.leaseUntil);
    expect(heartbeat.after).toStrictEqual({ ...heartbeat.before, rows: [requestedParent, { ...cancelledChild, leaseUntil: heartbeat.leaseUntil, lastHeartbeatAt: expect.any(Number) }] });
    expect(observed.before).toStrictEqual(heartbeat.after);
    const beforeAck = observed.before.rows.find((row) => row.id === seed.child.id);
    assert.ok(beforeAck);
    const { workerId, leaseUntil, lastHeartbeatAt, nextPollAt: cancelledPoll, ...releasedChild } = beforeAck;
    expect(workerId).toBe(claimed.identity.workerId);
    expect(leaseUntil).toBe(heartbeat.leaseUntil);
    expect(lastHeartbeatAt).toBeTypeOf("number");
    expect(cancelledPoll).toBeUndefined();
    expect(observed.input).toStrictEqual({ ...claimed.identity, notStarted: true, stopCause: "cancel_requested" });
    expect(observed.receipt).toStrictEqual({ jobId: seed.child.id, executionId: claimed.identity.executionId, status: "cancelled", executionPhase: "completed" });
    expect(observed.after).toStrictEqual({
        ...observed.before,
        rows: [requestedParent, { ...releasedChild, executionPhase: "completed", updatedAt: expect.any(Number), resultPayload: { executionId: claimed.identity.executionId, cancelNotStarted: { ...observed.input, receipt: observed.receipt } } }],
    });
    expect(observed.after.media).toStrictEqual([seed.registration]);
    expect(observed.after.sourceBytes).toEqual(cancellation.before.sourceBytes);
    expect(released).toStrictEqual(observed.after);
}

it("forwards a naturally closed prepare child invalid_image rejection over real TCP and pauses its original parent", async () => {
    const source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#8a6243" } })
        .png()
        .toBuffer();
    const idat = source.indexOf(Buffer.from("IDAT"));
    assert.ok(idat >= 12 && idat + 4 < source.length, "SETUP: generated PNG has no IDAT payload");
    // Keep the real PNG header, but invalidate its zlib stream before any registration or hash freeze.
    source[idat + 4] = 0;
    const decode = { failOn: "error", limitInputPixels: 64_000_000 } as const;
    const metadata = await sharp(source, decode)
        .metadata()
        .catch((error: unknown) => {
            throw new Error("SETUP: fault PNG metadata must remain readable", { cause: error });
        });
    assert.equal(metadata.format, "png", "SETUP: fault source is not a readable PNG header");
    assert.equal(metadata.width, 24, "SETUP: fault PNG header width changed");
    assert.equal(metadata.height, 18, "SETUP: fault PNG header height changed");
    await assert.rejects(sharp(source, decode).stats(), Error, "SETUP: PNG pixels must actually fail decoding");

    await withPrepareWorker(source, async (fixture) => {
        await fixture.waitFor(fixture.startup, 20_000, "SETUP: authenticated ordinary/refund/global heartbeat did not start");
        const claimed = await fixture.waitFor(fixture.claimed, 10_000, "Rejected job was not claimed over actual TCP");
        await fixture.waitFor(fixture.inputRead, 10_000, "Rejected job did not receive its exact frozen bytes");
        const observed = await fixture.waitFor(fixture.failed, 30_000, "Actual child rejection did not reach the real fail Route");
        const { seed } = fixture;
        expect(observed.input).toStrictEqual({
            ...claimed.identity,
            failure: {
                status: "rejected",
                jobId: seed.child.id,
                executionId: claimed.identity.executionId,
                pid: expect.any(Number),
                exitCode: 0,
                signal: null,
                stderr: expect.any(String),
                error: { code: "invalid_image", message: "商品图片像素无法解码" },
            },
        });
        expect(observed.receipt).toStrictEqual({ jobId: seed.child.id, status: "error", executionPhase: "needs_review" });
        const beforeChild = observed.before.rows.find((row) => row.id === seed.child.id);
        assert.ok(beforeChild);
        const { workerId, leaseUntil, lastHeartbeatAt, nextPollAt, ...releasedChild } = beforeChild;
        expect(workerId).toBe(claimed.identity.workerId);
        expect(leaseUntil).toBeTypeOf("number");
        expect(lastHeartbeatAt).toBeTypeOf("number");
        expect(nextPollAt).toBeTypeOf("number");
        expect(beforeChild.resultPayload).toBeUndefined();
        const expectedParent = {
            ...seed.parent,
            status: "paused",
            updatedAt: expect.any(Number),
            executionPhase: "needs_review",
            lastUpstreamStatus: "image_processing_failed",
            payload: { ...seed.parent.payload, status: "paused", updatedAt: expect.any(Number), failure: "图像处理未能完成，请检查参考图片或保护设置后继续。" },
        };
        const expectedChild = { ...releasedChild, status: "error", executionPhase: "needs_review", updatedAt: expect.any(Number), lastUpstreamStatus: "invalid_image", resultPayload: { ...claimed.identity, failure: observed.input.failure } };
        expect(observed.after).toStrictEqual({ ...observed.before, rows: [expectedParent, expectedChild] });
        expect(observed.after.media).toStrictEqual([seed.registration]);
        expect(observed.after.sourceBytes).toEqual(source);
        expect(fixture.calls).toStrictEqual({ uploads: 0, completes: 0, failures: 1 });
    });
}, 120_000);

it("pauses its original prepare stage after a real V8 OOM and does not reclaim it with the same resource profile", async () => {
    const source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#8a6243" } })
        .png()
        .toBuffer();
    await withPrepareWorker(
        source,
        async (fixture) => {
            await fixture.waitFor(fixture.startup, 20_000, "SETUP: actual Worker control lanes did not start");
            const claimed = await fixture.waitFor(fixture.claimed, 10_000, "Resource fault job was not claimed over TCP");
            await fixture.waitFor(fixture.inputRead, 10_000, "Resource fault job did not read its frozen source");
            const observed = await fixture.waitFor(fixture.failed, 30_000, "Actual V8 OOM did not reach the fail Route");
            const { seed } = fixture;
            expect(observed.input).toMatchObject({
                ...claimed.identity,
                failure: { status: "resource_failure", reason: "v8_heap_oom", jobId: seed.child.id, executionId: claimed.identity.executionId },
            });
            expect(observed.input.failure.stderr).toContain("Fatal JavaScript out of memory: GC during deserialization");
            expect(observed.receipt).toStrictEqual({ jobId: seed.child.id, status: "paused", executionPhase: "needs_review" });
            const parent = observed.after.rows.find((row) => row.id === seed.parent.id);
            const child = observed.after.rows.find((row) => row.id === seed.child.id);
            const originalChild = observed.before.rows.find((row) => row.id === seed.child.id);
            assert.ok(parent && child && originalChild);
            expect(parent).toMatchObject({ status: "paused", executionPhase: "needs_review", payload: { status: "paused", failure: expect.stringContaining("资源") } });
            expect(child).toMatchObject({ status: "paused", executionPhase: "needs_review", payload: originalChild.payload });
            expect(observed.after.media).toStrictEqual([seed.registration]);
            expect(observed.after.sourceBytes).toEqual(source);
            const nextClaim = await fixture.waitFor(fixture.released, 10_000, "Worker did not return its reservation after the child closed");
            expect(nextClaim).toStrictEqual(observed.after);
            expect(fixture.calls).toStrictEqual({ uploads: 0, completes: 0, failures: 1 });
        },
        "v8_heap_oom",
    );
}, 120_000);

it("acknowledges the natural prepare child close with a null stop cause after cancellation aborts its blocked TCP upload", async () => {
    const source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#537294" } })
        .png()
        .toBuffer();
    await withPrepareWorker(
        source,
        async (fixture) => {
            await fixture.waitFor(fixture.startup, 20_000, "SETUP: authenticated ordinary/refund/global heartbeat did not start");
            const claimed = await fixture.waitFor(fixture.claimed, 10_000, "Post-child cancellation job was not claimed over actual TCP");
            await fixture.waitFor(fixture.inputRead, 10_000, "Post-child cancellation job did not receive its exact frozen bytes");
            const uploaded = await fixture.waitFor(fixture.upload, 30_000, "Naturally completed child did not reach the real analysis PUT barrier");
            const heartbeat = await fixture.waitFor(fixture.cancellationHeartbeat, 35_000, "Real job heartbeat did not report the persisted cancellation intent");
            const observed = await fixture.waitFor(fixture.cancelled, 10_000, "Actual close report did not reach the real heartbeat ACK Route");
            await fixture.waitFor(fixture.uploadClosed, 10_000, "Worker did not abort its blocked upload after cancellation");
            const released = await fixture.waitFor(fixture.released, 10_000, "Worker did not return its exact slot/memory budget after close ACK and directory cleanup");
            const { seed } = fixture;
            expect(uploaded.bytes).toEqual(source);
            expect(uploaded.before.rows).toHaveLength(2);
            const beforeParent = uploaded.before.rows.find((row) => row.id === seed.parent.id);
            const beforeChild = uploaded.before.rows.find((row) => row.id === seed.child.id);
            assert.ok(beforeParent && beforeChild);
            expect(beforeParent).toStrictEqual(seed.parent);
            expect(beforeChild).toMatchObject({ status: "running", executionPhase: "created", workerId: claimed.identity.workerId, leaseUntil: expect.any(Number), lastHeartbeatAt: expect.any(Number) });
            expect(beforeChild.payload).toStrictEqual({ ...seed.child.payload, executionId: claimed.identity.executionId });
            expect(beforeChild.resultPayload).toBeUndefined();
            const requestedParent = uploaded.requested.rows.find((row) => row.id === seed.parent.id);
            assert.ok(requestedParent);
            expect(uploaded.requested).toStrictEqual({
                ...uploaded.before,
                rows: [
                    {
                        ...beforeParent,
                        updatedAt: expect.any(Number),
                        expiresAt: expect.any(Number),
                        payload: { ...beforeParent.payload, updatedAt: expect.any(Number), cancellation: { requestedAt: expect.any(Number), pendingChildTaskIds: [seed.child.id] } },
                    },
                    beforeChild,
                ],
            });
            const { nextPollAt, ...ownedChild } = beforeChild;
            expect(nextPollAt).toBeTypeOf("number");
            expect(uploaded.cancelled).toStrictEqual({ ...uploaded.requested, rows: [requestedParent, { ...ownedChild, status: "cancelled", executionPhase: "cancel_requested", updatedAt: expect.any(Number) }] });
            const cancelledChild = uploaded.cancelled.rows.find((row) => row.id === seed.child.id);
            assert.ok(cancelledChild && typeof cancelledChild.leaseUntil === "number");
            expect(heartbeat.before).toStrictEqual(uploaded.cancelled);
            expect(heartbeat.leaseUntil).toBeGreaterThan(cancelledChild.leaseUntil);
            expect(heartbeat.after).toStrictEqual({ ...heartbeat.before, rows: [requestedParent, { ...cancelledChild, leaseUntil: heartbeat.leaseUntil, lastHeartbeatAt: expect.any(Number) }] });
            expect(observed.before).toStrictEqual(heartbeat.after);
            const beforeAck = observed.before.rows.find((row) => row.id === seed.child.id);
            assert.ok(beforeAck);
            const { workerId, leaseUntil, lastHeartbeatAt, nextPollAt: cancelledPoll, ...releasedChild } = beforeAck;
            expect(workerId).toBe(claimed.identity.workerId);
            expect(leaseUntil).toBe(heartbeat.leaseUntil);
            expect(lastHeartbeatAt).toBeTypeOf("number");
            expect(cancelledPoll).toBeUndefined();
            expect(observed.receipt).toStrictEqual({ jobId: seed.child.id, executionId: claimed.identity.executionId, status: "cancelled", executionPhase: "completed" });
            expect(observed.after).toStrictEqual({
                ...observed.before,
                rows: [requestedParent, { ...releasedChild, executionPhase: "completed", updatedAt: expect.any(Number), resultPayload: { executionId: claimed.identity.executionId, cancelClose: { ...observed.input, receipt: observed.receipt } } }],
            });
            expect(observed.after.media).toStrictEqual([seed.registration]);
            expect(observed.after.sourceBytes).toEqual(source);
            expect(released).toStrictEqual(observed.after);
            expect(fixture.calls).toStrictEqual({ uploads: 1, completes: 0, failures: 0 });
            expect(fixture.cancellationCalls).toStrictEqual({ heartbeats: 1, acknowledgements: 1, uploadAborts: 1 });
            // The PUT can start only after supervise returned completed; later cancellation cannot rewrite that natural close cause.
            expect(observed.input).toStrictEqual({
                ...claimed.identity,
                closed: { status: "completed", jobId: seed.child.id, executionId: claimed.identity.executionId, pid: expect.any(Number), exitCode: 0, signal: null, stderr: expect.any(String) },
                stopCause: null,
            });
        },
        "cancel_after_child",
    );
}, 120_000);

it("cancels its uniquely captured spawned real child through a STOP barrier and real cancellation heartbeat", async () => {
    const source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#426381" } })
        .png()
        .toBuffer();
    await withPrepareWorker(
        source,
        async (fixture) => {
            await fixture.waitFor(fixture.startup, 20_000, "SETUP: authenticated ordinary/refund/global heartbeat did not start");
            const claimed = await fixture.waitFor(fixture.claimed, 10_000, "Spawned child cancellation job was not claimed over actual TCP");
            await fixture.waitFor(fixture.inputRead, 10_000, "Spawned child cancellation job did not receive its frozen bytes");
            const child = await fixture.waitFor(fixture.childStopped, 30_000, "SETUP: this one real child was not captured in state T before close");
            expect(child.state).toBe("T");
            const requested = await fixture.waitFor(fixture.requestChildCancellation(), 10_000, "Real parent/child cancellation intent was not persisted");
            expect(requested.child).toStrictEqual(child);
            const heartbeat = await fixture.waitFor(fixture.cancellationHeartbeat, 35_000, "Real job heartbeat did not report cancellation while the actual child was held");
            const pending = await fixture.waitFor(fixture.resumeCancelledChild(), 10_000, "Actual supervisor SIGTERM was not pending on the same stopped child");
            expect(pending.child).toStrictEqual(child);
            const observed = await fixture.waitFor(fixture.cancelled, 10_000, "Real aborted child close did not reach heartbeat ACK");
            const released = await fixture.waitFor(fixture.released, 10_000, "Spawned child cancellation did not return its exact budget after I/O and TMP drain");
            const { seed } = fixture;
            expect(requested.before.rows).toHaveLength(2);
            const beforeParent = requested.before.rows.find((row) => row.id === seed.parent.id);
            const beforeChild = requested.before.rows.find((row) => row.id === seed.child.id);
            assert.ok(beforeParent && beforeChild);
            expect(beforeParent).toStrictEqual(seed.parent);
            expect(beforeChild).toMatchObject({ status: "running", executionPhase: "created", workerId: claimed.identity.workerId, leaseUntil: expect.any(Number), lastHeartbeatAt: expect.any(Number) });
            expect(beforeChild.payload).toStrictEqual({ ...seed.child.payload, executionId: claimed.identity.executionId });
            expect(beforeChild.resultPayload).toBeUndefined();
            const requestedParent = requested.requested.rows.find((row) => row.id === seed.parent.id);
            assert.ok(requestedParent);
            expect(requested.requested).toStrictEqual({
                ...requested.before,
                rows: [
                    {
                        ...beforeParent,
                        updatedAt: expect.any(Number),
                        expiresAt: expect.any(Number),
                        payload: { ...beforeParent.payload, updatedAt: expect.any(Number), cancellation: { requestedAt: expect.any(Number), pendingChildTaskIds: [seed.child.id] } },
                    },
                    beforeChild,
                ],
            });
            const { nextPollAt, ...ownedChild } = beforeChild;
            expect(nextPollAt).toBeTypeOf("number");
            expect(requested.cancelled).toStrictEqual({ ...requested.requested, rows: [requestedParent, { ...ownedChild, status: "cancelled", executionPhase: "cancel_requested", updatedAt: expect.any(Number) }] });
            const cancelledChild = requested.cancelled.rows.find((row) => row.id === seed.child.id);
            assert.ok(cancelledChild && typeof cancelledChild.leaseUntil === "number");
            expect(heartbeat.before).toStrictEqual(requested.cancelled);
            expect(heartbeat.leaseUntil).toBeGreaterThan(cancelledChild.leaseUntil);
            expect(heartbeat.after).toStrictEqual({ ...heartbeat.before, rows: [requestedParent, { ...cancelledChild, leaseUntil: heartbeat.leaseUntil, lastHeartbeatAt: expect.any(Number) }] });
            expect(observed.before).toStrictEqual(heartbeat.after);
            const beforeAck = observed.before.rows.find((row) => row.id === seed.child.id);
            assert.ok(beforeAck);
            const { workerId, leaseUntil, lastHeartbeatAt, nextPollAt: cancelledPoll, ...releasedChild } = beforeAck;
            expect(workerId).toBe(claimed.identity.workerId);
            expect(leaseUntil).toBe(heartbeat.leaseUntil);
            expect(lastHeartbeatAt).toBeTypeOf("number");
            expect(cancelledPoll).toBeUndefined();
            expect(observed.input).toMatchObject({ ...claimed.identity, closed: { status: "aborted", jobId: seed.child.id, executionId: claimed.identity.executionId, pid: child.pid }, stopCause: "cancel_requested" });
            expect(observed.receipt).toStrictEqual({ jobId: seed.child.id, executionId: claimed.identity.executionId, status: "cancelled", executionPhase: "completed" });
            // Keep the actual supervisor exitCode/signal/stderr; the real Route validates them before persistence.
            expect(observed.after).toStrictEqual({
                ...observed.before,
                rows: [requestedParent, { ...releasedChild, executionPhase: "completed", updatedAt: expect.any(Number), resultPayload: { executionId: claimed.identity.executionId, cancelClose: { ...observed.input, receipt: observed.receipt } } }],
            });
            expect(observed.after.media).toStrictEqual([seed.registration]);
            expect(observed.after.sourceBytes).toEqual(source);
            expect(released).toStrictEqual(observed.after);
            expect(fixture.calls).toStrictEqual({ uploads: 0, completes: 0, failures: 0 });
            expect(fixture.cancellationCalls).toStrictEqual({ heartbeats: 1, acknowledgements: 1, uploadAborts: 0 });
        },
        "cancel_during_child",
    );
}, 120_000);

it("acknowledges a not-started prepare cancellation after its real claim and before its first job heartbeat", async () => {
    const source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#537294" } })
        .png()
        .toBuffer();
    await withPrepareWorker(
        source,
        async (fixture) => {
            await fixture.waitFor(fixture.startup, 20_000, "SETUP: authenticated ordinary/refund/global heartbeat did not start");
            const claimed = await fixture.waitFor(fixture.claimed, 10_000, "Initial cancellation job was not claimed over actual TCP");
            const cancellation = await fixture.waitFor(fixture.notStartedRequested, 10_000, "SETUP: cancellation was not persisted before the real claim response");
            const heartbeat = await fixture.waitFor(fixture.cancellationHeartbeat, 10_000, "Initial real job heartbeat did not return the persisted cancellation");
            const observed = await fixture.waitFor(fixture.notStartedCancelled, 10_000, "Not-started ACK did not reach the real heartbeat Route");
            const released = await fixture.waitFor(fixture.released, 10_000, "Worker did not restore its full budget after the not-started receipt and TMP cleanup");
            expectNotStartedTruth(fixture.seed, claimed, cancellation, heartbeat, observed, released);
            expect(observed.closure).toBeUndefined();
            expect(fixture.notStartedCalls).toStrictEqual({ inputs: 0, firstHeartbeat: true });
            expect(fixture.calls).toStrictEqual({ uploads: 0, completes: 0, failures: 0 });
            expect(fixture.cancellationCalls).toStrictEqual({ heartbeats: 1, acknowledgements: 1, uploadAborts: 0 });
            // The first heartbeat aborts before mkdir/input; the only supervise call requires all input pipelines.
        },
        "cancel_before_first_heartbeat",
    );
}, 120_000);

it("closes its held input TCP connection and write descriptor before accepting a not-started cancellation acknowledgement", async () => {
    const source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#537294" } })
        .png()
        .toBuffer();
    await withPrepareWorker(
        source,
        async (fixture) => {
            await fixture.waitFor(fixture.startup, 20_000, "SETUP: authenticated ordinary/refund/global heartbeat did not start");
            const claimed = await fixture.waitFor(fixture.claimed, 10_000, "Held-input cancellation job was not claimed over actual TCP");
            const sink = await fixture.waitFor(fixture.inputSink, 10_000, "SETUP/UNKNOWN: no real writable input descriptor and written PNG prefix were observed");
            const cancellation = await fixture.waitFor(fixture.notStartedRequested, 10_000, "SETUP: held-input cancellation was not persisted after sink observation");
            const heartbeat = await fixture.waitFor(fixture.cancellationHeartbeat, 35_000, "Real job heartbeat did not return the held-input cancellation");
            const observed = await fixture.waitFor(fixture.notStartedCancelled, 10_000, "Not-started ACK did not reach the input closure gate and real heartbeat Route");
            const released = await fixture.waitFor(fixture.released, 10_000, "Worker did not restore its full budget after input drain, receipt and TMP cleanup");
            const closure = observed.closure;
            assert.ok(closure);
            expect(sink.prefix).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            expect(sink.writableFds.length).toBeGreaterThan(0);
            expect(closure.sink).toStrictEqual(sink);
            expect(closure.responseClosedAt).toBeLessThan(closure.ackReceivedAt);
            expect(closure.socketClosedAt).toBeLessThan(closure.ackReceivedAt);
            expect(closure.ackReceivedAt).toBeLessThan(closure.fdAbsentAt);
            expectNotStartedTruth(fixture.seed, claimed, cancellation, heartbeat, observed, released);
            expect(fixture.notStartedCalls).toStrictEqual({ inputs: 1, firstHeartbeat: false });
            expect(fixture.calls).toStrictEqual({ uploads: 0, completes: 0, failures: 0 });
            expect(fixture.cancellationCalls).toStrictEqual({ heartbeats: 1, acknowledgements: 1, uploadAborts: 0 });
            // The real input never reaches EOF; cancellation rejects the pipeline before the unique supervise call.
        },
        "cancel_during_input",
    );
}, 120_000);
