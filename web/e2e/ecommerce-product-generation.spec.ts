import { readFileSync } from "node:fs";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import sharp from "sharp";

import { expectNoHorizontalOverflow } from "./responsive-helpers";
import { protocolFixtureState, resetProtocolFixture } from "./support";

type GoldenCase = {
    id: string;
    category: string;
    productFileName: string;
    fixturePath: string;
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
    tasks?: Array<{ id: string; status: string; childTasks?: Array<{ id: string; status: string }> }>;
    ecommerceQualityStatus?: string;
};

const cases = JSON.parse(readFileSync(new URL("./fixtures/ecommerce-product-cases.json", import.meta.url), "utf8")) as GoldenCase[];
const fixtureBytes = new Map<string, Buffer>();
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
        await expectAdminTrace(request, run.id, "passed");

        const state = await protocolFixtureState(request);
        expect(state.requests.some((item) => item.path.endsWith("/images/edits") && item.contentType.includes("multipart/form-data"))).toBe(true);
    });
}

test("可选场景参考仍以商品为锚点并在刷新后恢复结果", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "连续性回归只在桌面 Chromium 执行");
    const goldenCase = cases[5];
    const created = await submitProductScene(page, goldenCase, { sceneReference: true });
    const run = await waitForRun(request, created.runId, "completed");
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
    await expectProductResult(page);

    const second = await submitPrompt(page, "让场景光线再亮一点。", { reusePage: true });
    const secondRun = await waitForRun(request, second.runId, "completed");
    expect(secondRun.assetIds?.[0]).not.toBe(firstRun.assetIds?.[0]);

    const roundActionButtons = page.getByRole("button", { name: "更多本轮创作操作" });
    await expect(roundActionButtons).toHaveCount(2);
    await roundActionButtons.first().click();
    await page.getByRole("menuitem", { name: "引用结果" }).click();
    const branch = await submitPrompt(page, "从这张较早结果把背景改成现代厨房。", { reusePage: true });
    const branchRun = await waitForRun(request, branch.runId, "completed");
    expect(branchRun.assetIds?.[0]).not.toBe(firstRun.assetIds?.[0]);
    expect(branchRun.assetIds?.[0]).not.toBe(secondRun.assetIds?.[0]);

    const assets = await conversationAssets(request, branchRun.conversationId);
    const branchAsset = assets.find((asset) => asset.id === branchRun.assetIds?.[0]);
    expect(branchAsset?.metadata?.ecommerceContinuity).toMatchObject({ parentResultId: firstRun.assetIds?.[0] });
    expect(assets.map((asset) => asset.id)).toEqual(expect.arrayContaining([firstRun.assetIds?.[0], secondRun.assetIds?.[0], branchRun.assetIds?.[0]]));
});

test("角色歧义会暂停并且不会提交图片 provider", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "异常路径回归只在桌面 Chromium 执行");
    const ambiguous = { ...cases[0], productFileName: "ambiguous-reference.webp", userRequest: "根据这张无法判断角色的图片生成一个家居场景。" };
    const created = await submitProductScene(page, ambiguous);
    pausedRunForCleanup = created;
    await waitForRun(request, created.runId, "paused");
    await expect(page.getByText("请确认这张图片是商品图还是场景参考图。", { exact: true })).toBeVisible();
    const state = await protocolFixtureState(request);
    expect(state.requests.some((item) => item.path.endsWith("/images/edits") || item.path.endsWith("/images/generations"))).toBe(false);
});

