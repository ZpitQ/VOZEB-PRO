import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { createProtocolFixtureServer } from "../scripts/protocol-fixture-server.mjs";
import { emptyAdvancedConfig } from "../src/lib/channel-protocol-registry";
import type { CreativeAsset } from "../src/lib/creative-runtime-contract";
import type { PublicImageEnhancement } from "../src/lib/image-enhancement-contract";
import { e2eSettingsPatch } from "./support";

const MODEL = "custom-native-image";
test.describe.configure({ mode: "serial" });
test.skip(!process.env.VOZEB_PRO_M5_GPU_CONNECTION, "Opt-in real Windows GPU acceptance requires a private connection file.");
const fixtures = [
    { id: "F01", native: { width: 1254, height: 1254 }, ai: { width: 5016, height: 5016 }, delivered: { width: 4096, height: 4096 } },
    { id: "F02", native: { width: 1600, height: 900 }, ai: { width: 6400, height: 3600 }, delivered: { width: 3840, height: 2160 } },
];

test("the administrator qualifies the actual new Worker boot through the application Route", async ({ request }, info) => {
    const connection = JSON.parse(await readFile(process.env.VOZEB_PRO_M5_GPU_CONNECTION!, "utf8")) as { endpoint: string; token: string; serviceId: string };
    let settings = await adminSettings(request);
    let response = await request.patch("/api/admin/image-enhancement", { data: { revision: settings.revision, enabled: false, endpoint: connection.endpoint, token: connection.token, timeoutMs: 120_000 } });
    expect(response.ok()).toBe(true);
    settings = (await response.json()).data;
    response = await request.post("/api/admin/image-enhancement", { data: { revision: settings.revision, action: "connection" } });
    expect(response.ok()).toBe(true);
    settings = (await response.json()).data;
    expect(settings.models.map((model: { id: string }) => model.id)).toContain("standard-4x");
    response = await request.patch("/api/admin/image-enhancement", { data: { revision: settings.revision, modelId: "standard-4x" } });
    expect(response.ok()).toBe(true);
    settings = (await response.json()).data;
    await expect.poll(async () => {
        const check = await request.post("/api/admin/image-enhancement", { data: { revision: settings.revision, action: "sample" } });
        expect(check.ok()).toBe(true);
        settings = (await check.json()).data;
        expect(["sample_pending", "ready"]).toContain(settings.check.reason);
        return settings.ready;
    }, { timeout: 240_000 }).toBe(true);
    expect(settings.check).toMatchObject({ serviceId: connection.serviceId, sample: { input: fixtures[0].native, inference: fixtures[0].ai, output: fixtures[0].ai } });
    expect(JSON.stringify(settings)).not.toContain(connection.token);
    response = await request.patch("/api/admin/image-enhancement", { data: { revision: settings.revision, enabled: true } });
    expect(response.ok()).toBe(true);
    expect((await response.json()).data).toMatchObject({ enabled: true, ready: true });
    await writeFile(info.outputPath("actual-self-test.json"), JSON.stringify(settings, null, 2));
});

