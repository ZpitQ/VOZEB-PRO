import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import sharp from "sharp";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { EcommerceCanvasConstraint, EcommercePhotographyPlan, EcommerceVisibleStructure } from "../src/lib/server/ecommerce-edit-plan";
import type { EcommerceCanvasQualityEvidence, EcommerceQualityCheck } from "../src/lib/server/ecommerce-quality-check";
import type { SceneEditProtectionEvidence } from "../src/lib/server/ecommerce-product-regions";
import type { CreativeAgentRun } from "../src/services/api/creative";
import type { CreativeReferenceRecovery, CreativeReferenceReview } from "../src/lib/creative-runtime-contract";
import type { AdminGenerationTask } from "../src/lib/admin-generation-operations";

import { expectNoHorizontalOverflow } from "./responsive-helpers";
import { E2E_PROTOCOL_ORIGIN, e2eSettingsPatch, protocolFixtureState, resetProtocolFixture } from "./support";
import { observeResidentF02 } from "./resident-f02-observation";

type GoldenCase = {
    caseId?: string;
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
type GoldenRegression = {
    caseId: string;
    scenario: string;
    userRequest: string;
    followupRequest?: string;
    source?: { kind: "deterministic_scene"; width: number; height: number };
    residualSize?: string;
    expectedOperation: string;
    hardProtections: string[];
    expectedQuality: string;
    manualAcceptance: "pending";
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
        error?: string;
    }>;
    ecommerceQualityStatus?: string;
    ecommerceSceneSelection?: CreativeAgentRun["ecommerceSceneSelection"];
    ecommerceReferenceReview?: CreativeReferenceReview | null;
};
type TraceModel = {
    logicalRole?: string;
    capability?: string;
    logicalModelId?: string;
    channelId?: string;
    upstreamModel?: string;
    apiFormat?: string;
};
type TraceReference = { assetId: string; role?: "product" | "scene"; contentType?: string };
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
        analysisVersion?: string;
        planVersion?: string;
        compilerVersion?: string;
        version?: string;
        photography?: EcommercePhotographyPlan;
        visibleStructure?: EcommerceVisibleStructure[];
        protection?: { scope: string; preserveOutsideMask: boolean; allowLightingChange: boolean };
        observations?: EcommerceQualityCheck["observations"];
        sceneProtectionEvidence?: Array<{ resultId: string; evidence: SceneEditProtectionEvidence }>;
        operation?: string;
        source?: {
            productAnchorId?: string;
            currentSceneBaselineId?: string | null;
            sceneReferenceIds?: string[];
        };
        preserve?: { productCore?: string[] };
        continuity?: { parentResultId?: string | null; sceneRootAssetId?: string | null; branchId?: string; parentQualityCheck?: EcommerceQualityCheck };
        executionPrompt?: string;
        referenceRoles?: TraceReference[];
        mask?: { mode?: string; required?: boolean };
        imageTaskIds?: string[];
        checks?: TraceQualityCheck[];
        hardFailures?: TraceQualityCheck[];
        canvas?: EcommerceCanvasConstraint;
        canvasEvidence?: EcommerceCanvasQualityEvidence[];
        policy?: "disabled" | "advisory";
        technicalCheck?: { status: string };
        modelRoles?: { qualityCheck: string | null };
    };
};
type EcommerceTrace = {
    runId: string;
    imageTaskIds: string[];
    stages: TraceStage[];
    finalStatus: string;
};

const QUALITY_CHECKS = [
    "product_identity",
    "product_silhouette",
    "product_color_material",
    "product_proportions_view",
    "brand_logo",
    "packaging_text",
    "scene_intent",
    "composition_lighting",
    "protected_structure",
    "protected_material",
    "unmodified_region",
] as const;
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

const manifest = JSON.parse(readFileSync(new URL("./fixtures/ecommerce-product-cases.json", import.meta.url), "utf8")) as Array<GoldenCase | GoldenRegression>;
const cases = manifest.filter((item): item is GoldenCase => "id" in item);
const regressions = manifest.filter((item): item is GoldenRegression => "scenario" in item);
const fixtureBytes = new Map<string, { buffer: Buffer; sha256: string }>();
let pausedRunForCleanup: { runId: string; conversationId: string } | undefined;

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
    pausedRunForCleanup = undefined;
    await resetProtocolFixture(request);
    const saved = await request.patch("/api/admin/settings", { data: { ...e2eSettingsPatch(), ecommerceVisualQualityCheckEnabled: true } });
    expect(saved.ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
    const saved = await request.patch("/api/admin/settings", { data: { ecommerceVisualQualityCheckEnabled: false } });
    expect(saved.ok()).toBe(true);
    if (!pausedRunForCleanup) return;
    const response = await request.post(`/api/agent/runs/${encodeURIComponent(pausedRunForCleanup.runId)}/cancel`, {
        data: { conversationId: pausedRunForCleanup.conversationId },
    });
    if (!response.ok()) throw new Error(`Unable to clean up paused ecommerce run: ${response.status()} ${await response.text()}`);
    pausedRunForCleanup = undefined;
});

test("optional-quality-toggle:后台双向保存立即回读并刷新保持", async ({ page, request }) => {
    await request.patch("/api/admin/settings", { data: { ecommerceVisualQualityCheckEnabled: false } });
    await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "电商流程", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "启用可选视觉质检", exact: true });
    await expect(toggle).not.toBeChecked();
    for (const enabled of [true, false]) {
        await toggle.setChecked(enabled);
        const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/admin/settings");
        await page.getByRole("button", { name: "保存模型渠道配置", exact: true }).click();
        expect((await saved).ok()).toBe(true);
        const persisted = await request.get("/api/admin/settings");
        expect(persisted.ok()).toBe(true);
        expect((await persisted.json()).settings.ecommerceVisualQualityCheckEnabled).toBe(enabled);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("tab", { name: "电商流程", exact: true }).click();
        await expect(toggle).toBeChecked({ checked: enabled });
    }
});

