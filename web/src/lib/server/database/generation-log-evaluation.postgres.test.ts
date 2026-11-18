import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GenerationLogEvaluation } from "@/lib/generation-log-evaluation";
import { readAdminBackupData, restoreAdminBackupData } from "../admin-backup-store";
import { claimGenerationLogEvaluation, finishGenerationLogEvaluation, getGenerationLogEvaluation, listGenerationLogEvaluations } from "../generation-log-evaluation-store";
import { deleteGenerationLogs } from "../generation-log-store";
import { initializePostgresSchema, postgresQuery } from "./postgres";
import { createPostgresRepositories } from "./repositories";

const enabled = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
const owner = `evaluation-owner-${randomUUID()}`;
const actor = `evaluation-actor-${randomUUID()}`;

async function createLog() {
    const id = `evaluation-log-${randomUUID()}`;
    const now = new Date().toISOString();
    const log = await createPostgresRepositories().generationLogs.upsert({
        id,
        userId: owner,
        username: owner,
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
        createdAt: now,
        updatedAt: now,
    });
    return log;
}

function review(logId: string): Extract<GenerationLogEvaluation, { kind: "ai_review" }> {
    const now = new Date().toISOString();
    return {
        id: `evaluation-${randomUUID()}`,
        logId,
        userId: owner,
        actorId: actor,
        actorName: "Admin snapshot",
        fingerprint: "request-fingerprint",
        kind: "ai_review",
        status: "pending",
        createdAt: now,
        updatedAt: now,
        review: {
            ruleVersion: "review-v1",
            mode: "text_metadata",
            model: { logicalModelId: "text-model", channelId: "text-channel", upstreamModel: "text-upstream" },
            factsDigest: "facts-digest",
            evidence: [{ id: "generation", label: "Generation", facts: { prompt: "Original request" } }],
        },
    };
}

describe.skipIf(!enabled)("isolated PostgreSQL generation log evaluations", () => {
    beforeAll(async () => {
        const target = new URL(process.env.DATABASE_URL || "");
        if (process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_m5_e2e") || process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1")
            throw new Error("An isolated PostgreSQL fixture with a single connection is required");
        await initializePostgresSchema();
        await postgresQuery("INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, $1, 'Owner', 'unusable-fixture'), ($2, $2, 'Actor', 'unusable-fixture')", [owner, actor]);
    }, 30_000);

    afterAll(async () => {
        await postgresQuery("DELETE FROM users WHERE id = ANY($1::text[])", [[owner, actor]]);
    });

    it("claims a request once, rejects changed identities, and checks parent ownership", async () => {
        const log = await createLog();
        const pending = review(log.id);
        const claims = await Promise.all([claimGenerationLogEvaluation(pending), claimGenerationLogEvaluation(pending)]);
        expect(claims.map((claim) => claim.created).sort()).toEqual([false, true]);
        await expect(claimGenerationLogEvaluation({ ...pending, fingerprint: "other-request" })).rejects.toMatchObject({ status: 409 });
        await expect(claimGenerationLogEvaluation({ ...pending, id: randomUUID(), userId: actor })).rejects.toMatchObject({ status: 404 });
        await expect(claimGenerationLogEvaluation({ ...pending, id: randomUUID(), logId: "missing-log" })).rejects.toMatchObject({ status: 404 });
        await expect(listGenerationLogEvaluations(log.id)).resolves.toEqual([pending]);
    });

    it("finishes only pending evaluations and retains billing and evidence without changing generation facts", async () => {
        const log = await createLog();
        const pending = review(log.id);
        await claimGenerationLogEvaluation(pending);
        const completed = {
            ...pending,
            status: "completed" as const,
            review: { ...pending.review, pointsCost: 1.5, pointsRecordId: "review-charge", report: { outcome: "insufficient_evidence" as const, summary: "Visual facts unavailable", limitations: ["No image inspection"], issues: [] } },
        };
        await expect(finishGenerationLogEvaluation(completed)).resolves.toEqual(completed);
        await expect(finishGenerationLogEvaluation({ ...pending, status: "failed", review: { ...pending.review, error: "late failure" } })).resolves.toEqual(completed);
        await expect(getGenerationLogEvaluation(pending.id)).resolves.toEqual(completed);
        await expect(createPostgresRepositories().generationLogs.getById(log.id)).resolves.toEqual(log);
    });

    it("backs up and restores feedback and AI review through the same single-connection transaction", async () => {
        const log = await createLog();
        const pending = review(log.id);
        const feedback: GenerationLogEvaluation = {
            id: randomUUID(),
            logId: log.id,
            userId: owner,
            actorId: actor,
            actorName: "Admin snapshot",
            fingerprint: "feedback-fingerprint",
            createdAt: pending.createdAt,
            updatedAt: pending.updatedAt,
            kind: "feedback",
            status: "completed",
            feedback: { sentiment: "unsatisfied", message: "Retain feedback independently", source: "admin_transcribed" },
        };
        await claimGenerationLogEvaluation(pending);
        await claimGenerationLogEvaluation(feedback);
        const failed = { ...pending, status: "failed" as const, review: { ...pending.review, error: "Provider failed", pointsCost: 1.5, pointsRecordId: "failed-review-charge", refunded: true } };
        await finishGenerationLogEvaluation(failed);
        const saved = await readAdminBackupData();
        expect(saved.generationLogEvaluations.evaluations).toContainEqual(failed);
        expect(saved.generationLogEvaluations.evaluations).toContainEqual(feedback);
        await deleteGenerationLogs([log.id]);
        await expect(getGenerationLogEvaluation(pending.id)).resolves.toBeNull();
        await restoreAdminBackupData(saved);
        await expect(getGenerationLogEvaluation(pending.id)).resolves.toEqual(failed);
        await expect(getGenerationLogEvaluation(feedback.id)).resolves.toEqual(feedback);
    }, 30_000);

    it("rolls back earlier restored data when an evaluation references a missing parent", async () => {
        const log = await createLog();
        const pending = review(log.id);
        await claimGenerationLogEvaluation(pending);
        const imported = await readAdminBackupData();
        const user = imported.auth.users.find((item) => item.id === owner);
        if (!user) throw new Error("Evaluation fixture owner is missing");
        user.displayName = "Must roll back";
        imported.generationLogEvaluations.evaluations.push({ ...review("missing-parent"), id: randomUUID() });
        await expect(restoreAdminBackupData(imported)).rejects.toMatchObject({ status: 404 });
        const actual = await postgresQuery<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [owner]);
        expect(actual.rows[0].display_name).toBe("Owner");
        await expect(getGenerationLogEvaluation(pending.id)).resolves.toEqual(pending);
    });

    it("cascades log and owner deletion while retaining an actor snapshot until its owner is deleted", async () => {
        const log = await createLog();
        const pending = review(log.id);
        await Promise.allSettled([claimGenerationLogEvaluation(pending), deleteGenerationLogs([log.id])]);
        await expect(getGenerationLogEvaluation(pending.id)).resolves.toBeNull();
        const retained = await createLog();
        const record = review(retained.id);
        await claimGenerationLogEvaluation(record);
        await postgresQuery("DELETE FROM users WHERE id = $1", [actor]);
        await expect(getGenerationLogEvaluation(record.id)).resolves.toEqual(record);
        await postgresQuery("DELETE FROM users WHERE id = $1", [owner]);
        await expect(getGenerationLogEvaluation(record.id)).resolves.toBeNull();
    });
});
