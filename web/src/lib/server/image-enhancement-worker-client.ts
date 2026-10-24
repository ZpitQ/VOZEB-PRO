import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { Agent, FormData, request } from "undici";
import type { EnhancementCheck, EnhancementModel, EnhancementSize, ImageEnhancementTimings } from "@/lib/image-enhancement-contract";
import type { EnhancementDecision, EnhancementSource } from "./image-enhancement-plan";

type Connection = { endpoint: string; token: string; trust: "system" | "custom_ca"; caPem: string; timeoutMs: number | null; modelId: string; serviceId: string | null };
type Report = { check: Omit<EnhancementCheck, "revision">; models?: EnhancementModel[]; serviceId?: string };
export class WorkerCheckError extends Error {
    constructor(readonly reason: string) {
        super(reason);
    }
}

type TaskConnection = Omit<Connection, "modelId">;
function workerTransport(connection: TaskConnection) {
    if (!connection.endpoint || !connection.token || !connection.timeoutMs) fail("not_configured");
    const timeoutMs = connection.timeoutMs || fail("not_configured");
    const agent = new Agent({ connect: connection.trust === "custom_ca" ? { ca: connection.caPem, rejectUnauthorized: true } : { rejectUnauthorized: true } });
    async function call(path: string, method: "GET" | "POST" | "DELETE" = "GET", maxBytes = 4 * 1024 * 1024, body?: string | FormData, headers?: Record<string, string>) {
        // JSON responses use the same 4 MiB boundary as the existing admin request parser.
        const response = await request(connection.endpoint + path, {
            method,
            dispatcher: agent,
            headers: { ...headers, authorization: `Bearer ${connection.token}` },
            body,
            signal: AbortSignal.timeout(timeoutMs),
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
        });
        if (response.statusCode === 401 || response.statusCode === 403) {
            response.body.on("error", () => undefined);
            response.body.destroy();
            fail("authentication_failed");
        }
        const chunks: Buffer[] = [];
        let length = 0;
        try {
            for await (const chunk of response.body) {
                length += chunk.length;
                if (length > maxBytes) fail("invalid_response");
                chunks.push(Buffer.from(chunk));
            }
        } catch (error) {
            response.body.destroy();
            throw error;
        }
        const bytes = Buffer.concat(chunks);
        if (response.statusCode !== 200 && response.statusCode !== 202) {
            let code = "";
            try {
                code = String(object(JSON.parse(bytes.toString("utf8"))).code);
            } catch {
                /* Ignore untrusted error text. */
            }
            const reasons = new Map([
                ["configuration_invalid", "worker_configuration_invalid"],
                ["not_ready", "engine_unavailable"],
                ["download_timeout", "timeout"],
                ["budget_exceeded", "output_invalid"],
                ...["strategy_mismatch", "queue_full", "idempotency_conflict", "job_not_found", "result_not_ready", "result_gone", "receipt_conflict"].map((reason) => [reason, reason] as [string, string]),
            ]);
            fail(reasons.get(code) ?? "invalid_response");
        }
        return bytes;
    }
    async function json(path: string, method: "GET" | "POST" | "DELETE" = "GET", body?: string | FormData, headers?: Record<string, string>) {
        const bytes = await call(path, method, undefined, body, headers);
        let payload: Record<string, unknown>;
        try {
            payload = object(JSON.parse(bytes.toString("utf8")));
        } catch {
            return fail("invalid_response");
        }
        if (payload.code !== "ok") fail("invalid_response");
        return object(payload.data);
    }
    return { call, json, close: () => agent.close() };
}

