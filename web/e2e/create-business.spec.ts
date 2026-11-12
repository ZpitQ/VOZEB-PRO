import { expect, test, type Page, type Route } from "@playwright/test";
import type { CreativeAgentRun } from "../src/services/api/creative";
import type { CreativeAsset, CreativeConversation, CreativeMessage } from "../src/lib/creative-runtime-contract";

const now = Date.now();
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFokAAAAASUVORK5CYII=";
const conversations = ["A", "B", "references", "history"].map((title): CreativeConversation => ({
    id: title,
    userId: "fixture",
    surface: "chat",
    source: "agent",
    title: `Create ${title}`,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
}));
const references = ["A", "B"].map((title, ordinal): CreativeAsset => ({
    id: `reference-${title}`,
    userId: "fixture",
    conversationId: "references",
    ordinal,
    type: "image",
    status: "ready",
    title: `Reference ${title}`,
    serverUrl: png,
    metadata: {},
    createdAt: now,
    updatedAt: now,
}));
const exchange = (conversationId: string, index = 0): CreativeMessage[] => [
    {
        id: `${conversationId}-user-${index}`,
        conversationId,
        sequence: index * 2 + 1,
        runId: conversationId === "history" ? `history-${index}` : undefined,
        role: "user",
        status: "completed",
        content: `${conversationId} request ${index}`,
        metadata: {},
        createdAt: now,
        updatedAt: now,
    },
    {
        id: `${conversationId}-assistant-${index}`,
        conversationId,
        sequence: index * 2 + 2,
        runId: conversationId === "history" ? `history-${index}` : undefined,
        role: "assistant",
        status: conversationId === "history" && index === 0 ? "failed" : "completed",
        content: `${conversationId} response ${index}`,
        metadata: {},
        createdAt: now,
        updatedAt: now,
    },
];
const history = Array.from({ length: 27 }, (_, index) => exchange("history", index)).flat();
const run = (id: string, conversationId = "A", status: CreativeAgentRun["status"] = "paused"): CreativeAgentRun => ({
    id,
    conversationId,
    inputMessageId: `${id}-user`,
    assistantMessageId: `${id}-assistant`,
    status,
    generationPreferences: { mode: "image" },
    assetIds: [],
    tasks: [],
});
const json = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
const ok = (route: Route, data: unknown) => json(route, { code: 0, data, msg: "OK" });
const composer = (page: Page) => page.getByPlaceholder("描述你想生成或修改的图片");
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

test.beforeEach(async ({ page }) => {
    await page.route("**/api/creative/conversations?*", (route) => ok(route, { conversations, hasMore: false }));
    await page.route("**/api/creative/conversations/*", (route) => ok(route, { conversation: conversations.find((item) => item.id === new URL(route.request().url()).pathname.split("/").at(-1)) }));
    await page.route("**/api/creative/conversations/*/messages?*", (route) => {
        const url = new URL(route.request().url());
        const id = url.pathname.split("/").at(-2)!;
        const messages = id === "history" ? history : exchange(id);
        const before = Number(url.searchParams.get("beforeSequence")) || Infinity;
        return ok(route, { messages: messages.filter((item) => item.sequence < before).slice(-50) });
    });
    await page.route("**/api/creative/conversations/*/assets", (route) => ok(route, { assets: route.request().url().includes("/references/") ? references : [] }));
    await page.route("**/api/agent/runs?*", (route) => ok(route, { runs: [] }));
    await page.route("**/api/agent/runs/*", (route) => {
        const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
        const failed = id === "history-0";
        return ok(route, {
            run: { ...run(id, id.startsWith("history-") ? "history" : "A", failed ? "failed" : "completed"), tasks: [{ id: `task-${id}`, title: "生成图片", type: "image", model: "fixture-image", status: failed ? "failed" : "completed" }] },
        });
    });
    await page.route("**/api/create/overview", (route) => ok(route, { overview: { runningTasks: [], recentAssets: [] } }));
    await page.route("**/api/public/gallery?*", (route) => json(route, { items: [], total: 0 }));
});

async function open(page: Page, id = "A") {
    await page.goto(`/create?conversationId=${id}`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-ready="true"]').waitFor({ timeout: 60_000 });
    await expect(page.getByTestId("creative-message-list")).toBeVisible();
}

