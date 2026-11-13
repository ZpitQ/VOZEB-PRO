import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import sharp from "sharp";
import { emptyAdvancedConfig } from "../src/lib/channel-protocol-registry";
import type { CreativeAsset } from "../src/lib/creative-runtime-contract";
import type { ImageEnhancementSettings, PublicImageEnhancement } from "../src/lib/image-enhancement-contract";
import type { AgentRun } from "../src/lib/server/agent-run-store";
import type { ImageTask } from "../src/lib/server/image-task-store";
import type { CreativeAgentRun } from "../src/services/api/creative";
import { createBusinessFaultFixture, mediaSnapshot, ownedDataDirectory, readOwnedJob, sha256 } from "./image-enhancement-business-faults.fixture.mjs";
import { e2eSettingsPatch } from "./support";
import { sanitizeRestartEvidence } from "./image-enhancement-restart.lifecycle.mjs";
import { runImageProcessing } from "../scripts/image-processing-supervisor.mjs";
import { runImageProcessingLane } from "../.image-processing-runtime/workers/image-processing-lane.mjs";

const MODEL = "m5-controlled-native-image";
const timeoutMs = Number(process.env.VOZEB_PRO_M5_BUSINESS_TIMEOUT_MS || 10_000);
type Fixture = Awaited<ReturnType<typeof createBusinessFaultFixture>>;
type Counts = ReturnType<Fixture["counts"]>;
type FrozenImage = Awaited<ReturnType<typeof immutableImage>>;

test.skip(process.env.VOZEB_PRO_M5_F13_BUSINESS !== "1", "Requires a freshly owned actual application and the explicit F13 protocol fixture.");