export async function inspectEnhancementWorker(connection: Connection, sample: boolean): Promise<Report> {
    const report: Report = { check: { state: "pending", stage: "configuration", reason: "not_configured", checkedAt: new Date().toISOString() } };
    if (!connection.endpoint || !connection.token || !connection.timeoutMs) return report;
    const { call, json, close } = workerTransport(connection);
    try {
        report.check = { ...report.check, stage: "connection" };
        const capabilities = await json("/v1/capabilities");
        report.check = { ...report.check, stage: "capabilities" };
        const serviceId = uuid(capabilities.serviceId);
        if (connection.serviceId && connection.serviceId !== serviceId) fail("service_identity_changed");
        if (capabilities.protocolVersion !== "image-enhancement.v1" || capabilities.normalizationProfile !== "srgb-upright-v1") fail("invalid_response");
        report.serviceId = serviceId;
        report.check = { ...report.check, serviceId };
        if (!Array.isArray(capabilities.models)) fail("invalid_response");
        report.models = capabilities.models.map(parseModel);
        if (new Set(report.models.map((model) => model.id)).size !== report.models.length) fail("invalid_response");
        if (!report.models.length) fail("model_unavailable");
        if (!sample) {
            report.check = { ...report.check, stage: "engine", state: capabilities.ready === true ? "pending" : "unavailable", reason: capabilities.ready === true ? "sample_required" : "engine_unavailable" };
            return report;
        }
        report.check = { ...report.check, stage: "sample" };
        const selected = report.models.find((model) => model.id === connection.modelId);
        if (!selected) fail("model_unavailable");
        let selfTest = await json("/v1/self-test");
        // The Worker owns one fixed idempotent self-test per boot. Never submit another job after an unknown result.
        if (selfTest.phase === "not_started") selfTest = await json("/v1/self-test", "POST");
        if (selfTest.assetId !== "zeb-enhancement-calibration-v1" || typeof selfTest.bootId !== "string" || !selfTest.bootId) fail("invalid_response");
        report.check = { ...report.check, bootId: selfTest.bootId };
        if (selfTest.jobId) report.check = { ...report.check, jobId: uuid(selfTest.jobId) };
        if (["not_started", "preparing", "bound", "checking_output"].includes(String(selfTest.phase))) {
            report.check = { ...report.check, reason: "sample_pending" };
            return report;
        }
        if (selfTest.phase !== "output_verified") fail("sample_failed");
        if (selfTest.qualification !== "qualified") fail("sample_unqualified");
        const jobId = uuid(selfTest.jobId);
        const job = object((await json(`/v1/enhancement-jobs/${jobId}`)).job);
        if (job.serviceId !== serviceId || job.jobId !== jobId || job.status !== "succeeded") fail("invalid_response");
        const engine = object(object(job.plan).engine);
        // The fixed sample qualifies the GPU service; business jobs freeze their independently selected model.
        const calibration = report.models.find((model) => model.id === engine.modelId);
        if (
            !calibration ||
            ["binaryVersion", "binarySha256", "modelVersion", "modelSha256", "nativeScale", "gpuId", "tta"].some((key) => engine[key] !== calibration[key as keyof EnhancementModel]) ||
            !calibration.allowedTiles.includes(engine.tile as number)
        )
            fail("sample_model_mismatch");
        report.check = { ...report.check, stage: "output" };
        const result = object(job.result);
        const selfOutput = object(selfTest.output);
        if (["sha256", "byteLength", "width", "height"].some((key) => result[key] !== selfOutput[key])) fail("output_invalid");
        const aiBudget = object(object(capabilities.budgets).ai);
        const bytes = await call(`/v1/enhancement-jobs/${jobId}/result`, "GET", positive(aiBudget.maxBytes));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (sha256 !== result.sha256 || bytes.length !== result.byteLength) fail("output_invalid");
        const input = size(job.source);
        const engineInput = size(job.engineInput);
        const expected = size(result);
        const inference = { width: engineInput.width * calibration.nativeScale, height: engineInput.height * calibration.nativeScale };
        if (expected.width !== inference.width || expected.height !== inference.height) fail("output_invalid");
        try {
            const image = sharp(bytes, { failOn: "warning", limitInputPixels: positive(aiBudget.maxPixels) });
            const metadata = await image.metadata();
            const { info } = await image.raw().toBuffer({ resolveWithObject: true });
            if (metadata.format !== "png" || (metadata.pages && metadata.pages !== 1) || info.width !== expected.width || info.height !== expected.height) fail("output_invalid");
        } catch {
            fail("output_invalid");
        }
        const afterSample = await json("/v1/self-test");
        const afterCapabilities = await json("/v1/capabilities");
        if (afterSample.bootId !== selfTest.bootId || afterSample.jobId !== jobId || afterSample.phase !== "output_verified" || afterSample.qualification !== "qualified" || object(afterSample.output).sha256 !== sha256) fail("sample_changed");
        if (afterCapabilities.serviceId !== serviceId) fail("service_identity_changed");
        if (afterCapabilities.ready !== true) fail("engine_unavailable");
        if (!Array.isArray(afterCapabilities.models)) fail("model_unavailable");
        const currentModels = afterCapabilities.models.map(parseModel);
        if (![selected, calibration].every((expected) => currentModels.some((model) => isDeepStrictEqual(model, expected)))) fail("model_unavailable");
        report.check = { ...report.check, state: "ready", reason: "ready", sample: { input, inference, output: expected, sha256, byteLength: bytes.length } };
        return report;
    } catch (error) {
        const reason = error instanceof WorkerCheckError ? error.reason : transportReason(error);
        report.check = { ...report.check, state: "unavailable", stage: reason === "authentication_failed" ? "authentication" : report.check.stage, reason };
        return report;
    } finally {
        await close();
    }
}