test("reference-confirm:真实用途歧义刷新后确认同一轮并复用有效分析", async ({ page, request }) => {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    const product = cases[0];
    const scene = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#567789" } })
        .png()
        .toBuffer();
    await page.locator('input[type="file"][multiple]').setInputFiles([uploadFixture(product.fixturePath, product.productFileName, product.fixtureSha256), { name: "reference-scene.png", mimeType: "image/png", buffer: scene }]);
    const created = await submitPrompt(page, "图片1和图片2", { reusePage: true });
    pausedRunForCleanup = created;
    const waiting = await waitForRun(request, created.runId, "paused");
    expect(waiting.ecommerceReferenceReview?.kind).toBe("confirm_purposes");
    expectPublicWhitelist(waiting);
    const beforeMessages = await request.get(`/api/creative/conversations/${created.conversationId}/messages`).then((response) => response.json());
    const before = await protocolFixtureState(request);
    expect(before.requests.filter((item) => item.method === "POST" && /\/images\//.test(item.path))).toHaveLength(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("creative-reference-review");
    await expect(panel).toHaveCount(1);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-review-id", waiting.ecommerceReferenceReview!.reviewId);
    const entries = panel.getByTestId("creative-reference-review-asset");
    await expect(entries).toHaveCount(2);
    for (const [index, asset] of waiting.ecommerceReferenceReview!.assets.entries()) await expect(entries.nth(index).getByRole("img", { name: asset.alias, exact: true })).toHaveAttribute("src", `${asset.previewUrl}?format=webp&width=320`);
    await entries.nth(0).getByRole("radio", { name: "修改这张图", exact: true }).check();
    await entries.nth(0).getByRole("checkbox", { name: "保留商品身份", exact: true }).check();
    await entries.nth(1).getByRole("checkbox", { name: "参考光线", exact: true }).check();
    const response = page.waitForResponse((value) => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/agent/runs/${created.runId}/resume`);
    await panel.getByRole("button", { name: "确认用途并继续", exact: true }).click();
    const resumed = await response;
    expect(resumed.ok(), await resumed.text()).toBe(true);
    const body = resumed.request().postDataJSON() as { conversationId: string; referenceRecovery: CreativeReferenceRecovery };
    expect(body).toMatchObject({ conversationId: created.conversationId, referenceRecovery: { reviewId: waiting.ecommerceReferenceReview!.reviewId, action: "confirm_purposes", decisionVersion: "ecommerce-reference-decision.v1" } });
    expect(((await resumed.json()).data.run as PublicRun).ecommerceReferenceReview).toBeNull();
    expect((await request.post(`/api/agent/runs/${created.runId}/resume`, { data: body })).status()).toBe(409);
    const completed = await waitForRun(request, created.runId, "completed");
    pausedRunForCleanup = undefined;
    const trace = await expectAdminTrace(request, created.runId, "passed");
    expectLatestTraceVersions(trace);
    const after = await protocolFixtureState(request);
    const analyses = (state: typeof after) => state.requests.filter((item) => item.method === "POST" && item.model === MODEL_ROUTES.visual_analysis.upstreamModel).length;
    expect(analyses(after)).toBe(analyses(before));
    expect(after.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(1);
    const afterMessages = await request.get(`/api/creative/conversations/${created.conversationId}/messages`).then((value) => value.json());
    expect(afterMessages.data.messages.map((message: { id: string }) => message.id)).toEqual(beforeMessages.data.messages.map((message: { id: string }) => message.id));
    await expectProductResult(page);
    await expectNoHorizontalOverflow(page);
});

test("reference-retry:真实分析服务失败刷新后重新分析原Run并完成整图生成", async ({ page, request }) => {
    const control = (enabled: boolean) => request.post(`${E2E_PROTOCOL_ORIGIN}/__ecommerce-analysis-failure`, { data: { enabled } });
    expect((await control(true)).ok()).toBe(true);
    try {
        const created = await submitProductScene(page, cases[0]);
        pausedRunForCleanup = created;
        const waiting = await waitForRun(request, created.runId, "paused");
        expect(waiting.ecommerceReferenceReview?.kind).toBe("retry_analysis");
        expectPublicWhitelist(waiting);
        const messages = await request.get(`/api/creative/conversations/${created.conversationId}/messages`).then((response) => response.json());
        expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && /\/images\//.test(item.path))).toHaveLength(0);
        expect((await control(false)).ok()).toBe(true);
        await page.reload({ waitUntil: "domcontentloaded" });
        const panel = page.getByTestId("creative-reference-review");
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("img")).toHaveCount(1);
        await expect(panel.getByRole("radio")).toHaveCount(0);
        const response = page.waitForResponse((value) => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/agent/runs/${created.runId}/resume`);
        await panel.getByRole("button", { name: "重新分析", exact: true }).click();
        const resumed = await response;
        expect(resumed.ok(), await resumed.text()).toBe(true);
        expect(resumed.request().postDataJSON()).toEqual({ conversationId: created.conversationId, referenceRecovery: { reviewId: waiting.ecommerceReferenceReview!.reviewId, action: "retry_analysis" } });
        const completed = await waitForRun(request, created.runId, "completed");
        pausedRunForCleanup = undefined;
        expectLatestTraceVersions(await expectAdminTrace(request, created.runId, "passed"));
        const afterMessages = await request.get(`/api/creative/conversations/${created.conversationId}/messages`).then((value) => value.json());
        expect(afterMessages.data.messages.map((message: { id: string }) => message.id)).toEqual(messages.data.messages.map((message: { id: string }) => message.id));
        expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(1);
        await expectProductResult(page);
        await expectNoHorizontalOverflow(page);
    } finally {
        expect((await control(false)).ok()).toBe(true);
    }
});

for (const kind of ["confirm_purposes", "retry_analysis"] as const)
    test(`reference-ui-${kind}:完成态助手刷新复核缩略图并保留409与单次提交`, async ({ page }) => {
        const fixture = await installReferenceReviewFixture(page, kind);
        await page.goto(`/create?conversationId=${fixture.run.conversationId}`, { waitUntil: "domcontentloaded" });
        let panel = page.getByTestId("creative-reference-review");
        await expect(panel).toBeVisible();
        await expect(page.getByText("已为你生成图片", { exact: true })).toHaveCount(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        panel = page.getByTestId("creative-reference-review");
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("img", { name: "图片1", exact: true })).toHaveAttribute("src", `${fixture.run.ecommerceReferenceReview!.assets[0].previewUrl}?format=webp&width=320`);
        const button = panel.getByRole("button");
        await expect(button).toHaveCount(1);
        await expect(button).toHaveAccessibleName(kind === "confirm_purposes" ? "确认用途并继续" : "重新分析");
        if (kind === "confirm_purposes") {
            await expect(panel.getByRole("img", { name: "当前图片", exact: true })).toHaveAttribute("src", `${fixture.run.ecommerceReferenceReview!.inheritedEditTarget!.previewUrl}?format=webp&width=320`);
            await expect(panel.getByRole("radio", { name: "继续修改当前图片", exact: true })).toBeChecked();
            await expect(panel.getByRole("radio", { name: "修改这张图", exact: true })).toHaveCount(0);
            await expect(panel.getByRole("checkbox", { name: "保留商品身份", exact: true })).toHaveCount(0);
            await expect(button).toBeDisabled();
            await panel.getByRole("checkbox", { name: "参考光线", exact: true }).check();
            await expect(button).toBeEnabled();
            await panel.getByRole("checkbox", { name: "参考光线", exact: true }).uncheck();
            await expect(button).toBeDisabled();
            await panel.getByRole("checkbox", { name: "参考光线", exact: true }).check();
        }
        await expect(button).toBeEnabled();
        await button.dblclick();
        await expect(button).toBeDisabled();
        await expect(panel.locator(".anticon-loading")).toBeVisible();
        await fixture.requestReceived;
        expect(fixture.controls).toHaveLength(1);
        fixture.release();
        await expect(panel.getByRole("alert")).toContainText("参考复核已变化，请刷新后重试。");
        await expect(button).toBeEnabled();
        expect(fixture.controls).toHaveLength(1);
        expect(fixture.controls[0]).toEqual({
            conversationId: fixture.run.conversationId,
            referenceRecovery:
                kind === "retry_analysis"
                    ? { reviewId: "r3-review", action: kind }
                    : { reviewId: "r3-review", action: kind, decisionVersion: "ecommerce-reference-decision.v1", bindings: [{ assetId: "r3-product", assetVersion: "r3-product-version", purposes: ["lighting"] }] },
        });
        expect(fixture.createdRuns()).toBe(0);
        await expect(page.getByTestId("creative-round-request")).toHaveCount(1);
        await expectNoHorizontalOverflow(page);
    });

for (const action of ["retry_source", "check_status"] as const)
    test(`reference-ui-${action}:刷新后恢复原Run且不创建第二轮`, async ({ page }) => {
        const fixture = await installReferenceReviewFixture(page, action, true);
        const original = { id: fixture.run.id, conversationId: fixture.run.conversationId, inputMessageId: fixture.run.inputMessageId, assistantMessageId: fixture.run.assistantMessageId };
        await page.goto(`/create?conversationId=${original.conversationId}`, { waitUntil: "domcontentloaded" });
        const label = action === "retry_source" ? "重试并继续" : "检查状态";
        await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
        await page.reload({ waitUntil: "domcontentloaded" });
        const waitingPanel = page.getByTestId("creative-generation-waiting");
        const button = waitingPanel.getByRole("button");
        await expect(button).toHaveCount(1);
        await expect(button).toHaveAccessibleName(label);
        await expect(button).toBeVisible();
        const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/agent/runs/${original.id}/resume` && response.request().method() === "POST");
        await button.dblclick();
        await expect(button).toBeDisabled();
        if (action === "check_status") await expect(button).toHaveText("正在检查");
        await fixture.requestReceived;
        expect(fixture.controls).toHaveLength(1);
        expect(fixture.controls[0]).toEqual({ conversationId: original.conversationId, ...(action === "retry_source" ? { referenceRecovery: { reviewId: "r3-review", action } } : {}) });
        fixture.release();
        const response = await responsePromise;
        expect(response.ok()).toBe(true);
        expect(fixture.controls).toHaveLength(1);
        expect((await response.json()).data.run).toMatchObject({ ...original, status: action === "retry_source" ? "planning" : "running", ecommerceReferenceReview: null, canCheckStatus: false });
        await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
        await expect(waitingPanel.getByRole("button")).toHaveCount(0);
        await expect(page.getByTestId("creative-generation-waiting")).toBeVisible();
        expect(fixture.createdRuns()).toBe(0);
        await expect(page.getByTestId("creative-round-request")).toHaveCount(1);
        await expectNoHorizontalOverflow(page);
    });

async function installReferenceReviewFixture(page: Page, kind: CreativeReferenceReview["kind"] | "check_status", continueOriginal = false) {
    const timestamp = Date.now();
    const conversation = { id: "r3-conversation", userId: "fixture-user", surface: "chat", source: "agent", title: "参考复核", createdAt: timestamp, updatedAt: timestamp };
    const run: CreativeAgentRun = {
        id: "r3-run",
        conversationId: conversation.id,
        inputMessageId: "r3-input",
        assistantMessageId: "r3-assistant",
        surface: "chat",
        status: "paused",
        prompt: kind === "confirm_purposes" ? "参考图片1的光线继续修改当前图片" : "修改图片1",
        createdAt: timestamp,
        updatedAt: timestamp,
        assetIds: [],
        generationPreferences: { mode: "image" },
        tasks: kind === "check_status" ? [{ id: "r3-image-task", title: "商品场景图", type: "image", model: "fixture-image", status: "needs_review", error: "参考图片暂时无法读取，请检查状态后继续原任务。" }] : [],
        canCheckStatus: kind === "check_status",
        ecommerceReferenceReview:
            kind === "check_status"
                ? null
                : {
                      version: "ecommerce-reference-review.v1",
                      reviewId: "r3-review",
                      kind,
                      question: kind === "retry_source" ? "参考图片暂时无法读取，可重试后继续这次创作。" : "请确认参考用途后继续这次创作。",
                      ...(kind === "confirm_purposes" ? { inheritedEditTarget: { assetId: "r3-current", previewUrl: "/api/reference-assets/r3-current.png" } } : {}),
                      assets: [
                          {
                              assetId: "r3-product",
                              assetVersion: "r3-product-version",
                              alias: "图片1",
                              previewUrl: "/api/reference-assets/r3-product.png",
                              purposes: kind === "confirm_purposes" ? [] : ["edit_target", "product_identity"],
                              allowedPurposes: kind === "confirm_purposes" ? ["lighting"] : ["edit_target", "product_identity"],
                          },
                      ],
                  },
    };
    const controls: unknown[] = [];
    let created = 0;
    const gate = Promise.withResolvers<void>();
    const requestReceived = Promise.withResolvers<void>();
    const messages = [
        { id: run.inputMessageId, conversationId: conversation.id, runId: run.id, sequence: 1, role: "user", status: "completed", content: run.prompt, metadata: {}, createdAt: timestamp, updatedAt: timestamp },
        { id: run.assistantMessageId, conversationId: conversation.id, runId: run.id, sequence: 2, role: "assistant", status: "completed", content: "已保存这次任务进度", metadata: {}, createdAt: timestamp, updatedAt: timestamp },
    ];
    const preview = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#987654" } })
        .png()
        .toBuffer();
    await page.route(/\/api\/reference-assets\/r3-(?:product|current)\.png(?:\?.*)?$/, (route) => route.fulfill({ body: preview, contentType: "image/png" }));
    await page.route(/\/api\/creative\/conversations(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { conversations: [conversation], hasMore: false } } }));
    await page.route(/\/api\/creative\/conversations\/r3-conversation$/, (route) => route.fulfill({ json: { code: 0, data: { conversation } } }));
    await page.route(/\/api\/creative\/conversations\/r3-conversation\/messages(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { messages, hasMore: false } } }));
    await page.route(/\/api\/creative\/conversations\/r3-conversation\/assets(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { assets: [] } } }));
    await page.route(/\/api\/agent\/runs(?:\?.*)?$/, (route) => {
        if (route.request().method() === "POST") created++;
        return route.fulfill({ json: { code: 0, data: { runs: [run] } } });
    });
    await page.route(/\/api\/agent\/runs\/r3-run$/, (route) => route.fulfill({ json: { code: 0, data: { run } } }));
    await page.route(/\/api\/agent\/runs\/r3-run\/events(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/event-stream", body: `event: run.snapshot\ndata: ${JSON.stringify(run)}\n\n` }));
    await page.route(/\/api\/agent\/runs\/r3-run\/(?:resume|retry)$/, async (route) => {
        controls.push(route.request().postDataJSON());
        requestReceived.resolve();
        await gate.promise;
        if (continueOriginal) {
            run.status = kind === "check_status" ? "running" : "planning";
            run.ecommerceReferenceReview = null;
            run.canCheckStatus = false;
            run.tasks = run.tasks.map((task) => ({ ...task, status: "running" }));
            await route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } });
            return;
        }
        await route.fulfill({ status: 409, json: { code: 409, data: null, msg: "参考复核已变化，请刷新后重试。" } });
    });
    return { run, controls, requestReceived: requestReceived.promise, release: () => gate.resolve(), createdRuns: () => created };
}

for (const goldenCase of [cases[0]]) {
    test(`${goldenCase.caseId || goldenCase.id}:${goldenCase.category}白底或透明底商品可从一句话生成场景`, async ({ page, request }, testInfo) => {
        test.skip(testInfo.project.name !== "chromium", "商品生成主链只在桌面 Chromium 执行");

        const created = await submitProductScene(page, goldenCase);
        const run = await waitForRun(request, created.runId, "completed");
        await expectProductResult(page);
        await expectPublicProgress(request, run.id);
        const trace = await expectAdminTrace(request, run.id, "passed");
        expectSuccessfulTrace(trace, {
            operation: goldenCase.expectedOperation,
            hardProtections: goldenCase.hardProtections,
            userRequest: goldenCase.userRequest,
        });

        const state = await protocolFixtureState(request);
        const requestImage = state.requests.find((item) => item.path.endsWith("/images/edits"));
        expect(requestImage).toMatchObject({ hasMask: false, imageInputs: [{ sha256: goldenCase.fixtureSha256 }] });
    });
}

for (const golden of regressions.filter((item) => item.caseId === "conflicting-canvas")) {
    test(`${golden.caseId}:修改场景直接整图生成且不要求选区`, async ({ page, request }) => {
        await page.goto("/create", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
        const source = await deterministicScene(golden.source!);
        await page.locator('input[type="file"][multiple]').setInputFiles({ name: `${golden.caseId}.png`, mimeType: "image/png", buffer: source });
        const created = await submitPrompt(page, golden.userRequest, { reusePage: true });
        const completed = await waitForRun(request, created.runId, "completed");
        expect(completed.ecommerceSceneSelection).toBeUndefined();
        await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toHaveCount(0);
        await expectProductResult(page);
        const trace = await expectAdminTrace(request, created.runId, "passed");
        expectLatestTraceVersions(trace);
        expect(traceStage(trace, "edit_planning").output.protection).toMatchObject({ scope: "global", preserveOutsideMask: false });
        const creates = (await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"));
        expect(creates).toHaveLength(1);
        expect(creates[0]).toMatchObject({ hasMask: false, imageInputs: [{ sha256: createHash("sha256").update(source).digest("hex") }] });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expectProductResult(page);
    });
}

test("nano-full-image:完整商品参考通过真实HTTP直接生成且不带蒙版", async ({ page, request }) => {
    const settings = e2eSettingsPatch();
    const upstream = "nano-banana-2";
    for (const channel of settings.systemChannels) {
        channel.models = [...channel.models, upstream];
        channel.advancedConfig.modelCapabilities = { ...channel.advancedConfig.modelCapabilities, [upstream]: "image" };
        channel.advancedConfig.modelConfigs = { ...channel.advancedConfig.modelConfigs, [upstream]: channel.advancedConfig.modelConfigs["gpt-image-2.5-flare"] };
    }
    settings.logicalModels = settings.logicalModels.map((model) => (model.id === "e2e-ecommerce-image" ? { ...model, bindings: model.bindings.map((binding) => ({ ...binding, upstreamModel: upstream })) } : model));
    settings.modelPointCosts[upstream] = 0;
    expect((await request.patch("/api/admin/settings", { data: settings })).ok()).toBe(true);
    const golden = cases[0];
    const created = await submitProductScene(page, golden);
    const run = await waitForRun(request, created.runId, "completed");
    expect(run.assetIds).toHaveLength(1);
    await expectProductResult(page);
    const state = await protocolFixtureState(request);
    const images = state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"));
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ model: upstream, hasMask: false, imageInputs: [{ sha256: golden.fixtureSha256 }] });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectProductResult(page);
});

for (const golden of regressions.filter((item) => item.scenario === "quality_unavailable")) {
    test(`${golden.caseId}:真实生成先交付再提供可选视觉建议`, async ({ page, request }, testInfo) => {
        test.skip(testInfo.project.name !== "chromium", "服务端门禁专项");
        const created = await submitProductScene(page, { ...cases[0], userRequest: golden.userRequest });
        const run = await waitForRun(request, created.runId, "completed");
        const trace = await expectAdminTrace(request, created.runId, "unavailable");
        expectLatestTraceVersions(trace);
        const assets = await conversationAssets(request, run.conversationId);
        expect(assets.some((asset) => asset.sourceRunId === run.id && asset.status === "ready")).toBe(true);
        expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(1);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "参考建议", level: 3, exact: true })).toBeVisible();
        await expect(page.getByTestId("creative-media-result")).toHaveCount(1);
        expectPublicWhitelist(run);
    });
}

async function deterministicScene(size: { width: number; height: number }) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><rect width="100%" height="100%" fill="#d8d3c9"/><rect x="900" y="900" width="1600" height="1000" fill="#805b3e"/><path d="M900 1233H2500M900 1566H2500" stroke="#402d20" stroke-width="12"/></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
}

function expectPublicWhitelist(run: PublicRun) {
    const serialized = JSON.stringify(run);
    for (const internal of ["ecommerceSnapshot", "ecommerceExecution", "sceneProtection", "photography", "observations", "executionPrompt", "internalReason"]) expect(serialized).not.toContain(`"${internal}"`);
    const string = expect.any(String);
    const number = expect.any(Number);
    const boolean = expect.any(Boolean);
    const array = expect.any(Array);
    const object = expect.any(Object);
    // publicAgentRun[ForRequest] and CreativeAgentRun publish result assetIds;
    // task child identities/results are internal and have no allowed DTO shape.
    const value = expectPublicObject(
        run,
        {
            id: string,
            conversationId: string,
            inputMessageId: string,
            assistantMessageId: string,
            surface: string,
            projectId: string,
            status: string,
            prompt: string,
            referencedAssetIds: array,
            selectedSkillIds: array,
            requestedModelIds: array,
            generationPreferences: object,
            assetIds: array,
            ecommerceQualityStatus: string,
            ecommerceQualityReview: object,
            ecommerceSceneSelection: object,
            ecommerceReferenceReview: object,
            canCheckStatus: boolean,
            tasks: array,
            cancellation: object,
            timings: object,
            createdAt: number,
            updatedAt: number,
        },
        ["id", "conversationId", "inputMessageId", "assistantMessageId", "surface", "status", "prompt", "assetIds", "tasks", "createdAt", "updatedAt"],
    );
    expect(["planning", "running", "paused", "completed", "failed", "cancelled"]).toContain(value.status);
    for (const key of ["assetIds", "referencedAssetIds", "selectedSkillIds", "requestedModelIds"]) for (const id of (value[key] || []) as unknown[]) expect(id).toEqual(string);
    for (const task of value.tasks as unknown[]) {
        const publicTask = expectPublicObject(
            task,
            {
                id: string,
                title: string,
                type: string,
                model: string,
                optimizedPrompt: string,
                ratio: string,
                quality: string,
                seconds: number,
                voice: string,
                format: string,
                generateAudio: boolean,
                watermark: boolean,
                speed: number,
                count: number,
                status: string,
                error: string,
            },
            ["id", "title", "type", "model", "status"],
        );
        expect(["ready", "running", "needs_review", "completed", "failed", "cancelled"]).toContain(publicTask.status);
    }
    if (value.ecommerceSceneSelection) {
        expectPublicObject(value.ecommerceSceneSelection, { action: "regenerate_full_image" }, ["action"]);
    }
    if (value.ecommerceReferenceReview) {
        const review = expectPublicObject(value.ecommerceReferenceReview, { version: "ecommerce-reference-review.v1", reviewId: string, kind: string, question: string, assets: array, inheritedEditTarget: object }, [
            "version",
            "reviewId",
            "kind",
            "question",
            "assets",
        ]);
        expect(["confirm_purposes", "retry_analysis", "retry_source"]).toContain(review.kind);
        if (review.inheritedEditTarget) {
            const inherited = expectPublicObject(review.inheritedEditTarget, { assetId: string, previewUrl: string }, ["assetId", "previewUrl"]);
            expect(review.kind).toBe("confirm_purposes");
            expect(inherited.previewUrl).toMatch(/^\/api\/(reference-assets|generation-log-assets)\//);
            expect((review.assets as Array<{ assetId: string }>).some((asset) => asset.assetId === inherited.assetId)).toBe(false);
        }
        for (const item of review.assets as unknown[]) {
            const asset = expectPublicObject(item, { assetId: string, assetVersion: string, alias: string, previewUrl: string, purposes: array, allowedPurposes: array }, ["assetId", "assetVersion", "alias", "previewUrl", "purposes", "allowedPurposes"]);
            expect(asset.previewUrl).toMatch(/^\/api\/(reference-assets|generation-log-assets)\//);
        }
    }
    if (value.ecommerceQualityReview) {
        const review = expectPublicObject(value.ecommerceQualityReview, { kind: string, failureKeys: array, message: string, advisory: boolean }, ["kind", "failureKeys"]);
        expect(["hard_failure", "check_unavailable", "needs_adjustment"]).toContain(review.kind);
        for (const key of review.failureKeys as unknown[])
            expect([
                "product_identity",
                "product_silhouette",
                "product_color_material",
                "product_proportions_view",
                "brand_logo",
                "packaging_text",
                "scene_intent",
                "composition_lighting",
                "canvas_geometry",
                "protected_structure",
                "protected_material",
                "unmodified_region",
                "stored_media",
            ]).toContain(key);
    }
    if (value.cancellation) expectPublicObject(value.cancellation, { pendingCount: number }, ["pendingCount"]);
    if (value.timings)
        expectPublicObject(
            value.timings,
            Object.fromEntries(["requestAcceptedAt", "planningStartedAt", "plannerFirstByteAt", "planningCompletedAt", "firstTaskSubmittedAt", "firstResultReadyAt", "allResultsReadyAt", "reviewCompletedAt", "runCompletedAt"].map((key) => [key, number])),
            ["requestAcceptedAt"],
        );
    if (value.generationPreferences) {
        const preferences = expectPublicObject(value.generationPreferences, { mode: string, image: object, video: object, audio: object });
        if (preferences.image) expectPublicObject(preferences.image, { size: string, quality: string, count: number });
        if (preferences.video)
            expectPublicObject(preferences.video, { size: string, quality: string, seconds: number, count: number, generateAudio: boolean, watermark: boolean, referenceMode: string, firstFrameAssetId: string, lastFrameAssetId: string });
        if (preferences.audio) expectPublicObject(preferences.audio, { voice: string, format: string, speed: number });
    }
}

function expectPublicObject(value: unknown, shape: Record<string, unknown>, required: string[] = []) {
    expect(value).toBeTruthy();
    expect(typeof value).toBe("object");
    expect(Array.isArray(value)).toBe(false);
    const record = value as Record<string, unknown>;
    expect(
        Object.keys(record).filter((key) => !Object.hasOwn(shape, key)),
        "unpublished public DTO keys",
    ).toEqual([]);
    expect(Object.keys(record)).toEqual(expect.arrayContaining(required));
    for (const [key, field] of Object.entries(record)) {
        if (key === "ecommerceReferenceReview" && field === null) continue;
        expect(field, `public DTO ${key}`).toEqual(shape[key]);
    }
    return record;
}

function expectLatestTraceVersions(trace: EcommerceTrace) {
    expect(traceStage(trace, "visual_analysis").output.analysisVersion).toBe("ecommerce-visual-analysis.v4");
    expect(traceStage(trace, "edit_planning").output).toMatchObject({ planVersion: "ecommerce-edit.v7", visibleStructure: expect.any(Array) });
    expect(traceStage(trace, "image_generation").output.compilerVersion).toBe("ecommerce-openai-image-2.5.v5");
    expect(traceStage(trace, "image_generation").output.photography).toEqual(traceStage(trace, "edit_planning").output.photography);
    expect(traceStage(trace, "quality_check").output.version).toBe("ecommerce-quality.v2");
}

test("white-product-style-reference:可选场景参考仍以商品为锚点并在刷新后恢复结果", async ({ page, request }, testInfo) => {
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
    const productReference = visualStage.output.references?.find((reference) => reference.contentType === "isolated_product");
    const sceneReference = visualStage.output.references?.find((reference) => reference.contentType === "interior_scene");
    expect(productReference).toBeDefined();
    expect(sceneReference).toBeDefined();
    expect(productReference?.assetId).not.toBe(sceneReference?.assetId);
    expect(planningStage.output.source).toMatchObject({
        productAnchorId: productReference?.assetId,
        sceneReferenceIds: [sceneReference?.assetId],
    });
    await expectProductResult(page);
    const resultSource = await page.getByTestId("creative-media-result").last().getByRole("img").getAttribute("src");
    expect(resultSource).toMatch(/^\/api\/(?:generation-log-assets|reference-assets)\/.+\.png(?:\?.*)?$/);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(page.getByTestId("creative-media-result").last().getByRole("img")).toHaveAttribute("src", resultSource!);
    expect(run.assetIds?.length).toBeGreaterThan(0);
});

test("large-reference:四千八百万像素参考图完成真实创作并刷新恢复", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "大像素参考图回归只在桌面 Chromium 执行");
    const goldenCase = cases[5];
    const product = uploadFixture(goldenCase.fixturePath, goldenCase.productFileName, goldenCase.fixtureSha256);
    const scene = {
        name: "large-style-reference.jpg",
        mimeType: "image/jpeg",
        buffer: await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "#203040" } })
            .jpeg()
            .toBuffer(),
    };
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await selectImageMode(page);
    await page.locator('input[type="file"][multiple]').setInputFiles([product, scene]);
    for (const file of [product, scene]) await expect(page.getByLabel(`已上传图片 ${file.name}`)).toBeVisible({ timeout: 30_000 });
    const created = await submitPrompt(page, goldenCase.userRequest, { reusePage: true });
    const run = await waitForRun(request, created.runId, "completed");
    expect(run.ecommerceReferenceReview).toBeFalsy();
    const trace = await expectAdminTrace(request, run.id, "passed");
    expectSuccessfulTrace(trace, { operation: goldenCase.expectedOperation, hardProtections: goldenCase.hardProtections, userRequest: goldenCase.userRequest, sceneReferenceCount: 1 });
    await expectProductResult(page);
    const resultSource = await page.getByTestId("creative-media-result").last().getByRole("img").getAttribute("src");
    expect(resultSource).toMatch(/^\/api\/(?:generation-log-assets|reference-assets)\//);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(page.getByTestId("creative-media-result").last().getByRole("img")).toHaveAttribute("src", resultSource!);
    await expect(page.getByTestId("creative-reference-review")).toHaveCount(0);
});

test("large-product-reference:四千二百多万像素商品整图生成并刷新恢复", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "大商品参考回归只在桌面 Chromium 执行");
    const goldenCase = cases[5];
    const userRequest = goldenCase.userRequest;
    const product = {
        name: goldenCase.productFileName,
        mimeType: "image/png",
        buffer: await sharp({ create: { width: 7997, height: 5334, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 3200, height: 2800, channels: 4, background: "#252525" } }, left: 2400, top: 1200 }])
            .png()
            .toBuffer(),
    };
    const scene = {
        name: "small-style-reference.png",
        mimeType: "image/png",
        buffer: await sharp({ create: { width: 64, height: 48, channels: 3, background: "#203040" } })
            .png()
            .toBuffer(),
    };
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await selectImageMode(page);
    await page.locator('input[type="file"][multiple]').setInputFiles([product, scene]);
    await expect(page.getByLabel(`已上传图片 ${product.name}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel(`已上传图片 ${scene.name}`)).toBeVisible({ timeout: 30_000 });

    const created = await submitPrompt(page, userRequest, { reusePage: true });
    await testInfo.attach("resident-f02-source.json", {
        body: JSON.stringify(
            {
                source: { width: 7997, height: 5334, bytes: product.buffer.length, sha256: createHash("sha256").update(product.buffer).digest("hex") },
                style: { width: 64, height: 48, bytes: scene.buffer.length, sha256: createHash("sha256").update(scene.buffer).digest("hex") },
            },
            null,
            2,
        ),
        contentType: "application/json",
    });
    const activity = await observeResidentF02(request, new URL(page.url()).origin, created.runId);
    try {
        const run = await waitForRun(request, created.runId, "completed");
        expect(run.ecommerceReferenceReview).toBeFalsy();
        expect(run.assetIds).toHaveLength(1);
        let trace: EcommerceTrace | undefined;
        await expect
            .poll(
                async () => {
                    const response = await request.get("/api/admin/generation-logs?page=1&pageSize=100");
                    expect(response.ok()).toBe(true);
                    const payload: { logs: Array<{ ecommerceTrace?: EcommerceTrace }> } = await response.json();
                    trace = payload.logs.find((log) => log.ecommerceTrace?.runId === run.id)?.ecommerceTrace;
                    return trace?.stages.find((stage) => stage.key === "quality_check")?.status;
                },
                { timeout: 30_000 },
            )
            .toBe("passed");
        assert.ok(trace);
        expect(trace).toMatchObject({ runId: run.id, finalStatus: "completed" });
        expectTraceRoutes(trace);
        expectLatestTraceVersions(trace);
        expect(trace.imageTaskIds).toHaveLength(1);
        expect(traceStage(trace, "edit_planning").output).toMatchObject({ operation: "product_to_scene", canvas: { mode: "ratio", source: "baseline", size: { width: 7997, height: 5334 } } });
        expect(traceStage(trace, "image_generation").output.mask).toBeUndefined();
        expect(traceStage(trace, "image_generation").output.protection).toBeUndefined();
        expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(1);
        const assetsResponse = await request.get(`/api/creative/conversations/${run.conversationId}/assets`);
        expect(assetsResponse.ok()).toBe(true);
        const assetsPayload: { data: { assets: Array<{ id: string; sourceRunId?: string; serverUrl?: string; width?: number; height?: number }> } } = await assetsResponse.json();
        const deliveredAsset = assetsPayload.data.assets.find((asset) => asset.id === run.assetIds?.[0]);
        assert.ok(deliveredAsset?.serverUrl);
        expect(deliveredAsset.sourceRunId).toBe(run.id);
        expect(deliveredAsset.width).toBeGreaterThan(0);
        expect(deliveredAsset.width).toBeLessThan(7997);
        expect(deliveredAsset.height).toBeGreaterThan(0);
        expect(deliveredAsset.height).toBeLessThan(5334);
        const expectedSource = new URL(deliveredAsset.serverUrl, page.url());
        const resultImage = page.getByTestId("creative-media-result").last().getByTestId("creative-primary-result").getByRole("img");
        await expect(resultImage).toBeVisible({ timeout: 30_000 });
        await expect
            .poll(async () => {
                const source = await resultImage.getAttribute("src");
                assert.ok(source);
                const preview = new URL(source, page.url());
                return { origin: preview.origin, pathname: preview.pathname };
            })
            .toEqual({ origin: expectedSource.origin, pathname: expectedSource.pathname });
        const resultSource = await resultImage.getAttribute("src");
        assert.ok(resultSource);

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
        await expect(resultImage).toHaveAttribute("src", resultSource);
        await expect(page.getByTestId("creative-reference-review")).toHaveCount(0);
        const restored = await request.get(`/api/agent/runs/${created.runId}`);
        expect(restored.ok()).toBe(true);
        expect((await restored.json()).data.run).toMatchObject({ id: created.runId, status: "completed", assetIds: run.assetIds, ecommerceQualityStatus: "passed" });
        await activity.terminal;
    } finally {
        const evidence = await activity.close();
        await testInfo.attach("resident-f02-http-sse.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
        expect.soft(evidence.failures).toEqual([]);
        expect.soft(evidence.health.length).toBeGreaterThan(0);
        expect.soft(evidence.task.length).toBeGreaterThan(0);
        expect.soft(evidence.sse.status).toBe(200);
        expect.soft(evidence.sse.contentType).toContain("text/event-stream");
        expect.soft(evidence.sse.naturalClose).toBe(true);
        expect.soft(evidence.sse.frames.map((frame) => frame.event)).toEqual(expect.arrayContaining(["run.snapshot", "run.completed"]));
    }
});

test("historical-branch:关闭质检仍可下载连续编辑并从较早结果建立分支", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "连续性回归只在桌面 Chromium 执行");
    const saved = await request.patch("/api/admin/settings", { data: { ecommerceVisualQualityCheckEnabled: false, ecommerceModelRoles: { ...e2eSettingsPatch().ecommerceModelRoles, quality_check: [] } } });
    expect(saved.ok()).toBe(true);
    const first = await submitProductScene(page, cases[0]);
    const firstRun = await waitForRun(request, first.runId, "completed");
    expect(firstRun.assetIds).toHaveLength(1);
    expectPublicWhitelist(firstRun);
    const firstTrace = await expectAdminTrace(request, firstRun.id, "not_run");
    expect(traceStage(firstTrace, "quality_check")).toMatchObject({ status: "not_run", output: { policy: "disabled" } });
    expect(traceStage(firstTrace, "quality_check").model).toBeUndefined();
    expect(traceStage(firstTrace, "image_generation").output.technicalCheck?.status).toBe("passed");
    expect(traceStage(firstTrace, "edit_planning").output).toMatchObject({
        operation: cases[0].expectedOperation,
        preserve: { productCore: cases[0].hardProtections },
        modelRoles: { qualityCheck: null },
    });
    const originalProductAnchorId = traceStage(firstTrace, "edit_planning").output.source?.productAnchorId;
    expect(originalProductAnchorId).toBeTruthy();
    const firstAsset = (await conversationAssets(request, first.conversationId)).find((asset) => asset.id === firstRun.assetIds![0]);
    expect(firstAsset).toMatchObject({ id: firstRun.assetIds![0], status: "ready" });
    await expectProductResult(page);
    await expect(page.getByTestId("creative-quality-review")).toHaveCount(0);
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载", exact: true }).last().click();
    expect(await (await downloading).failure()).toBeNull();
    await page.getByRole("button", { name: "更多本轮创作操作", exact: true }).last().click();
    await page.getByRole("menuitem", { name: "引用结果", exact: true }).click();
    await page.getByRole("button", { name: "更多本轮创作操作", exact: true }).last().click();
    await page.getByRole("menuitem", { name: "取消引用", exact: true }).click();

    const secondPrompt = "让场景光线再亮一点。";
    const second = await submitPrompt(page, secondPrompt, { reusePage: true });
    const secondRun = await waitForRun(request, second.runId, "completed");
    expect(secondRun.assetIds).toHaveLength(1);
    expectPublicWhitelist(secondRun);
    const secondTrace = await expectAdminTrace(request, secondRun.id, "not_run");
    expect(traceStage(secondTrace, "image_generation").output.technicalCheck?.status).toBe("passed");
    expect(traceStage(secondTrace, "edit_planning").output).toMatchObject({
        operation: "local_edit",
        preserve: { productCore: cases[0].hardProtections },
        modelRoles: { qualityCheck: null },
        source: {
            productAnchorId: originalProductAnchorId,
            currentSceneBaselineId: firstRun.assetIds?.[0],
        },
        continuity: { parentResultId: firstRun.assetIds?.[0] },
    });
    expect(secondRun.assetIds?.[0]).not.toBe(firstRun.assetIds?.[0]);
    const secondAsset = (await conversationAssets(request, second.conversationId)).find((asset) => asset.id === secondRun.assetIds![0]);
    expect(secondAsset).toMatchObject({ id: secondRun.assetIds![0], status: "ready" });
    await expect(page.getByTestId("creative-media-result")).toHaveCount(2);

    const roundActionButtons = page.getByRole("button", {
        name: "更多本轮创作操作",
    });
    await expect(roundActionButtons).toHaveCount(2);
    await roundActionButtons.first().click();
    await page.getByRole("menuitem", { name: "引用结果" }).click();
    const branchPrompt = "从这张较早结果把背景改成现代厨房。";
    const branch = await submitPrompt(page, branchPrompt, { reusePage: true });
    const branchRun = await waitForRun(request, branch.runId, "completed");
    expect(branchRun.assetIds).toHaveLength(1);
    expectPublicWhitelist(branchRun);
    const branchTrace = await expectAdminTrace(request, branchRun.id, "not_run");
    expect(traceStage(branchTrace, "image_generation").output.technicalCheck?.status).toBe("passed");
    expect(traceStage(branchTrace, "edit_planning").output).toMatchObject({
        operation: "local_edit",
        preserve: { productCore: cases[0].hardProtections },
        modelRoles: { qualityCheck: null },
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
    expect(assets.find((asset) => asset.id === firstRun.assetIds![0])).toEqual(firstAsset);
    expect(assets.find((asset) => asset.id === secondRun.assetIds![0])).toEqual(secondAsset);
    const unchanged = await request.get(`/api/agent/runs/${first.runId}`);
    expect(unchanged.ok(), await unchanged.text()).toBe(true);
    const unchangedRun = ((await unchanged.json()) as { data: { run: PublicRun } }).data.run;
    expect(unchangedRun.assetIds).toEqual(firstRun.assetIds);
    expectPublicWhitelist(unchangedRun);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("creative-media-result")).toHaveCount(3);
    await expect(page.getByTestId("creative-quality-review")).toHaveCount(0);
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && item.model === MODEL_ROUTES.quality_check.upstreamModel)).toHaveLength(0);
    expect(state.requests.filter((item) => item.method === "POST" && /\/images\//.test(item.path))).toHaveLength(3);
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
    const waiting = await waitForRun(request, created.runId, "paused");
    expect(waiting.ecommerceReferenceReview?.kind).toBe("retry_analysis");
    expectPublicWhitelist(waiting);
    const panel = page.getByTestId("creative-reference-review");
    await expect(panel).toHaveCount(1);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-review-id", waiting.ecommerceReferenceReview!.reviewId);
    await expect(page.getByText("当前参考图片缺少可用于确定完整用途的视觉线索，可重新分析后继续这次创作。", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "重新分析", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "重新分析", exact: true })).toBeEnabled();
    await expect(panel.getByRole("button", { name: "确认用途并继续", exact: true })).toHaveCount(0);
    const state = await protocolFixtureState(request);
    expect(state.requests.some((item) => item.path.endsWith("/images/edits") || item.path.endsWith("/images/generations"))).toBe(false);
});

