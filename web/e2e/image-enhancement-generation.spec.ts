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
import type { CreativeAgentRun, CreativeSceneSelection } from "../src/services/api/creative";
import { createBusinessFaultFixture, mediaSnapshot, ownedDataDirectory, readOwnedJob, readPreloadRecords, sha256 } from "./image-enhancement-business-faults.fixture.mjs";
import { sanitizeRestartEvidence } from "./image-enhancement-restart.lifecycle.mjs";
import { e2eSettingsPatch } from "./support";

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
    expect(asset).toMatchObject({ type: "image", status: "ready", serverUrl: expect.stringMatching(/^\/api\/generation-log-assets\/permanent\//) });
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

async function confirmScene(page: Page, request: APIRequestContext, root: string, run: CreativeAgentRun, source: FrozenImage, info: TestInfo, label: string, area = { left: 0.35, top: 0.15, right: 0.55, bottom: 0.35 }) {
    const waiting = await persistedRun(root, run.id);
    await evidence(info, `${label}-actual-planning-before-selection`, { publicRun: run, persistedRun: waiting, source });
    expect(run.status).toBe("paused");
    expect(waiting.ecommerceSnapshot).toMatchObject({
        mode: "active",
        fallback: { reason: "scene_selection_required" },
        plan: {
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: source.asset.id },
            canvas: { mode: "exact", source: "user_text", size: { width: source.width, height: source.height }, allowReframe: false },
            protection: { scope: "local", preserveOutsideMask: true, allowLightingChange: false },
        },
    });
    expect(run.ecommerceSceneSelection).toEqual({ action: "confirm_scene_selection", baselineAssetId: source.asset.id, url: source.immutableUrl, width: source.width, height: source.height });
    expect(waiting.tasks).toHaveLength(1);
    expect(waiting.tasks[0]).toMatchObject({ status: "needs_review", attempts: 0 });
    expect(waiting.tasks[0].sceneProtection).toBeUndefined();
    const beforeSelection = { taskId: waiting.tasks[0].id, plan: waiting.ecommerceSnapshot!.plan, execution: waiting.tasks[0].ecommerceExecution };
    await expect(page.getByTestId("creative-scene-selection-preview")).toHaveCount(1);
    await page.getByRole("button", { name: "放大图片并选择修改位置", exact: true }).click();
    const panel = page.getByTestId("creative-scene-selection");
    const image = panel.getByRole("img", { name: "选择修改位置的原图", exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await image.hover();
    const bounds = await image.boundingBox();
    expect(bounds).not.toBeNull();
    const start = { x: Math.round(bounds!.x + bounds!.width * area.left), y: Math.round(bounds!.y + bounds!.height * area.top) };
    const end = { x: Math.round(bounds!.x + bounds!.width * area.right), y: Math.round(bounds!.y + bounds!.height * area.bottom) };
    const startPixel = { x: Math.round(((start.x - bounds!.x) / bounds!.width) * source.width), y: Math.round(((start.y - bounds!.y) / bounds!.height) * source.height) };
    const endPixel = { x: Math.round(((end.x - bounds!.x) / bounds!.width) * source.width), y: Math.round(((end.y - bounds!.y) / bounds!.height) * source.height) };
    const intended = { x: startPixel.x, y: startPixel.y, width: endPixel.x - startPixel.x, height: endPixel.y - startPixel.y };
    const pointerFrames = await image.evaluateHandle((element) => {
        const frames: Array<{ type: string; trusted: boolean; at: number; point: { x: number; y: number }; bounds: { x: number; y: number; width: number; height: number } }> = [];
        const record = (event: PointerEvent) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            frames.push({ type: event.type, trusted: event.isTrusted, at: event.timeStamp, point: { x: event.clientX, y: event.clientY }, bounds: { x, y, width, height } });
        };
        element.parentElement!.addEventListener("pointerdown", record, { capture: true, passive: true, once: true });
        element.parentElement!.addEventListener("pointerup", record, { capture: true, passive: true, once: true });
        return frames;
    });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await page.mouse.up();
    const frames = await pointerFrames.jsonValue();
    await pointerFrames.dispose();
    await evidence(info, `${label}-actual-pointer-geometry`, { bounds, start, end, intended, frames });
    expect(frames.map(({ type, trusted, point }) => ({ type, trusted, point }))).toEqual([
        { type: "pointerdown", trusted: true, point: start },
        { type: "pointerup", trusted: true, point: end },
    ]);
    const [observedStart, observedEnd] = frames.map(({ point, bounds }) => ({
        x: Math.round(((point.x - bounds.x) / bounds.width) * source.width),
        y: Math.round(((point.y - bounds.y) / bounds.height) * source.height),
    }));
    const pointerRegion = { x: observedStart.x, y: observedStart.y, width: observedEnd.x - observedStart.x, height: observedEnd.y - observedStart.y };
    await expect(panel.getByTestId("creative-scene-selection-region")).toBeVisible();
    await expect(panel.getByRole("button", { name: "确认修改位置", exact: true })).toBeEnabled();
    await screenshot(page, info, `${label}-actual-user-selection`);
    const confirmedAfter = Date.now();
    const pending = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent/runs/${encodeURIComponent(run.id)}/resume`);
    await panel.getByRole("button", { name: "确认修改位置", exact: true }).click();
    const response = await pending;
    const resumeResult = await response.json().catch(() => null);
    const selection = response.request().postDataJSON().sceneSelection as CreativeSceneSelection;
    await evidence(info, `${label}-actual-selection-response`, { status: response.status(), result: resumeResult, selection, pointer: { bounds, start, end, intended, frames, pointerRegion } });
    expect(response.ok(), JSON.stringify(resumeResult)).toBe(true);
    expect(selection.baselineAssetId).toBe(source.asset.id);
    // Modal animation can change the pre-drag box; trusted event bounds determine actual pixels.
    expect(selection.region).toEqual(pointerRegion);
    expect(resumeResult.data.run.id).toBe(run.id);
    expect((await waitRun(request, run.id, info)).status).toBe("completed");
    const frozen = await freezeScene(request, root, run.id);
    expect(frozen.run.ecommerceSnapshot!.plan).toEqual(beforeSelection.plan);
    expect(frozen.run.tasks[0].id).toBe(beforeSelection.taskId);
    expect(frozen.run.tasks[0].ecommerceExecution).toEqual(beforeSelection.execution);
    expect(frozen.run.tasks[0].sceneProtection).toMatchObject({
        sourceAssetId: source.asset.id,
        sourceSize: { width: source.width, height: source.height },
        selectionSource: "user_selection",
        targetRegion: selection.region,
        confirmation: { actorUserId: frozen.run.userId, confirmedAt: expect.any(Number) },
    });
    expect(frozen.run.tasks[0].sceneProtection!.confirmation!.confirmedAt).toBeGreaterThanOrEqual(confirmedAfter);
    expect(frozen.run.tasks[0].sceneProtection!.confirmation!.confirmedAt).toBeLessThanOrEqual(Date.now());
    await evidence(info, `${label}-actual-completed-selection-and-protection`, { beforeSelection, pointer: { bounds, start, end, intended, frames, pointerRegion }, selection, frozen });
    return { frozen, selection };
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

async function assertScene(request: APIRequestContext, scene: Awaited<ReturnType<typeof freezeScene>>, source: FrozenImage, rootAssetId: string, selection: CreativeSceneSelection) {
    const run = scene.run;
    const continuity = { parentResultId: source.asset.id, sceneRootAssetId: rootAssetId, branchId: `ecommerce-${run.id}` };
    expect(run.referencedAssetIds).toEqual([source.asset.id]);
    expect(run.ecommerceSnapshot).toMatchObject({
        mode: "active",
        input: { assetIds: [source.asset.id] },
        continuity,
        referenceDecision: {
            state: "resolved",
            editTargetId: source.asset.id,
            currentSceneBaselineId: source.asset.id,
            bindings: expect.arrayContaining([expect.objectContaining({ assetId: source.asset.id, alias: "图片1", purposes: ["edit_target"], source: "explicit" })]),
        },
        plan: {
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: source.asset.id, sceneReferenceIds: [] },
            canvas: { mode: "exact", source: "user_text", size: { width: source.width, height: source.height }, allowReframe: false },
            protection: { scope: "local", preserveOutsideMask: true },
            continuity: { parentResultId: source.asset.id, branchId: continuity.branchId },
        },
        technicalCheck: { status: "passed" },
    });
    expect(scene.baseline).toEqual(source);
    expect(scene.output.asset.id).not.toBe(source.asset.id);
    expect(scene.output.asset).toMatchObject({
        parentAssetId: rootAssetId,
        sourceRunId: run.id,
        metadata: { parentAssetIds: [...new Set([rootAssetId, source.asset.id])], ecommerceContinuity: { ...continuity, productAnchorId: null, sceneBaselineId: source.asset.id }, enhancementSkip: { status: "skipped", reason: "not_requested" } },
    });
    expect(scene.output.asset.metadata.provenance).not.toBe("ai_enhanced");
    expect(scene.output.asset.metadata.enhancementId).toBeUndefined();
    expect(scene.output).toMatchObject({ width: source.width, height: source.height });
    const result = scene.persistedResults[0].result!.results![0];
    const sourceSize = { width: source.width, height: source.height };
    const nativeResponse = await request.get(result.canvasEvidence!.nativeUrl!);
    expect(nativeResponse.ok()).toBe(true);
    const nativeBytes = await nativeResponse.body();
    const native = await decoded(nativeBytes);
    expect(native).toMatchObject(sourceSize);
    const sourceResponse = await request.get(source.immutableUrl);
    expect(sourceResponse.ok()).toBe(true);
    const sourceBytes = await sourceResponse.body();
    expect(sha256(sourceBytes)).toBe(source.sha256);
    // The controlled upstream emits PNG even when its source reference is JPG.
    const actualPixels = await sharp(nativeBytes).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer();
    const referencePixels = await sharp(sourceBytes).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer();
    expect(actualPixels.equals(referencePixels)).toBe(true);
    if (source.format === "png") expect(native.sha256).toBe(source.sha256);
    expect(result).toMatchObject({
        serverUrl: scene.output.immutableUrl,
        canvasEvidence: { nativeSize: sourceSize, storedSize: sourceSize, nativeUrl: expect.stringMatching(/^\/api\/generation-log-assets\/permanent\//), normalization: "none" },
        sceneProtectionEvidence: {
            sourceAssetId: source.asset.id,
            sourceDigest: source.sha256,
            sourceSize,
            nativeSize: sourceSize,
            nativeDigest: native.sha256,
            compositeDigest: scene.output.sha256,
            compositeUrl: scene.output.immutableUrl,
            compositeOutsideChangedPixels: 0,
            normalization: "none",
        },
    });
    expect(result.canvasEvidence!.nativeUrl).toBe(result.sceneProtectionEvidence!.nativeUrl);
    expect(result.canvasEvidence!.nativeUrl).not.toBe(scene.output.immutableUrl);
    const task = run.tasks[0];
    expect(task).toMatchObject({
        status: "completed",
        attempts: 1,
        referenceAssetId: source.asset.id,
        referenceUrl: source.immutableUrl,
        references: [{ assetId: source.asset.id, url: source.immutableUrl, width: source.width, height: source.height }],
        sceneProtection: {
            version: "scene-edit-protection.v1",
            sourceAssetId: source.asset.id,
            sourceDigest: source.sha256,
            sourceSize: { width: source.width, height: source.height },
            maskSize: { width: source.width, height: source.height },
            selectionSource: "user_selection",
            targetRegion: selection.region,
            maskSemantics: "alpha_zero_edit",
            method: "source_pixels_copy",
        },
    });
    const protection = task.sceneProtection!;
    const mask = Buffer.from(protection.mask.dataUrl!.split(",")[1], "base64");
    expect(sha256(mask)).toBe(protection.maskDigest);
    const pixels = await sharp(mask, { failOn: "warning" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(pixels.info).toMatchObject({ width: source.width, height: source.height, channels: 4 });
    let wrongAlpha = 0;
    const region = selection.region;
    for (let y = 0; y < source.height; y++)
        for (let x = 0; x < source.width; x++) {
            const inside = x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
            if (pixels.data[(y * source.width + x) * 4 + 3] !== (inside ? 0 : 255)) wrongAlpha++;
        }
    expect(wrongAlpha, "The persisted mask must describe the actual user-selected pixels").toBe(0);
    const checkpoint = run.ecommerceSnapshot!.referenceCheckpoint!.assets.find((item) => item.asset.id === source.asset.id);
    expect(checkpoint).toMatchObject({ asset: source.asset, contentSha256: source.sha256 });
    return {
        continuity,
        sourceDigest: protection.sourceDigest,
        maskDigest: protection.maskDigest,
        sourceVariant: source.asset.metadata.provenance === "ai_enhanced" ? "ai_enhanced" : "provider_native",
        outputKind: "protected_composite",
        native: { url: result.canvasEvidence!.nativeUrl, ...native },
    };
}
async function sourceHashes() {
    const files = [
        "e2e/image-enhancement-generation.spec.ts",
        "e2e/image-enhancement-business-faults.spec.ts",
        "e2e/image-enhancement-business-faults.fixture.mjs",
        "e2e/image-enhancement-restart.lifecycle.mjs",
        "e2e/support.ts",
        "src/lib/server/agent-run-store.ts",
        "src/lib/server/agent-run-surface-policy.ts",
        "src/lib/server/ecommerce-generation-snapshot.ts",
        "src/lib/server/agent-run-executor.ts",
        "src/lib/server/ecommerce-generation-service.ts",
        "src/lib/server/ecommerce-reference-roles.ts",
        "src/lib/server/ecommerce-product-regions.ts",
        "src/lib/server/creative-runtime-store.ts",
        "src/lib/server/image-enhancement-publication.ts",
        "playwright.config.ts",
        "playwright.image-enhancement.config.ts",
        "scripts/run-image-enhancement-e2e.mjs",
        "e2e/image-enhancement.setup.ts",
    ];
    return Promise.all(files.map(async (file) => ({ path: file, sha256: sha256(await readFile(path.resolve(file))) })));
}

test("SR-M5-07/F13 actual frozen scene chain: late A enhancement preserves selected B and explicit enhanced C starts its own native branch", async ({ page, request }, info) => {
    await page.setViewportSize({ width: 1672, height: 941 });
    const root = ownedDataDirectory();
    const fixture = await createBusinessFaultFixture({ root, caseId: `f13-${randomUUID()}`, imagePath: process.env.VOZEB_PRO_M5_BUSINESS_NATIVE_SOURCE!, sceneOutputs: true, native4xDelivery: true });
    const browserWorkerRequests: string[] = [];
    page.context().on("request", (entry) => {
        if (new URL(entry.url()).origin === fixture.endpoint) browserWorkerRequests.push(entry.url());
    });
    const stages: Array<{ stage: string; at: number; counts: Counts; facts: unknown }> = [];
    let phase = "setup";
    let firstFailure: { phase: string; message: string; stack?: string } | undefined;
    let primaryError: unknown;
    const cleanupErrors: Array<{ action: string; message: string }> = [];
    let refreshPage: Page | undefined;
    const record = async (stage: string, facts: unknown) => {
        stages.push({ stage, at: Date.now(), counts: fixture.counts(), facts });
        await evidence(info, "f13-stage-timeline", { kind: "actual app/persistence/assets; controlled LLM and image/enhancement transport bytes; not GPU or visual-quality acceptance", stages });
    };
    try {
        const initialSources = await sourceHashes();
        const preload = await readPreloadRecords(root);
        const sessionResponse = await request.get("/api/auth/session");
        expect(sessionResponse.ok()).toBe(true);
        const user = (await sessionResponse.json()).user;
        expect(user).toMatchObject({ id: expect.any(String), role: "admin" });
        expect(Number.isSafeInteger(timeoutMs) && timeoutMs > 0).toBe(true);
        await qualify(request, fixture);
        await configureGeneration(request, fixture, false);

        phase = "ordinary A and actual pending enhancement";
        const beforeA = fixture.counts();
        const a = await createOrdinaryA(page, request, fixture, info);
        const afterA = fixture.counts();
        expect(delta(beforeA, afterA)).toMatchObject({ generation: 1, analysis: 0 });
        expect(delta(beforeA, afterA).planning).toBeGreaterThan(0);
        const nativeTaskResponse = await request.get(`/api/image-tasks/${encodeURIComponent(a.pending.imageTaskId)}`);
        expect(nativeTaskResponse.ok()).toBe(true);
        const nativeTask = (await nativeTaskResponse.json()).task;
        expect(nativeTask.status).toBe("success");
        const initialLog = await nativeLog(request, a.id);
        const aBefore = await fixture.snapshot();
        expect(aBefore.jobs).toHaveLength(1);
        expect(aBefore.jobs[0]).toMatchObject({ status: "running", executionCount: 1, retained: true });
        expect(aBefore.acceptedReceipts).toEqual([]);
        await record("A actual native saved; synthetic enhancement remains pending", {
            initialSources,
            preload,
            run: a.run,
            nativeRun: a.nativeRun,
            source: a.source,
            nativeTask,
            nativeLog: initialLog,
            publicEnhancement: a.pending,
            ownedEnhancement: await readOwnedJob(root, a.id),
            nativeMedia: a.nativeMedia,
            generationDelta: delta(beforeA, afterA),
            remote: aBefore,
        });

        phase = "B actual explicit original reference and scene planning";
        await configureGeneration(request, fixture, true);
        await fixture.setSceneOutput("b-native", fixture.native, { width: 1254, height: 1254 });
        await page.goto(`/create?conversationId=${encodeURIComponent(a.run.conversationId)}`, { waitUntil: "domcontentloaded" });
        const aRound = roundFor(page, a.source.asset.id);
        await expect(aRound).toHaveCount(1);
        await aRound.getByRole("button", { name: "原图", exact: true }).click();
        await referenceCurrent(page, aRound.getByLabel("本轮创作操作", { exact: true }));
        await expect(page.getByRole("button", { name: `移除${a.source.asset.title}`, exact: true })).toBeVisible();
        const beforeB = fixture.counts();
        const bRun = await submitPrompt(page, "修改图片1，场景只加花瓶，局部修改柜面；保持原图尺寸，选区外保持原样 F13-B");
        expect(bRun.id).not.toBe(a.run.id);
        expect(bRun.conversationId).toBe(a.run.conversationId);
        const bWaiting = await waitRun(request, bRun.id, info);
        phase = "B actual user selection and protection persistence";
        const b = await confirmScene(page, request, root, bWaiting, a.source, info, "B");
        const bGraph = await assertScene(request, b.frozen, a.source, a.source.asset.id, b.selection);
        const frozenB = JSON.stringify(b.frozen);
        const unchangedB = async (name: string) => {
            const current = await freezeScene(request, root, bRun.id);
            const serialized = JSON.stringify(current);
            await evidence(info, name, { b: current, frozenSha256: sha256(Buffer.from(frozenB)), currentSha256: sha256(Buffer.from(serialized)) });
            expect(serialized === frozenB, "Persisted B input, plan, selection/protection, result, variant and complete parent/root/branch facts must remain byte-for-byte equal").toBe(true);
            return current;
        };
        const bDelta = delta(beforeB, fixture.counts());
        expect(bDelta.generation).toBe(1);
        expect(bDelta.analysis).toBeGreaterThan(0);
        expect(bDelta.planning).toBeGreaterThan(0);
        expect((await enhancement(request, a.id)).status).toBe("running");
        expect((await fixture.snapshot()).jobs).toHaveLength(1);
        const bRound = roundFor(page, b.frozen.output.asset.id);
        await expect(bRound).toHaveCount(1);
        await referenceCurrent(page, bRound.getByLabel("本轮创作操作", { exact: true }));
        const draft = "保留 B 的真实编辑基线和未提交草稿，等待 A 的增强晚到 F13";
        const input = page.getByRole("textbox", { name: "描述你想生成或修改的图片", exact: true });
        await input.fill(draft);
        const editor = async () => {
            await expect(aRound.getByLabel("本轮创作操作", { exact: true })).toHaveAttribute("data-active-asset-id", a.source.asset.id);
            await expect(bRound.getByLabel("本轮创作操作", { exact: true })).toHaveAttribute("data-active-asset-id", b.frozen.output.asset.id);
            await expect(input).toHaveValue(draft);
            await expect(page.getByRole("button", { name: `移除${b.frozen.output.asset.title}`, exact: true })).toBeVisible();
            return {
                aActiveAssetId: await aRound.getByLabel("本轮创作操作", { exact: true }).getAttribute("data-active-asset-id"),
                bActiveAssetId: await bRound.getByLabel("本轮创作操作", { exact: true }).getAttribute("data-active-asset-id"),
                selectedReference: b.frozen.output.asset.id,
                draft: await input.inputValue(),
            };
        };
        const frozenEditor = await editor();
        await screenshot(page, info, "f13-B-frozen-before-A-publication");
        await record("B frozen before A publication", { b: b.frozen, selection: b.selection, graph: bGraph, editor: frozenEditor, generationDelta: bDelta });

        phase = "A late actual permanent publication and receipt";
        const beforeLate = fixture.counts();
        let receiptBoundary: unknown;
        let receiptFailure: unknown;
        fixture.beforeReceipt(async (boundary: { job: { jobId: string; retained: boolean }; receipt: unknown; acceptedReceipts: unknown[] }) => {
            try {
                const publishing = await readOwnedJob(root, a.id);
                const listed = await listedAssets(request, a.run.conversationId);
                const children = listed.filter((asset) => asset.metadata.enhancementId === a.id && asset.metadata.provenance === "ai_enhanced");
                expect(boundary.acceptedReceipts).toEqual([]);
                expect(boundary.job).toMatchObject({ jobId: aBefore.jobs[0].jobId, retained: true });
                expect(publishing).toMatchObject({
                    status: "succeeded",
                    phase: "receipt",
                    publication: {
                        publishedAt: expect.any(Number),
                        assetId: expect.any(String),
                        ai: { width: 5016, height: 5016, format: "png", sha256: fixture.expected.sha256 },
                        delivered: { width: 4096, height: 4096, format: "jpeg", url: expect.stringMatching(/\.jpg$/) },
                    },
                });
                expect(children).toHaveLength(1);
                const media = await mediaSnapshot(root, a.id);
                expect(media).toHaveLength(2);
                const retained = await request.get(`${fixture.endpoint}/v1/enhancement-jobs/${boundary.job.jobId}/result`, { headers: { authorization: `Bearer ${fixture.token}`, "x-m5-fixture-observer": "1" } });
                expect(retained.ok()).toBe(true);
                expect(sha256(await retained.body())).toBe(fixture.expected.sha256);
                receiptBoundary = { boundary, publishing, media, child: await immutableImage(request, children[0]), retainedRemoteSha256: fixture.expected.sha256 };
                await record("A actual independent child and permanent bytes exist before receipt acceptance", receiptBoundary);
            } catch (error) {
                receiptFailure = error;
                throw error;
            }
        });
        await fixture.setFault("ok");
        const delivered = await waitEnhancement(request, a.id, (job) => Boolean(receiptFailure) || job.status === "failed" || (job.status === "succeeded" && job.phase === "completed"), info);
        if (receiptFailure) throw receiptFailure;
        expect(receiptBoundary).toBeDefined();
        expect(delivered).toMatchObject({ attempt: 1, native: a.pending.native, enhanced: { width: 4096, height: 4096, assetId: expect.any(String) } });
        expect(delivered).toMatchObject({ status: "succeeded", phase: "completed" });
        expect(delivered.events.filter((event) => event.stage === "published")).toHaveLength(1);
        expect(delivered.events.filter((event) => event.stage === "receipt_confirmed")).toHaveLength(1);
        const published = await readOwnedJob(root, a.id);
        const aiResponse = await request.get(published.publication.ai.url);
        expect(aiResponse.ok()).toBe(true);
        expect(await decoded(await aiResponse.body())).toMatchObject({ width: 5016, height: 5016, byteLength: fixture.expected.byteLength, sha256: fixture.expected.sha256 });
        expect(await mediaSnapshot(root, a.pending.imageTaskId)).toEqual(a.nativeMedia);
        const allAfterPublication = await listedAssets(request, a.run.conversationId);
        const enhancedAsset = allAfterPublication.find((asset) => asset.id === delivered.enhanced!.assetId)!;
        expect(enhancedAsset).toMatchObject({
            sourceRunId: a.run.id,
            sourceTaskId: a.id,
            parentAssetId: a.source.asset.id,
            metadata: { provenance: "ai_enhanced", parentResultId: a.pending.resultId, parentAssetIds: [a.source.asset.id], enhancementId: a.id, nativeSha256: a.source.sha256, sha256: delivered.enhanced!.sha256 },
        });
        expect(enhancedAsset.id).not.toBe(a.source.asset.id);
        const enhanced = await immutableImage(request, enhancedAsset);
        expect(enhanced).toMatchObject({ width: 4096, height: 4096, sha256: delivered.enhanced!.sha256, byteLength: delivered.enhanced!.byteLength });
        expect(enhanced.immutableUrl).not.toBe(a.source.immutableUrl);
        expect(enhanced.sha256).not.toBe(a.source.sha256);
        await unchangedB("B-after-A-publication");
        await expect(aRound.getByRole("button", { name: "AI增强", exact: true })).toBeEnabled();
        expect(await editor()).toEqual(frozenEditor);
        await expect(page.getByRole("button", { name: `移除${enhanced.asset.title}`, exact: true })).toHaveCount(0);
        noCalls(beforeLate, fixture.counts());
        await screenshot(page, info, "f13-B-editor-after-A-publication");
        await record("B unchanged after A publication", { b: await freezeScene(request, root, bRun.id), enhanced, delivered, editor: await editor(), upstreamDelta: delta(beforeLate, fixture.counts()) });

        phase = "actual A/B browser refresh and independent downloads";
        const beforeRefresh = fixture.counts();
        refreshPage = await page.context().newPage();
        await refreshPage.goto(`/create?conversationId=${encodeURIComponent(a.run.conversationId)}`, { waitUntil: "domcontentloaded" });
        await expect(roundFor(refreshPage, b.frozen.output.asset.id)).toHaveCount(1);
        const refreshedA = roundFor(refreshPage, enhanced.asset.id);
        await expect(refreshedA).toHaveCount(1);
        await refreshedA.getByRole("button", { name: "原图", exact: true }).click();
        const refreshedNative = roundFor(refreshPage, a.source.asset.id);
        await downloadCurrent(refreshPage, refreshedNative.getByLabel("本轮创作操作", { exact: true }), a.source);
        await refreshedNative.getByRole("button", { name: "AI增强", exact: true }).click();
        await downloadCurrent(refreshPage, roundFor(refreshPage, enhanced.asset.id).getByLabel("本轮创作操作", { exact: true }), enhanced);
        await refreshPage.reload({ waitUntil: "domcontentloaded" });
        await expect(roundFor(refreshPage, b.frozen.output.asset.id)).toHaveCount(1);
        await unchangedB("B-after-A-and-B-refresh");
        expect(await editor()).toEqual(frozenEditor);
        expect(
            await immutableImage(
                request,
                (await listedAssets(request, a.run.conversationId)).find((asset) => asset.id === a.source.asset.id)!,
            ),
        ).toEqual(a.source);
        const afterNativeTask = await request.get(`/api/image-tasks/${encodeURIComponent(a.pending.imageTaskId)}`);
        expect(afterNativeTask.ok()).toBe(true);
        expect((await afterNativeTask.json()).task).toEqual(nativeTask);
        expect(await runState(request, a.run.id)).toMatchObject({ status: "completed", assetIds: expect.arrayContaining([a.source.asset.id]) });
        expect(await nativeLog(request, a.id)).toEqual(initialLog);
        noCalls(beforeRefresh, fixture.counts());
        await screenshot(refreshPage, info, "f13-refreshed-A-B-persisted-identities");
        await record("B unchanged after actual A/B refresh", { b: await freezeScene(request, root, bRun.id), editor: await editor(), original: a.source, enhanced, upstreamDelta: delta(beforeRefresh, fixture.counts()) });

        phase = "same enhanced asset repeated actual reads and explicit UI references";
        const beforeReferences = fixture.counts();
        const stableJob = await readOwnedJob(root, a.id);
        const stableMedia = await mediaSnapshot(root, a.id);
        const stableWorker = await fixture.snapshot();
        expect(stableWorker.jobs).toHaveLength(1);
        expect(stableWorker.jobs[0]).toMatchObject({ executionCount: 1, retained: true });
        expect(stableWorker.acceptedReceipts).toHaveLength(1);
        expect(stableJob.events.filter((event: { stage: string }) => event.stage === "published")).toHaveLength(1);
        await page.getByRole("button", { name: `移除${b.frozen.output.asset.title}`, exact: true }).click();
        await aRound.getByRole("button", { name: "AI增强", exact: true }).click();
        for (let repeat = 0; repeat < 2; repeat++) {
            await referenceCurrent(page, roundFor(page, enhanced.asset.id).getByLabel("本轮创作操作", { exact: true }));
            await expect(page.getByRole("button", { name: `移除${enhanced.asset.title}`, exact: true })).toBeVisible();
            expect(
                await immutableImage(
                    request,
                    (await listedAssets(request, a.run.conversationId)).find((asset) => asset.id === enhanced.asset.id)!,
                ),
            ).toEqual(enhanced);
            expect(await readOwnedJob(root, a.id)).toEqual(stableJob);
            expect(await mediaSnapshot(root, a.id)).toEqual(stableMedia);
            expect((await fixture.snapshot()).jobs).toEqual(stableWorker.jobs);
            expect((await fixture.snapshot()).acceptedReceipts).toEqual(stableWorker.acceptedReceipts);
            if (repeat === 0) await page.getByRole("button", { name: `移除${enhanced.asset.title}`, exact: true }).click();
        }
        noCalls(beforeReferences, fixture.counts());
        await record("Existing enhancement keeps its identity/provenance through repeated actual reads/references", {
            enhanced,
            ownedEnhancement: stableJob,
            media: stableMedia,
            upstreamDelta: delta(beforeReferences, fixture.counts()),
            saveBoundary: "UI selectAsset only selects an existing asset; existing provider tests separately cover real register/get upserts",
        });

        phase = "C actual explicit enhanced reference and new native scene branch";
        const enhancedResponse = await request.get(enhanced.immutableUrl);
        expect(enhancedResponse.ok()).toBe(true);
        const enhancedBytes = await enhancedResponse.body();
        expect(sha256(enhancedBytes)).toBe(enhanced.sha256);
        const cNative = await sharp(enhancedBytes).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
        await fixture.setSceneOutput("c-native", cNative, { width: 4096, height: 4096 });
        const beforeC = fixture.counts();
        const cRun = await submitPrompt(page, "修改图片1，场景只加花瓶，局部修改柜面；保持原图尺寸，选区外保持原样 F13-C 明确引用AI增强件");
        expect(cRun.conversationId).toBe(a.run.conversationId);
        expect([a.run.id, bRun.id]).not.toContain(cRun.id);
        const cWaiting = await waitRun(request, cRun.id, info);
        const c = await confirmScene(page, request, root, cWaiting, enhanced, info, "C");
        const cGraph = await assertScene(request, c.frozen, enhanced, a.source.asset.id, c.selection);
        expect(cGraph.continuity.branchId).not.toBe(bGraph.continuity.branchId);
        expect([a.source.asset.id, enhanced.asset.id, b.frozen.output.asset.id]).not.toContain(c.frozen.output.asset.id);
        expect(c.frozen.run.ecommerceSnapshot!.referenceCheckpoint!.assets.find((item) => item.asset.id === enhanced.asset.id)).toMatchObject({
            asset: { width: 4096, height: 4096, metadata: { provenance: "ai_enhanced", sha256: enhanced.sha256 } },
            contentSha256: enhanced.sha256,
        });
        const cDelta = delta(beforeC, fixture.counts());
        expect(cDelta.generation).toBe(1);
        expect(cDelta.analysis).toBeGreaterThan(0);
        expect(cDelta.planning).toBeGreaterThan(0);
        await unchangedB("B-after-explicit-C");
        expect(await readOwnedJob(root, a.id)).toEqual(stableJob);
        expect(await mediaSnapshot(root, a.id)).toEqual(stableMedia);
        const enhancementRows = JSON.parse(await readFile(path.join(root, "image-enhancement-jobs.json"), "utf8")) as Array<{ id: string }>;
        expect(enhancementRows.map((row) => row.id)).toEqual([a.id]);
        const finalWorker = await fixture.snapshot();
        expect(finalWorker.jobs).toEqual(stableWorker.jobs);
        expect(finalWorker.acceptedReceipts).toEqual(stableWorker.acceptedReceipts);
        expect(finalWorker.calls.filter((call: { path: string; method: string }) => call.method === "POST" && call.path === "/v1/enhancement-jobs")).toHaveLength(1);
        expect(browserWorkerRequests).toEqual([]);
        await screenshot(page, info, "f13-explicit-C-new-native-branch");
        await record("Explicit enhanced C has a new persisted native result and branch; B remains frozen", {
            c: c.frozen,
            selection: c.selection,
            graph: cGraph,
            b: await freezeScene(request, root, bRun.id),
            generationDelta: cDelta,
            enhancementIds: enhancementRows.map((row) => row.id),
            remote: finalWorker,
        });

        phase = "final passive refresh and source preservation";
        const beforeFinal = fixture.counts();
        const frozenC = JSON.stringify(c.frozen);
        await refreshPage.reload({ waitUntil: "domcontentloaded" });
        await expect(roundFor(refreshPage, c.frozen.output.asset.id)).toHaveCount(1);
        expect(JSON.stringify(await freezeScene(request, root, cRun.id))).toBe(frozenC);
        await unchangedB("B-after-final-passive-refresh");
        expect(
            await immutableImage(
                request,
                (await listedAssets(request, a.run.conversationId)).find((asset) => asset.id === enhanced.asset.id)!,
            ),
        ).toEqual(enhanced);
        await advance(request);
        expect(await readOwnedJob(root, a.id)).toEqual(stableJob);
        expect((await fixture.snapshot()).jobs).toEqual(stableWorker.jobs);
        expect((await fixture.snapshot()).acceptedReceipts).toEqual(stableWorker.acceptedReceipts);
        expect(await nativeLog(request, a.id)).toEqual(initialLog);
        noCalls(beforeFinal, fixture.counts());
        expect(await sourceHashes()).toEqual(initialSources);
        await record("Final passive refresh preserves B/C/A and starts no second enhancement", { upstreamDelta: delta(beforeFinal, fixture.counts()), sourceHashes: await sourceHashes(), browserWorkerRequests });
    } catch (error) {
        primaryError = error;
        firstFailure = { phase, message: error instanceof Error ? error.message : String(error), ...(error instanceof Error ? { stack: error.stack } : {}) };
        try {
            await screenshot(page, info, "f13-first-failure");
        } catch (failure) {
            cleanupErrors.push({ action: "first-failure screenshot", message: String(failure) });
        }
    } finally {
        for (const [action, cleanup] of [
            ["preserve final worker ledger", async () => evidence(info, "f13-final-worker-ledger", await fixture.snapshot())],
            [
                "disable owned application enhancement",
                async () => {
                    const settings = await getData<ImageEnhancementSettings>(request, "/api/admin/image-enhancement");
                    const reply = await request.patch("/api/admin/image-enhancement", { data: { revision: settings.revision, enabled: false } });
                    expect(reply.ok()).toBe(true);
                },
            ],
            ["close refresh page", async () => refreshPage?.close()],
            ["close owned protocol fixture", async () => fixture.close()],
        ] as const) {
            try {
                await cleanup();
            } catch (error) {
                cleanupErrors.push({ action, message: error instanceof Error ? error.message : String(error) });
            }
        }
        try {
            await evidence(info, "f13-outcome", {
                firstFailure: firstFailure || null,
                completed: !firstFailure && cleanupErrors.length === 0,
                phase,
                cleanupErrors,
                stages: stages.map((stage) => ({ stage: stage.stage, at: stage.at, counts: stage.counts })),
                browserWorkerRequests,
            });
        } catch (error) {
            cleanupErrors.push({ action: "preserve final outcome", message: error instanceof Error ? error.message : String(error) });
        }
    }
    if (firstFailure) throw primaryError;
    if (cleanupErrors.length)
        throw new AggregateError(
            cleanupErrors.map((item) => new Error(`${item.action}: ${item.message}`)),
            "F13 cleanup failed after assertions",
        );
});

test("SR-M8 actual protected local scene chain: confirmed baseline enters Worker HTTP and enhanced reference starts a fresh selection", async ({ page, request }, info) => {
    test.skip(process.env.VOZEB_PRO_M8_SCENE_BUSINESS !== "1", "Requires the freshly owned M8 application and controlled HTTP fixtures.");
    await page.setViewportSize({ width: 1672, height: 941 });
    const root = ownedDataDirectory();
    const fixture = await createBusinessFaultFixture({ root, caseId: `m8-${randomUUID()}`, imagePath: process.env.VOZEB_PRO_M5_BUSINESS_NATIVE_SOURCE!, sceneOutputs: true, native4xDelivery: true, protectedBaselineInput: true });
    const size = { width: 1254, height: 1254 };
    const browserWorkerRequests: string[] = [];
    page.context().on("request", (entry) => {
        if (new URL(entry.url()).origin === fixture.endpoint) browserWorkerRequests.push(entry.url());
    });
    const stages: Array<{ stage: string; at: number; counts: Counts; facts: unknown }> = [];
    let phase = "setup";
    let failure: { phase: string; message: string } | undefined;
    let primaryError: unknown;
    const cleanupErrors: Array<{ action: string; message: string }> = [];
    const record = async (stage: string, facts: unknown) => {
        stages.push({ stage, at: Date.now(), counts: fixture.counts(), facts });
        await evidence(info, "m8-stage-timeline", { kind: "actual /create Agent, user selection/resume, image-task guard, persistence and Worker HTTP; controlled synthetic pixels, not GPU or home-photo quality acceptance", stages });
    };
    const image = async (url: string) => {
        const response = await request.get(url);
        expect(response.ok(), url).toBe(true);
        const bytes = await response.body();
        const pixels = await sharp(bytes, { failOn: "warning" }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return { bytes, pixels, ...(await decoded(bytes)) };
    };
    const storedImageTask = async (id: string) => {
        const rows = JSON.parse(await readFile(path.join(root, "generation-tasks.json"), "utf8")) as Array<{ type: string; id: string; payload: ImageTask }>;
        const task = rows.find((row) => row.type === "image" && row.id === id)?.payload;
        expect(task).toBeDefined();
        return task!;
    };
    const selectedUpstreamSha256 = async () => {
        const call = fixture
            .upstreamRequests()
            .filter((entry: { method: string; path: string }) => entry.method === "POST" && entry.path.endsWith("/images/edits"))
            .at(-1);
        expect(call, "A real provider image-edit HTTP request must carry the selected source").toBeDefined();
        const form = await new Response(call.body, { headers: { "content-type": call.contentType } }).formData();
        const file = form.get("image") || form.get("image[]");
        expect(file instanceof File).toBe(true);
        return sha256(Buffer.from(await (file as File).arrayBuffer()));
    };
    try {
        const initialSources = await sourceHashes();
        await qualify(request, fixture);
        await configureGeneration(request, fixture, false);
        phase = "A seed and explicit enhancement cancellation";
        const a = await createOrdinaryA(page, request, fixture, info);
        const cancel = await request.post(`/api/image-enhancements/${encodeURIComponent(a.id)}`, { data: { action: "cancel" } });
        expect(cancel.ok(), await cancel.text()).toBe(true);
        const cancelled = await waitEnhancement(request, a.id, (job) => job.status === "cancelled" || job.status === "failed", info);
        expect(cancelled.status).toBe("cancelled");
        const seedWorker = await fixture.snapshot();
        expect(seedWorker.jobs).toHaveLength(1);
        expect(seedWorker.jobs[0]).toMatchObject({ status: "cancelled", input: { sha256: a.source.sha256 } });
        expect(seedWorker.cancelRequests).toHaveLength(1);
        expect(seedWorker.acceptedReceipts).toEqual([]);
        await record("A real native seed retained; unrelated enhancement explicitly cancelled", { source: a.source, public: cancelled, owned: await readOwnedJob(root, a.id), worker: seedWorker, preload: await readPreloadRecords(root), initialSources });

        phase = "B explicit original reference, current 4K preference and real scene planning";
        await configureGeneration(request, fixture, true);
        const nativeB = await sharp({ create: { ...size, channels: 3, background: "#b14f35" } })
            .png()
            .toBuffer();
        expect(sha256(nativeB)).not.toBe(a.source.sha256);
        await fixture.setSceneOutput("m8-b-native", nativeB, size);
        await page.goto(`/create?conversationId=${encodeURIComponent(a.run.conversationId)}`, { waitUntil: "domcontentloaded" });
        const aRound = roundFor(page, a.source.asset.id);
        await expect(aRound).toHaveCount(1);
        await referenceCurrent(page, aRound.getByLabel("本轮创作操作", { exact: true }));
        await expect(page.getByRole("button", { name: `移除${a.source.asset.title}`, exact: true })).toBeVisible();
        await page.getByRole("button", { name: /^生成参数：/ }).click();
        const preferences = page.locator("[data-creative-generation-preferences]");
        await preferences.getByRole("tab", { name: "输出", exact: true }).click();
        await preferences.getByRole("button", { name: /高画质/ }).click();
        await page.getByRole("button", { name: /^生成参数：/ }).click();
        const beforeB = fixture.counts();
        const bRun = await submitPrompt(page, "修改图片1，场景只加花瓶，局部修改柜面；保持原图尺寸，选区外保持原样 F13-B M8");
        const bWaiting = await waitRun(request, bRun.id, info);
        phase = "B actual pointer selection, confirmation/resume and protected baseline";
        const b = await confirmScene(page, request, root, bWaiting, a.source, info, "M8-B");
        const bTask = await storedImageTask(b.frozen.persistedResults[0].imageTaskId);
        // The UI persists high; the existing 4k alias resolves to this same quality.
        expect(b.frozen.run.generationPreferences?.image?.quality).toBe("high");
        expect(b.frozen.run.tasks[0].quality).toBe("high");
        expect(bTask.config.quality).toBe("high");
        expect(bTask).toMatchObject({
            runId: bRun.id,
            enhancementDelivery: { version: "ecommerce-delivery.v2", scope: "local_edit", baseline: { url: a.source.immutableUrl, sha256: a.source.sha256, ...size }, protection: { scene: b.frozen.run.tasks[0].sceneProtection } },
            sceneProtection: { sourceAssetId: a.source.asset.id, sourceDigest: a.source.sha256, targetRegion: b.selection.region },
        });
        expect(b.frozen.run.referencedAssetIds).toEqual([a.source.asset.id]);
        expect(b.frozen.run.ecommerceSnapshot).toMatchObject({ continuity: { parentResultId: a.source.asset.id, sceneRootAssetId: a.source.asset.id, branchId: `ecommerce-${bRun.id}` }, technicalCheck: { status: "passed" } });
        expect(b.frozen.baseline).toEqual(a.source);
        expect(b.frozen.output.asset).toMatchObject({ parentAssetId: a.source.asset.id, sourceRunId: bRun.id });
        const original = bTask.result!.results![0];
        const id = original.enhancementId!;
        expect(id).toEqual(expect.any(String));
        expect(original.enhancementSkip).toBeUndefined();
        const raw = await image(original.nativeSource!.url);
        const baseline = await image(b.frozen.output.immutableUrl);
        const source = await image(a.source.immutableUrl);
        expect(raw.bytes.equals(nativeB)).toBe(true);
        expect(new Set([source.sha256, raw.sha256, baseline.sha256]).size).toBe(3);
        expect(original.sceneProtectionEvidence).toMatchObject({ sourceDigest: source.sha256, nativeDigest: raw.sha256, compositeDigest: baseline.sha256, compositeOutsideChangedPixels: 0 });
        const mask = Buffer.from(bTask.sceneProtection!.mask.dataUrl!.split(",")[1], "base64");
        expect(sha256(mask)).toBe(bTask.sceneProtection!.maskDigest);
        const decodedMask = await sharp(mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(decodedMask.info).toMatchObject({ ...size, channels: 4 });
        const maskPixels = decodedMask.data;
        let wrongAlpha = 0;
        for (let y = 0; y < size.height; y++)
            for (let x = 0; x < size.width; x++) {
                const region = b.selection.region;
                const inside = x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
                if (maskPixels[(y * size.width + x) * 4 + 3] !== (inside ? 0 : 255)) wrongAlpha++;
            }
        expect(wrongAlpha).toBe(0);
        const compare = (before: Buffer, after: Buffer) => {
            let protectedPixels = 0;
            let allowedPixels = 0;
            let outsideChangedPixels = 0;
            let insideChangedPixels = 0;
            for (let offset = 0; offset < before.length; offset += 4) {
                const changed = !before.subarray(offset, offset + 4).equals(after.subarray(offset, offset + 4));
                if (maskPixels[offset + 3] === 255) {
                    protectedPixels++;
                    if (changed) outsideChangedPixels++;
                } else {
                    allowedPixels++;
                    if (changed) insideChangedPixels++;
                }
            }
            expect(outsideChangedPixels, "All four RGBA channels outside alpha255 must remain identical").toBe(0);
            expect(insideChangedPixels).toBeGreaterThan(0);
            return { protectedPixels, allowedPixels, outsideChangedPixels, insideChangedPixels };
        };
        const baselinePixels = compare(source.pixels.data, baseline.pixels.data);
        const pending = await waitEnhancement(request, id, (job) => job.status === "failed" || (job.status === "running" && job.phase === "poll"), info);
        expect(pending).toMatchObject({
            status: "running",
            phase: "poll",
            native: { sha256: baseline.sha256, provenance: "protected_composite", ...size },
            providerNative: { sha256: raw.sha256 },
            target: size,
            plannedInference: { width: 5016, height: 5016 },
            delivery: { scope: "local_edit", requestedTarget: size },
        });
        const submitted = await fixture.snapshot();
        expect(submitted.fixtureError).toBeUndefined();
        expect(submitted.jobs).toHaveLength(2);
        const remoteB = submitted.jobs.find((job: { jobId: string }) => job.jobId !== seedWorker.jobs[0].jobId)!;
        expect(remoteB).toMatchObject({
            source: { ...size, sha256: baseline.sha256 },
            engineInput: { ...size, sha256: baseline.sha256 },
            input: { ...size, sha256: baseline.sha256, byteLength: baseline.byteLength },
            plan: { sourceSha256: baseline.sha256, scope: "full_image", target: { width: 5016, height: 5016, format: "png" } },
        });
        expect((await readFile(remoteB.input.file)).equals(baseline.bytes)).toBe(true);
        await info.attach("m8-actual-worker-baseline-upload", { path: remoteB.input.file, contentType: "image/png" });
        await info.attach("m8-provider-native", { body: raw.bytes, contentType: "image/png" });
        expect(remoteB.source.sha256).not.toBe(raw.sha256);
        const ownedPending = await readOwnedJob(root, id);
        expect(ownedPending).toMatchObject({ decision: { source: { sha256: raw.sha256 }, delivery: { baseline: { sha256: baseline.sha256 } } }, remotePlan: { sourceSha256: baseline.sha256, planFingerprint: remoteB.plan.planFingerprint } });
        expect(await selectedUpstreamSha256()).toBe(a.source.sha256);
        const bDelta = delta(beforeB, fixture.counts());
        expect(bDelta.generation).toBe(1);
        expect(bDelta.analysis).toBeGreaterThan(0);
        expect(bDelta.planning).toBeGreaterThan(0);
        const bFrozen = JSON.stringify(b.frozen);
        const nativeMedia = await mediaSnapshot(root, bTask.id);
        await record("B real 4K Agent task froze local protection; Worker received exact protected baseline bytes", {
            b: b.frozen,
            selection: b.selection,
            task: bTask,
            public: pending,
            source: { sha256: source.sha256, ...size },
            raw: await decoded(raw.bytes),
            baseline: await decoded(baseline.bytes),
            baselinePixels,
            workerInput: remoteB.input,
            owned: ownedPending,
            generationDelta: bDelta,
        });

        phase = "real image-task inbound 409 guard";
        const guardBefore = fixture.counts();
        const guard = await request.post("/api/image-tasks", {
            data: {
                kind: bTask.kind,
                source: bTask.source,
                prompt: bTask.prompt,
                config: bTask.config,
                references: bTask.references,
                mask: bTask.mask,
                sceneProtection: bTask.sceneProtection,
                ecommerceExecution: bTask.ecommerceExecution,
                context: { runId: bRun.id, parentTaskId: b.frozen.run.tasks[0].id, conversationId: a.run.conversationId, surface: "chat", attemptNo: b.frozen.run.tasks[0].attempts, clientRequestId: randomUUID() },
            },
        });
        const guardResult = await guard.json();
        expect(guard.status()).toBe(409);
        expect(guardResult.error).toBe("场景保护与任务的已确认快照不匹配");
        noCalls(guardBefore, fixture.counts());
        expect(JSON.stringify(await freezeScene(request, root, bRun.id))).toBe(bFrozen);
        await record("Completed confirmed scene snapshot cannot be replayed as a fresh image task", { status: guard.status(), result: guardResult, generationDelta: delta(guardBefore, fixture.counts()) });

        phase = "B permanent complete AI/final publication before real receipt";
        let receiptBoundary: unknown;
        let receiptFailure: unknown;
        fixture.beforeReceipt(async (boundary: { job: { jobId: string }; acceptedReceipts: unknown[] }) => {
            try {
                const persisted = await readOwnedJob(root, id);
                expect(boundary.job.jobId).toBe(remoteB.jobId);
                expect(boundary.acceptedReceipts).toEqual([]);
                expect(persisted).toMatchObject({
                    status: "succeeded",
                    phase: "receipt",
                    publication: { assetId: expect.any(String), protection: { protectedChangedPixels: 0, protectedPixels: baselinePixels.protectedPixels, allowedPixels: baselinePixels.allowedPixels } },
                });
                expect((await image(persisted.publication.ai.url)).sha256).toBe(fixture.expected.sha256);
                expect((await image(persisted.publication.delivered.url)).sha256).toBe(persisted.publication.delivered.sha256);
                expect((await listedAssets(request, a.run.conversationId)).find((asset) => asset.id === persisted.publication.assetId)).toMatchObject({
                    parentAssetId: b.frozen.output.asset.id,
                    metadata: { provenance: "ai_enhanced", scope: "local_edit" },
                });
                receiptBoundary = { persisted, remoteJobId: boundary.job.jobId, permanentMedia: await mediaSnapshot(root, id) };
                await record("B full AI and final bytes plus independent child exist before receipt acceptance", receiptBoundary);
            } catch (error) {
                receiptFailure = error;
                throw error;
            }
        });
        await fixture.setFault("ok");
        const completed = await waitEnhancement(request, id, (job) => Boolean(receiptFailure) || job.status === "failed" || (job.status === "succeeded" && job.phase === "completed"), info);
        if (receiptFailure) throw receiptFailure;
        expect(receiptBoundary).toBeDefined();
        expect(completed).toMatchObject({
            status: "succeeded",
            phase: "completed",
            native: pending.native,
            providerNative: pending.providerNative,
            target: size,
            delivery: { scope: "local_edit", protectedPixels: baselinePixels.protectedPixels, allowedPixels: baselinePixels.allowedPixels, protectedChangedPixels: 0 },
            ai: { width: 5016, height: 5016, sha256: fixture.expected.sha256 },
            enhanced: size,
        });
        for (const stage of ["protection_verified", "published", "receipt_confirmed"]) expect(completed.events.filter((event) => event.stage === stage)).toHaveLength(1);
        const final = await image(completed.enhanced!.url);
        expect(final).toMatchObject({ ...size, format: "png", opaque: true });
        await info.attach("m8-protected-final", { body: final.bytes, contentType: "image/png" });
        const finalPixels = compare(baseline.pixels.data, final.pixels.data);
        expect(new Set([raw.sha256, baseline.sha256, fixture.expected.sha256, final.sha256]).size).toBe(4);
        expect((await image(a.source.immutableUrl)).bytes.equals(source.bytes)).toBe(true);
        expect((await image(b.frozen.output.immutableUrl)).bytes.equals(baseline.bytes)).toBe(true);
        expect(await mediaSnapshot(root, bTask.id)).toEqual(nativeMedia);
        expect(JSON.stringify(await freezeScene(request, root, bRun.id))).toBe(bFrozen);
        const finalAsset = (await listedAssets(request, a.run.conversationId)).find((asset) => asset.id === completed.enhanced!.assetId)!;
        const enhanced = await immutableImage(request, finalAsset);
        expect(finalAsset).toMatchObject({
            sourceRunId: bRun.id,
            sourceTaskId: id,
            parentAssetId: b.frozen.output.asset.id,
            metadata: { provenance: "ai_enhanced", parentResultId: completed.resultId, parentAssetIds: [b.frozen.output.asset.id], enhancementId: id, nativeSha256: raw.sha256, scope: "local_edit" },
        });
        const publicJson = JSON.stringify(completed);
        for (const privateValue of ["maskDataUrl", "data:image/", fixture.token, bTask.sceneProtection!.maskDigest]) expect(publicJson).not.toContain(privateValue);
        const stableWorker = await fixture.snapshot();
        expect(stableWorker.acceptedReceipts).toHaveLength(1);
        expect(stableWorker.acceptedReceipts[0]).toMatchObject({ jobId: remoteB.jobId, receipt: { serviceId: fixture.serviceId, result: fixture.expected } });
        await record("B local final keeps source canvas and zero outside RGBA change; receipt confirmed", { completed, enhanced, finalPixels, worker: stableWorker });

        phase = "B real version downloads and refresh";
        const beforeRead = fixture.counts();
        await page.reload({ waitUntil: "domcontentloaded" });
        const finalRound = roundFor(page, enhanced.asset.id);
        await expect(finalRound).toHaveCount(1);
        await expect(finalRound.getByText(/局部保护增强 · 保持原画幅/)).toBeVisible();
        await finalRound.getByRole("button", { name: "原图", exact: true }).click();
        const baselineRound = roundFor(page, b.frozen.output.asset.id);
        await downloadCurrent(page, baselineRound.getByLabel("本轮创作操作", { exact: true }), b.frozen.output);
        await baselineRound.getByRole("button", { name: "AI增强", exact: true }).click();
        await downloadCurrent(page, roundFor(page, enhanced.asset.id).getByLabel("本轮创作操作", { exact: true }), enhanced);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(roundFor(page, enhanced.asset.id)).toHaveCount(1);
        await screenshot(page, info, "m8-final-local-protection-and-source-size");
        noCalls(beforeRead, fixture.counts());

        phase = "C explicit final reference, lower quality and fresh local selection";
        await referenceCurrent(page, roundFor(page, enhanced.asset.id).getByLabel("本轮创作操作", { exact: true }));
        await expect(page.getByRole("button", { name: `移除${enhanced.asset.title}`, exact: true })).toBeVisible();
        await page.getByRole("button", { name: /^生成参数：/ }).click();
        await preferences.getByRole("tab", { name: "输出", exact: true }).click();
        await preferences.getByRole("button", { name: /中画质/ }).click();
        await page.getByRole("button", { name: /^生成参数：/ }).click();
        await fixture.setSceneOutput("m8-c-native", final.bytes, size);
        const beforeC = fixture.counts();
        const cRun = await submitPrompt(page, "修改图片1，场景只加花瓶，局部修改柜面；保持原图尺寸，选区外保持原样 F13-C M8 明确引用AI增强件");
        const cWaiting = await waitRun(request, cRun.id, info);
        const c = await confirmScene(page, request, root, cWaiting, enhanced, info, "M8-C", { left: 0.6, top: 0.55, right: 0.8, bottom: 0.75 });
        const cGraph = await assertScene(request, c.frozen, enhanced, a.source.asset.id, c.selection);
        const cTask = await storedImageTask(c.frozen.persistedResults[0].imageTaskId);
        expect(c.frozen.run.generationPreferences?.image?.quality).toBe("medium");
        expect(cTask.config.quality).toBe("medium");
        expect(cTask.enhancementDelivery).toBeUndefined();
        expect(cTask.result!.results![0].enhancementId).toBeUndefined();
        expect(cTask.result!.results![0].enhancementSkip).toEqual({ status: "skipped", reason: "not_requested" });
        expect(cTask.sceneProtection!.maskDigest).not.toBe(bTask.sceneProtection!.maskDigest);
        expect(cTask.sceneProtection!.sourceDigest).toBe(final.sha256);
        expect(cTask.sceneProtection!.sourceAssetId).toBe(enhanced.asset.id);
        expect(c.selection.region).not.toEqual(b.selection.region);
        expect(cGraph.continuity).toEqual({ parentResultId: enhanced.asset.id, sceneRootAssetId: a.source.asset.id, branchId: `ecommerce-${cRun.id}` });
        expect(cGraph.continuity.branchId).not.toBe(`ecommerce-${bRun.id}`);
        expect(c.frozen.baseline).toEqual(enhanced);
        expect(await selectedUpstreamSha256()).toBe(final.sha256);
        const cDelta = delta(beforeC, fixture.counts());
        expect(cDelta.generation).toBe(1);
        expect(cDelta.analysis).toBeGreaterThan(0);
        expect(cDelta.planning).toBeGreaterThan(0);
        expect(JSON.stringify(await freezeScene(request, root, bRun.id))).toBe(bFrozen);
        const afterC = await fixture.snapshot();
        expect(afterC.jobs).toEqual(stableWorker.jobs);
        expect(afterC.acceptedReceipts).toEqual(stableWorker.acceptedReceipts);
        expect(afterC.calls.filter((call: { method: string; path: string }) => call.method === "POST" && call.path === "/v1/enhancement-jobs")).toHaveLength(2);
        expect(browserWorkerRequests).toEqual([]);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(roundFor(page, c.frozen.output.asset.id)).toHaveCount(1);
        expect(JSON.stringify(await freezeScene(request, root, cRun.id))).toBe(JSON.stringify(c.frozen));
        expect(
            await immutableImage(
                request,
                (await listedAssets(request, a.run.conversationId)).find((asset) => asset.id === enhanced.asset.id)!,
            ),
        ).toEqual(enhanced);
        const enhancementRows = JSON.parse(await readFile(path.join(root, "image-enhancement-jobs.json"), "utf8")) as Array<{ id: string }>;
        expect(enhancementRows.map((row) => row.id).sort()).toEqual([a.id, id].sort());
        expect((await fixture.snapshot()).jobs).toEqual(stableWorker.jobs);
        expect((await fixture.snapshot()).acceptedReceipts).toEqual(stableWorker.acceptedReceipts);
        expect(await sourceHashes()).toEqual(initialSources);
        await screenshot(page, info, "m8-explicit-enhanced-C-new-selection");
        await record("C real final-byte provider upload uses new baseline, selection and branch; B/source preserved", {
            c: c.frozen,
            selection: c.selection,
            graph: cGraph,
            task: cTask,
            selectedUploadSha256: final.sha256,
            generationDelta: cDelta,
            enhancementIds: enhancementRows.map((row) => row.id),
            worker: afterC,
            browserWorkerRequests,
        });
    } catch (error) {
        primaryError = error;
        failure = { phase, message: error instanceof Error ? error.message : String(error) };
        try {
            await screenshot(page, info, "m8-first-failure");
        } catch (error) {
            cleanupErrors.push({ action: "first-failure screenshot", message: String(error) });
        }
    } finally {
        for (const [action, cleanup] of [
            ["preserve Worker ledger", async () => evidence(info, "m8-final-worker-ledger", await fixture.snapshot())],
            [
                "disable owned enhancement",
                async () => {
                    const settings = await getData<ImageEnhancementSettings>(request, "/api/admin/image-enhancement");
                    const reply = await request.patch("/api/admin/image-enhancement", { data: { revision: settings.revision, enabled: false } });
                    expect(reply.ok()).toBe(true);
                },
            ],
            ["close owned fixture", async () => fixture.close()],
        ] as const) {
            try {
                await cleanup();
            } catch (error) {
                cleanupErrors.push({ action, message: error instanceof Error ? error.message : String(error) });
            }
        }
        await evidence(info, "m8-outcome", { firstFailure: failure || null, completed: !failure && cleanupErrors.length === 0, phase, cleanupErrors, stages: stages.map(({ stage, at, counts }) => ({ stage, at, counts })), browserWorkerRequests });
    }
    if (failure) throw primaryError;
    if (cleanupErrors.length)
        throw new AggregateError(
            cleanupErrors.map(({ action, message }) => new Error(`${action}: ${message}`)),
            "M8 cleanup failed after assertions",
        );
});