async function getData<T>(request: APIRequestContext, url: string): Promise<T> {
    const response = await request.get(url);
    expect(response.ok(), `${url}: ${response.status()}`).toBe(true);
    return (await response.json()).data as T;
}
async function runState(request: APIRequestContext, id: string) {
    return (await getData<{ run: CreativeAgentRun }>(request, `/api/agent/runs/${encodeURIComponent(id)}`)).run;
}
async function listedAssets(request: APIRequestContext, conversationId: string) {
    return (await getData<{ assets: CreativeAsset[] }>(request, `/api/creative/conversations/${encodeURIComponent(conversationId)}/assets`)).assets;
}
async function enhancement(request: APIRequestContext, id: string) {
    return getData<PublicImageEnhancement>(request, `/api/image-enhancements/${encodeURIComponent(id)}`);
}
async function nativeLog(request: APIRequestContext, id: string) {
    const response = await request.get("/api/admin/generation-logs?pageSize=100");
    expect(response.ok()).toBe(true);
    const log = ((await response.json()).logs as Array<{ id: string; status: string; assets: Array<Record<string, unknown>> }>).find((entry) => entry.assets.some((asset) => asset.enhancementId === id));
    expect(log).toBeDefined();
    expect(log!.status).toBe("success");
    return { id: log!.id, status: log!.status, assets: log!.assets.map((asset) => Object.fromEntries(Object.entries(asset).filter(([key]) => key !== "enhancement"))) };
}
async function advance(request: APIRequestContext) {
    const response = await request.post("/api/maintenance/generation-tasks/run", { headers: { authorization: "Bearer vozeb-pro-e2e-worker-token-separate-32chars", "x-vozeb-pro-worker-id": "m5-f13-actual-business-chain" } });
    expect(response.ok()).toBe(true);
}
async function waitRun(request: APIRequestContext, id: string, info: TestInfo) {
    let run = await runState(request, id);
    await expect
        .poll(
            async () => {
                if (["planning", "running"].includes(run.status)) {
                    await advance(request);
                    run = await runState(request, id);
                }
                return ["planning", "running"].includes(run.status);
            },
            { timeout: info.timeout },
        )
        .toBe(false);
    return run;
}
async function waitEnhancement(request: APIRequestContext, id: string, accepts: (job: PublicImageEnhancement) => boolean, info: TestInfo) {
    let job = await enhancement(request, id);
    await expect
        .poll(
            async () => {
                if (!accepts(job)) {
                    await advance(request);
                    job = await enhancement(request, id);
                }
                return accepts(job);
            },
            { timeout: info.timeout },
        )
        .toBe(true);
    return job;
}
async function persistedRun(root: string, id: string): Promise<AgentRun> {
    const rows = JSON.parse(await readFile(path.join(root, "generation-tasks.json"), "utf8")) as Array<{ id: string; payload: AgentRun }>;
    const row = rows.find((entry) => entry.id === id);
    expect(row, "Actual agent persistence must contain this run").toBeDefined();
    expect(row!.payload.id).toBe(id);
    return row!.payload;
}
async function decoded(bytes: Buffer) {
    const image = sharp(bytes, { failOn: "warning" });
    const [metadata, pixels, statistics] = await Promise.all([image.metadata(), image.clone().raw().toBuffer({ resolveWithObject: true }), image.clone().stats()]);
    return { width: pixels.info.width, height: pixels.info.height, format: metadata.format, opaque: statistics.isOpaque, byteLength: bytes.length, sha256: sha256(bytes) };
}
async function immutableImage(request: APIRequestContext, asset: CreativeAsset) {
    expect(asset).toMatchObject({ type: "image", status: "ready", serverUrl: expect.stringMatching(/^\/api\/(?:generation-log-assets|reference-assets)\//) });
    const response = await request.get(asset.serverUrl!);
    expect(response.ok()).toBe(true);
    const facts = await decoded(await response.body());
    expect(facts).toMatchObject({ width: asset.width, height: asset.height, byteLength: asset.bytes, format: asset.mimeType === "image/jpeg" ? "jpeg" : "png", opaque: true });
    expect(response.headers()["content-type"]).toContain(asset.mimeType);
    return { asset, immutableUrl: asset.serverUrl!, ...facts };
}
async function freezeScene(request: APIRequestContext, root: string, id: string) {
    const run = await persistedRun(root, id);
    expect(run.status).toBe("completed");
    const listed = await listedAssets(request, run.conversationId);
    const baselineId = run.ecommerceSnapshot!.plan!.source.currentSceneBaselineId!;
    const baseline = listed.find((asset) => asset.id === baselineId);
    expect(baseline).toBeDefined();
    const outputIds = run.assetIds;
    expect(outputIds).toHaveLength(1);
    const output = listed.find((asset) => asset.id === outputIds[0]);
    expect(output).toMatchObject({ sourceRunId: id });
    const taskIds = run.tasks.flatMap((task) => task.taskIds || (task.taskId ? [task.taskId] : []));
    expect(taskIds).toHaveLength(1);
    const imageTasks = await Promise.all(
        taskIds.map(async (taskId) => {
            const response = await request.get(`/api/image-tasks/${encodeURIComponent(taskId)}`);
            expect(response.ok()).toBe(true);
            const task = (await response.json()).task;
            expect(task.status).toBe("success");
            return task;
        }),
    );
    const records = JSON.parse(await readFile(path.join(root, "generation-tasks.json"), "utf8")) as Array<{ id: string; type: string; userId: string; payload: ImageTask }>;
    const persistedResults = taskIds.map((id) => {
        const record = records.find((entry) => entry.id === id && entry.type === "image" && entry.userId === run.userId);
        expect(record).toBeDefined();
        expect(record!.payload.status).toBe("success");
        return { imageTaskId: id, result: record!.payload.result };
    });
    return { run, baseline: await immutableImage(request, baseline!), output: await immutableImage(request, output!), imageTasks, persistedResults };
}
function delta(before: Counts, after: Counts): Counts["counts"] {
    return Object.fromEntries(Object.entries(after.counts).map(([key, value]) => [key, Number(value) - before.counts[key as keyof Counts["counts"]]])) as Counts["counts"];
}
function noCalls(before: Counts, after: Counts) {
    expect(delta(before, after)).toEqual({ generation: 0, analysis: 0, planning: 0, otherText: 0, otherPost: 0 });
}
async function evidence(info: TestInfo, name: string, value: unknown) {
    const file = info.outputPath(`${name}.json`);
    await writeFile(file, JSON.stringify(sanitizeRestartEvidence(value), null, 2));
    await info.attach(name, { path: file, contentType: "application/json" });
}
async function screenshot(page: Page, info: TestInfo, name: string) {
    const file = info.outputPath(`${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await info.attach(name, { path: file, contentType: "image/png" });
}
function roundFor(page: Page, assetId: string) {
    return page.getByTestId("creative-media-result").filter({ has: page.locator(`[data-active-asset-id="${assetId}"]`) });
}
async function referenceCurrent(page: Page, actions: Locator) {
    await actions.getByRole("button", { name: "更多本轮创作操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "引用结果", exact: true }).click();
}
async function submitPrompt(page: Page, prompt: string) {
    await page.getByRole("textbox", { name: "描述你想生成或修改的图片", exact: true }).fill(prompt);
    const pending = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const response = await pending;
    expect(response.ok()).toBe(true);
    return (await response.json()).data.run as CreativeAgentRun;
}

async function qualify(request: APIRequestContext, fixture: Fixture) {
    let settings = await getData<ImageEnhancementSettings>(request, "/api/admin/image-enhancement");
    for (const change of [
        { method: "patch", data: { enabled: false, endpoint: fixture.endpoint, token: fixture.token, timeoutMs } },
        { method: "post", data: { action: "connection" } },
        { method: "patch", data: { modelId: fixture.model.id } },
        { method: "post", data: { action: "sample" } },
        { method: "patch", data: { enabled: true } },
    ] as const) {
        const options = { data: { revision: settings.revision, ...change.data } };
        const response = change.method === "patch" ? await request.patch("/api/admin/image-enhancement", options) : await request.post("/api/admin/image-enhancement", options);
        expect(response.ok()).toBe(true);
        settings = (await response.json()).data;
    }
    expect(settings).toMatchObject({ enabled: true, ready: true, timeoutMs, check: { state: "ready", serviceId: fixture.serviceId } });
    expect(settings.models.find((model) => model.id === fixture.model.id)).toEqual(fixture.model);
}
async function configureGeneration(request: APIRequestContext, fixture: Fixture, ecommerce: boolean) {
    const base = e2eSettingsPatch();
    const channels = base.systemChannels.map((channel) => ({
        ...channel,
        baseUrl: `${fixture.upstreamEndpoint}/v1`,
        ...(ecommerce
            ? {}
            : {
                  models: channel.models.filter((model) => !model.includes("image")),
                  advancedConfig: {
                      ...channel.advancedConfig,
                      modelCapabilities: Object.fromEntries(Object.entries(channel.advancedConfig.modelCapabilities).filter(([, capability]) => capability !== "image")),
                      modelConfigs: Object.fromEntries(Object.entries(channel.advancedConfig.modelConfigs).filter(([model]) => !model.includes("image"))),
                  },
              }),
    }));
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
    const normal = {
        id: "m5-local-native",
        name: "M5 controlled native fixture",
        baseUrl: fixture.upstreamEndpoint,
        apiKey: "m5-local-native-test-token",
        apiFormat: "openai",
        models: [MODEL],
        enabled: true,
        advancedConfig: { ...emptyAdvancedConfig(), ...operation, modelCapabilities: { [MODEL]: "image" }, modelConfigs: { [MODEL]: operation }, operationConfigs: { image: operation } },
    };
    const response = await request.patch("/api/admin/settings", {
        data: {
            ...base,
            ecommerceGenerationEnabled: ecommerce,
            systemChannels: [...channels, normal],
            defaultModels: { ...base.defaultModels, imageModel: ecommerce ? "e2e-ecommerce-image" : MODEL },
            ...(ecommerce ? {} : { logicalModels: base.logicalModels.filter((model) => model.capability !== "image"), ecommerceModelRoles: { ...base.ecommerceModelRoles, image_generation: [] } }),
            modelPointCosts: { ...base.modelPointCosts, [MODEL]: 0 },
        },
    });
    expect(response.ok()).toBe(true);
}
async function createOrdinaryA(page: Page, request: APIRequestContext, fixture: Fixture, info: TestInfo) {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true");
    await page.getByRole("button", { name: /^生成参数：/ }).click();
    const preferences = page.locator("[data-creative-generation-preferences]");
    await preferences.getByRole("tab", { name: "输出", exact: true }).click();
    await preferences.getByRole("button", { name: /高画质/ }).click();
    await preferences.getByRole("tab", { name: "画面", exact: true }).click();
    await preferences.getByRole("button", { name: "打开图片自定义像素尺寸", exact: true }).click();
    await page.getByRole("textbox", { name: "自定义图片宽度", exact: true }).fill("4096");
    await page.getByRole("textbox", { name: "自定义图片高度", exact: true }).fill("4096");
    await page.getByRole("button", { name: /^生成参数：/ }).click();
    const run = await submitPrompt(page, `生成商品摄影测试图 F13-A ${randomUUID()}`);
    expect((await waitRun(request, run.id, info)).status).toBe("completed");
    const native = (await listedAssets(request, run.conversationId)).find((asset) => asset.sourceRunId === run.id && asset.metadata.enhancementId && asset.metadata.provenance !== "ai_enhanced");
    expect(native).toMatchObject({ width: 1254, height: 1254, metadata: { nativeSource: { width: 1254, height: 1254, sha256: sha256(fixture.native), provenance: "provider_native" } } });
    const id = String(native!.metadata.enhancementId);
    const pending = await waitEnhancement(request, id, (job) => job.status === "running" && job.phase === "poll", info);
    expect(pending).toMatchObject({ attempt: 1, native: { width: 1254, height: 1254, sha256: sha256(fixture.native) }, target: { width: 4096, height: 4096 } });
    const source = await immutableImage(request, native!);
    expect(source.sha256).toBe(sha256(fixture.native));
    return { run, source, id, pending, nativeRun: await persistedRun(ownedDataDirectory(), run.id), nativeMedia: await mediaSnapshot(ownedDataDirectory(), pending.imageTaskId) };
}

async function downloadCurrent(page: Page, actions: Locator, expected: FrozenImage) {
    const pending = page.waitForEvent("download");
    await actions.getByRole("button", { name: "下载", exact: true }).click();
    const menu = page.getByRole("menuitem", { name: "下载当前结果", exact: true });
    if (await menu.isVisible()) await menu.click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    const url = new URL(download.url());
    expect(url.pathname).toBe(expected.immutableUrl);
    expect(url.searchParams.get("download")).toBe("original");
    expect(url.searchParams.has("width")).toBe(false);
    expect(url.searchParams.has("format")).toBe(false);
    expect(await decoded(await readFile((await download.path())!))).toMatchObject({ width: expected.width, height: expected.height, byteLength: expected.byteLength, sha256: expected.sha256 });
}

async function selectStandardSquare(page: Page) {
    await page.getByRole("button", { name: /^生成参数：/ }).click();
    const preferences = page.locator("[data-creative-generation-preferences]");
    await preferences.getByRole("tab", { name: "画面", exact: true }).click();
    await preferences.getByRole("button", { name: "选择图片比例 1:1", exact: true }).click();
    await preferences.getByRole("tab", { name: "输出", exact: true }).click();
    await preferences.getByRole("button", { name: "选择图片画质 中画质", exact: true }).click();
    await page.getByRole("button", { name: /^生成参数：/ }).click();
}

test("SR-M5-07/F13 full-image chain: late A enhancement preserves B and enhanced C uses the saved source", async ({ page, request }, info) => {
    await page.setViewportSize({ width: 1672, height: 941 });
    const root = ownedDataDirectory();
    const fixture = await createBusinessFaultFixture({ root, caseId: `f13-${randomUUID()}`, imagePath: process.env.VOZEB_PRO_M5_BUSINESS_NATIVE_SOURCE!, sceneOutputs: true, native4xDelivery: true });
    const cpuStop = new AbortController();
    const cpuLane = runImageProcessingLane({
        origin: `http://127.0.0.1:${process.env.VOZEB_PRO_E2E_PORT}`,
        token: "vozeb-pro-e2e-worker-token-separate-32chars",
        workerId: "f13:cpu",
        stop: cpuStop.signal,
        idleDelayMs: 2_000,
        supervise: runImageProcessing,
    });
    const browserWorkerRequests: string[] = [];
    page.context().on("request", (entry) => {
        if (new URL(entry.url()).origin === fixture.endpoint) browserWorkerRequests.push(entry.url());
    });
    try {
        await qualify(request, fixture);
        await configureGeneration(request, fixture, false);
        const beforeA = fixture.counts();
        const a = await createOrdinaryA(page, request, fixture, info);
        expect(delta(beforeA, fixture.counts()).generation).toBe(1);
        const originalLog = await nativeLog(request, a.id);
        await configureGeneration(request, fixture, true);
        await fixture.setSceneOutput("b-native", fixture.native, { width: 1254, height: 1254 });
        const aRound = roundFor(page, a.source.asset.id);
        await expect(aRound).toHaveCount(1);
        await aRound.getByRole("button", { name: "原图", exact: true }).click();
        await referenceCurrent(page, aRound.getByLabel("本轮创作操作", { exact: true }));
        await selectStandardSquare(page);
        const beforeB = fixture.counts();
        const bRun = await submitPrompt(page, "修改图片1，场景只加花瓶，保留当前主体和机位。F13-B");
        expect(bRun.conversationId).toBe(a.run.conversationId);
        expect((await waitRun(request, bRun.id, info)).status).toBe("completed");
        const b = await freezeScene(request, root, bRun.id);
        expect(b.run.ecommerceSnapshot!.plan).toMatchObject({ planVersion: "ecommerce-edit.v7", strategy: "full_image", continuity: { parentResultId: a.source.asset.id } });
        expect(b.run.ecommerceSnapshot!.processing!.protection).toBeUndefined();
        expect(b.run.ecommerceSnapshot!.processing!.sceneSelection).toBeUndefined();
        expect(b.run.tasks[0].ecommerceExecution!.mask).toBeUndefined();
        expect(b.run.tasks[0].sceneProtection).toBeUndefined();
        expect(delta(beforeB, fixture.counts()).generation).toBe(1);
        const frozenB = JSON.stringify(await persistedRun(root, bRun.id));
        const bRound = roundFor(page, b.output.asset.id);
        await referenceCurrent(page, bRound.getByLabel("本轮创作操作", { exact: true }));
        const draft = "保留B的原始输入和草稿，等待A增强完成";
        const input = page.getByRole("textbox", { name: "描述你想生成或修改的图片", exact: true });
        await input.fill(draft);
        const beforeLate = fixture.counts();
        await fixture.setFault("ok");
        const delivered = await waitEnhancement(request, a.id, (job) => job.status === "failed" || (job.status === "succeeded" && job.phase === "completed"), info);
        expect(delivered).toMatchObject({ status: "succeeded", phase: "completed", attempt: 1, native: a.pending.native });
        expect(delivered.events.filter((event) => event.stage === "published")).toHaveLength(1);
        expect(delivered.events.filter((event) => event.stage === "receipt_confirmed")).toHaveLength(1);
        const enhancedAsset = (await listedAssets(request, a.run.conversationId)).find((asset) => asset.id === delivered.enhanced!.assetId)!;
        expect(enhancedAsset).toMatchObject({ parentAssetId: a.source.asset.id, metadata: { provenance: "ai_enhanced", enhancementId: a.id, nativeSha256: a.source.sha256 } });
        const enhanced = await immutableImage(request, enhancedAsset);
        expect(enhanced.sha256).toBe(delivered.enhanced!.sha256);
        expect(await mediaSnapshot(root, a.pending.imageTaskId)).toEqual(a.nativeMedia);
        expect(JSON.stringify(await persistedRun(root, bRun.id))).toBe(frozenB);
        await expect(bRound.getByLabel("本轮创作操作", { exact: true })).toHaveAttribute("data-active-asset-id", b.output.asset.id);
        await expect(input).toHaveValue(draft);
        await expect(page.getByRole("button", { name: `移除${b.output.asset.title}`, exact: true })).toBeVisible();
        noCalls(beforeLate, fixture.counts());
        await evidence(info, "full-image-late-publication", { b, enhanced, delivered, originalLog, remote: await fixture.snapshot(), owned: await readOwnedJob(root, a.id) });
        await screenshot(page, info, "full-image-B-after-A-enhancement");

        const refreshPage = await page.context().newPage();
        const restoredMessages = refreshPage.waitForRequest((entry) => new URL(entry.url()).pathname === `/api/creative/conversations/${a.run.conversationId}/messages`);
        let holdFirstDetail = true;
        await refreshPage.route(`**/api/creative/conversations/${a.run.conversationId}`, async (route) => {
            if (!holdFirstDetail) return route.continue();
            holdFirstDetail = false;
            const response = await route.fetch();
            await restoredMessages;
            await route.fulfill({ response });
        });
        await refreshPage.goto(`/create?conversationId=${encodeURIComponent(a.run.conversationId)}`, { waitUntil: "domcontentloaded" });
        await expect(roundFor(refreshPage, b.output.asset.id)).toHaveCount(1);
        await downloadCurrent(refreshPage, roundFor(refreshPage, b.output.asset.id).getByLabel("本轮创作操作", { exact: true }), b.output);
        const refreshedA = roundFor(refreshPage, enhanced.asset.id);
        await expect(refreshedA).toHaveCount(1);
        await refreshedA.getByRole("button", { name: "原图", exact: true }).click();
        await downloadCurrent(refreshPage, roundFor(refreshPage, a.source.asset.id).getByLabel("本轮创作操作", { exact: true }), a.source);
        await roundFor(refreshPage, a.source.asset.id).getByRole("button", { name: "AI增强", exact: true }).click();
        await downloadCurrent(refreshPage, roundFor(refreshPage, enhanced.asset.id).getByLabel("本轮创作操作", { exact: true }), enhanced);
        await referenceCurrent(refreshPage, roundFor(refreshPage, enhanced.asset.id).getByLabel("本轮创作操作", { exact: true }));
        await selectStandardSquare(refreshPage);
        const beforeC = fixture.counts();
        const cRun = await submitPrompt(refreshPage, "修改图片1，场景只加花瓶，以当前增强图片为基础保留机位和主体。F13-C");
        expect(cRun.conversationId).toBe(a.run.conversationId);
        expect((await waitRun(request, cRun.id, info)).status).toBe("completed");
        const c = await freezeScene(request, root, cRun.id);
        expect(c.run.referencedAssetIds).toEqual([enhanced.asset.id]);
        expect(c.run.ecommerceSnapshot!.plan).toMatchObject({ planVersion: "ecommerce-edit.v7", strategy: "full_image", source: { currentSceneBaselineId: enhanced.asset.id } });
        expect(c.run.ecommerceSnapshot!.referenceCheckpoint!.assets.find((entry) => entry.asset.id === enhanced.asset.id)).toMatchObject({ contentSha256: enhanced.sha256 });
        expect(c.run.tasks[0].ecommerceExecution!.mask).toBeUndefined();
        expect(c.run.tasks[0].sceneProtection).toBeUndefined();
        expect(delta(beforeC, fixture.counts()).generation).toBe(1);
        expect(JSON.stringify(await persistedRun(root, bRun.id))).toBe(frozenB);
        expect(browserWorkerRequests).toEqual([]);
        const remote = await fixture.snapshot();
        expect(remote.jobs).toHaveLength(1);
        expect(remote.jobs[0]).toMatchObject({ executionCount: 1, retained: true });
        expect(remote.acceptedReceipts).toHaveLength(1);
        await evidence(info, "full-image-enhanced-reference", { c, enhanced, remote });
        await refreshPage.reload();
        await expect(roundFor(refreshPage, c.output.asset.id)).toHaveCount(1);
        await downloadCurrent(refreshPage, roundFor(refreshPage, c.output.asset.id).getByLabel("本轮创作操作", { exact: true }), c.output);
        await refreshPage.close();
    } finally {
        cpuStop.abort();
        await cpuLane;
        await fixture.close();
    }
});
