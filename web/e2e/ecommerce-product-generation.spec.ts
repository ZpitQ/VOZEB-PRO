import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectNoHorizontalOverflow } from "./responsive-helpers";
import { protocolFixtureState, resetProtocolFixture } from "./support";

type GoldenCase = {
    id: string;
    category: string;
    productFileName: string;
    fixturePath: string;
    fixtureSha256: string;
    sceneFixturePath?: string;
    sceneFixtureSha256?: string;
    userRequest: string;
    expectedOperation: string;
    hardProtections: string[];
};
type PublicRun = {
    id: string;
    status: string;
    failure?: string;
    conversationId: string;
    assetIds?: string[];
    tasks?: Array<{
        id: string;
        status: string;
        childTasks?: Array<{ id: string; status: string }>;
    }>;
    ecommerceQualityStatus?: string;
};
type TraceModel = {
    logicalRole?: string;
    capability?: string;
    logicalModelId?: string;
    channelId?: string;
    upstreamModel?: string;
    apiFormat?: string;
};
type TraceReference = { assetId: string; role: "product" | "scene" };
type TraceQualityCheck = {
    resultId: string;
    key: string;
    status: "passed" | "failed" | "not_applicable";
    reason: string;
};
type TraceStage = {
    key: "visual_analysis" | "edit_planning" | "image_generation" | "quality_check";
    status: string;
    model?: TraceModel;
    output: {
        references?: TraceReference[];
        operation?: string;
        source?: {
            productAnchorId?: string;
            currentSceneBaselineId?: string | null;
            sceneReferenceIds?: string[];
        };
        preserve?: { productCore?: string[] };
        continuity?: { parentResultId?: string | null };
        executionPrompt?: string;
        referenceRoles?: TraceReference[];
        mask?: { mode?: string; required?: boolean };
        imageTaskIds?: string[];
        checks?: TraceQualityCheck[];
        hardFailures?: TraceQualityCheck[];
    };
};
type EcommerceTrace = {
    runId: string;
    imageTaskIds: string[];
    stages: TraceStage[];
    finalStatus: string;
};

const QUALITY_CHECKS = ["product_identity", "product_silhouette", "product_color_material", "product_proportions_view", "brand_logo", "packaging_text", "scene_intent", "composition_lighting"] as const;
const MODEL_ROUTES: Record<TraceStage["key"], Required<TraceModel>> = {
    visual_analysis: {
        logicalRole: "vision_analysis",
        capability: "text",
        logicalModelId: "e2e-ecommerce-vision",
        channelId: "e2e-primary",
        upstreamModel: "e2e-ecommerce-vision-upstream",
        apiFormat: "openai",
    },
    edit_planning: {
        logicalRole: "edit_planning",
        capability: "text",
        logicalModelId: "e2e-ecommerce-planner",
        channelId: "e2e-primary",
        upstreamModel: "e2e-ecommerce-planner-upstream",
        apiFormat: "openai",
    },
    image_generation: {
        logicalRole: "image_generation",
        capability: "image",
        logicalModelId: "e2e-ecommerce-image",
        channelId: "e2e-primary",
        upstreamModel: "gpt-image-2.5-flare",
        apiFormat: "openai",
    },
    quality_check: {
        logicalRole: "quality_check",
        capability: "text",
        logicalModelId: "e2e-ecommerce-quality",
        channelId: "e2e-primary",
        upstreamModel: "e2e-ecommerce-quality-upstream",
        apiFormat: "openai",
    },
};

const cases = JSON.parse(readFileSync(new URL("./fixtures/ecommerce-product-cases.json", import.meta.url), "utf8")) as GoldenCase[];
const fixtureBytes = new Map<string, { buffer: Buffer; sha256: string }>();
let pausedRunForCleanup: { runId: string; conversationId: string } | undefined;

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
    pausedRunForCleanup = undefined;
    await resetProtocolFixture(request);
});

test.afterEach(async ({ request }) => {
    if (!pausedRunForCleanup) return;
    const response = await request.post(`/api/agent/runs/${encodeURIComponent(pausedRunForCleanup.runId)}/cancel`, {
        data: { conversationId: pausedRunForCleanup.conversationId },
    });
    if (!response.ok()) throw new Error(`Unable to clean up paused ecommerce run: ${response.status()} ${await response.text()}`);
    pausedRunForCleanup = undefined;
});

