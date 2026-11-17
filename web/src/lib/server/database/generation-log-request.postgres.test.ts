import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as postgres from "./postgres";
import { createPostgresRepositories } from "./repositories";
import { createCreativeRunBundle } from "../creative-runtime-store";
import { updateAgentRunById, type AgentRun } from "../agent-run-store";
import { listGenerationLogs } from "../generation-log-store";
import { writeImageGenerationLog } from "@/app/api/image-tasks/image-task-runner";
import type { ImageTask } from "../image-task-store";

const enabled = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
const owner = `request-log-owner-${randomUUID()}`;
const other = `request-log-other-${randomUUID()}`;
const runIds: string[] = [];

async function createRun(prompt: string) {
    const now = Date.now();
    const id = `request-log-${randomUUID()}`;
    const run: AgentRun = {
        id,
        userId: owner,
        conversationId: `conversation-${randomUUID()}`,
        clientRequestId: randomUUID(),
        surface: "chat",
        inputMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        prompt,
        publicPrompt: "只改变桌面颜色",
        generationPreferences: { mode: "image" },
        referencedAssetIds: [],
        assetIds: [],
        status: "planning",
        tasks: [],
        reviewed: false,
        createdAt: now,
        updatedAt: now,
    };
    await createCreativeRunBundle(owner, { run, prompt: run.publicPrompt!, title: "Request log fixture", assetIds: [], ttlMs: 60_000 });
    runIds.push(id);
    return run;
}

describe.skipIf(!enabled)("isolated PostgreSQL durable request logs", () => {
    beforeAll(async () => {
        const target = new URL(process.env.DATABASE_URL || "");
        if (process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_m5_e2e") || process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1")
            throw new Error("An isolated PostgreSQL fixture with a single connection is required");
        await postgres.initializePostgresSchema();
        await postgres.postgresQuery("INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, $1, 'Owner', 'unusable-fixture'), ($2, $2, 'Other', 'unusable-fixture')", [owner, other]);
    }, 30_000);

    afterAll(async () => {
        await postgres.postgresQuery("DELETE FROM creative_run_events WHERE run_id = ANY($1::text[])", [runIds]);
        await postgres.postgresQuery("DELETE FROM users WHERE id = ANY($1::text[])", [[owner, other]]);
    });

    it("persists a pre-generation pause with its original message and excludes it from generation counts", async () => {
        const run = await createRun("expanded internal requirement");
        await updateAgentRunById(run.id, { status: "paused", failure: "请确认要编辑哪张图" }, { type: "run.paused" }, ["planning"]);

        const admin = await listGenerationLogs({ userId: owner, includeRequestRecords: true });
        expect(admin.items.find((log) => log.id === `agent-run:${run.id}`)).toMatchObject({
            username: owner,
            requestSnapshot: { userPrompt: "只改变桌面颜色", run: { id: run.id, inputMessageId: run.inputMessageId, status: "paused", reason: "请确认要编辑哪张图" } },
        });
        expect((await listGenerationLogs({ userId: owner })).items).toEqual([]);
        const aggregate = await createPostgresRepositories().generationLogs.getOverviewAggregate({ startAt: new Date(run.createdAt - 1000).toISOString(), endAt: new Date(run.createdAt + 60_000).toISOString(), timeZone: "UTC" });
        expect(aggregate.totalCalls).toBe(0);
    });

    it("rolls back the run transition if its request log cannot be committed", async () => {
        const run = await createRun("request with a conflicting log identity");
        const time = new Date(run.createdAt).toISOString();
        await createPostgresRepositories().generationLogs.upsert({
            id: `agent-run:${run.id}`,
            userId: other,
            username: other,
            displayName: "Other",
            kind: "image",
            source: "agent",
            status: "failed",
            title: "Other owner's log",
            prompt: "Other request",
            model: "",
            summary: "Failed",
            durationMs: 0,
            count: 1,
            successCount: 0,
            failCount: 1,
            assets: [],
            createdAt: time,
            updatedAt: time,
        });

        await expect(updateAgentRunById(run.id, { status: "paused", failure: "请选择目标" }, { type: "run.paused" }, ["planning"])).rejects.toThrow("generation log id belongs to another user");

        const persisted = await postgres.postgresQuery<{ status: string }>("SELECT payload ->> 'status' AS status FROM generation_tasks WHERE id = $1", [run.id]);
        expect(persisted.rows[0].status).toBe("planning");
    });

    it("freezes original input and fractional billing through the existing transaction after task retention", async () => {
        const run = await createRun("compiled planning request");
        await updateAgentRunById(run.id, { status: "running" }, { type: "run.running" }, ["planning"]);
        const task: ImageTask = {
            id: `image-${randomUUID()}`,
            userId: owner,
            username: owner,
            displayName: "Owner",
            conversationId: run.conversationId,
            runId: run.id,
            kind: "generation",
            source: "agent",
            status: "error",
            createdAt: run.createdAt,
            updatedAt: run.createdAt + 200,
            prompt: "compiled image request",
            references: [],
            config: { baseUrl: "https://provider.invalid", apiKey: "PRIVATE-CREDENTIAL", apiFormat: "openai", model: "upstream-image" },
            attempts: [{ attemptNo: 1, model: "upstream-image", channelId: "channel-one", status: "failed", startedAt: run.createdAt, completedAt: run.createdAt + 200, pointsCost: 1.5, pointsRecordId: "charge-one" }],
            billing: { pointsCost: 1.5, pointsRecordId: "charge-one", refunded: true },
        };
        await postgres.withPostgresTransaction((executor) => writeImageGenerationLog(task, "failed", "", 200, "明确失败", undefined, executor));
        const logs = await listGenerationLogs({ userId: owner, includeEcommerceTrace: true });
        const saved = logs.items.find((log) => log.taskId === task.id);
        expect(saved?.requestSnapshot).toMatchObject({
            userPrompt: "只改变桌面颜色",
            run: { id: run.id, inputMessageId: run.inputMessageId },
            slots: [{ prompt: "compiled image request", attempts: [{ pointsCost: 1.5, pointsRecordId: "charge-one" }], billing: { pointsCost: 1.5, refunded: true } }],
        });
        expect(JSON.stringify(saved)).not.toContain("PRIVATE-CREDENTIAL");
    });
});