for (const sample of fixtures) test(`${sample.id} persists native, real AI and delivered dimensions through create, admin logs and downloads`, async ({ page, request }, info) => {
    const directory = await mkdtemp(path.join(tmpdir(), "vozeb-m5-gpu-source-"));
    const photo = await readFile(process.env.VOZEB_PRO_M5_GPU_SOURCE!);
    const original = sample.id === "F01" ? photo : await sharp(photo)
        .resize(sample.native.width, sample.native.height, { fit: "contain", background: "white" }).removeAlpha().jpeg({ quality: 96, chromaSubsampling: "4:4:4" }).toBuffer();
    expect(await sharp(original).metadata()).toMatchObject({ ...sample.native, format: sample.id === "F01" ? "png" : "jpeg" });
    const imagePath = path.join(directory, `${sample.id}.${sample.id === "F01" ? "png" : "jpg"}`);
    await writeFile(imagePath, original);
    const fixture = createProtocolFixtureServer({ imagePath });
    await new Promise<void>((resolve, reject) => { fixture.server.once("error", reject); fixture.server.listen(0, "127.0.0.1", resolve); });
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("fixture_port_missing");
    const settings = e2eSettingsPatch();
    const operation = { capability: "image" as const, source: "manual" as const, protocol: "custom" as const, apiFormat: "openai" as const,
        createPath: "/custom/images", editPath: "/custom/images", requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","size":"{{size}}","quality":"{{quality}}","references":"{{images}}"}',
        resultField: "data.image_url", referenceRule: "base64 inline image references", supportsReferenceImage: true };
    const systemChannels = settings.systemChannels.map((channel) => ({ ...channel, models: channel.models.filter((model) => !model.includes("image")), advancedConfig: { ...channel.advancedConfig,
        modelCapabilities: Object.fromEntries(Object.entries(channel.advancedConfig.modelCapabilities).filter(([, capability]) => capability !== "image")),
        modelConfigs: Object.fromEntries(Object.entries(channel.advancedConfig.modelConfigs).filter(([model]) => !model.includes("image"))) } }));
    try {
        const saved = await request.patch("/api/admin/settings", { data: { ...settings, ecommerceGenerationEnabled: false, systemChannels: [...systemChannels,
            { id: "e2e-gpu-native", name: "E2E controlled native source", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "e2e-native-image-secret", apiFormat: "openai", models: [MODEL], enabled: true,
                advancedConfig: { ...emptyAdvancedConfig(), ...operation, modelCapabilities: { [MODEL]: "image" }, modelConfigs: { [MODEL]: operation }, operationConfigs: { image: operation } } }],
            logicalModels: settings.logicalModels.filter((model) => model.capability !== "image"), defaultModels: { ...settings.defaultModels, imageModel: MODEL },
            ecommerceModelRoles: { ...settings.ecommerceModelRoles, image_generation: [] }, modelPointCosts: { ...settings.modelPointCosts, [MODEL]: 0 } } });
        expect(saved.ok()).toBe(true);
        await page.goto("/create", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
        await page.getByRole("button", { name: /^生成参数：/ }).click();
        const preferences = page.locator("[data-creative-generation-preferences]");
        await preferences.getByRole("tab", { name: "输出", exact: true }).click();
        await preferences.getByRole("button", { name: /高画质/ }).click();
        await preferences.getByRole("tab", { name: "画面", exact: true }).click();
        await preferences.getByRole("button", { name: "打开图片自定义像素尺寸", exact: true }).click();
        await page.getByRole("textbox", { name: "自定义图片宽度", exact: true }).fill(String(sample.delivered.width));
        await page.getByRole("textbox", { name: "自定义图片高度", exact: true }).fill(String(sample.delivered.height));
        await page.getByRole("button", { name: /^生成参数：/ }).click();
        await page.getByRole("textbox", { name: "描述你想生成或修改的图片" }).fill(`生成${sample.id}摄影测试商品图`);
        const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        const createdResponse = await created;
        expect(createdResponse.ok()).toBe(true);
        const { run } = (await createdResponse.json()).data;
        await expect.poll(async () => {
            await advanceWorker(request);
            const current = await request.get(`/api/agent/runs/${run.id}`);
            expect(current.ok()).toBe(true);
            return (await current.json()).data.run.status;
        }, { timeout: 120_000 }).toBe("completed");
        let assets: CreativeAsset[] = [];
        let native: CreativeAsset | undefined;
        await expect.poll(async () => {
            const response = await request.get(`/api/creative/conversations/${run.conversationId}/assets`);
            expect(response.ok()).toBe(true);
            assets = (await response.json()).data.assets;
            native = assets.find((asset) => asset.sourceRunId === run.id && asset.metadata?.enhancementId && asset.metadata?.provenance !== "ai_enhanced");
            return Boolean(native);
        }, { timeout: 120_000 }).toBe(true);
        expect(native).toMatchObject({ ...sample.native, metadata: { nativeSource: { ...sample.native, provenance: "provider_native", sha256: sha256(original) } } });
        const enhancementId = String(native!.metadata!.enhancementId);
        const round = page.getByTestId("creative-media-result");
        await expect(round).toBeVisible({ timeout: 45_000 });
        await round.getByRole("button", { name: "原图", exact: true }).click();
        const nativeDownload = await download(page, round.getByLabel("本轮创作操作", { exact: true }));
        expect(sha256(nativeDownload)).toBe(sha256(original));
        let enhancement: PublicImageEnhancement | undefined;
        await expect.poll(async () => {
            await advanceWorker(request);
            const response = await request.get(`/api/image-enhancements/${enhancementId}`);
            expect(response.ok()).toBe(true);
            enhancement = (await response.json()).data;
            expect(["queued", "running", "succeeded"]).toContain(enhancement!.status);
            return `${enhancement!.status}:${enhancement!.phase}`;
        }, { timeout: 240_000 }).toBe("succeeded:completed");
        expect(enhancement!.events.map((event) => event.stage)).toContain("receipt_confirmed");
        expect(enhancement).toMatchObject({ native: sample.native, ai: sample.ai, enhanced: sample.delivered, target: sample.delivered, attempt: 1 });
        for (const value of Object.values(enhancement!.timings!)) expect(value).toBeGreaterThanOrEqual(0);
        expect(Object.keys(enhancement!.timings!).sort()).toEqual(["deliveryEncodingMs", "workerExecutionMs", "workerQueueMs"]);
        await expect(round.getByRole("button", { name: "AI增强", exact: true })).toBeEnabled({ timeout: 30_000 });
        await round.getByRole("button", { name: "AI增强", exact: true }).click();
        const actions = page.getByTestId("creative-media-result").getByLabel("本轮创作操作", { exact: true });
        await expect(actions).toHaveAttribute("data-active-asset-id", enhancement!.enhanced!.assetId!);
        const enhancedDownload = await download(page, actions);
        expect(await sharp(enhancedDownload).metadata()).toMatchObject(sample.delivered);
        expect(sha256(enhancedDownload)).toBe(enhancement!.enhanced!.sha256);
        expect(sha256(enhancedDownload)).not.toBe(sha256(original));
        const media = await request.get(enhancement!.enhanced!.url);
        expect(media.ok()).toBe(true);
        expect(sha256(await media.body())).toBe(enhancement!.enhanced!.sha256);
        const logReply = await request.get("/api/admin/generation-logs?pageSize=20");
        expect(logReply.ok()).toBe(true);
        const logs = (await logReply.json()).logs as Array<{ id: string; status: string; assets: Array<{ enhancementId?: string; enhancement?: PublicImageEnhancement }> }>;
        const log = logs.find((entry) => entry.assets.some((asset) => asset.enhancementId === enhancementId));
        expect(log).toBeTruthy();
        expect(log!.status).toBe("success");
        expect(log!.assets.find((asset) => asset.enhancementId === enhancementId)!.enhancement).toMatchObject({ status: "succeeded", native: sample.native, ai: sample.ai, enhanced: sample.delivered });
        await page.screenshot({ path: info.outputPath(`${sample.id}-actual-gpu.png`), fullPage: true });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("creative-media-result")).toBeVisible();
        const reloaded = await request.get(`/api/creative/conversations/${run.conversationId}/assets`);
        assets = (await reloaded.json()).data.assets;
        const child = assets.find((asset) => asset.id === enhancement!.enhanced!.assetId);
        expect(child).toMatchObject({ ...sample.delivered, parentAssetId: native!.id, metadata: { provenance: "ai_enhanced", enhancementId } });
        expect(fixture.requests.filter((entry) => entry.method === "POST" && entry.path === "/custom/images")).toHaveLength(1);
        await writeFile(info.outputPath(`${sample.id}-actual-evidence.json`), JSON.stringify({ fixture: sample, runId: run.id, conversationId: run.conversationId, native, child, enhancement, logId: log!.id, upstreamPostCount: 1 }, null, 2));
    } finally {
        try {
            const restored = await request.patch("/api/admin/settings", { data: e2eSettingsPatch() });
            expect(restored.ok()).toBe(true);
        } finally {
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => error ? reject(error) : resolve()));
        }
    }
});

async function adminSettings(request: APIRequestContext) {
    const response = await request.get("/api/admin/image-enhancement");
    expect(response.ok()).toBe(true);
    return (await response.json()).data;
}
async function advanceWorker(request: APIRequestContext) {
    const response = await request.post("/api/maintenance/generation-tasks/run", { headers: { authorization: "Bearer vozeb-pro-e2e-worker-token-separate-32chars", "x-vozeb-pro-worker-id": "m5-real-gpu-acceptance" } });
    expect(response.ok()).toBe(true);
}
async function download(page: Page, actions: Locator) {
    const started = page.waitForEvent("download");
    await actions.getByRole("button", { name: "下载", exact: true }).click();
    const menu = page.getByRole("menuitem", { name: "下载当前结果", exact: true });
    if (await menu.isVisible()) await menu.click();
    const item = await started;
    expect(await item.failure()).toBeNull();
    const url = new URL(item.url());
    expect(url.searchParams.get("download")).toBe("original");
    expect(url.searchParams.has("width")).toBe(false);
    expect(url.searchParams.has("format")).toBe(false);
    return readFile((await item.path())!);
}
function sha256(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