async function holdSubmission(page: Page) {
    const received = deferred();
    const release = deferred();
    const accepted = run("accepted");
    await page.route("**/api/agent/runs", async (route) => {
        received.resolve();
        await release.promise;
        await ok(route, { run: accepted, created: true });
    });
    await page.route("**/api/agent/runs/accepted/events", (route) => route.fulfill({ contentType: "text/event-stream", body: `event: run.snapshot\ndata: ${JSON.stringify(accepted)}\n\n` }));
    return { received: received.promise, release: release.resolve };
}

test("new references preserve existing image aliases and submitted order", async ({ page }) => {
    const submitted = deferred();
    let payload: { assetIds: string[]; prompt: string };
    await page.route("**/api/agent/runs", async (route) => {
        payload = route.request().postDataJSON();
        submitted.resolve();
        await json(route, { code: 503, data: null, msg: "Fixture captured request" }, 503);
    });
    await open(page, "references");
    await page.getByRole("button", { name: "引用当前对话资产", exact: true }).click();
    await page.getByRole("button", { name: "选择Reference B", exact: true }).click();
    await composer(page).press("Control+End");
    await composer(page).pressSequentially(" 的主体和 ");
    await page.getByRole("button", { name: "引用当前对话资产", exact: true }).click();
    await page.getByRole("button", { name: "选择Reference A", exact: true }).click();
    await expect(page.getByTestId("creative-composer-reference-chip").first()).toHaveAttribute("data-asset-id", "reference-B");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await submitted.promise;
    expect(payload!.assetIds).toEqual(["reference-B", "reference-A"]);
});

test("local attachments retain their alias when a stored reference is added", async ({ page }) => {
    const submitted = deferred();
    let payload: { assetIds: string[] };
    await page.route("**/api/creative/assets", (route) => ok(route, { asset: { ...references[1], id: "uploaded-local-B" } }));
    await page.route("**/api/agent/runs", async (route) => {
        payload = route.request().postDataJSON();
        submitted.resolve();
        await json(route, { code: 503, data: null, msg: "Fixture captured request" }, 503);
    });
    await open(page, "references");
    await page.locator('input[type="file"]').setInputFiles({ name: "local-B.png", mimeType: "image/png", buffer: Buffer.from(png.split(",")[1], "base64") });
    await composer(page).fill("@图片1 的主体");
    const firstId = await page.getByTestId("creative-composer-reference-chip").first().getAttribute("data-asset-id");
    await page.getByRole("button", { name: "引用当前对话资产", exact: true }).click();
    await page.getByRole("button", { name: "选择Reference A", exact: true }).click();
    await expect(page.getByTestId("creative-composer-reference-chip").first()).toHaveAttribute("data-asset-id", firstId!);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await submitted.promise;
    expect(payload!.assetIds).toEqual(["uploaded-local-B", "reference-A"]);
});

test("terminal refresh preserves a newly attached reference for the next draft", async ({ page }) => {
    const received = deferred();
    const release = deferred();
    let terminalRefresh = false;
    await page.route("**/api/creative/conversations/references/assets", async (route) => {
        if (!terminalRefresh || route.request().method() !== "GET") return route.fallback();
        received.resolve();
        await release.promise;
        return ok(route, { assets: references });
    });
    await page.route("**/api/creative/conversations/references/messages?*", (route) => {
        if (!terminalRefresh) return route.fallback();
        return ok(route, { messages: [{ ...exchange("references")[1], content: "Terminal refresh is visible" }] });
    });
    await page.route("**/api/agent/runs", (route) => ok(route, { run: run("terminal", "references", "running"), created: true }));
    await page.route("**/api/agent/runs/terminal/events", (route) => route.fulfill({ contentType: "text/event-stream", body: 'event: run.completed\ndata: {"data":{"reply":"Completed"}}\n\n' }));
    await open(page, "references");
    terminalRefresh = true;
    await composer(page).fill("Original request");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await received.promise;
    await page.locator('input[type="file"]').setInputFiles({ name: "next-draft.png", mimeType: "image/png", buffer: Buffer.from(png.split(",")[1], "base64") });
    await composer(page).fill("@图片1 next request");
    const firstId = await page.getByTestId("creative-composer-reference-chip").first().getAttribute("data-asset-id");
    release.resolve();
    await expect(page.getByText("Terminal refresh is visible", { exact: true })).toBeVisible();
    await expect(page.getByTestId("creative-composer-reference-chip").first()).toHaveAttribute("data-asset-id", firstId!);
});

