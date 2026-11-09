import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, relative } from "node:path";
import sharp from "sharp";
import type { EnhancementModel } from "@/lib/image-enhancement-contract";
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import type { EnhancementArtifact, EnhancementWorkerBudgets, RemoteEnhancementJob } from "./image-enhancement-worker-client";

export const retainedWorkerToken = "retained-worker-fixture-token";
export const retainedDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type WireJob = RemoteEnhancementJob & { serviceId: string; plan: { planFingerprint: string; strategyFingerprint: string; engine: { tta: boolean } }; source: { sha256: string }; engineInput: { width: number; height: number } };
type RetainedReceipt = { serviceId: string; receiptId: string; result: EnhancementArtifact };
export type RetainedWorkerState = {
    endpoint: string;
    serviceId: string;
    model: EnhancementModel;
    budgets: EnhancementWorkerBudgets;
    sourceSha256: string;
    output: EnhancementArtifact;
    job: WireJob | null;
    acceptedRequest: { key: string; plan: unknown } | null;
    receipt?: RetainedReceipt;
    requests: { method: string; path: string; body?: RetainedReceipt }[];
};
type WorkerInput = {
    controlDirectory: string;
    readParent: () => Promise<ImageEnhancementJob | null>;
    mediaGet: (request: Request) => Promise<Response>;
} & ({ create: { serviceId: string; model: EnhancementModel; budgets: EnhancementWorkerBudgets; source: Buffer; ai: Buffer } } | { expectedState: RetainedWorkerState; create?: never });

