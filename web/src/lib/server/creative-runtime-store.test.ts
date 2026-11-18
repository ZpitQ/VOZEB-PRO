import { beforeEach, describe, expect, it, vi } from "vitest";

import { setAgentRunStatus, updateAgentRunById, updateAgentRunTaskById, type AgentRun } from "./agent-run-store";
import { writeJsonDataFile } from "./data-adapter";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { buildEcommercePlanningInput } from "./ecommerce-generation-snapshot";
import { createEcommerceReferenceCheckpoint } from "./ecommerce-reference-recovery";
import { normalizeStoredLog } from "./generation-log-repository";
import { generationLogRunSnapshot } from "./generation-log-request-snapshot";
import { persistAgentRunRequestLog } from "./agent-run-generation-log";

const mocks = vi.hoisted(() => ({
    files: new Map<string, unknown>(),
    databaseProvider: "file" as "file" | "postgres",
    query: vi.fn(),
    transaction: vi.fn(),
    failTaskWrites: false,
    beforeTaskFailure: undefined as (() => void) | undefined,
}));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    isPostgresDatabaseEnabled: vi.fn(() => mocks.databaseProvider === "postgres"),
    getDatabaseProvider: vi.fn(() => mocks.databaseProvider),
    postgresQuery: mocks.query,
    withPostgresTransaction: mocks.transaction,
}));
vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async (fileName: string, fallback: unknown) => structuredClone(mocks.files.has(fileName) ? mocks.files.get(fileName) : fallback)),
    withJsonDataFileLock: vi.fn(async (_fileName: string, callback: () => Promise<unknown>) => callback()),
    writeJsonDataFile: vi.fn(async (fileName: string, value: unknown) => {
        if (mocks.failTaskWrites && fileName === "generation-tasks.json") {
            mocks.beforeTaskFailure?.();
            throw new Error("task-file-write-failed");
        }
        mocks.files.set(fileName, structuredClone(value));
    }),
}));

import {
    appendCreativeConversationExchange,
    CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT,
    CREATIVE_RUN_EVENT_BATCH_SIZE,
    createCreativeConversation,
    createCreativeRunBundle,
    CreativeStoreConflict,
    getCreativeConversationContext,
    getCreativeConversation,
    getCreativeConversationsByIds,
    getCreativeAsset,
    getCreativeAssetsByIds,
    getCreativeRunByClientRequestId,
    listCreativeConversations,
    listCreativeMessages,
    listCreativeRunEvents,
    mutateCreativeRun,
    registerCreativeAssets,
} from "./creative-runtime-store";

