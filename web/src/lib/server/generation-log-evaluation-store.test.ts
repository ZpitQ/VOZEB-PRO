import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerationLogEvaluation } from "@/lib/generation-log-evaluation";
import type { StoredGenerationLog } from "./generation-log-types";

const log: StoredGenerationLog = {
    id: "evaluation-log",
    userId: "evaluation-owner",
    username: "owner",
    displayName: "Owner",
    kind: "image",
    source: "image-workbench",
    status: "success",
    title: "Original generation facts",
    prompt: "Original request",
    model: "original-model",
    summary: "Complete",
    durationMs: 1000,
    count: 1,
    successCount: 1,
    failCount: 0,
    assets: [],
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:01.000Z",
};

function review(): Extract<GenerationLogEvaluation, { kind: "ai_review" }> {
    return {
        id: "evaluation-one",
        logId: log.id,
        userId: log.userId,
        actorId: "evaluation-admin",
        actorName: "Admin",
        fingerprint: "request-fingerprint",
        kind: "ai_review",
        status: "pending",
        createdAt: "2026-11-18T01:00:00.000Z",
        updatedAt: "2026-11-18T01:00:00.000Z",
        review: {
            ruleVersion: "review-v1",
            mode: "text_metadata",
            model: { logicalModelId: "text-model", channelId: "text-channel", upstreamModel: "text-upstream" },
            factsDigest: "facts-digest",
            evidence: [{ id: "generation", label: "Generation", facts: { prompt: log.prompt } }],
        },
    };
}

