import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { normalizeSystemChannelAdvancedConfig } from "@/lib/auth/store-normalizers-channel";

// Only the Next request cookie boundary is replaced. Storage, scheduler, user,
// sessions, provider HTTP, native downloads, and recovery are real.
const cookie = vi.hoisted(() => ({ value: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: cookie.value }) }) }));

let directory: string;
let imageTasks: typeof import("./image-task-store");
let tasks: typeof import("./generation-task-store");
let scheduler: typeof import("./generation-task-scheduler");
let recovery: typeof import("./generation-task-recovery-service");
let userId: string;
let image: Buffer;

beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "vozeb-main-audit-probes-"));
    vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
    vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", process.env.RECOVERY_TEST_PROVIDER || "file");
    vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
    vi.stubEnv("VOZEB_PRO_INSTALL_TOKEN", "fixture-only-audit-install-token-000001");
    vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
    vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1,localhost");
    vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-only-audit-worker-token-000001");
    vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-only-audit-maintenance-token-000001");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_MEMORY_MB", "8192");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_HEAP_MB", "64");
    vi.stubEnv("VOZEB_PRO_GENERATION_WORKER_CPUS", "1");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB", "6144");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_HEAP_MB", "384");
    vi.stubEnv("VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY", "1");
    [imageTasks, tasks, scheduler, recovery] = await Promise.all([import("./image-task-store"), import("./generation-task-store"), import("./generation-task-scheduler"), import("./generation-task-recovery-service")]);
    if (process.env.RECOVERY_TEST_PROVIDER === "postgres") await (await import("./database")).initializePostgresSchema();
    const auth = await import("@/lib/auth/store");
    const user = await auth.createFirstAdmin({ username: "auditfixture", password: "FixtureOnly_Audit2026!", installToken: process.env.VOZEB_PRO_INSTALL_TOKEN });
    userId = user.id;
    cookie.value = await auth.createSession(user.id);
    image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
        .png()
        .toBuffer();
}, 30_000);

afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
});

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function upstream(handler: (method: string, url: string, response: ServerResponse, body: string) => void) {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => {
            requests.push({ method: request.method!, url: request.url!, body });
            handler(request.method!, request.url!, response, body);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return {
        origin: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

async function create(baseUrl: string, extra: Record<string, unknown> = {}, owner = userId) {
    return imageTasks.createImageTask({
        userId: owner,
        username: "auditfixture",
        displayName: "Isolated audit",
        kind: "generation",
        source: "image-workbench",
        config: { baseUrl, apiKey: "fixture-only", apiFormat: "openai", model: "fixture-model" },
        prompt: "Audit image generation",
        references: [],
        ...extra,
    });
}

it("recovers the same synchronous result after repeated download failures without another generation", async () => {
    let failDownload = true;
    const server = await upstream((method, url, response) => {
        if (method === "POST") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: [{ url: `${server.origin}/native.png` }] }));
            return;
        }
        if (url === "/native.png" && failDownload) {
            response.statusCode = 503;
            response.end("temporary unavailable");
            return;
        }
        response.setHeader("content-type", "image/png");
        response.end(image);
    });
    try {
        const task = await create(server.origin);
        await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "created", nextPollAt: 1 });
        await recovery.runGenerationTaskRecoveryBatch({ origin: server.origin, limit: 1, taskIds: [task.id], workerId: "audit-A2-first" });
        const record = await tasks.getStoredGenerationTaskRecord("image", task.id);
        assert.ok(record);
        assert.ok(record.payload.nativeAcquisition);
        const route = await import("@/app/api/image-tasks/[id]/route");
        const unavailable = await route.POST(new Request(`${server.origin}/api/image-tasks/${task.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
            params: Promise.resolve({ id: task.id }),
        });
        expect(unavailable.status).toBe(200);
        expect((await unavailable.json()).task).toMatchObject({ id: task.id, needsReview: true });
        expect((await imageTasks.getImageTask(task.id))?.nativeAcquisition).toEqual(record.payload.nativeAcquisition);
        failDownload = false;
        const response = await route.POST(new Request(`${server.origin}/api/image-tasks/${task.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
            params: Promise.resolve({ id: task.id }),
        });
        expect(response.status).toBe(200);
        expect((await response.json()).task.id).toBe(task.id);
        expect((await imageTasks.getImageTask(task.id))?.nativeResults).toMatchObject({ attemptNo: 1, upstreamTaskId: null, slots: [{ resultId: `${task.id}:1`, resultIndex: 1, status: "stored" }] });
        expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    } finally {
        await server.close();
    }
});