test("可选视觉轮廓建议保留已交付结果与连续编辑入口", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "异常路径回归只在桌面 Chromium 执行");
    const strictFailure = {
        ...cases[0],
        userRequest: "生成现代客厅场景，保持商品不变。[qa-silhouette-failure]",
    };
    const created = await submitProductScene(page, strictFailure);
    const run = await waitForRun(request, created.runId, "completed");
    const trace = await expectAdminTrace(request, run.id, "blocked");
    expect(run.assetIds).toHaveLength(1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "参考建议", exact: true })).toBeVisible();
    await expect(page.getByTestId("creative-media-result")).toHaveCount(1);
    await expect(page.getByRole("list", { name: "未通过项" }).getByRole("listitem").filter({ hasText: "商品轮廓与原图不一致" })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重新生成未通过的商品图", exact: true })).toHaveCount(0);
    expectTraceRoutes(trace);
    expect(traceStage(trace, "image_generation").status).toBe("completed");
    const qualityStage = traceStage(trace, "quality_check");
    expect(qualityStage.status).toBe("blocked");
    expect(qualityStage.output.hardFailures).toEqual(expect.arrayContaining([expect.objectContaining({ key: "product_silhouette", status: "failed" })]));
    expect(trace.finalStatus).toBe("completed");
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && (item.path.endsWith("/images/edits") || item.path.endsWith("/images/generations")))).toHaveLength(1);
    expect(state.requests.filter((item) => item.method === "POST" && item.model === MODEL_ROUTES.quality_check.upstreamModel)).toHaveLength(1);
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
    expect(run.assetIds).toContain(internalResult?.id);
    const overviewResponse = await request.get("/api/create/overview");
    expect(overviewResponse.ok()).toBe(true);
    const overview = (await overviewResponse.json()) as { data: { overview: { recentAssets: Array<{ url: string }> } } };
    expect(overview.data.overview.recentAssets.some((asset) => asset.url === internalResult?.serverUrl || asset.url === internalResult?.remoteUrl)).toBe(true);
});