describe("file generation log evaluations", () => {
    let directory: string;
    let store: typeof import("./generation-log-evaluation-store");
    let logs: typeof import("./generation-log-repository");

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "generation-log-evaluations-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.resetModules();
        store = await import("./generation-log-evaluation-store");
        logs = await import("./generation-log-repository");
        await logs.writeGenerationLogDb({ version: 1, logs: [log, { ...log, id: "other-log" }] });
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("claims one request once, persists its terminal result, and keeps the original generation facts", async () => {
        const record = review();
        const claims = await Promise.all([store.claimGenerationLogEvaluation(record), store.claimGenerationLogEvaluation(record)]);
        expect(claims.map((claim) => claim.created).sort()).toEqual([false, true]);
        const complete = {
            ...record,
            status: "completed" as const,
            review: { ...record.review, report: { outcome: "no_issue_observed" as const, summary: "No issue observed", limitations: ["No visual inspection"], issues: [] }, pointsCost: 1.5, pointsRecordId: "review-charge" },
        };
        await store.finishGenerationLogEvaluation(complete);
        await expect(store.finishGenerationLogEvaluation({ ...record, status: "failed", review: { ...record.review, error: "late failure" } })).resolves.toEqual(complete);
        vi.resetModules();
        const refreshed = await import("./generation-log-evaluation-store");
        await expect(refreshed.getGenerationLogEvaluation(record.id)).resolves.toEqual(complete);
        await expect(refreshed.listGenerationLogEvaluations(log.id)).resolves.toEqual([complete]);
        expect((await logs.readGenerationLogDb()).logs[0]).toEqual(log);
    });

    it.each([{ fingerprint: "other-request" }, { actorId: "other-admin" }, { logId: "other-log" }, { userId: "other-owner" }])("rejects reuse of an evaluation ID with another identity %j", async (change) => {
        await store.claimGenerationLogEvaluation(review());
        await expect(store.claimGenerationLogEvaluation({ ...review(), ...change })).rejects.toMatchObject({ status: 409 });
        await expect(store.getGenerationLogEvaluation("evaluation-one")).resolves.toEqual(review());
    });

    it("rejects a missing or foreign parent before saving any evaluation", async () => {
        await expect(store.claimGenerationLogEvaluation({ ...review(), logId: "missing-log" })).rejects.toMatchObject({ status: 404 });
        await expect(store.claimGenerationLogEvaluation({ ...review(), userId: "other-owner" })).rejects.toMatchObject({ status: 404 });
        await expect(store.listGenerationLogEvaluations(log.id)).resolves.toEqual([]);
    });

    it("serializes claims with log deletion and cascades evaluation deletion for user logs", async () => {
        const lifecycle = await import("./generation-log-store");
        await Promise.allSettled([store.claimGenerationLogEvaluation(review()), lifecycle.deleteGenerationLogs([log.id])]);
        await expect(store.getGenerationLogEvaluation("evaluation-one")).resolves.toBeNull();
        await expect(store.listGenerationLogEvaluations(log.id)).resolves.toEqual([]);
        await store.claimGenerationLogEvaluation({ ...review(), id: "evaluation-two", logId: "other-log" });
        await lifecycle.deleteGenerationLogsByUserId(log.userId);
        await expect(store.getGenerationLogEvaluation("evaluation-two")).resolves.toBeNull();
        expect((await logs.readGenerationLogDb()).logs).toEqual([]);
    });

    it.each([
        ["conversation", "conversation-one"],
        ["canvas", "canvas-one"],
    ] as const)("keeps evaluation backups consistent after deleting a %s aggregate", async (kind, id) => {
        const { writeJsonDataFile } = await import("./data-adapter");
        await logs.writeGenerationLogDb({
            version: 1,
            logs: [
                { ...log, conversationId: "conversation-one" },
                { ...log, id: "other-log", conversationId: "conversation-two" },
            ],
        });
        await writeJsonDataFile("creative-runtime.json", {
            version: 1,
            nextEventId: 1,
            conversations: [
                { id: "conversation-one", userId: log.userId, surface: "canvas", projectId: "canvas-one" },
                { id: "conversation-two", userId: log.userId, surface: "chat" },
            ],
            messages: [],
            assets: [],
            events: [],
        });
        await writeJsonDataFile("canvas-projects.json", { version: 1, projects: [{ userId: log.userId, project: { id: "canvas-one", creativeConversationId: "conversation-one", nodes: [] } }] });
        await store.claimGenerationLogEvaluation(review());
        const retained = { ...review(), id: "retained-evaluation", logId: "other-log" };
        await store.claimGenerationLogEvaluation(retained);
        const deletion = await import("./creative-entity-deletion-store");
        const remove = { conversation: deletion.deleteCreativeConversationAggregates, canvas: deletion.deleteCanvasProjectAggregates }[kind];
        await remove(log.userId, [id]);
        await expect(store.getGenerationLogEvaluation("evaluation-one")).resolves.toBeNull();
        await expect(store.getGenerationLogEvaluation(retained.id)).resolves.toEqual(retained);
        const backup = await import("./admin-backup-store");
        const saved = await backup.readAdminBackupData();
        expect(saved.generationLogEvaluations.evaluations).toEqual([retained]);
        await expect(backup.restoreAdminBackupData(saved)).resolves.toBeUndefined();
        await expect(store.listGenerationLogEvaluations("other-log")).resolves.toEqual([retained]);
    });

    it("removes evaluations of a newly created request log when its parent task commit is compensated", async () => {
        const { persistAgentRunRequestLog } = await import("./agent-run-generation-log");
        const rollback = await persistAgentRunRequestLog({
            id: "compensated-run",
            userId: log.userId,
            conversationId: "compensated-conversation",
            clientRequestId: "compensated-request",
            surface: "chat",
            inputMessageId: "compensated-input",
            assistantMessageId: "compensated-assistant",
            prompt: "Original request",
            referencedAssetIds: [],
            assetIds: [],
            generationPreferences: { mode: "image" },
            status: "paused",
            tasks: [],
            reviewed: false,
            createdAt: Date.parse(log.createdAt),
            updatedAt: Date.parse(log.updatedAt),
        });
        const record = { ...review(), logId: "agent-run:compensated-run" };
        await store.claimGenerationLogEvaluation(record);
        await rollback?.();
        await expect(store.getGenerationLogEvaluation(record.id)).resolves.toBeNull();
        expect((await logs.readGenerationLogDb()).logs.map((item) => item.id)).toEqual(["evaluation-log", "other-log"]);
    });

    it("backs up feedback and AI evidence, merges restore without losing newer terminal records, and restores after deletion", async () => {
        const pending = review();
        const feedback: GenerationLogEvaluation = {
            id: "feedback-one",
            logId: log.id,
            userId: log.userId,
            actorId: pending.actorId,
            actorName: pending.actorName,
            fingerprint: "feedback-fingerprint",
            createdAt: pending.createdAt,
            updatedAt: pending.updatedAt,
            kind: "feedback",
            status: "completed",
            feedback: { sentiment: "partly_satisfied", message: "Retain this feedback", source: "admin_transcribed" },
        };
        await store.claimGenerationLogEvaluation(pending);
        await store.claimGenerationLogEvaluation(feedback);
        const backup = await import("./admin-backup-store");
        const saved = await backup.readAdminBackupData();
        expect(saved.generationLogEvaluations.evaluations).toEqual([pending, feedback]);
        await store.finishGenerationLogEvaluation({ ...pending, status: "failed", review: { ...pending.review, error: "Provider failed", refunded: true } });
        await backup.restoreAdminBackupData(saved);
        await expect(store.getGenerationLogEvaluation(pending.id)).resolves.toMatchObject({ status: "failed", review: { error: "Provider failed", refunded: true } });
        const lifecycle = await import("./generation-log-store");
        await lifecycle.deleteGenerationLogs([log.id]);
        await backup.restoreAdminBackupData(saved);
        await expect(store.getGenerationLogEvaluation(feedback.id)).resolves.toEqual(feedback);
        await expect(store.getGenerationLogEvaluation(pending.id)).resolves.toEqual(pending);
    });
});