for (const switchConversation of [false, true]) {
    test(`accepted submission preserves a newer draft${switchConversation ? " in a new conversation" : ""}`, async ({ page }) => {
        const pending = await holdSubmission(page);
        await open(page);
        await composer(page).fill("Original request");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await pending.received;
        if (switchConversation) {
            await page.getByRole("button", { name: "新建对话", exact: true }).click();
            await expect(page).toHaveURL(/\/create$/);
        }
        await composer(page).fill("New draft must remain");
        const response = page.waitForResponse((item) => item.request().method() === "POST" && new URL(item.url()).pathname === "/api/agent/runs");
        pending.release();
        await response;
        await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
        await expect(composer(page)).toHaveValue("New draft must remain");
    });
}

test("stop during submission cancels the accepted original Run", async ({ page }) => {
    const pending = await holdSubmission(page);
    await page.route("**/api/agent/runs/accepted/cancel", (route) => ok(route, { run: run("accepted", "A", "cancelled") }));
    await open(page);
    await composer(page).fill("Request to stop");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await pending.received;
    await page.getByRole("button", { name: "停止生成", exact: true }).click();
    const cancelled = page.waitForRequest((item) => item.method() === "POST" && new URL(item.url()).pathname === "/api/agent/runs/accepted/cancel", { timeout: 15_000 });
    pending.release();
    expect((await cancelled).postDataJSON()).toEqual({ conversationId: "A" });
});

test("older failed rounds retry their persisted task in the same Run", async ({ page }) => {
    await page.route("**/api/agent/runs/history-0/tasks/task-history-0/retry", (route) => ok(route, { run: run("history-0", "history") }));
    await page.route("**/api/agent/runs/history-0/events", (route) => route.fulfill({ contentType: "text/event-stream", body: `event: run.snapshot\ndata: ${JSON.stringify(run("history-0", "history"))}\n\n` }));
    await open(page, "history");
    await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
    await expect(page.getByText("history request 0", { exact: true })).toBeVisible();
    const retried = page.waitForRequest((item) => item.method() === "POST" && item.url().endsWith("/history-0/tasks/task-history-0/retry"), { timeout: 15_000 });
    await page.getByRole("button", { name: "直接重试本次创作", exact: true }).click();
    expect((await retried).postDataJSON()).toEqual({ conversationId: "history", taskIds: ["task-history-0"] });
});

test("a late prompt search cannot replace the current search result", async ({ page }) => {
    const oldReceived = deferred();
    const release = deferred();
    await page.route("**/api/my-prompts?*", async (route) => {
        const keyword = new URL(route.request().url()).searchParams.get("keyword") || "initial";
        if (keyword === "OLD") {
            oldReceived.resolve();
            await release.promise;
        }
        await json(route, { items: [{ id: keyword, title: keyword, prompt: `${keyword} text`, category: "fixture", tags: [], coverUrl: png, preview: "", createdAt: "", updatedAt: "" }], total: 1, categories: ["fixture"], tags: [] });
    });
    await open(page);
    await page.getByRole("button", { name: "打开资产面板", exact: true }).click();
    await page.getByRole("tab", { name: /我的提示词/ }).click();
    await expect(page.getByRole("button", { name: "插入：initial", exact: true })).toBeVisible();
    const search = page.getByPlaceholder("搜索提示词");
    await search.fill("OLD");
    await search.press("Enter");
    await oldReceived.promise;
    await search.fill("NEW");
    await search.press("Enter");
    await expect(page.getByRole("button", { name: "插入：NEW", exact: true })).toBeVisible();
    const oldResponse = page.waitForResponse((item) => item.url().includes("/api/my-prompts?") && new URL(item.url()).searchParams.get("keyword") === "OLD");
    release.resolve();
    await oldResponse;
    await expect(page.getByRole("button", { name: "插入：NEW", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "插入：NEW", exact: true }).click();
    await expect(composer(page)).toHaveValue("NEW text");
});

test("back and forward restore the matching creative conversation", async ({ page }) => {
    await open(page);
    await expect(page.getByText("A response 0", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "打开创作历史", exact: true }).click();
    await page.getByRole("button", { name: /^Create B / }).click();
    await expect(page).toHaveURL(/conversationId=B$/);
    await expect(page.getByText("B response 0", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/conversationId=A$/);
    await expect(page.getByText("A response 0", { exact: true })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/conversationId=B$/);
    await expect(page.getByText("B response 0", { exact: true })).toBeVisible();
});
