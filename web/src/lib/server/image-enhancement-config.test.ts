import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getImageEnhancementSettings, saveImageEnhancementSettings, checkImageEnhancementSettings, freezeImageEnhancementConnection, resolveImageEnhancementConnection, captureImageEnhancementPolicy } from "./image-enhancement-config";
import { createImageTask, getImageTask } from "./image-task-store";

const token = "fixture-enhancement-access";
let directory: string;
let server: Server;
let endpoint: string;
let requests: string[];
let mode: string;
let capabilityReadiness: boolean[];
let image: Buffer;
let gate: Promise<void> | undefined;
let release: (() => void) | undefined;
let availableModels: Array<typeof model>;
const serviceId = "31313131-3131-4131-8131-313131313131";
const jobId = "42424242-4242-4242-8242-424242424242";
const model = { id: "fixture-model", binaryVersion: "v1", binarySha256: "a".repeat(64), modelVersion: "v1", modelSha256: "b".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 };

async function save(input: Record<string, unknown> = {}) {
    const settings = await getImageEnhancementSettings();
    return saveImageEnhancementSettings({ revision: settings.revision, ...input });
}
async function check(action: "connection" | "sample" = "connection") {
    return checkImageEnhancementSettings({ revision: (await getImageEnhancementSettings()).revision, action });
}
async function configured() {
    await save({ mode: "remote_api", endpoint, token, timeoutMs: 10_000 });
    await check();
    await save({ modelId: model.id });
}
async function qualified() {
    await configured();
    await check("sample");
    return save({ enabled: true });
}

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "enhancement-admin-"));
    vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
    vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "5d".repeat(32));
    requests = [];
    mode = "ok";
    capabilityReadiness = [];
    availableModels = [model];
    image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#dedede" } })
        .png()
        .toBuffer();
    server = createServer(async (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        if (gate) await gate;
        if (request.headers.authorization !== `Bearer ${token}` || mode === "auth") {
            response.writeHead(401).end(JSON.stringify({ code: "authentication_failed", msg: token }));
            return;
        }
        if (mode === "redirect") {
            response.writeHead(302, { location: "http://unrelated.invalid/" }).end();
            return;
        }
        if (mode === "hang") return;
        if (mode === "worker-configuration") {
            response.writeHead(503).end(JSON.stringify({ code: "configuration_invalid", msg: token }));
            return;
        }
        if (request.url === "/v1/self-test" && request.method === "POST" && mode === "not-started") mode = "pending";
        const outputImage = mode === "truncated-consistent" ? image.subarray(0, 50) : image;
        const output = { width: 8, height: 8, byteLength: outputImage.length, sha256: createHash("sha256").update(outputImage).digest("hex"), format: "png" };
        let data: unknown;
        if (request.url === "/v1/capabilities")
            data = {
                serviceId: mode === "identity" ? jobId : serviceId,
                protocolVersion: "image-enhancement.v1",
                normalizationProfile: "srgb-upright-v1",
                models: mode === "no-model" ? [] : availableModels.map((entry) => ({ ...entry, nativeScale: mode === "scale" ? 2 : 4 })),
                budgets: { input: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 }, delivery: { maxBytes: 1_000_000, maxPixels: 1_000_000 } },
                ready: capabilityReadiness.shift() ?? mode !== "gpu",
                reason: mode === "gpu" ? "runner_unavailable" : null,
            };
        else if (request.url === "/v1/self-test")
            data = {
                bootId: mode === "rebooted" ? "boot-new" : "boot-fixture",
                assetId: "zeb-enhancement-calibration-v1",
                phase: mode === "not-started" ? "not_started" : mode === "pending" ? "bound" : mode === "unknown" ? "unknown" : "output_verified",
                qualification: mode === "unqualified" ? "unknown" : "qualified",
                jobId,
                reason: null,
                output,
            };
        else if (request.url === `/v1/enhancement-jobs/${jobId}`)
            data = {
                job: {
                    serviceId,
                    jobId,
                    status: "succeeded",
                    source: { width: 2, height: 2 },
                    engineInput: { width: 2, height: 2 },
                    result: output,
                    plan: { engine: { ...model, modelId: mode === "other-model" ? "other" : model.id, gpuId: mode === "other-gpu" ? 1 : 0, tile: mode === "other-tile" ? 64 : 0, tta: mode === "other-tta" } },
                },
            };
        else if (request.url === `/v1/enhancement-jobs/${jobId}/result`) {
            response.writeHead(200, { "content-type": "image/png" }).end(mode === "corrupt" ? image.subarray(0, 50) : outputImage);
            if (mode === "reboot-during-download") mode = "rebooted";
            if (mode === "remove-calibration-during-download") availableModels = availableModels.filter((entry) => entry.id !== model.id);
            return;
        } else {
            response.writeHead(404).end();
            return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ code: "ok", data, msg: "OK" }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
    release?.();
    gate = undefined;
    release = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
});

