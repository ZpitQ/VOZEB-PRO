import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";
import sharp from "sharp";

import { createProtocolFixtureServer } from "../scripts/protocol-fixture-server.mjs";
import { emptyAdvancedConfig } from "../src/lib/channel-protocol-registry";
import type { CreativeAsset } from "../src/lib/creative-runtime-contract";
import { e2eSettingsPatch } from "./support";

const MODEL = "custom-native-image";
const NATIVE_SIZE = { width: 1254, height: 1254 };
let fixture: ReturnType<typeof createProtocolFixtureServer>;
let dataDirectory = "";
let originalImage: Buffer;

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Native image delivery is a desktop Chromium acceptance case.");
    dataDirectory = await mkdtemp(path.join(tmpdir(), "vozeb-native-delivery-e2e-"));
    const imagePath = path.join(dataDirectory, "native-1254.png");
    await sharp({ create: { ...NATIVE_SIZE, channels: 3, background: { r: 24, g: 132, b: 192 } } })
        .png()
        .toFile(imagePath);
    originalImage = await readFile(imagePath);
    fixture = createProtocolFixtureServer({ imagePath });
    await new Promise<void>((resolve, reject) => {
        fixture.server.once("error", reject);
        fixture.server.listen(0, "127.0.0.1", resolve);
    });
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("Native image fixture did not bind a TCP port");

    const settings = e2eSettingsPatch();
    const operation = {
        capability: "image" as const,
        source: "manual" as const,
        protocol: "custom" as const,
        apiFormat: "openai" as const,
        createPath: "/custom/images",
        editPath: "/custom/images",
        requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","size":"{{size}}","quality":"{{quality}}","references":"{{images}}"}',
        resultField: "data.image_url",
        referenceRule: "base64 inline image references",
        supportsReferenceImage: true,
    };
    const systemChannels = settings.systemChannels.map((channel) => ({
        ...channel,
        models: channel.models.filter((model) => !model.includes("image")),
        advancedConfig: {
            ...channel.advancedConfig,
            modelCapabilities: Object.fromEntries(Object.entries(channel.advancedConfig.modelCapabilities).filter(([, capability]) => capability !== "image")),
            modelConfigs: Object.fromEntries(Object.entries(channel.advancedConfig.modelConfigs).filter(([model]) => !model.includes("image"))),
        },
    }));
    const saved = await request.patch("/api/admin/settings", {
        data: {
            ...settings,
            systemChannels: [
                ...systemChannels,
                {
                    id: "e2e-native-image-custom",
                    name: "E2E Native image custom",
                    baseUrl: `http://127.0.0.1:${address.port}`,
                    apiKey: "e2e-native-image-secret",
                    apiFormat: "openai",
                    models: [MODEL],
                    enabled: true,
                    advancedConfig: { ...emptyAdvancedConfig(), ...operation, modelCapabilities: { [MODEL]: "image" }, modelConfigs: { [MODEL]: operation }, operationConfigs: { image: operation } },
                },
            ],
            logicalModels: settings.logicalModels.filter((model) => model.capability !== "image"),
            defaultModels: { ...settings.defaultModels, imageModel: MODEL },
            ecommerceModelRoles: { ...settings.ecommerceModelRoles, image_generation: [] },
            modelPointCosts: { ...settings.modelPointCosts, [MODEL]: 0 },
        },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
});

test.afterEach(async ({ request }) => {
    try {
        if (fixture) {
            const restored = await request.patch("/api/admin/settings", { data: e2eSettingsPatch() });
            expect(restored.ok(), await restored.text()).toBe(true);
        }
    } finally {
        if (fixture?.server.listening) await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
    }
});