export async function openRetainedEnhancementWorker(input: WorkerInput) {
    const statePath = join(input.controlDirectory, "remote-state.json");
    let state: RetainedWorkerState;
    if (input.create) {
        const metadata = await sharp(input.create.ai).metadata();
        assert.ok(metadata.width && metadata.height);
        await writeFile(join(input.controlDirectory, "worker-ai.png"), input.create.ai, { flag: "wx" });
        state = {
            endpoint: "",
            serviceId: input.create.serviceId,
            model: input.create.model,
            budgets: input.create.budgets,
            sourceSha256: retainedDigest(input.create.source),
            output: { width: metadata.width, height: metadata.height, format: "png", sha256: retainedDigest(input.create.ai), byteLength: input.create.ai.length },
            job: null,
            acceptedRequest: null,
            requests: [],
        };
    } else {
        state = JSON.parse(await readFile(statePath, "utf8"));
        assert.deepEqual(state, input.expectedState);
    }
    const persist = async () => {
        await writeFile(statePath + ".next", JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
        await rename(statePath + ".next", statePath);
    };
    const reply = async (response: ServerResponse, value: unknown) => {
        await persist();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "ok", data: value }));
    };
    const handle = async (request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url!, state.endpoint);
        state.requests.push({ method: request.method!, path: url.pathname });
        if (request.method === "GET" && url.pathname.startsWith("/api/generation-log-assets/")) {
            const headers = new Headers();
            for (const [key, value] of Object.entries(request.headers)) {
                if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
                else if (value !== undefined) headers.set(key, value);
            }
            const actual = await input.mediaGet(new Request(url, { headers }));
            assert.equal(actual.status, 200);
            const bytes = Buffer.from(await actual.arrayBuffer());
            await persist();
            response.writeHead(200, Object.fromEntries(actual.headers));
            response.end(bytes);
        } else {
            assert.equal(request.headers.authorization, "Bearer " + retainedWorkerToken);
            if (request.method === "GET" && url.pathname === "/v1/capabilities") {
                await reply(response, {
                    serviceId: state.serviceId,
                    protocolVersion: "image-enhancement.v1",
                    normalizationProfile: "srgb-upright-v1",
                    features: { expectedStrategyFingerprint: true },
                    ready: true,
                    models: [state.model],
                    budgets: state.budgets,
                });
            } else if (request.method === "POST" && url.pathname === "/v1/enhancement-jobs") {
                assert.equal(state.job, null, "The retained chain must not submit another remote job");
                const chunks: Buffer[] = [];
                for await (const bytes of request) chunks.push(Buffer.from(bytes));
                const contentType = request.headers["content-type"];
                assert.ok(contentType);
                const form = await new Request(url, { method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(Buffer.concat(chunks)) }).formData();
                const plan = form.get("plan");
                const image = form.get("image");
                assert.ok(typeof plan === "string" && image instanceof File);
                const parent = await input.readParent();
                assert.ok(parent?.remotePlan);
                assert.equal(request.headers["idempotency-key"], parent.remoteKey);
                assert.equal(retainedDigest(Buffer.from(await image.arrayBuffer())), state.sourceSha256);
                assert.deepEqual(JSON.parse(plan), {
                    protocolVersion: "image-enhancement.v1",
                    scope: "full_image",
                    sourceSha256: state.sourceSha256,
                    target: { width: state.output.width, height: state.output.height, format: "png" },
                    modelId: state.model.id,
                    normalizationProfile: "srgb-upright-v1",
                    tile: 0,
                    expectedStrategyFingerprint: parent.remotePlan.strategyFingerprint,
                });
                state.acceptedRequest = { key: parent.remoteKey, plan: JSON.parse(plan) };
                state.job = {
                    jobId: randomUUID(),
                    serviceId: state.serviceId,
                    plan: { planFingerprint: parent.remotePlan.planFingerprint, strategyFingerprint: parent.remotePlan.strategyFingerprint, engine: { tta: false } },
                    source: { sha256: state.sourceSha256 },
                    engineInput: { width: parent.remotePlan.source.width, height: parent.remotePlan.source.height },
                    status: "queued",
                    reason: null,
                    result: null,
                    createdAt: Date.now(),
                    completedAt: null,
                };
                await reply(response, { job: state.job, replayed: false });
            } else if (request.method === "GET" && url.pathname === `/v1/enhancement-jobs/${state.job?.jobId}`) {
                assert.ok(state.job);
                if (state.job.status === "queued") state.job = { ...state.job, status: "succeeded", result: state.output, completedAt: Date.now() };
                await reply(response, { job: state.job });
            } else if (request.method === "GET" && url.pathname === `/v1/enhancement-jobs/${state.job?.jobId}/result`) {
                const ai = await readFile(join(input.controlDirectory, "worker-ai.png"));
                assert.equal(retainedDigest(ai), state.output.sha256);
                await persist();
                response.writeHead(200, { "content-type": "image/png", "content-length": ai.length });
                response.end(ai);
            } else if (request.method === "POST" && url.pathname === `/v1/enhancement-jobs/${state.job?.jobId}/receipt`) {
                const chunks: Buffer[] = [];
                for await (const bytes of request) chunks.push(Buffer.from(bytes));
                const body: RetainedReceipt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                const parent = await input.readParent();
                assert.ok(parent?.publication);
                assert.equal(parent.phase, "receipt");
                assert.equal(parent.remoteJobId, state.job?.jobId);
                assert.deepEqual(body, { serviceId: state.serviceId, receiptId: parent.receiptId, result: state.output });
                state.requests[state.requests.length - 1].body = body;
                state.receipt = body;
                await reply(response, {});
            } else throw new Error(`Unexpected retained fixture request: ${request.method} ${url.pathname}`);
        }
    };
    let queue = Promise.resolve();
    const server = createServer((request, response) => {
        queue = queue.then(() => handle(request, response));
        // The queue stays rejected; close() rethrows the handler's original error.
        void queue.catch(() => {
            response.writeHead(500);
            response.end("retained fixture failed");
        });
    });
    const closeServer = () =>
        new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
        });
    let opened = false;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            // Rebinding the saved port fails on EADDRINUSE; no unknown service is reused.
            server.listen(input.create ? 0 : Number(new URL(state.endpoint).port), "127.0.0.1", resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        if (input.create) {
            state.endpoint = `http://127.0.0.1:${address.port}`;
            await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
        }
        opened = true;
        return {
            endpoint: state.endpoint,
            async readState(): Promise<RetainedWorkerState> {
                await queue;
                return JSON.parse(await readFile(statePath, "utf8"));
            },
            async close() {
                await closeServer();
                await queue;
            },
        };
    } finally {
        if (!opened && server.listening) await closeServer();
    }
}

export async function retainedDataSnapshot(root: string) {
    const files: Record<string, { bytes: number; sha256: string }> = {};
    async function visit(directory: string) {
        for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((left, right) => left.name.localeCompare(right.name))) {
            const filename = join(directory, entry.name);
            if (entry.isDirectory()) await visit(filename);
            else {
                const bytes = await readFile(filename);
                files[relative(root, filename).replaceAll("\\", "/")] = { bytes: bytes.length, sha256: retainedDigest(bytes) };
            }
        }
    }
    await visit(root);
    return files;
}