describe("image enhancement administrator configuration", () => {
    it("discovers models using only an address and token with the standard request deadline", async () => {
        const saved = await save({ endpoint, token });
        expect(saved.timeoutMs).toBe(30_000);
        const result = await check();
        expect(result.models).toEqual([model]);
        expect(result.check?.reason).toBe("sample_required");
        expect(requests).toEqual(["GET /v1/capabilities"]);
    });
    it("qualifies a selected model using the Worker's registered fixed GPU calibration model", async () => {
        const alternate = { ...model, id: "fixture-alternative", modelVersion: "v2", modelSha256: "c".repeat(64) };
        availableModels = [model, alternate];
        await configured();
        await save({ modelId: alternate.id });
        const result = await check("sample");
        expect(result).toMatchObject({ ready: true, modelId: alternate.id });
        expect(requests.every((entry) => entry.startsWith("GET"))).toBe(true);
    });
    it("rejects a calibration model that disappears during its output verification", async () => {
        const alternate = { ...model, id: "fixture-alternative", modelSha256: "c".repeat(64) };
        availableModels = [model, alternate];
        await configured();
        await save({ modelId: alternate.id });
        mode = "remove-calibration-during-download";
        expect((await check("sample")).check?.reason).toBe("model_unavailable");
    });
    it("captures disabled intent without a connection or Worker request", async () => {
        const settings = await getImageEnhancementSettings();
        expect(await captureImageEnhancementPolicy()).toEqual({ revision: settings.revision, enabled: false, connection: null });
        expect(requests).toEqual([]);
    });
    it("distinguishes enabled-but-unavailable intent from disabled", async () => {
        await qualified();
        const settings = await save({ clearToken: true });
        expect(await captureImageEnhancementPolicy()).toEqual({ revision: settings.revision, enabled: true, connection: null });
    });
    it("persists the creation-time policy independently of later settings", async () => {
        const enabled = await qualified();
        const input = {
            userId: "enhancement-fixture-user",
            username: "fixture",
            displayName: "fixture",
            kind: "generation" as const,
            source: "image-workbench" as const,
            config: { baseUrl: "https://fixture.invalid", apiKey: "", apiFormat: "openai" as const, model: "fixture-image", size: "4096x4096" },
            prompt: "fixture",
            references: [],
        };
        const original = await createImageTask(input);
        const policy = original.enhancementPolicy!;
        expect(policy).toMatchObject({ revision: enabled.revision, enabled: true, connection: { serviceId, model } });
        const serialized = JSON.stringify(policy);
        const disabled = await save({ enabled: false });
        const next = await createImageTask(input);
        expect((await getImageTask(original.id))?.enhancementPolicy).toEqual(JSON.parse(serialized));
        expect(next.enhancementPolicy).toEqual({ revision: disabled.revision, enabled: false, connection: null });
        expect(serialized).not.toMatch(/token|endpoint|password/i);
        expect(requests.every((value) => value.startsWith("GET"))).toBe(true);
    });
    it("advances the revision for toggle changes while retaining the qualified sample", async () => {
        const enabled = await qualified();
        const disabled = await saveImageEnhancementSettings({ revision: enabled.revision, enabled: false });
        expect(disabled).toMatchObject({ enabled: false, ready: true });
        expect(disabled.revision).not.toBe(enabled.revision);
        expect(disabled.check?.sample).toEqual(enabled.check?.sample);
        await expect(saveImageEnhancementSettings({ revision: enabled.revision, enabled: true })).rejects.toMatchObject({ code: "configuration_changed", status: 409 });
        expect((await getImageEnhancementSettings()).enabled).toBe(false);
        expect(await saveImageEnhancementSettings({ revision: disabled.revision, enabled: true })).toMatchObject({ enabled: true, ready: true });
    });
    it("accepts only one concurrent toggle for the same revision", async () => {
        await configured();
        const before = await check("sample");
        const writes = await Promise.allSettled([saveImageEnhancementSettings({ revision: before.revision, enabled: true }), saveImageEnhancementSettings({ revision: before.revision, enabled: true })]);
        expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
        expect(writes.find((write) => write.status === "rejected")).toMatchObject({ status: "rejected", reason: { code: "configuration_changed", status: 409 } });
        expect(await getImageEnhancementSettings()).toMatchObject({ enabled: true, ready: true });
    });
    it("starts disabled without probing or initializing an engine", async () => {
        expect(await getImageEnhancementSettings()).toMatchObject({ enabled: false, ready: false, mode: "remote_api", hasToken: false });
        expect(requests).toEqual([]);
        expect(await freezeImageEnhancementConnection()).toBeNull();
    });
    it("persists encrypted credentials and never returns them", async () => {
        await configured();
        const data = await getImageEnhancementSettings();
        expect(data).toMatchObject({ endpoint, hasToken: true, modelId: model.id });
        expect(JSON.stringify(data)).not.toContain(token);
        const stored = await readFile(join(directory, "image-enhancement-settings.json"), "utf8");
        expect(stored).not.toContain(token);
        expect(stored).toContain("vozeb-pro-secret:v1:");
    });
    it("preserves blank tokens and retains readiness on equivalent saves", async () => {
        const before = await qualified();
        const after = await save({ token: "", endpoint: endpoint + "/" });
        expect(after).toMatchObject({ revision: before.revision, ready: true, enabled: true, hasToken: true });
    });
    it("explicit clearing removes credentials, invalidates checks and preserves enabled intent", async () => {
        await qualified();
        expect(await save({ clearToken: true })).toMatchObject({ enabled: true, ready: false, hasToken: false });
        expect(await freezeImageEnhancementConnection()).toBeNull();
    });
    it("does not enable before a complete sample is decoded", async () => {
        await configured();
        await expect(save({ enabled: true })).rejects.toMatchObject({ code: "not_ready" });
        await check();
        await expect(save({ enabled: true })).rejects.toMatchObject({ code: "not_ready" });
        await check("sample");
        expect(await save({ enabled: true })).toMatchObject({ enabled: true, ready: true });
        expect(requests.filter((path) => path.startsWith("POST"))).toEqual([]);
    });
    it.each(["auth", "gpu", "no-model", "scale", "redirect", "corrupt", "other-model", "unqualified", "pending"])("cannot qualify unsafe or incomplete sample: %s", async (failure) => {
        await configured();
        mode = failure;
        const result = await check("sample");
        expect(result.ready).toBe(false);
        expect(JSON.stringify(result)).not.toContain(token);
        await expect(save({ enabled: true })).rejects.toMatchObject({ code: "not_ready" });
        expect(requests.some((value) => value.startsWith("POST"))).toBe(false);
    });
    it("records actual input, inference and decoded output sizes", async () => {
        await configured();
        expect((await check("sample")).check).toMatchObject({ state: "ready", sample: { input: { width: 2, height: 2 }, inference: { width: 8, height: 8 }, output: { width: 8, height: 8 }, sha256: createHash("sha256").update(image).digest("hex") } });
    });
    it("qualifies a verified sample when capabilities become ready during the same check", async () => {
        await configured();
        requests = [];
        capabilityReadiness = [false, true];
        expect(await check("sample")).toMatchObject({
            ready: true,
            check: {
                state: "ready",
                reason: "ready",
                serviceId,
                bootId: "boot-fixture",
                jobId,
                sample: { input: { width: 2, height: 2 }, inference: { width: 8, height: 8 }, output: { width: 8, height: 8 }, sha256: createHash("sha256").update(image).digest("hex"), byteLength: image.length },
            },
        });
        expect(capabilityReadiness).toEqual([]);
        expect(requests).toEqual(["GET /v1/capabilities", "GET /v1/self-test", `GET /v1/enhancement-jobs/${jobId}`, `GET /v1/enhancement-jobs/${jobId}/result`, "GET /v1/self-test", "GET /v1/capabilities"]);
    });
    it("rejects a verified sample when the final capabilities are no longer ready", async () => {
        await configured();
        requests = [];
        capabilityReadiness = [true, false];
        expect(await check("sample")).toMatchObject({ ready: false, check: { state: "unavailable", stage: "output", reason: "engine_unavailable" } });
        expect(capabilityReadiness).toEqual([]);
        expect(requests).toEqual(["GET /v1/capabilities", "GET /v1/self-test", `GET /v1/enhancement-jobs/${jobId}`, `GET /v1/enhancement-jobs/${jobId}/result`, "GET /v1/self-test", "GET /v1/capabilities"]);
        await expect(save({ enabled: true })).rejects.toMatchObject({ code: "not_ready" });
    });
    it.each(["http://user:secret@localhost", "http://localhost/?token=secret", "http://localhost/#secret", "file:///tmp/image", "http://localhost/?", "http://localhost/#"])("rejects unsafe credential-bearing endpoints: %s", async (url) => {
        await expect(save({ endpoint: url })).rejects.toMatchObject({ code: "invalid_configuration" });
        expect(requests).toEqual([]);
    });
    it.each(["ssh", "local_cli", "mtls", "password"])("rejects unimplemented mode/auth: %s", async (value) => {
        await expect(save({ mode: value })).rejects.toMatchObject({ code: "invalid_configuration" });
    });
    it("rejects unknown models without persisting a revision", async () => {
        await configured();
        const before = await getImageEnhancementSettings();
        await expect(save({ modelId: "../../not-a-model" })).rejects.toMatchObject({ code: "model_unavailable" });
        expect((await getImageEnhancementSettings()).revision).toBe(before.revision);
    });
    it("rejects stale updates and late validation results", async () => {
        await configured();
        const before = await getImageEnhancementSettings();
        await save({ timeoutMs: 20_000 });
        await expect(saveImageEnhancementSettings({ revision: before.revision, clearToken: true })).rejects.toMatchObject({ code: "configuration_changed" });
        gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const pending = check("sample");
        await vi.waitFor(() => expect(requests.filter((value) => value === "GET /v1/capabilities").length).toBeGreaterThan(1));
        await save({ timeoutMs: 21_000 });
        release!();
        gate = undefined;
        await expect(pending).rejects.toMatchObject({ code: "configuration_changed" });
        expect((await getImageEnhancementSettings()).ready).toBe(false);
    });
    it("preserves intent across failure and recovery", async () => {
        await qualified();
        mode = "auth";
        expect(await check()).toMatchObject({ enabled: true, ready: false, check: { reason: "authentication_failed" } });
        mode = "ok";
        expect(await check("sample")).toMatchObject({ enabled: true, ready: true });
    });
    it("turning off does not cancel, restart, or mutate existing frozen connections", async () => {
        await qualified();
        const frozen = (await freezeImageEnhancementConnection())!;
        expect(JSON.stringify(frozen)).not.toContain(token);
        await save({ enabled: false });
        expect(await freezeImageEnhancementConnection()).toBeNull();
        expect((await resolveImageEnhancementConnection(frozen)).endpoint).toBe(endpoint);
        expect(requests.every((value) => value.startsWith("GET"))).toBe(true);
    });
    it("retains original endpoint ownership when the administrator changes address", async () => {
        await qualified();
        const frozen = (await freezeImageEnhancementConnection())!;
        await save({ endpoint: endpoint + "/second-service" });
        expect((await resolveImageEnhancementConnection(frozen)).endpoint).toBe(endpoint);
        expect((await getImageEnhancementSettings()).ready).toBe(false);
    });
    it("uses a controlled updated credential reference for the same service", async () => {
        await qualified();
        const frozen = (await freezeImageEnhancementConnection())!;
        await save({ token: "rotated-fixture-token" });
        expect((await resolveImageEnhancementConnection(frozen)).token).toBe("rotated-fixture-token");
        expect(JSON.stringify(frozen)).not.toContain(token);
    });
    it("does not treat a changed service identity as the original", async () => {
        await qualified();
        mode = "identity";
        expect((await check("sample")).check?.reason).toBe("service_identity_changed");
    });
    it("does not qualify a previous boot when the service restarts during download", async () => {
        await configured();
        mode = "reboot-during-download";
        expect((await check("sample")).ready).toBe(false);
    });
    it("distinguishes Worker configuration rejection from network failure without echoing its message", async () => {
        await configured();
        mode = "worker-configuration";
        const result = await check();
        expect(result.check?.reason).toBe("worker_configuration_invalid");
        expect(JSON.stringify(result)).not.toContain(token);
    });
    it("rejects a truncated image even when its declared hash and dimensions match", async () => {
        await configured();
        mode = "truncated-consistent";
        expect((await check("sample")).check).toMatchObject({ state: "unavailable", reason: "output_invalid" });
    });
    it("reports a configured request deadline independently of authentication", async () => {
        await configured();
        await save({ timeoutMs: 50 });
        mode = "hang";
        expect((await check()).check).toMatchObject({ state: "unavailable", reason: "timeout" });
    });
    it("reports connection refusal without modifying the enabled intent", async () => {
        await qualified();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        expect(await check()).toMatchObject({ enabled: true, ready: false, check: { reason: "connection_failed" } });
    });
    it.each(["other-gpu", "other-tile", "other-tta"])("does not qualify an unexpected execution policy: %s", async (failure) => {
        await configured();
        mode = failure;
        expect((await check("sample")).check).toMatchObject({ state: "unavailable", reason: "sample_model_mismatch" });
    });
    it("starts the fixed sample once and only queries its pending operation afterward", async () => {
        await configured();
        mode = "not-started";
        expect((await check("sample")).check?.reason).toBe("sample_pending");
        expect((await check("sample")).check?.reason).toBe("sample_pending");
        expect(requests.filter((path) => path === "POST /v1/self-test")).toHaveLength(1);
        mode = "ok";
        expect((await check("sample")).ready).toBe(true);
        expect(requests.filter((path) => path === "POST /v1/self-test")).toHaveLength(1);
    });
    it("does not resubmit a sample whose original outcome is unknown", async () => {
        await configured();
        mode = "unknown";
        expect((await check("sample")).check?.reason).toBe("sample_failed");
        expect((await check("sample")).check?.reason).toBe("sample_failed");
        expect(requests.filter((path) => path.startsWith("POST"))).toEqual([]);
    });
});
