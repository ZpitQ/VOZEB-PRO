import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoredGenerationTaskRecord } from "./generation-task-store";

describe("File native user recovery scheduler command guards", () => {
    let directory: string;
    let userId: string;
    let imageTasks: typeof import("./image-task-store");
    let tasks: typeof import("./generation-task-store");
    let scheduler: typeof import("./generation-task-scheduler");
    const upstream = {
        upstreamTaskId: "fixture-native-user-recovery-guards-upstream",
        channelId: "fixture-native-user-recovery-guards-channel",
        provider: "openai",
        queryPath: "/fixture-query/{taskId}",
        submittedAt: 1_700_000_000_000,
    };
    const workerId = "fixture-native-user-recovery-guards-worker";
    const reviewReason = "Fixture original task remains pending";

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-native-user-recovery-guards-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        [imageTasks, tasks, scheduler] = await Promise.all([import("./image-task-store"), import("./generation-task-store"), import("./generation-task-scheduler")]);
        userId = `fixture-native-user-recovery-guards-${randomUUID()}`;
    }, 30_000);

    afterAll(async () => {
        try {
            if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    async function createScheduledImage() {
        const task = await imageTasks.createImageTask({
            userId,
            username: "fixture-native-user-recovery-guards",
            displayName: "Isolated native user recovery guard fixture",
            kind: "generation",
            source: "image-workbench",
            config: { baseUrl: "https://fixture.invalid", apiKey: "fixture-only", apiFormat: "openai", model: "fixture-guard-model" },
            prompt: "Preserve the current task when a user recovery command is stale",
            references: [],
            upstream: { id: upstream.upstreamTaskId, mediaBaseUrl: "https://fixture.invalid", pollBaseUrl: "https://fixture.invalid" },
        });
        assert.ok(
            await scheduler.scheduleGenerationTask("image", task.id, {
                ...upstream,
                executionPhase: "submitted",
                nextPollAt: 1,
                lastUpstreamStatus: "fixture_upstream_pending",
                resultPayload: { fixture: "preserved" },
            }),
        );
        return task;
    }

    // The public getter hides expired records; inspect the persisted row under its real File lock.
    async function rawRecord(id: string) {
        return tasks.withGenerationTaskFileMutation(async (records) => {
            const record = records.find((item) => item.type === "image" && item.id === id);
            assert.ok(record);
            return { tasks: records, result: record };
        });
    }

    async function expectBothCommandsRejected(before: StoredGenerationTaskRecord) {
        expect(await scheduler.rearmImageTaskForUser({ id: before.id, ...upstream })).toBeNull();
        expect(await rawRecord(before.id)).toStrictEqual(before);
        expect(await scheduler.markImageTaskUserCheckPending(before, reviewReason)).toBeNull();
        expect(await rawRecord(before.id)).toStrictEqual(before);
    }

    it("rearms an eligible image and conditionally returns the matching observation to user review", async () => {
        const task = await createScheduledImage();
        const before = await rawRecord(task.id);
        const startedAt = Date.now();
        const rearmed = await scheduler.rearmImageTaskForUser({ id: task.id, ...upstream });
        assert.ok(rearmed);
        expect(rearmed).toMatchObject({ ...upstream, executionPhase: "polling", lastUpstreamStatus: "user_recovery_requested" });
        expect(rearmed.nextPollAt).toBeGreaterThanOrEqual(startedAt);
        expect(rearmed.nextPollAt).toBeLessThanOrEqual(Date.now());
        const observed = await rawRecord(task.id);
        expect(observed).toStrictEqual({ ...before, executionPhase: "polling", nextPollAt: rearmed.nextPollAt, lastUpstreamStatus: "user_recovery_requested" });

        expect(await scheduler.markImageTaskUserCheckPending(observed, reviewReason)).toMatchObject({ executionPhase: "needs_review", nextPollAt: undefined });
        const pending = await rawRecord(task.id);
        expect(pending).toMatchObject({ ...upstream, executionPhase: "needs_review", lastUpstreamStatus: "user_recovery_requested" });
        expect(pending).not.toHaveProperty("nextPollAt");
        expect(pending.payload).toStrictEqual(before.payload);
        expect(pending.resultPayload).toStrictEqual({ fixture: "preserved", reviewReason });
    });

    it.each(["cancelled", "error"] as const)("preserves the full terminal image after both commands (%s)", async (status) => {
        const task = await createScheduledImage();
        assert.ok(await imageTasks.transitionImageTask(task, ["pending"], { status }));
        const before = await rawRecord(task.id);
        expect(before.status).toBe(status);
        expect(before.expiresAt).toBeGreaterThan(Date.now());
        await expectBothCommandsRejected(before);
    });

    it("preserves the full expired row after both commands", async () => {
        const task = await createScheduledImage();
        const active = await rawRecord(task.id);
        const expiresAt = Date.now();
        await tasks.withGenerationTaskFileMutation(async (records) => ({
            tasks: records.map((record) => (record.type === "image" && record.id === task.id ? { ...record, expiresAt } : record)),
            result: undefined,
        }));
        const before = await rawRecord(task.id);
        expect(before).toStrictEqual({ ...active, expiresAt });
        expect(before.expiresAt).toBeLessThanOrEqual(Date.now());
        await expectBothCommandsRejected(before);
    });

    it("preserves the full current claim after both commands", async () => {
        const task = await createScheduledImage();
        const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [task.id], limit: 1 });
        assert.equal(claimed.length, 1);
        const claim = claimed[0];
        assert.ok(claim);
        assert.ok(claim.executionId);
        const before = await rawRecord(task.id);
        expect(before.workerId).toBe(workerId);
        expect(before.payload.executionId).toBe(claim.executionId);
        expect(before.leaseUntil).toBeGreaterThan(Date.now());
        await expectBothCommandsRejected(before);
    });

    it("rejects the old observation after a real claim is released and accepts the current epoch", async () => {
        const task = await createScheduledImage();
        const observed = await rawRecord(task.id);
        const claimed = await scheduler.claimDueGenerationTasks({ workerId, taskIds: [task.id], limit: 1 });
        assert.equal(claimed.length, 1);
        const claim = claimed[0];
        assert.ok(claim);
        assert.ok(claim.workerId);
        assert.ok(claim.executionId);
        assert.ok(await scheduler.releaseGenerationTaskLease("image", task.id, claim.workerId, { executionPhase: observed.executionPhase, nextPollAt: observed.nextPollAt }, { executionId: claim.executionId }));
        const current = await rawRecord(task.id);
        expect(current).toStrictEqual({ ...observed, payload: { ...observed.payload, executionId: claim.executionId }, lastHeartbeatAt: claim.lastHeartbeatAt });
        expect(current.workerId).toBeUndefined();
        expect(current.leaseUntil).toBeUndefined();

        expect(await scheduler.markImageTaskUserCheckPending(observed, reviewReason)).toBeNull();
        expect(await rawRecord(task.id)).toStrictEqual(current);
        expect(await scheduler.markImageTaskUserCheckPending(current, reviewReason)).toMatchObject({ executionPhase: "needs_review" });
        expect((await rawRecord(task.id)).payload).toStrictEqual(current.payload);
    });

    it("rejects an old due time and accepts the current schedule observation", async () => {
        const task = await createScheduledImage();
        const observed = await rawRecord(task.id);
        const nextPollAt = Date.now();
        assert.ok(await scheduler.scheduleGenerationTask("image", task.id, { executionPhase: observed.executionPhase, nextPollAt }));
        const current = await rawRecord(task.id);
        expect(current).toStrictEqual({ ...observed, nextPollAt });
        expect(current.nextPollAt).not.toBe(observed.nextPollAt);

        expect(await scheduler.markImageTaskUserCheckPending(observed, reviewReason)).toBeNull();
        expect(await rawRecord(task.id)).toStrictEqual(current);
        expect(await scheduler.markImageTaskUserCheckPending(current, reviewReason)).toMatchObject({ executionPhase: "needs_review" });
        expect((await rawRecord(task.id)).payload).toStrictEqual(current.payload);
    });

    it.each([
        { name: "both absent", fields: {} },
        { name: "native null", fields: { nativeResults: null } },
        { name: "processing null", fields: { resultProcessing: null } },
        { name: "both null", fields: { nativeResults: null, resultProcessing: null } },
    ])("treats persisted missing and JSON null native fields as absent ($name)", async ({ fields }) => {
        const task = await createScheduledImage();
        const original = await rawRecord(task.id);
        expect(original.payload).not.toHaveProperty("nativeResults");
        expect(original.payload).not.toHaveProperty("resultProcessing");
        await tasks.withGenerationTaskFileMutation(async (records) => ({
            tasks: records.map((record) => (record.type === "image" && record.id === task.id ? { ...record, payload: { ...record.payload, ...fields } } : record)),
            result: undefined,
        }));
        const boundary = await rawRecord(task.id);
        expect(boundary.payload).toStrictEqual({ ...original.payload, ...fields });

        expect(await scheduler.rearmImageTaskForUser({ id: task.id, ...upstream })).toMatchObject({ executionPhase: "polling" });
        const observed = await rawRecord(task.id);
        expect(observed.payload).toStrictEqual(boundary.payload);
        expect(await scheduler.markImageTaskUserCheckPending(observed, reviewReason)).toMatchObject({ executionPhase: "needs_review" });
        const pending = await rawRecord(task.id);
        expect(pending).not.toHaveProperty("nextPollAt");
        expect(pending.payload).toStrictEqual(boundary.payload);
        expect(pending.resultPayload).toStrictEqual({ fixture: "preserved", reviewReason });
    });
});