test("移动端可完成一句话商品场景生成且没有横向溢出", async ({ page, request }, testInfo) => {
    test.skip(!["mobile-390", "mobile-430"].includes(testInfo.project.name), "移动端专项");
    const created = await submitProductScene(page, cases[6]);
    await waitForRun(request, created.runId, "completed");
    await expectProductResult(page);
    await expectNoHorizontalOverflow(page, `ecommerce product generation ${testInfo.project.name}`);
});

test("historical-selection:未提交旧任务可直接重新生成且不再框选", async ({ page }) => {
    const fixture = await mockPublicEcommerceRound(page, "selection");
    await page.goto(`/create?conversationId=${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
    const regenerate = page.getByRole("button", { name: "按原要求重新生成", exact: true });
    await expect(regenerate).toBeVisible();
    await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toHaveCount(0);
    await regenerate.click();
    await expect.poll(() => fixture.controls.length).toBe(1);
    expect(fixture.controls[0]).toEqual({ conversationId: fixture.conversationId });
    fixture.releaseResume();
    await expect(regenerate).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(regenerate).toHaveCount(0);
    expect(fixture.createdRuns()).toBe(0);
});

for (const theme of ["light", "dark"] as const) {
    test(`验收公开状态刷新和切换对话保持可读-${theme}`, async ({ page }, testInfo) => {
        test.skip(!["chromium", "mobile-390", "mobile-430"].includes(testInfo.project.name), "桌面与390/430专项");
        await page.addInitScript((value) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: value }, version: 0 })), theme);
        for (const quality of ["soft", "hard", "unavailable"] as const) {
            const fixture = await mockPublicEcommerceRound(page, quality);
            await page.goto(`/create?conversationId=${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
            const label = quality === "soft" ? "需要调整" : "待复核";
            await expect(page.getByRole("heading", { name: label, exact: true, level: 3 })).toBeVisible();
            await expect(page.getByTestId("creative-media-result")).toHaveCount(quality === "soft" ? 1 : 0);
            await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toHaveCount(0);
            await expect(page.getByRole("button", { name: "重新生成未通过的商品图", exact: true })).toHaveCount(0);
            await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
            if (quality === "hard") await expect(page.getByText("画幅与要求不一致：要求 1024×1024，上游原图 1254×1254。", { exact: true })).toBeVisible();
            await expectNoHorizontalOverflow(page, `${quality} ${theme} ${testInfo.project.name}`);
            await testInfo.attach(`quality-${quality}-${theme}-${testInfo.project.name}`, { body: await page.screenshot(), contentType: "image/png" });
            await page.reload({ waitUntil: "domcontentloaded" });
            await expect(page.getByRole("heading", { name: label, exact: true, level: 3 })).toBeVisible();
            await page.goto(`/create?conversationId=${fixture.otherConversationId}`, { waitUntil: "domcontentloaded" });
            await expect(page.getByText("另一个对话自己的消息", { exact: true })).toBeVisible();
            await expect(page.getByRole("heading", { name: label, exact: true, level: 3 })).toHaveCount(0);
            expect(fixture.controls).toHaveLength(0);
            expect(fixture.createdRuns()).toBe(0);
        }
    });
}

