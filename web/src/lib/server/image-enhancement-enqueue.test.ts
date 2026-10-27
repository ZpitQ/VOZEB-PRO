import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializePostgresSchema, postgresQuery } from "./database/postgres";
import { listEnhancementJobsForTask } from "./database/image-enhancement-job-repository";
import { createStoredGenerationTask } from "./generation-task-store";
import { getImageTask, transitionImageTask, type ImageTask } from "./image-task-store";
import type { FrozenImageEnhancementPolicy } from "./image-enhancement-config";
import { planImageTaskEnhancement } from "./image-enhancement-enqueue";

const userId = "enhancement-enqueue-fixture-owner";
const pg = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
const policy: FrozenImageEnhancementPolicy = {
    revision: "policy-one",
    enabled: true,
    connection: {
        revision: "policy-one",
        credentialRef: "credential-fixture",
        serviceId: "service-fixture",
        timeoutMs: 60_000,
        model: { id: "model-fixture", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [256], defaultTile: 256, tta: false, gpuId: 0 },
    },
};
function nativeTask(): ImageTask {
    const id = randomUUID();
    const media = {
        resultId: `${id}:1`,
        enhancementId: `enhancement:${id}:1`,
        dataUrl: "/api/generation-log-assets/native.png",
        serverUrl: "/api/generation-log-assets/native.png",
        width: 1254,
        height: 1254,
        bytes: 1000,
        mimeType: "image/png",
        nativeSource: { url: "/api/generation-log-assets/native.png", sha256: "a".repeat(64), width: 1254, height: 1254, byteLength: 1000, format: "png", hasAlpha: false, provenance: "provider_native" as const },
    };
    return {
        id,
        userId,
        username: "fixture",
        displayName: "fixture",
        kind: "generation",
        source: "image-workbench",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        config: { baseUrl: "https://fixture.invalid", apiKey: "system", apiFormat: "openai", model: "fixture", quality: "4k", size: "4096x4096" },
        references: [],
        prompt: "fixture",
        enhancementPolicy: structuredClone(policy),
        result: { ...media, results: [media] },
    };
}
describe("ecommerce v2 enhancement admission", () => {
    function canvasTask() {
        const task = nativeTask();
        const canvas = { mode: "ratio" as const, size: { width: 1, height: 1 }, source: "baseline" as const, allowReframe: true };
        task.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            prompt: "fixture",
            parameters: { variant: "nano-banana-2" },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "openai" },
            canvas,
            protection: { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: true },
            referenceRoles: [{ assetId: "scene", role: "scene" }],
        };
        task.enhancementDelivery = { version: "ecommerce-delivery.v2", scope: "full_image", canvas: structuredClone(canvas) };
        task.result!.canvasEvidence = { constraint: structuredClone(canvas), nativeSize: { width: 1254, height: 1254 }, storedSize: { width: 1254, height: 1254 }, nativeUrl: task.result!.nativeSource!.url, normalization: "none" };
        return task;
    }
    function productTask() {
        const task = canvasTask();
        const raw = task.result!.nativeSource!;
        const product = {
            compilerVersion: "strict-product.v1" as const,
            state: "ready" as const,
            productAnchorId: "root",
            sourceAssetId: "product",
            sourceSize: { width: raw.width, height: raw.height },
            productCore: [{ x: 0, y: 0, width: 1, height: 1 }],
            fusionHalo: [],
            editableBackground: [],
        };
        task.kind = "edit";
        task.productProtection = product;
        task.mask = { id: "mask", type: "image/png", name: "mask.png", dataUrl: "data:image/png;base64,AA==" };
        task.enhancementDelivery = {
            version: "ecommerce-delivery.v2",
            scope: "product_background",
            canvas: structuredClone(task.ecommerceExecution!.canvas!),
            protection: { version: "product-enhancement.v2", normalization: "srgb-upright-v1", product: structuredClone(product), maskDataUrl: task.mask.dataUrl, maskSha256: "d".repeat(64) },
            baseline: { url: "/api/reference-assets/product.png", sha256: "c".repeat(64), byteLength: 1200, width: raw.width, height: raw.height, normalizedSha256: "e".repeat(64) },
        };
        task.result!.serverUrl = task.result!.dataUrl = "/api/generation-log-assets/product-base.png";
        task.result!.productEnhancementEvidence = {
            version: "product-baseline.v2",
            nativeUrl: raw.url,
            nativeSha256: raw.sha256,
            baselineUrl: task.result!.serverUrl,
            baselineSha256: "b".repeat(64),
            composition: {
                version: "product-enhancement.v2",
                normalization: "srgb-upright-v1",
                productAnchorId: "root",
                sourceAssetId: "product",
                sourceSha256: "c".repeat(64),
                maskSha256: "d".repeat(64),
                aiSha256: raw.sha256,
                compositeSha256: "b".repeat(64),
                sourceSize: { width: raw.width, height: raw.height },
                aiSize: { width: raw.width, height: raw.height },
                allowedPixels: 10,
                protectedPixels: raw.width * raw.height - 10,
                protectedChangedPixels: 0,
            },
        };
        return task;
    }
    it("queues an explicitly unprotected new canvas without losing the native canvas constraint", () => {
        const task = canvasTask();
        expect(planImageTaskEnhancement(task, task.result!)).toMatchObject({ status: "queued", delivery: { contract: task.enhancementDelivery, baseline: { url: task.result!.serverUrl } } });
    });
    it("binds raw native, protected original and product anchor before background work", () => {
        const task = productTask();
        expect(planImageTaskEnhancement(task, task.result!)).toMatchObject({
            status: "queued",
            target: { width: 1254, height: 1254 },
            source: task.result!.nativeSource,
            delivery: { contract: task.enhancementDelivery, baseline: { url: task.result!.serverUrl, sha256: "b".repeat(64) } },
        });
    });
    it.each(["old", "protected_object", "wrong_canvas", "native_failure", "local"])("keeps %s out of new full-canvas enhancement", (variant) => {
        const task = canvasTask();
        if (variant === "old") task.enhancementDelivery = undefined;
        if (variant === "protected_object") task.ecommerceExecution!.protection!.protectedObjectIds = ["product"];
        if (variant === "wrong_canvas") task.ecommerceExecution!.canvas!.size.width = 2;
        if (variant === "native_failure") {
            task.ecommerceExecution!.canvas!.mode = "exact";
            task.ecommerceExecution!.canvas!.size = { width: 4096, height: 4096 };
            task.enhancementDelivery = { version: "ecommerce-delivery.v2", scope: "full_image", canvas: structuredClone(task.ecommerceExecution!.canvas!) };
        }
        if (variant === "local") task.sceneProtection = {} as ImageTask["sceneProtection"];
        expect(planImageTaskEnhancement(task, task.result!).status).not.toBe("queued");
    });
    it.each(["native_digest", "base_digest", "mask", "root"])("rejects a changed %s protected binding", (variant) => {
        const task = productTask();
        if (variant === "native_digest") task.result!.productEnhancementEvidence!.nativeSha256 = "f".repeat(64);
        if (variant === "base_digest") task.result!.productEnhancementEvidence!.baselineSha256 = "f".repeat(64);
        if (variant === "mask") task.result!.productEnhancementEvidence!.composition.maskSha256 = "f".repeat(64);
        if (variant === "root") task.result!.productEnhancementEvidence!.composition.productAnchorId = "wrong";
        expect(planImageTaskEnhancement(task, task.result!).status).not.toBe("queued");
    });
});
for (const provider of ["file", "postgres"] as const) {
    describe.skipIf(provider === "postgres" && !pg)(`${provider} image completion enhancement outbox`, () => {
        let directory: string;
        let initialized = false;
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-enqueue-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            if (provider === "postgres") {
                const target = new URL(process.env.DATABASE_URL || "");
                if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_m5_e2e")) throw new Error("An explicitly isolated M5 PostgreSQL fixture is required");
                await initializePostgresSchema();
                initialized = true;
                await postgresQuery("INSERT INTO users (id,username,display_name,password_hash) VALUES ($1,$1,'fixture','fixture-hash') ON CONFLICT (id) DO NOTHING", [userId]);
            }
        });
        afterEach(async () => {
            if (provider === "postgres" && initialized) {
                await postgresQuery("DELETE FROM image_enhancement_jobs WHERE user_id=$1", [userId]);
                await postgresQuery("DELETE FROM generation_tasks WHERE user_id=$1", [userId]);
                await postgresQuery("DELETE FROM users WHERE id=$1", [userId]);
            }
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        });
        it("commits exactly one frozen job with native success and does not enqueue on repeated transitions", async () => {
            const task = await createStoredGenerationTask("image", nativeTask(), 60_000);
            const completed = await transitionImageTask(task, ["running"], { status: "success", result: task.result });
            const [job] = await listEnhancementJobsForTask(task.id, userId);
            expect(job).toMatchObject({
                id: task.result!.enhancementId,
                imageTaskId: task.id,
                resultId: task.result!.resultId,
                status: "queued",
                phase: "prepare",
                attempt: 1,
                decision: { status: "queued", source: task.result!.nativeSource, target: { width: 4096, height: 4096 }, inference: { width: 5016, height: 5016 }, connection: policy.connection },
            });
            expect(completed?.status).toBe("success");
            expect((await getImageTask(task.id))?.result).toEqual(task.result);
            expect(await transitionImageTask(task, ["running"], { status: "success", result: task.result })).toBeNull();
            expect(await listEnhancementJobsForTask(task.id, userId)).toEqual([job]);
        });
        it.each(["disabled", "native_sufficient", "unsupported_transparency"])("records a terminal %s decision without due work", async (reason) => {
            const input = nativeTask();
            if (reason === "disabled") input.enhancementPolicy = { ...policy, enabled: false, connection: null };
            if (reason === "native_sufficient") input.config.size = "1024x1024";
            if (reason === "unsupported_transparency") input.result!.results![0].nativeSource = { ...input.result!.results![0].nativeSource!, hasAlpha: true };
            const task = await createStoredGenerationTask("image", input, 60_000);
            await transitionImageTask(task, ["running"], { status: "success", result: task.result });
            expect(await listEnhancementJobsForTask(task.id, userId)).toEqual([expect.objectContaining({ status: "skipped", phase: "completed", reason, nextPollAt: null })]);
            expect((await getImageTask(task.id))?.status).toBe("success");
        });
        it("does not create enhancement work for failed, cancelled or non-native results", async () => {
            for (const status of ["error", "cancelled", "success"] as const) {
                const input = nativeTask();
                if (status === "success") input.result = { dataUrl: "/api/generation-log-assets/unqualified.png" };
                const task = await createStoredGenerationTask("image", input, 60_000);
                await transitionImageTask(task, ["running"], { status, result: task.result });
                expect(await listEnhancementJobsForTask(task.id, userId)).toEqual([]);
            }
        });
    });
}
