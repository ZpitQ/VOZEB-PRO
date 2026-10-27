import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import type { EcommerceEnhancementDelivery } from "./image-enhancement-delivery";
import type { ImageTask } from "./image-task-store";

const storage = vi.hoisted(() => ({ rejectedBytes: new Set<string>() }));
const mediaRegistry = vi.hoisted(() => ({ register: vi.fn(), get: vi.fn<(storageKey: string) => Promise<null>>(async () => null), delete: vi.fn<(storageKeys: string[]) => Promise<void>>(async () => undefined) }));
const worker = vi.hoisted(() => ({ inspectEnhancementWorker: vi.fn(), createEnhancementTaskClient: vi.fn() }));

vi.mock("@/lib/server/image-enhancement-worker-client", () => worker);

vi.mock("@/app/api/image-tasks/image-task-support", () => ({
    directRemoteImageResult: vi.fn(),
    imageReferenceToDataUrl: async (reference: { dataUrl: string; serverUrl?: string }) => {
        const url = reference.serverUrl || reference.dataUrl;
        if (!url.startsWith("/api/generation-log-assets/")) return url;
        const { localAssetUrlToPath } = await import("./generation-log-repository");
        return `data:image/png;base64,${(await readFile(localAssetUrlToPath(url))).toString("base64")}`;
    },
    inlineRemoteImageResult: async (dataUrl: string) => ({ dataUrl }),
    resolveProxiedMediaSource: () => ({}),
}));
vi.mock("@/lib/server/generation-media-authorization", () => ({ generationMediaProxyHeaders: vi.fn() }));
vi.mock("@/lib/server/object-storage-service", () => ({
    deleteExternalMediaObject: vi.fn(),
    persistExternalMediaIfEnabled: async ({ bytes }: { bytes: Buffer }) => {
        if (storage.rejectedBytes.has(bytes.toString("base64"))) throw new Error("private-storage-detail");
        return null;
    },
}));
vi.mock("@/lib/server/local-media-registry", () => ({ registerLocalMediaAsset: mediaRegistry.register, getLocalMediaRegistration: mediaRegistry.get, deleteLocalMediaRegistrations: mediaRegistry.delete }));
vi.mock("@/lib/server/database", () => ({ getDatabaseProvider: () => "file", isPostgresDatabaseEnabled: () => false }));