for (const goldenCase of cases) {
    test(`${goldenCase.category}白底或透明底商品可从一句话生成场景`, async ({ page, request }, testInfo) => {
        test.skip(testInfo.project.name !== "chromium", "完整类别回归只在桌面 Chromium 执行");

        const created = await submitProductScene(page, goldenCase);
        const run = await waitForRun(request, created.runId, "completed");
        expect(run.ecommerceQualityStatus).toBe("passed");
        await expectProductResult(page);
        await expectPublicProgress(request, run.id);
        const trace = await expectAdminTrace(request, run.id, "passed");
        expectSuccessfulTrace(trace, {
            operation: goldenCase.expectedOperation,
            hardProtections: goldenCase.hardProtections,
            userRequest: goldenCase.userRequest,
        });

        const state = await protocolFixtureState(request);
        expect(state.requests.some((item) => item.path.endsWith("/images/edits") && item.contentType.includes("multipart/form-data"))).toBe(true);
    });
}

test("可选场景参考仍以商品为锚点并在刷新后恢复结果", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "连续性回归只在桌面 Chromium 执行");
    const goldenCase = cases[5];
    const created = await submitProductScene(page, goldenCase, {
        sceneReference: true,
    });
    const run = await waitForRun(request, created.runId, "completed");
    const trace = await expectAdminTrace(request, run.id, "passed");
    expectSuccessfulTrace(trace, {
        operation: goldenCase.expectedOperation,
        hardProtections: goldenCase.hardProtections,
        userRequest: goldenCase.userRequest,
        sceneReferenceCount: 1,
    });
    const visualStage = traceStage(trace, "visual_analysis");
    const planningStage = traceStage(trace, "edit_planning");
    const productReference = visualStage.output.references?.find((reference) => reference.role === "product");
    const sceneReference = visualStage.output.references?.find((reference) => reference.role === "scene");
    expect(productReference).toBeDefined();
    expect(sceneReference).toBeDefined();
    expect(productReference?.assetId).not.toBe(sceneReference?.assetId);
    expect(planningStage.output.source).toMatchObject({
        productAnchorId: productReference?.assetId,
        sceneReferenceIds: [sceneReference?.assetId],
    });
    await expectProductResult(page);
    const resultSource = await page.getByTestId("creative-media-result").last().getByRole("img").getAttribute("src");
    expect(resultSource).toMatch(/^\/api\/generation-log-assets\/permanent\/.+\.png(?:\?.*)?$/);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(page.getByTestId("creative-media-result").last().getByRole("img")).toHaveAttribute("src", resultSource!);
    expect(run.assetIds?.length).toBeGreaterThan(0);
});

test("连续编辑默认继承最近结果并可从较早结果建立分支", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "连续性回归只在桌面 Chromium 执行");
    const first = await submitProductScene(page, cases[0]);
    const firstRun = await waitForRun(request, first.runId, "completed");
    const firstTrace = await expectAdminTrace(request, firstRun.id, "passed");
    expectSuccessfulTrace(firstTrace, {
        operation: cases[0].expectedOperation,
        hardProtections: cases[0].hardProtections,
        userRequest: cases[0].userRequest,
    });
    const originalProductAnchorId = traceStage(firstTrace, "edit_planning").output.source?.productAnchorId;
    expect(originalProductAnchorId).toBeTruthy();
    await expectProductResult(page);

    const secondPrompt = "让场景光线再亮一点。";
    const second = await submitPrompt(page, secondPrompt, { reusePage: true });
    const secondRun = await waitForRun(request, second.runId, "completed");
    const secondTrace = await expectAdminTrace(request, secondRun.id, "passed");
    expectSuccessfulTrace(secondTrace, {
        operation: "local_edit",
        hardProtections: cases[0].hardProtections,
        userRequest: secondPrompt,
    });
    expect(traceStage(secondTrace, "edit_planning").output).toMatchObject({
        operation: "local_edit",
        source: {
            productAnchorId: originalProductAnchorId,
            currentSceneBaselineId: firstRun.assetIds?.[0],
        },
        continuity: { parentResultId: firstRun.assetIds?.[0] },
    });
    expect(secondRun.assetIds?.[0]).not.toBe(firstRun.assetIds?.[0]);

    const roundActionButtons = page.getByRole("button", {
        name: "更多本轮创作操作",
    });
    await expect(roundActionButtons).toHaveCount(2);
    await roundActionButtons.first().click();
    await page.getByRole("menuitem", { name: "引用结果" }).click();
    const branchPrompt = "从这张较早结果把背景改成现代厨房。";
    const branch = await submitPrompt(page, branchPrompt, { reusePage: true });
    const branchRun = await waitForRun(request, branch.runId, "completed");
    const branchTrace = await expectAdminTrace(request, branchRun.id, "passed");
    expectSuccessfulTrace(branchTrace, {
        operation: "local_edit",
        hardProtections: cases[0].hardProtections,
        userRequest: branchPrompt,
    });
    expect(traceStage(branchTrace, "edit_planning").output).toMatchObject({
        operation: "local_edit",
        source: {
            productAnchorId: originalProductAnchorId,
            currentSceneBaselineId: firstRun.assetIds?.[0],
        },
        continuity: { parentResultId: firstRun.assetIds?.[0] },
    });
    expect(branchRun.assetIds?.[0]).not.toBe(firstRun.assetIds?.[0]);
    expect(branchRun.assetIds?.[0]).not.toBe(secondRun.assetIds?.[0]);

    const assets = await conversationAssets(request, branchRun.conversationId);
    const branchAsset = assets.find((asset) => asset.id === branchRun.assetIds?.[0]);
    expect(branchAsset?.metadata?.ecommerceContinuity).toMatchObject({
        parentResultId: firstRun.assetIds?.[0],
    });
    expect(assets.map((asset) => asset.id)).toEqual(expect.arrayContaining([firstRun.assetIds?.[0], secondRun.assetIds?.[0], branchRun.assetIds?.[0]]));
});

