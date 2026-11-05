import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImageProcessingEnhancementOptions, ProductEnhancementDescriptor, SceneProtectionSnapshot } from "../image-processing/contracts";
import type { CompleteImageProcessingInput } from "./image-processing-service";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const descriptor = (bytes: Buffer, width: number, height: number) => ({ sha256: digest(bytes), byteLength: bytes.length, width, height, format: "png" as const });
const solid = (width: number, height: number, background: string) =>
    sharp({ create: { width, height, channels: 3, background } })
        .png()
        .toBuffer();
const budget = { maxBytes: 1_000_000, maxPixels: 1_000_000 };
const workerToken = "fixture-enhancement-complete-http-worker-token-0001";

// Actual CPU kernels produce these files. No child is claimed, no report is persisted, and404 proves only HTTP parsing and service dispatch.
describe("enhancement completion HTTP boundary from actual CPU artifacts", () => {
    let directory: string;
    let route: typeof import("@/app/api/maintenance/image-processing/[id]/complete/route");
    let operations: typeof import("../image-processing/operations");
    let tasks: typeof import("./generation-task-store");

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-complete-boundary-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", workerToken);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "fixture-enhancement-complete-http-maintenance-token-0001");
        [route, operations, tasks] = await Promise.all([import("@/app/api/maintenance/image-processing/[id]/complete/route"), import("../image-processing/operations"), import("./generation-task-store")]);
        assert.ok((await import("./maintenance-auth")).isWorkerTokenConfigured());
    });
    afterAll(async () => {
        try {
            await rm(directory, { recursive: true, force: true });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    async function execute(images: Array<{ bytes: Buffer; assetId: string }>, options: ImageProcessingEnhancementOptions): Promise<CompleteImageProcessingInput> {
        const taskDirectory = await mkdtemp(join(directory, "actual-kernel-"));
        const outputDirectory = join(taskDirectory, "output");
        await mkdir(outputDirectory);
        const inputs = await Promise.all(
            images.map(async (image, index) => {
                const path = join(taskDirectory, "input-" + index);
                await writeFile(path, image.bytes);
                return { path, assetId: image.assetId, assetVersion: "fixture-v1", expectedSha256: digest(image.bytes) };
            }),
        );
        const executionId = randomUUID();
        const started = performance.now();
        const result = await operations.executeImageProcessing({ version: "image-processing.v1", jobId: "image-process-" + randomUUID(), executionId, operation: "process_enhancement", options, inputs, outputDirectory }, () => {});
        const memory = process.memoryUsage();
        return {
            workerId: "fixture-http-boundary",
            executionId,
            manifest: { ...result, artifacts: result.artifacts.map(({ path: _path, ...artifact }, index) => ({ ...artifact, storageKey: "fixture-unregistered-final-" + index })) },
            metrics: { pid: process.pid, peakRssBytes: memory.rss, peakHeapUsedBytes: memory.heapUsed, peakExternalBytes: memory.external, elapsedMs: performance.now() - started },
        };
    }
    async function fixture(scope: ImageProcessingEnhancementOptions["scope"]) {
        const source = await solid(6, 4, "#5a4632");
        const ai = await solid(24, 16, "#2385e9");
        const common = {
            bindingDigest: "a".repeat(64),
            resultId: "fixture-result:1",
            resultIndex: 1,
            aiInputIndex: 0,
            engineInput: { width: 6, height: 4 },
            expectedAi: descriptor(ai, 24, 16),
            targetSize: { width: 6, height: 4 },
            budgets: { input: budget, ai: budget, delivery: budget },
        };
        if (scope === "full_image") return execute([{ bytes: ai, assetId: "ai" }], { ...common, scope });
        const native = await solid(scope === "local_edit" ? 3 : 6, scope === "local_edit" ? 2 : 4, "#be6e2d");
        const mask = await sharp({ create: { width: 6, height: 4, channels: 4, background: "white" } })
            .composite([{ input: await solid(2, 2, "white"), left: 2, top: 1, blend: "dest-out" }])
            .png()
            .toBuffer();
        const normalized = await sharp(source).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
        const roles = { sourceInputIndex: 1, nativeInputIndex: 2, baselineInputIndex: 3, maskInputIndex: 4, source: { sha256: digest(source), byteLength: source.length, width: 6, height: 4, normalizedSha256: digest(normalized) } };
        const scene: SceneProtectionSnapshot = {
            version: "scene-edit-protection.v1",
            sourceAssetId: "source",
            sourceSize: { width: 6, height: 4 },
            sourceDigest: digest(source),
            maskSize: { width: 6, height: 4 },
            maskDigest: digest(mask),
            targetRegion: { x: 2, y: 1, width: 2, height: 2 },
            semantics: ["replace selected background"],
            selectionSource: "user_selection",
            maskSemantics: "alpha_zero_edit",
            method: "source_pixels_copy",
        };
        if (scope === "local_edit") {
            const baseline = await (await import("../image-processing/scene-protection")).compositeSceneEditBytes(source, native, mask, scene);
            return execute(
                [
                    { bytes: ai, assetId: "ai" },
                    { bytes: source, assetId: "source" },
                    { bytes: native, assetId: "native" },
                    { bytes: baseline.bytes, assetId: "baseline" },
                    { bytes: mask, assetId: "mask" },
                ],
                { ...common, ...roles, scope, native: descriptor(native, 3, 2), baseline: descriptor(baseline.bytes, 6, 4), protection: { version: "scene-enhancement.v1", normalization: "srgb-upright-v1", scene }, originalProof: baseline.evidence },
            );
        }
        const product: ProductEnhancementDescriptor = {
            version: "product-enhancement.v2",
            normalization: "srgb-upright-v1",
            maskSha256: digest(mask),
            product: {
                compilerVersion: "strict-product.v1",
                state: "ready",
                productAnchorId: "product-anchor",
                sourceAssetId: "source",
                sourceSize: { width: 6, height: 4 },
                productCore: [{ x: 0, y: 0, width: 1, height: 1 }],
                fusionHalo: [],
                editableBackground: [{ x: 2, y: 1, width: 2, height: 2 }],
            },
        };
        const baseline = await (await import("../image-processing/product-protection")).compositeProductEnhancement(source, native, { ...product, maskDataUrl: "data:image/png;base64," + mask.toString("base64") }, 1_000_000, "native");
        return execute(
            [
                { bytes: ai, assetId: "ai" },
                { bytes: source, assetId: "source" },
                { bytes: native, assetId: "native" },
                { bytes: baseline.bytes, assetId: "baseline" },
                { bytes: mask, assetId: "mask" },
            ],
            { ...common, ...roles, scope, native: descriptor(native, 6, 4), baseline: descriptor(baseline.bytes, 6, 4), protection: product, originalProof: baseline.evidence },
        );
    }
    async function post<T extends { manifest: { jobId: string } }>(input: T) {
        return route.POST(
            new Request("http://fixture.local/api/maintenance/image-processing/" + input.manifest.jobId + "/complete", {
                method: "POST",
                headers: { authorization: "Bearer " + workerToken, "content-type": "application/json" },
                body: JSON.stringify(input),
            }),
            { params: Promise.resolve({ id: input.manifest.jobId }) },
        );
    }

    it.each(["full_image", "product_background", "local_edit"] as const)("accepts actual %s kernel output up to the real missing-job boundary", async (scope) => {
        const input = await fixture(scope);
        const response = await post(input);
        expect(response.status).toBe(404);
        expect(await tasks.withGenerationTaskFileRead(async (records) => records)).toEqual([]);
    });

    it.each(["results", "unknown_manifest", "native_image", "layer", "global_protection"] as const)("rejects %s mixing before any service mutation", async (field) => {
        const input = await fixture("full_image");
        const manifests = {
            results: { ...input.manifest, results: [] },
            unknown_manifest: { ...input.manifest, unknown: true },
            native_image: { ...input.manifest, sourceIdentities: input.manifest.sourceIdentities.map((source) => ({ ...source, nativeImage: { format: "png", hasAlpha: false } })) },
            layer: { ...input.manifest, artifacts: input.manifest.artifacts.map((artifact) => ({ ...artifact, layerKind: "element" })) },
            global_protection: { ...input.manifest, enhancement: { ...input.manifest.enhancement, protection: { version: "product-enhancement.v2" } } },
        };
        const response = await post({ ...input, manifest: manifests[field] });
        expect(response.status).toBe(400);
        expect(await tasks.withGenerationTaskFileRead(async (records) => records)).toEqual([]);
    });

    it.each(["product_background", "local_edit"] as const)("rejects %s proof under the other protected scope", async (scope) => {
        const input = await fixture(scope);
        const swapped = { product_background: "local_edit", local_edit: "product_background" };
        const response = await post({ ...input, manifest: { ...input.manifest, enhancement: { ...input.manifest.enhancement, scope: swapped[scope] } } });
        expect(response.status).toBe(400);
        expect(await tasks.withGenerationTaskFileRead(async (records) => records)).toEqual([]);
    });
});
