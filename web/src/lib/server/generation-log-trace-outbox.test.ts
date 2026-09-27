import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getImageTask: vi.fn(),
}));

vi.mock("./image-task-store", () => ({ getImageTask: mocks.getImageTask }));

import { hydrateEcommerceTracesFromImageTasks } from "./generation-log-store";
import type { EcommerceGenerationTrace } from "./ecommerce-generation-trace";
import type { StoredGenerationLog } from "./generation-log-types";

describe("ecommerce generation trace outbox", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("hydrates an administrator log from the durable image-task trace", async () => {
        const trace = ecommerceTrace();
        const persist = vi.fn(async () => ({ updated: 1 }));
        mocks.getImageTask.mockResolvedValue({ id: "image-task-1", ecommerceTrace: trace });

        const [hydrated] = await hydrateEcommerceTracesFromImageTasks([generationLog()], persist);

        expect(hydrated.ecommerceTrace).toEqual(trace);
        expect(mocks.getImageTask).toHaveBeenCalledWith("image-task-1");
        expect(persist).toHaveBeenCalledWith(["image-task-1"], trace);
    });

    it("does not read image tasks when a log already has its trace", async () => {
        const log = { ...generationLog(), ecommerceTrace: ecommerceTrace() };

        await expect(hydrateEcommerceTracesFromImageTasks([log], vi.fn())).resolves.toEqual([log]);
        expect(mocks.getImageTask).not.toHaveBeenCalled();
    });
});

function ecommerceTrace(): EcommerceGenerationTrace {
    return {
        version: "ecommerce-generation-trace.v1",
        runId: "run-1",
        agentTaskId: "agent-task-1",
        imageTaskIds: ["image-task-1"],
        stages: [
            { key: "visual_analysis", status: "completed", output: {} },
            { key: "edit_planning", status: "completed", output: {} },
            { key: "image_generation", status: "completed", output: {} },
            { key: "quality_check", status: "passed", output: {} },
        ],
        finalStatus: "passed",
        recordedAt: 1,
    };
}

function generationLog(): StoredGenerationLog {
    return {
        id: "log-1",
        userId: "user-1",
        username: "creator",
        displayName: "Creator",
        kind: "image",
        source: "agent",
        status: "success",
        title: "Product scene",
        prompt: "Place the product in a room",
        model: "image-model",
        summary: "done",
        durationMs: 100,
        count: 1,
        successCount: 1,
        failCount: 0,
        assets: [],
        taskId: "image-task-1",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };
}