const RESOURCE_BLOCKED_MESSAGE = "图像处理因资源不足暂停，进度已保存。当前资源配置仍无法执行原图像阶段，请联系管理员检查。调整后请刷新页面。";
const RESOURCE_READY_MESSAGE = "图像处理因资源不足暂停，进度已保存。资源已调整，可以继续原任务。";
const RESOURCE_RESUME_ERROR = "原图像阶段状态已变化，请刷新后重试。";

for (const theme of ["light", "dark"] as const) {
    test(`resource-resume-ui:资源说明刷新后同一Run单次继续-${theme}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "chromium", "桌面资源暂停专项；API/SSE为受控UI夹具");
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.addInitScript((value) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: value }, version: 0 })), theme);
        const fixture = await mockPublicEcommerceRound(page, "resource");
        await page.goto(`/create?conversationId=${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
        const panel = page.getByTestId("creative-generation-waiting");
        await expect(panel).toHaveCount(1);
        await expect(panel).toBeVisible();
        await expect(panel).toContainText(RESOURCE_BLOCKED_MESSAGE);
        await expect(page.getByRole("button", { name: "继续图像处理", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "检查状态", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("creative-generation-elapsed")).toHaveCount(0);
        await expect.poll(() => page.locator("html").evaluate((element) => element.classList.contains("dark"))).toBe(theme === "dark");
        await expectNoHorizontalOverflow(page, `resource blocked ${theme}`);
        await testInfo.attach(`resource-blocked-${theme}`, { body: await page.screenshot(), contentType: "image/png" });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(panel).toContainText(RESOURCE_BLOCKED_MESSAGE);
        await expect(panel.getByRole("button")).toHaveCount(0);
        expect(fixture.controls).toHaveLength(0);
        expect(fixture.createdRuns()).toBe(0);
        expect(fixture.eventSnapshots).not.toContainEqual(expect.objectContaining({ status: "running" }));

        // This models a newly readable public projection after configuration changes; no admin mutation is claimed.
        fixture.run.imageProcessingRecovery = { reason: "resource_failure", canResume: true, message: RESOURCE_READY_MESSAGE };
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(panel).toContainText(RESOURCE_READY_MESSAGE);
        const resume = panel.getByRole("button");
        await expect(resume).toHaveCount(1);
        await expect(resume).toHaveAccessibleName("继续图像处理");
        await expect(resume).toBeEnabled();
        await expect(page.getByRole("button", { name: "检查状态", exact: true })).toHaveCount(0);
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent/runs/${fixture.runId}/resume`);
        await resume.dblclick();
        await expect(resume).toBeDisabled();
        await expect(resume).toHaveText("正在继续");
        await expect.poll(() => fixture.controls.length).toBe(1);
        expect(fixture.controls).toEqual([{ conversationId: fixture.conversationId }]);
        await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("creative-generation-elapsed")).toHaveCount(0);
        expect(fixture.eventSnapshots).not.toContainEqual(expect.objectContaining({ status: "running" }));
        fixture.releaseResume();
        const response = await responsePromise;
        expect(response.ok()).toBe(true);
        expect((await response.json()).data.run).toMatchObject({ id: fixture.runId, conversationId: fixture.conversationId, inputMessageId: "task16-input", assistantMessageId: "task16-assistant", status: "running" });
        await expect(panel.getByRole("button")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "停止生成", exact: true })).toBeVisible();
        await expect(page.getByTestId("creative-generation-elapsed")).toBeVisible();
        await expect(page.getByTestId("creative-round-request")).toHaveCount(1);
        await expect(page).toHaveURL(new RegExp(`[?&]conversationId=${fixture.conversationId}(?:&|$)`));
        expect(fixture.controls).toEqual([{ conversationId: fixture.conversationId }]);
        expect(fixture.createdRuns()).toBe(0);
        await expectNoHorizontalOverflow(page, `resource resumed ${theme}`);
        await testInfo.attach(`resource-resumed-${theme}`, { body: await page.screenshot(), contentType: "image/png" });
    });
}

for (const scenario of [
    { outcome: "error", responseStatus: 409, message: RESOURCE_RESUME_ERROR, remainingButtons: 1 },
    { outcome: "paused", responseStatus: 200, message: RESOURCE_BLOCKED_MESSAGE, remainingButtons: 0 },
] as const) {
    test(`resource-resume-ui:失败或仍暂停响应不伪造运行-${scenario.outcome}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "chromium", "桌面资源恢复响应专项；API/SSE为受控UI夹具");
        const fixture = await mockPublicEcommerceRound(page, "resource", false, scenario.outcome);
        fixture.run.imageProcessingRecovery = { reason: "resource_failure", canResume: true, message: RESOURCE_READY_MESSAGE };
        await page.goto(`/create?conversationId=${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
        const panel = page.getByTestId("creative-generation-waiting");
        await expect(panel).toContainText(RESOURCE_READY_MESSAGE);
        const resume = panel.getByRole("button");
        await expect(resume).toHaveAccessibleName("继续图像处理");
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent/runs/${fixture.runId}/resume`);
        await resume.dblclick();
        await expect(resume).toBeDisabled();
        await expect(resume).toHaveText("正在继续");
        await expect.poll(() => fixture.controls.length).toBe(1);
        fixture.releaseResume();
        expect((await responsePromise).status()).toBe(scenario.responseStatus);
        await expect(panel.getByRole("alert")).toContainText(scenario.message);
        await expect(panel.getByRole("button")).toHaveCount(scenario.remainingButtons);
        await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "检查状态", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("creative-generation-elapsed")).toHaveCount(0);
        expect(fixture.eventSnapshots).not.toContainEqual(expect.objectContaining({ status: "running" }));
        expect(fixture.run.status).toBe("paused");
        expect(fixture.controls).toEqual([{ conversationId: fixture.conversationId }]);
        expect(fixture.createdRuns()).toBe(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(panel).toBeVisible();
        await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("creative-generation-elapsed")).toHaveCount(0);
        await expect(page.getByTestId("creative-round-request")).toHaveCount(1);
    });
}

