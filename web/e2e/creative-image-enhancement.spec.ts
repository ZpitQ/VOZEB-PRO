import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import sharp from "sharp";

import type { CreativeAsset, CreativeMessage } from "../src/lib/creative-runtime-contract";
import type { ImageEnhancementSkip, PublicImageEnhancement } from "../src/lib/image-enhancement-contract";

test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== "chromium", "增强变体按桌面 Chromium 验收");
    await page.setViewportSize({ width: 1672, height: 941 });
    await page.route(/\/api\/public\/gallery(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { items: [] }, msg: "OK" } }));
    await page.route(/\/api\/notifications\/interactions(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { items: [], unreadCount: 0 }, msg: "OK" } }));
});

test("restored variants keep one result and download and reference the actual selected asset", async ({ page }, info) => {
    const fixture = await mockEnhancementRound(page, { status: "succeeded", persistentMedia: true });
    await openRound(page, fixture.id);
    const result = page.getByTestId("creative-media-result");
    const actions = page.getByLabel("本轮创作操作", { exact: true });
    await expect(result).toHaveAttribute("data-results-count", "1");
    await expect(result.getByTestId("creative-result-switcher")).toHaveCount(0);
    await expect(actions).toHaveAttribute("data-active-asset-id", fixture.child.id);
    await expect(result.getByRole("button", { name: "AI增强", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(result.getByLabel("图像增强与版本", { exact: true })).toContainText(/当前AI增强\s*2048×2048/);
    const preview = result.getByTestId("creative-primary-result").locator("img");
    await expect(preview).toHaveAttribute("src", `${fixture.child.serverUrl}?format=webp&width=960`);
    await referenceCurrent(page, actions);
    await expect(page.getByRole("button", { name: `移除${fixture.child.title}`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `移除${fixture.original.title}`, exact: true })).toHaveCount(0);
    const enhancedDownload = await downloadCurrent(page, actions);
    expect(enhancedDownload.url.pathname).toBe(fixture.child.serverUrl);
    expect(createHash("sha256").update(enhancedDownload.bytes).digest("hex")).toBe(fixture.enhancedSha256);

    await result.getByRole("button", { name: "原图", exact: true }).click();
    await expect(actions).toHaveAttribute("data-active-asset-id", fixture.original.id);
    await expect(result.getByLabel("图像增强与版本", { exact: true })).toContainText(/当前原图\s*1024×1024/);
    const originalDownload = await downloadCurrent(page, actions);
    expect(originalDownload.url.pathname).toBe(fixture.original.serverUrl);
    expect(createHash("sha256").update(originalDownload.bytes).digest("hex")).toBe(fixture.nativeSha256);
    await referenceCurrent(page, actions);
    await expect(page.getByRole("button", { name: `移除${fixture.original.title}`, exact: true })).toBeVisible();
    await expectTightImage(result);
    await page.screenshot({ path: info.outputPath("image-enhancement-light.png") });

    await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(actions).toHaveAttribute("data-active-asset-id", fixture.child.id);
    await expect(result.getByLabel("图像增强与版本", { exact: true })).toContainText(/当前AI增强\s*2048×2048/);
    const originalButton = result.getByRole("button", { name: "原图", exact: true });
    await originalButton.focus();
    await page.keyboard.press("Enter");
    await expect(actions).toHaveAttribute("data-active-asset-id", fixture.original.id);
    await expect(result.getByLabel("图像增强与版本", { exact: true })).toContainText(/当前原图\s*1024×1024/);
    await expectTightImage(result);
    await page.screenshot({ path: info.outputPath("image-enhancement-dark.png") });
    expect(fixture.generatedRequests).toEqual([]);
});

test("enhanced detail preview loads delivered pixels while thumbnails remain small", async ({ page }) => {
    const fixture = await mockEnhancementRound(page, { status: "succeeded", persistentMedia: true, enhancedSize: { width: 3838, height: 2160 } });
    await openRound(page, fixture.id);
    const result = page.getByTestId("creative-media-result");
    const thumbnail = result.getByTestId("creative-primary-result").getByRole("img", { name: fixture.child.title, exact: true });
    await expect(thumbnail).toHaveAttribute("src", `${fixture.child.serverUrl}?format=webp&width=960`);
    await thumbnail.click();
    const dialog = page.getByRole("dialog", { name: fixture.child.title, exact: true });
    const detail = dialog.getByRole("img", { name: fixture.child.title, exact: true });
    await expect(detail).toHaveAttribute("src", `${fixture.child.serverUrl}?format=webp&width=4096`);
    await expect.poll(() => detail.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([3838, 2160]);
    await dialog.getByRole("button", { name: "zoomIn", exact: true }).click();
    await expect(detail).toHaveAttribute("src", `${fixture.child.serverUrl}?format=webp&width=4096`);
    await dialog.getByRole("button", { name: "close", exact: true }).click();
    await result.getByRole("button", { name: "原图", exact: true }).click();
    await result.getByTestId("creative-primary-result").getByRole("img", { name: fixture.original.title, exact: true }).click();
    const originalDialog = page.getByRole("dialog", { name: fixture.original.title, exact: true });
    const native = originalDialog.getByRole("img", { name: fixture.original.title, exact: true });
    await expect(native).toHaveAttribute("src", `${fixture.original.serverUrl}?format=webp&width=1920`);
    await expect.poll(() => native.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([1024, 1024]);
    await originalDialog.getByRole("button", { name: "close", exact: true }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    const restored = page.getByTestId("creative-primary-result").getByRole("img", { name: fixture.child.title, exact: true });
    await restored.click();
    const restoredDetail = page.getByRole("dialog", { name: fixture.child.title, exact: true }).getByRole("img", { name: fixture.child.title, exact: true });
    await expect.poll(() => restoredDetail.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([3838, 2160]);
    expect(fixture.generatedRequests).toEqual([]);
});

test("late enhancement refreshes only assets and preserves the explicit original, selected reference and draft", async ({ page }) => {
    const fixture = await mockEnhancementRound(page, { status: "running" });
    await openRound(page, fixture.id);
    const result = page.getByTestId("creative-media-result");
    const actions = page.getByLabel("本轮创作操作", { exact: true });
    await expect(result.getByRole("status")).toContainText("AI增强进行中");
    await expect(result.getByLabel("图像增强与版本", { exact: true })).toContainText(/当前原图\s*1024×1024/);
    await result.getByRole("button", { name: "原图", exact: true }).click();
    await referenceCurrent(page, actions);
    const input = page.getByRole("textbox", { name: "描述你想生成或修改的图片", exact: true });
    await input.fill("保留这段尚未提交的下一轮草稿");
    const messagesBefore = fixture.messageReads();
    const assetsBefore = fixture.assetReads();
    fixture.finish();

    await expect(result.getByRole("button", { name: "AI增强", exact: true })).toBeEnabled();
    await expect.poll(fixture.assetReads).toBeGreaterThan(assetsBefore);
    await expect(actions).toHaveAttribute("data-active-asset-id", fixture.original.id);
    await expect(result.getByLabel("图像增强与版本", { exact: true })).toContainText(/当前原图\s*1024×1024/);
    await expect(result.getByLabel("图像增强与版本", { exact: true })).not.toContainText("当前AI增强");
    await expect(input).toHaveValue("保留这段尚未提交的下一轮草稿");
    await expect(page.getByRole("button", { name: `移除${fixture.original.title}`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `移除${fixture.child.title}`, exact: true })).toHaveCount(0);
    expect(fixture.messageReads()).toBe(messagesBefore);
    expect(fixture.generatedRequests).toEqual([]);
    await result.getByRole("button", { name: "AI增强", exact: true }).click();
    await expect(actions).toHaveAttribute("data-active-asset-id", fixture.child.id);
    await expect(result.getByLabel("图像增强与版本", { exact: true })).toContainText(/当前AI增强\s*2048×2048/);
    await expect(page.getByRole("button", { name: `移除${fixture.child.title}`, exact: true })).toHaveCount(0);
});

test("late enhancement keeps submitted B on the original and explicit enhanced reference creates C", async ({ page }) => {
    const fixture = await mockEnhancementRound(page, { status: "running" });
    await openRound(page, fixture.id);
    const actions = page.getByLabel("本轮创作操作", { exact: true }).first();
    await referenceCurrent(page, actions);
    const input = page.getByRole("textbox", { name: "描述你想生成或修改的图片", exact: true });
    await input.fill("用原图开始下一轮B");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => fixture.generatedRequests.length).toBe(1);
    await expect(input).toHaveValue("");
    await input.fill("仅在明确引用增强图后提交C");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    expect(fixture.generatedRequests[0].assetIds).toEqual([fixture.original.id]);
    const frozenB = JSON.stringify(fixture.generatedRequests[0]);
    fixture.finish();
    const result = page.getByTestId("creative-media-result").first();
    await expect(result.getByRole("button", { name: "AI增强", exact: true })).toBeEnabled();
    await expect(input).toHaveValue("仅在明确引用增强图后提交C");
    await expect(page.getByRole("button", { name: `移除${fixture.child.title}`, exact: true })).toHaveCount(0);
    expect(JSON.stringify(fixture.generatedRequests[0])).toBe(frozenB);
    await result.getByRole("button", { name: "AI增强", exact: true }).click();
    await referenceCurrent(page, actions);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => fixture.generatedRequests.length).toBe(2);
    expect(fixture.generatedRequests[1].assetIds).toEqual([fixture.child.id]);
    expect(JSON.stringify(fixture.generatedRequests[0])).toBe(frozenB);
});

test("retry and cancel control only the enhancement and disable repeated actions while pending", async ({ page }) => {
    const fixture = await mockEnhancementRound(page, { status: "failed", reason: "private-internal-details" });
    await openRound(page, fixture.id);
    const result = page.getByTestId("creative-media-result");
    const actions = page.getByLabel("本轮创作操作", { exact: true });
    await expect(result.getByRole("status")).toContainText("AI增强失败");
    await expect(result).not.toContainText("private-internal-details");
    await expect(page.getByRole("button", { name: "直接重试本次创作" })).toHaveCount(0);
    await expect(result.getByRole("button", { name: "取消增强", exact: true })).toHaveCount(0);
    const releaseRetry = fixture.holdNextControl();
    try {
        const retry = result.getByRole("button", { name: "重试增强", exact: true });
        await retry.click();
        await expect(retry).toBeDisabled();
        await expect.poll(() => fixture.controls.length).toBe(1);
        expect(fixture.controls).toEqual(["retry"]);
    } finally {
        releaseRetry();
    }
    await expect(result.getByRole("status")).toContainText("AI增强排队中");
    const releaseCancel = fixture.holdNextControl();
    try {
        const cancel = result.getByRole("button", { name: "取消增强", exact: true });
        await cancel.click();
        await expect(cancel).toBeDisabled();
        await expect.poll(() => fixture.controls.length).toBe(2);
    } finally {
        releaseCancel();
    }
    await expect(result.getByRole("status")).toContainText("AI增强已取消");
    await expect(actions).toHaveAttribute("data-active-asset-id", fixture.original.id);
    expect(fixture.controls).toEqual(["retry", "cancel"]);
    expect(fixture.generatedRequests).toEqual([]);
});

test("a legacy ratio skip can enhance the existing image once without generating another image", async ({ page }) => {
    const fixture = await mockEnhancementRound(page, { status: "skipped", reason: "aspect_ratio_mismatch" });
    await openRound(page, fixture.id);
    const result = page.getByTestId("creative-media-result");
    const actions = page.getByLabel("本轮创作操作", { exact: true });
    await expect(result.getByRole("status")).toContainText("原图与请求比例不同，可按原图比例补做AI增强");
    await expect(actions).toHaveAttribute("data-active-asset-id", fixture.original.id);
    const release = fixture.holdNextControl();
    try {
        const retry = result.getByRole("button", { name: "补做AI增强", exact: true });
        await retry.click();
        await expect(retry).toBeDisabled();
        await expect.poll(() => fixture.controls.length).toBe(1);
    } finally {
        release();
    }
    await expect(result.getByRole("status")).toContainText("AI增强排队中");
    fixture.finish();
    await expect(result.getByRole("button", { name: "AI增强", exact: true })).toBeEnabled();
    await result.getByRole("button", { name: "原图", exact: true }).click();
    await expect(actions).toHaveAttribute("data-active-asset-id", fixture.original.id);
    await result.getByRole("button", { name: "AI增强", exact: true }).click();
    await expect(actions).toHaveAttribute("data-active-asset-id", fixture.child.id);
    expect(fixture.controls).toEqual(["retry"]);
    expect(fixture.generatedRequests).toEqual([]);
});

test("a no-job skip makes no enhancement request for any supported skip reason", async ({ page }) => {
    const cases: Array<[ImageEnhancementSkip["reason"], string]> = [
        ["disabled", "未启用AI增强"],
        ["not_requested", "本次未请求AI增强"],
        ["protected_contract", "保护图像保持原图"],
        ["unsupported_layers", "分层结果保持原图"],
    ];
    for (const [reason, label] of cases) {
        const fixture = await mockEnhancementRound(page, { skip: reason });
        await openRound(page, fixture.id);
        await expect(page.getByTestId("creative-media-result").getByRole("status")).toContainText(label);
        await expect(page.getByLabel("本轮创作操作", { exact: true })).toHaveAttribute("data-active-asset-id", fixture.original.id);
        expect(fixture.jobReads()).toBe(0);
        expect(fixture.controls).toEqual([]);
        expect(fixture.generatedRequests).toEqual([]);
    }
});

test("a failed status read keeps the original and recovers by an explicit check without showing remote details", async ({ page }) => {
    await page.clock.install();
    const fixture = await mockEnhancementRound(page, { status: "queued", failRead: true });
    await openRound(page, fixture.id);
    const result = page.getByTestId("creative-media-result");
    await expect(result.getByRole("status")).toContainText("暂时无法读取增强状态");
    await expect(page.getByLabel("本轮创作操作", { exact: true })).toHaveAttribute("data-active-asset-id", fixture.original.id);
    await expect(page.locator("body")).not.toContainText("private-read-failure-details");
    await expect.poll(() => fixture.pendingJobReads() === 0 && fixture.finishedJobReads() === fixture.jobReads()).toBe(true);
    const settledReads = fixture.jobReads();
    // Cross the existing 1800 ms polling period after every initial Strict Mode response has settled.
    await page.clock.runFor("00:04");
    expect(fixture.jobReads()).toBe(settledReads);
    fixture.allowReads();
    await result.getByRole("button", { name: "检查增强状态", exact: true }).click();
    await expect(result.getByRole("status")).toContainText("AI增强排队中");
    expect(fixture.controls).toEqual([]);
    expect(fixture.generatedRequests).toEqual([]);
});

test("a delayed enhancement GET cannot refresh or repopulate a newly opened draft", async ({ page }) => {
    const fixture = await mockEnhancementRound(page, { status: "succeeded", publishChild: false });
    const release = fixture.holdJobReads();
    try {
        await openRound(page, fixture.id);
        await fixture.firstJobRead();
        await page.getByRole("button", { name: "新建对话", exact: true }).click();
        const input = page.getByRole("textbox", { name: "描述你想生成或修改的图片", exact: true });
        await input.fill("新对话的草稿不能被旧增强响应覆盖");
        release();
        await expect.poll(() => fixture.pendingJobReads() === 0 && fixture.finishedJobReads() === fixture.jobReads()).toBe(true);
        await expect(input).toHaveValue("新对话的草稿不能被旧增强响应覆盖");
        await expect(page.getByTestId("creative-media-result")).toHaveCount(0);
        expect(fixture.assetReads()).toBe(1);
    } finally {
        release();
    }
});

test("a delayed assets-only refresh is isolated after switching the conversation", async ({ page }) => {
    const fixture = await mockEnhancementRound(page, { status: "running" });
    await openRound(page, fixture.id);
    const release = fixture.holdNextAssetRead();
    try {
        fixture.finish();
        await expect.poll(fixture.assetReads).toBe(2);
        await page.getByRole("button", { name: "新建对话", exact: true }).click();
        const input = page.getByRole("textbox", { name: "描述你想生成或修改的图片", exact: true });
        await input.fill("保留新对话和新草稿");
        release();
        await expect.poll(fixture.finishedAssetReads).toBe(2);
        await expect(input).toHaveValue("保留新对话和新草稿");
        await expect(page.getByTestId("creative-media-result")).toHaveCount(0);
        await expect(page.getByRole("button", { name: `移除${fixture.child.title}`, exact: true })).toHaveCount(0);
    } finally {
        release();
    }
});

test("same-conversation assets-only responses keep the newer enhanced reference when the older snapshot arrives last", async ({ page }) => {
    const fixture = await mockEnhancementRound(page, { status: "running" });
    const second = await fixture.addRound();
    await openTwoRounds(page, fixture.id);
    const baseline = fixture.assetReads();
    const releaseOld = fixture.holdNextAssetRead();
    let releaseFollowups: () => void = () => undefined;
    try {
        fixture.finish();
        await expect.poll(fixture.assetReads).toBe(baseline + 1);
        expect(fixture.assetSnapshots().at(-1)).not.toContain(second.child.id);
        second.finish();
        await expect.poll(fixture.assetReads).toBe(baseline + 2);
        await selectSecondChild(page, second.child);
        releaseFollowups = fixture.holdAssetReads();
        await releaseStaleAssets(page, fixture.id, releaseOld, second.child.id);
        const input = page.getByRole("textbox", { name: "描述你想生成或修改的图片", exact: true });
        await input.fill("继续使用第二轮真实增强图");
        await expect.soft(page.getByRole("button", { name: `移除${second.child.title}`, exact: true })).toBeVisible();
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect.poll(() => fixture.generatedRequests.length).toBe(1);
        expect(fixture.generatedRequests[0].assetIds).toEqual([second.child.id]);
    } finally {
        releaseOld();
        releaseFollowups();
    }
});

test("an older full conversation refresh cannot remove a newer assets-only enhanced reference", async ({ page }) => {
    const fixture = await mockEnhancementRound(page, { status: "running" });
    await openRound(page, fixture.id);
    const baseline = fixture.assetReads();
    const releaseOld = fixture.holdNextAssetRead();
    let releaseFollowups: () => void = () => undefined;
    try {
        const input = page.getByRole("textbox", { name: "描述你想生成或修改的图片", exact: true });
        await input.fill("先完成一轮生成以触发完整会话读取");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect.poll(() => fixture.generatedRequests.length).toBe(1);
        await expect(input).toHaveValue("");
        await expect.poll(fixture.assetReads).toBe(baseline + 1);
        expect(fixture.assetSnapshots().at(-1)).not.toContain(fixture.child.id);
        fixture.finish();
        await expect.poll(fixture.assetReads).toBe(baseline + 2);
        const round = page.getByTestId("creative-media-round").first();
        await round.getByRole("button", { name: "AI增强", exact: true }).click();
        await referenceCurrent(page, round.getByLabel("本轮创作操作", { exact: true }));
        await expect(page.getByRole("button", { name: `移除${fixture.child.title}`, exact: true })).toBeVisible();
        releaseFollowups = fixture.holdAssetReads();
        await releaseStaleAssets(page, fixture.id, releaseOld, fixture.child.id);
        await input.fill("完整刷新晚到后仍引用真实增强图");
        await expect.soft(page.getByRole("button", { name: `移除${fixture.child.title}`, exact: true })).toBeVisible();
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect.poll(() => fixture.generatedRequests.length).toBe(2);
        expect(fixture.generatedRequests[1].assetIds).toEqual([fixture.child.id]);
    } finally {
        releaseOld();
        releaseFollowups();
    }
});

test("an older assets-only refresh cannot remove the enhanced reference read by a newer full refresh", async ({ page }) => {
    const fixture = await mockEnhancementRound(page, { status: "running" });
    const second = await fixture.addRound();
    await openTwoRounds(page, fixture.id);
    const baseline = fixture.assetReads();
    const releaseOld = fixture.holdNextAssetRead();
    let releaseFollowups: () => void = () => undefined;
    try {
        fixture.finish();
        await expect.poll(fixture.assetReads).toBe(baseline + 1);
        expect(fixture.assetSnapshots().at(-1)).not.toContain(second.child.id);
        second.publish();
        const input = page.getByRole("textbox", { name: "描述你想生成或修改的图片", exact: true });
        await input.fill("通过本轮完成读取服务器最新资产");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect.poll(() => fixture.generatedRequests.length).toBe(1);
        await expect(input).toHaveValue("");
        await expect.poll(fixture.assetReads).toBe(baseline + 2);
        await selectSecondChild(page, second.child);
        releaseFollowups = fixture.holdAssetReads();
        await releaseStaleAssets(page, fixture.id, releaseOld, second.child.id);
        await input.fill("资产旧响应晚到后仍引用第二轮增强图");
        await expect.soft(page.getByRole("button", { name: `移除${second.child.title}`, exact: true })).toBeVisible();
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect.poll(() => fixture.generatedRequests.length).toBe(2);
        expect(fixture.generatedRequests[1].assetIds).toEqual([second.child.id]);
    } finally {
        releaseOld();
        releaseFollowups();
    }
});

async function openTwoRounds(page: Page, id: string) {
    await page.goto(`/create?conversationId=${id}`, { waitUntil: "domcontentloaded" });
    const results = page.getByTestId("creative-media-result");
    await expect(results).toHaveCount(2);
    await expect(results.nth(0).getByRole("status")).toContainText("AI增强进行中");
    await expect(results.nth(1).getByRole("status")).toContainText("AI增强进行中");
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true");
}

async function selectSecondChild(page: Page, child: CreativeAsset) {
    const round = page.getByTestId("creative-media-round").nth(1);
    await expect(round.getByRole("button", { name: "AI增强", exact: true })).toBeEnabled();
    await round.getByRole("button", { name: "AI增强", exact: true }).click();
    await expect(round.getByLabel("本轮创作操作", { exact: true })).toHaveAttribute("data-active-asset-id", child.id);
    await referenceCurrent(page, round.getByLabel("本轮创作操作", { exact: true }));
    await expect(page.getByRole("button", { name: `移除${child.title}`, exact: true })).toBeVisible();
}

async function releaseStaleAssets(page: Page, id: string, release: () => void, absentChildId: string) {
    const responsePending = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === `/api/creative/conversations/${id}/assets`);
    release();
    const response = await responsePending;
    const body = (await response.json()) as { data: { assets: CreativeAsset[] } };
    expect(body.data.assets.map((asset) => asset.id)).not.toContain(absentChildId);
    expect(await response.finished()).toBeNull();
}

async function openRound(page: Page, id: string) {
    await page.goto(`/create?conversationId=${id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("creative-media-result")).toBeVisible({ timeout: 45_000 });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true");
}

async function referenceCurrent(page: Page, actions: Locator) {
    await actions.getByRole("button", { name: "更多本轮创作操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "引用结果", exact: true }).click();
}

async function downloadCurrent(page: Page, actions: Locator) {
    const downloadStarted = page.waitForEvent("download");
    await actions.getByRole("button", { name: "下载", exact: true }).click();
    const menu = page.getByRole("menuitem", { name: "下载当前结果", exact: true });
    if (await menu.isVisible()) await menu.click();
    const download = await downloadStarted;
    expect(await download.failure()).toBeNull();
    const downloadedPath = await download.path();
    expect(downloadedPath).not.toBeNull();
    const url = new URL(download.url());
    expect(url.searchParams.get("download")).toBe("original");
    expect(url.searchParams.has("format")).toBe(false);
    expect(url.searchParams.has("width")).toBe(false);
    return { url, bytes: await readFile(downloadedPath!) };
}

async function expectTightImage(result: Locator) {
    const card = result.getByTestId("creative-primary-result");
    const bounds = await card.evaluate((element) => {
        const frame = element.getBoundingClientRect();
        const media = element.querySelector("img")!.getBoundingClientRect();
        return { width: frame.width, height: frame.height, mediaWidth: media.width, mediaHeight: media.height };
    });
    expect(Math.abs(bounds.width - bounds.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(bounds.width - bounds.mediaWidth)).toBeLessThanOrEqual(3);
    expect(Math.abs(bounds.height - bounds.mediaHeight)).toBeLessThanOrEqual(3);
    const widths = await result.page().evaluate(() => ({ available: document.documentElement.clientWidth, actual: document.documentElement.scrollWidth }));
    expect(widths.actual).toBeLessThanOrEqual(widths.available + 1);
}

function gate() {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

async function mockEnhancementRound(
    page: Page,
    options: { status?: PublicImageEnhancement["status"]; reason?: string; skip?: ImageEnhancementSkip["reason"]; publishChild?: boolean; failRead?: boolean; persistentMedia?: boolean; enhancedSize?: { width: number; height: number } },
) {
    const prefix = `enhancement-${randomUUID()}`;
    const id = `conversation-${prefix}`;
    const runId = `run-${prefix}`;
    const enhancementId = `job-${prefix}`;
    const resultId = `result-${prefix}`;
    const now = Date.now();
    let nativeUrl = `/api/reference-assets/${prefix}/native.png`;
    let enhancedUrl = `/api/reference-assets/${prefix}/enhanced.png`;
    const original: CreativeAsset = {
        id: `native-${prefix}`,
        userId: "fixture-user",
        conversationId: id,
        messageId: `assistant-${runId}`,
        sourceRunId: runId,
        sourceTaskId: "image-task",
        ordinal: 0,
        type: "image",
        status: "ready",
        title: "原图结果",
        serverUrl: nativeUrl,
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        metadata: { resultId, agentTaskId: "image-task", ...(options.skip ? { enhancementSkip: { status: "skipped", reason: options.skip } } : { enhancementId }) },
        createdAt: now,
        updatedAt: now,
    };
    const child: CreativeAsset = {
        ...original,
        id: `child-${prefix}`,
        messageId: undefined,
        sourceTaskId: enhancementId,
        parentAssetId: original.id,
        title: "AI增强结果",
        serverUrl: enhancedUrl,
        width: 2048,
        height: 2048,
        ...options.enhancedSize,
        metadata: { provenance: "ai_enhanced", enhancementId, parentResultId: resultId, parentAssetIds: [original.id], nativeSha256: "a".repeat(64), sha256: "b".repeat(64) },
        createdAt: now + 1,
        updatedAt: now + 1,
    };
    let status: PublicImageEnhancement["status"] = options.status || "queued";
    let assets = [original, ...(status === "succeeded" && options.publishChild !== false ? [child] : [])];
    let failRead = Boolean(options.failRead);
    let assetReadCount = 0;
    let completedAssetReadCount = 0;
    let jobReadCount = 0;
    let completedJobReadCount = 0;
    let messageReadCount = 0;
    let jobReadGate: ReturnType<typeof gate> | undefined;
    let assetReadGate: ReturnType<typeof gate> | undefined;
    let nextAssetGate: ReturnType<typeof gate> | undefined;
    let nextControlGate: ReturnType<typeof gate> | undefined;
    const controls: string[] = [];
    const generatedRequests: Array<Record<string, unknown>> = [];
    const assetSnapshots: string[][] = [];
    const firstJobRead = gate();
    const pendingJobRequests = new Set<Request>();
    page.on("request", (request) => {
        if (request.method() === "GET" && new URL(request.url()).pathname === `/api/image-enhancements/${enhancementId}`) pendingJobRequests.add(request);
    });
    page.on("requestfinished", (request) => pendingJobRequests.delete(request));
    page.on("requestfailed", (request) => pendingJobRequests.delete(request));
    const messages: CreativeMessage[] = [
        { id: `user-${runId}`, conversationId: id, runId, sequence: 1, role: "user", status: "completed", content: "生成一张商业商品图", metadata: {}, createdAt: now, updatedAt: now },
        { id: `assistant-${runId}`, conversationId: id, runId, sequence: 2, role: "assistant", status: "completed", content: "图片已生成。", metadata: {}, createdAt: now + 1, updatedAt: now + 1 },
    ];
    const conversation = { id, userId: "fixture-user", surface: "chat", source: "agent", title: "增强变体回归", status: "active", contextSummary: "", contextSummaryThroughSequence: 0, createdAt: now, updatedAt: now, lastMessageAt: now };
    const run = {
        id: runId,
        conversationId: id,
        inputMessageId: messages[0].id,
        assistantMessageId: messages[1].id,
        status: "completed",
        prompt: messages[0].content,
        referencedAssetIds: [],
        requestedModelIds: ["image-gen"],
        generationPreferences: { mode: "image", image: { size: "1:1", quality: "high" } },
        assetIds: [original.id],
        tasks: [{ id: "image-task", title: "生成图片", type: "image", model: "image-gen", ratio: "1:1", quality: "high", count: 1, status: "completed", optimizedPrompt: "公开商品图提示词" }],
        createdAt: now,
        updatedAt: now + 1000,
    };
    const nativeBytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#51869d" } })
        .png()
        .toBuffer();
    const enhancedBytes = await sharp({ create: { width: child.width!, height: child.height!, channels: 3, background: "#709e81" } })
        .png()
        .toBuffer();
    if (options.persistentMedia) {
        for (const [asset, bytes, name] of [
            [original, nativeBytes, "native.png"],
            [child, enhancedBytes, "enhanced.png"],
        ] as const) {
            const response = await page.context().request.post("/api/reference-assets", { data: { type: "image", persistent: true, originalName: `E2E ${name}`, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` } });
            expect(response.ok(), "The isolated authenticated media fixture must upload successfully").toBe(true);
            const uploaded = (await response.json()) as { url: string; bytes: number; mimeType: string };
            expect(uploaded.url).toMatch(/^\/api\/reference-assets\/permanent\//);
            expect(uploaded.bytes).toBe(bytes.length);
            expect(uploaded.mimeType).toBe("image/png");
            asset.serverUrl = uploaded.url;
        }
        nativeUrl = original.serverUrl!;
        enhancedUrl = child.serverUrl!;
    }
    const nativeSha256 = createHash("sha256").update(nativeBytes).digest("hex");
    const enhancedSha256 = createHash("sha256").update(enhancedBytes).digest("hex");
    original.bytes = nativeBytes.length;
    child.bytes = enhancedBytes.length;
    child.metadata.nativeSha256 = nativeSha256;
    child.metadata.sha256 = enhancedSha256;
    original.metadata.nativeSource = { url: nativeUrl, width: 1024, height: 1024, sha256: nativeSha256, byteLength: nativeBytes.length, format: "png", hasAlpha: false, provenance: "provider_native" };
    const job = (): PublicImageEnhancement => ({
        id: enhancementId,
        imageTaskId: "native-task",
        resultId,
        status,
        phase: status === "succeeded" ? "completed" : "poll",
        reason: options.reason || null,
        attempt: controls.filter((action) => action === "retry").length + 1,
        native: { url: nativeUrl, width: 1024, height: 1024, sha256: nativeSha256, byteLength: nativeBytes.length, format: "png", provenance: "provider_native" },
        target: { width: child.width!, height: child.height! },
        ...(status === "succeeded" ? { enhanced: { url: enhancedUrl, assetId: child.id, width: child.width!, height: child.height!, sha256: enhancedSha256, byteLength: enhancedBytes.length, format: "png" } } : {}),
        events: [],
        canRetry: status === "failed" || (status === "skipped" && options.reason === "aspect_ratio_mismatch"),
        canCancel: status === "queued" || status === "running",
    });

    await page.route(new RegExp(`/api/reference-assets/${prefix}/(?:second-)?(?:native|enhanced)\\.png(?:\\?.*)?$`), async (route) => {
        const url = new URL(route.request().url());
        const originalBytes = url.pathname.endsWith("enhanced.png") ? enhancedBytes : nativeBytes;
        const previewWidth = Number(url.searchParams.get("width"));
        const webp = url.searchParams.get("format") === "webp";
        const body = webp
            ? await sharp(originalBytes)
                  .resize({ ...(previewWidth > 0 ? { width: previewWidth } : {}), withoutEnlargement: true })
                  .webp()
                  .toBuffer()
            : originalBytes;
        await route.fulfill({ body, contentType: webp ? "image/webp" : "image/png" });
    });
    await page.route(/\/api\/creative\/conversations(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { conversations: [conversation], hasMore: false }, msg: "OK" } }));
    await page.route(/\/api\/agent\/runs(?:\?.*)?$/, async (route) => {
        if (route.request().method() === "GET") return route.fulfill({ json: { code: 0, data: { runs: [] }, msg: "OK" } });
        const input = route.request().postDataJSON() as Record<string, unknown>;
        generatedRequests.push(input);
        const submittedId = `submitted-${prefix}-${generatedRequests.length}`;
        const submittedRun = { ...run, id: submittedId, status: "running", inputMessageId: `user-${submittedId}`, assistantMessageId: `assistant-${submittedId}`, assetIds: [], tasks: [] };
        messages.push(
            { ...messages[0], id: submittedRun.inputMessageId, runId: submittedId, sequence: messages.length + 1, content: String(input.publicPrompt || input.prompt), metadata: { assetIds: input.assetIds } },
            { ...messages[1], id: submittedRun.assistantMessageId, runId: submittedId, sequence: messages.length + 2, content: "本轮已完成" },
        );
        await page.route(new RegExp(`/api/agent/runs/${submittedId}$`), (detail) => detail.fulfill({ json: { code: 0, data: { run: { ...submittedRun, status: "completed" } }, msg: "OK" } }));
        await page.route(new RegExp(`/api/agent/runs/${submittedId}/events(?:\\?.*)?$`), (events) => events.fulfill({ contentType: "text/event-stream", body: `event: run.completed\ndata: ${JSON.stringify({ data: { reply: "本轮已完成" } })}\n\n` }));
        await route.fulfill({ json: { code: 0, data: { run: submittedRun, created: true }, msg: "OK" } });
    });
    await page.route(new RegExp(`/api/creative/conversations/${id}$`), (route) => route.fulfill({ json: { code: 0, data: { conversation }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${id}/messages(?:\\?.*)?$`), (route) => {
        messageReadCount += 1;
        return route.fulfill({ json: { code: 0, data: { messages }, msg: "OK" } });
    });
    await page.route(new RegExp(`/api/creative/conversations/${id}/assets$`), async (route) => {
        assetReadCount += 1;
        const body = JSON.stringify({ code: 0, data: { assets }, msg: "OK" });
        assetSnapshots.push(assets.map((asset) => asset.id));
        const held = nextAssetGate || assetReadGate;
        nextAssetGate = undefined;
        await held?.promise;
        await route.fulfill({ body, contentType: "application/json" });
        completedAssetReadCount += 1;
    });
    await page.route(new RegExp(`/api/agent/runs/${runId}$`), (route) => route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } }));
    await page.route(new RegExp(`/api/image-enhancements/${enhancementId}$`), async (route) => {
        if (route.request().method() === "POST") {
            const action = String(route.request().postDataJSON().action);
            controls.push(action);
            const held = nextControlGate;
            nextControlGate = undefined;
            await held?.promise;
            status = action === "retry" ? "queued" : "cancelled";
            return route.fulfill({ json: { code: 0, data: job(), msg: "OK" } });
        }
        jobReadCount += 1;
        firstJobRead.release();
        const held = jobReadGate;
        await held?.promise;
        await route.fulfill({ json: failRead ? { code: 1, data: null, msg: "private-read-failure-details" } : { code: 0, data: job(), msg: "OK" } });
        completedJobReadCount += 1;
    });
    return {
        id,
        original,
        child,
        controls,
        generatedRequests,
        nativeSha256,
        enhancedSha256,
        jobReads: () => jobReadCount,
        finishedJobReads: () => completedJobReadCount,
        pendingJobReads: () => pendingJobRequests.size,
        firstJobRead: () => firstJobRead.promise,
        assetReads: () => assetReadCount,
        finishedAssetReads: () => completedAssetReadCount,
        assetSnapshots: () => assetSnapshots,
        messageReads: () => messageReadCount,
        finish: () => {
            status = "succeeded";
            assets = [...assets.filter((asset) => asset.id !== child.id), child];
        },
        allowReads: () => {
            failRead = false;
        },
        holdJobReads: () => {
            jobReadGate = gate();
            return jobReadGate.release;
        },
        holdNextAssetRead: () => {
            nextAssetGate = gate();
            return nextAssetGate.release;
        },
        holdAssetReads: () => {
            assetReadGate = gate();
            return assetReadGate.release;
        },
        holdNextControl: () => {
            nextControlGate = gate();
            return nextControlGate.release;
        },
        addRound: async () => {
            const secondRunId = `second-${runId}`;
            const secondEnhancementId = `second-${enhancementId}`;
            const secondResultId = `second-${resultId}`;
            const secondNativeUrl = `/api/reference-assets/${prefix}/second-native.png`;
            const secondOriginal: CreativeAsset = {
                ...original,
                id: `second-${original.id}`,
                messageId: `assistant-${secondRunId}`,
                sourceRunId: secondRunId,
                sourceTaskId: "second-image-task",
                title: "第二轮原图结果",
                serverUrl: secondNativeUrl,
                metadata: { ...original.metadata, nativeSource: { ...(original.metadata.nativeSource as Record<string, unknown>), url: secondNativeUrl }, resultId: secondResultId, enhancementId: secondEnhancementId, agentTaskId: "second-image-task" },
            };
            const secondChild: CreativeAsset = {
                ...child,
                id: `second-${child.id}`,
                parentAssetId: secondOriginal.id,
                sourceRunId: secondRunId,
                sourceTaskId: secondEnhancementId,
                title: "第二轮AI增强结果",
                serverUrl: `/api/reference-assets/${prefix}/second-enhanced.png`,
                metadata: { ...child.metadata, parentResultId: secondResultId, enhancementId: secondEnhancementId, parentAssetIds: [secondOriginal.id] },
            };
            const secondUser = { ...messages[0], id: `user-${secondRunId}`, runId: secondRunId, sequence: 3, content: "生成第二张商业商品图" };
            const secondAssistant = { ...messages[1], id: `assistant-${secondRunId}`, runId: secondRunId, sequence: 4 };
            const secondRun = { ...run, id: secondRunId, prompt: secondUser.content, inputMessageId: secondUser.id, assistantMessageId: secondAssistant.id, assetIds: [secondOriginal.id], tasks: [{ ...run.tasks[0], id: "second-image-task" }] };
            let secondStatus: PublicImageEnhancement["status"] = "running";
            const publish = () => {
                assets = [...assets.filter((asset) => asset.id !== secondChild.id), secondChild];
            };
            assets = [...assets, secondOriginal];
            messages.push(secondUser, secondAssistant);
            await page.route(new RegExp(`/api/agent/runs/${secondRunId}$`), (route) => route.fulfill({ json: { code: 0, data: { run: secondRun }, msg: "OK" } }));
            await page.route(new RegExp(`/api/image-enhancements/${secondEnhancementId}$`), (route) =>
                route.fulfill({
                    json: {
                        code: 0,
                        data: {
                            ...job(),
                            id: secondEnhancementId,
                            imageTaskId: "second-native-task",
                            resultId: secondResultId,
                            status: secondStatus,
                            phase: secondStatus === "succeeded" ? "completed" : "poll",
                            canRetry: false,
                            canCancel: secondStatus === "running",
                            native: { ...job().native, url: secondOriginal.serverUrl },
                            enhanced: secondStatus === "succeeded" ? { url: secondChild.serverUrl, assetId: secondChild.id, width: 2048, height: 2048, sha256: enhancedSha256, byteLength: enhancedBytes.length, format: "png" } : undefined,
                        },
                        msg: "OK",
                    },
                }),
            );
            return {
                original: secondOriginal,
                child: secondChild,
                publish,
                finish: () => {
                    secondStatus = "succeeded";
                    publish();
                },
            };
        },
    };
}