type Budget = Readonly<{ maxBytes: number; maxPixels: number }>;
export type EnhancementWorkerBudgets = Readonly<{ input: Budget; ai: Budget; delivery: Budget }>;
export type EnhancementArtifact = Readonly<EnhancementSize & { format: "png"; sha256: string; byteLength: number }>;
export type FrozenWorkerEnhancementPlan = Readonly<{
    protocolVersion: "image-enhancement.v1";
    scope: "full_image";
    target: Readonly<EnhancementSize & { format: "png" }>;
    normalizationProfile: "srgb-upright-v1";
    engine: Readonly<{ modelId: string; binaryVersion: string; binarySha256: string; modelVersion: string; modelSha256: string; nativeScale: 4; tile: number; tta: false; gpuId: number }>;
    budgets: EnhancementWorkerBudgets;
    sourceSha256: string;
    strategyFingerprint: string;
    planFingerprint: string;
    source: Readonly<EnhancementSource>;
}>;
export type RemoteEnhancementJob = Readonly<{
    jobId: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    reason: string | null;
    result: EnhancementArtifact | null;
    createdAt: number;
    completedAt: number | null;
    timings?: Pick<ImageEnhancementTimings, "workerQueueMs" | "workerExecutionMs">;
}>;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createEnhancementTaskClient(connection: TaskConnection) {
    const transport = workerTransport(connection);
    async function safe<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            throw error instanceof WorkerCheckError ? error : new WorkerCheckError(transportReason(error));
        }
    }
    async function identity() {
        const capabilities = await transport.json("/v1/capabilities");
        if (uuid(capabilities.serviceId) !== connection.serviceId) fail("service_identity_changed");
        if (capabilities.protocolVersion !== "image-enhancement.v1" || capabilities.normalizationProfile !== "srgb-upright-v1") fail("invalid_response");
        return capabilities;
    }
    function artifact(value: unknown): EnhancementArtifact {
        const data = object(value);
        if (data.format !== "png" || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) fail("output_invalid");
        return { ...size(data), format: "png", sha256: data.sha256, byteLength: positive(data.byteLength) };
    }
    function job(value: unknown, plan: FrozenWorkerEnhancementPlan, expectedId?: string): RemoteEnhancementJob {
        const data = object(value);
        const id = uuid(data.jobId);
        const remotePlan = object(data.plan);
        const engineInput = size(data.engineInput);
        if (
            data.serviceId !== connection.serviceId ||
            (expectedId && id !== expectedId) ||
            remotePlan.planFingerprint !== plan.planFingerprint ||
            remotePlan.strategyFingerprint !== plan.strategyFingerprint ||
            object(data.source).sha256 !== plan.sourceSha256 ||
            engineInput.width !== plan.source.width ||
            engineInput.height !== plan.source.height
        )
            fail("invalid_response");
        if (typeof data.status !== "string" || !["queued", "running", "succeeded", "failed", "cancelled"].includes(data.status)) fail("invalid_response");
        const output = data.result ? artifact(data.result) : null;
        if (data.status === "succeeded" && (!output || output.width !== engineInput.width * plan.engine.nativeScale || output.height !== engineInput.height * plan.engine.nativeScale)) fail("output_invalid");
        // Worker reason values are codes; never expose arbitrary upstream text.
        const reason = data.reason === null ? null : typeof data.reason === "string" && /^[a-z][a-z0-9_]*$/.test(data.reason) ? data.reason : "invalid_response";
        const timings: NonNullable<RemoteEnhancementJob["timings"]> = {};
        if (data.timings !== undefined) {
            const reported = object(data.timings);
            for (const key of ["workerQueueMs", "workerExecutionMs"] as const) {
                if (!Object.hasOwn(reported, key)) continue;
                const value = reported[key];
                if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("invalid_response");
                timings[key] = value;
            }
        }
        return Object.freeze({
            jobId: id,
            status: data.status as RemoteEnhancementJob["status"],
            reason,
            result: output,
            createdAt: positive(data.createdAt),
            completedAt: data.completedAt === null ? null : positive(data.completedAt),
            ...(Object.keys(timings).length ? { timings: Object.freeze(timings) } : {}),
        });
    }
    return {
        prepare: (decision: Extract<EnhancementDecision, { status: "queued" }>) =>
            safe(async (): Promise<FrozenWorkerEnhancementPlan> => {
                if (decision.connection.serviceId !== connection.serviceId) fail("service_identity_changed");
                const capabilities = await identity();
                if (object(capabilities.features).expectedStrategyFingerprint !== true) fail("strategy_binding_unavailable");
                if (capabilities.ready !== true) fail("engine_unavailable");
                if (!Array.isArray(capabilities.models)) fail("invalid_response");
                const selected = capabilities.models.map(parseModel).find((model) => model.id === decision.connection.model.id);
                if (!selected || !isDeepStrictEqual(selected, decision.connection.model)) fail("model_unavailable");
                const raw = object(capabilities.budgets);
                const budget = (key: string) => Object.freeze({ maxBytes: positive(object(raw[key]).maxBytes), maxPixels: positive(object(raw[key]).maxPixels) });
                const budgets = Object.freeze({ input: budget("input"), ai: budget("ai"), delivery: budget("delivery") });
                const inferencePixels = BigInt(decision.inference.width) * BigInt(decision.inference.height);
                if (
                    decision.source.byteLength > budgets.input.maxBytes ||
                    BigInt(decision.source.width) * BigInt(decision.source.height) > BigInt(budgets.input.maxPixels) ||
                    inferencePixels > BigInt(budgets.ai.maxPixels) ||
                    inferencePixels > BigInt(budgets.delivery.maxPixels) ||
                    BigInt(decision.target.width) * BigInt(decision.target.height) > BigInt(budgets.delivery.maxPixels)
                )
                    fail("budget_exceeded");
                // The Worker produces native 4x; ZEB owns the separate requested delivery boundary.
                const target = Object.freeze({ width: decision.inference.width, height: decision.inference.height, format: "png" as const });
                const engine = Object.freeze({
                    modelId: selected.id,
                    binaryVersion: selected.binaryVersion,
                    binarySha256: selected.binarySha256,
                    modelVersion: selected.modelVersion,
                    modelSha256: selected.modelSha256,
                    nativeScale: selected.nativeScale,
                    tile: selected.defaultTile,
                    tta: selected.tta,
                    gpuId: selected.gpuId,
                });
                const strategy = { protocolVersion: "image-enhancement.v1" as const, scope: "full_image" as const, target, normalizationProfile: "srgb-upright-v1" as const, engine, budgets };
                return Object.freeze({
                    ...strategy,
                    sourceSha256: decision.source.sha256,
                    strategyFingerprint: fingerprint(strategy),
                    planFingerprint: fingerprint({ sourceSha256: decision.source.sha256, ...strategy }),
                    source: Object.freeze({ ...decision.source }),
                });
            }),
        submit: (plan: FrozenWorkerEnhancementPlan, bytes: Buffer, key: string) =>
            safe(async () => {
                if (bytes.length !== plan.source.byteLength || createHash("sha256").update(bytes).digest("hex") !== plan.sourceSha256) fail("input_digest_mismatch");
                await identity();
                const body = new FormData();
                body.append(
                    "plan",
                    JSON.stringify({
                        protocolVersion: plan.protocolVersion,
                        scope: plan.scope,
                        sourceSha256: plan.sourceSha256,
                        target: plan.target,
                        modelId: plan.engine.modelId,
                        normalizationProfile: plan.normalizationProfile,
                        tile: plan.engine.tile,
                        expectedStrategyFingerprint: plan.strategyFingerprint,
                    }),
                );
                body.append("image", new Blob([new Uint8Array(bytes)], { type: plan.source.format === "jpeg" ? "image/jpeg" : "image/png" }), `source.${plan.source.format}`);
                const result = await transport.json("/v1/enhancement-jobs", "POST", body, { "idempotency-key": key });
                if (typeof result.replayed !== "boolean") fail("invalid_response");
                return { job: job(result.job, plan), replayed: result.replayed };
            }),
        query: (plan: FrozenWorkerEnhancementPlan, jobId: string) =>
            safe(async () => {
                await identity();
                return job((await transport.json(`/v1/enhancement-jobs/${uuid(jobId)}`)).job, plan, jobId);
            }),
        download: (plan: FrozenWorkerEnhancementPlan, jobId: string, expected: EnhancementArtifact) =>
            safe(async () => {
                await identity();
                const bytes = await transport.call(`/v1/enhancement-jobs/${uuid(jobId)}/result`, "GET", plan.budgets.ai.maxBytes);
                if (
                    bytes.length !== expected.byteLength ||
                    createHash("sha256").update(bytes).digest("hex") !== expected.sha256 ||
                    expected.width !== plan.source.width * plan.engine.nativeScale ||
                    expected.height !== plan.source.height * plan.engine.nativeScale
                )
                    fail("output_invalid");
                try {
                    const image = sharp(bytes, { failOn: "warning", limitInputPixels: plan.budgets.ai.maxPixels });
                    const metadata = await image.metadata();
                    const stats = await image.stats();
                    if (metadata.format !== "png" || (metadata.pages && metadata.pages !== 1) || (metadata.orientation && metadata.orientation !== 1) || metadata.width !== expected.width || metadata.height !== expected.height || !stats.isOpaque)
                        fail("output_invalid");
                } catch {
                    fail("output_invalid");
                }
                return bytes;
            }),
        acknowledge: (plan: FrozenWorkerEnhancementPlan, jobId: string, receiptId: string, output: EnhancementArtifact) =>
            safe(async () => {
                await identity();
                await transport.json(`/v1/enhancement-jobs/${uuid(jobId)}/receipt`, "POST", JSON.stringify({ serviceId: connection.serviceId, receiptId: uuid(receiptId), result: output }), { "content-type": "application/json" });
            }),
        cancel: (plan: FrozenWorkerEnhancementPlan, jobId: string) =>
            safe(async () => {
                await identity();
                return job((await transport.json(`/v1/enhancement-jobs/${uuid(jobId)}`, "DELETE")).job, plan, jobId);
            }),
        close: transport.close,
    };
}