test("resource-resume-ui:成功后刷新按原Run运行态恢复且保留旧助手消息", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "桌面资源恢复刷新专项；API/SSE为受控UI夹具");
    const fixture = await mockPublicEcommerceRound(page, "resource");
    fixture.run.imageProcessingRecovery = { reason: "resource_failure", canResume: true, message: RESOURCE_READY_MESSAGE };
    await page.goto(`/create?conversationId=${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("creative-generation-waiting");
    await expect(panel).toContainText(RESOURCE_READY_MESSAGE);
    const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent/runs/${fixture.runId}/resume`);
    await panel.getByRole("button", { name: "继续图像处理", exact: true }).click();
    await expect.poll(() => fixture.controls.length).toBe(1);
    fixture.releaseResume();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    expect((await response.json()).data.run).toMatchObject({ id: fixture.runId, conversationId: fixture.conversationId, status: "running" });
    await expect(page.getByTestId("creative-generation-elapsed")).toBeVisible();
    const eventsBeforeReload = fixture.eventSnapshots.length;
    await page.reload({ waitUntil: "commit" });
    const restoredRun = page
        .waitForRequest((value) => value.method() === "GET" && new URL(value.url()).pathname === `/api/agent/runs/${fixture.runId}`)
        .then(async (request) => {
            const response = await request.response();
            assert.ok(response);
            return response.json();
        });
    const restoredMessages = page
        .waitForRequest((value) => value.method() === "GET" && new URL(value.url()).pathname === `/api/creative/conversations/${fixture.conversationId}/messages`)
        .then(async (request) => {
            const response = await request.response();
            assert.ok(response);
            return response.json();
        });
    const restoredStream = page.waitForRequest((value) => value.method() === "GET" && new URL(value.url()).pathname === `/api/agent/runs/${fixture.runId}/events`);
    const [runPayload, messagesPayload] = await Promise.all([restoredRun, restoredMessages]);
    expect(runPayload.data.run).toMatchObject({ id: fixture.runId, conversationId: fixture.conversationId, status: "running" });
    expect(messagesPayload.data.messages).toMatchObject([
        { id: "task16-input", status: "completed" },
        { id: "task16-assistant", runId: fixture.runId, status: "completed" },
    ]);
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("creative-generation-elapsed")).toBeVisible();
    await expect(page.getByRole("button", { name: "停止生成", exact: true })).toBeVisible();
    expect((await restoredStream).method()).toBe("GET");
    await expect.poll(() => fixture.eventSnapshots.length).toBeGreaterThan(eventsBeforeReload);
    expect(fixture.eventSnapshots.at(-1)).toEqual({ id: fixture.runId, conversationId: fixture.conversationId, status: "running" });
    await expect(page.getByTestId("creative-round-request")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "继续图像处理", exact: true })).toHaveCount(0);
    expect(fixture.controls).toEqual([{ conversationId: fixture.conversationId }]);
    expect(fixture.createdRuns()).toBe(0);
});