it("downloads a ready result while an upstream query in the same batch remains blocked", async () => {
    const queryArrived = deferred();
    const releaseQuery = deferred();
    const server = await upstream((_method, url, response) => {
        if (url.includes("/jobs/")) {
            queryArrived.resolve();
            void releaseQuery.promise.then(() => {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ status: "processing" }));
            });
        } else {
            response.setHeader("content-type", "image/png");
            response.end(image);
        }
    });
    let running: Promise<unknown> | undefined;
    try {
        const slow = await create(server.origin, { upstream: { id: "slow", mediaBaseUrl: server.origin, pollBaseUrl: `${server.origin}/v1/images/generations` } });
        await imageTasks.updateImageTask(slow.id, { config: { ...slow.config, advancedConfig: normalizeSystemChannelAdvancedConfig({ protocol: "openai", queryPath: "/jobs/:task_id" }) } });
        await imageTasks.transitionImageTask(slow, ["pending"], { status: "running" });
        await scheduler.scheduleGenerationTask("image", slow.id, { executionPhase: "polling", upstreamTaskId: "slow", nextPollAt: 1 });
        const ready = await create(server.origin, { attemptNo: 1 });
        await imageTasks.transitionImageTask(ready, ["pending"], { status: "running" });
        await scheduler.scheduleGenerationTask("image", ready.id, { executionPhase: "result_ready", nextPollAt: 1, resultPayload: { url: `${server.origin}/ready.png` } });
        running = recovery.runGenerationTaskRecoveryBatch({ origin: server.origin, limit: 2, taskIds: [slow.id, ready.id], workerId: "audit-A3" });
        await queryArrived.promise;
        await expect.poll(() => server.requests.some((request) => request.url === "/ready.png"), { timeout: 2_000 }).toBe(true);
    } finally {
        releaseQuery.resolve();
        await running;
        await server.close();
    }
});

it.skipIf(process.env.RECOVERY_TEST_PROVIDER === "postgres")("holds File admission until the first creation finishes", async () => {
    const owner = "audit-A4-" + randomUUID();
    const entered = deferred();
    const release = deferred();
    const secondEntered = deferred();
    const first = tasks.withGenerationConcurrencyLimit(owner, "image", 600_000, 1, async () => {
        entered.resolve();
        await release.promise;
        await create("https://fixture.invalid", {}, owner);
        return "first";
    });
    await entered.promise;
    const competing = tasks.withGenerationConcurrencyLimit(owner, "image", 600_000, 1, async () => {
        secondEntered.resolve();
        await create("https://fixture.invalid", {}, owner);
        return "second-admitted";
    });
    await Promise.race([secondEntered.promise, new Promise<void>((resolve) => setTimeout(resolve, 150))]);
    release.resolve();
    await first;
    const second = await competing;
    expect(second).toBeNull();
});

it("counts a live long-running task for both admission and capacity timing", async () => {
    const owner = process.env.RECOVERY_TEST_PROVIDER === "postgres" ? (await (await import("@/lib/auth/store")).createUserByAdmin({ actorId: userId, username: "auditlongtask", password: "FixtureOnly_Audit2026!" })).id : "audit-A5-" + randomUUID();
    const task = await create("https://fixture.invalid", {}, owner);
    await imageTasks.updateImageTask(task.id, { config: { ...task.config, capabilityProfile: { timeoutMs: 30 * 60_000 } } });
    await imageTasks.transitionImageTask(task, ["pending"], { status: "running" });
    await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "submitting", submittedAt: Date.now() - 660_000, nextPollAt: Date.now() + 300_000 });
    if (process.env.RECOVERY_TEST_PROVIDER === "postgres") {
        const { postgresQuery } = await import("./database");
        await postgresQuery("UPDATE generation_tasks SET updated_at = now() - interval '11 minutes', worker_id = 'live-worker', lease_until = now() + interval '90 seconds', last_heartbeat_at = now() WHERE id = $1", [task.id]);
    } else {
        await tasks.withGenerationTaskFileMutation(async (records) => ({
            tasks: records.map((record) => (record.id === task.id ? { ...record, updatedAt: Date.now() - 660_000, workerId: "live-worker", leaseUntil: Date.now() + 90_000, lastHeartbeatAt: Date.now() } : record)),
            result: undefined,
        }));
    }
    const admitted = await tasks.withGenerationConcurrencyLimit(owner, "image", 600_000, 1, async () => "new-task-admitted");
    expect(admitted).toBeNull();
    expect(await tasks.countActiveStoredGenerationTasks(owner, "image")).toBe(1);
    expect(await tasks.countActiveStoredGenerationTasks(owner, "image", task.id)).toBe(0);
    expect(await tasks.generationCapacityRetryAfterSeconds(owner, "image")).toBeGreaterThan(0);
});

