import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { ClaimImageProcessingInput } from "./image-processing-service";

// These deadlines detect missing fixture events; they do not pace Worker execution.
async function arrivedBefore(pending: Promise<unknown>, milliseconds: number) {
    const cleanup = new AbortController();
    const deadline = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), milliseconds);
        cleanup.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    });
    try {
        return await Promise.race([pending.then(() => true), deadline]);
    } finally {
        cleanup.abort();
    }
}

it("W1 independently claims an empty image queue while ordinary and refund TCP responses remain held", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vozeb-worker-image-lane-"));
    const workerId = "fixture-image-lane-" + randomUUID();
    const laneOneId = workerId + ":lane-1";
    const laneTwoId = workerId + ":lane-2";
    const refundId = workerId + ":billing-refunds";
    const workerToken = "fixture-worker-image-lane-worker-token-0001";
    const maintenanceToken = "fixture-worker-image-lane-maintenance-token-0001";
    const observations = new EventEmitter();
    const heldRuns = new Map<string, ServerResponse>();
    const heldResponses = new Set<ServerResponse>();
    let heldRefund: ServerResponse | undefined;
    let origin: string;
    let stdout = "";
    let stderr = "";
    const claims: ClaimImageProcessingInput[] = [];
    const heartbeatWhileHeld = once(observations, "heartbeat-while-held");
    const imageWhileHeld = once(observations, "image-while-held");
    const fixtureFailure = new Promise<never>((_resolve, reject) => observations.on("failure", reject));
    const startupSignal = Promise.race([heartbeatWhileHeld, fixtureFailure]);

    vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
    vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
    vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", maintenanceToken);
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "1536");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "1024");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");

    const server = createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
            observations.emit("failure", error);
            if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: 500, data: null, msg: "TCP fixture rejected the request" }));
        });
    });

    function barriersHeld() {
        return heldRuns.size === 2 && heldRefund !== undefined && heldResponses.size === 3 && [...heldResponses].every((response) => !response.writableEnded && !response.destroyed);
    }

    function diagnostics(message: string) {
        return message + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr;
    }

    async function handle(request: IncomingMessage, response: ServerResponse) {
        assert.ok(request.url);
        const url = new URL(request.url, origin);
        expect(request.method).toBe("POST");
        const authorization = request.headers.authorization;
        assert.ok(typeof authorization === "string");
        expect(authorization).toBe("Bearer " + workerToken);
        if (url.pathname === "/api/maintenance/generation-tasks/run") {
            const id = request.headers["x-vozeb-pro-worker-id"];
            assert.ok(typeof id === "string");
            expect([laneOneId, laneTwoId]).toContain(id);
            expect(heldRuns.has(id)).toBe(false);
            heldRuns.set(id, response);
            heldResponses.add(response);
            return;
        }
        if (url.pathname === "/api/maintenance/billing-refunds/run") {
            expect(request.headers["x-vozeb-pro-worker-id"]).toBe(refundId);
            expect(heldRefund).toBeUndefined();
            heldRefund = response;
            heldResponses.add(response);
            return;
        }
        if (url.pathname === "/api/maintenance/generation-tasks/heartbeat") {
            expect(request.headers["x-vozeb-pro-worker-id"]).toBe(workerId);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: 0, data: {}, msg: "OK" }));
            if (barriersHeld()) observations.emit("heartbeat-while-held");
            return;
        }
        if (url.pathname === "/api/maintenance/image-processing/claim") {
            const contentType = request.headers["content-type"];
            assert.ok(typeof contentType === "string");
            expect(contentType).toMatch(/^application\/json(?:;|$)/i);
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
                assert.ok(Buffer.isBuffer(chunk));
                chunks.push(chunk);
            }
            const text = Buffer.concat(chunks).toString("utf8");
            const body: unknown = JSON.parse(text);
            assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
            assert.ok("workerId" in body && typeof body.workerId === "string");
            expect(body.workerId).toBe(body.workerId.trim());
            expect(body.workerId === workerId || (body.workerId.startsWith(workerId + ":") && body.workerId.length > workerId.length + 1)).toBe(true);
            expect([laneOneId, laneTwoId, refundId]).not.toContain(body.workerId);
            const input: ClaimImageProcessingInput = { workerId: body.workerId, profileVersion: profile.profileVersion, availableMemoryBytes: 1073741824, slots: 1 };
            expect(body).toStrictEqual(input);
            const heldAtArrival = barriersHeld();
            const result = await claimRoute.POST(new Request(url, { method: "POST", headers: { authorization, "content-type": contentType }, body: text }));
            expect(result.status).toBe(200);
            expect(result.headers.get("cache-control")).toBe("no-store");
            const bytes = Buffer.from(await result.arrayBuffer());
            const envelope: unknown = JSON.parse(bytes.toString("utf8"));
            expect(envelope).toStrictEqual({ code: 0, data: { tasks: [] }, msg: "OK" });
            claims.push(input);
            for (const [name, value] of result.headers) response.setHeader(name, value);
            response.writeHead(result.status);
            response.end(bytes);
            if (heldAtArrival && barriersHeld()) observations.emit("image-while-held");
            return;
        }
        throw new Error("Unexpected Worker TCP path: " + url.pathname);
    }

    let profile: ReturnType<(typeof import("@/lib/image-processing/resource-config"))["imageProcessingResourceConfig"]>;
    let claimRoute: typeof import("@/app/api/maintenance/image-processing/claim/route");
    try {
        const { imageProcessingResourceConfig } = await import("@/lib/image-processing/resource-config");
        profile = imageProcessingResourceConfig(process.env);
        expect(profile).toMatchObject({ workerMemoryBytes: 1610612736, supervisorHeapBytes: 67108864, budgetBytes: 1073741824, processHeapMb: 384, concurrency: 1 });
        const { isWorkerTokenConfigured } = await import("./maintenance-auth");
        assert.ok(isWorkerTokenConfigured());
        claimRoute = await import("@/app/api/maintenance/image-processing/claim/route");
        // This direct preflight is never recorded as a Worker TCP observation.
        const probe = await claimRoute.POST(
            new Request("http://fixture.invalid/api/maintenance/image-processing/claim", {
                method: "POST",
                headers: { authorization: "Bearer " + workerToken, "content-type": "application/json" },
                body: JSON.stringify({ workerId, profileVersion: profile.profileVersion, availableMemoryBytes: 1073741824, slots: 1 }),
            }),
        );
        expect(probe.status).toBe(200);
        expect(probe.headers.get("cache-control")).toBe("no-store");
        expect(await probe.json()).toStrictEqual({ code: 0, data: { tasks: [] }, msg: "OK" });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        server.on("error", (error) => observations.emit("failure", error));
        const address = server.address();
        assert.ok(address !== null && typeof address !== "string");
        origin = "http://127.0.0.1:" + address.port;
        const workerScript = fileURLToPath(new URL("../../../scripts/generation-worker.mjs", import.meta.url));
        const worker = spawn(process.execPath, ["--max-old-space-size=64", workerScript], {
            cwd: path.dirname(path.dirname(workerScript)),
            env: { ...process.env, VOZEB_PRO_WORKER_API_ORIGIN: origin, VOZEB_PRO_GENERATION_WORKER_ID: workerId, VOZEB_PRO_GENERATION_WORKER_LANES: "2", VOZEB_PRO_GENERATION_WORKER_HEARTBEAT_MS: "5000" },
            stdio: "pipe",
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            worker.once("error", (error) => reject(new Error("SETUP: real Worker could not start", { cause: error })));
            worker.once("close", (code, signal) => resolve({ code, signal }));
        });
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
            throw new Error(diagnostics("SETUP: real Worker exited before the image-lane observation: " + JSON.stringify(exit)));
        });
        try {
            const ready = await arrivedBefore(Promise.race([startupSignal, unexpectedExit]), 20_000);
            assert.ok(ready, diagnostics("SETUP: two ordinary responses, the refund response and a heartbeat while all three remain held are required before W1"));
            expect([...heldRuns.keys()].toSorted()).toStrictEqual([laneOneId, laneTwoId]);
            expect(barriersHeld()).toBe(true);
            expect(worker.exitCode).toBeNull();
            expect(worker.signalCode).toBeNull();
            expect(stderr, diagnostics("SETUP: real Worker reported an error before W1")).toBe("");

            const claimed = await arrivedBefore(Promise.race([imageWhileHeld, fixtureFailure, unexpectedExit]), 10_000);
            expect(worker.exitCode).toBeNull();
            expect(worker.signalCode).toBeNull();
            expect(barriersHeld()).toBe(true);
            expect(stderr, diagnostics("Worker failed during image-lane observation")).toBe("");
            expect(claimed, diagnostics("W1: independent POST /api/maintenance/image-processing/claim did not arrive while both ordinary run responses and refund response remained held, despite a successful heartbeat")).toBe(true);
            expect(claims.length).toBeGreaterThan(0);
        } finally {
            if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
            for (const response of heldResponses) {
                if (!response.writableEnded && !response.destroyed) {
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end(JSON.stringify({ code: 0, data: { claimed: 0 }, msg: "OK" }));
                }
            }
            const exited = await arrivedBefore(closed, 15_000);
            if (!exited) {
                worker.kill("SIGKILL");
                await closed;
                throw new Error(diagnostics("CLEANUP: real Worker required SIGKILL after responses were released; this is not a valid W1 RED"));
            }
            expect(await closed, diagnostics("CLEANUP: real Worker did not drain normally")).toStrictEqual({ code: 0, signal: null });
        }
    } finally {
        try {
            server.closeAllConnections();
            if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        } finally {
            try {
                await rm(directory, { recursive: true, force: true });
            } finally {
                vi.unstubAllEnvs();
            }
        }
    }
}, 90_000);