describe("image task result persistence", () => {
    let directory: string;
    let prepare: typeof import("./image-task-result-service").prepareImageTaskResults;
    let assetPath: typeof import("./generation-log-repository").localAssetUrlToPath;

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-image-result-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        ({ prepareImageTaskResults: prepare } = await import("./image-task-result-service"));
        ({ localAssetUrlToPath: assetPath } = await import("./generation-log-repository"));
    });

    afterAll(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    beforeEach(() => {
        storage.rejectedBytes.clear();
        mediaRegistry.register.mockClear();
        mediaRegistry.get.mockClear();
        mediaRegistry.delete.mockClear();
    });

    afterEach(() => {
        expect(worker.inspectEnhancementWorker).not.toHaveBeenCalled();
        expect(worker.createEnhancementTaskClient).not.toHaveBeenCalled();
    });

    const savedFiles = async () => {
        const paths = await readdir(directory, { recursive: true });
        const files = await Promise.all(paths.map(async (file) => ((await stat(join(directory, file))).isFile() ? file : null)));
        return files.filter((file): file is string => file !== null).sort();
    };

    it.each([1, 2, 3])("durably retains unreadable canvas slot %s without renumbering or deleting good files", async (missingIndex) => {
        const { createImageTask, getImageTask, updateImageTask } = await import("./image-task-store");
        const task = await createImageTask(canvasTask());
        const source = await imageBytes(6, 4);
        const inputs = Array.from({ length: 3 }, (_, index) => ({ dataUrl: index + 1 === missingIndex ? "https://fixture.invalid/unreadable.png" : dataUrl(source) }));
        const prepared = await prepare(task, { dataUrl: inputs[0].dataUrl, results: inputs }, "http://fixture.local", "fixture");
        expect(prepared).toMatchObject({ results: expect.any(Array), batchEvidence: expect.any(Array) });
        expect(prepared.results).toHaveLength(2);
        expect(prepared.batchEvidence?.map((slot) => slot.resultId)).toEqual([1, 2, 3].map((index) => `${task.id}:${index}`));
        expect(prepared.batchEvidence?.[missingIndex - 1]).toMatchObject({ resultIndex: missingIndex, nativeStatus: "unavailable", storageStatus: "unavailable", failureStage: "read", failureReason: "上游原生图片无法读取" });
        expect(prepared.batchEvidence?.[missingIndex - 1]).not.toHaveProperty("nativeSize");
        expect(prepared.results.map((media) => media.resultId)).toEqual([1, 2, 3].filter((index) => index !== missingIndex).map((index) => `${task.id}:${index}`));
        for (const media of prepared.results) {
            expect(media).toHaveProperty("enhancementSkip", { status: "skipped", reason: "disabled" });
            expect(media).not.toHaveProperty("nativeSource");
            expect(media).not.toHaveProperty("enhancementId");
        }
        for (const media of prepared.results) expect((await readFile(assetPath(media.serverUrl!))).equals(source)).toBe(true);
        await updateImageTask(task.id, { result: { ...prepared.results[0], ...prepared } });
        expect((await getImageTask(task.id))?.result).toEqual({ ...prepared.results[0], ...prepared });
        expect(await readFile(join(directory, "generation-tasks.json"), "utf8")).toContain('"failureStage": "read"');
    });

    it.each([6, 8])("retains actually decoded %s x 4 native geometry after storage rejection", async (width) => {
        const good = await imageBytes(6, 4);
        const rejected = await sharp({ create: { width, height: 4, channels: 3, background: "red" } })
            .png()
            .toBuffer();
        storage.rejectedBytes.add(rejected.toString("base64"));
        const prepared = await prepare(canvasTask(), { dataUrl: dataUrl(good), results: [{ dataUrl: dataUrl(good) }, { dataUrl: dataUrl(rejected) }] }, "http://fixture.local", "fixture");
        expect(prepared).toMatchObject({
            results: [expect.objectContaining({ width: 6, height: 4 })],
            batchEvidence: [
                expect.objectContaining({ storageStatus: "stored" }),
                expect.objectContaining({ resultId: "custom-gemini-image:2", resultIndex: 2, nativeStatus: "readable", nativeSize: { width, height: 4 }, storageStatus: "unavailable", failureStage: "store", failureReason: "原生图片保存失败" }),
            ],
        });
        expect(prepared.batchEvidence?.[1]).not.toHaveProperty("storedSize");
        expect(JSON.stringify(prepared)).not.toContain("private-storage-detail");
        expect((await readFile(assetPath(prepared.results[0].serverUrl!))).equals(good)).toBe(true);
    });

    it("retains a decode failure separately from an unreadable native and preserves the good media", async () => {
        const good = await imageBytes(6, 4);
        const prepared = await prepare(canvasTask(), { dataUrl: dataUrl(good), results: [{ dataUrl: dataUrl(good) }, { dataUrl: "data:image/png;base64,AA==" }] }, "http://fixture.local", "fixture");
        expect(prepared).toMatchObject({
            results: [expect.objectContaining({ width: 6, height: 4 })],
            batchEvidence: [expect.any(Object), expect.objectContaining({ nativeStatus: "unavailable", storageStatus: "unavailable", failureStage: "decode", failureReason: "上游原生图片无法解码" })],
        });
        expect(prepared.batchEvidence?.[1]).not.toHaveProperty("nativeSize");
    });

    it("returns the complete unavailable canvas batch even when no media can be saved", async () => {
        const prepared = await prepare(canvasTask(), { dataUrl: "https://fixture.invalid/one.png", results: [{ dataUrl: "https://fixture.invalid/one.png" }, { dataUrl: "https://fixture.invalid/two.png" }] }, "http://fixture.local", "fixture");
        expect(prepared).toMatchObject({
            results: [],
            batchEvidence: [
                { resultId: "custom-gemini-image:1", resultIndex: 1, nativeStatus: "unavailable", storageStatus: "unavailable" },
                { resultId: "custom-gemini-image:2", resultIndex: 2, nativeStatus: "unavailable", storageStatus: "unavailable" },
            ],
        });
    });

    it.each([false, true])("gives a v2 canvas its independently saved native identity (enabled=%s)", async (enabled) => {
        const task = canvasTask();
        task.config.quality = "4k";
        task.enhancementPolicy = { revision: "frozen-v2", enabled, connection: null };
        task.enhancementDelivery = { version: "ecommerce-delivery.v2", scope: "full_image", canvas: structuredClone(task.ecommerceExecution!.canvas!) };
        const native = await imageBytes(6, 4);
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture");
        expect(result.nativeSource).toEqual({ url: result.serverUrl, sha256: digest(native), width: 6, height: 4, byteLength: native.length, format: "png", hasAlpha: false, provenance: "provider_native" });
        expect(result.enhancementId).toBe(`enhancement:${task.id}:1`);
        expect(result.canvasEvidence).toMatchObject({ nativeUrl: result.serverUrl, nativeSize: { width: 6, height: 4 }, storedSize: { width: 6, height: 4 }, normalization: "none" });
        if (enabled) expect(result).not.toHaveProperty("enhancementSkip");
        else expect(result.enhancementSkip).toEqual({ status: "skipped", reason: "disabled" });
        expect(await readFile(assetPath(result.serverUrl!))).toEqual(native);
    });

    it("keeps native canvas geometry independently failing the v2 requested exact size", async () => {
        const { evaluateEcommerceCanvas } = await import("./ecommerce-quality-check");
        const task = canvasTask();
        task.config.quality = "4k";
        task.enhancementPolicy = { revision: "frozen-v2", enabled: true, connection: null };
        task.ecommerceExecution!.canvas!.size = { width: 12, height: 8 };
        task.enhancementDelivery = { version: "ecommerce-delivery.v2", scope: "full_image", canvas: structuredClone(task.ecommerceExecution!.canvas!) };
        const native = await imageBytes(6, 4);
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture");
        expect(result.nativeSource).toMatchObject({ width: 6, height: 4, sha256: digest(native) });
        expect(result.canvasEvidence).toMatchObject({ nativeSize: { width: 6, height: 4 }, storedSize: { width: 6, height: 4 } });
        expect(evaluateEcommerceCanvas(task.ecommerceExecution!.canvas!, result.canvasEvidence!.nativeSize, result.canvasEvidence!.storedSize)).toMatchObject({ nativeMatches: false, storedMatches: false, hardFailures: ["canvas_geometry"] });
        expect(await readFile(assetPath(result.serverUrl!))).toEqual(native);
    });

    it("keeps an unrequested v2 canvas skipped without signing an enhancement source", async () => {
        const task = canvasTask();
        task.config.quality = "2k";
        task.enhancementPolicy = { revision: "frozen-v2", enabled: true, connection: null };
        task.enhancementDelivery = { version: "ecommerce-delivery.v2", scope: "full_image", canvas: structuredClone(task.ecommerceExecution!.canvas!) };
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(await imageBytes(6, 4)) }, "http://fixture.local", "fixture");
        expect(result.enhancementSkip).toEqual({ status: "skipped", reason: "not_requested" });
        expect(result).not.toHaveProperty("nativeSource");
        expect(result).not.toHaveProperty("enhancementId");
    });

    it.each((["read", "geometry", "store"] as const).flatMap((failure) => [0, 1].map((index) => ({ failure, index }))))("retains the valid product slot and its original identity after slot $index fails at $failure", async ({ failure, index }) => {
        const { task, native } = await productDeliveryTask(true);
        const bad = await sharp({ create: { width: failure === "geometry" ? 3 : 6, height: failure === "geometry" ? 2 : 4, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        if (failure === "store") storage.rejectedBytes.add(bad.toString("base64"));
        const inputs = [{ dataUrl: dataUrl(native) }, { dataUrl: dataUrl(native) }];
        inputs[index] = { dataUrl: failure === "read" ? "https://fixture.invalid/unreadable.png" : dataUrl(bad) };
        const goodIndex = 1 - index;
        const prepared = await prepare(task, { dataUrl: inputs[0].dataUrl, results: inputs }, "http://fixture.local", "fixture");
        expect(prepared.results).toHaveLength(1);
        const good = prepared.results[0];
        expect(good.resultId).toBe(`${task.id}:${goodIndex + 1}`);
        expect(good.enhancementId).toBe(`enhancement:${task.id}:${goodIndex + 1}`);
        expect(prepared.batchEvidence?.map((slot) => slot.resultId)).toEqual([`${task.id}:1`, `${task.id}:2`]);
        expect(prepared.batchEvidence?.[index]).toMatchObject({ resultIndex: index + 1, storageStatus: "unavailable", failureStage: failure === "geometry" ? "validation" : failure });
        expect(prepared.batchEvidence?.[goodIndex]).toMatchObject({ resultIndex: goodIndex + 1, nativeStatus: "readable", storageStatus: "stored", storedUrl: good.serverUrl });
        expect(await readFile(assetPath(good.productEnhancementEvidence!.nativeUrl))).toEqual(native);
        expect(digest(await readFile(assetPath(good.serverUrl!)))).toBe(good.productEnhancementEvidence!.baselineSha256);
    });

    it.each([false, true])("persists the qualified product baseline independently from untouched raw native bytes (canvas=%s)", async (withCanvas) => {
        const { task, source, native, mask, delivery } = await productDeliveryTask(withCanvas);
        const before = structuredClone(task);
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture");
        expect(result).toMatchObject({ width: 6, height: 4, mimeType: "image/png", enhancementId: `enhancement:${task.id}:1` });
        expect(result).not.toHaveProperty("enhancementSkip");
        const proof = result.productEnhancementEvidence!;
        expect(proof).toMatchObject({
            version: "product-baseline.v2",
            nativeSha256: digest(native),
            baselineUrl: result.serverUrl,
            composition: {
                version: "product-enhancement.v2",
                normalization: "srgb-upright-v1",
                sourceAssetId: "scene",
                productAnchorId: "product",
                sourceSha256: digest(source),
                maskSha256: digest(mask),
                aiSha256: digest(native),
                sourceSize: { width: 6, height: 4 },
                aiSize: { width: 6, height: 4 },
                allowedPixels: 4,
                protectedPixels: 20,
                protectedChangedPixels: 0,
            },
        });
        expect(proof.nativeUrl).not.toBe(result.serverUrl);
        const [baseBytes, rawBytes] = await Promise.all([readFile(assetPath(result.serverUrl!)), readFile(assetPath(proof.nativeUrl))]);
        expect(rawBytes).toEqual(native);
        expect(proof.baselineSha256).toBe(digest(baseBytes));
        expect(result.nativeSource).toEqual({ url: proof.nativeUrl, sha256: digest(native), byteLength: native.length, width: 6, height: 4, format: "png", hasAlpha: false, provenance: "provider_native" });
        expect(result.bytes).toBe(baseBytes.length);
        expect(proof.composition.compositeSha256).toBe(digest(baseBytes));
        const [original, composite] = await Promise.all([sharp(source).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer(), sharp(baseBytes).ensureAlpha().raw().toBuffer()]);
        for (let y = 0; y < 4; y++)
            for (let x = 0; x < 6; x++) {
                const offset = (y * 6 + x) * 4;
                expect(composite.subarray(offset, offset + 4)).toEqual(x >= 4 && y < 2 ? Buffer.from([255, 0, 0, 255]) : original.subarray(offset, offset + 4));
            }
        if (withCanvas) expect(result.canvasEvidence).toMatchObject({ nativeUrl: proof.nativeUrl, nativeSize: { width: 6, height: 4 }, storedSize: { width: 6, height: 4 }, normalization: "none" });
        expect(task).toEqual(before);
        expect(delivery.baseline.sha256).toBe(digest(source));
    });

    it("restores protected base pixels for an unrequested product delivery without resizing the composite", async () => {
        const { task, native } = await productDeliveryTask();
        task.config.quality = "1k";
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture");
        expect(result).toMatchObject({ width: 6, height: 4, enhancementSkip: { status: "skipped", reason: "not_requested" }, productEnhancementEvidence: { composition: { protectedChangedPixels: 0 } } });
        expect(result).not.toHaveProperty("nativeSource");
        expect(result).not.toHaveProperty("enhancementId");
    });

    it("keeps an old product protection task skipped without assigning the v2 baseline contract", async () => {
        const { task, native } = await productDeliveryTask();
        delete task.enhancementDelivery;
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture");
        expect(result.enhancementSkip).toEqual({ status: "skipped", reason: "protected_contract" });
        expect(result).not.toHaveProperty("productEnhancementEvidence");
        expect(result).not.toHaveProperty("nativeSource");
        expect(result).not.toHaveProperty("enhancementId");
        expect(await readFile(assetPath(result.serverUrl!))).toEqual(native);
    });

    it.each([
        { width: 3, height: 2 },
        { width: 12, height: 8 },
        { width: 6, height: 5 },
    ])("rejects product raw native geometry $width x $height before any persistence", async ({ width, height }) => {
        const { task } = await productDeliveryTask(true);
        const before = await savedFiles();
        const prepared = await prepare(task, { dataUrl: dataUrl(await imageBytes(width, height)) }, "http://fixture.local", "fixture");
        expect(prepared).toMatchObject({ results: [], batchEvidence: [expect.objectContaining({ nativeStatus: "readable", nativeSize: { width, height }, storageStatus: "unavailable", failureStage: "validation" })] });
        expect(mediaRegistry.register).not.toHaveBeenCalled();
        expect(await savedFiles()).toEqual(before);
    });

    it.each(["source", "source-digest", "source-length", "normalized-digest", "source-dimensions", "mask"] as const)("rejects a changed frozen product %s before persistence", async (changed) => {
        const { task, native, delivery } = await productDeliveryTask();
        if (changed === "source") delivery.baseline.url = dataUrl(native);
        if (changed === "source-digest") delivery.baseline.sha256 = "0".repeat(64);
        if (changed === "source-length") delivery.baseline.byteLength++;
        if (changed === "normalized-digest") delivery.baseline.normalizedSha256 = "0".repeat(64);
        if (changed === "source-dimensions") delivery.baseline.width++;
        if (changed === "mask") delivery.protection.maskDataUrl = dataUrl(native);
        const before = await savedFiles();
        await expect(prepare(task, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture")).rejects.toThrow();
        expect(mediaRegistry.register).not.toHaveBeenCalled();
        expect(await savedFiles()).toEqual(before);
    });

    it("durably retains the immutable product snapshot and independent base/native evidence", async () => {
        const { createImageTask, getImageTask, updateImageTask } = await import("./image-task-store");
        const { task, native } = await productDeliveryTask(true);
        const created = await createImageTask(task);
        const prepared = await prepare(created, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture");
        expect(prepared.results[0].productEnhancementEvidence?.version).toBe("product-baseline.v2");
        await updateImageTask(created.id, { result: { ...prepared.results[0], ...prepared } });
        const restored = await getImageTask(created.id);
        expect(restored?.enhancementDelivery).toEqual(task.enhancementDelivery);
        expect(restored?.result?.productEnhancementEvidence).toEqual(prepared.results[0].productEnhancementEvidence);
        expect(restored?.result?.nativeSource).toEqual(prepared.results[0].nativeSource);
    });

    it("cleans new product outputs after storage failure while preserving the already stored source", async () => {
        const { normalizeAssets } = await import("./generation-log-repository");
        const { compositeProductEnhancement } = await import("./image-enhancement-product-protection");
        const { task, source, native, delivery } = await productDeliveryTask();
        const [sourceAsset] = await normalizeAssets([{ type: "image", url: dataUrl(source) }], { ownerUserId: task.userId, source: task.source, taskId: "original-product", originalName: "original-product.png" });
        delivery.baseline.url = sourceAsset.serverUrl!;
        task.references[0].dataUrl = sourceAsset.serverUrl!;
        const composite = await compositeProductEnhancement(source, native, delivery.protection, 24);
        storage.rejectedBytes.add(composite.bytes.toString("base64"));
        mediaRegistry.register.mockClear();
        const before = await savedFiles();
        await expect(prepare(task, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture")).rejects.toThrow();
        expect(mediaRegistry.register).toHaveBeenCalled();
        expect(await savedFiles()).toEqual(before);
        expect(await readFile(assetPath(sourceAsset.serverUrl!))).toEqual(source);
    });

    it("deletes discarded product delivery outputs while retaining their frozen source", async () => {
        const { deletePreparedImageTaskResults } = await import("./image-task-result-service");
        const { normalizeAssets } = await import("./generation-log-repository");
        const { task, source, native, delivery } = await productDeliveryTask();
        const [sourceAsset] = await normalizeAssets([{ type: "image", url: dataUrl(source) }], { ownerUserId: task.userId, source: task.source, taskId: "original-product", originalName: "original-product.png" });
        delivery.baseline.url = sourceAsset.serverUrl!;
        task.references[0].dataUrl = sourceAsset.serverUrl!;
        const { results } = await prepare(task, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture");
        const proof = results[0].productEnhancementEvidence!;
        expect(proof).toBeDefined();
        await deletePreparedImageTaskResults(results);
        await expect(readFile(assetPath(results[0].serverUrl!))).rejects.toThrow();
        await expect(readFile(assetPath(proof.nativeUrl))).rejects.toThrow();
        expect(await readFile(assetPath(sourceAsset.serverUrl!))).toEqual(source);
    });

    it.each([
        { size: "16:9", quality: "4k", width: 4096, height: 2304 },
        { size: "auto", quality: "4k", width: 2304, height: 4096 },
        { size: "9:16", quality: "2k", width: 1152, height: 2048 },
        { size: "16:9", quality: "4k", width: 1024, height: 576 },
    ])("preserves native $width x $height bytes for custom Gemini $quality $size", async ({ size, quality, width, height }) => {
        const bytes = await imageBytes(width, height);
        const {
            results: [result],
        } = await prepare(imageTask({ size, quality }), { dataUrl: dataUrl(bytes) }, "http://fixture.local", "fixture");
        const persisted = await readFile(assetPath(result.serverUrl!));

        expect(result).toMatchObject({ width, height, bytes: bytes.length, mimeType: "image/png" });
        expect(persisted.equals(bytes)).toBe(true);
        expect(await sharp(persisted).metadata()).toMatchObject({ width, height });
    });

    it.each(["2k", "4k"])("keeps the %s original variant contract for smaller custom dimensions", async (quality) => {
        const bytes = await imageBytes(2048, 1152);
        const task = imageTask({ size: "768x512", quality });
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(bytes) }, "http://fixture.local", "fixture");
        const persisted = await readFile(assetPath(result.serverUrl!));

        expect(task.config.size).toBe("768x512");
        const dimensions = quality === "4k" ? { width: 2048, height: 1152 } : { width: 768, height: 432 };
        expect(result).toMatchObject(dimensions);
        expect(await sharp(persisted).metadata()).toMatchObject(dimensions);
        if (quality === "4k") expect(persisted.equals(bytes)).toBe(true);
    });

    it.each([false, true])("stores independent mask, untouched native file and protected composite as separate internal evidence (v4 auxiliary=%s)", async (withStyle) => {
        const { buildSceneEditProtection } = await import("./ecommerce-product-regions");
        const source = await imageBytes(6, 4);
        const native = await sharp({ create: { width: 6, height: 4, channels: 3, background: "red" } })
            .png()
            .toBuffer();
        const task = imageTask({ size: "300x200", quality: "4k" });
        task.enhancementPolicy = { revision: "frozen-enabled", enabled: true, connection: null };
        task.kind = "edit";
        task.references = [{ id: "scene", dataUrl: dataUrl(source), ecommerceRole: "scene" }, ...(withStyle ? [{ id: "style", dataUrl: dataUrl(source), ecommerceRole: "scene" as const }] : [])];
        if (withStyle)
            task.ecommerceExecution = {
                state: "ready",
                compilerVersion: "ecommerce-openai-image-2.5.v4",
                providerProfileId: "gpt-image-2.5-flare",
                prompt: "edit",
                referenceRoles: [
                    { assetId: "scene", role: "scene" },
                    { assetId: "style", role: "scene" },
                ],
                referenceMapping: [
                    { assetId: "scene", userAlias: "图片2", providerIndex: 0, purposes: ["edit_target"] },
                    { assetId: "style", userAlias: "图片1", providerIndex: 1, purposes: ["style"] },
                ],
                parameters: { variant: "gpt-image-2.5-flare" },
                modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" },
            };
        task.sceneProtection = await buildSceneEditProtection(source, "scene", { x: 2, y: 1, width: 2, height: 2 }, ["vase and shadow"], "user_selection");
        task.mask = task.sceneProtection.mask;
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture");
        expect(result).toMatchObject({ width: 6, height: 4, sceneProtectionEvidence: { compositeOutsideChangedPixels: 0, nativeOutsideChangedPixels: 20, method: "source_pixels_copy" } });
        expect(result).toHaveProperty("resultId", `${task.id}:1`);
        expect(result).toHaveProperty("enhancementSkip", { status: "skipped", reason: "protected_contract" });
        expect(result).not.toHaveProperty("nativeSource");
        expect(result).not.toHaveProperty("enhancementId");
        const evidence = result.sceneProtectionEvidence!;
        expect((await readFile(assetPath(evidence.nativeUrl!))).equals(native)).toBe(true);
        expect(await sharp(await readFile(assetPath(evidence.maskUrl!))).metadata()).toMatchObject({ width: 6, height: 4 });
        expect(evidence.compositeUrl).toBe(result.serverUrl);
        expect(evidence.nativeUrl).not.toBe(result.serverUrl);
        const { createImageTask, getImageTask, updateImageTask } = await import("./image-task-store");
        const created = await createImageTask(task);
        await updateImageTask(created.id, { result: { ...result, results: [result] } });
        const restored = await getImageTask(created.id);
        expect(restored?.sceneProtection).toEqual(task.sceneProtection);
        expect(restored?.result?.sceneProtectionEvidence).toEqual(evidence);
        expect(restored?.result).toHaveProperty("enhancementSkip", { status: "skipped", reason: "protected_contract" });
    });

    it("does not turn a partially unreadable local scene batch into success", async () => {
        const { buildSceneEditProtection } = await import("./ecommerce-product-regions");
        const source = await imageBytes(6, 4);
        const task = imageTask({ size: "6x4" });
        task.kind = "edit";
        task.references = [{ id: "scene", dataUrl: dataUrl(source) }];
        task.sceneProtection = await buildSceneEditProtection(source, "scene", { x: 2, y: 1, width: 2, height: 2 }, ["vase"], "user_selection");
        task.mask = task.sceneProtection.mask;
        await expect(prepare(task, { dataUrl: dataUrl(source), results: [{ dataUrl: dataUrl(source) }, { dataUrl: "https://fixture.invalid/unreadable.png" }] }, "http://fixture.local", "fixture")).rejects.toThrow("原生图片");
    });

    it("fails a mixed valid-ratio and wrong-ratio local scene batch before registering or writing any file", async () => {
        const { buildSceneEditProtection } = await import("./ecommerce-product-regions");
        const source = await imageBytes(6, 4);
        const good = await imageBytes(3, 2);
        const wrongRatio = await imageBytes(5, 5);
        const task = imageTask({ size: "6x4" });
        task.kind = "edit";
        task.references = [{ id: "scene", dataUrl: dataUrl(source) }];
        task.sceneProtection = await buildSceneEditProtection(source, "scene", { x: 2, y: 1, width: 2, height: 2 }, ["vase"], "user_selection");
        task.mask = task.sceneProtection.mask;
        const before = await savedFiles();
        await expect(prepare(task, { dataUrl: dataUrl(good), results: [{ dataUrl: dataUrl(good) }, { dataUrl: dataUrl(wrongRatio) }] }, "http://fixture.local", "fixture")).rejects.toThrow("原生画幅比例");
        expect(mediaRegistry.register).not.toHaveBeenCalled();
        expect(mediaRegistry.delete).not.toHaveBeenCalled();
        expect(await savedFiles()).toEqual(before);
        expect(task.result).toBeUndefined();
    });

    it("removes the saved mask and native when protected composite storage fails without deleting older files", async () => {
        const { buildSceneEditProtection, compositeSceneEdit } = await import("./ecommerce-product-regions");
        const source = await imageBytes(6, 4);
        const native = await sharp({ create: { width: 3, height: 2, channels: 4, background: "red" } })
            .png()
            .toBuffer();
        const task = imageTask({ size: "6x4" });
        task.kind = "edit";
        task.references = [{ id: "scene", dataUrl: dataUrl(source) }];
        task.sceneProtection = await buildSceneEditProtection(source, "scene", { x: 2, y: 1, width: 2, height: 2 }, ["vase"], "user_selection");
        task.mask = task.sceneProtection.mask;
        const composite = await compositeSceneEdit(source, native, task.sceneProtection);
        storage.rejectedBytes.add(composite.bytes.toString("base64"));
        const before = await savedFiles();
        await expect(prepare(task, { dataUrl: dataUrl(native) }, "http://fixture.local", "fixture")).rejects.toThrow();
        expect(mediaRegistry.register).toHaveBeenCalledTimes(2);
        expect(mediaRegistry.register.mock.calls.map(([registration]) => registration.originalName)).toEqual(["scene-edit-mask.png", "scene-edit-native-1.png"]);
        const registered = mediaRegistry.register.mock.calls.map(([registration]) => registration.storageKey).sort();
        expect(mediaRegistry.delete).toHaveBeenCalledTimes(2);
        expect(mediaRegistry.delete.mock.calls.flatMap(([keys]) => keys).sort()).toEqual(registered);
        expect(await savedFiles()).toEqual(before);
        expect(task.result).toBeUndefined();
    });

    it.each(["ecommerce-nano-banana-2.v1", "ecommerce-nano-banana-2.v3"] as const)("retains each ecommerce native file before target normalization and %s task round-trip", async (compilerVersion) => {
        const task = imageTask({ size: "384x216" });
        task.ecommerceExecution = {
            state: "ready",
            compilerVersion,
            ...(compilerVersion === "ecommerce-nano-banana-2.v3"
                ? {
                      photography: {
                          materials: [{ objectId: "cabinet", textureDirection: "纵向木纹", textureScale: "细木纹", roughness: "哑光", gloss: "低光泽" }],
                          lighting: { keyLight: "柔光", fillLight: "弱补光", whiteBalance: "中性", contactShadow: "接触阴影" },
                          composition: { focalSubject: "边柜", depth: "纵深", negativeSpace: "留白" },
                      },
                  }
                : {}),
            providerProfileId: "nano-banana-2",
            prompt: "preserve",
            referenceRoles: [{ assetId: "scene", role: "scene" }],
            parameters: { variant: "nano-banana-2", size: "384x216" },
            canvas: { mode: "exact", size: { width: 384, height: 216 }, source: "user_text", allowReframe: false },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "gemini" },
        };
        task.ecommerceCanvasRequest = { size: "384x216" };
        task.config.quality = "4k";
        task.enhancementPolicy = { revision: "frozen-enabled", enabled: true, connection: null };
        const square = await imageBytes(288, 288);
        const landscape = await imageBytes(384, 216);
        const remoteUrl = "https://fixture.invalid/shared-result.png";
        const { results, batchEvidence } = await prepare(
            task,
            {
                dataUrl: dataUrl(square),
                results: [
                    { dataUrl: dataUrl(square), remoteUrl },
                    { dataUrl: dataUrl(landscape), remoteUrl },
                ],
            },
            "http://fixture.local",
            "fixture",
        );
        expect(results).toHaveLength(2);
        for (const media of results) {
            expect(media).toHaveProperty("enhancementSkip", { status: "skipped", reason: "protected_contract" });
            expect(media).not.toHaveProperty("nativeSource");
            expect(media).not.toHaveProperty("enhancementId");
        }
        expect(batchEvidence?.map((slot) => ({ resultId: slot.resultId, resultIndex: slot.resultIndex, nativeStatus: slot.nativeStatus, storageStatus: slot.storageStatus }))).toEqual(
            [1, 2].map((resultIndex) => ({ resultId: `${task.id}:${resultIndex}`, resultIndex, nativeStatus: "readable", storageStatus: "stored" })),
        );
        expect(results[0]).toMatchObject({ width: 288, height: 288, canvasEvidence: { nativeSize: { width: 288, height: 288 }, storedSize: { width: 288, height: 288 }, requestedSize: { width: 384, height: 216 }, normalization: "none" } });
        expect(results[1]).toMatchObject({ canvasEvidence: { nativeSize: { width: 384, height: 216 }, storedSize: { width: 384, height: 216 } } });
        expect((await readFile(assetPath(results[0].canvasEvidence!.nativeUrl))).equals(square)).toBe(true);
        expect(JSON.parse(JSON.stringify({ ...task, result: { ...results[0], results } })).result.results).toEqual(results);
        const { createImageTask, getImageTask, updateImageTask } = await import("./image-task-store");
        const created = await createImageTask(task);
        await updateImageTask(created.id, { result: { ...results[0], results, batchEvidence } });
        const restored = await getImageTask(created.id);
        expect(restored?.ecommerceExecution?.canvas).toEqual(task.ecommerceExecution.canvas);
        expect(restored?.ecommerceExecution?.photography).toEqual(task.ecommerceExecution.photography);
        expect(restored?.result?.results).toEqual(results);
        expect(restored?.result?.batchEvidence).toEqual(batchEvidence);
        expect(await readFile(join(directory, "generation-tasks.json"), "utf8")).toContain("nativeSize");
    });

    it.each([
        { model: "other-image-model", protocol: "custom" as const },
        { model: "gemini-3.1-flash-image", protocol: "openai" as const },
    ])("keeps non-4K normalization with a stable result identity for $protocol $model", async ({ model, protocol }) => {
        const task = imageTask({ model, size: "1:1", quality: "1k", advancedConfig: { ...emptyAdvancedConfig(), protocol } });
        task.enhancementPolicy = { revision: "frozen-enabled", enabled: true, connection: null };
        const prepared = await prepare(task, { dataUrl: dataUrl(await imageBytes(1280, 1280)) }, "http://fixture.local", "fixture");
        const [result] = prepared.results;
        expect(prepared).not.toHaveProperty("batchEvidence");
        expect(result.resultId).toBe(`${task.id}:1`);
        expect(result).toMatchObject({ width: 1024, height: 1024 });
        expect(result).toHaveProperty("enhancementSkip", { status: "skipped", reason: "not_requested" });
        expect(result).not.toHaveProperty("nativeSource");
        expect(result).not.toHaveProperty("enhancementId");
    });

    it("uses the frozen disabled policy for a successful result without creating enhancement work", async () => {
        const task = imageTask({ model: "other-image-model", size: "1:1", quality: "1k" });
        task.enhancementPolicy = { revision: "frozen-disabled", enabled: false, connection: null };
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(await imageBytes(8, 8)) }, "http://fixture.local", "fixture");
        expect(result).toHaveProperty("enhancementSkip", { status: "skipped", reason: "disabled" });
        expect(result).not.toHaveProperty("nativeSource");
        expect(result).not.toHaveProperty("enhancementId");
        const { createImageTask, updateImageTask, getImageTask } = await import("./image-task-store");
        const created = await createImageTask(task);
        await updateImageTask(created.id, { result: { ...result, results: [result] } });
        expect((await getImageTask(created.id))?.result).toHaveProperty("enhancementSkip", { status: "skipped", reason: "disabled" });
    });

    it.each([
        { model: "other-image-model", protocol: "custom" as const },
        { model: "gemini-3.1-flash-image", protocol: "openai" as const },
    ])("persists actual native bytes, task dimensions and repeat log references for ordinary $protocol $model 4K requests", async ({ model, protocol }) => {
        const source = await imageBytes(1254, 1254);
        const { createImageTask, getImageTask, updateImageTask } = await import("./image-task-store");
        const task = await createImageTask(imageTask({ model, size: "1:1", quality: "4k", advancedConfig: { ...emptyAdvancedConfig(), protocol } }));
        const prepared = await prepare(task, { dataUrl: dataUrl(source) }, "http://fixture.local", "fixture");
        const [result] = prepared.results;
        const persisted = await readFile(assetPath(result.serverUrl!));
        expect(result).toMatchObject({ mimeType: "image/png", width: 1254, height: 1254, bytes: source.length });
        expect(persisted).toEqual(source);
        expect(result.resultId).toBe(`${task.id}:1`);
        expect(result.nativeSource).toEqual({ url: result.serverUrl, sha256: createHash("sha256").update(source).digest("hex"), width: 1254, height: 1254, byteLength: source.length, format: "png", hasAlpha: false, provenance: "provider_native" });
        expect(result.enhancementId).toBe(`enhancement:${task.id}:1`);
        expect(result).not.toHaveProperty("enhancementSkip");
        await expect(sharp(persisted).metadata()).resolves.toMatchObject({ width: 1254, height: 1254 });

        await updateImageTask(task.id, { result: { ...result, ...prepared } });
        expect(await getImageTask(task.id)).toMatchObject({
            config: { size: "1:1", quality: "4k" },
            result: { width: 1254, height: 1254, results: [{ dataUrl: result.dataUrl, serverUrl: result.serverUrl, mimeType: "image/png", width: 1254, height: 1254, bytes: source.length }] },
        });
        const beforeLogFiles = (await savedFiles()).filter((file) => file.endsWith(".png"));
        const { recordGenerationTaskLogResult } = await import("./generation-log-task-service");
        const logInput = {
            taskId: task.id,
            userId: task.userId,
            username: task.username,
            displayName: task.displayName,
            kind: "image" as const,
            source: "image-workbench" as const,
            status: "success" as const,
            title: "Native image result",
            prompt: task.prompt,
            model,
            summary: "Image ready",
            durationMs: 100,
            createdAt: task.createdAt,
            asset: { type: "image" as const, url: result.serverUrl!, serverUrl: result.serverUrl, width: result.width, height: result.height, mimeType: result.mimeType, bytes: result.bytes, targetSize: "4096x4096" },
        };
        const firstLog = await recordGenerationTaskLogResult(logInput);
        const repeatedLog = await recordGenerationTaskLogResult(logInput);
        expect(firstLog.asset).toMatchObject({ url: result.serverUrl, width: 1254, height: 1254, bytes: source.length });
        expect(repeatedLog.asset).toEqual(firstLog.asset);
        expect(repeatedLog.log?.assets).toHaveLength(1);
        expect(mediaRegistry.register).toHaveBeenCalledTimes(1);
        expect((await savedFiles()).filter((file) => file.endsWith(".png"))).toEqual(beforeLogFiles);
        expect(await readFile(assetPath(repeatedLog.asset!.serverUrl!))).toEqual(source);
        const storedLogs = JSON.parse(await readFile(join(directory, "generation-logs.json"), "utf8"));
        expect(storedLogs.logs.find((log: { taskId?: string }) => log.taskId === task.id).assets).toEqual([repeatedLog.asset]);
    });

    it("preserves a single insufficient native edge for an exact ordinary request", async () => {
        const source = await imageBytes(6000, 3000);
        const {
            results: [result],
        } = await prepare(imageTask({ model: "other-image-model", size: "4096x4096" }), { dataUrl: dataUrl(source) }, "http://fixture.local", "fixture");

        expect(result).toMatchObject({ width: 6000, height: 3000, bytes: source.length });
        expect(await readFile(assetPath(result.serverUrl!))).toEqual(source);
    });
    it("keeps the original 4K-native variant unchanged even when it already exceeds the delivery target", async () => {
        const task = imageTask({ model: "other-image-model", size: "1:1", quality: "4k" });
        const source = await imageBytes(4100, 4100);
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(source) }, "http://fixture.local", "fixture");
        expect(result).toMatchObject({ width: 4100, height: 4100, bytes: source.length, nativeSource: { width: 4100, height: 4100, byteLength: source.length } });
        expect(await readFile(assetPath(result.serverUrl!))).toEqual(source);
    });
    it.each([0, 1])("records actual transparency rather than the existence of an alpha channel: %s", async (alpha) => {
        const source = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 255, b: 255, alpha } } })
            .png()
            .toBuffer();
        const task = imageTask({ model: "other-image-model", size: "1:1", quality: "4k" });
        const {
            results: [result],
        } = await prepare(task, { dataUrl: dataUrl(source) }, "http://fixture.local", "fixture");
        expect(result.nativeSource).toMatchObject({ hasAlpha: alpha === 0, width: 8, height: 8 });
        expect(await readFile(assetPath(result.serverUrl!))).toEqual(source);
    });
});

