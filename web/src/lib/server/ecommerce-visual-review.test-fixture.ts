import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { completeClaimedImageProcessingFixture } from "./image-processing.test-fixture";
import { imageProcessingResourceConfig } from "../image-processing/resource-config";

// Controlled fixtures still use actual review claims, source reads, isolated CPU workers and receipts.
export async function prepareAdvisoryReview(runId: string, input: { origin: string; cookie: string; directory: string; failFirst?: boolean }) {
    const [service, scheduler, tasks, { runGenerationTaskRecoveryBatch }, { getAgentRun }] = await Promise.all([
        import("./image-processing-service"),
        import("./generation-task-scheduler"),
        import("./generation-task-store"),
        import("./generation-task-recovery-service"),
        import("./agent-run-store"),
    ]);
    const parent = await tasks.getStoredGenerationTaskRecord("agent", runId);
    assert.ok(parent);
    if (parent.workerId)
        await scheduler.releaseGenerationTaskLease("agent", runId, parent.workerId, { executionPhase: "review_pending", nextPollAt: Date.now() }, { executionId: typeof parent.payload.executionId === "string" ? parent.payload.executionId : undefined });
    expect(await runGenerationTaskRecoveryBatch({ origin: input.origin, cookie: input.cookie, workerId: "fixture-review-prepare", taskIds: [runId], limit: 1 })).toMatchObject({ claimed: 1 });
    const waiting = await getAgentRun(runId);
    assert.ok(waiting?.ecommerceSnapshot?.visualReview);
    expect(waiting.reviewed).toBe(false);
    const jobs = (await tasks.listStoredGenerationTaskRecordsByRunIds([runId], [waiting.userId]))
        .filter((record) => record.type === "image_processing" && record.payload.operation === "prepare_review")
        .toSorted((left, right) => Number(left.nextPollAt) - Number(right.nextPollAt) || left.id.localeCompare(right.id));
    expect(jobs.length).toBeGreaterThan(0);
    for (const [index, job] of jobs.entries()) {
        const workerId = "fixture-review-cpu-" + randomUUID();
        const { profileVersion, budgetBytes } = imageProcessingResourceConfig(process.env);
        const claimed = await service.claimImageProcessingTasks({ workerId, profileVersion, availableMemoryBytes: budgetBytes, slots: 1 });
        expect(claimed.tasks).toHaveLength(1);
        const child = claimed.tasks[0];
        assert.ok(child && child.payload.operation === "prepare_review");
        expect(child.id).toBe(job.id);
        const identity = { workerId, executionId: child.executionId };
        if (input.failFirst && index === 0) {
            await service.failImageProcessingTask(child.id, {
                ...identity,
                failure: { status: "rejected", jobId: child.id, executionId: child.executionId, pid: null, exitCode: null, signal: null, stderr: "", error: { code: "fixture_review_preparation_failed", message: "fixture preparation rejected" } },
            });
            continue;
        }
        const { manifest } = await completeClaimedImageProcessingFixture(child, workerId, input.directory);
        expect(manifest.artifacts).toHaveLength(1);
        expect(manifest.artifacts[0].kind).toBe("analysis");
    }
    return (await getAgentRun(runId))!;
}

export async function recoverAdvisoryReview(runId: string, origin = "http://fixture.local", cookie = "session=fixture") {
    const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
    return runGenerationTaskRecoveryBatch({ origin, cookie, workerId: "fixture-review-finish-" + randomUUID(), taskIds: [runId], limit: 1 });
}