describe("creative runtime file provider", () => {
    beforeEach(() => {
        mocks.files = new Map();
        mocks.databaseProvider = "file";
        mocks.query.mockReset();
        mocks.transaction.mockReset();
        mocks.failTaskWrites = false;
        mocks.beforeTaskFailure = undefined;
    });

    it("creates a run bundle once and keeps message sequence stable", async () => {
        const first = await createBundle(run({ id: "run-one" }));
        const duplicate = await createBundle(run({ id: "run-two" }));

        expect(first.created).toBe(true);
        expect(duplicate).toMatchObject({ created: false, run: { id: "run-one" } });
        expect(await getCreativeRunByClientRequestId<AgentRun>("user", "request-one")).toMatchObject({ id: "run-one" });
        expect(await listCreativeMessages("conversation", 0, 10)).toMatchObject([
            { sequence: 1, role: "user", status: "completed", content: "生成一张图" },
            { sequence: 2, role: "assistant", status: "running", runId: "run-one" },
        ]);
        expect(mocks.files.get("generation-tasks.json")).toMatchObject([
            {
                id: "run-one",
                executionPhase: "created",
                nextPollAt: expect.any(Number),
                lastUpstreamStatus: "created",
            },
        ]);
    });

    it("persists reference preparation progress on the original assistant message", async () => {
        await createBundle(run({ id: "run-progress" }));

        await updateAgentRunById("run-progress", { status: "running" }, { type: "ecommerce.progress", data: { stage: "identifying_product", text: "正在识别商品" } }, ["planning"]);

        expect(await listCreativeMessages("conversation", 0, 10)).toMatchObject([
            { id: "input-message", role: "user", content: "生成一张图" },
            { id: "assistant-message", role: "assistant", status: "running", content: "正在识别商品", runId: "run-progress" },
        ]);
    });

    it("keeps a durable request record when reference preparation pauses before an image task exists", async () => {
        await createBundle(run({ id: "run-reference-paused", generationPreferences: { mode: "image" } }));

        await updateAgentRunById("run-reference-paused", { status: "paused", failure: "请明确要修改哪一张图" }, { type: "run.paused" }, ["planning"]);

        expect(mocks.files.get("generation-logs.json")).toMatchObject({
            logs: [
                {
                    id: "agent-run:run-reference-paused",
                    userId: "user",
                    conversationId: "conversation",
                    requestSnapshot: { userPrompt: "生成一张图", run: { id: "run-reference-paused", recordType: "pre-generation", status: "paused", inputMessageId: "input-message", reason: "请明确要修改哪一张图" } },
                },
            ],
        });
        const logs = await import("./generation-log-store");
        expect((await logs.listGenerationLogs({ userId: "user" })).total).toBe(0);
        expect((await logs.listGenerationLogs({ includeRequestRecords: true })).total).toBe(1);
    });

    it("retains frozen reference identity and confirmed purpose when the current asset is unavailable", async () => {
        const asset: CreativeAsset = {
            id: "frozen-reference",
            userId: "user",
            conversationId: "conversation",
            ordinal: 0,
            type: "image",
            status: "ready",
            title: "原始桌子",
            serverUrl: "/api/reference-assets/permanent/original.png",
            mimeType: "image/png",
            width: 640,
            height: 480,
            bytes: 128,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const original = run({ id: "run-frozen-reference", referencedAssetIds: [asset.id], generationPreferences: { mode: "image" } });
        const planning = buildEcommercePlanningInput(original, [asset], { summary: "", recentMessages: [] });
        const checkpoint = createEcommerceReferenceCheckpoint(original, planning, [asset]);
        checkpoint.assets[0].contentSha256 = "a".repeat(64);
        checkpoint.confirmedBindings = [{ assetId: asset.id, alias: "图片1", purposes: ["edit_target"] }];
        original.ecommerceSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            runId: original.id,
            userId: original.userId,
            input: { userRequest: original.prompt, assetIds: [asset.id], conversationId: original.conversationId, surface: original.surface },
            referenceCheckpoint: checkpoint,
            createdAt: 1,
        };
        await createBundle(original);

        await updateAgentRunById(original.id, { status: "paused", failure: "需要确认用途" }, { type: "run.paused" }, ["planning"]);

        expect(mocks.files.get("generation-logs.json")).toMatchObject({
            logs: [
                {
                    requestSnapshot: {
                        references: [
                            {
                                id: "frozen-reference",
                                name: "原始桌子",
                                url: "/api/reference-assets/permanent/original.png",
                                alias: "图片1",
                                purposes: ["edit_target"],
                                assetVersion: checkpoint.assets[0].assetVersion,
                                sha256: "a".repeat(64),
                                width: 640,
                                height: 480,
                            },
                        ],
                    },
                },
            ],
        });
    });

    it("stores the readable task explanation before the internal fallback code for a pre-generation pause", async () => {
        const original = run({
            id: "run-readable-pause",
            generationPreferences: { mode: "image" },
            tasks: [{ id: "reference-review", title: "确认参考图", type: "image", prompt: "修改参考图片", count: 1, dependencies: [], attempts: 0, status: "needs_review", error: "请确认参考图用途和本次要修改的图片。" }],
        });
        original.ecommerceSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            runId: original.id,
            userId: original.userId,
            input: { userRequest: original.prompt, assetIds: [], conversationId: original.conversationId, surface: original.surface },
            fallback: { reason: "reference_purpose_confirmation_required" },
            createdAt: 1,
        };
        await createBundle(original);

        await updateAgentRunById(original.id, { status: "paused" }, { type: "run.paused" }, ["planning"]);

        expect(mocks.files.get("generation-logs.json")).toMatchObject({ logs: [{ summary: "请确认参考图用途和本次要修改的图片。", requestSnapshot: { run: { reason: "请确认参考图用途和本次要修改的图片。" } } }] });
    });

    it("updates the same pre-generation record when the original request resumes", async () => {
        await createBundle(run({ id: "run-resumed", generationPreferences: { mode: "image" } }));
        await updateAgentRunById("run-resumed", { status: "paused", failure: "请选择目标" }, { type: "run.paused" }, ["planning"]);
        await updateAgentRunById("run-resumed", { status: "running", failure: undefined }, { type: "run.resumed" }, ["paused"]);
        expect(mocks.files.get("generation-logs.json")).toMatchObject({ logs: [{ id: "agent-run:run-resumed", requestSnapshot: { run: { status: "running" } } }] });
    });

    it("removes a newly written request log when the task file cannot commit the pause", async () => {
        await createBundle(run({ id: "run-write-fault", generationPreferences: { mode: "image" } }));
        mocks.failTaskWrites = true;
        await expect(updateAgentRunById("run-write-fault", { status: "paused", failure: "请选择目标" }, { type: "run.paused" }, ["planning"])).rejects.toThrow("task-file-write-failed");
        expect(mocks.files.get("generation-tasks.json")).toMatchObject([{ payload: { status: "planning" } }]);
        expect(mocks.files.get("generation-logs.json")).toMatchObject({ logs: [] });
    });

    it("restores the previous request snapshot when a resume cannot commit", async () => {
        await createBundle(run({ id: "run-resume-fault", generationPreferences: { mode: "image" } }));
        await updateAgentRunById("run-resume-fault", { status: "paused", failure: "请选择目标" }, { type: "run.paused" }, ["planning"]);
        mocks.failTaskWrites = true;
        await expect(updateAgentRunById("run-resume-fault", { status: "running", failure: undefined }, { type: "run.resumed" }, ["paused"])).rejects.toThrow("task-file-write-failed");
        expect(mocks.files.get("generation-tasks.json")).toMatchObject([{ payload: { status: "paused" } }]);
        expect(mocks.files.get("generation-logs.json")).toMatchObject({ logs: [{ requestSnapshot: { run: { status: "paused", reason: "请选择目标" } } }] });
    });

    it("retains completed request timings on child logs after runtime retention", async () => {
        const original = run({
            id: "run-durable-timings",
            status: "running",
            executionId: "execution",
            generationPreferences: { mode: "image" },
            timings: { requestAcceptedAt: 100, planningStartedAt: 200, planningCompletedAt: 300 },
            tasks: [{ id: "image-parent", type: "image", title: "Image", prompt: "Image", count: 1, dependencies: [], attempts: 1, status: "running", taskId: "image-child" }],
        });
        await createBundle(original);
        seedChildLog(original);
        await updateAgentRunTaskById(original.id, "image-parent", { status: "completed" }, "task.completed", "execution");
        await updateAgentRunById(original.id, { status: "completed", timings: { requestAcceptedAt: 100, planningStartedAt: 200, planningCompletedAt: 300, runCompletedAt: 179100 } }, { type: "run.completed" }, ["running"]);
        mocks.files.set("generation-tasks.json", []);
        const logs = await import("./generation-log-store");
        expect((await logs.listGenerationLogs({ userId: "user" })).items[0]).toMatchObject({
            durationMs: 55000,
            requestSnapshot: {
                userPrompt: "生成一张图",
                run: { status: "completed", timings: { requestAcceptedAt: 100, planningStartedAt: 200, planningCompletedAt: 300, runCompletedAt: 179100 } },
                slots: [{ id: "image-child", attempts: [{ pointsCost: 1.5 }] }],
            },
        });
    });

    it("keeps the first result boundary on duplicate completion observations", async () => {
        const original = run({
            id: "run-task-timings",
            status: "running",
            executionId: "execution",
            generationPreferences: { mode: "image" },
            tasks: [{ id: "image-parent", type: "image", title: "Image", prompt: "Image", count: 1, dependencies: [], attempts: 0, status: "ready" }],
        });
        await createBundle(original);
        await updateAgentRunTaskById(original.id, "image-parent", { status: "running" }, "task.running", "execution");
        const completed = await updateAgentRunTaskById(original.id, "image-parent", { status: "completed" }, "task.completed", "execution");
        const repeated = await updateAgentRunTaskById(original.id, "image-parent", { status: "completed" }, "task.completed", "execution");
        expect(completed?.timings?.firstResultReadyAt).toEqual(expect.any(Number));
        expect(repeated?.timings?.firstResultReadyAt).toBe(completed?.timings?.firstResultReadyAt);
        expect(repeated?.timings?.allResultsReadyAt).toBe(completed?.timings?.allResultsReadyAt);
    });

    it.each([
        ["failed", (current: AgentRun) => updateAgentRunById(current.id, { status: "failed" }, { type: "run.failed" }, ["planning"])],
        ["cancelled", (current: AgentRun) => setAgentRunStatus(current, "cancelled")],
    ] as const)("records the actual request terminal mutation for %s without inventing planning stages", async (status, finish) => {
        const original = run({ id: `run-terminal-${status}`, generationPreferences: { mode: "image" } });
        await createBundle(original);
        await finish(original);
        expect(mocks.files.get("generation-logs.json")).toMatchObject({ logs: [{ requestSnapshot: { run: { status, timings: { requestAcceptedAt: original.createdAt, runCompletedAt: expect.any(Number) } } } }] });
        const db = mocks.files.get("generation-logs.json") as { logs: Array<{ requestSnapshot: { run: { timings: unknown } } }> };
        expect(db.logs[0].requestSnapshot.run.timings).not.toHaveProperty("planningStartedAt");
    });

    it.each([
        ["retry", "planning", (current: AgentRun) => updateAgentRunById(current.id, { status: "planning", failure: undefined }, { type: "run.retry.requested" }, ["failed"])],
        ["resume", "running", (current: AgentRun) => setAgentRunStatus(current, "running")],
    ] as const)("clears the old failed request end during %s and records a fresh cancellation end", async (_action, status, reopen) => {
        const original = run({ id: `run-reopened-${status}`, generationPreferences: { mode: "image" }, timings: { requestAcceptedAt: 100 } });
        await createBundle(original);
        const failed = await updateAgentRunById(original.id, { status: "failed", timings: { requestAcceptedAt: 100, runCompletedAt: 200 } }, { type: "run.failed" }, ["planning"]);
        const reopened = await reopen(failed!);
        expect(reopened).toMatchObject({ status, timings: { requestAcceptedAt: 100 } });
        expect(reopened?.timings?.runCompletedAt).toBeUndefined();
        const activeLogs = mocks.files.get("generation-logs.json") as { logs: Array<{ completedAt?: string; requestSnapshot: { run: { timings: { requestAcceptedAt: number; runCompletedAt?: number } } } }> };
        expect(activeLogs.logs[0].completedAt).toBeUndefined();
        expect(activeLogs.logs[0].requestSnapshot.run.timings).toEqual({ requestAcceptedAt: 100 });
        const cancelled = await setAgentRunStatus(reopened!, "cancelled");
        expect(cancelled?.timings?.requestAcceptedAt).toBe(100);
        expect(cancelled?.timings?.runCompletedAt).toBeGreaterThan(200);
        expect(mocks.files.get("generation-logs.json")).toMatchObject({
            logs: [{ completedAt: expect.any(String), requestSnapshot: { run: { status: "cancelled", timings: { requestAcceptedAt: 100, runCompletedAt: cancelled!.timings!.runCompletedAt } } } }],
        });
    });

    it("does not rewrite log facts when only the run observation timestamp changes", async () => {
        const original = run({ id: "run-unchanged-timings", generationPreferences: { mode: "image" }, status: "paused", failure: "请选择目标" });
        await persistAgentRunRequestLog(original);
        const before = structuredClone(mocks.files.get("generation-logs.json"));
        vi.mocked(writeJsonDataFile).mockClear();
        await persistAgentRunRequestLog({ ...original, updatedAt: original.updatedAt + 1000 });
        expect(mocks.files.get("generation-logs.json")).toEqual(before);
        expect(writeJsonDataFile).not.toHaveBeenCalled();
    });

    it("compensates child run metadata without overwriting a newer log result", async () => {
        const original = run({ id: "run-child-compensation", status: "running", generationPreferences: { mode: "image" }, timings: { requestAcceptedAt: 100 } });
        await createBundle(original);
        seedChildLog(original);
        mocks.failTaskWrites = true;
        mocks.beforeTaskFailure = () => {
            const db = mocks.files.get("generation-logs.json") as { logs: Array<{ title: string }> };
            db.logs[0].title = "Newer delivery metadata";
        };
        await expect(updateAgentRunById(original.id, { status: "completed", timings: { requestAcceptedAt: 100, runCompletedAt: 179100 } }, { type: "run.completed" }, ["running"])).rejects.toThrow("task-file-write-failed");
        expect(mocks.files.get("generation-logs.json")).toMatchObject({ logs: [{ title: "Newer delivery metadata", requestSnapshot: { run: { status: "running", timings: { requestAcceptedAt: 100 } } } }] });
        expect(mocks.files.get("generation-tasks.json")).toMatchObject([{ payload: { status: "running" } }]);
    });

    it("keeps the completed first round in the next Agent run context", async () => {
        await createBundle(run({ id: "run-one" }));
        await mutateCreativeRun<AgentRun>(
            "run-one",
            60_000,
            (current) => ({
                run: { ...current, status: "completed" },
                assistant: { status: "completed", content: "上一轮确定使用红色跑车。" },
            }),
            ["planning"],
        );
        const nextRun = run({
            id: "run-two",
            clientRequestId: "request-two",
            inputMessageId: "input-message-two",
            assistantMessageId: "assistant-message-two",
            prompt: "继续上一轮，把背景改成夜景",
        });
        await createBundle(nextRun, [], "conversation");

        const context = await getCreativeConversationContext("conversation", "user", "run-two");

        expect(context.recentMessages.map((item) => ({ role: item.role, content: item.content }))).toEqual([
            { role: "user", content: "生成一张图" },
            { role: "assistant", content: "上一轮确定使用红色跑车。" },
        ]);
    });

    it("atomically persists completed delivery with a review queue readable after reload", async () => {
        await createBundle(run({ id: "run-review" }));
        const due = Date.now();
        await mutateCreativeRun<AgentRun>(
            "run-review",
            60_000,
            (current) => ({
                run: { ...current, status: "completed", reviewStatus: "review_pending", reviewed: false },
                assistant: { status: "completed", content: "图片已生成。" },
                event: { type: "run.completed" },
                schedule: { executionPhase: "review_pending", nextPollAt: due, lastUpstreamStatus: "review_pending" },
            }),
            ["planning"],
        );
        expect(mocks.files.get("generation-tasks.json")).toMatchObject([{ id: "run-review", status: "success", executionPhase: "review_pending", nextPollAt: due, payload: { status: "completed", reviewStatus: "review_pending" } }]);
        vi.resetModules();
        const { claimDueGenerationTasks } = await import("./generation-task-scheduler");
        expect(await claimDueGenerationTasks({ workerId: "fixture-review", taskIds: ["run-review"] })).toMatchObject([{ id: "run-review", executionPhase: "review_pending", payload: { status: "completed" } }]);
    });

    it("rolls back delivery messages when the atomic review task write fails", async () => {
        await createBundle(run({ id: "run-review" }));
        const before = structuredClone([...mocks.files]);
        const write = vi.mocked(writeJsonDataFile),
            implementation = write.getMockImplementation()!;
        write.mockImplementationOnce(implementation).mockRejectedValueOnce(new Error("fixture task write failed"));
        await expect(
            mutateCreativeRun<AgentRun>(
                "run-review",
                60_000,
                (current) => ({
                    run: { ...current, status: "completed", reviewStatus: "review_pending" },
                    assistant: { status: "completed", content: "图片已生成。" },
                    event: { type: "run.completed" },
                    schedule: { executionPhase: "review_pending", nextPollAt: Date.now(), lastUpstreamStatus: "review_pending" },
                }),
                ["planning"],
            ),
        ).rejects.toThrow("fixture task write failed");
        expect([...mocks.files]).toEqual(before);
    });

    it("writes PostgreSQL delivery and its review schedule in one transaction update", async () => {
        mocks.databaseProvider = "postgres";
        const current = run({ id: "run-review" });
        const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
        const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
            queries.push({ sql, parameters });
            return { rows: sql.startsWith("SELECT payload") ? [{ payload: current }] : [] };
        });
        mocks.transaction.mockImplementation(async (handler: (client: { query: typeof query }) => Promise<unknown>) => handler({ query }));
        const due = Date.now();
        await mutateCreativeRun<AgentRun>(
            current.id,
            60_000,
            (saved) => ({
                run: { ...saved, status: "completed", reviewStatus: "review_pending", reviewed: false },
                event: { type: "run.completed" },
                schedule: { executionPhase: "review_pending", nextPollAt: due, lastUpstreamStatus: "review_pending" },
            }),
            ["planning"],
        );
        const updates = queries.filter((item) => item.sql.startsWith("UPDATE generation_tasks"));
        expect(updates).toHaveLength(1);
        expect(updates[0].sql).toContain("execution_phase = $6, next_poll_at = $7, last_upstream_status = $8");
        expect(updates[0].parameters?.slice(5)).toEqual(["review_pending", new Date(due), "review_pending"]);
        expect(JSON.parse(updates[0].parameters![2] as string)).toMatchObject({ status: "completed", reviewStatus: "review_pending" });
        expect(updates[0].sql).not.toContain("lease_until = NULL");
    });

    it("replays events after a numeric cursor without duplication", async () => {
        await createBundle(run());
        await mutateCreativeRun<AgentRun>("run-one", 60_000, (current) => ({ run: { ...current, status: "running" }, event: { type: "run.running" } }), ["planning"]);

        expect((await listCreativeRunEvents("run-one")).map((event) => event.type)).toEqual(["run.created", "run.running"]);
        expect((await listCreativeRunEvents("run-one", "1")).map((event) => event.type)).toEqual(["run.running"]);
    });

    it("uses the shared event batch size for PostgreSQL cursor pagination", async () => {
        mocks.databaseProvider = "postgres";
        mocks.query.mockResolvedValue({ rows: [] });

        await expect(listCreativeRunEvents("run-one", "17")).resolves.toEqual([]);

        expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("LIMIT $3"), ["run-one", 17, CREATIVE_RUN_EVENT_BATCH_SIZE]);
    });

    it("queries PostgreSQL conversation history by project before pagination", async () => {
        mocks.databaseProvider = "postgres";
        mocks.query.mockResolvedValue({ rows: [] });

        await expect(listCreativeConversations("user-one", { surface: "drama", source: "drama", projectId: "project-one", status: "active", limit: 21, offset: 4 })).resolves.toEqual([]);

        expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("project_id = $4"), ["user-one", "drama", "drama", "project-one", "active", 21, 4]);
    });

    it("loads only owned file conversations by unique stable ids", async () => {
        const owned = await createCreativeConversation("user", { surface: "canvas", projectId: "canvas-one", title: "Owned" });
        const foreign = await createCreativeConversation("other-user", { surface: "canvas", projectId: "canvas-one", title: "Foreign" });

        await expect(getCreativeConversationsByIds("user", ["", ` ${owned.id} `, owned.id, foreign.id])).resolves.toMatchObject([{ id: owned.id, userId: "user", title: "Owned" }]);
        await expect(getCreativeConversationsByIds("user", [" "])).resolves.toEqual([]);
    });

    it("queries PostgreSQL conversations by owner and unique stable ids", async () => {
        mocks.databaseProvider = "postgres";
        mocks.query.mockResolvedValue({
            rows: [
                {
                    id: "conversation-one",
                    user_id: "user",
                    surface: "canvas",
                    source: "canvas-agent",
                    project_id: "canvas-one",
                    title: "Agent",
                    status: "active",
                    context_summary: "",
                    context_summary_through_sequence: 0,
                    created_at: new Date(0),
                    updated_at: new Date(0),
                    last_message_at: new Date(0),
                },
            ],
        });

        await expect(getCreativeConversationsByIds("user", [" conversation-one ", "conversation-one", "conversation-two"])).resolves.toMatchObject([{ id: "conversation-one", userId: "user", surface: "canvas", projectId: "canvas-one" }]);
        expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("WHERE user_id = $1 AND id = ANY($2::text[])"), ["user", ["conversation-one", "conversation-two"]]);
    });

    it("applies owner scope when loading a conversation or asset by id", async () => {
        mocks.databaseProvider = "postgres";
        mocks.query.mockResolvedValue({ rows: [] });

        await expect(getCreativeConversation("conversation-one", "user-one")).resolves.toBeNull();
        await expect(getCreativeAsset("asset-one", "user-one")).resolves.toBeNull();
        await expect(getCreativeAssetsByIds([" asset-one ", "asset-one"], "user-one")).resolves.toEqual([]);

        expect(mocks.query).toHaveBeenNthCalledWith(1, expect.stringContaining("id = $1 AND user_id = $2"), ["conversation-one", "user-one"]);
        expect(mocks.query).toHaveBeenNthCalledWith(2, expect.stringContaining("id = $1 AND user_id = $2"), ["asset-one", "user-one"]);
        expect(mocks.query).toHaveBeenNthCalledWith(3, expect.stringContaining("id = ANY($1::text[]) AND user_id = $2"), [["asset-one"], "user-one"]);
    });

    it("upserts a stable asset for the same run task and ordinal", async () => {
        await createBundle(run());
        const first = await registerCreativeAssets([
            {
                userId: "user",
                conversationId: "conversation",
                messageId: "assistant-message",
                sourceRunId: "run-one",
                sourceTaskId: "child-one",
                ordinal: 0,
                type: "image",
                title: "第一版",
                remoteUrl: "https://cdn.example.com/one.png",
                storageKind: "remote",
            },
        ]);
        const second = await registerCreativeAssets([
            {
                userId: "user",
                conversationId: "conversation",
                messageId: "assistant-message",
                sourceRunId: "run-one",
                sourceTaskId: "child-one",
                ordinal: 0,
                type: "image",
                title: "更新标题",
                remoteUrl: "https://cdn.example.com/one.png",
                storageKind: "remote",
            },
        ]);

        expect(second[0]).toMatchObject({ id: first[0].id, title: "更新标题" });
        expect((mocks.files.get("creative-runtime.json") as { assets: unknown[] }).assets).toHaveLength(1);
    });

    it("rejects foreign assets and immutable conversation scope changes", async () => {
        const foreign = await registerCreativeAssets([
            {
                userId: "other-user",
                conversationId: "other-conversation",
                sourceRunId: "other-run",
                sourceTaskId: "other-task",
                ordinal: 0,
                type: "image",
                title: "他人资产",
                remoteUrl: "https://cdn.example.com/other.png",
                storageKind: "remote",
            },
        ]);
        await expect(createBundle(run(), [foreign[0].id])).rejects.toMatchObject({ status: 403 });

        const conversation = await createCreativeConversation("user", { surface: "canvas", projectId: "project-one" });
        await expect(createBundle(run({ conversationId: conversation.id, surface: "canvas", projectId: "project-two" }), [], conversation.id)).rejects.toBeInstanceOf(CreativeStoreConflict);
    });

    it("rolls older file messages into the persistent summary before the next Agent run", async () => {
        const now = Date.now();
        mocks.files.set("creative-runtime.json", {
            version: 1,
            nextEventId: 1,
            conversations: [
                {
                    id: "conversation",
                    userId: "user",
                    surface: "chat",
                    title: "长对话",
                    status: "active",
                    contextSummary: "",
                    contextSummaryThroughSequence: 0,
                    createdAt: now,
                    updatedAt: now,
                    lastMessageAt: now,
                },
            ],
            messages: Array.from({ length: 16 }, (_, index) => ({
                id: `message-${index + 1}`,
                conversationId: "conversation",
                sequence: index + 1,
                role: index % 2 ? "assistant" : "user",
                status: "completed",
                content: `第 ${index + 1} 条历史内容`,
                metadata: {},
                createdAt: now + index,
                updatedAt: now + index,
            })),
            assets: [],
            events: [],
        });

        await createBundle(run(), [], "conversation");
        const first = await getCreativeConversationContext("conversation", "user", "run-one");
        const second = await getCreativeConversationContext("conversation", "user", "run-one");

        expect(first.recentMessages.map((item) => item.sequence)).toEqual(Array.from({ length: CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT }, (_, index) => index + 5));
        expect(first.summary).toContain("第 1 条历史内容");
        expect(first.summary).toContain("第 4 条历史内容");
        expect(first.summaryThroughSequence).toBe(4);
        expect(second).toEqual(first);
        expect((mocks.files.get("creative-runtime.json") as { conversations: Array<{ contextSummaryThroughSequence: number }> }).conversations[0].contextSummaryThroughSequence).toBe(4);
    });

    it("does not advance the summary past an unfinished older message", async () => {
        const now = Date.now();
        mocks.files.set("creative-runtime.json", {
            version: 1,
            nextEventId: 1,
            conversations: [{ id: "conversation", userId: "user", surface: "chat", title: "并发", status: "active", contextSummary: "", contextSummaryThroughSequence: 0, createdAt: now, updatedAt: now, lastMessageAt: now }],
            messages: Array.from({ length: 16 }, (_, index) => ({
                id: `message-${index + 1}`,
                conversationId: "conversation",
                sequence: index + 1,
                role: index === 1 ? "assistant" : index % 2 ? "assistant" : "user",
                status: index === 1 ? "running" : "completed",
                content: `第 ${index + 1} 条历史内容`,
                metadata: {},
                createdAt: now + index,
                updatedAt: now + index,
            })),
            assets: [],
            events: [],
        });

        await createBundle(run(), [], "conversation");

        const conversation = (mocks.files.get("creative-runtime.json") as { conversations: Array<{ contextSummaryThroughSequence: number; contextSummary: string }> }).conversations[0];
        expect(conversation.contextSummaryThroughSequence).toBe(1);
        expect(conversation.contextSummary).toContain("第 1 条历史内容");
        expect(conversation.contextSummary).not.toContain("第 3 条历史内容");

        const runtime = mocks.files.get("creative-runtime.json") as {
            messages: Array<{ id: string; status: "completed" | "running" }>;
        };
        runtime.messages = runtime.messages.map((item) => (item.id === "message-2" ? { ...item, status: "completed" } : item));
        mocks.files.set("creative-runtime.json", runtime);
        await mutateCreativeRun<AgentRun>(
            "run-one",
            60_000,
            (current) => ({
                run: { ...current, status: "completed" },
                assistant: { status: "completed", content: "第一轮已经完成。" },
            }),
            ["planning"],
        );
        await createBundle(
            run({
                id: "run-two",
                clientRequestId: "request-two",
                inputMessageId: "input-message-two",
                assistantMessageId: "assistant-message-two",
                prompt: "继续处理",
            }),
            [],
            "conversation",
        );

        const resumed = await getCreativeConversationContext("conversation", "user", "run-two");
        expect(resumed.summaryThroughSequence).toBe(6);
        expect(resumed.summary).toContain("第 2 条历史内容");
        expect(resumed.summary).toContain("第 6 条历史内容");
        expect(resumed.recentMessages.map((item) => item.sequence)).toEqual(Array.from({ length: CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT }, (_, index) => index + 7));
    });

    it("queries owned PostgreSQL conversation context once with an ordered bounded message subquery", async () => {
        mocks.databaseProvider = "postgres";
        mocks.query.mockResolvedValue({
            rows: [
                {
                    context_summary: "已压缩内容",
                    context_summary_through_sequence: 120,
                    recent_messages: [
                        {
                            id: "message-121",
                            conversation_id: "conversation",
                            sequence: 121,
                            role: "user",
                            status: "completed",
                            content: "继续完善分镜",
                            metadata: {},
                            created_at: new Date(0),
                            updated_at: new Date(0),
                        },
                    ],
                },
            ],
        });

        await expect(getCreativeConversationContext("conversation", "user", "current-run")).resolves.toMatchObject({ summary: "已压缩内容", summaryThroughSequence: 120, recentMessages: [{ sequence: 121, content: "继续完善分镜" }] });

        expect(mocks.query).toHaveBeenCalledTimes(1);
        const [sql, parameters] = mocks.query.mock.calls[0] || [];
        expect(String(sql)).toContain("conversation.id = $1 AND conversation.user_id = $2");
        expect(String(sql)).toContain("message.sequence > conversation.context_summary_through_sequence");
        expect(String(sql)).toContain("ORDER BY message.sequence DESC");
        expect(String(sql)).toContain("LIMIT $4");
        expect(String(sql)).not.toContain("FOR UPDATE");
        expect(parameters).toEqual(["conversation", "user", "current-run", CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT]);
    });

    it("persists PostgreSQL rolling context before appending the next Agent round", async () => {
        mocks.databaseProvider = "postgres";
        const queries: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
        const now = Date.now();
        const conversationRow = {
            id: "conversation",
            user_id: "user",
            surface: "chat",
            source: "agent",
            project_id: null,
            title: "长对话",
            status: "active",
            context_summary: "",
            context_summary_through_sequence: 0,
            created_at: new Date(now),
            updated_at: new Date(now),
            last_message_at: new Date(now),
        };
        const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
            queries.push({ sql, parameters });
            if (sql.startsWith("SELECT payload")) return { rows: [] };
            if (sql.includes("FROM creative_conversations WHERE id = $1 AND user_id = $2 FOR UPDATE")) return { rows: [conversationRow] };
            if (sql.startsWith("WITH context_messages")) return { rows: [{ summary_additions: "用户：较早需求\n助手：较早回复", summary_through_sequence: 4 }] };
            if (sql.startsWith("SELECT COALESCE(MAX")) return { rows: [{ sequence: 16 }] };
            if (sql.startsWith("INSERT INTO creative_run_events")) return { rows: [{ id: 1, run_id: "run-one", type: "run.created", data: null, created_at: new Date(now) }] };
            if (sql.startsWith("UPDATE creative_conversations SET title"))
                return {
                    rows: [{ ...conversationRow, context_summary: "用户：较早需求\n助手：较早回复", context_summary_through_sequence: 4, updated_at: new Date(now), last_message_at: new Date(now) }],
                };
            return { rows: [] };
        });
        mocks.transaction.mockImplementation(async (handler: (client: { query: typeof query }) => Promise<unknown>) => handler({ query }));

        await expect(createBundle(run({ createdAt: now, updatedAt: now }), [], "conversation")).resolves.toMatchObject({ created: true, conversation: { contextSummary: "用户：较早需求\n助手：较早回复", contextSummaryThroughSequence: 4 } });

        const summaryQuery = queries.find((item) => item.sql.startsWith("WITH context_messages"));
        expect(summaryQuery?.parameters).toEqual(["conversation", 0, CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT]);
        expect(summaryQuery?.sql).toContain("OFFSET $3 LIMIT 1");
        expect(summaryQuery?.sql).toContain("MIN(message.sequence) - 1");
        expect(queries).toContainEqual({
            sql: "UPDATE creative_conversations SET context_summary = $2, context_summary_through_sequence = $3 WHERE id = $1",
            parameters: ["conversation", "用户：较早需求\n助手：较早回复", 4],
        });
    });

    it("inserts PostgreSQL Agent tasks with their initial recovery schedule atomically", async () => {
        mocks.databaseProvider = "postgres";
        const queries: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
        const now = Date.now();
        const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
            queries.push({ sql, parameters });
            if (sql.startsWith("SELECT payload")) return { rows: [] };
            if (sql.startsWith("SELECT COALESCE(MAX")) return { rows: [{ sequence: 0 }] };
            if (sql.startsWith("INSERT INTO creative_run_events")) return { rows: [{ id: 1, run_id: "run-one", type: "run.created", data: null, created_at: new Date(now) }] };
            if (sql.startsWith("UPDATE creative_conversations"))
                return {
                    rows: [
                        {
                            id: "conversation",
                            user_id: "user",
                            surface: "chat",
                            source: "agent",
                            project_id: null,
                            title: "测试会话",
                            status: "active",
                            context_summary: "",
                            context_summary_through_sequence: 0,
                            created_at: new Date(now),
                            updated_at: new Date(now),
                            last_message_at: new Date(now),
                        },
                    ],
                };
            return { rows: [] };
        });
        mocks.transaction.mockImplementation(async (handler: (client: { query: typeof query }) => Promise<unknown>) => handler({ query }));

        await expect(createBundle(run({ createdAt: now, updatedAt: now }))).resolves.toMatchObject({ created: true, run: { id: "run-one" } });

        const taskInsert = queries.find((item) => item.sql.includes("INSERT INTO generation_tasks"));
        expect(taskInsert?.sql).toContain("execution_phase, next_poll_at, last_upstream_status");
        expect(taskInsert?.sql).toContain("'created', $4, 'created'");
    });

    it("appends a workbench exchange atomically and advances the sequence", async () => {
        await createCreativeConversation("user", { surface: "chat", source: "image-workbench" });
        const conversation = (mocks.files.get("creative-runtime.json") as { conversations: Array<{ id: string }> }).conversations[0];

        const exchange = await appendCreativeConversationExchange({
            userId: "user",
            conversationId: conversation.id,
            userContent: "生成产品主图",
            assistantContent: "已选择横向商业摄影方案。",
            assistantMetadata: { workspace: "image" },
        });

        expect(exchange).toMatchObject({ userMessage: { sequence: 1, role: "user" }, assistantMessage: { sequence: 2, role: "assistant" } });
        expect(await listCreativeMessages(conversation.id)).toHaveLength(2);
        await expect(appendCreativeConversationExchange({ userId: "other", conversationId: conversation.id, userContent: "test", assistantContent: "reply" })).rejects.toMatchObject({ status: 404 });
    });

    it("is idempotent for the same request identity but keeps identical prompts from new requests", async () => {
        const conversation = await createCreativeConversation("user", { surface: "chat", source: "image-workbench" });
        const input = { userId: "user", conversationId: conversation.id, userContent: "相同提示词", assistantContent: "已收到生成需求。", runId: "request-one" };
        const first = await appendCreativeConversationExchange(input);
        const replay = await appendCreativeConversationExchange(input);
        const second = await appendCreativeConversationExchange({ ...input, runId: "request-two" });

        expect(replay).toEqual(first);
        expect(second.userMessage.id).not.toBe(first.userMessage.id);
        expect((await listCreativeMessages(conversation.id)).filter((message) => message.role === "user")).toHaveLength(2);
    });

    it("filters conversation sources before applying pagination", async () => {
        const agent = await createCreativeConversation("user", { surface: "chat", source: "agent", title: "Agent" });
        await createCreativeConversation("user", { surface: "chat", source: "image-workbench", title: "Image" });
        await createCreativeConversation("user", { surface: "chat", source: "video-workbench", title: "Video" });

        expect(await listCreativeConversations("user", { surface: "chat", source: "agent", limit: 1 })).toEqual([agent]);
    });

    it("filters project conversations before applying pagination", async () => {
        const first = await createCreativeConversation("user", { surface: "drama", source: "drama", projectId: "project-one", title: "第一条" });
        await createCreativeConversation("user", { surface: "drama", source: "drama", projectId: "project-two", title: "其他项目" });
        const second = await createCreativeConversation("user", { surface: "drama", source: "drama", projectId: "project-one", title: "第二条" });

        expect(await listCreativeConversations("user", { surface: "drama", source: "drama", projectId: "project-one", limit: 2 })).toEqual([second, first]);
    });

    it("loads the newest page first and can page backward through long conversations", async () => {
        const now = Date.now();
        mocks.files.set("creative-runtime.json", {
            version: 1,
            nextEventId: 1,
            conversations: [],
            assets: [],
            events: [],
            messages: Array.from({ length: 240 }, (_, index) => ({
                id: `message-${index + 1}`,
                conversationId: "long",
                sequence: index + 1,
                role: index % 2 ? "assistant" : "user",
                status: "completed",
                content: String(index + 1),
                metadata: {},
                createdAt: now,
                updatedAt: now,
            })),
        });

        const latest = await listCreativeMessages("long", 0, 200);
        const older = await listCreativeMessages("long", 0, 200, latest[0].sequence);

        expect(latest[0].sequence).toBe(41);
        expect(latest.at(-1)?.sequence).toBe(240);
        expect(older.map((item) => item.sequence)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    });
});