function fail(reason: string): never {
    throw new WorkerCheckError(reason);
}
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_response");
    return value as Record<string, unknown>;
}
function positive(value: unknown) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail("invalid_response");
    return value;
}
function size(value: unknown): EnhancementSize {
    const data = object(value);
    return { width: positive(data.width), height: positive(data.height) };
}
function uuid(value: unknown) {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail("invalid_response");
    return value;
}
function parseModel(value: unknown): EnhancementModel {
    const data = object(value);
    if (data.nativeScale !== 4) fail("model_unavailable");
    for (const key of ["id", "binaryVersion", "modelVersion"]) if (typeof data[key] !== "string" || !data[key]) fail("invalid_response");
    for (const key of ["binarySha256", "modelSha256"]) if (typeof data[key] !== "string" || !/^[a-f0-9]{64}$/.test(data[key] as string)) fail("invalid_response");
    if (
        !Array.isArray(data.allowedTiles) ||
        !data.allowedTiles.length ||
        !data.allowedTiles.every((tile) => Number.isSafeInteger(tile) && tile >= 0) ||
        !data.allowedTiles.includes(data.defaultTile) ||
        data.tta !== false ||
        !Number.isSafeInteger(data.gpuId) ||
        Number(data.gpuId) < 0
    )
        fail("invalid_response");
    return {
        id: data.id as string,
        binaryVersion: data.binaryVersion as string,
        binarySha256: data.binarySha256 as string,
        modelVersion: data.modelVersion as string,
        modelSha256: data.modelSha256 as string,
        nativeScale: 4,
        allowedTiles: [...data.allowedTiles] as number[],
        defaultTile: data.defaultTile as number,
        tta: false,
        gpuId: data.gpuId as number,
    };
}
function transportReason(error: unknown) {
    const current = error as { code?: string; name?: string; cause?: { code?: string } };
    const code = current?.code ?? current?.cause?.code ?? "";
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return "tls_untrusted";
    if (/TIMEOUT|TIMEDOUT/.test(code) || current?.name === "TimeoutError" || current?.name === "AbortError") return "timeout";
    return "connection_failed";
}