test("角色歧义会暂停并且不会提交图片 provider", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "异常路径回归只在桌面 Chromium 执行");
    const ambiguous = {
        ...cases[0],
        productFileName: "ambiguous-reference.webp",
        userRequest: "根据这张无法判断角色的图片生成一个家居场景。",
    };
    const created = await submitProductScene(page, ambiguous);
    pausedRunForCleanup = created;
    await waitForRun(request, created.runId, "paused");
    await expect(page.getByText("请确认这张图片是商品图还是场景参考图。", { exact: true })).toBeVisible();
    const state = await protocolFixtureState(request);
    expect(state.requests.some((item) => item.path.endsWith("/images/edits") || item.path.endsWith("/images/generations"))).toBe(false);
});

test("严格商品验收失败会给出明确复核提示且不发布结果", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "异常路径回归只在桌面 Chromium 执行");
    const strictFailure = {
        ...cases[0],
        userRequest: "生成现代客厅场景并故意改变商品轮廓以触发严格商品失败。",
    };
    const created = await submitProductScene(page, strictFailure);
    pausedRunForCleanup = created;
    const run = await waitForRun(request, created.runId, "paused");
    expect(run.ecommerceQualityStatus).toBe("needs_review");
    expect(run.assetIds ?? []).toEqual([]);
    await expect(page.getByText("商品一致性检查未通过，需要复核。", { exact: true })).toBeVisible();
    await expect(page.getByTestId("creative-media-result")).toHaveCount(0);
    const trace = await expectAdminTrace(request, run.id, "needs_review");
    expectTraceRoutes(trace);
    const qualityStage = traceStage(trace, "quality_check");
    expect(qualityStage.status).toBe("blocked");
    expect(qualityStage.output.hardFailures).toEqual(expect.arrayContaining([expect.objectContaining({ key: "product_silhouette", status: "failed" })]));
    expect(trace.finalStatus).toBe("needs_review");
    const assets = await conversationAssets(request, run.conversationId);
    expect(assets).toHaveLength(2);
    const uploadedProduct = assets.find((asset) => asset.metadata?.source === "upload");
    expect(uploadedProduct).toMatchObject({
        type: "image",
        metadata: { source: "upload" },
    });
    const internalResult = assets.find((asset) => asset.sourceRunId === run.id);
    expect(internalResult).toMatchObject({
        type: "image",
        status: "ready",
    });
    expect(internalResult?.sourceTaskId).toBeTruthy();
    expect(run.assetIds).not.toContain(internalResult?.id);
});

test("移动端可完成一句话商品场景生成且没有横向溢出", async ({ page, request }, testInfo) => {
    test.skip(!["mobile-390", "mobile-430"].includes(testInfo.project.name), "移动端专项");
    const created = await submitProductScene(page, cases[6]);
    await waitForRun(request, created.runId, "completed");
    await expectProductResult(page);
    await expectNoHorizontalOverflow(page, `ecommerce product generation ${testInfo.project.name}`);
});

