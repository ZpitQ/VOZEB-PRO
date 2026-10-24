import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEnhancementTaskClient } from "./image-enhancement-worker-client";
import { planImageEnhancement } from "./image-enhancement-plan";

const serviceId = "31313131-3131-4131-8131-313131313131";
const jobId = "42424242-4242-4242-8242-424242424242";
const receiptId = "53535353-5353-4353-8353-535353535353";
const token = "fixture-task-worker-token";
const model = { id: "fixture-model", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4 as const, allowedTiles: [0], defaultTile: 0, tta: false as const, gpuId: 0 };
const budgets = { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let server: Server;
let client: ReturnType<typeof createEnhancementTaskClient>;
let endpoint: string;
let mode: string;
let source: Buffer;
let ai: Buffer;
let frozen: Awaited<ReturnType<ReturnType<typeof createEnhancementTaskClient>["prepare"]>>;
let requests: string[];
let submissions: { key: string | undefined; plan: Record<string, unknown>; multipart: string }[];
let receipts: unknown[];
let timings: unknown;
let rawTimingNumber: string | undefined;
const result = () => {
    const bytes = mode === "truncated-consistent" ? ai.subarray(0, 50) : ai;
    return { format: "png" as const, width: 8, height: 8, sha256: digest(bytes), byteLength: bytes.length };
};
const job = () => ({
    serviceId,
    jobId,
    status: mode === "status-array" ? ["succeeded"] : "succeeded",
    reason: null,
    source: { sha256: digest(source), width: 2, height: 2 },
    engineInput: { width: 2, height: 2 },
    plan: frozen,
    result: mode === "status-array" ? null : result(),
    createdAt: 1,
    completedAt: 2,
    ...(timings === undefined ? {} : { timings }),
});

beforeEach(async () => {
    mode = "ok";
    requests = [];
    submissions = [];
    receipts = [];
    timings = undefined;
    rawTimingNumber = undefined;
    source = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#dedede" } })
        .png()
        .toBuffer();
    ai = await sharp(source).resize(8, 8).png().toBuffer();
    server = createServer(async (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        if (request.headers.authorization !== `Bearer ${token}` || mode === "auth") {
            response.writeHead(401).end(JSON.stringify({ code: "authentication_failed", msg: token }));
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        let data: unknown;
        if (request.url === "/v1/capabilities")
            data = {
                serviceId: mode === "identity" ? jobId : serviceId,
                protocolVersion: "image-enhancement.v1",
                normalizationProfile: "srgb-upright-v1",
                features: { expectedStrategyFingerprint: mode !== "legacy" },
                models: [{ ...model, modelSha256: mode === "weights" ? "d".repeat(64) : model.modelSha256 }],
                budgets: mode === "budget" ? { ...budgets, input: { ...budgets.input, maxPixels: 3 } } : mode === "native-delivery-budget" ? { ...budgets, delivery: { ...budgets.delivery, maxPixels: 36 } } : budgets,
                ready: mode !== "unready",
            };
        else if (request.url === "/v1/enhancement-jobs" && request.method === "POST") {
            const boundary = String(request.headers["content-type"]).split("boundary=")[1];
            const part = bytes.toString("utf8").split(`--${boundary}`)[1];
            const plan = JSON.parse(part.split("\r\n\r\n")[1].trim()) as Record<string, unknown>;
            submissions.push({ key: request.headers["idempotency-key"] as string | undefined, plan, multipart: part });
            if (mode === "lost-submit") {
                request.socket.destroy();
                return;
            }
            data = { job: job(), replayed: submissions.length > 1 };
        } else if (request.url === `/v1/enhancement-jobs/${jobId}/result`) {
            response.writeHead(200, { "content-type": "image/png" }).end(mode === "truncated-consistent" ? ai.subarray(0, 50) : mode === "corrupt" ? Buffer.from("corrupt") : ai);
            return;
        } else if (request.url === `/v1/enhancement-jobs/${jobId}/receipt`) {
            receipts.push(JSON.parse(bytes.toString("utf8")));
            if (mode === "lost-receipt") {
                request.socket.destroy();
                return;
            }
            data = { accepted: true };
        } else if (request.url === `/v1/enhancement-jobs/${jobId}`) data = { job: job() };
        else {
            response.writeHead(404).end();
            return;
        }
        const json = JSON.stringify({ code: "ok", data, msg: "OK" });
        response.writeHead(200, { "content-type": "application/json" }).end(rawTimingNumber ? json.replace('"workerExecutionMs":null', `"workerExecutionMs":${rawTimingNumber}`) : json);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    client = createEnhancementTaskClient({ endpoint, token, trust: "system", caPem: "", serviceId, timeoutMs: 10000 });
});
afterEach(async () => {
    await client?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function prepare(snapshotServiceId = serviceId, target = { width: 6, height: 6 }, frozenModel = model) {
    const decision = planImageEnhancement({
        nativeValid: true,
        enabled: true,
        requested4k: true,
        protectedContract: false,
        layered: false,
        source: { url: "/api/generation-log-assets/images/fixture.png", sha256: digest(source), width: 2, height: 2, byteLength: source.length, format: "png", hasAlpha: false, provenance: "provider_native" },
        target,
        connection: { revision: "fixture-revision", credentialRef: "fixture-profile", serviceId: snapshotServiceId, timeoutMs: 10000, model: frozenModel },
    });
    if (decision.status !== "queued") throw new Error("expected fixture plan");
    frozen = await client.prepare(decision);
    return frozen;
}

describe("frozen enhancement task client over HTTP", () => {
    it("accepts only measured Worker timing fields and drops private timing details over TCP", async () => {
        const plan = await prepare();
        timings = { workerQueueMs: 0, workerExecutionMs: 12.5, deliveryEncodingMs: 99, ownerDescriptor: { path: "private-worker-path", token }, attemptNo: 3 };
        const remote = await client.query(plan, jobId);
        expect(remote).toHaveProperty("timings", { workerQueueMs: 0, workerExecutionMs: 12.5 });
        expect(JSON.stringify(remote)).not.toContain("private-worker-path");
        expect(JSON.stringify(remote)).not.toContain(token);
        expect((await client.submit(plan, source, "timing-key")).job).toHaveProperty("timings", { workerQueueMs: 0, workerExecutionMs: 12.5 });
    });
    it("keeps missing timing facts absent", async () => {
        const plan = await prepare();
        expect(await client.query(plan, jobId)).not.toHaveProperty("timings");
        timings = { ownerDescriptor: "private-only" };
        expect(await client.query(plan, jobId)).not.toHaveProperty("timings");
    });
    it.each([null, [], "12", { workerQueueMs: "12" }, { workerQueueMs: -1 }, { workerExecutionMs: null }, { workerExecutionMs: -0.5 }].map((value) => [value]))("rejects invalid Worker timing facts without repeating a request: %j", async (value) => {
        const plan = await prepare();
        timings = value;
        await expect(client.query(plan, jobId)).rejects.toMatchObject({ reason: "invalid_response" });
        expect(requests.filter((request) => request === `GET /v1/enhancement-jobs/${jobId}`)).toHaveLength(1);
        expect(submissions).toEqual([]);
    });
    it.each(["NaN", "1e999"])("rejects a nonfinite raw timing number over TCP: %s", async (value) => {
        const plan = await prepare();
        timings = { workerExecutionMs: null };
        rawTimingNumber = value;
        await expect(client.query(plan, jobId)).rejects.toMatchObject({ reason: "invalid_response" });
        expect(requests.filter((request) => request === `GET /v1/enhancement-jobs/${jobId}`)).toHaveLength(1);
    });
    it("rejects a non-string status instead of accepting its string coercion", async () => {
        const plan = await prepare();
        mode = "status-array";
        await expect(client.query(plan, jobId)).rejects.toMatchObject({ reason: "invalid_response" });
    });
    it("compares frozen model values independently of JSONB object key order", async () => {
        const first = await prepare();
        const reordered = await prepare(serviceId, { width: 6, height: 6 }, Object.fromEntries(Object.entries(model).reverse()) as typeof model);
        expect(reordered.strategyFingerprint).toBe(first.strategyFingerprint);
        expect(reordered.planFingerprint).toBe(first.planFingerprint);
    });
    it("canonicalizes target field order to the Worker strategy contract", async () => {
        const first = await prepare();
        const reordered = await prepare(serviceId, { height: 6, width: 6 });
        expect(reordered.strategyFingerprint).toBe(first.strategyFingerprint);
        expect(reordered.planFingerprint).toBe(first.planFingerprint);
    });
    it("rejects a decision captured for a different service", async () => {
        await expect(prepare(jobId)).rejects.toMatchObject({ reason: "service_identity_changed" });
        expect(submissions).toEqual([]);
    });
    it("freezes authenticated budgets and exact model strategy without a self-test or submission", async () => {
        const plan = await prepare();
        expect(plan).toMatchObject({ sourceSha256: digest(source), target: { width: 8, height: 8, format: "png" }, budgets, engine: { modelId: model.id, modelSha256: model.modelSha256, tile: 0 } });
        expect(Object.isFrozen(plan.budgets.ai)).toBe(true);
        expect(plan.strategyFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(requests).toEqual(["GET /v1/capabilities"]);
        expect(JSON.stringify(plan)).not.toContain(token);
        expect(JSON.stringify(plan)).not.toContain(endpoint);
    });
    it("uses the native 4x Worker target when the delivery boundary has a different rounded aspect", async () => {
        const plan = await prepare(serviceId, { width: 7, height: 6 });
        expect(plan.target).toEqual({ width: 8, height: 8, format: "png" });
        await client.submit(plan, source, "rounded-delivery-target");
        expect(submissions).toHaveLength(1);
        expect(submissions[0].plan.target).toEqual({ width: 8, height: 8, format: "png" });
    });
    it.each(["legacy", "weights", "budget", "unready"])("refuses unsupported or changed execution before submission: %s", async (failure) => {
        mode = failure;
        await expect(prepare()).rejects.toBeInstanceOf(Error);
        expect(submissions).toEqual([]);
    });
    it("checks the native 4x target against the Worker delivery budget before submission", async () => {
        mode = "native-delivery-budget";
        await expect(prepare()).rejects.toMatchObject({ reason: "budget_exceeded" });
        expect(requests).toEqual(["GET /v1/capabilities"]);
        expect(submissions).toEqual([]);
    });
    it("keeps the original key and constrained payload after a lost submission response", async () => {
        const plan = await prepare();
        mode = "lost-submit";
        await expect(client.submit(plan, source, "fixture-stable-key")).rejects.toMatchObject({ reason: "connection_failed" });
        expect(submissions).toHaveLength(1);
        mode = "ok";
        expect(await client.submit(plan, source, "fixture-stable-key")).toMatchObject({ job: { jobId }, replayed: true });
        expect(submissions.map((item) => item.key)).toEqual(["fixture-stable-key", "fixture-stable-key"]);
        expect(submissions[0].plan).toEqual(submissions[1].plan);
        expect(submissions[0].plan.expectedStrategyFingerprint).toBe(plan.strategyFingerprint);
        expect(submissions[0].multipart).not.toContain("filename=");
    });
    it("checks identity before an old-job query or download", async () => {
        const plan = await prepare();
        mode = "identity";
        await expect(client.query(plan, jobId)).rejects.toMatchObject({ reason: "service_identity_changed" });
        await expect(client.download(plan, jobId, result())).rejects.toMatchObject({ reason: "service_identity_changed" });
        expect(requests.every((item) => item === "GET /v1/capabilities")).toBe(true);
    });
    it("downloads the full native AI artifact and leaves downsampling to publication", async () => {
        const plan = await prepare();
        expect(await client.query(plan, jobId)).toMatchObject({ jobId, status: "succeeded", result: { width: 8, height: 8 } });
        const bytes = await client.download(plan, jobId, result());
        expect(bytes.equals(ai)).toBe(true);
        expect((await sharp(bytes).metadata()).width).toBe(8);
    });
    it.each(["corrupt", "truncated-consistent"])("fully verifies downloaded bytes even with consistent declarations: %s", async (failure) => {
        const plan = await prepare();
        mode = failure;
        await expect(client.download(plan, jobId, result())).rejects.toMatchObject({ reason: "output_invalid" });
    });
    it("recovers only the same receipt after response loss", async () => {
        const plan = await prepare();
        mode = "lost-receipt";
        await expect(client.acknowledge(plan, jobId, receiptId, result())).rejects.toMatchObject({ reason: "connection_failed" });
        expect(receipts).toHaveLength(1);
        mode = "ok";
        await client.acknowledge(plan, jobId, receiptId, result());
        expect(receipts).toHaveLength(2);
        expect(receipts[0]).toEqual(receipts[1]);
        expect(submissions).toEqual([]);
    });
    it("returns safe authentication errors without Worker messages or credentials", async () => {
        mode = "auth";
        const error = await prepare().catch((value: Error) => value);
        expect(error).toMatchObject({ reason: "authentication_failed" });
        expect(String(error)).not.toContain(token);
        expect(String(error)).not.toContain(endpoint);
    });
});