it.each([
    ["openai", '{"status":"completed","data":[]}'],
    ["custom", '{"status":"completed","data":[]}'],
    ["custom", "invalid JSON"],
] as const)("preserves the %s upstream identity for query response %s", async (protocol, queryResponse) => {
    const server = await upstream((method, _url, response) => {
        response.setHeader("content-type", "application/json");
        response.end(method === "GET" ? queryResponse : JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }));
    });
    try {
        const task = await create(server.origin, { upstream: { id: "completed-original", mediaBaseUrl: server.origin, pollBaseUrl: `${server.origin}/v1/images/generations` }, attemptNo: 1 });
        await imageTasks.updateImageTask(task.id, { config: { ...task.config, advancedConfig: normalizeSystemChannelAdvancedConfig({ protocol, queryPath: "/jobs/:task_id", resultField: "data", statusField: "status" }) } });
        await imageTasks.transitionImageTask(task, ["pending"], { status: "running" });
        await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "polling", upstreamTaskId: "completed-original", nextPollAt: 1 });
        await recovery.runGenerationTaskRecoveryBatch({ origin: server.origin, limit: 1, taskIds: [task.id], workerId: "audit-A6" });
        const middle = await tasks.getStoredGenerationTaskRecord("image", task.id);
        await recovery.runGenerationTaskRecoveryBatch({ origin: server.origin, limit: 1, taskIds: [task.id], workerId: "audit-A6" });
        expect(middle).toMatchObject({ executionPhase: "needs_review", upstreamTaskId: "completed-original" });
        expect((await imageTasks.getImageTask(task.id))?.attemptNo).toBe(1);
        expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    } finally {
        await server.close();
    }
});

it.each(["openai", "custom"] as const)("preserves the %s identity for a temporary query business error", async (protocol) => {
    const server = await upstream((_method, _url, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "processing", code: 500, msg: "temporary query error" }));
    });
    try {
        const task = await create(server.origin, { upstream: { id: "original", mediaBaseUrl: server.origin, pollBaseUrl: server.origin }, attemptNo: 1 });
        await imageTasks.updateImageTask(task.id, { config: { ...task.config, advancedConfig: normalizeSystemChannelAdvancedConfig({ protocol, queryPath: "/jobs/:task_id", resultField: "data", statusField: "status" }) } });
        await imageTasks.transitionImageTask(task, ["pending"], { status: "running" });
        await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "polling", upstreamTaskId: "original", nextPollAt: 1 });
        await recovery.runGenerationTaskRecoveryBatch({ origin: server.origin, limit: 1, taskIds: [task.id], workerId: "query-business-error" });
        expect(await tasks.getStoredGenerationTaskRecord("image", task.id)).toMatchObject({ executionPhase: "polling", upstreamTaskId: "original" });
        expect((await imageTasks.getImageTask(task.id))?.attemptNo).toBe(1);
        expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    } finally {
        await server.close();
    }
});

it("keeps sealed synchronous originals recoverable when result admission cannot read the edit source", async () => {
    let failDownload = true;
    let failReference = false;
    const server = await upstream((method, url, response) => {
        if (method === "POST") {
            failReference = true;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: [{ url: `${server.origin}/native.png` }] }));
            return;
        }
        if ((url === "/native.png" && failDownload) || (url === "/source.png" && failReference)) {
            response.statusCode = 503;
            response.end("temporary unavailable");
            return;
        }
        response.setHeader("content-type", "image/png");
        response.end(image);
    });
    try {
        const task = await create(server.origin, {
            kind: "edit",
            config: { baseUrl: server.origin, apiKey: "fixture-only", apiFormat: "openai", model: "fixture-model", outputMode: "layers" },
            references: [{ id: "original", name: "source.png", dataUrl: `${server.origin}/source.png` }],
        });
        await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: "created", nextPollAt: 1 });
        await recovery.runGenerationTaskRecoveryBatch({ origin: server.origin, limit: 1, taskIds: [task.id], workerId: "admission-first" });
        expect((await imageTasks.getImageTask(task.id))?.nativeAcquisition).toBeDefined();
        failDownload = false;
        const route = await import("@/app/api/image-tasks/[id]/route");
        const check = () =>
            route.POST(new Request(`${server.origin}/api/image-tasks/${task.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), { params: Promise.resolve({ id: task.id }) });
        expect((await check()).status).toBe(200);
        expect((await imageTasks.getImageTask(task.id))?.nativeResults?.slots[0]).toMatchObject({ resultId: `${task.id}:1`, status: "stored" });
        failReference = false;
        expect((await check()).status).toBe(200);
        expect((await imageTasks.getImageTask(task.id))?.resultProcessing).toBeDefined();
        expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    } finally {
        await server.close();
    }
});
