import type { QueryResultRow } from "pg";
import { expect, it, vi } from "vitest";
import type { AgentRun } from "./agent-run-store";

type Claim = { id: string; executionId: string; leaseUntil: number };
export type ImageProcessingProcessInput = {
    command: "claim" | "late_heartbeat" | "cancel" | "resource_resume";
    origin: string;
    key: string;
    taskId: string;
    userId: string;
    runId?: string;
    workerId: string;
    profileVersion: string;
    availableMemoryBytes: number;
    observeSelection: boolean;
};
export type ImageProcessingProcessStage = { pid: number; claims?: Claim[]; backendPid?: number; selectedIds?: string[] };
export type ImageProcessingProcessResult = { pid: number; claims: Claim[]; heartbeatStatus?: number; resourceResume?: { outcome: "resumed"; runId: string } | { outcome: "conflict" } };

const input = vi.hoisted(() => JSON.parse(process.env.VOZEB_PRO_IMAGE_PROCESSING_PROCESS_INPUT || "null") as ImageProcessingProcessInput | null);
const observation = vi.hoisted(() => ({ selected: false, resumeReady: false }));

async function post(phase: "ready" | "selected" | "claimed" | "result", value: ImageProcessingProcessStage | ImageProcessingProcessResult) {
    if (!input) throw new Error("Image process fixture input is required");
    const response = await fetch(`${input.origin}/_image-processing-process/${input.key}/${phase}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    expect(response.status).toBe(200);
}

// Observe completed real row locking; every query and transaction still uses PG.
vi.mock("./database", async (original) => {
    const actual = await original<typeof import("./database")>();
    return {
        ...actual,
        withPostgresTransaction: <T>(callback: Parameters<typeof actual.withPostgresTransaction<T>>[0]) =>
            actual.withPostgresTransaction(async (executor) => {
                const observedExecutor: typeof executor = {
                    query: async <Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => {
                        if (input?.command === "resource_resume" && !observation.resumeReady && /task_type = 'agent'/.test(sql) && /FOR UPDATE/.test(sql)) {
                            observation.resumeReady = true;
                            // Pin ready to the owner's actual transaction connection before it waits on the parent.
                            const backend = await executor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                            await post("ready", { pid: process.pid, backendPid: backend.rows[0].pid });
                        }
                        const result = await executor.query<Row>(sql, values);
                        const selected = /WITH user_candidates AS MATERIALIZED/.test(sql) || (input?.command === "cancel" && /FOR UPDATE/.test(sql) && /task_type = 'image_processing'/.test(sql));
                        if (input?.observeSelection && !observation.selected && selected) {
                            observation.selected = true;
                            const backend = await executor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                            await post("selected", { pid: process.pid, backendPid: backend.rows[0].pid, selectedIds: result.rows.map((row) => String(row.id)) });
                        }
                        return result;
                    },
                };
                return callback(observedExecutor);
            }),
    };
});

(input ? it : it.skip)(
    "executes one isolated image processing process command",
    async () => {
        if (
            !input ||
            process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION !== "1" ||
            process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" ||
            process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" ||
            process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" ||
            !process.env.DATABASE_URL
        )
            throw new Error("Explicit isolated PostgreSQL process fixture with pool maximum one is required");
        const { cancelImageProcessingTaskForRun, claimImageProcessingTasks, heartbeatImageProcessingTask, resumeImageProcessingTaskForRun, ImageProcessingInputError } = await import("./image-processing-service");
        const { getStoredGenerationTask, getStoredGenerationTaskRecord } = await import("./generation-task-store");
        const task = await getStoredGenerationTaskRecord("image_processing", input.taskId);
        expect(task?.userId).toBe(input.userId);
        expect(task?.payload.resource).toMatchObject({ profileVersion: input.profileVersion });

        if (input.command === "resource_resume") {
            if (!input.runId || !task) throw new Error("Resource resume process fixture requires the original parent and child");
            const parent = await getStoredGenerationTask<AgentRun>("agent", input.runId);
            if (!parent) throw new Error("Resource resume process fixture parent is missing");
            expect(task).toMatchObject({ runId: input.runId, status: "paused", executionPhase: "needs_review" });
            expect(parent).toMatchObject({ id: input.runId, userId: input.userId, status: "paused", ecommerceSnapshot: { processing: { waitingFor: { jobId: task.id, inputDigest: task.payload.inputDigest } } } });
            try {
                const resumed = await resumeImageProcessingTaskForRun(parent);
                if (!resumed) throw new Error("Resource resume owner did not return its original Run");
                expect(resumed).toMatchObject({ id: input.runId, status: "running" });
                await post("result", { pid: process.pid, claims: [], resourceResume: { outcome: "resumed", runId: resumed.id } });
            } catch (error) {
                if (!(error instanceof ImageProcessingInputError) || error.status !== 409) throw error;
                await post("result", { pid: process.pid, claims: [], resourceResume: { outcome: "conflict" } });
            }
            return;
        }
        if (input.command === "cancel") {
            if (!input.runId) throw new Error("Cancel process fixture requires the actual parent Run identity");
            const { postgresQuery } = await import("./database");
            const backend = await postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            await post("ready", { pid: process.pid, backendPid: backend.rows[0].pid });
            await cancelImageProcessingTaskForRun({ userId: input.userId, runId: input.runId, jobId: input.taskId });
            await post("result", { pid: process.pid, claims: [] });
            return;
        }
        await post("ready", { pid: process.pid });
        const claimed = await claimImageProcessingTasks({ workerId: input.workerId, profileVersion: input.profileVersion, availableMemoryBytes: input.availableMemoryBytes, slots: 1 });
        const claims = claimed.tasks.map(({ id, executionId, leaseUntil }) => ({ id, executionId, leaseUntil }));
        const result: ImageProcessingProcessResult = { pid: process.pid, claims };
        if (input.command === "late_heartbeat") {
            expect(claims).toHaveLength(1);
            expect(claims[0].id).toBe(input.taskId);
            await post("claimed", { pid: process.pid, claims });
            try {
                await heartbeatImageProcessingTask(input.taskId, { workerId: input.workerId, executionId: claims[0].executionId });
                result.heartbeatStatus = 200;
            } catch (error) {
                if (!(error instanceof Error) || !("status" in error) || error.status !== 409) throw error;
                result.heartbeatStatus = error.status;
            }
        }
        await post("result", result);
    },
    120_000,
);