test("ordinary 4K image requests deliver native pixels through reload, download and reuse", async ({ page, request }, testInfo) => {
    const submittedRuns: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/agent/runs") submittedRuns.push(request.url());
    });
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await page.getByRole("button", { name: /^生成参数：/ }).click();
    const preferences = page.locator("[data-creative-generation-preferences]");
    await preferences.getByRole("button", { name: "打开图片自定义像素尺寸", exact: true }).click();
    const customWidth = page.getByRole("textbox", { name: "自定义图片宽度", exact: true });
    const customHeight = page.getByRole("textbox", { name: "自定义图片高度", exact: true });
    await customWidth.fill("4096");
    await expect(customWidth).toHaveValue("4096");
    await customHeight.fill("4096");
    await expect(customHeight).toHaveValue("4096");
    await expect(page.getByRole("button", { name: /^生成参数：/ })).toHaveAccessibleName(/4096\s*[×x]\s*4096/);
    await page.getByRole("button", { name: /^生成参数：/ }).click();
    await expect(preferences).toBeHidden();
    await page.getByRole("textbox", { name: "描述你想生成或修改的图片" }).fill("生成一张蓝色正方形商品图");
    const runCreated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const response = await runCreated;
    expect(response.ok(), await response.text()).toBe(true);
    const { run } = ((await response.json()) as { data: { run: { id: string; conversationId: string } } }).data;
    await expect
        .poll(
            async () => {
                const current = await request.get(`/api/agent/runs/${run.id}`);
                expect(current.ok(), await current.text()).toBe(true);
                return ((await current.json()) as { data: { run: { status: string } } }).data.run.status;
            },
            { timeout: 60_000 },
        )
        .toBe("completed");

    const summary = page.getByLabel("本轮创作参数", { exact: true });
    await expect(summary.getByText("请求尺寸：4096x4096", { exact: true })).toBeVisible();
    await expect(summary.getByText(/^请求画质：/)).toBeVisible();
    await expect(summary.getByText("原图尺寸：1254×1254", { exact: true })).toBeVisible();
    await expect(page.getByLabel("图像增强与版本").getByRole("status")).toContainText("当前原图 1254×1254");
    const image = page.getByTestId("creative-media-result").getByTestId("creative-primary-result").getByRole("img");
    await expect(image).toBeVisible();
    const mediaUrl = new URL((await image.getAttribute("src"))!, page.url());
    mediaUrl.search = "";
    const media = await request.get(mediaUrl.href);
    expect(media.ok()).toBe(true);
    const mediaBytes = await media.body();
    expect(await sharp(mediaBytes).metadata()).toMatchObject(NATIVE_SIZE);
    expect(sha256(mediaBytes)).toBe(sha256(originalImage));
    const upstream = fixture.requests.filter((entry) => entry.method === "POST" && entry.path === "/custom/images");
    expect(upstream).toHaveLength(1);
    expect(JSON.parse(upstream[0].body.toString("utf8"))).toMatchObject({ model: MODEL, size: "4096x4096" });

    await page.goto(`/create?conversationId=${run.conversationId}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(image).toBeVisible();
    await expect(summary.getByText("请求尺寸：4096x4096", { exact: true })).toBeVisible();
    await expect(summary.getByText(/^请求画质：/)).toBeVisible();
    await expect(summary.getByText("原图尺寸：1254×1254", { exact: true })).toBeVisible();
    await expect(page.getByLabel("图像增强与版本").getByRole("status")).toContainText("当前原图 1254×1254");
    expect(new URL((await image.getAttribute("src"))!, page.url()).pathname).toBe(mediaUrl.pathname);
    const operations = page.getByLabel("本轮创作操作", { exact: true });
    const assetId = await operations.getAttribute("data-active-asset-id");
    expect(assetId).toBeTruthy();
    const assetsResponse = await request.get(`/api/creative/conversations/${run.conversationId}/assets`);
    expect(assetsResponse.ok(), await assetsResponse.text()).toBe(true);
    const assetsBefore = ((await assetsResponse.json()) as { data: { assets: CreativeAsset[] } }).data.assets;
    const outputAsset = assetsBefore.find((asset) => asset.id === assetId);
    expect(outputAsset).toMatchObject({ id: assetId, sourceRunId: run.id, type: "image", status: "ready", ...NATIVE_SIZE });
    expect(new URL(outputAsset!.serverUrl!, page.url()).pathname).toBe(mediaUrl.pathname);
    const downloadReady = page.waitForEvent("download");
    await operations.getByRole("button", { name: "下载", exact: true }).click();
    const download = await downloadReady;
    expect(await download.failure()).toBeNull();
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const downloadBytes = await readFile(downloadPath!);
    expect(await sharp(downloadBytes).metadata()).toMatchObject(NATIVE_SIZE);
    expect(sha256(downloadBytes)).toBe(sha256(originalImage));
    await page.screenshot({ path: testInfo.outputPath("native-image-delivery.png"), fullPage: true });

    await operations.getByRole("button", { name: "更多本轮创作操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "引用结果", exact: true }).click();
    await page.getByRole("textbox", { name: "描述你想生成或修改的图片" }).fill("保持这个商品不变，下轮修改背景");
    const referencedThumbnail = page.locator(".creative-composer").getByRole("img", { name: outputAsset!.title, exact: true });
    await expect(referencedThumbnail).toBeVisible();
    expect(new URL((await referencedThumbnail.getAttribute("src"))!, page.url()).pathname).toBe(mediaUrl.pathname);
    await operations.getByRole("button", { name: "更多本轮创作操作", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "取消引用", exact: true })).toBeVisible();
    const referencedAssetsResponse = await request.get(`/api/creative/conversations/${run.conversationId}/assets`);
    expect(referencedAssetsResponse.ok(), await referencedAssetsResponse.text()).toBe(true);
    const assetsAfter = ((await referencedAssetsResponse.json()) as { data: { assets: CreativeAsset[] } }).data.assets;
    expect(assetsAfter.find((asset) => asset.id === assetId)).toMatchObject({ id: assetId, width: 1254, height: 1254, serverUrl: outputAsset!.serverUrl });
    expect(assetsAfter.map((asset) => asset.id).sort()).toEqual(assetsBefore.map((asset) => asset.id).sort());
    expect(submittedRuns).toHaveLength(1);
    expect(fixture.requests.filter((entry) => entry.method === "POST" && entry.path === "/custom/images")).toHaveLength(1);
});

function sha256(buffer: Buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}