async function mockPublicEcommerceRound(page: Page, state: "selection" | "soft" | "hard" | "unavailable" | "resource", runningMessage = false, resourceResumeResult: "running" | "paused" | "error" = "running") {
    const conversationId = `task16-${state}`;
    const otherConversationId = `${conversationId}-other`;
    const timestamp = Date.now();
    const conversation = (id: string) => ({
        id,
        userId: "fixture-user",
        surface: "chat",
        source: "agent",
        title: id,
        status: "active",
        contextSummary: "",
        contextSummaryThroughSequence: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastMessageAt: timestamp,
    });
    const run: CreativeAgentRun = {
        id: `task16-run-${state}`,
        conversationId,
        inputMessageId: "task16-input",
        assistantMessageId: "task16-assistant",
        status: state === "soft" ? "completed" : "paused",
        surface: "chat",
        prompt: "保持原图，只调整场景",
        generationPreferences: { mode: "image" },
        createdAt: timestamp,
        updatedAt: timestamp,
        assetIds: state === "soft" ? ["task16-preview"] : [],
        tasks: [{ id: "task16-task", title: "生成图片", type: "image", model: "fixture-image", status: state === "soft" ? "completed" : "needs_review" }],
        ...(state === "resource"
            ? { imageProcessingRecovery: { reason: "resource_failure", canResume: false, message: RESOURCE_BLOCKED_MESSAGE }, canCheckStatus: false }
            : state === "selection"
              ? { ecommerceSceneSelection: { action: "regenerate_full_image" } }
              : {
                    ecommerceQualityStatus: state === "soft" ? "needs_adjustment" : "needs_review",
                    ecommerceQualityReview: {
                        kind: state === "soft" ? "needs_adjustment" : state === "hard" ? "hard_failure" : "check_unavailable",
                        failureKeys: state === "hard" ? ["canvas_geometry"] : state === "soft" ? ["composition_lighting"] : [],
                        ...(state === "hard" ? { message: "画幅与要求不一致：要求 1024×1024，上游原图 1254×1254。" } : {}),
                    },
                }),
    };
    const controls: Array<{ conversationId: string }> = [];
    let created = 0;
    let statusReads = 0;
    const eventSnapshots: Array<Pick<CreativeAgentRun, "id" | "conversationId" | "status">> = [];
    let releaseResume = () => {};
    const resumeRelease = new Promise<void>((resolve) => {
        releaseResume = resolve;
    });
    const preview = await sharp({ create: { width: 418, height: 209, channels: 3, background: "#899d8e" } })
        .webp()
        .toBuffer();
    await page.route(/\/api\/reference-assets\/task16-baseline\.png(?:\?.*)?$/, (route) => route.fulfill({ body: preview, contentType: "image/webp" }));
    await page.route(/\/api\/creative\/conversations(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { conversations: [conversation(conversationId), conversation(otherConversationId)], hasMore: false }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${conversationId}(?:-other)?$`), (route) => route.fulfill({ json: { code: 0, data: { conversation: conversation(new URL(route.request().url()).pathname.split("/").at(-1)!) }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${conversationId}(?:-other)?/messages(?:\\?.*)?$`), (route) => {
        const other = new URL(route.request().url()).pathname.includes(`${otherConversationId}/`);
        const messages = [
            {
                id: run.inputMessageId,
                conversationId: other ? otherConversationId : conversationId,
                ...(other ? {} : { runId: run.id }),
                sequence: 1,
                role: "user",
                status: "completed",
                content: other ? "另一个对话自己的消息" : run.prompt,
                metadata: {},
                createdAt: timestamp,
                updatedAt: timestamp,
            },
            {
                id: run.assistantMessageId,
                conversationId,
                runId: run.id,
                sequence: 2,
                role: "assistant",
                status: runningMessage && !["completed", "failed", "cancelled"].includes(run.status) ? "running" : "completed",
                content: "本次任务进度已保存",
                metadata: {},
                createdAt: timestamp,
                updatedAt: timestamp,
            },
        ];
        return route.fulfill({ json: { code: 0, data: { messages: other ? messages.slice(0, 1) : messages }, msg: "OK" } });
    });
    const assets =
        state === "soft"
            ? [
                  {
                      id: "task16-preview",
                      userId: "fixture-user",
                      conversationId,
                      sourceRunId: run.id,
                      sourceTaskId: "task16-task",
                      ordinal: 1,
                      type: "image",
                      status: "ready",
                      title: "待调整预览",
                      serverUrl: "/api/reference-assets/task16-baseline.png",
                      width: 1254,
                      height: 627,
                      metadata: {},
                      createdAt: timestamp,
                      updatedAt: timestamp,
                  },
              ]
            : [];
    await page.route(new RegExp(`/api/creative/conversations/${conversationId}(?:-other)?/assets$`), (route) => route.fulfill({ json: { code: 0, data: { assets: route.request().url().includes(`${otherConversationId}/`) ? [] : assets }, msg: "OK" } }));
    await page.route(new RegExp(`/api/agent/runs/${run.id}$`), (route) => {
        statusReads += 1;
        return route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } });
    });
    await page.route(/\/api\/agent\/runs(?:\?.*)?$/, (route) => {
        if (route.request().method() === "POST") created += 1;
        return route.fulfill({ json: { code: 0, data: { runs: [] }, msg: "OK" } });
    });
    await page.route(new RegExp(`/api/agent/runs/${run.id}/${state === "selection" ? "retry" : "resume"}$`), async (route) => {
        controls.push(route.request().postDataJSON());
        await resumeRelease;
        if (state === "resource" && resourceResumeResult === "error") return route.fulfill({ status: 409, json: { code: 409, data: null, msg: RESOURCE_RESUME_ERROR } });
        if (state === "resource" && resourceResumeResult === "paused") {
            run.imageProcessingRecovery = { reason: "resource_failure", canResume: false, message: RESOURCE_BLOCKED_MESSAGE };
            return route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } });
        }
        run.status = state === "selection" ? "planning" : "running";
        if (state === "selection") run.tasks = [];
        delete run.ecommerceSceneSelection;
        if (state === "resource") delete run.imageProcessingRecovery;
        await route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } });
    });
    await page.route(new RegExp(`/api/agent/runs/${run.id}/events$`), (route) => {
        const snapshot = state === "resource" ? run : { ...run, status: "running" as const };
        eventSnapshots.push({ id: snapshot.id, conversationId: snapshot.conversationId, status: snapshot.status });
        return route.fulfill({ contentType: "text/event-stream", body: `event: run.snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` });
    });
    return { conversationId, otherConversationId, runId: run.id, run, controls, eventSnapshots, releaseResume: () => releaseResume(), createdRuns: () => created, statusReads: () => statusReads };
}

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
    await expect(result.getByTestId("creative-primary-result").getByRole("img")).toHaveAttribute("src", /\/api\/(?:generation-log-assets|reference-assets)\/.+\.png/);
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
    expect(body).not.toContain("ecommerceSnapshot");
}