function createBundle(value: AgentRun, assetIds: string[] = [], conversationId?: string) {
    return createCreativeRunBundle("user", { run: value, conversationId, prompt: value.prompt, title: "测试会话", assetIds, ttlMs: 60_000 });
}

function seedChildLog(value: AgentRun) {
    mocks.files.set("generation-logs.json", {
        version: 1,
        logs: [
            normalizeStoredLog({
                id: "child-log",
                taskId: "image-child",
                userId: value.userId,
                title: "Image delivery",
                durationMs: 55000,
                requestSnapshot: {
                    version: 1,
                    userPrompt: value.prompt,
                    parameters: {},
                    references: [],
                    run: generationLogRunSnapshot(value, "generation"),
                    slots: [{ id: "image-child", index: 0, status: "success", attempts: [{ attemptNo: 1, model: "image", status: "succeeded", startedAt: 100, pointsCost: 1.5 }] }],
                },
            }),
        ],
    });
}

function run(patch: Partial<AgentRun> = {}): AgentRun {
    const now = Date.now();
    return {
        id: "run-one",
        userId: "user",
        conversationId: "conversation",
        clientRequestId: "request-one",
        surface: "chat",
        inputMessageId: "input-message",
        assistantMessageId: "assistant-message",
        prompt: "生成一张图",
        referencedAssetIds: [],
        assetIds: [],
        status: "planning",
        tasks: [],
        reviewed: false,
        createdAt: now,
        updatedAt: now,
        ...patch,
    };
}
