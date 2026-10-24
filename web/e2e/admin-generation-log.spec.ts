import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import sharp from "sharp";

import type { PublicImageEnhancement } from "../src/lib/image-enhancement-contract";
import type { StoredGenerationLog } from "../src/lib/server/generation-log-types";
import { E2E_ADMIN } from "./support";

test("administrator refreshes independent enhancement facts while preserving original generation success and download", async ({ page, request }, info) => {
    test.skip(info.project.name !== "chromium", "管理员增强日志按桌面 Chromium 验收");
    await page.setViewportSize({ width: 1672, height: 941 });
    if (process.env.VOZEB_PRO_M4_FRESH_FIXTURE === "1") {
        const registered = await request.post("/api/auth/register", { data: { username: E2E_ADMIN.username, displayName: E2E_ADMIN.displayName, password: E2E_ADMIN.password, installToken: E2E_ADMIN.installToken } });
        expect(registered.ok()).toBe(true);
        await page.context().addCookies((await request.storageState()).cookies);
    }
    const native = await sharp({ create: { width: 1254, height: 1254, channels: 3, background: "#b7c1ca" } }).png().toBuffer();
    const nativeHash = createHash("sha256").update(native).digest("hex");
    const upload = await request.post("/api/reference-assets", { data: { type: "image", persistent: true, originalName: "admin-enhancement-log-native.png", dataUrl: `data:image/png;base64,${native.toString("base64")}` } });
    expect(upload.ok(), "The isolated authenticated media fixture must upload successfully").toBe(true);
    const uploaded = await upload.json() as { url: string; bytes: number; mimeType: string };
    expect(uploaded.url).toMatch(/^\/api\/reference-assets\/permanent\//);
    expect(uploaded.bytes).toBe(native.length);
    expect(uploaded.mimeType).toBe("image/png");
    const nativeUrl = uploaded.url;
    let completed = false;
    let listReads = 0;
    const unexpected: string[] = [];
    const summary = (): PublicImageEnhancement => ({
        id: "fixture-enhancement", imageTaskId: "fixture-image-task", resultId: "fixture-result-one", status: completed ? "succeeded" : "running", phase: completed ? "receipt" : "poll", reason: null, attempt: 2,
        native: { url: nativeUrl, width: 1254, height: 1254, byteLength: native.length, sha256: nativeHash, format: "png", provenance: "provider_native" }, plannedInference: { width: 5016, height: 5016 }, target: { width: 4096, height: 4096 }, model: { id: "fixture-model", binaryVersion: "binary-v2", modelVersion: "model-v3" },
        timings: completed ? { workerQueueMs: 0, workerExecutionMs: 500.25, deliveryEncodingMs: 2.75 } : { workerQueueMs: 0, workerExecutionMs: 125.5 },
        ...(completed ? { ai: { width: 5016, height: 5016, byteLength: 5000, sha256: "b".repeat(64), format: "png" }, enhanced: { url: "/api/generation-log-assets/fixture-delivered.png", width: 4096, height: 4096, byteLength: 4000, sha256: "c".repeat(64), format: "png", assetId: "fixture-child" } } : {}),
        events: [{ stage: "prepared", at: 1000, attempt: 2 }, { stage: completed ? "published" : "worker_running", at: 2000, attempt: 2 }], canRetry: false, canCancel: !completed,
    });
    const fixtureLog = (): StoredGenerationLog => ({
        id: "fixture-admin-log", userId: "fixture-owner", accountId: "0001", username: "creator", displayName: "创作者", kind: "image", source: "image-workbench", status: "success", title: "管理员增强日志夹具", prompt: "公开需求", model: "image-model", summary: "完成", durationMs: 1000, count: 3, successCount: 3, failCount: 0, taskId: "fixture-image-task", createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:01.000Z",
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

    await page.goto("/admin?section=logs", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    const row = page.locator(".admin-generation-log-table").getByRole("row").filter({ hasText: "管理员增强日志夹具" });
    await row.getByRole("button", { name: "详情", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "生成日志详情", exact: true });
    const observations = modal.getByTestId("generation-log-enhancement");
    await expect(observations).toHaveCount(3);
    const first = observations.nth(0);
    await expect(first.getByRole("status")).toHaveText("增强中");
    await expect(first.getByText("查询 Worker", { exact: true })).toBeVisible();
    await expect(first.getByText("125.5 ms", { exact: true })).toBeVisible();
    await expect(first.getByText("5016 × 5016", { exact: true })).toHaveCount(1);
    await expect(observations.nth(1)).toContainText("保护编辑契约不执行增强");
    await expect(observations.nth(2).getByRole("status")).toHaveText("增强记录暂未取得");
    await expect(modal.getByText("成功 3 / 失败 0 / 共 3", { exact: true })).toBeVisible();

    await modal.getByRole("button", { name: "Close", exact: true }).click();
    const previousReads = listReads;
    completed = true;
    const response = page.waitForResponse((entry) => new URL(entry.url()).pathname === "/api/admin/generation-logs");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await response;
    await expect.poll(() => listReads).toBeGreaterThan(previousReads);
    await row.getByRole("button", { name: "详情", exact: true }).click();
    await expect(first.getByRole("status")).toHaveText("增强成功");
    for (const text of ["确认接收", "原生实际尺寸", "1254 × 1254", "完整 AI 实际尺寸", "实际交付尺寸", "fixture-model", "binary-v2", "model-v3", "第 2 次尝试", "交付已保存", "0 ms", "500.25 ms", "2.75 ms"]) await expect(first.getByText(text, { exact: true }).first()).toBeVisible();
    await expect(first.getByText("5016 × 5016", { exact: true })).toHaveCount(2);
    await expect(first.getByText("4096 × 4096", { exact: true })).toHaveCount(2);
    await expect(modal.getByText("成功 3 / 失败 0 / 共 3", { exact: true })).toBeVisible();
    const downloadEvent = page.waitForEvent("download");
    await first.getByRole("link", { name: "下载原图", exact: true }).click();
    const download = await downloadEvent;
    expect(await download.failure()).toBeNull();
    const downloadedPath = info.outputPath("native-download.png");
    await download.saveAs(downloadedPath);
    expect(createHash("sha256").update(await readFile(downloadedPath)).digest("hex")).toBe(nativeHash);
    expect(new URL(download.url()).pathname).toBe(nativeUrl);
    const bounds = await first.locator(".grid").evaluate((element) => ({ display: getComputedStyle(element).display, children: [...element.children].map((child) => ({ left: child.getBoundingClientRect().left, width: child.getBoundingClientRect().width })) }));
    expect(bounds.display).toBe("grid");
    expect(bounds.children[1]!.left).toBeGreaterThan(bounds.children[0]!.left);
    expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(modal.locator("img").first()).toHaveAttribute("src", /format=webp/);
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
    expect(unexpected).toEqual([]);
});
