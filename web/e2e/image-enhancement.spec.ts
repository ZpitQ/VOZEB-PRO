import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { expect, test } from "@playwright/test";
import { E2E_ADMIN } from "./support";

test("administrator configures enhancement while disabled and controls readiness independently", async ({ page, request }, info) => {
    if (process.env.VOZEB_PRO_M4_FRESH_FIXTURE === "1") {
        const registration = await request.post("/api/auth/register", { data: { username: E2E_ADMIN.username, displayName: E2E_ADMIN.displayName, password: E2E_ADMIN.password, installToken: E2E_ADMIN.installToken } });
        expect(registration.ok()).toBe(true);
        await page.context().addCookies((await request.storageState()).cookies);
    }
    const access = "fixture-enhancement-access";
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#eee6de" } })
        .png()
        .toBuffer();
    const output = { width: 32, height: 32, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), format: "png" };
    const model = { id: "fixture-model", binaryVersion: "v1", binarySha256: "a".repeat(64), modelVersion: "v1", modelSha256: "b".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 };
    const alternate = { ...model, id: "fixture-alternative", modelVersion: "v2", modelSha256: "c".repeat(64) };
    const serviceId = "31313131-3131-4131-8131-313131313131";
    const jobId = "42424242-4242-4242-8242-424242424242";
    let rejectAccess = false;
    const calls: string[] = [];
    const server = createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`);
        if (rejectAccess || req.headers.authorization !== `Bearer ${access}`) {
            res.writeHead(401).end();
            return;
        }
        if (req.url?.endsWith("/result")) {
            res.writeHead(200, { "content-type": "image/png" }).end(bytes);
            return;
        }
        const data =
            req.url === "/v1/capabilities"
                ? { serviceId, protocolVersion: "image-enhancement.v1", normalizationProfile: "srgb-upright-v1", models: [model, alternate], budgets: { ai: { maxBytes: 1_000_000, maxPixels: 1_000_000 } }, ready: true }
                : req.url === "/v1/self-test"
                  ? { bootId: "fixture-boot", assetId: "zeb-enhancement-calibration-v1", phase: "output_verified", qualification: "qualified", jobId, reason: null, output }
                  : { job: { serviceId, jobId, status: "succeeded", source: { width: 8, height: 8 }, engineInput: { width: 8, height: 8 }, result: output, plan: { engine: { ...model, modelId: model.id, tile: model.defaultTile } } } };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code: "ok", data, msg: "OK" }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        await page.goto("/admin?section=imageEnhancement");
        await expect(page.getByRole("heading", { name: "AI 高清增强", level: 3, exact: true })).toBeVisible();
        const toggle = page.getByRole("switch", { name: "启用 AI 高清增强" });
        await expect(toggle).not.toBeChecked();
        await expect(toggle).toBeDisabled();
        const contrast = await page.getByText("保存配置后，依次检查连接和样图；通过前无法首次开启。", { exact: true }).evaluate((element) => {
            const root = element.closest(".ant-alert")!;
            const luminance = (color: string) =>
                color
                    .match(/[\d.]+/g)!
                    .slice(0, 3)
                    .map((value) => {
                        const channel = Number(value) / 255;
                        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                    })
                    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
            const a = luminance(getComputedStyle(element).color);
            const b = luminance(getComputedStyle(root).backgroundColor);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        expect(contrast).toBeGreaterThanOrEqual(4.5);
        await page.getByLabel("服务地址", { exact: true }).fill(endpoint);
        await page.getByLabel("专用访问密钥", { exact: true }).fill(access);
        await expect(page.getByRole("button", { name: "检查连接", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "检查连接", exact: true }).click();
        await expect(page.getByText("访问密钥已配置", { exact: false })).toBeVisible();
        await page.reload();
        await expect(page.getByLabel("服务地址", { exact: true })).toHaveValue(endpoint);
        await expect(page.getByLabel("专用访问密钥", { exact: true })).toHaveValue("");
        await expect(page.getByLabel("请求超时（毫秒）", { exact: true })).toHaveValue("30000");
        await page.getByRole("button", { name: "检查连接", exact: true }).click();
        await expect(page.getByText("连接与能力检查通过，请选择模型并执行样图自检。", { exact: true })).toBeVisible();
        await page.getByLabel("默认增强模型", { exact: true }).click();
        await expect(page.getByRole("option", { name: "fixture-model · 原生 ×4", exact: true })).toBeAttached();
        await page.getByText("fixture-alternative · 原生 ×4", { exact: true }).click();
        await page.getByRole("button", { name: "保存配置", exact: true }).click();
        await page.getByRole("button", { name: "样图自检", exact: true }).click();
        await expect(page.getByText("样图已完整下载和解码，当前配置检查通过。", { exact: true })).toBeVisible();
        await expect(toggle).toBeEnabled();
        await toggle.click();
        await expect(toggle).toBeChecked();
        await page.reload();
        await expect(toggle).toBeChecked();
        await expect(page.getByText("fixture-alternative · 原生 ×4", { exact: true })).toBeVisible();
        rejectAccess = true;
        await page.getByRole("button", { name: "检查连接", exact: true }).click();
        await expect(page.getByText("增强服务拒绝访问密钥，请替换有效密钥。", { exact: true })).toBeVisible();
        await expect(toggle).toBeChecked();
        await toggle.click();
        await expect(toggle).not.toBeChecked();
        rejectAccess = false;
        await page.getByRole("button", { name: "样图自检", exact: true }).click();
        await expect(page.getByText("样图已完整下载和解码，当前配置检查通过。", { exact: true })).toBeVisible();
        const clear = page.getByRole("button", { name: "清除访问密钥", exact: true });
        await clear.click();
        await page.getByRole("button", { name: "确认清除", exact: true }).click();
        await expect(page.getByText("尚未配置访问密钥", { exact: false })).toBeVisible();
        await page.reload();
        await expect(page.getByLabel("服务地址", { exact: true })).toHaveValue(endpoint);
        await expect(page.getByText("尚未配置访问密钥", { exact: false })).toBeVisible();
        const saved = await request.get("/api/admin/image-enhancement");
        const settings = (await saved.json()).data;
        expect(settings).toMatchObject({ hasToken: false, ready: false, enabled: false });
        expect(JSON.stringify(settings)).not.toContain(access);
        expect(calls.every((call) => call.startsWith("GET"))).toBe(true);
        const bounds = await page
            .locator('[data-testid="enhancement-connection-grid"]')
            .evaluate((element) => ({
                display: getComputedStyle(element).display,
                width: element.getBoundingClientRect().width,
                childBounds: [...element.children].map((child) => ({ left: child.getBoundingClientRect().left, width: child.getBoundingClientRect().width })),
            }));
        expect(bounds.display).toBe("grid");
        expect(bounds.childBounds[1]!.left).toBeGreaterThan(bounds.childBounds[0]!.left);
        await page.screenshot({ path: info.outputPath("enhancement-light.png"), fullPage: true });
        await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
        await page.reload();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await expect(page.getByLabel("服务地址", { exact: true })).toHaveValue(endpoint);
        await page.screenshot({ path: info.outputPath("enhancement-dark.png"), fullPage: true });
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