async function expectAdminTrace(request: APIRequestContext, runId: string, qualityStatus: EcommerceQualityCheck["status"] | "not_run") {
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
                if (qualityStatus !== "not_run" && matchedTrace && traceStage(matchedTrace, "quality_check").status === "not_run") {
                    // This isolated fixture has no resident worker; process the real durable queue.
                    const advanced = await request.post("/api/maintenance/generation-tasks/run", { headers: { authorization: "Bearer vozeb-pro-e2e-worker-token-separate-32chars", "x-vozeb-pro-worker-id": "e2e-optional-visual-quality" } });
                    expect(advanced.ok()).toBe(true);
                }
                return matchedTrace || null;
            },
            { timeout: 30_000 },
        )
        .toMatchObject({
            runId,
            finalStatus: "completed",
            stages: expect.arrayContaining([
                expect.objectContaining({ key: "visual_analysis" }),
                expect.objectContaining({ key: "edit_planning" }),
                expect.objectContaining({ key: "image_generation" }),
                expect.objectContaining({ key: "quality_check", status: qualityStatus }),
            ]),
        });
    if (!matchedTrace) throw new Error(`Ecommerce trace for run ${runId} disappeared after polling`);
    const current = (await request.get(`/api/agent/runs/${runId}`).then((response) => response.json())).data.run as CreativeAgentRun;
    expect(current.status).toBe("completed");
    if (qualityStatus === "not_run") {
        expect(current.ecommerceQualityStatus).toBeUndefined();
        expect(current.ecommerceQualityReview).toBeUndefined();
    } else {
        expect(current.ecommerceQualityStatus).toBe(qualityStatus === "passed" ? "passed" : "needs_adjustment");
        if (qualityStatus !== "passed") expect(current.ecommerceQualityReview?.advisory).toBe(true);
    }
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
    expectLatestTraceVersions(trace);
    expect(trace.finalStatus).toBe("completed");
    expect(trace.imageTaskIds).toHaveLength(1);

    const planningStage = traceStage(trace, "edit_planning");
    expect(planningStage.status).toBe("completed");
    expect(planningStage.output.operation).toBe(expected.operation);
    expect(planningStage.output.protection).toMatchObject({ scope: "global", preserveOutsideMask: false, protectedObjectIds: [] });
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
    for (const protection of expected.hardProtections) expect(generationStage.output.executionPrompt).toContain(protection);
    expect(generationStage.output.mask).toBeUndefined();
    expect(generationStage.output.protection).toBeUndefined();
    expect(generationStage.output.referenceRoles).toEqual(expectedReferences);
    expect(generationStage.output.imageTaskIds).toEqual(trace.imageTaskIds);
    const canvas = planningStage.output.canvas;
    expect(canvas).toMatchObject({ mode: "ratio", source: "baseline" });
    expect(generationStage.output.canvas).toEqual(canvas);

    const qualityStage = traceStage(trace, "quality_check");
    expect(qualityStage.status).toBe("passed");
    const checks = qualityStage.output.checks ?? [];
    expect(checks).toHaveLength(QUALITY_CHECKS.length + 1);
    expect(checks.map((check) => check.key).sort()).toEqual([...QUALITY_CHECKS, "canvas_geometry"].sort());
    const resultId = `${trace.imageTaskIds[0]}:1`;
    for (const check of checks) {
        expect(check.resultId).toBe(resultId);
        expect(check.reason).not.toBe("");
        expect(check.status).toBe(["brand_logo", "packaging_text", "unmodified_region"].includes(check.key) ? "not_applicable" : "passed");
    }
    expect(qualityStage.output.hardFailures).toEqual([]);
    const canvasEvidence = qualityStage.output.canvasEvidence ?? [];
    expect(canvasEvidence).toHaveLength(1);
    const evidence = canvasEvidence[0];
    expect(evidence).toMatchObject({ resultId, constraint: canvas, nativeMatches: true, storedMatches: true, normalization: "none", hardFailures: [] });
    expect(evidence.nativeUrl).toMatch(/^\/api\/(?:generation-log-assets|reference-assets)\//);
    expect(evidence.storedUrl).toMatch(/^\/api\/(?:generation-log-assets|reference-assets)\//);
    for (const size of [evidence.nativeSize, evidence.storedSize]) {
        expect(Number.isSafeInteger(size.width) && size.width > 0).toBe(true);
        expect(Number.isSafeInteger(size.height) && size.height > 0).toBe(true);
        if (canvas!.mode === "exact") expect(size).toEqual(canvas!.size);
        else expect(BigInt(size.width) * BigInt(canvas!.size.height)).toBe(BigInt(size.height) * BigInt(canvas!.size.width));
    }
    expect(checks.at(-1)?.reason).toBe(
        `native=${evidence.nativeSize.width}x${evidence.nativeSize.height};stored=${evidence.storedSize.width}x${evidence.storedSize.height};constraint=${canvas!.mode}:${canvas!.size.width}x${canvas!.size.height};normalization=none`,
    );
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
                sourceRunId?: string;
                status?: string;
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