async function submitProductScene(page: Page, goldenCase: GoldenCase, options: { sceneReference?: boolean } = {}) {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await selectImageMode(page);
    const product = uploadFixture(goldenCase.fixturePath, goldenCase.productFileName, goldenCase.fixtureSha256);
    let files = [product];
    if (options.sceneReference) {
        if (!goldenCase.sceneFixturePath || !goldenCase.sceneFixtureSha256) throw new Error(`${goldenCase.id} is missing its scene fixture path or SHA-256`);
        files = [product, uploadFixture(goldenCase.sceneFixturePath, "modern-living-room.webp", goldenCase.sceneFixtureSha256)];
    }
    await page.locator('input[type="file"][multiple]').setInputFiles(files);
    for (const file of files)
        await expect(page.getByLabel(`已上传图片 ${file.name}`)).toBeVisible({
            timeout: 30_000,
        });
    return submitPrompt(page, goldenCase.userRequest, { reusePage: true });
}

async function submitPrompt(page: Page, prompt: string, options: { reusePage?: boolean } = {}) {
    if (!options.reusePage) await page.goto("/create", { waitUntil: "domcontentloaded" });
    const textbox = page.getByRole("textbox", {
        name: "描述你想生成或修改的图片",
    });
    await textbox.fill(prompt);
    const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const response = await responsePromise;
    expect(response.ok(), await response.text()).toBe(true);
    const payload = (await response.json()) as { data: { run: PublicRun } };
    return {
        runId: payload.data.run.id,
        conversationId: payload.data.run.conversationId,
    };
}

async function selectImageMode(page: Page) {
    await expect(page.getByRole("button", { name: /当前创作类型：/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /生成模型：/ })).toBeVisible();
}

function uploadFixture(relativePath: string, name: string, expectedSha256: string) {
    let fixture = fixtureBytes.get(relativePath);
    if (!fixture) {
        const buffer = readFileSync(new URL(relativePath, import.meta.url));
        fixture = {
            buffer,
            sha256: createHash("sha256").update(buffer).digest("hex"),
        };
        fixtureBytes.set(relativePath, fixture);
    }
    if (fixture.sha256 !== expectedSha256.toLowerCase()) {
        throw new Error(`Fixture SHA-256 mismatch for ${relativePath}: expected ${expectedSha256}, received ${fixture.sha256}`);
    }
    return {
        name,
        mimeType: fixtureMimeType(relativePath),
        buffer: fixture.buffer,
    };
}

function fixtureMimeType(relativePath: string) {
    const extension = extname(relativePath).toLowerCase();
    if (extension === ".webp") return "image/webp";
    if (extension === ".png") return "image/png";
    if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
    throw new Error(`Unsupported ecommerce fixture extension: ${extension || "(none)"}`);
}

async function waitForRun(request: APIRequestContext, runId: string, expectedStatus: "completed" | "paused") {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        const response = await request.get(`/api/agent/runs/${runId}`);
        expect(response.ok(), await response.text()).toBe(true);
        const run = ((await response.json()) as { data: { run: PublicRun } }).data.run;
        if (run.status === expectedStatus) return run;
        if (["failed", "cancelled"].includes(run.status)) throw new Error(`Agent run ${runId} ended as ${run.status}: ${run.failure || "no failure detail"}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Agent run ${runId} did not reach ${expectedStatus} within 90000ms`);
}

async function expectProductResult(page: Page) {
    const result = page.getByTestId("creative-media-result").last();
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result.getByTestId("creative-primary-result").getByRole("img")).toHaveAttribute("src", /\/api\/generation-log-assets\/permanent\/.+\.png/);
}

