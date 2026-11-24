import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import sharp from "sharp";

import type { GenerationLogEvaluation } from "../src/lib/generation-log-evaluation";
import type { PublicImageEnhancement } from "../src/lib/image-enhancement-contract";
import type { StoredGenerationLog } from "../src/lib/server/generation-log-types";
import { E2E_ADMIN } from "./support";

test.beforeEach(async ({ page, request }, info) => {
    test.skip(info.project.name !== "chromium", "管理员日志按桌面 Chromium 验收");
    await page.setViewportSize({ width: 1672, height: 941 });
    await authenticateFixtureAdmin(page, request);
});

test("administrator inspects actual delivery versions, timings and separate evaluation evidence", async ({ page, request }, info) => {
    const native = await sharp({ create: { width: 1254, height: 1254, channels: 3, background: "#b7c1ca" } })
        .png()
        .toBuffer();
    const nativeHash = createHash("sha256").update(native).digest("hex");
    const upload = await request.post("/api/reference-assets", { data: { type: "image", persistent: true, originalName: "admin-enhancement-log-native.png", dataUrl: `data:image/png;base64,${native.toString("base64")}` } });
    expect(upload.ok(), "The isolated authenticated media fixture must upload successfully").toBe(true);
    const uploaded = (await upload.json()) as { url: string; bytes: number; mimeType: string };
    expect(uploaded.url).toMatch(/^\/api\/reference-assets\/permanent\//);
    expect(uploaded.bytes).toBe(native.length);
    expect(uploaded.mimeType).toBe("image/png");
    const nativeUrl = uploaded.url;
    const delivered = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: "#6f8f74" } })
        .png()
        .toBuffer();
    const deliveredHash = createHash("sha256").update(delivered).digest("hex");
    const deliveredUpload = await request.post("/api/reference-assets", { data: { type: "image", persistent: true, originalName: "admin-enhancement-log-delivered.png", dataUrl: `data:image/png;base64,${delivered.toString("base64")}` } });
    expect(deliveredUpload.ok()).toBe(true);
    const deliveredAsset = (await deliveredUpload.json()) as { url: string; bytes: number; mimeType: string };
    expect(deliveredAsset.bytes).toBe(delivered.length);
    expect(deliveredAsset.mimeType).toBe("image/png");
    let completed = false;
    let detailReads = 0;
    let listReads = 0;
    const unexpected: string[] = [];
    const summary = (): PublicImageEnhancement => ({
        id: "fixture-enhancement",
        imageTaskId: "fixture-image-task",
        resultId: "fixture-result-one",
        status: completed ? "succeeded" : "running",
        phase: completed ? "receipt" : "poll",
        reason: null,
        attempt: 2,
        native: { url: nativeUrl, width: 1254, height: 1254, byteLength: native.length, sha256: nativeHash, format: "png", provenance: "provider_native" },
        plannedInference: { width: 5016, height: 5016 },
        target: { width: 4096, height: 4096 },
        model: { id: "fixture-model", binaryVersion: "binary-v2", modelVersion: "model-v3" },
        timings: completed ? { workerQueueMs: 0, workerExecutionMs: 500.25, deliveryEncodingMs: 2.75 } : { workerQueueMs: 0, workerExecutionMs: 125.5 },
        ...(completed
            ? {
                  ai: { width: 5016, height: 5016, byteLength: 5000, sha256: "b".repeat(64), format: "png" },
                  enhanced: { url: deliveredAsset.url, width: 4096, height: 4096, byteLength: delivered.length, sha256: deliveredHash, format: "png", assetId: "fixture-child" },
              }
            : {}),
        events: [
            { stage: "prepared", at: 1000, attempt: 2 },
            { stage: completed ? "published" : "worker_running", at: 2000, attempt: 2 },
        ],
        canRetry: false,
        canCancel: !completed,
    });
    const fixtureLog = (): StoredGenerationLog => ({
        id: "fixture-admin-log",
        userId: "fixture-owner",
        accountId: "0001",
        username: "creator",
        displayName: "创作者",
        kind: "image",
        source: "image-workbench",
        status: "success",
        title: "管理员增强日志夹具",
        prompt: "公开需求",
        model: "image-model",
        summary: "完成",
        durationMs: 55000,
        requestSnapshot: {
            version: 1,
            userPrompt: "公开需求",
            parameters: {},
            references: [],
            slots: [
                {
                    id: "fixture-image-task",
                    index: 0,
                    status: "success",
                    taskId: "fixture-image-task",
                    prompt: "fixture-executed-prompt",
                    attempts: [{ attemptNo: 1, model: "image-model", status: "succeeded", startedAt: 120000, completedAt: 175000, pointsCost: 1.5 }],
                },
            ],
            run: { id: "fixture-run", recordType: "generation", status: "completed", inputMessageId: "fixture-message", childTaskIds: ["fixture-image-task"], timings: { requestAcceptedAt: 1000, planningCompletedAt: 120000, runCompletedAt: 180000 } },
        },
        ecommerceTrace: {
            version: "ecommerce-generation-trace.v1",
            runId: "fixture-run",
            agentTaskId: "fixture-agent-task",
            imageTaskIds: ["fixture-image-task"],
            finalStatus: "completed",
            recordedAt: 180000,
            stages: [
                { key: "visual_analysis", status: "completed", startedAt: 1000, completedAt: 11000, output: { diagnostic: "fixture-analysis-diagnostic", references: [] } },
                { key: "edit_planning", status: "completed", completedAt: 120000, output: { operation: "product_to_scene", diagnostic: "fixture-planning-diagnostic" } },
                { key: "image_generation", status: "completed", startedAt: 120000, completedAt: 175000, output: { technicalCheck: { status: "passed" } } },
                { key: "quality_check", status: "not_run", output: { policy: "disabled" } },
            ],
        },
        count: 3,
        successCount: 3,
        failCount: 0,
        taskId: "fixture-image-task",
        createdAt: "2026-10-23T00:00:00.000Z",
        updatedAt: "2026-10-23T00:00:01.000Z",
        assets: [
            { type: "image", url: nativeUrl, width: 1254, height: 1254, bytes: native.length, resultId: "fixture-result-one", enhancementId: "fixture-enhancement", enhancement: summary() },
            { type: "image", url: nativeUrl, width: 1254, height: 1254, resultId: "fixture-result-two", enhancementSkip: { status: "skipped", reason: "protected_contract" } },
            { type: "image", url: nativeUrl, width: 1254, height: 1254, resultId: "fixture-result-three", enhancementId: "missing-fixture-enhancement" },
        ],
    });
    page.on("request", (outbound) => {
        const pathname = new URL(outbound.url()).pathname;
        if ((pathname.startsWith("/api/") && outbound.method() !== "GET") || /^\/api\/(?:image-tasks|image-enhancements|workers|ai)(?:\/|$)/.test(pathname)) unexpected.push(`${outbound.method()} ${pathname}`);
    });
    await page.route(/\/api\/admin\/generation-logs(?:\?.*)?$/, (route) => {
        if (route.request().method() !== "GET") return route.fulfill({ status: 405 });
        listReads += 1;
        return route.fulfill({ headers: { "cache-control": "private, no-store" }, json: { logs: [fixtureLog()], total: 1, page: 1, pageSize: 20 } });
    });

    await page.route(/\/api\/admin\/generation-logs\/fixture-admin-log$/, (route) => {
        detailReads += 1;
        return route.fulfill({ json: { code: 0, data: { log: fixtureLog() }, msg: "" } });
    });
    const previousReview = historicalReview("fixture-admin-log");
    const latestReview: GenerationLogEvaluation = {
        ...previousReview,
        id: "fixture-latest-review",
        createdAt: "2026-10-23T00:00:02.000Z",
        updatedAt: "2026-10-23T00:00:02.000Z",
        review: {
            ...previousReview.review,
            report: {
                outcome: "issues_found",
                summary: "最新复盘发现提示词约束冲突",
                limitations: ["未查看图片，不能评价画面效果"],
                issues: [{ category: "提示词约束冲突", message: "生成参数与保留项不一致", evidenceIds: ["technical"], recommendation: "提交前核对保留项" }],
            },
        },
    };
    await page.route(/\/api\/admin\/generation-logs\/fixture-admin-log\/evaluations$/, (route) =>
        route.fulfill({ status: route.request().method() === "GET" ? 200 : 405, json: { code: 0, data: { evaluations: [latestReview, previousReview] }, msg: "" } }),
    );

    await page.goto("/admin?section=logs", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    const row = page.locator(".admin-generation-log-table").getByRole("row").filter({ hasText: "管理员增强日志夹具" });
    await row.getByRole("button", { name: "详情", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "生成日志详情", exact: true });
    const observations = modal.getByTestId("generation-log-enhancement");
    await expect(observations).toHaveCount(3);
    const first = observations.nth(0);
    await expect(first.getByRole("status")).toHaveText("增强中");
    const diagnosis = first.locator("details");
    await expect(diagnosis).toHaveJSProperty("open", false);
    await expect(first.getByText("查询 Worker", { exact: true })).not.toBeVisible();
    await diagnosis.getByText("增强诊断与版本", { exact: true }).click();
    await expect(first.getByText("查询 Worker", { exact: true })).toBeVisible();
    await expect(first.getByText("125.5 ms", { exact: true })).toBeVisible();
    await expect(first.getByText("5016 × 5016", { exact: true })).toHaveCount(1);
    await expect(observations.nth(1)).toContainText("保护编辑契约不执行增强");
    await expect(observations.nth(1).locator("details")).toHaveCount(0);
    await expect(observations.nth(1)).not.toContainText("未取得");
    await expect(observations.nth(2).getByRole("status")).toHaveText("增强记录暂未取得");
    await expect(modal.getByText("成功 3 / 失败 0 / 共 3", { exact: true })).toBeVisible();

    await diagnosis.getByText("增强诊断与版本", { exact: true }).click();
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    const previousReads = listReads;
    completed = true;
    const response = page.waitForResponse((entry) => new URL(entry.url()).pathname === "/api/admin/generation-logs");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await response;
    await expect.poll(() => listReads).toBeGreaterThan(previousReads);
    await row.getByRole("button", { name: "详情", exact: true }).click();
    await expect(first.getByRole("status")).toHaveText("增强成功");
    await expect(diagnosis).toHaveJSProperty("open", false);
    await diagnosis.getByText("增强诊断与版本", { exact: true }).click();
    for (const text of ["确认接收", "原生实际尺寸", "1254 × 1254", "完整 AI 实际尺寸", "实际交付尺寸", "fixture-model", "binary-v2", "model-v3", "第 2 次尝试", "交付已保存", "0 ms", "500.25 ms", "2.75 ms"])
        await expect(first.getByText(text, { exact: true }).first()).toBeVisible();
    await expect(first.getByText("5016 × 5016", { exact: true })).toHaveCount(2);
    await expect(first.getByText("4096 × 4096", { exact: true })).toHaveCount(2);
    await expect(modal.getByText("成功 3 / 失败 0 / 共 3", { exact: true })).toBeVisible();
    const media = modal.getByTestId("generation-log-media-result").nth(0);
    await expect(media.getByRole("button", { name: "交付图", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(media.getByText("4096 × 4096", { exact: true })).toBeVisible();
    await expect(media.getByText("PNG", { exact: true })).toBeVisible();
    await expect(media.getByText(`${(delivered.length / 1024).toFixed(1)} KB`, { exact: true })).toBeVisible();
    await expect(media.getByText(deliveredHash, { exact: true })).toBeVisible();
    await expect(media.locator("img")).toHaveAttribute("src", new RegExp(deliveredAsset.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await media.locator("img").click();
    const zoom = page.locator(".agent-media-image-preview");
    await expect(zoom).toBeVisible();
    await expect(zoom.locator("img")).toHaveAttribute("src", /width=1920/);
    await page.keyboard.press("Escape");
    await expect(zoom).not.toBeVisible();
    await expect(modal).toBeVisible();

    await media.getByRole("button", { name: /^原\s*图$/ }).click();
    await expect(media.getByRole("button", { name: /^原\s*图$/ })).toHaveAttribute("aria-pressed", "true");
    await expect(media.getByText("1254 × 1254", { exact: true })).toBeVisible();
    await expect(media.getByText(nativeHash, { exact: true })).toBeVisible();
    await expect(media.locator("img")).toHaveAttribute("src", new RegExp(nativeUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(media.getByText(`${(native.length / 1024).toFixed(1)} KB`, { exact: true })).toBeVisible();
    const previousDetailReads = detailReads;
    await modal.getByRole("button", { name: "刷新详情", exact: true }).click();
    await expect.poll(() => detailReads).toBeGreaterThan(previousDetailReads);
    await expect(media.getByRole("button", { name: /^原\s*图$/ })).toHaveAttribute("aria-pressed", "true");
    await expect(media.getByText(nativeHash, { exact: true })).toBeVisible();
    await assertOriginalDownload(page, media.getByRole("link", { name: "下载原图", exact: true }), native, nativeUrl, info, "native-download.png");
    await assertOriginalDownload(page, media.getByRole("link", { name: "下载交付图", exact: true }), delivered, deliveredAsset.url, info, "delivered-download.png");

    await expect(modal.getByText("请求总耗时", { exact: true }).locator("..")).toContainText("179.00s");
    await expect(modal.getByText("规划耗时：未知（缺少完整时间记录）", { exact: true })).toBeVisible();
    const planning = modal.locator("div.py-3").filter({ has: page.getByText("编辑规划", { exact: true }) });
    await expect(planning).toContainText("开始：未知");
    await expect(planning).toContainText("耗时：未知（缺少完整时间记录）");
    const outcome = modal.getByRole("region", { name: "交付与评价摘要", exact: true });
    await expect(outcome.getByText("技术检查", { exact: true }).locator("..")).toContainText("通过");
    await expect(outcome.getByText("视觉评价", { exact: true }).locator("..")).toContainText("未执行");
    const evaluations = modal.getByRole("region", { name: "用户反馈与AI流程复盘", exact: true });
    await expect(evaluations).toContainText("用户反馈：未知，尚未记录");
    const report = evaluations.getByRole("article");
    await expect(report).toHaveCount(1);
    const latestSummary = report.getByText("最新复盘发现提示词约束冲突", { exact: true });
    await expect(latestSummary).toBeVisible();
    await expect(latestSummary).toHaveCSS("font-size", "12px");
    await expect(evaluations.getByText("流程复盘仅针对文字与元数据", { exact: true })).toHaveCount(0);
    await expect(report.getByText("提交前核对保留项", { exact: true })).not.toBeVisible();
    await report.getByRole("button", { name: "展开完整报告", exact: true }).click();
    await expect(report.getByText("提交前核对保留项", { exact: true })).toBeVisible();
    await report.getByText("复盘时的事实与证据", { exact: true }).click();
    await expect(report.locator("pre")).toContainText("fixture-facts-digest");
    const history = evaluations.getByRole("combobox", { name: "切换复盘记录", exact: true });
    await history.selectOption("fixture-ai-review");
    await expect(report).toContainText("流程复盘仅针对文字与元数据");
    await expect(report).toContainText("证据不足");
    await expect(latestSummary).toHaveCount(0);
    await history.selectOption("fixture-latest-review");
    await expect(latestSummary).toBeVisible();
    await expect(report.getByText("提交前核对保留项", { exact: true })).not.toBeVisible();
    await expect(modal.getByText("fixture-analysis-diagnostic", { exact: false })).not.toBeVisible();
    await expect(modal.getByText("fixture-executed-prompt", { exact: true })).not.toBeVisible();
    await planning.getByText("结构化输出", { exact: true }).click();
    await expect(planning.getByText("fixture-planning-diagnostic", { exact: false })).toBeVisible();
    const bounds = await media
        .locator(".grid")
        .evaluate((element) => ({ display: getComputedStyle(element).display, children: [...element.children].map((child) => ({ left: child.getBoundingClientRect().left, width: child.getBoundingClientRect().width })) }));
    expect(bounds.display).toBe("grid");
    expect(bounds.children[1]!.left).toBeGreaterThan(bounds.children[0]!.left);
    expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(media.locator("img")).toHaveAttribute("src", /format=webp/);
    await page.screenshot({ path: info.outputPath("admin-enhancement-log-light.png"), fullPage: true });

    await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await row.getByRole("button", { name: "详情", exact: true }).click();
    await expect(first.getByRole("status")).toHaveText("增强成功");
    await expect(observations.nth(1)).toContainText("保护编辑契约不执行增强");
    await expect(modal.getByText("成功 3 / 失败 0 / 共 3", { exact: true })).toBeVisible();
    expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("admin-enhancement-log-dark.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();
    expect(unexpected).toEqual([]);
});

test("administrator transcribes feedback durably and a read-only administrator cannot change it", async ({ page, request, browser }, info) => {
    const id = `e2e-feedback-${randomUUID()}`;
    const title = `用户反馈持久化 ${id}`;
    const created = await request.post("/api/generation-logs", {
        data: {
            id,
            title,
            kind: "image",
            source: "image-workbench",
            status: "pending",
            prompt: "保持桌子形状",
            durationMs: 999999,
            requestSnapshot: { version: 1, userPrompt: "保持桌子形状", parameters: {}, references: [], slots: [{ id: `${id}-slot`, index: 0, status: "pending", clientRequestId: `${id}-request` }] },
        },
    });
    expect(created.ok()).toBe(true);
    const logId = ((await created.json()) as { log: { id: string } }).log.id;
    const userMessage = "桌子的轮廓保持正确，但希望背景更明亮。";
    const readerName = `log_reader_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let readerId: string | undefined;
    const reader = await browser.newContext({ baseURL: info.project.use.baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 1672, height: 941 } });
    const generationRequests: string[] = [];
    page.on("request", (entry) => {
        if (/^\/api\/(?:ai|image-tasks|image-enhancements|workers)(?:\/|$)/.test(new URL(entry.url()).pathname)) generationRequests.push(entry.url());
    });
    try {
        await page.goto("/admin?section=logs", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        const row = page.locator(".admin-generation-log-table").getByRole("row").filter({ hasText: title });
        await row.getByRole("button", { name: "详情", exact: true }).click();
        const modal = page.getByRole("dialog", { name: "生成日志详情", exact: true });
        const feedback = modal.getByRole("region", { name: "用户反馈与AI流程复盘", exact: true });
        await expect(modal.getByText("请求总耗时", { exact: true }).locator("..")).toContainText("未知（缺少完整时间记录）");
        await expect(modal.getByText("规划耗时：未知（缺少完整时间记录）", { exact: true })).toBeVisible();
        await expect(feedback).toContainText("用户反馈：未知，尚未记录");
        await expect(feedback.getByRole("button", { name: "保存用户反馈", exact: true })).toBeDisabled();
        await feedback.getByRole("combobox", { name: "用户满意程度", exact: true }).click();
        await page
            .locator(".ant-select-dropdown:visible .ant-select-item-option-content")
            .filter({ hasText: /^部分满意$/ })
            .click();
        await feedback.getByRole("textbox", { name: "用户反馈原话", exact: true }).fill(userMessage);
        const saved = page.waitForResponse((entry) => new URL(entry.url()).pathname === `/api/admin/generation-logs/${logId}/evaluations` && entry.request().method() === "POST");
        await feedback.getByRole("button", { name: "保存用户反馈", exact: true }).click();
        expect((await saved).ok()).toBe(true);
        await expect(feedback.getByRole("article")).toContainText("用户反馈 · 部分满意");
        await expect(feedback.getByRole("article")).toContainText(userMessage);
        await expect(feedback).toContainText("用户反馈来源：管理员转录");
        const readback = await request.get(`/api/admin/generation-logs/${logId}/evaluations`);
        expect(readback.ok()).toBe(true);
        const evaluations = (await readback.json()) as { data: { evaluations: GenerationLogEvaluation[] } };
        expect(evaluations.data.evaluations).toHaveLength(1);
        expect(evaluations.data.evaluations[0]).toMatchObject({ kind: "feedback", status: "completed", actorName: E2E_ADMIN.displayName, feedback: { sentiment: "partly_satisfied", message: userMessage, source: "admin_transcribed" } });
        await page.reload({ waitUntil: "domcontentloaded" });
        await row.getByRole("button", { name: "详情", exact: true }).click();
        await expect(feedback.getByRole("article")).toContainText(userMessage);
        await expect(feedback.getByRole("article")).toContainText(E2E_ADMIN.displayName);

        const account = await request.post("/api/admin/users", { data: { username: readerName, displayName: "E2E 日志只读", password: E2E_ADMIN.password, role: "admin", status: "active", adminPermissions: ["generation.read"], pointsBalance: 0 } });
        expect(account.ok()).toBe(true);
        readerId = ((await account.json()) as { user: { id: string } }).user.id;
        const login = await reader.request.post("/api/auth/login", { data: { username: readerName, password: E2E_ADMIN.password } });
        expect(login.ok()).toBe(true);
        const readerPage = await reader.newPage();
        await readerPage.goto("/admin?section=logs", { waitUntil: "domcontentloaded" });
        await expect(readerPage.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        await readerPage.locator(".admin-generation-log-table").getByRole("row").filter({ hasText: title }).getByRole("button", { name: "详情", exact: true }).click();
        const readOnlyModal = readerPage.getByRole("dialog", { name: "生成日志详情", exact: true });
        const readOnlyFeedback = readOnlyModal.getByRole("region", { name: "用户反馈与AI流程复盘", exact: true });
        await expect(readOnlyFeedback.getByRole("article")).toContainText(userMessage);
        await expect(readOnlyFeedback.getByRole("button", { name: "保存用户反馈", exact: true })).toHaveCount(0);
        await expect(readOnlyFeedback.getByRole("button", { name: "手动 AI 流程复盘", exact: true })).toHaveCount(0);
        const deniedFeedback = await reader.request.post(`/api/admin/generation-logs/${logId}/evaluations`, { data: { kind: "feedback", requestId: randomUUID(), sentiment: "satisfied", message: "只读账号不能写入" } });
        expect(deniedFeedback.status()).toBe(403);
        const deniedReview = await reader.request.post(`/api/admin/generation-logs/${logId}/evaluations`, { data: { kind: "ai_review", requestId: randomUUID() } });
        expect(deniedReview.status()).toBe(403);
        const unchanged = await reader.request.get(`/api/admin/generation-logs/${logId}/evaluations`);
        expect((await unchanged.json()).data.evaluations).toEqual(evaluations.data.evaluations);
        await readerPage.screenshot({ path: info.outputPath("admin-log-feedback-readonly.png"), fullPage: true });
        expect(generationRequests).toEqual([]);
    } finally {
        await reader.close();
        expect((await request.delete("/api/admin/generation-logs", { data: { ids: [logId] } })).ok()).toBe(true);
        if (readerId) expect((await request.delete(`/api/admin/users/${readerId}`)).ok()).toBe(true);
    }
});

async function authenticateFixtureAdmin(page: Page, request: APIRequestContext) {
    if (process.env.VOZEB_PRO_M4_FRESH_FIXTURE !== "1") return;
    const session = await request.get("/api/auth/session");
    if (!(await session.json()).user) {
        const registered = await request.post("/api/auth/register", { data: { username: E2E_ADMIN.username, displayName: E2E_ADMIN.displayName, password: E2E_ADMIN.password, installToken: E2E_ADMIN.installToken } });
        if (!registered.ok()) {
            const loggedIn = await request.post("/api/auth/login", { data: { username: E2E_ADMIN.username, password: E2E_ADMIN.password } });
            expect(loggedIn.ok()).toBe(true);
        }
    }
    await page.context().addCookies((await request.storageState()).cookies);
}

async function assertOriginalDownload(page: Page, link: Locator, expected: Buffer, pathname: string, info: TestInfo, filename: string) {
    const event = page.waitForEvent("download");
    await link.click();
    const download = await event;
    expect(await download.failure()).toBeNull();
    const target = info.outputPath(filename);
    await download.saveAs(target);
    expect(await readFile(target)).toEqual(expected);
    const url = new URL(download.url());
    expect(url.pathname).toBe(pathname);
    expect(url.searchParams.get("download")).toBe("original");
    expect(url.searchParams.has("format")).toBe(false);
    expect(url.searchParams.has("width")).toBe(false);
}

function historicalReview(logId: string): Extract<GenerationLogEvaluation, { kind: "ai_review" }> {
    return {
        id: "fixture-ai-review",
        logId,
        userId: "fixture-owner",
        actorId: "fixture-admin",
        actorName: "历史管理员",
        fingerprint: "fixture-review-fingerprint",
        createdAt: "2026-10-23T00:00:01.000Z",
        updatedAt: "2026-10-23T00:00:01.000Z",
        kind: "ai_review",
        status: "completed",
        review: {
            ruleVersion: "fixture-rules-v1",
            mode: "text_metadata",
            model: { logicalModelId: "fixture-text-model", channelId: "fixture-text-channel", upstreamModel: "fixture-text-upstream" },
            factsDigest: "fixture-facts-digest",
            evidence: [{ id: "technical", label: "技术检查", facts: { status: "passed" } }],
            pointsCost: 0,
            report: { outcome: "insufficient_evidence", summary: "流程复盘仅针对文字与元数据", limitations: ["未查看图片，不能评价画面效果"], issues: [] },
        },
    };
}