function imageBytes(width: number, height: number) {
    return sharp({ create: { width, height, channels: 3, background: "#287fbd" } })
        .png()
        .toBuffer();
}

function dataUrl(bytes: Buffer) {
    return `data:image/png;base64,${bytes.toString("base64")}`;
}

function digest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}

async function productDeliveryTask(withCanvas = false) {
    const pixels = Buffer.alloc(6 * 4 * 4);
    const maskPixels = Buffer.alloc(pixels.length, 255);
    for (let y = 0; y < 4; y++)
        for (let x = 0; x < 6; x++) {
            const offset = (y * 6 + x) * 4;
            pixels.set([30 + x * 10, 40 + y * 20, 180 - x * 5, 255], offset);
            if (x >= 4 && y < 2) maskPixels[offset + 3] = 0;
        }
    const [source, native, mask] = await Promise.all([
        sharp(pixels, { raw: { width: 6, height: 4, channels: 4 } })
            .png()
            .toBuffer(),
        sharp({ create: { width: 6, height: 4, channels: 3, background: "red" } })
            .png()
            .toBuffer(),
        sharp(maskPixels, { raw: { width: 6, height: 4, channels: 4 } })
            .png()
            .toBuffer(),
    ]);
    const task = withCanvas ? canvasTask() : imageTask({ size: "300x200" });
    task.config.quality = "4k";
    task.kind = "edit";
    task.enhancementPolicy = { revision: "frozen-v2", enabled: true, connection: null };
    task.references = [{ id: "scene", dataUrl: dataUrl(source), width: 6, height: 4, ecommerceRole: "scene" }];
    task.mask = { id: "product-mask", type: "image/png", dataUrl: dataUrl(mask), width: 6, height: 4 };
    task.productProtection = {
        compilerVersion: "strict-product.v1",
        state: "ready",
        productAnchorId: "product",
        sourceAssetId: "scene",
        sourceSize: { width: 6, height: 4 },
        productCore: [{ x: 1, y: 1, width: 2, height: 2 }],
        fusionHalo: [
            { x: 0, y: 0, width: 4, height: 1 },
            { x: 0, y: 3, width: 4, height: 1 },
            { x: 0, y: 1, width: 1, height: 2 },
            { x: 3, y: 1, width: 1, height: 2 },
        ],
        editableBackground: [{ x: 4, y: 0, width: 2, height: 4 }],
    };
    const normalized = await sharp(source).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
    const delivery: Extract<EcommerceEnhancementDelivery, { scope: "product_background" }> = {
        version: "ecommerce-delivery.v2",
        scope: "product_background",
        ...(withCanvas ? { canvas: structuredClone(task.ecommerceExecution!.canvas!) } : {}),
        protection: { version: "product-enhancement.v2", normalization: "srgb-upright-v1", product: structuredClone(task.productProtection), maskDataUrl: dataUrl(mask), maskSha256: digest(mask) },
        baseline: { url: dataUrl(source), sha256: digest(source), byteLength: source.length, width: 6, height: 4, normalizedSha256: digest(normalized) },
    };
    task.enhancementDelivery = delivery;
    return { task, source, native, mask, delivery };
}

function imageTask(config: Partial<ImageTask["config"]> = {}): ImageTask {
    return {
        id: "custom-gemini-image",
        userId: "fixture-user",
        username: "fixture-user",
        displayName: "Fixture User",
        kind: "generation",
        source: "image-workbench",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        config: {
            baseUrl: "https://fixture.example",
            apiKey: "fixture-only",
            apiFormat: "openai",
            model: "gemini-3.1-flash-image",
            advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom" },
            ...config,
        },
        prompt: "Fixture image",
        references: [],
    };
}

function canvasTask(): ImageTask {
    const task = imageTask({ size: "6x4" });
    task.ecommerceExecution = {
        state: "ready",
        compilerVersion: "ecommerce-nano-banana-2.v1",
        providerProfileId: "nano-banana-2",
        prompt: "preserve",
        referenceRoles: [],
        parameters: { variant: "nano-banana-2", size: "6x4" },
        canvas: { mode: "exact", size: { width: 6, height: 4 }, source: "user_text", allowReframe: false },
        modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "openai" },
    };
    return task;
}