async function expectPublicProgress(request: APIRequestContext, runId: string) {
    const response = await request.get(`/api/agent/runs/${runId}/events`, {
        headers: { "Last-Event-ID": "0" },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = await response.text();
    expect(body).toContain("正在识别商品");
    expect(body).toContain("正在规划场景");
    expect(body).toContain("正在生成图片");
    expect(body).toContain("正在检查商品细节");
    expect(body).not.toContain("ecommerceSnapshot");
}

async function expectAdminTrace(request: APIRequestContext, runId: string, finalStatus: "passed" | "needs_review") {
    let matchedTrace: EcommerceTrace | undefined;
    await expect
        .poll(
            async () => {
                const response = await request.get("/api/admin/generation-logs?page=1&pageSize=100");
                if (!response.ok()) return null;
                const payload = (await response.json()) as {
                    logs: Array<{ ecommerceTrace?: EcommerceTrace }>;
                };
                matchedTrace = payload.logs.find((log) => log.ecommerceTrace?.runId === runId)?.ecommerceTrace;
                return matchedTrace || null;
            },
            { timeout: 30_000 },
        )
        .toMatchObject({
            runId,
            finalStatus,
            stages: expect.arrayContaining([expect.objectContaining({ key: "visual_analysis" }), expect.objectContaining({ key: "edit_planning" }), expect.objectContaining({ key: "image_generation" }), expect.objectContaining({ key: "quality_check" })]),
        });
    if (!matchedTrace) throw new Error(`Ecommerce trace for run ${runId} disappeared after polling`);
    return matchedTrace;
}

function expectSuccessfulTrace(
    trace: EcommerceTrace,
    expected: {
        operation: string;
        hardProtections: string[];
        userRequest: string;
        sceneReferenceCount?: number;
    },
) {
    expectTraceRoutes(trace);
    expect(trace.finalStatus).toBe("passed");
    expect(trace.imageTaskIds).toHaveLength(1);

    const planningStage = traceStage(trace, "edit_planning");
    expect(planningStage.status).toBe("completed");
    expect(planningStage.output.operation).toBe(expected.operation);
    expect(planningStage.output.preserve?.productCore).toEqual(expected.hardProtections);

    const source = planningStage.output.source;
    expect(source?.productAnchorId).toBeTruthy();
    expect(source?.sceneReferenceIds ?? []).toHaveLength(expected.sceneReferenceCount ?? 0);
    const expectedReferences: TraceReference[] = [];
    if (expected.operation === "local_edit" && source?.currentSceneBaselineId)
        expectedReferences.push({
            assetId: source.currentSceneBaselineId,
            role: "scene",
        });
    if (source?.productAnchorId)
        expectedReferences.push({
            assetId: source.productAnchorId,
            role: "product",
        });
    for (const assetId of source?.sceneReferenceIds ?? []) expectedReferences.push({ assetId, role: "scene" });

    const generationStage = traceStage(trace, "image_generation");
    expect(generationStage.status).toBe("completed");
    expect(generationStage.output.executionPrompt).toContain(expected.userRequest);
    expect(generationStage.output.executionPrompt).toContain(expected.operation);
    for (const protection of expected.hardProtections) expect(generationStage.output.executionPrompt).toContain(protection);
    expect(generationStage.output.mask).toEqual({
        mode: "independent",
        required: true,
    });
    expect(generationStage.output.referenceRoles).toEqual(expectedReferences);
    expect(generationStage.output.imageTaskIds).toEqual(trace.imageTaskIds);

    const qualityStage = traceStage(trace, "quality_check");
    expect(qualityStage.status).toBe("passed");
    const checks = qualityStage.output.checks ?? [];
    expect(checks).toHaveLength(QUALITY_CHECKS.length);
    expect(checks.map((check) => check.key)).toEqual(QUALITY_CHECKS);
    for (const check of checks) {
        expect(check.resultId).toBe(trace.imageTaskIds[0]);
        expect(check.reason).not.toBe("");
        expect(check.status).toBe(["brand_logo", "packaging_text"].includes(check.key) ? "not_applicable" : "passed");
    }
    expect(qualityStage.output.hardFailures).toEqual([]);
}

function expectTraceRoutes(trace: EcommerceTrace) {
    expect(trace.stages.map((stage) => stage.key)).toEqual(["visual_analysis", "edit_planning", "image_generation", "quality_check"]);
    for (const stage of trace.stages) expect(stage.model).toMatchObject(MODEL_ROUTES[stage.key]);
}

function traceStage(trace: EcommerceTrace, key: TraceStage["key"]) {
    const stage = trace.stages.find((candidate) => candidate.key === key);
    if (!stage) throw new Error(`Ecommerce trace for run ${trace.runId} is missing ${key}`);
    return stage;
}

async function conversationAssets(request: APIRequestContext, conversationId: string) {
    const response = await request.get(`/api/creative/conversations/${conversationId}/assets`);
    expect(response.ok(), await response.text()).toBe(true);
    const payload = (await response.json()) as {
        data: {
            assets: Array<{
                id: string;
                type?: string;
                metadata?: {
                    source?: string;
                    agentTaskId?: string;
                    ecommerceContinuity?: Record<string, unknown>;
                };
            }>;
        };
    };
    return payload.data.assets;
}