test("严格商品验收失败会给出明确复核提示且不发布结果", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "异常路径回归只在桌面 Chromium 执行");
    const strictFailure = { ...cases[0], userRequest: "生成现代客厅场景并故意改变商品轮廓以触发严格商品失败。" };
    const created = await submitProductScene(page, strictFailure);
    pausedRunForCleanup = created;
    const run = await waitForRun(request, created.runId, "paused");
    expect(run.ecommerceQualityStatus).toBe("needs_review");
    await expect(page.getByText("商品一致性检查未通过，需要复核。", { exact: true })).toBeVisible();
    await expectAdminTrace(request, run.id, "needs_review");
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
    const product = await uploadFixture(goldenCase.fixturePath, goldenCase.productFileName);
    const files = options.sceneReference ? [product, await uploadFixture(goldenCase.fixturePath, `scene-${goldenCase.id}.webp`)] : [product];
    await page.locator('input[type="file"][multiple]').setInputFiles(files);
    for (const file of files) await expect(page.getByLabel(`已上传图片 ${file.name}`)).toBeVisible({ timeout: 30_000 });
    return submitPrompt(page, goldenCase.userRequest, { reusePage: true });
}

async function submitPrompt(page: Page, prompt: string, options: { reusePage?: boolean } = {}) {
    if (!options.reusePage) await page.goto("/create", { waitUntil: "domcontentloaded" });
    const textbox = page.getByRole("textbox", { name: "输入你的创作想法、脚本或画面要求" });
    await textbox.fill(prompt);
    const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const response = await responsePromise;
    expect(response.ok(), await response.text()).toBe(true);
    const payload = (await response.json()) as { data: { run: PublicRun } };
    return { runId: payload.data.run.id, conversationId: payload.data.run.conversationId };
}

async function selectImageMode(page: Page) {
    const agentMode = page.getByRole("button", { name: "当前创作类型：Agent 模式" });
    if (await agentMode.isVisible()) {
        await agentMode.click();
        const picker = page.locator(".ant-popover").filter({ hasText: "创作类型" }).last();
        await expect(picker).toBeVisible();
        await picker.getByRole("button", { name: /图片生成/ }).click();
    }
    await expect(page.getByRole("button", { name: "当前创作类型：图片生成" })).toBeVisible();
}

async function uploadFixture(relativePath: string, name: string) {
    let buffer = fixtureBytes.get(relativePath);
    if (!buffer) {
        buffer = await sharp({ create: { width: 512, height: 512, channels: 4, background: "#00000000" } })
            .composite([{ input: { create: { width: 300, height: 360, channels: 4, background: "#4b5563" } }, left: 106, top: 76 }])
            .webp()
            .toBuffer();
        fixtureBytes.set(relativePath, buffer);
    }
    return { name, mimeType: "image/webp", buffer };
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
    const response = await request.get(`/api/agent/runs/${runId}/events`, { headers: { "Last-Event-ID": "0" } });
    expect(response.ok(), await response.text()).toBe(true);
    const body = await response.text();
    expect(body).toContain("正在识别商品");
    expect(body).toContain("正在规划场景");
    expect(body).toContain("正在生成图片");
    expect(body).toContain("正在检查商品细节");
    expect(body).not.toContain("ecommerceSnapshot");
}

async function expectAdminTrace(request: APIRequestContext, runId: string, finalStatus: "passed" | "needs_review") {
    await expect
        .poll(
            async () => {
                const response = await request.get("/api/admin/generation-logs?page=1&pageSize=100");
                if (!response.ok()) return null;
                const payload = (await response.json()) as { logs: Array<{ ecommerceTrace?: { runId?: string; finalStatus?: string; stages?: Array<{ key: string }> } }> };
                return payload.logs.find((log) => log.ecommerceTrace?.runId === runId)?.ecommerceTrace || null;
            },
            { timeout: 30_000 },
        )
        .toMatchObject({
            runId,
            finalStatus,
            stages: expect.arrayContaining([expect.objectContaining({ key: "visual_analysis" }), expect.objectContaining({ key: "edit_planning" }), expect.objectContaining({ key: "image_generation" }), expect.objectContaining({ key: "quality_check" })]),
        });
}

async function conversationAssets(request: APIRequestContext, conversationId: string) {
    const response = await request.get(`/api/creative/conversations/${conversationId}/assets`);
    expect(response.ok(), await response.text()).toBe(true);
    const payload = (await response.json()) as { data: { assets: Array<{ id: string; metadata?: { ecommerceContinuity?: Record<string, unknown> } }> } };
    return payload.data.assets;
}
