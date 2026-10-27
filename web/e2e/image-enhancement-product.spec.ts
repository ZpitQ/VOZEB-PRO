import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import sharp from "sharp";
import type { CreativeAsset } from "../src/lib/creative-runtime-contract";
import type { ImageEnhancementSettings, PublicImageEnhancement } from "../src/lib/image-enhancement-contract";
import type { ImageTask } from "../src/lib/server/image-task-store";
import type { ProductProtectionRegions } from "../src/lib/server/ecommerce-product-regions";
import { createBusinessFaultFixture, mediaSnapshot, ownedDataDirectory, readOwnedJob, sha256 } from "./image-enhancement-business-faults.fixture.mjs";
import { sanitizeRestartEvidence } from "./image-enhancement-restart.lifecycle.mjs";
import { e2eSettingsPatch } from "./support";

test.skip(process.env.VOZEB_PRO_M7_PRODUCT_BUSINESS !== "1", "Requires the freshly owned M7 application and controlled HTTP protocol fixtures.");

async function data<T>(request: APIRequestContext, url: string): Promise<T> {
    const response = await request.get(url);
    expect(response.ok(), `${url}: ${response.status()}`).toBe(true);
    return (await response.json()).data as T;
}
async function advance(request: APIRequestContext) {
    const response = await request.post("/api/maintenance/generation-tasks/run", { headers: { authorization: "Bearer vozeb-pro-e2e-worker-token-separate-32chars", "x-vozeb-pro-worker-id": "m7-actual-product-chain" } });
    expect(response.ok()).toBe(true);
}
async function storedTask(root: string, id: string): Promise<ImageTask> {
    const rows = JSON.parse(await readFile(path.join(root, "generation-tasks.json"), "utf8")) as Array<{ type: string; id: string; payload: ImageTask }>;
    const task = rows.find((entry) => entry.type === "image" && entry.id === id)?.payload;
    expect(task, "Actual image task persistence must contain this task").toBeDefined();
    return task!;
}
async function image(request: APIRequestContext, url: string) {
    const response = await request.get(url);
    expect(response.ok()).toBe(true);
    const bytes = await response.body();
    const pixels = await sharp(bytes, { failOn: "warning" }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { bytes, pixels, sha256: sha256(bytes) };
}

test("SR-M7 actual protected background chain: frozen source survives HTTP enhancement, publication, and explicit task references", async ({ request }, info) => {
    const root = ownedDataDirectory();
    const fixture = await createBusinessFaultFixture({ root, caseId: `m7-${randomUUID()}`, imagePath: process.env.VOZEB_PRO_M5_BUSINESS_NATIVE_SOURCE!, native4xDelivery: true });
    const stages: Array<Record<string, unknown>> = [];
    const record = async (stage: string, facts: unknown) => {
        stages.push({ stage, at: Date.now(), facts });
        await writeFile(
            info.outputPath("m7-actual-product-chain.json"),
            JSON.stringify(sanitizeRestartEvidence({ kind: "real application, file store, image provider and Worker HTTP; synthetic pixels, not GPU/quality or /create Agent continuity evidence", stages }), null, 2),
        );
    };
    const assets = async (id: string) => (await data<{ assets: CreativeAsset[] }>(request, `/api/creative/conversations/${encodeURIComponent(id)}/assets`)).assets;
    const enhancement = (id: string) => data<PublicImageEnhancement>(request, `/api/image-enhancements/${encodeURIComponent(id)}`);
    try {
        const settings = e2eSettingsPatch();
        const configured = await request.patch("/api/admin/settings", { data: { ...settings, ecommerceGenerationEnabled: false, systemChannels: settings.systemChannels.map((channel) => ({ ...channel, baseUrl: `${fixture.upstreamEndpoint}/v1` })) } });
        expect(configured.ok()).toBe(true);
        let enhancementSettings = await data<ImageEnhancementSettings>(request, "/api/admin/image-enhancement");
        for (const change of [
            { method: "patch", data: { enabled: false, endpoint: fixture.endpoint, token: fixture.token } },
            { method: "post", data: { action: "connection" } },
            { method: "patch", data: { modelId: fixture.model.id } },
            { method: "post", data: { action: "sample" } },
            { method: "patch", data: { enabled: true } },
        ] as const) {
            const options = { data: { revision: enhancementSettings.revision, ...change.data } };
            const response = change.method === "patch" ? await request.patch("/api/admin/image-enhancement", options) : await request.post("/api/admin/image-enhancement", options);
            expect(response.ok()).toBe(true);
            enhancementSettings = (await response.json()).data;
        }
        expect(enhancementSettings).toMatchObject({ enabled: true, ready: true });
        const created = await request.post("/api/creative/conversations", { data: { surface: "chat", source: "image-workbench", title: "M7 protected background fixture" } });
        expect(created.ok()).toBe(true);
        const conversationId = (await created.json()).data.conversation.id as string;
        const size = { width: 1254, height: 1254 };
        const source = await sharp({ create: { ...size, channels: 3, background: "#b14f35" } })
            .png({ palette: true })
            .toBuffer();
        expect(source.length).toBeLessThanOrEqual(fixture.native.length);
        const sourceId = `m7-product-${randomUUID()}`;
        const core = { x: 500, y: 500, width: 254, height: 254 };
        const halo = [
            { x: 480, y: 480, width: 294, height: 20 },
            { x: 480, y: 754, width: 294, height: 20 },
            { x: 480, y: 500, width: 20, height: 254 },
            { x: 754, y: 500, width: 20, height: 254 },
        ];
        const editable = [
            { x: 0, y: 0, width: 1254, height: 480 },
            { x: 0, y: 774, width: 1254, height: 480 },
            { x: 0, y: 480, width: 480, height: 294 },
            { x: 774, y: 480, width: 480, height: 294 },
        ];
        const maskPixels = Buffer.alloc(size.width * size.height * 4, 255);
        for (const rectangle of editable) for (let y = rectangle.y; y < rectangle.y + rectangle.height; y++) for (let x = rectangle.x; x < rectangle.x + rectangle.width; x++) maskPixels[(y * size.width + x) * 4 + 3] = 0;
        const mask = await sharp(maskPixels, { raw: { ...size, channels: 4 } })
            .png()
            .toBuffer();
        const regions: ProductProtectionRegions = {
            productAnchorId: sourceId,
            sourceAssetId: sourceId,
            sourceSize: size,
            productCore: { ...size, rectangles: [core] },
            fusionHalo: { ...size, rectangles: halo },
            editableBackground: {
                ...size,
                rectangles: editable,
                mask: { trust: "trusted", provider: "controlled-independent-mask", reference: { id: `${sourceId}-mask`, name: "background-mask.png", type: "image/png", ...size, dataUrl: `data:image/png;base64,${mask.toString("base64")}` } },
            },
        };
        const logicalImage = settings.logicalModels.find((model) => model.capability === "image");
        expect(logicalImage).toBeDefined();
        const config = { model: logicalImage!.id, quality: "4k", size: "1:1" };
        const createTask = async (reference: { id: string; dataUrl: string; width: number; height: number }, strict: boolean) => {
            const response = await request.post("/api/image-tasks", {
                data: {
                    kind: "edit",
                    source: "image-workbench",
                    prompt: "Change only the permitted background",
                    config: { ...config, quality: strict ? "4k" : "2k" },
                    references: [{ ...reference, name: "product.png", type: "image/png" }],
                    ...(strict ? { productProtectionRegions: regions } : {}),
                    context: { conversationId, surface: "chat", clientRequestId: randomUUID() },
                },
            });
            expect(response.ok(), await response.text()).toBe(true);
            const taskId = (await response.json()).task.id as string;
            await expect
                .poll(
                    async () => {
                        await advance(request);
                        const task = await storedTask(root, taskId);
                        if (task.status === "error") throw new Error(JSON.stringify({ id: task.id, status: task.status, error: task.error }));
                        return task.status;
                    },
                    { timeout: info.timeout },
                )
                .toBe("success");
            return storedTask(root, taskId);
        };
        const task = await createTask({ id: sourceId, dataUrl: `data:image/png;base64,${source.toString("base64")}`, ...size }, true);
        expect(task.productProtection).toMatchObject({ state: "ready", productAnchorId: sourceId });
        expect(task.enhancementDelivery).toMatchObject({ version: "ecommerce-delivery.v2", scope: "product_background", baseline: { sha256: sha256(source) }, protection: { maskSha256: sha256(mask) } });
        const original = task.result!.results![0];
        expect(original.productEnhancementEvidence).toMatchObject({ version: "product-baseline.v2", nativeSha256: sha256(fixture.native), composition: { protectedChangedPixels: 0 } });
        const id = original.enhancementId!;
        // The existing 4K square quality table requests 2880²; protected delivery keeps the source canvas.
        const requestedTarget = { width: 2880, height: 2880 };
        let pending!: PublicImageEnhancement;
        await expect
            .poll(
                async () => {
                    await advance(request);
                    pending = await enhancement(id);
                    if (pending.status === "failed") throw new Error(JSON.stringify(pending));
                    return `${pending.status}:${pending.phase}`;
                },
                { timeout: info.timeout },
            )
            .toBe("running:poll");
        expect(pending).toMatchObject({
            native: { url: original.serverUrl, provenance: "protected_composite" },
            providerNative: { sha256: sha256(fixture.native) },
            plannedInference: { width: 5016, height: 5016 },
            target: size,
            delivery: { scope: "product_background", requestedTarget },
        });
        const raw = await image(request, original.nativeSource!.url);
        const baseline = await image(request, original.serverUrl!);
        const product = await sharp(source).toColourspace("srgb").ensureAlpha().raw().toBuffer();
        expect(raw.bytes.equals(fixture.native)).toBe(true);
        expect(baseline.sha256).not.toBe(raw.sha256);
        const assertProtected = (pixels: Buffer) => {
            let changed = 0;
            for (let pixel = 0; pixel < size.width * size.height; pixel++) if (maskPixels[pixel * 4 + 3] === 255 && !pixels.subarray(pixel * 4, pixel * 4 + 4).equals(product.subarray(pixel * 4, pixel * 4 + 4))) changed++;
            expect(changed).toBe(0);
        };
        assertProtected(baseline.pixels.data);
        const baselineMedia = await mediaSnapshot(root, task.id);
        await record("real prepare/freeze, provider native, protected baseline, durable queue and HTTP submit", {
            taskId: task.id,
            enhancementId: id,
            public: pending,
            productSourceSha256: sha256(source),
            maskSha256: sha256(mask),
            nativeMedia: baselineMedia,
            worker: await fixture.snapshot(),
        });
        let receiptBoundary = false;
        let receiptFailure: unknown;
        fixture.beforeReceipt(async () => {
            try {
                const persisted = await readOwnedJob(root, id);
                expect(persisted).toMatchObject({ status: "succeeded", phase: "receipt", publication: { assetId: expect.any(String), protection: { protectedChangedPixels: 0 } } });
                expect(await image(request, persisted.publication.ai.url).then((value) => value.sha256)).toBe(fixture.expected.sha256);
                const publishedAssets = await assets(conversationId);
                const child = publishedAssets.find((asset) => asset.id === persisted.publication.assetId);
                expect(child).toBeDefined();
                expect(publishedAssets.find((asset) => asset.id === child!.parentAssetId)).toMatchObject({ sourceTaskId: task.id, serverUrl: original.serverUrl });
                receiptBoundary = true;
            } catch (error) {
                receiptFailure = error;
                throw error;
            }
        });
        await fixture.setFault("ok");
        let completed!: PublicImageEnhancement;
        await expect
            .poll(
                async () => {
                    await advance(request);
                    if (receiptFailure) throw receiptFailure;
                    completed = await enhancement(id);
                    if (completed.status === "failed") throw new Error(JSON.stringify(completed));
                    return `${completed.status}:${completed.phase}`;
                },
                { timeout: info.timeout },
            )
            .toBe("succeeded:completed");
        expect(receiptBoundary).toBe(true);
        expect(completed.delivery).toMatchObject({ scope: "product_background", protectedChangedPixels: 0 });
        expect(completed.events.filter((event) => event.stage === "protection_verified")).toHaveLength(1);
        expect(completed.events.filter((event) => event.stage === "receipt_confirmed")).toHaveLength(1);
        const final = await image(request, completed.enhanced!.url);
        expect(final.pixels.info).toMatchObject(size);
        expect(final.sha256).not.toBe(baseline.sha256);
        assertProtected(final.pixels.data);
        expect([...final.pixels.data.subarray(0, 4)]).toEqual([0x51, 0x86, 0x9d, 255]);
        expect((await image(request, original.serverUrl!)).bytes.equals(baseline.bytes)).toBe(true);
        expect(await mediaSnapshot(root, task.id)).toEqual(baselineMedia);
        const publishedAssets = await assets(conversationId);
        const finalAsset = publishedAssets.find((asset) => asset.id === completed.enhanced!.assetId)!;
        expect(finalAsset).toBeDefined();
        const originalAsset = publishedAssets.find((asset) => asset.id === finalAsset.parentAssetId)!;
        expect(originalAsset).toMatchObject({ sourceTaskId: task.id, serverUrl: original.serverUrl });
        expect(finalAsset).toMatchObject({ parentAssetId: originalAsset.id, metadata: { provenance: "ai_enhanced", enhancementId: id } });
        const beforeReferences = await fixture.snapshot();
        for (const selected of [originalAsset, finalAsset]) {
            const branch = await createTask({ id: selected.id, dataUrl: selected.serverUrl!, width: selected.width!, height: selected.height! }, false);
            expect(branch.references[0]).toMatchObject({ id: selected.id, dataUrl: selected.serverUrl });
            const call = fixture
                .upstreamRequests()
                .filter((entry: { method: string; path: string }) => entry.method === "POST" && entry.path.endsWith("/images/edits"))
                .at(-1)!;
            const form = await new Response(call.body, { headers: { "content-type": call.contentType } }).formData();
            const file = form.get("image") || form.get("image[]");
            expect(file instanceof File).toBe(true);
            expect(sha256(Buffer.from(await (file as File).arrayBuffer()))).toBe(selected.id === originalAsset.id ? baseline.sha256 : final.sha256);
        }
        const worker = await fixture.snapshot();
        expect(worker.jobs).toHaveLength(1);
        expect(worker.acceptedReceipts).toHaveLength(1);
        expect(worker.jobs).toEqual(beforeReferences.jobs);
        expect((await enhancement(id)).enhanced).toEqual(completed.enhanced);
        expect(JSON.stringify(completed)).not.toContain("maskDataUrl");
        expect(JSON.stringify(completed)).not.toContain(fixture.token);
        await record("permanent AI/final published before receipt; protected pixels unchanged; both actual task-level references submit selected immutable bytes", {
            completed,
            originalAsset,
            finalAsset,
            finalSha256: final.sha256,
            protectedChangedPixels: 0,
            worker,
            counts: fixture.counts(),
        });
    } finally {
        try {
            await record("final controlled Worker ledger", await fixture.snapshot());
            await info.attach("m7-actual-product-chain", { path: info.outputPath("m7-actual-product-chain.json"), contentType: "application/json" });
        } finally {
            await fixture.close();
        }
    }
});
